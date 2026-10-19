import { Router } from 'express';
import { getOrderByOrderNumber } from './orders.controller.js';

export const ordersRouter = Router();

ordersRouter.get('/:orderNumber', getOrderByOrderNumber);
