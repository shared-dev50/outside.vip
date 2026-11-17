import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env, normalizeEmail } from '../../config/env.js';
import {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  TooManyRequestsError,
  ServiceUnavailableError,
} from '../../utils/errors.js';
import { checkRedisRateLimit } from '../../lib/session.service.js';
import { sendStaffInvitationEmail } from '../../lib/email.service.js';
import {
  inviteStaffSchema,
  eventStaffParamsSchema,
  eventInvitationParamsSchema,
  eventStaffMemberParamsSchema,
} from './staff.schema.js';

const INVITATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_INVITES_PER_WINDOW = 20;
const INVITE_RATE_WINDOW_MS = 15 * 60 * 1000;

function requireOrganizerOrAdmin(role: Role): void {
  if (role !== Role.ORGANIZER && role !== Role.ADMIN) {
    throw new ForbiddenError('Only event organizers and administrators can manage event staff');
  }
}

async function resolveAuthorizedEvent(eventId: string, userId: string, isAdmin: boolean) {
  const event = await prisma.event.findFirst({
    where: {
      OR: [{ id: eventId }, { slug: eventId }],
    },
    select: {
      id: true,
      title: true,
      organizerId: true,
      organizer: {
        select: {
          name: true,
          organizer: {
            select: {
              displayName: true,
            },
          },
        },
      },
    },
  });

  if (!event) {
    throw new NotFoundError('Event not found');
  }

  if (event.organizerId !== userId && !isAdmin) {
    throw new ForbiddenError('You do not have permission to manage staff for this event');
  }

  return event;
}

