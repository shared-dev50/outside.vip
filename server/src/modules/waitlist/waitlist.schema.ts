import { z } from 'zod';

export const joinWaitlistSchema = z.object({
  ticketTierId: z.string().min(1, 'Ticket tier ID is required'),
  customerName: z.string().trim().min(1, 'Full name is required').max(100),
  customerEmail: z.string().trim().email('A valid email address is required'),
  customerPhone: z.string().trim().max(30).optional().nullable(),
  quantity: z
    .number()
    .int('Quantity must be an integer')
    .min(1, 'Quantity must be at least 1')
    .max(50, 'Cannot exceed 50 tickets'),
});

export type JoinWaitlistInputSchema = z.infer<typeof joinWaitlistSchema>;
