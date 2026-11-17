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

    it('returns 400 INVITATION_ALREADY_ACCEPTED when invitation was already accepted', async () => {
      const mockInvite = createMockInvitation({ status: 'ACCEPTED' });
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(mockInvite as any);

      const res = await request(app).get(`/api/staff/invitations/${rawToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVITATION_ALREADY_ACCEPTED');
    });

    it('returns 404 INVITATION_NOT_FOUND when token hash does not exist', async () => {
      vi.spyOn(prisma.eventStaffInvitation, 'findUnique').mockResolvedValue(null);

      const res = await request(app).get(`/api/staff/invitations/${rawToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVITATION_NOT_FOUND');
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
          update: vi.fn().mockResolvedValue({ ...mockInvite, status: 'ACCEPTED' }),
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

      expect(mockTx.eventStaffInvitation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockInvite.id },
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
          update: vi.fn().mockResolvedValue({ ...mockInvite, status: 'ACCEPTED' }),
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
  });

  describe('4. Existing Account Acceptance (POST /api/staff/invitations/:token/accept)', () => {
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
      };

      const userToken = jwt.sign(
        { userId: authenticatedUser.id, email: inviteEmail, role: 'ORGANIZER', emailVerified: true },
        env.JWT_SECRET
      );

      const mockTx = {
        eventStaffInvitation: {
          findUnique: vi.fn().mockResolvedValue(mockInvite),
          update: vi.fn().mockResolvedValue({ ...mockInvite, status: 'ACCEPTED' }),
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

      expect(mockTx.eventStaffInvitation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockInvite.id },
          data: expect.objectContaining({
            status: 'ACCEPTED',
          }),
        })
      );
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
  });
});
