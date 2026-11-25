import crypto from 'crypto';
import os from 'os';
import Stripe from 'stripe';
import {
  LedgerBalanceType,
  LedgerEntryType,
  OrganizerTransfer,
  Prisma,
  TransferStatus,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { stripe } from '../../lib/stripe.js';
import { getOrCreateOrganizerBalance } from './ledger.service.js';
import { classifyTransferCreateError, redactSensitiveData } from './stripeError.js';

export const TRANSFER_RECONCILIATION_MAX_ATTEMPTS = 12;
export const TRANSFER_RECONCILIATION_LEASE_MS = 90_000;
export const TRANSFER_RECONCILIATION_BATCH_SIZE = 10;
export const TRANSFER_STALE_PENDING_THRESHOLD_MS = 30_000;
export const STRIPE_IDEMPOTENCY_RETRY_WINDOW_MS = 20 * 60 * 60 * 1000;
export const STRIPE_IDEMPOTENCY_EXPIRY_GRACE_MS = 24 * 60 * 60 * 1000 + 15 * 60 * 1000;

export const TRANSFER_RECONCILIATION_RETRY_DELAYS_MS = [
  30_000, // 30s
  120_000, // 2m
  300_000, // 5m
  900_000, // 15m
  1_800_000, // 30m
  3_600_000, // 1h
  7_200_000, // 2h
  14_400_000, // 4h
] as const;

export interface TransferReconciliationPassStats {
  claimed: number;
  succeeded: number;
  failedRestored: number;
  retried: number;
  stillUncertain: number;
  alreadyFinalized: number;
  skipped: number;
  leaseLost: number;
  manualReviewRequired: number;
}

export function generateTransferWorkerId(): string {
  const host = os.hostname().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 32) || 'host';
  const suffix = crypto.randomBytes(4).toString('hex');
  return `trf_rec:${host}:${process.pid}:${suffix}`;
}

export function sanitizeTransferDiagnosticMessage(raw: unknown): string {
  const rawStr = raw instanceof Error ? raw.message : String(raw ?? 'Unknown error');
  return redactSensitiveData(rawStr).slice(0, 500);
}

export function computeNextTransferRetryDelayMs(
  completedAttempt: number,
  randomFn: () => number = Math.random
): number {
  const idx = Math.max(
    0,
    Math.min(completedAttempt - 1, TRANSFER_RECONCILIATION_RETRY_DELAYS_MS.length - 1)
  );
  const baseMs = TRANSFER_RECONCILIATION_RETRY_DELAYS_MS[idx];
  const clamped = Math.max(0, Math.min(1, randomFn()));
  const jitter = 0.8 + clamped * 0.4;
  return Math.max(1_000, Math.round(baseMs * jitter));
}

export function emitTransferCriticalAlert(details: {
  transferId: string;
  transferNumber: string;
  organizerId: string;
  stripeTransferId?: string | null;
  code: string;
  message: string;
}): void {
  console.error('[TransferReconciliation][CRITICAL]', {
    transferId: details.transferId,
    transferNumber: details.transferNumber,
    organizerId: details.organizerId,
    stripeTransferId: details.stripeTransferId || null,
    code: details.code,
    message: sanitizeTransferDiagnosticMessage(details.message),
  });
}

function getStripeDestinationId(destination: Stripe.Transfer['destination']): string | null {
  if (typeof destination === 'string') return destination;
  if (destination && typeof destination === 'object' && 'id' in destination) {
    return destination.id;
  }
  return null;
}

export const TRANSFER_LOOKUP_PAGE_LIMIT = 100;
export const TRANSFER_LOOKUP_MAX_PAGES = 10;

export function findMatchingStripeTransferInList(
  transfers: Stripe.Transfer[],
  target: {
    id: string;
    transferNumber: string;
    stripeAccountId: string;
    amountInCents: number;
    currency: string;
  }
): Stripe.Transfer | null {
  for (const st of transfers) {
    const destId = getStripeDestinationId(st.destination);
    const matchDestination = destId === target.stripeAccountId;
    const matchAmount = st.amount === target.amountInCents;
    const matchCurrency = st.currency.toLowerCase() === target.currency.toLowerCase();
    if (!matchDestination || !matchAmount || !matchCurrency) {
      continue;
    }

    const metaId = st.metadata?.transferId;
    const metaNumber = st.metadata?.transferNumber;
    if (metaId) {
      if (metaId === target.id) return st;
      continue;
    }
    if (metaNumber) {
      if (metaNumber === target.transferNumber) return st;
      continue;
    }
    if (!st.transfer_group || st.transfer_group === target.transferNumber) {
      return st;
    }
  }
  return null;
}

