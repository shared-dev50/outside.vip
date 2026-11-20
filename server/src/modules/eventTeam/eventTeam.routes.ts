import { Router } from 'express';
import { requireAuth, requireVerifiedEmail } from '../../middleware/auth.js';
import {
  handleInviteTeamMember,
  handleInspectTeamInvitation,
  handleAcceptTeamInvitation,
  handleResendTeamInvitation,
  handleRevokeTeamInvitation,
  handleUpdateTeamMember,
  handleRevokeTeamMember,
  handleListTeamMembers,
  handleListHostEvents,
} from './eventTeam.controller.js';
import {
  handleGetHostPromotionalAnalytics,
  handleCustomizeHostSlug,
  handleGetEventPromotionalLinks,
  handleCreateCampaignLink,
  handleUpdatePromotionLink,
  handleCustomizePromotionSlug,
  handleGetEventPromotionalAnalytics,
} from '../promotions/promotions.management.controller.js';

export const teamRouter = Router();

// ==========================================
// 1. Team Invitations (Public & Authenticated)
// ==========================================
teamRouter.get('/invitations/:token', handleInspectTeamInvitation);
teamRouter.post(
  '/invitations/:token/accept',
  requireAuth,
  requireVerifiedEmail,
  handleAcceptTeamInvitation
);

// ==========================================
// 2. Host Experience & Isolated Analytics
// ==========================================
export const hostRouter = Router();
hostRouter.use(requireAuth);
hostRouter.use(requireVerifiedEmail);

hostRouter.get('/events', handleListHostEvents);
hostRouter.get('/events/:eventId/analytics', handleGetHostPromotionalAnalytics);
hostRouter.patch('/events/:eventId/slug', handleCustomizeHostSlug);

// ==========================================
// 3. Event-Scoped Team & Promotions Router
// ==========================================
export const eventTeamRouter = Router({ mergeParams: true });
eventTeamRouter.use(requireAuth);
eventTeamRouter.use(requireVerifiedEmail);

// Team Members & Invitations
eventTeamRouter.get('/', handleListTeamMembers);
eventTeamRouter.post('/invitations', handleInviteTeamMember);
eventTeamRouter.post('/invitations/:invitationId/resend', handleResendTeamInvitation);
eventTeamRouter.delete('/invitations/:invitationId', handleRevokeTeamInvitation);
eventTeamRouter.patch('/members/:memberId', handleUpdateTeamMember);
eventTeamRouter.delete('/members/:memberId', handleRevokeTeamMember);

// ==========================================
// 4. Event Promotional Links & Analytics Router
// ==========================================
export const eventPromotionsRouter = Router({ mergeParams: true });
eventPromotionsRouter.use(requireAuth);
eventPromotionsRouter.use(requireVerifiedEmail);

eventPromotionsRouter.get('/links', handleGetEventPromotionalLinks);
eventPromotionsRouter.post('/links', handleCreateCampaignLink);
eventPromotionsRouter.patch('/links/:linkId', handleUpdatePromotionLink);
eventPromotionsRouter.post('/links/:linkId/slug', handleCustomizePromotionSlug);
eventPromotionsRouter.get('/analytics', handleGetEventPromotionalAnalytics);

