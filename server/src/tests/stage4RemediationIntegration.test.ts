import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  AccountStatus,
  EventStatus,
  EventStaffStatus,
  EventTeamRole,
  OrderStatus,
  Role,
  TeamInvitationStatus,
  TeamMemberStatus,
  TicketStatus,
  TicketTierStatus,
} from '@prisma/client';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import {
  createSession,
  invalidateUserAuthCache,
  resolveUserAuthWithCache,
} from '../lib/session.service.js';
import { getRedisClient } from '../lib/redis.js';
import {
  sentLoginOtpEmails,
  sentTeamInvitationEmails,
  sentVerificationEmails,
} from '../lib/email.service.js';
import { ensureOrganizerWorkspaceForUser } from '../modules/organizer/organizer.controller.js';

describe('Authentication Stage 4 Remediation: Real Express + PostgreSQL Security & Concurrency Suite (S4R-01, S4R-02, S4R-03, S4R-05)', () => {
  const runId = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const createdUserIds: string[] = [];
  const createdEventIds: string[] = [];
  let passwordHashSample: string;

  let ownerUser: any;
  let ownerAuth: { cookie: string; csrf: string };
  let primaryEvent: any;

  async function issueSessionAuth(userId: string) {
    const session = await createSession({
      userId,
      ipAddress: '127.0.0.1',
      userAgent: 'Stage4RemediationVitest',
    });
    return {
      cookie: `__Host-outside_sid=${session.rawCookieValue}`,
      csrf: session.csrfToken,
      sessionId: session.sessionId,
    };
  }

  function extractCookieAndCsrf(res: request.Response) {
    const setCookies = (res.headers['set-cookie'] as unknown as string[]) || [];
    const sessionCookie = setCookies
      .map((c) => c.split(';')[0])
      .find((pair) => pair.startsWith('__Host-outside_sid='));
    return {
      cookie: sessionCookie || '',
      csrf: res.body?.data?.csrfToken || (res.headers['x-csrf-token'] as string) || '',
    };
  }

  async function createInvitationDirect(params: {
    eventId: string;
    email: string;
    role: EventTeamRole;
    invitedByUserId: string;
    status?: TeamInvitationStatus;
    expiresAt?: Date;
    permissions?: Record<string, boolean> | null;
  }) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const invitation = await prisma.eventTeamInvitation.create({
      data: {
        eventId: params.eventId,
        email: params.email.trim().toLowerCase(),
        role: params.role,
        permissions:
          params.role === EventTeamRole.ADMIN
            ? ((params.permissions ?? { canEditDetails: true, canManageTeam: false }) as any)
            : null,
        tokenHash,
        invitedByUserId: params.invitedByUserId,
        status: params.status ?? TeamInvitationStatus.PENDING,
        expiresAt: params.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    return { invitation, rawToken, tokenHash };
  }

  async function createEventWithTicket(params: {
    organizerId: string;
    slugSuffix: string;
    status?: EventStatus;
  }) {
    const event = await prisma.event.create({
      data: {
        organizerId: params.organizerId,
        title: `S4R Event ${params.slugSuffix}`,
        description: 'Stage 4 Remediation Integration Test Event',
        coverImageUrl: 'https://example.com/s4r-cover.jpg',
        venueName: 'Nairobi Arena',
        venueAddress: '100 Arena Way',
        city: 'Nairobi',
        country: 'Kenya',
        slug: `s4r-evt-${params.slugSuffix}-${runId}`.toLowerCase(),
        category: 'MUSIC',
        status: params.status ?? EventStatus.PUBLISHED,
        startAt: new Date(Date.now() - 3600_000),
        endAt: new Date(Date.now() + 24 * 3600_000),
        timezone: 'Africa/Nairobi',
      },
    });
    createdEventIds.push(event.id);

    const tier = await prisma.ticketTier.create({
      data: {
        eventId: event.id,
        name: 'General Admission',
        priceInCents: 2500,
        currency: 'USD',
        totalCapacity: 100,
        soldQuantity: 1,
        status: TicketTierStatus.ACTIVE,
      },
    });

    const order = await prisma.order.create({
      data: {
        orderNumber: `S4R-${params.slugSuffix.toUpperCase()}-${runId}`.slice(0, 32),
        eventId: event.id,
        customerName: 'Test Attendee',
        customerEmail: `buyer_${params.slugSuffix}_${runId}@outside.vip`,
        totalInCents: 2500,
        currency: 'USD',
        status: OrderStatus.COMPLETED,
        idempotencyKey: `s4r-ord-idem-${params.slugSuffix}-${runId}`,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    const ticket = await prisma.ticket.create({
      data: {
        orderId: order.id,
        eventId: event.id,
        ticketTierId: tier.id,
        ticketToken: `tkt_sec_s4r_${params.slugSuffix}_${crypto.randomBytes(6).toString('hex')}`,
        attendeeName: 'Test Attendee',
        attendeeEmail: order.customerEmail,
        status: TicketStatus.ISSUED,
      },
    });

    return { event, tier, order, ticket };
  }

  beforeAll(async () => {
    passwordHashSample = await bcrypt.hash('StrongPass#2026!', 10);

    ownerUser = await prisma.user.create({
      data: {
        email: `s4r_owner_${runId}@outside.vip`,
        name: 'S4R Owner',
        passwordHash: passwordHashSample,
        role: Role.ORGANIZER,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(ownerUser.id);
    ownerAuth = await issueSessionAuth(ownerUser.id);

    primaryEvent = await prisma.event.create({
      data: {
        organizerId: ownerUser.id,
        title: `S4R Primary Festival ${runId}`,
        description: 'Primary test festival for Stage 4 remediation integration tests',
        coverImageUrl: 'https://example.com/primary.jpg',
        venueName: 'Uhuru Gardens',
        venueAddress: 'Langata Rd',
        city: 'Nairobi',
        country: 'Kenya',
        slug: `s4r-primary-${runId}`,
        category: 'MUSIC',
        status: EventStatus.PUBLISHED,
        startAt: new Date(Date.now() + 86400000),
        endAt: new Date(Date.now() + 86400000 * 2),
        timezone: 'Africa/Nairobi',
      },
    });
    createdEventIds.push(primaryEvent.id);
  });

  afterAll(async () => {
    if (createdEventIds.length > 0) {
      const links = await prisma.promotionLink.findMany({
        where: { eventId: { in: createdEventIds } },
        select: { id: true },
      });
      const linkIds = links.map((l) => l.id);
      if (linkIds.length > 0) {
        await prisma.promotionLink.updateMany({
          where: { id: { in: linkIds } },
          data: { status: 'ARCHIVED' },
        });
        await prisma.promotionClick.deleteMany({ where: { promotionLinkId: { in: linkIds } } });
        await prisma.promotionVisitorDay.deleteMany({ where: { promotionLinkId: { in: linkIds } } });
        await prisma.promotionVisitorAttribution.deleteMany({ where: { promotionLinkId: { in: linkIds } } });
        await prisma.promotionSlugRegistry.deleteMany({ where: { promotionLinkId: { in: linkIds } } });
        await prisma.promotionLink.deleteMany({ where: { id: { in: linkIds } } });
      }
      await prisma.checkInLog.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.ticket.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.order.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.ticketTier.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.eventStaffInvitation.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.eventStaff.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.eventTeamInvitation.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.eventTeamMember.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.emailVerificationCode.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.organizerProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  // =========================================================================
  // 1. S4R-01: Server-Side ADMIN Invitation Password Enforcement
  // =========================================================================
  describe('1. S4R-01: Server-Side ADMIN Invitation Password Onboarding Enforcement', () => {
    it('rejects an existing passwordless account (even after authenticating via standalone OTP) from accepting an ADMIN invitation without consuming it', async () => {
      const scannerEmail = `s4r_pwless_admin_${runId}@outside.vip`;
      const pwlessUser = await prisma.user.create({
        data: {
          email: scannerEmail,
          name: 'Passwordless Scanner',
          passwordHash: null,
          role: Role.ATTENDEE,
          status: AccountStatus.ACTIVE,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(pwlessUser.id);

      const { invitation, rawToken } = await createInvitationDirect({
        eventId: primaryEvent.id,
        email: scannerEmail,
        role: EventTeamRole.ADMIN,
        invitedByUserId: ownerUser.id,
      });

      // Step 1: Authenticate via standalone OTP (simulating /scanner or /login?mode=otp bypass)
      sentLoginOtpEmails.length = 0;
      await request(app)
        .post('/api/auth/otp/request')
        .send({ email: scannerEmail })
        .expect(200);

      const otpEntry = sentLoginOtpEmails.find((e) => e.to === scannerEmail);
      expect(otpEntry).toBeDefined();

      const verifyRes = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: scannerEmail, code: otpEntry!.code })
        .expect(200);

      const otpAuth = extractCookieAndCsrf(verifyRes);
      expect(otpAuth.cookie).toContain('__Host-outside_sid=');
      expect(otpAuth.csrf).toBeTruthy();

      // Step 2: Attempt to accept ADMIN invitation directly via HTTP API
      const acceptRes = await request(app)
        .post(`/api/team/invitations/${rawToken}/accept`)
        .set('Cookie', otpAuth.cookie)
        .set('x-csrf-token', otpAuth.csrf)
        .expect(403);

      expect(acceptRes.body?.error?.code).toBe('ADMIN_PASSWORD_REQUIRED');
      expect(acceptRes.body?.error?.message).toMatch(/password-protected account/i);

      // Invitation must remain PENDING (never consumed) and zero EventTeamMember created
      const invAfter = await prisma.eventTeamInvitation.findUnique({ where: { id: invitation.id } });
      expect(invAfter?.status).toBe(TeamInvitationStatus.PENDING);

      const memberAfter = await prisma.eventTeamMember.findUnique({
        where: { eventId_userId: { eventId: primaryEvent.id, userId: pwlessUser.id } },
      });
      expect(memberAfter).toBeNull();
    });

    it('allows the same existing passwordless account to accept a HOST invitation via OTP without creating a duplicate User account', async () => {
      const hostEmail = `s4r_pwless_host_${runId}@outside.vip`;
      const pwlessUser = await prisma.user.create({
        data: {
          email: hostEmail,
          name: 'Scanner Turned Host',
          passwordHash: null,
          role: Role.ATTENDEE,
          status: AccountStatus.ACTIVE,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(pwlessUser.id);

      const { rawToken } = await createInvitationDirect({
        eventId: primaryEvent.id,
        email: hostEmail,
        role: EventTeamRole.HOST,
        invitedByUserId: ownerUser.id,
      });

      sentLoginOtpEmails.length = 0;
      await request(app).post('/api/auth/otp/request').send({ email: hostEmail }).expect(200);
      const otpEntry = sentLoginOtpEmails.find((e) => e.to === hostEmail);
      expect(otpEntry).toBeDefined();

      const verifyRes = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: hostEmail, code: otpEntry!.code })
        .expect(200);
      const otpAuth = extractCookieAndCsrf(verifyRes);

      const acceptRes = await request(app)
        .post(`/api/team/invitations/${rawToken}/accept`)
        .set('Cookie', otpAuth.cookie)
        .set('x-csrf-token', otpAuth.csrf)
        .expect(200);

      expect(acceptRes.body.success).toBe(true);
      expect(acceptRes.body.membership.role).toBe('HOST');
      expect(acceptRes.body.membership.hostLink?.slug).toBeTruthy();

      // Confirm zero duplicate users were created
      const usersWithEmail = await prisma.user.findMany({ where: { email: hostEmail } });
      expect(usersWithEmail).toHaveLength(1);
      expect(usersWithEmail[0].id).toBe(pwlessUser.id);
    });

    it('allows an existing password-based account to accept an ADMIN invitation', async () => {
      const existingAdminEmail = `s4r_pw_admin_${runId}@outside.vip`;
      const pwUser = await prisma.user.create({
        data: {
          email: existingAdminEmail,
          name: 'Existing Password Admin',
          passwordHash: passwordHashSample,
          role: Role.ATTENDEE,
          status: AccountStatus.ACTIVE,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(pwUser.id);

      const { rawToken } = await createInvitationDirect({
        eventId: primaryEvent.id,
        email: existingAdminEmail,
        role: EventTeamRole.ADMIN,
        invitedByUserId: ownerUser.id,
      });

      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: existingAdminEmail, password: 'StrongPass#2026!' })
        .expect(200);
      const auth = extractCookieAndCsrf(loginRes);

      const acceptRes = await request(app)
        .post(`/api/team/invitations/${rawToken}/accept`)
        .set('Cookie', auth.cookie)
        .set('x-csrf-token', auth.csrf)
        .expect(200);

      expect(acceptRes.body.success).toBe(true);
      expect(acceptRes.body.membership.role).toBe('ADMIN');
    });

    it('allows a new ADMIN invitee to complete password registration, verify email, and accept the ADMIN invitation', async () => {
      const newAdminEmail = `s4r_new_admin_${runId}@outside.vip`;
      const { rawToken } = await createInvitationDirect({
        eventId: primaryEvent.id,
        email: newAdminEmail,
        role: EventTeamRole.ADMIN,
        invitedByUserId: ownerUser.id,
      });

      sentVerificationEmails.length = 0;
      const regRes = await request(app)
        .post('/api/auth/register')
        .send({
          name: 'New Event Admin',
          email: newAdminEmail,
          password: 'NewAdminPass#2026!',
        })
        .expect(201);

      const newUserId = regRes.body.data.user.id;
      createdUserIds.push(newUserId);
      const regAuth = extractCookieAndCsrf(regRes);

      const verificationEmail = sentVerificationEmails.find((e) => e.to === newAdminEmail);
      expect(verificationEmail).toBeDefined();

      const verifyRes = await request(app)
        .post('/api/auth/verify-email')
        .set('Cookie', regAuth.cookie)
        .set('x-csrf-token', regAuth.csrf)
        .send({ code: verificationEmail!.code })
        .expect(200);

      const verifiedAuth = extractCookieAndCsrf(verifyRes);

      const acceptRes = await request(app)
        .post(`/api/team/invitations/${rawToken}/accept`)
        .set('Cookie', verifiedAuth.cookie)
        .set('x-csrf-token', verifiedAuth.csrf)
        .expect(200);

      expect(acceptRes.body.success).toBe(true);
      expect(acceptRes.body.membership.role).toBe('ADMIN');
    });
  });

  // =========================================================================
  // 2. S4R-02 & S4R-05: Real PostgreSQL Concurrency & Warm-Cache Fresh Verification
  // =========================================================================
  describe('2. S4R-02 & S4R-05: Real PostgreSQL Concurrency & Fresh Verification', () => {
    it('rejects a SUSPENDED database user on POST /api/team/invitations/:token/accept even when Redis auth cache is warm with ACTIVE status', async () => {
      const suspEmail = `s4r_warm_susp_${runId}@outside.vip`;
      const suspUser = await prisma.user.create({
        data: {
          email: suspEmail,
          name: 'Soon Suspended Host',
          passwordHash: passwordHashSample,
          role: Role.ATTENDEE,
          status: AccountStatus.ACTIVE,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(suspUser.id);

      const auth = await issueSessionAuth(suspUser.id);
      // Warm Redis user auth cache with ACTIVE state via real HTTP /api/auth/me
      await request(app).get('/api/auth/me').set('Cookie', auth.cookie).expect(200);

      const { invitation, rawToken } = await createInvitationDirect({
        eventId: primaryEvent.id,
        email: suspEmail,
        role: EventTeamRole.HOST,
        invitedByUserId: ownerUser.id,
      });

      // Suspend directly in PostgreSQL WITHOUT invalidating Redis cache
      await prisma.user.update({
        where: { id: suspUser.id },
        data: { status: AccountStatus.SUSPENDED },
      });

      const acceptRes = await request(app)
        .post(`/api/team/invitations/${rawToken}/accept`)
        .set('Cookie', auth.cookie)
        .set('x-csrf-token', auth.csrf)
        .expect(403);

      expect(acceptRes.body?.error?.code).toBe('ACCOUNT_SUSPENDED');

      const invAfter = await prisma.eventTeamInvitation.findUnique({ where: { id: invitation.id } });
      expect(invAfter?.status).toBe(TeamInvitationStatus.PENDING);

      const memAfter = await prisma.eventTeamMember.findUnique({
        where: { eventId_userId: { eventId: primaryEvent.id, userId: suspUser.id } },
      });
      expect(memAfter).toBeNull();
    });

    it('handles two simultaneous accept requests in real PostgreSQL: exactly one 200 and one 409 with a single membership & promotion link', async () => {
      const email = `s4r_double_acc_${runId}@outside.vip`;
      const user = await prisma.user.create({
        data: {
          email,
          name: 'Double Accept Host',
          passwordHash: passwordHashSample,
          role: Role.ATTENDEE,
          status: AccountStatus.ACTIVE,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(user.id);
      const auth = await issueSessionAuth(user.id);

      const { invitation, rawToken } = await createInvitationDirect({
        eventId: primaryEvent.id,
        email,
        role: EventTeamRole.HOST,
        invitedByUserId: ownerUser.id,
      });

      const [resA, resB] = await Promise.all([
        request(app)
          .post(`/api/team/invitations/${rawToken}/accept`)
          .set('Cookie', auth.cookie)
          .set('x-csrf-token', auth.csrf),
        request(app)
          .post(`/api/team/invitations/${rawToken}/accept`)
          .set('Cookie', auth.cookie)
          .set('x-csrf-token', auth.csrf),
      ]);

      const statuses = [resA.status, resB.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      const loser = resA.status === 409 ? resA : resB;
      expect(loser.body?.error?.code).toBe('INVITATION_ALREADY_ACCEPTED');

      const finalInv = await prisma.eventTeamInvitation.findUnique({ where: { id: invitation.id } });
      expect(finalInv?.status).toBe(TeamInvitationStatus.ACCEPTED);

      const members = await prisma.eventTeamMember.findMany({
        where: { eventId: primaryEvent.id, userId: user.id },
      });
      expect(members).toHaveLength(1);
      expect(members[0].status).toBe(TeamMemberStatus.ACTIVE);

      const links = await prisma.promotionLink.findMany({
        where: { eventId: primaryEvent.id, hostMemberId: members[0].id },
      });
      expect(links).toHaveLength(1);
    });

    it('handles concurrent accept + revoke in real PostgreSQL across multiple rounds with strict status/membership consistency', async () => {
      for (let round = 0; round < 3; round++) {
        const email = `s4r_acc_rev_${round}_${runId}@outside.vip`;
        const user = await prisma.user.create({
          data: {
            email,
            name: `Race Host ${round}`,
            passwordHash: passwordHashSample,
            role: Role.ATTENDEE,
            status: AccountStatus.ACTIVE,
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        });
        createdUserIds.push(user.id);
        const userAuth = await issueSessionAuth(user.id);

        const { invitation, rawToken } = await createInvitationDirect({
          eventId: primaryEvent.id,
          email,
          role: EventTeamRole.HOST,
          invitedByUserId: ownerUser.id,
        });

        const [acceptRes, revokeRes] = await Promise.all([
          request(app)
            .post(`/api/team/invitations/${rawToken}/accept`)
            .set('Cookie', userAuth.cookie)
            .set('x-csrf-token', userAuth.csrf),
          request(app)
            .delete(`/api/events/${primaryEvent.id}/team/invitations/${invitation.id}`)
            .set('Cookie', ownerAuth.cookie)
            .set('x-csrf-token', ownerAuth.csrf),
        ]);

        const finalInv = await prisma.eventTeamInvitation.findUnique({ where: { id: invitation.id } });
        const finalMember = await prisma.eventTeamMember.findUnique({
          where: { eventId_userId: { eventId: primaryEvent.id, userId: user.id } },
        });

        // Exactly one operation must succeed; never both 200!
        expect(acceptRes.status === 200 && revokeRes.status === 200).toBe(false);
        expect(acceptRes.status === 200 || revokeRes.status === 200).toBe(true);

        if (acceptRes.status === 200) {
          // Accept won: revoke MUST fail with 409, status MUST remain ACCEPTED (never overwritten to REVOKED!)
          expect(revokeRes.status).toBe(409);
          expect(revokeRes.body?.error?.code).toBe('INVITATION_ALREADY_ACCEPTED');
          expect(finalInv?.status).toBe(TeamInvitationStatus.ACCEPTED);
          expect(finalMember?.status).toBe(TeamMemberStatus.ACTIVE);
        } else {
          // Revoke won: accept MUST fail with 403, status MUST be REVOKED, zero EventTeamMember created
          expect(revokeRes.status).toBe(200);
          expect(acceptRes.status).toBe(403);
          expect(finalInv?.status).toBe(TeamInvitationStatus.REVOKED);
          expect(finalMember).toBeNull();
        }
      }
    });

    it('handles concurrent accept + resend in real PostgreSQL without rotating an accepted invitation or honoring a superseded token', async () => {
      const email = `s4r_acc_res_${runId}@outside.vip`;
      const user = await prisma.user.create({
        data: {
          email,
          name: 'Resend Race Host',
          passwordHash: passwordHashSample,
          role: Role.ATTENDEE,
          status: AccountStatus.ACTIVE,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(user.id);
      const userAuth = await issueSessionAuth(user.id);

      const { invitation, rawToken, tokenHash: originalHash } = await createInvitationDirect({
        eventId: primaryEvent.id,
        email,
        role: EventTeamRole.HOST,
        invitedByUserId: ownerUser.id,
      });

      sentTeamInvitationEmails.length = 0;

      const [acceptRes, resendRes] = await Promise.all([
        request(app)
          .post(`/api/team/invitations/${rawToken}/accept`)
          .set('Cookie', userAuth.cookie)
          .set('x-csrf-token', userAuth.csrf),
        request(app)
          .post(`/api/events/${primaryEvent.id}/team/invitations/${invitation.id}/resend`)
          .set('Cookie', ownerAuth.cookie)
          .set('x-csrf-token', ownerAuth.csrf),
      ]);

      const finalInv = await prisma.eventTeamInvitation.findUnique({ where: { id: invitation.id } });
      const finalMember = await prisma.eventTeamMember.findUnique({
        where: { eventId_userId: { eventId: primaryEvent.id, userId: user.id } },
      });

      // Never both 200
      expect(acceptRes.status === 200 && resendRes.status === 200).toBe(false);
      expect(acceptRes.status === 200 || resendRes.status === 200).toBe(true);

      if (acceptRes.status === 200) {
        // Accept won: resend rejected with 409, tokenHash unchanged, invitation remains ACCEPTED
        expect(resendRes.status).toBe(409);
        expect(resendRes.body?.error?.code).toBe('INVITATION_ALREADY_ACCEPTED');
        expect(finalInv?.status).toBe(TeamInvitationStatus.ACCEPTED);
        expect(finalInv?.tokenHash).toBe(originalHash);
        expect(finalMember?.status).toBe(TeamMemberStatus.ACTIVE);
      } else {
        // Resend won: old token acceptance MUST be rejected (403/404) with zero membership created
        expect(resendRes.status).toBe(200);
        expect([403, 404]).toContain(acceptRes.status);
        expect(finalInv?.status).toBe(TeamInvitationStatus.PENDING);
        expect(finalInv?.tokenHash).not.toBe(originalHash);
        expect(finalMember).toBeNull();
      }
    });

    it('handles concurrent revoke + resend in real PostgreSQL safely and prevents revoked invitation reuse', async () => {
      const email = `s4r_rev_res_${runId}@outside.vip`;
      const user = await prisma.user.create({
        data: {
          email,
          name: 'Revoke Resend Host',
          passwordHash: passwordHashSample,
          role: Role.ATTENDEE,
          status: AccountStatus.ACTIVE,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(user.id);
      const userAuth = await issueSessionAuth(user.id);

      const { invitation, rawToken } = await createInvitationDirect({
        eventId: primaryEvent.id,
        email,
        role: EventTeamRole.HOST,
        invitedByUserId: ownerUser.id,
      });

      const [revokeRes, resendRes] = await Promise.all([
        request(app)
          .delete(`/api/events/${primaryEvent.id}/team/invitations/${invitation.id}`)
          .set('Cookie', ownerAuth.cookie)
          .set('x-csrf-token', ownerAuth.csrf),
        request(app)
          .post(`/api/events/${primaryEvent.id}/team/invitations/${invitation.id}/resend`)
          .set('Cookie', ownerAuth.cookie)
          .set('x-csrf-token', ownerAuth.csrf),
      ]);

      // Revoke always succeeds (either first, causing resend to 409, or right after resend rotates token)
      expect(revokeRes.status).toBe(200);
      expect([200, 409]).toContain(resendRes.status);

      const finalInv = await prisma.eventTeamInvitation.findUnique({ where: { id: invitation.id } });
      expect(finalInv?.status).toBe(TeamInvitationStatus.REVOKED);

      // Neither original token nor any resent token may be accepted once REVOKED
      const tryOld = await request(app)
        .post(`/api/team/invitations/${rawToken}/accept`)
        .set('Cookie', userAuth.cookie)
        .set('x-csrf-token', userAuth.csrf);
      expect([403, 404]).toContain(tryOld.status);

      const mem = await prisma.eventTeamMember.findUnique({
        where: { eventId_userId: { eventId: primaryEvent.id, userId: user.id } },
      });
      expect(mem).toBeNull();
    });

    it('rejects reuse of ACCEPTED invitations with 409 INVITATION_ALREADY_ACCEPTED even after expiresAt passes, and rejects REVOKED invitations with 403', async () => {
      const email = `s4r_reuse_${runId}@outside.vip`;
      const user = await prisma.user.create({
        data: {
          email,
          name: 'Reuse Host',
          passwordHash: passwordHashSample,
          role: Role.ATTENDEE,
          status: AccountStatus.ACTIVE,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(user.id);
      const auth = await issueSessionAuth(user.id);

      const past = new Date(Date.now() - 48 * 3600_000);
      const { rawToken: acceptedToken } = await createInvitationDirect({
        eventId: primaryEvent.id,
        email,
        role: EventTeamRole.HOST,
        invitedByUserId: ownerUser.id,
        status: TeamInvitationStatus.ACCEPTED,
        expiresAt: past,
      });

      const getAcc = await request(app).get(`/api/team/invitations/${acceptedToken}`).expect(409);
      expect(getAcc.body?.error?.code).toBe('INVITATION_ALREADY_ACCEPTED');

      const postAcc = await request(app)
        .post(`/api/team/invitations/${acceptedToken}/accept`)
        .set('Cookie', auth.cookie)
        .set('x-csrf-token', auth.csrf)
        .expect(409);
      expect(postAcc.body?.error?.code).toBe('INVITATION_ALREADY_ACCEPTED');

      const { rawToken: revokedToken } = await createInvitationDirect({
        eventId: primaryEvent.id,
        email,
        role: EventTeamRole.HOST,
        invitedByUserId: ownerUser.id,
        status: TeamInvitationStatus.REVOKED,
      });

      await request(app).get(`/api/team/invitations/${revokedToken}`).expect(403);
      await request(app)
        .post(`/api/team/invitations/${revokedToken}/accept`)
        .set('Cookie', auth.cookie)
        .set('x-csrf-token', auth.csrf)
        .expect(403);
    });
  });

  // =========================================================================
  // 3. S4R-03: Scanner Gates & Check-In Ownership Alignment (Global-Role Independent)
  // =========================================================================
  describe('3. S4R-03: Owned-Event Scanner Gate & Check-In Authorization Alignment', () => {
    it('allows an event owner with global role ATTENDEE (and stale cached ATTENDEE role) to list their gate, check in a ticket, and replay idempotently', async () => {
      const attendeeOwner = await prisma.user.create({
        data: {
          email: `s4r_att_owner_${runId}@outside.vip`,
          name: 'Attendee Role Owner',
          passwordHash: passwordHashSample,
          role: Role.ATTENDEE,
          status: AccountStatus.ACTIVE,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(attendeeOwner.id);
      const auth = await issueSessionAuth(attendeeOwner.id);

      // Explicitly populate Redis auth cache with ATTENDEE role via real HTTP /api/auth/me
      await request(app).get('/api/auth/me').set('Cookie', auth.cookie).expect(200);

      const { event, ticket } = await createEventWithTicket({
        organizerId: attendeeOwner.id,
        slugSuffix: 'att-owner',
      });

      // 1. GET /api/scanner/gates includes owned PUBLISHED event
      const gatesRes = await request(app)
        .get('/api/scanner/gates')
        .set('Cookie', auth.cookie)
        .expect(200);

      expect(gatesRes.body.data.events).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: event.id, role: 'ORGANIZER' })])
      );

      // 2. POST /api/scanner/check-in succeeds with idempotency key despite ATTENDEE global role
      const idemKey = `s4r-owner-idem-${runId}`;
      const checkInRes = await request(app)
        .post('/api/scanner/check-in')
        .set('Cookie', auth.cookie)
        .set('x-csrf-token', auth.csrf)
        .set('Idempotency-Key', idemKey)
        .send({ token: ticket.ticketToken, eventId: event.slug })
        .expect(200);

      expect(checkInRes.body.success).toBe(true);
      expect(checkInRes.body.data.result).toBe('SUCCESS');

      // 3. Replaying the exact same idempotency key with global role still ATTENDEE succeeds
      const replayRes = await request(app)
        .post('/api/scanner/check-in')
        .set('Cookie', auth.cookie)
        .set('x-csrf-token', auth.csrf)
        .set('Idempotency-Key', idemKey)
        .send({ token: ticket.ticketToken, eventId: event.slug })
        .expect(200);

      expect(replayRes.body.success).toBe(true);
      expect(replayRes.body.data.result).toBe('SUCCESS');
    });

    it('allows an active EventStaff member to check in, rejects unauthorized Hosts and Event Admins, and rejects revoked staff idempotency replay', async () => {
      const { event, ticket } = await createEventWithTicket({
        organizerId: ownerUser.id,
        slugSuffix: 'staff-vs-team',
      });

      // Create active EventStaff, active Event HOST, and active Event ADMIN
      const staffUser = await prisma.user.create({
        data: {
          email: `s4r_staff_${runId}@outside.vip`,
          name: 'Active Gate Staff',
          passwordHash: null,
          role: Role.ATTENDEE,
          status: AccountStatus.ACTIVE,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      const hostOnlyUser = await prisma.user.create({
        data: {
          email: `s4r_host_noscan_${runId}@outside.vip`,
          name: 'Host No Scan',
          passwordHash: null,
          role: Role.ATTENDEE,
          status: AccountStatus.ACTIVE,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      const adminOnlyUser = await prisma.user.create({
        data: {
          email: `s4r_admin_noscan_${runId}@outside.vip`,
          name: 'Event Admin No Scan',
          passwordHash: passwordHashSample,
          role: Role.ATTENDEE,
          status: AccountStatus.ACTIVE,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(staffUser.id, hostOnlyUser.id, adminOnlyUser.id);

      await prisma.eventStaff.create({
        data: {
          eventId: event.id,
          userId: staffUser.id,
          email: staffUser.email,
          status: EventStaffStatus.ACTIVE,
          assignedByUserId: ownerUser.id,
        },
      });
      await prisma.eventTeamMember.createMany({
        data: [
          {
            eventId: event.id,
            userId: hostOnlyUser.id,
            role: EventTeamRole.HOST,
            status: TeamMemberStatus.ACTIVE,
            invitedById: ownerUser.id,
          },
          {
            eventId: event.id,
            userId: adminOnlyUser.id,
            role: EventTeamRole.ADMIN,
            status: TeamMemberStatus.ACTIVE,
            permissions: { canEditDetails: true, canManageTeam: true, canViewOrders: true },
            invitedById: ownerUser.id,
          },
        ],
      });

      const [staffAuth, hostAuth, eventAdminAuth] = await Promise.all([
        issueSessionAuth(staffUser.id),
        issueSessionAuth(hostOnlyUser.id),
        issueSessionAuth(adminOnlyUser.id),
      ]);

      // Host must get 0 gates and 403 on check-in
      const hostGates = await request(app).get('/api/scanner/gates').set('Cookie', hostAuth.cookie).expect(200);
      expect(hostGates.body.data.events).toEqual([]);
      await request(app)
        .post('/api/scanner/check-in')
        .set('Cookie', hostAuth.cookie)
        .set('x-csrf-token', hostAuth.csrf)
        .send({ token: ticket.ticketToken, eventId: event.slug })
        .expect(403);

      // Event Admin (without EventStaff) must get 0 gates and 403 on check-in
      const adminGates = await request(app).get('/api/scanner/gates').set('Cookie', eventAdminAuth.cookie).expect(200);
      expect(adminGates.body.data.events).toEqual([]);
      await request(app)
        .post('/api/scanner/check-in')
        .set('Cookie', eventAdminAuth.cookie)
        .set('x-csrf-token', eventAdminAuth.csrf)
        .send({ token: ticket.ticketToken, eventId: event.slug })
        .expect(403);

      // Active EventStaff succeeds on check-in with idempotency key
      const staffIdemKey = `s4r-staff-idem-${runId}`;
      const staffScan = await request(app)
        .post('/api/scanner/check-in')
        .set('Cookie', staffAuth.cookie)
        .set('x-csrf-token', staffAuth.csrf)
        .set('Idempotency-Key', staffIdemKey)
        .send({ token: ticket.ticketToken, eventId: event.slug })
        .expect(200);
      expect(staffScan.body.data.result).toBe('SUCCESS');

      // Revoke EventStaff assignment and verify F-07 idempotency replay is rejected (403)
      await prisma.eventStaff.update({
        where: { eventId_userId: { eventId: event.id, userId: staffUser.id } },
        data: { status: EventStaffStatus.REVOKED },
      });

      await request(app)
        .post('/api/scanner/check-in')
        .set('Cookie', staffAuth.cookie)
        .set('x-csrf-token', staffAuth.csrf)
        .set('Idempotency-Key', staffIdemKey)
        .send({ token: ticket.ticketToken, eventId: event.slug })
        .expect(403);
    });

    it('logs a structured warning when invalidateUserAuthCache fails during ATTENDEE->ORGANIZER promotion without crashing workspace creation', async () => {
      const promoUser = await prisma.user.create({
        data: {
          email: `s4r_cache_warn_${runId}@outside.vip`,
          name: 'Cache Warn Organizer',
          passwordHash: passwordHashSample,
          role: Role.ATTENDEE,
          status: AccountStatus.ACTIVE,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(promoUser.id);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const redis = getRedisClient();
      const invSpy = vi
        .spyOn(redis, 'invalidateUserCacheAtomically')
        .mockRejectedValue(new Error('Simulated Redis outage'));

      try {
        const profile = await ensureOrganizerWorkspaceForUser(promoUser.id, `Warn Org ${runId}`);
        expect(profile).not.toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(
          '[Organizer] Failed to invalidate user auth cache after role promotion',
          expect.objectContaining({
            userId: promoUser.id,
            context: 'ensureOrganizerWorkspaceForUser',
          })
        );
      } finally {
        invSpy.mockRestore();
        warnSpy.mockRestore();
      }

      // Clean cache state and confirm DB role promoted
      await invalidateUserAuthCache(promoUser.id).catch(() => {});
      const updated = await prisma.user.findUnique({ where: { id: promoUser.id } });
      expect(updated?.role).toBe(Role.ORGANIZER);

      // Verify fresh DB resolution reflects ORGANIZER
      const resolved = await resolveUserAuthWithCache(
        promoUser.id,
        async (id) => {
          const u = await prisma.user.findUnique({ where: { id } });
          if (!u) return null;
          return {
            userId: u.id,
            email: u.email,
            role: u.role,
            emailVerified: u.emailVerified,
            accountStatus: u.status,
          };
        },
        { forceFreshDb: true }
      );
      expect(resolved.user?.role).toBe(Role.ORGANIZER);
    });
  });
});
