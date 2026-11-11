import { Router } from 'express';
import {
  register,
  login,
  getCurrentUser,
  verifyEmail,
  resendVerification,
  updateProfile,
  forbidRolePromotion,
  forbidDemoAuth,
} from './auth.controller.js';
import { requireAuth } from '../../middleware/auth.js';

export const authRouter = Router();

authRouter.all(['/demo', '/demo-login', '/quick-login', '/demo/*'], forbidDemoAuth);
authRouter.post('/register', register);
authRouter.post('/login', login);
authRouter.post('/verify-email', verifyEmail);
authRouter.post('/resend-verification', resendVerification);
authRouter.get('/me', requireAuth, getCurrentUser);
authRouter.patch('/profile', requireAuth, updateProfile);
authRouter.put('/profile', requireAuth, updateProfile);
authRouter.patch('/users/:id/role', requireAuth, forbidRolePromotion);
authRouter.put('/users/:id/role', requireAuth, forbidRolePromotion);
