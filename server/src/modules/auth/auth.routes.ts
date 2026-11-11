import { Router } from 'express';
import {
  register,
  login,
  logout,
  logoutAll,
  listSessions,
  revokeSessionById,
  changePassword,
  updateUserStatus,
  getCsrfToken,
  getCurrentUser,
  verifyEmail,
  resendVerification,
  updateProfile,
  forbidRolePromotion,
  forbidDemoAuth,
} from './auth.controller.js';
import {
  requireAuth,
  requireAdmin,
  requireFreshUserVerification,
} from '../../middleware/auth.js';

export const authRouter = Router();

authRouter.all(['/demo', '/demo-login', '/quick-login', '/demo/*'], forbidDemoAuth);
authRouter.get('/csrf', getCsrfToken);
authRouter.post('/register', register);
authRouter.post('/login', login);
authRouter.post('/logout', logout);
authRouter.post('/logout-all', requireAuth, requireFreshUserVerification, logoutAll);
authRouter.get('/sessions', requireAuth, listSessions);
authRouter.delete('/sessions/:sessionId', requireAuth, requireFreshUserVerification, revokeSessionById);
authRouter.post('/change-password', requireAuth, requireFreshUserVerification, changePassword);
authRouter.post('/verify-email', verifyEmail);
authRouter.post('/resend-verification', resendVerification);
authRouter.get('/me', requireAuth, requireFreshUserVerification, getCurrentUser);
authRouter.patch('/profile', requireAuth, requireFreshUserVerification, updateProfile);
authRouter.put('/profile', requireAuth, requireFreshUserVerification, updateProfile);
authRouter.patch('/users/:id/role', requireAuth, forbidRolePromotion);
authRouter.put('/users/:id/role', requireAuth, forbidRolePromotion);
authRouter.patch('/users/:id/status', requireAuth, requireAdmin, updateUserStatus);
authRouter.put('/users/:id/status', requireAuth, requireAdmin, updateUserStatus);
