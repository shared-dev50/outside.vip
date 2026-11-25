import {
  EventStatus,
  Prisma,
  TicketStatus,
  WaitlistEntryStatus,
  WaitlistOfferStatus,
} from '@prisma/client';
import { nanoid } from 'nanoid';
import { ConflictError } from '../../utils/errors.js';
import {
  enqueueOrderConfirmationEmail,
  OrderSnapshotSource,
} from '../notifications/emailOutbox.service.js';
import { calculateCheckoutFeeBreakdown } from '../checkout/checkout.financials.js';
import {
  allocateOrderTicketPayments,
  PersistedTicketPaymentAllocation,
} from '../refunds/refundAllocation.domain.js';

export interface FulfillOrderCompletionInput {
  order: OrderSnapshotSource & {
    id: string;
    eventId: string;
    customerName: string;
    customerEmail: string;
    items: Array<
      OrderSnapshotSource['items'][number] & {
        ticketTierId: string;
      }
    >;
  };
  existingTicketCount?: number;
  linkedOffers?: Array<{
    id: string;
    entryId: string;
  }>;
  now?: Date;
}

export interface FulfillOrderCompletionResult {
  issuedTicketCount: number;
  enqueuedEmail: boolean;
}

/**
 * Shared atomic fulfillment core used by both paid Stripe webhook fulfillment and
 * direct zero-payment free-ticket checkout. Must run inside the caller's PostgreSQL
 * transaction after Order status/ownership locks and inventory updates are complete.
 *
 * Never creates PaymentTransaction rows, Stripe references, or financial ledger entries.
 */
export async function fulfillOrderCompletionInTx(
  tx: Prisma.TransactionClient,
  input: FulfillOrderCompletionInput
): Promise<FulfillOrderCompletionResult> {
  const { order, linkedOffers = [] } = input;
  const now = input.now ?? new Date();

  const eventStatusFromOrder = (order as any)?.event?.status;
  if (eventStatusFromOrder === EventStatus.CANCELLED) {
    throw new ConflictError('Cannot fulfill or issue tickets for a cancelled event.', 'EVENT_CANCELLED');
  }
  if (typeof (tx as any)?.event?.findUnique === 'function') {
    const evt = await tx.event.findUnique({
      where: { id: order.eventId },
      select: { status: true },
    });
    if (evt?.status === EventStatus.CANCELLED) {
      throw new ConflictError('Cannot fulfill or issue tickets for a cancelled event.', 'EVENT_CANCELLED');
    }
  }

  if (linkedOffers.length > 0) {
    const offerIds = linkedOffers.map((o) => o.id);
    const entryIds = Array.from(new Set(linkedOffers.map((o) => o.entryId)));

    await tx.ticketWaitlistOffer.updateMany({
      where: { id: { in: offerIds } },
      data: {
        status: WaitlistOfferStatus.ACCEPTED,
        claimedAt: now,
      },
    });

    await tx.ticketWaitlistEntry.updateMany({
      where: { id: { in: entryIds } },
      data: {
        status: WaitlistEntryStatus.PURCHASED,
      },
    });
  }

  let issuedTicketCount =
    typeof input.existingTicketCount === 'number'
      ? input.existingTicketCount
      : await tx.ticket.count({ where: { orderId: order.id } });

  if (issuedTicketCount === 0) {
    const ticketInputs: Array<{ ticketId: string; ticketTierId: string; grossPriceInCents: number }> = [];
    const generatedTokens: string[] = [];

    for (const item of order.items) {
      const unitGross =
        typeof (item as any).unitPriceInCents === 'number'
          ? Math.max(0, Math.round((item as any).unitPriceInCents))
          : 0;
      for (let i = 0; i < item.quantity; i++) {
        const idx = ticketInputs.length;
        ticketInputs.push({
          ticketId: `pending_${idx}`,
          ticketTierId: item.ticketTierId,
          grossPriceInCents: unitGross,
        });
        generatedTokens.push(`tkt_sec_${nanoid(24)}`);
      }
    }

    let allocations: PersistedTicketPaymentAllocation[] | null = null;
    if (ticketInputs.length > 0 && typeof order.totalInCents === 'number') {
      const canonical = calculateCheckoutFeeBreakdown(
        ticketInputs.map((t) => ({ priceInCents: t.grossPriceInCents, quantity: 1 }))
      );
      if (order.totalInCents === canonical.buyerTotalInCents) {
        allocations = allocateOrderTicketPayments(
          { buyerTotalInCents: order.totalInCents },
          ticketInputs
        ).tickets;
      }
    }

    for (let i = 0; i < ticketInputs.length; i++) {
      const ticketInput = ticketInputs[i];
      const alloc = allocations ? allocations[i] : null;
      await tx.ticket.create({
        data: {
          ticketToken: generatedTokens[i],
          orderId: order.id,
          eventId: order.eventId,
          ticketTierId: ticketInput.ticketTierId,
          attendeeName: order.customerName,
          attendeeEmail: order.customerEmail,
          status: TicketStatus.ISSUED,
          ...(alloc
            ? {
                allocatedGrossInCents: alloc.allocatedGrossInCents,
                allocatedPlatformFeeInCents: alloc.allocatedPlatformFeeInCents,
                allocatedServiceFeeInCents: alloc.allocatedServiceFeeInCents,
                allocatedProcessingFeeInCents: alloc.allocatedProcessingFeeInCents,
                allocatedBuyerTotalInCents: alloc.allocatedBuyerTotalInCents,
              }
            : {}),
        },
      });
      issuedTicketCount += 1;
    }
  }

  // Atomically enqueue the durable buyer confirmation email inside the same transaction.
  // Never performs external email I/O here.
  let enqueuedEmail = false;
  if (issuedTicketCount > 0 && order.event) {
    const outboxResult = await enqueueOrderConfirmationEmail(tx, order);
    enqueuedEmail = outboxResult.enqueued;
  }

  return { issuedTicketCount, enqueuedEmail };
}
