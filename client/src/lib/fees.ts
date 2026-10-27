/**
 * Shared fee and organizer earnings calculation logic for Outside.vip.
 * All monetary amounts are computed authoritatively in integer minor currency units (cents).
 */

export const PLATFORM_FEE_PERCENT = 10; // 10% of ticket price
export const SERVICE_FEE_CENTS = 95; // $0.95 (95 cents per ticket paid by buyer)
export const STRIPE_PERCENT = 0.029; // 2.9%
export const STRIPE_FIXED_CENTS = 30; // $0.30 (30 cents per transaction)

export interface TierFeeBreakdown {
  /** Unit ticket price in cents set by organizer */
  ticketPriceInCents: number;
  /** Platform fee in cents (10% of ticket price) */
  platformFeeInCents: number;
  /** Fixed service fee in cents ($0.95 per ticket paid by buyer) */
  serviceFeeInCents: number;
  /** Pre-processing subtotal = ticketPrice + platformFee + serviceFee */
  subtotalInCents: number;
  /** Stripe payment processing fee in cents covering 2.9% + $0.30 */
  processingFeeInCents: number;
  /** Final estimated total charged to buyer per ticket */
  buyerTotalInCents: number;
  /** Organizer net earnings per ticket */
  organizerEarningsInCents: number;
  /** Platform net revenue per ticket = platformFee + serviceFee */
  platformRevenueInCents: number;
  /** Configured capacity of this tier */
  capacity: number;
  /** Projected organizer earnings at capacity = organizerEarningsInCents * capacity */
  projectedEarningsInCents: number;
  /** Projected gross buyer spend at capacity = buyerTotalInCents * capacity */
  projectedBuyerTotalInCents: number;
  /** Projected platform revenue at capacity = platformRevenueInCents * capacity */
  projectedPlatformRevenueInCents: number;
}

export interface CombinedEarningsBreakdown {
  tiers: TierFeeBreakdown[];
  totalCapacity: number;
  totalProjectedEarningsInCents: number;
  totalProjectedBuyerSpendInCents: number;
  totalProjectedPlatformRevenueInCents: number;
  totalProjectedProcessingFeesInCents: number;
}

/**
 * Calculates the fee breakdown and organizer earnings for a single ticket tier in integer cents.
 *
 * @param ticketPriceInCents Ticket price in cents (e.g. 2000 for $20.00)
 * @param capacity Configured capacity for this tier (defaults to 1)
 */
export function calculateTierEarnings(
  ticketPriceInCents: number,
  capacity: number = 1
): TierFeeBreakdown {
  const safePrice = Math.max(0, Math.round(ticketPriceInCents));
  const safeCapacity = Math.max(0, Math.round(capacity));

  if (safePrice === 0) {
    return {
      ticketPriceInCents: 0,
      platformFeeInCents: 0,
      serviceFeeInCents: 0,
      subtotalInCents: 0,
      processingFeeInCents: 0,
      buyerTotalInCents: 0,
      organizerEarningsInCents: 0,
      platformRevenueInCents: 0,
      capacity: safeCapacity,
      projectedEarningsInCents: 0,
      projectedBuyerTotalInCents: 0,
      projectedPlatformRevenueInCents: 0,
    };
  }

  // 1. Platform fee: 10% of ticket price
  const platformFeeInCents = Math.round(safePrice * (PLATFORM_FEE_PERCENT / 100));

  // 2. Service fee: $0.95 (95 cents), charged to the buyer
  const serviceFeeInCents = SERVICE_FEE_CENTS;

  // 3. Pre-processing subtotal
  const subtotalInCents = safePrice + platformFeeInCents + serviceFeeInCents;

  // 4. Estimated buyer total covering Stripe 2.9% + $0.30
  // Formula: BuyerTotal * (1 - 0.029) - 30 = Subtotal => BuyerTotal = (Subtotal + 30) / (1 - 0.029)
  const buyerTotalInCents = Math.round(
    (subtotalInCents + STRIPE_FIXED_CENTS) / (1 - STRIPE_PERCENT)
  );

  // Exact Stripe fee charged on final buyer charge
  const processingFeeInCents = buyerTotalInCents - subtotalInCents;

  // 5. Organizer earnings
  // The buyer pays platform fee, service fee, and processing fee.
  // The organizer receives 100% of their set ticket price.
  const organizerEarningsInCents = safePrice;
  const platformRevenueInCents = platformFeeInCents + serviceFeeInCents;

  return {
    ticketPriceInCents: safePrice,
    platformFeeInCents,
    serviceFeeInCents,
    subtotalInCents,
    processingFeeInCents,
    buyerTotalInCents,
    organizerEarningsInCents,
    platformRevenueInCents,
    capacity: safeCapacity,
    projectedEarningsInCents: organizerEarningsInCents * safeCapacity,
    projectedBuyerTotalInCents: buyerTotalInCents * safeCapacity,
    projectedPlatformRevenueInCents: platformRevenueInCents * safeCapacity,
  };
}

/**
 * Calculates combined projected earnings and platform revenue across all configured tiers.
 */
