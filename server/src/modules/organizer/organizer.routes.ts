import { Router } from 'express';
import {
  requireAuth,
  requireVerifiedEmail,
  requireFreshUserVerification,
} from '../../middleware/auth.js';
import {
  getDashboardStats,
  listOrganizerEvents,
  getOrganizerEventById,
  createOrganizerEvent,
  updateOrganizerEvent,
  publishEvent,
  unpublishEvent,
  deleteOrganizerEvent,
  cancelOrganizerEvent,
  cancelOrganizerSeries,
  getOrganizerSeries,
  getUploadSignature,
  handleDirectUpload,
  getOrganizerPayoutDetails,
  updateOrganizerPayoutDetails,
  checkInTicket,
  getOrganizerEarningsPreview,
  getOrganizerWorkspace,
  upsertOrganizerWorkspace,
  getOrganizerOrders,
} from './organizer.controller.js';
import { handleGetOrganizerWaitlist } from '../waitlist/waitlist.controller.js';
import { uploadCoverMiddleware } from '../../middleware/upload.js';
import { financeRouter } from '../finance/finance.routes.js';
import {
  getEventTeam,
  inviteStaff,
  resendInvitation,
  revokeInvitation,
  revokeStaffMember,
} from '../staff/staff.controller.js';

export const organizerRouter = Router();

organizerRouter.use('/finance', financeRouter);

organizerRouter.use(requireAuth);
organizerRouter.use(requireVerifiedEmail);

organizerRouter.get('/workspace', getOrganizerWorkspace);
organizerRouter.post('/workspace', upsertOrganizerWorkspace);
organizerRouter.put('/workspace', upsertOrganizerWorkspace);
organizerRouter.post('/onboarding', upsertOrganizerWorkspace);

organizerRouter.post('/check-in', checkInTicket);
organizerRouter.post('/upload/sign', getUploadSignature);

organizerRouter.post('/upload', uploadCoverMiddleware.single('image'), handleDirectUpload);

organizerRouter.get('/dashboard', getDashboardStats);
organizerRouter.get('/orders', getOrganizerOrders);
organizerRouter.post('/earnings-preview', getOrganizerEarningsPreview);
organizerRouter.get('/payout-details', getOrganizerPayoutDetails);
organizerRouter.put('/payout-details', requireFreshUserVerification, updateOrganizerPayoutDetails);
organizerRouter.get('/events', listOrganizerEvents);
organizerRouter.post('/events', createOrganizerEvent);
organizerRouter.get('/events/:id', getOrganizerEventById);
organizerRouter.get('/events/:id/waitlist', handleGetOrganizerWaitlist);
organizerRouter.put('/events/:id', updateOrganizerEvent);
organizerRouter.patch('/events/:id', updateOrganizerEvent);
organizerRouter.post('/events/:id/publish', publishEvent);
organizerRouter.post('/events/:id/unpublish', unpublishEvent);
organizerRouter.post('/events/:id/cancel', cancelOrganizerEvent);
organizerRouter.delete('/events/:id', deleteOrganizerEvent);
organizerRouter.get('/series/:id', getOrganizerSeries);
organizerRouter.post('/series/:id/cancel', cancelOrganizerSeries);

organizerRouter.get(['/events/:eventId/team', '/events/:id/team'], getEventTeam);
organizerRouter.post(['/events/:eventId/team/invitations', '/events/:id/team/invitations'], inviteStaff);
organizerRouter.post(
  [
    '/events/:eventId/team/invitations/:invitationId/resend',
    '/events/:id/team/invitations/:invitationId/resend',
  ],
  resendInvitation
);
organizerRouter.delete(
  [
    '/events/:eventId/team/invitations/:invitationId',
    '/events/:id/team/invitations/:invitationId',
  ],
  revokeInvitation
);
organizerRouter.delete(
  ['/events/:eventId/team/members/:userId', '/events/:id/team/members/:userId'],
  revokeStaffMember
);
