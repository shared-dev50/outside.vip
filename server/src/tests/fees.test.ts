import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import {
  calculateTierEarnings,
  calculateCombinedEarnings,
  calculateFinancialBreakdown,
  calculateCheckoutFeeBreakdown,
  PLATFORM_FEE_PERCENT,
  SERVICE_FEE_CENTS,
  STRIPE_PERCENT,
  STRIPE_FIXED_CENTS,
} from '../modules/checkout/checkout.financials.js';

describe('Organizer Earnings & Fee Calculations (Server)', () => {
  let organizerToken: string;

  beforeAll(() => {
    // Generate valid organizer JWT token directly without database dependency
    organizerToken = jwt.sign(
      {
        userId: 'organizer-test-id',
        email: 'sol@outside.vip',
        role: 'ORGANIZER',
      },
      env.JWT_SECRET,
      { expiresIn: '1h' }
    );
  });

  it('defines correct fee rule constants and backwards-compatible breakdown', () => {
    expect(PLATFORM_FEE_PERCENT).toBe(10);
    expect(SERVICE_FEE_CENTS).toBe(95);
    expect(STRIPE_PERCENT).toBe(0.029);
    expect(STRIPE_FIXED_CENTS).toBe(30);

    const legacy = calculateFinancialBreakdown(10000, 10);
    expect(legacy.totalInCents).toBe(10000);
    expect(legacy.commissionInCents).toBe(1000);
    expect(legacy.organizerPayoutInCents).toBe(9000);
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
      // 2000 cents ($20.00)
      const breakdown = calculateTierEarnings(2000, 250);

      // Platform fee: 10% = 200 cents ($2.00)
      expect(breakdown.platformFeeInCents).toBe(200);
      // Service fee: 95 cents ($0.95)
      expect(breakdown.serviceFeeInCents).toBe(95);
      // Pre-processing subtotal: 2000 + 200 + 95 = 2295 cents ($22.95)
      expect(breakdown.subtotalInCents).toBe(2295);
      // Buyer total: Math.round((2295 + 30) / (1 - 0.029)) = Math.round(2325 / 0.971) = 2394 cents ($23.94)
      expect(breakdown.buyerTotalInCents).toBe(2394);
      // Processing fee: 2394 - 2295 = 99 cents ($0.99)
      expect(breakdown.processingFeeInCents).toBe(99);
      // Organizer earnings per ticket = 2000 cents ($20.00)
      expect(breakdown.organizerEarningsInCents).toBe(2000);
      // Platform revenue: 200 + 95 = 295 cents ($2.95)
      expect(breakdown.platformRevenueInCents).toBe(295);
      // Projected earnings: 2000 * 250 = 500,000 cents ($5,000.00)
      expect(breakdown.projectedEarningsInCents).toBe(500000);
      // Projected buyer spend: 2394 * 250 = 598,500 cents ($5,985.00)
      expect(breakdown.projectedBuyerTotalInCents).toBe(598500);

        expect(breakdown.buyerTotalInCents).toBe(
        breakdown.organizerEarningsInCents +
          breakdown.platformRevenueInCents +
          breakdown.processingFeeInCents
      );
    });

    it('reconciles exactly across a sweep of 100 different ticket prices', () => {
      for (let dollars = 1; dollars <= 100; dollars++) {
        const priceInCents = dollars * 100;
        const capacity = dollars * 5;
        const b = calculateTierEarnings(priceInCents, capacity);

          expect(Number.isInteger(b.ticketPriceInCents)).toBe(true);
        expect(Number.isInteger(b.platformFeeInCents)).toBe(true);
        expect(Number.isInteger(b.serviceFeeInCents)).toBe(true);
        expect(Number.isInteger(b.processingFeeInCents)).toBe(true);
        expect(Number.isInteger(b.buyerTotalInCents)).toBe(true);
        expect(Number.isInteger(b.organizerEarningsInCents)).toBe(true);

          expect(b.organizerEarningsInCents).toBe(priceInCents);

        // Strict fund preservation: Buyer Total === Organizer + Platform + Stripe
        expect(b.buyerTotalInCents).toBe(
          b.organizerEarningsInCents + b.platformRevenueInCents + b.processingFeeInCents
        );

          expect(b.projectedEarningsInCents).toBe(b.organizerEarningsInCents * capacity);
        expect(b.projectedBuyerTotalInCents).toBe(b.buyerTotalInCents * capacity);
        expect(b.projectedPlatformRevenueInCents).toBe(b.platformRevenueInCents * capacity);
      }
    });

    it('correctly handles fractional rounding on odd cent prices ($19.99, $49.50)', () => {
      const oddPrices = [1999, 4950, 100, 1, 14999];
      for (const price of oddPrices) {
        const b = calculateTierEarnings(price, 10);
        expect(b.organizerEarningsInCents).toBe(price);
        expect(b.buyerTotalInCents).toBe(
          b.organizerEarningsInCents + b.platformFeeInCents + b.serviceFeeInCents + b.processingFeeInCents
        );
      }
    });
  });

  describe('calculateCombinedEarnings', () => {
    it('aggregates multiple tiers and maintains overall fund reconciliation', () => {
      const tiers = [
        { priceInCents: 1500, capacity: 50 },  // Early bird: $15.00 x 50
        { priceInCents: 3000, capacity: 200 }, // GA: $30.00 x 200
        { priceInCents: 10000, capacity: 25 }, // VIP: $100.00 x 25
      ];

      const combined = calculateCombinedEarnings(tiers);

      expect(combined.tiers.length).toBe(3);
      expect(combined.totalCapacity).toBe(275);

      // Expected earnings: 1500*50 + 3000*200 + 10000*25 = 75000 + 600000 + 250000 = 925000 cents ($9,250.00)
      expect(combined.totalProjectedEarningsInCents).toBe(925000);

        expect(combined.totalProjectedBuyerSpendInCents).toBe(
        combined.totalProjectedEarningsInCents +
          combined.totalProjectedPlatformRevenueInCents +
          combined.totalProjectedProcessingFeesInCents
      );
    });
  });

  describe('POST /api/organizer/earnings-preview endpoint', () => {
    it('returns 401 Unauthorized when unauthenticated', async () => {
      const res = await request(app)
        .post('/api/organizer/earnings-preview')
        .send({
          tiers: [{ priceInCents: 2000, capacity: 100 }],
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 Bad Request when tiers input is invalid', async () => {
      const res = await request(app)
        .post('/api/organizer/earnings-preview')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          tiers: [{ priceInCents: -50, capacity: 10 }], // negative price
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 200 OK with correct fee breakdown preview for authenticated organizer', async () => {
      const res = await request(app)
        .post('/api/organizer/earnings-preview')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          tiers: [
            { priceInCents: 2500, capacity: 250 },
            { priceInCents: 7500, capacity: 100 },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('preview');

      const preview = res.body.data.preview;
      expect(preview.tiers.length).toBe(2);
      expect(preview.totalCapacity).toBe(350);
      expect(preview.totalProjectedEarningsInCents).toBe(2500 * 250 + 7500 * 100);

      // First tier ($25.00)
      const t1 = preview.tiers[0];
      expect(t1.ticketPriceInCents).toBe(2500);
      expect(t1.platformFeeInCents).toBe(250);
      expect(t1.serviceFeeInCents).toBe(95);
      expect(t1.organizerEarningsInCents).toBe(2500);

      // Second tier ($75.00)
      const t2 = preview.tiers[1];
      expect(t2.ticketPriceInCents).toBe(7500);
      expect(t2.platformFeeInCents).toBe(750);
      expect(t2.serviceFeeInCents).toBe(95);
      expect(t2.organizerEarningsInCents).toBe(7500);

      expect(preview.totalProjectedBuyerSpendInCents).toBe(
        preview.totalProjectedEarningsInCents +
          preview.totalProjectedPlatformRevenueInCents +
          preview.totalProjectedProcessingFeesInCents
      );
    });
  });

  describe('calculateCheckoutFeeBreakdown (Server authoritative fee calculations)', () => {
    it('returns zeroes when total quantity or subtotal is zero', () => {
      const breakdown = calculateCheckoutFeeBreakdown(0, 0);
      expect(breakdown.ticketSubtotalInCents).toBe(0);
      expect(breakdown.platformFeeInCents).toBe(0);
      expect(breakdown.serviceFeeInCents).toBe(0);
      expect(breakdown.processingFeeInCents).toBe(0);
      expect(breakdown.buyerTotalInCents).toBe(0);
      expect(breakdown.organizerEarningsInCents).toBe(0);

      const emptyArrayBreakdown = calculateCheckoutFeeBreakdown([]);
      expect(emptyArrayBreakdown.buyerTotalInCents).toBe(0);
    });

    it('calculates the exact authoritative breakdown for a single $20.00 ticket', () => {
      // 1 ticket @ $20.00 (2000 cents)
      const b = calculateCheckoutFeeBreakdown(2000, 1);

      // Subtotal: 2000 ($20.00)
      expect(b.ticketSubtotalInCents).toBe(2000);
      expect(b.totalTicketQuantity).toBe(1);

      // Platform fee: 10% of $20.00 = 200 cents ($2.00)
      expect(b.platformFeeInCents).toBe(200);

      // Service fee: fixed $0.95 = 95 cents
      expect(b.serviceFeeInCents).toBe(95);

      // Pre-processing total: 2000 + 200 + 95 = 2295 cents ($22.95)
      expect(b.preProcessingTotalInCents).toBe(2295);

      // Buyer total: Math.round((2295 + 30) / (1 - 0.029)) = Math.round(2325 / 0.971) = 2394 cents ($23.94)
      expect(b.buyerTotalInCents).toBe(2394);

      // Processing fee: 2394 - 2295 = 99 cents ($0.99)
      expect(b.processingFeeInCents).toBe(99);

      // Organizer payout: 2000 cents ($20.00)
      expect(b.organizerEarningsInCents).toBe(2000);

      // Invariant: buyerTotal === ticketSubtotal + platformFee + serviceFee + processingFee
      expect(b.buyerTotalInCents).toBe(
        b.ticketSubtotalInCents +
          b.platformFeeInCents +
          b.serviceFeeInCents +
          b.processingFeeInCents
      );
    });

    it('calculates the exact breakdown for multiple tickets in one transaction (2 x $20.00)', () => {
      // 2 tickets @ $20.00 = 4000 cents
      const b = calculateCheckoutFeeBreakdown(4000, 2);

      expect(b.ticketSubtotalInCents).toBe(4000);
      expect(b.totalTicketQuantity).toBe(2);

      // Platform fee: 10% of 4000 = 400 cents ($4.00)
      expect(b.platformFeeInCents).toBe(400);

      // Service fee: 2 x $0.95 = 190 cents ($1.90)
      expect(b.serviceFeeInCents).toBe(190);

      // Pre-processing total: 4000 + 400 + 190 = 4590 cents ($45.90)
      expect(b.preProcessingTotalInCents).toBe(4590);

      // Buyer total: Math.round((4590 + 30) / 0.971) = 4758 cents ($47.58)
      expect(b.buyerTotalInCents).toBe(4758);

      // Processing fee: 4758 - 4590 = 168 cents ($1.68)
      expect(b.processingFeeInCents).toBe(168);

        expect(b.buyerTotalInCents).toBe(
        b.ticketSubtotalInCents +
          b.platformFeeInCents +
          b.serviceFeeInCents +
          b.processingFeeInCents
      );
    });

    it('calculates breakdown for an array of items across multiple tiers', () => {
      // 1 x $25.00 ticket + 2 x $50.00 tickets = 3 tickets, $125.00 subtotal (12500 cents)
      const items = [
        { unitPriceInCents: 2500, quantity: 1 },
        { unitPriceInCents: 5000, quantity: 2 },
      ];

      const b = calculateCheckoutFeeBreakdown(items);

      expect(b.ticketSubtotalInCents).toBe(12500);
      expect(b.totalTicketQuantity).toBe(3);
      expect(b.platformFeeInCents).toBe(1250);
      expect(b.serviceFeeInCents).toBe(285);
      expect(b.preProcessingTotalInCents).toBe(14035);
      expect(b.buyerTotalInCents).toBe(14485);
      expect(b.processingFeeInCents).toBe(450);

        expect(b.buyerTotalInCents).toBe(
        b.ticketSubtotalInCents +
          b.platformFeeInCents +
          b.serviceFeeInCents +
          b.processingFeeInCents
      );
    });

    it('dynamically responds to quantity changes and maintains monotonic increase', () => {
      const ticketPrice = 3000; // $30.00
      let lastTotal = 0;

      for (let qty = 1; qty <= 6; qty++) {
        const subtotal = ticketPrice * qty;
        const b = calculateCheckoutFeeBreakdown(subtotal, qty);

        expect(b.totalTicketQuantity).toBe(qty);
        expect(b.ticketSubtotalInCents).toBe(subtotal);
        expect(b.platformFeeInCents).toBe(Math.round(subtotal * 0.10));
        expect(b.serviceFeeInCents).toBe(qty * 95);
        expect(b.buyerTotalInCents).toBeGreaterThan(lastTotal);
        lastTotal = b.buyerTotalInCents;

        expect(b.buyerTotalInCents).toBe(
          b.ticketSubtotalInCents +
            b.platformFeeInCents +
            b.serviceFeeInCents +
            b.processingFeeInCents
        );
      }
    });

    it('handles cent rounding safely across awkward prices without fractional leakage', () => {
      const prices = [1999, 3333, 4999, 100, 1];

      for (const price of prices) {
        for (const qty of [1, 2, 5]) {
          const subtotal = price * qty;
          const b = calculateCheckoutFeeBreakdown(subtotal, qty);

          expect(Number.isInteger(b.ticketSubtotalInCents)).toBe(true);
          expect(Number.isInteger(b.platformFeeInCents)).toBe(true);
          expect(Number.isInteger(b.serviceFeeInCents)).toBe(true);
          expect(Number.isInteger(b.processingFeeInCents)).toBe(true);
          expect(Number.isInteger(b.buyerTotalInCents)).toBe(true);

          expect(b.buyerTotalInCents).toBe(
            b.ticketSubtotalInCents +
              b.platformFeeInCents +
              b.serviceFeeInCents +
              b.processingFeeInCents
          );
        }
      }
    });

    it('prevents duplicate fee application and reconciles Stripe processing cut', () => {
      const subtotal = 7500; // $75.00
      const qty = 2;
      const b = calculateCheckoutFeeBreakdown(subtotal, qty);

        expect(b.platformFeeInCents).toBe(750);

      // Service fee is $0.95 x 2
      expect(b.serviceFeeInCents).toBe(190);

        expect(b.preProcessingTotalInCents).toBe(8440);

        expect(b.buyerTotalInCents).toBe(8723);

        expect(b.processingFeeInCents).toBe(283);

        const stripeTake = Math.round(b.buyerTotalInCents * STRIPE_PERCENT + STRIPE_FIXED_CENTS);
      expect(b.processingFeeInCents).toBe(stripeTake);
    });
  });
});
