import { z } from 'zod';
import { EventCategory, EventStatus, TicketTierStatus } from '@prisma/client';
import { calculateGrossPriceFromDisplay } from '../checkout/checkout.financials.js';

export const listEventsQuerySchema = z.object({
  search: z.string().optional(),
  category: z.nativeEnum(EventCategory).optional(),
  city: z.string().optional(),
  featuredOnly: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  timeFilter: z.enum(['upcoming', 'this_weekend', 'this_month', 'all']).default('upcoming'),
  sortBy: z.enum(['date_asc', 'date_desc', 'price_asc', 'price_desc']).default('date_asc').optional(),
  page: z.string().optional().default('1').transform((v) => Math.max(1, parseInt(v, 10) || 1)),
  limit: z.string().optional().default('12').transform((v) => Math.min(50, Math.max(1, parseInt(v, 10) || 12))),
});

export const createTicketTierBaseSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, 'Tier name is required'),
  description: z.string().optional(),
  priceInCents: z.number().int().min(0, 'Price must be 0 or positive').optional(),
  displayPriceInCents: z.number().int().min(0, 'Display price must be 0 or positive').optional().nullable(),
  currency: z.string().default('USD'),
  totalCapacity: z.number().int().min(1, 'Capacity must be at least 1'),
  minPerOrder: z.number().int().min(1).default(1),
  maxPerOrder: z.number().int().min(1).default(10),
  salesStartAt: z.string().datetime().optional().nullable(),
  salesEndAt: z.string().datetime().optional().nullable(),
  validityStartAt: z.string().datetime().optional().nullable(),
  validityEndAt: z.string().datetime().optional().nullable(),
  status: z.nativeEnum(TicketTierStatus).default(TicketTierStatus.ACTIVE),
});

export const createTicketTierSchema = createTicketTierBaseSchema
  .refine(
    (data) => {
      if (data.salesStartAt && data.salesEndAt) {
        return new Date(data.salesStartAt) < new Date(data.salesEndAt);
      }
      return true;
    },
    {
      message: 'Sales start time must precede sales end time',
      path: ['salesEndAt'],
    }
  )
  .refine(
    (data) => {
      if (data.validityStartAt && data.validityEndAt) {
        return new Date(data.validityStartAt) < new Date(data.validityEndAt);
      }
      return true;
    },
    {
      message: 'Ticket validity start time must precede validity end time',
      path: ['validityEndAt'],
    }
  )
  .transform((data) => {
    let priceInCents = data.priceInCents;
    if (priceInCents === undefined || priceInCents === null) {
      if (data.displayPriceInCents !== undefined && data.displayPriceInCents !== null) {
        priceInCents = calculateGrossPriceFromDisplay(data.displayPriceInCents);
      } else {
        priceInCents = 0;
      }
    }
    return {
      ...data,
      priceInCents,
    };
  });

export const createEventSchema = z.object({
  title: z.string().min(3, 'Title must be at least 3 characters'),
  tagline: z.string().optional(),
  description: z.string().min(10, 'Description must be at least 10 characters'),
  category: z.nativeEnum(EventCategory).default(EventCategory.MUSIC),
  coverImageUrl: z.string().url('Cover image must be a valid URL'),
  thumbnailUrl: z.string().url().optional(),
  venueName: z.string().min(2, 'Venue name is required'),
  venueAddress: z.string().min(3, 'Venue address is required'),
  city: z.string().min(2, 'City is required'),
  country: z.string().default('United States'),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  timezone: z.string().default('America/New_York'),
  ageRestriction: z.string().default('18+'),
  dressCode: z.string().optional(),
  ticketTiers: z.array(createTicketTierSchema).min(1, 'At least one ticket tier is required'),
  status: z.nativeEnum(EventStatus).default(EventStatus.DRAFT),
});

export const updateEventSchema = createEventSchema.partial().extend({
  ticketTiers: z.array(createTicketTierSchema).optional(),
});

export const verifyEventPasswordSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;
export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
export type VerifyEventPasswordInput = z.infer<typeof verifyEventPasswordSchema>;

