import { z } from 'zod';

export const onboardingLinkSchema = z.object({
  returnUrl: z.string().url().optional(),
  refreshUrl: z.string().url().optional(),
  reconnect: z.boolean().optional(),
});

export const loginLinkSchema = z.object({
  returnUrl: z.string().url().optional(),
});

export const updatePayoutScheduleSchema = z.object({
  interval: z.enum(['manual', 'daily', 'weekly', 'monthly']),
  weeklyAnchor: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']).optional(),
  monthlyAnchor: z.number().int().min(1).max(31).optional(),
  delayDays: z.number().int().min(0).max(30).optional(),
});

export const withdrawFundsSchema = z.object({
  amountInCents: z.number().int().min(100, 'Minimum withdrawal amount is $1.00 (100 cents).'),
  idempotencyKey: z.string().min(1).max(100).optional(),
  notes: z.string().max(255).optional(),
});

export const adminWithdrawFundsSchema = z.object({
  organizerId: z.string().uuid('Valid organizer user ID is required.'),
  amountInCents: z.number().int().min(100, 'Minimum withdrawal amount is $1.00 (100 cents).'),
  idempotencyKey: z.string().min(1).max(100).optional(),
  notes: z.string().max(255).optional(),
});
