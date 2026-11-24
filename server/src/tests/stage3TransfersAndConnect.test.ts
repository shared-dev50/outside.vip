import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { nanoid } from 'nanoid';
import {
  EventStatus,
  LedgerBalanceType,
  LedgerEntryType,
  OrderStatus,
  PaymentProvider,
  Prisma,
  Role,
  TransferStatus,
} from '@prisma/client';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import { validateStripeWebhookProductionConfig } from '../config/env.js';
import { processStripeWebhookEvent } from '../modules/webhooks/webhook.service.js';
import { executeWithdrawal } from '../modules/finance/transfer.service.js';
import {
  claimPendingTransfersForReconciliation,
  finalizeTransferSucceededInTx,
  lookupStripeTransferForRecord,
  processClaimedTransferReconciliation,
  runTransferReconciliationPass,
  STRIPE_IDEMPOTENCY_EXPIRY_GRACE_MS,
  STRIPE_IDEMPOTENCY_RETRY_WINDOW_MS,
  TRANSFER_LOOKUP_MAX_PAGES,
} from '../modules/finance/transferReconciliation.service.js';
import {
  assertStripeReadyForPaidPublishing,
  createOnboardingLink,
  getConnectedAccountStatus,
} from '../modules/finance/finance.service.js';
import {
  getConfiguredSupportedCurrencies,
  validatePlatformCurrencyConfig,
} from '../modules/finance/stripeCountries.js';
import {
  getOrganizerFinancialSummary,
  reconcileOrganizerFinance,
  recordDisputeLedger,
  recordTicketSalePending,
  settlePendingOrder,
} from '../modules/finance/ledger.service.js';

