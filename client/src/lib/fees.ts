/**
 * Shared fee and organizer earnings calculation logic for Outside.vip.
 * All monetary amounts are computed authoritatively in integer minor currency units (cents).
 */

export const PLATFORM_FEE_PERCENT = 10; // 10% of ticket price
export const SERVICE_FEE_CENTS = 95; // $0.95 (95 cents per ticket paid by buyer)
export const STRIPE_PERCENT = 0.029; // 2.9%
export const STRIPE_FIXED_CENTS = 30; // $0.30 (30 cents per transaction)

export interface TierFeeBreakdown {
  ticketPriceInCents: number;
  platformFeeInCents: number;
  serviceFeeInCents: number;
  subtotalInCents: number;
  processingFeeInCents: number;
  buyerTotalInCents: number;
  organizerEarningsInCents: number;
  platformRevenueInCents: number;
  capacity: number;
  projectedEarningsInCents: number;
  projectedBuyerTotalInCents: number;
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

  const platformFeeInCents = Math.round(safePrice * (PLATFORM_FEE_PERCENT / 100));
  const serviceFeeInCents = SERVICE_FEE_CENTS;
  const subtotalInCents = safePrice + platformFeeInCents + serviceFeeInCents;

  // Gross-up buyer charge to cover Stripe 2.9% + $0.30
  // Formula: BuyerTotal = (Subtotal + 30) / (1 - 0.029)
  const buyerTotalInCents = Math.round(
    (subtotalInCents + STRIPE_FIXED_CENTS) / (1 - STRIPE_PERCENT)
  );

  const processingFeeInCents = buyerTotalInCents - subtotalInCents;

  // Organizer receives 100% of face value; buyer absorbs fees
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
  ticketSubtotalInCents: number;
  totalTicketQuantity: number;
  platformFeeInCents: number;
  serviceFeeInCents: number;
  preProcessingTotalInCents: number;
  processingFeeInCents: number;
  buyerTotalInCents: number;
  organizerEarningsInCents: number;
  platformRevenueInCents: number;
}

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

  const platformFeeInCents = Math.round(ticketSubtotalInCents * (PLATFORM_FEE_PERCENT / 100));
  const serviceFeeInCents = totalTicketQuantity * SERVICE_FEE_CENTS;
  const preProcessingTotalInCents = ticketSubtotalInCents + platformFeeInCents + serviceFeeInCents;

  // Formula: BuyerTotal = (PreProcessingTotal + 0.30) / (1 - 0.029)
  const buyerTotalInCents = Math.round(
    (preProcessingTotalInCents + STRIPE_FIXED_CENTS) / (1 - STRIPE_PERCENT)
  );

  const processingFeeInCents = buyerTotalInCents - preProcessingTotalInCents;
  const organizerEarningsInCents = ticketSubtotalInCents;
  const platformRevenueInCents = platformFeeInCents + serviceFeeInCents;

  // Financial balance invariant
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
