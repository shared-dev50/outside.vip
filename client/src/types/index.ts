export type Role = 'ATTENDEE' | 'ORGANIZER' | 'ADMIN';

export type EventCategory =
  | 'MUSIC'
  | 'NIGHTLIFE'
  | 'FESTIVAL'
  | 'TECH'
  | 'ARTS_CULTURE'
  | 'FOOD_DRINK'
  | 'SPORTS'
  | 'COMMUNITY';

export type EventStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'CANCELLED';

export type TicketTierStatus = 'ACTIVE' | 'PAUSED' | 'SOLD_OUT' | 'HIDDEN';

export type OrderStatus = 'PENDING' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED' | 'REFUNDED';

export type TicketStatus = 'ISSUED' | 'CHECKED_IN' | 'CANCELLED' | 'REFUNDED';

export type CheckInResult =
  | 'SUCCESS'
  | 'ALREADY_CHECKED_IN'
  | 'INVALID_TOKEN'
  | 'WRONG_EVENT'
  | 'CANCELLED_TICKET';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  avatarUrl?: string | null;
  organizer?: OrganizerProfile | null;
}

export interface OrganizerProfile {
  id: string;
  displayName: string;
  slug: string;
  bio?: string | null;
  websiteUrl?: string | null;
  instagramHandle?: string | null;
  twitterHandle?: string | null;
  logoUrl?: string | null;
}

export interface TicketTier {
  id: string;
  eventId: string;
  name: string;
  description?: string | null;
  priceInCents: number;
  currency: string;
  totalCapacity: number;
  reservedQuantity: number;
  soldQuantity: number;
  remainingCapacity?: number;
  minPerOrder: number;
  maxPerOrder: number;
  salesStartAt?: string | null;
  salesEndAt?: string | null;
  status: TicketTierStatus;
  isAvailable?: boolean;
}

export interface Event {
  id: string;
  slug: string;
  organizerId: string;
  organizer: {
    id: string;
    name: string;
    avatarUrl?: string | null;
    organizer?: {
      displayName: string;
      slug: string;
      bio?: string | null;
      websiteUrl?: string | null;
      instagramHandle?: string | null;
      twitterHandle?: string | null;
      logoUrl?: string | null;
    } | null;
  };
  title: string;
  tagline?: string | null;
  description: string;
  category: EventCategory;
  status: EventStatus;
  coverImageUrl: string;
  thumbnailUrl?: string | null;
  venueName: string;
  venueAddress: string;
  city: string;
  country: string;
  latitude?: number | null;
  longitude?: number | null;
  startAt: string;
  endAt: string;
  timezone: string;
  ageRestriction?: string | null;
  dressCode?: string | null;
  isFeatured: boolean;
  ticketTiers: TicketTier[];
  minPriceInCents?: number;
  currency?: string;
  isSoldOut?: boolean;
}

export interface OrderItem {
  id: string;
  orderId: string;
  ticketTierId: string;
  ticketTier: TicketTier;
  quantity: number;
  unitPriceInCents: number;
  subtotalInCents: number;
}

export interface Ticket {
  id: string;
  ticketToken: string;
  orderId: string;
  eventId: string;
  event?: Event;
  ticketTierId: string;
  ticketTier?: TicketTier;
  attendeeName: string;
  attendeeEmail: string;
  status: TicketStatus;
  checkedInAt?: string | null;
  createdAt: string;
}

export interface Order {
  id: string;
  orderNumber: string;
  userId?: string | null;
  eventId: string;
  event?: Event;
  status: OrderStatus;
  customerEmail: string;
  customerName: string;
  customerPhone?: string | null;
  totalInCents: number;
  currency: string;
  items: OrderItem[];
  tickets: Ticket[];
  expiresAt: string;
  createdAt: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: {
    message: string;
    statusCode: number;
    details?: Array<{ field: string; message: string }>;
  };
}

export interface EventListResponse {
  events: Event[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
  };
}

export interface OrganizerDashboardStats {
  totalEvents: number;
  publishedEvents: number;
  draftEvents: number;
  ticketsSold: number;
  grossRevenueInCents: number;
  grossRevenueFormatted: string;
  currency: string;
}

export interface OrganizerEventItem extends Event {
  totalCapacity: number;
  ticketsSold: number;
  revenueInCents: number;
  revenueFormatted: string;
}

