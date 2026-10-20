import { Router } from 'express';
import {
  getOrderByOrderNumber,
  downloadOrderTicketsPdf,
  downloadSingleTicketPdf,
} from './orders.controller.js';

export const ordersRouter = Router();

ordersRouter.get('/:orderNumber', getOrderByOrderNumber);
ordersRouter.get('/:orderNumber/tickets/pdf', downloadOrderTicketsPdf);
ordersRouter.get('/:orderNumber/tickets/:ticketId/pdf', downloadSingleTicketPdf);