export type StripeTransferLookupResult =
  | { found: true; stripeTransfer: Stripe.Transfer }
  | { found: false; authoritativeEmpty: boolean; error?: unknown };

async function scanPaginatedStripeTransfers(
  baseParams: Omit<Stripe.TransferListParams, 'limit' | 'starting_after'>,
  target: {
    id: string;
    transferNumber: string;
    stripeAccountId: string;
    amountInCents: number;
    currency: string;
  },
  matchedById: Map<string, Stripe.Transfer>
): Promise<{
  complete: boolean;
  mismatchDetected: boolean;
  error?: unknown;
}> {
  const seenPageIds = new Set<string>();
  let startingAfter: string | undefined;
  let pageCount = 0;
  let hasMore = true;
  let mismatchDetected = false;

  try {
    while (hasMore && pageCount < TRANSFER_LOOKUP_MAX_PAGES) {
      pageCount += 1;
      const page = await stripe.transfers.list({
        ...baseParams,
        limit: TRANSFER_LOOKUP_PAGE_LIMIT,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });

      const items = page.data || [];
      let advanced = false;

      for (const st of items) {
        if (!st?.id || seenPageIds.has(st.id)) {
          continue;
        }
        seenPageIds.add(st.id);
        advanced = true;

        const explicitUuidOrSameAccountRef =
          st.metadata?.transferId === target.id ||
          ((st.metadata?.transferNumber === target.transferNumber ||
            st.transfer_group === target.transferNumber) &&
            getStripeDestinationId(st.destination) === target.stripeAccountId);

        const fullMatch = findMatchingStripeTransferInList([st], target);
        if (fullMatch) {
          matchedById.set(fullMatch.id, fullMatch);
        } else if (explicitUuidOrSameAccountRef) {
          // A Stripe transfer explicitly tied to this transfer UUID or same organizer destination/group had mismatched attributes.
          mismatchDetected = true;
          emitTransferCriticalAlert({
            transferId: target.id,
            transferNumber: target.transferNumber,
            organizerId: 'system',
            stripeTransferId: st.id,
            code: 'TRANSFER_LOOKUP_ATTRIBUTES_MISMATCH',
            message: `Stripe transfer ${st.id} matched reference for #${target.transferNumber} with mismatched attributes (${st.amount} ${st.currency}).`,
          });
        }
      }

      hasMore = Boolean(page.has_more);
      const lastId = items.length > 0 ? items[items.length - 1]?.id : undefined;
      if (!hasMore || !lastId || !advanced || lastId === startingAfter) {
        if (hasMore && (!lastId || !advanced || lastId === startingAfter)) {
          return { complete: false, mismatchDetected };
        }
        break;
      }
      startingAfter = lastId;
    }

    return {
      complete: !hasMore,
      mismatchDetected,
    };
  } catch (err) {
    return {
      complete: false,
      mismatchDetected,
      error: err,
    };
  }
}

/**
 * Looks up whether Stripe already created a Transfer for a local OrganizerTransfer record.
 * Strictly executed OUTSIDE any PostgreSQL lock or transaction.
 */
