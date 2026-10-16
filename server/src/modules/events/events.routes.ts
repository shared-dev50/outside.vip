import { Router } from 'express';
import { listEvents, getEventBySlug, getFeaturedEvents, getCities } from './events.controller.js';

export const eventsRouter = Router();

eventsRouter.get('/', listEvents);
eventsRouter.get('/featured', getFeaturedEvents);
eventsRouter.get('/cities', getCities);
eventsRouter.get('/:slug', getEventBySlug);
