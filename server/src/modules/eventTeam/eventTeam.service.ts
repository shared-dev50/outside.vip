import crypto from 'crypto';
import { Prisma, EventTeamRole, TeamMemberStatus, TeamInvitationStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env, normalizeEmail } from '../../config/env.js';
import {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from '../../utils/errors.js';
import {
  EventAdminPermissions,
  parseAdminPermissions,
} from './eventTeam.permissions.js';
import { sendTeamInvitationEmail } from '../../lib/email.service.js';
import { isValidSlugFormat, RESERVED_SLUGS } from '../promotions/promotions.constants.js';

export interface InviteTeamMemberParams {
  eventId: string;
  invitedByUserId: string;
  email: string;
  role: EventTeamRole;
  permissions?: EventAdminPermissions | null;
}

export interface AcceptInvitationResult {
  memberId: string;
  eventId: string;
  role: EventTeamRole;
  status: TeamMemberStatus;
  hostLink?: {
    id: string;
    slug: string;
    name: string;
  };
}

/**
 * Normalizes string to a URL-safe lowercase slug format.
 */
function slugify(text: string): string {
  const cleaned = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'team';
}

/**
 * Masks an email for safe public display (e.g. "a***@example.com").
 */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  if (local.length <= 2) {
    return `${local[0]}***@${domain}`;
  }
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

/**
 * Generates a unique, URL-safe slug for a personal Host promotional link.
 */
async function generateUniqueHostSlug(
  userName: string,
  eventSlug: string | null,
  tx: Prisma.TransactionClient
): Promise<string> {
  const base = `${slugify(userName)}-${(eventSlug || 'vip').slice(0, 12)}`.slice(0, 48);
  for (let attempt = 0; attempt < 10; attempt++) {
    const randomSuffix = crypto.randomBytes(3).toString('hex');
    const candidate = `${base}-${randomSuffix}`;
    if (!RESERVED_SLUGS.has(candidate) && isValidSlugFormat(candidate)) {
      const existing = await tx.promotionSlugRegistry.findUnique({
        where: { slug: candidate },
      });
      if (!existing) {
        return candidate;
      }
    }
  }
  return `host-${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Creates and dispatches a team invitation for an Event Admin or Event Host.
 * Enforces email validation, duplicate active membership prevention, and deny-by-default permissions.
 */
export async function inviteTeamMember(params: InviteTeamMemberParams) {
  const { eventId, invitedByUserId, email, role, permissions } = params;
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw new BadRequestError('Valid email address is required');
  }

  // 1. Verify target event exists
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: {
      organizer: {
        select: {
          name: true,
          email: true,
        },
      },
    },
  });

  if (!event) {
    throw new NotFoundError('Event not found');
  }

  // 2. Prevent inviting event owner to their own team
  const inviter = await prisma.user.findUnique({
    where: { id: invitedByUserId },
    select: { id: true, name: true, email: true },
  });

  const targetUser = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, name: true, email: true },
  });

  if (targetUser && targetUser.id === event.organizerId) {
    throw new BadRequestError('Event organizer is already the owner of this event');
  }

  // 3. Prevent duplicate active memberships
  if (targetUser) {
    const activeMember = await prisma.eventTeamMember.findUnique({
      where: {
        eventId_userId: {
          eventId,
          userId: targetUser.id,
        },
      },
    });

    if (activeMember && activeMember.status === 'ACTIVE') {
      throw new ConflictError(
        `User is already an active ${activeMember.role} of this event team`
      );
    }
  }

  // 4. Prevent duplicate pending invitations for this email and event
  const pendingInvitation = await prisma.eventTeamInvitation.findFirst({
    where: {
      eventId,
      email: normalizedEmail,
      status: 'PENDING',
    },
  });

  if (pendingInvitation) {
    throw new ConflictError(
      'An active pending invitation already exists for this email. Use resend instead.'
    );
  }

  // 5. Generate secure 32-byte opaque invitation token
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresInDays = 7;
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  // 6. Validate permissions: only ADMIN receives typed permissions; HOST receives null
  const validatedPermissions =
    role === EventTeamRole.ADMIN ? parseAdminPermissions(permissions) : null;

  const invitation = await prisma.eventTeamInvitation.create({
    data: {
      eventId,
      email: normalizedEmail,
      role,
      permissions: validatedPermissions as any,
      tokenHash,
      invitedByUserId,
      expiresAt,
    },
  });

  // 7. Dispatch invitation email
  const baseUrl = env.CLIENT_URL || 'https://outside.vip';
  const inviteUrl = `${baseUrl}/team/invitations/${rawToken}`;
  const organizerDisplayName = event.organizer?.name || inviter?.name || 'The event organizer';

  await sendTeamInvitationEmail({
    to: normalizedEmail,
    eventTitle: event.title,
    organizerName: organizerDisplayName,
    role,
    inviteUrl,
    expiresInDays,
  }).catch((err) => {
    console.warn('[EventTeam] Failed to dispatch invitation email:', err);
  });

  return {
    id: invitation.id,
    eventId: invitation.eventId,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expiresAt,
    token: rawToken, // Expose token for automated test assertions
  };
}

/**
 * Inspects public invitation metadata without requiring prior authentication.
 */
export async function inspectTeamInvitation(rawToken: string) {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new BadRequestError('Invitation token required');
  }

  const tokenHash = crypto.createHash('sha256').update(rawToken.trim()).digest('hex');

  const invitation = await prisma.eventTeamInvitation.findUnique({
    where: { tokenHash },
    include: {
      event: {
        select: {
          id: true,
          title: true,
          slug: true,
          venueName: true,
          city: true,
          startAt: true,
          coverImageUrl: true,
          organizer: {
            select: {
              name: true,
            },
          },
        },
      },
    },
  });

  if (!invitation) {
    throw new NotFoundError('Invitation not found');
  }

  if (invitation.status === TeamInvitationStatus.REVOKED) {
    throw new ForbiddenError('This invitation has been revoked');
  }

  if (invitation.status === TeamInvitationStatus.EXPIRED || invitation.expiresAt < new Date()) {
    if (invitation.status === TeamInvitationStatus.PENDING) {
      await prisma.eventTeamInvitation.update({
        where: { id: invitation.id },
        data: { status: TeamInvitationStatus.EXPIRED },
      });
    }
    throw new ForbiddenError('This invitation has expired');
  }

  return {
    id: invitation.id,
    eventId: invitation.eventId,
    eventTitle: invitation.event.title,
    eventSlug: invitation.event.slug,
    organizerName: invitation.event.organizer?.name || 'Outside.vip Organizer',
    role: invitation.role,
    emailMasked: maskEmail(invitation.email),
    status: invitation.status,
    expiresAt: invitation.expiresAt,
  };
}

/**
 * Accepts a team invitation.
 *
 * Requirements:
 * - Invitee must be authenticated with a verified email.
 * - Authenticated email must match invitation email.
 * - Automatically generates personal Host promotional link with unique primary slug if role is HOST.
 */
export async function acceptTeamInvitation(
  rawToken: string,
  user: { userId: string; email: string; emailVerified?: boolean; name?: string }
): Promise<AcceptInvitationResult> {
  if (!user.emailVerified) {
    throw new ForbiddenError('Email must be verified to accept team invitation');
  }

  const tokenHash = crypto.createHash('sha256').update(rawToken.trim()).digest('hex');

  const invitation = await prisma.eventTeamInvitation.findUnique({
    where: { tokenHash },
    include: {
      event: {
        select: {
          id: true,
          slug: true,
          title: true,
        },
      },
    },
  });

  if (!invitation) {
    throw new NotFoundError('Invitation not found');
  }

  if (invitation.status === TeamInvitationStatus.REVOKED) {
    throw new ForbiddenError('This invitation has been revoked');
  }

  if (invitation.status === TeamInvitationStatus.EXPIRED || invitation.expiresAt < new Date()) {
    throw new ForbiddenError('This invitation has expired');
  }

  if (invitation.status === TeamInvitationStatus.ACCEPTED) {
    // If already accepted, return existing membership
    const member = await prisma.eventTeamMember.findUnique({
      where: {
        eventId_userId: {
          eventId: invitation.eventId,
          userId: user.userId,
        },
      },
      include: {
        hostedLinks: {
          where: { status: { not: 'ARCHIVED' } },
          include: { slugRegistry: { where: { isPrimary: true } } },
        },
      },
    });

    if (member) {
      const primaryLink = member.hostedLinks[0];
      const primarySlug = primaryLink?.slugRegistry[0]?.slug;
      return {
        memberId: member.id,
        eventId: member.eventId,
        role: member.role,
        status: member.status,
        hostLink: primaryLink && primarySlug ? {
          id: primaryLink.id,
          slug: primarySlug,
          name: primaryLink.name,
        } : undefined,
      };
    }
  }

  if (invitation.status !== TeamInvitationStatus.PENDING) {
    throw new BadRequestError(`Invitation is already ${invitation.status.toLowerCase()}`);
  }

  // Verify signed-in email matches recipient
  if (normalizeEmail(user.email) !== normalizeEmail(invitation.email)) {
    throw new ForbiddenError('Signed-in account email does not match invitation recipient');
  }

  // Execute acceptance in an atomic transaction
  return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 1. Mark invitation accepted
    await tx.eventTeamInvitation.update({
      where: { id: invitation.id },
      data: {
        status: TeamInvitationStatus.ACCEPTED,
        acceptedAt: new Date(),
      },
    });

    // 2. Upsert active EventTeamMember
    const member = await tx.eventTeamMember.upsert({
      where: {
        eventId_userId: {
          eventId: invitation.eventId,
          userId: user.userId,
        },
      },
      create: {
        eventId: invitation.eventId,
        userId: user.userId,
        role: invitation.role,
        status: TeamMemberStatus.ACTIVE,
        permissions: invitation.permissions ?? Prisma.DbNull,
        invitedById: invitation.invitedByUserId,
      },
      update: {
        role: invitation.role,
        status: TeamMemberStatus.ACTIVE,
        permissions: invitation.permissions ?? Prisma.DbNull,
      },
    });

    let hostLinkResult: AcceptInvitationResult['hostLink'] | undefined;

    // 3. For HOST role: automatically generate personal Host promotional link
    if (invitation.role === EventTeamRole.HOST) {
      const existingHostLink = await tx.promotionLink.findFirst({
        where: {
          eventId: invitation.eventId,
          hostMemberId: member.id,
          status: { not: 'ARCHIVED' },
        },
        include: {
          slugRegistry: {
            where: { isPrimary: true },
          },
        },
      });

      if (existingHostLink && existingHostLink.slugRegistry[0]) {
        hostLinkResult = {
          id: existingHostLink.id,
          slug: existingHostLink.slugRegistry[0].slug,
          name: existingHostLink.name,
        };
      } else {
        // Generate unique primary host slug
        const hostSlug = await generateUniqueHostSlug(
          user.name || user.email.split('@')[0],
          invitation.event.slug,
          tx
        );

        const newLink = await tx.promotionLink.create({
          data: {
            eventId: invitation.eventId,
            type: 'HOST',
            status: 'ACTIVE',
            name: `${user.name || 'Host'} Personal Link`,
            hostMemberId: member.id,
            createdById: user.userId,
            slugRegistry: {
              create: [
                {
                  slug: hostSlug,
                  isPrimary: true,
                },
              ],
            },
          },
        });

        hostLinkResult = {
          id: newLink.id,
          slug: hostSlug,
          name: newLink.name,
        };
      }
    }

    return {
      memberId: member.id,
      eventId: member.eventId,
      role: member.role,
      status: member.status,
      hostLink: hostLinkResult,
    };
  });
}

/**
 * Resends a pending team invitation with refreshed token and extended expiration.
 */
export async function resendTeamInvitation(invitationId: string, eventId: string) {
  const invitation = await prisma.eventTeamInvitation.findFirst({
    where: { id: invitationId, eventId },
    include: {
      event: {
        select: {
          title: true,
          organizer: { select: { name: true } },
        },
      },
    },
  });

  if (!invitation) {
    throw new NotFoundError('Invitation not found');
  }

  if (invitation.status !== TeamInvitationStatus.PENDING) {
    throw new BadRequestError(`Cannot resend invitation that is already ${invitation.status.toLowerCase()}`);
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresInDays = 7;
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  const updated = await prisma.eventTeamInvitation.update({
    where: { id: invitation.id },
    data: {
      tokenHash,
      expiresAt,
    },
  });

  const baseUrl = env.CLIENT_URL || 'https://outside.vip';
  const inviteUrl = `${baseUrl}/team/invitations/${rawToken}`;
  const organizerDisplayName = invitation.event.organizer?.name || 'Outside.vip Organizer';

  await sendTeamInvitationEmail({
    to: updated.email,
    eventTitle: invitation.event.title,
    organizerName: organizerDisplayName,
    role: updated.role,
    inviteUrl,
    expiresInDays,
  }).catch((err) => {
    console.warn('[EventTeam] Failed to dispatch resend email:', err);
  });

  return {
    id: updated.id,
    email: updated.email,
    expiresAt: updated.expiresAt,
    token: rawToken,
  };
}

/**
 * Revokes a pending team invitation.
 */
export async function revokeTeamInvitation(invitationId: string, eventId: string) {
  const invitation = await prisma.eventTeamInvitation.findFirst({
    where: { id: invitationId, eventId },
  });

  if (!invitation) {
    throw new NotFoundError('Invitation not found');
  }

  if (invitation.status !== TeamInvitationStatus.PENDING) {
    throw new BadRequestError(`Cannot revoke invitation that is already ${invitation.status.toLowerCase()}`);
  }

  await prisma.eventTeamInvitation.update({
    where: { id: invitation.id },
    data: {
      status: TeamInvitationStatus.REVOKED,
      revokedAt: new Date(),
    },
  });

  return { success: true };
}

/**
 * Updates an EventTeamMember's role or permissions.
 * If changing role from HOST to ADMIN, safely archives dependent links first
 * to satisfy trigger trg_protect_host_role_mutation.
 */
export async function updateTeamMember(
  memberId: string,
  eventId: string,
  updates: {
    role?: EventTeamRole;
    permissions?: EventAdminPermissions | null;
    status?: TeamMemberStatus;
  }
) {
  const member = await prisma.eventTeamMember.findFirst({
    where: { id: memberId, eventId },
  });

  if (!member) {
    throw new NotFoundError('Team member not found');
  }

  return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // If mutating role from HOST to ADMIN, archive dependent links to comply with DB trigger
    if (member.role === EventTeamRole.HOST && updates.role === EventTeamRole.ADMIN) {
      await tx.promotionLink.updateMany({
        where: {
          hostMemberId: member.id,
          eventId,
        },
        data: {
          status: 'ARCHIVED',
        },
      });
    }

    const data: Prisma.EventTeamMemberUpdateInput = {};
    if (updates.role) {
      data.role = updates.role;
    }
    if (updates.status) {
      data.status = updates.status;
    }
    if (updates.role === EventTeamRole.ADMIN && updates.permissions !== undefined) {
      data.permissions = (updates.permissions ? parseAdminPermissions(updates.permissions) : null) as any;
    } else if (updates.role === EventTeamRole.HOST) {
      data.permissions = Prisma.DbNull;
    }

    return tx.eventTeamMember.update({
      where: { id: member.id },
      data,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });
  });
}

/**
 * Revokes an EventTeamMember's access.
 * If HOST, marks their personal promotional link as ARCHIVED.
 */
export async function revokeTeamMember(memberId: string, eventId: string) {
  const member = await prisma.eventTeamMember.findFirst({
    where: { id: memberId, eventId },
  });

  if (!member) {
    throw new NotFoundError('Team member not found');
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (member.role === EventTeamRole.HOST) {
      await tx.promotionLink.updateMany({
        where: {
          hostMemberId: member.id,
          eventId,
        },
        data: {
          status: 'ARCHIVED',
        },
      });
    }

    await tx.eventTeamMember.update({
      where: { id: member.id },
      data: {
        status: TeamMemberStatus.REVOKED,
      },
    });
  });

  return { success: true };
}

/**
 * Lists all team members and pending invitations for an event.
 */
export async function listTeamMembers(eventId: string) {
  const [members, invitations] = await Promise.all([
    prisma.eventTeamMember.findMany({
      where: { eventId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        hostedLinks: {
          where: { status: { not: 'ARCHIVED' } },
          include: {
            slugRegistry: {
              where: { isPrimary: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.eventTeamInvitation.findMany({
      where: { eventId, status: TeamInvitationStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  return {
    members: members.map((m) => ({
      id: m.id,
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      status: m.status,
      permissions: m.permissions,
      hostLink: m.hostedLinks[0] ? {
        id: m.hostedLinks[0].id,
        slug: m.hostedLinks[0].slugRegistry[0]?.slug,
        name: m.hostedLinks[0].name,
      } : null,
      createdAt: m.createdAt,
    })),
    invitations: invitations.map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      status: inv.status,
      permissions: inv.permissions,
      expiresAt: inv.expiresAt,
      createdAt: inv.createdAt,
    })),
  };
}

/**
 * Returns events where the current authenticated user is an active Event Host,
 * including their assigned promotional link and primary slug.
 */
export async function listHostAssignedEvents(userId: string) {
  const hostMemberships = await prisma.eventTeamMember.findMany({
    where: {
      userId,
      role: EventTeamRole.HOST,
      status: TeamMemberStatus.ACTIVE,
    },
    include: {
      event: {
        select: {
          id: true,
          slug: true,
          title: true,
          status: true,
          startAt: true,
          endAt: true,
          venueName: true,
          city: true,
          coverImageUrl: true,
        },
      },
      hostedLinks: {
        where: { status: { not: 'ARCHIVED' } },
        include: {
          slugRegistry: {
            where: { isPrimary: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return hostMemberships.map((m) => {
    const link = m.hostedLinks[0];
    const slug = link?.slugRegistry[0]?.slug;
    return {
      membershipId: m.id,
      event: m.event,
      hostLink: link && slug ? {
        id: link.id,
        name: link.name,
        status: link.status,
        slug,
        shortUrl: `/r/${slug}`,
      } : null,
    };
  });
}
