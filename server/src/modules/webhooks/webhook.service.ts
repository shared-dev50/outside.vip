import Stripe from 'stripe';
import {
  Prisma,
  PaymentProvider,
  PaymentStatus,
  OrderStatus,
  ReservationStatus,
  TicketStatus,
  WaitlistOfferStatus,
  WaitlistEntryStatus,
  TransferStatus,
  PayoutStatus,
  LedgerEntryType,
  LedgerBalanceType,
} from '@prisma/client';
import { nanoid } from 'nanoid';
import { prisma } from '../../db/prisma.js';
import {
  recordTicketSalePending,
  settleOrderEarnings,
  recordActualStripeFee,
  recordRefundLedger,
  recordDisputeLedger,
} from '../finance/ledger.service.js';

export async function processStripeWebhookEvent(
  event: Stripe.Event
): Promise<{ handled: boolean; duplicate?: boolean }> {
  return await prisma.$transaction(
    async (tx) => {
      // Skip duplicate deliveries
      const existing = await tx.processedWebhookEvent.findUnique({
        where: { eventId: event.id },
      });

      if (existing) {
        return { handled: true, duplicate: true };
      }

      switch (event.type) {
        case 'payment_intent.succeeded': {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;
          await handlePaymentIntentSucceeded(tx, paymentIntent);
          break;
        }

        case 'payment_intent.payment_failed': {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;
          await handlePaymentIntentFailed(tx, paymentIntent);
          break;
        }

        case 'charge.updated': {
          const charge = event.data.object as Stripe.Charge;
          await handleChargeUpdated(tx, charge);
          break;
        }

        case 'charge.refunded': {
          const charge = event.data.object as Stripe.Charge;
          await handleChargeRefunded(tx, charge);
          break;
        }

        case 'charge.dispute.created':
        case 'charge.dispute.updated':
        case 'charge.dispute.closed': {
          const dispute = event.data.object as Stripe.Dispute;
          await handleDisputeEvent(tx, event.type, dispute);
          break;
        }

        case 'transfer.created':
        case 'transfer.updated':
        case 'transfer.reversed': {
          const transfer = event.data.object as Stripe.Transfer;
          await handleTransferEvent(tx, event.type, transfer);
          break;
        }

        case 'account.updated': {
          const account = event.data.object as Stripe.Account;
          await handleAccountUpdated(tx, account);
          break;
        }

        case 'payout.created':
        case 'payout.updated':
        case 'payout.paid':
        case 'payout.failed': {
          const payout = event.data.object as Stripe.Payout;
          const stripeAccountId = (event as any).account as string | undefined;
          await handlePayoutEvent(tx, event.type, payout, stripeAccountId);
          break;
        }

        default:
          break;
      }

      // Record processed event to guarantee idempotent retries
      await tx.processedWebhookEvent.create({
        data: {
          provider: PaymentProvider.STRIPE,
          eventId: event.id,
        },
      });

      return { handled: true };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 10000,
    }
  );
}

export async function fulfillPaidOrder(
  paymentIntent: Stripe.PaymentIntent
): Promise<boolean> {
  return await prisma.$transaction(
    async (tx) => {
      await handlePaymentIntentSucceeded(tx, paymentIntent);
      return true;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 10000,
    }
  );
}

