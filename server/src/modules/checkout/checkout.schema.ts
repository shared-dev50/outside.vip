import { z } from 'zod';

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
  customerPhone: z.string().trim().max(30).optional(),
  idempotencyKey: z.string().trim().max(100).optional(),
});

export type CreateCheckoutSessionInput = z.infer<typeof createCheckoutSessionSchema>;
