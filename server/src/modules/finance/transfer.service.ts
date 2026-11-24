import crypto from 'crypto';
import {
  LedgerBalanceType,
  LedgerEntryType,
  OrganizerTransfer,
  Prisma,
  TransferSourceType,
  TransferStatus,
} from '@prisma/client';
import { nanoid } from 'nanoid';
import Stripe from 'stripe';
import { prisma } from '../../db/prisma.js';
import { stripe } from '../../lib/stripe.js';
import { env } from '../../config/env.js';
import { BadRequestError, ServiceUnavailableError } from '../../utils/errors.js';
import { getOrCreateOrganizerBalance } from './ledger.service.js';
import {
  classifyStripeError,
  classifyTransferCreateError,
  logStripeDiagnostic,
} from './stripeError.js';
import {
  DEFAULT_PLATFORM_CURRENCY,
  isStripeExpressCountrySupported,
  isSupportedPlatformCurrency,
} from './stripeCountries.js';
import {
  finalizeTransferFailedInTx,
  finalizeTransferSucceededInTx,
  lookupStripeTransferForRecord,
  sanitizeTransferDiagnosticMessage,
  STRIPE_IDEMPOTENCY_RETRY_WINDOW_MS,
  TRANSFER_RECONCILIATION_LEASE_MS,
} from './transferReconciliation.service.js';

export interface RequestWithdrawalInput {
  userId: string;
  amountInCents: number;
  idempotencyKey?: string;
  initiatedByUserId?: string;
  isAdmin?: boolean;
  notes?: string;
}

export interface OrganizerTransferResult {
  transferId: string;
  transferNumber: string;
  stripeTransferId: string | null;
  amountInCents: number;
  reversedAmountInCents: number;
  currency: string;
  status: TransferStatus;
  reconciliationRequired: boolean;
  retryable?: boolean;
  idempotencyKey?: string;
  message?: string;
  sourceType: TransferSourceType;
  remainingAvailableInCents: number;
  transferredInCents: number;
  createdAt: string;
}

function buildTransferResult(
  transfer: OrganizerTransfer,
  balance: {
    availableBalanceInCents: number;
    transferredBalanceInCents: number;
  } | null,
  extras?: {
    retryable?: boolean;
    clientIdempotencyKey?: string;
    message?: string;
  }
): OrganizerTransferResult {
  return {
    transferId: transfer.id,
    transferNumber: transfer.transferNumber,
    stripeTransferId: transfer.stripeTransferId,
    amountInCents: transfer.amountInCents,
    reversedAmountInCents: transfer.reversedAmountInCents ?? 0,
    currency: transfer.currency.toUpperCase(),
    status: transfer.status,
    reconciliationRequired: Boolean(transfer.reconciliationRequired),
    ...(extras?.retryable !== undefined ? { retryable: extras.retryable } : {}),
    ...(extras?.clientIdempotencyKey ? { idempotencyKey: extras.clientIdempotencyKey } : {}),
    ...(extras?.message ? { message: extras.message } : {}),
    sourceType: transfer.sourceType,
    remainingAvailableInCents: balance?.availableBalanceInCents || 0,
    transferredInCents: balance?.transferredBalanceInCents || 0,
    createdAt: transfer.createdAt.toISOString(),
  };
}

function extractClientKeyFromFullKey(userId: string, fullKey: string): string {
  const prefix = `tx_${userId}_`;
  return fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : fullKey;
}

/**
 * Initiates a platform-to-connected-account Stripe Transfer for an organizer's available balance.
 * Uses durable idempotency keys, FOR UPDATE row-locking, ambiguous-error reconciliation, and
 * deferred recovery to prevent duplicate transfers or unsafe balance restoration.
 */
