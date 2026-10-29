import { Router } from 'express';
import { listEvents, getEventBySlug, getFeaturedEvents, getCities, verifyEventPassword } from './events.controller.js';
import { handleJoinWaitlist } from '../waitlist/waitlist.controller.js';

export const eventsRouter = Router();

eventsRouter.get('/', listEvents);
eventsRouter.get('/featured', getFeaturedEvents);
eventsRouter.get('/cities', getCities);
eventsRouter.get('/:slug', getEventBySlug);
eventsRouter.post('/:slug/verify-password', verifyEventPassword);
eventsRouter.post('/:slug/waitlist', handleJoinWaitlist);

