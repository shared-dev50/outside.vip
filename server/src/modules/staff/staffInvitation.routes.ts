import { Router } from 'express';
import {
  requireAuth,
  requireFreshUserVerification,
  requireVerifiedEmail,
} from '../../middleware/auth.js';
import {
  getInvitationMetadata,
  requestInvitationOtp,
  verifyInvitationOtp,
  acceptInvitationWithSession,
} from './staffInvitation.controller.js';

export const staffInvitationRouter = Router();

staffInvitationRouter.get('/:token', getInvitationMetadata);
staffInvitationRouter.post('/:token/request-otp', requestInvitationOtp);
staffInvitationRouter.post('/:token/verify-otp', verifyInvitationOtp);
staffInvitationRouter.post(
  '/:token/accept',
  requireAuth,
  requireFreshUserVerification,
  requireVerifiedEmail,
  acceptInvitationWithSession
);