export function calculateCombinedEarnings(
  tiers: Array<{ priceInCents: number; capacity: number }>
): CombinedEarningsBreakdown {
  const breakdowns = tiers.map((t) => calculateTierEarnings(t.priceInCents, t.capacity));

  const totalCapacity = breakdowns.reduce((sum, b) => sum + b.capacity, 0);
  const totalProjectedEarningsInCents = breakdowns.reduce((sum, b) => sum + b.projectedEarningsInCents, 0);
  const totalProjectedBuyerSpendInCents = breakdowns.reduce((sum, b) => sum + b.projectedBuyerTotalInCents, 0);
  const totalProjectedPlatformRevenueInCents = breakdowns.reduce((sum, b) => sum + b.projectedPlatformRevenueInCents, 0);
  const totalProjectedProcessingFeesInCents = breakdowns.reduce(
    (sum, b) => sum + b.processingFeeInCents * b.capacity,
    0
  );

  return {
    tiers: breakdowns,
    totalCapacity,
    totalProjectedEarningsInCents,
    totalProjectedBuyerSpendInCents,
    totalProjectedPlatformRevenueInCents,
    totalProjectedProcessingFeesInCents,
  };
}

/**
 * Formats an amount in integer cents to a standard currency string (e.g. $20.00).
 */
export function formatCents(cents: number, currency: string = 'USD'): string {
  const safeCents = Number.isFinite(cents) ? cents : 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safeCents / 100);
}

export interface CheckoutFeeBreakdown {
  /** Sum of ticket prices × quantities in cents */
  ticketSubtotalInCents: number;
  /** Total ticket quantity across all tiers */
  totalTicketQuantity: number;
  /** Platform fee: 10% of ticket subtotal in cents */
  platformFeeInCents: number;
  /** Service fee: $0.95 (95 cents) per ticket × total quantity */
  serviceFeeInCents: number;
  /** Pre-processing subtotal = ticketSubtotal + platformFee + serviceFee */
  preProcessingTotalInCents: number;
  /** Estimated Stripe processing fee in cents covering 2.9% + $0.30 */
  processingFeeInCents: number;
  /** Final total payable by buyer in cents */
  buyerTotalInCents: number;
  /** Organizer net earnings in cents (= ticketSubtotal) */
  organizerEarningsInCents: number;
  /** Platform revenue in cents (= platformFee + serviceFee) */
  platformRevenueInCents: number;
}

/**
 * Calculates the comprehensive checkout fee breakdown for a buyer order in integer cents.
 * Supports passing either an array of tier items [{ priceInCents, quantity }] or (ticketSubtotalInCents, totalTicketQuantity).
 *
 * Invariant: buyerTotalInCents === ticketSubtotalInCents + platformFeeInCents + serviceFeeInCents + processingFeeInCents
 */
export function calculateCheckoutFeeBreakdown(
  itemsOrSubtotal:
    | Array<{ priceInCents?: number; unitPriceInCents?: number; quantity: number }>
    | number,
  quantity?: number
): CheckoutFeeBreakdown {
  let ticketSubtotalInCents = 0;
  let totalTicketQuantity = 0;

  if (Array.isArray(itemsOrSubtotal)) {
    for (const item of itemsOrSubtotal) {
      const unitPrice =
        typeof item.priceInCents === 'number'
          ? item.priceInCents
          : typeof item.unitPriceInCents === 'number'
          ? item.unitPriceInCents
          : 0;
      const p = Math.max(0, Math.round(unitPrice));
      const q = Math.max(0, Math.round(item.quantity || 0));
      ticketSubtotalInCents += p * q;
      totalTicketQuantity += q;
    }
  } else {
    ticketSubtotalInCents = Math.max(0, Math.round(itemsOrSubtotal || 0));
    totalTicketQuantity = Math.max(0, Math.round(quantity || 0));
  }

  // Free order or zero quantity
  if (ticketSubtotalInCents === 0 || totalTicketQuantity === 0) {
    return {
      ticketSubtotalInCents,
      totalTicketQuantity,
      platformFeeInCents: 0,
      serviceFeeInCents: 0,
      preProcessingTotalInCents: 0,
      processingFeeInCents: 0,
      buyerTotalInCents: 0,
      organizerEarningsInCents: 0,
      platformRevenueInCents: 0,
    };
  }

  // 1. Platform fee: 10% of ticket subtotal
  const platformFeeInCents = Math.round(ticketSubtotalInCents * (PLATFORM_FEE_PERCENT / 100));

  // 2. Service fee: $0.95 per ticket, multiplied by total ticket quantity
  const serviceFeeInCents = totalTicketQuantity * SERVICE_FEE_CENTS;

  // 3. Pre-processing total
  const preProcessingTotalInCents = ticketSubtotalInCents + platformFeeInCents + serviceFeeInCents;

  // 4. Estimated buyer total covering 2.9% + $0.30 per transaction
  // buyerTotal = (preProcessingTotal + 0.30) / (1 - 0.029)
  const buyerTotalInCents = Math.round(
    (preProcessingTotalInCents + STRIPE_FIXED_CENTS) / (1 - STRIPE_PERCENT)
  );

  // 5. Processing fee: exact difference to cover rounding reconciliation
  const processingFeeInCents = buyerTotalInCents - preProcessingTotalInCents;

  // 6. Fund allocation
  const organizerEarningsInCents = ticketSubtotalInCents;
  const platformRevenueInCents = platformFeeInCents + serviceFeeInCents;

  // Enforce mathematical fund balance invariant
  if (
    buyerTotalInCents !==
    organizerEarningsInCents + platformRevenueInCents + processingFeeInCents
  ) {
    throw new Error(
      `Financial discrepancy in checkout fee calculation: ${buyerTotalInCents} !== ${organizerEarningsInCents} + ${platformRevenueInCents} + ${processingFeeInCents}`
    );
  }

  return {
    ticketSubtotalInCents,
    totalTicketQuantity,
    platformFeeInCents,
    serviceFeeInCents,
    preProcessingTotalInCents,
    processingFeeInCents,
    buyerTotalInCents,
    organizerEarningsInCents,
    platformRevenueInCents,
  };
}
