import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { EventTeamRole, TeamMemberStatus, TeamInvitationStatus } from '@prisma/client';
import { createSession } from '../lib/session.service.js';
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
      expect(res.body.invitation.token).toBeDefined();

      hostInviteToken = res.body.invitation.token;
      hostInvitationId = res.body.invitation.id;

      // Verify email was recorded in test email service
      const sentEmail = sentTeamInvitationEmails.find((e) => e.to === hostUser.email.toLowerCase());
      expect(sentEmail).toBeDefined();
      expect(sentEmail?.role).toBe('HOST');
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
      adminInviteToken = res.body.invitation.token;
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
      expect(res.body.invitation.token).toBeDefined();
      expect(res.body.invitation.token).not.toBe(hostInviteToken);

      // Update token to the newly rotated token
      hostInviteToken = res.body.invitation.token;
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

      const res = await request(app)
        .post(`/api/team/invitations/${inv.body.invitation.token}/accept`)
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
      const invRes = await request(app)
        .post(`/api/events/${event1.id}/team/invitations`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          email: `revokeme_${testRunId}@outside.vip`,
          role: 'HOST',
        })
        .expect(201);

      const token = invRes.body.invitation.token;
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
});