export async function executeWithdrawal(
  input: RequestWithdrawalInput
): Promise<OrganizerTransferResult> {
  const { userId, amountInCents, idempotencyKey, initiatedByUserId, isAdmin = false, notes } = input;

  if (!Number.isInteger(amountInCents) || amountInCents <= 0) {
    throw new BadRequestError('Withdrawal amount must be a positive integer in cents.', 'INVALID_WITHDRAWAL_AMOUNT');
  }

  if (amountInCents < 100) {
    throw new BadRequestError('Minimum withdrawal amount is $1.00 USD.', 'WITHDRAWAL_BELOW_MINIMUM');
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      stripeAccountId: true,
      stripeAccountCountry: true,
      role: true,
    },
  });

  if (!user) {
    throw new BadRequestError('Organizer not found.', 'USER_NOT_FOUND');
  }

  if (!user.stripeAccountId) {
    throw new BadRequestError(
      'No connected Stripe Express account found. Please connect your bank account before requesting a withdrawal.',
      'NO_CONNECTED_ACCOUNT'
    );
  }
  const connectedStripeAccountId = user.stripeAccountId;

  const effectiveStripeKey = process.env.STRIPE_SECRET_KEY ?? env.STRIPE_SECRET_KEY;
  if (!effectiveStripeKey || effectiveStripeKey === 'sk_test_placeholder') {
    throw new ServiceUnavailableError(
      'Withdrawals are temporarily unavailable while platform Stripe configuration is being completed.',
      'STRIPE_CONFIGURATION_UNAVAILABLE'
    );
  }

  let account: Stripe.Account;
  try {
    account = await stripe.accounts.retrieve(user.stripeAccountId);
  } catch (error: any) {
    logStripeDiagnostic('executeWithdrawal:accounts.retrieve', error, {
      userId,
      stripeAccountId: user.stripeAccountId,
    });
    const classified = classifyStripeError(error);
    if (classified.category === 'invalid_or_inaccessible') {
      throw new BadRequestError(
        'Your connected Stripe account is no longer accessible. Please reconnect your account.',
        'INVALID_CONNECTED_ACCOUNT'
      );
    }
    throw new ServiceUnavailableError(classified.safeMessage, classified.code);
  }

  const effectiveCountry = account.country || user.stripeAccountCountry || null;
  if (!effectiveCountry || !isStripeExpressCountrySupported(effectiveCountry)) {
    throw new BadRequestError(
      effectiveCountry
        ? `Withdrawals are currently restricted to supported US Stripe Express accounts (account country: ${effectiveCountry}).`
        : 'Connected Stripe Express account country is missing. Only verified US accounts are supported for withdrawals.',
      'UNSUPPORTED_ACCOUNT_COUNTRY'
    );
  }

  if (!account.default_currency || !isSupportedPlatformCurrency(account.default_currency)) {
    throw new BadRequestError(
      account.default_currency
        ? `Connected Stripe account default currency (${account.default_currency.toUpperCase()}) is incompatible with USD withdrawals.`
        : 'Connected Stripe account default currency is missing. USD settlement is required for withdrawals.',
      'CURRENCY_MISMATCH'
    );
  }

  const transfersActive = account.capabilities?.transfers === 'active';
  const payoutsEnabled = Boolean(account.payouts_enabled);
  const disabledReason = account.requirements?.disabled_reason;
  const pastDue = account.requirements?.past_due || [];

  if (!transfersActive || disabledReason || pastDue.length > 0 || !payoutsEnabled) {
    let safeReason = 'Your Stripe Express account is not yet fully enabled to receive withdrawals.';
    let errorCode = 'ACCOUNT_NOT_READY_FOR_TRANSFERS';
    if (disabledReason) {
      safeReason = `Transfers are disabled by Stripe: ${disabledReason}. Please update your account details in the Stripe dashboard.`;
    } else if (pastDue.length > 0) {
      safeReason =
        'Your Stripe account has past-due verification requirements. Please complete identity or bank verification in the Stripe dashboard.';
    } else if (!transfersActive) {
      safeReason =
        'Your Stripe account transfer capability is pending activation by Stripe. Please complete your Stripe onboarding.';
    } else if (!payoutsEnabled) {
      safeReason =
        'Your connected Stripe Express account must have external bank payouts enabled before you can withdraw funds.';
      errorCode = 'PAYOUTS_NOT_ENABLED';
    }
    throw new BadRequestError(safeReason, errorCode);
  }

  const normalizedClientKey = idempotencyKey?.trim();
  const clientKey = normalizedClientKey || `withdr_${nanoid(20)}`;
  const fullIdempotencyKey = `tx_${userId}_${clientKey}`;

  async function resolveExistingTransferRecord(
    existingTransfer: OrganizerTransfer
  ): Promise<OrganizerTransferResult> {
    if (existingTransfer.amountInCents !== amountInCents) {
      throw new BadRequestError(
        'This idempotency key has already been used for a different withdrawal amount. Start a new withdrawal request.',
        'IDEMPOTENCY_KEY_CONFLICT'
      );
    }

    if (
      existingTransfer.status === TransferStatus.SUCCEEDED ||
      existingTransfer.status === TransferStatus.REVERSED
    ) {
      const bal = await prisma.organizerBalance.findUnique({ where: { userId } });
      return buildTransferResult(existingTransfer, bal, {
        clientIdempotencyKey: extractClientKeyFromFullKey(userId, existingTransfer.idempotencyKey),
      });
    }

    if (existingTransfer.status === TransferStatus.FAILED) {
      throw new BadRequestError(
        existingTransfer.failureMessage ||
          'This previous withdrawal attempt failed permanently. Initiate a new withdrawal request to try again.',
        'TRANSFER_ALREADY_FAILED'
      );
    }

    // Status is PENDING (either concurrent in-flight or ambiguous reconciliationRequired).
    // Step 1: Perform read-only Stripe verification outside DB locks.
    const lookup = await lookupStripeTransferForRecord(existingTransfer);
    if (lookup.found) {
      const finalized = await prisma.$transaction((tx) =>
        finalizeTransferSucceededInTx(tx, {
          transferId: existingTransfer.id,
          stripeTransfer: lookup.stripeTransfer,
        })
      );

      if (finalized.outcome === 'amountCurrencyMismatch') {
        throw new ServiceUnavailableError(
          'Stripe transfer details mismatched the reserved withdrawal. Held for manual reconciliation.',
          'TRANSFER_AMOUNT_CURRENCY_MISMATCH'
        );
      }

      if (finalized.transfer) {
        return buildTransferResult(finalized.transfer, finalized.balance, {
          clientIdempotencyKey: extractClientKeyFromFullKey(userId, existingTransfer.idempotencyKey),
        });
      }
    }

    // Step 2: If marked reconciliationRequired and still inside Stripe's safe idempotency window,
    // allow a single leased retry with the exact same Stripe idempotency key.
    const ageMs = Date.now() - existingTransfer.createdAt.getTime();
    if (
      existingTransfer.reconciliationRequired &&
      ageMs < STRIPE_IDEMPOTENCY_RETRY_WINDOW_MS &&
      existingTransfer.stripeAccountId === connectedStripeAccountId
    ) {
      const retryWorkerId = `retry_${crypto.randomBytes(6).toString('hex')}`;
      const now = new Date();
      const leaseUntil = new Date(now.getTime() + TRANSFER_RECONCILIATION_LEASE_MS);

      const claimed = await prisma.organizerTransfer.updateMany({
        where: {
          id: existingTransfer.id,
          status: TransferStatus.PENDING,
          OR: [{ reconciliationLockedUntil: null }, { reconciliationLockedUntil: { lte: now } }],
        },
        data: {
          reconciliationLockedBy: retryWorkerId,
          reconciliationLockedUntil: leaseUntil,
          reconciliationLastAttemptAt: now,
          reconciliationAttempts: { increment: 1 },
        },
      });

      if (claimed.count > 0) {
        try {
          // Persist create-attempt timestamp BEFORE the Stripe API call ONLY while still holding the active lease.
          const attemptNow = new Date();
          const stamped = await prisma.organizerTransfer.updateMany({
            where: {
              id: existingTransfer.id,
              status: TransferStatus.PENDING,
              reconciliationLockedBy: retryWorkerId,
              reconciliationLockedUntil: { gt: attemptNow },
            },
            data: { lastCreateAttemptAt: attemptNow },
          });

          if (stamped.count === 0) {
            const [latestTransfer, bal] = await Promise.all([
              prisma.organizerTransfer.findUniqueOrThrow({ where: { id: existingTransfer.id } }),
              prisma.organizerBalance.findUnique({ where: { userId } }),
            ]);
            if (
              latestTransfer.status === TransferStatus.SUCCEEDED ||
              latestTransfer.status === TransferStatus.REVERSED
            ) {
              return buildTransferResult(latestTransfer, bal, {
                retryable: false,
                clientIdempotencyKey: extractClientKeyFromFullKey(userId, existingTransfer.idempotencyKey),
              });
            }
            if (latestTransfer.status === TransferStatus.FAILED) {
              throw new BadRequestError(
                latestTransfer.failureMessage ||
                  'This previous withdrawal attempt failed permanently. Initiate a new withdrawal request to try again.',
                'TRANSFER_ALREADY_FAILED'
              );
            }
            const ageAfterLeaseLossMs = Date.now() - latestTransfer.createdAt.getTime();
            const retryableAfterLeaseLoss =
              Boolean(latestTransfer.reconciliationRequired) &&
              ageAfterLeaseLossMs < STRIPE_IDEMPOTENCY_RETRY_WINDOW_MS;
            return buildTransferResult(latestTransfer, bal, {
              retryable: retryableAfterLeaseLoss,
              clientIdempotencyKey: extractClientKeyFromFullKey(userId, existingTransfer.idempotencyKey),
              message: retryableAfterLeaseLoss
                ? 'This withdrawal is awaiting Stripe confirmation. You can safely retry with the same reference or wait for automatic reconciliation.'
                : 'This withdrawal is awaiting final Stripe verification before funds can be released or confirmed.',
            });
          }

          const retriedTransfer = await stripe.transfers.create(
            {
              amount: existingTransfer.amountInCents,
              currency: existingTransfer.currency.toLowerCase(),
              destination: existingTransfer.stripeAccountId,
              transfer_group: existingTransfer.transferNumber,
              metadata: {
                organizerId: userId,
                transferId: existingTransfer.id,
                transferNumber: existingTransfer.transferNumber,
                initiatedByUserId: existingTransfer.initiatedByUserId,
                sourceType: existingTransfer.sourceType,
                notes: notes || '',
              },
            },
            { idempotencyKey: `stripe_${existingTransfer.idempotencyKey}` }
          );

          const finalized = await prisma.$transaction((tx) =>
            finalizeTransferSucceededInTx(tx, {
              transferId: existingTransfer.id,
              stripeTransfer: retriedTransfer,
              expectedWorkerId: retryWorkerId,
            })
          );

          if (finalized.outcome === 'amountCurrencyMismatch') {
            throw new ServiceUnavailableError(
              'Stripe transfer details mismatched the reserved withdrawal. Held for manual reconciliation.',
              'TRANSFER_AMOUNT_CURRENCY_MISMATCH'
            );
          }

          if (finalized.outcome === 'leaseLost') {
            const latest = await prisma.organizerTransfer.findUniqueOrThrow({
              where: { id: existingTransfer.id },
            });
            const bal = await prisma.organizerBalance.findUnique({ where: { userId } });
            return buildTransferResult(latest, bal, {
              retryable: latest.status === TransferStatus.PENDING && Boolean(latest.reconciliationRequired),
              clientIdempotencyKey: extractClientKeyFromFullKey(userId, latest.idempotencyKey),
            });
          }

          return buildTransferResult(finalized.transfer!, finalized.balance, {
            retryable: false,
            clientIdempotencyKey: extractClientKeyFromFullKey(userId, existingTransfer.idempotencyKey),
          });
        } catch (retryErr: any) {
          if (retryErr instanceof ServiceUnavailableError && retryErr.code === 'TRANSFER_AMOUNT_CURRENCY_MISMATCH') {
            throw retryErr;
          }
          if (retryErr instanceof BadRequestError && retryErr.code === 'TRANSFER_ALREADY_FAILED') {
            throw retryErr;
          }
          const classified = classifyTransferCreateError(retryErr);
          if (classified.disposition === 'CONFIRMED_FAILURE') {
            const failOutcome = await prisma.$transaction((tx) =>
              finalizeTransferFailedInTx(tx, {
                transferId: existingTransfer.id,
                failureCode: classified.code,
                failureMessage: retryErr?.message ? String(retryErr.message) : classified.safeMessage,
                expectedWorkerId: retryWorkerId,
              })
            );
            if (failOutcome.outcome === 'leaseLost' || failOutcome.outcome === 'alreadySucceeded') {
              const [latestTransfer, bal] = await Promise.all([
                prisma.organizerTransfer.findUniqueOrThrow({ where: { id: existingTransfer.id } }),
                prisma.organizerBalance.findUnique({ where: { userId } }),
              ]);
              if (
                latestTransfer.status === TransferStatus.SUCCEEDED ||
                latestTransfer.status === TransferStatus.REVERSED
              ) {
                return buildTransferResult(latestTransfer, bal, {
                  retryable: false,
                  clientIdempotencyKey: extractClientKeyFromFullKey(userId, existingTransfer.idempotencyKey),
                });
              }
            }
            throw new BadRequestError(classified.safeMessage, 'TRANSFER_EXECUTION_FAILED');
          }

          const nextAttemptAt = new Date(Date.now() + 30_000);
          await prisma.organizerTransfer.updateMany({
            where: {
              id: existingTransfer.id,
              status: TransferStatus.PENDING,
              reconciliationLockedBy: retryWorkerId,
            },
            data: {
              reconciliationRequired: true,
              reconciliationLockedBy: null,
              reconciliationLockedUntil: null,
              reconciliationNextAttemptAt: nextAttemptAt,
              reconciliationLastErrorCode: classified.code,
              reconciliationLastErrorMessage: sanitizeTransferDiagnosticMessage(retryErr),
            },
          });

          const [latestTransfer, bal] = await Promise.all([
            prisma.organizerTransfer.findUniqueOrThrow({ where: { id: existingTransfer.id } }),
            prisma.organizerBalance.findUnique({ where: { userId } }),
          ]);

          if (
            latestTransfer.status === TransferStatus.SUCCEEDED ||
            latestTransfer.status === TransferStatus.REVERSED
          ) {
            return buildTransferResult(latestTransfer, bal, {
              retryable: false,
              clientIdempotencyKey: extractClientKeyFromFullKey(userId, existingTransfer.idempotencyKey),
            });
          }

          if (latestTransfer.status === TransferStatus.FAILED) {
            throw new BadRequestError(
              latestTransfer.failureMessage ||
                'Failed to complete transfer to your Stripe Express account. No funds were deducted.',
              'TRANSFER_EXECUTION_FAILED'
            );
          }

          const stillRetryable =
            Boolean(latestTransfer.reconciliationRequired) &&
            Date.now() - latestTransfer.createdAt.getTime() < STRIPE_IDEMPOTENCY_RETRY_WINDOW_MS;

          return buildTransferResult(latestTransfer, bal, {
            retryable: stillRetryable,
            clientIdempotencyKey: extractClientKeyFromFullKey(userId, existingTransfer.idempotencyKey),
            message: classified.safeMessage,
          });
        }
      }
    }

    if (existingTransfer.reconciliationRequired) {
      const [latestTransfer, bal] = await Promise.all([
        prisma.organizerTransfer.findUniqueOrThrow({ where: { id: existingTransfer.id } }),
        prisma.organizerBalance.findUnique({ where: { userId } }),
      ]);
      if (
        latestTransfer.status === TransferStatus.SUCCEEDED ||
        latestTransfer.status === TransferStatus.REVERSED
      ) {
        return buildTransferResult(latestTransfer, bal, {
          retryable: false,
          clientIdempotencyKey: extractClientKeyFromFullKey(userId, existingTransfer.idempotencyKey),
        });
      }
      if (latestTransfer.status === TransferStatus.FAILED) {
        throw new BadRequestError(
          latestTransfer.failureMessage ||
            'This previous withdrawal attempt failed permanently. Initiate a new withdrawal request to try again.',
          'TRANSFER_ALREADY_FAILED'
        );
      }
      const insideWindow =
        Boolean(latestTransfer.reconciliationRequired) &&
        Date.now() - latestTransfer.createdAt.getTime() < STRIPE_IDEMPOTENCY_RETRY_WINDOW_MS;
      return buildTransferResult(latestTransfer, bal, {
        retryable: insideWindow,
        clientIdempotencyKey: extractClientKeyFromFullKey(userId, existingTransfer.idempotencyKey),
        message: insideWindow
          ? 'This withdrawal is awaiting Stripe confirmation. You can safely retry with the same reference or wait for automatic reconciliation.'
          : 'This withdrawal is awaiting final Stripe verification before funds can be released or confirmed.',
      });
    }

    throw new BadRequestError(
      'A transfer with this reference is already in progress. Please wait a moment.',
      'DUPLICATE_TRANSFER_IN_PROGRESS'
    );
  }

  const existingTransfer = await prisma.organizerTransfer.findUnique({
    where: { idempotencyKey: fullIdempotencyKey },
  });

  if (existingTransfer) {
    return resolveExistingTransferRecord(existingTransfer);
  }

  let transferRecord: OrganizerTransfer;
  try {
    transferRecord = await prisma.$transaction(
      async (tx) => {
        await getOrCreateOrganizerBalance(tx, userId, DEFAULT_PLATFORM_CURRENCY);

        // Lock balance row to prevent concurrent race conditions on withdrawals
        const [lockedBalance] = await tx.$queryRaw<
          Array<{
            id: string;
            userId: string;
            currency: string;
            availableBalanceInCents: number;
            pendingBalanceInCents: number;
            transferredBalanceInCents: number;
          }>
        >`SELECT id, "userId", currency, "availableBalanceInCents", "pendingBalanceInCents", "transferredBalanceInCents"
          FROM "OrganizerBalance"
          WHERE "userId" = ${userId}
          FOR UPDATE`;

        if (!lockedBalance) {
          throw new BadRequestError('Organizer balance record not found.', 'BALANCE_NOT_FOUND');
        }

        if (lockedBalance.currency.toUpperCase() !== DEFAULT_PLATFORM_CURRENCY) {
          throw new BadRequestError(
            `Organizer balance currency (${lockedBalance.currency.toUpperCase()}) is not supported for USD transfers.`,
            'CURRENCY_MISMATCH'
          );
        }

        // Check net recoverable liabilities from signed ledger entries (-liability, +offset)
        const recoverableEntries = await tx.financialLedgerEntry.findMany({
          where: {
            organizerId: userId,
            balanceType: LedgerBalanceType.RECOVERABLE,
          },
        });
        const signedRecoverable = recoverableEntries.reduce((s, e) => s + e.amountInCents, 0);
        const totalRecoverable = Math.max(0, -signedRecoverable);

        const netAvailable = Math.max(0, lockedBalance.availableBalanceInCents - totalRecoverable);

        if (amountInCents > netAvailable) {
          throw new BadRequestError(
            `Insufficient available balance. You requested $${(amountInCents / 100).toFixed(2)}, but only $${(netAvailable / 100).toFixed(2)} is currently available for withdrawal.`,
            'INSUFFICIENT_AVAILABLE_BALANCE'
          );
        }

        const transferNumber = `TRF-${new Date().getFullYear()}-${nanoid(8).toUpperCase()}`;

        // Reserve funds immediately by decrementing available balance during initial row-lock transaction
        await tx.organizerBalance.update({
          where: { userId },
          data: {
            availableBalanceInCents: { decrement: amountInCents },
          },
        });

        const record = await tx.organizerTransfer.create({
          data: {
            transferNumber,
            organizerId: userId,
            stripeAccountId: user.stripeAccountId!,
            amountInCents,
            currency: DEFAULT_PLATFORM_CURRENCY,
            status: TransferStatus.PENDING,
            reconciliationRequired: false,
            sourceType: isAdmin ? TransferSourceType.ADMIN_INITIATED : TransferSourceType.MANUAL_ORGANIZER_REQUEST,
            idempotencyKey: fullIdempotencyKey,
            initiatedByUserId: initiatedByUserId || userId,
          },
        });

        await tx.financialLedgerEntry.create({
          data: {
            type: LedgerEntryType.TRANSFER_INITIATED,
            balanceType: LedgerBalanceType.AVAILABLE,
            amountInCents: -amountInCents,
            currency: DEFAULT_PLATFORM_CURRENCY,
            organizerId: userId,
            transferId: record.id,
            description: `Transfer initiated to Stripe Express account (#${transferNumber})`,
            metadata: {
              transferNumber,
              sourceType: record.sourceType,
            },
          },
        });

        return record;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  } catch (txError: any) {
    // Handle concurrent identical-key request race cleanly via P2002 replay recovery
    if (txError?.code === 'P2002') {
      const racedRecord = await prisma.organizerTransfer.findUnique({
        where: { idempotencyKey: fullIdempotencyKey },
      });
      if (racedRecord) {
        return resolveExistingTransferRecord(racedRecord);
      }
    }
    throw txError;
  }

  let stripeTransfer: Stripe.Transfer;
  try {
    // Persist create-attempt timestamp BEFORE the Stripe API call so crashes preserve the 24h15m restoration clock.
    await prisma.organizerTransfer.update({
      where: { id: transferRecord.id },
      data: { lastCreateAttemptAt: new Date() },
    });

    stripeTransfer = await stripe.transfers.create(
      {
        amount: amountInCents,
        currency: 'usd',
        destination: user.stripeAccountId,
        transfer_group: transferRecord.transferNumber,
        metadata: {
          organizerId: userId,
          transferId: transferRecord.id,
          transferNumber: transferRecord.transferNumber,
          initiatedByUserId: initiatedByUserId || userId,
          sourceType: transferRecord.sourceType,
          notes: notes || '',
        },
      },
      { idempotencyKey: `stripe_${transferRecord.idempotencyKey}` }
    );
  } catch (error: any) {
    logStripeDiagnostic('executeWithdrawal:transfers.create', error, {
      userId,
      stripeAccountId: user.stripeAccountId,
      amountInCents,
      transferId: transferRecord.id,
    });

    const classified = classifyTransferCreateError(error);

    if (classified.disposition === 'CONFIRMED_FAILURE') {
      const failureMessage = error?.message
        ? sanitizeTransferDiagnosticMessage(error.message)
        : classified.safeMessage;

      await prisma.$transaction((tx) =>
        finalizeTransferFailedInTx(tx, {
          transferId: transferRecord.id,
          failureCode: classified.code,
          failureMessage,
        })
      );

      throw new BadRequestError(
        classified.safeMessage || 'Failed to complete transfer to your Stripe Express account. No funds were deducted.',
        'TRANSFER_EXECUTION_FAILED'
      );
    }

    // AMBIGUOUS outcome (ETIMEDOUT / ECONNRESET / StripeConnectionError / StripeAPIError / 5xx / unknown):
    // Keep funds reserved, NEVER mark FAILED or restore balance prematurely.
    // Perform one read-only Stripe lookup outside DB locks in case the transfer actually succeeded.
    const lookup = await lookupStripeTransferForRecord(transferRecord);
    if (lookup.found) {
      const finalized = await prisma.$transaction((tx) =>
        finalizeTransferSucceededInTx(tx, {
          transferId: transferRecord.id,
          stripeTransfer: lookup.stripeTransfer,
        })
      );
      if (finalized.outcome === 'amountCurrencyMismatch') {
        throw new ServiceUnavailableError(
          'Stripe transfer details mismatched the reserved withdrawal. Held for manual reconciliation.',
          'TRANSFER_AMOUNT_CURRENCY_MISMATCH'
        );
      }
      if (finalized.transfer) {
        return buildTransferResult(finalized.transfer, finalized.balance, {
          clientIdempotencyKey: clientKey,
        });
      }
    }

    // Conditional update prevents racing with a concurrent transfer.created webhook that finalized SUCCEEDED during lookup.
    await prisma.organizerTransfer.updateMany({
      where: {
        id: transferRecord.id,
        status: TransferStatus.PENDING,
      },
      data: {
        reconciliationRequired: true,
        reconciliationNextAttemptAt: new Date(Date.now() + 30_000),
        reconciliationLastAttemptAt: new Date(),
        reconciliationLastErrorCode: classified.code,
        reconciliationLastErrorMessage: sanitizeTransferDiagnosticMessage(error),
      },
    });
    const [latestTransfer, bal] = await Promise.all([
      prisma.organizerTransfer.findUniqueOrThrow({ where: { id: transferRecord.id } }),
      prisma.organizerBalance.findUnique({ where: { userId } }),
    ]);

    if (
      latestTransfer.status === TransferStatus.SUCCEEDED ||
      latestTransfer.status === TransferStatus.REVERSED
    ) {
      return buildTransferResult(latestTransfer, bal, {
        clientIdempotencyKey: clientKey,
      });
    }

    if (latestTransfer.status === TransferStatus.FAILED) {
      throw new BadRequestError(
        latestTransfer.failureMessage ||
          'Failed to complete transfer to your Stripe Express account. No funds were deducted.',
        'TRANSFER_EXECUTION_FAILED'
      );
    }

    return buildTransferResult(latestTransfer, bal, {
      retryable: true,
      clientIdempotencyKey: clientKey,
      message: classified.safeMessage,
    });
  }

  // Finalize success idempotently (safe even if transfer.created webhook committed first)
  const finalized = await prisma.$transaction((tx) =>
    finalizeTransferSucceededInTx(tx, {
      transferId: transferRecord.id,
      stripeTransfer,
    })
  );

  if (finalized.outcome === 'amountCurrencyMismatch') {
    throw new ServiceUnavailableError(
      'Stripe transfer details mismatched the reserved withdrawal. Held for manual reconciliation.',
      'TRANSFER_AMOUNT_CURRENCY_MISMATCH'
    );
  }

  return buildTransferResult(finalized.transfer || transferRecord, finalized.balance, {
    clientIdempotencyKey: clientKey,
  });
}

/**
 * Returns paginated transfer history for an organizer.
 */
export async function getOrganizerTransfers(
  userId: string,
  options: { page?: number; limit?: number } = {}
) {
  const page = Math.max(1, options.page || 1);
  const limit = Math.min(100, Math.max(1, options.limit || 20));
  const skip = (page - 1) * limit;

  const [total, transfers] = await Promise.all([
    prisma.organizerTransfer.count({ where: { organizerId: userId } }),
    prisma.organizerTransfer.findMany({
      where: { organizerId: userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        initiatedByUser: { select: { id: true, name: true, email: true, role: true } },
      },
    }),
  ]);

  return {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    transfers: transfers.map((t) => ({
      id: t.id,
      transferNumber: t.transferNumber,
      stripeTransferId: t.stripeTransferId,
      amountInCents: t.amountInCents,
      reversedAmountInCents: t.reversedAmountInCents,
      currency: t.currency.toUpperCase(),
      status: t.status,
      reconciliationRequired: t.reconciliationRequired,
      sourceType: t.sourceType,
      failureCode: t.failureCode,
      failureMessage: t.failureMessage,
      createdAt: t.createdAt.toISOString(),
      initiatedBy: t.initiatedByUser
        ? {
            id: t.initiatedByUser.id,
            name: t.initiatedByUser.name,
            email: t.initiatedByUser.email,
            role: t.initiatedByUser.role,
          }
        : null,
    })),
  };
}
