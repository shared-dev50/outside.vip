import { Router } from 'express';
import {
  handleJoinWaitlist,
  handleLookupWaitlistOffer,
  handleDeclineWaitlistOffer,
  handleWaitlistMaintenance,
} from './waitlist.controller.js';
import { requireMaintenanceAuth } from '../../middleware/maintenanceAuth.js';

export const waitlistRouter = Router();

waitlistRouter.get('/offers/:token', handleLookupWaitlistOffer);
waitlistRouter.post('/offers/:token/decline', handleDeclineWaitlistOffer);

// Maintenance sweep endpoint (for Render cron / external triggers)
waitlistRouter.post('/maintenance', requireMaintenanceAuth, handleWaitlistMaintenance);