export async function lookupStripeTransferForRecord(
  transfer: Pick<
    OrganizerTransfer,
    'id' | 'transferNumber' | 'stripeAccountId' | 'amountInCents' | 'currency' | 'stripeTransferId' | 'createdAt'
  >,
  options?: { includeDestinationScan?: boolean }
): Promise<StripeTransferLookupResult> {
  try {
    if (transfer.stripeTransferId) {
      const retrieved = await stripe.transfers.retrieve(transfer.stripeTransferId);
      if (retrieved && retrieved.id) {
        return { found: true, stripeTransfer: retrieved };
      }
    }

    const matchedById = new Map<string, Stripe.Transfer>();
    const byGroup = await scanPaginatedStripeTransfers(
      { transfer_group: transfer.transferNumber },
      transfer,
      matchedById
    );

    if (matchedById.size === 1 && !byGroup.mismatchDetected && !options?.includeDestinationScan) {
      return { found: true, stripeTransfer: Array.from(matchedById.values())[0] };
    }

    let byDest: { complete: boolean; mismatchDetected: boolean; error?: unknown } | null = null;
    if (options?.includeDestinationScan) {
      const createdAfterSec = Math.max(0, Math.floor(transfer.createdAt.getTime() / 1000) - 300);
      byDest = await scanPaginatedStripeTransfers(
        {
          destination: transfer.stripeAccountId,
          created: { gte: createdAfterSec },
        },
        transfer,
        matchedById
      );
    }

    if (byGroup.mismatchDetected || byDest?.mismatchDetected) {
      return {
        found: false,
        authoritativeEmpty: false,
        error: new Error('Stripe transfer matched reference with mismatched amount, currency, or destination'),
      };
    }

    if (matchedById.size > 1) {
      emitTransferCriticalAlert({
        transferId: transfer.id,
        transferNumber: transfer.transferNumber,
        organizerId: 'system',
        code: 'AMBIGUOUS_MULTIPLE_STRIPE_TRANSFERS',
        message: `Found ${matchedById.size} distinct Stripe transfers matching #${transfer.transferNumber}; manual review required.`,
      });
      return {
        found: false,
        authoritativeEmpty: false,
        error: new Error('Multiple Stripe transfers matched this OrganizerTransfer record'),
      };
    }

    if (matchedById.size === 1) {
      return { found: true, stripeTransfer: Array.from(matchedById.values())[0] };
    }

    const combinedError = byGroup.error ?? byDest?.error;
    if (combinedError) {
      return { found: false, authoritativeEmpty: false, error: combinedError };
    }

    const allScansComplete =
      byGroup.complete && (!options?.includeDestinationScan || Boolean(byDest?.complete));

    return {
      found: false,
      authoritativeEmpty: allScansComplete,
    };
  } catch (err: any) {
    const errCode = String(err?.code || '');
    const errType = String(err?.type || '');
    if (transfer.stripeTransferId && errCode === 'resource_missing' && errType === 'StripeInvalidRequestError') {
      return { found: false, authoritativeEmpty: false, error: err };
    }
    return { found: false, authoritativeEmpty: false, error: err };
  }
}

export interface FinalizeTransferSucceededResult {
  outcome:
    | 'succeeded'
    | 'alreadySucceeded'
    | 'leaseLost'
    | 'conflictAfterFailure'
    | 'amountCurrencyMismatch';
  transfer: OrganizerTransfer | null;
  balance: {
    availableBalanceInCents: number;
    transferredBalanceInCents: number;
    pendingBalanceInCents: number;
    currency: string;
  } | null;
}

/**
 * Shared atomic finalizer for marking an OrganizerTransfer SUCCEEDED and crediting
 * transferredBalanceInCents + TRANSFER_SUCCEEDED ledger entry.
 * Enforces canonical lock ordering: OrganizerTransfer FOR UPDATE -> OrganizerBalance FOR UPDATE.
 */
