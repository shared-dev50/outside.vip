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
  getUploadSignature,
  handleDirectUpload,
} from './organizer.controller.js';
import { uploadCoverMiddleware } from '../../middleware/upload.js';

export const organizerRouter = Router();

// Protect all organizer endpoints with auth & role middleware
organizerRouter.use(requireAuth);
organizerRouter.use(requireRole(Role.ORGANIZER, Role.ADMIN));

organizerRouter.post('/upload/sign', getUploadSignature);
organizerRouter.post('/upload', uploadCoverMiddleware.single('image'), handleDirectUpload);

organizerRouter.get('/dashboard', getDashboardStats);
organizerRouter.get('/events', listOrganizerEvents);
organizerRouter.post('/events', createOrganizerEvent);
organizerRouter.get('/events/:id', getOrganizerEventById);
organizerRouter.put('/events/:id', updateOrganizerEvent);
organizerRouter.post('/events/:id/publish', publishEvent);
organizerRouter.post('/events/:id/unpublish', unpublishEvent);
organizerRouter.delete('/events/:id', deleteOrganizerEvent);
