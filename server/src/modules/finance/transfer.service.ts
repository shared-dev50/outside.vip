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

  // 1. Amount validation
  if (!Number.isInteger(amountInCents) || amountInCents <= 0) {
    throw new BadRequestError('Withdrawal amount must be a positive integer in cents.', 'INVALID_WITHDRAWAL_AMOUNT');
  }

  // Minimum withdrawal amount: $1.00 (100 cents)
  if (amountInCents < 100) {
    throw new BadRequestError('Minimum withdrawal amount is $1.00 USD.', 'WITHDRAWAL_BELOW_MINIMUM');
  }

  // 2. Verify user and connected account exist
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

  // 3. Verify Stripe configuration is active
  if (!env.STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
    throw new ServiceUnavailableError(
      'Withdrawals are temporarily unavailable while platform Stripe configuration is being completed.',
      'STRIPE_CONFIGURATION_UNAVAILABLE'
    );
  }

  // 4. Verify connected account can receive transfers via Stripe API
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

  // Check if payouts/transfers are enabled or requirements are overdue
  const canReceiveTransfers = account.payouts_enabled || account.charges_enabled || account.details_submitted;
  if (!canReceiveTransfers) {
    throw new BadRequestError(
      'Your Stripe Express account is not yet fully enabled to receive transfers. Please complete identity or payout verification in the Stripe dashboard.',
      'ACCOUNT_NOT_READY_FOR_TRANSFERS'
    );
  }

  // 5. Unique transfer tracking
  const clientKey = idempotencyKey || `withdr_${nanoid(20)}`;
  const fullIdempotencyKey = `tx_${userId}_${clientKey}`;

  // Check if an existing transfer was already recorded with this idempotency key
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
      throw new BadRequestError(
        'A transfer with this reference is already in progress. Please wait a moment.',
        'DUPLICATE_TRANSFER_IN_PROGRESS'
      );
    }
  }

  // 6. Execute atomic balance check and reservation with row-level lock
  const transferRecord = await prisma.$transaction(
    async (tx) => {
      // Ensure balance row exists
      await getOrCreateOrganizerBalance(tx, userId);

      // Lock balance row using FOR UPDATE to prevent concurrent race conditions
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

      // Record transfer in PENDING status
      return await tx.organizerTransfer.create({
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
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
  );

  // 7. Call Stripe API to initiate the transfer
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
    // Record failure in transfer record and do NOT deduct from organizer available balance
    logStripeDiagnostic('executeWithdrawal:transfers.create', error, {
      userId,
      stripeAccountId: user.stripeAccountId,
      amountInCents,
      transferId: transferRecord.id,
    });

    const failureMessage = error?.message ? String(error.message).slice(0, 500) : 'Stripe transfer failed';
    const failureCode = error?.code || 'transfer_failed';

    await prisma.organizerTransfer.update({
      where: { id: transferRecord.id },
      data: {
        status: TransferStatus.FAILED,
        failureCode,
        failureMessage,
      },
    });

    const classified = classifyStripeError(error);
    throw new BadRequestError(
      classified.safeMessage || 'Failed to complete transfer to your Stripe Express account. No funds were deducted.',
      'TRANSFER_EXECUTION_FAILED'
    );
  }

  // 8. Stripe transfer succeeded! Finalize DB state in transaction
  const updatedResult = await prisma.$transaction(async (tx) => {
    // Re-lock balance row
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

    const updatedBalance = await tx.organizerBalance.update({
      where: { userId },
      data: {
        availableBalanceInCents: { decrement: amountInCents },
        transferredBalanceInCents: { increment: amountInCents },
      },
    });

    // Create ledger entry
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
