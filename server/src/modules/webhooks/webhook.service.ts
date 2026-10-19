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
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded': {
          const session = event.data.object as Stripe.Checkout.Session;
          await handlePaymentSuccess(tx, session);
          break;
        }

        case 'checkout.session.async_payment_failed': {
          const session = event.data.object as Stripe.Checkout.Session;
          await handlePaymentFailed(tx, session);
          break;
        }

        case 'checkout.session.expired': {
          const session = event.data.object as Stripe.Checkout.Session;
          await handleSessionExpired(tx, session);
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
  session: Stripe.Checkout.Session
): Promise<boolean> {
  return await prisma.$transaction(
    async (tx) => {
      await handlePaymentSuccess(tx, session);
      return true;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 10000,
    }
  );
}

export async function handlePaymentSuccess(
  tx: Prisma.TransactionClient,
  session: Stripe.Checkout.Session
): Promise<void> {
  const orderId = (session.metadata?.orderId as string) || (session.client_reference_id as string);
  if (!orderId) {
    console.warn('Stripe checkout session completed without orderId in metadata:', session.id);
    return;
  }

  // Fulfill ONLY when payment is verified as paid
  if (session.payment_status !== 'paid') {
    console.info(`Stripe session ${session.id} payment_status is '${session.payment_status}', deferring fulfillment.`);
    return;
  }

  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: {
      items: { include: { ticketTier: true } },
      reservations: true,
      tickets: true,
    },
  });

  if (!order) {
    console.warn(`Order ${orderId} referenced by Stripe session ${session.id} not found.`);
    return;
  }

  // Already fulfilled? Safe return
  if (order.status === OrderStatus.COMPLETED) {
    return;
  }

  // Verify amounts and currency match
  if (session.amount_total !== null && session.amount_total !== order.totalInCents) {
    throw new Error(
      `Amount mismatch for order ${order.orderNumber}: expected ${order.totalInCents}, received ${session.amount_total}`
    );
  }

  if (session.currency && session.currency.toUpperCase() !== order.currency.toUpperCase()) {
    throw new Error(
      `Currency mismatch for order ${order.orderNumber}: expected ${order.currency}, received ${session.currency}`
    );
  }

  // 1. Mark order completed
  await tx.order.update({
    where: { id: order.id },
    data: {
      status: OrderStatus.COMPLETED,
      paymentReference: session.id,
    },
  });

  // 2. Confirm reservations
  await tx.ticketReservation.updateMany({
    where: { orderId: order.id },
    data: { status: ReservationStatus.CONFIRMED },
  });

  // 3. Shift reserved quantity to sold quantity
  // Only decrement reservedQuantity if the reservation was still ACTIVE.
  // If the reservation had already been released by cleanup before webhook arrived,
  // do not decrement reservedQuantity again (which would drive it below zero).
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
        providerTransactionId: (session.payment_intent as string) || session.id,
        status: PaymentStatus.SUCCEEDED,
        amountInCents: session.amount_total || order.totalInCents,
        currency: order.currency,
        rawResponse: session as any,
      },
    });
  }
}

async function handlePaymentFailed(
  tx: Prisma.TransactionClient,
  session: Stripe.Checkout.Session
): Promise<void> {
  const orderId = (session.metadata?.orderId as string) || (session.client_reference_id as string);
  if (!orderId) return;

  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });

  if (!order || order.status === OrderStatus.COMPLETED) {
    return;
  }

  // Release reservation hold
  for (const item of order.items) {
    await tx.ticketTier.update({
      where: { id: item.ticketTierId },
      data: {
        reservedQuantity: { decrement: item.quantity },
      },
    });
  }

  await tx.ticketReservation.updateMany({
    where: { orderId: order.id },
    data: { status: ReservationStatus.RELEASED },
  });

  await tx.order.update({
    where: { id: order.id },
    data: { status: OrderStatus.CANCELLED },
  });

  await tx.paymentTransaction.create({
    data: {
      orderId: order.id,
      provider: PaymentProvider.STRIPE,
      providerTransactionId: (session.payment_intent as string) || session.id,
      status: PaymentStatus.FAILED,
      amountInCents: session.amount_total || order.totalInCents,
      currency: order.currency,
      rawResponse: session as any,
    },
  });
}

async function handleSessionExpired(
  tx: Prisma.TransactionClient,
  session: Stripe.Checkout.Session
): Promise<void> {
  const orderId = (session.metadata?.orderId as string) || (session.client_reference_id as string);
  if (!orderId) return;

  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });

  if (!order || order.status !== OrderStatus.PENDING) {
    return;
  }

  for (const item of order.items) {
    await tx.ticketTier.update({
      where: { id: item.ticketTierId },
      data: {
        reservedQuantity: { decrement: item.quantity },
      },
    });
  }

  await tx.ticketReservation.updateMany({
    where: { orderId: order.id },
    data: { status: ReservationStatus.RELEASED },
  });

  await tx.order.update({
    where: { id: order.id },
    data: { status: OrderStatus.EXPIRED },
  });
}
