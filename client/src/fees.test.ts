import { describe, it, expect } from 'vitest';
import {
  calculateTierEarnings,
  calculateCombinedEarnings,
  calculateCheckoutFeeBreakdown,
  formatCents,
  PLATFORM_FEE_PERCENT,
  SERVICE_FEE_CENTS,
  STRIPE_PERCENT,
  STRIPE_FIXED_CENTS,
} from './lib/fees';

describe('Client Fees & Organizer Earnings Breakdown', () => {
  it('defines correct fee rule constants', () => {
    expect(PLATFORM_FEE_PERCENT).toBe(10);
    expect(SERVICE_FEE_CENTS).toBe(95);
    expect(STRIPE_PERCENT).toBe(0.029);
    expect(STRIPE_FIXED_CENTS).toBe(30);
  });

  describe('calculateTierEarnings', () => {
    it('returns zeroes for free tickets ($0.00)', () => {
      const breakdown = calculateTierEarnings(0, 100);

      expect(breakdown.ticketPriceInCents).toBe(0);
      expect(breakdown.platformFeeInCents).toBe(0);
      expect(breakdown.serviceFeeInCents).toBe(0);
      expect(breakdown.subtotalInCents).toBe(0);
      expect(breakdown.processingFeeInCents).toBe(0);
      expect(breakdown.buyerTotalInCents).toBe(0);
      expect(breakdown.organizerEarningsInCents).toBe(0);
      expect(breakdown.platformRevenueInCents).toBe(0);
      expect(breakdown.capacity).toBe(100);
      expect(breakdown.projectedEarningsInCents).toBe(0);
      expect(breakdown.projectedBuyerTotalInCents).toBe(0);
      expect(breakdown.projectedPlatformRevenueInCents).toBe(0);
    });

    it('correctly calculates breakdown for a $20.00 ticket with capacity 250', () => {
      // $20.00 = 2000 cents
      const priceInCents = 2000;
      const capacity = 250;
      const breakdown = calculateTierEarnings(priceInCents, capacity);

      // Platform fee: 10% of 2000 = 200 cents ($2.00)
      expect(breakdown.platformFeeInCents).toBe(200);

      // Service fee: fixed 95 cents ($0.95)
      expect(breakdown.serviceFeeInCents).toBe(95);

      // Subtotal before processing fee: 2000 + 200 + 95 = 2295 cents ($22.95)
      expect(breakdown.subtotalInCents).toBe(2295);

      // Grossed-up buyer total: Math.round((2295 + 30) / (1 - 0.029)) = Math.round(2325 / 0.971) = 2394 cents ($23.94)
      expect(breakdown.buyerTotalInCents).toBe(2394);

      // Processing fee: 2394 - 2295 = 99 cents ($0.99)
      expect(breakdown.processingFeeInCents).toBe(99);

      // Organizer earnings per ticket: 100% of ticket price = 2000 cents ($20.00)
      expect(breakdown.organizerEarningsInCents).toBe(2000);

      // Platform revenue: 200 + 95 = 295 cents ($2.95)
      expect(breakdown.platformRevenueInCents).toBe(295);

      // Projected earnings at capacity: 2000 * 250 = 500,000 cents ($5,000.00)
      expect(breakdown.projectedEarningsInCents).toBe(500000);

      // Projected buyer total at capacity: 2394 * 250 = 598,500 cents ($5,985.00)
      expect(breakdown.projectedBuyerTotalInCents).toBe(598500);

      // Projected platform revenue at capacity: 295 * 250 = 73,750 cents ($737.50)
      expect(breakdown.projectedPlatformRevenueInCents).toBe(73750);

      // Strict balance sheet reconciliation:
      // Buyer Total === Organizer Earnings + Platform Revenue + Processing Fee
      expect(breakdown.buyerTotalInCents).toBe(
        breakdown.organizerEarningsInCents +
          breakdown.platformRevenueInCents +
          breakdown.processingFeeInCents
      );
    });

    it('correctly calculates breakdown for a $75.00 VIP ticket with capacity 100', () => {
      // $75.00 = 7500 cents
      const priceInCents = 7500;
      const capacity = 100;
      const breakdown = calculateTierEarnings(priceInCents, capacity);

      // Platform fee: 10% of 7500 = 750 cents ($7.50)
      expect(breakdown.platformFeeInCents).toBe(750);
      expect(breakdown.serviceFeeInCents).toBe(95);

      // Subtotal: 7500 + 750 + 95 = 8345 cents ($83.45)
      expect(breakdown.subtotalInCents).toBe(8345);

      // Grossed-up buyer total: Math.round((8345 + 30) / (1 - 0.029)) = Math.round(8375 / 0.971) = 8625 cents ($86.25)
      expect(breakdown.buyerTotalInCents).toBe(8625);

      // Processing fee: 8625 - 8345 = 280 cents ($2.80)
      expect(breakdown.processingFeeInCents).toBe(280);

      // Organizer earnings per ticket = 7500 cents ($75.00)
      expect(breakdown.organizerEarningsInCents).toBe(7500);

      // Projected earnings: 7500 * 100 = 750,000 cents ($7,500.00)
      expect(breakdown.projectedEarningsInCents).toBe(750000);

      // Reconciliation
      expect(breakdown.buyerTotalInCents).toBe(
        breakdown.organizerEarningsInCents +
          breakdown.platformRevenueInCents +
          breakdown.processingFeeInCents
      );
    });

    it('handles rounding on awkward cents prices like $19.99 and $33.33', () => {
      const oddPrices = [1999, 3333, 100, 1, 99999];

      for (const price of oddPrices) {
        const breakdown = calculateTierEarnings(price, 50);

        // Integer cent verification
        expect(Number.isInteger(breakdown.ticketPriceInCents)).toBe(true);
        expect(Number.isInteger(breakdown.platformFeeInCents)).toBe(true);
        expect(Number.isInteger(breakdown.serviceFeeInCents)).toBe(true);
        expect(Number.isInteger(breakdown.processingFeeInCents)).toBe(true);
        expect(Number.isInteger(breakdown.buyerTotalInCents)).toBe(true);
        expect(Number.isInteger(breakdown.organizerEarningsInCents)).toBe(true);

        // Organizer receives exactly the base ticket price
        expect(breakdown.organizerEarningsInCents).toBe(price);

        // Balance sheet reconciliation holds exactly
        expect(breakdown.buyerTotalInCents).toBe(
          breakdown.organizerEarningsInCents +
            breakdown.platformFeeInCents +
            breakdown.serviceFeeInCents +
            breakdown.processingFeeInCents
        );
      }
    });
  });

  describe('calculateCombinedEarnings', () => {
    it('returns empty summary for empty tier list', () => {
      const combined = calculateCombinedEarnings([]);
      expect(combined.tiers).toEqual([]);
      expect(combined.totalCapacity).toBe(0);
      expect(combined.totalProjectedEarningsInCents).toBe(0);
      expect(combined.totalProjectedBuyerSpendInCents).toBe(0);
      expect(combined.totalProjectedPlatformRevenueInCents).toBe(0);
      expect(combined.totalProjectedProcessingFeesInCents).toBe(0);
    });

    it('aggregates multiple tiers correctly and reconciles projected total funds', () => {
      const tiers = [
        { priceInCents: 2500, capacity: 250 }, // $25.00 x 250 = $6,250.00
        { priceInCents: 7500, capacity: 100 }, // $75.00 x 100 = $7,500.00
        { priceInCents: 0, capacity: 50 },    // Free x 50 = $0.00
      ];

      const combined = calculateCombinedEarnings(tiers);

      expect(combined.tiers.length).toBe(3);
      expect(combined.totalCapacity).toBe(400);

      // Total organizer earnings = 2500 * 250 + 7500 * 100 + 0 * 50 = 625,000 + 750,000 = 1,375,000 cents ($13,750.00)
      expect(combined.totalProjectedEarningsInCents).toBe(1375000);

      // Check sum of tier projected totals
      const sumTierEarnings = combined.tiers.reduce((acc, t) => acc + t.projectedEarningsInCents, 0);
      const sumTierBuyerSpend = combined.tiers.reduce((acc, t) => acc + t.projectedBuyerTotalInCents, 0);
      const sumTierPlatformRev = combined.tiers.reduce((acc, t) => acc + t.projectedPlatformRevenueInCents, 0);
      const sumTierProcFees = combined.tiers.reduce((acc, t) => acc + t.processingFeeInCents * t.capacity, 0);

      expect(combined.totalProjectedEarningsInCents).toBe(sumTierEarnings);
      expect(combined.totalProjectedBuyerSpendInCents).toBe(sumTierBuyerSpend);
      expect(combined.totalProjectedPlatformRevenueInCents).toBe(sumTierPlatformRev);
      expect(combined.totalProjectedProcessingFeesInCents).toBe(sumTierProcFees);

      // Invariant: Total Buyer Spend === Total Organizer Payout + Total Platform Revenue + Total Processing Fees
      expect(combined.totalProjectedBuyerSpendInCents).toBe(
        combined.totalProjectedEarningsInCents +
          combined.totalProjectedPlatformRevenueInCents +
          combined.totalProjectedProcessingFeesInCents
      );
    });
  });

  describe('formatCents', () => {
    it('formats cents as standard USD currency string', () => {
      expect(formatCents(2000)).toBe('$20.00');
      expect(formatCents(2394)).toBe('$23.94');
      expect(formatCents(95)).toBe('$0.95');
      expect(formatCents(0)).toBe('$0.00');
      expect(formatCents(500000)).toBe('$5,000.00');
    });

    it('handles negative or invalid values gracefully', () => {
      expect(formatCents(-100)).toBe('-$1.00');
      expect(formatCents(NaN)).toBe('$0.00');
    });
  });

  describe('calculateCheckoutFeeBreakdown', () => {
    it('returns all zeroes when total quantity or subtotal is zero', () => {
      const breakdown1 = calculateCheckoutFeeBreakdown(0, 0);
      expect(breakdown1.ticketSubtotalInCents).toBe(0);
      expect(breakdown1.platformFeeInCents).toBe(0);
      expect(breakdown1.serviceFeeInCents).toBe(0);
      expect(breakdown1.processingFeeInCents).toBe(0);
      expect(breakdown1.buyerTotalInCents).toBe(0);
      expect(breakdown1.organizerEarningsInCents).toBe(0);

      const breakdown2 = calculateCheckoutFeeBreakdown([]);
      expect(breakdown2.buyerTotalInCents).toBe(0);

      // Free tickets ($0 ticket price with quantity > 0)
      const breakdownFree = calculateCheckoutFeeBreakdown(0, 5);
      expect(breakdownFree.ticketSubtotalInCents).toBe(0);
      expect(breakdownFree.buyerTotalInCents).toBe(0);
      expect(breakdownFree.processingFeeInCents).toBe(0);
    });

    it('calculates the exact breakdown for a single $20.00 ticket', () => {
      // 1 ticket @ $20.00 (2000 cents)
      const breakdown = calculateCheckoutFeeBreakdown(2000, 1);

      // 1. Ticket subtotal
      expect(breakdown.ticketSubtotalInCents).toBe(2000);
      expect(breakdown.totalTicketQuantity).toBe(1);

      // 2. Platform fee: 10% of $20.00 = $2.00 (200 cents)
      expect(breakdown.platformFeeInCents).toBe(200);

      // 3. Service fee: $0.95 x 1 = $0.95 (95 cents)
      expect(breakdown.serviceFeeInCents).toBe(95);

      // Pre-processing total: 2000 + 200 + 95 = 2295 cents ($22.95)
      expect(breakdown.preProcessingTotalInCents).toBe(2295);

      // 4. Grossed-up buyer total: Math.round((2295 + 30) / (1 - 0.029)) = Math.round(2325 / 0.971) = 2394 cents ($23.94)
      expect(breakdown.buyerTotalInCents).toBe(2394);

      // 5. Estimated Stripe processing fee: 2394 - 2295 = 99 cents ($0.99)
      expect(breakdown.processingFeeInCents).toBe(99);

      // Organizer receives 100% of ticket price
      expect(breakdown.organizerEarningsInCents).toBe(2000);

      // Platform revenue: platform fee + service fee = 200 + 95 = 295 cents ($2.95)
      expect(breakdown.platformRevenueInCents).toBe(295);

      // Exact fund reconciliation:
      // buyerTotal === ticketSubtotal + platformFee + serviceFee + processingFee
      expect(breakdown.buyerTotalInCents).toBe(
        breakdown.ticketSubtotalInCents +
          breakdown.platformFeeInCents +
          breakdown.serviceFeeInCents +
          breakdown.processingFeeInCents
      );
    });

    it('calculates the exact breakdown for multiple tickets in one transaction (2 x $20.00)', () => {
      // 2 tickets @ $20.00 = 4000 cents
      const breakdown = calculateCheckoutFeeBreakdown(4000, 2);

      expect(breakdown.ticketSubtotalInCents).toBe(4000);
      expect(breakdown.totalTicketQuantity).toBe(2);

      // Platform fee: 10% of 4000 = 400 cents ($4.00)
      expect(breakdown.platformFeeInCents).toBe(400);

      // Service fee: $0.95 x 2 = 190 cents ($1.90)
      expect(breakdown.serviceFeeInCents).toBe(190);

      // Pre-processing total: 4000 + 400 + 190 = 4590 cents ($45.90)
      expect(breakdown.preProcessingTotalInCents).toBe(4590);

      // Buyer total: Math.round((4590 + 30) / 0.971) = Math.round(4620 / 0.971) = 4758 cents ($47.58)
      expect(breakdown.buyerTotalInCents).toBe(4758);

      // Processing fee: 4758 - 4590 = 168 cents ($1.68)
      expect(breakdown.processingFeeInCents).toBe(168);

      // Strict balance check
      expect(breakdown.buyerTotalInCents).toBe(
        breakdown.ticketSubtotalInCents +
          breakdown.platformFeeInCents +
          breakdown.serviceFeeInCents +
          breakdown.processingFeeInCents
      );
    });

    it('calculates breakdown for multiple tier selections supplied as an item array', () => {
      // 1 x $25.00 ticket + 2 x $50.00 tickets = 3 tickets, $125.00 subtotal (12500 cents)
      const items = [
        { unitPriceInCents: 2500, quantity: 1 },
        { unitPriceInCents: 5000, quantity: 2 },
      ];

      const breakdown = calculateCheckoutFeeBreakdown(items);

      expect(breakdown.ticketSubtotalInCents).toBe(12500);
      expect(breakdown.totalTicketQuantity).toBe(3);

      // Platform fee: 10% of 12500 = 1250 cents ($12.50)
      expect(breakdown.platformFeeInCents).toBe(1250);

      // Service fee: 3 x 95 = 285 cents ($2.85)
      expect(breakdown.serviceFeeInCents).toBe(285);

      // Pre-processing total: 12500 + 1250 + 285 = 14035 cents ($140.35)
      expect(breakdown.preProcessingTotalInCents).toBe(14035);

      // Buyer total: Math.round((14035 + 30) / 0.971) = Math.round(14065 / 0.971) = 14485 cents ($144.85)
      expect(breakdown.buyerTotalInCents).toBe(14485);

      // Processing fee: 14485 - 14035 = 450 cents ($4.50)
      expect(breakdown.processingFeeInCents).toBe(450);

      // Reconciliation
      expect(breakdown.buyerTotalInCents).toBe(
        breakdown.ticketSubtotalInCents +
          breakdown.platformFeeInCents +
          breakdown.serviceFeeInCents +
          breakdown.processingFeeInCents
      );
    });

    it('dynamically updates as quantity changes from 1 to 5', () => {
      const ticketPrice = 3500; // $35.00
      let previousTotal = 0;

      for (let qty = 1; qty <= 5; qty++) {
        const subtotal = ticketPrice * qty;
        const b = calculateCheckoutFeeBreakdown(subtotal, qty);

        expect(b.totalTicketQuantity).toBe(qty);
        expect(b.ticketSubtotalInCents).toBe(subtotal);
        expect(b.platformFeeInCents).toBe(Math.round(subtotal * 0.10));
        expect(b.serviceFeeInCents).toBe(qty * 95);

        // Buyer total must increase monotonically
        expect(b.buyerTotalInCents).toBeGreaterThan(previousTotal);
        previousTotal = b.buyerTotalInCents;

        // Reconciliation invariant holds at each quantity step
        expect(b.buyerTotalInCents).toBe(
          b.ticketSubtotalInCents +
            b.platformFeeInCents +
            b.serviceFeeInCents +
            b.processingFeeInCents
        );
      }
    });

    it('handles rounding safely on odd prices ($19.99, $33.33, $0.01)', () => {
      const awkwardPrices = [1999, 3333, 1, 99999];

      for (const price of awkwardPrices) {
        for (const qty of [1, 3, 7]) {
          const subtotal = price * qty;
          const b = calculateCheckoutFeeBreakdown(subtotal, qty);

          // All values must be integer cents
          expect(Number.isInteger(b.ticketSubtotalInCents)).toBe(true);
          expect(Number.isInteger(b.platformFeeInCents)).toBe(true);
          expect(Number.isInteger(b.serviceFeeInCents)).toBe(true);
          expect(Number.isInteger(b.processingFeeInCents)).toBe(true);
          expect(Number.isInteger(b.buyerTotalInCents)).toBe(true);

          // Strict reconciliation holds with 0 discrepancy
          expect(b.buyerTotalInCents).toBe(
            b.ticketSubtotalInCents +
              b.platformFeeInCents +
              b.serviceFeeInCents +
              b.processingFeeInCents
          );
        }
      }
    });

    it('prevents duplicate fee application and ensures Stripe fees cover the gross transaction', () => {
      const subtotal = 5000; // $50.00
      const qty = 1;
      const b = calculateCheckoutFeeBreakdown(subtotal, qty);

      // Platform fee is 10% of ticket subtotal ONLY (not applied to service fee or processing fee)
      expect(b.platformFeeInCents).toBe(500);

      // Service fee is charged per ticket only ($0.95 * 1)
      expect(b.serviceFeeInCents).toBe(95);

      // The Stripe processing fee is grossed up to cover the whole charged transaction
      // Math.round((5595 + 30) / 0.971) = Math.round(5625 / 0.971) = 5793 cents ($57.93)
      expect(b.buyerTotalInCents).toBe(5793);
      expect(b.processingFeeInCents).toBe(198);

      // When Stripe charges 2.9% + $0.30 on the buyerTotal:
      // 5793 * 0.029 + 30 = 167.997 + 30 = 197.997 -> rounds to 198 cents ($1.98)!
      const expectedStripeCut = Math.round(b.buyerTotalInCents * STRIPE_PERCENT + STRIPE_FIXED_CENTS);
      expect(b.processingFeeInCents).toBe(expectedStripeCut);

      // After Stripe takes its cut, the net proceeds exactly equal preProcessingTotal
      expect(b.buyerTotalInCents - expectedStripeCut).toBe(b.preProcessingTotalInCents);
    });
  });
});