export async function finalizeTransferSucceededInTx(
  tx: Prisma.TransactionClient,
  params: {
    transferId: string;
    stripeTransfer: Pick<Stripe.Transfer, 'id' | 'amount' | 'currency'>;
    expectedWorkerId?: string;
  }
): Promise<FinalizeTransferSucceededResult> {
  const lockedRows = await tx.$queryRaw<OrganizerTransfer[]>`
    SELECT * FROM "OrganizerTransfer"
    WHERE id = ${params.transferId}
    FOR UPDATE
  `;
  const locked = lockedRows[0];
  if (!locked) {
    return { outcome: 'leaseLost', transfer: null, balance: null };
  }

  if (
    params.expectedWorkerId &&
    locked.reconciliationLockedBy !== params.expectedWorkerId
  ) {
    return { outcome: 'leaseLost', transfer: locked, balance: null };
  }

  if (
    locked.status === TransferStatus.SUCCEEDED ||
    locked.status === TransferStatus.REVERSED
  ) {
    const updated =
      !locked.stripeTransferId && params.stripeTransfer.id
        ? await tx.organizerTransfer.update({
            where: { id: locked.id },
            data: { stripeTransferId: params.stripeTransfer.id },
          })
        : locked;
    const bal = await getOrCreateOrganizerBalance(tx, locked.organizerId, locked.currency);
    return { outcome: 'alreadySucceeded', transfer: updated, balance: bal };
  }

  if (locked.status === TransferStatus.FAILED) {
    emitTransferCriticalAlert({
      transferId: locked.id,
      transferNumber: locked.transferNumber,
      organizerId: locked.organizerId,
      stripeTransferId: params.stripeTransfer.id,
      code: 'TRANSFER_SUCCEEDED_AFTER_FAILED_RESTORE',
      message: `Stripe transfer ${params.stripeTransfer.id} confirmed after transfer #${locked.transferNumber} was already marked FAILED.`,
    });
    return { outcome: 'conflictAfterFailure', transfer: locked, balance: null };
  }

  const stripeCurrency = String(params.stripeTransfer.currency || '').trim().toUpperCase();
  const localCurrency = locked.currency.trim().toUpperCase();
  if (
    params.stripeTransfer.amount !== locked.amountInCents ||
    !stripeCurrency ||
    stripeCurrency !== localCurrency
  ) {
    emitTransferCriticalAlert({
      transferId: locked.id,
      transferNumber: locked.transferNumber,
      organizerId: locked.organizerId,
      stripeTransferId: params.stripeTransfer.id,
      code: 'TRANSFER_AMOUNT_CURRENCY_MISMATCH',
      message: `Stripe transfer ${params.stripeTransfer.id} amount/currency (${params.stripeTransfer.amount} ${stripeCurrency || 'UNKNOWN'}) does not match reserved transfer #${locked.transferNumber} (${locked.amountInCents} ${localCurrency}).`,
    });
    const heldTransfer = await tx.organizerTransfer.update({
      where: { id: locked.id },
      data: {
        reconciliationRequired: true,
        reconciliationLockedBy: null,
        reconciliationLockedUntil: null,
        reconciliationNextAttemptAt: null,
        reconciliationLastErrorCode: 'TRANSFER_AMOUNT_CURRENCY_MISMATCH',
        reconciliationLastErrorMessage: sanitizeTransferDiagnosticMessage(
          `Stripe transfer ${params.stripeTransfer.id} reported ${params.stripeTransfer.amount} ${stripeCurrency || 'UNKNOWN'} instead of ${locked.amountInCents} ${localCurrency}.`
        ),
      },
    });
    const bal = await getOrCreateOrganizerBalance(tx, locked.organizerId, locked.currency);
    return { outcome: 'amountCurrencyMismatch', transfer: heldTransfer, balance: bal };
  }

  const lockedBalance = await getOrCreateOrganizerBalance(tx, locked.organizerId, locked.currency);

  const existingSuccessEntry = await tx.financialLedgerEntry.findFirst({
    where: {
      transferId: locked.id,
      type: LedgerEntryType.TRANSFER_SUCCEEDED,
    },
    select: { id: true },
  });

  const updTransfer = await tx.organizerTransfer.update({
    where: { id: locked.id },
    data: {
      status: TransferStatus.SUCCEEDED,
      stripeTransferId: params.stripeTransfer.id,
      reconciliationRequired: false,
      reconciliationLockedBy: null,
      reconciliationLockedUntil: null,
      reconciliationNextAttemptAt: null,
      reconciliationLastErrorCode: null,
      reconciliationLastErrorMessage: null,
      failureCode: null,
      failureMessage: null,
      succeededAt: locked.succeededAt ?? new Date(),
    },
  });

  let updBalance = lockedBalance;
  if (!existingSuccessEntry) {
    updBalance = await tx.organizerBalance.update({
      where: { userId: locked.organizerId },
      data: {
        transferredBalanceInCents: { increment: locked.amountInCents },
      },
    });

    await tx.financialLedgerEntry.create({
      data: {
        type: LedgerEntryType.TRANSFER_SUCCEEDED,
        balanceType: LedgerBalanceType.TRANSFERRED,
        amountInCents: locked.amountInCents,
        currency: locked.currency.toUpperCase(),
        organizerId: locked.organizerId,
        transferId: updTransfer.id,
        stripeReferenceId: params.stripeTransfer.id,
        description: `Transferred $${(locked.amountInCents / 100).toFixed(2)} to Stripe Express account (${locked.stripeAccountId})`,
        metadata: {
          transferNumber: updTransfer.transferNumber,
          stripeTransferId: params.stripeTransfer.id,
          sourceType: updTransfer.sourceType,
        },
      },
    });
  }

  return { outcome: 'succeeded', transfer: updTransfer, balance: updBalance };
}