export async function handlePaymentIntentSucceeded(
  tx: Prisma.TransactionClient,
  paymentIntent: Stripe.PaymentIntent
): Promise<void> {
  const orderId = paymentIntent.metadata?.orderId as string | undefined;

  let order = orderId
    ? await tx.order.findUnique({
        where: { id: orderId },
        include: {
          items: { include: { ticketTier: true } },
          reservations: true,
          tickets: true,
        },
      })
    : null;

  if (!order && paymentIntent.id) {
    order = await tx.order.findFirst({
      where: { paymentReference: paymentIntent.id },
      include: {
        items: { include: { ticketTier: true } },
        reservations: true,
        tickets: true,
      },
    });
  }

  if (!order) {
    console.warn(`Order referenced by Stripe PaymentIntent ${paymentIntent.id} not found.`);
    return;
  }

  // Fulfill ONLY when payment is verified as succeeded
  if (paymentIntent.status !== 'succeeded') {
    console.info(`Stripe PaymentIntent ${paymentIntent.id} status is '${paymentIntent.status}', deferring fulfillment.`);
    return;
  }

  if (order.status === OrderStatus.COMPLETED) {
    return;
  }

  if (paymentIntent.amount !== null && paymentIntent.amount !== order.totalInCents) {
    throw new Error(
      `Amount mismatch for order ${order.orderNumber}: expected ${order.totalInCents}, received ${paymentIntent.amount}`
    );
  }

  if (paymentIntent.currency && paymentIntent.currency.toUpperCase() !== order.currency.toUpperCase()) {
    throw new Error(
      `Currency mismatch for order ${order.orderNumber}: expected ${order.currency}, received ${paymentIntent.currency}`
    );
  }

  await tx.order.update({
    where: { id: order.id },
    data: {
      status: OrderStatus.COMPLETED,
      paymentReference: paymentIntent.id,
    },
  });

  await tx.ticketReservation.updateMany({
    where: { orderId: order.id },
    data: { status: ReservationStatus.CONFIRMED },
  });

  // Shift reserved inventory to sold counts
  const hasActiveReservations = order.reservations.some(
    (r) => r.status === ReservationStatus.ACTIVE
  );

  for (const item of order.items) {
    await tx.ticketTier.update({
      where: { id: item.ticketTierId },
      data: {
        ...(hasActiveReservations ? { reservedQuantity: { decrement: item.quantity } } : {}),
        soldQuantity: { increment: item.quantity },
      },
    });
  }

  if (order.tickets.length === 0) {
    for (const item of order.items) {
      for (let i = 0; i < item.quantity; i++) {
        const ticketToken = `tkt_sec_${nanoid(24)}`;
        await tx.ticket.create({
          data: {
            ticketToken,
            orderId: order.id,
            eventId: order.eventId,
            ticketTierId: item.ticketTierId,
            attendeeName: order.customerName,
            attendeeEmail: order.customerEmail,
            status: TicketStatus.ISSUED,
          },
        });
      }
    }
  }

  const existingTx = await tx.paymentTransaction.findFirst({
    where: { orderId: order.id, status: PaymentStatus.SUCCEEDED },
  });
  if (!existingTx) {
    await tx.paymentTransaction.create({
      data: {
        orderId: order.id,
        provider: PaymentProvider.STRIPE,
        providerTransactionId: paymentIntent.id,
        status: PaymentStatus.SUCCEEDED,
        amountInCents: paymentIntent.amount || order.totalInCents,
        currency: order.currency,
        rawResponse: paymentIntent as any,
      },
    });
  }

  // Claim any waitlist offers fulfilled by this order
  const linkedOffers = await tx.ticketWaitlistOffer.findMany({
    where: { orderId: order.id },
  });

  for (const offer of linkedOffers) {
    await tx.ticketWaitlistOffer.update({
      where: { id: offer.id },
      data: {
        status: WaitlistOfferStatus.ACCEPTED,
        claimedAt: new Date(),
      },
    });

    await tx.ticketWaitlistEntry.update({
      where: { id: offer.entryId },
      data: {
        status: WaitlistEntryStatus.PURCHASED,
      },
    });
  }

  const latestChargeId = typeof paymentIntent.latest_charge === 'string'
    ? paymentIntent.latest_charge
    : (paymentIntent.latest_charge as Stripe.Charge)?.id;

  await recordTicketSalePending(tx, {
    orderId: order.id,
    paymentIntentId: paymentIntent.id,
    stripeChargeId: latestChargeId,
    autoSettle: false,
  });
}

export async function handlePaymentIntentFailed(
  tx: Prisma.TransactionClient,
  paymentIntent: Stripe.PaymentIntent
): Promise<void> {
  const orderId = paymentIntent.metadata?.orderId as string | undefined;

  let order = orderId
    ? await tx.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      })
    : null;

  if (!order && paymentIntent.id) {
    order = await tx.order.findFirst({
      where: { paymentReference: paymentIntent.id },
      include: { items: true },
    });
  }

  if (!order || order.status === OrderStatus.COMPLETED) {
    return;
  }

  // Record failed transaction for auditing while allowing the attendee to retry
  const failureReason = paymentIntent.last_payment_error?.message || 'Payment attempt failed';
  await tx.paymentTransaction.create({
    data: {
      orderId: order.id,
      provider: PaymentProvider.STRIPE,
      providerTransactionId: paymentIntent.id,
      status: PaymentStatus.FAILED,
      amountInCents: paymentIntent.amount || order.totalInCents,
      currency: order.currency,
      rawResponse: {
        ...(paymentIntent as any),
        failureReason,
      },
    },
  });
}