export async function getEventTeam(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = req.user!;
    requireOrganizerOrAdmin(user.role);

    const parsed = eventStaffParamsSchema.parse(req.params);
    const eventId = (parsed.eventId || parsed.id)!;
    const event = await resolveAuthorizedEvent(eventId, user.userId, user.role === Role.ADMIN);

    const [staff, invitations] = await Promise.all([
      prisma.eventStaff.findMany({
        where: { eventId: event.id },
        select: {
          id: true,
          eventId: true,
          userId: true,
          email: true,
          status: true,
          assignedAt: true,
          revokedAt: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              avatarUrl: true,
            },
          },
          assignedByUser: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          revokedByUser: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.eventStaffInvitation.findMany({
        where: { eventId: event.id },
        select: {
          id: true,
          eventId: true,
          email: true,
          status: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
          createdAt: true,
          updatedAt: true,
          invitedByUser: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    res.json({
      success: true,
      data: {
        team: staff,
        invitations,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function inviteStaff(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = req.user!;
    requireOrganizerOrAdmin(user.role);

    const parsed = eventStaffParamsSchema.parse(req.params);
    const eventId = (parsed.eventId || parsed.id)!;
    const input = inviteStaffSchema.parse(req.body);
    const normalizedEmail = normalizeEmail(input.email);

    const event = await resolveAuthorizedEvent(eventId, user.userId, user.role === Role.ADMIN);

    if (user.email && normalizeEmail(user.email) === normalizedEmail) {
      throw new BadRequestError(
        'You cannot invite yourself as staff for your own event.',
        'SELF_INVITATION_NOT_ALLOWED'
      );
    }

    const rateKey = `staff_invite:${user.userId}:${event.id}`;
    const isRateAllowed = await checkRedisRateLimit(rateKey, MAX_INVITES_PER_WINDOW, INVITE_RATE_WINDOW_MS);
    if (!isRateAllowed) {
      throw new TooManyRequestsError(
        'Too many invitations sent recently. Please wait before inviting more staff.',
        'INVITATION_RATE_LIMIT'
      );
    }

    const existingActiveStaff = await prisma.eventStaff.findFirst({
      where: {
        eventId: event.id,
        email: normalizedEmail,
        status: 'ACTIVE',
      },
    });

    if (existingActiveStaff) {
      throw new ConflictError(
        'This user is already an active staff member for this event.',
        'STAFF_ALREADY_ACTIVE'
      );
    }

    const now = new Date();
    const existingPendingInvite = await prisma.eventStaffInvitation.findFirst({
      where: {
        eventId: event.id,
        email: normalizedEmail,
        status: 'PENDING',
        expiresAt: { gt: now },
      },
    });

    if (existingPendingInvite) {
      throw new ConflictError(
        'An active invitation has already been sent to this email address.',
        'INVITATION_ALREADY_PENDING'
      );
    }

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_MS);

    const invitation = await prisma.eventStaffInvitation.create({
      data: {
        eventId: event.id,
        email: normalizedEmail,
        invitedByUserId: user.userId,
        tokenHash,
        status: 'PENDING',
        expiresAt,
      },
      select: {
        id: true,
        eventId: true,
        email: true,
        status: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    const baseUrl = (env.CLIENT_URL || 'https://out-side.vip').replace(/\/+$/, '');
    const inviteUrl = `${baseUrl}/staff/invitations/${rawToken}`;
    const organizerName =
      event.organizer?.organizer?.displayName || event.organizer?.name || 'The event organizer';

    let emailDelivery;
    try {
      emailDelivery = await sendStaffInvitationEmail({
        to: normalizedEmail,
        eventTitle: event.title,
        organizerName,
        inviteUrl,
        expiresInDays: 7,
        idempotencyKey: `staff-invite-${invitation.id}`,
      });
    } catch {
      throw new ServiceUnavailableError(
        'Staff invitation created, but the invitation email could not be delivered. Please use the resend option to try again.',
        'EMAIL_DELIVERY_FAILED'
      );
    }

    res.status(201).json({
      success: true,
      data: {
        invitation,
        emailDelivery: {
          sent: emailDelivery.sent,
          status: emailDelivery.status,
        },
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function resendInvitation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = req.user!;
    requireOrganizerOrAdmin(user.role);

    const parsed = eventInvitationParamsSchema.parse(req.params);
    const eventId = (parsed.eventId || parsed.id)!;
    const { invitationId } = parsed;
    const event = await resolveAuthorizedEvent(eventId, user.userId, user.role === Role.ADMIN);

    const invitation = await prisma.eventStaffInvitation.findFirst({
      where: {
        id: invitationId,
        eventId: event.id,
      },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found', 'INVITATION_NOT_FOUND');
    }

    if (invitation.status !== 'PENDING') {
      throw new BadRequestError(
        'Only pending invitations can be resent.',
        'INVITATION_NOT_PENDING'
      );
    }

    const now = new Date();
    if (invitation.expiresAt.getTime() <= now.getTime()) {
      throw new BadRequestError(
        'This invitation has expired. Please create a new invitation.',
        'INVITATION_EXPIRED'
      );
    }

    const cooldownKey = `staff_resend_cooldown:${invitation.id}`;
    const isCooldownAllowed = await checkRedisRateLimit(cooldownKey, 1, RESEND_COOLDOWN_MS);
    if (!isCooldownAllowed) {
      throw new TooManyRequestsError(
        'Please wait at least 60 seconds before resending this invitation.',
        'RESEND_COOLDOWN'
      );
    }

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const newTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const baseUrl = (env.CLIENT_URL || 'https://out-side.vip').replace(/\/+$/, '');
    const inviteUrl = `${baseUrl}/staff/invitations/${rawToken}`;
    const organizerName =
      event.organizer?.organizer?.displayName || event.organizer?.name || 'The event organizer';

    let emailDelivery;
    try {
      emailDelivery = await sendStaffInvitationEmail({
        to: invitation.email,
        eventTitle: event.title,
        organizerName,
        inviteUrl,
        expiresInDays: 7,
        idempotencyKey: `staff-invite-resend-${invitation.id}-${Date.now()}`,
      });
    } catch {
      throw new ServiceUnavailableError(
        'Staff invitation resend email could not be delivered. The previous invitation link remains active.',
        'EMAIL_DELIVERY_FAILED'
      );
    }

    const updated = await prisma.eventStaffInvitation.update({
      where: { id: invitation.id },
      data: {
        tokenHash: newTokenHash,
      },
      select: {
        id: true,
        eventId: true,
        email: true,
        status: true,
        expiresAt: true,
        updatedAt: true,
      },
    });

    res.json({
      success: true,
      data: {
        invitation: updated,
        emailDelivery: {
          sent: emailDelivery.sent,
          status: emailDelivery.status,
        },
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function revokeInvitation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = req.user!;
    requireOrganizerOrAdmin(user.role);

    const parsed = eventInvitationParamsSchema.parse(req.params);
    const eventId = (parsed.eventId || parsed.id)!;
    const { invitationId } = parsed;
    const event = await resolveAuthorizedEvent(eventId, user.userId, user.role === Role.ADMIN);

    const invitation = await prisma.eventStaffInvitation.findFirst({
      where: {
        id: invitationId,
        eventId: event.id,
      },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found', 'INVITATION_NOT_FOUND');
    }

    if (invitation.status === 'REVOKED') {
      res.json({
        success: true,
        data: {
          invitation: {
            id: invitation.id,
            eventId: invitation.eventId,
            email: invitation.email,
            status: invitation.status,
            revokedAt: invitation.revokedAt,
          },
        },
      });
      return;
    }

    if (invitation.status !== 'PENDING') {
      throw new BadRequestError(
        'Only pending invitations can be revoked.',
        'CANNOT_REVOKE_INVITATION'
      );
    }

    const revoked = await prisma.eventStaffInvitation.update({
      where: { id: invitation.id },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        codeHash: null,
        otpExpiresAt: null,
        otpSentAt: null,
        attempts: 0,
      },
      select: {
        id: true,
        eventId: true,
        email: true,
        status: true,
        revokedAt: true,
      },
    });

    res.json({
      success: true,
      data: {
        invitation: revoked,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function revokeStaffMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = req.user!;
    requireOrganizerOrAdmin(user.role);

    const parsed = eventStaffMemberParamsSchema.parse(req.params);
    const eventId = (parsed.eventId || parsed.id)!;
    const { userId } = parsed;
    const event = await resolveAuthorizedEvent(eventId, user.userId, user.role === Role.ADMIN);

    const staff = await prisma.eventStaff.findFirst({
      where: {
        eventId: event.id,
        userId,
      },
    });

    if (!staff) {
      throw new NotFoundError('Staff assignment not found for this event', 'STAFF_NOT_FOUND');
    }

    if (staff.status === 'REVOKED') {
      res.json({
        success: true,
        data: {
          staff: {
            id: staff.id,
            eventId: staff.eventId,
            userId: staff.userId,
            email: staff.email,
            status: staff.status,
            revokedAt: staff.revokedAt,
            revokedByUserId: staff.revokedByUserId,
          },
        },
      });
      return;
    }

    const revoked = await prisma.eventStaff.update({
      where: { id: staff.id },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedByUserId: user.userId,
      },
      select: {
        id: true,
        eventId: true,
        userId: true,
        email: true,
        status: true,
        revokedAt: true,
        revokedByUserId: true,
      },
    });

    res.json({
      success: true,
      data: {
        staff: revoked,
      },
    });
  } catch (error) {
    next(error);
  }
}
