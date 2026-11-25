import { z } from 'zod';
import { RefundFeeBearer } from '@prisma/client';

export const refundOrderParamsSchema = z.object({
  orderId: z.string().trim().min(1, 'Order ID is required'),
});

export const previewOrderRefundBodySchema = z.object({
  ticketIds: z
    .array(z.string().trim().min(1))
    .min(1, 'Select at least one ticket to preview a refund')
    .max(100, 'At most 100 tickets may be selected per refund'),
  refundStripeProcessingFee: z.boolean().optional().default(false),
  feeBearer: z
    .enum([RefundFeeBearer.ORGANIZER, RefundFeeBearer.PLATFORM, RefundFeeBearer.SHARED])
    .optional(),
  restoreInventory: z.boolean().optional().default(true),
  allowCheckedInOverride: z.boolean().optional().default(false),
  overrideReason: z.string().trim().max(500).optional(),
});

export const initiateOrderRefundBodySchema = z.object({
  ticketIds: z
    .array(z.string().trim().min(1))
    .min(1, 'Select at least one ticket to refund')
    .max(100, 'At most 100 tickets may be selected per refund'),
  reason: z
    .string()
    .trim()
    .min(3, 'A refund reason (minimum 3 characters) is required')
    .max(500, 'Refund reason must be 500 characters or fewer'),
  refundStripeProcessingFee: z.boolean().optional().default(false),
  feeBearer: z
    .enum([RefundFeeBearer.ORGANIZER, RefundFeeBearer.PLATFORM, RefundFeeBearer.SHARED])
    .optional(),
  restoreInventory: z.boolean().optional().default(true),
  allowCheckedInOverride: z.boolean().optional().default(false),
  overrideReason: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
  confirm: z
    .boolean()
    .refine((val) => val === true, { message: 'Explicit confirmation is required to issue a refund.' }),
});

export type PreviewOrderRefundBody = z.infer<typeof previewOrderRefundBodySchema>;
export type InitiateOrderRefundBody = z.infer<typeof initiateOrderRefundBodySchema>;