export interface FinalizeTransferFailedResult {
  outcome: 'failed' | 'alreadyFailed' | 'alreadySucceeded' | 'leaseLost';
  transfer: OrganizerTransfer | null;
  balance: {
    availableBalanceInCents: number;
    transferredBalanceInCents: number;
    pendingBalanceInCents: number;
    currency: string;
  } | null;
}

/**
 * Shared atomic finalizer for authoritatively failed transfers.
 * Marks status FAILED and restores reserved availableBalanceInCents idempotently.
 * Enforces canonical lock ordering: OrganizerTransfer FOR UPDATE -> OrganizerBalance FOR UPDATE.
 */
export async function finalizeTransferFailedInTx(
  tx: Prisma.TransactionClient,
  params: {
    transferId: string;
    failureCode: string;
    failureMessage: string;
    expectedWorkerId?: string;
  }
): Promise<FinalizeTransferFailedResult> {
  const lockedRows = await tx.$queryRaw<OrganizerTransfer[]>`
    SELECT * FROM "OrganizerTransfer"
    WHERE id = ${params.transferId}
    FOR UPDATE
  `;
  const locked = lockedRows[0];
  if (!locked) {
    return { outcome: 'leaseLost', transfer: null, balance: null };
  }

  if (
    params.expectedWorkerId &&
    locked.reconciliationLockedBy !== params.expectedWorkerId
  ) {
    return { outcome: 'leaseLost', transfer: locked, balance: null };
  }

  if (locked.status === TransferStatus.FAILED) {
    const bal = await getOrCreateOrganizerBalance(tx, locked.organizerId, locked.currency);
    return { outcome: 'alreadyFailed', transfer: locked, balance: bal };
  }

  if (locked.status !== TransferStatus.PENDING) {
    const bal = await getOrCreateOrganizerBalance(tx, locked.organizerId, locked.currency);
    return { outcome: 'alreadySucceeded', transfer: locked, balance: bal };
  }

  const lockedBalance = await getOrCreateOrganizerBalance(tx, locked.organizerId, locked.currency);

  const existingFailedEntry = await tx.financialLedgerEntry.findFirst({
    where: {
      transferId: locked.id,
      type: LedgerEntryType.TRANSFER_FAILED,
    },
    select: { id: true },
  });

  const safeCode = params.failureCode.slice(0, 120);
  const safeMsg = sanitizeTransferDiagnosticMessage(params.failureMessage);

  const updTransfer = await tx.organizerTransfer.update({
    where: { id: locked.id },
    data: {
      status: TransferStatus.FAILED,
      reconciliationRequired: false,
      reconciliationLockedBy: null,
      reconciliationLockedUntil: null,
      reconciliationNextAttemptAt: null,
      reconciliationLastErrorCode: safeCode,
      reconciliationLastErrorMessage: safeMsg,
      failureCode: safeCode,
      failureMessage: safeMsg,
      failedAt: locked.failedAt ?? new Date(),
    },
  });

  let updBalance = lockedBalance;
  if (!existingFailedEntry) {
    updBalance = await tx.organizerBalance.update({
      where: { userId: locked.organizerId },
      data: {
        availableBalanceInCents: { increment: locked.amountInCents },
      },
    });

    await tx.financialLedgerEntry.create({
      data: {
        type: LedgerEntryType.TRANSFER_FAILED,
        balanceType: LedgerBalanceType.AVAILABLE,
        amountInCents: locked.amountInCents,
        currency: locked.currency.toUpperCase(),
        organizerId: locked.organizerId,
        transferId: updTransfer.id,
        description: `Transfer failed (${safeCode}); available balance restored for transfer #${locked.transferNumber}`,
        metadata: {
          failureCode: safeCode,
          failureMessage: safeMsg,
        },
      },
    });
  }

  return { outcome: 'failed', transfer: updTransfer, balance: updBalance };
}

async function releaseTransferReconciliationLease(params: {
  transferId: string;
  workerId: string;
  nextAttemptAt: Date | null;
  restoreAttemptCount?: boolean;
  currentAttempts: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  reconciliationRequired?: boolean;
}): Promise<boolean> {
  const safeMsg =
    params.errorMessage !== undefined && params.errorMessage !== null
      ? sanitizeTransferDiagnosticMessage(params.errorMessage)
      : undefined;

  const updated = await prisma.organizerTransfer.updateMany({
    where: {
      id: params.transferId,
      status: TransferStatus.PENDING,
      reconciliationLockedBy: params.workerId,
    },
    data: {
      reconciliationRequired: params.reconciliationRequired ?? true,
      reconciliationLockedBy: null,
      reconciliationLockedUntil: null,
      reconciliationNextAttemptAt: params.nextAttemptAt,
      ...(params.restoreAttemptCount
        ? { reconciliationAttempts: Math.max(0, params.currentAttempts - 1) }
        : {}),
      ...(params.errorCode !== undefined ? { reconciliationLastErrorCode: params.errorCode } : {}),
      ...(safeMsg !== undefined ? { reconciliationLastErrorMessage: safeMsg } : {}),
    },
  });

  return updated.count > 0;
}

