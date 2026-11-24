import {
  Prisma,
  TicketStatus,
  WaitlistEntryStatus,
  WaitlistOfferStatus,
} from '@prisma/client';
import { nanoid } from 'nanoid';
import {
  enqueueOrderConfirmationEmail,
  OrderSnapshotSource,
} from '../notifications/emailOutbox.service.js';

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
        issuedTicketCount += 1;
      }
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
