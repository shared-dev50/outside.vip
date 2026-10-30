import { Request, Response, NextFunction } from 'express';
import {
  getConnectedAccountStatus,
  createOnboardingLink,
  createAccountLoginOrUpdateLink,
  getConnectedAccountBalance,
  getConnectedAccountPayouts,
  getConnectedAccountDisputes,
  updateConnectedAccountPayoutSchedule,
} from './finance.service.js';
import {
  getOrganizerFinancialSummary,
  getOrganizerLedgerEntries,
  reconcileOrganizerFinance,
} from './ledger.service.js';
import { executeWithdrawal, getOrganizerTransfers } from './transfer.service.js';
import {
  onboardingLinkSchema,
  loginLinkSchema,
  updatePayoutScheduleSchema,
  withdrawFundsSchema,
  adminWithdrawFundsSchema,
} from './finance.schema.js';
import { prisma } from '../../db/prisma.js';

export async function handleGetAccountStatus(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const status = await getConnectedAccountStatus(userId);
    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    next(error);
  }
}

export async function handleCreateOnboardingLink(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { returnUrl, refreshUrl, reconnect } = onboardingLinkSchema.parse(req.body || {});
    const result = await createOnboardingLink(userId, returnUrl, refreshUrl, reconnect);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function handleCreateLoginLink(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { returnUrl } = loginLinkSchema.parse(req.body || {});
    const result = await createAccountLoginOrUpdateLink(userId, returnUrl);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Returns complete Posh-inspired balances:
 * - Pending balance (awaiting settlement)
 * - Available balance (eligible for transfer)
 * - Transferred balance (moved to Express)
 * - Lifetime earnings & any recoverable liabilities
 * - Stripe Express balance if connected
 */
export async function handleGetBalance(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const summary = await getOrganizerFinancialSummary(userId);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { stripeAccountId: true },
    });

    let stripeBalance: { available: any[]; pending: any[] } = { available: [], pending: [] };
    if (user?.stripeAccountId) {
      stripeBalance = await getConnectedAccountBalance(userId);
    }

    res.json({
      success: true,
      data: {
        ...summary,
        available: stripeBalance.available,
        pending: stripeBalance.pending,
        stripeBalance,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Initiates an organizer manual withdrawal to their Stripe Express account.
 */
export async function handleExecuteWithdrawal(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const input = withdrawFundsSchema.parse(req.body);
    const result = await executeWithdrawal({
      userId,
      amountInCents: input.amountInCents,
      idempotencyKey: input.idempotencyKey,
      notes: input.notes,
      isAdmin: false,
    });
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Admin-initiated withdrawal on behalf of an organizer.
 */
export async function handleAdminWithdrawal(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const adminUserId = req.user!.userId;
    const input = adminWithdrawFundsSchema.parse(req.body);
    const result = await executeWithdrawal({
      userId: input.organizerId,
      amountInCents: input.amountInCents,
      idempotencyKey: input.idempotencyKey,
      notes: input.notes,
      initiatedByUserId: adminUserId,
      isAdmin: true,
    });
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Returns organizer transfer history (platform -> Express connected account).
 */
export async function handleGetTransfers(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const result = await getOrganizerTransfers(userId, { page, limit });
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Returns organizer ledger entries.
 */
export async function handleGetLedger(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const eventId = req.query.eventId as string | undefined;
    const result = await getOrganizerLedgerEntries(userId, { page, limit, eventId });
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Returns connected account bank payouts (Express account -> Bank).
 */
export async function handleGetPayouts(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { stripeAccountId: true },
    });

    if (!user || !user.stripeAccountId) {
      res.json({
        success: true,
        data: { payouts: [] },
      });
      return;
    }

    // Call Stripe API to retrieve payouts
    const stripePayoutsRes = await getConnectedAccountPayouts(userId, limit);

    if (stripePayoutsRes.payouts.length > 0) {
      res.json({
        success: true,
        data: stripePayoutsRes,
      });
      return;
    }

    // Fallback to local ConnectedPayout table
    const dbPayouts = await prisma.connectedPayout.findMany({
      where: { organizerId: userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    res.json({
      success: true,
      data: {
        payouts: dbPayouts.map((p) => ({
          id: p.stripePayoutId,
          amount: p.amountInCents,
          currency: p.currency.toUpperCase(),
          status: p.status.toLowerCase(),
          arrivalDate: p.arrivalDate ? p.arrivalDate.toISOString() : null,
          created: p.createdAt.toISOString(),
          destination: p.destinationBankMasked || null,
          failureCode: p.failureCode,
          failureMessage: p.failureMessage,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function handleGetDisputes(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
    const disputes = await getConnectedAccountDisputes(userId, limit);
    res.json({
      success: true,
      data: disputes,
    });
  } catch (error) {
    next(error);
  }
}

export async function handleUpdatePayoutSchedule(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const input = updatePayoutScheduleSchema.parse(req.body);
    const result = await updateConnectedAccountPayoutSchedule(userId, input);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function handleReconcile(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const result = await reconcileOrganizerFinance(userId);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
