import { Request, Response, NextFunction } from 'express';
import { UnauthorizedError } from '../../utils/errors.js';
import {
  initiateOrderRefundBodySchema,
  previewOrderRefundBodySchema,
  refundOrderParamsSchema,
} from './refund.schema.js';
import {
  getOrderRefundSummary,
  initiateOrderTicketRefund,
  previewOrderTicketRefund,
} from './refund.service.js';

function getActorContext(req: Request) {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required.');
  }
  return {
    userId: req.user.userId,
    role: req.user.role,
    email: req.user.email,
  };
}

export async function handleGetOrderRefunds(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const actor = getActorContext(req);
    const { orderId } = refundOrderParamsSchema.parse(req.params);
    const summary = await getOrderRefundSummary(orderId, actor);

    res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    next(error);
  }
}

export async function handlePreviewOrderRefund(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const actor = getActorContext(req);
    const { orderId } = refundOrderParamsSchema.parse(req.params);
    const body = previewOrderRefundBodySchema.parse(req.body);
    const quote = await previewOrderTicketRefund(orderId, actor, body);

    res.json({
      success: true,
      data: quote,
    });
  } catch (error) {
    next(error);
  }
}

export async function handleInitiateOrderRefund(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const actor = getActorContext(req);
    const { orderId } = refundOrderParamsSchema.parse(req.params);
    const body = initiateOrderRefundBodySchema.parse(req.body);
    const headerKeyRaw = req.header('idempotency-key') || req.header('Idempotency-Key');

    const result = await initiateOrderTicketRefund(orderId, actor, body, {
      headerIdempotencyKey: headerKeyRaw?.trim() || undefined,
      ipAddress: req.ip || null,
    });

    const statusCode =
      result.mode === 'STRIPE_REFUND_QUEUED' && !result.replayed ? 202 : 200;

    res.status(statusCode).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
