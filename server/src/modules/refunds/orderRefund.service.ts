import crypto from 'crypto';
import os from 'os';
import Stripe from 'stripe';
import {
  EmailOutboxStatus,
  OrderRefund,
  OrderRefundKind,
  OrderRefundStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { normalizeEmail } from '../../config/env.js';
import { stripe } from '../../lib/stripe.js';
import { redactSensitiveData } from '../finance/stripeError.js';
import {
  buildBuyerRefundManualReviewDedupeKey,
  buildLatePaymentRefundManualReviewDedupeKey,
  enqueueBuyerRefundEmail,
  enqueueLatePaymentRefundEmail,
  EMAIL_OUTBOX_MAX_ATTEMPTS,
} from '../notifications/emailOutbox.service.js';
import { triggerEmailOutboxDispatch } from '../notifications/emailOutboxWorker.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/errors.js';

import {
  buildLatePaymentRefundIdempotencyKey,
  LATE_PAYMENT_REFUND_IDEMPOTENCY_PREFIX,
} from './refundAllocation.domain.js';
import {
  confirmTicketRefundSucceededInTx,
  triggerPostCommitWaitlistAdvancement,
} from './refundAdmissionState.service.js';

export { buildLatePaymentRefundIdempotencyKey, LATE_PAYMENT_REFUND_IDEMPOTENCY_PREFIX };

export const ORDER_REFUND_MAX_ATTEMPTS = EMAIL_OUTBOX_MAX_ATTEMPTS; // 8
export const ORDER_REFUND_LEASE_MS = 90_000;
export const ORDER_REFUND_BATCH_SIZE = 5;

export const ORDER_REFUND_RETRY_DELAYS_MS = [
  30_000, // Retry 1: 30s
  120_000, // Retry 2: 2m
  300_000, // Retry 3: 5m
  900_000, // Retry 4: 15m
  1_800_000, // Retry 5: 30m
  3_600_000, // Retry 6: 1h
  7_200_000, // Retry 7: 2h
] as const;

export const MANUAL_REVIEW_RUNBOOK_SQL = `
SELECT
  r.id AS "orderRefundId",
  r."orderId",
  o."orderNumber",
  o.status AS "orderStatus",
  r."stripePaymentIntentId",
  r."stripeChargeId",
  r."stripeRefundId",
  r."amountInCents",
  r.currency,
  r.reason,
  r.status,
  r.attempts,
  r."maxAttempts",
  r."lastErrorCategory",
  r."lastErrorCode",
  r."lastErrorMessage",
  r."lastAttemptAt",
  r."failedAt",
  r."createdAt"
FROM "OrderRefund" r
LEFT JOIN "Order" o ON o.id = r."orderId"
WHERE r."requiresManualResolution" = true
  AND r."resolvedAt" IS NULL
ORDER BY r."createdAt" ASC;
`.trim();

export type RefundFailureDisposition = 'RETRY' | 'PERMANENT';

export interface RefundFailureClassification {
  disposition: RefundFailureDisposition;
  category: 'RETRYABLE' | 'PERMANENT';
  code: string;
  message: string;
}

export interface OrderRefundPassStats {
  claimed: number;
  succeeded: number;
  stripePending: number;
  retried: number;
  manualReview: number;
  leaseLost: number;
  reapedExhausted: number;
}

export type ManualResolutionAction =
  | 'REFUNDED_MANUALLY'
  | 'CONFIRMED_ALREADY_REFUNDED'
  | 'FULFILLED_MANUALLY'
  | 'NO_REFUND_NEEDED';

export function generateOrderRefundWorkerId(): string {
  const host = os.hostname().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 32) || 'host';
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${host}:${process.pid}:${suffix}`;
}

export function computeNextRefundRetryDelayMs(
  completedAttempt: number,
  randomFn: () => number = Math.random
): number {
  const idx = Math.max(
    0,
    Math.min(completedAttempt - 1, ORDER_REFUND_RETRY_DELAYS_MS.length - 1)
  );
  const baseMs = ORDER_REFUND_RETRY_DELAYS_MS[idx];
  const clampedRandom = Math.max(0, Math.min(1, randomFn()));
  const jitterFactor = 0.8 + clampedRandom * 0.4;
  return Math.max(1_000, Math.round(baseMs * jitterFactor));
}

export function sanitizeRefundDiagnosticMessage(raw: unknown): string {
  const rawStr = raw instanceof Error ? raw.message : String(raw ?? 'Unknown error');
  let clean = redactSensitiveData(rawStr);
  clean = clean
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\boat_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_ORDER_TOKEN]')
    .replace(/\btkt_sec_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_TICKET_TOKEN]');
  return clean.slice(0, 500);
}

export function emitManualReviewCriticalAlert(details: {
  orderRefundId: string;
  orderId: string | null;
  stripePaymentIntentId: string;
  stripeRefundId?: string | null;
  amountInCents: number;
  currency: string;
  code: string;
  message: string;
}): void {
  console.error('[OrderRefund][CRITICAL]', {
    orderRefundId: details.orderRefundId,
    orderId: details.orderId,
    stripePaymentIntentId: details.stripePaymentIntentId,
    stripeRefundId: details.stripeRefundId || null,
    amountInCents: details.amountInCents,
    currency: details.currency,
    code: details.code,
    message: sanitizeRefundDiagnosticMessage(details.message),
  });
}

export function describeLatePaymentReason(reason: string): string {
  switch (reason) {
    case 'LATE_PAYMENT_CAPACITY_REALLOCATED':
      return 'your ticket reservation expired before payment settled and those tickets were reallocated to another buyer.';
    case 'ORDER_CANCELLED_LATE_PAYMENT':
      return 'your order was cancelled before payment settled.';
    case 'EVENT_OR_SALES_CLOSED':
      return 'ticket sales for this event had closed before payment settled.';
    case 'PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH':
      return 'there was a payment verification discrepancy requiring manual review.';
    case 'DUPLICATE_PAYMENT_INTENT':
      return 'multiple successful payments were detected for the same order.';
    default:
      return 'your ticket reservation expired before payment completed and your order could not be fulfilled.';
  }
}

export function classifyStripeRefundError(err: any): RefundFailureClassification {
  const errType = String(err?.type || err?.rawType || '');
  const errCode = String(err?.code || err?.raw?.code || '');
  const statusCode = typeof err?.statusCode === 'number'
    ? err.statusCode
    : typeof err?.status === 'number'
      ? err.status
      : null;
  const rawMessage = String(err?.message || 'Stripe refund failed');
  const safeMsg = sanitizeRefundDiagnosticMessage(rawMessage);

  if (
    errType === 'StripeAuthenticationError' ||
    errType === 'StripePermissionError' ||
    errCode === 'api_key_expired' ||
    errCode === 'bad_api_key'
  ) {
    return {
      disposition: 'PERMANENT',
      category: 'PERMANENT',
      code: errCode || 'STRIPE_AUTH_ERROR',
      message: safeMsg,
    };
  }

  if (
    errType === 'StripeConnectionError' ||
    errType === 'StripeAPIError' ||
    errType === 'StripeRateLimitError' ||
    errCode === 'ETIMEDOUT' ||
    errCode === 'ECONNRESET' ||
    errCode === 'ENOTFOUND' ||
    errCode === 'EAI_AGAIN' ||
    errCode === 'idempotency_error' ||
    errCode === 'lock_timeout' ||
    statusCode === 429 ||
    statusCode === 409 ||
    (statusCode !== null && statusCode >= 500) ||
    /timed?\s*out|network|ECONN|ENOTFOUND|rate limit/i.test(rawMessage)
  ) {
    return {
      disposition: 'RETRY',
      category: 'RETRYABLE',
      code: errCode || 'STRIPE_TRANSIENT_ERROR',
      message: safeMsg,
    };
  }

  if (
    errType === 'StripeInvalidRequestError' ||
    errType === 'StripeCardError' ||
    errCode === 'charge_already_refunded' ||
    errCode === 'charge_disputed' ||
    errCode === 'insufficient_funds' ||
    errCode === 'resource_missing' ||
    errCode === 'amount_too_large' ||
    (statusCode !== null && statusCode >= 400 && statusCode < 500)
  ) {
    return {
      disposition: 'PERMANENT',
      category: 'PERMANENT',
      code: errCode || 'STRIPE_PERMANENT_ERROR',
      message: safeMsg,
    };
  }

  return {
    disposition: 'RETRY',
    category: 'RETRYABLE',
    code: errCode || 'STRIPE_UNEXPECTED_ERROR',
    message: safeMsg,
  };
}

export interface EnqueueOrderRefundParams {
  orderId: string | null;
  stripePaymentIntentId: string;
  stripeChargeId?: string | null;
  amountInCents: number;
  currency: string;
  reason: string;
  initialStatus: 'PENDING' | 'MANUAL_REVIEW_REQUIRED';
  errorCategory?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
  buyerNotification?: {
    customerEmail?: string | null;
    customerName?: string | null;
    orderNumber?: string | null;
    eventTitle?: string | null;
  };
}

/**
 * Idempotently inserts an OrderRefund record within the caller's PostgreSQL transaction.
 * Never performs external Stripe calls.
 */
export async function enqueueOrderRefund(
  tx: Prisma.TransactionClient,
  params: EnqueueOrderRefundParams
): Promise<{
  created: boolean;
  orderRefund: OrderRefund;
  enqueuedEmail: boolean;
}> {
  const idempotencyKey = buildLatePaymentRefundIdempotencyKey(params.stripePaymentIntentId);
  const normalizedCurrency = (params.currency || 'USD').toUpperCase();
  const isManual = params.initialStatus === 'MANUAL_REVIEW_REQUIRED';
  const now = new Date();

  const insertResult = await tx.orderRefund.createMany({
    data: [
      {
        orderId: params.orderId,
        stripePaymentIntentId: params.stripePaymentIntentId,
        stripeChargeId: params.stripeChargeId ?? null,
        idempotencyKey,
        amountInCents: params.amountInCents,
        currency: normalizedCurrency,
        reason: params.reason,
        status: isManual
          ? OrderRefundStatus.MANUAL_REVIEW_REQUIRED
          : OrderRefundStatus.PENDING,
        attempts: 0,
        maxAttempts: ORDER_REFUND_MAX_ATTEMPTS,
        nextAttemptAt: now,
        requiresManualResolution: isManual,
        failedAt: isManual ? now : null,
        lastErrorCategory: params.errorCategory ?? (isManual ? 'ANOMALY' : null),
        lastErrorCode: params.errorCode ?? null,
        lastErrorMessage: params.errorMessage
          ? sanitizeRefundDiagnosticMessage(params.errorMessage)
          : null,
        metadata: params.metadata
          ? (params.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    ],
    skipDuplicates: true,
  });

  const orderRefund = await tx.orderRefund.findUniqueOrThrow({
    where: { idempotencyKey },
  });

  const created = insertResult.count > 0;
  let enqueuedEmail = false;

  if (created && isManual) {
    emitManualReviewCriticalAlert({
      orderRefundId: orderRefund.id,
      orderId: orderRefund.orderId,
      stripePaymentIntentId: orderRefund.stripePaymentIntentId,
      stripeRefundId: orderRefund.stripeRefundId,
      amountInCents: orderRefund.amountInCents,
      currency: orderRefund.currency,
      code: orderRefund.lastErrorCode || params.reason,
      message:
        orderRefund.lastErrorMessage ||
        `OrderRefund created directly in MANUAL_REVIEW_REQUIRED (${params.reason})`,
    });

    const recipientEmail = params.buyerNotification?.customerEmail?.trim();
    if (recipientEmail) {
      const emailResult = await enqueueLatePaymentRefundEmail(tx, {
        kind: 'MANUAL_REVIEW',
        orderRefundId: orderRefund.id,
        orderId: orderRefund.orderId,
        recipientEmail,
        snapshot: {
          orderRefundId: orderRefund.id,
          orderNumber: params.buyerNotification?.orderNumber || 'UNKNOWN',
          refundAmountInCents: orderRefund.amountInCents,
          currency: orderRefund.currency,
          buyerName: params.buyerNotification?.customerName || 'Customer',
          eventTitle: params.buyerNotification?.eventTitle || 'Outside.vip Event',
          stripeRefundId: null,
          confirmedAtIso: null,
          reasonSummary: describeLatePaymentReason(params.reason),
        },
      });
      enqueuedEmail = emailResult.enqueued;
    }
  }

  return { created, orderRefund, enqueuedEmail };
}

type StripeReconcileOutcome =
  | { kind: 'NONE' }
  | { kind: 'RECONCILED_SUCCEEDED'; refund: Stripe.Refund }
  | { kind: 'RECONCILED_PENDING'; refund: Stripe.Refund }
  | { kind: 'AMBIGUOUS_ESCALATE'; code: string; message: string; metadata?: Record<string, unknown> };

async function listAllStripeRefundsForPaymentIntent(
  paymentIntentId: string,
  maxPages = 20
): Promise<{ refunds: Stripe.Refund[]; incomplete: boolean }> {
  const allRefunds: Stripe.Refund[] = [];
  let startingAfter: string | undefined;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const page = await stripe.refunds.list({
      payment_intent: paymentIntentId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    const data = page?.data || [];
    allRefunds.push(...data);

    if (!page?.has_more || data.length === 0) {
      return { refunds: allRefunds, incomplete: false };
    }

    if (pageIndex === maxPages - 1) {
      return { refunds: allRefunds, incomplete: true };
    }

    startingAfter = data[data.length - 1].id;
  }

  return { refunds: allRefunds, incomplete: false };
}

export interface SiblingStripeRefundExclusion {
  orderRefundIds: ReadonlySet<string>;
  stripeRefundIds: ReadonlySet<string>;
}

export function evaluateExistingStripeRefunds(
  refunds: Stripe.Refund[],
  expectedAmountInCents: number,
  expectedCurrency: string,
  orderRefundId: string,
  persistedStripeRefundId?: string | null,
  siblingExclusions?: SiblingStripeRefundExclusion
): StripeReconcileOutcome {
  // Exclude Stripe refunds explicitly owned by distinct non-late-payment OrderRefund rows
  // (e.g. partial organizer/admin ticket refunds on the same PaymentIntent).
  const candidateRefunds = siblingExclusions
    ? refunds.filter((r) => {
        const ownedBySiblingMetadata = Boolean(
          r.metadata?.orderRefundId &&
            r.metadata.orderRefundId !== orderRefundId &&
            siblingExclusions.orderRefundIds.has(r.metadata.orderRefundId)
        );
        const ownedBySiblingStripeId = Boolean(
          r.id &&
            r.id !== persistedStripeRefundId &&
            siblingExclusions.stripeRefundIds.has(r.id)
        );
        return !ownedBySiblingMetadata && !ownedBySiblingStripeId;
      })
    : refunds;

  if (candidateRefunds.length === 0) {
    return { kind: 'NONE' };
  }

  const normalizedExpectedCurrency = expectedCurrency.toUpperCase();
  const activeRefunds: Stripe.Refund[] = [];
  const failedRefunds: Stripe.Refund[] = [];
  const unknownStatusRefunds: Stripe.Refund[] = [];

  for (const r of candidateRefunds) {
    if (r.status === 'succeeded' || r.status === 'pending' || r.status === 'requires_action') {
      activeRefunds.push(r);
    } else if (r.status === 'failed' || r.status === 'canceled') {
      failedRefunds.push(r);
    } else {
      unknownStatusRefunds.push(r);
    }
  }

  if (unknownStatusRefunds.length > 0) {
    return {
      kind: 'AMBIGUOUS_ESCALATE',
      code: 'STRIPE_UNKNOWN_REFUND_STATUS',
      message: `Found Stripe refund(s) with unrecognized status for reconciliation.`,
      metadata: {
        refundIds: unknownStatusRefunds.map((r) => ({ id: r.id, status: r.status, amount: r.amount })),
      },
    };
  }

  const currencyMismatch = candidateRefunds.find(
    (r) => r.currency && r.currency.toUpperCase() !== normalizedExpectedCurrency
  );
  if (currencyMismatch) {
    return {
      kind: 'AMBIGUOUS_ESCALATE',
      code: 'STRIPE_REFUND_CURRENCY_MISMATCH',
      message: `Existing Stripe refund ${currencyMismatch.id} currency ${currencyMismatch.currency} differs from expected ${normalizedExpectedCurrency}.`,
      metadata: {
        refundId: currencyMismatch.id,
        observedCurrency: currencyMismatch.currency,
        expectedCurrency: normalizedExpectedCurrency,
      },
    };
  }

  if (activeRefunds.length === 0 && failedRefunds.length > 0) {
    return {
      kind: 'AMBIGUOUS_ESCALATE',
      code: 'STRIPE_PREVIOUS_REFUND_FAILED',
      message: `Found ${failedRefunds.length} failed/canceled Stripe refund(s) on PaymentIntent; manual review required before re-attempting.`,
      metadata: {
        failedRefundIds: failedRefunds.map((r) => ({
          id: r.id,
          status: r.status,
          amount: r.amount,
          failureReason: r.failure_reason || null,
        })),
      },
    };
  }

  if (activeRefunds.length > 1) {
    const activeTotal = activeRefunds.reduce((sum, r) => sum + r.amount, 0);
    return {
      kind: 'AMBIGUOUS_ESCALATE',
      code: 'STRIPE_MULTIPLE_EXISTING_REFUNDS',
      message: `Found ${activeRefunds.length} active Stripe refunds totaling ${activeTotal} ${normalizedExpectedCurrency} (expected single full refund of ${expectedAmountInCents}).`,
      metadata: {
        expectedAmountInCents,
        observedTotalInCents: activeTotal,
        activeRefunds: activeRefunds.map((r) => ({
          id: r.id,
          status: r.status,
          amount: r.amount,
          orderRefundId: r.metadata?.orderRefundId || null,
        })),
      },
    };
  }

  // activeRefunds.length === 1
  const single = activeRefunds[0];
  if (single.amount !== expectedAmountInCents) {
    return {
      kind: 'AMBIGUOUS_ESCALATE',
      code: 'STRIPE_PARTIAL_OR_MISMATCHED_REFUND',
      message: `Existing Stripe refund ${single.id} amount ${single.amount} differs from expected full refund ${expectedAmountInCents}.`,
      metadata: {
        refundId: single.id,
        observedAmountInCents: single.amount,
        expectedAmountInCents,
        status: single.status,
      },
    };
  }

  const metaRefundId = single.metadata?.orderRefundId;
  if (metaRefundId && metaRefundId !== orderRefundId) {
    return {
      kind: 'AMBIGUOUS_ESCALATE',
      code: 'STRIPE_REFUND_METADATA_MISMATCH',
      message: `Existing Stripe refund ${single.id} belongs to another OrderRefund (${metaRefundId}).`,
      metadata: {
        refundId: single.id,
        observedOrderRefundId: metaRefundId,
        expectedOrderRefundId: orderRefundId,
      },
    };
  }

  // Positive ownership proof required: explicit metadata.orderRefundId OR exact persisted stripeRefundId
  const matchesMetadata = metaRefundId === orderRefundId;
  const matchesPersistedRefundId = Boolean(
    persistedStripeRefundId && single.id === persistedStripeRefundId
  );

  if (!matchesMetadata && !matchesPersistedRefundId) {
    return {
      kind: 'AMBIGUOUS_ESCALATE',
      code: 'STRIPE_UNATTRIBUTED_EXISTING_REFUND',
      message: `Existing Stripe refund ${single.id} (${single.amount} ${single.currency}) lacks OrderRefund ownership proof (missing metadata.orderRefundId and no persisted stripeRefundId match).`,
      metadata: {
        refundId: single.id,
        amount: single.amount,
        currency: single.currency,
        status: single.status,
        observedOrderRefundId: metaRefundId || null,
        expectedOrderRefundId: orderRefundId,
      },
    };
  }

  if (failedRefunds.length > 0 && !matchesMetadata && !matchesPersistedRefundId) {
    return {
      kind: 'AMBIGUOUS_ESCALATE',
      code: 'STRIPE_MIXED_FAILED_AND_ACTIVE_REFUNDS',
      message: `PaymentIntent has both failed and active refunds without matching OrderRefund ownership.`,
      metadata: {
        activeRefundId: single.id,
        failedRefundIds: failedRefunds.map((r) => r.id),
      },
    };
  }

  if (single.status === 'succeeded') {
    return { kind: 'RECONCILED_SUCCEEDED', refund: single };
  }

  return { kind: 'RECONCILED_PENDING', refund: single };
}

function isBuyerTicketRefundKind(kind: OrderRefundKind | null | undefined): boolean {
  return (
    kind === OrderRefundKind.ORGANIZER_TICKET_REFUND ||
    kind === OrderRefundKind.ADMIN_TICKET_REFUND ||
    kind === OrderRefundKind.EVENT_CANCELLATION
  );
}

function isWorkerClaimableRefundKind(kind: OrderRefundKind | null | undefined): boolean {
  return (
    kind === OrderRefundKind.LATE_PAYMENT ||
    kind === OrderRefundKind.ORGANIZER_TICKET_REFUND ||
    kind === OrderRefundKind.ADMIN_TICKET_REFUND
  );
}

async function loadBuyerRefundEmailStats(
  db: Prisma.TransactionClient | typeof prisma,
  orderRefundId: string,
  orderId: string | null
): Promise<{ ticketCount: number; isPartialRefund: boolean }> {
  const refundTicketCount = await db.orderRefundTicket.count({
    where: { orderRefundId },
  });
  const totalOrderTickets = orderId
    ? await db.ticket.count({
        where: { orderId },
      })
    : 0;
  const ticketCount = Math.max(1, refundTicketCount);
  const isPartialRefund = totalOrderTickets > 0 && refundTicketCount < totalOrderTickets;
  return { ticketCount, isPartialRefund };
}

/**
 * Transitions expired PROCESSING leases whose attempts >= maxAttempts to MANUAL_REVIEW_REQUIRED.
 */
export async function reapExpiredExhaustedRefundLeases(): Promise<number> {
  const reaped = await prisma.$queryRaw<OrderRefund[]>`
    UPDATE "OrderRefund"
    SET
      status = 'MANUAL_REVIEW_REQUIRED'::"OrderRefundStatus",
      "requiresManualResolution" = true,
      "lockedBy" = NULL,
      "lockedUntil" = NULL,
      "failedAt" = COALESCE("failedAt", NOW()),
      "lastErrorCategory" = COALESCE("lastErrorCategory", 'PERMANENT'),
      "lastErrorCode" = COALESCE("lastErrorCode", 'WORKER_LEASE_EXPIRED_MAX_ATTEMPTS'),
      "lastErrorMessage" = COALESCE(
        "lastErrorMessage",
        'Worker lease expired after reaching maximum refund attempts'
      ),
      "updatedAt" = NOW()
    WHERE "refundKind" IN (
        'LATE_PAYMENT'::"OrderRefundKind",
        'ORGANIZER_TICKET_REFUND'::"OrderRefundKind",
        'ADMIN_TICKET_REFUND'::"OrderRefundKind"
      )
      AND status = 'PROCESSING'::"OrderRefundStatus"
      AND "lockedUntil" IS NOT NULL
      AND "lockedUntil" < NOW()
      AND attempts >= "maxAttempts"
    RETURNING *
  `;

  let enqueuedAnyEmail = false;

  for (const row of reaped) {
    emitManualReviewCriticalAlert({
      orderRefundId: row.id,
      orderId: row.orderId,
      stripePaymentIntentId: row.stripePaymentIntentId,
      stripeRefundId: row.stripeRefundId,
      amountInCents: row.amountInCents,
      currency: row.currency,
      code: row.lastErrorCode || 'WORKER_LEASE_EXPIRED_MAX_ATTEMPTS',
      message:
        row.lastErrorMessage || 'Worker lease expired after reaching maximum refund attempts',
    });

    if (row.orderId) {
      const order = await prisma.order.findUnique({
        where: { id: row.orderId },
        select: {
          id: true,
          orderNumber: true,
          customerEmail: true,
          customerName: true,
          event: { select: { title: true } },
        },
      });
      if (order?.customerEmail) {
        if (isBuyerTicketRefundKind(row.refundKind)) {
          const stats = await loadBuyerRefundEmailStats(prisma, row.id, order.id);
          const res = await enqueueBuyerRefundEmail(prisma, {
            kind: 'MANUAL_REVIEW',
            orderRefundId: row.id,
            orderId: order.id,
            recipientEmail: order.customerEmail,
            snapshot: {
              orderRefundId: row.id,
              orderNumber: order.orderNumber,
              refundAmountInCents: row.amountInCents,
              currency: row.currency,
              buyerName: order.customerName,
              eventTitle: order.event?.title || 'Outside.vip Event',
              ticketCount: stats.ticketCount,
              isPartialRefund: stats.isPartialRefund,
              stripeRefundId: row.stripeRefundId,
              confirmedAtIso: null,
              reasonSummary: row.reason || 'Organizer-initiated ticket refund',
            },
          });
          if (res.enqueued) {
            enqueuedAnyEmail = true;
          }
        } else {
          const res = await enqueueLatePaymentRefundEmail(prisma, {
            kind: 'MANUAL_REVIEW',
            orderRefundId: row.id,
            orderId: order.id,
            recipientEmail: order.customerEmail,
            snapshot: {
              orderRefundId: row.id,
              orderNumber: order.orderNumber,
              refundAmountInCents: row.amountInCents,
              currency: row.currency,
              buyerName: order.customerName,
              eventTitle: order.event?.title || 'Outside.vip Event',
              stripeRefundId: row.stripeRefundId,
              confirmedAtIso: null,
              reasonSummary: describeLatePaymentReason(row.reason),
            },
          });
          if (res.enqueued) {
            enqueuedAnyEmail = true;
          }
        }
      }
    }
  }

  if (enqueuedAnyEmail) {
    triggerEmailOutboxDispatch();
  }

  return reaped.length;
}

/**
 * Claims due PENDING OrderRefund rows or expired PROCESSING leases using FOR UPDATE SKIP LOCKED.
 * Locks ONLY OrderRefund rows (never Order or TicketTier).
 */
export async function claimPendingOrderRefundBatch(options?: {
  workerId?: string;
  batchSize?: number;
  leaseMs?: number;
}): Promise<{ workerId: string; claimed: OrderRefund[]; reapedExhausted: number }> {
  const workerId = options?.workerId || generateOrderRefundWorkerId();
  const batchSize = Math.max(1, Math.min(options?.batchSize ?? ORDER_REFUND_BATCH_SIZE, 100));
  const leaseMs = Math.max(5_000, options?.leaseMs ?? ORDER_REFUND_LEASE_MS);

  const reapedExhausted = await reapExpiredExhaustedRefundLeases();

  const claimed = await prisma.$queryRaw<OrderRefund[]>`
    WITH claimable AS (
      SELECT id
      FROM "OrderRefund"
      WHERE "refundKind" IN (
          'LATE_PAYMENT'::"OrderRefundKind",
          'ORGANIZER_TICKET_REFUND'::"OrderRefundKind",
          'ADMIN_TICKET_REFUND'::"OrderRefundKind"
        )
        AND (
          (
            status = 'PENDING'::"OrderRefundStatus"
            AND "nextAttemptAt" <= NOW()
            AND attempts < "maxAttempts"
          ) OR (
            status = 'PROCESSING'::"OrderRefundStatus"
            AND "lockedUntil" IS NOT NULL
            AND "lockedUntil" < NOW()
            AND attempts < "maxAttempts"
          )
        )
      ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "OrderRefund" AS r
    SET
      status = 'PROCESSING'::"OrderRefundStatus",
      "lockedBy" = ${workerId},
      "lockedUntil" = NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
      attempts = r.attempts + 1,
      "lastAttemptAt" = NOW(),
      "updatedAt" = NOW()
    FROM claimable
    WHERE r.id = claimable.id
    RETURNING r.*
  `;

  return { workerId, claimed, reapedExhausted };
}

/**
 * Finalizes an OrderRefund inside a transaction with strict Order -> OrderRefund lock order
 * and lease ownership check (status = PROCESSING AND lockedBy = workerId).
 */
async function finalizeRefundSucceededInTx(params: {
  item: OrderRefund;
  workerId: string;
  stripeRefundId: string;
  succeededAt: Date;
}): Promise<{ outcome: 'succeeded' | 'leaseLost'; enqueuedEmail: boolean }> {
  const { item, workerId, stripeRefundId, succeededAt } = params;

  return await prisma.$transaction(
    async (tx) => {
      let lockedOrder: {
        id: string;
        orderNumber: string;
        status: OrderStatus;
        customerEmail: string;
        customerName: string;
        eventTitle: string;
      } | null = null;

      if (item.orderId) {
        const orderRows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Order" WHERE id = ${item.orderId} FOR UPDATE
        `;
        if (orderRows[0]) {
          const order = await tx.order.findUnique({
            where: { id: orderRows[0].id },
            select: {
              id: true,
              orderNumber: true,
              status: true,
              customerEmail: true,
              customerName: true,
              event: { select: { title: true } },
            },
          });
          if (order) {
            lockedOrder = {
              id: order.id,
              orderNumber: order.orderNumber,
              status: order.status,
              customerEmail: order.customerEmail,
              customerName: order.customerName,
              eventTitle: order.event?.title || 'Outside.vip Event',
            };
          }
        }
      }

      const updated = await tx.orderRefund.updateMany({
        where: {
          id: item.id,
          refundKind: OrderRefundKind.LATE_PAYMENT,
          status: OrderRefundStatus.PROCESSING,
          lockedBy: workerId,
        },
        data: {
          status: OrderRefundStatus.SUCCEEDED,
          stripeRefundId,
          succeededAt,
          lockedBy: null,
          lockedUntil: null,
          lastErrorCategory: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });

      if (updated.count === 0) {
        return { outcome: 'leaseLost', enqueuedEmail: false };
      }

      if (lockedOrder) {
        if (
          lockedOrder.status !== OrderStatus.COMPLETED &&
          lockedOrder.status !== OrderStatus.REFUNDED
        ) {
          await tx.order.update({
            where: { id: lockedOrder.id },
            data: { status: OrderStatus.REFUNDED },
          });
        }

        await tx.paymentTransaction.updateMany({
          where: {
            orderId: lockedOrder.id,
            providerTransactionId: item.stripePaymentIntentId,
            status: PaymentStatus.SUCCEEDED,
          },
          data: { status: PaymentStatus.REFUNDED },
        });
      }

      let enqueuedEmail = false;
      if (lockedOrder?.customerEmail) {
        const res = await enqueueLatePaymentRefundEmail(tx, {
          kind: 'CONFIRMED',
          orderRefundId: item.id,
          orderId: lockedOrder.id,
          recipientEmail: lockedOrder.customerEmail,
          snapshot: {
            orderRefundId: item.id,
            orderNumber: lockedOrder.orderNumber,
            refundAmountInCents: item.amountInCents,
            currency: item.currency,
            buyerName: lockedOrder.customerName,
            eventTitle: lockedOrder.eventTitle,
            stripeRefundId,
            confirmedAtIso: succeededAt.toISOString(),
            reasonSummary: describeLatePaymentReason(item.reason),
          },
        });
        enqueuedEmail = res.enqueued;
      }

      return { outcome: 'succeeded', enqueuedEmail };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 10000,
    }
  );
}

