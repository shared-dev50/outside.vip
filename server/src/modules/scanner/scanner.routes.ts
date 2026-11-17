import { Router } from 'express';
import { requireAuth, requireVerifiedEmail } from '../../middleware/auth.js';
import { checkInTicket } from '../organizer/organizer.controller.js';
import { getScannerGates } from './scanner.controller.js';

export const scannerRouter = Router();

scannerRouter.use(requireAuth);
scannerRouter.use(requireVerifiedEmail);

scannerRouter.get('/gates', getScannerGates);
scannerRouter.post('/check-in', checkInTicket);

