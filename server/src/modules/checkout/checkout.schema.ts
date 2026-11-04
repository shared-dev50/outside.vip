import { z } from 'zod';
import { normalizePhoneNumber } from '../../utils/phone.js';

export const checkoutItemSchema = z.object({
  ticketTierId: z.string().min(1, 'Ticket tier ID is required'),
  quantity: z
    .number()
    .int('Quantity must be an integer')
    .min(1, 'Quantity must be at least 1')
    .max(50, 'Cannot exceed 50 tickets in a single checkout'),
});

export const createCheckoutSessionSchema = z.object({
  eventId: z.string().min(1, 'Event ID is required'),
  items: z
    .array(checkoutItemSchema)
    .min(1, 'At least one ticket tier must be selected'),
  customerEmail: z.string().email('A valid email address is required'),
  customerName: z.string().trim().min(1, 'Full name is required').max(100),
  customerPhone: z
    .string({ required_error: 'Phone number is required' })
    .trim()
    .min(1, 'Phone number is required')
    .superRefine((val, ctx) => {
      const res = normalizePhoneNumber(val);
      if (!res.isValid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: res.error || 'Please enter a valid phone number (e.g. +1 555-123-4567 or +254 712 345678).',
        });
      }
    })
    .transform((val) => {
      const res = normalizePhoneNumber(val);
      return res.normalized || val;
    }),
  marketingConsent: z.boolean().optional().default(false),
  idempotencyKey: z.string().trim().max(100).optional(),
  eventAccessToken: z.string().optional(),
  offerToken: z.string().optional(),
});

export type CreateCheckoutSessionInput = z.infer<typeof createCheckoutSessionSchema>;
