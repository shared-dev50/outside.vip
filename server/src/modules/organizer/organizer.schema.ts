import { z } from 'zod';
import { EventCategory, EventStatus, TicketTierStatus, RecurrenceFrequency, EventFeatureType } from '@prisma/client';
import { extractYouTubeVideoId } from '../../utils/youtube.js';

export const galleryImageInputSchema = z.object({
  id: z.string().optional(),
  imageUrl: z
    .string()
    .min(1, 'Image URL is required')
    .refine((url) => !url.startsWith('data:image/'), {
      message: 'Base64 image data is not permitted',
    }),
  publicId: z.string().optional().nullable(),
  displayOrder: z.number().int().min(0).default(0),
});

export type GalleryImageInput = z.infer<typeof galleryImageInputSchema>;

export const eventFeatureInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, 'Feature name is required').max(150),
  type: z.nativeEnum(EventFeatureType).default(EventFeatureType.PERFORMER),
  imageUrl: z
    .string()
    .optional()
    .nullable()
    .refine((url) => !url || !url.startsWith('data:image/'), {
      message: 'Base64 image data is not permitted',
    }),
  imagePublicId: z.string().optional().nullable(),
  description: z.string().trim().max(500).optional().nullable(),
  displayOrder: z.number().int().min(0).default(0),
});

export type EventFeatureInput = z.infer<typeof eventFeatureInputSchema>;

export const ticketTierInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, 'Ticket name is required').max(100),
  description: z.string().optional().nullable(),
  priceInCents: z.number().int().min(0, 'Price must be 0 or greater'),
  currency: z.string().default('USD'),
  totalCapacity: z.number().int().min(1, 'Capacity must be at least 1'),
  minPerOrder: z.number().int().min(1, 'Min per order must be at least 1').default(1),
  maxPerOrder: z.number().int().min(1, 'Max per order must be at least 1').default(10),
  salesStartAt: z.string().datetime().optional().nullable(),
  salesEndAt: z.string().datetime().optional().nullable(),
  status: z.nativeEnum(TicketTierStatus).default(TicketTierStatus.ACTIVE),
  waitlistEnabled: z.boolean().default(false),
}).refine((data) => data.maxPerOrder >= data.minPerOrder, {
  message: 'Max tickets per order must be greater than or equal to min tickets per order',
  path: ['maxPerOrder'],
});

export const payoutDetailsInputSchema = z
  .object({
    // Organisation details
    orgType: z.enum(['Company', 'Partnership', 'NGO/Non-profit', 'Other'], {
      errorMap: () => ({ message: 'Please select a valid organisation type' }),
    }),
    orgTypeOther: z.string().optional().nullable(),
    registeredName: z.string().min(2, 'Registered organisation name must be at least 2 characters').max(200),
    registrationNumber: z.string().max(100).optional().nullable(),
    country: z.string().min(2, 'Country of registration is required').max(100),
    address: z.string().max(500).optional().nullable(),
    contactPersonName: z.string().min(2, "Authorised contact person's full name is required").max(150),
    contactEmail: z.string().email('Please enter a valid contact email').max(255),

    // Payout bank details
    accountHolderName: z.string().min(2, 'Account holder name is required').max(150),
    bankName: z.string().min(2, 'Bank name is required').max(150),
    bankCountry: z.string().min(2, 'Bank country is required').max(100),
    accountCurrency: z.string().min(3).max(10).default('USD'),
    accountNumber: z.string().min(4, 'Account number must be at least 4 digits').max(50).optional().nullable(),
    confirmAccountNumber: z.string().optional().nullable(),
    bankBranch: z.string().max(150).optional().nullable(),
    swiftBic: z.string().max(50).optional().nullable(),
    routingCode: z.string().max(50).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.orgType === 'Other' && (!data.orgTypeOther || !data.orgTypeOther.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Please specify the organisation type',
        path: ['orgTypeOther'],
      });
    }

    if (data.accountNumber && !data.accountNumber.startsWith('••••')) {
      if (data.accountNumber.trim().length < 4) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Account number must be at least 4 characters',
          path: ['accountNumber'],
        });
      }
      if (data.accountNumber !== data.confirmAccountNumber) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Account number and confirmation do not match',
          path: ['confirmAccountNumber'],
        });
      }
    }
  });

export type PayoutDetailsInput = z.infer<typeof payoutDetailsInputSchema>;

export const recurrenceRuleInputSchema = z
  .object({
    frequency: z.nativeEnum(RecurrenceFrequency),
    interval: z.number().int().min(1).max(12).default(1),
    byWeekday: z.array(z.number().int().min(0).max(6)).optional().default([]),
    endDate: z.string().datetime().optional().nullable(),
    count: z.number().int().min(1).max(52).optional().nullable(),
  })
  .refine((data) => data.endDate || data.count, {
    message: 'Recurrence rule must specify either an end date or a count of occurrences',
    path: ['count'],
  });

