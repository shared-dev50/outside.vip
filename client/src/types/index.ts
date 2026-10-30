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

export type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  interval: number;
  byWeekday?: number[];
  endDate?: string | null;
  count?: number | null;
}

export interface EventSeriesSummary {
  id: string;
  title: string;
  frequency: RecurrenceFrequency;
  interval: number;
  byWeekday?: number[];
  startDate?: string;
  endDate?: string | null;
  count?: number | null;
  timezone?: string;
  occurrencesCount?: number;
  events?: Array<{
    id: string;
    slug: string;
    occurrenceIndex?: number | null;
    startAt: string;
    endAt: string;
    status?: string;
    isCustomized?: boolean;
  }>;
  occurrences?: Array<{
    id: string;
    slug: string;
    occurrenceIndex?: number | null;
    startAt: string;
    endAt: string;
    status?: string;
    isCustomized?: boolean;
    totalCapacity?: number;
    ticketsSold?: number;
  }>;
}

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
  waitlistEnabled?: boolean;
  waitlistWaitingCount?: number;
  waitlistOfferedCount?: number;
}

export type EventFeatureType = 'PERFORMER' | 'SPONSOR' | 'SPEAKER' | 'HOST' | 'OTHER';

export interface EventGalleryImage {
  id?: string;
  eventId?: string;
  imageUrl: string;
  publicId?: string | null;
  displayOrder: number;
}

export interface EventFeature {
  id?: string;
  eventId?: string;
  name: string;
  type: EventFeatureType;
  imageUrl?: string | null;
  imagePublicId?: string | null;
  description?: string | null;
  displayOrder: number;
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
  coverImagePublicId?: string | null;
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
  showOnExplore?: boolean;
  hideGuestCount?: boolean;
  guestCount?: number | null;
  isPasswordProtected?: boolean;
  hasAccess?: boolean;
  youtubeVideoId?: string | null;
  youtubeVideoUrl?: string | null;
  galleryImages?: EventGalleryImage[];
  features?: EventFeature[];
  ticketTiers: TicketTier[];
  payoutDetails?: OrganizerPayoutDetails | null;
  seriesId?: string | null;
  occurrenceIndex?: number | null;
  isCustomized?: boolean;
  series?: EventSeriesSummary | null;
  minPriceInCents?: number;
  currency?: string;
  isSoldOut?: boolean;
}

export type OrgType = 'Company' | 'Partnership' | 'NGO/Non-profit' | 'Other';

