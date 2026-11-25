import { TicketTier, TicketTierStatus } from '../types';
import { calculateDisplayPriceFromGross, MIN_PAID_DISPLAY_PRICE_CENTS } from './fees';

export interface FormTicketTier {
  id?: string;
  tempId: string;
  name: string;
  description: string;
  price: number | ''; // Gross price in dollars (organizer receives)
  displayPrice: number | ''; // All-in customer-facing price in dollars
  totalCapacity: number | '';
  minPerOrder: number | '';
  maxPerOrder: number | '';
  hasSalesPeriod?: boolean;
  salesStartAt: string;
  salesEndAt: string;
  hasTicketValidity?: boolean;
  validityStartAt?: string;
  validityEndAt?: string;
  status: TicketTierStatus;
  isHidden: boolean;
  salesDisabled: boolean;
  soldQuantity?: number;
  waitlistEnabled?: boolean;
  waitlistWaitingCount?: number;
  waitlistOfferedCount?: number;
}

export interface TicketTierFieldErrors {
  name?: string;
  price?: string;
  displayPrice?: string;
  totalCapacity?: string;
  minPerOrder?: string;
  maxPerOrder?: string;
  salesPeriod?: string;
  validityPeriod?: string;
}

export interface TicketTiersValidationResult {
  isValid: boolean;
  summaryError: string | null;
  tierErrors: Record<string, TicketTierFieldErrors>;
}

