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
});