export type RecurrenceRuleInput = z.infer<typeof recurrenceRuleInputSchema>;

export const createEventSchema = z
  .object({
    title: z.string().min(2, 'Title must be at least 2 characters').max(200),
    tagline: z.string().max(300).optional().nullable(),
    description: z.string().default(''),
    category: z.nativeEnum(EventCategory).default(EventCategory.MUSIC),
    coverImageUrl: z
      .string()
      .min(1, 'Cover image URL is required')
      .refine((url) => !url.startsWith('data:image/'), {
        message: 'Base64 image data is not permitted. Please upload your image to obtain a Cloudinary URL.',
      }),
    coverImagePublicId: z.string().optional().nullable(),
    thumbnailUrl: z.string().optional().nullable(),
    venueName: z.string().default(''),
    venueAddress: z.string().default(''),
    city: z.string().default('Nairobi'),
    country: z.string().default('Kenya'),
    startAt: z.string().datetime().or(z.date()),
    endAt: z.string().datetime().or(z.date()),
    timezone: z.string().default('Africa/Nairobi'),
    ageRestriction: z.string().optional().nullable().default('18+'),
    dressCode: z.string().optional().nullable(),
    status: z.nativeEnum(EventStatus).default(EventStatus.DRAFT),
    ticketTiers: z.array(ticketTierInputSchema).default([]),
    payoutDetails: payoutDetailsInputSchema.optional().nullable(),
    recurrence: recurrenceRuleInputSchema.optional().nullable(),

    // New presentation & page settings
    youtubeVideoUrl: z
      .string()
      .trim()
      .optional()
      .nullable()
      .refine(
        (url) => !url || extractYouTubeVideoId(url) !== null,
        {
          message: 'Please provide a valid YouTube watch, youtu.be, or embed video URL',
        }
      ),
    showOnExplore: z.boolean().default(true),
    hideGuestCount: z.boolean().default(false),
    isPasswordProtected: z.boolean().default(false),
    password: z.string().min(4, 'Password must be at least 4 characters').max(100).optional().nullable(),
    galleryImages: z.array(galleryImageInputSchema).max(15, 'Maximum 15 gallery images allowed').default([]),
    features: z.array(eventFeatureInputSchema).max(30, 'Maximum 30 features allowed').default([]),
  })
  .superRefine((data, ctx) => {
    if (new Date(data.endAt).getTime() <= new Date(data.startAt).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Event end time must be after the start time',
        path: ['endAt'],
      });
    }
    if (data.isPasswordProtected && (!data.password || data.password.trim().length < 4)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Password is required when password protection is enabled (min 4 characters)',
        path: ['password'],
      });
    }
  });

export const updateEventSchema = z.object({
  title: z.string().min(2).max(200).optional(),
  tagline: z.string().max(300).optional().nullable(),
  description: z.string().optional(),
  category: z.nativeEnum(EventCategory).optional(),
  coverImageUrl: z.string().optional(),
  coverImagePublicId: z.string().optional().nullable(),
  thumbnailUrl: z.string().optional().nullable(),
  venueName: z.string().optional(),
  venueAddress: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  startAt: z.string().datetime().or(z.date()).optional(),
  endAt: z.string().datetime().or(z.date()).optional(),
  timezone: z.string().optional(),
  ageRestriction: z.string().optional().nullable(),
  dressCode: z.string().optional().nullable(),
  status: z.nativeEnum(EventStatus).optional(),
  ticketTiers: z.array(ticketTierInputSchema).optional(),
  payoutDetails: payoutDetailsInputSchema.optional().nullable(),
  recurrence: recurrenceRuleInputSchema.optional().nullable(),
  applyToFuture: z.boolean().optional().default(false),

  // New presentation & page settings
  youtubeVideoUrl: z
    .string()
    .trim()
    .optional()
    .nullable()
    .refine(
      (url) => !url || extractYouTubeVideoId(url) !== null,
      {
        message: 'Please provide a valid YouTube watch, youtu.be, or embed video URL',
      }
    ),
  showOnExplore: z.boolean().optional(),
  hideGuestCount: z.boolean().optional(),
  isPasswordProtected: z.boolean().optional(),
  password: z.string().min(4, 'Password must be at least 4 characters').max(100).optional().nullable(),
  galleryImages: z.array(galleryImageInputSchema).max(15).optional(),
  features: z.array(eventFeatureInputSchema).max(30).optional(),
});

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;

export const earningsPreviewInputSchema = z.object({
  tiers: z
    .array(
      z.object({
        priceInCents: z.number().int().min(0, 'Price must be 0 or greater'),
        capacity: z.number().int().min(1, 'Capacity must be at least 1').default(1),
      })
    )
    .min(1, 'At least one tier is required'),
});

export type EarningsPreviewInput = z.infer<typeof earningsPreviewInputSchema>;

