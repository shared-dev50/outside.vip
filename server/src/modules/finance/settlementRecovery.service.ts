import crypto from 'crypto';
import os from 'os';
import Stripe from 'stripe';
import {
  LedgerEntryType,
  Order,
  OrderStatus,
  PaymentProvider,
  Prisma,
  StripeSettlementStatus,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { stripe } from '../../lib/stripe.js';
import { redactSensitiveData } from './stripeError.js';
import {
  hasOpenDisputeForOrder,
  recordActualStripeFee,
  reconcileChargeRefundBeforeSettlement,
  settleOrderEarnings,
} from './ledger.service.js';

export const SETTLEMENT_MAX_ATTEMPTS = 8;
export const SETTLEMENT_LEASE_MS = 90_000;
export const SETTLEMENT_BATCH_SIZE = 10;

export const SETTLEMENT_MANUAL_REVIEW_SQL = `
SELECT
  o.id AS "orderId",
  o."orderNumber",
  e."organizerId",
  o."organizerNetInCents",
  o.currency,
  o."paymentReference",
  o."stripeSettledChargeId",
  o."stripeBalanceTransactionId",
  o."stripeSettlementStatus",
  o."stripeSettlementAttempts",
  o."stripeSettlementLastErrorCategory",
  o."stripeSettlementLastErrorCode",
  o."stripeSettlementLastErrorMessage",
  o."stripeSettlementLastAttemptAt",
  o."stripeSettlementFailedAt"
FROM "Order" o
JOIN "Event" e ON e.id = o."eventId"
WHERE o."stripeSettlementStatus" = 'FAILED_PERMANENT'::"StripeSettlementStatus"
  AND NOT EXISTS (
    SELECT 1 FROM "FinancialLedgerEntry" fle
    WHERE fle."orderId" = o.id
      AND fle.type = 'TICKET_SALE_CLEARED'::"LedgerEntryType"
  )
ORDER BY o."stripeSettlementFailedAt" ASC NULLS LAST, o."createdAt" ASC;
`.trim();

/**
 * Operator reset query template for eligible FAILED_PERMANENT orders after correcting
 * Stripe credentials or external configuration. Requires explicit order ID selection.
 * Never modifies FinancialLedgerEntry or OrganizerBalance.
 */
export const SETTLEMENT_RESET_ELIGIBLE_SQL = `
UPDATE "Order" o
SET
  "stripeSettlementStatus" = 'PENDING'::"StripeSettlementStatus",
  "stripeSettlementAttempts" = 0,
  "stripeSettlementNextAttemptAt" = (NOW() AT TIME ZONE 'UTC'),
  "stripeSettlementLockedBy" = NULL,
  "stripeSettlementLockedUntil" = NULL,
  "stripeSettlementFailedAt" = NULL,
  "stripeSettlementLastErrorCategory" = NULL,
  "stripeSettlementLastErrorCode" = NULL,
  "stripeSettlementLastErrorMessage" = NULL,
  "updatedAt" = (NOW() AT TIME ZONE 'UTC')
WHERE o.id = ANY($1::text[])
  AND o.status = 'COMPLETED'::"OrderStatus"
  AND o."paymentProvider" = 'STRIPE'::"PaymentProvider"
  AND o."stripeSettlementStatus" = 'FAILED_PERMANENT'::"StripeSettlementStatus"
  AND NOT EXISTS (
    SELECT 1 FROM "FinancialLedgerEntry" fle
    WHERE fle."orderId" = o.id
      AND fle.type = 'TICKET_SALE_CLEARED'::"LedgerEntryType"
  );
`.trim();

export const SETTLEMENT_RETRY_DELAYS_MS = [
  30_000, // Retry 1: 30s
  120_000, // Retry 2: 2m
  300_000, // Retry 3: 5m
  900_000, // Retry 4: 15m
  1_800_000, // Retry 5: 30m
  3_600_000, // Retry 6: 1h
  7_200_000, // Retry 7: 2h
] as const;

export interface SettlementErrorClassification {
  disposition: 'RETRY' | 'PERMANENT';
  category: 'RETRYABLE' | 'PERMANENT';
  code: string;
  message: string;
}

export interface SettlementRecoveryPassStats {
  claimed: number;
  settled: number;
  stripePending: number;
  disputeHeld: number;
  retried: number;
  failedPermanent: number;
  skipped: number;
  leaseLost: number;
  alreadySettled: number;
  reapedExhausted: number;
}

export function generateSettlementWorkerId(): string {
  const host = os.hostname().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 32) || 'host';
  const suffix = crypto.randomBytes(4).toString('hex');
  return `settle:${host}:${process.pid}:${suffix}`;
}