async function handleChargeUpdated(
  tx: Prisma.TransactionClient,
  charge: Stripe.Charge
): Promise<void> {
  const paymentIntentId = typeof charge.payment_intent === 'string'
    ? charge.payment_intent
    : (charge.payment_intent as Stripe.PaymentIntent)?.id;

  const orderId = charge.metadata?.orderId as string | undefined;

  let order = orderId
    ? await tx.order.findUnique({ where: { id: orderId } })
    : null;

  if (!order && paymentIntentId) {
    order = await tx.order.findFirst({
      where: { paymentReference: paymentIntentId },
    });
  }

  if (order) {
    // Settle earnings when charge is confirmed / succeeded
    if (charge.status === 'succeeded') {
      await settleOrderEarnings(tx, {
        orderId: order.id,
        stripeChargeId: charge.id,
      });
    }

    // Reconcile actual Stripe fee if balance transaction is included
    if (charge.balance_transaction) {
      const balanceTx = typeof charge.balance_transaction === 'object'
        ? (charge.balance_transaction as Stripe.BalanceTransaction)
        : null;

      if (balanceTx && typeof balanceTx.fee === 'number') {
        await recordActualStripeFee(tx, {
          stripeChargeId: charge.id,
          actualFeeInCents: balanceTx.fee,
          currency: charge.currency,
          orderId: order.id,
        });
      }
    }
  }
}

async function handleChargeRefunded(
  tx: Prisma.TransactionClient,
  charge: Stripe.Charge
): Promise<void> {
  const paymentIntentId = typeof charge.payment_intent === 'string'
    ? charge.payment_intent
    : (charge.payment_intent as Stripe.PaymentIntent)?.id;

  const orderId = charge.metadata?.orderId as string | undefined;

  let order = orderId
    ? await tx.order.findUnique({ where: { id: orderId } })
    : null;

  if (!order && paymentIntentId) {
    order = await tx.order.findFirst({
      where: { paymentReference: paymentIntentId },
    });
  }

  if (!order) {
    console.warn(`[ChargeRefunded] Order not found for charge ${charge.id}`);
    return;
  }

  const stripeRefundId = charge.refunds?.data?.[0]?.id;
  await recordRefundLedger(tx, {
    orderId: order.id,
    amountInCents: charge.amount_refunded,
    stripeRefundId,
    stripeChargeId: charge.id,
    reason: 'Stripe charge refunded',
  });
}

async function handleDisputeEvent(
  tx: Prisma.TransactionClient,
  eventType: string,
  dispute: Stripe.Dispute
): Promise<void> {
  const chargeId = typeof dispute.charge === 'string'
    ? dispute.charge
    : (dispute.charge as Stripe.Charge)?.id;

  let order = chargeId
    ? await tx.order.findFirst({
        where: {
          transactions: {
            some: { providerTransactionId: chargeId },
          },
        },
      })
    : null;

  let status: 'needs_response' | 'under_review' | 'won' | 'lost' | 'warning_needs_response' = 'needs_response';
  if (dispute.status === 'won') {
    status = 'won';
  } else if (dispute.status === 'lost') {
    status = 'lost';
  } else if (dispute.status === 'under_review') {
    status = 'under_review';
  }

  await recordDisputeLedger(tx, {
    stripeDisputeId: dispute.id,
    stripeChargeId: chargeId,
    orderId: order?.id,
    amountInCents: dispute.amount,
    status,
    reason: dispute.reason,
  });
}

