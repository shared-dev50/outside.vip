import { env } from '../../config/env.js';

export interface FinancialBreakdown {
  totalInCents: number;
  platformFeeInCents: number;
  organizerNetInCents: number;
  commissionPercent: number;
}

/**
 * Calculates integer-cents platform commission and organizer payout breakdown.
 * Enforces the invariant: platformFeeInCents + organizerNetInCents === totalInCents.
 *
 * @param totalInCents Gross order amount in minor currency units (cents)
 * @param commissionPercent Configurable platform commission rate (defaults to env or 5%)
 */
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

  // Calculate platform fee rounded to nearest integer cent
  const platformFeeInCents = Math.round(totalInCents * (commissionPercent / 100));
  const organizerNetInCents = totalInCents - platformFeeInCents;

  // Strict invariant validation
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
  };
}
