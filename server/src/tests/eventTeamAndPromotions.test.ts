import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { EventTeamRole, TeamMemberStatus, TeamInvitationStatus } from '@prisma/client';
import {
  VISITOR_COOKIE_NAME,
  TEAM_INVITE_CREATE_ACTOR_MAX_PER_HOUR,
  TEAM_INVITE_CREATE_EVENT_MAX_PER_HOUR,
  TEAM_INVITE_RESEND_ACTOR_MAX_PER_HOUR,
  TEAM_INVITE_RESEND_EVENT_MAX_PER_HOUR,
  TEAM_INVITE_INSPECT_IP_BURST_MAX,
  TEAM_INVITE_INSPECT_IP_SUSTAINED_MAX,
  MAX_HISTORICAL_SLUG_ALIASES_PER_LINK,
} from '../modules/promotions/promotions.constants.js';
import { deriveCanonicalVisitorId } from '../modules/promotions/promotions.service.js';
import { getRedisClient } from '../lib/redis.js';
import { createSession, hashRateLimitIdentifier } from '../lib/session.service.js';
import { sentTeamInvitationEmails } from '../lib/email.service.js';

describe('Event Teams, Invitations & Host Promotional Tools (Stage 2)', () => {
  const testRunId = Date.now();
  const createdUserIds: string[] = [];
  const createdEventIds: string[] = [];

  let organizerUser: any;
  let organizerAuth: { cookie: string; csrf: string };

  let adminUser: any;
  let adminAuth: { cookie: string; csrf: string };

  let hostUser: any;
  let hostAuth: { cookie: string; csrf: string };

  let unverifiedUser: any;
  let unverifiedAuth: { cookie: string; csrf: string };

  let outsiderUser: any;
  let outsiderAuth: { cookie: string; csrf: string };

  let event1: any;
  let event2: any;

  async function createAuth(userId: string) {
    const session = await createSession({ userId, ipAddress: '127.0.0.1', userAgent: 'Vitest' });
    return {
      cookie: `__Host-outside_sid=${session.rawCookieValue}`,
      csrf: session.csrfToken,
    };
  }

  beforeAll(async () => {
    // 1. Create Organizer User
    organizerUser = await prisma.user.create({
      data: {
        email: `organizer_s2_${testRunId}@outside.vip`,
        name: 'Stage 2 Organizer',
        role: 'ORGANIZER',
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(organizerUser.id);
    organizerAuth = await createAuth(organizerUser.id);

    // 2. Create Event Admin User
    adminUser = await prisma.user.create({
      data: {
        email: `event_admin_${testRunId}@outside.vip`,
        name: 'Stage 2 Admin',
        role: 'ATTENDEE',
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(adminUser.id);
    adminAuth = await createAuth(adminUser.id);

    // 3. Create Event Host User
    hostUser = await prisma.user.create({
      data: {
        email: `event_host_${testRunId}@outside.vip`,
        name: 'Stage 2 Host',
        role: 'ATTENDEE',
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(hostUser.id);
    hostAuth = await createAuth(hostUser.id);

    // 4. Create Unverified User
    unverifiedUser = await prisma.user.create({
      data: {
        email: `unverified_${testRunId}@outside.vip`,
        name: 'Unverified User',
        role: 'ATTENDEE',
        emailVerified: false,
      },
    });
    createdUserIds.push(unverifiedUser.id);
    unverifiedAuth = await createAuth(unverifiedUser.id);

    // 5. Create Outsider User (no membership)
    outsiderUser = await prisma.user.create({
      data: {
        email: `outsider_${testRunId}@outside.vip`,
        name: 'Outsider User',
        role: 'ATTENDEE',
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(outsiderUser.id);
    outsiderAuth = await createAuth(outsiderUser.id);

    // 6. Create Event 1
    event1 = await prisma.event.create({
      data: {
        organizerId: organizerUser.id,
        title: `Festival Stage 2 - ${testRunId}`,
        description: 'Test Event 1 Description',
        coverImageUrl: 'https://example.com/cover1.jpg',
        venueAddress: '100 Main St',
        slug: `fest-s2-1-${testRunId}`,
        category: 'MUSIC',
        status: 'PUBLISHED',
        startAt: new Date(Date.now() + 86400000 * 5),
        endAt: new Date(Date.now() + 86400000 * 6),
        venueName: 'Grand Arena',
        city: 'Nairobi',
        country: 'KE',
      },
    });
    createdEventIds.push(event1.id);

    // 7. Create Event 2 (for multi-event isolation testing)
    event2 = await prisma.event.create({
      data: {
        organizerId: organizerUser.id,
        title: `Festival Stage 2 Event 2 - ${testRunId}`,
        description: 'Test Event 2 Description',
        coverImageUrl: 'https://example.com/cover2.jpg',
        venueAddress: '200 Beach Rd',
        slug: `fest-s2-2-${testRunId}`,
        category: 'FESTIVAL',
        status: 'PUBLISHED',
        startAt: new Date(Date.now() + 86400000 * 10),
        endAt: new Date(Date.now() + 86400000 * 11),
        venueName: 'Beachfront Lawn',
        city: 'Mombasa',
        country: 'KE',
      },
    });
    createdEventIds.push(event2.id);
  });

  afterAll(async () => {
    // Teardown created records in relational safety order
    const links = await prisma.promotionLink.findMany({
      where: { eventId: { in: createdEventIds } },
      select: { id: true },
    });
    const linkIds = links.map((l) => l.id);

    if (linkIds.length > 0) {
      await prisma.promotionClick.deleteMany({ where: { promotionLinkId: { in: linkIds } } });
      await prisma.promotionVisitorDay.deleteMany({ where: { promotionLinkId: { in: linkIds } } });
      await prisma.promotionVisitorAttribution.deleteMany({ where: { promotionLinkId: { in: linkIds } } });
      await prisma.promotionDailyAggregate.deleteMany({ where: { promotionLinkId: { in: linkIds } } });
      await prisma.promotionLink.updateMany({
        where: { id: { in: linkIds } },
        data: { status: 'ARCHIVED' },
      });
      await prisma.promotionSlugRegistry.deleteMany({ where: { promotionLinkId: { in: linkIds } } });
      await prisma.promotionLink.deleteMany({ where: { id: { in: linkIds } } });
    }

    await prisma.eventTeamInvitation.deleteMany({ where: { eventId: { in: createdEventIds } } });
    await prisma.eventTeamMember.deleteMany({ where: { eventId: { in: createdEventIds } } });

    if (createdEventIds.length > 0) {
      await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  describe('1. Event Team Management & Invitation Lifecycle', () => {
    let hostInviteToken: string;
    let hostInvitationId: string;
    let adminInviteToken: string;
    let adminInvitationId: string;

    it('organizer can invite an Event Host with email dispatch', async () => {
      const res = await request(app)
        .post(`/api/events/${event1.id}/team/invitations`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          email: hostUser.email,
          role: 'HOST',
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.invitation).toBeDefined();
      expect(res.body.invitation.email).toBe(hostUser.email.toLowerCase());
      expect(res.body.invitation.role).toBe('HOST');
      expect(res.body.invitation.token).toBeUndefined();

      hostInvitationId = res.body.invitation.id;

      // Verify email was recorded in test email service and extract token from email delivery
      const sentEmail = sentTeamInvitationEmails
        .slice()
        .reverse()
        .find((e) => e.to === hostUser.email.toLowerCase());
      expect(sentEmail).toBeDefined();
      expect(sentEmail?.role).toBe('HOST');
      hostInviteToken = sentEmail!.inviteUrl.split('/').pop()!;
      expect(hostInviteToken).toBeTruthy();
      expect(sentEmail?.inviteUrl).toContain(`/team/invitations/${hostInviteToken}`);
    });

    it('organizer can invite an Event Admin with typed, configurable permissions', async () => {
      const res = await request(app)
        .post(`/api/events/${event1.id}/team/invitations`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          email: adminUser.email,
          role: 'ADMIN',
          permissions: {
            canEditDetails: true,
            canManagePromotions: true,
            canViewAnalytics: true,
            canManageTeam: false, // Explicitly false
            canCancelEvent: false,
          },
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.invitation.role).toBe('ADMIN');
      expect(res.body.invitation.token).toBeUndefined();
      const sentEmail = sentTeamInvitationEmails
        .slice()
        .reverse()
        .find((e) => e.to === adminUser.email.toLowerCase());
      expect(sentEmail).toBeDefined();
      adminInviteToken = sentEmail!.inviteUrl.split('/').pop()!;
      adminInvitationId = res.body.invitation.id;
    });

    it('prevents duplicate pending invitations for the same email and event', async () => {
      const res = await request(app)
        .post(`/api/events/${event1.id}/team/invitations`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          email: hostUser.email,
          role: 'HOST',
        })
        .expect(409);

      expect(res.body.error.message).toContain('An active pending invitation already exists');
    });

    it('allows inspecting public invitation metadata without authentication', async () => {
      const res = await request(app)
        .get(`/api/team/invitations/${hostInviteToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.invitation.eventTitle).toBe(event1.title);
      expect(res.body.invitation.role).toBe('HOST');
      expect(res.body.invitation.emailMasked).toMatch(/\*+.*@outside\.vip/);
      expect(res.body.invitation.status).toBe('PENDING');
    });

    it('resends a pending invitation, rotating the token and extending expiration', async () => {
      const res = await request(app)
        .post(`/api/events/${event1.id}/team/invitations/${hostInvitationId}/resend`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.invitation.token).toBeUndefined();
      const resentEmail = sentTeamInvitationEmails
        .slice()
        .reverse()
        .find((e) => e.to === hostUser.email.toLowerCase());
      expect(resentEmail).toBeDefined();
      const rotatedToken = resentEmail!.inviteUrl.split('/').pop()!;
      expect(rotatedToken).not.toBe(hostInviteToken);

      // Update token to the newly rotated token
      hostInviteToken = rotatedToken;
    });

    it('rejects invitation acceptance if account email is not verified', async () => {
      // Create invitation for unverified user email
      const inv = await request(app)
        .post(`/api/events/${event1.id}/team/invitations`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          email: unverifiedUser.email,
          role: 'HOST',
        })
        .expect(201);

      expect(inv.body.invitation.token).toBeUndefined();
      const unverifiedEmail = sentTeamInvitationEmails
        .slice()
        .reverse()
        .find((e) => e.to === unverifiedUser.email.toLowerCase());
      const unverifiedToken = unverifiedEmail!.inviteUrl.split('/').pop()!;

      const res = await request(app)
        .post(`/api/team/invitations/${unverifiedToken}/accept`)
        .set('Cookie', unverifiedAuth.cookie)
        .set('x-csrf-token', unverifiedAuth.csrf)
        .expect(403);

      expect(res.body.error.message).toMatch(/Email (?:must be verified|verification is required)/);
    });

    it('rejects invitation acceptance if signed-in account email does not match invitation recipient', async () => {
      const res = await request(app)
        .post(`/api/team/invitations/${hostInviteToken}/accept`)
        .set('Cookie', outsiderAuth.cookie) // Signed in as outsiderUser
        .set('x-csrf-token', outsiderAuth.csrf)
        .expect(403);

      expect(res.body.error.message).toContain('Signed-in account email does not match');
    });

    it('accepts Host invitation: creates active membership and automatically generates personal Host link', async () => {
      const res = await request(app)
        .post(`/api/team/invitations/${hostInviteToken}/accept`)
        .set('Cookie', hostAuth.cookie)
        .set('x-csrf-token', hostAuth.csrf)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.membership.role).toBe('HOST');
      expect(res.body.membership.status).toBe('ACTIVE');

      // Verify personal Host promotional link was automatically generated
      expect(res.body.membership.hostLink).toBeDefined();
      expect(res.body.membership.hostLink.slug).toBeDefined();
      expect(res.body.membership.hostLink.name).toContain('Host');

      // Verify link resolves via Stage 1 short-link resolver (/r/:slug)
      const hostSlug = res.body.membership.hostLink.slug;
      const resolverRes = await request(app).get(`/r/${hostSlug}`).expect(302);
      expect(resolverRes.header.location).toContain(`/events/${event1.slug}`);
    });

    it('accepts Admin invitation: creates active membership with configured permissions', async () => {
      const res = await request(app)
        .post(`/api/team/invitations/${adminInviteToken}/accept`)
        .set('Cookie', adminAuth.cookie)
        .set('x-csrf-token', adminAuth.csrf)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.membership.role).toBe('ADMIN');
      expect(res.body.membership.status).toBe('ACTIVE');
    });

    it('prevents duplicate active memberships when trying to invite an existing active member', async () => {
      const res = await request(app)
        .post(`/api/events/${event1.id}/team/invitations`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          email: hostUser.email,
          role: 'HOST',
        })
        .expect(409);

      expect(res.body.error.message).toContain('already an active HOST of this event team');
    });

    it('revokes an invitation and prevents subsequent acceptance', async () => {
      const revokeEmailAddr = `revokeme_${testRunId}@outside.vip`;
      const invRes = await request(app)
        .post(`/api/events/${event1.id}/team/invitations`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          email: revokeEmailAddr,
          role: 'HOST',
        })
        .expect(201);

      expect(invRes.body.invitation.token).toBeUndefined();
      const revokeEmail = sentTeamInvitationEmails
        .slice()
        .reverse()
        .find((e) => e.to === revokeEmailAddr);
      const token = revokeEmail!.inviteUrl.split('/').pop()!;
      const id = invRes.body.invitation.id;

      // Revoke
      await request(app)
        .delete(`/api/events/${event1.id}/team/invitations/${id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .expect(200);

      // Attempt inspection
      await request(app).get(`/api/team/invitations/${token}`).expect(403);
    });
  });

  describe('2. Event Admin Permissions & Deny-by-Default Enforcement', () => {
    it('enforces deny-by-default: Admin without canManageTeam permission is forbidden from inviting members', async () => {
      // adminUser has canManageTeam: false
      const res = await request(app)
        .post(`/api/events/${event1.id}/team/invitations`)
        .set('Cookie', adminAuth.cookie)
        .set('x-csrf-token', adminAuth.csrf)
        .send({
          email: `blocked_${testRunId}@outside.vip`,
          role: 'HOST',
        })
        .expect(403);

      expect(res.body.error.message).toContain("lack the 'canManageTeam' permission");
    });

    it('enforces deny-by-default: Admin without canCancelEvent is forbidden from canceling event', async () => {
      const res = await request(app)
        .post(`/api/organizer/events/${event1.id}/cancel`)
        .set('Cookie', adminAuth.cookie)
        .set('x-csrf-token', adminAuth.csrf)
        .expect(403);

      expect(res.body.error.message).toContain("lack the 'canCancelEvent' permission");
    });

    it('allows Admin with canEditDetails permission to update event details', async () => {
      const res = await request(app)
        .put(`/api/organizer/events/${event1.id}`)
        .set('Cookie', adminAuth.cookie)
        .set('x-csrf-token', adminAuth.csrf)
        .send({
          title: `Updated by Admin - ${testRunId}`,
        })
        .expect(200);

      expect(res.body.data.event.title).toContain('Updated by Admin');
    });

    it('strictly restricts financial payout settings to event owner; Event Admin is forbidden', async () => {
      // Organizer can view payout details
      const orgRes = await request(app)
        .get('/api/organizer/payout-details')
        .set('Cookie', organizerAuth.cookie)
        .expect(200);
      expect(orgRes.body.success).toBe(true);

      // Admin reading organizer event by ID receives null payoutDetails
      const adminEventRes = await request(app)
        .get(`/api/organizer/events/${event1.id}`)
        .set('Cookie', adminAuth.cookie)
        .expect(200);

      expect(adminEventRes.body.data.event.payoutDetails).toBeNull();
      expect(adminEventRes.body.data.event.organizer.payoutDetails).toBeNull();
    });
  });

  describe('3. Host Experience, Link Customization & Data Isolation', () => {
    let hostLinkSlug: string;

    it('host can list their assigned events and access their personal promotional link', async () => {
      const res = await request(app)
        .get('/api/host/events')
        .set('Cookie', hostAuth.cookie)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.events.length).toBeGreaterThanOrEqual(1);

      const assigned = res.body.events.find((e: any) => e.event.id === event1.id);
      expect(assigned).toBeDefined();
      expect(assigned.hostLink).toBeDefined();
      expect(assigned.hostLink.slug).toBeDefined();

      hostLinkSlug = assigned.hostLink.slug;
    });

    it('host can customize their primary promotional slug subject to availability and format', async () => {
      const newCustomSlug = `stage2-host-custom-${testRunId}`;

      const res = await request(app)
        .patch(`/api/host/events/${event1.id}/slug`)
        .set('Cookie', hostAuth.cookie)
        .set('x-csrf-token', hostAuth.csrf)
        .send({
          slug: newCustomSlug,
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.primarySlug).toBe(newCustomSlug);
      expect(res.body.previousSlug).toBe(hostLinkSlug);

      // Verify new slug immediately resolves
      const newRes = await request(app).get(`/r/${newCustomSlug}`).expect(302);
      expect(newRes.header.location).toContain(`/events/${event1.slug}`);

      // Verify old slug remains a historical alias and continues to redirect!
      const oldRes = await request(app).get(`/r/${hostLinkSlug}`).expect(302);
      expect(oldRes.header.location).toContain(`/events/${event1.slug}`);
    });

    it('rejects invalid or reserved slugs during customization', async () => {
      // Reserved slug check
      await request(app)
        .patch(`/api/host/events/${event1.id}/slug`)
        .set('Cookie', hostAuth.cookie)
        .set('x-csrf-token', hostAuth.csrf)
        .send({ slug: 'admin' })
        .expect(400);

      // Invalid format check (uppercase, special characters)
      await request(app)
        .patch(`/api/host/events/${event1.id}/slug`)
        .set('Cookie', hostAuth.cookie)
        .set('x-csrf-token', hostAuth.csrf)
        .send({ slug: 'INVALID_SLUG!!' })
        .expect(400);
    });

    it('host can view their own traffic analytics (clicks and unique visitors)', async () => {
      const res = await request(app)
        .get(`/api/host/events/${event1.id}/analytics`)
        .set('Cookie', hostAuth.cookie)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.traffic).toBeDefined();
      expect(res.body.traffic.totalClicks).toBeGreaterThanOrEqual(2); // From the two shortlink redirects above
      expect(res.body.traffic.uniqueVisitors).toBeDefined();
      expect(res.body.traffic.dailyVisits).toBeDefined();

      // STRICT ISOLATION: Zero financial, order, customer, or attendee data
      expect(res.body.revenue).toBeUndefined();
      expect(res.body.sales).toBeUndefined();
      expect(res.body.tickets).toBeUndefined();
      expect(res.body.customers).toBeUndefined();
    });

    it('host is strictly forbidden from accessing another event where they are not assigned', async () => {
      // hostUser is NOT a host of event2
      await request(app)
        .get(`/api/host/events/${event2.id}/analytics`)
        .set('Cookie', hostAuth.cookie)
        .expect(403);
    });
  });

  describe('4. Campaign Promotional Links & Traffic-Only Analytics', () => {
    let campaignLinkId: string;
    const campaignSlug = `summer-insta-${testRunId}`;

    it('organizer can create a named CAMPAIGN link with custom primary slug', async () => {
      const res = await request(app)
        .post(`/api/events/${event1.id}/promotions/links`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          name: 'Instagram Summer Campaign',
          slug: campaignSlug,
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.link.type).toBe('CAMPAIGN');
      expect(res.body.link.primarySlug).toBe(campaignSlug);
      campaignLinkId = res.body.link.id;

      // Test resolution
      const clickRes = await request(app)
        .get(`/r/${campaignSlug}?utm_source=instagram&utm_medium=story&utm_campaign=summer`)
        .expect(302);

      expect(clickRes.header.location).toContain('utm_source=instagram');
    });

    it('organizer can update promotional link status to DISABLED, blocking traffic', async () => {
      await request(app)
        .patch(`/api/events/${event1.id}/promotions/links/${campaignLinkId}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          status: 'DISABLED',
        })
        .expect(200);

      // Verify link is disabled in DB
      const link = await prisma.promotionLink.findUnique({ where: { id: campaignLinkId } });
      expect(link?.status).toBe('DISABLED');
    });

    it('organizer can reactivate link and view event-wide traffic analytics', async () => {
      await request(app)
        .patch(`/api/events/${event1.id}/promotions/links/${campaignLinkId}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          status: 'ACTIVE',
        })
        .expect(200);

      const res = await request(app)
        .get(`/api/events/${event1.id}/promotions/analytics`)
        .set('Cookie', organizerAuth.cookie)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.analytics.traffic).toBeDefined();
      expect(res.body.analytics.traffic.totalClicks).toBeGreaterThan(0);
      expect(res.body.analytics.traffic.uniqueVisitors).toBeGreaterThan(0);
      expect(res.body.analytics.traffic.topReferrers).toBeDefined();
      expect(res.body.analytics.traffic.utmBreakdown).toBeDefined();
      expect(res.body.analytics.traffic.linksBreakdown).toBeDefined();

      // STRICT PRODUCT DECISION: Traffic reporting only, zero sales or conversion metrics
      expect(res.body.analytics.sales).toBeUndefined();
      expect(res.body.analytics.revenue).toBeUndefined();
      expect(res.body.analytics.conversions).toBeUndefined();
      expect(res.body.analytics.orders).toBeUndefined();
    });
  });

  describe('5. Member Role Mutation Triggers & Revocation', () => {
    it('archives personal Host links when an Event Host role is updated or revoked', async () => {
      const member = await prisma.eventTeamMember.findFirst({
        where: { eventId: event1.id, userId: hostUser.id },
      });
      expect(member).not.toBeNull();

      // Revoke member
      await request(app)
        .delete(`/api/events/${event1.id}/team/members/${member!.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .expect(200);

      // Verify member is REVOKED
      const updatedMember = await prisma.eventTeamMember.findUnique({ where: { id: member!.id } });
      expect(updatedMember?.status).toBe(TeamMemberStatus.REVOKED);

      // Verify their host link was archived
      const hostLinks = await prisma.promotionLink.findMany({
        where: { hostMemberId: member!.id },
      });
      expect(hostLinks.every((l) => l.status === 'ARCHIVED')).toBe(true);
    });
  });

  describe('6. Host Role Mutation & Reactivation Lifecycle (Targeted Verification)', () => {
    let host2User: any;
    let host2Auth: any;
    let host2Member: any;
    let host2LinkId: string;
    let host2PrimarySlug: string;

    beforeAll(async () => {
      // Create second host user for role mutation tests
      host2User = await prisma.user.create({
        data: {
          email: `event_host2_${testRunId}@outside.vip`,
          name: 'Stage 2 Host Two',
          role: 'ATTENDEE',
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(host2User.id);
      host2Auth = await createAuth(host2User.id);

      // Invite host2
      await request(app)
        .post(`/api/events/${event1.id}/team/invitations`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          email: host2User.email,
          role: EventTeamRole.HOST,
        })
        .expect(201);

      const inviteEmail = sentTeamInvitationEmails.find((e) => e.to === host2User.email);
      expect(inviteEmail).toBeDefined();
      const rawToken = inviteEmail!.inviteUrl.split('/').pop()!;

      // Accept invitation
      const acceptRes = await request(app)
        .post(`/api/team/invitations/${rawToken}/accept`)
        .set('Cookie', host2Auth.cookie)
        .set('x-csrf-token', host2Auth.csrf)
        .expect(200);

      host2Member = await prisma.eventTeamMember.findFirst({
        where: { eventId: event1.id, userId: host2User.id },
      });
      expect(host2Member).not.toBeNull();
      host2LinkId = acceptRes.body.membership.hostLink.id;
      host2PrimarySlug = acceptRes.body.membership.hostLink.slug;
    });

    // SCENARIO 3: HOST -> INACTIVE status change
    it('Scenario 3: updates HOST status to INACTIVE and safely disables promotional link', async () => {
      const res = await request(app)
        .patch(`/api/events/${event1.id}/team/members/${host2Member.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({ status: TeamMemberStatus.INACTIVE })
        .expect(200);

      expect(res.body.member.status).toBe(TeamMemberStatus.INACTIVE);
      expect(res.body.member.role).toBe(EventTeamRole.HOST);

      // Verify link is DISABLED
      const link = await prisma.promotionLink.findUnique({ where: { id: host2LinkId } });
      expect(link?.status).toBe('DISABLED');
    });

    // SCENARIO 5 (part 1): Reactivation of INACTIVE host to ACTIVE
    it('Scenario 5a: reactivates INACTIVE host back to ACTIVE and restores link to ACTIVE', async () => {
      const res = await request(app)
        .patch(`/api/events/${event1.id}/team/members/${host2Member.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({ status: TeamMemberStatus.ACTIVE })
        .expect(200);

      expect(res.body.member.status).toBe(TeamMemberStatus.ACTIVE);

      // Verify link is restored to ACTIVE
      const link = await prisma.promotionLink.findUnique({ where: { id: host2LinkId } });
      expect(link?.status).toBe('ACTIVE');
    });

    // SCENARIO 1: HOST -> ADMIN role change
    it('Scenario 1: changing HOST to ADMIN archives personal link and updates role without trigger violation', async () => {
      const res = await request(app)
        .patch(`/api/events/${event1.id}/team/members/${host2Member.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          role: EventTeamRole.ADMIN,
          permissions: { canManageTeam: true },
        })
        .expect(200);

      expect(res.body.member.role).toBe(EventTeamRole.ADMIN);
      expect(res.body.member.permissions.canManageTeam).toBe(true);

      // Verify personal link was safely ARCHIVED
      const link = await prisma.promotionLink.findUnique({ where: { id: host2LinkId } });
      expect(link?.status).toBe('ARCHIVED');
    });

    // TRIGGER INTEGRITY: Attempting raw SQL role change away from HOST while link is ACTIVE throws DB error
    it('Trigger Integrity: trg_protect_host_role_mutation blocks raw role change away from HOST if link is ACTIVE', async () => {
      // Revert member back to HOST and link back to ACTIVE in a transaction
      await prisma.$transaction([
        prisma.eventTeamMember.update({
          where: { id: host2Member.id },
          data: { role: EventTeamRole.HOST },
        }),
        prisma.promotionLink.update({
          where: { id: host2LinkId },
          data: { status: 'ACTIVE' },
        }),
      ]);

      // Attempt raw update of role from HOST to ADMIN without archiving link first
      await expect(
        prisma.eventTeamMember.update({
          where: { id: host2Member.id },
          data: { role: EventTeamRole.ADMIN },
        })
      ).rejects.toThrow(/Cannot change EventTeamMember .* role from HOST to ADMIN while dependent PromotionLinks exist/);

      // Restore active HOST state
      await prisma.$transaction([
        prisma.eventTeamMember.update({
          where: { id: host2Member.id },
          data: { role: EventTeamRole.HOST, status: TeamMemberStatus.ACTIVE },
        }),
        prisma.promotionLink.update({
          where: { id: host2LinkId },
          data: { status: 'ACTIVE' },
        }),
      ]);
    });

    // SCENARIO 2: HOST membership revocation (verified on hostUser)
    it('Scenario 2: verified that revoked host has status REVOKED and link ARCHIVED', async () => {
      const member = await prisma.eventTeamMember.findFirst({
        where: { eventId: event1.id, userId: hostUser.id },
      });
      expect(member?.status).toBe(TeamMemberStatus.REVOKED);
      expect(member?.role).toBe(EventTeamRole.HOST);

      const links = await prisma.promotionLink.findMany({
        where: { hostMemberId: member!.id },
      });
      expect(links.length).toBe(1);
      expect(links[0].status).toBe('ARCHIVED');
    });

    // SCENARIO 4 & 5 (part 2): Re-invitation and reactivation of previously revoked Host
    it('Scenario 4 & 5b: re-inviting and reactivating revoked Host reactivates original link without duplicate', async () => {
      const priorMember = await prisma.eventTeamMember.findFirst({
        where: { eventId: event1.id, userId: hostUser.id },
      });
      expect(priorMember).not.toBeNull();

      const priorLinks = await prisma.promotionLink.findMany({
        where: { eventId: event1.id, hostMemberId: priorMember!.id },
        include: { slugRegistry: { where: { isPrimary: true } } },
      });
      expect(priorLinks.length).toBe(1);
      const priorLinkId = priorLinks[0].id;
      const priorPrimarySlug = priorLinks[0].slugRegistry[0].slug;

      // Re-invite revoked hostUser
      await request(app)
        .post(`/api/events/${event1.id}/team/invitations`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          email: hostUser.email,
          role: EventTeamRole.HOST,
        })
        .expect(201);

      const reinviteEmail = sentTeamInvitationEmails
        .filter((e) => e.to === hostUser.email)
        .pop();
      expect(reinviteEmail).toBeDefined();
      const rawToken = reinviteEmail!.inviteUrl.split('/').pop()!;

      // Accept re-invitation
      const acceptRes = await request(app)
        .post(`/api/team/invitations/${rawToken}/accept`)
        .set('Cookie', hostAuth.cookie)
        .set('x-csrf-token', hostAuth.csrf)
        .expect(200);

      expect(acceptRes.body.success).toBe(true);
      expect(acceptRes.body.membership.memberId).toBe(priorMember!.id);
      expect(acceptRes.body.membership.hostLink.id).toBe(priorLinkId); // MUST REUSE ORIGINAL LINK ID
      expect(acceptRes.body.membership.hostLink.slug).toBe(priorPrimarySlug); // MUST PRESERVE PRIMARY SLUG

      // Verify in DB that exactly one link exists for this host, and it is now ACTIVE
      const currentLinks = await prisma.promotionLink.findMany({
        where: { eventId: event1.id, hostMemberId: acceptRes.body.membership.memberId },
      });
      expect(currentLinks.length).toBe(1); // EXACTLY ONE PERSONAL HOST LINK
      expect(currentLinks[0].id).toBe(priorLinkId);
      expect(currentLinks[0].status).toBe('ACTIVE');

      // Verify DB constraint idx_unique_host_link_per_event holds
      const member = await prisma.eventTeamMember.findUnique({ where: { id: acceptRes.body.membership.memberId } });
      expect(member?.status).toBe(TeamMemberStatus.ACTIVE);
      expect(member?.role).toBe(EventTeamRole.HOST);
    });

    // INVARIANT TEST 1: updatePromotionLink rejects activating Host link if Host member is INACTIVE or REVOKED
    it('Invariant: updatePromotionLink rejects activating Host link if Host member is not active', async () => {
      // Set host2 to INACTIVE
      await request(app)
        .patch(`/api/events/${event1.id}/team/members/${host2Member.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({ status: TeamMemberStatus.INACTIVE })
        .expect(200);

      // Attempt to PATCH the promotion link to ACTIVE directly while member is INACTIVE
      const patchRes = await request(app)
        .patch(`/api/events/${event1.id}/promotions/links/${host2LinkId}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({ status: 'ACTIVE' })
        .expect(400);

      expect(patchRes.body.error.message).toContain('associated team member is not an active Host');

      // Restore host2 to ACTIVE
      await request(app)
        .patch(`/api/events/${event1.id}/team/members/${host2Member.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({ status: TeamMemberStatus.ACTIVE })
        .expect(200);
    });

    // INVARIANT TEST 2: DB Constraint Trigger rejects activating Host link for INACTIVE, REVOKED, or ADMIN member
    it('Invariant: DB constraint trigger trg_validate_promotion_link_host rejects ACTIVE Host link for non-active member', async () => {
      // Put host2 in INACTIVE state
      await prisma.$transaction([
        prisma.promotionLink.update({
          where: { id: host2LinkId },
          data: { status: 'DISABLED' },
        }),
        prisma.eventTeamMember.update({
          where: { id: host2Member.id },
          data: { status: TeamMemberStatus.INACTIVE },
        }),
      ]);

      // Attempt to directly set link to ACTIVE while member is INACTIVE
      await expect(
        prisma.promotionLink.update({
          where: { id: host2LinkId },
          data: { status: 'ACTIVE' },
        })
      ).rejects.toThrow(/Active PromotionLink hostMemberId must reference an EventTeamMember with role HOST and status ACTIVE/);

      // Restore to ACTIVE
      await prisma.$transaction([
        prisma.eventTeamMember.update({
          where: { id: host2Member.id },
          data: { status: TeamMemberStatus.ACTIVE },
        }),
        prisma.promotionLink.update({
          where: { id: host2LinkId },
          data: { status: 'ACTIVE' },
        }),
      ]);
    });

    // INVARIANT TEST 3: DB Constraint Trigger rejects setting Host member to INACTIVE or REVOKED while link is ACTIVE
    it('Invariant: DB constraint trigger trg_protect_host_membership_mutation rejects setting member to INACTIVE while link is ACTIVE', async () => {
      // Attempt to set member to INACTIVE directly without disabling link first
      await expect(
        prisma.eventTeamMember.update({
          where: { id: host2Member.id },
          data: { status: TeamMemberStatus.INACTIVE },
        })
      ).rejects.toThrow(/Cannot change EventTeamMember .* status to INACTIVE while active PromotionLinks exist/);
    });

    // INVARIANT TEST 4: Preservation of historical slug aliases and click analytics across deactivation and reactivation
    it('Invariant: preserves link ID, primary slug, historical aliases, and analytics across deactivation and reactivation', async () => {
      // 1. Customize slug to create a historical alias
      const customSlug = `host2-custom-${testRunId}`;
      await request(app)
        .patch(`/api/host/events/${event1.id}/slug`)
        .set('Cookie', host2Auth.cookie)
        .set('x-csrf-token', host2Auth.csrf)
        .send({ slug: customSlug })
        .expect(200);

      // 2. Generate traffic on the link to establish analytics
      await request(app).get(`/r/${customSlug}`).expect(302);

      const beforeAnalytics = await prisma.promotionClick.count({
        where: { promotionLinkId: host2LinkId },
      });
      expect(beforeAnalytics).toBeGreaterThan(0);

      const beforeAliases = await prisma.promotionSlugRegistry.findMany({
        where: { promotionLinkId: host2LinkId },
      });
      expect(beforeAliases.length).toBeGreaterThanOrEqual(2); // primary + historical alias

      // 3. Deactivate Host to INACTIVE
      await request(app)
        .patch(`/api/events/${event1.id}/team/members/${host2Member.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({ status: TeamMemberStatus.INACTIVE })
        .expect(200);

      // Verify link is DISABLED
      const disabledLink = await prisma.promotionLink.findUnique({ where: { id: host2LinkId } });
      expect(disabledLink?.status).toBe('DISABLED');

      // 4. Reactivate Host to ACTIVE
      await request(app)
        .patch(`/api/events/${event1.id}/team/members/${host2Member.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({ status: TeamMemberStatus.ACTIVE })
        .expect(200);

      // 5. Verify ID, slugs, aliases, and click records remain 100% intact
      const afterLink = await prisma.promotionLink.findUnique({
        where: { id: host2LinkId },
        include: { slugRegistry: true },
      });
      expect(afterLink?.id).toBe(host2LinkId);
      expect(afterLink?.status).toBe('ACTIVE');
      expect(afterLink?.slugRegistry.length).toBe(beforeAliases.length);

      const currentPrimary = afterLink?.slugRegistry.find((s) => s.isPrimary);
      expect(currentPrimary?.slug).toBe(customSlug);

      const afterAnalytics = await prisma.promotionClick.count({
        where: { promotionLinkId: host2LinkId },
      });
      expect(afterAnalytics).toBe(beforeAnalytics);
    });
  });

  // =========================================================================
  // 7. Final Host Link Lifecycle & Authorization Verification (Stage 3 Verification)
  // =========================================================================
  describe('7. Final Host Link Lifecycle & Authorization Verification (Stage 3 Verification)', () => {
    // ==========================================
    // 2A. Disabled Host links
    // ==========================================
    describe('2A. Disabled Host links', () => {
      let testHostSlug: string;

      beforeAll(async () => {
        // Ensure hostUser has an ACTIVE link on event1
        const hostLink = await prisma.promotionLink.findFirst({
          where: { eventId: event1.id, hostMember: { userId: hostUser.id } },
          include: { slugRegistry: { where: { isPrimary: true } } },
        });
        testHostSlug = hostLink!.slugRegistry[0].slug;
      });

      it('2A.1: Host cannot reactivate their own DISABLED link via promotion management endpoints', async () => {
        // Organizer disables the host link
        const hostLink = await prisma.promotionLink.findFirst({
          where: { eventId: event1.id, hostMember: { userId: hostUser.id } },
        });
        await request(app)
          .patch(`/api/events/${event1.id}/promotions/links/${hostLink!.id}`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .send({ status: 'DISABLED' })
          .expect(200);

        // Host attempts to reactivate link
        await request(app)
          .patch(`/api/events/${event1.id}/promotions/links/${hostLink!.id}`)
          .set('Cookie', hostAuth.cookie)
          .set('x-csrf-token', hostAuth.csrf)
          .send({ status: 'ACTIVE' })
          .expect(403);

        const checkLink = await prisma.promotionLink.findUnique({ where: { id: hostLink!.id } });
        expect(checkLink?.status).toBe('DISABLED');
      });

      it('2A.2: A DISABLED link redirects to the correct public event page', async () => {
        const res = await request(app)
          .get(`/r/${testHostSlug}`)
          .expect(302);

        expect(res.header.location).toContain(`/events/${event1.slug}`);
      });

      it('2A.3: Resolving a DISABLED link does not record a new click, visitor-day entry, or attribution', async () => {
        const hostLink = await prisma.promotionLink.findFirst({
          where: { eventId: event1.id, hostMember: { userId: hostUser.id } },
        });

        const initialClicks = await prisma.promotionClick.count({
          where: { promotionLinkId: hostLink!.id },
        });
        const initialVisitorDays = await prisma.promotionVisitorDay.count({
          where: { promotionLinkId: hostLink!.id },
        });
        const initialAttributions = await prisma.promotionVisitorAttribution.count({
          where: { promotionLinkId: hostLink!.id },
        });

        // Resolve disabled link
        await request(app)
          .get(`/r/${testHostSlug}`)
          .set('Cookie', `${VISITOR_COOKIE_NAME}=test_vid_disabled_check_${testRunId}`)
          .expect(302);

        const afterClicks = await prisma.promotionClick.count({
          where: { promotionLinkId: hostLink!.id },
        });
        const afterVisitorDays = await prisma.promotionVisitorDay.count({
          where: { promotionLinkId: hostLink!.id },
        });
        const afterAttributions = await prisma.promotionVisitorAttribution.count({
          where: { promotionLinkId: hostLink!.id },
        });

        expect(afterClicks).toBe(initialClicks);
        expect(afterVisitorDays).toBe(initialVisitorDays);
        expect(afterAttributions).toBe(initialAttributions);
      });

      it('2A.4: Organizer-controlled pause/resume behavior works through existing authorized management endpoint', async () => {
        const hostLink = await prisma.promotionLink.findFirst({
          where: { eventId: event1.id, hostMember: { userId: hostUser.id } },
        });

        // Resume to ACTIVE
        const res = await request(app)
          .patch(`/api/events/${event1.id}/promotions/links/${hostLink!.id}`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .send({ status: 'ACTIVE' })
          .expect(200);

        expect(res.body.link.status).toBe('ACTIVE');

        const activeLink = await prisma.promotionLink.findUnique({ where: { id: hostLink!.id } });
        expect(activeLink?.status).toBe('ACTIVE');
      });
    });

    // ==========================================
    // 2B. Archived Host links
    // ==========================================
    describe('2B. Archived Host links', () => {
      let archivedHostUser: any;
      let archivedHostAuth: { cookie: string; csrf: string };
      let archivedHostMember: any;
      let archivedLinkId: string;
      let archivedSlug: string;

      beforeAll(async () => {
        archivedHostUser = await prisma.user.create({
          data: {
            email: `archived_host_${testRunId}@outside.vip`,
            name: 'Archived Host User',
            role: 'ATTENDEE',
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        });
        createdUserIds.push(archivedHostUser.id);
        archivedHostAuth = await createAuth(archivedHostUser.id);

        // Invite and accept as HOST on event1
        await request(app)
          .post(`/api/events/${event1.id}/team/invitations`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .send({ email: archivedHostUser.email, role: EventTeamRole.HOST })
          .expect(201);

        const inviteEmail = sentTeamInvitationEmails.find((e) => e.to === archivedHostUser.email);
        const rawToken = inviteEmail!.inviteUrl.split('/').pop()!;

        const acceptRes = await request(app)
          .post(`/api/team/invitations/${rawToken}/accept`)
          .set('Cookie', archivedHostAuth.cookie)
          .set('x-csrf-token', archivedHostAuth.csrf)
          .expect(200);

        archivedLinkId = acceptRes.body.membership.hostLink.id;
        archivedSlug = acceptRes.body.membership.hostLink.slug;
        archivedHostMember = await prisma.eventTeamMember.findFirst({
          where: { eventId: event1.id, userId: archivedHostUser.id },
        });

        // Record a click while active to generate historical analytics
        await request(app).get(`/r/${archivedSlug}`).expect(302);

        // Revoke the host to archive their link
        await request(app)
          .delete(`/api/events/${event1.id}/team/members/${archivedHostMember.id}`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .expect(200);
      });

      it('2B.1: An ARCHIVED Host link cannot be customized or reactivated through Host-facing endpoints', async () => {
        // Attempting to customize slug on an archived link fails
        await request(app)
          .patch(`/api/host/events/${event1.id}/slug`)
          .set('Cookie', archivedHostAuth.cookie)
          .set('x-csrf-token', archivedHostAuth.csrf)
          .send({ slug: `try-custom-${testRunId}` })
          .expect(401); // Active Host membership required

        // Attempting to customize slug via management route rejects archived link
        await request(app)
          .post(`/api/events/${event1.id}/promotions/links/${archivedLinkId}/slug`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .send({ slug: `org-custom-${testRunId}` })
          .expect(400); // Cannot modify an archived promotional link
      });

      it('2B.2: An archived link cannot be used to create a duplicate Host link for the same event and Host', async () => {
        // Re-invite the revoked host
        await request(app)
          .post(`/api/events/${event1.id}/team/invitations`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .send({ email: archivedHostUser.email, role: EventTeamRole.HOST })
          .expect(201);

        const newEmail = sentTeamInvitationEmails
          .slice()
          .reverse()
          .find((e) => e.to === archivedHostUser.email);
        const newToken = newEmail!.inviteUrl.split('/').pop()!;

        const acceptRes = await request(app)
          .post(`/api/team/invitations/${newToken}/accept`)
          .set('Cookie', archivedHostAuth.cookie)
          .set('x-csrf-token', archivedHostAuth.csrf)
          .expect(200);

        // Verifies the existing link is reused, not duplicated
        expect(acceptRes.body.membership.hostLink.id).toBe(archivedLinkId);

        const totalLinksForHost = await prisma.promotionLink.count({
          where: { eventId: event1.id, hostMemberId: acceptRes.body.membership.memberId },
        });
        expect(totalLinksForHost).toBe(1);
      });

      it('2B.3: Existing slug aliases and historical analytics remain preserved', async () => {
        const link = await prisma.promotionLink.findUnique({
          where: { id: archivedLinkId },
          include: { slugRegistry: true },
        });
        expect(link).not.toBeNull();
        expect(link?.slugRegistry.length).toBeGreaterThanOrEqual(1);

        // Historical click remains intact
        const clicks = await prisma.promotionClick.count({
          where: { promotionLinkId: archivedLinkId },
        });
        expect(clicks).toBeGreaterThanOrEqual(1);
      });

      it('2B.4: Changing member role from HOST archives the host link', async () => {
        // Update member role from HOST to ADMIN
        const member = await prisma.eventTeamMember.findFirst({
          where: { eventId: event1.id, userId: archivedHostUser.id },
        });
        await request(app)
          .patch(`/api/events/${event1.id}/team/members/${member!.id}`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .send({ role: EventTeamRole.ADMIN, permissions: { canViewAnalytics: true } })
          .expect(200);

        const link = await prisma.promotionLink.findUnique({
          where: { id: archivedLinkId },
        });
        expect(link?.status).toBe('ARCHIVED');
      });
    });

    // ==========================================
    // 2C. Inactive or revoked Host membership
    // ==========================================
    describe('2C. Inactive or revoked Host membership', () => {
      let lifecycleHostUser: any;
      let lifecycleHostAuth: { cookie: string; csrf: string };
      let lifecycleMember: any;

      beforeAll(async () => {
        lifecycleHostUser = await prisma.user.create({
          data: {
            email: `lifecycle_host_${testRunId}@outside.vip`,
            name: 'Lifecycle Host',
            role: 'ATTENDEE',
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        });
        createdUserIds.push(lifecycleHostUser.id);
        lifecycleHostAuth = await createAuth(lifecycleHostUser.id);

        await request(app)
          .post(`/api/events/${event1.id}/team/invitations`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .send({ email: lifecycleHostUser.email, role: EventTeamRole.HOST })
          .expect(201);

        const email = sentTeamInvitationEmails
          .slice()
          .reverse()
          .find((e) => e.to === lifecycleHostUser.email);
        const token = email!.inviteUrl.split('/').pop()!;

        await request(app)
          .post(`/api/team/invitations/${token}/accept`)
          .set('Cookie', lifecycleHostAuth.cookie)
          .set('x-csrf-token', lifecycleHostAuth.csrf)
          .expect(200);

        lifecycleMember = await prisma.eventTeamMember.findFirst({
          where: { eventId: event1.id, userId: lifecycleHostUser.id },
        });
      });

      it('2C.1: INACTIVE Host cannot retrieve Host analytics', async () => {
        // Set to INACTIVE
        await request(app)
          .patch(`/api/events/${event1.id}/team/members/${lifecycleMember.id}`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .send({ status: TeamMemberStatus.INACTIVE })
          .expect(200);

        await request(app)
          .get(`/api/host/events/${event1.id}/analytics`)
          .set('Cookie', lifecycleHostAuth.cookie)
          .expect(403);
      });

      it('2C.2: INACTIVE Host cannot customize their personal slug', async () => {
        await request(app)
          .patch(`/api/host/events/${event1.id}/slug`)
          .set('Cookie', lifecycleHostAuth.cookie)
          .set('x-csrf-token', lifecycleHostAuth.csrf)
          .send({ slug: `inactive-slug-${testRunId}` })
          .expect(401);
      });

      it('2C.3: INACTIVE Host does not receive protected Host event/link information', async () => {
        const res = await request(app)
          .get('/api/host/events')
          .set('Cookie', lifecycleHostAuth.cookie)
          .expect(200);

        // Must not contain event1
        const found = res.body.events.find((e: any) => e.event.id === event1.id);
        expect(found).toBeUndefined();
      });

      it('2C.4: REVOKED Host cannot retrieve Host analytics', async () => {
        // Revoke member
        await request(app)
          .delete(`/api/events/${event1.id}/team/members/${lifecycleMember.id}`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .expect(200);

        await request(app)
          .get(`/api/host/events/${event1.id}/analytics`)
          .set('Cookie', lifecycleHostAuth.cookie)
          .expect(403);
      });

      it('2C.5: REVOKED Host cannot customize personal slug', async () => {
        await request(app)
          .patch(`/api/host/events/${event1.id}/slug`)
          .set('Cookie', lifecycleHostAuth.cookie)
          .set('x-csrf-token', lifecycleHostAuth.csrf)
          .send({ slug: `revoked-slug-${testRunId}` })
          .expect(401);
      });

      it('2C.6: REVOKED Host receives empty assigned events list', async () => {
        const res = await request(app)
          .get('/api/host/events')
          .set('Cookie', lifecycleHostAuth.cookie)
          .expect(200);

        expect(res.body.events.length).toBe(0);
      });
    });

    // ==========================================
    // 2D. Active Host membership
    // ==========================================
    describe('2D. Active Host membership', () => {
      let activeHostUser: any;
      let activeHostAuth: { cookie: string; csrf: string };
      let activeHostLink: any;
      let activePrimarySlug: string;

      beforeAll(async () => {
        activeHostUser = await prisma.user.create({
          data: {
            email: `active_host_2d_${testRunId}@outside.vip`,
            name: 'Active Host 2D',
            role: 'ATTENDEE',
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        });
        createdUserIds.push(activeHostUser.id);
        activeHostAuth = await createAuth(activeHostUser.id);

        await request(app)
          .post(`/api/events/${event1.id}/team/invitations`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .send({ email: activeHostUser.email, role: EventTeamRole.HOST })
          .expect(201);

        const email = sentTeamInvitationEmails
          .slice()
          .reverse()
          .find((e) => e.to === activeHostUser.email);
        const token = email!.inviteUrl.split('/').pop()!;

        const acceptRes = await request(app)
          .post(`/api/team/invitations/${token}/accept`)
          .set('Cookie', activeHostAuth.cookie)
          .set('x-csrf-token', activeHostAuth.csrf)
          .expect(200);

        activeHostLink = acceptRes.body.membership.hostLink;
        activePrimarySlug = acceptRes.body.membership.hostLink.slug;
      });

      it('2D.1: Active Host can retrieve assigned events and personal link details', async () => {
        const res = await request(app)
          .get('/api/host/events')
          .set('Cookie', activeHostAuth.cookie)
          .expect(200);

        expect(res.body.success).toBe(true);
        const item = res.body.events.find((e: any) => e.event.id === event1.id);
        expect(item).toBeDefined();
        expect(item.hostLink.slug).toBe(activePrimarySlug);
        expect(item.hostLink.status).toBe('ACTIVE');
      });

      it('2D.2: Active Host retrieves analytics for their own personal link only', async () => {
        const res = await request(app)
          .get(`/api/host/events/${event1.id}/analytics`)
          .set('Cookie', activeHostAuth.cookie)
          .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.link.id).toBe(activeHostLink.id);
        expect(res.body.link.primarySlug).toBe(activePrimarySlug);
        expect(res.body.traffic.totalClicks).toBeDefined();
        expect(res.body.traffic.uniqueVisitors).toBeDefined();
        expect(res.body.traffic.dailyVisits).toBeDefined();
        expect(res.body.traffic.topReferrers).toBeDefined();
      });

      it('2D.3: Cross-Host Isolation: Host A cannot access Host B link or analytics', async () => {
        // activeHostUser queries event1 analytics -> gets activeHostLink stats, NOT hostUser's stats
        const res = await request(app)
          .get(`/api/host/events/${event1.id}/analytics`)
          .set('Cookie', activeHostAuth.cookie)
          .expect(200);

        expect(res.body.link.id).toBe(activeHostLink.id);

        // activeHostUser queries event2 where they are NOT assigned -> 403 Forbidden
        await request(app)
          .get(`/api/host/events/${event2.id}/analytics`)
          .set('Cookie', activeHostAuth.cookie)
          .expect(403);
      });

      it('2D.4: Active Host can customize slug and retain previous slugs as aliases', async () => {
        const initialSlug = activePrimarySlug;
        const newSlug = `active-2d-new-${testRunId}`;

        const res = await request(app)
          .patch(`/api/host/events/${event1.id}/slug`)
          .set('Cookie', activeHostAuth.cookie)
          .set('x-csrf-token', activeHostAuth.csrf)
          .send({ slug: newSlug })
          .expect(200);

        expect(res.body.primarySlug).toBe(newSlug);
        expect(res.body.previousSlug).toBe(initialSlug);

        // Verify new slug resolves and redirects to event
        const newRes = await request(app).get(`/r/${newSlug}`).expect(302);
        expect(newRes.header.location).toContain(`/events/${event1.slug}`);

        // Verify previous slug resolves and redirects to event (alias preserved)
        const prevRes = await request(app).get(`/r/${initialSlug}`).expect(302);
        expect(prevRes.header.location).toContain(`/events/${event1.slug}`);
      });
    });
  });

  // =========================================================================
  // 8. Stage 3 Integration: Event Admin Permissions & Dual-Role Workspaces
  // =========================================================================
  describe('8. Stage 3 Integration: Event Admin Permissions & Dual-Role Workspaces', () => {
    let limitedAdminUser: any;
    let limitedAdminAuth: { cookie: string; csrf: string };
    let dualRoleUser: any;
    let dualRoleAuth: { cookie: string; csrf: string };
    let dualRoleEvent: any;

    beforeAll(async () => {
      // 1. Create limited admin user with canEditDetails: true, but canManageTickets: false
      limitedAdminUser = await prisma.user.create({
        data: {
          email: `limited_admin_${testRunId}@outside.vip`,
          name: 'Limited Admin',
          role: 'ATTENDEE',
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(limitedAdminUser.id);
      limitedAdminAuth = await createAuth(limitedAdminUser.id);

      await request(app)
        .post(`/api/events/${event1.id}/team/invitations`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          email: limitedAdminUser.email,
          role: EventTeamRole.ADMIN,
          permissions: {
            canEditDetails: true,
            canManageTickets: false,
            canManagePromotions: false,
          },
        })
        .expect(201);

      const email = sentTeamInvitationEmails
        .slice()
        .reverse()
        .find((e) => e.to === limitedAdminUser.email);
      const token = email!.inviteUrl.split('/').pop()!;

      await request(app)
        .post(`/api/team/invitations/${token}/accept`)
        .set('Cookie', limitedAdminAuth.cookie)
        .set('x-csrf-token', limitedAdminAuth.csrf)
        .expect(200);

      // 2. Create dual-role user (Organizer of their own event + Host on event1)
      dualRoleUser = await prisma.user.create({
        data: {
          email: `dual_role_${testRunId}@outside.vip`,
          name: 'Dual Role User',
          role: 'ORGANIZER',
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(dualRoleUser.id);
      dualRoleAuth = await createAuth(dualRoleUser.id);

      dualRoleEvent = await prisma.event.create({
        data: {
          organizerId: dualRoleUser.id,
          title: `Dual Role Organizer Event - ${testRunId}`,
          description: 'Organizer event description',
          coverImageUrl: 'https://example.com/cover.jpg',
          venueAddress: '500 Dual Way',
          slug: `dual-role-evt-${testRunId}`,
          category: 'MUSIC',
          status: 'PUBLISHED',
          startAt: new Date(Date.now() + 86400000 * 20),
          endAt: new Date(Date.now() + 86400000 * 21),
          venueName: 'Dual Arena',
          city: 'Nairobi',
          country: 'KE',
        },
      });
      createdEventIds.push(dualRoleEvent.id);

      // Invite dualRoleUser as HOST on event1
      await request(app)
        .post(`/api/events/${event1.id}/team/invitations`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          email: dualRoleUser.email,
          role: EventTeamRole.HOST,
        })
        .expect(201);

      const hostInviteEmail = sentTeamInvitationEmails
        .slice()
        .reverse()
        .find((e) => e.to === dualRoleUser.email);
      const hostToken = hostInviteEmail!.inviteUrl.split('/').pop()!;

      await request(app)
        .post(`/api/team/invitations/${hostToken}/accept`)
        .set('Cookie', dualRoleAuth.cookie)
        .set('x-csrf-token', dualRoleAuth.csrf)
        .expect(200);
    });

    it('enforces canManageTickets: Admin without canManageTickets cannot modify ticket tiers', async () => {
      // limitedAdmin attempts to update event details AND ticket tiers
      await request(app)
        .put(`/api/organizer/events/${event1.id}`)
        .set('Cookie', limitedAdminAuth.cookie)
        .set('x-csrf-token', limitedAdminAuth.csrf)
        .send({
          title: `Updated Title By Admin - ${testRunId}`,
          ticketTiers: [
            {
              name: 'Hacked VIP Tier',
              priceInCents: 10000,
              totalCapacity: 50,
            },
          ],
        })
        .expect(403);
    });

    it('allows Admin with canEditDetails to update event details when ticketTiers are omitted', async () => {
      const updateRes = await request(app)
        .put(`/api/organizer/events/${event1.id}`)
        .set('Cookie', limitedAdminAuth.cookie)
        .set('x-csrf-token', limitedAdminAuth.csrf)
        .send({
          title: `Updated Title By Admin - ${testRunId}`,
        })
        .expect(200);

      expect(updateRes.body.data.event.title).toBe(`Updated Title By Admin - ${testRunId}`);
    });

    it('dual-role user accesses both Organizer workspace and Host workspace independently', async () => {
      // 1. Organizer workspace: retrieves their owned event
      const orgRes = await request(app)
        .get('/api/organizer/events')
        .set('Cookie', dualRoleAuth.cookie)
        .expect(200);

      const owned = orgRes.body.data.events.find((e: any) => e.id === dualRoleEvent.id);
      expect(owned).toBeDefined();

      // 2. Host workspace: retrieves their assigned host event (event1)
      const hostRes = await request(app)
        .get('/api/host/events')
        .set('Cookie', dualRoleAuth.cookie)
        .expect(200);

      const hosted = hostRes.body.events.find((e: any) => e.event.id === event1.id);
      expect(hosted).toBeDefined();
      expect(hosted.hostLink.status).toBe('ACTIVE');
    });

    it('revoking Host membership removes Host access without affecting Organizer workspace', async () => {
      const hostMember = await prisma.eventTeamMember.findFirst({
        where: { eventId: event1.id, userId: dualRoleUser.id },
      });

      // Revoke host membership on event1
      await request(app)
        .delete(`/api/events/${event1.id}/team/members/${hostMember!.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .expect(200);

      // Host workspace: event1 is no longer returned
      const hostRes = await request(app)
        .get('/api/host/events')
        .set('Cookie', dualRoleAuth.cookie)
        .expect(200);

      const hosted = hostRes.body.events.find((e: any) => e.event.id === event1.id);
      expect(hosted).toBeUndefined();

      // Organizer workspace: owned event remains 100% accessible
      const orgRes = await request(app)
        .get('/api/organizer/events')
        .set('Cookie', dualRoleAuth.cookie)
        .expect(200);

      const owned = orgRes.body.data.events.find((e: any) => e.id === dualRoleEvent.id);
      expect(owned).toBeDefined();
      expect(owned.id).toBe(dualRoleEvent.id);
    });
  });

  describe('9. Stage 6 Implementation 2.1: P0 Event Admin Authorization Remediation (SEC-01 to SEC-05)', () => {
    let teamMgrAdminUser: any;
    let teamMgrAdminAuth: { cookie: string; csrf: string };
    let teamMgrMemberId: string;

    let peerAdminUser: any;
    let peerAdminAuth: { cookie: string; csrf: string };
    let peerAdminMemberId: string;

    let sec01HostUser: any;
    let sec01HostMemberId: string;

    let orgRoleAdminUser: any;
    let orgRoleAdminAuth: { cookie: string; csrf: string };

    let globalAdminUser: any;
    let globalAdminAuth: { cookie: string; csrf: string };

    let sec03DraftEvent: any;
    let sec03SeriesId: string;
    let sec03SeriesOcc1: any;
    let sec03SeriesOcc2: any;

    let tierEvent1Id: string;
    let tierEvent2Id: string;

    let orderEvent1Id: string;
    let orderEvent2Id: string;

    beforeAll(async () => {
      // 1. Create teamMgrAdminUser (ATTENDEE global role, granted canManageTeam, canEditDetails, canManageTickets)
      teamMgrAdminUser = await prisma.user.create({
        data: {
          email: `sec01_teammgr_${testRunId}@outside.vip`,
          name: 'Team Mgr Admin',
          role: 'ATTENDEE',
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(teamMgrAdminUser.id);
      teamMgrAdminAuth = await createAuth(teamMgrAdminUser.id);

      const teamMgrMember = await prisma.eventTeamMember.create({
        data: {
          eventId: event1.id,
          userId: teamMgrAdminUser.id,
          role: EventTeamRole.ADMIN,
          status: TeamMemberStatus.ACTIVE,
          permissions: {
            canEditDetails: true,
            canManageTickets: true,
            canViewOrders: false,
            canManageTeam: true,
            canManagePromotions: false,
            canViewAnalytics: false,
            canManageRefunds: false,
            canManagePayouts: false,
            canCancelEvent: false,
            canDeleteEvent: false,
          },
          invitedById: organizerUser.id,
        },
      });
      teamMgrMemberId = teamMgrMember.id;

      // 2. Create peerAdminUser (another Event Admin on event1)
      peerAdminUser = await prisma.user.create({
        data: {
          email: `sec01_peer_${testRunId}@outside.vip`,
          name: 'Peer Event Admin',
          role: 'ATTENDEE',
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(peerAdminUser.id);
      peerAdminAuth = await createAuth(peerAdminUser.id);

      const peerMember = await prisma.eventTeamMember.create({
        data: {
          eventId: event1.id,
          userId: peerAdminUser.id,
          role: EventTeamRole.ADMIN,
          status: TeamMemberStatus.ACTIVE,
          permissions: {
            canEditDetails: true,
            canManageTickets: false,
            canViewOrders: true,
            canManageTeam: false,
            canManagePromotions: true,
            canViewAnalytics: true,
            canManageRefunds: false,
            canManagePayouts: false,
            canCancelEvent: true,
            canDeleteEvent: false,
          },
          invitedById: organizerUser.id,
        },
      });
      peerAdminMemberId = peerMember.id;

      // 3. Create sec01HostUser (a Host on event1)
      sec01HostUser = await prisma.user.create({
        data: {
          email: `sec01_host_${testRunId}@outside.vip`,
          name: 'SEC01 Target Host',
          role: 'ATTENDEE',
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(sec01HostUser.id);

      const hostMem = await prisma.eventTeamMember.create({
        data: {
          eventId: event1.id,
          userId: sec01HostUser.id,
          role: EventTeamRole.HOST,
          status: TeamMemberStatus.ACTIVE,
          invitedById: organizerUser.id,
        },
      });
      sec01HostMemberId = hostMem.id;

      // 4. Create orgRoleAdminUser (global role ORGANIZER, Event Admin on event1 with canViewOrders: true)
      orgRoleAdminUser = await prisma.user.create({
        data: {
          email: `sec05_orgadmin_${testRunId}@outside.vip`,
          name: 'Organizer Role Event Admin',
          role: 'ORGANIZER',
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(orgRoleAdminUser.id);
      orgRoleAdminAuth = await createAuth(orgRoleAdminUser.id);

      await prisma.eventTeamMember.create({
        data: {
          eventId: event1.id,
          userId: orgRoleAdminUser.id,
          role: EventTeamRole.ADMIN,
          status: TeamMemberStatus.ACTIVE,
          permissions: {
            canEditDetails: false,
            canManageTickets: false,
            canViewOrders: true,
            canManageTeam: false,
            canManagePromotions: false,
            canViewAnalytics: false,
            canManageRefunds: false,
            canManagePayouts: false,
            canCancelEvent: false,
            canDeleteEvent: false,
          },
          invitedById: organizerUser.id,
        },
      });

      // 5. Create globalAdminUser (Platform ADMIN)
      globalAdminUser = await prisma.user.create({
        data: {
          email: `sec05_globaladmin_${testRunId}@outside.vip`,
          name: 'Global Platform Admin',
          role: 'ADMIN',
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(globalAdminUser.id);
      globalAdminAuth = await createAuth(globalAdminUser.id);

      // 6. Create sec03DraftEvent & series for lifecycle transition tests
      sec03DraftEvent = await prisma.event.create({
        data: {
          organizerId: organizerUser.id,
          title: `SEC03 Draft Event - ${testRunId}`,
          description: 'Draft lifecycle test event',
          coverImageUrl: 'https://example.com/sec03.jpg',
          venueAddress: '300 Lifecycle Ave',
          slug: `sec03-draft-${testRunId}`,
          category: 'MUSIC',
          status: 'DRAFT',
          startAt: new Date(Date.now() + 86400000 * 15),
          endAt: new Date(Date.now() + 86400000 * 16),
          venueName: 'Lifecycle Hall',
          city: 'Nairobi',
          country: 'KE',
          ticketTiers: {
            create: [
              {
                name: 'Free RSVP',
                priceInCents: 0,
                totalCapacity: 100,
                status: 'ACTIVE',
              },
            ],
          },
        },
      });
      createdEventIds.push(sec03DraftEvent.id);

      await prisma.eventTeamMember.create({
        data: {
          eventId: sec03DraftEvent.id,
          userId: teamMgrAdminUser.id,
          role: EventTeamRole.ADMIN,
          status: TeamMemberStatus.ACTIVE,
          permissions: {
            canEditDetails: true,
            canManageTickets: true,
            canViewOrders: false,
            canManageTeam: false,
            canManagePromotions: false,
            canViewAnalytics: false,
            canManageRefunds: false,
            canManagePayouts: false,
            canCancelEvent: false,
            canDeleteEvent: false,
          },
          invitedById: organizerUser.id,
        },
      });

      const series = await prisma.eventSeries.create({
        data: {
          organizerId: organizerUser.id,
          title: `SEC03 Series - ${testRunId}`,
          frequency: 'WEEKLY',
          interval: 1,
          startDate: new Date(Date.now() + 86400000 * 20),
          count: 2,
        },
      });
      sec03SeriesId = series.id;

      sec03SeriesOcc1 = await prisma.event.create({
        data: {
          organizerId: organizerUser.id,
          seriesId: series.id,
          occurrenceIndex: 1,
          title: `SEC03 Series Occ 1 - ${testRunId}`,
          description: 'Series Occ 1',
          coverImageUrl: 'https://example.com/occ1.jpg',
          venueAddress: '300 Series St',
          slug: `sec03-occ1-${testRunId}`,
          category: 'MUSIC',
          status: 'PUBLISHED',
          startAt: new Date(Date.now() + 86400000 * 20),
          endAt: new Date(Date.now() + 86400000 * 21),
          venueName: 'Series Hall',
          city: 'Nairobi',
          country: 'KE',
        },
      });
      createdEventIds.push(sec03SeriesOcc1.id);

      sec03SeriesOcc2 = await prisma.event.create({
        data: {
          organizerId: organizerUser.id,
          seriesId: series.id,
          occurrenceIndex: 2,
          title: `SEC03 Series Occ 2 - ${testRunId}`,
          description: 'Series Occ 2',
          coverImageUrl: 'https://example.com/occ2.jpg',
          venueAddress: '300 Series St',
          slug: `sec03-occ2-${testRunId}`,
          category: 'MUSIC',
          status: 'PUBLISHED',
          startAt: new Date(Date.now() + 86400000 * 27),
          endAt: new Date(Date.now() + 86400000 * 28),
          venueName: 'Series Hall',
          city: 'Nairobi',
          country: 'KE',
        },
      });
      createdEventIds.push(sec03SeriesOcc2.id);

      await prisma.eventTeamMember.create({
        data: {
          eventId: sec03SeriesOcc1.id,
          userId: teamMgrAdminUser.id,
          role: EventTeamRole.ADMIN,
          status: TeamMemberStatus.ACTIVE,
          permissions: {
            canEditDetails: true,
            canManageTickets: true,
            canViewOrders: false,
            canManageTeam: false,
            canManagePromotions: false,
            canViewAnalytics: false,
            canManageRefunds: false,
            canManagePayouts: false,
            canCancelEvent: false,
            canDeleteEvent: false,
          },
          invitedById: organizerUser.id,
        },
      });

      // 7. Create ticket tiers on event1 and event2 for SEC-04 IDOR testing
      const tier1 = await prisma.ticketTier.create({
        data: {
          eventId: event1.id,
          name: 'Event 1 Local Tier',
          priceInCents: 5000,
          totalCapacity: 100,
          status: 'ACTIVE',
        },
      });
      tierEvent1Id = tier1.id;

      const tier2 = await prisma.ticketTier.create({
        data: {
          eventId: event2.id,
          name: 'Event 2 Foreign Tier',
          priceInCents: 8000,
          totalCapacity: 200,
          status: 'ACTIVE',
        },
      });
      tierEvent2Id = tier2.id;

      // 8. Create orders on event1 and event2 for SEC-05 order access testing
      const ord1 = await prisma.order.create({
        data: {
          orderNumber: `OUT-SEC05-E1-${testRunId}`,
          eventId: event1.id,
          status: 'COMPLETED',
          customerName: 'Event 1 Buyer',
          customerEmail: `buyer1_${testRunId}@outside.vip`,
          totalInCents: 5000,
          platformFeeInCents: 500,
          organizerNetInCents: 4500,
          idempotencyKey: `idem_sec05_e1_${testRunId}`,
          expiresAt: new Date(Date.now() + 3600000),
          items: {
            create: [
              {
                ticketTierId: tierEvent1Id,
                quantity: 1,
                unitPriceInCents: 5000,
                subtotalInCents: 5000,
              },
            ],
          },
        },
      });
      orderEvent1Id = ord1.id;

      const ord2 = await prisma.order.create({
        data: {
          orderNumber: `OUT-SEC05-E2-${testRunId}`,
          eventId: event2.id,
          status: 'COMPLETED',
          customerName: 'Event 2 Buyer',
          customerEmail: `buyer2_${testRunId}@outside.vip`,
          totalInCents: 8000,
          platformFeeInCents: 800,
          organizerNetInCents: 7200,
          idempotencyKey: `idem_sec05_e2_${testRunId}`,
          expiresAt: new Date(Date.now() + 3600000),
          items: {
            create: [
              {
                ticketTierId: tierEvent2Id,
                quantity: 1,
                unitPriceInCents: 8000,
                subtotalInCents: 8000,
              },
            ],
          },
        },
      });
      orderEvent2Id = ord2.id;
    });

    afterAll(async () => {
      // Clean up orders, tiers, series, and payout details created in this block before top-level teardown
      await prisma.orderItem.deleteMany({
        where: { orderId: { in: [orderEvent1Id, orderEvent2Id].filter(Boolean) } },
      });
      await prisma.order.deleteMany({
        where: { id: { in: [orderEvent1Id, orderEvent2Id].filter(Boolean) } },
      });
      await prisma.ticketTier.deleteMany({
        where: { eventId: { in: createdEventIds } },
      });
      await prisma.event.updateMany({
        where: { id: { in: createdEventIds } },
        data: { payoutDetailsId: null, seriesId: null },
      });
      if (sec03SeriesId) {
        await prisma.eventSeries.deleteMany({ where: { id: sec03SeriesId } });
      }
      await prisma.organizerPayoutDetails.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
    });

    // =========================================================================
    // SEC-01: Prevent Event Admin Privilege Escalation
    // =========================================================================
    describe('SEC-01: Event Admin Privilege Escalation Prevention', () => {
      it('forbids Event Admin from modifying their own permissions or role', async () => {
        const res = await request(app)
          .patch(`/api/events/${event1.id}/team/members/${teamMgrMemberId}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            role: 'ADMIN',
            permissions: {
              canEditDetails: true,
              canManageTickets: true,
              canViewOrders: true,
              canManageTeam: true,
              canCancelEvent: true,
              canDeleteEvent: true,
            },
          })
          .expect(403);

        expect(res.body.error.message).toContain('cannot update their own membership');

        const dbMember = await prisma.eventTeamMember.findUnique({ where: { id: teamMgrMemberId } });
        expect((dbMember?.permissions as any)?.canDeleteEvent).toBe(false);
        expect((dbMember?.permissions as any)?.canCancelEvent).toBe(false);
      });

      it('forbids Event Admin from revoking their own membership', async () => {
        const res = await request(app)
          .delete(`/api/events/${event1.id}/team/members/${teamMgrMemberId}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .expect(403);

        expect(res.body.error.message).toContain('cannot revoke their own membership');

        const dbMember = await prisma.eventTeamMember.findUnique({ where: { id: teamMgrMemberId } });
        expect(dbMember?.status).toBe(TeamMemberStatus.ACTIVE);
      });

      it('forbids Event Admin from modifying or revoking another Event Admin', async () => {
        await request(app)
          .patch(`/api/events/${event1.id}/team/members/${peerAdminMemberId}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            role: 'HOST',
          })
          .expect(403);

        await request(app)
          .delete(`/api/events/${event1.id}/team/members/${peerAdminMemberId}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .expect(403);

        const dbPeer = await prisma.eventTeamMember.findUnique({ where: { id: peerAdminMemberId } });
        expect(dbPeer?.role).toBe(EventTeamRole.ADMIN);
        expect(dbPeer?.status).toBe(TeamMemberStatus.ACTIVE);
      });

      it('forbids Event Admin from granting permissions they do not personally hold when updating a member', async () => {
        // teamMgrAdmin does NOT hold canDeleteEvent or canCancelEvent
        const res = await request(app)
          .patch(`/api/events/${event1.id}/team/members/${sec01HostMemberId}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            role: 'ADMIN',
            permissions: {
              canEditDetails: true,
              canDeleteEvent: true,
            },
          })
          .expect(403);

        expect(res.body.error.message).toContain("cannot grant the 'canDeleteEvent' permission");

        const dbHost = await prisma.eventTeamMember.findUnique({ where: { id: sec01HostMemberId } });
        expect(dbHost?.role).toBe(EventTeamRole.HOST);
      });

      it('forbids Event Admin from inviting another Event Admin with permissions exceeding their own', async () => {
        const res = await request(app)
          .post(`/api/events/${event1.id}/team/invitations`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            email: `escalated_invite_${testRunId}@outside.vip`,
            role: 'ADMIN',
            permissions: {
              canEditDetails: true,
              canCancelEvent: true, // teamMgrAdmin lacks canCancelEvent
            },
          })
          .expect(403);

        expect(res.body.error.message).toContain("cannot grant the 'canCancelEvent' permission");
      });

      it('preserves Event Admin management of Hosts and subset-permission invitations, and preserves Event Owner full control', async () => {
        // 1. Event Admin with canManageTeam can invite a Host
        await request(app)
          .post(`/api/events/${event1.id}/team/invitations`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            email: `valid_host_by_admin_${testRunId}@outside.vip`,
            role: 'HOST',
          })
          .expect(201);

        // 2. Event Admin with canManageTeam can invite an Admin with permissions within their own ceiling
        await request(app)
          .post(`/api/events/${event1.id}/team/invitations`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            email: `valid_subadmin_${testRunId}@outside.vip`,
            role: 'ADMIN',
            permissions: {
              canEditDetails: true,
            },
          })
          .expect(201);

        // 3. Event Owner retains full control to modify any Event Admin's permissions
        const ownerRes = await request(app)
          .patch(`/api/events/${event1.id}/team/members/${peerAdminMemberId}`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .send({
            role: 'ADMIN',
            permissions: {
              canEditDetails: true,
              canViewOrders: true,
              canCancelEvent: true,
              canDeleteEvent: true,
            },
          })
          .expect(200);

        expect((ownerRes.body.member.permissions as any).canDeleteEvent).toBe(true);
      });
    });

    // =========================================================================
    // SEC-02: Enforce Owner-Only Payout Details
    // =========================================================================
    describe('SEC-02: Owner-Only Payout Details Enforcement', () => {
      const ownerPayoutPayload = {
        orgType: 'Company',
        registeredName: 'Outside Events Group Ltd',
        registrationNumber: 'PVT-2026-001',
        country: 'Kenya',
        address: 'Westlands Commercial Center',
        contactPersonName: 'Stage 2 Organizer',
        contactEmail: 'finance@outside.vip',
        accountHolderName: 'Outside Events Group Ltd',
        bankName: 'Equity Bank Kenya',
        bankCountry: 'Kenya',
        accountCurrency: 'USD',
        accountNumber: '123456789012',
        confirmAccountNumber: '123456789012',
        swiftBic: 'EQBLKENA',
      };

      it('allows Event Owner to submit and update payout details on their event', async () => {
        const res = await request(app)
          .put(`/api/organizer/events/${event1.id}`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .send({
            title: event1.title,
            payoutDetails: ownerPayoutPayload,
          })
          .expect(200);

        expect(res.body.data.event.payoutDetails).not.toBeNull();
        expect(res.body.data.event.payoutDetails.registeredName).toBe('Outside Events Group Ltd');
        expect(res.body.data.event.payoutDetails.accountNumberMasked).toContain('9012');
        expect(res.body.data.event.payoutDetails.accountNumberEncrypted).toBeUndefined();
      });

      it('rejects Event Admin submitting payoutDetails (valid, null, or empty) with 403 Forbidden and preserves owner payout association', async () => {
        const beforeEvent = await prisma.event.findUnique({ where: { id: event1.id } });
        expect(beforeEvent?.payoutDetailsId).not.toBeNull();

        // 1. Attempt to overwrite with Admin's own payout details
        await request(app)
          .put(`/api/organizer/events/${event1.id}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            title: event1.title,
            payoutDetails: {
              ...ownerPayoutPayload,
              registeredName: 'Attacker Hijacked LLC',
              accountHolderName: 'Attacker Hijacked LLC',
              accountNumber: '999988887777',
              confirmAccountNumber: '999988887777',
            },
          })
          .expect(403);

        // 2. Attempt with payoutDetails: null
        await request(app)
          .patch(`/api/organizer/events/${event1.id}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            payoutDetails: null,
          })
          .expect(403);

        // 3. Attempt with payoutDetailsId
        await request(app)
          .patch(`/api/organizer/events/${event1.id}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            payoutDetailsId: 'malicious-id',
          })
          .expect(403);

        const afterEvent = await prisma.event.findUnique({ where: { id: event1.id } });
        expect(afterEvent?.payoutDetailsId).toBe(beforeEvent?.payoutDetailsId);
      });

      it('returns payoutDetails: null in ordinary event-update responses for Event Admins', async () => {
        const res = await request(app)
          .patch(`/api/organizer/events/${event1.id}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            tagline: 'Admin Updated Tagline Safely',
          })
          .expect(200);

        expect(res.body.data.event.tagline).toBe('Admin Updated Tagline Safely');
        expect(res.body.data.event.payoutDetails).toBeNull();
      });
    });

    // =========================================================================
    // SEC-03: Enforce Event Lifecycle Permissions
    // =========================================================================
    describe('SEC-03: Event Lifecycle Status Transition Authorization', () => {
      it('forbids Event Admin with canEditDetails from publishing a DRAFT event via updateOrganizerEvent', async () => {
        await request(app)
          .patch(`/api/organizer/events/${sec03DraftEvent.id}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            status: 'PUBLISHED',
          })
          .expect(403);

        const dbEvt = await prisma.event.findUnique({ where: { id: sec03DraftEvent.id } });
        expect(dbEvt?.status).toBe('DRAFT');
      });

      it('allows Event Owner to publish event and forbids Event Admin from unpublishing back to DRAFT', async () => {
        await request(app)
          .patch(`/api/organizer/events/${sec03DraftEvent.id}`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .send({
            status: 'PUBLISHED',
          })
          .expect(200);

        const publishedEvt = await prisma.event.findUnique({ where: { id: sec03DraftEvent.id } });
        expect(publishedEvt?.status).toBe('PUBLISHED');

        // Event Admin cannot unpublish back to DRAFT via update endpoint
        await request(app)
          .patch(`/api/organizer/events/${sec03DraftEvent.id}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            status: 'DRAFT',
          })
          .expect(403);
      });

      it('forbids Event Admin without canCancelEvent from changing status to CANCELLED', async () => {
        await request(app)
          .patch(`/api/organizer/events/${sec03DraftEvent.id}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            status: 'CANCELLED',
          })
          .expect(403);

        const dbEvt = await prisma.event.findUnique({ where: { id: sec03DraftEvent.id } });
        expect(dbEvt?.status).toBe('PUBLISHED');
      });

      it('forbids Event Admin with only canEditDetails from changing status to ARCHIVED', async () => {
        await request(app)
          .patch(`/api/organizer/events/${sec03DraftEvent.id}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            status: 'ARCHIVED',
          })
          .expect(403);

        const dbEvt = await prisma.event.findUnique({ where: { id: sec03DraftEvent.id } });
        expect(dbEvt?.status).toBe('PUBLISHED');
      });

      it('enforces lifecycle permissions across future series occurrences when applyToFuture is true', async () => {
        // Attempt to cancel or unpublish future series occurrences via applyToFuture without permission
        await request(app)
          .patch(`/api/organizer/events/${sec03SeriesOcc1.id}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            status: 'CANCELLED',
            applyToFuture: true,
          })
          .expect(403);

        await request(app)
          .patch(`/api/organizer/events/${sec03SeriesOcc1.id}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            status: 'DRAFT',
            applyToFuture: true,
          })
          .expect(403);

        const occ2 = await prisma.event.findUnique({ where: { id: sec03SeriesOcc2.id } });
        expect(occ2?.status).toBe('PUBLISHED');
      });

      it('allows Event Admin with canCancelEvent: true to transition status to CANCELLED', async () => {
        // peerAdminUser has canEditDetails: true and canCancelEvent: true on sec03DraftEvent
        await prisma.eventTeamMember.create({
          data: {
            eventId: sec03DraftEvent.id,
            userId: peerAdminUser.id,
            role: EventTeamRole.ADMIN,
            status: TeamMemberStatus.ACTIVE,
            permissions: {
              canEditDetails: true,
              canCancelEvent: true,
            },
            invitedById: organizerUser.id,
          },
        });

        await request(app)
          .patch(`/api/organizer/events/${sec03DraftEvent.id}`)
          .set('Cookie', peerAdminAuth.cookie)
          .set('x-csrf-token', peerAdminAuth.csrf)
          .send({
            status: 'CANCELLED',
          })
          .expect(200);

        const dbEvt = await prisma.event.findUnique({ where: { id: sec03DraftEvent.id } });
        expect(dbEvt?.status).toBe('CANCELLED');
      });
    });

    // =========================================================================
    // SEC-04: Prevent Cross-Event Ticket-Tier Updates (IDOR)
    // =========================================================================
    describe('SEC-04: Cross-Event Ticket-Tier IDOR Prevention', () => {
      it('rejects foreign tier ID from Event 2 when updating Event 1 and leaves Event 2 tier untouched', async () => {
        await request(app)
          .put(`/api/organizer/events/${event1.id}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            ticketTiers: [
              {
                id: tierEvent2Id, // Belongs to event2!
                name: 'Hijacked Foreign Tier',
                priceInCents: 0,
                totalCapacity: 999,
              },
            ],
          })
          .expect(403);

        const foreignTier = await prisma.ticketTier.findUnique({ where: { id: tierEvent2Id } });
        expect(foreignTier?.name).toBe('Event 2 Foreign Tier');
        expect(foreignTier?.priceInCents).toBe(8000);
        expect(foreignTier?.totalCapacity).toBe(200);
      });

      it('causes zero partial writes when a mixed local and foreign tier payload is submitted', async () => {
        await request(app)
          .put(`/api/organizer/events/${event1.id}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            ticketTiers: [
              {
                id: tierEvent1Id, // Valid local tier
                name: 'Should Not Persist Local Update',
                priceInCents: 1234,
                totalCapacity: 50,
              },
              {
                id: tierEvent2Id, // Foreign tier from event2
                name: 'Hijacked Foreign Tier',
                priceInCents: 0,
                totalCapacity: 999,
              },
            ],
          })
          .expect(403);

        const localTier = await prisma.ticketTier.findUnique({ where: { id: tierEvent1Id } });
        expect(localTier?.name).toBe('Event 1 Local Tier');
        expect(localTier?.priceInCents).toBe(5000);
        expect(localTier?.totalCapacity).toBe(100);

        const foreignTier = await prisma.ticketTier.findUnique({ where: { id: tierEvent2Id } });
        expect(foreignTier?.name).toBe('Event 2 Foreign Tier');
        expect(foreignTier?.priceInCents).toBe(8000);
      });

      it('allows legitimate local ticket tier updates for the target event', async () => {
        const res = await request(app)
          .put(`/api/organizer/events/${event1.id}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .set('x-csrf-token', teamMgrAdminAuth.csrf)
          .send({
            ticketTiers: [
              {
                id: tierEvent1Id,
                name: 'Event 1 Local Tier Updated',
                priceInCents: 0,
                totalCapacity: 120,
              },
            ],
          })
          .expect(200);

        const updatedTier = res.body.data.event.ticketTiers.find((t: any) => t.id === tierEvent1Id);
        expect(updatedTier).toBeDefined();
        expect(updatedTier.name).toBe('Event 1 Local Tier Updated');
        expect(updatedTier.priceInCents).toBe(0);
        expect(updatedTier.totalCapacity).toBe(120);
      });
    });

    // =========================================================================
    // SEC-05: Repair Event Admin Order Access (canViewOrders)
    // =========================================================================
    describe('SEC-05: Event Admin Order Access & Scoping (Live DB)', () => {
      it('allows ATTENDEE-role Event Admin with canViewOrders: true to retrieve orders for their assigned event', async () => {
        // peerAdminUser has global role ATTENDEE and canViewOrders: true on event1
        const res = await request(app)
          .get(`/api/organizer/orders?eventId=${event1.id}`)
          .set('Cookie', peerAdminAuth.cookie)
          .expect(200);

        expect(res.body.success).toBe(true);
        const orderNumbers = res.body.data.orders.map((o: any) => o.orderNumber);
        expect(orderNumbers).toContain(`OUT-SEC05-E1-${testRunId}`);
        expect(orderNumbers).not.toContain(`OUT-SEC05-E2-${testRunId}`);
      });

      it('allows ORGANIZER-role Event Admin with canViewOrders: true to retrieve orders for an assigned event owned by another organizer', async () => {
        // orgRoleAdminUser has global role ORGANIZER and canViewOrders: true on event1 (owned by organizerUser)
        const res = await request(app)
          .get(`/api/organizer/orders?eventId=${event1.id}`)
          .set('Cookie', orgRoleAdminAuth.cookie)
          .expect(200);

        expect(res.body.success).toBe(true);
        const orderNumbers = res.body.data.orders.map((o: any) => o.orderNumber);
        expect(orderNumbers).toContain(`OUT-SEC05-E1-${testRunId}`);
      });

      it('rejects Event Admin with canViewOrders: false with 403 Forbidden', async () => {
        // teamMgrAdminUser has canViewOrders: false on event1
        await request(app)
          .get(`/api/organizer/orders?eventId=${event1.id}`)
          .set('Cookie', teamMgrAdminAuth.cookie)
          .expect(403);
      });

      it('rejects Event Admin attempting to access orders for an unassigned event with 403 Forbidden', async () => {
        // peerAdminUser is not a member of event2
        await request(app)
          .get(`/api/organizer/orders?eventId=${event2.id}`)
          .set('Cookie', peerAdminAuth.cookie)
          .expect(403);
      });

      it('scopes requests without eventId for Event Admin strictly to events where they hold active ADMIN membership with canViewOrders: true', async () => {
        const res = await request(app)
          .get('/api/organizer/orders')
          .set('Cookie', peerAdminAuth.cookie)
          .expect(200);

        const orderNumbers = res.body.data.orders.map((o: any) => o.orderNumber);
        expect(orderNumbers).toContain(`OUT-SEC05-E1-${testRunId}`);
        expect(orderNumbers).not.toContain(`OUT-SEC05-E2-${testRunId}`);
      });

      it('preserves Event Owner and global Platform ADMIN order access', async () => {
        // Event Owner
        const ownerRes = await request(app)
          .get(`/api/organizer/orders?eventId=${event1.id}`)
          .set('Cookie', organizerAuth.cookie)
          .expect(200);
        expect(ownerRes.body.data.orders.map((o: any) => o.orderNumber)).toContain(
          `OUT-SEC05-E1-${testRunId}`
        );

        // Global Platform ADMIN
        const adminRes = await request(app)
          .get(`/api/organizer/orders?eventId=${event2.id}`)
          .set('Cookie', globalAdminAuth.cookie)
          .expect(200);
        expect(adminRes.body.data.orders.map((o: any) => o.orderNumber)).toContain(
          `OUT-SEC05-E2-${testRunId}`
        );
      });
    });
  });

  // ===========================================================================
  // 10. Stage 6 Implementation 2.2: P1 Security Remediation (SEC-06, SEC-07, SEC-08, SEC-09, SEC-11)
  // ===========================================================================
  describe('10. Stage 6 Implementation 2.2: P1 Security Remediation (SEC-06, SEC-07, SEC-08, SEC-09, SEC-11)', () => {
    // =========================================================================
    // SEC-06: Prevent Raw Invitation Token Exposure
    // =========================================================================
    describe('SEC-06: Invitation Token Exposure Prevention', () => {
      it('omits raw token from POST /api/events/:eventId/team/invitations and POST .../resend responses while delivering valid token via email', async () => {
        const recipientUser = await prisma.user.create({
          data: {
            email: `sec06_recipient_${testRunId}@outside.vip`,
            name: 'SEC-06 Recipient',
            role: 'ATTENDEE',
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        });
        createdUserIds.push(recipientUser.id);
        const recipientAuth = await createAuth(recipientUser.id);

        // 1. Invite member -> response MUST NOT contain token
        const inviteRes = await request(app)
          .post(`/api/events/${event1.id}/team/invitations`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .send({
            email: recipientUser.email,
            role: 'HOST',
          })
          .expect(201);

        expect(inviteRes.body.success).toBe(true);
        expect(inviteRes.body.invitation).toBeDefined();
        expect(inviteRes.body.invitation.token).toBeUndefined();
        expect('token' in inviteRes.body.invitation).toBe(false);

        const firstEmail = sentTeamInvitationEmails
          .slice()
          .reverse()
          .find((e) => e.to === recipientUser.email.toLowerCase());
        expect(firstEmail).toBeDefined();
        const firstToken = firstEmail!.inviteUrl.split('/').pop()!;
        expect(firstToken).toMatch(/^[a-f0-9]{64}$/);

        // 2. Resend invitation -> response MUST NOT contain token
        const resendRes = await request(app)
          .post(`/api/events/${event1.id}/team/invitations/${inviteRes.body.invitation.id}/resend`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .expect(200);

        expect(resendRes.body.success).toBe(true);
        expect(resendRes.body.invitation).toBeDefined();
        expect(resendRes.body.invitation.token).toBeUndefined();
        expect('token' in resendRes.body.invitation).toBe(false);

        const secondEmail = sentTeamInvitationEmails
          .slice()
          .reverse()
          .find((e) => e.to === recipientUser.email.toLowerCase());
        expect(secondEmail).toBeDefined();
        const rotatedToken = secondEmail!.inviteUrl.split('/').pop()!;
        expect(rotatedToken).toMatch(/^[a-f0-9]{64}$/);
        expect(rotatedToken).not.toBe(firstToken);

        // 3. Inspection and acceptance via the emailed token continue to succeed
        const inspectRes = await request(app)
          .get(`/api/team/invitations/${rotatedToken}`)
          .expect(200);
        expect(inspectRes.body.invitation.status).toBe('PENDING');

        const acceptRes = await request(app)
          .post(`/api/team/invitations/${rotatedToken}/accept`)
          .set('Cookie', recipientAuth.cookie)
          .set('x-csrf-token', recipientAuth.csrf)
          .expect(200);
        expect(acceptRes.body.membership.role).toBe('HOST');
        expect(acceptRes.body.membership.status).toBe('ACTIVE');
      });
    });

    // =========================================================================
    // SEC-07: Explicitly Deny Hosts Access to Organizer Event Details
    // =========================================================================
    describe('SEC-07: Host Access to Organizer Event Details Denied', () => {
      it('rejects active Event Host calling GET /api/organizer/events/:id with 403 Forbidden', async () => {
        // Ensure hostUser is an active HOST on event1
        await prisma.eventTeamMember.updateMany({
          where: { eventId: event1.id, userId: hostUser.id },
          data: { role: EventTeamRole.HOST, status: TeamMemberStatus.ACTIVE },
        });

        const res = await request(app)
          .get(`/api/organizer/events/${event1.id}`)
          .set('Cookie', hostAuth.cookie)
          .expect(403);

        expect(res.body.error.message).toMatch(/Event hosts are restricted|permission/i);
      });

      it('allows active Event Admin calling GET /api/organizer/events/:id with 200 OK', async () => {
        const res = await request(app)
          .get(`/api/organizer/events/${event1.id}`)
          .set('Cookie', adminAuth.cookie)
          .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.data.event.id).toBe(event1.id);
      });

      it('allows Event Owner calling GET /api/organizer/events/:id with 200 OK', async () => {
        const res = await request(app)
          .get(`/api/organizer/events/${event1.id}`)
          .set('Cookie', organizerAuth.cookie)
          .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.data.event.id).toBe(event1.id);
      });

      it('rejects non-member user calling GET /api/organizer/events/:id with 403 Forbidden', async () => {
        await request(app)
          .get(`/api/organizer/events/${event1.id}`)
          .set('Cookie', outsiderAuth.cookie)
          .expect(403);
      });

      it('rejects revoked or suspended Event Admin calling GET /api/organizer/events/:id with 403 Forbidden', async () => {
        const tempAdminUser = await prisma.user.create({
          data: {
            email: `sec07_revoked_admin_${testRunId}@outside.vip`,
            name: 'SEC-07 Revoked Admin',
            role: 'ATTENDEE',
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        });
        createdUserIds.push(tempAdminUser.id);
        const tempAdminAuth = await createAuth(tempAdminUser.id);

        const tempMember = await prisma.eventTeamMember.create({
          data: {
            eventId: event1.id,
            userId: tempAdminUser.id,
            role: EventTeamRole.ADMIN,
            status: TeamMemberStatus.INACTIVE,
            permissions: { canEditDetails: true },
            invitedById: organizerUser.id,
          },
        });

        await request(app)
          .get(`/api/organizer/events/${event1.id}`)
          .set('Cookie', tempAdminAuth.cookie)
          .expect(403);

        await prisma.eventTeamMember.update({
          where: { id: tempMember.id },
          data: { status: TeamMemberStatus.REVOKED },
        });

        await request(app)
          .get(`/api/organizer/events/${event1.id}`)
          .set('Cookie', tempAdminAuth.cookie)
          .expect(403);
      });
    });

    // =========================================================================
    // SEC-08: Correct PromotionVisitorDay Click Counter Consistency
    // =========================================================================
    describe('SEC-08: PromotionVisitorDay Click Counter Consistency', () => {
      it('does not increment PromotionVisitorDay.clickCount on duplicate or concurrent clicks within 15 minutes, and increments after dedup expiration', async () => {
        const sec08Slug = `sec08-promo-${testRunId}`;
        const createLinkRes = await request(app)
          .post(`/api/events/${event1.id}/promotions/links`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .send({
            name: 'SEC-08 Campaign Link',
            slug: sec08Slug,
          })
          .expect(201);

        const sec08LinkId = createLinkRes.body.link.id;
        const rawVid = `vid_sec08_${testRunId}_123456`;
        const canonicalId = deriveCanonicalVisitorId(rawVid);
        const todayUtc = new Date(
          Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())
        );

        // 1. First click -> creates 1 PromotionClick and sets PromotionVisitorDay.clickCount = 1
        await request(app)
          .get(`/r/${sec08Slug}`)
          .set('Cookie', `${VISITOR_COOKIE_NAME}=${rawVid}`)
          .expect(302);

        let clickRows = await prisma.promotionClick.count({
          where: { promotionLinkId: sec08LinkId, canonicalVisitorId: canonicalId },
        });
        let visitorDay = await prisma.promotionVisitorDay.findUnique({
          where: {
            promotionLinkId_canonicalVisitorId_visitDate: {
              promotionLinkId: sec08LinkId,
              canonicalVisitorId: canonicalId,
              visitDate: todayUtc,
            },
          },
        });
        expect(clickRows).toBe(1);
        expect(visitorDay?.clickCount).toBe(1);

        // 2. Duplicate click within 15 minutes -> neither PromotionClick nor PromotionVisitorDay.clickCount increments
        await request(app)
          .get(`/r/${sec08Slug}`)
          .set('Cookie', `${VISITOR_COOKIE_NAME}=${rawVid}`)
          .expect(302);

        clickRows = await prisma.promotionClick.count({
          where: { promotionLinkId: sec08LinkId, canonicalVisitorId: canonicalId },
        });
        visitorDay = await prisma.promotionVisitorDay.findUnique({
          where: {
            promotionLinkId_canonicalVisitorId_visitDate: {
              promotionLinkId: sec08LinkId,
              canonicalVisitorId: canonicalId,
              visitDate: todayUtc,
            },
          },
        });
        expect(clickRows).toBe(1);
        expect(visitorDay?.clickCount).toBe(1);

        // 3. Concurrent duplicate clicks within 15 minutes -> still 1
        await Promise.all(
          Array.from({ length: 4 }, () =>
            request(app)
              .get(`/r/${sec08Slug}`)
              .set('Cookie', `${VISITOR_COOKIE_NAME}=${rawVid}`)
              .expect(302)
          )
        );

        clickRows = await prisma.promotionClick.count({
          where: { promotionLinkId: sec08LinkId, canonicalVisitorId: canonicalId },
        });
        visitorDay = await prisma.promotionVisitorDay.findUnique({
          where: {
            promotionLinkId_canonicalVisitorId_visitDate: {
              promotionLinkId: sec08LinkId,
              canonicalVisitorId: canonicalId,
              visitDate: todayUtc,
            },
          },
        });
        expect(clickRows).toBe(1);
        expect(visitorDay?.clickCount).toBe(1);

        // Verify unique visitor count and 30-day attribution remain intact
        const uniqueVisitors = await prisma.promotionVisitorDay.count({
          where: { promotionLinkId: sec08LinkId },
        });
        expect(uniqueVisitors).toBe(1);

        const attr = await prisma.promotionVisitorAttribution.findUnique({
          where: {
            canonicalVisitorId_eventId: {
              canonicalVisitorId: canonicalId,
              eventId: event1.id,
            },
          },
        });
        expect(attr?.promotionLinkId).toBe(sec08LinkId);

        // 4. Simulate 15-minute deduplication window expiration -> next click increments both to 2
        const redis = getRedisClient();
        await redis.del(`click_dedup:${canonicalId}:${sec08LinkId}`);

        await request(app)
          .get(`/r/${sec08Slug}`)
          .set('Cookie', `${VISITOR_COOKIE_NAME}=${rawVid}`)
          .expect(302);

        clickRows = await prisma.promotionClick.count({
          where: { promotionLinkId: sec08LinkId, canonicalVisitorId: canonicalId },
        });
        visitorDay = await prisma.promotionVisitorDay.findUnique({
          where: {
            promotionLinkId_canonicalVisitorId_visitDate: {
              promotionLinkId: sec08LinkId,
              canonicalVisitorId: canonicalId,
              visitDate: todayUtc,
            },
          },
        });
        expect(clickRows).toBe(2);
        expect(visitorDay?.clickCount).toBe(2);
      });
    });

    // =========================================================================
    // SEC-09: Fix Host-to-Admin Invitation Acceptance Lifecycle
    // =========================================================================
    describe('SEC-09: Host-to-Admin Invitation Acceptance Lifecycle', () => {
      it('transitions an INACTIVE Host with a DISABLED personal link to ADMIN upon invitation acceptance without trigger failure, archiving personal link and preserving history', async () => {
        const sec09User = await prisma.user.create({
          data: {
            email: `sec09_host_to_admin_${testRunId}@outside.vip`,
            name: 'SEC-09 Host To Admin',
            role: 'ATTENDEE',
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        });
        createdUserIds.push(sec09User.id);
        const sec09Auth = await createAuth(sec09User.id);

        // 1. Invite and accept as HOST
        await request(app)
          .post(`/api/events/${event1.id}/team/invitations`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .send({ email: sec09User.email, role: 'HOST' })
          .expect(201);

        const hostInviteEmail = sentTeamInvitationEmails
          .slice()
          .reverse()
          .find((e) => e.to === sec09User.email.toLowerCase());
        const hostInviteToken = hostInviteEmail!.inviteUrl.split('/').pop()!;

        const hostAcceptRes = await request(app)
          .post(`/api/team/invitations/${hostInviteToken}/accept`)
          .set('Cookie', sec09Auth.cookie)
          .set('x-csrf-token', sec09Auth.csrf)
          .expect(200);

        const memberId = hostAcceptRes.body.membership.memberId;
        const hostLinkId = hostAcceptRes.body.membership.hostLink.id;
        const initialSlug = hostAcceptRes.body.membership.hostLink.slug;

        // Customize slug to create historical alias and record a click
        const customSlug = `sec09-custom-${testRunId}`;
        await request(app)
          .patch(`/api/host/events/${event1.id}/slug`)
          .set('Cookie', sec09Auth.cookie)
          .set('x-csrf-token', sec09Auth.csrf)
          .send({ slug: customSlug })
          .expect(200);

        await request(app)
          .get(`/r/${customSlug}`)
          .set('Cookie', `${VISITOR_COOKIE_NAME}=vid_sec09_history_${testRunId}`)
          .expect(302);

        // 2. Organizer sets Host membership to INACTIVE (which disables their personal link to DISABLED)
        await request(app)
          .patch(`/api/events/${event1.id}/team/members/${memberId}`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .send({ status: 'INACTIVE' })
          .expect(200);

        const disabledLink = await prisma.promotionLink.findUnique({ where: { id: hostLinkId } });
        expect(disabledLink?.status).toBe('DISABLED');

        // 3. Organizer invites the inactive user as Event Admin
        await request(app)
          .post(`/api/events/${event1.id}/team/invitations`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .send({
            email: sec09User.email,
            role: 'ADMIN',
            permissions: {
              canEditDetails: true,
              canViewAnalytics: true,
            },
          })
          .expect(201);

        const adminInviteEmail = sentTeamInvitationEmails
          .slice()
          .reverse()
          .find((e) => e.to === sec09User.email.toLowerCase());
        const adminInviteToken = adminInviteEmail!.inviteUrl.split('/').pop()!;

        // 4. User accepts the ADMIN invitation -> succeeds cleanly without trg_protect_host_membership_mutation error
        const adminAcceptRes = await request(app)
          .post(`/api/team/invitations/${adminInviteToken}/accept`)
          .set('Cookie', sec09Auth.cookie)
          .set('x-csrf-token', sec09Auth.csrf)
          .expect(200);

        expect(adminAcceptRes.body.success).toBe(true);
        expect(adminAcceptRes.body.membership.memberId).toBe(memberId);
        expect(adminAcceptRes.body.membership.role).toBe('ADMIN');
        expect(adminAcceptRes.body.membership.status).toBe('ACTIVE');

        // 5. Verify DB state: member is ACTIVE ADMIN, personal Host link is ARCHIVED, historical aliases & clicks preserved
        const updatedMember = await prisma.eventTeamMember.findUnique({ where: { id: memberId } });
        expect(updatedMember?.role).toBe(EventTeamRole.ADMIN);
        expect(updatedMember?.status).toBe(TeamMemberStatus.ACTIVE);
        expect((updatedMember?.permissions as any)?.canEditDetails).toBe(true);
        expect((updatedMember?.permissions as any)?.canViewAnalytics).toBe(true);

        const archivedLink = await prisma.promotionLink.findUnique({
          where: { id: hostLinkId },
          include: { slugRegistry: true },
        });
        expect(archivedLink?.status).toBe('ARCHIVED');
        const slugs = archivedLink?.slugRegistry.map((s) => s.slug) || [];
        expect(slugs).toContain(initialSlug);
        expect(slugs).toContain(customSlug);

        const clickHistoryCount = await prisma.promotionClick.count({
          where: { promotionLinkId: hostLinkId },
        });
        expect(clickHistoryCount).toBe(1);
      });
    });

    // =========================================================================
    // SEC-11: Prevent Promotional Analytics Foreign-Key Failures During Event Deletion
    // =========================================================================
    describe('SEC-11: Promotional Analytics Protection During Event Deletion', () => {
      it('rejects deleting an event with existing promotional links or analytics with 409 Conflict instead of 500 P2003, while preserving authorization and clean-event deletion', async () => {
        // 1. Create an event with a promotional link and recorded click
        const eventWithPromos = await prisma.event.create({
          data: {
            organizerId: organizerUser.id,
            title: `SEC-11 Promo Protected Event ${testRunId}`,
            slug: `sec11-promo-event-${testRunId}`,
            description: 'Event with promotional history',
            category: 'MUSIC',
            venueName: 'SEC-11 Arena',
            venueAddress: '11 Security Way',
            city: 'Nairobi',
            startAt: new Date(Date.now() + 86400000 * 20),
            endAt: new Date(Date.now() + 86400000 * 21),
            coverImageUrl: 'https://outside.vip/sec11.jpg',
            status: 'DRAFT',
          },
        });
        createdEventIds.push(eventWithPromos.id);

        const promoSlug = `sec11-camp-${testRunId}`;
        const linkRes = await request(app)
          .post(`/api/events/${eventWithPromos.id}/promotions/links`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .send({
            name: 'SEC-11 Launch Campaign',
            slug: promoSlug,
          })
          .expect(201);
        const promoLinkId = linkRes.body.link.id;

        await request(app)
          .get(`/r/${promoSlug}`)
          .set('Cookie', `${VISITOR_COOKIE_NAME}=vid_sec11_${testRunId}`)
          .expect(302);

        // 2. Grant an Event Admin without canDeleteEvent and another with canDeleteEvent
        const noDeleteAdmin = await prisma.user.create({
          data: {
            email: `sec11_nodelete_admin_${testRunId}@outside.vip`,
            name: 'No Delete Admin',
            role: 'ATTENDEE',
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        });
        createdUserIds.push(noDeleteAdmin.id);
        const noDeleteAdminAuth = await createAuth(noDeleteAdmin.id);

        await prisma.eventTeamMember.create({
          data: {
            eventId: eventWithPromos.id,
            userId: noDeleteAdmin.id,
            role: EventTeamRole.ADMIN,
            status: TeamMemberStatus.ACTIVE,
            permissions: { canEditDetails: true, canDeleteEvent: false },
            invitedById: organizerUser.id,
          },
        });

        const canDeleteAdmin = await prisma.user.create({
          data: {
            email: `sec11_candelete_admin_${testRunId}@outside.vip`,
            name: 'Can Delete Admin',
            role: 'ATTENDEE',
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        });
        createdUserIds.push(canDeleteAdmin.id);
        const canDeleteAdminAuth = await createAuth(canDeleteAdmin.id);

        await prisma.eventTeamMember.create({
          data: {
            eventId: eventWithPromos.id,
            userId: canDeleteAdmin.id,
            role: EventTeamRole.ADMIN,
            status: TeamMemberStatus.ACTIVE,
            permissions: { canDeleteEvent: true },
            invitedById: organizerUser.id,
          },
        });

        // 3. Event Admin with canDeleteEvent: false is rejected with 403 Forbidden first
        await request(app)
          .delete(`/api/organizer/events/${eventWithPromos.id}`)
          .set('Cookie', noDeleteAdminAuth.cookie)
          .set('x-csrf-token', noDeleteAdminAuth.csrf)
          .expect(403);

        // 4. Event Owner attempting to delete event with promotional links receives 409 Conflict (not 500)
        const ownerDelRes = await request(app)
          .delete(`/api/organizer/events/${eventWithPromos.id}`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .expect(409);

        expect(ownerDelRes.body.error.code).toBe('EVENT_HAS_PROMOTIONAL_HISTORY');
        expect(ownerDelRes.body.error.message).toMatch(/unpublish or archive/i);

        // 5. Event Admin with canDeleteEvent: true also receives 409 Conflict when promotional links exist
        const adminDelRes = await request(app)
          .delete(`/api/organizer/events/${eventWithPromos.id}`)
          .set('Cookie', canDeleteAdminAuth.cookie)
          .set('x-csrf-token', canDeleteAdminAuth.csrf)
          .expect(409);

        expect(adminDelRes.body.error.code).toBe('EVENT_HAS_PROMOTIONAL_HISTORY');

        // Verify event, promotional link, slug alias, and click history remain completely intact
        const checkEvent = await prisma.event.findUnique({ where: { id: eventWithPromos.id } });
        expect(checkEvent).not.toBeNull();
        const checkLink = await prisma.promotionLink.findUnique({ where: { id: promoLinkId } });
        expect(checkLink).not.toBeNull();
        const checkClicks = await prisma.promotionClick.count({ where: { promotionLinkId: promoLinkId } });
        expect(checkClicks).toBe(1);

        // 6. Clean event with no orders, tickets, or promotional links can be deleted cleanly (200 OK)
        const cleanEvent = await prisma.event.create({
          data: {
            organizerId: organizerUser.id,
            title: `SEC-11 Clean Deletable Event ${testRunId}`,
            slug: `sec11-clean-event-${testRunId}`,
            description: 'Clean event without promos or orders',
            category: 'MUSIC',
            venueName: 'SEC-11 Clean Venue',
            venueAddress: '12 Clean Way',
            city: 'Nairobi',
            startAt: new Date(Date.now() + 86400000 * 25),
            endAt: new Date(Date.now() + 86400000 * 26),
            coverImageUrl: 'https://outside.vip/sec11-clean.jpg',
            status: 'DRAFT',
          },
        });

        const cleanDelRes = await request(app)
          .delete(`/api/organizer/events/${cleanEvent.id}`)
          .set('Cookie', organizerAuth.cookie)
          .set('x-csrf-token', organizerAuth.csrf)
          .expect(200);

        expect(cleanDelRes.body.success).toBe(true);
        const deletedCheck = await prisma.event.findUnique({ where: { id: cleanEvent.id } });
        expect(deletedCheck).toBeNull();
      });
    });
  });

  // ===========================================================================
  // 11. Stage 6 Implementation 2.3: SEC-10 Rate Limiting & Abuse Protection
  // ===========================================================================
  describe('11. Stage 6 Implementation 2.3: SEC-10 Rate Limiting & Abuse Protection', () => {
    let sec10Organizer: any;
    let sec10OrganizerAuth: { cookie: string; csrf: string };
    let sec10Admin1: any;
    let sec10Admin1Auth: { cookie: string; csrf: string };
    let sec10Admin2: any;
    let sec10Admin2Auth: { cookie: string; csrf: string };
    let sec10Host: any;
    let sec10HostAuth: { cookie: string; csrf: string };
    let sec10Event: any;

    beforeAll(async () => {
      sec10Organizer = await prisma.user.create({
        data: {
          email: `sec10_org_${testRunId}@outside.vip`,
          name: 'SEC-10 Organizer',
          role: 'ORGANIZER',
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(sec10Organizer.id);
      sec10OrganizerAuth = await createAuth(sec10Organizer.id);

      sec10Event = await prisma.event.create({
        data: {
          organizerId: sec10Organizer.id,
          title: `SEC-10 Abuse Protection Event ${testRunId}`,
          slug: `sec10-abuse-event-${testRunId}`,
          description: 'Event for SEC-10 rate limit tests',
          category: 'MUSIC',
          venueName: 'SEC-10 Arena',
          venueAddress: '10 Security Blvd',
          city: 'Nairobi',
          startAt: new Date(Date.now() + 86400000 * 30),
          endAt: new Date(Date.now() + 86400000 * 31),
          coverImageUrl: 'https://outside.vip/sec10.jpg',
          status: 'PUBLISHED',
        },
      });
      createdEventIds.push(sec10Event.id);

      sec10Admin1 = await prisma.user.create({
        data: {
          email: `sec10_admin1_${testRunId}@outside.vip`,
          name: 'SEC-10 Admin 1',
          role: 'ATTENDEE',
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(sec10Admin1.id);
      sec10Admin1Auth = await createAuth(sec10Admin1.id);

      await prisma.eventTeamMember.create({
        data: {
          eventId: sec10Event.id,
          userId: sec10Admin1.id,
          role: EventTeamRole.ADMIN,
          status: TeamMemberStatus.ACTIVE,
          permissions: { canManageTeam: true, canManagePromotions: true },
          invitedById: sec10Organizer.id,
        },
      });

      sec10Admin2 = await prisma.user.create({
        data: {
          email: `sec10_admin2_${testRunId}@outside.vip`,
          name: 'SEC-10 Admin 2',
          role: 'ATTENDEE',
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(sec10Admin2.id);
      sec10Admin2Auth = await createAuth(sec10Admin2.id);

      await prisma.eventTeamMember.create({
        data: {
          eventId: sec10Event.id,
          userId: sec10Admin2.id,
          role: EventTeamRole.ADMIN,
          status: TeamMemberStatus.ACTIVE,
          permissions: { canManageTeam: true, canManagePromotions: true },
          invitedById: sec10Organizer.id,
        },
      });

      sec10Host = await prisma.user.create({
        data: {
          email: `sec10_host_${testRunId}@outside.vip`,
          name: 'SEC-10 Host',
          role: 'ATTENDEE',
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(sec10Host.id);
      sec10HostAuth = await createAuth(sec10Host.id);
    });

    // =========================================================================
    // Part A: Invitation creation rate limiting
    // =========================================================================
    describe('Part A: Invitation Creation Rate Limiting', () => {
      it('does not consume rate-limit quota for unauthorized or invalid invitation requests', async () => {
        const redis = getRedisClient();
        await redis.del(
          `ratelimit:team_invite_create:actor:${sec10Organizer.id}`,
          `ratelimit:team_invite_create:event:${sec10Event.id}`
        );

        // Unauthorized caller (outsiderAuth) attempting to invite on sec10Event -> 403
        await request(app)
          .post(`/api/events/${sec10Event.id}/team/invitations`)
          .set('Cookie', outsiderAuth.cookie)
          .set('x-csrf-token', outsiderAuth.csrf)
          .send({ email: `unauth_${testRunId}@outside.vip`, role: 'HOST' })
          .expect(403);

        // Invalid payload by authorized organizer -> 400
        await request(app)
          .post(`/api/events/${sec10Event.id}/team/invitations`)
          .set('Cookie', sec10OrganizerAuth.cookie)
          .set('x-csrf-token', sec10OrganizerAuth.csrf)
          .send({ email: 'not-an-email', role: 'HOST' })
          .expect(400);

        const actorCount = await redis.get(`ratelimit:team_invite_create:actor:${sec10Organizer.id}`);
        const eventCount = await redis.get(`ratelimit:team_invite_create:event:${sec10Event.id}`);
        expect(actorCount).toBeNull();
        expect(eventCount).toBeNull();
      });

      it('enforces per-actor and per-event hourly invitation creation rate limits with HTTP 429 and Retry-After', async () => {
        const redis = getRedisClient();
        const actorKey = `ratelimit:team_invite_create:actor:${sec10Admin1.id}`;
        const eventKey = `ratelimit:team_invite_create:event:${sec10Event.id}`;
        await redis.del(actorKey, eventKey);

        // Pre-seed actor counter to 1 below limit (19 of 20)
        await redis.setPx(actorKey, String(TEAM_INVITE_CREATE_ACTOR_MAX_PER_HOUR - 1), 3600000);

        // 20th invitation succeeds
        await request(app)
          .post(`/api/events/${sec10Event.id}/team/invitations`)
          .set('Cookie', sec10Admin1Auth.cookie)
          .set('x-csrf-token', sec10Admin1Auth.csrf)
          .send({
            email: `sec10_allowed_20_${testRunId}@outside.vip`,
            role: 'HOST',
          })
          .expect(201);

        // 21st invitation by same actor is rejected with 429 and Retry-After header
        const blockedActorRes = await request(app)
          .post(`/api/events/${sec10Event.id}/team/invitations`)
          .set('Cookie', sec10Admin1Auth.cookie)
          .set('x-csrf-token', sec10Admin1Auth.csrf)
          .send({
            email: `sec10_blocked_21_${testRunId}@outside.vip`,
            role: 'HOST',
          })
          .expect(429);

        expect(blockedActorRes.body.error.code).toBe('TEAM_INVITATION_RATE_LIMIT');
        expect(Number(blockedActorRes.header['retry-after'])).toBeGreaterThan(0);

        // Event-level limit across actors: pre-seed event counter to TEAM_INVITE_CREATE_EVENT_MAX_PER_HOUR (40)
        await redis.setPx(eventKey, String(TEAM_INVITE_CREATE_EVENT_MAX_PER_HOUR), 3600000);

        // Different authorized actor (sec10Admin2) is rejected by event-wide ceiling
        const blockedEventRes = await request(app)
          .post(`/api/events/${sec10Event.id}/team/invitations`)
          .set('Cookie', sec10Admin2Auth.cookie)
          .set('x-csrf-token', sec10Admin2Auth.csrf)
          .send({
            email: `sec10_blocked_evt_${testRunId}@outside.vip`,
            role: 'HOST',
          })
          .expect(429);

        expect(blockedEventRes.body.error.code).toBe('TEAM_INVITATION_RATE_LIMIT');
        expect(Number(blockedEventRes.header['retry-after'])).toBeGreaterThan(0);

        // Clean up counters for subsequent tests
        await redis.del(actorKey, eventKey, `ratelimit:team_invite_create:actor:${sec10Admin2.id}`);
      });
    });

    // =========================================================================
    // Part B: Invitation resend cooldown and rate limiting
    // =========================================================================
    describe('Part B: Invitation Resend Cooldown & Rate Limiting', () => {
      let pendingInviteId: string;

      beforeAll(async () => {
        const res = await request(app)
          .post(`/api/events/${sec10Event.id}/team/invitations`)
          .set('Cookie', sec10OrganizerAuth.cookie)
          .set('x-csrf-token', sec10OrganizerAuth.csrf)
          .send({
            email: `sec10_resend_target_${testRunId}@outside.vip`,
            role: 'HOST',
          })
          .expect(201);
        pendingInviteId = res.body.invitation.id;
      });

      it('enforces atomic 60-second per-invitation resend cooldown under sequential and concurrent requests', async () => {
        const redis = getRedisClient();
        await redis.del(`cooldown:team_invite_resend:inv:${pendingInviteId}`);

        // Fire 4 concurrent resend requests for the same invitation
        const responses = await Promise.all(
          Array.from({ length: 4 }, () =>
            request(app)
              .post(`/api/events/${sec10Event.id}/team/invitations/${pendingInviteId}/resend`)
              .set('Cookie', sec10OrganizerAuth.cookie)
              .set('x-csrf-token', sec10OrganizerAuth.csrf)
          )
        );

        const successes = responses.filter((r) => r.status === 200);
        const throttled = responses.filter((r) => r.status === 429);

        // Exactly ONE request acquires the atomic cooldown lock; the other 3 receive 429
        expect(successes.length).toBe(1);
        expect(throttled.length).toBe(3);

        for (const t of throttled) {
          expect(t.body.error.code).toBe('TEAM_INVITATION_RESEND_COOLDOWN');
          expect(Number(t.header['retry-after'])).toBeGreaterThan(0);
        }

        // Subsequent sequential retry within 60s also fails with 429
        const seqRes = await request(app)
          .post(`/api/events/${sec10Event.id}/team/invitations/${pendingInviteId}/resend`)
          .set('Cookie', sec10OrganizerAuth.cookie)
          .set('x-csrf-token', sec10OrganizerAuth.csrf)
          .expect(429);

        expect(seqRes.body.error.code).toBe('TEAM_INVITATION_RESEND_COOLDOWN');
        expect(Number(seqRes.header['retry-after'])).toBeGreaterThan(0);
      });

      it('enforces per-actor hourly resend rate limit and releases invitation cooldown when actor limit blocks resend', async () => {
        const redis = getRedisClient();
        const cooldownKey = `cooldown:team_invite_resend:inv:${pendingInviteId}`;
        const actorResendKey = `ratelimit:team_invite_resend:actor:${sec10Admin1.id}`;
        await redis.del(cooldownKey, actorResendKey);

        // Pre-seed sec10Admin1's resend counter to TEAM_INVITE_RESEND_ACTOR_MAX_PER_HOUR (10)
        await redis.setPx(actorResendKey, String(TEAM_INVITE_RESEND_ACTOR_MAX_PER_HOUR), 3600000);

        const blockedRes = await request(app)
          .post(`/api/events/${sec10Event.id}/team/invitations/${pendingInviteId}/resend`)
          .set('Cookie', sec10Admin1Auth.cookie)
          .set('x-csrf-token', sec10Admin1Auth.csrf)
          .expect(429);

        expect(blockedRes.body.error.code).toBe('TEAM_INVITATION_RESEND_RATE_LIMIT');
        expect(Number(blockedRes.header['retry-after'])).toBeGreaterThan(0);

        // Verify the invitation cooldown was released so the event owner can still resend it!
        const ownerResend = await request(app)
          .post(`/api/events/${sec10Event.id}/team/invitations/${pendingInviteId}/resend`)
          .set('Cookie', sec10OrganizerAuth.cookie)
          .set('x-csrf-token', sec10OrganizerAuth.csrf)
          .expect(200);

        expect(ownerResend.body.success).toBe(true);
        expect(ownerResend.body.invitation.token).toBeUndefined();
      });

      it('enforces event-wide hourly resend limit (TEAM_INVITE_RESEND_EVENT_MAX_PER_HOUR = 25) across multiple authorized actors while isolating other events and ignoring unauthorized/invalid requests', async () => {
        const redis = getRedisClient();

        // Create a dedicated secondary event owned by sec10Organizer to verify event-scope isolation
        const sec10Event2 = await prisma.event.create({
          data: {
            organizerId: sec10Organizer.id,
            title: `SEC-10 Secondary Resend Scope Event ${testRunId}`,
            slug: `sec10-resend-scope-2-${testRunId}`,
            description: 'Secondary event for resend event-scope isolation test',
            category: 'MUSIC',
            venueName: 'SEC-10 Hall 2',
            venueAddress: '20 Security Blvd',
            city: 'Nairobi',
            startAt: new Date(Date.now() + 86400000 * 35),
            endAt: new Date(Date.now() + 86400000 * 36),
            coverImageUrl: 'https://outside.vip/sec10-2.jpg',
            status: 'PUBLISHED',
          },
        });
        createdEventIds.push(sec10Event2.id);

        // Reset actor and event resend counters for clean multi-actor evaluation
        const event1ResendKey = `ratelimit:team_invite_resend:event:${sec10Event.id}`;
        const event2ResendKey = `ratelimit:team_invite_resend:event:${sec10Event2.id}`;
        const orgActorKey = `ratelimit:team_invite_resend:actor:${sec10Organizer.id}`;
        const admin1ActorKey = `ratelimit:team_invite_resend:actor:${sec10Admin1.id}`;
        const admin2ActorKey = `ratelimit:team_invite_resend:actor:${sec10Admin2.id}`;
        await redis.del(event1ResendKey, event2ResendKey, orgActorKey, admin1ActorKey, admin2ActorKey);

        // 1. Seed 27 distinct PENDING invitations on sec10Event (avoiding 60s per-invitation cooldown)
        //    plus 1 REVOKED invitation on sec10Event and 1 PENDING invitation on sec10Event2
        const pendingInvitations: string[] = [];
        for (let i = 1; i <= 27; i++) {
          const inv = await prisma.eventTeamInvitation.create({
            data: {
              eventId: sec10Event.id,
              email: `sec10_evt_resend_${i}_${testRunId}@outside.vip`,
              role: EventTeamRole.HOST,
              tokenHash: `hash_evt_resend_${i}_${testRunId}`,
              status: TeamInvitationStatus.PENDING,
              invitedByUserId: sec10Organizer.id,
              expiresAt: new Date(Date.now() + 7 * 86400000),
            },
          });
          pendingInvitations.push(inv.id);
        }

        const revokedInv = await prisma.eventTeamInvitation.create({
          data: {
            eventId: sec10Event.id,
            email: `sec10_evt_revoked_${testRunId}@outside.vip`,
            role: EventTeamRole.HOST,
            tokenHash: `hash_evt_revoked_${testRunId}`,
            status: TeamInvitationStatus.REVOKED,
            invitedByUserId: sec10Organizer.id,
            expiresAt: new Date(Date.now() + 7 * 86400000),
          },
        });

        const otherEventInv = await prisma.eventTeamInvitation.create({
          data: {
            eventId: sec10Event2.id,
            email: `sec10_evt2_pending_${testRunId}@outside.vip`,
            role: EventTeamRole.HOST,
            tokenHash: `hash_evt2_pending_${testRunId}`,
            status: TeamInvitationStatus.PENDING,
            invitedByUserId: sec10Organizer.id,
            expiresAt: new Date(Date.now() + 7 * 86400000),
          },
        });

        // 2. Verify unauthorized (403) and invalid (404 / 400 non-PENDING) requests do NOT consume event or actor quota
        await request(app)
          .post(`/api/events/${sec10Event.id}/team/invitations/${pendingInvitations[0]}/resend`)
          .set('Cookie', outsiderAuth.cookie)
          .set('x-csrf-token', outsiderAuth.csrf)
          .expect(403);

        await request(app)
          .post(`/api/events/${sec10Event.id}/team/invitations/00000000-0000-0000-0000-000000000000/resend`)
          .set('Cookie', sec10OrganizerAuth.cookie)
          .set('x-csrf-token', sec10OrganizerAuth.csrf)
          .expect(404);

        await request(app)
          .post(`/api/events/${sec10Event.id}/team/invitations/${revokedInv.id}/resend`)
          .set('Cookie', sec10OrganizerAuth.cookie)
          .set('x-csrf-token', sec10OrganizerAuth.csrf)
          .expect(400);

        expect(await redis.get(event1ResendKey)).toBeNull();
        expect(await redis.get(orgActorKey)).toBeNull();

        // 3. Distribute 25 valid resends across 3 independently authorized actors on sec10Event:
        //    - sec10Organizer: 9 resends (invitations 0..8)   [under 10/hr actor limit]
        //    - sec10Admin1:    9 resends (invitations 9..17)  [under 10/hr actor limit]
        //    - sec10Admin2:    7 resends (invitations 18..24) [under 10/hr actor limit]
        //    Total = 25 resends on sec10Event (== TEAM_INVITE_RESEND_EVENT_MAX_PER_HOUR)
        const actors = [
          { auth: sec10OrganizerAuth, slice: pendingInvitations.slice(0, 9) },
          { auth: sec10Admin1Auth, slice: pendingInvitations.slice(9, 18) },
          { auth: sec10Admin2Auth, slice: pendingInvitations.slice(18, 25) },
        ];

        let totalSucceeded = 0;
        for (const { auth, slice } of actors) {
          for (const invId of slice) {
            await request(app)
              .post(`/api/events/${sec10Event.id}/team/invitations/${invId}/resend`)
              .set('Cookie', auth.cookie)
              .set('x-csrf-token', auth.csrf)
              .expect(200);
            totalSucceeded++;
          }
        }
        expect(totalSucceeded).toBe(TEAM_INVITE_RESEND_EVENT_MAX_PER_HOUR); // 25

        // 4. The 26th valid resend on sec10Event by sec10Admin2 (who only used 7 of 10 personal actor resends)
        //    is rejected with HTTP 429, TEAM_INVITATION_RESEND_RATE_LIMIT, and Retry-After header
        const overLimitAdmin2Res = await request(app)
          .post(`/api/events/${sec10Event.id}/team/invitations/${pendingInvitations[25]}/resend`)
          .set('Cookie', sec10Admin2Auth.cookie)
          .set('x-csrf-token', sec10Admin2Auth.csrf)
          .expect(429);

        expect(overLimitAdmin2Res.body.error.code).toBe('TEAM_INVITATION_RESEND_RATE_LIMIT');
        expect(Number(overLimitAdmin2Res.header['retry-after'])).toBeGreaterThan(0);

        // 5. Confirm different authorized actors (sec10Organizer and sec10Admin1, each at 9 of 10 actor resends)
        //    also cannot bypass the event-wide limit on sec10Event
        const overLimitOrgRes = await request(app)
          .post(`/api/events/${sec10Event.id}/team/invitations/${pendingInvitations[25]}/resend`)
          .set('Cookie', sec10OrganizerAuth.cookie)
          .set('x-csrf-token', sec10OrganizerAuth.csrf)
          .expect(429);

        expect(overLimitOrgRes.body.error.code).toBe('TEAM_INVITATION_RESEND_RATE_LIMIT');
        expect(Number(overLimitOrgRes.header['retry-after'])).toBeGreaterThan(0);

        const overLimitAdmin1Res = await request(app)
          .post(`/api/events/${sec10Event.id}/team/invitations/${pendingInvitations[26]}/resend`)
          .set('Cookie', sec10Admin1Auth.cookie)
          .set('x-csrf-token', sec10Admin1Auth.csrf)
          .expect(429);

        expect(overLimitAdmin1Res.body.error.code).toBe('TEAM_INVITATION_RESEND_RATE_LIMIT');
        expect(Number(overLimitAdmin1Res.header['retry-after'])).toBeGreaterThan(0);

        // 6. Confirm event-scope isolation: another event (sec10Event2) remains eligible for resends!
        //    Reset sec10Organizer's actor counter to ensure actor quota is available and resend on sec10Event2
        await redis.del(orgActorKey);
        const otherEventRes = await request(app)
          .post(`/api/events/${sec10Event2.id}/team/invitations/${otherEventInv.id}/resend`)
          .set('Cookie', sec10OrganizerAuth.cookie)
          .set('x-csrf-token', sec10OrganizerAuth.csrf)
          .expect(200);

        expect(otherEventRes.body.success).toBe(true);
        expect(otherEventRes.body.invitation.id).toBe(otherEventInv.id);

        await redis.del(event1ResendKey, event2ResendKey, orgActorKey, admin1ActorKey, admin2ActorKey);
      });
    });

    // =========================================================================
    // Part C: Public invitation inspection rate limiting
    // =========================================================================
    describe('Part C: Public Invitation Inspection Rate Limiting', () => {
      it('enforces IP burst rate limit on GET /api/team/invitations/:token with HTTP 429 and Retry-After without leaking token existence', async () => {
        const redis = getRedisClient();
        const testClientIp = '203.0.113.77';
        const ipHash = hashRateLimitIdentifier(testClientIp);
        const burstKey = `ratelimit:team_invite_inspect:burst:${ipHash}`;
        const sustainedKey = `ratelimit:team_invite_inspect:sustained:${ipHash}`;
        await redis.del(burstKey, sustainedKey);

        // Pre-seed burst counter to 1 below limit (19 of 20)
        await redis.setPx(burstKey, String(TEAM_INVITE_INSPECT_IP_BURST_MAX - 1), 60000);

        // 20th request from this IP is allowed through rate limiter (returns 404 for unknown token)
        await request(app)
          .get('/api/team/invitations/0000000000000000000000000000000000000000000000000000000000000000')
          .set('X-Forwarded-For', testClientIp)
          .expect(404);

        // 21st request from this IP is rejected with 429 Too Many Requests and Retry-After
        const throttledRes = await request(app)
          .get('/api/team/invitations/0000000000000000000000000000000000000000000000000000000000000000')
          .set('X-Forwarded-For', testClientIp)
          .expect(429);

        expect(throttledRes.body.error.code).toBe('TEAM_INVITATION_INSPECT_RATE_LIMIT');
        expect(Number(throttledRes.header['retry-after'])).toBeGreaterThan(0);

        // Verify spoofing an extra left-most X-Forwarded-For hop cannot bypass Express trust proxy = 1
        const spoofedRes = await request(app)
          .get('/api/team/invitations/0000000000000000000000000000000000000000000000000000000000000000')
          .set('X-Forwarded-For', `198.51.100.99, ${testClientIp}`)
          .expect(429);

        expect(spoofedRes.body.error.code).toBe('TEAM_INVITATION_INSPECT_RATE_LIMIT');

        await redis.del(burstKey, sustainedKey);
      });

      it('enforces 15-minute IP sustained rate limit (TEAM_INVITE_INSPECT_IP_SUSTAINED_MAX = 60) independently of the 1-minute burst counter, isolates different IPs, blocks X-Forwarded-For spoofing, and never leaks tokens', async () => {
        const redis = getRedisClient();
        const sustainedClientIp = '203.0.113.88';
        const otherClientIp = '203.0.113.89';
        const sustainedIpHash = hashRateLimitIdentifier(sustainedClientIp);
        const otherIpHash = hashRateLimitIdentifier(otherClientIp);

        const burstKey = `ratelimit:team_invite_inspect:burst:${sustainedIpHash}`;
        const sustainedKey = `ratelimit:team_invite_inspect:sustained:${sustainedIpHash}`;
        const otherBurstKey = `ratelimit:team_invite_inspect:burst:${otherIpHash}`;
        const otherSustainedKey = `ratelimit:team_invite_inspect:sustained:${otherIpHash}`;

        await redis.del(burstKey, sustainedKey, otherBurstKey, otherSustainedKey);

        // Create a real invitation to inspect so we test valid token inspection across 60 requests
        const targetEmail = `sec10_sustained_inspect_${testRunId}@outside.vip`;
        await request(app)
          .post(`/api/events/${sec10Event.id}/team/invitations`)
          .set('Cookie', sec10OrganizerAuth.cookie)
          .set('x-csrf-token', sec10OrganizerAuth.csrf)
          .send({ email: targetEmail, role: 'HOST' })
          .expect(201);

        const inviteEmail = sentTeamInvitationEmails
          .slice()
          .reverse()
          .find((e) => e.to === targetEmail);
        const validToken = inviteEmail!.inviteUrl.split('/').pop()!;

        // 1. Execute 60 real inspection requests across 3 simulated 1-minute burst windows
        //    (20 requests per minute * 3 minutes = 60 requests within the 15-minute sustained window).
        //    Between each batch of 20, expire only the 1-minute burst key while leaving the 15-minute sustained key intact.
        const batches = TEAM_INVITE_INSPECT_IP_SUSTAINED_MAX / TEAM_INVITE_INSPECT_IP_BURST_MAX; // 60 / 20 = 3
        let totalAllowed = 0;

        for (let batch = 0; batch < batches; batch++) {
          await redis.del(burstKey); // Simulate advancing 1 minute so burst window resets while 15m sustained window persists
          for (let reqIdx = 0; reqIdx < TEAM_INVITE_INSPECT_IP_BURST_MAX; reqIdx++) {
            const okRes = await request(app)
              .get(`/api/team/invitations/${validToken}`)
              .set('X-Forwarded-For', sustainedClientIp)
              .expect(200);
            expect(okRes.body.success).toBe(true);
            totalAllowed++;
          }
        }
        expect(totalAllowed).toBe(TEAM_INVITE_INSPECT_IP_SUSTAINED_MAX); // 60

        // 2. Advance the 1-minute burst window one more time so burst counter is 0 (burst limit permits),
        //    proving the 61st request is rejected specifically by the 15-minute sustained counter!
        await redis.del(burstKey);
        expect(await redis.get(burstKey)).toBeNull();
        expect(Number(await redis.get(sustainedKey))).toBe(TEAM_INVITE_INSPECT_IP_SUSTAINED_MAX);

        const blocked61Res = await request(app)
          .get(`/api/team/invitations/${validToken}`)
          .set('X-Forwarded-For', sustainedClientIp)
          .expect(429);

        expect(blocked61Res.body.error.code).toBe('TEAM_INVITATION_INSPECT_RATE_LIMIT');
        const retryAfterSeconds = Number(blocked61Res.header['retry-after']);
        // Retry-After reflects the remaining 15-minute (900s) sustained window (> 60s, not the 60s burst window)
        expect(retryAfterSeconds).toBeGreaterThan(60);
        expect(retryAfterSeconds).toBeLessThanOrEqual(900);

        // Confirm no invitation token is exposed in the 429 error response
        expect(JSON.stringify(blocked61Res.body)).not.toContain(validToken);

        // 3. Confirm spoofed client-prepended X-Forwarded-For values cannot evade the sustained IP limit
        const spoofedSustainedRes = await request(app)
          .get(`/api/team/invitations/${validToken}`)
          .set('X-Forwarded-For', `198.51.100.250, ${sustainedClientIp}`)
          .expect(429);

        expect(spoofedSustainedRes.body.error.code).toBe('TEAM_INVITATION_INSPECT_RATE_LIMIT');
        expect(JSON.stringify(spoofedSustainedRes.body)).not.toContain(validToken);

        // 4. Confirm a different trusted client IP has an independent quota and succeeds (200 OK)
        const otherIpRes = await request(app)
          .get(`/api/team/invitations/${validToken}`)
          .set('X-Forwarded-For', otherClientIp)
          .expect(200);

        expect(otherIpRes.body.success).toBe(true);
        expect(otherIpRes.body.invitation.status).toBe('PENDING');

        await redis.del(burstKey, sustainedKey, otherBurstKey, otherSustainedKey);
      });
    });

    // =========================================================================
    // Part D: Bound immutable promotional slug alias accumulation
    // =========================================================================
    describe('Part D: Promotional Slug Historical Alias Limit', () => {
      it('bounds historical slug aliases at MAX_HISTORICAL_SLUG_ALIASES_PER_LINK (10) for Campaign links even under concurrent requests', async () => {
        const initialSlug = `sec10-camp-init-${testRunId}`;
        const createRes = await request(app)
          .post(`/api/events/${sec10Event.id}/promotions/links`)
          .set('Cookie', sec10OrganizerAuth.cookie)
          .set('x-csrf-token', sec10OrganizerAuth.csrf)
          .send({
            name: 'SEC-10 Alias Limit Campaign',
            slug: initialSlug,
          })
          .expect(201);

        const campLinkId = createRes.body.link.id;

        // Perform 9 sequential slug customizations -> creates 9 historical aliases (slugs 0..8) + 1 active primary (slug 9)
        for (let i = 1; i <= MAX_HISTORICAL_SLUG_ALIASES_PER_LINK - 1; i++) {
          await request(app)
            .post(`/api/events/${sec10Event.id}/promotions/links/${campLinkId}/slug`)
            .set('Cookie', sec10OrganizerAuth.cookie)
            .set('x-csrf-token', sec10OrganizerAuth.csrf)
            .send({ slug: `sec10-camp-v${i}-${testRunId}` })
            .expect(200);
        }

        // Fire 4 concurrent requests competing for the 10th and final allowed historical alias slot!
        const concurrentResponses = await Promise.all(
          [10, 11, 12, 13].map((idx) =>
            request(app)
              .post(`/api/events/${sec10Event.id}/promotions/links/${campLinkId}/slug`)
              .set('Cookie', sec10OrganizerAuth.cookie)
              .set('x-csrf-token', sec10OrganizerAuth.csrf)
              .send({ slug: `sec10-camp-v${idx}-${testRunId}` })
          )
        );

        const succeeded = concurrentResponses.filter((r) => r.status === 200);
        const conflicts = concurrentResponses.filter((r) => r.status === 409);

        // Advisory lock serializes concurrent mutations: exactly 1 succeeds (reaching 10 historical aliases) and 3 fail with 409
        expect(succeeded.length).toBe(1);
        expect(conflicts.length).toBe(3);
        for (const c of conflicts) {
          expect(c.body.error.code).toBe('PROMOTION_SLUG_ALIAS_LIMIT_REACHED');
          expect(c.body.error.message).toMatch(/maximum limit of 10 historical URL aliases/i);
        }

        // Verify database contains exactly 10 historical aliases (isPrimary: false) and 1 primary slug (11 total)
        const allSlugs = await prisma.promotionSlugRegistry.findMany({
          where: { promotionLinkId: campLinkId },
        });
        expect(allSlugs.length).toBe(MAX_HISTORICAL_SLUG_ALIASES_PER_LINK + 1);
        expect(allSlugs.filter((s) => !s.isPrimary).length).toBe(MAX_HISTORICAL_SLUG_ALIASES_PER_LINK);
        expect(allSlugs.filter((s) => s.isPrimary).length).toBe(1);

        // Verify initial historical alias still resolves via /r/:slug
        await request(app).get(`/r/${initialSlug}`).expect(302);
      });

      it('enforces the same MAX_HISTORICAL_SLUG_ALIASES_PER_LINK (10) limit on Host personal slug customization', async () => {
        // Invite and accept sec10Host on sec10Event
        await request(app)
          .post(`/api/events/${sec10Event.id}/team/invitations`)
          .set('Cookie', sec10OrganizerAuth.cookie)
          .set('x-csrf-token', sec10OrganizerAuth.csrf)
          .send({ email: sec10Host.email, role: 'HOST' })
          .expect(201);

        const inviteEmail = sentTeamInvitationEmails
          .slice()
          .reverse()
          .find((e) => e.to === sec10Host.email.toLowerCase());
        const rawToken = inviteEmail!.inviteUrl.split('/').pop()!;

        const acceptRes = await request(app)
          .post(`/api/team/invitations/${rawToken}/accept`)
          .set('Cookie', sec10HostAuth.cookie)
          .set('x-csrf-token', sec10HostAuth.csrf)
          .expect(200);

        const hostLinkId = acceptRes.body.membership.hostLink.id;

        // Perform 10 valid Host slug customizations
        for (let i = 1; i <= MAX_HISTORICAL_SLUG_ALIASES_PER_LINK; i++) {
          await request(app)
            .patch(`/api/host/events/${sec10Event.id}/slug`)
            .set('Cookie', sec10HostAuth.cookie)
            .set('x-csrf-token', sec10HostAuth.csrf)
            .send({ slug: `sec10-host-v${i}-${testRunId}` })
            .expect(200);
        }

        // 11th Host slug customization is rejected with 409 Conflict
        const overLimitRes = await request(app)
          .patch(`/api/host/events/${sec10Event.id}/slug`)
          .set('Cookie', sec10HostAuth.cookie)
          .set('x-csrf-token', sec10HostAuth.csrf)
          .send({ slug: `sec10-host-v11-${testRunId}` })
          .expect(409);

        expect(overLimitRes.body.error.code).toBe('PROMOTION_SLUG_ALIAS_LIMIT_REACHED');

        const hostSlugs = await prisma.promotionSlugRegistry.findMany({
          where: { promotionLinkId: hostLinkId },
        });
        expect(hostSlugs.filter((s) => !s.isPrimary).length).toBe(MAX_HISTORICAL_SLUG_ALIASES_PER_LINK);
      });
    });
  });
});