export async function claimPendingTransfersForReconciliation(params: {
  workerId: string;
  batchSize?: number;
  leaseMs?: number;
  now?: Date;
  stalePendingThresholdMs?: number;
  maxAttempts?: number;
  includeUnflaggedPending?: boolean;
}): Promise<OrganizerTransfer[]> {
  const batchSize = params.batchSize ?? TRANSFER_RECONCILIATION_BATCH_SIZE;
  const leaseMs = params.leaseMs ?? TRANSFER_RECONCILIATION_LEASE_MS;
  const now = params.now ?? new Date();
  const staleCutoff = new Date(
    now.getTime() - (params.stalePendingThresholdMs ?? TRANSFER_STALE_PENDING_THRESHOLD_MS)
  );
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const maxAttempts = params.maxAttempts ?? TRANSFER_RECONCILIATION_MAX_ATTEMPTS;

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.$queryRaw<OrganizerTransfer[]>`
      WITH candidate_transfers AS (
        SELECT id
        FROM "OrganizerTransfer"
        WHERE status = 'PENDING'::"TransferStatus"
          AND "reconciliationAttempts" < ${maxAttempts}
          AND (
            "reconciliationRequired" = true
            ${
              params.includeUnflaggedPending
                ? Prisma.sql`OR "updatedAt" <= ${staleCutoff}`
                : Prisma.sql`OR ("reconciliationRequired" = false AND "updatedAt" <= ${staleCutoff})`
            }
          )
          AND (
            "reconciliationNextAttemptAt" IS NULL
            OR "reconciliationNextAttemptAt" <= ${now}
          )
          AND (
            "reconciliationLockedUntil" IS NULL
            OR "reconciliationLockedUntil" <= ${now}
          )
        ORDER BY "reconciliationNextAttemptAt" ASC NULLS FIRST, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchSize}
      )
      UPDATE "OrganizerTransfer" ot
      SET
        "reconciliationRequired" = true,
        "reconciliationLockedBy" = ${params.workerId},
        "reconciliationLockedUntil" = ${leaseUntil},
        "reconciliationLastAttemptAt" = ${now},
        "reconciliationAttempts" = ot."reconciliationAttempts" + 1,
        "updatedAt" = ${now}
      FROM candidate_transfers ct
      WHERE ot.id = ct.id
      RETURNING ot.*
    `;

    return claimed;
  });
}

export async function processClaimedTransferReconciliation(
  transfer: OrganizerTransfer,
  workerId: string,
  options?: {
    now?: Date;
    expiryGraceMs?: number;
    maxAttempts?: number;
    randomFn?: () => number;
  }
): Promise<
  | 'succeeded'
  | 'failedRestored'
  | 'retried'
  | 'stillUncertain'
  | 'alreadyFinalized'
  | 'skipped'
  | 'leaseLost'
  | 'manualReviewRequired'