describe('Stage 3 Transfers, Reversals & Connect Remediation', () => {
  const createdUserIds: string[] = [];
  const createdEventIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdWebhookEventIds: string[] = [];
  let adminToken = '';

  async function createVerifiedOrganizerFixture(prefix: string, stripeAccountId?: string | null) {
    const email = `s3_${prefix}_${Date.now()}_${nanoid(6)}@outside.vip`;
    const reg = await request(app).post('/api/auth/register').send({
      email,
      name: `Stage3 ${prefix}`,
      password: 'Outside2026!',
      role: Role.ORGANIZER,
    });
    expect(reg.status).toBe(201);
    const userId = reg.body.data.user.id as string;
    const token = reg.body.data.token as string;
    createdUserIds.push(userId);

    const assignedAcct =
      stripeAccountId === undefined ? `acct_s3_${nanoid(12)}` : stripeAccountId;

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        role: Role.ORGANIZER,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        stripeAccountId: assignedAcct,
        stripeAccountCountry: assignedAcct ? 'US' : null,
      },
    });

    const event = await prisma.event.create({
      data: {
        organizerId: userId,
        title: `Stage3 Event ${prefix}`,
        description: 'Stage 3 Connect & Transfer Integration Test Event',
        slug: `s3-event-${prefix}-${nanoid(8)}`.toLowerCase(),
        coverImageUrl: 'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14',
        venueName: 'Stage3 Venue',
        venueAddress: '100 Main St',
        city: 'Austin',
        country: 'United States',
        startAt: new Date(Date.now() + 86_400_000 * 5),
        endAt: new Date(Date.now() + 86_400_000 * 6),
        status: EventStatus.DRAFT,
        ticketTiers: {
          create: {
            name: 'GA',
            priceInCents: 2000,
            currency: 'USD',
            totalCapacity: 500,
          },
        },
      },
      include: { ticketTiers: true },
    });
    createdEventIds.push(event.id);

    return { user, token, event, tier: event.ticketTiers[0] };
  }

  async function seedAvailableBalanceFromOrder(opts: {
    organizerId: string;
    eventId: string;
    tierId: string;
    netInCents: number;
  }) {
    const order = await prisma.order.create({
      data: {
        orderNumber: `OUT-S3-${nanoid(8).toUpperCase()}`,
        eventId: opts.eventId,
        customerName: 'Stage3 Buyer',
        customerEmail: `buyer_${nanoid(6)}@outside.vip`,
        totalInCents: opts.netInCents,
        platformFeeInCents: 0,
        organizerNetInCents: opts.netInCents,
        currency: 'USD',
        idempotencyKey: `idem_ord_${nanoid(14)}`,
        paymentProvider: PaymentProvider.STRIPE,
        paymentReference: `pi_s3_${nanoid(12)}`,
        status: OrderStatus.COMPLETED,
        expiresAt: new Date(Date.now() + 900_000),
        items: {
          create: {
            ticketTierId: opts.tierId,
            quantity: 1,
            unitPriceInCents: opts.netInCents,
            subtotalInCents: opts.netInCents,
          },
        },
      },
    });
    createdOrderIds.push(order.id);

    await prisma.$transaction(async (tx) => {
      await recordTicketSalePending(tx, {
        orderId: order.id,
        paymentIntentId: order.paymentReference!,
        stripeChargeId: `ch_s3_${nanoid(10)}`,
        autoSettle: true,
      });
    });

    return order;
  }

  function mockReadyUsAccount(stripeAccountId: string) {
    return vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValue({
      id: stripeAccountId,
      country: 'US',
      default_currency: 'usd',
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { transfers: 'active', card_payments: 'active' },
      requirements: {
        currently_due: [],
        eventually_due: [],
        past_due: [],
        disabled_reason: null,
      },
    } as any);
  }

  function trackEvt(evt: Stripe.Event): Stripe.Event {
    createdWebhookEventIds.push(evt.id);
    return evt;
  }

  beforeAll(async () => {
    const adminLogin = await request(app).post('/api/auth/login').send({
      email: 'admin@outside.vip',
      password: 'Outside2026!',
    });
    expect(adminLogin.status).toBe(200);
    adminToken = adminLogin.body.data.token;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (createdWebhookEventIds.length > 0) {
      await prisma.processedWebhookEvent.deleteMany({
        where: { eventId: { in: createdWebhookEventIds } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.adminAuditLog.deleteMany({
        where: { targetId: { in: createdUserIds } },
      });
      await prisma.organizerTransfer.deleteMany({
        where: { organizerId: { in: createdUserIds } },
      });
      await prisma.connectedPayout.deleteMany({
        where: { organizerId: { in: createdUserIds } },
      });
      await prisma.financialLedgerEntry.deleteMany({
        where: { organizerId: { in: createdUserIds } },
      });
      await prisma.organizerBalance.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
    }
    if (createdOrderIds.length > 0) {
      await prisma.ticket.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    if (createdEventIds.length > 0) {
      await prisma.ticketTier.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  // =========================================================================
  // WORKSTREAM A — DURABLE TRANSFERS, AMBIGUOUS FAILURES & RECONCILIATION
  // =========================================================================
  describe('Workstream A: Reliable Organizer Transfers', () => {
    it('executes successful withdrawal, persists SUCCEEDED + ledger, and reconciles cleanly', async () => {
      const { user, event, tier } = await createVerifiedOrganizerFixture('tr-ok');
      await seedAvailableBalanceFromOrder({
        organizerId: user.id,
        eventId: event.id,
        tierId: tier.id,
        netInCents: 2500,
      });

      mockReadyUsAccount(user.stripeAccountId!);
      const trId = `tr_s3_ok_${nanoid(10)}`;
      vi.spyOn(stripe.transfers, 'create').mockResolvedValueOnce({
        id: trId,
        amount: 2000,
        currency: 'usd',
        destination: user.stripeAccountId,
      } as any);

      const res = await executeWithdrawal({
        userId: user.id,
        amountInCents: 2000,
        idempotencyKey: `s3_ok_${nanoid(8)}`,
      });

      expect(res.status).toBe(TransferStatus.SUCCEEDED);
      expect(res.stripeTransferId).toBe(trId);
      expect(res.remainingAvailableInCents).toBe(500);
      expect(res.transferredInCents).toBe(2000);

      const rec = await reconcileOrganizerFinance(user.id);
      expect(rec.isReconciled).toBe(true);
      expect(rec.discrepancies).toEqual([]);
    });

    it('rejects insufficient balance and duplicate intent replays without double-calling Stripe', async () => {
      const { user, event, tier } = await createVerifiedOrganizerFixture('tr-dup');
      await seedAvailableBalanceFromOrder({
        organizerId: user.id,
        eventId: event.id,
        tierId: tier.id,
        netInCents: 2000,
      });

      mockReadyUsAccount(user.stripeAccountId!);
      await expect(
        executeWithdrawal({ userId: user.id, amountInCents: 3000 })
      ).rejects.toThrow('Insufficient available balance');

      const createSpy = vi.spyOn(stripe.transfers, 'create').mockResolvedValueOnce({
        id: `tr_s3_once_${nanoid(10)}`,
        amount: 1000,
        currency: 'usd',
        destination: user.stripeAccountId,
      } as any);

      const key = `dup_${nanoid(10)}`;
      const first = await executeWithdrawal({ userId: user.id, amountInCents: 1000, idempotencyKey: key });
      const second = await executeWithdrawal({ userId: user.id, amountInCents: 1000, idempotencyKey: key });

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(second.transferId).toBe(first.transferId);
      expect(second.stripeTransferId).toBe(first.stripeTransferId);
      expect((await reconcileOrganizerFinance(user.id)).isReconciled).toBe(true);
    });

    it('handles Stripe success followed by response timeout (inline list recovery settles SUCCEEDED cleanly)', async () => {
      const { user, event, tier } = await createVerifiedOrganizerFixture('tr-timeout-created');
      await seedAvailableBalanceFromOrder({
        organizerId: user.id,
        eventId: event.id,
        tierId: tier.id,
        netInCents: 2000,
      });

      mockReadyUsAccount(user.stripeAccountId!);
      const trId = `tr_created_before_drop_${nanoid(10)}`;
      let capturedTransferGroup = '';

      vi.spyOn(stripe.transfers, 'create').mockImplementationOnce(async (params: any) => {
        capturedTransferGroup = params.transfer_group;
        const timeoutErr: any = new Error('ETIMEDOUT while reading Stripe response');
        timeoutErr.code = 'ETIMEDOUT';
        timeoutErr.type = 'StripeConnectionError';
        throw timeoutErr;
      });

      vi.spyOn(stripe.transfers, 'list').mockImplementationOnce(async () => ({
        object: 'list',
        has_more: false,
        data: [
          {
            id: trId,
            amount: 2000,
            currency: 'usd',
            destination: user.stripeAccountId,
            transfer_group: capturedTransferGroup,
          } as any,
        ],
      } as any));

      const res = await executeWithdrawal({
        userId: user.id,
        amountInCents: 2000,
        idempotencyKey: `to_rec_${nanoid(8)}`,
      });

      expect(res.status).toBe(TransferStatus.SUCCEEDED);
      expect(res.stripeTransferId).toBe(trId);
      expect(res.remainingAvailableInCents).toBe(0);
      expect(res.transferredInCents).toBe(2000);
      expect((await reconcileOrganizerFinance(user.id)).isReconciled).toBe(true);
    });

    it('keeps funds reserved in PENDING + reconciliationRequired on network/5xx/unknown error when Stripe list is empty, blocks different-key retry, and recovers on same-key retry', async () => {
      const { user, token, event, tier } = await createVerifiedOrganizerFixture('tr-ambig');
      await seedAvailableBalanceFromOrder({
        organizerId: user.id,
        eventId: event.id,
        tierId: tier.id,
        netInCents: 2000,
      });

      mockReadyUsAccount(user.stripeAccountId!);
      const networkErr: any = new Error('Connection reset by peer');
      networkErr.code = 'ECONNRESET';
      networkErr.type = 'StripeConnectionError';

      const createSpy = vi.spyOn(stripe.transfers, 'create').mockRejectedValueOnce(networkErr);
      vi.spyOn(stripe.transfers, 'list').mockResolvedValueOnce({
        object: 'list',
        has_more: false,
        data: [],
      } as any);

      const clientKey = `ambig_${nanoid(10)}`;
      const httpRes = await request(app)
        .post('/api/organizer/finance/withdraw')
        .set('Authorization', `Bearer ${token}`)
        .send({ amountInCents: 2000, idempotencyKey: clientKey });

      // Structured retryable 202 response, NOT false failure
      expect(httpRes.status).toBe(202);
      expect(httpRes.body.data.status).toBe(TransferStatus.PENDING);
      expect(httpRes.body.data.reconciliationRequired).toBe(true);
      expect(httpRes.body.data.retryable).toBe(true);
      expect(httpRes.body.data.remainingAvailableInCents).toBe(0);

      // Available balance remains deducted (0) and NO TRANSFER_FAILED entry was created
      const balAfterAmbig = await prisma.organizerBalance.findUnique({ where: { userId: user.id } });
      expect(balAfterAmbig?.availableBalanceInCents).toBe(0);
      expect(balAfterAmbig?.transferredBalanceInCents).toBe(0);

      const failedLedger = await prisma.financialLedgerEntry.findMany({
        where: { organizerId: user.id, type: LedgerEntryType.TRANSFER_FAILED },
      });
      expect(failedLedger.length).toBe(0);

      // Different-key retry while original is ambiguous MUST be blocked without calling Stripe!
      await expect(
        executeWithdrawal({
          userId: user.id,
          amountInCents: 2000,
          idempotencyKey: `different_${nanoid(10)}`,
        })
      ).rejects.toThrow('Insufficient available balance');
      expect(createSpy).toHaveBeenCalledTimes(1);

      // Same-key retry reuses the EXACT same Stripe idempotency key and finalizes SUCCEEDED cleanly
      const trId = `tr_same_key_ok_${nanoid(10)}`;
      vi.spyOn(stripe.transfers, 'list').mockResolvedValueOnce({
        object: 'list',
        has_more: false,
        data: [],
      } as any);
      createSpy.mockResolvedValueOnce({
        id: trId,
        amount: 2000,
        currency: 'usd',
        destination: user.stripeAccountId,
      } as any);

      const retryRes = await executeWithdrawal({
        userId: user.id,
        amountInCents: 2000,
        idempotencyKey: clientKey,
      });

      expect(retryRes.status).toBe(TransferStatus.SUCCEEDED);
      expect(retryRes.stripeTransferId).toBe(trId);
      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(createSpy.mock.calls[0][1]).toEqual(createSpy.mock.calls[1][1]);
      expect((await reconcileOrganizerFinance(user.id)).isReconciled).toBe(true);
    });

    it('restores reserved balance on confirmed failure, rejects FAILED-key reuse cleanly, and permits new intent with new key', async () => {
      const { user, event, tier } = await createVerifiedOrganizerFixture('tr-confirmed-fail');
      await seedAvailableBalanceFromOrder({
        organizerId: user.id,
        eventId: event.id,
        tierId: tier.id,
        netInCents: 2000,
      });

      mockReadyUsAccount(user.stripeAccountId!);
      const declinedErr: any = new Error('Insufficient funds in platform account');
      declinedErr.type = 'StripeInvalidRequestError';
      declinedErr.code = 'balance_insufficient';
      declinedErr.statusCode = 400;

      vi.spyOn(stripe.transfers, 'create').mockRejectedValueOnce(declinedErr);

      const failedKey = `fail_${nanoid(10)}`;
      await expect(
        executeWithdrawal({ userId: user.id, amountInCents: 1500, idempotencyKey: failedKey })
      ).rejects.toThrow();

      const balRestored = await prisma.organizerBalance.findUnique({ where: { userId: user.id } });
      expect(balRestored?.availableBalanceInCents).toBe(2000);

      // Reusing FAILED idempotencyKey MUST reject cleanly with TRANSFER_ALREADY_FAILED without P2002 or corrupting available balance
      let replayErr: any;
      try {
        await executeWithdrawal({ userId: user.id, amountInCents: 1500, idempotencyKey: failedKey });
      } catch (e) {
        replayErr = e;
      }
      expect(replayErr).toBeDefined();
      expect(replayErr.code).toBe('TRANSFER_ALREADY_FAILED');
      const balAfterReplay = await prisma.organizerBalance.findUnique({ where: { userId: user.id } });
      expect(balAfterReplay?.availableBalanceInCents).toBe(2000);

      // Genuinely new withdrawal intent with fresh key succeeds
      vi.spyOn(stripe.transfers, 'create').mockResolvedValueOnce({
        id: `tr_new_after_fail_${nanoid(10)}`,
        amount: 1500,
        currency: 'usd',
        destination: user.stripeAccountId,
      } as any);
      const ok = await executeWithdrawal({
        userId: user.id,
        amountInCents: 1500,
        idempotencyKey: `fresh_${nanoid(10)}`,
      });
      expect(ok.status).toBe(TransferStatus.SUCCEEDED);
      expect(ok.remainingAvailableInCents).toBe(500);
      expect((await reconcileOrganizerFinance(user.id)).isReconciled).toBe(true);
    });

    it(
      'reconciles transfer.created webhook arriving before post-call persistence without double counting',
      async () => {
      const { user, event, tier } = await createVerifiedOrganizerFixture('tr-webhook-early');
      await seedAvailableBalanceFromOrder({
        organizerId: user.id,
        eventId: event.id,
        tierId: tier.id,
        netInCents: 2000,
      });

      mockReadyUsAccount(user.stripeAccountId!);
      const earlyStripeTrId = `tr_early_wh_${nanoid(10)}`;

      // Simulate Stripe sending transfer.created webhook while transfers.create is still awaiting completion
      vi.spyOn(stripe.transfers, 'create').mockImplementationOnce(async (params: any) => {
        await processStripeWebhookEvent(
          trackEvt({
            id: `evt_tr_created_${nanoid(12)}`,
            type: 'transfer.created',
            data: {
              object: {
                id: earlyStripeTrId,
                object: 'transfer',
                amount: 2000,
                currency: 'usd',
                destination: user.stripeAccountId,
                transfer_group: params.transfer_group,
                metadata: params.metadata,
              } as any,
            },
          } as any)
        );

        return {
          id: earlyStripeTrId,
          object: 'transfer',
          amount: 2000,
          currency: 'usd',
          destination: user.stripeAccountId,
        } as any;
      });

      const res = await executeWithdrawal({
        userId: user.id,
        amountInCents: 2000,
        idempotencyKey: `early_${nanoid(10)}`,
      });

      expect(res.status).toBe(TransferStatus.SUCCEEDED);
      expect(res.stripeTransferId).toBe(earlyStripeTrId);
      expect(res.transferredInCents).toBe(2000);
      expect(res.remainingAvailableInCents).toBe(0);

      const entries = await prisma.financialLedgerEntry.findMany({
        where: { organizerId: user.id, type: LedgerEntryType.TRANSFER_SUCCEEDED },
      });
      expect(entries.length).toBe(1);
      expect((await reconcileOrganizerFinance(user.id)).isReconciled).toBe(true);
    },
      20000
    );

    it(
      'recovers stale PENDING transfers via worker, preserves ambiguous state <24h, prevents expired worker overwrite, and restores after >24h15m expiry',
      async () => {
      const { user, event, tier } = await createVerifiedOrganizerFixture('tr-worker');
      await seedAvailableBalanceFromOrder({
        organizerId: user.id,
        eventId: event.id,
        tierId: tier.id,
        netInCents: 3000,
      });

      mockReadyUsAccount(user.stripeAccountId!);
      const err500: any = new Error('Stripe internal server error');
      err500.type = 'StripeAPIError';
      err500.statusCode = 500;

      // Create two ambiguous transfers (1000 cents + 2000 cents)
      vi.spyOn(stripe.transfers, 'create').mockRejectedValue(err500);
      vi.spyOn(stripe.transfers, 'list').mockResolvedValue({
        object: 'list',
        has_more: false,
        data: [],
      } as any);

      const p1 = await executeWithdrawal({ userId: user.id, amountInCents: 1000, idempotencyKey: `wk1_${nanoid(8)}` });
      const p2 = await executeWithdrawal({ userId: user.id, amountInCents: 2000, idempotencyKey: `wk2_${nanoid(8)}` });

      // 1. Inside idempotency window with empty list -> worker MUST keep p1 & p2 PENDING (never restore!)
      await prisma.organizerTransfer.updateMany({
        where: { id: { in: [p1.transferId, p2.transferId] } },
        data: { reconciliationNextAttemptAt: new Date(Date.now() - 1000) },
      });

      const statsEarly = await runTransferReconciliationPass({ workerId: 'wk_early' });
      expect(statsEarly.claimed).toBe(2);
      expect(statsEarly.stillUncertain).toBe(2);
      expect((await prisma.organizerBalance.findUnique({ where: { userId: user.id } }))?.availableBalanceInCents).toBe(0);

      // 2. Lease expiry safety: Worker A claims p1, stalls so Worker B acquires expired lease and confirms SUCCEEDED;
      // Worker A finishing later MUST hit leaseLost and NOT overwrite!
      await prisma.organizerTransfer.update({
        where: { id: p1.transferId },
        data: { reconciliationNextAttemptAt: new Date(Date.now() - 1000), reconciliationAttempts: 0 },
      });
      await prisma.organizerTransfer.update({
        where: { id: p2.transferId },
        data: { reconciliationNextAttemptAt: new Date(Date.now() + 3600_000) },
      });

      const claimedByA = await claimPendingTransfersForReconciliation({
        workerId: 'worker_A',
        leaseMs: 1, // Immediately expiring lease
        batchSize: 1,
      });
      expect(claimedByA.length).toBe(1);

      await new Promise((r) => setTimeout(r, 15));

      const trP1 = `tr_wk_b_${nanoid(10)}`;
      vi.spyOn(stripe.transfers, 'list').mockResolvedValueOnce({
        object: 'list',
        has_more: false,
        data: [
          {
            id: trP1,
            amount: 1000,
            currency: 'usd',
            destination: user.stripeAccountId,
            transfer_group: p1.transferNumber,
          } as any,
        ],
      } as any);

      const statsB = await runTransferReconciliationPass({ workerId: 'worker_B', batchSize: 1 });
      expect(statsB.succeeded).toBe(1);

      vi.spyOn(stripe.transfers, 'list').mockResolvedValueOnce({
        object: 'list',
        has_more: false,
        data: [],
      } as any);
      const outcomeA = await processClaimedTransferReconciliation(claimedByA[0], 'worker_A', {
        now: new Date(Date.now() + 26 * 3600_000), // Even if Worker A thinks it expired, it lost lease!
      });
      expect(outcomeA).toBe('leaseLost');
      expect((await prisma.organizerTransfer.findUnique({ where: { id: p1.transferId } }))?.status).toBe(TransferStatus.SUCCEEDED);

      // 3. Past 24h15m retention window + authoritative empty list across transfer_group & destination -> safe restoration!
      await prisma.organizerTransfer.update({
        where: { id: p2.transferId },
        data: {
          createdAt: new Date(Date.now() - 25 * 3600_000),
          lastCreateAttemptAt: new Date(Date.now() - 25 * 3600_000),
          reconciliationNextAttemptAt: new Date(Date.now() - 1000),
          reconciliationAttempts: 1,
        },
      });
      vi.spyOn(stripe.transfers, 'list').mockResolvedValue({
        object: 'list',
        has_more: false,
        data: [],
      } as any);

      const statsExpired = await runTransferReconciliationPass({ workerId: 'wk_expired' });
      expect(statsExpired.failedRestored).toBe(1);

      const p2After = await prisma.organizerTransfer.findUnique({ where: { id: p2.transferId } });
      expect(p2After?.status).toBe(TransferStatus.FAILED);
      const balFinal = await prisma.organizerBalance.findUnique({ where: { userId: user.id } });
      expect(balFinal?.availableBalanceInCents).toBe(2000);
      expect(balFinal?.transferredBalanceInCents).toBe(1000);
      expect((await reconcileOrganizerFinance(user.id)).isReconciled).toBe(true);
    },
      20000
    );
  });

  // =========================================================================
  // WORKSTREAM B — FULL & PARTIAL TRANSFER REVERSALS
  // =========================================================================
  describe('Workstream B: Full & Partial Transfer Reversals', () => {
    it(
      'processes partial (500), cumulative (2000), duplicate, out-of-order, and transfer.updated reversals accurately',
      async () => {
      const { user, event, tier } = await createVerifiedOrganizerFixture('tr-rev-partial');
      await seedAvailableBalanceFromOrder({
        organizerId: user.id,
        eventId: event.id,
        tierId: tier.id,
        netInCents: 2000,
      });

      mockReadyUsAccount(user.stripeAccountId!);
      const trId = `tr_rev_multi_${nanoid(10)}`;
      vi.spyOn(stripe.transfers, 'create').mockResolvedValueOnce({
        id: trId,
        amount: 2000,
        currency: 'usd',
        destination: user.stripeAccountId,
      } as any);

      const w = await executeWithdrawal({ userId: user.id, amountInCents: 2000 });
      expect(w.transferredInCents).toBe(2000);
      expect(w.remainingAvailableInCents).toBe(0);

      // Step 1: Partial reversal of 500 cents via transfer.reversed
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_rev_500_${nanoid(10)}`,
          type: 'transfer.reversed',
          data: { object: { id: trId, amount: 2000, amount_reversed: 500, reversed: false, currency: 'usd' } },
        } as any)
      );

      let trRow = await prisma.organizerTransfer.findUnique({ where: { id: w.transferId } });
      let bal = await prisma.organizerBalance.findUnique({ where: { userId: user.id } });
      expect(trRow?.status).toBe(TransferStatus.SUCCEEDED); // Still partial!
      expect(trRow?.reversedAmountInCents).toBe(500);
      expect(bal?.availableBalanceInCents).toBe(500);
      expect(bal?.transferredBalanceInCents).toBe(1500);

      // Duplicate delivery with new event ID (amount_reversed still 500) -> zero additional restoration
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_rev_500_dup_${nanoid(10)}`,
          type: 'transfer.reversed',
          data: { object: { id: trId, amount: 2000, amount_reversed: 500, reversed: false, currency: 'usd' } },
        } as any)
      );
      bal = await prisma.organizerBalance.findUnique({ where: { userId: user.id } });
      expect(bal?.availableBalanceInCents).toBe(500);

      // Step 2: Intermediate reversal via transfer.updated (cumulative 1200 -> delta 700)
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_tr_upd_1200_${nanoid(10)}`,
          type: 'transfer.updated',
          data: { object: { id: trId, amount: 2000, amount_reversed: 1200, reversed: false, currency: 'usd' } },
        } as any)
      );
      bal = await prisma.organizerBalance.findUnique({ where: { userId: user.id } });
      expect(bal?.availableBalanceInCents).toBe(1200);
      expect(bal?.transferredBalanceInCents).toBe(800);

      // Out-of-order smaller cumulative reversal (900 < 1200) -> ignored
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_rev_stale_900_${nanoid(10)}`,
          type: 'transfer.reversed',
          data: { object: { id: trId, amount: 2000, amount_reversed: 900, reversed: false, currency: 'usd' } },
        } as any)
      );
      bal = await prisma.organizerBalance.findUnique({ where: { userId: user.id } });
      expect(bal?.availableBalanceInCents).toBe(1200);

      // Step 3: Final cumulative reversal to 2000 -> incremental +800, marks REVERSED
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_rev_2000_${nanoid(10)}`,
          type: 'transfer.reversed',
          data: { object: { id: trId, amount: 2000, amount_reversed: 2000, reversed: true, currency: 'usd' } },
        } as any)
      );

      trRow = await prisma.organizerTransfer.findUnique({ where: { id: w.transferId } });
      bal = await prisma.organizerBalance.findUnique({ where: { userId: user.id } });
      expect(trRow?.status).toBe(TransferStatus.REVERSED);
      expect(trRow?.reversedAmountInCents).toBe(2000);
      expect(bal?.availableBalanceInCents).toBe(2000);
      expect(bal?.transferredBalanceInCents).toBe(0);
      expect((await reconcileOrganizerFinance(user.id)).isReconciled).toBe(true);
    },
      20000
    );

    it(
      'offsets outstanding RECOVERABLE liabilities cleanly when a transfer is reversed after organizer spent other funds, and serializes concurrent reversal webhooks',
      async () => {
      const { user, event, tier } = await createVerifiedOrganizerFixture('tr-rev-recov');
      const ord1 = await seedAvailableBalanceFromOrder({
        organizerId: user.id,
        eventId: event.id,
        tierId: tier.id,
        netInCents: 2000,
      });
      const ord2 = await seedAvailableBalanceFromOrder({
        organizerId: user.id,
        eventId: event.id,
        tierId: tier.id,
        netInCents: 1000,
      });

      mockReadyUsAccount(user.stripeAccountId!);
      const trId1 = `tr_rec_1_${nanoid(10)}`;
      const trId2 = `tr_rec_2_${nanoid(10)}`;
      vi.spyOn(stripe.transfers, 'create')
        .mockResolvedValueOnce({ id: trId1, amount: 2000, currency: 'usd', destination: user.stripeAccountId } as any)
        .mockResolvedValueOnce({ id: trId2, amount: 1000, currency: 'usd', destination: user.stripeAccountId } as any);

      await executeWithdrawal({ userId: user.id, amountInCents: 2000 });
      await executeWithdrawal({ userId: user.id, amountInCents: 1000 });
      expect(ord1.id).toBeTruthy();

      // Post-transfer dispute loss on Order 2 ($10.00 = 1000 cents recoverable liability while available = 0)
      await prisma.$transaction(async (tx) => {
        await recordDisputeLedger(tx, {
          stripeDisputeId: `dp_post_${nanoid(8)}`,
          orderId: ord2.id,
          amountInCents: 1000,
          status: 'lost',
        });
      });

      // Now Transfer 1 ($20.00) is concurrently hit by two distinct reversal webhooks
      await Promise.all([
        processStripeWebhookEvent(
          trackEvt({
            id: `evt_conc_rev_a_${nanoid(10)}`,
            type: 'transfer.reversed',
            data: { object: { id: trId1, amount: 2000, amount_reversed: 2000, reversed: true, currency: 'usd' } },
          } as any)
        ),
        processStripeWebhookEvent(
          trackEvt({
            id: `evt_conc_rev_b_${nanoid(10)}`,
            type: 'transfer.reversed',
            data: { object: { id: trId1, amount: 2000, amount_reversed: 2000, reversed: true, currency: 'usd' } },
          } as any)
        ),
      ]);

      // $20.00 returned -> gross available = $20.00, recoverable liability = $10.00, net withdrawable = $10.00 (1000 cents)!
      const summary = await getOrganizerFinancialSummary(user.id);
      expect(summary.availableInCents).toBe(2000);
      expect(summary.recoverableInCents).toBe(1000);
      expect(summary.netAvailableInCents).toBe(1000);
      expect(summary.transferredInCents).toBe(1000);

      // Cannot withdraw more than netAvailableInCents ($10.00), and cannot double-penalize
      await expect(executeWithdrawal({ userId: user.id, amountInCents: 1500 })).rejects.toThrow(
        /Insufficient available balance/i
      );

      const trId3 = `tr_rec_net_${nanoid(10)}`;
      vi.spyOn(stripe.transfers, 'create').mockResolvedValueOnce({
        id: trId3,
        amount: 1000,
        currency: 'usd',
        destination: user.stripeAccountId,
      } as any);
      const netWithdrawal = await executeWithdrawal({ userId: user.id, amountInCents: 1000 });
      expect(netWithdrawal.status).toBe(TransferStatus.SUCCEEDED);

      const rec = await reconcileOrganizerFinance(user.id);
      expect(rec.isReconciled).toBe(true);
      expect(rec.discrepancies).toEqual([]);
      expect(rec.balanceRecord?.availableInCents).toBe(1000);
      expect(rec.balanceRecord?.transferredInCents).toBe(2000);
      expect(rec.ledgerTotals.recoverableInCents).toBe(1000);
    },
      20000
    );
  });

  // =========================================================================
  // WORKSTREAMS C, D, E & SECTION 7 — CONNECT LIFECYCLE, CURRENCY, CONFIG
  // =========================================================================
  describe('Workstreams C, D, E & Security Hardening', () => {
    it('prevents concurrent Express account creation from creating multiple Stripe accounts', async () => {
      const { user } = await createVerifiedOrganizerFixture('conn-race', null);

      const createdId = `acct_single_${nanoid(10)}`;
      const createSpy = vi.spyOn(stripe.accounts, 'create').mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 60));
        return {
          id: createdId,
          country: 'US',
          default_currency: 'usd',
        } as any;
      });
      vi.spyOn(stripe.accountLinks, 'create').mockResolvedValue({
        url: 'https://connect.stripe.com/setup/s/concurrent_ok',
      } as any);

      const [r1, r2] = await Promise.all([
        createOnboardingLink(user.id, undefined, undefined, false, 'US'),
        createOnboardingLink(user.id, undefined, undefined, false, 'US'),
      ]);

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(r1.stripeAccountId).toBe(createdId);
      expect(r2.stripeAccountId).toBe(createdId);
    });

    it('recovers ambiguous account creation timeout via metadata creationKey without orphaning accounts', async () => {
      const { user } = await createVerifiedOrganizerFixture('conn-timeout', null);

      let capturedCreationKey = '';
      const recoveredAcctId = `acct_timeout_rec_${nanoid(10)}`;

      vi.spyOn(stripe.accounts, 'create').mockImplementationOnce(async (params: any) => {
        capturedCreationKey = params.metadata.creationKey;
        const err: any = new Error('ETIMEDOUT creating Express account');
        err.code = 'ETIMEDOUT';
        err.type = 'StripeConnectionError';
        throw err;
      });
      vi.spyOn(stripe.accounts, 'list').mockResolvedValueOnce({
        object: 'list',
        has_more: false,
        data: [],
      } as any);

      await expect(
        createOnboardingLink(user.id, undefined, undefined, false, 'US')
      ).rejects.toThrow(/timed out/i);

      // Retry recovers existing account from Stripe list using preserved creationKey without creating a second account!
      const createSpy = vi.spyOn(stripe.accounts, 'create');
      vi.spyOn(stripe.accounts, 'list').mockImplementationOnce(async () => ({
        object: 'list',
        has_more: false,
        data: [
          {
            id: recoveredAcctId,
            country: 'US',
            default_currency: 'usd',
            metadata: { userId: user.id, creationKey: capturedCreationKey },
          } as any,
        ],
      } as any));
      vi.spyOn(stripe.accountLinks, 'create').mockResolvedValueOnce({
        url: 'https://connect.stripe.com/setup/s/recovered_acct',
      } as any);

      const retried = await createOnboardingLink(user.id, undefined, undefined, false, 'US');
      expect(retried.stripeAccountId).toBe(recoveredAcctId);
      expect(createSpy).not.toHaveBeenCalled();

      const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
      expect(updatedUser?.stripeAccountId).toBe(recoveredAcctId);
      expect(updatedUser?.stripeAccountCreationKey).toBeNull();
    });

    it(
      'rejects self-service reconnect: true for valid accounts and supports audited admin replacement',
      async () => {
      const { user, event, tier } = await createVerifiedOrganizerFixture('conn-reconnect');
      const oldAcct = user.stripeAccountId!;
      await seedAvailableBalanceFromOrder({
        organizerId: user.id,
        eventId: event.id,
        tierId: tier.id,
        netInCents: 1000,
      });

      mockReadyUsAccount(oldAcct);
      vi.spyOn(stripe.transfers, 'create').mockResolvedValueOnce({
        id: `tr_hist_${nanoid(8)}`,
        amount: 1000,
        currency: 'usd',
        destination: oldAcct,
      } as any);
      const w = await executeWithdrawal({ userId: user.id, amountInCents: 1000 });

      // Valid account -> self-service reconnect rejected
      await expect(
        createOnboardingLink(user.id, undefined, undefined, true, 'US')
      ).rejects.toThrow(/still active and accessible/i);

      // Admin audited replacement succeeds and preserves historical OrganizerTransfer.stripeAccountId
      const replacementAcct = `acct_admin_repl_${nanoid(8)}`;
      vi.spyOn(stripe.accounts, 'create').mockResolvedValueOnce({
        id: replacementAcct,
        country: 'US',
        default_currency: 'usd',
      } as any);
      vi.spyOn(stripe.accountLinks, 'create').mockResolvedValueOnce({
        url: 'https://connect.stripe.com/setup/s/admin_repl_link',
      } as any);

      const adminRes = await request(app)
        .post('/api/organizer/finance/admin/replace-account')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          organizerId: user.id,
          country: 'US',
          reason: 'Organizer requested legal entity migration',
        });

      expect(adminRes.status).toBe(200);
      expect(adminRes.body.data.previousStripeAccountId).toBe(oldAcct);
      expect(adminRes.body.data.newStripeAccountId).toBe(replacementAcct);

      const preservedTransfer = await prisma.organizerTransfer.findUnique({ where: { id: w.transferId } });
      expect(preservedTransfer?.stripeAccountId).toBe(oldAcct);
    },
      20000
    );

    it('handles capability.updated active/inactive transitions and blocks stale out-of-order re-enabling events', async () => {
      const { user } = await createVerifiedOrganizerFixture('conn-cap');
      const nowSec = Math.floor(Date.now() / 1000);

      // Newer restriction arrives (t = nowSec)
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_cap_inactive_${nanoid(10)}`,
          created: nowSec,
          type: 'capability.updated',
          account: user.stripeAccountId,
          data: {
            object: {
              id: 'transfers',
              object: 'capability',
              account: user.stripeAccountId,
              status: 'inactive',
              requirements: {
                disabled_reason: 'requirements.past_due',
                currently_due: ['individual.verification.document'],
                past_due: ['individual.verification.document'],
                eventually_due: [],
                pending_verification: [],
              },
            } as any,
          },
        } as any)
      );

      let dbUser = await prisma.user.findUnique({ where: { id: user.id } });
      expect(dbUser?.stripeAccountTransfersCapability).toBe('inactive');
      expect(dbUser?.stripeAccountDisabledReason).toBe('requirements.past_due');

      // Stale older active event arrives (t = nowSec - 120) -> MUST be ignored!
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_cap_stale_active_${nanoid(10)}`,
          created: nowSec - 120,
          type: 'capability.updated',
          account: user.stripeAccountId,
          data: {
            object: {
              id: 'transfers',
              object: 'capability',
              account: user.stripeAccountId,
              status: 'active',
              requirements: {
                disabled_reason: null,
                currently_due: [],
                past_due: [],
                eventually_due: [],
                pending_verification: [],
              },
            } as any,
          },
        } as any)
      );

      dbUser = await prisma.user.findUnique({ where: { id: user.id } });
      expect(dbUser?.stripeAccountTransfersCapability).toBe('inactive');
      expect(dbUser?.stripeAccountDisabledReason).toBe('requirements.past_due');
    });

    it('requires payouts_enabled === true for both withdrawals and paid-event publishing', async () => {
      const { user, event, tier } = await createVerifiedOrganizerFixture('conn-payouts-false');
      await seedAvailableBalanceFromOrder({
        organizerId: user.id,
        eventId: event.id,
        tierId: tier.id,
        netInCents: 1500,
      });

      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValue({
        id: user.stripeAccountId,
        country: 'US',
        default_currency: 'usd',
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: false,
        capabilities: { transfers: 'active', card_payments: 'active' },
        requirements: {
          currently_due: ['external_account'],
          eventually_due: [],
          past_due: [],
          disabled_reason: null,
        },
      } as any);

      await expect(
        executeWithdrawal({ userId: user.id, amountInCents: 1000 })
      ).rejects.toThrow(/external bank payouts enabled/i);

      await expect(assertStripeReadyForPaidPublishing(user.id)).rejects.toThrow(
        /bank account/i
      );
    });

    it('rejects non-USD ticket tiers, non-USD checkouts, non-USD Connect default_currency, OrganizerBalance mismatch, and untrusted onboarding redirect URLs', async () => {
      const { user, token, event } = await createVerifiedOrganizerFixture('cur-guard');

      // 1. Non-USD ticket tier rejected at organizer validation boundary
      const badTierRes = await request(app)
        .post('/api/organizer/events')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Non-USD Event',
          description: 'Testing currency validation boundary cleanly',
          category: 'MUSIC',
          coverImageUrl: 'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14',
          venueName: 'Club Test',
          venueAddress: '100 Broadway',
          city: 'New York',
          country: 'United States',
          startAt: new Date(Date.now() + 86_400_000 * 5).toISOString(),
          endAt: new Date(Date.now() + 86_400_000 * 6).toISOString(),
          ticketTiers: [
            {
              name: 'VIP',
              priceInCents: 2000,
              currency: 'EUR',
              totalCapacity: 50,
            },
          ],
        });
      expect(badTierRes.status).toBe(400);

      // 2. Legacy non-USD tier rejected at checkout boundary
      const eurTier = await prisma.ticketTier.create({
        data: {
          eventId: event.id,
          name: 'Legacy EUR',
          priceInCents: 2000,
          currency: 'EUR',
          totalCapacity: 50,
        },
      });
      await prisma.event.update({
        where: { id: event.id },
        data: { status: EventStatus.PUBLISHED },
      });

      const badCheckout = await request(app).post('/api/checkout/create-session').send({
        eventId: event.id,
        items: [{ ticketTierId: eurTier.id, quantity: 1 }],
        customerEmail: 'buyer@outside.vip',
        customerName: 'Buyer',
        customerPhone: '+15555555555',
      });
      expect(badCheckout.status).toBe(400);
      expect(badCheckout.body.error.code).toBe('UNSUPPORTED_CURRENCY');

      // 3. Connected account default_currency mismatch rejected on withdrawal
      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
        id: user.stripeAccountId,
        country: 'US',
        default_currency: 'cad',
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: { transfers: 'active', card_payments: 'active' },
        requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
      } as any);

      await expect(
        executeWithdrawal({ userId: user.id, amountInCents: 1000 })
      ).rejects.toThrow(/default currency/i);

      // 4. OrganizerBalance currency mismatch rejected during withdrawal
      await prisma.organizerBalance.create({
        data: {
          userId: user.id,
          availableBalanceInCents: 2000,
          currency: 'EUR',
        },
      });
      mockReadyUsAccount(user.stripeAccountId!);
      await expect(
        executeWithdrawal({ userId: user.id, amountInCents: 1000 })
      ).rejects.toThrow(/currency mismatch/i);

      // 5. Untrusted returnUrl / refreshUrl origin rejected
      await expect(
        createOnboardingLink(user.id, 'https://evil-phishing.example.com/steal', undefined, false, 'US')
      ).rejects.toThrow(/not allowlisted/i);
    });

    it('validates independent STRIPE_CONNECT_WEBHOOK_SECRET requirement in production startup config', () => {
      expect(() =>
        validateStripeWebhookProductionConfig({
          NODE_ENV: 'production',
          STRIPE_WEBHOOK_SECRET: 'whsec_platform_123',
          STRIPE_CONNECT_WEBHOOK_SECRET: '',
        })
      ).toThrow(/STRIPE_CONNECT_WEBHOOK_SECRET/i);

      expect(() =>
        validateStripeWebhookProductionConfig({
          NODE_ENV: 'production',
          STRIPE_WEBHOOK_SECRET: 'whsec_shared_123',
          STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_shared_123',
        })
      ).toThrow(/distinct from STRIPE_WEBHOOK_SECRET/i);

      expect(() =>
        validateStripeWebhookProductionConfig({
          NODE_ENV: 'production',
          STRIPE_WEBHOOK_SECRET: 'whsec_platform_123',
          STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect_456',
        })
      ).not.toThrow();
    });
  });

  // =========================================================================
  // STAGE 3 TARGETED REVIEW REMEDIATION VERIFICATION
  // =========================================================================
  describe('Stage 3 Review Remediation Verification', () => {
    it('paginates Connect account recovery across >100 accounts, fails closed on multi-match / page-cap / API errors without recreating', async () => {
      const { user } = await createVerifiedOrganizerFixture('conn-pag', null);
      const pendingKey = `ck_paginated_${nanoid(10)}`;
      const startedAt = new Date(Date.now() - 120_000);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          stripeAccountId: null,
          stripeAccountCountry: null,
          stripeAccountCreationKey: pendingKey,
          stripeAccountCreationStartedAt: startedAt,
        },
      });

      const createSpy = vi.spyOn(stripe.accounts, 'create');

      // 1. Page 2 match (>100 accounts) using starting_after + created.gte recovers without accounts.create()
      const page1Items = Array.from({ length: 100 }, (_, i) => ({
        id: `acct_other_p1_${i}`,
        country: 'US',
        default_currency: 'usd',
        metadata: { userId: 'other_user', creationKey: 'other_key' },
      }));
      const listSpy = vi
        .spyOn(stripe.accounts, 'list')
        .mockResolvedValueOnce({
          object: 'list',
          has_more: true,
          data: page1Items as any,
        } as any)
        .mockResolvedValueOnce({
          object: 'list',
          has_more: false,
          data: [
            {
              id: 'acct_recovered_page2',
              country: 'US',
              default_currency: 'usd',
              metadata: { userId: user.id, creationKey: pendingKey },
            },
          ] as any,
        } as any);

      vi.spyOn(stripe.accountLinks, 'create').mockResolvedValueOnce({
        url: 'https://connect.stripe.com/setup/s/paginated',
      } as any);

      const okRes = await createOnboardingLink(
        user.id,
        'http://localhost:5173/finance',
        'http://localhost:5173/finance',
        false,
        'US'
      );
      expect(okRes.stripeAccountId).toBe('acct_recovered_page2');
      expect(createSpy).not.toHaveBeenCalled();
      expect(listSpy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ limit: 100, created: expect.objectContaining({ gte: expect.any(Number) }) })
      );
      expect(listSpy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ starting_after: 'acct_other_p1_99' })
      );

      // Reset to ambiguous recovery state for fail-closed checks
      const failKey = `ck_failclosed_${nanoid(10)}`;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          stripeAccountId: null,
          stripeAccountCreationKey: failKey,
          stripeAccountCreationStartedAt: startedAt,
          stripeAccountCreationLockedBy: null,
          stripeAccountCreationLockedUntil: null,
        },
      });

      // 2. Multiple matches -> fail closed & preserve creation key
      vi.spyOn(stripe.accounts, 'list').mockResolvedValueOnce({
        object: 'list',
        has_more: false,
        data: [
          { id: 'acct_dup_1', country: 'US', metadata: { userId: user.id, creationKey: failKey } },
          { id: 'acct_dup_2', country: 'US', metadata: { userId: user.id, creationKey: failKey } },
        ] as any,
      } as any);
      await expect(
        createOnboardingLink(user.id, 'http://localhost:5173/finance', 'http://localhost:5173/finance', false, 'US')
      ).rejects.toThrow(/multiple stripe connect accounts/i);
      expect(createSpy).not.toHaveBeenCalled();
      expect((await prisma.user.findUnique({ where: { id: user.id } }))?.stripeAccountCreationKey).toBe(failKey);

      // 3. Truncated scan (has_more=true across 10 pages without match) -> fail closed
      let pageIdx = 0;
      vi.spyOn(stripe.accounts, 'list').mockImplementation(async () => {
        pageIdx += 1;
        return {
          object: 'list',
          has_more: true,
          data: [{ id: `acct_trunc_${pageIdx}`, metadata: { userId: 'other', creationKey: 'none' } }],
        } as any;
      });
      await expect(
        createOnboardingLink(user.id, 'http://localhost:5173/finance', 'http://localhost:5173/finance', false, 'US')
      ).rejects.toThrow(/temporarily unavailable/i);
      expect(pageIdx).toBe(10);
      expect(createSpy).not.toHaveBeenCalled();
      expect((await prisma.user.findUnique({ where: { id: user.id } }))?.stripeAccountCreationKey).toBe(failKey);

      // 4. Stripe list API error -> fail closed
      vi.spyOn(stripe.accounts, 'list').mockRejectedValueOnce(new Error('Stripe API rate limited'));
      await expect(
        createOnboardingLink(user.id, 'http://localhost:5173/finance', 'http://localhost:5173/finance', false, 'US')
      ).rejects.toThrow(/temporarily unavailable/i);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('separates lastCreateAttemptAt clock across T=0, T=19h55m retry, T=24h15m protection, post-retry expiry, and fails closed when lastCreateAttemptAt is unknown', async () => {
      const { user, event, tier } = await createVerifiedOrganizerFixture('attempt-clock');
      await seedAvailableBalanceFromOrder({
        organizerId: user.id,
        eventId: event.id,
        tierId: tier.id,
        netInCents: 3000,
      });

      mockReadyUsAccount(user.stripeAccountId!);

      // T = 0: Initial attempt hits transient 500 error; verify lastCreateAttemptAt was persisted before Stripe call
      let observedAttemptAtCall1: Date | null = null;
      const clientKey = `clk_retry_${nanoid(8)}`;
      const err500: any = new Error('Stripe 500');
      err500.type = 'StripeAPIError';
      err500.statusCode = 500;

      vi.spyOn(stripe.transfers, 'create').mockImplementationOnce(async () => {
        const rec = await prisma.organizerTransfer.findUnique({
          where: { idempotencyKey: `tx_${user.id}_${clientKey}` },
        });
        observedAttemptAtCall1 = rec?.lastCreateAttemptAt ?? null;
        throw err500;
      });
      vi.spyOn(stripe.transfers, 'list').mockResolvedValue({ object: 'list', has_more: false, data: [] } as any);

      const initialPending = await executeWithdrawal({
        userId: user.id,
        amountInCents: 1500,
        idempotencyKey: clientKey,
      });
      expect(initialPending.status).toBe(TransferStatus.PENDING);
      expect(observedAttemptAtCall1).not.toBeNull();

      // Backdate T = 0 to exactly 19h55m ago so we simulate executing the same-key retry at T = 19h55m
      const t0 = new Date(Date.now() - (19 * 60 + 55) * 60_000);
      await prisma.organizerTransfer.update({
        where: { id: initialPending.transferId },
        data: {
          createdAt: t0,
          lastCreateAttemptAt: t0,
          reconciliationNextAttemptAt: new Date(Date.now() - 1000),
        },
      });

      // Same-key retry at T = 19h55m (still < 20h window from T=0) updates lastCreateAttemptAt before Stripe call
      let observedAttemptAtRetry: Date | null = null;
      vi.spyOn(stripe.transfers, 'create').mockImplementationOnce(async () => {
        const rec = await prisma.organizerTransfer.findUnique({
          where: { id: initialPending.transferId },
        });
        observedAttemptAtRetry = rec?.lastCreateAttemptAt ?? null;
        throw err500;
      });

      const retryRes = await executeWithdrawal({
        userId: user.id,
        amountInCents: 1500,
        idempotencyKey: clientKey,
      });
      expect(retryRes.status).toBe(TransferStatus.PENDING);
      expect(observedAttemptAtRetry).not.toBeNull();
      expect(observedAttemptAtRetry!.getTime()).toBeGreaterThan(t0.getTime());

      // Worker run at T = 24h15m after T = 0 (must NOT restore because T = 19h55m + 24h15m has NOT elapsed!)
      const checkAtT0Plus24h15m = new Date(t0.getTime() + STRIPE_IDEMPOTENCY_EXPIRY_GRACE_MS + 60_000);
      const claim1 = await claimPendingTransfersForReconciliation({
        workerId: 'wk_clock_1',
        now: checkAtT0Plus24h15m,
      });
      const claimedRow1 = claim1.find((c) => c.id === initialPending.transferId)!;
      expect(claimedRow1).toBeDefined();

      const outcomeAtT0Expiry = await processClaimedTransferReconciliation(claimedRow1, 'wk_clock_1', {
        now: checkAtT0Plus24h15m,
      });
      expect(outcomeAtT0Expiry).toBe('stillUncertain');
      expect((await prisma.organizerTransfer.findUnique({ where: { id: initialPending.transferId } }))?.status).toBe(
        TransferStatus.PENDING
      );
      expect((await prisma.organizerBalance.findUnique({ where: { userId: user.id } }))?.availableBalanceInCents).toBe(1500);

      // Worker run AFTER lastCreateAttemptAt + 24h15m with authoritative empty list -> safely restores!
      await prisma.organizerTransfer.update({
        where: { id: initialPending.transferId },
        data: { reconciliationNextAttemptAt: new Date(Date.now() - 1000) },
      });
      const checkAfterRetryExpiry = new Date(observedAttemptAtRetry!.getTime() + STRIPE_IDEMPOTENCY_EXPIRY_GRACE_MS + 60_000);
      const claim2 = await claimPendingTransfersForReconciliation({
        workerId: 'wk_clock_2',
        now: checkAfterRetryExpiry,
      });
      const claimedRow2 = claim2.find((c) => c.id === initialPending.transferId)!;
      const outcomeAfterRetryExpiry = await processClaimedTransferReconciliation(claimedRow2, 'wk_clock_2', {
        now: checkAfterRetryExpiry,
      });
      expect(outcomeAfterRetryExpiry).toBe('failedRestored');
      expect((await prisma.organizerBalance.findUnique({ where: { userId: user.id } }))?.availableBalanceInCents).toBe(3000);

      // Unknown lastCreateAttemptAt === null -> fail closed and retain reservation even when createdAt > 30h old
      const nullKey = `clk_unknown_${nanoid(8)}`;
      vi.spyOn(stripe.transfers, 'create').mockRejectedValueOnce(err500);
      const pendingUnknown = await executeWithdrawal({
        userId: user.id,
        amountInCents: 1000,
        idempotencyKey: nullKey,
      });

      await prisma.organizerTransfer.update({
        where: { id: pendingUnknown.transferId },
        data: {
          createdAt: new Date(Date.now() - 36 * 3600_000),
          lastCreateAttemptAt: null,
          reconciliationNextAttemptAt: new Date(Date.now() - 1000),
        },
      });
      const claimNull = await claimPendingTransfersForReconciliation({ workerId: 'wk_null_attempt' });
      const claimedNullRow = claimNull.find((c) => c.id === pendingUnknown.transferId)!;
      const outcomeNull = await processClaimedTransferReconciliation(claimedNullRow, 'wk_null_attempt');
      expect(outcomeNull).toBe('manualReviewRequired');
      expect((await prisma.organizerTransfer.findUnique({ where: { id: pendingUnknown.transferId } }))?.status).toBe(
        TransferStatus.PENDING
      );
      expect((await prisma.organizerBalance.findUnique({ where: { userId: user.id } }))?.availableBalanceInCents).toBe(2000);
    });

    it('paginates lookupStripeTransferForRecord across pages/destination, deduplicates, preserves partial errors, and prevents non-authoritative restoration', async () => {
      const { user, event, tier } = await createVerifiedOrganizerFixture('tr-pag');
      await seedAvailableBalanceFromOrder({
        organizerId: user.id,
        eventId: event.id,
        tierId: tier.id,
        netInCents: 2000,
      });

      const target = {
        id: 'trf_pag_target',
        transferNumber: 'TRF-PAG-001',
        stripeAccountId: user.stripeAccountId!,
        amountInCents: 1200,
        currency: 'USD',
        stripeTransferId: null,
        createdAt: new Date(),
      };

      // 1. Page 2 destination scan match (>100 transfers) with overlapping page-1 item deduplication
      const listSpy = vi
        .spyOn(stripe.transfers, 'list')
        .mockResolvedValueOnce({ object: 'list', has_more: false, data: [] } as any) // byGroup empty
        .mockResolvedValueOnce({
          object: 'list',
          has_more: true,
          data: [
            { id: 'tr_noise_1', amount: 500, currency: 'usd', destination: user.stripeAccountId, transfer_group: 'TRF-OTHER' },
            { id: 'tr_noise_1', amount: 500, currency: 'usd', destination: user.stripeAccountId, transfer_group: 'TRF-OTHER' },
            { id: 'tr_noise_100', amount: 500, currency: 'usd', destination: user.stripeAccountId, transfer_group: 'TRF-OTHER' },
          ],
        } as any)
        .mockResolvedValueOnce({
          object: 'list',
          has_more: false,
          data: [
            {
              id: 'tr_dest_page2',
              amount: 1200,
              currency: 'usd',
              destination: user.stripeAccountId,
              transfer_group: target.transferNumber,
              metadata: { transferId: target.id },
            },
          ],
        } as any);

      const foundPage2 = await lookupStripeTransferForRecord(target, { includeDestinationScan: true });
      expect(foundPage2.found).toBe(true);
      if (foundPage2.found) {
        expect(foundPage2.stripeTransfer.id).toBe('tr_dest_page2');
      }
      expect(listSpy).toHaveBeenNthCalledWith(3, expect.objectContaining({ starting_after: 'tr_noise_100' }));

      // 2. Truncated scan after TRANSFER_LOOKUP_MAX_PAGES (10) -> authoritativeEmpty: false -> manualReviewRequired
      let calls = 0;
      vi.spyOn(stripe.transfers, 'list').mockImplementation(async () => {
        calls += 1;
        return {
          object: 'list',
          has_more: true,
          data: [{ id: `tr_cap_${calls}`, amount: 500, currency: 'usd', destination: 'acct_other', transfer_group: 'OTHER' }],
        } as any;
      });
      const truncated = await lookupStripeTransferForRecord(target, { includeDestinationScan: false });
      expect(truncated.found).toBe(false);
      if (!truncated.found) {
        expect(truncated.authoritativeEmpty).toBe(false);
      }
      expect(calls).toBe(TRANSFER_LOOKUP_MAX_PAGES);

      // 3. Error in byGroup while byDest returns empty -> error preserved & authoritativeEmpty: false
      vi.spyOn(stripe.transfers, 'list')
        .mockRejectedValueOnce(new Error('Stripe transient error on group list'))
        .mockResolvedValueOnce({ object: 'list', has_more: false, data: [] } as any);
      const partialErr = await lookupStripeTransferForRecord(target, { includeDestinationScan: true });
      expect(partialErr.found).toBe(false);
      if (!partialErr.found) {
        expect(partialErr.authoritativeEmpty).toBe(false);
        expect(partialErr.error).toBeDefined();
      }
    });

    it('prevents webhook/API race from tainting a withdrawal finalized by transfer.created during lookup', async () => {
      const { user, event, tier } = await createVerifiedOrganizerFixture('race-wh');
      await seedAvailableBalanceFromOrder({
        organizerId: user.id,
        eventId: event.id,
        tierId: tier.id,
        netInCents: 1800,
      });

      mockReadyUsAccount(user.stripeAccountId!);
      const timeoutErr: any = new Error('Socket timeout');
      timeoutErr.code = 'ETIMEDOUT';
      vi.spyOn(stripe.transfers, 'create').mockRejectedValueOnce(timeoutErr);

      const racedStripeTransferId = `tr_raced_${nanoid(10)}`;
      vi.spyOn(stripe.transfers, 'list').mockImplementationOnce(async (params: any) => {
        // Simulate concurrent transfer.created webhook arriving BEFORE lookup returns empty
        await processStripeWebhookEvent(
          trackEvt({
            id: `evt_race_tr_${nanoid(10)}`,
            type: 'transfer.created',
            data: {
              object: {
                id: racedStripeTransferId,
                amount: 1800,
                currency: 'usd',
                destination: user.stripeAccountId,
                transfer_group: params.transfer_group,
                metadata: { transferNumber: params.transfer_group },
              } as any,
            },
          } as any)
        );
        return { object: 'list', has_more: false, data: [] } as any;
      });

      const result = await executeWithdrawal({
        userId: user.id,
        amountInCents: 1800,
        idempotencyKey: `race_wh_${nanoid(8)}`,
      });

      expect(result.status).toBe(TransferStatus.SUCCEEDED);
      expect(result.stripeTransferId).toBe(racedStripeTransferId);
      expect(result.reconciliationRequired).toBe(false);
      expect(result.retryable).toBeUndefined();
      const dbRec = await prisma.organizerTransfer.findUnique({ where: { id: result.transferId } });
      expect(dbRec?.status).toBe(TransferStatus.SUCCEEDED);
      expect(dbRec?.reconciliationRequired).toBe(false);
    });

    it('rejects mismatched transfer amount or currency in finalizeTransferSucceededInTx and webhook stripeTransferId path', async () => {
      const { user, event, tier } = await createVerifiedOrganizerFixture('amt-cur');
      await seedAvailableBalanceFromOrder({
        organizerId: user.id,
        eventId: event.id,
        tierId: tier.id,
        netInCents: 2500,
      });

      mockReadyUsAccount(user.stripeAccountId!);
      const timeoutErr: any = new Error('Connection reset');
      timeoutErr.code = 'ECONNRESET';
      vi.spyOn(stripe.transfers, 'create').mockRejectedValueOnce(timeoutErr);
      vi.spyOn(stripe.transfers, 'list').mockResolvedValueOnce({ object: 'list', has_more: false, data: [] } as any);

      const pendingRes = await executeWithdrawal({
        userId: user.id,
        amountInCents: 2500,
        idempotencyKey: `mismatch_${nanoid(8)}`,
      });

      // 1. finalizeTransferSucceededInTx rejects wrong amount or wrong currency
      const wrongAmountFinalizer = await prisma.$transaction((tx) =>
        finalizeTransferSucceededInTx(tx, {
          transferId: pendingRes.transferId,
          stripeTransfer: { id: 'tr_wrong_amt', amount: 1200, currency: 'usd' },
        })
      );
      expect(wrongAmountFinalizer.outcome).toBe('amountCurrencyMismatch');
      expect((await prisma.organizerTransfer.findUnique({ where: { id: pendingRes.transferId } }))?.status).toBe(
        TransferStatus.PENDING
      );
      expect((await prisma.organizerBalance.findUnique({ where: { userId: user.id } }))?.transferredBalanceInCents).toBe(0);

      // 2. Webhook primary stripeTransferId branch rejects wrong amount or currency on transfer.reversed
      const stId = `tr_primary_check_${nanoid(8)}`;
      await prisma.organizerTransfer.update({
        where: { id: pendingRes.transferId },
        data: { stripeTransferId: stId },
      });

      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_wrong_cur_${nanoid(10)}`,
          type: 'transfer.created',
          data: {
            object: {
              id: stId,
              amount: 2500,
              currency: 'eur',
              destination: user.stripeAccountId,
            } as any,
          },
        } as any)
      );
      expect((await prisma.organizerTransfer.findUnique({ where: { id: pendingRes.transferId } }))?.status).toBe(
        TransferStatus.PENDING
      );

      // Now finalize cleanly with exact match, then test transfer.reversed with wrong amount
      const okFinalizer = await prisma.$transaction((tx) =>
        finalizeTransferSucceededInTx(tx, {
          transferId: pendingRes.transferId,
          stripeTransfer: { id: stId, amount: 2500, currency: 'usd' },
        })
      );
      expect(okFinalizer.outcome).toBe('succeeded');

      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_rev_mismatch_${nanoid(10)}`,
          type: 'transfer.reversed',
          data: {
            object: {
              id: stId,
              amount: 9999, // Mismatched amount!
              amount_reversed: 9999,
              currency: 'usd',
            } as any,
          },
        } as any)
      );
      const afterMismatchRev = await prisma.organizerTransfer.findUnique({ where: { id: pendingRes.transferId } });
      expect(afterMismatchRev?.status).toBe(TransferStatus.SUCCEEDED);
      expect(afterMismatchRev?.reversedAmountInCents).toBe(0);
    });

    it('fails closed on missing country or default_currency and rejects non-USD PLATFORM_SUPPORTED_CURRENCIES', async () => {
      const { user, event, tier } = await createVerifiedOrganizerFixture('missing-ac', 'acct_missing_fields_1');
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeAccountCountry: null },
      });
      await seedAvailableBalanceFromOrder({
        organizerId: user.id,
        eventId: event.id,
        tierId: tier.id,
        netInCents: 1500,
      });

      // Explicit usd returns defaultCurrency: 'USD' and allows publishing/withdrawal
      mockReadyUsAccount('acct_missing_fields_1');
      const statusValidUsUsd = await getConnectedAccountStatus(user.id);
      expect(statusValidUsUsd.defaultCurrency).toBe('USD');
      expect(statusValidUsUsd.transferBalance.enabled).toBe(true);
      await expect(assertStripeReadyForPaidPublishing(user.id)).resolves.toMatchObject({
        defaultCurrency: 'USD',
        country: 'US',
      });

      // Reset persisted country before testing missing country on account retrieve
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeAccountCountry: null },
      });

      // Missing country
      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValue({
        id: 'acct_missing_fields_1',
        default_currency: 'usd',
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: { transfers: 'active', card_payments: 'active' },
        requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
      } as any);

      const statusMissingCountry = await getConnectedAccountStatus(user.id);
      expect(statusMissingCountry.defaultCurrency).toBe('USD');
      expect(statusMissingCountry.country).toBeNull();
      expect(statusMissingCountry.transferBalance.enabled).toBe(false);
      await expect(assertStripeReadyForPaidPublishing(user.id)).rejects.toThrow(/country/i);
      await expect(executeWithdrawal({ userId: user.id, amountInCents: 1000 })).rejects.toThrow(/country/i);

      // Missing default_currency -> defaultCurrency MUST be null (never 'USD') and fail closed
      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValue({
        id: 'acct_missing_fields_1',
        country: 'US',
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: { transfers: 'active', card_payments: 'active' },
        requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
      } as any);

      const statusMissingCur = await getConnectedAccountStatus(user.id);
      expect(statusMissingCur.defaultCurrency).toBeNull();
      expect(statusMissingCur.transferBalance.enabled).toBe(false);
      await expect(assertStripeReadyForPaidPublishing(user.id)).rejects.toThrow(/currency/i);
      await expect(executeWithdrawal({ userId: user.id, amountInCents: 1000 })).rejects.toThrow(/currency/i);

      // Single-currency configuration invariant
      expect(validatePlatformCurrencyConfig(undefined)).toEqual(['USD']);
      expect(validatePlatformCurrencyConfig('usd')).toEqual(['USD']);
      expect(() => validatePlatformCurrencyConfig('USD,EUR')).toThrow(/PLATFORM_SUPPORTED_CURRENCIES/i);
      expect(() => validatePlatformCurrencyConfig('EUR')).toThrow(/PLATFORM_SUPPORTED_CURRENCIES/i);
      expect(() => validatePlatformCurrencyConfig('')).toThrow(/PLATFORM_SUPPORTED_CURRENCIES/i);
      expect(() => getConfiguredSupportedCurrencies('USD,CAD')).toThrow(/PLATFORM_SUPPORTED_CURRENCIES/i);
    });

    it('protects lastCreateAttemptAt via lease ownership and returns persisted SUCCEEDED / REVERSED state when webhook wins during same-key retry', async () => {
      const { user, event, tier } = await createVerifiedOrganizerFixture('retry-race-lease');
      await seedAvailableBalanceFromOrder({
        organizerId: user.id,
        eventId: event.id,
        tierId: tier.id,
        netInCents: 4000,
      });

      mockReadyUsAccount(user.stripeAccountId!);
      const errTimeout: any = new Error('Stripe timeout');
      errTimeout.code = 'ETIMEDOUT';

      // 1. Seed ambiguous PENDING transfer (1500 cents); reserved funds remain decremented (2500 left)
      const key1 = `retry_succ_${nanoid(8)}`;
      vi.spyOn(stripe.transfers, 'create').mockRejectedValueOnce(errTimeout);
      vi.spyOn(stripe.transfers, 'list').mockResolvedValue({ object: 'list', has_more: false, data: [] } as any);

      const p1 = await executeWithdrawal({ userId: user.id, amountInCents: 1500, idempotencyKey: key1 });
      expect(p1.status).toBe(TransferStatus.PENDING);
      expect(p1.retryable).toBe(true);
      expect((await prisma.organizerBalance.findUnique({ where: { userId: user.id } }))?.availableBalanceInCents).toBe(2500);

      // Same-key retry: webhook finalizes SUCCEEDED while stripe.transfers.create() is in-flight before throwing timeout
      const whTr1 = `tr_retry_wh_succ_${nanoid(8)}`;
      vi.spyOn(stripe.transfers, 'create').mockImplementationOnce(async () => {
        const rec = await prisma.organizerTransfer.findUniqueOrThrow({ where: { id: p1.transferId } });
        // Lease owner already stamped lastCreateAttemptAt before entering Stripe create call
        expect(rec.lastCreateAttemptAt).not.toBeNull();
        expect(rec.reconciliationLockedBy).toMatch(/^retry_/);

        await processStripeWebhookEvent(
          trackEvt({
            id: `evt_retry_succ_${nanoid(8)}`,
            type: 'transfer.created',
            data: {
              object: {
                id: whTr1,
                amount: 1500,
                currency: 'usd',
                destination: user.stripeAccountId,
                transfer_group: p1.transferNumber,
                metadata: { transferId: p1.transferId, transferNumber: p1.transferNumber },
              } as any,
            },
          } as any)
        );
        throw errTimeout;
      });

      const res1 = await executeWithdrawal({ userId: user.id, amountInCents: 1500, idempotencyKey: key1 });
      expect(res1.status).toBe(TransferStatus.SUCCEEDED);
      expect(res1.retryable).toBe(false);
      expect(res1.stripeTransferId).toBe(whTr1);
      expect(res1.reconciliationRequired).toBe(false);
      const db1 = await prisma.organizerTransfer.findUniqueOrThrow({ where: { id: p1.transferId } });
      expect(db1.status).toBe(TransferStatus.SUCCEEDED);
      expect(db1.reconciliationRequired).toBe(false);

      // 2. Same-key retry race when webhook commits SUCCEEDED + REVERSED before retry throws timeout
      const key2 = `retry_rev_${nanoid(8)}`;
      vi.spyOn(stripe.transfers, 'create').mockRejectedValueOnce(errTimeout);
      const p2 = await executeWithdrawal({ userId: user.id, amountInCents: 1000, idempotencyKey: key2 });
      expect(p2.status).toBe(TransferStatus.PENDING);

      const whTr2 = `tr_retry_wh_rev_${nanoid(8)}`;
      vi.spyOn(stripe.transfers, 'create').mockImplementationOnce(async () => {
        await processStripeWebhookEvent(
          trackEvt({
            id: `evt_retry_cre2_${nanoid(8)}`,
            type: 'transfer.created',
            data: {
              object: {
                id: whTr2,
                amount: 1000,
                currency: 'usd',
                destination: user.stripeAccountId,
                transfer_group: p2.transferNumber,
                metadata: { transferId: p2.transferId, transferNumber: p2.transferNumber },
              } as any,
            },
          } as any)
        );
        await processStripeWebhookEvent(
          trackEvt({
            id: `evt_retry_rev2_${nanoid(8)}`,
            type: 'transfer.reversed',
            data: {
              object: {
                id: whTr2,
                amount: 1000,
                amount_reversed: 1000,
                reversed: true,
                currency: 'usd',
                destination: user.stripeAccountId,
              } as any,
            },
          } as any)
        );
        throw errTimeout;
      });

      const res2 = await executeWithdrawal({ userId: user.id, amountInCents: 1000, idempotencyKey: key2 });
      expect(res2.status).toBe(TransferStatus.REVERSED);
      expect(res2.retryable).toBe(false);
      expect(res2.reversedAmountInCents).toBe(1000);
      expect(res2.remainingAvailableInCents).toBe(2500);
      const db2 = await prisma.organizerTransfer.findUniqueOrThrow({ where: { id: p2.transferId } });
      expect(db2.status).toBe(TransferStatus.REVERSED);

      // 3. Stale/expired lease owner MUST NOT overwrite newer lastCreateAttemptAt or invoke stripe.transfers.create()
      const key3 = `retry_stale_${nanoid(8)}`;
      vi.spyOn(stripe.transfers, 'create').mockRejectedValueOnce(errTimeout);
      const p3 = await executeWithdrawal({ userId: user.id, amountInCents: 1000, idempotencyKey: key3 });
      expect(p3.status).toBe(TransferStatus.PENDING);

      const protectedAttemptTime = new Date(Date.now() + 60_000);
      const rawUpdateMany = prisma.organizerTransfer.updateMany.bind(prisma.organizerTransfer);
      let hijackedAfterClaim = false;
      const updateManySpy = vi.spyOn(prisma.organizerTransfer, 'updateMany').mockImplementation(async (args: any) => {
        const result = await rawUpdateMany(args);
        if (!hijackedAfterClaim && args?.data?.reconciliationLockedBy) {
          hijackedAfterClaim = true;
          // Simulate lease expiry & takeover by another worker before stale caller tries to stamp lastCreateAttemptAt
          await rawUpdateMany({
            where: { id: p3.transferId },
            data: {
              reconciliationLockedBy: 'newer_worker_active',
              reconciliationLockedUntil: new Date(Date.now() + 120_000),
              lastCreateAttemptAt: protectedAttemptTime,
            },
          });
        }
        return result;
      });

      const createAfterStaleSpy = vi.spyOn(stripe.transfers, 'create');
      const staleRes = await executeWithdrawal({ userId: user.id, amountInCents: 1000, idempotencyKey: key3 });
      updateManySpy.mockRestore();

      expect(createAfterStaleSpy).not.toHaveBeenCalled();
      expect(staleRes.status).toBe(TransferStatus.PENDING);
      const db3 = await prisma.organizerTransfer.findUniqueOrThrow({ where: { id: p3.transferId } });
      expect(db3.reconciliationLockedBy).toBe('newer_worker_active');
      expect(db3.lastCreateAttemptAt?.getTime()).toBe(protectedAttemptTime.getTime());
      // Reserved funds remain intact ($40 - $15 SUCCEEDED - $10 stale PENDING = $15)
      expect((await prisma.organizerBalance.findUnique({ where: { userId: user.id } }))?.availableBalanceInCents).toBe(1500);
    });
  });
});
