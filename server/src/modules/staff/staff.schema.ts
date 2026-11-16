import { z } from 'zod';

export const inviteStaffSchema = z.object({
  email: z.string().trim().email('A valid email address is required'),
});

export const eventStaffParamsSchema = z
  .object({
    eventId: z.string().trim().min(1).optional(),
    id: z.string().trim().min(1).optional(),
  })
  .refine((data) => Boolean(data.eventId || data.id), {
    message: 'Event ID is required',
  });

export const eventInvitationParamsSchema = z
  .object({
    eventId: z.string().trim().min(1).optional(),
    id: z.string().trim().min(1).optional(),
    invitationId: z.string().trim().min(1, 'Invitation ID is required'),
  })
  .refine((data) => Boolean(data.eventId || data.id), {
    message: 'Event ID is required',
  });

export const eventStaffMemberParamsSchema = z
  .object({
    eventId: z.string().trim().min(1).optional(),
    id: z.string().trim().min(1).optional(),
    userId: z.string().trim().min(1, 'User ID is required'),
  })
  .refine((data) => Boolean(data.eventId || data.id), {
    message: 'Event ID is required',
  });

export const invitationTokenParamSchema = z.object({
  token: z.string().trim().min(1, 'Invitation token is required'),
});

export const verifyStaffOtpSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'A valid 6-digit verification code is required'),
});

export type InviteStaffInput = z.infer<typeof inviteStaffSchema>;
export type VerifyStaffOtpInput = z.infer<typeof verifyStaffOtpSchema>;
