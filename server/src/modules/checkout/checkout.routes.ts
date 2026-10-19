import { Router } from 'express';
import { handleCreateCheckoutSession, handleCleanupReservations } from './checkout.controller.js';

export const checkoutRouter = Router();

checkoutRouter.post('/create-session', handleCreateCheckoutSession);
checkoutRouter.post('/cleanup-reservations', handleCleanupReservations);