export function createEmptyTicketTier(tempId?: string): FormTicketTier {
  return {
    tempId: tempId || `tier-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    description: '',
    price: '',
    displayPrice: '',
    totalCapacity: '',
    minPerOrder: '',
    maxPerOrder: '',
    hasSalesPeriod: false,
    salesStartAt: '',
    salesEndAt: '',
    hasTicketValidity: false,
    validityStartAt: '',
    validityEndAt: '',
    status: 'ACTIVE',
    isHidden: false,
    salesDisabled: false,
    waitlistEnabled: false,
  };
}

export function mapExistingTicketTierToForm(
  tier: TicketTier,
  eventTimezone: string,
  toInputValueInTimezone: (dateString?: string | null, tz?: string) => string
): FormTicketTier {
  const grossPrice = tier.priceInCents / 100;
  const displayPrice =
    tier.displayPriceInCents !== undefined
      ? tier.displayPriceInCents / 100
      : calculateDisplayPriceFromGross(tier.priceInCents) / 100;
  const hasSales = Boolean(tier.salesStartAt || tier.salesEndAt);
  const hasValidity = Boolean(tier.validityStartAt || tier.validityEndAt);
  const isHidden = Boolean(tier.isHidden) || tier.status === 'HIDDEN';
  const salesDisabled = Boolean(tier.salesDisabled) || tier.status === 'PAUSED';

  return {
    id: tier.id,
    tempId: tier.id,
    name: tier.name,
    description: tier.description || '',
    price: grossPrice,
    displayPrice,
    totalCapacity: tier.totalCapacity,
    minPerOrder: tier.minPerOrder,
    maxPerOrder: tier.maxPerOrder,
    hasSalesPeriod: hasSales,
    salesStartAt: toInputValueInTimezone(tier.salesStartAt, eventTimezone),
    salesEndAt: toInputValueInTimezone(tier.salesEndAt, eventTimezone),
    hasTicketValidity: hasValidity,
    validityStartAt: toInputValueInTimezone(tier.validityStartAt, eventTimezone),
    validityEndAt: toInputValueInTimezone(tier.validityEndAt, eventTimezone),
    status: tier.status,
    isHidden,
    salesDisabled,
    soldQuantity: tier.soldQuantity,
    waitlistEnabled: Boolean(tier.waitlistEnabled),
    waitlistWaitingCount: tier.waitlistWaitingCount || 0,
    waitlistOfferedCount: tier.waitlistOfferedCount || 0,
  };
}

export function getSubMinimumDisplayPriceError(
  displayPrice: number | '' | null | undefined
): string | null {
  if (displayPrice === '' || displayPrice === null || displayPrice === undefined) {
    return null;
  }
  const numeric = Number(displayPrice);
  if (isNaN(numeric) || numeric <= 0) {
    return null;
  }
  const displayCents = Math.round(numeric * 100);
  if (displayCents > 0 && displayCents < MIN_PAID_DISPLAY_PRICE_CENTS) {
    return `Paid tickets must have an all-in display price of at least $${(
      MIN_PAID_DISPLAY_PRICE_CENTS / 100
    ).toFixed(2)} (or enter 0 for a free ticket).`;
  }
  return null;
}

export function validateSingleTicketTier(
  tier: FormTicketTier,
  index: number
): { errors: TicketTierFieldErrors; firstMessage: string | null } {
  const errors: TicketTierFieldErrors = {};
  const label = tier.name.trim() ? `"${tier.name.trim()}"` : `Ticket #${index + 1}`;
  let firstMessage: string | null = null;

  const setErr = (field: keyof TicketTierFieldErrors, fieldMsg: string, summaryMsg: string) => {
    if (!errors[field]) {
      errors[field] = fieldMsg;
    }
    if (!firstMessage) {
      firstMessage = summaryMsg;
    }
  };

  if (!tier.name.trim()) {
    setErr('name', 'Ticket name is required.', `Please enter a ticket name for ${label}.`);
  }

  const subMinimumDisplayError = getSubMinimumDisplayPriceError(tier.displayPrice);
  if (subMinimumDisplayError) {
    setErr('displayPrice', subMinimumDisplayError, `${subMinimumDisplayError} (${label})`);
  }

  if (tier.price === '' || tier.price === null || tier.price === undefined) {
    if (!subMinimumDisplayError) {
      setErr(
        'price',
        'Price is required (enter 0 for free).',
        `Please enter a price for ${label} (enter 0 for a free ticket).`
      );
    }
  } else if (isNaN(Number(tier.price)) || Number(tier.price) < 0) {
    setErr(
      'price',
      'Price must be 0 or greater.',
      `Please provide a valid price for ${label} (enter 0 for free admission).`
    );
  } else if (
    Math.round(Number(tier.price) * 100) === 0 &&
    tier.displayPrice !== '' &&
    tier.displayPrice !== null &&
    tier.displayPrice !== undefined &&
    Math.round(Number(tier.displayPrice) * 100) > 0
  ) {
    setErr(
      'displayPrice',
      'Display price must be $0.00 for a free ticket tier.',
      `Display price must be $0.00 for a free ticket tier (${label}).`
    );
  }

  if (tier.totalCapacity === '' || tier.totalCapacity === null || tier.totalCapacity === undefined) {
    setErr(
      'totalCapacity',
      'Quantity is required.',
      `Please enter a ticket quantity for ${label}.`
    );
  } else if (!Number.isInteger(Number(tier.totalCapacity)) || Number(tier.totalCapacity) < 1) {
    setErr(
      'totalCapacity',
      'Quantity must be at least 1.',
      `Quantity for ${label} must be a whole number of at least 1.`
    );
  } else if (tier.soldQuantity && Number(tier.totalCapacity) < tier.soldQuantity) {
    setErr(
      'totalCapacity',
      `Cannot be less than ${tier.soldQuantity} already sold.`,
      `Quantity for ${label} cannot be less than the ${tier.soldQuantity} ticket(s) already sold.`
    );
  }

  if (tier.minPerOrder !== '' && tier.minPerOrder !== null && tier.minPerOrder !== undefined) {
    if (!Number.isInteger(Number(tier.minPerOrder)) || Number(tier.minPerOrder) < 1) {
      setErr('minPerOrder', 'Min must be at least 1.', `Min per order for ${label} must be at least 1.`);
    }
  }

  if (tier.maxPerOrder !== '' && tier.maxPerOrder !== null && tier.maxPerOrder !== undefined) {
    if (!Number.isInteger(Number(tier.maxPerOrder)) || Number(tier.maxPerOrder) < 1) {
      setErr('maxPerOrder', 'Max must be at least 1.', `Max per order for ${label} must be at least 1.`);
    }
  }

  if (
    tier.minPerOrder !== '' &&
    tier.maxPerOrder !== '' &&
    Number(tier.maxPerOrder) < Number(tier.minPerOrder)
  ) {
    setErr(
      'maxPerOrder',
      'Max cannot be less than min.',
      `Max per order cannot be less than min per order for ${label}.`
    );
  }

  if (tier.hasSalesPeriod && tier.salesStartAt && tier.salesEndAt) {
    const startMs = new Date(tier.salesStartAt).getTime();
    const endMs = new Date(tier.salesEndAt).getTime();
    if (endMs <= startMs) {
      setErr(
        'salesPeriod',
        'Sales start time must precede sales end time.',
        `Sales start time must precede sales end time for ${label}.`
      );
    }
  }

  if (tier.hasTicketValidity && tier.validityStartAt && tier.validityEndAt) {
    const startMs = new Date(tier.validityStartAt).getTime();
    const endMs = new Date(tier.validityEndAt).getTime();
    if (endMs <= startMs) {
      setErr(
        'validityPeriod',
        'Validity start time must precede validity end time.',
        `Ticket validity start time must precede validity end time for ${label}.`
      );
    }
  }

  return { errors, firstMessage };
}

export function validateTicketTiers(
  tiers: FormTicketTier[],
  options: { requireAtLeastOne: boolean; requireVisibleForPublish?: boolean }
): TicketTiersValidationResult {
  const tierErrors: Record<string, TicketTierFieldErrors> = {};

  if (options.requireAtLeastOne && tiers.length === 0) {
    return {
      isValid: false,
      summaryError: options.requireVisibleForPublish
        ? 'At least one ticket is required to publish your event.'
        : 'Please add at least one ticket before continuing.',
      tierErrors,
    };
  }

  let firstSummaryError: string | null = null;

  tiers.forEach((tier, idx) => {
    const { errors, firstMessage } = validateSingleTicketTier(tier, idx);
    if (Object.keys(errors).length > 0) {
      tierErrors[tier.tempId] = errors;
      if (!firstSummaryError && firstMessage) {
        firstSummaryError = firstMessage;
      }
    }
  });

  if (firstSummaryError) {
    return {
      isValid: false,
      summaryError: firstSummaryError,
      tierErrors,
    };
  }

  if (options.requireVisibleForPublish) {
    const hasVisibleTier = tiers.some(
      (t) => !t.isHidden && Number(t.totalCapacity) > 0
    );
    if (!hasVisibleTier) {
      return {
        isValid: false,
        summaryError: 'At least one visible (non-hidden) ticket with positive quantity is required to publish.',
        tierErrors,
      };
    }
  }

  return {
    isValid: true,
    summaryError: null,
    tierErrors,
  };
}

export function deriveTicketTierStatus(tier: Pick<FormTicketTier, 'isHidden' | 'salesDisabled' | 'status'>): TicketTierStatus {
  if (tier.isHidden) return 'HIDDEN';
  if (tier.salesDisabled) return 'PAUSED';
  if (tier.status === 'SOLD_OUT') return 'SOLD_OUT';
  return 'ACTIVE';
}

export function buildTicketTierPayload(
  tier: FormTicketTier,
  eventTz: string,
  toIsoValueInTimezone: (localString?: string | null, tz?: string) => string | null
) {
  const priceInCents = Math.round(Number(tier.price) * 100);
  const displayPriceInCents = calculateDisplayPriceFromGross(priceInCents);
  const minPerOrder =
    tier.minPerOrder === '' || tier.minPerOrder === null || tier.minPerOrder === undefined
      ? 1
      : Math.max(1, Number(tier.minPerOrder));
  const rawMax =
    tier.maxPerOrder === '' || tier.maxPerOrder === null || tier.maxPerOrder === undefined
      ? Math.max(10, minPerOrder)
      : Number(tier.maxPerOrder);
  const maxPerOrder = Math.max(minPerOrder, rawMax);

  return {
    ...(tier.id ? { id: tier.id } : {}),
    name: tier.name.trim(),
    description: tier.description.trim() || null,
    priceInCents,
    displayPriceInCents,
    currency: 'USD',
    totalCapacity: Number(tier.totalCapacity),
    minPerOrder,
    maxPerOrder,
    salesStartAt: tier.hasSalesPeriod && tier.salesStartAt ? toIsoValueInTimezone(tier.salesStartAt, eventTz) : null,
    salesEndAt: tier.hasSalesPeriod && tier.salesEndAt ? toIsoValueInTimezone(tier.salesEndAt, eventTz) : null,
    validityStartAt:
      tier.hasTicketValidity && tier.validityStartAt ? toIsoValueInTimezone(tier.validityStartAt, eventTz) : null,
    validityEndAt:
      tier.hasTicketValidity && tier.validityEndAt ? toIsoValueInTimezone(tier.validityEndAt, eventTz) : null,
    status: deriveTicketTierStatus(tier),
    isHidden: Boolean(tier.isHidden),
    salesDisabled: Boolean(tier.salesDisabled),
    waitlistEnabled: Boolean(tier.waitlistEnabled),
  };
}

export function computeVisibleMinDisplayPrice(tiers: FormTicketTier[]): number | null {
  const pricedVisible = tiers.filter((t) => !t.isHidden && t.price !== '' && !isNaN(Number(t.price)));
  const activePricedVisible = pricedVisible.filter((t) => !t.salesDisabled);
  const candidates = activePricedVisible.length > 0 ? activePricedVisible : pricedVisible;
  if (candidates.length === 0) return null;

  return Math.min(
    ...candidates.map((t) => {
      const p = Number(t.price);
      return p > 0 ? calculateDisplayPriceFromGross(Math.round(p * 100)) / 100 : 0;
    })
  );
}
