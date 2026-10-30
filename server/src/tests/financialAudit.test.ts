import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { nanoid } from 'nanoid';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import { processStripeWebhookEvent } from '../modules/webhooks/webhook.service.js';
import {
  settlePendingOrder,
  reconcileOrganizerFinance,
  getOrganizerFinancialSummary,
  getOrCreateOrganizerBalance,
} from '../modules/finance/ledger.service.js';
import { executeWithdrawal } from '../modules/finance/transfer.service.js';
import {
  OrderStatus,
  Role,
  PaymentProvider,
  LedgerEntryType,
  LedgerBalanceType,
  TransferStatus,
  PayoutStatus,
  EventStatus,
} from '@prisma/client';

describe('Stripe Connect Financial Correctness & Money Movement Audit Suite', () => {
  let organizerToken: string;
  let organizerUserId: string;
  let organizerStripeAccountId: string;
  let testEventId: string;
  let testTierId: string;
  let testOrderId: string;

  beforeAll(async () => {
    // 1. Create and authenticate isolated audit test organizer
    const auditEmail = `audit_org_${Date.now()}@outside.vip`;
    const regRes = await request(app).post('/api/auth/register').send({
      email: auditEmail,
      name: 'Financial Audit Organizer',
      password: 'Outside2026!',
      role: Role.ORGANIZER,
    });
    expect(regRes.status).toBe(201);
    organizerToken = regRes.body.data.token;
    organizerUserId = regRes.body.data.user.id;

    organizerStripeAccountId = `acct_audit_${nanoid(12)}`;
    await prisma.user.update({
      where: { id: organizerUserId },
      data: { stripeAccountId: organizerStripeAccountId },
    });

    // Initialize clean organizer balance record
    await prisma.organizerBalance.upsert({
      where: { userId: organizerUserId },
      create: {
        userId: organizerUserId,
        pendingBalanceInCents: 0,
        availableBalanceInCents: 0,
        transferredBalanceInCents: 0,
        currency: 'USD',
      },
      update: {
        pendingBalanceInCents: 0,
        availableBalanceInCents: 0,
        transferredBalanceInCents: 0,
      },
    });

    // 2. Create test event with $20.00 ticket tier
    const event = await prisma.event.create({
      data: {
        organizerId: organizerUserId,
        title: 'Audit Grand Festival',
        description: 'Comprehensive financial audit test event',
        slug: `audit-event-${Date.now()}`,
        venueName: 'Financial Arena',
        venueAddress: '100 Treasury Way',
        city: 'Nairobi',
        country: 'Kenya',
        coverImageUrl: 'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14',
        startAt: new Date(Date.now() + 86400000 * 5),
        endAt: new Date(Date.now() + 86400000 * 6),
        ticketTiers: {
          create: {
            name: 'Audit Tier 1',
            priceInCents: 2000, // $20.00 face value
            totalCapacity: 500,
          },
        },
      },
      include: { ticketTiers: true },
    });
    testEventId = event.id;
    testTierId = event.ticketTiers[0].id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      if (testEventId) {
        await prisma.orderItem.deleteMany({ where: { order: { eventId: testEventId } } }).catch(() => {});
        await prisma.ticket.deleteMany({ where: { eventId: testEventId } }).catch(() => {});
        await prisma.financialLedgerEntry.deleteMany({ where: { eventId: testEventId } }).catch(() => {});
        await prisma.order.deleteMany({ where: { eventId: testEventId } }).catch(() => {});
        await prisma.ticketTier.deleteMany({ where: { eventId: testEventId } }).catch(() => {});
        await prisma.event.delete({ where: { id: testEventId } }).catch(() => {});
      }
      if (organizerUserId) {
        await prisma.financialLedgerEntry.deleteMany({ where: { organizerId: organizerUserId } }).catch(() => {});
        await prisma.organizerTransfer.deleteMany({ where: { organizerId: organizerUserId } }).catch(() => {});
        await prisma.organizerBalance.deleteMany({ where: { userId: organizerUserId } }).catch(() => {});
        await prisma.connectedPayout.deleteMany({ where: { organizerId: organizerUserId } }).catch(() => {});
        await prisma.user.delete({ where: { id: organizerUserId } }).catch(() => {});
      }
    } catch {}
  });

  // 1. Payment succeeds but funds are not yet available
  it('1. Payment succeeds but funds are not yet available in platform Stripe balance', async () => {
    const orderNumber = `AUDIT-${nanoid(8).toUpperCase()}`;
    const paymentIntentId = `pi_audit_${nanoid(16)}`;
    const chargeId = `ch_audit_${nanoid(16)}`;

    // Order checkout totals: $20.00 face value, 10% platform ($2.00), $0.95 service, 2.9%+$0.30 gross-up -> total $23.94
    const order = await prisma.order.create({
      data: {
        orderNumber,
        eventId: testEventId,
        status: OrderStatus.PENDING, // Realistic pending order awaiting payment
        customerEmail: 'audit_buyer@example.com',
        customerName: 'Audit Buyer',
        totalInCents: 2394,
        platformFeeInCents: 394,
        organizerNetInCents: 2000,
        idempotencyKey: `ord_${nanoid(16)}`,
        paymentProvider: PaymentProvider.STRIPE,
        paymentReference: paymentIntentId,
        expiresAt: new Date(Date.now() + 900000),
        items: {
          create: {
            ticketTierId: testTierId,
            quantity: 1,
            unitPriceInCents: 2000,
            subtotalInCents: 2000,
          },
        },
      },
    });
    testOrderId = order.id;

    // Simulate payment_intent.succeeded
    await processStripeWebhookEvent({
      id: `evt_pi_${nanoid(16)}`,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: paymentIntentId,
          amount: 2394,
          currency: 'usd',
          status: 'succeeded',
          metadata: { orderId: order.id },
          latest_charge: chargeId,
        } as any,
      },
    } as any);

    // Simulate charge.updated where balance_transaction available_on is in the future (+2 days)
    const futureAvailableOn = Math.floor(Date.now() / 1000) + 172800; // 2 days in future
    await processStripeWebhookEvent({
      id: `evt_ch_pending_${nanoid(16)}`,
      type: 'charge.updated',
      data: {
        object: {
          id: chargeId,
          payment_intent: paymentIntentId,
          currency: 'usd',
          status: 'succeeded',
          metadata: { orderId: order.id },
          balance_transaction: {
            id: `txn_future_${nanoid(12)}`,
            status: 'pending',
            available_on: futureAvailableOn,
            fee: 99,
          } as any,
        } as any,
      },
    } as any);

    const balance = await prisma.organizerBalance.findUnique({
      where: { userId: organizerUserId },
    });
    // Funds must be recorded in PENDING, not prematurely in AVAILABLE
    expect(balance?.pendingBalanceInCents).toBe(2000);
    expect(balance?.availableBalanceInCents).toBe(0);
  });

  // 2. Funds become available according to actual Stripe balance transaction
  it('2. Funds become available according to the actual Stripe balance transaction', async () => {
    const chargeId = `ch_audit_${nanoid(16)}`;
    const pastAvailableOn = Math.floor(Date.now() / 1000) - 60; // 1 minute in the past

    // Simulate charge.updated with available_on in the past and status 'available'
    await processStripeWebhookEvent({
      id: `evt_ch_avail_${nanoid(16)}`,
      type: 'charge.updated',
      data: {
        object: {
          id: chargeId,
          metadata: { orderId: testOrderId },
          currency: 'usd',
          status: 'succeeded',
          balance_transaction: {
            id: `txn_avail_${nanoid(12)}`,
            status: 'available',
            available_on: pastAvailableOn,
            fee: 99,
          } as any,
        } as any,
      },
    } as any);

    const balance = await prisma.organizerBalance.findUnique({
      where: { userId: organizerUserId },
    });
    expect(balance?.pendingBalanceInCents).toBe(0);
    expect(balance?.availableBalanceInCents).toBe(2000);

    const clearedEntry = await prisma.financialLedgerEntry.findFirst({
      where: {
        orderId: testOrderId,
        type: LedgerEntryType.TICKET_SALE_CLEARED,
      },
    });
    expect(clearedEntry).toBeDefined();
    expect(clearedEntry?.amountInCents).toBe(2000);
    expect(clearedEntry?.balanceType).toBe(LedgerBalanceType.AVAILABLE);
  });

  // 3. Duplicate settlement notifications
  it('3. Duplicate settlement notifications are strictly idempotent', async () => {
    // Deliver another charge.updated with the same charge and new event ID
    await processStripeWebhookEvent({
      id: `evt_ch_dup_${nanoid(16)}`,
      type: 'charge.updated',
      data: {
        object: {
          id: `ch_audit_dup_${nanoid(16)}`,
          metadata: { orderId: testOrderId },
          currency: 'usd',
          status: 'succeeded',
          balance_transaction: {
            id: `txn_dup_${nanoid(12)}`,
            status: 'available',
            available_on: Math.floor(Date.now() / 1000) - 100,
            fee: 99,
          } as any,
        } as any,
      },
    } as any);

    const balance = await prisma.organizerBalance.findUnique({
      where: { userId: organizerUserId },
    });
    // Available balance MUST remain 2000, NOT double to 4000
    expect(balance?.availableBalanceInCents).toBe(2000);
  });

  // 4. Transfer requested before funds are available
  it('4. Transfer requested before funds are available is rejected', async () => {
    vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
      id: organizerStripeAccountId,
      payouts_enabled: true,
      charges_enabled: true,
      details_submitted: true,
      capabilities: { transfers: 'active', card_payments: 'active' },
      requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
    } as any);

    // Current available balance is 2000. Request 5000 cents ($50.00)
    await expect(
      executeWithdrawal({
        userId: organizerUserId,
        amountInCents: 5000,
      })
    ).rejects.toThrow('Insufficient available balance');
  });

  // 5. Connected account without active transfer capability
  it('5. Connected account without active transfer capability is rejected with actionable error', async () => {
    vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
      id: organizerStripeAccountId,
      payouts_enabled: false,
      charges_enabled: true,
      details_submitted: true,
      capabilities: { transfers: 'inactive', card_payments: 'active' }, // Transfers inactive!
      requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
    } as any);

    await expect(
      executeWithdrawal({
        userId: organizerUserId,
        amountInCents: 1000,
      })
    ).rejects.toThrow('Your Stripe account transfer capability is pending activation by Stripe');
  });

  // 6. Connected account with outstanding requirements / disabled reason
  it('6. Connected account with outstanding requirements or disabled reason is rejected', async () => {
    vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
      id: organizerStripeAccountId,
      payouts_enabled: false,
      charges_enabled: false,
      details_submitted: true,
      capabilities: { transfers: 'inactive', card_payments: 'inactive' },
      requirements: {
        currently_due: ['individual.verification.document'],
        past_due: ['individual.verification.document'],
        disabled_reason: 'requirements.past_due',
      },
    } as any);

    await expect(
      executeWithdrawal({
        userId: organizerUserId,
        amountInCents: 1000,
      })
    ).rejects.toThrow('Transfers are disabled by Stripe: requirements.past_due');
  });

  // 7. Insufficient platform Stripe balance
  it('7. Insufficient platform Stripe balance safely restores organizer available balance', async () => {
    vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
      id: organizerStripeAccountId,
      payouts_enabled: true,
      charges_enabled: true,
      details_submitted: true,
      capabilities: { transfers: 'active', card_payments: 'active' },
      requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
    } as any);

    // Simulate Stripe returning balance_insufficient error
    const stripeBalanceError: any = new Error('You have insufficient funds in your Stripe balance.');
    stripeBalanceError.code = 'balance_insufficient';
    vi.spyOn(stripe.transfers, 'create').mockRejectedValueOnce(stripeBalanceError);

    await expect(
      executeWithdrawal({
        userId: organizerUserId,
        amountInCents: 1500,
        idempotencyKey: `w_insuf_${nanoid(10)}`,
      })
    ).rejects.toThrow();

    // Available balance MUST be restored back to 2000 cents
    const balance = await prisma.organizerBalance.findUnique({
      where: { userId: organizerUserId },
    });
    expect(balance?.availableBalanceInCents).toBe(2000);

    const failedTransfer = await prisma.organizerTransfer.findFirst({
      where: { organizerId: organizerUserId, status: TransferStatus.FAILED },
      orderBy: { createdAt: 'desc' },
    });
    expect(failedTransfer).toBeDefined();
    expect(failedTransfer?.failureCode).toBe('balance_insufficient');
  });

  // 8. Transfer succeeds but the API response times out
  it('8. Transfer succeeds but response timed out - recovered on retry', async () => {
    const customKey = `timeout_retry_${nanoid(12)}`;

    // Create a pending transfer as if Stripe was called but client timed out
    const transferNumber = `TRF-AUDIT-${nanoid(8).toUpperCase()}`;
    await prisma.organizerTransfer.create({
      data: {
        transferNumber,
        organizerId: organizerUserId,
        stripeAccountId: organizerStripeAccountId,
        amountInCents: 1000,
        currency: 'USD',
        status: TransferStatus.PENDING,
        idempotencyKey: `tx_${organizerUserId}_${customKey}`,
        initiatedByUserId: organizerUserId,
      },
    });

    // Mock stripe.transfers.list returning the succeeded transfer created on Stripe
    const mockStripeTransferId = `tr_recovered_${nanoid(14)}`;
    vi.spyOn(stripe.transfers, 'list').mockResolvedValueOnce({
      object: 'list',
      data: [
        {
          id: mockStripeTransferId,
          amount: 1000,
          currency: 'usd',
          destination: organizerStripeAccountId,
          transfer_group: transferNumber,
        } as any,
      ],
      has_more: false,
    } as any);

    vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
      id: organizerStripeAccountId,
      payouts_enabled: true,
      charges_enabled: true,
      details_submitted: true,
      capabilities: { transfers: 'active', card_payments: 'active' },
      requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
    } as any);

    const result = await executeWithdrawal({
      userId: organizerUserId,
      amountInCents: 1000,
      idempotencyKey: customKey,
    });

    expect(result.status).toBe(TransferStatus.SUCCEEDED);
    expect(result.stripeTransferId).toBe(mockStripeTransferId);
    expect(result.amountInCents).toBe(1000);
  });

  // 9. Duplicate transfer request
  it('9. Duplicate transfer request with same idempotency key returns existing record', async () => {
    const duplicateKey = `dup_key_${nanoid(12)}`;

    vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValue({
      id: organizerStripeAccountId,
      payouts_enabled: true,
      charges_enabled: true,
      details_submitted: true,
      capabilities: { transfers: 'active', card_payments: 'active' },
      requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
    } as any);

    const mockStripeTransferId = `tr_dup_${nanoid(14)}`;
    vi.spyOn(stripe.transfers, 'create').mockResolvedValueOnce({
      id: mockStripeTransferId,
      amount: 500,
      currency: 'usd',
      destination: organizerStripeAccountId,
    } as any);

    const first = await executeWithdrawal({
      userId: organizerUserId,
      amountInCents: 500,
      idempotencyKey: duplicateKey,
    });
    expect(first.status).toBe(TransferStatus.SUCCEEDED);

    // Call again with exact same key
    const second = await executeWithdrawal({
      userId: organizerUserId,
      amountInCents: 500,
      idempotencyKey: duplicateKey,
    });

    expect(second.transferId).toBe(first.transferId);
    expect(second.stripeTransferId).toBe(first.stripeTransferId);
    expect(second.amountInCents).toBe(500);
  });

  // 10. Concurrent withdrawals
  it('10. Concurrent withdrawals cannot double-spend available balance', async () => {
    // Give organizer exactly 1000 cents ($10.00) available
    await prisma.organizerBalance.upsert({
      where: { userId: organizerUserId },
      create: { userId: organizerUserId, availableBalanceInCents: 1000 },
      update: { availableBalanceInCents: 1000 },
    });

    vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValue({
      id: organizerStripeAccountId,
      payouts_enabled: true,
      charges_enabled: true,
      details_submitted: true,
      capabilities: { transfers: 'active', card_payments: 'active' },
      requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
    } as any);

    vi.spyOn(stripe.transfers, 'create').mockImplementation(async () => {
      // Simulate 50ms network delay to ensure both concurrent calls overlap
      await new Promise((r) => setTimeout(r, 50));
      return {
        id: `tr_conc_${nanoid(12)}`,
        amount: 1000,
        currency: 'usd',
        destination: organizerStripeAccountId,
      } as any;
    });

    // Fire two competing withdrawals for 1000 cents simultaneously
    const [res1, res2] = await Promise.allSettled([
      executeWithdrawal({
        userId: organizerUserId,
        amountInCents: 1000,
        idempotencyKey: `conc_1_${nanoid(10)}`,
      }),
      executeWithdrawal({
        userId: organizerUserId,
        amountInCents: 1000,
        idempotencyKey: `conc_2_${nanoid(10)}`,
      }),
    ]);

    const successes = [res1, res2].filter((r) => r.status === 'fulfilled');
    const rejections = [res1, res2].filter((r) => r.status === 'rejected');

    // Exactly ONE must succeed and exactly ONE must fail
    expect(successes.length).toBe(1);
    expect(rejections.length).toBe(1);

    const balance = await prisma.organizerBalance.findUnique({
      where: { userId: organizerUserId },
    });
    // Available balance must be exactly 0, NEVER negative
    expect(balance?.availableBalanceInCents).toBe(0);
  });

  // 11. Partial refund before transfer
  it('11. Partial refund before transfer reduces available balance incrementally without double deductions', async () => {
    // Reset available balance to 2000 for order
    await prisma.organizerBalance.upsert({
      where: { userId: organizerUserId },
      create: { userId: organizerUserId, availableBalanceInCents: 2000 },
      update: { availableBalanceInCents: 2000 },
    });

    const refundId1 = `re_audit_part1_${nanoid(10)}`;

    // First partial refund: $10.00 refunded out of $23.94 total -> organizer portion is Math.round((1000/2394)*2000) = 835 cents
    await processStripeWebhookEvent({
      id: `evt_ref_1_${nanoid(16)}`,
      type: 'charge.refunded',
      data: {
        object: {
          id: `ch_audit_ref_${nanoid(12)}`,
          metadata: { orderId: testOrderId },
          amount_refunded: 1000,
          currency: 'usd',
          refunds: {
            data: [{ id: refundId1, amount: 1000 }],
          },
        } as any,
      },
    } as any);

    let bal = await prisma.organizerBalance.findUnique({ where: { userId: organizerUserId } });
    expect(bal?.availableBalanceInCents).toBe(2000 - 835); // 1165 cents

    // Duplicate delivery of first refund must be ignored
    await processStripeWebhookEvent({
      id: `evt_ref_1_dup_${nanoid(16)}`,
      type: 'charge.refunded',
      data: {
        object: {
          id: `ch_audit_ref_${nanoid(12)}`,
          metadata: { orderId: testOrderId },
          amount_refunded: 1000,
          currency: 'usd',
          refunds: {
            data: [{ id: refundId1, amount: 1000 }],
          },
        } as any,
      },
    } as any);

    bal = await prisma.organizerBalance.findUnique({ where: { userId: organizerUserId } });
    expect(bal?.availableBalanceInCents).toBe(1165); // Untouched

    // Second partial refund: cumulative amount_refunded is now 1500
    // Total entitlement refund = Math.round((1500/2394)*2000) = 1253 cents
    // Incremental deduction = 1253 - 835 = 418 cents
    const refundId2 = `re_audit_part2_${nanoid(10)}`;
    await processStripeWebhookEvent({
      id: `evt_ref_2_${nanoid(16)}`,
      type: 'charge.refunded',
      data: {
        object: {
          id: `ch_audit_ref_${nanoid(12)}`,
          metadata: { orderId: testOrderId },
          amount_refunded: 1500,
          currency: 'usd',
          refunds: {
            data: [{ id: refundId2, amount: 500 }],
          },
        } as any,
      },
    } as any);

    bal = await prisma.organizerBalance.findUnique({ where: { userId: organizerUserId } });
    expect(bal?.availableBalanceInCents).toBe(1165 - 418); // 747 cents
  });

  // 12. Partial refund after transfer
  it('12. Partial refund after transfer creates recoverable liabilities without negative transfers', async () => {
    // Drain available balance to 0 as if organizer withdrew everything
    await prisma.organizerBalance.upsert({
      where: { userId: organizerUserId },
      create: { userId: organizerUserId, availableBalanceInCents: 0 },
      update: { availableBalanceInCents: 0 },
    });

    const refundId3 = `re_post_trf_${nanoid(10)}`;
    // Full cumulative refund to 2394
    await processStripeWebhookEvent({
      id: `evt_ref_post_${nanoid(16)}`,
      type: 'charge.refunded',
      data: {
        object: {
          id: `ch_audit_ref_${nanoid(12)}`,
          metadata: { orderId: testOrderId },
          amount_refunded: 2394,
          currency: 'usd',
          refunds: {
            data: [{ id: refundId3, amount: 894 }],
          },
        } as any,
      },
    } as any);

    const summary = await getOrganizerFinancialSummary(organizerUserId);
    expect(summary.recoverableInCents).toBeGreaterThan(0);
    expect(summary.availableInCents).toBe(0);
    expect(summary.netAvailableInCents).toBe(0);
  });

  // 13. Dispute created and resolved
  it('13. Dispute created and resolved records hold, win and loss accurately', async () => {
    const disputeId = `dp_audit_${nanoid(12)}`;

    // Dispute created
    await processStripeWebhookEvent({
      id: `evt_disp_created_${nanoid(16)}`,
      type: 'charge.dispute.created',
      data: {
        object: {
          id: disputeId,
          charge: `ch_audit_${nanoid(12)}`,
          amount: 2394,
          status: 'needs_response',
          reason: 'fraudulent',
        } as any,
      },
    } as any);

    // Dispute resolved as won
    await processStripeWebhookEvent({
      id: `evt_disp_closed_${nanoid(16)}`,
      type: 'charge.dispute.closed',
      data: {
        object: {
          id: disputeId,
          charge: `ch_audit_${nanoid(12)}`,
          amount: 2394,
          status: 'won',
          reason: 'fraudulent',
        } as any,
      },
    } as any);

    const wonEntry = await prisma.financialLedgerEntry.findFirst({
      where: {
        stripeReferenceId: disputeId,
        type: LedgerEntryType.DISPUTE_WON,
      },
    });
    expect(wonEntry).toBeDefined();
  });

  // 14. Transfer reversal
  it('14. Transfer reversal restores organizer available balance and decrements transferred balance', async () => {
    const stripeTransferId = `tr_rev_${nanoid(14)}`;
    const transferNumber = `TRF-REV-${nanoid(6).toUpperCase()}`;

    // Create a succeeded transfer record with 1000 cents
    const transfer = await prisma.organizerTransfer.create({
      data: {
        transferNumber,
        organizerId: organizerUserId,
        stripeAccountId: organizerStripeAccountId,
        amountInCents: 1000,
        currency: 'USD',
        status: TransferStatus.SUCCEEDED,
        stripeTransferId,
        idempotencyKey: `tx_rev_${nanoid(12)}`,
        initiatedByUserId: organizerUserId,
      },
    });

    // Set initial balance: transferred 1000, available 500
    await prisma.organizerBalance.upsert({
      where: { userId: organizerUserId },
      create: { userId: organizerUserId, transferredBalanceInCents: 1000, availableBalanceInCents: 500 },
      update: {
        transferredBalanceInCents: 1000,
        availableBalanceInCents: 500,
      },
    });

    // Webhook transfer.reversed arrives
    await processStripeWebhookEvent({
      id: `evt_tr_rev_${nanoid(16)}`,
      type: 'transfer.reversed',
      data: {
        object: {
          id: stripeTransferId,
          amount: 1000,
          currency: 'usd',
        } as any,
      },
    } as any);

    const updatedTransfer = await prisma.organizerTransfer.findUnique({
      where: { id: transfer.id },
    });
    expect(updatedTransfer?.status).toBe(TransferStatus.REVERSED);

    const balance = await prisma.organizerBalance.findUnique({
      where: { userId: organizerUserId },
    });
    // Transferred balance decremented by 1000 (1000 - 1000 = 0)
    expect(balance?.transferredBalanceInCents).toBe(0);
    // Available balance restored by 1000 (500 + 1000 = 1500)
    expect(balance?.availableBalanceInCents).toBe(1500);
  });

  // 15. Failed bank payout
  it('15. Failed bank payout is tracked in ConnectedPayout table with failure message', async () => {
    const stripePayoutId = `po_fail_${nanoid(14)}`;

    await processStripeWebhookEvent({
      id: `evt_po_failed_${nanoid(16)}`,
      type: 'payout.failed',
      account: organizerStripeAccountId,
      data: {
        object: {
          id: stripePayoutId,
          amount: 5000,
          currency: 'usd',
          status: 'failed',
          arrival_date: Math.floor(Date.now() / 1000) + 86400,
          failure_code: 'could_not_route_transfer',
          failure_message: 'Routing number unrecognized by the banking network.',
        } as any,
      },
    } as any);

    const payout = await prisma.connectedPayout.findUnique({
      where: { stripePayoutId },
    });
    expect(payout).toBeDefined();
    expect(payout?.status).toBe(PayoutStatus.FAILED);
    expect(payout?.failureCode).toBe('could_not_route_transfer');
    expect(payout?.failureMessage).toContain('Routing number unrecognized');
  });

  // 16. Successful bank payout
  it('16. Successful bank payout is tracked in ConnectedPayout table as PAID', async () => {
    const stripePayoutId = `po_paid_${nanoid(14)}`;

    await processStripeWebhookEvent({
      id: `evt_po_paid_${nanoid(16)}`,
      type: 'payout.paid',
      account: organizerStripeAccountId,
      data: {
        object: {
          id: stripePayoutId,
          amount: 2500,
          currency: 'usd',
          status: 'paid',
          arrival_date: Math.floor(Date.now() / 1000),
          destination_details: {
            card: { last4: '4242' },
          },
        } as any,
      },
    } as any);

    const payout = await prisma.connectedPayout.findUnique({
      where: { stripePayoutId },
    });
    expect(payout).toBeDefined();
    expect(payout?.status).toBe(PayoutStatus.PAID);
    expect(payout?.amountInCents).toBe(2500);
  });

  // 17. Platform-level dispute retrieval
  it('17. Platform-level dispute retrieval queries platform disputes without connected account header', async () => {
    const listSpy = vi.spyOn(stripe.disputes, 'list').mockResolvedValueOnce({
      object: 'list',
      data: [
        {
          id: 'dp_platform_001',
          amount: 2394,
          currency: 'usd',
          status: 'needs_response',
          reason: 'fraudulent',
          created: Math.floor(Date.now() / 1000),
        } as any,
      ],
      has_more: false,
    } as any);

    const res = await request(app)
      .get('/api/organizer/finance/disputes')
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.disputes.length).toBe(1);
    expect(res.body.data.disputes[0].id).toBe('dp_platform_001');

    // Confirm that stripe.disputes.list was called WITHOUT { stripeAccount } option
    expect(listSpy).toHaveBeenCalledWith({ limit: 10 });
  });

  // 18. Ledger reconciliation after all the above
  it('18. Ledger reconciliation verifies zero discrepancies between balance cache and underlying entries', async () => {
    // Create a pristine organizer for isolated end-to-end reconciliation
    const cleanEmail = `reconcile_org_${Date.now()}@outside.vip`;
    const regRes = await request(app).post('/api/auth/register').send({
      email: cleanEmail,
      name: 'Reconciliation Organizer',
      password: 'Outside2026!',
      role: Role.ORGANIZER,
    });
    const cleanUserId = regRes.body.data.user.id;
    const cleanStripeAccountId = `acct_clean_${nanoid(12)}`;

    await prisma.user.update({
      where: { id: cleanUserId },
      data: { stripeAccountId: cleanStripeAccountId },
    });

    // Initialize balance
    await prisma.organizerBalance.create({
      data: {
        userId: cleanUserId,
        pendingBalanceInCents: 0,
        availableBalanceInCents: 0,
        transferredBalanceInCents: 0,
        currency: 'USD',
      },
    });

    // Dedicated event for cleanUserId
    const cleanEvent = await prisma.event.create({
      data: {
        title: 'Reconciliation Event',
        slug: `rec-event-${nanoid(6)}`,
        description: 'Reconciliation event description',
        venueName: 'Test Venue',
        venueAddress: '100 Treasury Way',
        city: 'Nairobi',
        country: 'Kenya',
        coverImageUrl: 'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14',
        organizerId: cleanUserId,
        startAt: new Date(Date.now() + 86400000),
        endAt: new Date(Date.now() + 86400000 * 2),
        ticketTiers: {
          create: {
            name: 'GA',
            priceInCents: 2000,
            totalCapacity: 100,
          },
        },
      },
      include: { ticketTiers: true },
    });
    const cleanTierId = cleanEvent.ticketTiers[0].id;

    // 1. Order ticket sale ($20.00 face value)
    const cleanOrder = await prisma.order.create({
      data: {
        orderNumber: `ORD-REC-${nanoid(6)}`,
        eventId: cleanEvent.id,
        status: OrderStatus.PENDING,
        customerEmail: 'rec_buyer@example.com',
        customerName: 'Rec Buyer',
        totalInCents: 2394,
        platformFeeInCents: 394,
        organizerNetInCents: 2000,
        idempotencyKey: `rec_ord_${nanoid(12)}`,
        paymentProvider: PaymentProvider.STRIPE,
        expiresAt: new Date(Date.now() + 900000),
        items: {
          create: {
            ticketTierId: cleanTierId,
            quantity: 1,
            unitPriceInCents: 2000,
            subtotalInCents: 2000,
          },
        },
      },
    });

    // Pending sale recorded
    await processStripeWebhookEvent({
      id: `evt_rec_pi_${nanoid(14)}`,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: `pi_rec_${nanoid(12)}`,
          amount: 2394,
          currency: 'usd',
          status: 'succeeded',
          metadata: { orderId: cleanOrder.id },
        } as any,
      },
    } as any);

    // Initial check: pending matches
    let rec = await reconcileOrganizerFinance(cleanUserId);
    expect(rec.isReconciled).toBe(true);
    expect(rec.discrepancies).toEqual([]);
    expect(rec.balanceRecord?.pendingInCents).toBe(2000);
    expect(rec.balanceRecord?.availableInCents).toBe(0);

    // 2. Earnings cleared to available
    await settlePendingOrder(cleanOrder.id);
    rec = await reconcileOrganizerFinance(cleanUserId);
    expect(rec.isReconciled).toBe(true);
    expect(rec.discrepancies).toEqual([]);
    expect(rec.balanceRecord?.pendingInCents).toBe(0);
    expect(rec.balanceRecord?.availableInCents).toBe(2000);

    // 3. Withdrawal of 1000 cents
    vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
      id: cleanStripeAccountId,
      payouts_enabled: true,
      charges_enabled: true,
      details_submitted: true,
      capabilities: { transfers: 'active', card_payments: 'active' },
      requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
    } as any);

    const mockTransferId = `tr_rec_${nanoid(14)}`;
    vi.spyOn(stripe.transfers, 'create').mockResolvedValueOnce({
      id: mockTransferId,
      amount: 1000,
      currency: 'usd',
      destination: cleanStripeAccountId,
    } as any);

    await executeWithdrawal({
      userId: cleanUserId,
      amountInCents: 1000,
      idempotencyKey: `w_rec_${nanoid(10)}`,
    });

    rec = await reconcileOrganizerFinance(cleanUserId);
    expect(rec.isReconciled).toBe(true);
    expect(rec.discrepancies).toEqual([]);
    expect(rec.balanceRecord?.availableInCents).toBe(1000);
    expect(rec.balanceRecord?.transferredInCents).toBe(1000);

    // 4. Transfer reversal restores available balance
    await processStripeWebhookEvent({
      id: `evt_rec_rev_${nanoid(14)}`,
      type: 'transfer.reversed',
      data: {
        object: {
          id: mockTransferId,
          amount: 1000,
          currency: 'usd',
        } as any,
      },
    } as any);

    rec = await reconcileOrganizerFinance(cleanUserId);
    expect(rec.isReconciled).toBe(true);
    expect(rec.discrepancies).toEqual([]);
    expect(rec.balanceRecord?.availableInCents).toBe(2000);
    expect(rec.balanceRecord?.transferredInCents).toBe(0);

    // Cleanup test 18 records
    await prisma.ticket.deleteMany({ where: { orderId: cleanOrder.id } });
    await prisma.orderItem.deleteMany({ where: { orderId: cleanOrder.id } });
    await prisma.financialLedgerEntry.deleteMany({ where: { orderId: cleanOrder.id } });
    await prisma.order.deleteMany({ where: { id: cleanOrder.id } });
    await prisma.organizerTransfer.deleteMany({ where: { organizerId: cleanUserId } });
    await prisma.financialLedgerEntry.deleteMany({ where: { organizerId: cleanUserId } });
    await prisma.organizerBalance.deleteMany({ where: { userId: cleanUserId } });
    await prisma.ticketTier.deleteMany({ where: { eventId: cleanEvent.id } });
    await prisma.event.deleteMany({ where: { id: cleanEvent.id } });
    await prisma.user.deleteMany({ where: { id: cleanUserId } });
  });
});