> {
  const effectiveStripeKey = process.env.STRIPE_SECRET_KEY ?? env.STRIPE_SECRET_KEY;
  if (!effectiveStripeKey || effectiveStripeKey === 'sk_test_placeholder') {
    const released = await releaseTransferReconciliationLease({
      transferId: transfer.id,
      workerId,
      nextAttemptAt: new Date(Date.now() + 5 * 60_000),
      restoreAttemptCount: true,
      currentAttempts: transfer.reconciliationAttempts,
    });
    return released ? 'skipped' : 'leaseLost';
  }

  const now = options?.now ?? new Date();
  const expiryGraceMs = options?.expiryGraceMs ?? STRIPE_IDEMPOTENCY_EXPIRY_GRACE_MS;
  const maxAttempts = options?.maxAttempts ?? TRANSFER_RECONCILIATION_MAX_ATTEMPTS;

  // Compute the conservative restoration clock from the latest external create-attempt timestamp.
  // If lastCreateAttemptAt is null (unknown create-attempt time), we MUST fail closed before any auto-restoration.
  const hasKnownAttemptTime = Boolean(
    transfer.lastCreateAttemptAt && Number.isFinite(transfer.lastCreateAttemptAt.getTime())
  );
  const anchorTimeMs = hasKnownAttemptTime
    ? Math.max(transfer.createdAt.getTime(), transfer.lastCreateAttemptAt!.getTime())
    : null;
  const ageMs = anchorTimeMs !== null ? now.getTime() - anchorTimeMs : 0;
  const pastIdempotencyWindow = anchorTimeMs !== null && ageMs >= expiryGraceMs;

  // Read Stripe OUTSIDE all database transactions/locks
  const lookup = await lookupStripeTransferForRecord(transfer, {
    includeDestinationScan: pastIdempotencyWindow,
  });

  if (lookup.found) {
    const res = await prisma.$transaction((tx) =>
      finalizeTransferSucceededInTx(tx, {
        transferId: transfer.id,
        stripeTransfer: lookup.stripeTransfer,
        expectedWorkerId: workerId,
      })
    );
    if (res.outcome === 'leaseLost') return 'leaseLost';
    if (res.outcome === 'amountCurrencyMismatch') return 'manualReviewRequired';
    if (res.outcome === 'succeeded') return 'succeeded';
    return 'alreadyFinalized';
  }

  // If the latest create-attempt timestamp is unknown, fail closed and hold the reservation for manual reconciliation.
  if (anchorTimeMs === null) {
    await releaseTransferReconciliationLease({
      transferId: transfer.id,
      workerId,
      nextAttemptAt: null,
      currentAttempts: transfer.reconciliationAttempts,
      errorCode: 'TRANSFER_ATTEMPT_TIMESTAMP_UNKNOWN',
      errorMessage:
        'Latest Stripe create-attempt timestamp is unknown; retaining reservation for manual reconciliation.',
      reconciliationRequired: true,
    });
    emitTransferCriticalAlert({
      transferId: transfer.id,
      transferNumber: transfer.transferNumber,
      organizerId: transfer.organizerId,
      code: 'TRANSFER_ATTEMPT_TIMESTAMP_UNKNOWN',
      message: `Transfer #${transfer.transferNumber} lacks lastCreateAttemptAt; refusing automatic restoration.`,
    });
    return 'manualReviewRequired';
  }

  // If Stripe lookup threw a transient/API error, keep PENDING & schedule backoff; never restore funds blindly
  if (lookup.error) {
    const classified = classifyTransferCreateError(lookup.error);
    if (transfer.reconciliationAttempts >= maxAttempts) {
      await releaseTransferReconciliationLease({
        transferId: transfer.id,
        workerId,
        nextAttemptAt: null,
        currentAttempts: transfer.reconciliationAttempts,
        errorCode: classified.code,
        errorMessage: classified.safeMessage,
        reconciliationRequired: true,
      });
      emitTransferCriticalAlert({
        transferId: transfer.id,
        transferNumber: transfer.transferNumber,
        organizerId: transfer.organizerId,
        code: 'MAX_TRANSFER_RECONCILIATION_ATTEMPTS_WITH_API_ERRORS',
        message: `Transfer #${transfer.transferNumber} exhausted reconciliation retries while Stripe API lookup kept failing (${classified.code}).`,
      });
      return 'manualReviewRequired';
    }

    const delayMs = computeNextTransferRetryDelayMs(
      transfer.reconciliationAttempts,
      options?.randomFn
    );
    const released = await releaseTransferReconciliationLease({
      transferId: transfer.id,
      workerId,
      nextAttemptAt: new Date(now.getTime() + delayMs),
      currentAttempts: transfer.reconciliationAttempts,
      errorCode: classified.code,
      errorMessage: classified.safeMessage,
      reconciliationRequired: true,
    });
    return released ? 'retried' : 'leaseLost';
  }

  // Stripe list lookup returned empty with NO API error:
  // Inside Stripe's idempotency retention + webhook propagation window (< 24h15m since last create attempt),
  // NEVER assume no transfer was created. Keep PENDING and schedule another check.
  if (!pastIdempotencyWindow || !lookup.authoritativeEmpty) {
    if (transfer.reconciliationAttempts >= maxAttempts && !pastIdempotencyWindow) {
      // Schedule next attempt at idempotency expiry window rather than prematurely failing or abandoning
      const released = await releaseTransferReconciliationLease({
        transferId: transfer.id,
        workerId,
        nextAttemptAt: new Date(anchorTimeMs + expiryGraceMs),
        restoreAttemptCount: true,
        currentAttempts: transfer.reconciliationAttempts,
        errorCode: 'AWAITING_IDEMPOTENCY_WINDOW_EXPIRY',
        errorMessage:
          'Stripe transfer not yet visible; holding balance until idempotency retention and webhook window expires.',
        reconciliationRequired: true,
      });
      return released ? 'stillUncertain' : 'leaseLost';
    }

    if (transfer.reconciliationAttempts >= maxAttempts && pastIdempotencyWindow && !lookup.authoritativeEmpty) {
      await releaseTransferReconciliationLease({
        transferId: transfer.id,
        workerId,
        nextAttemptAt: null,
        currentAttempts: transfer.reconciliationAttempts,
        errorCode: 'NON_AUTHORITATIVE_EMPTY_LIST',
        errorMessage:
          'Stripe paginated results incomplete after idempotency expiry; holding for manual review.',
        reconciliationRequired: true,
      });
      emitTransferCriticalAlert({
        transferId: transfer.id,
        transferNumber: transfer.transferNumber,
        organizerId: transfer.organizerId,
        code: 'NON_AUTHORITATIVE_EMPTY_LIST',
        message: `Transfer #${transfer.transferNumber} had paginated empty list after 24h+ window; requires manual audit.`,
      });
      return 'manualReviewRequired';
    }

    const delayMs = computeNextTransferRetryDelayMs(
      transfer.reconciliationAttempts,
      options?.randomFn
    );
    const nextAttempt = new Date(
      Math.min(now.getTime() + delayMs, anchorTimeMs + expiryGraceMs)
    );
    const released = await releaseTransferReconciliationLease({
      transferId: transfer.id,
      workerId,
      nextAttemptAt: nextAttempt,
      currentAttempts: transfer.reconciliationAttempts,
      errorCode: 'PENDING_STRIPE_VERIFICATION',
      errorMessage: 'No Stripe transfer observed yet; scheduled follow-up reconciliation.',
      reconciliationRequired: true,
    });
    return released ? 'stillUncertain' : 'leaseLost';
  }

  // Authoritatively confirmed empty AFTER Stripe's 24h idempotency window + 15m grace buffer:
  // Safe to mark FAILED and restore reserved balance.
  const failRes = await prisma.$transaction((tx) =>
    finalizeTransferFailedInTx(tx, {
      transferId: transfer.id,
      failureCode: 'STRIPE_TRANSFER_NOT_CREATED_EXPIRED',
      failureMessage:
        'Verified no Stripe transfer exists after idempotency retention window elapsed; reserved balance restored.',
      expectedWorkerId: workerId,
    })
  );

  if (failRes.outcome === 'leaseLost') return 'leaseLost';
  if (failRes.outcome === 'failed') return 'failedRestored';
  return 'alreadyFinalized';
}