async function handleTransferEvent(
  tx: Prisma.TransactionClient,
  eventType: string,
  transfer: Stripe.Transfer
): Promise<void> {
  if (eventType === 'transfer.reversed') {
    const existing = await tx.organizerTransfer.findUnique({
      where: { stripeTransferId: transfer.id },
    });

    if (existing && existing.status !== TransferStatus.REVERSED) {
      await tx.organizerTransfer.update({
        where: { id: existing.id },
        data: { status: TransferStatus.REVERSED },
      });

      await tx.financialLedgerEntry.create({
        data: {
          type: LedgerEntryType.ADJUSTMENT,
          balanceType: LedgerBalanceType.TRANSFERRED,
          amountInCents: -existing.amountInCents,
          currency: existing.currency.toUpperCase(),
          organizerId: existing.organizerId,
          transferId: existing.id,
          stripeReferenceId: transfer.id,
          description: `Stripe transfer reversed for transfer #${existing.transferNumber}`,
          metadata: {
            transferId: existing.id,
            transferNumber: existing.transferNumber,
            stripeTransferId: transfer.id,
          },
        },
      });
    }
  }
}

async function handlePayoutEvent(
  tx: Prisma.TransactionClient,
  eventType: string,
  payout: Stripe.Payout,
  stripeAccountId?: string
): Promise<void> {
  if (!stripeAccountId) {
    return;
  }

  const user = await tx.user.findFirst({
    where: { stripeAccountId },
  });

  if (!user) {
    return;
  }

  let status: PayoutStatus = PayoutStatus.PENDING;
  if (payout.status === 'paid') {
    status = PayoutStatus.PAID;
  } else if (payout.status === 'failed') {
    status = PayoutStatus.FAILED;
  } else if (payout.status === 'canceled') {
    status = PayoutStatus.CANCELLED;
  }

  const arrivalDate = payout.arrival_date ? new Date(payout.arrival_date * 1000) : null;
  const failureCode = payout.failure_code || null;
  const failureMessage = payout.failure_message || null;

  // Masked bank account details from payout destination where available
  const destinationBankMasked = (payout as any).destination_details?.card?.last4
    ? `•••• ${(payout as any).destination_details?.card?.last4}`
    : null;

  await tx.connectedPayout.upsert({
    where: { stripePayoutId: payout.id },
    update: {
      status,
      arrivalDate,
      failureCode,
      failureMessage,
      destinationBankMasked,
    },
    create: {
      stripePayoutId: payout.id,
      organizerId: user.id,
      stripeAccountId,
      amountInCents: payout.amount,
      currency: payout.currency.toUpperCase(),
      status,
      arrivalDate,
      failureCode,
      failureMessage,
      destinationBankMasked,
    },
  });
}

async function handleAccountUpdated(
  tx: Prisma.TransactionClient,
  account: Stripe.Account
): Promise<void> {
  const user = await tx.user.findUnique({
    where: { stripeAccountId: account.id },
  });

  if (!user) {
    return;
  }

  // If Stripe account has bank account, reflect safe masked details in OrganizerPayoutDetails
  const bankAccounts = (account.external_accounts?.data || []).filter(
    (e) => e.object === 'bank_account'
  ) as Stripe.BankAccount[];

  if (bankAccounts.length > 0) {
    const defaultBank =
      bankAccounts.find((b) => (b as any).default_for_currency) || bankAccounts[0];

    const masked = `•••• •••• •••• ${defaultBank.last4 || '••••'}`;
    const last4 = defaultBank.last4 || '';

    const existingPayout = await tx.organizerPayoutDetails.findUnique({
      where: { userId: user.id },
    });

    if (existingPayout) {
      await tx.organizerPayoutDetails.update({
        where: { userId: user.id },
        data: {
          accountHolderName: defaultBank.account_holder_name || existingPayout.accountHolderName,
          bankName: defaultBank.bank_name || existingPayout.bankName,
          bankCountry: defaultBank.country || existingPayout.bankCountry,
          accountCurrency: defaultBank.currency
            ? defaultBank.currency.toUpperCase()
            : existingPayout.accountCurrency,
          accountNumberMasked: masked,
          accountNumberLast4: last4,
          routingCode: defaultBank.routing_number
            ? `••••${defaultBank.routing_number.slice(-4)}`
            : existingPayout.routingCode,
        },
      });
    }
  }
}