export interface OrganizerPayoutDetails {
  id: string;
  userId: string;
  orgType: OrgType;
  orgTypeOther?: string | null;
  registeredName: string;
  registrationNumber?: string | null;
  country: string;
  address?: string | null;
  contactPersonName: string;
  contactEmail: string;
  accountHolderName: string;
  bankName: string;
  bankCountry: string;
  accountCurrency: string;
  accountNumberMasked: string;
  accountNumberLast4: string;
  bankBranch?: string | null;
  swiftBic?: string | null;
  routingCode?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface PayoutDetailsInput {
  orgType: OrgType;
  orgTypeOther?: string | null;
  registeredName: string;
  registrationNumber?: string | null;
  country: string;
  address?: string | null;
  contactPersonName: string;
  contactEmail: string;
  accountHolderName: string;
  bankName: string;
  bankCountry: string;
  accountCurrency: string;
  accountNumber?: string | null;
  confirmAccountNumber?: string | null;
  bankBranch?: string | null;
  swiftBic?: string | null;
  routingCode?: string | null;
}

export interface HumanReadableRequirement {
  code: string;
  description: string;
}

export interface SanitizedExternalAccount {
  id: string;
  bankName: string;
  accountHolderName: string;
  last4: string;
  routingNumber: string | null;
  currency: string;
  isDefault: boolean;
  status: string;
}

export interface StripeConnectedAccountStatus {
  connected: boolean;
  stripeAccountId: string | null;
  connectionStatus?: 'connected' | 'not_connected' | 'invalid_or_inaccessible' | 'configuration_unavailable' | 'service_unavailable';
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  sellTickets: {
    enabled: boolean;
    status: 'enabled' | 'action_required' | 'disabled';
    message: string;
  };
  transferBalance: {
    enabled: boolean;
    status: 'enabled' | 'action_required' | 'disabled';
    message: string;
  };
  requirements: {
    currentlyDue: HumanReadableRequirement[];
    eventuallyDue: HumanReadableRequirement[];
    pastDue: HumanReadableRequirement[];
    disabledReason: string | null;
    pendingVerification: string[];
    rawCurrentlyDue: string[];
  };
  payoutSchedule: {
    interval: 'manual' | 'daily' | 'weekly' | 'monthly';
    delayDays: number;
    weeklyAnchor: string | null;
    monthlyAnchor: number | null;
  } | null;
  externalAccounts: SanitizedExternalAccount[];
  defaultCurrency: string;
  country: string | null;
}

export interface StripeBalanceCurrencyItem {
  amount: number;
  currency: string;
  sourceTypes?: Record<string, number>;
}

export interface StripeBalanceResponse {
  currency?: string;
  pendingInCents?: number;
  availableInCents?: number;
  netAvailableInCents?: number;
  transferredInCents?: number;
  lifetimeEarningsInCents?: number;
  recoverableInCents?: number;
  lastSettledAt?: string | null;
  stripeBalance?: {
    available: StripeBalanceCurrencyItem[];
    pending: StripeBalanceCurrencyItem[];
  } | null;
  available?: StripeBalanceCurrencyItem[];
  pending?: StripeBalanceCurrencyItem[];
}

export interface OrganizerTransferItem {
  id: string;
  transferNumber: string;
  stripeTransferId: string | null;
  amountInCents: number;
  currency: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REVERSED';
  sourceType: 'MANUAL_ORGANIZER_REQUEST' | 'ADMIN_INITIATED' | 'AUTOMATIC_SCHEDULED';
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  initiatedBy?: {
    id: string;
    name: string;
    email: string;
    role: string;
  } | null;
}

export interface FinancialLedgerEntryItem {
  id: string;
  entryType: string;
  balanceType: string;
  amountInCents: number;
  currency: string;
  description: string;
  createdAt: string;
  event?: { id: string; title: string; slug: string } | null;
  order?: { id: string; orderNumber: string } | null;
  stripeReferenceId?: string | null;
}

export interface WithdrawalRequestPayload {
  amountInCents: number;
  idempotencyKey?: string;
  notes?: string;
}

export interface WithdrawalResponse {
  transferId: string;
  transferNumber: string;
  stripeTransferId: string | null;
  amountInCents: number;
  currency: string;
  status: string;
  sourceType: string;
  remainingAvailableInCents: number;
  transferredInCents: number;
  createdAt: string;
}

export interface StripePayoutItem {
  id: string;
  amount: number;
  currency: string;
  status: string;
  arrivalDate: string | null;
  created: string;
  destination: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}

export interface StripeDisputeItem {
  id: string;
  amount: number;
  currency: string;
  status: string;
  reason: string;
  created: string;
  dueBy: string | null;
  isChargeRefundable: boolean;
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
  platformFeeInCents?: number;
  organizerNetInCents?: number;
  orderAccessToken?: string | null;
  items: OrderItem[];
  tickets: Ticket[];
  expiresAt: string;
  createdAt: string;
}

export interface CheckoutSessionInput {
  eventId: string;
  items: Array<{
    ticketTierId: string;
    quantity: number;
  }>;
  customerEmail: string;
  customerName: string;
  customerPhone?: string;
  idempotencyKey?: string;
  eventAccessToken?: string;
  offerToken?: string;
}

export type WaitlistEntryStatus =
  | 'WAITING'
  | 'OFFERED'
  | 'PURCHASED'
  | 'EXPIRED'
  | 'DECLINED'
  | 'CANCELLED';

export type WaitlistOfferStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'EXPIRED'
  | 'DECLINED'
  | 'CANCELLED';

export interface WaitlistOfferInfo {
  token: string;
  ticketTierId: string;
  tierName: string;
  quantity: number;
  unitPriceInCents: number;
  totalInCents: number;
  currency: string;
  status: WaitlistOfferStatus;
  expiresAt: string;
  event: {
    id: string;
    slug: string;
    title: string;
    startAt: string;
    venueName?: string | null;
  };
  customerName: string;
  customerEmail: string;
}

export interface JoinWaitlistInput {
  ticketTierId: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  quantity: number;
}

export interface JoinWaitlistResult {
  entry: {
    id: string;
    ticketTierId: string;
    customerName: string;
    customerEmail: string;
    quantity: number;
    status: WaitlistEntryStatus;
    position: number;
  };
  message: string;
}

export interface OrganizerWaitlistEntry {
  id: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string | null;
  quantity: number;
  status: WaitlistEntryStatus;
  createdAt: string;
  ticketTier: {
    id: string;
    name: string;
    priceInCents: number;
  };
  offers: Array<{
    id: string;
    status: WaitlistOfferStatus;
    expiresAt: string;
    createdAt: string;
  }>;
}

export interface OrganizerWaitlistResponse {
  entries: OrganizerWaitlistEntry[];
  tierSummaries: Array<{
    tierId: string;
    tierName: string;
    waitlistEnabled: boolean;
    totalCapacity: number;
    soldQuantity: number;
    reservedQuantity: number;
    waitingCount: number;
    offeredCount: number;
    purchasedCount: number;
    expiredCount: number;
    declinedCount: number;
  }>;
}

export interface CheckoutSessionResult {
  orderNumber: string;
  orderAccessToken: string;
  clientSecret: string;
  publishableKey?: string;
  totalInCents: number;
  currency: string;
  expiresAt: string;
  breakdown?: import('../lib/fees').CheckoutFeeBreakdown;
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

export type {
  TierFeeBreakdown,
  CombinedEarningsBreakdown,
  CheckoutFeeBreakdown,
} from '../lib/fees';