export async function runTransferReconciliationPass(params?: {
  workerId?: string;
  batchSize?: number;
  leaseMs?: number;
  now?: Date;
  stalePendingThresholdMs?: number;
  expiryGraceMs?: number;
  maxAttempts?: number;
  randomFn?: () => number;
}): Promise<TransferReconciliationPassStats> {
  const workerId = params?.workerId || generateTransferWorkerId();
  const claimed = await claimPendingTransfersForReconciliation({
    workerId,
    batchSize: params?.batchSize,
    leaseMs: params?.leaseMs,
    now: params?.now,
    stalePendingThresholdMs: params?.stalePendingThresholdMs,
    maxAttempts: params?.maxAttempts,
  });

  const stats: TransferReconciliationPassStats = {
    claimed: claimed.length,
    succeeded: 0,
    failedRestored: 0,
    retried: 0,
    stillUncertain: 0,
    alreadyFinalized: 0,
    skipped: 0,
    leaseLost: 0,
    manualReviewRequired: 0,
  };

  for (const transfer of claimed) {
    const outcome = await processClaimedTransferReconciliation(transfer, workerId, {
      now: params?.now,
      expiryGraceMs: params?.expiryGraceMs,
      maxAttempts: params?.maxAttempts,
      randomFn: params?.randomFn,
    });
    stats[outcome] += 1;
  }

  return stats;
}
