import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Role, AccountStatus } from '@prisma/client';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import * as sessionService from '../lib/session.service.js';
import * as emailService from '../lib/email.service.js';
import * as redisModule from '../lib/redis.js';

describe('Passwordless Staff Acceptance & Session Issuance API', () => {
  const rawToken = 'test-staff-raw-token-abcdef1234567890';
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const invitationId = 'inv-uuid-verification-111';
  const eventId = 'evt-uuid-sol-fest-222';
  const organizerId = 'org-uuid-sol-333';

  const mockEvent = {
    id: eventId,
    title: 'SOL FEST: Baobab Live & Vinyl',
    slug: 'sol-fest-baobab-live',
    startAt: new Date(Date.now() + 86400000),
    endAt: new Date(Date.now() + 172800000),
    venueName: 'Baobab Park Stage',
    city: 'Nairobi',
    country: 'Kenya',
    organizerId,
    organizer: {
      name: 'Sol Entertainment',
      organizer: {
        displayName: 'Sol Collective',
      },
    },
  };

  const createMockInvitation = (overrides: Record<string, any> = {}) => ({
    id: invitationId,
    eventId,
    email: 'newstaff@outside.vip',
    invitedByUserId: organizerId,
    tokenHash,
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    acceptedAt: null,
    revokedAt: null,
    codeHash: null,
    otpSentAt: null,
    otpExpiresAt: null,
    attempts: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    event: mockEvent,
    ...overrides,
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    emailService.resetSentStaffOtpEmails();
    vi.spyOn(sessionService, 'checkRedisRateLimit').mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    emailService.resetSentStaffOtpEmails();
  });

  describe('1. Public Invitation Metadata (GET /api/staff/invitations/:token)', () => {
    it('returns safe metadata with masked email and exposes OTP path for new invitee', async () => {
      const mockInvite = createMockInvitation();
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);

      const res = await request(app).get(`/api/staff/invitations/${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invitation.maskedEmail).toBe('ne***@outside.vip');
      expect(res.body.data.invitation.hasPassword).toBe(false);
      expect(res.body.data.invitation.requiresLogin).toBe(false);
      expect(res.body.data.invitation.isCurrentAccount).toBe(false);
      expect(res.body.data.event.title).toBe(mockEvent.title);
      expect(res.body.data.event.organizerName).toBe('Sol Collective');

      const jsonStr = JSON.stringify(res.body);
      expect(jsonStr).not.toContain(rawToken);
      expect(jsonStr).not.toContain(tokenHash);
      expect(jsonStr).not.toContain('codeHash');
    });

    it('returns requiresLogin: true when user account has a password set', async () => {
      const mockInvite = createMockInvitation({ email: 'existing.attendee@outside.vip' });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
        id: 'user-pw-1',
        email: 'existing.attendee@outside.vip',
        passwordHash: '$2a$10$hashedpwvalue1234567890',
      } as any);

      const res = await request(app).get(`/api/staff/invitations/${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invitation.hasPassword).toBe(true);
      expect(res.body.data.invitation.requiresLogin).toBe(true);
      expect(res.body.data.invitation.isCurrentAccount).toBe(false);
    });

    it('returns requiresLogin: false when visitor is authenticated as matching account', async () => {
      const mockInvite = createMockInvitation({ email: 'existing.organizer@outside.vip' });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
        id: 'user-org-1',
        email: 'existing.organizer@outside.vip',
        passwordHash: '$2a$10$hashedpwvalue1234567890',
      } as any);

      const userToken = jwt.sign(
        { userId: 'user-org-1', email: 'existing.organizer@outside.vip', role: 'ORGANIZER', emailVerified: true },
        env.JWT_SECRET
      );

      const res = await request(app)
        .get(`/api/staff/invitations/${rawToken}`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invitation.hasPassword).toBe(true);
      expect(res.body.data.invitation.requiresLogin).toBe(false);
      expect(res.body.data.invitation.isCurrentAccount).toBe(true);
    });

    it('returns isCurrentAccount: true when authenticated via session cookie and warm Redis user cache', async () => {
      const inviteEmail = 'cookie_staff@outside.vip';
      const mockInvite = createMockInvitation({ email: inviteEmail });
      const staffUserId = `user-cookie-staff-${Date.now()}`;

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
        id: staffUserId,
        email: inviteEmail,
        passwordHash: null,
      } as any);

      // Create a valid session and warm the user auth cache in Redis
      const issuedSession = await sessionService.createSession({ userId: staffUserId });
      const ver = await sessionService.getUserAuthCacheVersion(staffUserId);
      await sessionService.populateUserAuthCacheAtomically({
        userId: staffUserId,
        email: inviteEmail,
        role: Role.ATTENDEE,
        emailVerified: true,
        accountStatus: AccountStatus.ACTIVE,
      }, ver);

      const res = await request(app)
        .get(`/api/staff/invitations/${rawToken}`)
        .set('Cookie', `${sessionService.SESSION_COOKIE_NAME}=${encodeURIComponent(issuedSession.rawCookieValue)}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invitation.isCurrentAccount).toBe(true);
      expect(res.body.data.invitation.requiresLogin).toBe(false);
    });

    it('returns 410 INVITATION_EXPIRED when invitation has expired', async () => {
      const mockInvite = createMockInvitation({ expiresAt: new Date(Date.now() - 5000) });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);

      const res = await request(app).get(`/api/staff/invitations/${rawToken}`);

      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('INVITATION_EXPIRED');
    });

    it('returns 403 INVITATION_REVOKED when invitation was revoked', async () => {
      const mockInvite = createMockInvitation({ status: 'REVOKED' });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);

      const res = await request(app).get(`/api/staff/invitations/${rawToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INVITATION_REVOKED');
    });

    it('returns minimal safe metadata without session resumption or account disclosure for unauthenticated caller on ACCEPTED invitation', async () => {
      const mockInvite = createMockInvitation({ status: 'ACCEPTED' });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      const userFindSpy = vi.spyOn(prisma.user, 'findUnique');
      const staffFindSpy = vi.spyOn(prisma.eventStaff, 'findUnique');

      const res = await request(app).get(`/api/staff/invitations/${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invitation.status).toBe('ACCEPTED');
      expect(res.body.data.invitation.isCurrentAccount).toBe(false);
      expect(res.body.data.invitation.hasPassword).toBe(false);
      expect(res.body.data.invitation.requiresLogin).toBe(false);
      expect(res.body.data.invitation.isAssignmentActive).toBeUndefined();
      expect(res.body.data.invitation.canResumeSession).toBe(false);
      expect(res.body.data.event.title).toBe(mockEvent.title);
      expect(userFindSpy).not.toHaveBeenCalled();
      expect(staffFindSpy).not.toHaveBeenCalled();
    });

    it('returns isCurrentAccount: true and active status (with canResumeSession: false) when matching authenticated staff member reopens accepted link', async () => {
      const mockInvite = createMockInvitation({ status: 'ACCEPTED' });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
        id: 'staff-user-1',
        email: mockInvite.email,
        passwordHash: null,
        status: AccountStatus.ACTIVE,
      } as any);
      vi.spyOn(prisma.eventStaff, 'findUnique').mockResolvedValue({
        id: 'staff-assignment-1',
        status: 'ACTIVE',
      } as any);

      const staffToken = jwt.sign(
        { userId: 'staff-user-1', email: mockInvite.email, role: Role.ATTENDEE },
        env.JWT_SECRET
      );

      const res = await request(app)
        .get(`/api/staff/invitations/${rawToken}`)
        .set('Authorization', `Bearer ${staffToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.invitation.status).toBe('ACCEPTED');
      expect(res.body.data.invitation.isCurrentAccount).toBe(true);
      expect(res.body.data.invitation.isAssignmentActive).toBe(true);
      expect(res.body.data.invitation.canResumeSession).toBe(false);
    });

    it('returns isCurrentAccount: false and omits assignment details when mismatched authenticated account reopens accepted link', async () => {
      const mockInvite = createMockInvitation({ status: 'ACCEPTED' });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);

      const foreignToken = jwt.sign(
        { userId: 'foreign-user-2', email: 'other@outside.vip', role: Role.ATTENDEE },
        env.JWT_SECRET
      );

      const res = await request(app)
        .get(`/api/staff/invitations/${rawToken}`)
        .set('Authorization', `Bearer ${foreignToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.invitation.isCurrentAccount).toBe(false);
      expect(res.body.data.invitation.isAssignmentActive).toBeUndefined();
      expect(res.body.data.invitation.canResumeSession).toBe(false);
    });

    it('returns isAssignmentActive: false for matching authenticated staff when accepted staff assignment has been revoked', async () => {
      const mockInvite = createMockInvitation({ status: 'ACCEPTED' });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
        id: 'staff-user-1',
        email: mockInvite.email,
        passwordHash: null,
        status: AccountStatus.ACTIVE,
      } as any);
      vi.spyOn(prisma.eventStaff, 'findUnique').mockResolvedValue({
        id: 'staff-assignment-1',
        status: 'REVOKED',
      } as any);

      const staffToken = jwt.sign(
        { userId: 'staff-user-1', email: mockInvite.email, role: Role.ATTENDEE },
        env.JWT_SECRET
      );

      const res = await request(app)
        .get(`/api/staff/invitations/${rawToken}`)
        .set('Authorization', `Bearer ${staffToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.invitation.isAssignmentActive).toBe(false);
      expect(res.body.data.invitation.canResumeSession).toBe(false);
    });

    it('returns 404 INVITATION_NOT_FOUND when token hash does not exist', async () => {
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(null);

      const res = await request(app).get(`/api/staff/invitations/${rawToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVITATION_NOT_FOUND');
    });

    it('S2R-05: rejects explicitly persisted status EXPIRED with 410 INVITATION_EXPIRED without querying user or eventStaff', async () => {
      const mockInvite = createMockInvitation({
        status: 'EXPIRED',
        expiresAt: new Date(Date.now() + 3600_000),
      });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      const userSpy = vi.spyOn(prisma.user, 'findUnique');
      const staffSpy = vi.spyOn(prisma.eventStaff, 'findUnique');

      const res = await request(app).get(`/api/staff/invitations/${rawToken}`);

      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('INVITATION_EXPIRED');
      expect(userSpy).not.toHaveBeenCalled();
      expect(staffSpy).not.toHaveBeenCalled();
    });
  });

  describe('2. OTP Request & Resend (POST /api/staff/invitations/:token/request-otp)', () => {
    it('generates 6-digit OTP, stores HMAC hash, and dispatches email for passwordless invitee', async () => {
      const mockInvite = createMockInvitation();
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);

      const updateSpy = vi.spyOn(prisma.eventStaffInvitation, 'update').mockResolvedValue({} as any);

      const res = await request(app).post(`/api/staff/invitations/${rawToken}/request-otp`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.cooldownSeconds).toBe(60);
      expect(res.body.data.expiresInMinutes).toBe(10);

      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockInvite.id },
          data: expect.objectContaining({
            codeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            attempts: 0,
            otpSentAt: expect.any(Date),
            otpExpiresAt: expect.any(Date),
          }),
        })
      );

      const sentEmails = emailService.sentStaffOtpEmails;
      expect(sentEmails.length).toBe(1);
      expect(sentEmails[0].to).toBe(mockInvite.email);
      expect(sentEmails[0].code).toMatch(/^\d{6}$/);
      expect(sentEmails[0].eventTitle).toBe(mockEvent.title);
    });

    it('strictly blocks OTP request if account has a password set', async () => {
      const mockInvite = createMockInvitation({ email: 'admin@outside.vip' });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
        id: 'admin-id-999',
        email: 'admin@outside.vip',
        passwordHash: '$2a$10$hashedadminpasswordvalue',
        status: AccountStatus.ACTIVE,
      } as any);

      const res = await request(app).post(`/api/staff/invitations/${rawToken}/request-otp`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PASSWORD_LOGIN_REQUIRED');
      expect(emailService.sentStaffOtpEmails.length).toBe(0);
    });

    it('enforces 60-second cooldown on OTP resend requests', async () => {
      const mockInvite = createMockInvitation({
        otpSentAt: new Date(Date.now() - 20000), // sent 20s ago
      });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);

      const res = await request(app).post(`/api/staff/invitations/${rawToken}/request-otp`);

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('OTP_RESEND_COOLDOWN');
      expect(res.body.error.message).toContain('Please wait');
    });

    it('fails closed when Redis distributed lock is unavailable or contention occurs', async () => {
      const mockInvite = createMockInvitation();
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);

      const mockRedisClient = {
        setNxPx: vi.fn().mockResolvedValue(false), // lock not acquired
        delLockIfMatches: vi.fn().mockResolvedValue(true),
      };
      vi.spyOn(redisModule, 'getRedisClient' as any).mockReturnValue(mockRedisClient as any);
      vi.spyOn(sessionService, 'checkRedisRateLimit').mockResolvedValue(true);

      const res = await request(app).post(`/api/staff/invitations/${rawToken}/request-otp`);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVITATION_MUTEX_LOCKED');
    });

    it('restores previous OTP state if email delivery fails, preventing false cooldown lockout', async () => {
      const priorSentAt = new Date(Date.now() - 120000);
      const priorExpiresAt = new Date(Date.now() - 60000);
      const mockInvite = createMockInvitation({
        codeHash: 'prior-hmac-hash-1234567890',
        otpSentAt: priorSentAt,
        otpExpiresAt: priorExpiresAt,
        attempts: 2,
      });

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);
      const updateSpy = vi.spyOn(prisma.eventStaffInvitation, 'update').mockResolvedValue({} as any);
      const updateManySpy = vi.spyOn(prisma.eventStaffInvitation, 'updateMany').mockResolvedValue({ count: 1 } as any);
      vi.spyOn(emailService, 'sendStaffOtpEmail').mockRejectedValue(new Error('Resend network timeout'));

      const res = await request(app).post(`/api/staff/invitations/${rawToken}/request-otp`);

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('EMAIL_DELIVERY_FAILED');
      expect(updateSpy).toHaveBeenCalledTimes(1);

      expect(updateManySpy).toHaveBeenCalledWith({
        where: {
          id: mockInvite.id,
          codeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        data: {
          codeHash: 'prior-hmac-hash-1234567890',
          otpSentAt: priorSentAt,
          otpExpiresAt: priorExpiresAt,
          attempts: 2,
        },
      });
    });

    it('does not overwrite concurrent or newer OTP if rollback condition codeHash does not match', async () => {
      const mockInvite = createMockInvitation({
        codeHash: null,
        otpSentAt: null,
        otpExpiresAt: null,
        attempts: 0,
      });

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.eventStaffInvitation, 'update').mockResolvedValue({} as any);
      const updateManySpy = vi.spyOn(prisma.eventStaffInvitation, 'updateMany').mockResolvedValue({ count: 0 } as any);
      vi.spyOn(emailService, 'sendStaffOtpEmail').mockRejectedValue(new Error('SMTP unreachable'));

      const res = await request(app).post(`/api/staff/invitations/${rawToken}/request-otp`);

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('EMAIL_DELIVERY_FAILED');

      const updateManyCall = updateManySpy.mock.calls[0][0];
      expect(updateManyCall.where.id).toBe(mockInvite.id);
      expect(updateManyCall.where.codeHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('releases Redis distributed lock safely via delLockIfMatches even on email delivery failure', async () => {
      const mockInvite = createMockInvitation();
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.eventStaffInvitation, 'update').mockResolvedValue({} as any);
      vi.spyOn(prisma.eventStaffInvitation, 'updateMany').mockResolvedValue({ count: 1 } as any);
      vi.spyOn(emailService, 'sendStaffOtpEmail').mockRejectedValue(new Error('Service Unavailable'));

      const mockRedisClient = {
        setNxPx: vi.fn().mockResolvedValue(true),
        delLockIfMatches: vi.fn().mockResolvedValue(true),
      };
      vi.spyOn(redisModule, 'getRedisClient' as any).mockReturnValue(mockRedisClient as any);

      const res = await request(app).post(`/api/staff/invitations/${rawToken}/request-otp`);

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('EMAIL_DELIVERY_FAILED');
      expect(mockRedisClient.setNxPx).toHaveBeenCalledTimes(1);
      expect(mockRedisClient.delLockIfMatches).toHaveBeenCalledTimes(1);
      const [lockKey, lockId] = mockRedisClient.delLockIfMatches.mock.calls[0];
      expect(lockKey).toBe(`lock:invitation_otp:${mockInvite.id}`);
      expect(lockId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('STG2-02 (AUTH-S02): rejects OTP request on already ACCEPTED invitation with 409 INVITATION_ALREADY_ACCEPTED without writing OTP or sending email', async () => {
      const mockInvite = createMockInvitation({ status: 'ACCEPTED' });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      const updateSpy = vi.spyOn(prisma.eventStaffInvitation, 'update');

      const res = await request(app).post(`/api/staff/invitations/${rawToken}/request-otp`);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVITATION_ALREADY_ACCEPTED');
      expect(updateSpy).not.toHaveBeenCalled();
      expect(emailService.sentStaffOtpEmails.length).toBe(0);
    });

    it('STG2-02: rejects OTP request on ACCEPTED invitation even if invitation expiresAt is in the past', async () => {
      const mockInvite = createMockInvitation({
        status: 'ACCEPTED',
        expiresAt: new Date(Date.now() - 60_000),
      });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);

      const res = await request(app).post(`/api/staff/invitations/${rawToken}/request-otp`);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVITATION_ALREADY_ACCEPTED');
      expect(emailService.sentStaffOtpEmails.length).toBe(0);
    });

    it('STG2-02: rejects OTP request with 409 INVITATION_ALREADY_ACCEPTED when invitation transitions to ACCEPTED concurrently before lock read', async () => {
      const pendingInvite = createMockInvitation({ status: 'PENDING' });
      const acceptedInvite = createMockInvitation({ status: 'ACCEPTED' });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique')
        .mockResolvedValueOnce(pendingInvite as any)
        .mockResolvedValueOnce(acceptedInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);
      const updateSpy = vi.spyOn(prisma.eventStaffInvitation, 'update');

      const res = await request(app).post(`/api/staff/invitations/${rawToken}/request-otp`);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVITATION_ALREADY_ACCEPTED');
      expect(updateSpy).not.toHaveBeenCalled();
      expect(emailService.sentStaffOtpEmails.length).toBe(0);
    });
  });

  describe('3. OTP Verification & Passwordless Session Issuance (POST /api/staff/invitations/:token/verify-otp)', () => {
    it('verifies valid 6-digit OTP, creates passwordless user, activates EventStaff, and issues standard session', async () => {
      const validCode = '849201';
      const secret = env.SESSION_SECRET || env.JWT_SECRET;
      const validHmac = crypto.createHmac('sha256', secret).update(`${invitationId}:${validCode}`).digest('hex');

      const mockInvite = createMockInvitation({
        codeHash: validHmac,
        otpSentAt: new Date(Date.now() - 60000),
        otpExpiresAt: new Date(Date.now() + 500000),
        attempts: 0,
      });

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);

      const createdUser = {
        id: 'new-staff-user-uuid-999',
        email: mockInvite.email,
        name: 'newstaff',
        passwordHash: null,
        role: Role.ATTENDEE,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
      };

      const mockTx = {
        eventStaffInvitation: {
          findUnique: vi.fn().mockResolvedValue(mockInvite),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        user: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(createdUser),
        },
        eventStaff: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: 'staff-assignment-uuid-1',
            eventId,
            userId: createdUser.id,
            status: 'ACTIVE',
          }),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        return callback(mockTx);
      });

      const issuedSessionMock = {
        sessionId: 'sess-128bit-random-id',
        rawCookieValue: 'sess-128bit-random-id.sec256bitval',
        csrfToken: 'csrf-256bit-val',
        record: {} as any,
      };

      vi.spyOn(sessionService, 'rotateSession').mockResolvedValue(issuedSessionMock);

      const res = await request(app)
        .post(`/api/staff/invitations/${rawToken}/verify-otp`)
        .send({ code: validCode });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.id).toBe(createdUser.id);
      expect(res.body.data.user.role).toBe('ATTENDEE');
      expect(res.body.data.status).toBe('ACTIVE');
      expect(res.body.data.csrfToken).toBe('csrf-256bit-val');

      expect(mockTx.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: mockInvite.email,
            passwordHash: null,
            role: Role.ATTENDEE,
            emailVerified: true,
          }),
        })
      );

      expect(mockTx.eventStaffInvitation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockInvite.id, status: 'PENDING' },
          data: expect.objectContaining({
            status: 'ACCEPTED',
            codeHash: null,
            otpExpiresAt: null,
            otpSentAt: null,
            attempts: 0,
          }),
        })
      );
    });

    it('rejects wrong OTP, increments attempts, and invalidates after 5 attempts', async () => {
      const correctCode = '654321';
      const secret = env.SESSION_SECRET || env.JWT_SECRET;
      const codeHash = crypto.createHmac('sha256', secret).update(`${invitationId}:${correctCode}`).digest('hex');

      const mockInvite = createMockInvitation({
        codeHash,
        otpExpiresAt: new Date(Date.now() + 500000),
        attempts: 4, // 5th attempt incoming
      });

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);

      const updateSpy = vi.spyOn(prisma.eventStaffInvitation, 'update').mockResolvedValue({} as any);

      const res = await request(app)
        .post(`/api/staff/invitations/${rawToken}/verify-otp`)
        .send({ code: '000000' }); // wrong code

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_OTP_CODE');

      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockInvite.id },
          data: expect.objectContaining({
            attempts: 5,
            otpExpiresAt: expect.any(Date),
          }),
        })
      );
    });

    it('rejects OTP verification when 5 attempts were already exhausted', async () => {
      const mockInvite = createMockInvitation({
        codeHash: 'dummy-hmac',
        otpExpiresAt: new Date(Date.now() + 500000),
        attempts: 5,
      });

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);

      const res = await request(app)
        .post(`/api/staff/invitations/${rawToken}/verify-otp`)
        .send({ code: '123456' });

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('OTP_MAX_ATTEMPTS');
    });

    it('rejects expired OTP codes', async () => {
      const mockInvite = createMockInvitation({
        codeHash: 'dummy-hmac',
        otpExpiresAt: new Date(Date.now() - 5000), // expired
        attempts: 0,
      });

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);

      const res = await request(app)
        .post(`/api/staff/invitations/${rawToken}/verify-otp`)
        .send({ code: '123456' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('OTP_EXPIRED');
    });

    it('strictly aborts OTP verification if user has a password set', async () => {
      const mockInvite = createMockInvitation({ email: 'admin@outside.vip' });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
        id: 'admin-id-123',
        email: 'admin@outside.vip',
        passwordHash: '$2a$10$existingpasswordhash',
        status: AccountStatus.ACTIVE,
      } as any);

      const res = await request(app)
        .post(`/api/staff/invitations/${rawToken}/verify-otp`)
        .send({ code: '123456' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PASSWORD_LOGIN_REQUIRED');
    });

    it('reactivates an existing revoked EventStaff assignment rather than creating duplicate', async () => {
      const validCode = '112233';
      const secret = env.SESSION_SECRET || env.JWT_SECRET;
      const validHmac = crypto.createHmac('sha256', secret).update(`${invitationId}:${validCode}`).digest('hex');

      const mockInvite = createMockInvitation({
        codeHash: validHmac,
        otpExpiresAt: new Date(Date.now() + 500000),
      });

      const existingPasswordlessUser = {
        id: 'user-passwordless-reuse-777',
        email: mockInvite.email,
        name: 'newstaff',
        passwordHash: null,
        role: Role.ATTENDEE,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
      };

      const existingRevokedStaff = {
        id: 'staff-revoked-assignment-11',
        eventId,
        userId: existingPasswordlessUser.id,
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedByUserId: organizerId,
      };

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(existingPasswordlessUser as any);

      const mockTx = {
        eventStaffInvitation: {
          findUnique: vi.fn().mockResolvedValue(mockInvite),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        user: {
          findUnique: vi.fn().mockResolvedValue(existingPasswordlessUser),
          update: vi.fn().mockResolvedValue(existingPasswordlessUser),
        },
        eventStaff: {
          findUnique: vi.fn().mockResolvedValue(existingRevokedStaff),
          update: vi.fn().mockResolvedValue({
            ...existingRevokedStaff,
            status: 'ACTIVE',
            revokedAt: null,
            revokedByUserId: null,
          }),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        return callback(mockTx);
      });

      vi.spyOn(sessionService, 'rotateSession').mockResolvedValue({
        sessionId: 'sess-1',
        rawCookieValue: 'cookie-val',
        csrfToken: 'csrf-val',
        record: {} as any,
      });

      const res = await request(app)
        .post(`/api/staff/invitations/${rawToken}/verify-otp`)
        .send({ code: validCode });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(mockTx.eventStaff.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: existingRevokedStaff.id },
          data: expect.objectContaining({
            status: 'ACTIVE',
            revokedAt: null,
            revokedByUserId: null,
          }),
        })
      );
    });

    it('STG2-02 (AUTH-S02): rejects OTP verification on ACCEPTED invitation with 409 INVITATION_ALREADY_ACCEPTED and never issues a session', async () => {
      const validCode = '778899';
      const secret = env.SESSION_SECRET || env.JWT_SECRET;
      const validHmac = crypto.createHmac('sha256', secret).update(`${invitationId}:${validCode}`).digest('hex');

      const mockInvite = createMockInvitation({
        status: 'ACCEPTED',
        codeHash: validHmac,
        otpSentAt: new Date(Date.now() - 30000),
        otpExpiresAt: new Date(Date.now() + 500000),
      });

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      const rotateSpy = vi.spyOn(sessionService, 'rotateSession');

      const res = await request(app)
        .post(`/api/staff/invitations/${rawToken}/verify-otp`)
        .send({ code: validCode });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVITATION_ALREADY_ACCEPTED');
      expect(rotateSpy).not.toHaveBeenCalled();
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('STG2-02: rejects OTP verification with 409 INVITATION_ALREADY_ACCEPTED if invitation transitions to ACCEPTED before transaction updateMany', async () => {
      const validCode = '778899';
      const secret = env.SESSION_SECRET || env.JWT_SECRET;
      const validHmac = crypto.createHmac('sha256', secret).update(`${invitationId}:${validCode}`).digest('hex');

      const pendingInvite = createMockInvitation({
        status: 'PENDING',
        codeHash: validHmac,
        otpSentAt: new Date(Date.now() - 30000),
        otpExpiresAt: new Date(Date.now() + 500000),
      });

      const existingStaffUser = {
        id: 'user-race-staff-uuid',
        email: pendingInvite.email,
        name: 'racestaff',
        passwordHash: null,
        role: Role.ATTENDEE,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
      };

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(pendingInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(existingStaffUser as any);

      const mockTx = {
        eventStaffInvitation: {
          findUnique: vi.fn().mockResolvedValue(pendingInvite),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        user: {
          findUnique: vi.fn().mockResolvedValue(existingStaffUser),
        },
        eventStaff: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'staff-1', status: 'ACTIVE' }),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => callback(mockTx));
      const rotateSpy = vi.spyOn(sessionService, 'rotateSession');

      const res = await request(app)
        .post(`/api/staff/invitations/${rawToken}/verify-otp`)
        .send({ code: validCode });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVITATION_ALREADY_ACCEPTED');
      expect(rotateSpy).not.toHaveBeenCalled();
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('4. Existing Account Acceptance (POST /api/staff/invitations/:token/accept)', () => {
    it('STG2-02: rejects already-ACCEPTED invitation on authenticated accept endpoint with 409 INVITATION_ALREADY_ACCEPTED', async () => {
      const mockInvite = createMockInvitation({ status: 'ACCEPTED' });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
        id: 'matching-user-id',
        email: mockInvite.email,
        role: Role.ATTENDEE,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
      } as any);

      const matchingToken = jwt.sign(
        { userId: 'matching-user-id', email: mockInvite.email, role: Role.ATTENDEE, emailVerified: true },
        env.JWT_SECRET
      );

      const res = await request(app)
        .post(`/api/staff/invitations/${rawToken}/accept`)
        .set('Authorization', `Bearer ${matchingToken}`);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVITATION_ALREADY_ACCEPTED');
    });
    it('accepts invitation for authenticated matching user, preserves role and password, and activates staff', async () => {
      const inviteEmail = 'organizer.invitee@outside.vip';
      const mockInvite = createMockInvitation({ email: inviteEmail });

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);

      const authenticatedUser = {
        id: 'user-organizer-invitee-444',
        email: inviteEmail,
        role: Role.ORGANIZER,
        passwordHash: '$2a$10$uncompromisedpasswordhash',
        status: AccountStatus.ACTIVE,
        emailVerified: true,
      };

      const userToken = jwt.sign(
        { userId: authenticatedUser.id, email: inviteEmail, role: 'ORGANIZER', emailVerified: true },
        env.JWT_SECRET
      );

      const mockTx = {
        eventStaffInvitation: {
          findUnique: vi.fn().mockResolvedValue(mockInvite),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        user: {
          findUnique: vi.fn().mockResolvedValue(authenticatedUser),
        },
        eventStaff: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: 'staff-asst-1',
            eventId,
            userId: authenticatedUser.id,
            status: 'ACTIVE',
          }),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        return callback(mockTx);
      });

      const res = await request(app)
        .post(`/api/staff/invitations/${rawToken}/accept`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('ACTIVE');
      expect(res.body.data.user.role).toBe('ORGANIZER'); // Role ORGANIZER preserved!
      expect(res.body.data.user.id).toBe(authenticatedUser.id);

      expect(mockTx.eventStaff.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventId,
            userId: authenticatedUser.id,
            status: 'ACTIVE',
          }),
        })
      );

      expect(mockTx.eventStaffInvitation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockInvite.id, status: 'PENDING' },
          data: expect.objectContaining({
            status: 'ACCEPTED',
          }),
        })
      );
    });

    it('accepts invitation for user authenticated via session cookie and warm Redis user cache', async () => {
      const inviteEmail = 'cookie_staff_accept@outside.vip';
      const mockInvite = createMockInvitation({ email: inviteEmail });
      const staffUserId = `user-cookie-accept-${Date.now()}`;

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);

      const authenticatedUser = {
        id: staffUserId,
        email: inviteEmail,
        role: Role.ATTENDEE,
        passwordHash: null,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
      };

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(authenticatedUser as any);

      const mockTx = {
        eventStaffInvitation: {
          findUnique: vi.fn().mockResolvedValue(mockInvite),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        user: {
          findUnique: vi.fn().mockResolvedValue(authenticatedUser),
        },
        eventStaff: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: 'staff-asst-cookie-1',
            eventId,
            userId: staffUserId,
            status: 'ACTIVE',
          }),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        return callback(mockTx);
      });

      // Create a valid session and warm the user auth cache in Redis
      const issuedSession = await sessionService.createSession({ userId: staffUserId });
      const ver = await sessionService.getUserAuthCacheVersion(staffUserId);
      await sessionService.populateUserAuthCacheAtomically({
        userId: staffUserId,
        email: inviteEmail,
        role: Role.ATTENDEE,
        emailVerified: true,
        accountStatus: AccountStatus.ACTIVE,
      }, ver);

      const res = await request(app)
        .post(`/api/staff/invitations/${rawToken}/accept`)
        .set('Cookie', `${sessionService.SESSION_COOKIE_NAME}=${encodeURIComponent(issuedSession.rawCookieValue)}`)
        .set('X-CSRF-Token', issuedSession.csrfToken);

      expect(res.body.error).toBeUndefined();
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('ACTIVE');
      expect(res.body.data.user.id).toBe(staffUserId);
    });

    it('rejects acceptance with 403 Forbidden when authenticated user email does not match invitation email', async () => {
      const mockInvite = createMockInvitation({ email: 'target.staff@outside.vip' });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);

      const mismatchedToken = jwt.sign(
        { userId: 'different-user-888', email: 'mismatched@outside.vip', role: 'ATTENDEE', emailVerified: true },
        env.JWT_SECRET
      );

      const res = await request(app)
        .post(`/api/staff/invitations/${rawToken}/accept`)
        .set('Authorization', `Bearer ${mismatchedToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INVITATION_EMAIL_MISMATCH');
      expect(res.body.error.message).toContain('Please sign in with the invited account');
    });

    it('rejects unauthenticated requests to accept endpoint with 401 Unauthorized', async () => {
      const res = await request(app).post(`/api/staff/invitations/${rawToken}/accept`);
      expect(res.status).toBe(401);
    });

    it('S2R-05: rejects explicitly persisted status EXPIRED on authenticated accept endpoint with 410 INVITATION_EXPIRED', async () => {
      const mockInvite = createMockInvitation({
        status: 'EXPIRED',
        expiresAt: new Date(Date.now() + 3600_000),
      });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
        id: 'matching-expired-user',
        email: mockInvite.email,
        role: Role.ATTENDEE,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
      } as any);

      const userToken = jwt.sign(
        { userId: 'matching-expired-user', email: mockInvite.email, role: Role.ATTENDEE, emailVerified: true },
        env.JWT_SECRET
      );

      const res = await request(app)
        .post(`/api/staff/invitations/${rawToken}/accept`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('INVITATION_EXPIRED');
    });
  });

  describe('5. Concurrency & State Invariants', () => {
    it('prevents acceptance if invitation was revoked concurrently during transaction', async () => {
      const mockInvite = createMockInvitation();
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);

      const userToken = jwt.sign(
        { userId: 'u-1', email: mockInvite.email, role: 'ATTENDEE', emailVerified: true },
        env.JWT_SECRET
      );

      // Recheck inside transaction finds that another thread revoked it:
      const mockTx = {
        eventStaffInvitation: {
          findUnique: vi.fn().mockResolvedValue({ ...mockInvite, status: 'REVOKED' }),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        return callback(mockTx);
      });

      const res = await request(app)
        .post(`/api/staff/invitations/${rawToken}/accept`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVITATION_INVALID');
    });

    it('STG2-02 concurrency: two concurrent authenticated accept requests on a PENDING invitation produce exactly one 200 and one 409 INVITATION_ALREADY_ACCEPTED', async () => {
      const inviteEmail = 'concurrent.accept@outside.vip';
      const mockInvite = createMockInvitation({ status: 'PENDING', email: inviteEmail });
      const activeUser = {
        id: 'user-concurrent-accept-1',
        email: inviteEmail,
        role: Role.ATTENDEE,
        passwordHash: null,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
      };

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(activeUser as any);

      let pendingClaimed = false;
      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const mockTx = {
          eventStaffInvitation: {
            findUnique: vi.fn().mockResolvedValue(mockInvite),
            updateMany: vi.fn().mockImplementation(async () => {
              if (!pendingClaimed) {
                pendingClaimed = true;
                return { count: 1 };
              }
              return { count: 0 };
            }),
          },
          user: {
            findUnique: vi.fn().mockResolvedValue(activeUser),
          },
          eventStaff: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: 'staff-conc-1', status: 'ACTIVE' }),
          },
        };
        return callback(mockTx);
      });

      const userToken = jwt.sign(
        { userId: activeUser.id, email: inviteEmail, role: Role.ATTENDEE, emailVerified: true },
        env.JWT_SECRET
      );

      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/api/staff/invitations/${rawToken}/accept`)
          .set('Authorization', `Bearer ${userToken}`),
        request(app)
          .post(`/api/staff/invitations/${rawToken}/accept`)
          .set('Authorization', `Bearer ${userToken}`),
      ]);

      const statuses = [res1.status, res2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);
      const conflictRes = res1.status === 409 ? res1 : res2;
      expect(conflictRes.body.error.code).toBe('INVITATION_ALREADY_ACCEPTED');
    });

    it('STG2-02 concurrency: two concurrent verify-otp calls on a PENDING invitation produce exactly one 200 session and one 409 INVITATION_ALREADY_ACCEPTED', async () => {
      const validCode = '246810';
      const secret = env.SESSION_SECRET || env.JWT_SECRET;
      const validHmac = crypto
        .createHmac('sha256', secret)
        .update(`${invitationId}:${validCode}`)
        .digest('hex');

      const mockInvite = createMockInvitation({
        status: 'PENDING',
        codeHash: validHmac,
        otpSentAt: new Date(Date.now() - 30000),
        otpExpiresAt: new Date(Date.now() + 500000),
      });

      const activeUser = {
        id: 'user-concurrent-otp-1',
        email: mockInvite.email,
        name: 'concstaff',
        role: Role.ATTENDEE,
        passwordHash: null,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
      };

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(activeUser as any);

      let pendingClaimed = false;
      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const mockTx = {
          eventStaffInvitation: {
            findUnique: vi.fn().mockResolvedValue(mockInvite),
            updateMany: vi.fn().mockImplementation(async () => {
              if (!pendingClaimed) {
                pendingClaimed = true;
                return { count: 1 };
              }
              return { count: 0 };
            }),
          },
          user: {
            findUnique: vi.fn().mockResolvedValue(activeUser),
          },
          eventStaff: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: 'staff-conc-otp-1', status: 'ACTIVE' }),
          },
        };
        return callback(mockTx);
      });

      const rotateSpy = vi.spyOn(sessionService, 'rotateSession').mockResolvedValue({
        sessionId: 'sess-conc-win',
        rawCookieValue: 'sess-conc-win.secret',
        csrfToken: 'csrf-conc-win',
        record: {} as any,
      });

      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/api/staff/invitations/${rawToken}/verify-otp`)
          .send({ code: validCode }),
        request(app)
          .post(`/api/staff/invitations/${rawToken}/verify-otp`)
          .send({ code: validCode }),
      ]);

      const statuses = [res1.status, res2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);
      expect(rotateSpy).toHaveBeenCalledTimes(1);
      const conflictRes = res1.status === 409 ? res1 : res2;
      expect(conflictRes.body.error.code).toBe('INVITATION_ALREADY_ACCEPTED');
      expect(conflictRes.headers['set-cookie']).toBeUndefined();
    });

    it('S2R-03: executes conditional updateMany claim BEFORE user.create and eventStaff.create in verifyInvitationOtp and skips writes on count=0', async () => {
      const validCode = '135790';
      const secret = env.SESSION_SECRET || env.JWT_SECRET;
      const validHmac = crypto
        .createHmac('sha256', secret)
        .update(`${invitationId}:${validCode}`)
        .digest('hex');

      const mockInvite = createMockInvitation({
        status: 'PENDING',
        codeHash: validHmac,
        otpSentAt: new Date(Date.now() - 30000),
        otpExpiresAt: new Date(Date.now() + 500000),
      });

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);

      const callOrder: string[] = [];
      const createdUser = {
        id: 'user-order-verify-1',
        email: mockInvite.email,
        name: 'orderstaff',
        passwordHash: null,
        role: Role.ATTENDEE,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
      };

      const mockTx = {
        eventStaffInvitation: {
          findUnique: vi.fn().mockResolvedValue(mockInvite),
          updateMany: vi.fn().mockImplementation(async () => {
            callOrder.push('invitation.updateMany');
            return { count: 1 };
          }),
        },
        user: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation(async () => {
            callOrder.push('user.create');
            return createdUser;
          }),
        },
        eventStaff: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation(async () => {
            callOrder.push('eventStaff.create');
            return { id: 'staff-order-1', status: 'ACTIVE' };
          }),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => callback(mockTx));
      vi.spyOn(sessionService, 'rotateSession').mockResolvedValue({
        sessionId: 'sess-order-1',
        rawCookieValue: 'sess-order-1.secret',
        csrfToken: 'csrf-order-1',
        record: {} as any,
      });

      const res = await request(app)
        .post(`/api/staff/invitations/${rawToken}/verify-otp`)
        .send({ code: validCode });

      expect(res.status).toBe(200);
      expect(callOrder).toEqual(['invitation.updateMany', 'user.create', 'eventStaff.create']);

      // Now verify count=0 aborts before user.create or eventStaff.create
      mockTx.eventStaffInvitation.updateMany.mockResolvedValueOnce({ count: 0 });
      mockTx.user.create.mockClear();
      mockTx.eventStaff.create.mockClear();

      const loserRes = await request(app)
        .post(`/api/staff/invitations/${rawToken}/verify-otp`)
        .send({ code: validCode });

      expect(loserRes.status).toBe(409);
      expect(loserRes.body.error.code).toBe('INVITATION_ALREADY_ACCEPTED');
      expect(mockTx.user.create).not.toHaveBeenCalled();
      expect(mockTx.eventStaff.create).not.toHaveBeenCalled();
    });

    it('S2R-03: executes conditional updateMany claim BEFORE eventStaff.create in acceptInvitationWithSession and resolves concurrent verify-otp vs accept deterministically', async () => {
      const validCode = '975310';
      const secret = env.SESSION_SECRET || env.JWT_SECRET;
      const validHmac = crypto
        .createHmac('sha256', secret)
        .update(`${invitationId}:${validCode}`)
        .digest('hex');

      const mockInvite = createMockInvitation({
        status: 'PENDING',
        codeHash: validHmac,
        otpSentAt: new Date(Date.now() - 30000),
        otpExpiresAt: new Date(Date.now() + 500000),
      });

      const activeUser = {
        id: 'user-race-verify-accept-1',
        email: mockInvite.email,
        name: 'raceuser',
        passwordHash: null,
        role: Role.ATTENDEE,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
      };

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(activeUser as any);

      let pendingClaimed = false;
      const callOrder: string[] = [];
      let staffCreateCalls = 0;

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const mockTx = {
          eventStaffInvitation: {
            findUnique: vi.fn().mockResolvedValue(mockInvite),
            updateMany: vi.fn().mockImplementation(async () => {
              callOrder.push('invitation.updateMany');
              if (!pendingClaimed) {
                pendingClaimed = true;
                return { count: 1 };
              }
              return { count: 0 };
            }),
          },
          user: {
            findUnique: vi.fn().mockResolvedValue(activeUser),
          },
          eventStaff: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockImplementation(async () => {
              callOrder.push('eventStaff.create');
              staffCreateCalls++;
              return { id: 'staff-race-va-1', status: 'ACTIVE' };
            }),
          },
        };
        return callback(mockTx);
      });

      vi.spyOn(sessionService, 'rotateSession').mockResolvedValue({
        sessionId: 'sess-va-win',
        rawCookieValue: 'sess-va-win.secret',
        csrfToken: 'csrf-va-win',
        record: {} as any,
      });

      const userToken = jwt.sign(
        { userId: activeUser.id, email: activeUser.email, role: Role.ATTENDEE, emailVerified: true },
        env.JWT_SECRET
      );

      // Concurrent mocked verify-otp vs authenticated accept
      const [otpRes, acceptRes] = await Promise.all([
        request(app)
          .post(`/api/staff/invitations/${rawToken}/verify-otp`)
          .send({ code: validCode }),
        request(app)
          .post(`/api/staff/invitations/${rawToken}/accept`)
          .set('Authorization', `Bearer ${userToken}`),
      ]);

      const statuses = [otpRes.status, acceptRes.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);
      expect(staffCreateCalls).toBe(1);
      expect(callOrder.indexOf('invitation.updateMany')).toBeLessThan(
        callOrder.indexOf('eventStaff.create')
      );
      const conflictRes = otpRes.status === 409 ? otpRes : acceptRes;
      expect(conflictRes.body.error.code).toBe('INVITATION_ALREADY_ACCEPTED');
    });

    it('S2R-03: failed user.create inside verifyInvitationOtp aborts transaction cleanly without issuing follow-up tx queries or session', async () => {
      const validCode = '112233';
      const secret = env.SESSION_SECRET || env.JWT_SECRET;
      const validHmac = crypto
        .createHmac('sha256', secret)
        .update(`${invitationId}:${validCode}`)
        .digest('hex');

      const mockInvite = createMockInvitation({
        status: 'PENDING',
        codeHash: validHmac,
        otpSentAt: new Date(Date.now() - 30000),
        otpExpiresAt: new Date(Date.now() + 500000),
      });

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);

      const userFindInTx = vi.fn().mockResolvedValue(null);
      const staffCreateInTx = vi.fn();
      const txError = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const mockTx = {
          eventStaffInvitation: {
            findUnique: vi.fn().mockResolvedValue(mockInvite),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          user: {
            findUnique: userFindInTx,
            create: vi.fn().mockRejectedValue(txError),
          },
          eventStaff: {
            findUnique: vi.fn(),
            create: staffCreateInTx,
          },
        };
        return callback(mockTx);
      });

      const rotateSpy = vi.spyOn(sessionService, 'rotateSession');

      const res = await request(app)
        .post(`/api/staff/invitations/${rawToken}/verify-otp`)
        .send({ code: validCode });

      expect(res.status).toBeGreaterThanOrEqual(400);
      // user.findUnique was called ONLY once (pre-check), NEVER retried inside aborted tx
      expect(userFindInTx).toHaveBeenCalledTimes(1);
      expect(staffCreateInTx).not.toHaveBeenCalled();
      expect(rotateSpy).not.toHaveBeenCalled();
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('6. Stage 1 Security Hardening (AUTH-S01 & AUTH-S05)', () => {
    it('AUTH-S01: rejects SUSPENDED account during staff invitation OTP request and verification without issuing session or fabricating ACTIVE cache', async () => {
      const validCode = '445566';
      const secret = env.SESSION_SECRET || env.JWT_SECRET;
      const validHmac = crypto
        .createHmac('sha256', secret)
        .update(`${invitationId}:${validCode}`)
        .digest('hex');

      const mockInvite = createMockInvitation({
        status: 'PENDING',
        codeHash: validHmac,
        otpSentAt: new Date(Date.now() - 30000),
        otpExpiresAt: new Date(Date.now() + 500000),
      });

      const suspendedUser = {
        id: 'user-suspended-staff-901',
        email: mockInvite.email,
        passwordHash: null,
        status: AccountStatus.SUSPENDED,
      };

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(suspendedUser as any);
      const rotateSpy = vi.spyOn(sessionService, 'rotateSession');
      const cachePopulateSpy = vi.spyOn(sessionService, 'populateUserAuthCacheAtomically');

      const reqOtpRes = await request(app).post(`/api/staff/invitations/${rawToken}/request-otp`);
      expect(reqOtpRes.status).toBe(403);
      expect(reqOtpRes.body.error.code).toBe('ACCOUNT_SUSPENDED');
      expect(emailService.sentStaffOtpEmails).toHaveLength(0);

      const verifyRes = await request(app)
        .post(`/api/staff/invitations/${rawToken}/verify-otp`)
        .send({ code: validCode });
      expect(verifyRes.status).toBe(403);
      expect(verifyRes.body.error.code).toBe('ACCOUNT_SUSPENDED');
      expect(rotateSpy).not.toHaveBeenCalled();
      expect(cachePopulateSpy).not.toHaveBeenCalled();
    });

    it('AUTH-S01: rejects DISABLED account during staff invitation OTP verification even if disabled concurrently inside transaction', async () => {
      const validCode = '332211';
      const secret = env.SESSION_SECRET || env.JWT_SECRET;
      const validHmac = crypto
        .createHmac('sha256', secret)
        .update(`${invitationId}:${validCode}`)
        .digest('hex');

      const mockInvite = createMockInvitation({
        status: 'PENDING',
        codeHash: validHmac,
        otpSentAt: new Date(Date.now() - 30000),
        otpExpiresAt: new Date(Date.now() + 500000),
      });

      const activePreCheckUser = {
        id: 'user-disabled-race-902',
        email: mockInvite.email,
        passwordHash: null,
        status: AccountStatus.ACTIVE,
      };
      const disabledInTxUser = {
        ...activePreCheckUser,
        status: AccountStatus.DISABLED,
      };

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(activePreCheckUser as any);
      const rotateSpy = vi.spyOn(sessionService, 'rotateSession');
      const cachePopulateSpy = vi.spyOn(sessionService, 'populateUserAuthCacheAtomically');

      const mockTx = {
        eventStaffInvitation: {
          findUnique: vi.fn().mockResolvedValue(mockInvite),
          update: vi.fn(),
        },
        user: {
          findUnique: vi.fn().mockResolvedValue(disabledInTxUser),
        },
        eventStaff: {
          findUnique: vi.fn(),
          create: vi.fn(),
          update: vi.fn(),
        },
      };
      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => callback(mockTx));

      const verifyRes = await request(app)
        .post(`/api/staff/invitations/${rawToken}/verify-otp`)
        .send({ code: validCode });

      expect(verifyRes.status).toBe(403);
      expect(verifyRes.body.error.code).toBe('ACCOUNT_DISABLED');
      expect(rotateSpy).not.toHaveBeenCalled();
      expect(cachePopulateSpy).not.toHaveBeenCalled();
      expect(mockTx.eventStaff.create).not.toHaveBeenCalled();
    });

    it('AUTH-S05: rejects staff invitation session acceptance when authenticated user email is unverified', async () => {
      const inviteEmail = 'unverified.staff@outside.vip';
      const mockInvite = createMockInvitation({ email: inviteEmail });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);

      const unverifiedToken = jwt.sign(
        {
          userId: 'user-unverified-903',
          email: inviteEmail,
          role: Role.ATTENDEE,
          emailVerified: false,
        },
        env.JWT_SECRET
      );

      const res = await request(app)
        .post(`/api/staff/invitations/${rawToken}/accept`)
        .set('Authorization', `Bearer ${unverifiedToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('Email verification is required');
    });

    it('Finding 3: invalidates auth cache, revokes all sessions, and clears cookie when account becomes SUSPENDED/DISABLED concurrently inside verifyInvitationOtp transaction (PENDING branch)', async () => {
      const validCode = '665544';
      const secret = env.SESSION_SECRET || env.JWT_SECRET;
      const validHmac = crypto
        .createHmac('sha256', secret)
        .update(`${invitationId}:${validCode}`)
        .digest('hex');

      // 1) PENDING branch concurrent SUSPENDED inside transaction
      const pendingTxInvite = createMockInvitation({
        status: 'PENDING',
        codeHash: validHmac,
        otpSentAt: new Date(Date.now() - 30000),
        otpExpiresAt: new Date(Date.now() + 500000),
      });

      const activePreUser = {
        id: 'user-race-pending-904',
        email: pendingTxInvite.email,
        passwordHash: null,
        status: AccountStatus.ACTIVE,
      };
      const suspendedInTxUser = {
        ...activePreUser,
        status: AccountStatus.SUSPENDED,
      };

      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(pendingTxInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(activePreUser as any);

      const invalidateSpy = vi.spyOn(sessionService, 'invalidateUserAuthCache');
      const revokeAllSpy = vi.spyOn(sessionService, 'revokeAllUserSessions');
      const clearCookieSpy = vi.spyOn(sessionService, 'clearSessionCookie');
      const rotateSpy = vi.spyOn(sessionService, 'rotateSession');

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) =>
        callback({
          eventStaffInvitation: { findUnique: vi.fn().mockResolvedValue(pendingTxInvite) },
          user: { findUnique: vi.fn().mockResolvedValue(suspendedInTxUser) },
          eventStaff: { findUnique: vi.fn() },
        })
      );

      const pendingTxRes = await request(app)
        .post(`/api/staff/invitations/${rawToken}/verify-otp`)
        .send({ code: validCode });

      expect(pendingTxRes.status).toBe(403);
      expect(pendingTxRes.body.error.code).toBe('ACCOUNT_SUSPENDED');
      expect(invalidateSpy).toHaveBeenCalledWith(activePreUser.id);
      expect(revokeAllSpy).toHaveBeenCalledWith(activePreUser.id);
      expect(clearCookieSpy).toHaveBeenCalled();
      expect(rotateSpy).not.toHaveBeenCalled();

      // 2) PENDING branch pre-check DISABLED
      vi.clearAllMocks();
      vi.spyOn(sessionService, 'checkRedisRateLimit').mockResolvedValue(true);
      const pendingInvite = createMockInvitation({
        status: 'PENDING',
        codeHash: validHmac,
        otpSentAt: new Date(Date.now() - 30000),
        otpExpiresAt: new Date(Date.now() + 500000),
      });
      const disabledPreUser = {
        id: 'user-disabled-pending-905',
        email: pendingInvite.email,
        passwordHash: null,
        status: AccountStatus.DISABLED,
      };
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(pendingInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(disabledPreUser as any);

      const pendingRes = await request(app)
        .post(`/api/staff/invitations/${rawToken}/verify-otp`)
        .send({ code: validCode });

      expect(pendingRes.status).toBe(403);
      expect(pendingRes.body.error.code).toBe('ACCOUNT_DISABLED');
      expect(invalidateSpy).toHaveBeenCalledWith(disabledPreUser.id);
      expect(revokeAllSpy).toHaveBeenCalledWith(disabledPreUser.id);
      expect(clearCookieSpy).toHaveBeenCalled();
    });

    it('Finding 4: rejects SUSPENDED, DISABLED, and unverified users in ALREADY-ACCEPTED and PENDING session acceptance even when Redis user cache is stale', async () => {
      const inviteEmail = 'stale.cache.staff@outside.vip';
      const userId = `user-stale-cache-${Date.now()}`;

      // Seed active session + STALE warm Redis user cache claiming ACTIVE + emailVerified: true
      const issuedSession = await sessionService.createSession({ userId });
      const ver = await sessionService.getUserAuthCacheVersion(userId);
      await sessionService.populateUserAuthCacheAtomically(
        {
          userId,
          email: inviteEmail,
          role: Role.ATTENDEE,
          emailVerified: true,
          accountStatus: AccountStatus.ACTIVE,
        },
        ver
      );

      // Case A: Already-ACCEPTED invitation, authoritative DB shows emailVerified: false
      const acceptedInvite = createMockInvitation({ status: 'ACCEPTED', email: inviteEmail });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(acceptedInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
        id: userId,
        email: inviteEmail,
        role: Role.ATTENDEE,
        status: AccountStatus.ACTIVE,
        emailVerified: false,
      } as any);

      const unverifiedAcceptedRes = await request(app)
        .post(`/api/staff/invitations/${rawToken}/accept`)
        .set(
          'Cookie',
          `${sessionService.SESSION_COOKIE_NAME}=${encodeURIComponent(issuedSession.rawCookieValue)}`
        )
        .set('X-CSRF-Token', issuedSession.csrfToken);

      expect(unverifiedAcceptedRes.status).toBe(403);
      expect(unverifiedAcceptedRes.body.error.message).toContain('Email verification is required');

      // Case B: Already-ACCEPTED invitation, authoritative DB shows SUSPENDED
      const session2 = await sessionService.createSession({ userId });
      const ver2 = await sessionService.getUserAuthCacheVersion(userId);
      await sessionService.populateUserAuthCacheAtomically(
        {
          userId,
          email: inviteEmail,
          role: Role.ATTENDEE,
          emailVerified: true,
          accountStatus: AccountStatus.ACTIVE,
        },
        ver2
      );
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
        id: userId,
        email: inviteEmail,
        role: Role.ATTENDEE,
        status: AccountStatus.SUSPENDED,
        emailVerified: true,
      } as any);

      const suspendedAcceptedRes = await request(app)
        .post(`/api/staff/invitations/${rawToken}/accept`)
        .set(
          'Cookie',
          `${sessionService.SESSION_COOKIE_NAME}=${encodeURIComponent(session2.rawCookieValue)}`
        )
        .set('X-CSRF-Token', session2.csrfToken);

      expect(suspendedAcceptedRes.status).toBe(403);
      expect(suspendedAcceptedRes.body.error.code).toBe('ACCOUNT_SUSPENDED');

      // Case C: PENDING invitation, authoritative DB shows DISABLED
      const pendingUserId = `user-pending-disabled-${Date.now()}`;
      const session3 = await sessionService.createSession({ userId: pendingUserId });
      const ver3 = await sessionService.getUserAuthCacheVersion(pendingUserId);
      await sessionService.populateUserAuthCacheAtomically(
        {
          userId: pendingUserId,
          email: inviteEmail,
          role: Role.ATTENDEE,
          emailVerified: true,
          accountStatus: AccountStatus.ACTIVE,
        },
        ver3
      );
      const pendingInvite = createMockInvitation({ status: 'PENDING', email: inviteEmail });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(pendingInvite as any);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
        id: pendingUserId,
        email: inviteEmail,
        role: Role.ATTENDEE,
        status: AccountStatus.DISABLED,
        emailVerified: true,
      } as any);

      const disabledPendingRes = await request(app)
        .post(`/api/staff/invitations/${rawToken}/accept`)
        .set(
          'Cookie',
          `${sessionService.SESSION_COOKIE_NAME}=${encodeURIComponent(session3.rawCookieValue)}`
        )
        .set('X-CSRF-Token', session3.csrfToken);

      expect(disabledPendingRes.status).toBe(403);
      expect(disabledPendingRes.body.error.code).toBe('ACCOUNT_DISABLED');
    });

    it('Finding 6: getInvitationMetadata does not advertise canResumeSession: true for SUSPENDED or DISABLED accounts', async () => {
      const acceptedInvite = createMockInvitation({ status: 'ACCEPTED' });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(acceptedInvite as any);
      vi.spyOn(prisma.eventStaff, 'findUnique').mockResolvedValue({
        id: 'staff-assignment-active',
        status: 'ACTIVE',
      } as any);

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
        id: 'staff-user-susp',
        email: acceptedInvite.email,
        passwordHash: null,
        status: AccountStatus.SUSPENDED,
      } as any);
      const suspRes = await request(app).get(`/api/staff/invitations/${rawToken}`);
      expect(suspRes.status).toBe(200);
      expect(suspRes.body.data.invitation.canResumeSession).toBe(false);

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
        id: 'staff-user-dis',
        email: acceptedInvite.email,
        passwordHash: null,
        status: AccountStatus.DISABLED,
      } as any);
      const disRes = await request(app).get(`/api/staff/invitations/${rawToken}`);
      expect(disRes.status).toBe(200);
      expect(disRes.body.data.invitation.canResumeSession).toBe(false);
    });
  });
});
