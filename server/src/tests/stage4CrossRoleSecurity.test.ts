import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountStatus, EventTeamRole, Role, TeamInvitationStatus, TeamMemberStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import {
  inspectTeamInvitation,
  acceptTeamInvitation,
} from '../modules/eventTeam/eventTeam.service.js';
import { handleCustomizeHostSlug } from '../modules/promotions/promotions.management.controller.js';
import { getScannerGates } from '../modules/scanner/scanner.controller.js';
import {
  ensureOrganizerWorkspaceForUser,
  listOrganizerEvents,
  upsertOrganizerWorkspace,
} from '../modules/organizer/organizer.controller.js';
import { teamRouter } from '../modules/eventTeam/eventTeam.routes.js';
import * as sessionService from '../lib/session.service.js';
import { ConflictError, ForbiddenError, UnauthorizedError } from '../utils/errors.js';

describe('Authentication Stage 4: Backend Cross-Role Security & Invitation Hardening (S4-02, S4-05, S4-06, S4-07)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // S4-02: EventTeamInvitation Fresh Verification, Atomicity & Single-Use
  // =========================================================================
  describe('S4-02: EventTeamInvitation Fresh Verification, Atomicity & Single-Use', () => {
    it('enforces requireFreshUserVerification on POST /api/team/invitations/:token/accept', () => {
      const acceptLayer = (teamRouter as any).stack.find(
        (layer: any) =>
          layer.route?.path === '/invitations/:token/accept' && layer.route?.methods?.post
      );
      expect(acceptLayer).toBeDefined();
      const middlewareNames = acceptLayer.route.stack.map((s: any) => s.name);
      expect(middlewareNames).toEqual([
        'requireAuth',
        'requireFreshUserVerification',
        'requireVerifiedEmail',
        'handleAcceptTeamInvitation',
      ]);
    });

    it('GET inspectTeamInvitation does NOT mutate DB when an invitation is expired', async () => {
      const updateSpy = vi.spyOn(prisma.eventTeamInvitation, 'update');
      vi.spyOn(prisma.eventTeamInvitation, 'findUnique').mockResolvedValueOnce({
        id: 'inv-exp-1',
        eventId: 'evt-1',
        email: 'host@outside.vip',
        role: EventTeamRole.HOST,
        status: TeamInvitationStatus.PENDING,
        expiresAt: new Date(Date.now() - 60_000),
        event: {
          id: 'evt-1',
          title: 'Expired Fest',
          slug: 'expired-fest',
          organizer: { name: 'Organizer' },
        },
      } as any);

      await expect(inspectTeamInvitation('raw-expired-token')).rejects.toThrow(
        /invitation has expired/i
      );
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('distinguishes ACCEPTED invitations from EXPIRED even after expiresAt passes (409 INVITATION_ALREADY_ACCEPTED)', async () => {
      const pastDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      vi.spyOn(prisma.eventTeamInvitation, 'findUnique').mockResolvedValue({
        id: 'inv-acc-1',
        eventId: 'evt-1',
        email: 'host@outside.vip',
        role: EventTeamRole.HOST,
        status: TeamInvitationStatus.ACCEPTED,
        expiresAt: pastDate,
        invitedByUserId: 'usr-owner',
        event: {
          id: 'evt-1',
          title: 'Accepted Fest',
          slug: 'accepted-fest',
          organizerId: 'usr-owner',
          organizer: { name: 'Organizer' },
        },
      } as any);

      await expect(inspectTeamInvitation('raw-accepted-token')).rejects.toMatchObject({
        statusCode: 409,
        code: 'INVITATION_ALREADY_ACCEPTED',
      });

      await expect(
        acceptTeamInvitation('raw-accepted-token', {
          userId: 'usr-host',
          email: 'host@outside.vip',
          emailVerified: true,
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'INVITATION_ALREADY_ACCEPTED',
      });
    });

    it('enforces atomic conditional PENDING claim: concurrent accept + accept allows exactly one and rejects the second with 409 without partial membership', async () => {
      const futureDate = new Date(Date.now() + 3600_000);
      const rawToken = 'concurrent-host-token';
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      const pendingInvitation = {
        id: 'inv-race-1',
        eventId: 'evt-c',
        email: 'scanner-host@outside.vip',
        role: EventTeamRole.HOST,
        permissions: null,
        tokenHash,
        status: TeamInvitationStatus.PENDING,
        expiresAt: futureDate,
        invitedByUserId: 'usr-owner-c',
        event: {
          id: 'evt-c',
          slug: 'event-c',
          title: 'Event C',
          organizerId: 'usr-owner-c',
        },
      };

      vi.spyOn(prisma.eventTeamInvitation, 'findUnique').mockResolvedValue(pendingInvitation as any);

      let claimedOnce = false;
      const upsertSpy = vi.fn().mockResolvedValue({
        id: 'mem-host-1',
        eventId: 'evt-c',
        role: EventTeamRole.HOST,
        status: TeamMemberStatus.ACTIVE,
      });

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const tx = {
          eventTeamInvitation: {
            updateMany: vi.fn().mockImplementation(async ({ where }: any) => {
              expect(where.status).toBe(TeamInvitationStatus.PENDING);
              if (!claimedOnce) {
                claimedOnce = true;
                return { count: 1 };
              }
              return { count: 0 };
            }),
            findUnique: vi.fn().mockResolvedValue({
              status: TeamInvitationStatus.ACCEPTED,
              expiresAt: futureDate,
            }),
          },
          eventTeamMember: {
            upsert: upsertSpy,
          },
          promotionLink: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({
              id: 'link-1',
              name: 'Host Personal Link',
            }),
          },
          promotionSlugRegistry: {
            findUnique: vi.fn().mockResolvedValue(null),
          },
        };
        return callback(tx);
      });

      const [first, second] = await Promise.allSettled([
        acceptTeamInvitation(rawToken, {
          userId: 'usr-scanner-1',
          email: 'scanner-host@outside.vip',
          emailVerified: true,
        }),
        acceptTeamInvitation(rawToken, {
          userId: 'usr-scanner-1',
          email: 'scanner-host@outside.vip',
          emailVerified: true,
        }),
      ]);

      const fulfilled = [first, second].filter((r) => r.status === 'fulfilled');
      const rejected = [first, second].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictError);
      expect(rejected[0].reason.code).toBe('INVITATION_ALREADY_ACCEPTED');
      expect(upsertSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects accept + revoke race with 403 and writes zero EventTeamMember rows', async () => {
      const futureDate = new Date(Date.now() + 3600_000);
      vi.spyOn(prisma.eventTeamInvitation, 'findUnique').mockResolvedValueOnce({
        id: 'inv-revoke-race',
        eventId: 'evt-c',
        email: 'host@outside.vip',
        role: EventTeamRole.HOST,
        permissions: null,
        status: TeamInvitationStatus.PENDING,
        expiresAt: futureDate,
        invitedByUserId: 'usr-owner-c',
        event: {
          id: 'evt-c',
          slug: 'event-c',
          title: 'Event C',
          organizerId: 'usr-owner-c',
        },
      } as any);

      const upsertSpy = vi.fn();
      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (callback: any) => {
        const tx = {
          eventTeamInvitation: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            findUnique: vi.fn().mockResolvedValue({
              status: TeamInvitationStatus.REVOKED,
              expiresAt: futureDate,
            }),
          },
          eventTeamMember: { upsert: upsertSpy },
        };
        return callback(tx);
      });

      await expect(
        acceptTeamInvitation('revoke-race-token', {
          userId: 'usr-host-1',
          email: 'host@outside.vip',
          emailVerified: true,
        })
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(upsertSpy).not.toHaveBeenCalled();
    });

    it('rejects invitation email mismatch with 403', async () => {
      vi.spyOn(prisma.eventTeamInvitation, 'findUnique').mockResolvedValueOnce({
        id: 'inv-mismatch',
        eventId: 'evt-c',
        email: 'intended@outside.vip',
        role: EventTeamRole.HOST,
        status: TeamInvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 3600_000),
        invitedByUserId: 'usr-owner-c',
        event: { id: 'evt-c', slug: 'event-c', title: 'Event C', organizerId: 'usr-owner-c' },
      } as any);

      await expect(
        acceptTeamInvitation('mismatch-token', {
          userId: 'usr-wrong',
          email: 'other@outside.vip',
          emailVerified: true,
        })
      ).rejects.toThrow(/does not match invitation recipient/i);
    });
  });

  // =========================================================================
  // S4-05: PATCH /api/host/events/:eventId/slug Returns 403 (Not 401)
  // =========================================================================
  describe('S4-05: Host Slug Authorization Returns 403 on Non-Host / Revoked Host and 401 Only When Unauthenticated', () => {
    it('returns 401 Unauthorized when req.user is absent', async () => {
      const req: any = { params: { eventId: 'evt-c' }, body: { slug: 'my-slug' }, user: undefined };
      const res: any = { json: vi.fn() };
      let capturedErr: any = null;

      await handleCustomizeHostSlug(req, res, (err) => {
        capturedErr = err;
      });

      expect(capturedErr).toBeInstanceOf(UnauthorizedError);
      expect(capturedErr.statusCode).toBe(401);
    });

    it('returns 403 Forbidden (not 401) when Host membership is revoked', async () => {
      vi.spyOn(prisma.eventTeamMember, 'findUnique').mockResolvedValueOnce({
        id: 'mem-revoked',
        eventId: 'evt-c',
        userId: 'usr-host',
        role: EventTeamRole.HOST,
        status: TeamMemberStatus.REVOKED,
      } as any);

      const req: any = {
        params: { eventId: 'evt-c' },
        body: { slug: 'revoked-host-slug' },
        user: { userId: 'usr-host', role: Role.ATTENDEE, email: 'host@outside.vip' },
      };
      const res: any = { json: vi.fn() };
      let capturedErr: any = null;

      await handleCustomizeHostSlug(req, res, (err) => {
        capturedErr = err;
      });

      expect(capturedErr).toBeInstanceOf(ForbiddenError);
      expect(capturedErr.statusCode).toBe(403);
    });

    it('returns 403 Forbidden (not 401) when user holds ADMIN role instead of active HOST on the event', async () => {
      vi.spyOn(prisma.eventTeamMember, 'findUnique').mockResolvedValueOnce({
        id: 'mem-admin',
        eventId: 'evt-c',
        userId: 'usr-admin',
        role: EventTeamRole.ADMIN,
        status: TeamMemberStatus.ACTIVE,
      } as any);

      const req: any = {
        params: { eventId: 'evt-c' },
        body: { slug: 'admin-slug-attempt' },
        user: { userId: 'usr-admin', role: Role.ATTENDEE, email: 'admin@outside.vip' },
      };
      const res: any = { json: vi.fn() };
      let capturedErr: any = null;

      await handleCustomizeHostSlug(req, res, (err) => {
        capturedErr = err;
      });

      expect(capturedErr).toBeInstanceOf(ForbiddenError);
      expect(capturedErr.statusCode).toBe(403);
    });
  });

  // =========================================================================
  // S4-06: Organizer Promotion Cache Invalidation & Scanner Gate Ownership
  // =========================================================================
  describe('S4-06: Auth Cache Invalidation on Role Promotion & Global-Role-Independent Scanner Gates', () => {
    it('invalidates Redis auth cache immediately when upsertOrganizerWorkspace promotes ATTENDEE to ORGANIZER', async () => {
      const invalidateSpy = vi
        .spyOn(sessionService, 'invalidateUserAuthCache')
        .mockResolvedValue(undefined);
      vi.spyOn(prisma.organizerProfile, 'findUnique').mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      vi.spyOn(prisma.organizerProfile, 'create').mockResolvedValueOnce({
        id: 'org-new',
        userId: 'usr-att-1',
        displayName: 'Savannah Events',
        slug: 'savannah-events',
      } as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
        id: 'usr-att-1',
        role: Role.ATTENDEE,
      } as any);
      const userUpdateSpy = vi.spyOn(prisma.user, 'update').mockResolvedValueOnce({} as any);

      const req: any = {
        user: { userId: 'usr-att-1', role: Role.ATTENDEE, email: 'a@outside.vip' },
        body: { displayName: 'Savannah Events' },
      };
      const res: any = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };

      await upsertOrganizerWorkspace(req, res, vi.fn());

      expect(userUpdateSpy).toHaveBeenCalledWith({
        where: { id: 'usr-att-1' },
        data: { role: Role.ORGANIZER },
      });
      expect(invalidateSpy).toHaveBeenCalledTimes(1);
      expect(invalidateSpy).toHaveBeenCalledWith('usr-att-1');
    });

    it('does NOT unnecessarily invalidate Redis auth cache when user is already ORGANIZER', async () => {
      const invalidateSpy = vi
        .spyOn(sessionService, 'invalidateUserAuthCache')
        .mockResolvedValue(undefined);
      vi.spyOn(prisma.organizerProfile, 'findUnique').mockResolvedValueOnce({
        id: 'org-existing',
        userId: 'usr-org-1',
      } as any);
      vi.spyOn(prisma.organizerProfile, 'update').mockResolvedValueOnce({
        id: 'org-existing',
        userId: 'usr-org-1',
        displayName: 'Updated Name',
      } as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
        id: 'usr-org-1',
        role: Role.ORGANIZER,
      } as any);

      const req: any = {
        user: { userId: 'usr-org-1', role: Role.ORGANIZER, email: 'o@outside.vip' },
        body: { displayName: 'Updated Name' },
      };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await upsertOrganizerWorkspace(req, res, vi.fn());

      expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it('ensureOrganizerWorkspaceForUser invalidates Redis auth cache when promoting ATTENDEE to ORGANIZER', async () => {
      const invalidateSpy = vi
        .spyOn(sessionService, 'invalidateUserAuthCache')
        .mockResolvedValue(undefined);
      vi.spyOn(prisma.organizerProfile, 'findUnique')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
        id: 'usr-att-2',
        name: 'Promo Creator',
        role: Role.ATTENDEE,
      } as any);
      vi.spyOn(prisma.organizerProfile, 'create').mockResolvedValueOnce({
        id: 'org-2',
        userId: 'usr-att-2',
      } as any);
      vi.spyOn(prisma.user, 'update').mockResolvedValueOnce({} as any);

      await ensureOrganizerWorkspaceForUser('usr-att-2', 'Promo Creator');

      expect(invalidateSpy).toHaveBeenCalledTimes(1);
      expect(invalidateSpy).toHaveBeenCalledWith('usr-att-2');
    });

    it('getScannerGates includes owned events independently of global user.role and includes active EventStaff without granting access to Hosts/Admins', async () => {
      const eventFindManySpy = vi.spyOn(prisma.event, 'findMany').mockResolvedValueOnce([
        {
          id: 'evt-owned-a',
          title: 'Owned Event A',
          slug: 'owned-event-a',
          startAt: new Date('2026-12-10T18:00:00Z'),
          endAt: new Date('2026-12-10T23:00:00Z'),
          venueName: 'Venue A',
          city: 'Nairobi',
          country: 'Kenya',
        },
      ] as any);

      const staffFindManySpy = vi.spyOn(prisma.eventStaff, 'findMany').mockResolvedValueOnce([
        {
          event: {
            id: 'evt-staff-d',
            title: 'Scanner Gate D',
            slug: 'scanner-gate-d',
            startAt: new Date('2026-12-12T18:00:00Z'),
            endAt: new Date('2026-12-12T23:00:00Z'),
            venueName: 'Venue D',
            city: 'Mombasa',
            country: 'Kenya',
          },
        },
      ] as any);

      const teamFindManySpy = vi.spyOn(prisma.eventTeamMember, 'findMany');

      const req: any = {
        user: {
          userId: 'usr-multi',
          role: Role.ATTENDEE, // Global role is ATTENDEE (not ORGANIZER!)
          email: 'multi@outside.vip',
          emailVerified: true,
          accountStatus: AccountStatus.ACTIVE,
        },
      };
      let payload: any = null;
      const res: any = {
        json: (body: any) => {
          payload = body;
        },
      };

      await getScannerGates(req, res, vi.fn());

      expect(eventFindManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizerId: 'usr-multi', status: 'PUBLISHED' },
        })
      );
      expect(staffFindManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'usr-multi', status: 'ACTIVE', event: { status: 'PUBLISHED' } },
        })
      );
      // EventTeamMember (Hosts/Admins) must NEVER be queried for scanner access
      expect(teamFindManySpy).not.toHaveBeenCalled();

      expect(payload.events).toHaveLength(2);
      expect(payload.events[0]).toMatchObject({ id: 'evt-owned-a', role: 'ORGANIZER' });
      expect(payload.events[1]).toMatchObject({ id: 'evt-staff-d', role: 'STAFF' });
    });
  });

  // =========================================================================
  // S4-07: listOrganizerEvents Per-Event Authorization Metadata & Payout Isolation
  // =========================================================================
  describe('S4-07: listOrganizerEvents Per-Event Ownership, Permissions & Payout Privacy', () => {
    it('returns isOwner, accessRole, and sanitized permissions per event while hiding payoutDetailsId from non-owners', async () => {
      vi.spyOn(prisma.eventTeamMember, 'findMany').mockResolvedValueOnce([
        {
          eventId: 'evt-admin-b',
          role: EventTeamRole.ADMIN,
          status: TeamMemberStatus.ACTIVE,
          permissions: {
            canEditDetails: true,
            canManageTeam: true,
            canViewOrders: false,
            canManageRefunds: true, // legacy true must be stripped
            canManagePayouts: true, // legacy true must be stripped
          },
        },
      ] as any);

      vi.spyOn(prisma.event, 'findMany').mockResolvedValueOnce([
        {
          id: 'evt-owned-a',
          title: 'Owned Event A',
          slug: 'owned-a',
          organizerId: 'usr-multi',
          status: 'PUBLISHED',
          payoutDetailsId: 'payout-owner-a',
          ticketTiers: [{ totalCapacity: 100, soldQuantity: 10 }],
          orders: [{ totalInCents: 50000 }],
        },
        {
          id: 'evt-admin-b',
          title: 'Admin Event B',
          slug: 'admin-b',
          organizerId: 'usr-other-owner',
          status: 'PUBLISHED',
          payoutDetailsId: 'payout-secret-b',
          ticketTiers: [{ totalCapacity: 100, soldQuantity: 20 }],
          orders: [{ totalInCents: 99900 }],
        },
      ] as any);

      const req: any = {
        user: {
          userId: 'usr-multi',
          role: Role.ATTENDEE,
          email: 'multi@outside.vip',
          emailVerified: true,
        },
      };
      let payload: any = null;
      const res: any = {
        json: (body: any) => {
          payload = body;
        },
      };

      await listOrganizerEvents(req, res, vi.fn());

      const evtA = payload.data.events.find((e: any) => e.id === 'evt-owned-a');
      const evtB = payload.data.events.find((e: any) => e.id === 'evt-admin-b');

      // Owned event
      expect(evtA.isOwner).toBe(true);
      expect(evtA.accessRole).toBe('OWNER');
      expect(evtA.permissions).toBeNull();
      expect(evtA.payoutDetailsId).toBe('payout-owner-a');
      expect(evtA.revenueInCents).toBe(50000);

      // Admin event
      expect(evtB.isOwner).toBe(false);
      expect(evtB.accessRole).toBe('ADMIN');
      expect(evtB.permissions.canEditDetails).toBe(true);
      expect(evtB.permissions.canManageTeam).toBe(true);
      expect(evtB.permissions.canManageRefunds).toBe(false);
      expect(evtB.permissions.canManagePayouts).toBe(false);
      expect(evtB.payoutDetails).toBeNull();
      expect(evtB.payoutDetailsId).toBeNull();
      expect(evtB.revenueInCents).toBe(0); // canViewOrders is false
    });
  });
});