async function finalizeBuyerRefundSucceededInTx(params: {
  item: OrderRefund;
  workerId: string;
  stripeRefundId: string;
  stripeChargeId?: string | null;
  succeededAt: Date;
}): Promise<{
  outcome: 'succeeded' | 'leaseLost';
  enqueuedEmail: boolean;
  tiersToAdvanceWaitlist: string[];
}> {
  const { item, workerId, stripeRefundId, stripeChargeId, succeededAt } = params;

  return await prisma.$transaction(
    async (tx) => {
      const fin = await confirmTicketRefundSucceededInTx(tx, {
        orderRefundId: item.id,
        stripeRefundId,
        stripeChargeId: stripeChargeId ?? item.stripeChargeId,
        confirmedByUserId: item.initiatedByUserId,
        succeededAt,
        expectedLockedBy: workerId,
      });

      if (fin.leaseLost) {
        return {
          outcome: 'leaseLost',
          enqueuedEmail: false,
          tiersToAdvanceWaitlist: [],
        };
      }

      let enqueuedEmail = false;
      if (!fin.alreadyFinalized && fin.orderRefund.orderId) {
        const order = await tx.order.findUnique({
          where: { id: fin.orderRefund.orderId },
          select: {
            id: true,
            orderNumber: true,
            customerEmail: true,
            customerName: true,
            event: { select: { title: true } },
          },
        });
        if (order?.customerEmail) {
          const stats = await loadBuyerRefundEmailStats(tx, fin.orderRefund.id, order.id);
          const emailRes = await enqueueBuyerRefundEmail(tx, {
            kind: 'CONFIRMED',
            orderRefundId: fin.orderRefund.id,
            orderId: order.id,
            recipientEmail: order.customerEmail,
            snapshot: {
              orderRefundId: fin.orderRefund.id,
              orderNumber: order.orderNumber,
              refundAmountInCents: fin.orderRefund.amountInCents,
              currency: fin.orderRefund.currency,
              buyerName: order.customerName,
              eventTitle: order.event?.title || 'Outside.vip Event',
              ticketCount: stats.ticketCount,
              isPartialRefund: stats.isPartialRefund,
              stripeRefundId: fin.orderRefund.stripeRefundId || stripeRefundId,
              confirmedAtIso: (fin.orderRefund.succeededAt || succeededAt).toISOString(),
              reasonSummary: fin.orderRefund.reason || 'Organizer-initiated ticket refund',
            },
          });
          enqueuedEmail = emailRes.enqueued;
        }
      }

      return {
        outcome: 'succeeded',
        enqueuedEmail,
        tiersToAdvanceWaitlist: fin.tiersToAdvanceWaitlist,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 10000,
    }
  );
}

async function finalizeRefundManualReviewInTx(params: {
  item: OrderRefund;
  workerId: string;
  stripeRefundId?: string | null;
  category: string;
  code: string;
  message: string;
  extraMetadata?: Record<string, unknown>;
}): Promise<{ outcome: 'manualReview' | 'leaseLost'; enqueuedEmail: boolean }> {
  const { item, workerId, stripeRefundId, category, code, message, extraMetadata } = params;
  const safeMsg = sanitizeRefundDiagnosticMessage(message);

  const txResult = await prisma.$transaction(
    async (tx) => {
      let lockedOrder: {
        id: string;
        orderNumber: string;
        customerEmail: string;
        customerName: string;
        eventTitle: string;
      } | null = null;

      if (item.orderId) {
        const orderRows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Order" WHERE id = ${item.orderId} FOR UPDATE
        `;
        if (orderRows[0]) {
          const order = await tx.order.findUnique({
            where: { id: orderRows[0].id },
            select: {
              id: true,
              orderNumber: true,
              customerEmail: true,
              customerName: true,
              event: { select: { title: true } },
            },
          });
          if (order) {
            lockedOrder = {
              id: order.id,
              orderNumber: order.orderNumber,
              customerEmail: order.customerEmail,
              customerName: order.customerName,
              eventTitle: order.event?.title || 'Outside.vip Event',
            };
          }
        }
      }

      const existingMeta =
        item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
          ? (item.metadata as Record<string, unknown>)
          : {};
      const mergedMeta = extraMetadata ? { ...existingMeta, ...extraMetadata } : existingMeta;

      const updated = await tx.orderRefund.updateMany({
        where: {
          id: item.id,
          refundKind: item.refundKind,
          status: OrderRefundStatus.PROCESSING,
          lockedBy: workerId,
        },
        data: {
          status: OrderRefundStatus.MANUAL_REVIEW_REQUIRED,
          requiresManualResolution: true,
          ...(stripeRefundId ? { stripeRefundId } : {}),
          failedAt: new Date(),
          lockedBy: null,
          lockedUntil: null,
          lastErrorCategory: category,
          lastErrorCode: code,
          lastErrorMessage: safeMsg,
          metadata:
            Object.keys(mergedMeta).length > 0
              ? (mergedMeta as Prisma.InputJsonValue)
              : Prisma.JsonNull,
        },
      });

      if (updated.count === 0) {
        return { outcome: 'leaseLost' as const, enqueuedEmail: false };
      }

      let enqueuedEmail = false;
      if (lockedOrder?.customerEmail) {
        if (isBuyerTicketRefundKind(item.refundKind)) {
          const stats = await loadBuyerRefundEmailStats(tx, item.id, lockedOrder.id);
          const res = await enqueueBuyerRefundEmail(tx, {
            kind: 'MANUAL_REVIEW',
            orderRefundId: item.id,
            orderId: lockedOrder.id,
            recipientEmail: lockedOrder.customerEmail,
            snapshot: {
              orderRefundId: item.id,
              orderNumber: lockedOrder.orderNumber,
              refundAmountInCents: item.amountInCents,
              currency: item.currency,
              buyerName: lockedOrder.customerName,
              eventTitle: lockedOrder.eventTitle,
              ticketCount: stats.ticketCount,
              isPartialRefund: stats.isPartialRefund,
              stripeRefundId: stripeRefundId || item.stripeRefundId,
              confirmedAtIso: null,
              reasonSummary: item.reason || 'Organizer-initiated ticket refund',
            },
          });
          enqueuedEmail = res.enqueued;
        } else {
          const res = await enqueueLatePaymentRefundEmail(tx, {
            kind: 'MANUAL_REVIEW',
            orderRefundId: item.id,
            orderId: lockedOrder.id,
            recipientEmail: lockedOrder.customerEmail,
            snapshot: {
              orderRefundId: item.id,
              orderNumber: lockedOrder.orderNumber,
              refundAmountInCents: item.amountInCents,
              currency: item.currency,
              buyerName: lockedOrder.customerName,
              eventTitle: lockedOrder.eventTitle,
              stripeRefundId: stripeRefundId || item.stripeRefundId,
              confirmedAtIso: null,
              reasonSummary: describeLatePaymentReason(item.reason),
            },
          });
          enqueuedEmail = res.enqueued;
        }
      }

      return { outcome: 'manualReview' as const, enqueuedEmail };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 10000,
    }
  );

  if (txResult.outcome === 'manualReview') {
    emitManualReviewCriticalAlert({
      orderRefundId: item.id,
      orderId: item.orderId,
      stripePaymentIntentId: item.stripePaymentIntentId,
      stripeRefundId: stripeRefundId || item.stripeRefundId,
      amountInCents: item.amountInCents,
      currency: item.currency,
      code,
      message: safeMsg,
    });
  }

  return txResult;
}

/**
 * Processes a single claimed OrderRefund item outside any Prisma transaction while calling Stripe,
 * then finalizes state in PostgreSQL with lease guards.
 */
export async function processClaimedOrderRefundItem(
  item: OrderRefund,
  workerId: string,
  options?: { randomFn?: () => number }
): Promise<'succeeded' | 'stripePending' | 'retried' | 'manualReview' | 'leaseLost'> {
  if (!isWorkerClaimableRefundKind(item.refundKind)) {
    return 'leaseLost';
  }

  if (item.amountInCents <= 0) {
    const res = await finalizeRefundManualReviewInTx({
      item,
      workerId,
      category: 'ANOMALY',
      code: 'INVALID_REFUND_AMOUNT',
      message: `Refund amount ${item.amountInCents} must be positive.`,
    });
    if (res.enqueuedEmail) triggerEmailOutboxDispatch();
    return res.outcome;
  }

  let postCommitWakeEmail = false;
  let postCommitWaitlistTiers: string[] = [];

  try {
    // 1. Reconcile existing Stripe refunds on the PaymentIntent before issuing another refund
    const { refunds: existingRefunds, incomplete } = await listAllStripeRefundsForPaymentIntent(
      item.stripePaymentIntentId
    );
    if (incomplete) {
      const res = await finalizeRefundManualReviewInTx({
        item,
        workerId,
        category: 'ANOMALY',
        code: 'STRIPE_REFUND_LIST_INCOMPLETE',
        message: `Stripe refunds.list pagination exceeded maximum pages with has_more=true for PaymentIntent ${item.stripePaymentIntentId}; escalating to manual review rather than guessing from partial history.`,
        extraMetadata: {
          fetchedRefundCount: existingRefunds.length,
        },
      });
      if (res.enqueuedEmail) triggerEmailOutboxDispatch();
      return res.outcome;
    }

    const siblingOrderRefunds = await prisma.orderRefund.findMany({
      where: {
        stripePaymentIntentId: item.stripePaymentIntentId,
        id: { not: item.id },
      },
      select: { id: true, stripeRefundId: true },
    });

    const siblingExclusions: SiblingStripeRefundExclusion | undefined =
      siblingOrderRefunds.length > 0
        ? {
            orderRefundIds: new Set(siblingOrderRefunds.map((s) => s.id)),
            stripeRefundIds: new Set(
              siblingOrderRefunds
                .map((s) => s.stripeRefundId)
                .filter((id): id is string => typeof id === 'string' && id.length > 0)
            ),
          }
        : undefined;

    const reconcile = evaluateExistingStripeRefunds(
      existingRefunds,
      item.amountInCents,
      item.currency,
      item.id,
      item.stripeRefundId,
      siblingExclusions
    );

    if (reconcile.kind === 'AMBIGUOUS_ESCALATE') {
      const res = await finalizeRefundManualReviewInTx({
        item,
        workerId,
        category: 'ANOMALY',
        code: reconcile.code,
        message: reconcile.message,
        extraMetadata: reconcile.metadata,
      });
      if (res.enqueuedEmail) triggerEmailOutboxDispatch();
      return res.outcome;
    }

    let stripeRefund: Stripe.Refund;
    if (reconcile.kind === 'RECONCILED_SUCCEEDED' || reconcile.kind === 'RECONCILED_PENDING') {
      stripeRefund = reconcile.refund;
    } else {
      // 2. Create refund with deterministic idempotencyKey (never pass custom text to Stripe top-level `reason`)
      stripeRefund = await stripe.refunds.create(
        {
          payment_intent: item.stripePaymentIntentId,
          amount: item.amountInCents,
          metadata: {
            orderRefundId: item.id,
            refundKind: item.refundKind,
            ...(item.orderId ? { orderId: item.orderId } : {}),
            ...(item.refundKind === OrderRefundKind.LATE_PAYMENT
              ? { latePaymentReason: item.reason }
              : {}),
          },
        },
        {
          idempotencyKey: item.idempotencyKey,
        }
      );
    }

    // 3. Validate returned amount & currency before persisting completion
    if (
      stripeRefund.amount !== item.amountInCents ||
      (stripeRefund.currency &&
        stripeRefund.currency.toUpperCase() !== item.currency.toUpperCase())
    ) {
      const res = await finalizeRefundManualReviewInTx({
        item,
        workerId,
        stripeRefundId: stripeRefund.id,
        category: 'ANOMALY',
        code: 'STRIPE_REFUND_RESPONSE_MISMATCH',
        message: `Returned Stripe refund ${stripeRefund.id} (${stripeRefund.amount} ${stripeRefund.currency}) did not match expected ${item.amountInCents} ${item.currency}.`,
      });
      if (res.enqueuedEmail) triggerEmailOutboxDispatch();
      return res.outcome;
    }

    if (stripeRefund.status === 'succeeded') {
      if (isBuyerTicketRefundKind(item.refundKind)) {
        const fin = await finalizeBuyerRefundSucceededInTx({
          item,
          workerId,
          stripeRefundId: stripeRefund.id,
          stripeChargeId:
            typeof stripeRefund.charge === 'string'
              ? stripeRefund.charge
              : stripeRefund.charge?.id ?? item.stripeChargeId,
          succeededAt: new Date(),
        });
        postCommitWakeEmail = fin.enqueuedEmail;
        postCommitWaitlistTiers = fin.tiersToAdvanceWaitlist;
        if (postCommitWakeEmail) {
          triggerEmailOutboxDispatch();
        }
        if (postCommitWaitlistTiers.length > 0) {
          await triggerPostCommitWaitlistAdvancement(postCommitWaitlistTiers);
        }
        return fin.outcome;
      }

      const fin = await finalizeRefundSucceededInTx({
        item,
        workerId,
        stripeRefundId: stripeRefund.id,
        succeededAt: new Date(),
      });
      postCommitWakeEmail = fin.enqueuedEmail;
      if (postCommitWakeEmail) {
        triggerEmailOutboxDispatch();
      }
      return fin.outcome;
    }

    if (stripeRefund.status === 'pending' || stripeRefund.status === 'requires_action') {
      const updated = await prisma.orderRefund.updateMany({
        where: {
          id: item.id,
          refundKind: item.refundKind,
          status: OrderRefundStatus.PROCESSING,
          lockedBy: workerId,
        },
        data: {
          status: OrderRefundStatus.STRIPE_PENDING,
          stripeRefundId: stripeRefund.id,
          lockedBy: null,
          lockedUntil: null,
          lastErrorCategory: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      if (updated.count === 0) {
        return 'leaseLost';
      }
      return 'stripePending';
    }

    // 'failed' | 'canceled' | unexpected
    const res = await finalizeRefundManualReviewInTx({
      item,
      workerId,
      stripeRefundId: stripeRefund.id,
      category: 'PERMANENT',
      code: stripeRefund.failure_reason || `STRIPE_REFUND_${String(stripeRefund.status).toUpperCase()}`,
      message: `Stripe refund ${stripeRefund.id} returned terminal non-success status '${stripeRefund.status}'.`,
    });
    if (res.enqueuedEmail) triggerEmailOutboxDispatch();
    return res.outcome;
  } catch (err) {
    const classification = classifyStripeRefundError(err);

    if (classification.disposition === 'PERMANENT' || item.attempts >= item.maxAttempts) {
      const res = await finalizeRefundManualReviewInTx({
        item,
        workerId,
        category: classification.category,
        code:
          item.attempts >= item.maxAttempts && classification.disposition === 'RETRY'
            ? 'RETRIES_EXHAUSTED'
            : classification.code,
        message: classification.message,
      });
      if (res.enqueuedEmail) triggerEmailOutboxDispatch();
      return res.outcome;
    }

    const delayMs = computeNextRefundRetryDelayMs(item.attempts, options?.randomFn);
    const nextAttemptAt = new Date(Date.now() + delayMs);

    const updated = await prisma.orderRefund.updateMany({
      where: {
        id: item.id,
        refundKind: item.refundKind,
        status: OrderRefundStatus.PROCESSING,
        lockedBy: workerId,
      },
      data: {
        status: OrderRefundStatus.PENDING,
        nextAttemptAt,
        lockedBy: null,
        lockedUntil: null,
        lastErrorCategory: classification.category,
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

/**
 * Claims and processes one batch of eligible OrderRefund rows.
 */
export async function runOrderRefundPass(options?: {
  workerId?: string;
  batchSize?: number;
  leaseMs?: number;
  randomFn?: () => number;
}): Promise<OrderRefundPassStats> {
  const { workerId, claimed, reapedExhausted } = await claimPendingOrderRefundBatch(options);

  const stats: OrderRefundPassStats = {
    claimed: claimed.length,
    succeeded: 0,
    stripePending: 0,
    retried: 0,
    manualReview: 0,
    leaseLost: 0,
    reapedExhausted,
  };

  for (const item of claimed) {
    try {
      const outcome = await processClaimedOrderRefundItem(item, workerId, {
        randomFn: options?.randomFn,
      });
      stats[outcome] += 1;
    } catch (unexpectedErr) {
      console.error(
        `[OrderRefund] Unexpected error processing orderRefund=${item.id}: ${sanitizeRefundDiagnosticMessage(unexpectedErr)}`
      );
    }
  }

  return stats;
}

/**
 * Webhook reconciliation helper called inside an existing webhook transaction.
 * Caller MUST lock Order (FOR UPDATE) before calling when an Order exists.
 */
async function reconcileLatePaymentOrderRefundsInTx(
  tx: Prisma.TransactionClient,
  params: {
    lockedOrder: {
      id: string;
      orderNumber: string;
      status: OrderStatus;
      customerEmail: string;
      customerName: string;
      eventTitle: string;
    } | null;
    paymentIntentId?: string | null;
    hasMoreRefunds?: boolean;
    refunds: Array<{
      id: string;
      amount: number;
      currency: string;
      status: string | null;
      failure_reason?: string;
      payment_intent?: string | null;
      metadata?: Record<string, string> | null;
    }>;
  }
): Promise<{
  matchedLatePaymentRefund: boolean;
  matchedStripeRefundIds: Set<string>;
  enqueuedEmail: boolean;
}> {
  const { lockedOrder, paymentIntentId, hasMoreRefunds = false, refunds } = params;

  const refundIds = refunds.map((r) => r.id).filter(Boolean);
  const metaOrderRefundIds = refunds
    .map((r) => r.metadata?.orderRefundId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  if (!paymentIntentId && refundIds.length === 0 && metaOrderRefundIds.length === 0) {
    return {
      matchedLatePaymentRefund: false,
      matchedStripeRefundIds: new Set<string>(),
      enqueuedEmail: false,
    };
  }

  // Match strictly LATE_PAYMENT OrderRefund records on trustworthy identifiers
  // (PaymentIntent ID, persisted stripeRefundId, or metadata.orderRefundId).
  // Buyer/partial ticket refunds are excluded so buyer webhooks never enter late-payment
  // recovery, mutate PaymentTransaction, or emit late-payment emails.
  const existingRows = await tx.$queryRaw<OrderRefund[]>`
    SELECT *
    FROM "OrderRefund"
    WHERE "refundKind" = 'LATE_PAYMENT'::"OrderRefundKind"
      AND (
        (${paymentIntentId ?? null}::text IS NOT NULL AND "stripePaymentIntentId" = ${paymentIntentId ?? null})
        OR (${refundIds.length > 0} AND "stripeRefundId" = ANY(${refundIds}))
        OR (${metaOrderRefundIds.length > 0} AND id = ANY(${metaOrderRefundIds}))
      )
    ORDER BY id ASC
    FOR UPDATE
  `;

  if (existingRows.length === 0) {
    return {
      matchedLatePaymentRefund: false,
      matchedStripeRefundIds: new Set<string>(),
      enqueuedEmail: false,
    };
  }

  const matchedStripeRefundIds = new Set<string>();

  // Empty or truncated charge.refunds payload cannot safely prove refund outcome;
  // leave record recoverable by worker or a subsequent attributable refund.updated webhook.
  if (hasMoreRefunds || refunds.length === 0) {
    return { matchedLatePaymentRefund: true, matchedStripeRefundIds, enqueuedEmail: false };
  }

  const affectedPiIds = Array.from(new Set(existingRows.map((row) => row.stripePaymentIntentId)));
  const siblingNonLateRefunds = await tx.orderRefund.findMany({
    where: {
      stripePaymentIntentId: { in: affectedPiIds },
      refundKind: { not: OrderRefundKind.LATE_PAYMENT },
    },
    select: { id: true, stripeRefundId: true },
  });
  const siblingOrderRefundIds = new Set(siblingNonLateRefunds.map((s) => s.id));
  const siblingStripeRefundIds = new Set(
    siblingNonLateRefunds
      .map((s) => s.stripeRefundId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  );

  let enqueuedEmail = false;
  let matchedAnyLatePayment = false;

  for (const orderRefund of existingRows) {
    const nonSiblingRefunds = refunds.filter((r) => {
      const ownedBySiblingMetadata = Boolean(
        r.metadata?.orderRefundId &&
          r.metadata.orderRefundId !== orderRefund.id &&
          siblingOrderRefundIds.has(r.metadata.orderRefundId)
      );
      const ownedBySiblingStripeId = Boolean(
        r.id &&
          r.id !== orderRefund.stripeRefundId &&
          siblingStripeRefundIds.has(r.id)
      );
      return !ownedBySiblingMetadata && !ownedBySiblingStripeId;
    });

    // If all incoming Stripe refunds belong to known non-late-payment sibling refunds, ignore cleanly
    if (nonSiblingRefunds.length === 0) {
      continue;
    }

    // Track positively-owned late-payment stripeRefundIds even on already-terminal rows
    for (const r of nonSiblingRefunds) {
      if (
        (orderRefund.stripeRefundId && r.id === orderRefund.stripeRefundId) ||
        r.metadata?.orderRefundId === orderRefund.id
      ) {
        matchedStripeRefundIds.add(r.id);
      }
    }

    matchedAnyLatePayment = true;

    // Terminal and MANUAL_REVIEW_REQUIRED records must not be overwritten or auto-cleared by ordinary webhooks.
    if (
      orderRefund.status === OrderRefundStatus.SUCCEEDED ||
      orderRefund.status === OrderRefundStatus.MANUALLY_RESOLVED ||
      orderRefund.status === OrderRefundStatus.MANUAL_REVIEW_REQUIRED ||
      orderRefund.requiresManualResolution
    ) {
      continue;
    }

    if (paymentIntentId && paymentIntentId !== orderRefund.stripePaymentIntentId) {
      continue;
    }

    // Positive ownership proof required: exact persisted stripeRefundId OR metadata.orderRefundId match
    const matchingRefunds = nonSiblingRefunds.filter((r) => {
      const matchesPersisted = Boolean(
        orderRefund.stripeRefundId && r.id === orderRefund.stripeRefundId
      );
      const matchesMetadata = r.metadata?.orderRefundId === orderRefund.id;
      if (!matchesPersisted && !matchesMetadata) {
        return false;
      }
      if (r.metadata?.orderRefundId && r.metadata.orderRefundId !== orderRefund.id) {
        return false;
      }
      if (r.payment_intent && r.payment_intent !== orderRefund.stripePaymentIntentId) {
        return false;
      }
      return true;
    });

    const targetRefund = matchingRefunds[0];
    if (!targetRefund) {
      continue;
    }

    const amountMatches = targetRefund.amount === orderRefund.amountInCents;
    const currencyMatches =
      Boolean(targetRefund.currency) &&
      targetRefund.currency.toUpperCase() === orderRefund.currency.toUpperCase();

    if (!amountMatches || !currencyMatches || nonSiblingRefunds.length > 1) {
      const now = new Date();
      await tx.orderRefund.update({
        where: { id: orderRefund.id },
        data: {
          status: OrderRefundStatus.MANUAL_REVIEW_REQUIRED,
          requiresManualResolution: true,
          lockedBy: null,
          lockedUntil: null,
          failedAt: now,
          lastErrorCategory: 'ANOMALY',
          lastErrorCode: 'WEBHOOK_REFUND_MISMATCH',
          lastErrorMessage: sanitizeRefundDiagnosticMessage(
            `Webhook refund mismatch for ${targetRefund.id}: observed ${targetRefund.amount} ${targetRefund.currency} across ${refunds.length} refund(s), expected ${orderRefund.amountInCents} ${orderRefund.currency}.`
          ),
        },
      });
      continue;
    }

    // Explicit Stripe confirmation required: only 'succeeded' confirms completion (never null/missing)
    if (targetRefund.status === 'succeeded') {
      const now = new Date();
      await tx.orderRefund.update({
        where: { id: orderRefund.id },
        data: {
          status: OrderRefundStatus.SUCCEEDED,
          stripeRefundId: targetRefund.id,
          succeededAt: now,
          lockedBy: null,
          lockedUntil: null,
          lastErrorCategory: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });

      if (lockedOrder) {
        if (
          lockedOrder.status !== OrderStatus.COMPLETED &&
          lockedOrder.status !== OrderStatus.REFUNDED
        ) {
          await tx.order.update({
            where: { id: lockedOrder.id },
            data: { status: OrderStatus.REFUNDED },
          });
        }
        await tx.paymentTransaction.updateMany({
          where: {
            orderId: lockedOrder.id,
            providerTransactionId: orderRefund.stripePaymentIntentId,
            status: PaymentStatus.SUCCEEDED,
          },
          data: { status: PaymentStatus.REFUNDED },
        });
      }

      if (lockedOrder?.customerEmail) {
        const emailRes = await enqueueLatePaymentRefundEmail(tx, {
          kind: 'CONFIRMED',
          orderRefundId: orderRefund.id,
          orderId: lockedOrder.id,
          recipientEmail: lockedOrder.customerEmail,
          snapshot: {
            orderRefundId: orderRefund.id,
            orderNumber: lockedOrder.orderNumber,
            refundAmountInCents: orderRefund.amountInCents,
            currency: orderRefund.currency,
            buyerName: lockedOrder.customerName,
            eventTitle: lockedOrder.eventTitle,
            stripeRefundId: targetRefund.id,
            confirmedAtIso: now.toISOString(),
            reasonSummary: describeLatePaymentReason(orderRefund.reason),
          },
        });
        if (emailRes.enqueued) {
          enqueuedEmail = true;
        }
      }
    } else if (targetRefund.status === 'pending' || targetRefund.status === 'requires_action') {
      await tx.orderRefund.update({
        where: { id: orderRefund.id },
        data: {
          status: OrderRefundStatus.STRIPE_PENDING,
          stripeRefundId: targetRefund.id,
          lockedBy: null,
          lockedUntil: null,
        },
      });
    } else if (targetRefund.status === 'failed' || targetRefund.status === 'canceled') {
      const now = new Date();
      await tx.orderRefund.update({
        where: { id: orderRefund.id },
        data: {
          status: OrderRefundStatus.MANUAL_REVIEW_REQUIRED,
          requiresManualResolution: true,
          stripeRefundId: targetRefund.id,
          failedAt: now,
          lockedBy: null,
          lockedUntil: null,
          lastErrorCategory: 'PERMANENT',
          lastErrorCode:
            targetRefund.failure_reason || `STRIPE_REFUND_${targetRefund.status.toUpperCase()}`,
          lastErrorMessage: `Stripe reported refund ${targetRefund.id} status '${targetRefund.status}'.`,
        },
      });

      emitManualReviewCriticalAlert({
        orderRefundId: orderRefund.id,
        orderId: orderRefund.orderId,
        stripePaymentIntentId: orderRefund.stripePaymentIntentId,
        stripeRefundId: targetRefund.id,
        amountInCents: orderRefund.amountInCents,
        currency: orderRefund.currency,
        code: targetRefund.failure_reason || `STRIPE_REFUND_${targetRefund.status.toUpperCase()}`,
        message: `Stripe reported refund ${targetRefund.id} status '${targetRefund.status}'.`,
      });

      if (lockedOrder?.customerEmail) {
        const emailRes = await enqueueLatePaymentRefundEmail(tx, {
          kind: 'MANUAL_REVIEW',
          orderRefundId: orderRefund.id,
          orderId: lockedOrder.id,
          recipientEmail: lockedOrder.customerEmail,
          snapshot: {
            orderRefundId: orderRefund.id,
            orderNumber: lockedOrder.orderNumber,
            refundAmountInCents: orderRefund.amountInCents,
            currency: orderRefund.currency,
            buyerName: lockedOrder.customerName,
            eventTitle: lockedOrder.eventTitle,
            stripeRefundId: targetRefund.id,
            confirmedAtIso: null,
            reasonSummary: describeLatePaymentReason(orderRefund.reason),
          },
        });
        if (emailRes.enqueued) {
          enqueuedEmail = true;
        }
      }
    }
    // Note: if targetRefund.status is null/missing, leave OrderRefund unchanged without confirming success.
  }

  return {
    matchedLatePaymentRefund: matchedAnyLatePayment,
    matchedStripeRefundIds,
    enqueuedEmail,
  };
}

/**
 * Webhook reconciliation helper called inside an existing webhook transaction.
 * Caller MUST lock Order (FOR UPDATE) before calling when an Order exists.
 */
export async function reconcileOrderRefundFromStripeWebhook(
  tx: Prisma.TransactionClient,
  params: {
    lockedOrder: {
      id: string;
      orderNumber: string;
      status: OrderStatus;
      customerEmail: string;
      customerName: string;
      eventTitle: string;
    } | null;
    paymentIntentId?: string | null;
    hasMoreRefunds?: boolean;
    refunds: Array<{
      id: string;
      amount: number;
      currency: string;
      status: string | null;
      failure_reason?: string;
      payment_intent?: string | null;
      metadata?: Record<string, string> | null;
    }>;
  }
): Promise<{ matchedLatePaymentRefund: boolean; enqueuedEmail: boolean }> {
  const res = await reconcileLatePaymentOrderRefundsInTx(tx, params);
  return {
    matchedLatePaymentRefund: res.matchedLatePaymentRefund,
    enqueuedEmail: res.enqueuedEmail,
  };
}

export async function reconcileOrderRefundFromStripeWebhookWithTrackedIds(
  tx: Prisma.TransactionClient,
  params: Parameters<typeof reconcileOrderRefundFromStripeWebhook>[1]
) {
  return reconcileLatePaymentOrderRefundsInTx(tx, params);
}

/**
 * Reconciles buyer/partial/cancellation ticket refunds (ORGANIZER_TICKET_REFUND, ADMIN_TICKET_REFUND,
 * EVENT_CANCELLATION) inside an active webhook transaction.
 * Caller MUST lock Order (FOR UPDATE) before calling so confirmTicketRefundSucceededInTx
 * maintains canonical Order -> Ticket -> OrderRefund lock order.
 */
export async function reconcileBuyerRefundsFromStripeWebhook(
  tx: Prisma.TransactionClient,
  params: {
    lockedOrder: {
      id: string;
      orderNumber: string;
      status: OrderStatus;
      customerEmail: string;
      customerName: string;
      eventTitle: string;
    } | null;
    paymentIntentId?: string | null;
    stripeChargeId?: string | null;
    hasMoreRefunds?: boolean;
    refunds: Array<{
      id: string;
      amount: number;
      currency: string;
      status: string | null;
      failure_reason?: string;
      payment_intent?: string | null;
      metadata?: Record<string, string> | null;
    }>;
  }
): Promise<{
  matchedBuyerRefund: boolean;
  matchedStripeRefundIds: Set<string>;
  enqueuedEmail: boolean;
  tiersToAdvanceWaitlist: string[];
}> {
  const { lockedOrder, paymentIntentId, stripeChargeId, hasMoreRefunds = false, refunds } = params;
  const matchedStripeRefundIds = new Set<string>();
  const waitlistTierSet = new Set<string>();

  const refundIds = refunds.map((r) => r.id).filter(Boolean);
  const metaOrderRefundIds = refunds
    .map((r) => r.metadata?.orderRefundId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  if (!paymentIntentId && refundIds.length === 0 && metaOrderRefundIds.length === 0) {
    return {
      matchedBuyerRefund: false,
      matchedStripeRefundIds,
      enqueuedEmail: false,
      tiersToAdvanceWaitlist: [],
    };
  }

  const orClauses: Prisma.OrderRefundWhereInput[] = [];
  if (paymentIntentId) {
    orClauses.push({ stripePaymentIntentId: paymentIntentId });
  }
  if (refundIds.length > 0) {
    orClauses.push({ stripeRefundId: { in: refundIds } });
  }
  if (metaOrderRefundIds.length > 0) {
    orClauses.push({ id: { in: metaOrderRefundIds } });
  }

  const buyerRows =
    orClauses.length > 0 && typeof tx.orderRefund?.findMany === 'function'
      ? await tx.orderRefund.findMany({
          where: {
            refundKind: {
              in: [
                OrderRefundKind.ORGANIZER_TICKET_REFUND,
                OrderRefundKind.ADMIN_TICKET_REFUND,
                OrderRefundKind.EVENT_CANCELLATION,
              ],
            },
            OR: orClauses,
          },
          orderBy: { id: 'asc' },
        })
      : [];

  if (buyerRows.length === 0) {
    return {
      matchedBuyerRefund: false,
      matchedStripeRefundIds,
      enqueuedEmail: false,
      tiersToAdvanceWaitlist: [],
    };
  }

  if (hasMoreRefunds || refunds.length === 0) {
    return {
      matchedBuyerRefund: true,
      matchedStripeRefundIds,
      enqueuedEmail: false,
      tiersToAdvanceWaitlist: [],
    };
  }

  let matchedAnyBuyerRefund = false;
  let enqueuedEmail = false;

  for (const orderRefund of buyerRows) {
    // Multiple partial refunds may share one stripePaymentIntentId; match positively to this row.
    const matchingRefunds = refunds.filter((r) => {
      if (r.metadata?.orderRefundId && r.metadata.orderRefundId !== orderRefund.id) {
        return false;
      }
      if (r.payment_intent && r.payment_intent !== orderRefund.stripePaymentIntentId) {
        return false;
      }
      const matchesPersisted = Boolean(
        orderRefund.stripeRefundId && r.id === orderRefund.stripeRefundId
      );
      const matchesMetadata = r.metadata?.orderRefundId === orderRefund.id;
      return matchesPersisted || matchesMetadata;
    });

    if (matchingRefunds.length === 0) {
      continue;
    }

    matchedAnyBuyerRefund = true;
    for (const r of matchingRefunds) {
      if (r.id) {
        matchedStripeRefundIds.add(r.id);
      }
    }

    // Preserve terminal, cancelled, or manual-review states
    if (
      orderRefund.status === OrderRefundStatus.SUCCEEDED ||
      orderRefund.status === OrderRefundStatus.MANUALLY_RESOLVED ||
      orderRefund.status === OrderRefundStatus.MANUAL_REVIEW_REQUIRED ||
      orderRefund.status === OrderRefundStatus.CANCELLED ||
      orderRefund.requiresManualResolution
    ) {
      continue;
    }

    const targetRefund = matchingRefunds[0];
    if (!targetRefund) {
      continue;
    }

    const amountMatches = targetRefund.amount === orderRefund.amountInCents;
    const currencyMatches =
      Boolean(targetRefund.currency) &&
      targetRefund.currency.toUpperCase() === orderRefund.currency.toUpperCase();

    if (matchingRefunds.length > 1 || !amountMatches || !currencyMatches) {
      const now = new Date();
      await tx.orderRefund.update({
        where: { id: orderRefund.id },
        data: {
          status: OrderRefundStatus.MANUAL_REVIEW_REQUIRED,
          requiresManualResolution: true,
          lockedBy: null,
          lockedUntil: null,
          failedAt: now,
          lastErrorCategory: 'ANOMALY',
          lastErrorCode: 'WEBHOOK_REFUND_MISMATCH',
          lastErrorMessage: sanitizeRefundDiagnosticMessage(
            `Webhook buyer refund mismatch for ${targetRefund.id}: observed ${targetRefund.amount} ${targetRefund.currency} across ${matchingRefunds.length} matching refund(s), expected ${orderRefund.amountInCents} ${orderRefund.currency}.`
          ),
        },
      });
      emitManualReviewCriticalAlert({
        orderRefundId: orderRefund.id,
        orderId: orderRefund.orderId,
        stripePaymentIntentId: orderRefund.stripePaymentIntentId,
        stripeRefundId: targetRefund.id,
        amountInCents: orderRefund.amountInCents,
        currency: orderRefund.currency,
        code: 'WEBHOOK_REFUND_MISMATCH',
        message: `Buyer refund webhook mismatch for ${targetRefund.id}.`,
      });
      if (lockedOrder?.customerEmail) {
        const stats = await loadBuyerRefundEmailStats(tx, orderRefund.id, lockedOrder.id);
        const emailRes = await enqueueBuyerRefundEmail(tx, {
          kind: 'MANUAL_REVIEW',
          orderRefundId: orderRefund.id,
          orderId: lockedOrder.id,
          recipientEmail: lockedOrder.customerEmail,
          snapshot: {
            orderRefundId: orderRefund.id,
            orderNumber: lockedOrder.orderNumber,
            refundAmountInCents: orderRefund.amountInCents,
            currency: orderRefund.currency,
            buyerName: lockedOrder.customerName,
            eventTitle: lockedOrder.eventTitle,
            ticketCount: stats.ticketCount,
            isPartialRefund: stats.isPartialRefund,
            stripeRefundId: targetRefund.id,
            confirmedAtIso: null,
            reasonSummary: orderRefund.reason || 'Organizer-initiated ticket refund',
          },
        });
        if (emailRes.enqueued) enqueuedEmail = true;
      }
      continue;
    }

    if (targetRefund.status === 'succeeded') {
      const now = new Date();
      const fin = await confirmTicketRefundSucceededInTx(tx, {
        orderRefundId: orderRefund.id,
        stripeRefundId: targetRefund.id,
        stripeChargeId: stripeChargeId ?? orderRefund.stripeChargeId,
        confirmedByUserId: orderRefund.initiatedByUserId,
        succeededAt: now,
      });
      for (const tierId of fin.tiersToAdvanceWaitlist) {
        waitlistTierSet.add(tierId);
      }
      if (!fin.alreadyFinalized && lockedOrder?.customerEmail) {
        const stats = await loadBuyerRefundEmailStats(tx, orderRefund.id, lockedOrder.id);
        const emailRes = await enqueueBuyerRefundEmail(tx, {
          kind: 'CONFIRMED',
          orderRefundId: orderRefund.id,
          orderId: lockedOrder.id,
          recipientEmail: lockedOrder.customerEmail,
          snapshot: {
            orderRefundId: orderRefund.id,
            orderNumber: lockedOrder.orderNumber,
            refundAmountInCents: orderRefund.amountInCents,
            currency: orderRefund.currency,
            buyerName: lockedOrder.customerName,
            eventTitle: lockedOrder.eventTitle,
            ticketCount: stats.ticketCount,
            isPartialRefund: stats.isPartialRefund,
            stripeRefundId: targetRefund.id,
            confirmedAtIso: now.toISOString(),
            reasonSummary: orderRefund.reason || 'Organizer-initiated ticket refund',
          },
        });
        if (emailRes.enqueued) {
          enqueuedEmail = true;
        }
      }
    } else if (targetRefund.status === 'pending' || targetRefund.status === 'requires_action') {
      await tx.orderRefund.update({
        where: { id: orderRefund.id },
        data: {
          status: OrderRefundStatus.STRIPE_PENDING,
          stripeRefundId: targetRefund.id,
          lockedBy: null,
          lockedUntil: null,
        },
      });
    } else if (targetRefund.status === 'failed' || targetRefund.status === 'canceled') {
      const now = new Date();
      await tx.orderRefund.update({
        where: { id: orderRefund.id },
        data: {
          status: OrderRefundStatus.MANUAL_REVIEW_REQUIRED,
          requiresManualResolution: true,
          stripeRefundId: targetRefund.id,
          failedAt: now,
          lockedBy: null,
          lockedUntil: null,
          lastErrorCategory: 'PERMANENT',
          lastErrorCode:
            targetRefund.failure_reason || `STRIPE_REFUND_${targetRefund.status.toUpperCase()}`,
          lastErrorMessage: `Stripe reported buyer refund ${targetRefund.id} status '${targetRefund.status}'.`,
        },
      });
      emitManualReviewCriticalAlert({
        orderRefundId: orderRefund.id,
        orderId: orderRefund.orderId,
        stripePaymentIntentId: orderRefund.stripePaymentIntentId,
        stripeRefundId: targetRefund.id,
        amountInCents: orderRefund.amountInCents,
        currency: orderRefund.currency,
        code: targetRefund.failure_reason || `STRIPE_REFUND_${targetRefund.status.toUpperCase()}`,
        message: `Stripe reported buyer refund ${targetRefund.id} status '${targetRefund.status}'.`,
      });
      if (lockedOrder?.customerEmail) {
        const stats = await loadBuyerRefundEmailStats(tx, orderRefund.id, lockedOrder.id);
        const emailRes = await enqueueBuyerRefundEmail(tx, {
          kind: 'MANUAL_REVIEW',
          orderRefundId: orderRefund.id,
          orderId: lockedOrder.id,
          recipientEmail: lockedOrder.customerEmail,
          snapshot: {
            orderRefundId: orderRefund.id,
            orderNumber: lockedOrder.orderNumber,
            refundAmountInCents: orderRefund.amountInCents,
            currency: orderRefund.currency,
            buyerName: lockedOrder.customerName,
            eventTitle: lockedOrder.eventTitle,
            ticketCount: stats.ticketCount,
            isPartialRefund: stats.isPartialRefund,
            stripeRefundId: targetRefund.id,
            confirmedAtIso: null,
            reasonSummary: orderRefund.reason || 'Organizer-initiated ticket refund',
          },
        });
        if (emailRes.enqueued) {
          enqueuedEmail = true;
        }
      }
    }
  }

  return {
    matchedBuyerRefund: matchedAnyBuyerRefund,
    matchedStripeRefundIds,
    enqueuedEmail,
    tiersToAdvanceWaitlist: Array.from(waitlistTierSet),
  };
}

/**
 * Controlled manual resolution helper for operators closing a LATE_PAYMENT MANUAL_REVIEW_REQUIRED OrderRefund.
 * Rejects buyer ticket refund, event cancellation, and external reconciled refund kinds before mutation.
 * Atomically updates OrderRefund, Order (when refund confirmed manually), and AdminAuditLog.
 */
export async function resolveManualOrderRefund(input: {
  orderRefundId: string;
  actorUserId?: string | null;
  actorEmail: string;
  action: ManualResolutionAction;
  stripeRefundId?: string | null;
  notes: string;
  ipAddress?: string | null;
}): Promise<OrderRefund> {
  const cleanNotes = (input.notes || '').trim();
  if (cleanNotes.length < 3) {
    throw new BadRequestError('Resolution notes are required (minimum 3 characters).');
  }

  const normalizedActorEmail = normalizeEmail(input.actorEmail || '');
  if (!normalizedActorEmail) {
    throw new BadRequestError('Operator actorEmail is required for audit logging.');
  }

  const cleanStripeRefundId = input.stripeRefundId?.trim() || null;
  if (
    (input.action === 'REFUNDED_MANUALLY' || input.action === 'CONFIRMED_ALREADY_REFUNDED') &&
    !cleanStripeRefundId
  ) {
    throw new BadRequestError(
      'stripeRefundId evidence is required when resolving as refunded or confirmed refunded.'
    );
  }

  return await prisma.$transaction(async (tx) => {
    const preLookup = await tx.orderRefund.findUnique({
      where: { id: input.orderRefundId },
      select: { id: true, orderId: true, refundKind: true },
    });

    if (!preLookup) {
      throw new NotFoundError(`OrderRefund '${input.orderRefundId}' not found.`);
    }

    if (
      preLookup.refundKind !== undefined &&
      preLookup.refundKind !== OrderRefundKind.LATE_PAYMENT
    ) {
      throw new ConflictError(
        `OrderRefund '${preLookup.id}' has unsupported refundKind '${preLookup.refundKind}' for resolveManualOrderRefund; only LATE_PAYMENT refunds are supported.`,
        'UNSUPPORTED_MANUAL_REFUND_KIND'
      );
    }

    // Preserve canonical Order -> OrderRefund lock ordering
    let lockedOrder: { id: string; status: OrderStatus; orderNumber: string } | null = null;
    if (preLookup.orderId) {
      const orderRows = await tx.$queryRaw<
        Array<{ id: string; status: OrderStatus; orderNumber: string }>
      >`
        SELECT id, status, "orderNumber" FROM "Order" WHERE id = ${preLookup.orderId} FOR UPDATE
      `;
      lockedOrder = orderRows[0] || null;
    }

    const lockedRefundRows = await tx.$queryRaw<OrderRefund[]>`
      SELECT * FROM "OrderRefund" WHERE id = ${input.orderRefundId} FOR UPDATE
    `;
    const refund = lockedRefundRows[0];
    if (!refund) {
      throw new NotFoundError(`OrderRefund '${input.orderRefundId}' not found.`);
    }

    if (refund.refundKind !== OrderRefundKind.LATE_PAYMENT) {
      throw new ConflictError(
        `OrderRefund '${refund.id}' has unsupported refundKind '${refund.refundKind}' for resolveManualOrderRefund; only LATE_PAYMENT refunds are supported.`,
        'UNSUPPORTED_MANUAL_REFUND_KIND'
      );
    }

    if (
      refund.status !== OrderRefundStatus.MANUAL_REVIEW_REQUIRED &&
      !refund.requiresManualResolution
    ) {
      throw new ConflictError(
        `OrderRefund '${refund.id}' cannot be manually resolved from status '${refund.status}'.`
      );
    }

    if (refund.resolvedAt) {
      throw new ConflictError(`OrderRefund '${refund.id}' has already been resolved.`);
    }

    const now = new Date();
    const resolved = await tx.orderRefund.update({
      where: { id: refund.id },
      data: {
        status: OrderRefundStatus.MANUALLY_RESOLVED,
        requiresManualResolution: false,
        resolvedAt: now,
        resolvedByUserId: input.actorUserId ?? null,
        resolvedByEmail: normalizedActorEmail,
        resolutionAction: input.action,
        resolutionNotes: sanitizeRefundDiagnosticMessage(cleanNotes),
        ...(cleanStripeRefundId ? { stripeRefundId: cleanStripeRefundId } : {}),
        lockedBy: null,
        lockedUntil: null,
      },
    });

    if (
      refund.refundKind === OrderRefundKind.LATE_PAYMENT &&
      lockedOrder &&
      (input.action === 'REFUNDED_MANUALLY' || input.action === 'CONFIRMED_ALREADY_REFUNDED')
    ) {
      if (
        lockedOrder.status !== OrderStatus.COMPLETED &&
        lockedOrder.status !== OrderStatus.REFUNDED
      ) {
        await tx.order.update({
          where: { id: lockedOrder.id },
          data: { status: OrderStatus.REFUNDED },
        });
      }

      await tx.paymentTransaction.updateMany({
        where: {
          orderId: lockedOrder.id,
          providerTransactionId: refund.stripePaymentIntentId,
          status: PaymentStatus.SUCCEEDED,
        },
        data: { status: PaymentStatus.REFUNDED },
      });
    }

    // Cancel any un-dispatched PENDING manual-review buyer notification so resolved cases
    // never emit stale "still unresolved" notices or fail permanently on dispatch.
    await tx.emailOutbox.updateMany({
      where: {
        dedupeKey: {
          in: [
            buildLatePaymentRefundManualReviewDedupeKey(refund.id),
            buildBuyerRefundManualReviewDedupeKey(refund.id),
          ],
        },
        status: EmailOutboxStatus.PENDING,
      },
      data: {
        status: EmailOutboxStatus.CANCELLED,
        lockedBy: null,
        lockedUntil: null,
        lastErrorCode: 'REFUND_ALREADY_MANUALLY_RESOLVED',
        lastErrorMessage: 'Superseded by manual refund resolution prior to dispatch.',
      },
    });

    await tx.adminAuditLog.create({
      data: {
        actorUserId: input.actorUserId ?? null,
        actorEmail: normalizedActorEmail,
        action: 'ORDER_REFUND_MANUALLY_RESOLVED',
        targetType: 'OrderRefund',
        targetId: refund.id,
        metadata: {
          orderId: refund.orderId,
          orderNumber: lockedOrder?.orderNumber || null,
          stripePaymentIntentId: refund.stripePaymentIntentId,
          stripeRefundId: cleanStripeRefundId || refund.stripeRefundId,
          amountInCents: refund.amountInCents,
          currency: refund.currency,
          resolutionAction: input.action,
          resolutionNotes: sanitizeRefundDiagnosticMessage(cleanNotes),
          resolvedAt: now.toISOString(),
        },
        ipAddress: input.ipAddress ?? null,
      },
    });

    return resolved;
  });
}

export async function listPendingManualReviewOrderRefunds() {
  return prisma.orderRefund.findMany({
    where: {
      requiresManualResolution: true,
      resolvedAt: null,
    },
    orderBy: { createdAt: 'asc' },
    include: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          status: true,
          customerEmail: true,
          customerName: true,
        },
      },
    },
  });
}
