import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth, requireRole } from '../../middleware/auth.js';
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
} from './organizer.controller.js';
import { handleGetOrganizerWaitlist } from '../waitlist/waitlist.controller.js';
import { uploadCoverMiddleware } from '../../middleware/upload.js';

export const organizerRouter = Router();

// Protect all organizer endpoints with auth & role middleware
organizerRouter.use(requireAuth);
organizerRouter.use(requireRole(Role.ORGANIZER, Role.ADMIN));

organizerRouter.post('/check-in', checkInTicket);
organizerRouter.post('/upload/sign', getUploadSignature);

organizerRouter.post('/upload', uploadCoverMiddleware.single('image'), handleDirectUpload);

organizerRouter.get('/dashboard', getDashboardStats);
organizerRouter.post('/earnings-preview', getOrganizerEarningsPreview);
organizerRouter.get('/payout-details', getOrganizerPayoutDetails);
organizerRouter.put('/payout-details', updateOrganizerPayoutDetails);
organizerRouter.get('/events', listOrganizerEvents);
organizerRouter.post('/events', createOrganizerEvent);
organizerRouter.get('/events/:id', getOrganizerEventById);
organizerRouter.get('/events/:id/waitlist', handleGetOrganizerWaitlist);
organizerRouter.put('/events/:id', updateOrganizerEvent);
organizerRouter.post('/events/:id/publish', publishEvent);
organizerRouter.post('/events/:id/unpublish', unpublishEvent);
organizerRouter.post('/events/:id/cancel', cancelOrganizerEvent);
organizerRouter.delete('/events/:id', deleteOrganizerEvent);
organizerRouter.get('/series/:id', getOrganizerSeries);
organizerRouter.post('/series/:id/cancel', cancelOrganizerSeries);
