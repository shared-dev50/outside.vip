import { Router } from 'express';
import { handleCreateCheckoutSession, handleCleanupReservations } from './checkout.controller.js';
import { requireMaintenanceAuth } from '../../middleware/maintenanceAuth.js';

export const checkoutRouter = Router();

checkoutRouter.post('/create-session', handleCreateCheckoutSession);
checkoutRouter.post('/cleanup-reservations', requireMaintenanceAuth, handleCleanupReservations);
