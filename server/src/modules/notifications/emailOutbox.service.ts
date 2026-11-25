import crypto from 'crypto';
import os from 'os';
import {
  EmailOutbox,
  EmailOutboxStatus,
  EmailOutboxType,
  OrderRefundStatus,
  OrderStatus,
  Prisma,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { normalizeEmail } from '../../config/env.js';
import {
  buildOrderTicketAccessUrl,
  BUYER_REFUND_TEMPLATE_VERSION,
  BuyerRefundContentSnapshot,
  BuyerRefundNotificationKind,
  EmailDeliveryError,
  EVENT_CANCELLED_TEMPLATE_VERSION,
  EventCancelledBuyerContentSnapshot,
  EventCancelledOrganizerContentSnapshot,
  LATE_PAYMENT_REFUND_TEMPLATE_VERSION,
  LatePaymentRefundContentSnapshot,
  LatePaymentRefundNotificationKind,
  maskEmailForLog,
  normalizeClientOrigin,
  ORDER_CONFIRMATION_TEMPLATE_VERSION,
  OrderConfirmationContentSnapshot,
  OrderConfirmationSnapshotItem,
  resolveEmailFrom,
  sanitizeEmailLogMessage,
  sendBuyerRefundEmail,
  sendEventCancelledBuyerEmail,
  sendEventCancelledOrganizerEmail,
  sendLatePaymentRefundEmail,
  sendOrderConfirmationEmail,
} from '../../lib/email.service.js';

export const EMAIL_OUTBOX_MAX_ATTEMPTS = 8;
export const EMAIL_OUTBOX_LEASE_MS = 90_000; // 90s lease (comfortably > 5 * 10s worst-case sequential batch timeouts)
export const EMAIL_OUTBOX_BATCH_SIZE = 5;

// Exponential backoff base delays (ms) for retries after attempts 1..7.
// Total retry window (~4.25h) remains comfortably inside Resend's 24-hour idempotency retention window.
export const EMAIL_OUTBOX_RETRY_DELAYS_MS = [
  30_000, // Retry 1: 30s
  120_000, // Retry 2: 2m
  300_000, // Retry 3: 5m
  900_000, // Retry 4: 15m
  1_800_000, // Retry 5: 30m
  3_600_000, // Retry 6: 1h
  7_200_000, // Retry 7: 2h
] as const;

export type OutboxFailureDisposition =
  | 'RETRY'
  | 'PERMANENT'
  | 'CONFIG_FAILURE'
  | 'PAYLOAD_CONFLICT';

export interface OutboxFailureClassification {
  disposition: OutboxFailureDisposition;
  code: string;
  message: string;
}

export interface EmailOutboxPassStats {
  claimed: number;
  accepted: number;
  retried: number;
  failedPermanent: number;
  cancelled: number;
  leaseLost: number;
  reapedExhausted: number;
}

export interface OrderSnapshotSource {
  id: string;
  orderNumber: string;
  customerEmail: string;
  customerName: string;
  totalInCents: number;
  currency: string;
  createdAt: Date;
  event: {
    title: string;
    startAt: Date;
    endAt: Date | null;
    timezone: string | null;
    venueName: string;
    venueAddress: string;
    city: string;
    country: string;
    organizer?: {
      name?: string | null;
      organizer?: {
        displayName?: string | null;
      } | null;
    } | null;
  };
  items: Array<{
    quantity: number;
    unitPriceInCents: number;
    subtotalInCents: number;
    ticketTier: {
      name: string;
      currency: string;
      validityStartAt: Date | null;
      validityEndAt: Date | null;
    };
  }>;
}

export function generateEmailOutboxWorkerId(): string {
  const host = os.hostname().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 32) || 'host';
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${host}:${process.pid}:${suffix}`;
}

export function buildOrderConfirmationDedupeKey(orderId: string): string {
  return `order_confirmation:${orderId}`;
}

export function buildOrderConfirmationIdempotencyKey(orderId: string): string {
  return `order-confirmation:${orderId}`;
}

export function buildLatePaymentRefundConfirmedDedupeKey(orderRefundId: string): string {
  return `late_payment_refund_confirmed:${orderRefundId}`;
}

export function buildLatePaymentRefundConfirmedIdempotencyKey(orderRefundId: string): string {
  return `late-payment-refund-confirmed:${orderRefundId}`;
}

export function buildLatePaymentRefundManualReviewDedupeKey(orderRefundId: string): string {
  return `late_payment_refund_manual_review:${orderRefundId}`;
}

export function buildLatePaymentRefundManualReviewIdempotencyKey(orderRefundId: string): string {
  return `late-payment-refund-manual-review:${orderRefundId}`;
}

export async function enqueueLatePaymentRefundEmail(
  tx: Prisma.TransactionClient,
  params: {
    kind: LatePaymentRefundNotificationKind;
    orderRefundId: string;
    orderId: string | null;
    recipientEmail: string;
    snapshot: Omit<LatePaymentRefundContentSnapshot, 'templateVersion' | 'fromEmail'> & {
      fromEmail?: string;
    };
  }
): Promise<{ enqueued: boolean; dedupeKey: string; idempotencyKey: string }> {
  const dedupeKey =
    params.kind === 'CONFIRMED'
      ? buildLatePaymentRefundConfirmedDedupeKey(params.orderRefundId)
      : buildLatePaymentRefundManualReviewDedupeKey(params.orderRefundId);
  const idempotencyKey =
    params.kind === 'CONFIRMED'
      ? buildLatePaymentRefundConfirmedIdempotencyKey(params.orderRefundId)
      : buildLatePaymentRefundManualReviewIdempotencyKey(params.orderRefundId);
  const type =
    params.kind === 'CONFIRMED'
      ? EmailOutboxType.LATE_PAYMENT_REFUND_CONFIRMED
      : EmailOutboxType.LATE_PAYMENT_REFUND_MANUAL_REVIEW;

  const fullSnapshot: LatePaymentRefundContentSnapshot = {
    templateVersion: LATE_PAYMENT_REFUND_TEMPLATE_VERSION,
    orderRefundId: params.snapshot.orderRefundId,
    fromEmail: params.snapshot.fromEmail || resolveEmailFrom(),
    orderNumber: params.snapshot.orderNumber,
    refundAmountInCents: params.snapshot.refundAmountInCents,
    currency: params.snapshot.currency.toUpperCase(),
    buyerName: params.snapshot.buyerName,
    eventTitle: params.snapshot.eventTitle,
    stripeRefundId: params.snapshot.stripeRefundId ?? null,
    confirmedAtIso: params.snapshot.confirmedAtIso ?? null,
    reasonSummary: params.snapshot.reasonSummary,
  };

  const result = await tx.emailOutbox.createMany({
    data: [
      {
        dedupeKey,
        type,
        status: EmailOutboxStatus.PENDING,
        orderId: params.orderId,
        recipientEmail: normalizeEmail(params.recipientEmail),
        idempotencyKey,
        templateVersion: fullSnapshot.templateVersion,
        contentSnapshot: fullSnapshot as unknown as Prisma.InputJsonValue,
        attempts: 0,
        maxAttempts: EMAIL_OUTBOX_MAX_ATTEMPTS,
        nextAttemptAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });

    return {
      enqueued: result.count > 0,
      dedupeKey,
      idempotencyKey,
    };
}

export function buildBuyerRefundConfirmedDedupeKey(orderRefundId: string): string {
  return `buyer_refund_confirmed:${orderRefundId}`;
}

export function buildBuyerRefundConfirmedIdempotencyKey(orderRefundId: string): string {
  return `buyer-refund-confirmed:${orderRefundId}`;
}

export function buildBuyerRefundManualReviewDedupeKey(orderRefundId: string): string {
  return `buyer_refund_manual_review:${orderRefundId}`;
}

export function buildBuyerRefundManualReviewIdempotencyKey(orderRefundId: string): string {
  return `buyer-refund-manual-review:${orderRefundId}`;
}

export async function enqueueBuyerRefundEmail(
  tx: Prisma.TransactionClient,
  params: {
    kind: BuyerRefundNotificationKind;
    orderRefundId: string;
    orderId: string | null;
    recipientEmail: string;
    snapshot: Omit<BuyerRefundContentSnapshot, 'templateVersion' | 'fromEmail'> & {
      fromEmail?: string;
    };
  }
): Promise<{ enqueued: boolean; dedupeKey: string; idempotencyKey: string }> {
  const dedupeKey =
    params.kind === 'CONFIRMED'
      ? buildBuyerRefundConfirmedDedupeKey(params.orderRefundId)
      : buildBuyerRefundManualReviewDedupeKey(params.orderRefundId);
  const idempotencyKey =
    params.kind === 'CONFIRMED'
      ? buildBuyerRefundConfirmedIdempotencyKey(params.orderRefundId)
      : buildBuyerRefundManualReviewIdempotencyKey(params.orderRefundId);
  const type =
    params.kind === 'CONFIRMED'
      ? EmailOutboxType.BUYER_REFUND_CONFIRMED
      : EmailOutboxType.BUYER_REFUND_MANUAL_REVIEW;

  const fullSnapshot: BuyerRefundContentSnapshot = {
    templateVersion: BUYER_REFUND_TEMPLATE_VERSION,
    orderRefundId: params.snapshot.orderRefundId,
    fromEmail: params.snapshot.fromEmail || resolveEmailFrom(),
    orderNumber: params.snapshot.orderNumber,
    refundAmountInCents: params.snapshot.refundAmountInCents,
    currency: params.snapshot.currency.toUpperCase(),
    buyerName: params.snapshot.buyerName,
    eventTitle: params.snapshot.eventTitle,
    ticketCount: params.snapshot.ticketCount,
    isPartialRefund: Boolean(params.snapshot.isPartialRefund),
    stripeRefundId: params.snapshot.stripeRefundId ?? null,
    confirmedAtIso: params.snapshot.confirmedAtIso ?? null,
    reasonSummary: params.snapshot.reasonSummary,
  };

  const result = await tx.emailOutbox.createMany({
    data: [
      {
        dedupeKey,
        type,
        status: EmailOutboxStatus.PENDING,
        orderId: params.orderId,
        recipientEmail: normalizeEmail(params.recipientEmail),
        idempotencyKey,
        templateVersion: fullSnapshot.templateVersion,
        contentSnapshot: fullSnapshot as unknown as Prisma.InputJsonValue,
        attempts: 0,
        maxAttempts: EMAIL_OUTBOX_MAX_ATTEMPTS,
        nextAttemptAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });

  return {
    enqueued: result.count > 0,
    dedupeKey,
    idempotencyKey,
  };
}

/**
 * Builds the immutable fulfillment-time snapshot stored in EmailOutbox.contentSnapshot.
 * Intentionally excludes orderAccessToken and individual ticket QR tokens so secrets are
 * never duplicated into outbox JSON payloads.
 */
export function buildOrderConfirmationSnapshot(
  order: OrderSnapshotSource,
  clientOrigin?: string | null,
  fromEmail?: string | null
): OrderConfirmationContentSnapshot {
  const items: OrderConfirmationSnapshotItem[] = order.items.map((item) => ({
    tierName: item.ticketTier.name,
    quantity: item.quantity,
    unitPriceInCents: item.unitPriceInCents,
    subtotalInCents: item.subtotalInCents,
    currency: (item.ticketTier.currency || order.currency || 'USD').toUpperCase(),
    validityStartAtIso: item.ticketTier.validityStartAt
      ? item.ticketTier.validityStartAt.toISOString()
      : null,
    validityEndAtIso: item.ticketTier.validityEndAt
      ? item.ticketTier.validityEndAt.toISOString()
      : null,
  }));

  const totalTickets = items.reduce((sum, item) => sum + item.quantity, 0);
  const organizerName =
    order.event.organizer?.organizer?.displayName ||
    order.event.organizer?.name ||
    'Outside.vip';

  const resolvedFromEmail =
    (typeof fromEmail === 'string'
      ? fromEmail.replace(/[\r\n]+/g, ' ').trim().replace(/^["']+|["']+$/g, '').trim()
      : '') || resolveEmailFrom();

  return {
    templateVersion: ORDER_CONFIRMATION_TEMPLATE_VERSION,
    clientOrigin: normalizeClientOrigin(clientOrigin),
    fromEmail: resolvedFromEmail,
    orderNumber: order.orderNumber,
    purchaseDateIso: order.createdAt.toISOString(),
    totalInCents: order.totalInCents,
    currency: (order.currency || 'USD').toUpperCase(),
    buyerName: order.customerName,
    eventTitle: order.event.title,
    eventStartAtIso: order.event.startAt.toISOString(),
    eventEndAtIso: order.event.endAt ? order.event.endAt.toISOString() : null,
    eventTimezone: order.event.timezone || 'UTC',
    venueName: order.event.venueName,
    venueAddress: order.event.venueAddress,
    city: order.event.city,
    country: order.event.country,
    organizerName,
    totalTickets,
    items,
  };
}

/**
 * Computes retry delay (ms) with ±20% jitter for a completed attempt count (1-based).
 */
export function computeNextRetryDelayMs(
  completedAttempt: number,
  randomFn: () => number = Math.random
): number {
  const idx = Math.max(
    0,
    Math.min(completedAttempt - 1, EMAIL_OUTBOX_RETRY_DELAYS_MS.length - 1)
  );
  const baseMs = EMAIL_OUTBOX_RETRY_DELAYS_MS[idx];
  const clampedRandom = Math.max(0, Math.min(1, randomFn()));
  const jitterFactor = 0.8 + clampedRandom * 0.4; // [0.8, 1.2]
  return Math.max(1_000, Math.round(baseMs * jitterFactor));
}

/**
 * Classifies email dispatch errors for durable outbox handling:
 * - Missing RESEND_API_KEY and HTTP 401/403 => CONFIG_FAILURE (permanent, immediate alert)
 * - HTTP 409 payload mismatch => PAYLOAD_CONFLICT (permanent implementation error, immediate alert)
 * - HTTP 400/422 => PERMANENT (invalid recipient or rejected payload)
 * - HTTP 409 concurrent identical request, HTTP 429, HTTP 5xx, network, timeout => RETRY
 */
export function classifyOutboxFailure(
  error: unknown,
  sensitiveValues: string[] = []
): OutboxFailureClassification {
  if (error instanceof EmailDeliveryError) {
    const safeMsg = sanitizeEmailLogMessage(
      error.providerDetail || error.message,
      sensitiveValues
    );

    if (
      error.code === 'EMAIL_SERVICE_UNCONFIGURED' ||
      error.code === 'EMAIL_PROVIDER_AUTH_FAILED' ||
      error.providerStatusCode === 401 ||
      error.providerStatusCode === 403
    ) {
      return {
        disposition: 'CONFIG_FAILURE',
        code: error.code || 'EMAIL_PROVIDER_AUTH_FAILED',
        message: safeMsg,
      };
    }

    if (error.code === 'EMAIL_IDEMPOTENCY_PAYLOAD_CONFLICT') {
      return {
        disposition: 'PAYLOAD_CONFLICT',
        code: 'EMAIL_IDEMPOTENCY_PAYLOAD_CONFLICT',
        message: safeMsg,
      };
    }

    if (error.code === 'EMAIL_IDEMPOTENCY_CONCURRENT') {
      return {
        disposition: 'RETRY',
        code: 'EMAIL_IDEMPOTENCY_CONCURRENT',
        message: safeMsg,
      };
    }

    if (error.code === 'EMAIL_PROVIDER_RATE_LIMITED' || error.providerStatusCode === 429) {
      return {
        disposition: 'RETRY',
        code: 'EMAIL_PROVIDER_RATE_LIMITED',
        message: safeMsg,
      };
    }

    if (
      error.providerStatusCode === 400 ||
      error.providerStatusCode === 422 ||
      error.code === 'EMAIL_DELIVERY_REJECTED'
    ) {
      return {
        disposition: 'PERMANENT',
        code: error.code || 'EMAIL_DELIVERY_REJECTED',
        message: safeMsg,
      };
    }

    if (
      error.retryable ||
      error.timedOut ||
      (error.providerStatusCode !== null && error.providerStatusCode >= 500) ||
      error.code === 'EMAIL_DELIVERY_TIMEOUT' ||
      error.code === 'EMAIL_NETWORK_ERROR' ||
      error.code === 'EMAIL_PROVIDER_UNAVAILABLE' ||
      error.code === 'EMAIL_INVALID_PROVIDER_RESPONSE'
    ) {
      return {
        disposition: 'RETRY',
        code: error.code || 'EMAIL_TRANSIENT_ERROR',
        message: safeMsg,
      };
    }

    return {
      disposition: 'PERMANENT',
      code: error.code || 'EMAIL_DELIVERY_FAILED',
      message: safeMsg,
    };
  }

  const rawMessage = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return {
    disposition: 'RETRY',
    code: 'EMAIL_UNEXPECTED_ERROR',
    message: sanitizeEmailLogMessage(rawMessage, sensitiveValues),
  };
}

/**
 * Idempotently inserts the durable ORDER_CONFIRMATION outbox row inside the caller's
 * PostgreSQL fulfillment transaction. Never performs external HTTP calls.
 */
export async function enqueueOrderConfirmationEmail(
  tx: Prisma.TransactionClient,
  order: OrderSnapshotSource
): Promise<{ enqueued: boolean; dedupeKey: string; idempotencyKey: string }> {
  const dedupeKey = buildOrderConfirmationDedupeKey(order.id);
  const idempotencyKey = buildOrderConfirmationIdempotencyKey(order.id);
  const snapshot = buildOrderConfirmationSnapshot(order);

  const result = await tx.emailOutbox.createMany({
    data: [
      {
        dedupeKey,
        type: EmailOutboxType.ORDER_CONFIRMATION,
        status: EmailOutboxStatus.PENDING,
        orderId: order.id,
        recipientEmail: normalizeEmail(order.customerEmail),
        idempotencyKey,
        templateVersion: snapshot.templateVersion,
        contentSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        attempts: 0,
        maxAttempts: EMAIL_OUTBOX_MAX_ATTEMPTS,
        nextAttemptAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });

  return {
    enqueued: result.count > 0,
    dedupeKey,
    idempotencyKey,
  };
}

export function buildEventCancelledBuyerDedupeKey(eventId: string, orderId: string): string {
  return `event_cancelled_buyer:${eventId}:${orderId}`;
}

export function buildEventCancelledBuyerIdempotencyKey(eventId: string, orderId: string): string {
  return `event-cancelled-buyer:${eventId}:${orderId}`;
}

export function buildEventCancelledOrganizerDedupeKey(eventId: string): string {
  return `event_cancelled_organizer:${eventId}`;
}

export function buildEventCancelledOrganizerIdempotencyKey(eventId: string): string {
  return `event-cancelled-organizer:${eventId}`;
}

export async function enqueueEventCancelledBuyerEmail(
  tx: Prisma.TransactionClient,
  params: {
    eventId: string;
    orderId: string;
    recipientEmail: string;
    snapshot: Omit<
      EventCancelledBuyerContentSnapshot,
      'templateVersion' | 'fromEmail' | 'eventId' | 'orderId'
    > & {
      fromEmail?: string;
    };
  }
): Promise<{ enqueued: boolean; dedupeKey: string; idempotencyKey: string }> {
  const dedupeKey = buildEventCancelledBuyerDedupeKey(params.eventId, params.orderId);
  const idempotencyKey = buildEventCancelledBuyerIdempotencyKey(params.eventId, params.orderId);

  const fullSnapshot: EventCancelledBuyerContentSnapshot = {
    templateVersion: EVENT_CANCELLED_TEMPLATE_VERSION,
    eventId: params.eventId,
    orderId: params.orderId,
    fromEmail: params.snapshot.fromEmail || resolveEmailFrom(),
    orderNumber: params.snapshot.orderNumber,
    buyerName: params.snapshot.buyerName,
    eventTitle: params.snapshot.eventTitle,
    eventStartAtIso: params.snapshot.eventStartAtIso ?? null,
    cancelledAtIso: params.snapshot.cancelledAtIso,
    cancellationReason: params.snapshot.cancellationReason,
    ticketCount: Math.max(1, params.snapshot.ticketCount),
    orderTotalInCents: Math.max(0, params.snapshot.orderTotalInCents),
    currency: (params.snapshot.currency || 'USD').toUpperCase(),
  };

  const result = await tx.emailOutbox.createMany({
    data: [
      {
        dedupeKey,
        type: EmailOutboxType.EVENT_CANCELLED_BUYER,
        status: EmailOutboxStatus.PENDING,
        orderId: params.orderId,
        recipientEmail: normalizeEmail(params.recipientEmail),
        idempotencyKey,
        templateVersion: fullSnapshot.templateVersion,
        contentSnapshot: fullSnapshot as unknown as Prisma.InputJsonValue,
        attempts: 0,
        maxAttempts: EMAIL_OUTBOX_MAX_ATTEMPTS,
        nextAttemptAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });

  return {
    enqueued: result.count > 0,
    dedupeKey,
    idempotencyKey,
  };
}

export async function enqueueEventCancelledOrganizerEmail(
  tx: Prisma.TransactionClient,
  params: {
    eventId: string;
    recipientEmail: string;
    snapshot: Omit<
      EventCancelledOrganizerContentSnapshot,
      'templateVersion' | 'fromEmail' | 'eventId'
    > & {
      fromEmail?: string;
    };
  }
): Promise<{ enqueued: boolean; dedupeKey: string; idempotencyKey: string }> {
  const dedupeKey = buildEventCancelledOrganizerDedupeKey(params.eventId);
  const idempotencyKey = buildEventCancelledOrganizerIdempotencyKey(params.eventId);

  const fullSnapshot: EventCancelledOrganizerContentSnapshot = {
    templateVersion: EVENT_CANCELLED_TEMPLATE_VERSION,
    eventId: params.eventId,
    fromEmail: params.snapshot.fromEmail || resolveEmailFrom(),
    organizerName: params.snapshot.organizerName,
    eventTitle: params.snapshot.eventTitle,
    eventStartAtIso: params.snapshot.eventStartAtIso ?? null,
    cancelledAtIso: params.snapshot.cancelledAtIso,
    actorEmail: params.snapshot.actorEmail,
    cancellationReason: params.snapshot.cancellationReason,
    affectedOrdersCount: Math.max(0, params.snapshot.affectedOrdersCount),
    cancelledPendingOrdersCount: Math.max(0, params.snapshot.cancelledPendingOrdersCount),
  };

  const result = await tx.emailOutbox.createMany({
    data: [
      {
        dedupeKey,
        type: EmailOutboxType.EVENT_CANCELLED_ORGANIZER,
        status: EmailOutboxStatus.PENDING,
        orderId: null,
        recipientEmail: normalizeEmail(params.recipientEmail),
        idempotencyKey,
        templateVersion: fullSnapshot.templateVersion,
        contentSnapshot: fullSnapshot as unknown as Prisma.InputJsonValue,
        attempts: 0,
        maxAttempts: EMAIL_OUTBOX_MAX_ATTEMPTS,
        nextAttemptAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });

  return {
    enqueued: result.count > 0,
    dedupeKey,
    idempotencyKey,
  };
}

function isValidEventCancelledBuyerSnapshot(
  raw: unknown
): raw is EventCancelledBuyerContentSnapshot {
  if (!raw || typeof raw !== 'object') return false;
  const c = raw as Record<string, unknown>;
  return (
    c.templateVersion === EVENT_CANCELLED_TEMPLATE_VERSION &&
    typeof c.eventId === 'string' &&
    typeof c.orderId === 'string' &&
    typeof c.fromEmail === 'string' &&
    typeof c.orderNumber === 'string' &&
    typeof c.buyerName === 'string' &&
    typeof c.eventTitle === 'string' &&
    typeof c.cancelledAtIso === 'string' &&
    typeof c.cancellationReason === 'string' &&
    typeof c.ticketCount === 'number' &&
    typeof c.orderTotalInCents === 'number' &&
    typeof c.currency === 'string'
  );
}

function isValidEventCancelledOrganizerSnapshot(
  raw: unknown
): raw is EventCancelledOrganizerContentSnapshot {
  if (!raw || typeof raw !== 'object') return false;
  const c = raw as Record<string, unknown>;
  return (
    c.templateVersion === EVENT_CANCELLED_TEMPLATE_VERSION &&
    typeof c.eventId === 'string' &&
    typeof c.fromEmail === 'string' &&
    typeof c.organizerName === 'string' &&
    typeof c.eventTitle === 'string' &&
    typeof c.cancelledAtIso === 'string' &&
    typeof c.actorEmail === 'string' &&
    typeof c.cancellationReason === 'string' &&
    typeof c.affectedOrdersCount === 'number' &&
    typeof c.cancelledPendingOrdersCount === 'number'
  );
}

function isValidOrderConfirmationSnapshot(
  raw: unknown
): raw is OrderConfirmationContentSnapshot {
  if (!raw || typeof raw !== 'object') return false;
  const candidate = raw as Record<string, unknown>;
  if (
    candidate.templateVersion !== ORDER_CONFIRMATION_TEMPLATE_VERSION ||
    typeof candidate.clientOrigin !== 'string' ||
    candidate.clientOrigin.trim().length === 0 ||
    typeof candidate.fromEmail !== 'string' ||
    candidate.fromEmail.trim().length === 0 ||
    typeof candidate.orderNumber !== 'string' ||
    candidate.orderNumber.length === 0 ||
    typeof candidate.eventTitle !== 'string' ||
    typeof candidate.purchaseDateIso !== 'string' ||
    typeof candidate.totalInCents !== 'number' ||
    typeof candidate.currency !== 'string' ||
    !Array.isArray(candidate.items)
  ) {
    return false;
  }
  try {
    normalizeClientOrigin(candidate.clientOrigin);
    return true;
  } catch {
    return false;
  }
}

function isValidLatePaymentRefundSnapshot(
  raw: unknown
): raw is LatePaymentRefundContentSnapshot {
  if (!raw || typeof raw !== 'object') return false;
  const candidate = raw as Record<string, unknown>;
  return (
    candidate.templateVersion === LATE_PAYMENT_REFUND_TEMPLATE_VERSION &&
    typeof candidate.orderRefundId === 'string' &&
    candidate.orderRefundId.length > 0 &&
    typeof candidate.fromEmail === 'string' &&
    candidate.fromEmail.trim().length > 0 &&
    typeof candidate.orderNumber === 'string' &&
    candidate.orderNumber.length > 0 &&
    typeof candidate.refundAmountInCents === 'number' &&
    typeof candidate.currency === 'string' &&
    typeof candidate.buyerName === 'string' &&
    typeof candidate.eventTitle === 'string' &&
    typeof candidate.reasonSummary === 'string'
  );
}

function isValidBuyerRefundSnapshot(
  raw: unknown
): raw is BuyerRefundContentSnapshot {
  if (!raw || typeof raw !== 'object') return false;
  const candidate = raw as Record<string, unknown>;
  return (
    candidate.templateVersion === BUYER_REFUND_TEMPLATE_VERSION &&
    typeof candidate.orderRefundId === 'string' &&
    candidate.orderRefundId.length > 0 &&
    typeof candidate.fromEmail === 'string' &&
    candidate.fromEmail.trim().length > 0 &&
    typeof candidate.orderNumber === 'string' &&
    candidate.orderNumber.length > 0 &&
    typeof candidate.refundAmountInCents === 'number' &&
    typeof candidate.currency === 'string' &&
    typeof candidate.buyerName === 'string' &&
    typeof candidate.eventTitle === 'string' &&
    typeof candidate.ticketCount === 'number' &&
    typeof candidate.reasonSummary === 'string'
  );
}

function emitOperationalAlert(
  severity: 'CRITICAL' | 'ERROR',
  category: string,
  details: {
    outboxId: string;
    orderId: string | null;
    recipientEmail: string;
    attempts: number;
    maxAttempts: number;
    code: string;
    message: string;
  }
): void {
  console.error(`[EmailOutbox][${severity}][${category}]`, {
    outboxId: details.outboxId,
    orderId: details.orderId,
    recipient: maskEmailForLog(details.recipientEmail),
    attempts: details.attempts,
    maxAttempts: details.maxAttempts,
    errorCode: details.code,
    errorMessage: details.message,
  });
}

/**
 * Transitions expired PROCESSING leases that already consumed all maxAttempts into
 * FAILED_PERMANENT so stuck records are surfaced rather than left leased indefinitely.
 */
export async function reapExpiredExhaustedLeases(): Promise<number> {
  const reaped = await prisma.$queryRaw<
    Array<{
      id: string;
      orderId: string | null;
      recipientEmail: string;
      attempts: number;
      maxAttempts: number;
      lastErrorCode: string | null;
    }>
  >`
    UPDATE "EmailOutbox"
    SET
      status = 'FAILED_PERMANENT'::"EmailOutboxStatus",
      "lockedBy" = NULL,
      "lockedUntil" = NULL,
      "failedAt" = COALESCE("failedAt", NOW()),
      "lastErrorCode" = COALESCE("lastErrorCode", 'WORKER_LEASE_EXPIRED_MAX_ATTEMPTS'),
      "lastErrorMessage" = COALESCE(
        "lastErrorMessage",
        'Worker lease expired after reaching maximum delivery attempts'
      ),
      "updatedAt" = NOW()
    WHERE status = 'PROCESSING'::"EmailOutboxStatus"
      AND "lockedUntil" IS NOT NULL
      AND "lockedUntil" < NOW()
      AND attempts >= "maxAttempts"
    RETURNING id, "orderId", "recipientEmail", attempts, "maxAttempts", "lastErrorCode"
  `;

  for (const row of reaped) {
    emitOperationalAlert('ERROR', 'LEASE_EXHAUSTED', {
      outboxId: row.id,
      orderId: row.orderId,
      recipientEmail: row.recipientEmail,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      code: row.lastErrorCode || 'WORKER_LEASE_EXPIRED_MAX_ATTEMPTS',
      message: 'Worker lease expired after reaching maximum delivery attempts',
    });
  }

  return reaped.length;
}

/**
 * Atomically claims due PENDING rows and expired PROCESSING leases using PostgreSQL
 * FOR UPDATE SKIP LOCKED so concurrent API instances never claim the same notification.
 */
export async function claimPendingEmailOutboxBatch(options?: {
  workerId?: string;
  batchSize?: number;
  leaseMs?: number;
}): Promise<{ workerId: string; claimed: EmailOutbox[]; reapedExhausted: number }> {
  const workerId = options?.workerId || generateEmailOutboxWorkerId();
  const batchSize = Math.max(1, Math.min(options?.batchSize ?? EMAIL_OUTBOX_BATCH_SIZE, 100));
  const leaseMs = Math.max(5_000, options?.leaseMs ?? EMAIL_OUTBOX_LEASE_MS);

  const reapedExhausted = await reapExpiredExhaustedLeases();

  const claimed = await prisma.$queryRaw<EmailOutbox[]>`
    WITH claimable AS (
      SELECT id
      FROM "EmailOutbox"
      WHERE (
        status = 'PENDING'::"EmailOutboxStatus"
        AND "nextAttemptAt" <= NOW()
        AND attempts < "maxAttempts"
      ) OR (
        status = 'PROCESSING'::"EmailOutboxStatus"
        AND "lockedUntil" IS NOT NULL
        AND "lockedUntil" < NOW()
        AND attempts < "maxAttempts"
      )
      ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "EmailOutbox" AS o
    SET
      status = 'PROCESSING'::"EmailOutboxStatus",
      "lockedBy" = ${workerId},
      "lockedUntil" = NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
      attempts = o.attempts + 1,
      "lastAttemptAt" = NOW(),
      "updatedAt" = NOW()
    FROM claimable
    WHERE o.id = claimable.id
    RETURNING o.*
  `;

  return { workerId, claimed, reapedExhausted };
}

/**
 * Processes a single claimed EmailOutbox record with lease-guarded state transitions.
 * Never issues tickets and never throws unhandled errors into payment paths.
 */
export async function processClaimedEmailOutboxItem(
  item: EmailOutbox,
  workerId: string,
  options?: {
    randomFn?: () => number;
  }
): Promise<'accepted' | 'retried' | 'failedPermanent' | 'cancelled' | 'leaseLost'> {
  const markCancelledGuarded = async (
    code: string,
    message: string
  ): Promise<'cancelled' | 'leaseLost'> => {
    const updated = await prisma.emailOutbox.updateMany({
      where: {
        id: item.id,
        status: EmailOutboxStatus.PROCESSING,
        lockedBy: workerId,
      },
      data: {
        status: EmailOutboxStatus.CANCELLED,
        lockedBy: null,
        lockedUntil: null,
        lastErrorCode: code,
        lastErrorMessage: message,
      },
    });

    if (updated.count === 0) {
      console.warn(
        `[EmailOutbox] Lease lost before marking CANCELLED for outbox=${item.id} (worker=${workerId})`
      );
      return 'leaseLost';
    }

    return 'cancelled';
  };

  const markPermanentGuarded = async (
    code: string,
    message: string,
    severity: 'CRITICAL' | 'ERROR',
    category: string
  ): Promise<'failedPermanent' | 'leaseLost'> => {
    const updated = await prisma.emailOutbox.updateMany({
      where: {
        id: item.id,
        status: EmailOutboxStatus.PROCESSING,
        lockedBy: workerId,
      },
      data: {
        status: EmailOutboxStatus.FAILED_PERMANENT,
        failedAt: new Date(),
        lockedBy: null,
        lockedUntil: null,
        lastErrorCode: code,
        lastErrorMessage: message,
      },
    });

    if (updated.count === 0) {
      console.warn(
        `[EmailOutbox] Lease lost before recording permanent failure for outbox=${item.id} (worker=${workerId})`
      );
      return 'leaseLost';
    }

    emitOperationalAlert(severity, category, {
      outboxId: item.id,
      orderId: item.orderId,
      recipientEmail: item.recipientEmail,
      attempts: item.attempts,
      maxAttempts: item.maxAttempts,
      code,
      message,
    });
    return 'failedPermanent';
  };

  if (
    item.type === EmailOutboxType.LATE_PAYMENT_REFUND_CONFIRMED ||
    item.type === EmailOutboxType.LATE_PAYMENT_REFUND_MANUAL_REVIEW
  ) {
    const kind: LatePaymentRefundNotificationKind =
      item.type === EmailOutboxType.LATE_PAYMENT_REFUND_CONFIRMED ? 'CONFIRMED' : 'MANUAL_REVIEW';

    if (!isValidLatePaymentRefundSnapshot(item.contentSnapshot)) {
      return markPermanentGuarded(
        'INVALID_CONTENT_SNAPSHOT',
        'Stored refund email content snapshot is invalid.',
        'CRITICAL',
        'SNAPSHOT_CORRUPT'
      );
    }

    const snapshot = item.contentSnapshot;
    const refundRecord = await prisma.orderRefund.findUnique({
      where: { id: snapshot.orderRefundId },
      select: {
        id: true,
        status: true,
        requiresManualResolution: true,
        stripeRefundId: true,
        order: {
          select: { status: true },
        },
      },
    });

    if (!refundRecord) {
      return markPermanentGuarded(
        'ORDER_REFUND_MISSING',
        'Associated OrderRefund record could not be found during notification dispatch.',
        'ERROR',
        'REFUND_STATE_MISMATCH'
      );
    }

    if (kind === 'CONFIRMED' && refundRecord.status !== OrderRefundStatus.SUCCEEDED) {
      return markPermanentGuarded(
        'REFUND_NOT_CONFIRMED',
        `Refund confirmation email blocked because OrderRefund status is ${refundRecord.status}, not SUCCEEDED.`,
        'CRITICAL',
        'REFUND_STATE_MISMATCH'
      );
    }

    if (
      kind === 'MANUAL_REVIEW' &&
      (refundRecord.status === OrderRefundStatus.MANUALLY_RESOLVED ||
        refundRecord.status === OrderRefundStatus.SUCCEEDED)
    ) {
      return markCancelledGuarded(
        'REFUND_ALREADY_RESOLVED',
        `Superseded stale manual-review notification because OrderRefund is already ${refundRecord.status}.`
      );
    }

    if (
      kind === 'MANUAL_REVIEW' &&
      refundRecord.status !== OrderRefundStatus.MANUAL_REVIEW_REQUIRED &&
      !refundRecord.requiresManualResolution
    ) {
      return markPermanentGuarded(
        'REFUND_NOT_MANUAL_REVIEW',
        `Manual-review refund email blocked because OrderRefund status is ${refundRecord.status}.`,
        'ERROR',
        'REFUND_STATE_MISMATCH'
      );
    }

    try {
      const result = await sendLatePaymentRefundEmail({
        kind,
        to: item.recipientEmail,
        snapshot,
        idempotencyKey: item.idempotencyKey,
      });

      const updated = await prisma.emailOutbox.updateMany({
        where: {
          id: item.id,
          status: EmailOutboxStatus.PROCESSING,
          lockedBy: workerId,
        },
        data: {
          status: EmailOutboxStatus.SENT,
          provider: result.provider,
          providerMessageId: result.messageId,
          sentAt: result.sentAt,
          lockedBy: null,
          lockedUntil: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });

      if (updated.count === 0) {
        console.warn(
          `[EmailOutbox] Lease lost before marking SENT for refund outbox=${item.id} (worker=${workerId})`
        );
        return 'leaseLost';
      }

      return 'accepted';
    } catch (err) {
      const classification = classifyOutboxFailure(err);

      if (classification.disposition === 'CONFIG_FAILURE') {
        return markPermanentGuarded(
          classification.code,
          classification.message,
          'CRITICAL',
          'EMAIL_CONFIG_FAILURE'
        );
      }

      if (classification.disposition === 'PAYLOAD_CONFLICT') {
        return markPermanentGuarded(
          classification.code,
          classification.message,
          'CRITICAL',
          'RESEND_IDEMPOTENCY_PAYLOAD_CONFLICT'
        );
      }

      if (classification.disposition === 'PERMANENT' || item.attempts >= item.maxAttempts) {
        return markPermanentGuarded(
          classification.code,
          classification.message,
          'ERROR',
          item.attempts >= item.maxAttempts ? 'RETRIES_EXHAUSTED' : 'PERMANENT_DELIVERY_FAILURE'
        );
      }

      const delayMs = computeNextRetryDelayMs(item.attempts, options?.randomFn);
      const nextAttemptAt = new Date(Date.now() + delayMs);

      const updated = await prisma.emailOutbox.updateMany({
        where: {
          id: item.id,
          status: EmailOutboxStatus.PROCESSING,
          lockedBy: workerId,
        },
        data: {
          status: EmailOutboxStatus.PENDING,
          nextAttemptAt,
          lockedBy: null,
          lockedUntil: null,
          lastErrorCode: classification.code,
          lastErrorMessage: classification.message,
        },
      });

      if (updated.count === 0) {
        console.warn(
          `[EmailOutbox] Lease lost before scheduling retry for refund outbox=${item.id} (worker=${workerId})`
        );
        return 'leaseLost';
      }

      return 'retried';
    }
  }

  if (
    item.type === EmailOutboxType.BUYER_REFUND_CONFIRMED ||
    item.type === EmailOutboxType.BUYER_REFUND_MANUAL_REVIEW
  ) {
    const kind: BuyerRefundNotificationKind =
      item.type === EmailOutboxType.BUYER_REFUND_CONFIRMED ? 'CONFIRMED' : 'MANUAL_REVIEW';

    if (!isValidBuyerRefundSnapshot(item.contentSnapshot)) {
      return markPermanentGuarded(
        'INVALID_CONTENT_SNAPSHOT',
        'Stored buyer refund email content snapshot is invalid.',
        'CRITICAL',
        'SNAPSHOT_CORRUPT'
      );
    }

    const snapshot = item.contentSnapshot;
    const refundRecord = await prisma.orderRefund.findUnique({
      where: { id: snapshot.orderRefundId },
      select: {
        id: true,
        status: true,
        requiresManualResolution: true,
        stripeRefundId: true,
      },
    });

    if (!refundRecord) {
      return markPermanentGuarded(
        'ORDER_REFUND_MISSING',
        'Associated OrderRefund record could not be found during buyer notification dispatch.',
        'ERROR',
        'REFUND_STATE_MISMATCH'
      );
    }

    if (kind === 'CONFIRMED' && refundRecord.status !== OrderRefundStatus.SUCCEEDED) {
      return markPermanentGuarded(
        'REFUND_NOT_CONFIRMED',
        `Buyer refund confirmation email blocked because OrderRefund status is ${refundRecord.status}, not SUCCEEDED.`,
        'CRITICAL',
        'REFUND_STATE_MISMATCH'
      );
    }

    if (
      kind === 'MANUAL_REVIEW' &&
      (refundRecord.status === OrderRefundStatus.MANUALLY_RESOLVED ||
        refundRecord.status === OrderRefundStatus.SUCCEEDED ||
        refundRecord.status === OrderRefundStatus.CANCELLED)
    ) {
      return markCancelledGuarded(
        'REFUND_ALREADY_RESOLVED',
        `Superseded stale manual-review buyer notification because OrderRefund is ${refundRecord.status}.`
      );
    }

    if (
      kind === 'MANUAL_REVIEW' &&
      refundRecord.status !== OrderRefundStatus.MANUAL_REVIEW_REQUIRED &&
      !refundRecord.requiresManualResolution
    ) {
      return markPermanentGuarded(
        'REFUND_NOT_MANUAL_REVIEW',
        `Manual-review buyer refund email blocked because OrderRefund status is ${refundRecord.status}.`,
        'ERROR',
        'REFUND_STATE_MISMATCH'
      );
    }

    try {
      const result = await sendBuyerRefundEmail({
        kind,
        to: item.recipientEmail,
        snapshot,
        idempotencyKey: item.idempotencyKey,
      });

      const updated = await prisma.emailOutbox.updateMany({
        where: {
          id: item.id,
          status: EmailOutboxStatus.PROCESSING,
          lockedBy: workerId,
        },
        data: {
          status: EmailOutboxStatus.SENT,
          provider: result.provider,
          providerMessageId: result.messageId,
          sentAt: result.sentAt,
          lockedBy: null,
          lockedUntil: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });

      if (updated.count === 0) {
        console.warn(
          `[EmailOutbox] Lease lost before marking SENT for buyer refund outbox=${item.id} (worker=${workerId})`
        );
        return 'leaseLost';
      }

      return 'accepted';
    } catch (err) {
      const classification = classifyOutboxFailure(err);

      if (classification.disposition === 'CONFIG_FAILURE') {
        return markPermanentGuarded(
          classification.code,
          classification.message,
          'CRITICAL',
          'EMAIL_CONFIG_FAILURE'
        );
      }

      if (classification.disposition === 'PAYLOAD_CONFLICT') {
        return markPermanentGuarded(
          classification.code,
          classification.message,
          'CRITICAL',
          'RESEND_IDEMPOTENCY_PAYLOAD_CONFLICT'
        );
      }

      if (classification.disposition === 'PERMANENT' || item.attempts >= item.maxAttempts) {
        return markPermanentGuarded(
          classification.code,
          classification.message,
          'ERROR',
          item.attempts >= item.maxAttempts ? 'RETRIES_EXHAUSTED' : 'PERMANENT_DELIVERY_FAILURE'
        );
      }

      const delayMs = computeNextRetryDelayMs(item.attempts, options?.randomFn);
      const nextAttemptAt = new Date(Date.now() + delayMs);

      const updated = await prisma.emailOutbox.updateMany({
        where: {
          id: item.id,
          status: EmailOutboxStatus.PROCESSING,
          lockedBy: workerId,
        },
        data: {
          status: EmailOutboxStatus.PENDING,
          nextAttemptAt,
          lockedBy: null,
          lockedUntil: null,
          lastErrorCode: classification.code,
          lastErrorMessage: classification.message,
        },
      });

      if (updated.count === 0) {
        return 'leaseLost';
      }

      return 'retried';
    }
  }

  if (item.type === EmailOutboxType.EVENT_CANCELLED_BUYER) {
    if (!isValidEventCancelledBuyerSnapshot(item.contentSnapshot)) {
      return markPermanentGuarded(
        'INVALID_CONTENT_SNAPSHOT',
        'Stored buyer event cancellation snapshot is invalid.',
        'CRITICAL',
        'SNAPSHOT_CORRUPT'
      );
    }

    try {
      const result = await sendEventCancelledBuyerEmail({
        to: item.recipientEmail,
        snapshot: item.contentSnapshot,
        idempotencyKey: item.idempotencyKey,
      });

      const updated = await prisma.emailOutbox.updateMany({
        where: {
          id: item.id,
          status: EmailOutboxStatus.PROCESSING,
          lockedBy: workerId,
        },
        data: {
          status: EmailOutboxStatus.SENT,
          provider: result.provider,
          providerMessageId: result.messageId,
          sentAt: result.sentAt,
          lockedBy: null,
          lockedUntil: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });

      return updated.count === 0 ? 'leaseLost' : 'accepted';
    } catch (err) {
      const classification = classifyOutboxFailure(err);
      if (classification.disposition === 'CONFIG_FAILURE' || classification.disposition === 'PAYLOAD_CONFLICT' || classification.disposition === 'PERMANENT' || item.attempts >= item.maxAttempts) {
        return markPermanentGuarded(
          classification.code,
          classification.message,
          classification.disposition === 'CONFIG_FAILURE' || classification.disposition === 'PAYLOAD_CONFLICT' ? 'CRITICAL' : 'ERROR',
          classification.disposition === 'CONFIG_FAILURE'
            ? 'EMAIL_CONFIG_FAILURE'
            : classification.disposition === 'PAYLOAD_CONFLICT'
            ? 'RESEND_IDEMPOTENCY_PAYLOAD_CONFLICT'
            : item.attempts >= item.maxAttempts
            ? 'RETRIES_EXHAUSTED'
            : 'PERMANENT_DELIVERY_FAILURE'
        );
      }

      const delayMs = computeNextRetryDelayMs(item.attempts, options?.randomFn);
      const nextAttemptAt = new Date(Date.now() + delayMs);
      const updated = await prisma.emailOutbox.updateMany({
        where: {
          id: item.id,
          status: EmailOutboxStatus.PROCESSING,
          lockedBy: workerId,
        },
        data: {
          status: EmailOutboxStatus.PENDING,
          nextAttemptAt,
          lockedBy: null,
          lockedUntil: null,
          lastErrorCode: classification.code,
          lastErrorMessage: classification.message,
        },
      });
      return updated.count === 0 ? 'leaseLost' : 'retried';
    }
  }

  if (item.type === EmailOutboxType.EVENT_CANCELLED_ORGANIZER) {
    if (!isValidEventCancelledOrganizerSnapshot(item.contentSnapshot)) {
      return markPermanentGuarded(
        'INVALID_CONTENT_SNAPSHOT',
        'Stored organizer event cancellation snapshot is invalid.',
        'CRITICAL',
        'SNAPSHOT_CORRUPT'
      );
    }

    try {
      const result = await sendEventCancelledOrganizerEmail({
        to: item.recipientEmail,
        snapshot: item.contentSnapshot,
        idempotencyKey: item.idempotencyKey,
      });

      const updated = await prisma.emailOutbox.updateMany({
        where: {
          id: item.id,
          status: EmailOutboxStatus.PROCESSING,
          lockedBy: workerId,
        },
        data: {
          status: EmailOutboxStatus.SENT,
          provider: result.provider,
          providerMessageId: result.messageId,
          sentAt: result.sentAt,
          lockedBy: null,
          lockedUntil: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });

      return updated.count === 0 ? 'leaseLost' : 'accepted';
    } catch (err) {
      const classification = classifyOutboxFailure(err);
      if (classification.disposition === 'CONFIG_FAILURE' || classification.disposition === 'PAYLOAD_CONFLICT' || classification.disposition === 'PERMANENT' || item.attempts >= item.maxAttempts) {
        return markPermanentGuarded(
          classification.code,
          classification.message,
          classification.disposition === 'CONFIG_FAILURE' || classification.disposition === 'PAYLOAD_CONFLICT' ? 'CRITICAL' : 'ERROR',
          classification.disposition === 'CONFIG_FAILURE'
            ? 'EMAIL_CONFIG_FAILURE'
            : classification.disposition === 'PAYLOAD_CONFLICT'
            ? 'RESEND_IDEMPOTENCY_PAYLOAD_CONFLICT'
            : item.attempts >= item.maxAttempts
            ? 'RETRIES_EXHAUSTED'
            : 'PERMANENT_DELIVERY_FAILURE'
        );
      }

      const delayMs = computeNextRetryDelayMs(item.attempts, options?.randomFn);
      const nextAttemptAt = new Date(Date.now() + delayMs);
      const updated = await prisma.emailOutbox.updateMany({
        where: {
          id: item.id,
          status: EmailOutboxStatus.PROCESSING,
          lockedBy: workerId,
        },
        data: {
          status: EmailOutboxStatus.PENDING,
          nextAttemptAt,
          lockedBy: null,
          lockedUntil: null,
          lastErrorCode: classification.code,
          lastErrorMessage: classification.message,
        },
      });
      return updated.count === 0 ? 'leaseLost' : 'retried';
    }
  }

  if (item.type !== EmailOutboxType.ORDER_CONFIRMATION) {
    return markPermanentGuarded(
      'UNSUPPORTED_OUTBOX_TYPE',
      `Unsupported outbox notification type: ${String(item.type)}`,
      'ERROR',
      'UNSUPPORTED_TYPE'
    );
  }

  if (!item.orderId) {
    return markPermanentGuarded(
      'ORDER_MISSING',
      'Associated order was deleted or detached before confirmation email dispatch.',
      'ERROR',
      'ORDER_MISSING'
    );
  }

  const order = await prisma.order.findUnique({
    where: { id: item.orderId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      orderAccessToken: true,
      _count: {
        select: { tickets: true },
      },
    },
  });

  if (!order) {
    return markPermanentGuarded(
      'ORDER_MISSING',
      'Associated order could not be found during confirmation email dispatch.',
      'ERROR',
      'ORDER_MISSING'
    );
  }

  if (order.status !== OrderStatus.COMPLETED) {
    return markPermanentGuarded(
      'ORDER_NOT_COMPLETED',
      `Confirmation email blocked because order status is ${order.status}, not COMPLETED.`,
      'ERROR',
      'ORDER_STATE_MISMATCH'
    );
  }

  if (order._count.tickets <= 0) {
    return markPermanentGuarded(
      'ORDER_NO_ISSUED_TICKETS',
      'Confirmation email blocked because completed order has zero issued tickets.',
      'ERROR',
      'ORDER_STATE_MISMATCH'
    );
  }

  if (!order.orderAccessToken) {
    return markPermanentGuarded(
      'ORDER_MISSING_ACCESS_TOKEN',
      'Confirmation email blocked because order has no orderAccessToken.',
      'CRITICAL',
      'ORDER_STATE_MISMATCH'
    );
  }

  if (!isValidOrderConfirmationSnapshot(item.contentSnapshot)) {
    return markPermanentGuarded(
      'INVALID_CONTENT_SNAPSHOT',
      'Stored email content snapshot is missing required fields or has an unsupported template version.',
      'CRITICAL',
      'SNAPSHOT_CORRUPT'
    );
  }

  const snapshot = item.contentSnapshot;
  const ticketAccessUrl = buildOrderTicketAccessUrl(
    snapshot.orderNumber,
    order.orderAccessToken,
    snapshot.clientOrigin
  );

  try {
    const result = await sendOrderConfirmationEmail({
      to: item.recipientEmail,
      snapshot,
      ticketAccessUrl,
      orderAccessToken: order.orderAccessToken,
      idempotencyKey: item.idempotencyKey,
    });

    // Lease-guarded update: SENT means accepted by the email provider (Resend HTTP 200),
    // not confirmed delivery into the buyer's inbox.
    const updated = await prisma.emailOutbox.updateMany({
      where: {
        id: item.id,
        status: EmailOutboxStatus.PROCESSING,
        lockedBy: workerId,
      },
      data: {
        status: EmailOutboxStatus.SENT,
        provider: result.provider,
        providerMessageId: result.messageId,
        sentAt: result.sentAt,
        lockedBy: null,
        lockedUntil: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });

    if (updated.count === 0) {
      console.warn(
        `[EmailOutbox] Lease lost before marking SENT for outbox=${item.id} (worker=${workerId}, providerMessageId=${result.messageId})`
      );
      return 'leaseLost';
    }

    return 'accepted';
  } catch (err) {
    const classification = classifyOutboxFailure(err, [
      order.orderAccessToken,
      ticketAccessUrl,
    ]);

    if (classification.disposition === 'CONFIG_FAILURE') {
      return markPermanentGuarded(
        classification.code,
        classification.message,
        'CRITICAL',
        'EMAIL_CONFIG_FAILURE'
      );
    }

    if (classification.disposition === 'PAYLOAD_CONFLICT') {
      return markPermanentGuarded(
        classification.code,
        classification.message,
        'CRITICAL',
        'RESEND_IDEMPOTENCY_PAYLOAD_CONFLICT'
      );
    }

    if (classification.disposition === 'PERMANENT' || item.attempts >= item.maxAttempts) {
      return markPermanentGuarded(
        classification.code,
        classification.message,
        'ERROR',
        item.attempts >= item.maxAttempts ? 'RETRIES_EXHAUSTED' : 'PERMANENT_DELIVERY_FAILURE'
      );
    }

    const delayMs = computeNextRetryDelayMs(item.attempts, options?.randomFn);
    const nextAttemptAt = new Date(Date.now() + delayMs);

    const updated = await prisma.emailOutbox.updateMany({
      where: {
        id: item.id,
        status: EmailOutboxStatus.PROCESSING,
        lockedBy: workerId,
      },
      data: {
        status: EmailOutboxStatus.PENDING,
        nextAttemptAt,
        lockedBy: null,
        lockedUntil: null,
        lastErrorCode: classification.code,
        lastErrorMessage: classification.message,
      },
    });

    if (updated.count === 0) {
      console.warn(
        `[EmailOutbox] Lease lost before scheduling retry for outbox=${item.id} (worker=${workerId})`
      );
      return 'leaseLost';
    }

    return 'retried';
  }
}

/**
 * Claims and processes one batch of pending/expired EmailOutbox records.
 */
export async function runEmailOutboxPass(options?: {
  workerId?: string;
  batchSize?: number;
  leaseMs?: number;
  randomFn?: () => number;
}): Promise<EmailOutboxPassStats> {
  const { workerId, claimed, reapedExhausted } = await claimPendingEmailOutboxBatch(options);

  const stats: EmailOutboxPassStats = {
    claimed: claimed.length,
    accepted: 0,
    retried: 0,
    failedPermanent: 0,
    cancelled: 0,
    leaseLost: 0,
    reapedExhausted,
  };

  for (const item of claimed) {
    try {
      const outcome = await processClaimedEmailOutboxItem(item, workerId, {
        randomFn: options?.randomFn,
      });
      stats[outcome] += 1;
    } catch (unexpectedErr) {
      const safeErr = sanitizeEmailLogMessage(
        unexpectedErr instanceof Error ? unexpectedErr.message : String(unexpectedErr)
      );
      console.error(
        `[EmailOutbox] Unexpected error processing outbox=${item.id}: ${safeErr}`
      );
    }
  }

  return stats;
}

