import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import Stripe from 'stripe';
import {
  EventStatus,
  LedgerBalanceType,
  LedgerEntryType,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  Role,
  StripeSettlementStatus,
  TicketTierStatus,
  TransferStatus,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import { processStripeWebhookEvent } from '../modules/webhooks/webhook.service.js';
import {
  getOrCreateOrganizerBalance,
  getOrganizerFinancialSummary,
  reconcileOrganizerFinance,
  recordTicketSalePending,
  recoverOrganizerLiabilities,
  settlePendingOrder,
} from '../modules/finance/ledger.service.js';
import {
  resetFailedSettlementOrders,
  runSettlementRecoveryPass,
  SETTLEMENT_MANUAL_REVIEW_SQL,
  SETTLEMENT_MAX_ATTEMPTS,
  SETTLEMENT_RESET_ELIGIBLE_SQL,
} from '../modules/finance/settlementRecovery.service.js';
import { executeWithdrawal } from '../modules/finance/transfer.service.js';

describe('Stage 2: Stripe Settlement Reliability, Pre-Settlement Refunds, Locking & Recovery', () => {
  const runId = `${Date.now()}_${nanoid(6).toLowerCase()}`;
  const createdUserIds: string[] = [];
  const createdEventIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdWebhookEventIds: string[] = [];
  let cachedPasswordHash: string;

  beforeAll(async () => {
    cachedPasswordHash = await bcrypt.hash('Outside2026!Stage2', 8);
  });

  async function createOrganizerFixture(suffix: string, stripeAccountId?: string | null) {
    const user = await prisma.user.create({
      data: {
        email: `stage2_${suffix}_${runId}@outside.vip`.toLowerCase(),
        name: `Stage2 Org ${suffix}`,
        passwordHash: cachedPasswordHash,
        role: Role.ORGANIZER,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        stripeAccountId: stripeAccountId === undefined ? `acct_stage2_${suffix}_${runId}` : stripeAccountId,
      },
    });
    createdUserIds.push(user.id);

    const event = await prisma.event.create({
      data: {
        organizerId: user.id,
        title: `Stage2 Event ${suffix} ${runId}`,
        description: 'Stage 2 settlement reliability fixture event',
        slug: `stage2-event-${suffix}-${runId}-${nanoid(4).toLowerCase()}`,
        coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
        venueName: 'Stage2 Arena',
        venueAddress: '100 Commerce Ave',
        city: 'New York',
        country: 'US',
        status: EventStatus.PUBLISHED,
        startAt: new Date(Date.now() + 86_400_000 * 3),
        endAt: new Date(Date.now() + 86_400_000 * 4),
        ticketTiers: {
          create: {
            name: 'GA',
            priceInCents: 2000,
            totalCapacity: 500,
            status: TicketTierStatus.ACTIVE,
          },
        },
      },
      include: { ticketTiers: true },
    });
    createdEventIds.push(event.id);

    return {
      organizer: user,
      event,
      tier: event.ticketTiers[0],
    };
  }

  async function createCompletedOrderFixture(opts: {
    eventId: string;
    tierId: string;
    organizerId: string;
    status?: OrderStatus;
    totalInCents?: number;
    platformFeeInCents?: number;
    organizerNetInCents?: number;
    paymentReference?: string | null;
    stripeSettledChargeId?: string | null;
    recordPendingLedger?: boolean;
  }) {
    const piId = opts.paymentReference === undefined ? `pi_s2_${nanoid(12)}` : opts.paymentReference;
    const total = opts.totalInCents ?? 2394;
    const fee = opts.platformFeeInCents ?? 394;
    const net = opts.organizerNetInCents ?? 2000;
    const status = opts.status ?? OrderStatus.COMPLETED;

    const order = await prisma.order.create({
      data: {
        orderNumber: `OUT-S2-${nanoid(8).toUpperCase()}`,
        eventId: opts.eventId,
        status,
        customerName: 'Stage2 Buyer',
        customerEmail: `buyer_${nanoid(6)}@outside.vip`,
        totalInCents: total,
        platformFeeInCents: fee,
        organizerNetInCents: net,
        currency: 'USD',
        idempotencyKey: `idem_s2_${nanoid(12)}`,
        paymentProvider: PaymentProvider.STRIPE,
        paymentReference: piId,
        stripeSettledChargeId: opts.stripeSettledChargeId ?? null,
        expiresAt: new Date(Date.now() + 900_000),
        items: {
          create: {
            ticketTierId: opts.tierId,
            quantity: 1,
            unitPriceInCents: net,
            subtotalInCents: net,
          },
        },
      },
    });
    createdOrderIds.push(order.id);

    if (opts.recordPendingLedger !== false && status === OrderStatus.COMPLETED) {
      await prisma.$transaction(async (tx) => {
        await recordTicketSalePending(tx, {
          orderId: order.id,
          paymentIntentId: piId || undefined,
          stripeChargeId: opts.stripeSettledChargeId || undefined,
          autoSettle: false,
        });
      });
    }

    return { order, paymentIntentId: piId };
  }

  function trackEvt<T extends { id: string }>(evt: T): T {
    createdWebhookEventIds.push(evt.id);
    return evt;
  }

  function stubUnrelatedStripeLookups() {
    vi.spyOn(stripe.paymentIntents, 'retrieve').mockImplementation(
      async (id: string) => ({ id, status: 'processing', latest_charge: null } as any)
    );
    vi.spyOn(stripe.balanceTransactions, 'retrieve').mockImplementation(
      async (id: string) => ({ id, status: 'pending', currency: 'usd', fee: 0 } as any)
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (createdWebhookEventIds.length > 0) {
      await prisma.processedWebhookEvent
        .deleteMany({ where: { eventId: { in: createdWebhookEventIds } } })
        .catch(() => {});
    }
    if (createdOrderIds.length > 0) {
      await prisma.orderRefund.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => {});
      await prisma.emailOutbox.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => {});
      await prisma.financialLedgerEntry.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => {});
      await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => {});
      await prisma.ticketReservation.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => {});
      await prisma.ticket.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => {});
      await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => {});
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => {});
    }
    if (createdEventIds.length > 0) {
      await prisma.ticketTier.deleteMany({ where: { eventId: { in: createdEventIds } } }).catch(() => {});
      await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } }).catch(() => {});
    }
    if (createdUserIds.length > 0) {
      await prisma.financialLedgerEntry.deleteMany({ where: { organizerId: { in: createdUserIds } } }).catch(() => {});
      await prisma.organizerTransfer.deleteMany({ where: { organizerId: { in: createdUserIds } } }).catch(() => {});
      await prisma.organizerBalance.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }
  });

  describe('1. Settlement Recovery & Multi-Worker Coordination', () => {
    it('moves funds from pending -> available once Stripe confirms available after an initial pending charge.updated', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('pend-to-avail');
      const chargeId = `ch_s2_pa_${nanoid(10)}`;
      const txnId = `txn_s2_pa_${nanoid(10)}`;
      const { order, paymentIntentId } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
      });

      const futureAvailableOn = Math.floor(Date.now() / 1000) + 172_800;
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_pending_${nanoid(12)}`,
          type: 'charge.updated',
          data: {
            object: {
              id: chargeId,
              payment_intent: paymentIntentId,
              currency: 'usd',
              status: 'succeeded',
              metadata: { orderId: order.id },
              balance_transaction: {
                id: txnId,
                status: 'pending',
                available_on: futureAvailableOn,
                fee: 99,
              },
            },
          },
        } as any)
      );

      let bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(2000);
      expect(bal?.availableBalanceInCents).toBe(0);

      const persisted = await prisma.order.findUnique({ where: { id: order.id } });
      expect(persisted?.stripeSettledChargeId).toBe(chargeId);
      expect(persisted?.stripeBalanceTransactionId).toBe(txnId);
      expect(persisted?.stripeSettlementStatus).toBe(StripeSettlementStatus.PENDING);

      // Make order due now (simulating clearing time reached without another charge.updated webhook)
      await prisma.order.update({
        where: { id: order.id },
        data: { stripeSettlementNextAttemptAt: new Date(Date.now() - 1000) },
      });

      vi.spyOn(stripe.charges, 'retrieve').mockImplementation(async (id: string) => {
        if (id === chargeId) {
          return {
            id: chargeId,
            status: 'succeeded',
            currency: 'usd',
            disputed: false,
            amount_refunded: 0,
            balance_transaction: {
              id: txnId,
              status: 'available',
              available_on: Math.floor(Date.now() / 1000) - 30,
              fee: 99,
            },
          } as any;
        }
        return { id, status: 'pending', balance_transaction: null } as any;
      });

      const passStats = await runSettlementRecoveryPass({ batchSize: 100 });
      expect(passStats.settled).toBeGreaterThanOrEqual(1);

      bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(0);
      expect(bal?.availableBalanceInCents).toBe(2000);

      const afterOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(afterOrder?.stripeSettlementStatus).toBe(StripeSettlementStatus.SETTLED);
      expect(afterOrder?.stripeActualFeeRecordedAt).not.toBeNull();

      // Actual fee recorded once (not duplicated by charge.updated + recovery)
      const actualFees = await prisma.financialLedgerEntry.findMany({
        where: { orderId: order.id, type: LedgerEntryType.STRIPE_PROCESSING_FEE },
      });
      expect(actualFees.filter((e) => (e.metadata as any)?.isActualReconciliation)).toHaveLength(1);
    });

    it('recovers delayed/missed charge.updated via PaymentIntent.latest_charge and remains idempotent under late duplicate webhooks', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('missed-cu');
      const { order, paymentIntentId } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        status: OrderStatus.PENDING,
        recordPendingLedger: false,
      });

      await prisma.ticketReservation.create({
        data: {
          orderId: order.id,
          ticketTierId: tier.id,
          quantity: 1,
          expiresAt: new Date(Date.now() + 900_000),
        },
      });
      await prisma.ticketTier.update({
        where: { id: tier.id },
        data: { reservedQuantity: { increment: 1 } },
      });

      // Fulfill via payment_intent.succeeded WITHOUT charge.updated ever arriving
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_pi_${nanoid(12)}`,
          type: 'payment_intent.succeeded',
          data: {
            object: {
              id: paymentIntentId,
              amount: 2394,
              currency: 'usd',
              status: 'succeeded',
              metadata: { orderId: order.id },
            },
          },
        } as any)
      );

      // Move nextAttemptAt into the past so worker claims immediately
      await prisma.order.update({
        where: { id: order.id },
        data: { stripeSettlementNextAttemptAt: new Date(Date.now() - 1000) },
      });

      const chargeId = `ch_s2_rec_${nanoid(10)}`;
      const txnId = `txn_s2_rec_${nanoid(10)}`;
      vi.spyOn(stripe.paymentIntents, 'retrieve').mockImplementation(async (id: string) => {
        if (id === paymentIntentId) {
          return {
            id: paymentIntentId,
            status: 'succeeded',
            latest_charge: {
              id: chargeId,
              status: 'succeeded',
              currency: 'usd',
              disputed: false,
              amount_refunded: 0,
              balance_transaction: {
                id: txnId,
                status: 'available',
                available_on: Math.floor(Date.now() / 1000) - 60,
                fee: 99,
              },
            },
          } as any;
        }
        return { id, status: 'processing', latest_charge: null } as any;
      });
      vi.spyOn(stripe.charges, 'retrieve').mockImplementation(async (id: string) => ({
        id,
        status: 'pending',
        balance_transaction: null,
      } as any));

      const pass = await runSettlementRecoveryPass({ batchSize: 100 });
      expect(pass.settled).toBeGreaterThanOrEqual(1);

      let bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(0);
      expect(bal?.availableBalanceInCents).toBe(2000);

      // Delayed charge.updated finally arrives + duplicate -> strictly idempotent
      const delayedEvt = trackEvt({
        id: `evt_s2_delayed_${nanoid(12)}`,
        type: 'charge.updated',
        data: {
          object: {
            id: chargeId,
            payment_intent: paymentIntentId,
            currency: 'usd',
            status: 'succeeded',
            metadata: { orderId: order.id },
            balance_transaction: {
              id: txnId,
              status: 'available',
              available_on: Math.floor(Date.now() / 1000) - 60,
              fee: 99,
            },
          },
        },
      } as any);
      await processStripeWebhookEvent(delayedEvt);
      const dupRes = await processStripeWebhookEvent(delayedEvt);
      expect(dupRes.duplicate).toBe(true);

      bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.availableBalanceInCents).toBe(2000);

      const clearedEntries = await prisma.financialLedgerEntry.findMany({
        where: { orderId: order.id, type: LedgerEntryType.TICKET_SALE_CLEARED },
      });
      expect(clearedEntries).toHaveLength(1);
    });

    it('handles balance.available as a recovery nudge without trusting it to settle pending Stripe funds', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('bal-avail');
      const chargeId = `ch_s2_ba_${nanoid(10)}`;
      const txnId = `txn_s2_ba_${nanoid(10)}`;
      const { order } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        stripeSettledChargeId: chargeId,
      });

      // Scheduled check is 2 hours in the future (near-due)
      await prisma.order.update({
        where: { id: order.id },
        data: {
          stripeBalanceTransactionId: txnId,
          stripeSettlementStatus: StripeSettlementStatus.PENDING,
          stripeAvailableOn: new Date(Date.now() + 2 * 3_600_000),
          stripeSettlementNextAttemptAt: new Date(Date.now() + 2 * 3_600_000),
        },
      });

      // Deliver platform balance.available webhook
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_ba_${nanoid(12)}`,
          type: 'balance.available',
          data: { object: { available: [{ amount: 500_000, currency: 'usd' }] } },
        } as any)
      );

      const nudgedOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(nudgedOrder?.stripeSettlementNextAttemptAt!.getTime()).toBeLessThanOrEqual(
        Date.now() + 5_000
      );

      // Even after balance.available, if Stripe still reports THIS charge's balance_transaction as pending,
      // organizer funds MUST NOT become available prematurely
      vi.spyOn(stripe.charges, 'retrieve').mockImplementation(async (id: string) => ({
        id,
        status: 'succeeded',
        currency: 'usd',
        balance_transaction: {
          id: id === chargeId ? txnId : `txn_other_${id}`,
          status: 'pending',
          available_on: Math.floor(Date.now() / 1000) + 3600,
          fee: 99,
        },
      } as any));

      const pendingPass = await runSettlementRecoveryPass({ batchSize: 100 });
      expect(pendingPass.stripePending).toBeGreaterThanOrEqual(1);

      let bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(2000);
      expect(bal?.availableBalanceInCents).toBe(0);

      // Once Stripe flips BalanceTransaction to available, recovery settles cleanly
      await prisma.order.update({
        where: { id: order.id },
        data: { stripeSettlementNextAttemptAt: new Date(Date.now() - 1000) },
      });

      vi.spyOn(stripe.charges, 'retrieve').mockImplementation(async (id: string) => {
        if (id === chargeId) {
          return {
            id: chargeId,
            status: 'succeeded',
            currency: 'usd',
            disputed: false,
            amount_refunded: 0,
            balance_transaction: {
              id: txnId,
              status: 'available',
              available_on: Math.floor(Date.now() / 1000) - 10,
              fee: 99,
            },
          } as any;
        }
        return { id, status: 'pending', balance_transaction: null } as any;
      });

      await runSettlementRecoveryPass({ batchSize: 100 });
      bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(0);
      expect(bal?.availableBalanceInCents).toBe(2000);
    });

    it('retries bounded transient Stripe timeouts cleanly and isolates multiple concurrent API workers', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('worker-race');
      const chargeId = `ch_s2_wr_${nanoid(10)}`;
      const { order } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        stripeSettledChargeId: chargeId,
      });

      await prisma.order.update({
        where: { id: order.id },
        data: {
          stripeSettlementStatus: StripeSettlementStatus.PENDING,
          stripeSettlementNextAttemptAt: new Date(Date.now() - 1000),
        },
      });

      // Pass 1: Transient timeout schedules backoff retry without marking permanent failure
      vi.spyOn(stripe.charges, 'retrieve').mockImplementation(async (id: string) => {
        if (id === chargeId) {
          throw Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' });
        }
        return { id, status: 'pending', balance_transaction: null } as any;
      });
      const retryPass = await runSettlementRecoveryPass({
        workerId: 'worker-timeout-1',
        batchSize: 100,
        randomFn: () => 0.5,
      });
      expect(retryPass.retried).toBeGreaterThanOrEqual(1);

      const afterRetry = await prisma.order.findUnique({ where: { id: order.id } });
      expect(afterRetry?.stripeSettlementStatus).toBe(StripeSettlementStatus.PENDING);
      expect(afterRetry?.stripeSettlementAttempts).toBe(1);
      expect(afterRetry?.stripeSettlementLastErrorCategory).toBe('RETRYABLE');

      // Make due again and race 3 concurrent recovery workers against the same order
      await prisma.order.update({
        where: { id: order.id },
        data: { stripeSettlementNextAttemptAt: new Date(Date.now() - 1000) },
      });

      vi.spyOn(stripe.charges, 'retrieve').mockImplementation(async (id: string) => {
        if (id === chargeId) {
          await new Promise((r) => setTimeout(r, 40));
          return {
            id: chargeId,
            status: 'succeeded',
            currency: 'usd',
            disputed: false,
            amount_refunded: 0,
            balance_transaction: {
              id: `txn_wr_${nanoid(8)}`,
              status: 'available',
              available_on: Math.floor(Date.now() / 1000) - 10,
              fee: 99,
            },
          } as any;
        }
        return { id, status: 'pending', balance_transaction: null } as any;
      });

      await Promise.all([
        runSettlementRecoveryPass({ workerId: 'worker-race-A', batchSize: 100 }),
        runSettlementRecoveryPass({ workerId: 'worker-race-B', batchSize: 100 }),
        runSettlementRecoveryPass({ workerId: 'worker-race-C', batchSize: 100 }),
      ]);

      const bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(0);
      expect(bal?.availableBalanceInCents).toBe(2000);

      const cleared = await prisma.financialLedgerEntry.findMany({
        where: { orderId: order.id, type: LedgerEntryType.TICKET_SALE_CLEARED },
      });
      expect(cleared).toHaveLength(1);
    });

    it('holds disputed earnings in pending until the dispute is won', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('dispute-hold');
      const chargeId = `ch_s2_dh_${nanoid(10)}`;
      const disputeId = `dp_s2_dh_${nanoid(10)}`;
      const { order, paymentIntentId } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        stripeSettledChargeId: chargeId,
      });

      // Open dispute while order is still PENDING settlement
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_dc_${nanoid(12)}`,
          type: 'charge.dispute.created',
          data: {
            object: {
              id: disputeId,
              charge: chargeId,
              amount: 2394,
              status: 'needs_response',
              reason: 'fraudulent',
            },
          },
        } as any)
      );

      // charge.updated reports BalanceTransaction available -> must STILL hold in PENDING because dispute is open
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_dh_cu_${nanoid(12)}`,
          type: 'charge.updated',
          data: {
            object: {
              id: chargeId,
              payment_intent: paymentIntentId,
              currency: 'usd',
              status: 'succeeded',
              disputed: true,
              metadata: { orderId: order.id },
              balance_transaction: {
                id: `txn_dh_${nanoid(8)}`,
                status: 'available',
                available_on: Math.floor(Date.now() / 1000) - 60,
                fee: 99,
              },
            },
          },
        } as any)
      );

      let bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(2000);
      expect(bal?.availableBalanceInCents).toBe(0);

      // Dispute closes WON -> nudges settlement -> recovery settles into available
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_dw_${nanoid(12)}`,
          type: 'charge.dispute.closed',
          data: {
            object: {
              id: disputeId,
              charge: chargeId,
              amount: 2394,
              status: 'won',
              reason: 'fraudulent',
            },
          },
        } as any)
      );

      vi.spyOn(stripe.charges, 'retrieve').mockImplementation(async (id: string) => {
        if (id === chargeId) {
          return {
            id: chargeId,
            status: 'succeeded',
            currency: 'usd',
            disputed: true,
            amount_refunded: 0,
            balance_transaction: {
              id: `txn_dh_${nanoid(8)}`,
              status: 'available',
              available_on: Math.floor(Date.now() / 1000) - 60,
              fee: 99,
            },
          } as any;
        }
        return { id, status: 'pending', balance_transaction: null } as any;
      });

      const afterWin = await runSettlementRecoveryPass({ batchSize: 100 });
      expect(afterWin.settled).toBeGreaterThanOrEqual(1);

      bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(0);
      expect(bal?.availableBalanceInCents).toBe(2000);
    });
  });

  describe('2. Pre-Settlement Refund Accounting (Full, Partial, Repeated & Post-Settlement)', () => {
    it('prevents full pre-settlement refund from creating withdrawable available earnings on settlement', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('full-ref-pre');
      const chargeId = `ch_s2_frp_${nanoid(10)}`;
      const { order, paymentIntentId } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        stripeSettledChargeId: chargeId,
      });

      // Full refund while earnings are still pending
      const refundEvt = trackEvt({
        id: `evt_s2_fr_${nanoid(12)}`,
        type: 'charge.refunded',
        data: {
          object: {
            id: chargeId,
            payment_intent: paymentIntentId,
            amount_refunded: 2394,
            currency: 'usd',
            metadata: { orderId: order.id },
            refunds: { data: [{ id: `re_s2_fr_${nanoid(8)}`, amount: 2394 }] },
          },
        },
      } as any);
      await processStripeWebhookEvent(refundEvt);
      // Repeated delivery of same refund webhook
      await processStripeWebhookEvent(
        trackEvt({ ...refundEvt, id: `evt_s2_fr_dup_${nanoid(12)}` })
      );

      let bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(0);
      expect(bal?.availableBalanceInCents).toBe(0);

      // Now charge settles as available -> must settle at $0.00, NEVER credit 2000 to available
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_fr_cu_${nanoid(12)}`,
          type: 'charge.updated',
          data: {
            object: {
              id: chargeId,
              payment_intent: paymentIntentId,
              currency: 'usd',
              status: 'succeeded',
              metadata: { orderId: order.id },
              balance_transaction: {
                id: `txn_s2_fr_${nanoid(8)}`,
                status: 'available',
                available_on: Math.floor(Date.now() / 1000) - 30,
                fee: 99,
              },
            },
          },
        } as any)
      );

      bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(0);
      expect(bal?.availableBalanceInCents).toBe(0);

      const reconcile = await reconcileOrganizerFinance(organizer.id);
      expect(reconcile.isReconciled).toBe(true);
    });

    it('settles only the non-refunded remainder after a partial pre-settlement refund', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('part-ref-pre');
      const chargeId = `ch_s2_prp_${nanoid(10)}`;
      const { order, paymentIntentId } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        stripeSettledChargeId: chargeId,
      });

      // Partial refund of 1197 / 2394 => exact 50% => 1000 cents organizer portion
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_pr_${nanoid(12)}`,
          type: 'charge.refunded',
          data: {
            object: {
              id: chargeId,
              payment_intent: paymentIntentId,
              amount_refunded: 1197,
              currency: 'usd',
              metadata: { orderId: order.id },
              refunds: { data: [{ id: `re_s2_pr_${nanoid(8)}`, amount: 1197 }] },
            },
          },
        } as any)
      );

      let bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(1000);
      expect(bal?.availableBalanceInCents).toBe(0);

      // Settle remainder
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_pr_cu_${nanoid(12)}`,
          type: 'charge.updated',
          data: {
            object: {
              id: chargeId,
              payment_intent: paymentIntentId,
              currency: 'usd',
              status: 'succeeded',
              metadata: { orderId: order.id },
              balance_transaction: {
                id: `txn_s2_pr_${nanoid(8)}`,
                status: 'available',
                available_on: Math.floor(Date.now() / 1000) - 30,
                fee: 99,
              },
            },
          },
        } as any)
      );

      bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(0);
      expect(bal?.availableBalanceInCents).toBe(1000);

      const reconcile = await reconcileOrganizerFinance(organizer.id);
      expect(reconcile.isReconciled).toBe(true);
    });

    it('deducts post-settlement refunds from available balance accurately without disrupting prior settlement', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('post-settle-ref');
      const chargeId = `ch_s2_psr_${nanoid(10)}`;
      const { order, paymentIntentId } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        stripeSettledChargeId: chargeId,
      });

      await settlePendingOrder(order.id, chargeId);

      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_psr_${nanoid(12)}`,
          type: 'charge.refunded',
          data: {
            object: {
              id: chargeId,
              payment_intent: paymentIntentId,
              amount_refunded: 2394,
              currency: 'usd',
              metadata: { orderId: order.id },
              refunds: { data: [{ id: `re_s2_psr_${nanoid(8)}`, amount: 2394 }] },
            },
          },
        } as any)
      );

      const bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(0);
      expect(bal?.availableBalanceInCents).toBe(0);

      const reconcile = await reconcileOrganizerFinance(organizer.id);
      expect(reconcile.isReconciled).toBe(true);
    });
  });

  describe('3. Concurrency, Row Locking & Race Protections', () => {
    it('creates initial OrganizerBalance safely under concurrent first-time orders', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('conc-init');
      const { order: o1 } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        recordPendingLedger: false,
      });
      const { order: o2 } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        recordPendingLedger: false,
      });
      const { order: o3 } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        recordPendingLedger: false,
      });

      // Confirm NO OrganizerBalance row exists yet
      const beforeBal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(beforeBal).toBeNull();

      await Promise.all([
        prisma.$transaction((tx) => recordTicketSalePending(tx, { orderId: o1.id })),
        prisma.$transaction((tx) => recordTicketSalePending(tx, { orderId: o2.id })),
        prisma.$transaction((tx) => recordTicketSalePending(tx, { orderId: o3.id })),
        prisma.$transaction((tx) => getOrCreateOrganizerBalance(tx, organizer.id, 'USD')),
      ]);

      const afterBal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(afterBal?.pendingBalanceInCents).toBe(6000);
      expect((await reconcileOrganizerFinance(organizer.id)).isReconciled).toBe(true);
    });

    it('serializes concurrent settlement attempts, settlement vs withdrawal, and settlement vs refund', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('conc-races');
      const { order: o1, paymentIntentId: pi1 } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
      });
      const { order: o2 } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
      });
      const { order: o3, paymentIntentId: pi3 } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
      });

      // Seed o1 as settled so $20 is available for withdrawal race
      await settlePendingOrder(o1.id, `ch_race_1_${nanoid(6)}`);

      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValue({
        id: organizer.stripeAccountId,
        country: 'US',
        default_currency: 'usd',
        payouts_enabled: true,
        charges_enabled: true,
        details_submitted: true,
        capabilities: { transfers: 'active', card_payments: 'active' },
        requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
      } as any);
      vi.spyOn(stripe.transfers, 'create').mockResolvedValue({
        id: `tr_s2_race_${nanoid(8)}`,
        amount: 2000,
        currency: 'usd',
        destination: organizer.stripeAccountId,
      } as any);

      // Concurrently race:
      // - 2 duplicate settlement calls on o2
      // - withdrawal of $20 (from o1's cleared balance)
      // - refund + settlement race on o3
      await Promise.all([
        settlePendingOrder(o2.id, `ch_race_2a_${nanoid(6)}`),
        settlePendingOrder(o2.id, `ch_race_2b_${nanoid(6)}`),
        executeWithdrawal({
          userId: organizer.id,
          amountInCents: 2000,
          idempotencyKey: `withdr_s2_${nanoid(8)}`,
        }),
        processStripeWebhookEvent(
          trackEvt({
            id: `evt_s2_race_ref3_${nanoid(10)}`,
            type: 'charge.refunded',
            data: {
              object: {
                id: `ch_race_3_${nanoid(6)}`,
                payment_intent: pi3,
                amount_refunded: 2394,
                currency: 'usd',
                metadata: { orderId: o3.id },
                refunds: { data: [{ id: `re_race_3_${nanoid(6)}`, amount: 2394 }] },
              },
            },
          } as any)
        ),
        processStripeWebhookEvent(
          trackEvt({
            id: `evt_s2_race_cu3_${nanoid(10)}`,
            type: 'charge.updated',
            data: {
              object: {
                id: `ch_race_3_${nanoid(6)}`,
                payment_intent: pi3,
                currency: 'usd',
                status: 'succeeded',
                metadata: { orderId: o3.id },
                balance_transaction: {
                  id: `txn_race_3_${nanoid(6)}`,
                  status: 'available',
                  available_on: Math.floor(Date.now() / 1000) - 10,
                  fee: 99,
                },
              },
            },
          } as any)
        ),
        // Ensure pi1 reference used cleanly if checked
        Promise.resolve(pi1),
      ]);

      const bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBeGreaterThanOrEqual(0);
      expect(bal?.availableBalanceInCents).toBeGreaterThanOrEqual(0);
      // Net financial position across o1 ($20 cleared - $20 withdrawn), o2 ($20 cleared), o3 ($0 net after full refund)
      const summary = await reconcileOrganizerFinance(organizer.id);
      expect(summary.isReconciled).toBe(true);
      expect(
        (bal!.pendingBalanceInCents + bal!.availableBalanceInCents) - summary.ledgerTotals.recoverableInCents
      ).toBe(2000);
    });
  });

  describe('4. Webhook Reliability: Transient vs Permanent Failures, Out-of-Order & Lease Recovery', () => {
    it('does not swallow transient Stripe errors on charge.updated and succeeds cleanly on webhook retry', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('wh-transient');
      const chargeId = `ch_s2_tr_${nanoid(10)}`;
      const txnId = `txn_s2_tr_${nanoid(10)}`;
      const { order, paymentIntentId } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
      });

      const evtId = `evt_s2_wh_tr_${nanoid(12)}`;
      const chargeEvt: Stripe.Event = trackEvt({
        id: evtId,
        type: 'charge.updated',
        data: {
          object: {
            id: chargeId,
            payment_intent: paymentIntentId,
            currency: 'usd',
            status: 'succeeded',
            metadata: { orderId: order.id },
            balance_transaction: txnId,
          },
        },
      } as any);

      vi.spyOn(stripe.balanceTransactions, 'retrieve').mockRejectedValueOnce(
        Object.assign(new Error('Stripe upstream connection timed out'), {
          type: 'StripeConnectionError',
          code: 'ETIMEDOUT',
        })
      );

      await expect(processStripeWebhookEvent(chargeEvt)).rejects.toThrow(/timed out/i);

      // Must NOT have committed ProcessedWebhookEvent so retry is NOT dropped as duplicate
      const processedAfterFail = await prisma.processedWebhookEvent.findUnique({
        where: { eventId: evtId },
      });
      expect(processedAfterFail).toBeNull();

      // Retry same event ID after Stripe recovers -> settles once
      vi.spyOn(stripe.balanceTransactions, 'retrieve').mockResolvedValueOnce({
        id: txnId,
        status: 'available',
        available_on: Math.floor(Date.now() / 1000) - 30,
        fee: 99,
      } as any);

      const retryRes = await processStripeWebhookEvent(chargeEvt);
      expect(retryRes.handled).toBe(true);
      expect(retryRes.duplicate).toBeUndefined();

      const bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(0);
      expect(bal?.availableBalanceInCents).toBe(2000);
    });

    it('marks permanent Stripe retrieval errors as FAILED_PERMANENT without looping webhook retries', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('wh-perm');
      const chargeId = `ch_s2_pm_${nanoid(10)}`;
      const badTxnId = `txn_missing_${nanoid(10)}`;
      const { order, paymentIntentId } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
      });

      vi.spyOn(stripe.balanceTransactions, 'retrieve').mockRejectedValueOnce(
        Object.assign(new Error(`No such balance transaction: ${badTxnId}`), {
          type: 'StripeInvalidRequestError',
          code: 'resource_missing',
          statusCode: 404,
        })
      );

      const evtId = `evt_s2_wh_pm_${nanoid(12)}`;
      const res = await processStripeWebhookEvent(
        trackEvt({
          id: evtId,
          type: 'charge.updated',
          data: {
            object: {
              id: chargeId,
              payment_intent: paymentIntentId,
              currency: 'usd',
              status: 'succeeded',
              metadata: { orderId: order.id },
              balance_transaction: badTxnId,
            },
          },
        } as any)
      );
      expect(res.handled).toBe(true);

      const processed = await prisma.processedWebhookEvent.findUnique({ where: { eventId: evtId } });
      expect(processed).not.toBeNull();

      const updatedOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(updatedOrder?.stripeSettlementStatus).toBe(StripeSettlementStatus.FAILED_PERMANENT);
      expect(updatedOrder?.stripeSettlementLastErrorCategory).toBe('PERMANENT');
      expect(updatedOrder?.stripeSettlementLastErrorCode).toBe('resource_missing');

      const bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.availableBalanceInCents).toBe(0);
    });

    it('reclaims interrupted expired worker leases and transitions exhausted leases to FAILED_PERMANENT', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('lease-rec');
      const chargeA = `ch_s2_la_${nanoid(8)}`;
      const { order: recoverableOrder } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        stripeSettledChargeId: chargeA,
      });
      const { order: exhaustedOrder } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        stripeSettledChargeId: `ch_s2_lb_${nanoid(8)}`,
      });

      const expiredLease = new Date(Date.now() - 120_000);
      await prisma.order.update({
        where: { id: recoverableOrder.id },
        data: {
          stripeSettlementStatus: StripeSettlementStatus.PENDING,
          stripeSettlementLockedBy: 'crashed-worker-1',
          stripeSettlementLockedUntil: expiredLease,
          stripeSettlementAttempts: 1,
        },
      });
      await prisma.order.update({
        where: { id: exhaustedOrder.id },
        data: {
          stripeSettlementStatus: StripeSettlementStatus.PENDING,
          stripeSettlementLockedBy: 'crashed-worker-2',
          stripeSettlementLockedUntil: expiredLease,
          stripeSettlementAttempts: SETTLEMENT_MAX_ATTEMPTS,
        },
      });

      vi.spyOn(stripe.charges, 'retrieve').mockImplementation(async (id: string) => {
        if (id === chargeA) {
          return {
            id: chargeA,
            status: 'succeeded',
            currency: 'usd',
            disputed: false,
            amount_refunded: 0,
            balance_transaction: {
              id: `txn_la_${nanoid(8)}`,
              status: 'available',
              available_on: Math.floor(Date.now() / 1000) - 10,
              fee: 99,
            },
          } as any;
        }
        return { id, status: 'pending', balance_transaction: null } as any;
      });

      const pass = await runSettlementRecoveryPass({ workerId: 'healthy-worker', batchSize: 100 });
      expect(pass.reapedExhausted).toBeGreaterThanOrEqual(1);
      expect(pass.settled).toBeGreaterThanOrEqual(1);

      const recAfter = await prisma.order.findUnique({ where: { id: recoverableOrder.id } });
      expect(recAfter?.stripeSettlementStatus).toBe(StripeSettlementStatus.SETTLED);

      const exhAfter = await prisma.order.findUnique({ where: { id: exhaustedOrder.id } });
      expect(exhAfter?.stripeSettlementStatus).toBe(StripeSettlementStatus.FAILED_PERMANENT);
      expect(exhAfter?.stripeSettlementLastErrorCode).toBe('WORKER_LEASE_EXPIRED_MAX_ATTEMPTS');
    });

    it('handles out-of-order charge.updated(available) followed by payment_intent.succeeded safely', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('ooo-settle');
      const chargeId = `ch_s2_ooo_${nanoid(8)}`;
      const txnId = `txn_s2_ooo_${nanoid(8)}`;
      const { order, paymentIntentId } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        status: OrderStatus.PENDING,
        recordPendingLedger: false,
      });

      await prisma.ticketReservation.create({
        data: {
          orderId: order.id,
          ticketTierId: tier.id,
          quantity: 1,
          expiresAt: new Date(Date.now() + 900_000),
        },
      });
      await prisma.ticketTier.update({
        where: { id: tier.id },
        data: { reservedQuantity: { increment: 1 } },
      });

      // Step 1: charge.updated arrives BEFORE payment_intent.succeeded
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_ooo_cu_${nanoid(12)}`,
          type: 'charge.updated',
          data: {
            object: {
              id: chargeId,
              payment_intent: paymentIntentId,
              currency: 'usd',
              status: 'succeeded',
              metadata: { orderId: order.id },
              balance_transaction: {
                id: txnId,
                status: 'available',
                available_on: Math.floor(Date.now() / 1000) - 30,
                fee: 99,
              },
            },
          },
        } as any)
      );

      // Step 2: payment_intent.succeeded arrives -> fulfills & settles immediately
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_ooo_pi_${nanoid(12)}`,
          type: 'payment_intent.succeeded',
          data: {
            object: {
              id: paymentIntentId,
              amount: 2394,
              currency: 'usd',
              status: 'succeeded',
              metadata: { orderId: order.id },
              latest_charge: chargeId,
            },
          },
        } as any)
      );

      const bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(0);
      expect(bal?.availableBalanceInCents).toBe(2000);

      const finalOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(finalOrder?.status).toBe(OrderStatus.COMPLETED);
      expect(finalOrder?.stripeSettlementStatus).toBe(StripeSettlementStatus.SETTLED);
    });
  });

  describe('5. Remediation Adversarial Scenarios: Missed Refunds, Disputed Out-of-Order, Concurrent Webhook/Worker & Lease Expiry', () => {
    it('reconciles missed charge.refunded when available charge.updated arrives first with amount_refunded > 0 (partial + delayed webhook idempotency)', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('missed-ref-cu');
      const chargeId = `ch_s2_mrcu_${nanoid(8)}`;
      const refundId = `re_s2_mrcu_${nanoid(8)}`;
      const { order, paymentIntentId } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        stripeSettledChargeId: chargeId,
      });

      // charge.refunded webhook was missed; available charge.updated arrives carrying amount_refunded = 1197 (50% = 1000 organizer cents)
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_mrcu_cu_${nanoid(10)}`,
          type: 'charge.updated',
          data: {
            object: {
              id: chargeId,
              payment_intent: paymentIntentId,
              currency: 'usd',
              status: 'succeeded',
              amount_refunded: 1197,
              refunds: { data: [{ id: refundId, amount: 1197 }] },
              metadata: { orderId: order.id },
              balance_transaction: {
                id: `txn_mrcu_${nanoid(8)}`,
                status: 'available',
                available_on: Math.floor(Date.now() / 1000) - 30,
                fee: 99,
              },
            },
          },
        } as any)
      );

      let bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(0);
      expect(bal?.availableBalanceInCents).toBe(1000);

      // Delayed charge.refunded finally arrives with the exact same refund -> MUST NOT double-deduct
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_mrcu_ref_${nanoid(10)}`,
          type: 'charge.refunded',
          data: {
            object: {
              id: chargeId,
              payment_intent: paymentIntentId,
              currency: 'usd',
              amount_refunded: 1197,
              metadata: { orderId: order.id },
              refunds: { data: [{ id: refundId, amount: 1197 }] },
            },
          },
        } as any)
      );

      bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.availableBalanceInCents).toBe(1000);
      expect((await reconcileOrganizerFinance(organizer.id)).isReconciled).toBe(true);
    });

    it('blocks out-of-order charge.updated(disputed: true) before charge.dispute.created and payment_intent.succeeded, then handles DISPUTE_LOST recovery', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('ooo-disp-lost');
      const chargeId = `ch_s2_odl_${nanoid(8)}`;
      const disputeId = `dp_s2_odl_${nanoid(8)}`;
      const { order, paymentIntentId } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        status: OrderStatus.PENDING,
        recordPendingLedger: false,
      });

      await prisma.ticketReservation.create({
        data: {
          orderId: order.id,
          ticketTierId: tier.id,
          quantity: 1,
          expiresAt: new Date(Date.now() + 900_000),
        },
      });
      await prisma.ticketTier.update({
        where: { id: tier.id },
        data: { reservedQuantity: { increment: 1 } },
      });

      // 1. Out-of-order charge.updated(available, disputed: true) arrives BEFORE payment_intent.succeeded & charge.dispute.created
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_odl_cu_${nanoid(10)}`,
          type: 'charge.updated',
          data: {
            object: {
              id: chargeId,
              payment_intent: paymentIntentId,
              currency: 'usd',
              status: 'succeeded',
              disputed: true,
              metadata: { orderId: order.id },
              balance_transaction: {
                id: `txn_odl_${nanoid(8)}`,
                status: 'available',
                available_on: Math.floor(Date.now() / 1000) - 30,
                fee: 99,
              },
            },
          },
        } as any)
      );

      const bufferedOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(bufferedOrder?.stripeFundsAvailableAt).toBeNull();

      // 2. payment_intent.succeeded fulfills -> funds MUST land in PENDING, NOT auto-settled
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_odl_pi_${nanoid(10)}`,
          type: 'payment_intent.succeeded',
          data: {
            object: {
              id: paymentIntentId,
              amount: 2394,
              currency: 'usd',
              status: 'succeeded',
              metadata: { orderId: order.id },
              latest_charge: chargeId,
            },
          },
        } as any)
      );

      let bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(2000);
      expect(bal?.availableBalanceInCents).toBe(0);

      // 3. Repeated dispute hold/update events keep funds held in PENDING
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_odl_dc_${nanoid(10)}`,
          type: 'charge.dispute.created',
          data: {
            object: { id: disputeId, charge: chargeId, amount: 2394, status: 'needs_response', reason: 'fraudulent' },
          },
        } as any)
      );
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_odl_du_${nanoid(10)}`,
          type: 'charge.dispute.updated',
          data: {
            object: { id: disputeId, charge: chargeId, amount: 2394, status: 'under_review', reason: 'fraudulent' },
          },
        } as any)
      );

      // 4. Dispute closes as LOST -> records RECOVERABLE (-2000), nudges settlement, settles pending (+2000) and offsets RECOVERABLE (+2000)
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_odl_dl_${nanoid(10)}`,
          type: 'charge.dispute.closed',
          data: {
            object: { id: disputeId, charge: chargeId, amount: 2394, status: 'lost', reason: 'fraudulent' },
          },
        } as any)
      );

      vi.spyOn(stripe.charges, 'retrieve').mockImplementation(async (id: string) => {
        if (id === chargeId) {
          return {
            id: chargeId,
            status: 'succeeded',
            currency: 'usd',
            disputed: true,
            amount_refunded: 0,
            balance_transaction: {
              id: `txn_odl_${nanoid(8)}`,
              status: 'available',
              available_on: Math.floor(Date.now() / 1000) - 30,
              fee: 99,
            },
          } as any;
        }
        return { id, status: 'pending', balance_transaction: null } as any;
      });

      const pass = await runSettlementRecoveryPass({ batchSize: 100 });
      expect(pass.settled).toBeGreaterThanOrEqual(1);

      bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(0);
      expect(bal?.availableBalanceInCents).toBe(0);
      const summary = await getOrganizerFinancialSummary(organizer.id);
      expect(summary.recoverableInCents).toBe(0);
      expect(summary.netAvailableInCents).toBe(0);
      expect((await reconcileOrganizerFinance(organizer.id)).isReconciled).toBe(true);
    });

    it('handles two consecutive partial refunds before settlement cleanly across recovery worker reconciliation', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('two-part-pre');
      const chargeId = `ch_s2_tpp_${nanoid(8)}`;
      const { order, paymentIntentId } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        stripeSettledChargeId: chargeId,
      });

      // Partial refund #1: 1000 / 2394 => 835 cents organizer share
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_tpp_1_${nanoid(10)}`,
          type: 'charge.refunded',
          data: {
            object: {
              id: chargeId,
              payment_intent: paymentIntentId,
              currency: 'usd',
              amount_refunded: 1000,
              metadata: { orderId: order.id },
              refunds: { data: [{ id: `re_tpp_1_${nanoid(6)}`, amount: 1000 }] },
            },
          },
        } as any)
      );

      // Partial refund #2: cumulative 1500 / 2394 => 1253 - 835 = 418 cents organizer share
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_tpp_2_${nanoid(10)}`,
          type: 'charge.refunded',
          data: {
            object: {
              id: chargeId,
              payment_intent: paymentIntentId,
              currency: 'usd',
              amount_refunded: 1500,
              metadata: { orderId: order.id },
              refunds: { data: [{ id: `re_tpp_2_${nanoid(6)}`, amount: 500 }] },
            },
          },
        } as any)
      );

      let bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(747);
      expect(bal?.availableBalanceInCents).toBe(0);

      await prisma.order.update({
        where: { id: order.id },
        data: { stripeSettlementNextAttemptAt: new Date(Date.now() - 1000) },
      });

      stubUnrelatedStripeLookups();
      vi.spyOn(stripe.charges, 'retrieve').mockImplementation(async (id: string) => {
        if (id === chargeId) {
          return {
            id: chargeId,
            status: 'succeeded',
            currency: 'usd',
            disputed: false,
            amount_refunded: 1500,
            refunds: {
              data: [
                { id: `re_tpp_1_${nanoid(6)}`, amount: 1000 },
                { id: `re_tpp_2_${nanoid(6)}`, amount: 500 },
              ],
            },
            balance_transaction: {
              id: `txn_tpp_${nanoid(8)}`,
              status: 'available',
              available_on: Math.floor(Date.now() / 1000) - 20,
              fee: 99,
            },
          } as any;
        }
        return { id, status: 'pending', balance_transaction: null } as any;
      });

      const pass = await runSettlementRecoveryPass({ batchSize: 100 });
      expect(pass.settled).toBeGreaterThanOrEqual(1);

      bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(0);
      expect(bal?.availableBalanceInCents).toBe(747);
      expect((await reconcileOrganizerFinance(organizer.id)).isReconciled).toBe(true);
    }, 15_000);

    it('serializes a live concurrent charge.updated webhook racing with an in-flight recovery worker pass', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('wh-vs-worker');
      const chargeId = `ch_s2_wvw_${nanoid(8)}`;
      const txnId = `txn_s2_wvw_${nanoid(8)}`;
      const { order, paymentIntentId } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        stripeSettledChargeId: chargeId,
      });

      await prisma.order.update({
        where: { id: order.id },
        data: {
          stripeSettlementStatus: StripeSettlementStatus.PENDING,
          stripeSettlementNextAttemptAt: new Date(Date.now() - 1000),
        },
      });

      let workerInStripeResolve!: () => void;
      const workerInStripe = new Promise<void>((r) => {
        workerInStripeResolve = r;
      });
      let allowWorkerProceed!: () => void;
      const workerGate = new Promise<void>((r) => {
        allowWorkerProceed = r;
      });

      stubUnrelatedStripeLookups();
      vi.spyOn(stripe.charges, 'retrieve').mockImplementation(async (id: string) => {
        if (id === chargeId) {
          workerInStripeResolve();
          await workerGate;
          return {
            id: chargeId,
            status: 'succeeded',
            currency: 'usd',
            disputed: false,
            amount_refunded: 0,
            balance_transaction: {
              id: txnId,
              status: 'available',
              available_on: Math.floor(Date.now() / 1000) - 20,
              fee: 99,
            },
          } as any;
        }
        return { id, status: 'pending', balance_transaction: null } as any;
      });

      const workerPromise = runSettlementRecoveryPass({ workerId: 'in-flight-worker', batchSize: 100 });
      await workerInStripe;

      // While worker is in-flight talking to Stripe, webhook settles the order completely
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s2_wvw_${nanoid(10)}`,
          type: 'charge.updated',
          data: {
            object: {
              id: chargeId,
              payment_intent: paymentIntentId,
              currency: 'usd',
              status: 'succeeded',
              metadata: { orderId: order.id },
              balance_transaction: {
                id: txnId,
                status: 'available',
                available_on: Math.floor(Date.now() / 1000) - 20,
                fee: 99,
              },
            },
          },
        } as any)
      );

      allowWorkerProceed();
      const workerStats = await workerPromise;
      expect(workerStats.alreadySettled).toBeGreaterThanOrEqual(1);

      const bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(0);
      expect(bal?.availableBalanceInCents).toBe(2000);
      const cleared = await prisma.financialLedgerEntry.findMany({
        where: { orderId: order.id, type: LedgerEntryType.TICKET_SALE_CLEARED },
      });
      expect(cleared).toHaveLength(1);
    }, 15_000);

    it('prevents an expired in-flight worker from overwriting a second worker after live lease expiration', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('inflight-lease-exp');
      const chargeId = `ch_s2_ile_${nanoid(8)}`;
      const { order } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        stripeSettledChargeId: chargeId,
      });

      await prisma.order.update({
        where: { id: order.id },
        data: {
          stripeSettlementStatus: StripeSettlementStatus.PENDING,
          stripeSettlementNextAttemptAt: new Date(Date.now() - 1000),
        },
      });

      let workerAEnteredStripe!: () => void;
      const workerAAtStripe = new Promise<void>((r) => {
        workerAEnteredStripe = r;
      });
      let releaseWorkerA!: () => void;
      const workerAGate = new Promise<void>((r) => {
        releaseWorkerA = r;
      });
      let retrieveCalls = 0;

      vi.spyOn(stripe.charges, 'retrieve').mockImplementation(async (id: string) => {
        if (id === chargeId) {
          retrieveCalls += 1;
          if (retrieveCalls === 1) {
            // Worker A stalls past the 5s lease window and then tries to return 'pending'
            workerAEnteredStripe();
            await workerAGate;
            return {
              id: chargeId,
              status: 'succeeded',
              currency: 'usd',
              balance_transaction: {
                id: `txn_ile_old_${nanoid(6)}`,
                status: 'pending',
                available_on: Math.floor(Date.now() / 1000) + 3600,
                fee: 99,
              },
            } as any;
          }
          return {
            id: chargeId,
            status: 'succeeded',
            currency: 'usd',
            disputed: false,
            amount_refunded: 0,
            balance_transaction: {
              id: `txn_ile_new_${nanoid(6)}`,
              status: 'available',
              available_on: Math.floor(Date.now() / 1000) - 10,
              fee: 99,
            },
          } as any;
        }
        return { id, status: 'pending', balance_transaction: null } as any;
      });

      // Worker A acquires a real 5s lease (`Math.max(5_000, ...)` minimum)
      const workerAPromise = runSettlementRecoveryPass({
        workerId: 'slow-worker-A',
        batchSize: 100,
        leaseMs: 5_000,
      });
      await workerAAtStripe;

      // Wait just past the 5s lease expiration on PostgreSQL clock
      await new Promise((r) => setTimeout(r, 5_300));

      // Worker B steals the expired lease and settles
      const workerBStats = await runSettlementRecoveryPass({
        workerId: 'fast-worker-B',
        batchSize: 100,
      });
      expect(workerBStats.settled).toBeGreaterThanOrEqual(1);

      // Now release hung Worker A -> its 'pending' response MUST NOT overwrite Worker B's SETTLED state
      releaseWorkerA();
      const workerAStats = await workerAPromise;
      expect(workerAStats.leaseLost).toBeGreaterThanOrEqual(1);

      const finalOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(finalOrder?.stripeSettlementStatus).toBe(StripeSettlementStatus.SETTLED);

      const bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(0);
      expect(bal?.availableBalanceInCents).toBe(2000);
    }, 15_000);

    it('rejects insufficient-balance withdrawal attempts racing with pending settlement while preserving consistency', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('withdr-pend-race');
      const chargeId = `ch_s2_wpr_${nanoid(8)}`;
      const { order } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        stripeSettledChargeId: chargeId,
      });

      await prisma.order.update({
        where: { id: order.id },
        data: {
          stripeSettlementStatus: StripeSettlementStatus.PENDING,
          stripeSettlementNextAttemptAt: new Date(Date.now() - 1000),
        },
      });

      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValue({
        id: organizer.stripeAccountId,
        country: 'US',
        default_currency: 'usd',
        payouts_enabled: true,
        charges_enabled: true,
        details_submitted: true,
        capabilities: { transfers: 'active', card_payments: 'active' },
        requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
      } as any);
      vi.spyOn(stripe.transfers, 'create').mockResolvedValue({
        id: `tr_s2_wpr_${nanoid(8)}`,
        amount: 2000,
        currency: 'usd',
        destination: organizer.stripeAccountId,
      } as any);
      vi.spyOn(stripe.charges, 'retrieve').mockImplementation(async (id: string) => {
        if (id === chargeId) {
          await new Promise((r) => setTimeout(r, 60));
          return {
            id: chargeId,
            status: 'succeeded',
            currency: 'usd',
            disputed: false,
            amount_refunded: 0,
            balance_transaction: {
              id: `txn_wpr_${nanoid(8)}`,
              status: 'available',
              available_on: Math.floor(Date.now() / 1000) - 10,
              fee: 99,
            },
          } as any;
        }
        return { id, status: 'pending', balance_transaction: null } as any;
      });

      const [withdrawAttempt, settlementResult] = await Promise.allSettled([
        executeWithdrawal({
          userId: organizer.id,
          amountInCents: 2000,
          idempotencyKey: `wpr_1_${nanoid(8)}`,
        }),
        runSettlementRecoveryPass({ batchSize: 100 }),
      ]);

      expect(settlementResult.status).toBe('fulfilled');
      const bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.pendingBalanceInCents).toBe(0);
      if (withdrawAttempt.status === 'rejected') {
        expect(bal?.availableBalanceInCents).toBe(2000);
        // Once settled, subsequent withdrawal succeeds cleanly
        const okWithdraw = await executeWithdrawal({
          userId: organizer.id,
          amountInCents: 2000,
          idempotencyKey: `wpr_2_${nanoid(8)}`,
        });
        expect(okWithdraw.remainingAvailableInCents).toBe(0);
      } else {
        expect(bal?.availableBalanceInCents).toBe(0);
      }
      expect((await reconcileOrganizerFinance(organizer.id)).isReconciled).toBe(true);
    });

    it('retries temporary auth outages with backoff, transitions to FAILED_PERMANENT on exhaustion, and recovers cleanly after explicit resetFailedSettlementOrders', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('auth-reset');
      const chargeId = `ch_s2_ar_${nanoid(8)}`;
      const { order } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        stripeSettledChargeId: chargeId,
      });

      await prisma.order.update({
        where: { id: order.id },
        data: {
          stripeSettlementStatus: StripeSettlementStatus.PENDING,
          stripeSettlementNextAttemptAt: new Date(Date.now() - 1000),
        },
      });

      vi.spyOn(stripe.charges, 'retrieve').mockImplementation(async (id: string) => {
        if (id === chargeId) {
          throw Object.assign(new Error('Expired API Key provided'), {
            type: 'StripeAuthenticationError',
            code: 'api_key_expired',
            statusCode: 401,
          });
        }
        return { id, status: 'pending', balance_transaction: null } as any;
      });

      // Attempt 1 must retry (NOT immediately FAILED_PERMANENT)
      const firstPass = await runSettlementRecoveryPass({ batchSize: 100, randomFn: () => 0.5 });
      expect(firstPass.retried).toBeGreaterThanOrEqual(1);
      let cur = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(cur.stripeSettlementStatus).toBe(StripeSettlementStatus.PENDING);
      expect(cur.stripeSettlementAttempts).toBe(1);

      // Push attempts to final boundary -> exhaustion transitions cleanly to FAILED_PERMANENT
      await prisma.order.update({
        where: { id: order.id },
        data: {
          stripeSettlementAttempts: SETTLEMENT_MAX_ATTEMPTS - 1,
          stripeSettlementNextAttemptAt: new Date(Date.now() - 1000),
        },
      });
      const exhaustPass = await runSettlementRecoveryPass({ batchSize: 100 });
      expect(exhaustPass.failedPermanent).toBeGreaterThanOrEqual(1);

      cur = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(cur.stripeSettlementStatus).toBe(StripeSettlementStatus.FAILED_PERMANENT);
      expect(SETTLEMENT_MANUAL_REVIEW_SQL).toContain('FAILED_PERMANENT');
      expect(SETTLEMENT_RESET_ELIGIBLE_SQL).toContain('ANY($1::text[])');

      // Explicit operator reset after fixing configuration
      const resetCount = await resetFailedSettlementOrders([order.id]);
      expect(resetCount).toBe(1);

      vi.spyOn(stripe.charges, 'retrieve').mockImplementation(async (id: string) => {
        if (id === chargeId) {
          return {
            id: chargeId,
            status: 'succeeded',
            currency: 'usd',
            disputed: false,
            amount_refunded: 0,
            balance_transaction: {
              id: `txn_ar_${nanoid(8)}`,
              status: 'available',
              available_on: Math.floor(Date.now() / 1000) - 10,
              fee: 99,
            },
          } as any;
        }
        return { id, status: 'pending', balance_transaction: null } as any;
      });

      const recoveredPass = await runSettlementRecoveryPass({ batchSize: 100 });
      expect(recoveredPass.settled).toBeGreaterThanOrEqual(1);

      const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.stripeSettlementStatus).toBe(StripeSettlementStatus.SETTLED);
      expect(finalOrder.stripeSettlementAttempts).toBe(1);
    });
  });

  describe('6. Recoverable Liability Lifecycle & Stripe Fee Accounting Verification', () => {
    it('tracks recoverable liability creation, partial recovery, full recovery, duplicate offset prevention, and signed reconciliation', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('rec-lifecycle');
      const { order: o1, paymentIntentId: pi1 } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        totalInCents: 2394,
        organizerNetInCents: 2000,
      });

      // 1. Settle and withdraw Order 1 ($20.00)
      await settlePendingOrder(o1.id, `ch_rl_1_${nanoid(6)}`);
      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValue({
        id: organizer.stripeAccountId,
        country: 'US',
        default_currency: 'usd',
        payouts_enabled: true,
        charges_enabled: true,
        details_submitted: true,
        capabilities: { transfers: 'active', card_payments: 'active' },
        requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
      } as any);
      vi.spyOn(stripe.transfers, 'create').mockResolvedValue({
        id: `tr_rl_1_${nanoid(6)}`,
        amount: 2000,
        currency: 'usd',
        destination: organizer.stripeAccountId,
      } as any);
      await executeWithdrawal({
        userId: organizer.id,
        amountInCents: 2000,
        idempotencyKey: `rl_w_${nanoid(8)}`,
      });

      // 2. Post-transfer refund on Order 1 creates -2000 RECOVERABLE liability
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_rl_ref1_${nanoid(10)}`,
          type: 'charge.refunded',
          data: {
            object: {
              id: `ch_rl_1_${nanoid(6)}`,
              payment_intent: pi1,
              amount_refunded: 2394,
              currency: 'usd',
              metadata: { orderId: o1.id },
              refunds: { data: [{ id: `re_rl_1_${nanoid(6)}`, amount: 2394 }] },
            },
          },
        } as any)
      );

      let summary = await getOrganizerFinancialSummary(organizer.id);
      expect(summary.recoverableInCents).toBe(2000);
      expect(summary.netAvailableInCents).toBe(0);

      // 3. Order 2 ($8.00) settles -> partial recovery of 800 cents leaves 1200 recoverable
      const { order: o2 } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        totalInCents: 1000,
        platformFeeInCents: 200,
        organizerNetInCents: 800,
      });
      await settlePendingOrder(o2.id, `ch_rl_2_${nanoid(6)}`);

      summary = await getOrganizerFinancialSummary(organizer.id);
      expect(summary.availableInCents).toBe(0);
      expect(summary.recoverableInCents).toBe(1200);
      expect(summary.netAvailableInCents).toBe(0);
      expect((await reconcileOrganizerFinance(organizer.id)).isReconciled).toBe(true);

      // 4. Order 3 ($20.00) settles -> full recovery of remaining 1200 cents leaves 800 available & 0 recoverable
      const { order: o3 } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        totalInCents: 2394,
        organizerNetInCents: 2000,
      });
      await settlePendingOrder(o3.id, `ch_rl_3_${nanoid(6)}`);

      summary = await getOrganizerFinancialSummary(organizer.id);
      expect(summary.availableInCents).toBe(800);
      expect(summary.recoverableInCents).toBe(0);
      expect(summary.netAvailableInCents).toBe(800);

      // 5. Repeated recovery attempt is strictly a no-op (never deducts twice)
      const repeat = await recoverOrganizerLiabilities({
        organizerId: organizer.id,
        idempotencyKey: `order_${o3.id}_recover_liability`,
      });
      expect(repeat.duplicate).toBe(true);
      expect(repeat.recoveredInCents).toBe(0);
      expect(repeat.remainingRecoverableInCents).toBe(0);

      const rec = await reconcileOrganizerFinance(organizer.id);
      expect(rec.isReconciled).toBe(true);
      expect(rec.ledgerTotals.recoverableInCents).toBe(0);
      expect(rec.balanceRecord?.availableInCents).toBe(800);
    });

    it('separates buyer-collected estimated fees (PLATFORM_REVENUE) from actual Stripe costs (PLATFORM_EXPENSE) and prevents fee inflation on duplicates/unfulfilled late payments', async () => {
      const { organizer, event, tier } = await createOrganizerFixture('fee-accounting');
      const { order, paymentIntentId } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        status: OrderStatus.PENDING,
        recordPendingLedger: false,
      });
      await prisma.ticketReservation.create({
        data: {
          orderId: order.id,
          ticketTierId: tier.id,
          quantity: 1,
          expiresAt: new Date(Date.now() + 900_000),
        },
      });
      await prisma.ticketTier.update({
        where: { id: tier.id },
        data: { reservedQuantity: { increment: 1 } },
      });

      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_fa_pi_${nanoid(10)}`,
          type: 'payment_intent.succeeded',
          data: {
            object: {
              id: paymentIntentId,
              amount: 2394,
              currency: 'usd',
              status: 'succeeded',
              metadata: { orderId: order.id },
            },
          },
        } as any)
      );

      const chargeId = `ch_fa_${nanoid(8)}`;
      // Actual Stripe fee = 115 cents (differs from 99 estimate); deliver twice with distinct event IDs
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_fa_cu1_${nanoid(10)}`,
          type: 'charge.updated',
          data: {
            object: {
              id: chargeId,
              payment_intent: paymentIntentId,
              currency: 'usd',
              status: 'succeeded',
              metadata: { orderId: order.id },
              balance_transaction: {
                id: `txn_fa_${nanoid(8)}`,
                currency: 'usd',
                status: 'available',
                available_on: Math.floor(Date.now() / 1000) - 30,
                fee: 115,
              },
            },
          },
        } as any)
      );
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_fa_cu2_${nanoid(10)}`,
          type: 'charge.updated',
          data: {
            object: {
              id: chargeId,
              payment_intent: paymentIntentId,
              currency: 'usd',
              status: 'succeeded',
              metadata: { orderId: order.id },
              balance_transaction: {
                id: `txn_fa_${nanoid(8)}`,
                currency: 'usd',
                status: 'available',
                available_on: Math.floor(Date.now() / 1000) - 30,
                fee: 115,
              },
            },
          },
        } as any)
      );

      // Unfulfilled EXPIRED late payment for same organizer MUST create 0 fee entries & 0 organizer earnings
      const latePi = `pi_fa_late_${nanoid(8)}`;
      const { order: expiredOrder } = await createCompletedOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        organizerId: organizer.id,
        status: OrderStatus.EXPIRED,
        paymentReference: latePi,
        recordPendingLedger: false,
      });
      await prisma.ticketTier.update({
        where: { id: tier.id },
        data: { soldQuantity: 500 }, // Tier sold out -> forces late-payment refund path
      });
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_fa_late_pi_${nanoid(10)}`,
          type: 'payment_intent.succeeded',
          data: {
            object: {
              id: latePi,
              amount: 2394,
              currency: 'usd',
              status: 'succeeded',
              metadata: { orderId: expiredOrder.id },
              latest_charge: `ch_fa_late_${nanoid(8)}`,
            },
          },
        } as any)
      );
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_fa_late_cu_${nanoid(10)}`,
          type: 'charge.updated',
          data: {
            object: {
              id: `ch_fa_late_${nanoid(8)}`,
              payment_intent: latePi,
              currency: 'usd',
              status: 'succeeded',
              metadata: { orderId: expiredOrder.id },
              balance_transaction: {
                id: `txn_fa_late_${nanoid(8)}`,
                currency: 'usd',
                status: 'available',
                available_on: Math.floor(Date.now() / 1000) - 10,
                fee: 115,
              },
            },
          },
        } as any)
      );

      const expiredLedgerCount = await prisma.financialLedgerEntry.count({
        where: { orderId: expiredOrder.id },
      });
      expect(expiredLedgerCount).toBe(0);

      const feeEntries = await prisma.financialLedgerEntry.findMany({
        where: { orderId: order.id, type: LedgerEntryType.STRIPE_PROCESSING_FEE },
      });
      expect(feeEntries).toHaveLength(2);
      const est = feeEntries.find((e) => !(e.metadata as any)?.isActualReconciliation)!;
      const act = feeEntries.find((e) => (e.metadata as any)?.isActualReconciliation === true)!;
      expect(est.balanceType).toBe(LedgerBalanceType.PLATFORM_REVENUE);
      expect(est.amountInCents).toBe(99);
      expect(act.balanceType).toBe(LedgerBalanceType.PLATFORM_EXPENSE);
      expect(act.amountInCents).toBe(115);

      // PLATFORM_REVENUE must be 200 + 95 + 99 = 394 (NOT 394 + 115 = 509); PLATFORM_EXPENSE = 115
      const rec = await reconcileOrganizerFinance(organizer.id);
      expect(rec.isReconciled).toBe(true);
      expect(rec.ledgerTotals.platformRevenueInCents).toBe(394);
      expect(rec.ledgerTotals.platformExpenseInCents).toBe(115);
      expect(rec.balanceRecord?.availableInCents).toBe(2000);
    });
  });

  describe('7. Concurrent transfer.reversed Idempotency & Locking', () => {
    it('serializes two simultaneous transfer.reversed webhooks with distinct event IDs so balances restore exactly once', async () => {
      const { organizer } = await createOrganizerFixture('tr-rev-race');
      const stripeTransferId = `tr_s2_revrace_${nanoid(8)}`;

      await prisma.organizerBalance.create({
        data: {
          userId: organizer.id,
          pendingBalanceInCents: 0,
          availableBalanceInCents: 500,
          transferredBalanceInCents: 1000,
          currency: 'USD',
        },
      });
      await prisma.financialLedgerEntry.createMany({
        data: [
          {
            organizerId: organizer.id,
            type: LedgerEntryType.TICKET_SALE_CLEARED,
            balanceType: LedgerBalanceType.AVAILABLE,
            amountInCents: 500,
            currency: 'USD',
            description: 'Remaining available seed',
          },
          {
            organizerId: organizer.id,
            type: LedgerEntryType.TRANSFER_SUCCEEDED,
            balanceType: LedgerBalanceType.TRANSFERRED,
            amountInCents: 1000,
            currency: 'USD',
            stripeReferenceId: stripeTransferId,
            description: 'Transfer succeeded seed',
          },
        ],
      });
      await prisma.organizerTransfer.create({
        data: {
          transferNumber: `TRF-RACE-${nanoid(6).toUpperCase()}`,
          organizerId: organizer.id,
          stripeAccountId: organizer.stripeAccountId!,
          amountInCents: 1000,
          currency: 'USD',
          status: TransferStatus.SUCCEEDED,
          stripeTransferId,
          idempotencyKey: `idem_tr_race_${nanoid(8)}`,
          initiatedByUserId: organizer.id,
        },
      });

      await Promise.all([
        processStripeWebhookEvent(
          trackEvt({
            id: `evt_tr_rev_race_1_${nanoid(10)}`,
            type: 'transfer.reversed',
            data: { object: { id: stripeTransferId, amount: 1000, currency: 'usd' } },
          } as any)
        ),
        processStripeWebhookEvent(
          trackEvt({
            id: `evt_tr_rev_race_2_${nanoid(10)}`,
            type: 'transfer.reversed',
            data: { object: { id: stripeTransferId, amount: 1000, currency: 'usd' } },
          } as any)
        ),
      ]);

      const bal = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(bal?.transferredBalanceInCents).toBe(0);
      expect(bal?.availableBalanceInCents).toBe(1500);
      expect((await reconcileOrganizerFinance(organizer.id)).isReconciled).toBe(true);
    });
  });
});
