import { Router } from 'express';
import {
  handleJoinWaitlist,
  handleLookupWaitlistOffer,
  handleDeclineWaitlistOffer,
  handleWaitlistMaintenance,
} from './waitlist.controller.js';

export const waitlistRouter = Router();

// Public offer lookup & decline endpoints
waitlistRouter.get('/offers/:token', handleLookupWaitlistOffer);
waitlistRouter.post('/offers/:token/decline', handleDeclineWaitlistOffer);

// Maintenance sweep endpoint (for Render cron / external triggers)
waitlistRouter.post('/maintenance', handleWaitlistMaintenance);