export function sanitizeSettlementDiagnosticMessage(raw: unknown): string {
  const rawStr = raw instanceof Error ? raw.message : String(raw ?? 'Unknown error');
  return redactSensitiveData(rawStr).slice(0, 500);
}

export function emitSettlementCriticalAlert(details: {
  orderId: string;
  orderNumber?: string | null;
  stripeChargeId?: string | null;
  stripeBalanceTransactionId?: string | null;
  code: string;
  message: string;
}): void {
  console.error('[Settlement][CRITICAL]', {
    orderId: details.orderId,
    orderNumber: details.orderNumber || null,
    stripeChargeId: details.stripeChargeId || null,
    stripeBalanceTransactionId: details.stripeBalanceTransactionId || null,
    code: details.code,
    message: sanitizeSettlementDiagnosticMessage(details.message),
  });
}

export function computeNextSettlementRetryDelayMs(
  completedAttempt: number,
  randomFn: () => number = Math.random
): number {
  const idx = Math.max(
    0,
    Math.min(completedAttempt - 1, SETTLEMENT_RETRY_DELAYS_MS.length - 1)
  );
  const baseMs = SETTLEMENT_RETRY_DELAYS_MS[idx];
  const clamped = Math.max(0, Math.min(1, randomFn()));
  const jitter = 0.8 + clamped * 0.4;
  return Math.max(1_000, Math.round(baseMs * jitter));
}

