import { Router } from 'express';
import { Role } from '@prisma/client';
import {
  requireAuth,
  requireVerifiedEmail,
  requireAdmin,
  requireFreshUserVerification,
  requireRole,
} from '../../middleware/auth.js';
import {
  handleGetAccountStatus,
  handleCreateOnboardingLink,
  handleCreateLoginLink,
  handleGetBalance,
  handleExecuteWithdrawal,
  handleAdminWithdrawal,
  handleAdminReplaceConnectedAccount,
  handleGetTransfers,
  handleGetLedger,
  handleGetPayouts,
  handleGetDisputes,
  handleUpdatePayoutSchedule,
  handleReconcile,
  handleGetSupportedCountries,
} from './finance.controller.js';

export const financeRouter = Router();

const requireOrganizerOrAdmin = requireRole(Role.ORGANIZER, Role.ADMIN);

financeRouter.use(requireAuth);
financeRouter.use(requireVerifiedEmail);

financeRouter.get('/countries', requireOrganizerOrAdmin, handleGetSupportedCountries);
financeRouter.get('/account', requireOrganizerOrAdmin, handleGetAccountStatus);
financeRouter.post(
  '/onboarding-link',
  requireFreshUserVerification,
  requireOrganizerOrAdmin,
  handleCreateOnboardingLink
);
financeRouter.post(
  '/login-link',
  requireFreshUserVerification,
  requireOrganizerOrAdmin,
  handleCreateLoginLink
);
financeRouter.get('/balance', requireOrganizerOrAdmin, handleGetBalance);
financeRouter.post(
  '/withdraw',
  requireFreshUserVerification,
  requireOrganizerOrAdmin,
  handleExecuteWithdrawal
);
financeRouter.post(
  '/admin/withdraw',
  requireFreshUserVerification,
  requireAdmin,
  handleAdminWithdrawal
);
financeRouter.post(
  '/admin/replace-account',
  requireFreshUserVerification,
  requireAdmin,
  handleAdminReplaceConnectedAccount
);
financeRouter.get('/transfers', requireOrganizerOrAdmin, handleGetTransfers);
financeRouter.get('/ledger', requireOrganizerOrAdmin, handleGetLedger);
financeRouter.get('/payouts', requireOrganizerOrAdmin, handleGetPayouts);
financeRouter.get('/disputes', requireOrganizerOrAdmin, handleGetDisputes);
financeRouter.patch(
  '/payout-schedule',
  requireFreshUserVerification,
  requireOrganizerOrAdmin,
  handleUpdatePayoutSchedule
);
financeRouter.get('/reconcile', requireOrganizerOrAdmin, handleReconcile);
