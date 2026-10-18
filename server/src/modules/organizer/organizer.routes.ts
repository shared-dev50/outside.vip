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
} from './organizer.controller.js';

export const organizerRouter = Router();

// Protect all organizer endpoints with auth & role middleware
organizerRouter.use(requireAuth);
organizerRouter.use(requireRole(Role.ORGANIZER, Role.ADMIN));

organizerRouter.get('/dashboard', getDashboardStats);
organizerRouter.get('/events', listOrganizerEvents);
organizerRouter.post('/events', createOrganizerEvent);
organizerRouter.get('/events/:id', getOrganizerEventById);
organizerRouter.put('/events/:id', updateOrganizerEvent);
organizerRouter.post('/events/:id/publish', publishEvent);
organizerRouter.post('/events/:id/unpublish', unpublishEvent);
organizerRouter.delete('/events/:id', deleteOrganizerEvent);
