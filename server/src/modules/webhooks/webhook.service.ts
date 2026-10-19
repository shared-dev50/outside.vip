import Stripe from 'stripe';
import { Prisma, PaymentProvider, PaymentStatus, OrderStatus, ReservationStatus, TicketStatus } from '@prisma/client';
import { nanoid } from 'nanoid';
import { prisma } from '../../db/prisma.js';

export async function processStripeWebhookEvent(
  event: Stripe.Event
): Promise<{ handled: boolean; duplicate?: boolean }> {
  return await prisma.$transaction(
    async (tx) => {
      // 1. Idempotency verification
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

  // Already fulfilled? Safe idempotent return
  if (order.status === OrderStatus.COMPLETED) {
    return;
  }

  // Verify amounts and currency match
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

  // 1. Mark order completed
  await tx.order.update({
    where: { id: order.id },
    data: {
      status: OrderStatus.COMPLETED,
      paymentReference: paymentIntent.id,
    },
  });

  // 2. Confirm reservations
  await tx.ticketReservation.updateMany({
    where: { orderId: order.id },
    data: { status: ReservationStatus.CONFIRMED },
  });

  // 3. Shift reserved quantity to sold quantity
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

  // 4. Issue cryptographically secure ticket records
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

  // 5. Record payment transaction
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
