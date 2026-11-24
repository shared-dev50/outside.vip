import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import {
  EventTeamRole,
  LedgerBalanceType,
  LedgerEntryType,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  Role,
  TeamMemberStatus,
} from '@prisma/client';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';

describe('Stripe Readiness Stage 1: Finance Authorization, Dispute Isolation & Team Boundaries', () => {
  const runId = `${Date.now()}_${nanoid(6).toLowerCase()}`;
  const createdUserIds: string[] = [];
  const createdEventIds: string[] = [];
  const createdOrderIds: string[] = [];

  let verifiedAttendeeId: string;
  let verifiedAttendeeToken: string;

  let unverifiedOrganizerId: string;
  let unverifiedOrganizerToken: string;

  let organizerAId: string;
  let organizerAToken: string;
  const organizerAAcctId = `acct_stage1_orgA_${runId}`;

  let organizerBId: string;
  let organizerBToken: string;
  const organizerBAcctId = `acct_stage1_orgB_${runId}`;

  let teamAdminAttendeeId: string;
  let teamAdminAttendeeToken: string;

  let platformAdminToken: string;

  let eventAId: string;
  let eventBId: string;
  let orderA1Id: string;
  let orderA2Id: string;
  let orderB1Id: string;

  const piA1 = `pi_stage1_orgA_1_${runId}`;
  const chA1 = `ch_stage1_orgA_1_${runId}`;
  const piA2 = `pi_stage1_orgA_2_${runId}`;
  const chA2 = `ch_stage1_orgA_2_${runId}`;
  const piB1 = `pi_stage1_orgB_1_${runId}`;
  const chB1 = `ch_stage1_orgB_1_${runId}`;

  async function createAndLoginUser(opts: {
    email: string;
    name: string;
    role: Role;
    emailVerified: boolean;
    stripeAccountId?: string;
  }): Promise<{ userId: string; token: string }> {
    const password = 'Outside2026!Stage1';
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email: opts.email.trim().toLowerCase(),
        name: opts.name,
        passwordHash,
        role: opts.role,
        emailVerified: opts.emailVerified,
        emailVerifiedAt: opts.emailVerified ? new Date() : null,
        stripeAccountId: opts.stripeAccountId || null,
      },
    });
    createdUserIds.push(user.id);

    const loginRes = await request(app).post('/api/auth/login').send({
      email: opts.email,
      password,
    });
    expect(loginRes.status).toBe(200);
    return {
      userId: user.id,
      token: loginRes.body.data.token,
    };
  }

  beforeAll(async () => {
    const adminLogin = await request(app).post('/api/auth/login').send({
      email: 'admin@outside.vip',
      password: 'Outside2026!',
    });
    expect(adminLogin.status).toBe(200);
    platformAdminToken = adminLogin.body.data.token;

    const att = await createAndLoginUser({
      email: `stage1_att_${runId}@outside.vip`,
      name: 'Verified Attendee',
      role: Role.ATTENDEE,
      emailVerified: true,
    });
    verifiedAttendeeId = att.userId;
    verifiedAttendeeToken = att.token;

    const unverifiedOrg = await createAndLoginUser({
      email: `stage1_unver_org_${runId}@outside.vip`,
      name: 'Unverified Organizer',
      role: Role.ORGANIZER,
      emailVerified: false,
    });
    unverifiedOrganizerId = unverifiedOrg.userId;
    unverifiedOrganizerToken = unverifiedOrg.token;

    const orgA = await createAndLoginUser({
      email: `stage1_orgA_${runId}@outside.vip`,
      name: 'Stage1 Organizer A',
      role: Role.ORGANIZER,
      emailVerified: true,
      stripeAccountId: organizerAAcctId,
    });
    organizerAId = orgA.userId;
    organizerAToken = orgA.token;

    const orgB = await createAndLoginUser({
      email: `stage1_orgB_${runId}@outside.vip`,
      name: 'Stage1 Organizer B',
      role: Role.ORGANIZER,
      emailVerified: true,
      stripeAccountId: organizerBAcctId,
    });
    organizerBId = orgB.userId;
    organizerBToken = orgB.token;

    const teamAdmin = await createAndLoginUser({
      email: `stage1_team_admin_${runId}@outside.vip`,
      name: 'Delegated Event Admin',
      role: Role.ATTENDEE,
      emailVerified: true,
    });
    teamAdminAttendeeId = teamAdmin.userId;
    teamAdminAttendeeToken = teamAdmin.token;

    const eventA = await prisma.event.create({
      data: {
        organizerId: organizerAId,
        title: `Stage1 Event A ${runId}`,
        description: 'Event A for financial isolation testing',
        slug: `stage1-event-a-${runId}`,
        coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
        venueName: 'Venue A',
        venueAddress: '100 Main St',
        city: 'New York',
        country: 'US',
        startAt: new Date(Date.now() + 86400000),
        endAt: new Date(Date.now() + 86400000 * 2),
      },
    });
    eventAId = eventA.id;
    createdEventIds.push(eventAId);

    const eventB = await prisma.event.create({
      data: {
        organizerId: organizerBId,
        title: `Stage1 Event B ${runId}`,
        description: 'Event B for financial isolation testing',
        slug: `stage1-event-b-${runId}`,
        coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
        venueName: 'Venue B',
        venueAddress: '200 Ocean Ave',
        city: 'Miami',
        country: 'US',
        startAt: new Date(Date.now() + 86400000),
        endAt: new Date(Date.now() + 86400000 * 2),
      },
    });
    eventBId = eventB.id;
    createdEventIds.push(eventBId);

    await prisma.eventTeamMember.create({
      data: {
        eventId: eventAId,
        userId: teamAdminAttendeeId,
        role: EventTeamRole.ADMIN,
        status: TeamMemberStatus.ACTIVE,
        permissions: {
          canEditDetails: true,
          canManageTickets: true,
          canViewOrders: true,
          canViewAnalytics: true,
          canManageTeam: false,
          canManagePromotions: false,
          canManageRefunds: false,
          canManagePayouts: false,
          canCancelEvent: false,
          canDeleteEvent: false,
        },
      },
    });

    const oA1 = await prisma.order.create({
      data: {
        orderNumber: `OUT-S1-A1-${nanoid(6).toUpperCase()}`,
        eventId: eventAId,
        status: OrderStatus.COMPLETED,
        customerName: 'Buyer A1',
        customerEmail: 'buyer.a1@outside.vip',
        totalInCents: 2394,
        platformFeeInCents: 394,
        organizerNetInCents: 2000,
        currency: 'USD',
        idempotencyKey: `idem_s1_a1_${runId}`,
        paymentReference: piA1,
        stripeSettledChargeId: chA1,
        expiresAt: new Date(),
        transactions: {
          create: {
            provider: PaymentProvider.STRIPE,
            providerTransactionId: piA1,
            status: PaymentStatus.SUCCEEDED,
            amountInCents: 2394,
            currency: 'USD',
            rawResponse: { id: piA1, latest_charge: chA1 },
          },
        },
      },
    });
    orderA1Id = oA1.id;
    createdOrderIds.push(orderA1Id);

    // Order A2 relies on PaymentTransaction + orderId / paymentReference (without stripeSettledChargeId)
    const oA2 = await prisma.order.create({
      data: {
        orderNumber: `OUT-S1-A2-${nanoid(6).toUpperCase()}`,
        eventId: eventAId,
        status: OrderStatus.COMPLETED,
        customerName: 'Buyer A2',
        customerEmail: 'buyer.a2@outside.vip',
        totalInCents: 3500,
        platformFeeInCents: 500,
        organizerNetInCents: 3000,
        currency: 'USD',
        idempotencyKey: `idem_s1_a2_${runId}`,
        paymentReference: piA2,
        expiresAt: new Date(),
      },
    });
    orderA2Id = oA2.id;
    createdOrderIds.push(orderA2Id);

    const oB1 = await prisma.order.create({
      data: {
        orderNumber: `OUT-S1-B1-${nanoid(6).toUpperCase()}`,
        eventId: eventBId,
        status: OrderStatus.COMPLETED,
        customerName: 'Buyer B1',
        customerEmail: 'buyer.b1@outside.vip',
        totalInCents: 4500,
        platformFeeInCents: 500,
        organizerNetInCents: 4000,
        currency: 'USD',
        idempotencyKey: `idem_s1_b1_${runId}`,
        paymentReference: piB1,
        stripeSettledChargeId: chB1,
        expiresAt: new Date(),
        ledgerEntries: {
          create: {
            organizerId: organizerBId,
            eventId: eventBId,
            type: LedgerEntryType.TICKET_SALE_CLEARED,
            balanceType: LedgerBalanceType.AVAILABLE,
            amountInCents: 4000,
            currency: 'USD',
            stripeReferenceId: chB1,
            description: 'Stage1 Organizer B sale',
          },
        },
      },
    });
    orderB1Id = oB1.id;
    createdOrderIds.push(orderB1Id);
  }, 30000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (createdOrderIds.length > 0) {
      await prisma.financialLedgerEntry.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => {});
      await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => {});
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => {});
    }
    if (createdEventIds.length > 0) {
      await prisma.eventTeamMember.deleteMany({ where: { eventId: { in: createdEventIds } } }).catch(() => {});
      await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } }).catch(() => {});
    }
    if (createdUserIds.length > 0) {
      await prisma.organizerBalance.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
      await prisma.organizerPayoutDetails.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }
  });

  describe('1. Backend Role, Authentication & Verification Enforcement on Finance Routes', () => {
    it('blocks email-verified ATTENDEE accounts from all /api/organizer/finance/* and /payout-details endpoints with 403 and never creates Connect accounts', async () => {
      const accountCreateSpy = vi.spyOn(stripe.accounts, 'create');
      const accountLinkSpy = vi.spyOn(stripe.accountLinks, 'create');
      const disputesListSpy = vi.spyOn(stripe.disputes, 'list');

      const financeRequests: Array<Promise<request.Response>> = [
        request(app).get('/api/organizer/finance/countries').set('Authorization', `Bearer ${verifiedAttendeeToken}`),
        request(app).get('/api/organizer/finance/account').set('Authorization', `Bearer ${verifiedAttendeeToken}`),
        request(app).post('/api/organizer/finance/onboarding-link').set('Authorization', `Bearer ${verifiedAttendeeToken}`).send({ country: 'US' }),
        request(app).post('/api/organizer/finance/login-link').set('Authorization', `Bearer ${verifiedAttendeeToken}`).send({}),
        request(app).get('/api/organizer/finance/balance').set('Authorization', `Bearer ${verifiedAttendeeToken}`),
        request(app).post('/api/organizer/finance/withdraw').set('Authorization', `Bearer ${verifiedAttendeeToken}`).send({ amountInCents: 1000 }),
        request(app).post('/api/organizer/finance/admin/withdraw').set('Authorization', `Bearer ${verifiedAttendeeToken}`).send({ organizerId: organizerAId, amountInCents: 1000 }),
        request(app).get('/api/organizer/finance/transfers').set('Authorization', `Bearer ${verifiedAttendeeToken}`),
        request(app).get('/api/organizer/finance/ledger').set('Authorization', `Bearer ${verifiedAttendeeToken}`),
        request(app).get('/api/organizer/finance/payouts').set('Authorization', `Bearer ${verifiedAttendeeToken}`),
        request(app).get('/api/organizer/finance/disputes').set('Authorization', `Bearer ${verifiedAttendeeToken}`),
        request(app).patch('/api/organizer/finance/payout-schedule').set('Authorization', `Bearer ${verifiedAttendeeToken}`).send({ interval: 'daily' }),
        request(app).get('/api/organizer/finance/reconcile').set('Authorization', `Bearer ${verifiedAttendeeToken}`),
        request(app).get('/api/organizer/payout-details').set('Authorization', `Bearer ${verifiedAttendeeToken}`),
        request(app).put('/api/organizer/payout-details').set('Authorization', `Bearer ${verifiedAttendeeToken}`).send({
          orgType: 'Company',
          registeredName: 'Unauthorized Corp',
          country: 'US',
          contactPersonName: 'Att',
          contactEmail: 'att@outside.vip',
          accountHolderName: 'Att',
          bankName: 'Bank',
          bankCountry: 'US',
          accountCurrency: 'USD',
        }),
      ];

      const responses = await Promise.all(financeRequests);
      for (const res of responses) {
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      }

      expect(accountCreateSpy).not.toHaveBeenCalled();
      expect(accountLinkSpy).not.toHaveBeenCalled();
      expect(disputesListSpy).not.toHaveBeenCalled();

      const attendeeAfter = await prisma.user.findUnique({
        where: { id: verifiedAttendeeId },
        select: { stripeAccountId: true },
      });
      expect(attendeeAfter?.stripeAccountId).toBeNull();
    });

    it('keeps unauthenticated callers rejected with 401 and unverified organizers rejected with 403', async () => {
      const [unauthAccount, unauthDisputes, unverifiedAccount, unverifiedDisputes] = await Promise.all([
        request(app).get('/api/organizer/finance/account'),
        request(app).get('/api/organizer/finance/disputes'),
        request(app).get('/api/organizer/finance/account').set('Authorization', `Bearer ${unverifiedOrganizerToken}`),
        request(app).get('/api/organizer/finance/disputes').set('Authorization', `Bearer ${unverifiedOrganizerToken}`),
      ]);

      expect(unauthAccount.status).toBe(401);
      expect(unauthDisputes.status).toBe(401);
      expect(unverifiedAccount.status).toBe(403);
      expect(unverifiedDisputes.status).toBe(403);
    });
  });

  describe('2. Dispute Data Isolation & Platform ADMIN Access', () => {
    it('isolates GET /api/organizer/finance/disputes per organizer across paginated Stripe results and ignores client organizerId params', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const disputeA1 = {
        id: `dp_orgA_1_${runId}`,
        amount: 2394,
        currency: 'usd',
        charge: chA1,
        payment_intent: piA1,
        status: 'needs_response',
        reason: 'fraudulent',
        created: nowSeconds,
        evidence_details: { due_by: nowSeconds + 86400 },
        is_charge_refundable: false,
      };
      const disputeA2 = {
        id: `dp_orgA_2_${runId}`,
        amount: 3500,
        currency: 'usd',
        charge: chA2,
        payment_intent: piA2,
        metadata: { orderId: orderA2Id },
        status: 'under_review',
        reason: 'product_not_received',
        created: nowSeconds - 100,
        evidence_details: { due_by: null },
        is_charge_refundable: true,
      };
      const disputeB1 = {
        id: `dp_orgB_1_${runId}`,
        amount: 4500,
        currency: 'usd',
        charge: chB1,
        payment_intent: piB1,
        status: 'lost',
        reason: 'general',
        created: nowSeconds - 50,
        evidence_details: { due_by: null },
        is_charge_refundable: false,
      };
      const disputeUnowned = {
        id: `dp_unknown_${runId}`,
        amount: 9900,
        currency: 'usd',
        charge: `ch_unknown_${runId}`,
        payment_intent: `pi_unknown_${runId}`,
        metadata: { organizerId: organizerAId }, // Untrusted metadata organizerId must NOT leak ownership
        status: 'needs_response',
        reason: 'duplicate',
        created: nowSeconds - 10,
        evidence_details: { due_by: null },
        is_charge_refundable: false,
      };

      const listSpy = vi.spyOn(stripe.disputes, 'list').mockImplementation(async (params?: any) => {
        if (!params?.starting_after) {
          return {
            object: 'list',
            data: [disputeB1, disputeUnowned, disputeA1] as any,
            has_more: true,
          } as any;
        }
        return {
          object: 'list',
          data: [disputeA2] as any,
          has_more: false,
        } as any;
      });

      // Organizer A attempts to pass organizerId=organizerBId in query -> must be ignored & return ONLY A's disputes across pages
      const orgARes = await request(app)
        .get(`/api/organizer/finance/disputes?limit=10&organizerId=${organizerBId}`)
        .set('Authorization', `Bearer ${organizerAToken}`);

      expect(orgARes.status).toBe(200);
      expect(orgARes.body.success).toBe(true);
      expect(orgARes.body.data.disputes.map((d: any) => d.id)).toEqual([disputeA1.id, disputeA2.id]);
      expect(orgARes.body.data.disputes[0]).toMatchObject({
        id: disputeA1.id,
        amount: 2394,
        currency: 'USD',
        status: 'needs_response',
        reason: 'fraudulent',
        isChargeRefundable: false,
      });

      // Organizer B only sees dispute B1
      const orgBRes = await request(app)
        .get('/api/organizer/finance/disputes?limit=10')
        .set('Authorization', `Bearer ${organizerBToken}`);

      expect(orgBRes.status).toBe(200);
      expect(orgBRes.body.data.disputes.map((d: any) => d.id)).toEqual([disputeB1.id]);

      // Platform ADMIN accesses platform-wide disputes (even without an Express stripeAccountId)
      listSpy.mockResolvedValueOnce({
        object: 'list',
        data: [disputeB1, disputeUnowned, disputeA1] as any,
        has_more: false,
      } as any);

      const adminRes = await request(app)
        .get('/api/organizer/finance/disputes?limit=10')
        .set('Authorization', `Bearer ${platformAdminToken}`);

      expect(adminRes.status).toBe(200);
      expect(adminRes.body.data.disputes.map((d: any) => d.id)).toEqual([
        disputeB1.id,
        disputeUnowned.id,
        disputeA1.id,
      ]);
      expect(listSpy).toHaveBeenLastCalledWith({ limit: 10 });
    });

    it('returns empty disputes for an organizer with no transactions or orders without calling Stripe', async () => {
      const orgC = await createAndLoginUser({
        email: `stage1_orgC_${runId}@outside.vip`,
        name: 'No-Sales Organizer C',
        role: Role.ORGANIZER,
        emailVerified: true,
        stripeAccountId: `acct_stage1_orgC_${runId}`,
      });

      const listSpy = vi.spyOn(stripe.disputes, 'list');
      const res = await request(app)
        .get('/api/organizer/finance/disputes')
        .set('Authorization', `Bearer ${orgC.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.disputes).toEqual([]);
      expect(listSpy).not.toHaveBeenCalled();
    });

    it('uses page size 100 to scan beyond 500 platform disputes while honoring requested limit and organizer isolation', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const makeUnownedDispute = (index: number) => ({
        id: `dp_unowned_${index}_${runId}`,
        amount: 1500,
        currency: 'usd',
        charge: `ch_other_${index}_${runId}`,
        payment_intent: `pi_other_${index}_${runId}`,
        status: 'needs_response',
        reason: 'general',
        created: nowSeconds - index,
        evidence_details: { due_by: null },
        is_charge_refundable: false,
      });

      const ownedAfter500 = {
        id: `dp_owned_550_${runId}`,
        amount: 2394,
        currency: 'usd',
        charge: chA1,
        payment_intent: piA1,
        status: 'needs_response',
        reason: 'fraudulent',
        created: nowSeconds - 550,
        evidence_details: { due_by: nowSeconds + 86400 },
        is_charge_refundable: false,
      };

      const ownedExtraPage7 = {
        id: `dp_owned_650_${runId}`,
        amount: 3500,
        currency: 'usd',
        charge: chA2,
        payment_intent: piA2,
        status: 'under_review',
        reason: 'product_not_received',
        created: nowSeconds - 650,
        evidence_details: { due_by: null },
        is_charge_refundable: true,
      };

      let pageNumber = 0;
      const listSpy = vi.spyOn(stripe.disputes, 'list').mockImplementation(async () => {
        pageNumber += 1;
        const start = (pageNumber - 1) * 100;
        const items = Array.from({ length: 100 }, (_, i) => {
          const globalIndex = start + i + 1;
          if (globalIndex === 550) return ownedAfter500;
          if (globalIndex === 650) return ownedExtraPage7;
          return makeUnownedDispute(globalIndex);
        });
        return {
          object: 'list',
          data: items as any,
          has_more: pageNumber < 8,
        } as any;
      });

      const res = await request(app)
        .get('/api/organizer/finance/disputes?limit=1')
        .set('Authorization', `Bearer ${organizerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.disputes.map((d: any) => d.id)).toEqual([ownedAfter500.id]);
      expect(listSpy).toHaveBeenCalledTimes(6);
      for (const [callParams] of listSpy.mock.calls) {
        expect(callParams).toMatchObject({ limit: 100 });
      }
      expect(listSpy).toHaveBeenNthCalledWith(1, { limit: 100 });
      expect(listSpy).toHaveBeenNthCalledWith(6, {
        limit: 100,
        starting_after: `dp_unowned_500_${runId}`,
      });
    });

    it('enforces the 1,000-dispute scan ceiling across 10 pages of 100', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const ownedAt1000 = {
        id: `dp_owned_1000_${runId}`,
        amount: 2394,
        currency: 'usd',
        charge: chA1,
        payment_intent: piA1,
        status: 'needs_response',
        reason: 'fraudulent',
        created: nowSeconds - 1000,
        evidence_details: { due_by: null },
        is_charge_refundable: false,
      };
      const ownedAt1001 = {
        id: `dp_owned_1001_${runId}`,
        amount: 3500,
        currency: 'usd',
        charge: chA2,
        payment_intent: piA2,
        status: 'under_review',
        reason: 'general',
        created: nowSeconds - 1001,
        evidence_details: { due_by: null },
        is_charge_refundable: false,
      };

      let pageNumber = 0;
      const listSpy = vi.spyOn(stripe.disputes, 'list').mockImplementation(async () => {
        pageNumber += 1;
        const start = (pageNumber - 1) * 100;
        const items = Array.from({ length: 100 }, (_, i) => {
          const globalIndex = start + i + 1;
          if (globalIndex === 1000) return ownedAt1000;
          if (globalIndex === 1001) return ownedAt1001;
          return {
            id: `dp_cap_${globalIndex}_${runId}`,
            amount: 1000,
            currency: 'usd',
            charge: `ch_cap_${globalIndex}_${runId}`,
            payment_intent: `pi_cap_${globalIndex}_${runId}`,
            status: 'needs_response',
            reason: 'general',
            created: nowSeconds - globalIndex,
            evidence_details: { due_by: null },
            is_charge_refundable: false,
          };
        });
        return {
          object: 'list',
          data: items as any,
          has_more: true,
        } as any;
      });

      const res = await request(app)
        .get('/api/organizer/finance/disputes?limit=10')
        .set('Authorization', `Bearer ${organizerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.disputes.map((d: any) => d.id)).toEqual([ownedAt1000.id]);
      expect(listSpy).toHaveBeenCalledTimes(10);
      for (const [callParams] of listSpy.mock.calls) {
        expect(callParams).toMatchObject({ limit: 100 });
      }
      expect(listSpy).toHaveBeenNthCalledWith(10, {
        limit: 100,
        starting_after: `dp_cap_900_${runId}`,
      });
    });
  });

  describe('3. Cross-Organizer Isolation & Team Permission Financial Boundaries', () => {
    it('prevents Organizer B from accessing Organizer A ledger entries even when passing Organizer A eventId', async () => {
      const ledgerRes = await request(app)
        .get(`/api/organizer/finance/ledger?eventId=${eventAId}`)
        .set('Authorization', `Bearer ${organizerBToken}`);

      expect(ledgerRes.status).toBe(200);
      expect(ledgerRes.body.data.entries).toEqual([]);
      expect(ledgerRes.body.data.total).toBe(0);
    });

    it('keeps Event Team Admin blocked from organizer Connect/payout/withdrawal/ledger endpoints while preserving event-scoped order read visibility', async () => {
      const [balRes, withdrawRes, scheduleRes, payoutDetailsRes, ordersRes] = await Promise.all([
        request(app).get('/api/organizer/finance/balance').set('Authorization', `Bearer ${teamAdminAttendeeToken}`),
        request(app).post('/api/organizer/finance/withdraw').set('Authorization', `Bearer ${teamAdminAttendeeToken}`).send({ amountInCents: 1000 }),
        request(app).patch('/api/organizer/finance/payout-schedule').set('Authorization', `Bearer ${teamAdminAttendeeToken}`).send({ interval: 'manual' }),
        request(app).get('/api/organizer/payout-details').set('Authorization', `Bearer ${teamAdminAttendeeToken}`),
        request(app).get(`/api/organizer/orders?eventId=${eventAId}`).set('Authorization', `Bearer ${teamAdminAttendeeToken}`),
      ]);

      expect(balRes.status).toBe(403);
      expect(withdrawRes.status).toBe(403);
      expect(scheduleRes.status).toBe(403);
      expect(payoutDetailsRes.status).toBe(403);

      expect(ordersRes.status).toBe(200);
      expect(ordersRes.body.data.orders.length).toBeGreaterThanOrEqual(1);
      // Event Admin does not see Stripe paymentReference
      expect(ordersRes.body.data.orders[0].paymentReference).toBeUndefined();
    });
  });
});
