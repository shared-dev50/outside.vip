import { Router } from 'express';
import {
  requireAuth,
  requireVerifiedEmail,
  requireAdmin,
  requireFreshUserVerification,
} from '../../middleware/auth.js';
import {
  handleGetAccountStatus,
  handleCreateOnboardingLink,
  handleCreateLoginLink,
  handleGetBalance,
  handleExecuteWithdrawal,
  handleAdminWithdrawal,
  handleGetTransfers,
  handleGetLedger,
  handleGetPayouts,
  handleGetDisputes,
  handleUpdatePayoutSchedule,
  handleReconcile,
  handleGetSupportedCountries,
} from './finance.controller.js';

export const financeRouter = Router();

financeRouter.use(requireAuth);
financeRouter.use(requireVerifiedEmail);

financeRouter.get('/countries', handleGetSupportedCountries);
financeRouter.get('/account', handleGetAccountStatus);
financeRouter.post('/onboarding-link', requireFreshUserVerification, handleCreateOnboardingLink);
financeRouter.post('/login-link', requireFreshUserVerification, handleCreateLoginLink);
financeRouter.get('/balance', handleGetBalance);
financeRouter.post('/withdraw', requireFreshUserVerification, handleExecuteWithdrawal);
financeRouter.post('/admin/withdraw', requireAdmin, handleAdminWithdrawal);
financeRouter.get('/transfers', handleGetTransfers);
financeRouter.get('/ledger', handleGetLedger);
financeRouter.get('/payouts', handleGetPayouts);
financeRouter.get('/disputes', handleGetDisputes);
financeRouter.patch('/payout-schedule', requireFreshUserVerification, handleUpdatePayoutSchedule);
financeRouter.get('/reconcile', handleReconcile);
