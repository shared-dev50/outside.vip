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
} from './organizer.controller.js';
import { handleGetOrganizerWaitlist } from '../waitlist/waitlist.controller.js';
import { uploadCoverMiddleware } from '../../middleware/upload.js';
import { financeRouter } from '../finance/finance.routes.js';

export const organizerRouter = Router();

// Mount Stripe-connected Finance routes
organizerRouter.use('/finance', financeRouter);

// Protect all organizer endpoints with auth & verified email middleware
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
