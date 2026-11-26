import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, evaluatePasswordPolicy } from './passwordPolicy.js';

export const passwordPolicySchema = z.string().superRefine((password, ctx) => {
  const evaluation = evaluatePasswordPolicy(password);
  for (const message of evaluation.errors) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message,
    });
  }
});

export const boundedPasswordPolicySchema = passwordPolicySchema.refine(
  (password) => password.length <= PASSWORD_MAX_LENGTH,
  `Password must be at most ${PASSWORD_MAX_LENGTH} characters long`
);

export const registerSchema = z.object({
  email: z.string().trim().email('Please provide a valid email address'),
  password: passwordPolicySchema,
  name: z.string().trim().min(2, 'Name must be at least 2 characters long'),
  role: z.string().optional(),
  organizerDisplayName: z.string().trim().min(2).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().email('Please provide a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const requestLoginOtpSchema = z.object({
  email: z.string().trim().email('Please provide a valid email address'),
});

export const verifyLoginOtpSchema = z.object({
  email: z.string().trim().email('Please provide a valid email address'),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Sign-in code must be a 6-digit number'),
});

export const verifyEmailSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Verification code must be a 6-digit number'),
  email: z.string().trim().email('Please provide a valid email address').optional(),
});

export const resendVerificationSchema = z.object({
  email: z.string().trim().email('Please provide a valid email address').optional(),
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters long').optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: passwordPolicySchema,
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email('Please provide a valid email address'),
});

export const validateResetTokenSchema = z.object({
  token: z.string().trim().min(1, 'Reset token is required'),
});

export const resetPasswordSchema = z
  .object({
    token: z.string().trim().min(1, 'Reset token is required'),
    newPassword: boundedPasswordPolicySchema,
    confirmPassword: z.string().optional(),
  })
  .refine(
    (data) => data.confirmPassword === undefined || data.newPassword === data.confirmPassword,
    {
      message: 'Passwords do not match',
      path: ['confirmPassword'],
    }
  );

export const updateUserStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']),
  reason: z.string().trim().max(500).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RequestLoginOtpInput = z.infer<typeof requestLoginOtpSchema>;
export type VerifyLoginOtpInput = z.infer<typeof verifyLoginOtpSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ValidateResetTokenInput = z.infer<typeof validateResetTokenSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>;
