import { env } from '../../config/env.js';

export interface FinancialBreakdown {
  totalInCents: number;
  platformFeeInCents: number;
  organizerNetInCents: number;
  commissionPercent: number;
  commissionInCents?: number;
  organizerPayoutInCents?: number;
}

// Calculates platform commission and organizer payout breakdown in integer cents.
// Enforces invariant: platformFeeInCents + organizerNetInCents === totalInCents.
export function calculateFinancialBreakdown(
  totalInCents: number,
  commissionPercent: number = env.PLATFORM_COMMISSION_PERCENT
): FinancialBreakdown {
  if (totalInCents < 0) {
    throw new Error('Total amount cannot be negative');
  }

  if (commissionPercent < 0 || commissionPercent > 100) {
    throw new Error('Commission percentage must be between 0 and 100');
  }

  const platformFeeInCents = Math.round(totalInCents * (commissionPercent / 100));
  const organizerNetInCents = totalInCents - platformFeeInCents;

  if (platformFeeInCents + organizerNetInCents !== totalInCents) {
    throw new Error(
      `Financial discrepancy detected: ${platformFeeInCents} + ${organizerNetInCents} !== ${totalInCents}`
    );
  }

  return {
    totalInCents,
    platformFeeInCents,
    organizerNetInCents,
    commissionPercent,
    commissionInCents: platformFeeInCents,
    organizerPayoutInCents: organizerNetInCents,
  };
}

export const PLATFORM_FEE_PERCENT = 10; // 10%
export const SERVICE_FEE_CENTS = 95; // $0.95 per ticket
export const STRIPE_PERCENT = 0.029; // 2.9%
export const STRIPE_FIXED_CENTS = 30; // $0.30 per transaction

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

// Calculates fee breakdown and organizer earnings for a single ticket tier.
// Guarantee: buyerTotalInCents === organizerEarningsInCents + platformRevenueInCents + processingFeeInCents.
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

  // Gross-up buyer total to cover Stripe's 2.9% + $0.30 fee
  // BuyerTotal = (Subtotal + 30) / (1 - 0.029)
  const buyerTotalInCents = Math.round(
    (subtotalInCents + STRIPE_FIXED_CENTS) / (1 - STRIPE_PERCENT)
  );

  const processingFeeInCents = buyerTotalInCents - subtotalInCents;

  // Buyer pays all platform and processing fees; organizer retains 100% of face value
  const organizerEarningsInCents = safePrice;
  const platformRevenueInCents = platformFeeInCents + serviceFeeInCents;

  if (buyerTotalInCents !== organizerEarningsInCents + platformRevenueInCents + processingFeeInCents) {
    throw new Error('Reconciliation invariant failed in calculateTierEarnings');
  }

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

// Invariant: buyerTotalInCents === ticketSubtotalInCents + platformFeeInCents + serviceFeeInCents + processingFeeInCents
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

  // buyerTotal = (preProcessingTotal + 0.30) / (1 - 0.029)
  const buyerTotalInCents = Math.round(
    (preProcessingTotalInCents + STRIPE_FIXED_CENTS) / (1 - STRIPE_PERCENT)
  );

  const processingFeeInCents = buyerTotalInCents - preProcessingTotalInCents;
  const organizerEarningsInCents = ticketSubtotalInCents;
  const platformRevenueInCents = platformFeeInCents + serviceFeeInCents;

  // Enforce fund balance invariant
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

