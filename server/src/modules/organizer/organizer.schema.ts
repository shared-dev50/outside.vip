import { z } from 'zod';
import { EventCategory, EventStatus, TicketTierStatus } from '@prisma/client';

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
}).refine((data) => data.maxPerOrder >= data.minPerOrder, {
  message: 'Max tickets per order must be greater than or equal to min tickets per order',
  path: ['maxPerOrder'],
});

export const createEventSchema = z.object({
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
}).refine(
  (data) => new Date(data.endAt).getTime() > new Date(data.startAt).getTime(),
  {
    message: 'Event end time must be after the start time',
    path: ['endAt'],
  }
);

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
});
