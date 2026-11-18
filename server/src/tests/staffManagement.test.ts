import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import * as sessionService from '../lib/session.service.js';
import * as emailService from '../lib/email.service.js';

describe('Organizer Event Staff Management API', () => {
  const organizerId = 'org-user-uuid-111';
  const otherOrganizerId = 'org-user-uuid-999';
  const adminId = 'admin-user-uuid-000';
  const attendeeId = 'attendee-user-uuid-555';

  const organizerToken = jwt.sign(
    { userId: organizerId, email: 'organizer@outside.vip', role: 'ORGANIZER', emailVerified: true },
    env.JWT_SECRET
  );

  const otherOrganizerToken = jwt.sign(
    { userId: otherOrganizerId, email: 'other@outside.vip', role: 'ORGANIZER', emailVerified: true },
    env.JWT_SECRET
  );

  const attendeeToken = jwt.sign(
    { userId: attendeeId, email: 'attendee@outside.vip', role: 'ATTENDEE', emailVerified: true },
    env.JWT_SECRET
  );

  const adminToken = jwt.sign(
    { userId: adminId, email: 'admin@outside.vip', role: 'ADMIN', emailVerified: true },
    env.JWT_SECRET
  );

  const mockEvent = {
    id: 'evt-sunset-101',
    title: 'Sunset Rooftop Groove & Vinyl',
    slug: 'sunset-rooftop-groove',
    organizerId,
    organizer: {
      name: 'Outside Events Co.',
      organizer: {
        displayName: 'Outside Collective',
      },
    },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    emailService.resetSentStaffInvitationEmails();
    vi.spyOn(sessionService, 'checkRedisRateLimit').mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    emailService.resetSentStaffInvitationEmails();
  });

  describe('1. Authorization & Role Verification', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).get(`/api/organizer/events/${mockEvent.id}/team`);
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('rejects ATTENDEE requests with 403 Forbidden', async () => {
      const res = await request(app)
        .get(`/api/organizer/events/${mockEvent.id}/team`)
        .set('Authorization', `Bearer ${attendeeToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('rejects an organizer attempting to manage another organizer’s event with 403 Forbidden', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);

      const res = await request(app)
        .get(`/api/organizer/events/${mockEvent.id}/team`)
        .set('Authorization', `Bearer ${otherOrganizerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('You do not have permission to manage staff');
    });

    it('allows the event owner to manage staff', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);
      vi.spyOn(prisma.eventStaff, 'findMany').mockResolvedValue([]);
      vi.spyOn(prisma.eventStaffInvitation, 'findMany').mockResolvedValue([]);

      const res = await request(app)
        .get(`/api/organizer/events/${mockEvent.id}/team`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.team).toEqual([]);
      expect(res.body.data.invitations).toEqual([]);
    });

    it('allows an administrator to manage staff for any event', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);
      vi.spyOn(prisma.eventStaff, 'findMany').mockResolvedValue([]);
      vi.spyOn(prisma.eventStaffInvitation, 'findMany').mockResolvedValue([]);

      const res = await request(app)
        .get(`/api/organizer/events/${mockEvent.id}/team`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('2. Staff Invitation Creation & Validation', () => {
    it('creates a valid pending invitation, stores only tokenHash, and dispatches email', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);
      vi.spyOn(prisma.eventStaff, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.eventStaffInvitation, 'findFirst').mockResolvedValue(null);

      const createSpy = vi.spyOn(prisma.eventStaffInvitation, 'create').mockImplementation(async ({ data }: any) => {
        return {
          id: 'inv-uuid-777',
          eventId: data.eventId,
          email: data.email,
          status: data.status,
          expiresAt: data.expiresAt,
          createdAt: new Date(),
        } as any;
      });

      const res = await request(app)
        .post(`/api/organizer/events/${mockEvent.id}/team/invitations`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ email: 'Staff.Door@Example.COM ' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invitation.email).toBe('staff.door@example.com');
      expect(res.body.data.invitation.status).toBe('PENDING');
      expect(res.body.data.invitation.tokenHash).toBeUndefined();
      expect(res.body.data.invitation.rawToken).toBeUndefined();

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventId: mockEvent.id,
            email: 'staff.door@example.com',
            invitedByUserId: organizerId,
            status: 'PENDING',
            tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        })
      );

      const sentEmails = emailService.sentStaffInvitationEmails;
      expect(sentEmails.length).toBe(1);
      expect(sentEmails[0].to).toBe('staff.door@example.com');
      expect(sentEmails[0].eventTitle).toBe(mockEvent.title);
      expect(sentEmails[0].inviteUrl).toContain('/staff/invitations/');
    });

    it('rejects self-invitation when organizer enters their own email', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);

      const res = await request(app)
        .post(`/api/organizer/events/${mockEvent.id}/team/invitations`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ email: 'organizer@outside.vip' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('SELF_INVITATION_NOT_ALLOWED');
    });

    it('rejects invitation when user is already an active staff member', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);
      vi.spyOn(prisma.eventStaff, 'findFirst').mockResolvedValue({
        id: 'staff-active-1',
        email: 'staff@example.com',
        status: 'ACTIVE',
      } as any);

      const res = await request(app)
        .post(`/api/organizer/events/${mockEvent.id}/team/invitations`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ email: 'staff@example.com' });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('STAFF_ALREADY_ACTIVE');
    });

    it('rejects duplicate pending invitation for the same event and email', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);
      vi.spyOn(prisma.eventStaff, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.eventStaffInvitation, 'findFirst').mockResolvedValue({
        id: 'inv-existing-1',
        email: 'pending@example.com',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 500000),
      } as any);

      const res = await request(app)
        .post(`/api/organizer/events/${mockEvent.id}/team/invitations`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ email: 'pending@example.com' });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVITATION_ALREADY_PENDING');
    });

    it('allows a new invitation if a prior invitation was revoked or expired', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);
      vi.spyOn(prisma.eventStaff, 'findFirst').mockResolvedValue(null);
      // findFirst returns null because query filters for PENDING with expiresAt > now
      vi.spyOn(prisma.eventStaffInvitation, 'findFirst').mockResolvedValue(null);

      vi.spyOn(prisma.eventStaffInvitation, 'create').mockResolvedValue({
        id: 'inv-uuid-new',
        eventId: mockEvent.id,
        email: 'revoked-before@example.com',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 600000),
        createdAt: new Date(),
      } as any);

      const res = await request(app)
        .post(`/api/organizer/events/${mockEvent.id}/team/invitations`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ email: 'revoked-before@example.com' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('enforces Redis invitation rate limiting', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);
      vi.spyOn(sessionService, 'checkRedisRateLimit').mockResolvedValue(false);

      const res = await request(app)
        .post(`/api/organizer/events/${mockEvent.id}/team/invitations`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ email: 'rate.limit@example.com' });

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('INVITATION_RATE_LIMIT');
    });

    it('handles email delivery failure safely and returns 503 without deleting invitation', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);
      vi.spyOn(prisma.eventStaff, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.eventStaffInvitation, 'findFirst').mockResolvedValue(null);

      vi.spyOn(prisma.eventStaffInvitation, 'create').mockResolvedValue({
        id: 'inv-uuid-failed-email',
        eventId: mockEvent.id,
        email: 'fail@example.com',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 600000),
        createdAt: new Date(),
      } as any);

      vi.spyOn(emailService, 'sendStaffInvitationEmail').mockRejectedValue(
        new emailService.EmailDeliveryError('Provider error')
      );

      const deleteSpy = vi.spyOn(prisma.eventStaffInvitation, 'delete');

      const res = await request(app)
        .post(`/api/organizer/events/${mockEvent.id}/team/invitations`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ email: 'fail@example.com' });

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('EMAIL_DELIVERY_FAILED');
      expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('returns 404 Event not found when event ID does not exist', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(null);

      const res = await request(app)
        .post('/api/organizer/events/nonexistent-event-id/team/invitations')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ email: 'valid@example.com' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toBe('Event not found');
    });

    it('returns 500 without leaking database details when unapplied migration causes P2021 table missing error', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);
      vi.spyOn(prisma.eventStaff, 'findFirst').mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError(
          'The table `public.EventStaff` does not exist in the current database.',
          { code: 'P2021', clientVersion: '5.22.0' }
        )
      );

      const res = await request(app)
        .post(`/api/organizer/events/${mockEvent.id}/team/invitations`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ email: 'newstaff@example.com' });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toBe('Internal server error');
      expect(res.body.error.details).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('EventStaff');
    });

    it('rejects an organizer attempting to invite staff to another organizer’s event with 403 Forbidden', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);

      const res = await request(app)
        .post(`/api/organizer/events/${mockEvent.id}/team/invitations`)
        .set('Authorization', `Bearer ${otherOrganizerToken}`)
        .send({ email: 'another.staff@example.com' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('You do not have permission to manage staff');
    });

    it('rejects invalid or malformed email address with 400 Validation failed', async () => {
      const res = await request(app)
        .post(`/api/organizer/events/${mockEvent.id}/team/invitations`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ email: 'not-an-email' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toBe('Validation failed');
    });

    it('rejects missing or empty email address with 400 Validation failed', async () => {
      const res = await request(app)
        .post(`/api/organizer/events/${mockEvent.id}/team/invitations`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ email: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toBe('Validation failed');
    });
  });

  describe('3. Team & Invitation Listing', () => {
    it('returns staff and invitations while strictly excluding sensitive token hashes and secrets', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);

      vi.spyOn(prisma.eventStaff, 'findMany').mockResolvedValue([
        {
          id: 'staff-1',
          eventId: mockEvent.id,
          userId: 'user-staff-1',
          email: 'scanner1@example.com',
          status: 'ACTIVE',
          assignedAt: new Date(),
          revokedAt: null,
          user: { id: 'user-staff-1', name: 'Scanner One', email: 'scanner1@example.com', avatarUrl: null },
          assignedByUser: { id: organizerId, name: 'Organizer', email: 'organizer@outside.vip' },
          revokedByUser: null,
        },
      ] as any);

      vi.spyOn(prisma.eventStaffInvitation, 'findMany').mockResolvedValue([
        {
          id: 'inv-1',
          eventId: mockEvent.id,
          email: 'pending@example.com',
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 500000),
          acceptedAt: null,
          revokedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          invitedByUser: { id: organizerId, name: 'Organizer', email: 'organizer@outside.vip' },
        },
      ] as any);

      const res = await request(app)
        .get(`/api/organizer/events/${mockEvent.id}/team`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.team.length).toBe(1);
      expect(res.body.data.team[0].email).toBe('scanner1@example.com');
      expect(res.body.data.invitations.length).toBe(1);
      expect(res.body.data.invitations[0].email).toBe('pending@example.com');

      const jsonStr = JSON.stringify(res.body);
      expect(jsonStr).not.toContain('tokenHash');
      expect(jsonStr).not.toContain('codeHash');
      expect(jsonStr).not.toContain('otp');
    });

    it('returns accepted staff under active staff collection and excludes accepted invitations from pending', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);

      const staffFindManySpy = vi.spyOn(prisma.eventStaff, 'findMany').mockResolvedValue([
        {
          id: 'staff-accepted-1',
          eventId: mockEvent.id,
          userId: 'user-accepted-1',
          email: 'accepted.staff@example.com',
          status: 'ACTIVE',
          assignedAt: new Date(),
          revokedAt: null,
          user: { id: 'user-accepted-1', name: 'Accepted Staff', email: 'accepted.staff@example.com', avatarUrl: null },
          assignedByUser: { id: organizerId, name: 'Organizer Name', email: 'organizer@outside.vip' },
          revokedByUser: null,
        },
      ] as any);

      const inviteFindManySpy = vi.spyOn(prisma.eventStaffInvitation, 'findMany').mockResolvedValue([] as any);

      const res = await request(app)
        .get(`/api/organizer/events/${mockEvent.id}/team`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(staffFindManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            eventId: mockEvent.id,
            status: 'ACTIVE',
          }),
        })
      );
      expect(inviteFindManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            eventId: mockEvent.id,
            status: 'PENDING',
          }),
        })
      );

      expect(res.body.data.staff.length).toBe(1);
      expect(res.body.data.staff[0].name).toBe('Accepted Staff');
      expect(res.body.data.staff[0].status).toBe('ACTIVE');
      expect(res.body.data.staff[0].assignedByName).toBe('Organizer Name');
      expect(res.body.data.invitations.length).toBe(0);
    });

    it('retains unaccepted invitations under pending invitations list with canResend capability', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);
      vi.spyOn(prisma.eventStaff, 'findMany').mockResolvedValue([] as any);

      vi.spyOn(prisma.eventStaffInvitation, 'findMany').mockResolvedValue([
        {
          id: 'inv-unaccepted-1',
          eventId: mockEvent.id,
          email: 'unaccepted@example.com',
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 600000),
          acceptedAt: null,
          revokedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          invitedByUser: { id: organizerId, name: 'Organizer', email: 'organizer@outside.vip' },
        },
      ] as any);

      const res = await request(app)
        .get(`/api/organizer/events/${mockEvent.id}/team`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.staff.length).toBe(0);
      expect(res.body.data.invitations.length).toBe(1);
      expect(res.body.data.invitations[0].email).toBe('unaccepted@example.com');
      expect(res.body.data.invitations[0].status).toBe('PENDING');
      expect(res.body.data.invitations[0].canResend).toBe(true);
    });
  });

  describe('4. Resend Invitation & Token Rotation', () => {
    it('rotates token hash, enforces cooldown, and dispatches fresh invitation link', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);

      const existingInvitation = {
        id: 'inv-resend-1',
        eventId: mockEvent.id,
        email: 'staff.resend@example.com',
        tokenHash: 'old-hash-aaaa',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 400000),
      };

      vi.spyOn(prisma.eventStaffInvitation, 'findFirst').mockResolvedValue(existingInvitation as any);

      const updateSpy = vi.spyOn(prisma.eventStaffInvitation, 'update').mockImplementation(async ({ data }: any) => {
        return {
          ...existingInvitation,
          tokenHash: data.tokenHash,
          updatedAt: new Date(),
        } as any;
      });

      const res = await request(app)
        .post(`/api/organizer/events/${mockEvent.id}/team/invitations/${existingInvitation.id}/resend`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: existingInvitation.id },
          data: expect.objectContaining({
            tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        })
      );

      const updateCall = updateSpy.mock.calls[0][0];
      expect(updateCall.data.tokenHash).not.toBe('old-hash-aaaa');

      const sentEmails = emailService.sentStaffInvitationEmails;
      expect(sentEmails.length).toBe(1);
      expect(sentEmails[0].to).toBe(existingInvitation.email);
    });

    it('rejects resend if 60s cooldown is active', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);
      vi.spyOn(prisma.eventStaffInvitation, 'findFirst').mockResolvedValue({
        id: 'inv-cooldown-1',
        eventId: mockEvent.id,
        email: 'cooldown@example.com',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 500000),
      } as any);

      vi.spyOn(sessionService, 'checkRedisRateLimit').mockResolvedValue(false);

      const res = await request(app)
        .post(`/api/organizer/events/${mockEvent.id}/team/invitations/inv-cooldown-1/resend`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RESEND_COOLDOWN');
    });

    it('rejects resending an expired or revoked invitation', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);
      vi.spyOn(prisma.eventStaffInvitation, 'findFirst').mockResolvedValue({
        id: 'inv-expired-1',
        eventId: mockEvent.id,
        email: 'expired@example.com',
        status: 'PENDING',
        expiresAt: new Date(Date.now() - 1000), // expired
      } as any);

      const res = await request(app)
        .post(`/api/organizer/events/${mockEvent.id}/team/invitations/inv-expired-1/resend`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVITATION_EXPIRED');
    });

    it('preserves existing tokenHash if email delivery fails during resend', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);
      vi.spyOn(prisma.eventStaffInvitation, 'findFirst').mockResolvedValue({
        id: 'inv-resend-fail-email',
        eventId: mockEvent.id,
        email: 'resendfail@example.com',
        tokenHash: 'original-token-hash-1234',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 400000),
      } as any);

      vi.spyOn(emailService, 'sendStaffInvitationEmail').mockRejectedValue(
        new emailService.EmailDeliveryError('Resend failed')
      );

      const updateSpy = vi.spyOn(prisma.eventStaffInvitation, 'update');

      const res = await request(app)
        .post(`/api/organizer/events/${mockEvent.id}/team/invitations/inv-resend-fail-email/resend`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('EMAIL_DELIVERY_FAILED');
      expect(updateSpy).not.toHaveBeenCalled();
    });
  });

  describe('5. Revocation Lifecycle & Cross-Event Isolation', () => {
    it('revokes a pending invitation and clears transient OTP fields', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);

      vi.spyOn(prisma.eventStaffInvitation, 'findFirst').mockResolvedValue({
        id: 'inv-to-revoke',
        eventId: mockEvent.id,
        status: 'PENDING',
      } as any);

      const updateSpy = vi.spyOn(prisma.eventStaffInvitation, 'update').mockResolvedValue({
        id: 'inv-to-revoke',
        eventId: mockEvent.id,
        email: 'revoked@example.com',
        status: 'REVOKED',
        revokedAt: new Date(),
      } as any);

      const res = await request(app)
        .delete(`/api/organizer/events/${mockEvent.id}/team/invitations/inv-to-revoke`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invitation.status).toBe('REVOKED');

      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'inv-to-revoke' },
          data: expect.objectContaining({
            status: 'REVOKED',
            codeHash: null,
            otpExpiresAt: null,
            otpSentAt: null,
            attempts: 0,
          }),
        })
      );
    });

    it('returns 404 when attempting to revoke an invitation belonging to a different event', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);
      vi.spyOn(prisma.eventStaffInvitation, 'findFirst').mockResolvedValue(null);

      const res = await request(app)
        .delete(`/api/organizer/events/${mockEvent.id}/team/invitations/foreign-invitation-id`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVITATION_NOT_FOUND');
    });

    it('revokes an active staff member without deleting user or altering check-in attribution', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);

      vi.spyOn(prisma.eventStaff, 'findFirst').mockResolvedValue({
        id: 'staff-rec-1',
        eventId: mockEvent.id,
        userId: 'user-to-revoke',
        email: 'staff@example.com',
        status: 'ACTIVE',
      } as any);

      const updateSpy = vi.spyOn(prisma.eventStaff, 'update').mockResolvedValue({
        id: 'staff-rec-1',
        eventId: mockEvent.id,
        userId: 'user-to-revoke',
        email: 'staff@example.com',
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedByUserId: organizerId,
      } as any);

      const userDeleteSpy = vi.spyOn(prisma.user, 'delete');

      const res = await request(app)
        .delete(`/api/organizer/events/${mockEvent.id}/team/members/user-to-revoke`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.staff.status).toBe('REVOKED');

      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'staff-rec-1' },
          data: expect.objectContaining({
            status: 'REVOKED',
            revokedByUserId: organizerId,
          }),
        })
      );

      expect(userDeleteSpy).not.toHaveBeenCalled();
    });

    it('returns 404 when attempting to revoke staff member from a different event', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockEvent as any);
      vi.spyOn(prisma.eventStaff, 'findFirst').mockResolvedValue(null);

      const res = await request(app)
        .delete(`/api/organizer/events/${mockEvent.id}/team/members/foreign-user-id`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('STAFF_NOT_FOUND');
    });
  });

  describe('6. Database Schema & Migration Invariant Verification', () => {
    it('verifies EventStaff and EventStaffInvitation tables exist in the database and are queryable without P2021', async () => {
      const [staffCount, invitationCount] = await Promise.all([
        prisma.eventStaff.count(),
        prisma.eventStaffInvitation.count(),
      ]);

      expect(typeof staffCount).toBe('number');
      expect(typeof invitationCount).toBe('number');
    });
  });
});