export function classifyStripeSettlementRetrievalError(
  err: any
): SettlementErrorClassification {
  const errType = String(err?.type || err?.rawType || '');
  const errCode = String(err?.code || err?.raw?.code || '');
  const statusCode =
    typeof err?.statusCode === 'number'
      ? err.statusCode
      : typeof err?.status === 'number'
        ? err.status
        : null;
  const rawMessage = String(err?.message || 'Stripe settlement retrieval failed');
  const safeMsg = sanitizeSettlementDiagnosticMessage(rawMessage);

  // Transient authentication, permission, network, rate-limit and server errors receive bounded retries
  if (
    errType === 'StripeAuthenticationError' ||
    errType === 'StripePermissionError' ||
    errCode === 'api_key_expired' ||
    errCode === 'bad_api_key' ||
    statusCode === 401 ||
    statusCode === 403
  ) {
    return {
      disposition: 'RETRY',
      category: 'RETRYABLE',
      code: errCode || 'STRIPE_AUTH_OR_CONFIG_ERROR',
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
    /timed?\s*out|timeout|network|ECONN|ENOTFOUND|rate limit/i.test(rawMessage)
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
    errCode === 'resource_missing' ||
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

/**
 * Nudges due/near-due pending Stripe orders when a platform balance.available webhook arrives.
 * Does NOT trust balance.available as proof any specific order is available; triggers verification.
 */
export async function handleBalanceAvailableWebhook(
  tx: Prisma.TransactionClient
): Promise<boolean> {
  await tx.$executeRaw`
    UPDATE "Order" o
    SET
      "stripeSettlementStatus" = 'PENDING'::"StripeSettlementStatus",
      "stripeSettlementNextAttemptAt" = (NOW() AT TIME ZONE 'UTC'),
      "updatedAt" = (NOW() AT TIME ZONE 'UTC')
    WHERE o.status = 'COMPLETED'::"OrderStatus"
      AND o."paymentProvider" = 'STRIPE'::"PaymentProvider"
      AND o."organizerNetInCents" > 0
      AND (
        o."stripeSettlementStatus" IS NULL
        OR o."stripeSettlementStatus" = 'PENDING'::"StripeSettlementStatus"
      )
      AND o."stripeSettlementLockedBy" IS NULL
      AND (
        o."stripeAvailableOn" IS NULL
        OR o."stripeAvailableOn" <= (NOW() AT TIME ZONE 'UTC') + INTERVAL '24 hours'
      )
      AND (
        o."stripeSettlementNextAttemptAt" IS NULL
        OR o."stripeSettlementNextAttemptAt" > (NOW() AT TIME ZONE 'UTC')
      )
      AND EXISTS (
        SELECT 1 FROM "FinancialLedgerEntry" fle
        WHERE fle."orderId" = o.id
          AND fle.type = 'TICKET_SALE_PENDING'::"LedgerEntryType"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "FinancialLedgerEntry" fle2
        WHERE fle2."orderId" = o.id
          AND fle2.type = 'TICKET_SALE_CLEARED'::"LedgerEntryType"
      )
  `;

  return true;
}

export async function reapExpiredExhaustedSettlementLeases(): Promise<number> {
  const reaped = await prisma.$queryRaw<Order[]>`
    UPDATE "Order"
    SET
      "stripeSettlementStatus" = 'FAILED_PERMANENT'::"StripeSettlementStatus",
      "stripeSettlementLockedBy" = NULL,
      "stripeSettlementLockedUntil" = NULL,
      "stripeSettlementNextAttemptAt" = NULL,
      "stripeSettlementFailedAt" = COALESCE("stripeSettlementFailedAt", (NOW() AT TIME ZONE 'UTC')),
      "stripeSettlementLastErrorCategory" = COALESCE("stripeSettlementLastErrorCategory", 'PERMANENT'),
      "stripeSettlementLastErrorCode" = COALESCE("stripeSettlementLastErrorCode", 'WORKER_LEASE_EXPIRED_MAX_ATTEMPTS'),
      "stripeSettlementLastErrorMessage" = COALESCE(
        "stripeSettlementLastErrorMessage",
        'Worker lease expired after reaching maximum settlement verification attempts'
      ),
      "updatedAt" = (NOW() AT TIME ZONE 'UTC')
    WHERE "stripeSettlementStatus" = 'PENDING'::"StripeSettlementStatus"
      AND "stripeSettlementLockedUntil" IS NOT NULL
      AND "stripeSettlementLockedUntil" < (NOW() AT TIME ZONE 'UTC')
      AND "stripeSettlementAttempts" >= ${SETTLEMENT_MAX_ATTEMPTS}
    RETURNING *
  `;

  for (const row of reaped) {
    emitSettlementCriticalAlert({
      orderId: row.id,
      orderNumber: row.orderNumber,
      stripeChargeId: row.stripeSettledChargeId,
      stripeBalanceTransactionId: row.stripeBalanceTransactionId,
      code: row.stripeSettlementLastErrorCode || 'WORKER_LEASE_EXPIRED_MAX_ATTEMPTS',
      message:
        row.stripeSettlementLastErrorMessage ||
        'Worker lease expired after reaching maximum settlement verification attempts',
    });
  }

  return reaped.length;
}

export async function claimPendingSettlementBatch(options?: {
  workerId?: string;
  batchSize?: number;
  leaseMs?: number;
}): Promise<{ workerId: string; claimed: Order[]; reapedExhausted: number }> {
  const workerId = options?.workerId || generateSettlementWorkerId();
  const batchSize = Math.max(1, Math.min(options?.batchSize ?? SETTLEMENT_BATCH_SIZE, 100));
  const leaseMs = Math.max(5_000, options?.leaseMs ?? SETTLEMENT_LEASE_MS);

  const reapedExhausted = await reapExpiredExhaustedSettlementLeases();

  const claimed = await prisma.$queryRaw<Order[]>`
    WITH claimable AS (
      SELECT o.id
      FROM "Order" o
      WHERE o.status = 'COMPLETED'::"OrderStatus"
        AND o."paymentProvider" = 'STRIPE'::"PaymentProvider"
        AND o."organizerNetInCents" > 0
        AND (
          o."stripeSettlementStatus" IS NULL
          OR o."stripeSettlementStatus" = 'PENDING'::"StripeSettlementStatus"
        )
        AND (
          (
            (o."stripeSettlementNextAttemptAt" IS NULL OR o."stripeSettlementNextAttemptAt" <= (NOW() AT TIME ZONE 'UTC'))
            AND (o."stripeSettlementLockedUntil" IS NULL OR o."stripeSettlementLockedUntil" < (NOW() AT TIME ZONE 'UTC'))
          )
          OR (
            o."stripeSettlementLockedUntil" IS NOT NULL
            AND o."stripeSettlementLockedUntil" < (NOW() AT TIME ZONE 'UTC')
          )
        )
        AND o."stripeSettlementAttempts" < ${SETTLEMENT_MAX_ATTEMPTS}
        AND EXISTS (
          SELECT 1 FROM "FinancialLedgerEntry" fle
          WHERE fle."orderId" = o.id
            AND fle.type = 'TICKET_SALE_PENDING'::"LedgerEntryType"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "FinancialLedgerEntry" fle2
          WHERE fle2."orderId" = o.id
            AND fle2.type = 'TICKET_SALE_CLEARED'::"LedgerEntryType"
        )
      ORDER BY COALESCE(o."stripeSettlementNextAttemptAt", o."createdAt") ASC, o."createdAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "Order" AS o
    SET
      "stripeSettlementStatus" = 'PENDING'::"StripeSettlementStatus",
      "stripeSettlementLockedBy" = ${workerId},
      "stripeSettlementLockedUntil" = (NOW() AT TIME ZONE 'UTC') + (${leaseMs} * INTERVAL '1 millisecond'),
      "stripeSettlementAttempts" = o."stripeSettlementAttempts" + 1,
      "stripeSettlementLastAttemptAt" = (NOW() AT TIME ZONE 'UTC'),
      "updatedAt" = (NOW() AT TIME ZONE 'UTC')
    FROM claimable
    WHERE o.id = claimable.id
    RETURNING o.*
  `;

  return { workerId, claimed, reapedExhausted };
}

async function releasePendingSettlementLease(params: {
  orderId: string;
  workerId: string;
  nextAttemptAt: Date;
  restoreAttemptCount: boolean;
  stripeChargeId?: string | null;
  stripeBalanceTransactionId?: string | null;
  stripeAvailableOn?: Date | null;
  fundsAvailableAt?: Date | null;
  errorCategory?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  currentAttempts: number;
}): Promise<boolean> {
  const updated = await prisma.order.updateMany({
    where: {
      id: params.orderId,
      stripeSettlementLockedBy: params.workerId,
      stripeSettlementStatus: StripeSettlementStatus.PENDING,
    },
    data: {
      stripeSettlementLockedBy: null,
      stripeSettlementLockedUntil: null,
      stripeSettlementNextAttemptAt: params.nextAttemptAt,
      ...(params.restoreAttemptCount
        ? { stripeSettlementAttempts: Math.max(0, params.currentAttempts - 1) }
        : {}),
      ...(params.stripeChargeId ? { stripeSettledChargeId: params.stripeChargeId } : {}),
      ...(params.stripeBalanceTransactionId
        ? { stripeBalanceTransactionId: params.stripeBalanceTransactionId }
        : {}),
      ...(params.stripeAvailableOn ? { stripeAvailableOn: params.stripeAvailableOn } : {}),
      ...(params.fundsAvailableAt ? { stripeFundsAvailableAt: params.fundsAvailableAt } : {}),
      stripeSettlementLastErrorCategory: params.errorCategory ?? null,
      stripeSettlementLastErrorCode: params.errorCode ?? null,
      stripeSettlementLastErrorMessage: params.errorMessage
        ? sanitizeSettlementDiagnosticMessage(params.errorMessage)
        : null,
    },
  });

  return updated.count > 0;
}

async function markSettlementFailedPermanent(params: {
  order: Order;
  workerId: string;
  stripeChargeId?: string | null;
  stripeBalanceTransactionId?: string | null;
  code: string;
  message: string;
}): Promise<boolean> {
  const safeMsg = sanitizeSettlementDiagnosticMessage(params.message);
  const updated = await prisma.order.updateMany({
    where: {
      id: params.order.id,
      stripeSettlementLockedBy: params.workerId,
      stripeSettlementStatus: StripeSettlementStatus.PENDING,
    },
    data: {
      stripeSettlementStatus: StripeSettlementStatus.FAILED_PERMANENT,
      stripeSettlementLockedBy: null,
      stripeSettlementLockedUntil: null,
      stripeSettlementNextAttemptAt: null,
      stripeSettlementFailedAt: new Date(),
      stripeSettlementLastErrorCategory: 'PERMANENT',
      stripeSettlementLastErrorCode: params.code,
      stripeSettlementLastErrorMessage: safeMsg,
      ...(params.stripeChargeId && !params.order.stripeSettledChargeId
        ? { stripeSettledChargeId: params.stripeChargeId }
        : {}),
      ...(params.stripeBalanceTransactionId && !params.order.stripeBalanceTransactionId
        ? { stripeBalanceTransactionId: params.stripeBalanceTransactionId }
        : {}),
    },
  });

  if (updated.count > 0) {
    emitSettlementCriticalAlert({
      orderId: params.order.id,
      orderNumber: params.order.orderNumber,
      stripeChargeId: params.stripeChargeId || params.order.stripeSettledChargeId,
      stripeBalanceTransactionId:
        params.stripeBalanceTransactionId || params.order.stripeBalanceTransactionId,
      code: params.code,
      message: safeMsg,
    });
  }

  return updated.count > 0;
}

async function fetchStripeChargeAndBalanceTx(order: Order): Promise<{
  charge: Stripe.Charge | null;
  balanceTx: Stripe.BalanceTransaction | null;
  paymentIntentStatus?: string;
}> {
  let charge: Stripe.Charge | null = null;
  let paymentIntentStatus: string | undefined;

  if (order.stripeSettledChargeId) {
    charge = await stripe.charges.retrieve(order.stripeSettledChargeId, {
      expand: ['balance_transaction'],
    });
  } else if (order.paymentReference) {
    const pi = await stripe.paymentIntents.retrieve(order.paymentReference, {
      expand: ['latest_charge.balance_transaction'],
    });
    paymentIntentStatus = pi.status;
    if (typeof pi.latest_charge === 'object' && pi.latest_charge !== null) {
      charge = pi.latest_charge as Stripe.Charge;
    } else if (typeof pi.latest_charge === 'string') {
      charge = await stripe.charges.retrieve(pi.latest_charge, {
        expand: ['balance_transaction'],
      });
    }
  }

  let balanceTx: Stripe.BalanceTransaction | null = null;
  if (charge && typeof charge.balance_transaction === 'object' && charge.balance_transaction !== null) {
    balanceTx = charge.balance_transaction as Stripe.BalanceTransaction;
  } else {
    const balanceTxId =
      (charge && typeof charge.balance_transaction === 'string'
        ? charge.balance_transaction
        : null) || order.stripeBalanceTransactionId;
    if (balanceTxId) {
      balanceTx = await stripe.balanceTransactions.retrieve(balanceTxId);
    }
  }

  return { charge, balanceTx, paymentIntentStatus };
}

function computePendingRecheckDate(availableOnMs: number | null, nowMs: number): Date {
  if (availableOnMs !== null && availableOnMs > nowMs) {
    return new Date(Math.max(nowMs + 60_000, availableOnMs));
  }
  if (availableOnMs !== null && nowMs - availableOnMs > 24 * 3_600_000) {
    return new Date(nowMs + 6 * 3_600_000);
  }
  return new Date(nowMs + 15 * 60_000);
}

export async function processClaimedSettlementOrder(
  order: Order,
  workerId: string,
  options?: { randomFn?: () => number }
): Promise<
  | 'settled'
  | 'stripePending'
  | 'disputeHeld'
  | 'retried'
  | 'failedPermanent'
  | 'skipped'
  | 'leaseLost'
  | 'alreadySettled'
> {
  const effectiveStripeKey = process.env.STRIPE_SECRET_KEY ?? env.STRIPE_SECRET_KEY;
  if (!effectiveStripeKey || effectiveStripeKey === 'sk_test_placeholder') {
    const released = await releasePendingSettlementLease({
      orderId: order.id,
      workerId,
      nextAttemptAt: new Date(Date.now() + 5 * 60_000),
      restoreAttemptCount: true,
      currentAttempts: order.stripeSettlementAttempts,
    });
    return released ? 'skipped' : 'leaseLost';
  }

  if (!order.stripeSettledChargeId && !order.paymentReference) {
    const marked = await markSettlementFailedPermanent({
      order,
      workerId,
      code: 'MISSING_STRIPE_IDENTIFIERS',
      message: `Completed Stripe order ${order.orderNumber} has neither stripeSettledChargeId nor paymentReference.`,
    });
    return marked ? 'failedPermanent' : 'leaseLost';
  }

  let charge: Stripe.Charge | null = null;
  let balanceTx: Stripe.BalanceTransaction | null = null;
  let paymentIntentStatus: string | undefined;

  try {
    const fetched = await fetchStripeChargeAndBalanceTx(order);
    charge = fetched.charge;
    balanceTx = fetched.balanceTx;
    paymentIntentStatus = fetched.paymentIntentStatus;
  } catch (err: any) {
    const classified = classifyStripeSettlementRetrievalError(err);
    if (
      classified.disposition === 'PERMANENT' ||
      order.stripeSettlementAttempts >= SETTLEMENT_MAX_ATTEMPTS
    ) {
      const marked = await markSettlementFailedPermanent({
        order,
        workerId,
        code:
          classified.disposition === 'PERMANENT'
            ? classified.code
            : 'MAX_SETTLEMENT_ATTEMPTS_EXCEEDED',
        message: classified.message,
      });
      return marked ? 'failedPermanent' : 'leaseLost';
    }

    const retryDelay = computeNextSettlementRetryDelayMs(
      order.stripeSettlementAttempts,
      options?.randomFn
    );
    const released = await releasePendingSettlementLease({
      orderId: order.id,
      workerId,
      nextAttemptAt: new Date(Date.now() + retryDelay),
      restoreAttemptCount: false,
      currentAttempts: order.stripeSettlementAttempts,
      errorCategory: classified.category,
      errorCode: classified.code,
      errorMessage: classified.message,
    });
    return released ? 'retried' : 'leaseLost';
  }

  if (charge && charge.status === 'failed') {
    const marked = await markSettlementFailedPermanent({
      order,
      workerId,
      stripeChargeId: charge.id,
      stripeBalanceTransactionId: balanceTx?.id,
      code: 'CHARGE_NOT_SUCCEEDED',
      message: `Stripe charge ${charge.id} has terminal non-succeeded status '${charge.status}'.`,
    });
    return marked ? 'failedPermanent' : 'leaseLost';
  }

  if (
    paymentIntentStatus &&
    paymentIntentStatus !== 'succeeded' &&
    paymentIntentStatus !== 'processing'
  ) {
    const marked = await markSettlementFailedPermanent({
      order,
      workerId,
      stripeChargeId: charge?.id,
      code: 'PAYMENT_INTENT_NOT_SUCCEEDED',
      message: `Stripe PaymentIntent ${order.paymentReference} has non-succeeded status '${paymentIntentStatus}'.`,
    });
    return marked ? 'failedPermanent' : 'leaseLost';
  }

  const nowMs = Date.now();
  const availableOnMs =
    balanceTx && typeof balanceTx.available_on === 'number'
      ? balanceTx.available_on * 1000
      : null;
  const availableOnDate = availableOnMs !== null ? new Date(availableOnMs) : null;

  const isFundsAvailable = Boolean(
    charge &&
      charge.status === 'succeeded' &&
      balanceTx &&
      balanceTx.status === 'available' &&
      (availableOnMs === null || availableOnMs <= nowMs)
  );

  if (!isFundsAvailable) {
    // Opportunistically record actual Stripe fee even while funds remain pending if known
    if (charge && balanceTx && typeof balanceTx.fee === 'number' && !order.stripeActualFeeRecordedAt) {
      await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<
          Array<{ id: string; stripeActualFeeRecordedAt: Date | null; stripeSettlementLockedBy: string | null }>
        >`
          SELECT id, "stripeActualFeeRecordedAt", "stripeSettlementLockedBy"
          FROM "Order"
          WHERE id = ${order.id}
          FOR UPDATE
        `;
        if (
          locked[0] &&
          locked[0].stripeSettlementLockedBy === workerId &&
          !locked[0].stripeActualFeeRecordedAt
        ) {
          await recordActualStripeFee(tx, {
            stripeChargeId: charge!.id,
            actualFeeInCents: balanceTx!.fee,
            currency: balanceTx!.currency || charge!.currency || order.currency,
            orderId: order.id,
          });
          await tx.order.update({
            where: { id: order.id },
            data: {
              stripeActualFeeRecordedAt: new Date(),
              stripeActualFeeInCents: null,
            },
          });
        }
      });
    }

    const released = await releasePendingSettlementLease({
      orderId: order.id,
      workerId,
      nextAttemptAt: computePendingRecheckDate(availableOnMs, nowMs),
      restoreAttemptCount: true,
      currentAttempts: order.stripeSettlementAttempts,
      stripeChargeId: charge?.id,
      stripeBalanceTransactionId: balanceTx?.id,
      stripeAvailableOn: availableOnDate,
    });
    return released ? 'stripePending' : 'leaseLost';
  }

  // Funds verified available in Stripe; finalize settlement inside transaction
  return await prisma.$transaction(
    async (tx) => {
      const lockedRows = await tx.$queryRaw<
        Array<{
          id: string;
          status: OrderStatus;
          stripeSettlementStatus: StripeSettlementStatus | null;
          stripeSettlementLockedBy: string | null;
          stripeActualFeeRecordedAt: Date | null;
          stripeFundsAvailableAt: Date | null;
          paymentReference: string | null;
          organizerNetInCents: number;
          totalInCents: number;
          currency: string;
        }>
      >`
        SELECT
          id,
          status,
          "stripeSettlementStatus",
          "stripeSettlementLockedBy",
          "stripeActualFeeRecordedAt",
          "stripeFundsAvailableAt",
          "paymentReference",
          "organizerNetInCents",
          "totalInCents",
          currency
        FROM "Order"
        WHERE id = ${order.id}
        FOR UPDATE
      `;
      const locked = lockedRows[0];
      if (!locked) {
        return 'leaseLost' as const;
      }

      if (locked.stripeSettlementStatus === StripeSettlementStatus.SETTLED) {
        return 'alreadySettled' as const;
      }

      if (locked.stripeSettlementLockedBy !== workerId) {
        return 'leaseLost' as const;
      }

      const existingCleared = await tx.financialLedgerEntry.findFirst({
        where: { orderId: locked.id, type: LedgerEntryType.TICKET_SALE_CLEARED },
        select: { id: true },
      });
      if (existingCleared) {
        await settleOrderEarnings(tx, {
          orderId: locked.id,
          stripeChargeId: charge!.id,
          stripeBalanceTransactionId: balanceTx!.id,
          availableOn: availableOnDate,
        });
        return 'alreadySettled' as const;
      }

      // Guard fee recording
      if (typeof balanceTx!.fee === 'number' && !locked.stripeActualFeeRecordedAt) {
        await recordActualStripeFee(tx, {
          stripeChargeId: charge!.id,
          actualFeeInCents: balanceTx!.fee,
          currency: balanceTx!.currency || charge!.currency || locked.currency,
          orderId: locked.id,
        });
        await tx.order.update({
          where: { id: locked.id },
          data: {
            stripeActualFeeRecordedAt: new Date(),
            stripeActualFeeInCents: null,
          },
        });
      }

      // Reconcile any missed Stripe charge refunds before moving funds into AVAILABLE
      if (locked.status === OrderStatus.COMPLETED) {
        await reconcileChargeRefundBeforeSettlement(tx, {
          orderId: locked.id,
          paymentReference: locked.paymentReference,
          charge: charge!,
        });
      }

      // Hold in PENDING if an active dispute exists on this order or charge
      if (await hasOpenDisputeForOrder(tx, locked.id, charge)) {
        await tx.order.update({
          where: { id: locked.id },
          data: {
            stripeSettlementStatus: StripeSettlementStatus.PENDING,
            stripeSettledChargeId: charge!.id,
            stripeBalanceTransactionId: balanceTx!.id,
            stripeAvailableOn: availableOnDate,
            stripeFundsAvailableAt: locked.stripeFundsAvailableAt ?? new Date(),
            stripeSettlementLockedBy: null,
            stripeSettlementLockedUntil: null,
            stripeSettlementNextAttemptAt: new Date(Date.now() + 3_600_000),
            stripeSettlementAttempts: Math.max(0, order.stripeSettlementAttempts - 1),
          },
        });
        return 'disputeHeld' as const;
      }

      await settleOrderEarnings(tx, {
        orderId: locked.id,
        stripeChargeId: charge!.id,
        stripeBalanceTransactionId: balanceTx!.id,
        availableOn: availableOnDate,
      });

      return 'settled' as const;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 10000,
    }
  );
}

export async function runSettlementRecoveryPass(options?: {
  workerId?: string;
  batchSize?: number;
  leaseMs?: number;
  randomFn?: () => number;
}): Promise<SettlementRecoveryPassStats> {
  const { workerId, claimed, reapedExhausted } = await claimPendingSettlementBatch({
    workerId: options?.workerId,
    batchSize: options?.batchSize,
    leaseMs: options?.leaseMs,
  });

  const stats: SettlementRecoveryPassStats = {
    claimed: claimed.length,
    settled: 0,
    stripePending: 0,
    disputeHeld: 0,
    retried: 0,
    failedPermanent: 0,
    skipped: 0,
    leaseLost: 0,
    alreadySettled: 0,
    reapedExhausted,
  };

  for (const item of claimed) {
    try {
      const outcome = await processClaimedSettlementOrder(item, workerId, {
        randomFn: options?.randomFn,
      });
      stats[outcome] += 1;
    } catch (err: any) {
      console.error(
        `[SettlementRecovery] Unexpected error on order=${item.id}: ${sanitizeSettlementDiagnosticMessage(err)}`
      );
      await releasePendingSettlementLease({
        orderId: item.id,
        workerId,
        nextAttemptAt: new Date(Date.now() + 60_000),
        restoreAttemptCount: false,
        currentAttempts: item.stripeSettlementAttempts,
        errorCategory: 'RETRYABLE',
        errorCode: 'UNEXPECTED_RECOVERY_ERROR',
        errorMessage: sanitizeSettlementDiagnosticMessage(err),
      }).catch(() => {});
      stats.retried += 1;
    }
  }

  return stats;
}

/**
 * Explicitly resets operator-selected FAILED_PERMANENT settlement orders back to PENDING
 * without altering any FinancialLedgerEntry or OrganizerBalance records.
 */
export async function resetFailedSettlementOrders(orderIds: string[]): Promise<number> {
  const cleanedIds = Array.from(
    new Set(orderIds.map((id) => id.trim()).filter((id) => id.length > 0))
  );
  if (cleanedIds.length === 0) {
    throw new Error('Explicit non-empty orderIds list is required to reset FAILED_PERMANENT settlements.');
  }

  const resetCount = await prisma.$executeRaw`
    UPDATE "Order" o
    SET
      "stripeSettlementStatus" = 'PENDING'::"StripeSettlementStatus",
      "stripeSettlementAttempts" = 0,
      "stripeSettlementNextAttemptAt" = (NOW() AT TIME ZONE 'UTC'),
      "stripeSettlementLockedBy" = NULL,
      "stripeSettlementLockedUntil" = NULL,
      "stripeSettlementFailedAt" = NULL,
      "stripeSettlementLastErrorCategory" = NULL,
      "stripeSettlementLastErrorCode" = NULL,
      "stripeSettlementLastErrorMessage" = NULL,
      "updatedAt" = (NOW() AT TIME ZONE 'UTC')
    WHERE o.id = ANY(${cleanedIds}::text[])
      AND o.status = 'COMPLETED'::"OrderStatus"
      AND o."paymentProvider" = 'STRIPE'::"PaymentProvider"
      AND o."stripeSettlementStatus" = 'FAILED_PERMANENT'::"StripeSettlementStatus"
      AND NOT EXISTS (
        SELECT 1 FROM "FinancialLedgerEntry" fle
        WHERE fle."orderId" = o.id
          AND fle.type = 'TICKET_SALE_CLEARED'::"LedgerEntryType"
      )
  `;

  return Number(resetCount);
}
