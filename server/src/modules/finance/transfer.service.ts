import { Prisma, TransferStatus, TransferSourceType, LedgerEntryType, LedgerBalanceType } from '@prisma/client';
import { nanoid } from 'nanoid';
import Stripe from 'stripe';
import { prisma } from '../../db/prisma.js';
import { stripe } from '../../lib/stripe.js';
import { env } from '../../config/env.js';
import { BadRequestError, ServiceUnavailableError } from '../../utils/errors.js';
import { classifyStripeError, logStripeDiagnostic } from './stripeError.js';
import { getOrCreateOrganizerBalance } from './ledger.service.js';

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
  currency: string;
  status: TransferStatus;
  sourceType: TransferSourceType;
  remainingAvailableInCents: number;
  transferredInCents: number;
  createdAt: string;
}

/**
 * Executes an organizer withdrawal or admin-initiated transfer to a Stripe Express connected account.
 * Uses strict row-locking (FOR UPDATE) to prevent double-spending or concurrent race conditions.
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

  if (!env.STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
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

  const transfersActive = account.capabilities?.transfers === 'active';
  const disabledReason = account.requirements?.disabled_reason;
  const pastDue = account.requirements?.past_due || [];

  if (!transfersActive || disabledReason || pastDue.length > 0) {
    let safeReason = 'Your Stripe Express account is not yet fully enabled to receive transfers.';
    if (disabledReason) {
      safeReason = `Transfers are disabled by Stripe: ${disabledReason}. Please update your account details in the Stripe dashboard.`;
    } else if (pastDue.length > 0) {
      safeReason = 'Your Stripe account has past-due verification requirements. Please complete identity or bank verification in the Stripe dashboard.';
    } else if (!transfersActive) {
      safeReason = 'Your Stripe account transfer capability is pending activation by Stripe. Please complete your Stripe onboarding.';
    }
    throw new BadRequestError(safeReason, 'ACCOUNT_NOT_READY_FOR_TRANSFERS');
  }

  const clientKey = idempotencyKey || `withdr_${nanoid(20)}`;
  const fullIdempotencyKey = `tx_${userId}_${clientKey}`;

  const existingTransfer = await prisma.organizerTransfer.findUnique({
    where: { idempotencyKey: fullIdempotencyKey },
  });

  if (existingTransfer) {
    if (existingTransfer.status === TransferStatus.SUCCEEDED) {
      const bal = await prisma.organizerBalance.findUnique({ where: { userId } });
      return {
        transferId: existingTransfer.id,
        transferNumber: existingTransfer.transferNumber,
        stripeTransferId: existingTransfer.stripeTransferId,
        amountInCents: existingTransfer.amountInCents,
        currency: existingTransfer.currency.toUpperCase(),
        status: existingTransfer.status,
        sourceType: existingTransfer.sourceType,
        remainingAvailableInCents: bal?.availableBalanceInCents || 0,
        transferredInCents: bal?.transferredBalanceInCents || 0,
        createdAt: existingTransfer.createdAt.toISOString(),
      };
    }
    if (existingTransfer.status === TransferStatus.PENDING) {
      try {
        const existingStripeTransfers = await stripe.transfers.list({
          transfer_group: existingTransfer.transferNumber,
          limit: 10,
        });

        // Match exact internal withdrawal: transfer ID, amount, currency, and destination connected account
        const matchingTransfer = existingStripeTransfers.data.find((st) => {
          const matchMeta = st.metadata?.transferId === existingTransfer.id;
          const matchAmount = st.amount === existingTransfer.amountInCents;
          const matchCurrency = st.currency.toLowerCase() === existingTransfer.currency.toLowerCase();
          const matchDestination = st.destination === user.stripeAccountId;
          return matchAmount && matchCurrency && matchDestination && (matchMeta || !st.metadata?.transferId);
        });

        if (matchingTransfer) {
          const finalized = await prisma.$transaction(async (tx) => {
            const current = await tx.organizerTransfer.findUnique({
              where: { id: existingTransfer.id },
            });
            if (current && current.status === TransferStatus.SUCCEEDED) {
              const bal = await tx.organizerBalance.findUnique({ where: { userId } });
              return { updTransfer: current, updBalance: bal! };
            }

            const updTransfer = await tx.organizerTransfer.update({
              where: { id: existingTransfer.id },
              data: {
                status: TransferStatus.SUCCEEDED,
                stripeTransferId: matchingTransfer.id,
              },
            });
            const updBalance = await tx.organizerBalance.update({
              where: { userId },
              data: {
                transferredBalanceInCents: { increment: existingTransfer.amountInCents },
              },
            });
            await tx.financialLedgerEntry.create({
              data: {
                type: LedgerEntryType.TRANSFER_SUCCEEDED,
                balanceType: LedgerBalanceType.TRANSFERRED,
                amountInCents: existingTransfer.amountInCents,
                currency: 'USD',
                organizerId: userId,
                transferId: updTransfer.id,
                stripeReferenceId: matchingTransfer.id,
                description: `Transferred $${(existingTransfer.amountInCents / 100).toFixed(2)} to Stripe Express account (${user.stripeAccountId})`,
                metadata: {
                  transferNumber: updTransfer.transferNumber,
                  stripeTransferId: matchingTransfer.id,
                  sourceType: updTransfer.sourceType,
                },
              },
            });
            return { updTransfer, updBalance };
          });

          return {
            transferId: finalized.updTransfer.id,
            transferNumber: finalized.updTransfer.transferNumber,
            stripeTransferId: finalized.updTransfer.stripeTransferId,
            amountInCents: finalized.updTransfer.amountInCents,
            currency: finalized.updTransfer.currency.toUpperCase(),
            status: finalized.updTransfer.status,
            sourceType: finalized.updTransfer.sourceType,
            remainingAvailableInCents: finalized.updBalance.availableBalanceInCents,
            transferredInCents: finalized.updBalance.transferredBalanceInCents,
            createdAt: finalized.updTransfer.createdAt.toISOString(),
          };
        }
      } catch (err: any) {
        if (err instanceof BadRequestError) throw err;
        // fallback to in-progress message
      }

      throw new BadRequestError(
        'A transfer with this reference is already in progress. Please wait a moment.',
        'DUPLICATE_TRANSFER_IN_PROGRESS'
      );
    }
  }

  const transferRecord = await prisma.$transaction(
    async (tx) => {
      await getOrCreateOrganizerBalance(tx, userId);

      // Lock balance row to prevent concurrent race conditions on withdrawals
      const [lockedBalance] = await tx.$queryRaw<
        Array<{
          id: string;
          userId: string;
          availableBalanceInCents: number;
          pendingBalanceInCents: number;
          transferredBalanceInCents: number;
        }>
      >`SELECT id, "userId", "availableBalanceInCents", "pendingBalanceInCents", "transferredBalanceInCents"
        FROM "OrganizerBalance"
        WHERE "userId" = ${userId}
        FOR UPDATE`;

      if (!lockedBalance) {
        throw new BadRequestError('Organizer balance record not found.', 'BALANCE_NOT_FOUND');
      }

      // Check recoverable liabilities from ledger
      const recoverableEntries = await tx.financialLedgerEntry.findMany({
        where: {
          organizerId: userId,
          balanceType: LedgerBalanceType.RECOVERABLE,
        },
      });
      const totalRecoverable = recoverableEntries.reduce((s, e) => s + Math.abs(e.amountInCents), 0);

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
          currency: 'USD',
          status: TransferStatus.PENDING,
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
          currency: 'USD',
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

  let stripeTransfer: Stripe.Transfer;
  try {
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

    const failureMessage = error?.message ? String(error.message).slice(0, 500) : 'Stripe transfer failed';
    const failureCode = error?.code || 'transfer_failed';

    // Atomically restore the reserved available balance and record the failed attempt
    await prisma.$transaction(async (tx) => {
      await tx.organizerTransfer.update({
        where: { id: transferRecord.id },
        data: {
          status: TransferStatus.FAILED,
          failureCode,
          failureMessage,
        },
      });

      await tx.organizerBalance.update({
        where: { userId },
        data: {
          availableBalanceInCents: { increment: amountInCents },
        },
      });

      await tx.financialLedgerEntry.create({
        data: {
          type: LedgerEntryType.TRANSFER_FAILED,
          balanceType: LedgerBalanceType.AVAILABLE,
          amountInCents,
          currency: 'USD',
          organizerId: userId,
          transferId: transferRecord.id,
          description: `Transfer failed (${failureCode}); available balance restored for transfer #${transferRecord.transferNumber}`,
          metadata: {
            failureCode,
            failureMessage,
          },
        },
      });
    });

    const classified = classifyStripeError(error);
    throw new BadRequestError(
      classified.safeMessage || 'Failed to complete transfer to your Stripe Express account. No funds were deducted.',
      'TRANSFER_EXECUTION_FAILED'
    );
  }

  // Update balance and record transfer success in a transaction
  const updatedResult = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id FROM "OrganizerBalance" WHERE "userId" = ${userId} FOR UPDATE
    `;

    const updatedTransfer = await tx.organizerTransfer.update({
      where: { id: transferRecord.id },
      data: {
        status: TransferStatus.SUCCEEDED,
        stripeTransferId: stripeTransfer.id,
      },
    });

    // Available balance was already decremented when transfer was initiated; increment transferred balance
    const updatedBalance = await tx.organizerBalance.update({
      where: { userId },
      data: {
        transferredBalanceInCents: { increment: amountInCents },
      },
    });

    await tx.financialLedgerEntry.create({
      data: {
        type: LedgerEntryType.TRANSFER_SUCCEEDED,
        balanceType: LedgerBalanceType.TRANSFERRED,
        amountInCents,
        currency: 'USD',
        organizerId: userId,
        transferId: updatedTransfer.id,
        stripeReferenceId: stripeTransfer.id,
        description: `Transferred $${(amountInCents / 100).toFixed(2)} to Stripe Express account (${user.stripeAccountId})`,
        metadata: {
          transferNumber: updatedTransfer.transferNumber,
          stripeTransferId: stripeTransfer.id,
          sourceType: updatedTransfer.sourceType,
        },
      },
    });

    return {
      updatedTransfer,
      updatedBalance,
    };
  });

  return {
    transferId: updatedResult.updatedTransfer.id,
    transferNumber: updatedResult.updatedTransfer.transferNumber,
    stripeTransferId: updatedResult.updatedTransfer.stripeTransferId,
    amountInCents: updatedResult.updatedTransfer.amountInCents,
    currency: updatedResult.updatedTransfer.currency.toUpperCase(),
    status: updatedResult.updatedTransfer.status,
    sourceType: updatedResult.updatedTransfer.sourceType,
    remainingAvailableInCents: updatedResult.updatedBalance.availableBalanceInCents,
    transferredInCents: updatedResult.updatedBalance.transferredBalanceInCents,
    createdAt: updatedResult.updatedTransfer.createdAt.toISOString(),
  };
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
      currency: t.currency.toUpperCase(),
      status: t.status,
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
