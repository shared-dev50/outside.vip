import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth, requireRole } from '../../middleware/auth.js';
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
} from './finance.controller.js';

export const financeRouter = Router();

// Protect all finance endpoints with auth & organizer/admin role
financeRouter.use(requireAuth);
financeRouter.use(requireRole(Role.ORGANIZER, Role.ADMIN));

financeRouter.get('/account', handleGetAccountStatus);
financeRouter.post('/onboarding-link', handleCreateOnboardingLink);
financeRouter.post('/login-link', handleCreateLoginLink);
financeRouter.get('/balance', handleGetBalance);
financeRouter.post('/withdraw', handleExecuteWithdrawal);
financeRouter.post('/admin/withdraw', requireRole(Role.ADMIN), handleAdminWithdrawal);
financeRouter.get('/transfers', handleGetTransfers);
financeRouter.get('/ledger', handleGetLedger);
financeRouter.get('/payouts', handleGetPayouts);
financeRouter.get('/disputes', handleGetDisputes);
financeRouter.patch('/payout-schedule', handleUpdatePayoutSchedule);
financeRouter.get('/reconcile', handleReconcile);
