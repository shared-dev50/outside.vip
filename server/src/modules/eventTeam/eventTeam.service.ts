import crypto from 'crypto';
import {
  AccountStatus,
  Prisma,
  EventTeamRole,
  TeamMemberStatus,
  TeamInvitationStatus,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env, normalizeEmail } from '../../config/env.js';
import {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  TooManyRequestsError,
} from '../../utils/errors.js';
import {
  EventAdminPermissions,
  DEFAULT_ADMIN_PERMISSIONS,
  parseAdminPermissions,
  assertAdminPermissionCeiling,
  hasEventPermission,
} from './eventTeam.permissions.js';
import { sendTeamInvitationEmail } from '../../lib/email.service.js';
import {
  checkRedisRateLimitWithRetryAfter,
  acquireRedisCooldown,
  releaseRedisCooldown,
} from '../../lib/session.service.js';
import {
  isValidSlugFormat,
  RESERVED_SLUGS,
  TEAM_INVITE_CREATE_ACTOR_MAX_PER_HOUR,
  TEAM_INVITE_CREATE_EVENT_MAX_PER_HOUR,
  TEAM_INVITE_CREATE_WINDOW_MS,
  TEAM_INVITE_RESEND_COOLDOWN_MS,
  TEAM_INVITE_RESEND_ACTOR_MAX_PER_HOUR,
  TEAM_INVITE_RESEND_EVENT_MAX_PER_HOUR,
  TEAM_INVITE_RESEND_WINDOW_MS,
} from '../promotions/promotions.constants.js';

export interface TeamActorContext {
  userId: string;
  email?: string;
  isOwner: boolean;
  memberId?: string;
  permissions?: EventAdminPermissions | null;
}

export interface InviteTeamMemberParams {
  eventId: string;
  invitedByUserId: string;
  email: string;
  role: EventTeamRole;
  permissions?: EventAdminPermissions | null;
  actor?: TeamActorContext;
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
  const { eventId, invitedByUserId, email, role, permissions, actor } = params;
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

  const isOwner = actor ? actor.isOwner : event.organizerId === invitedByUserId;
  let callerPermissions = actor?.permissions;

  if (!isOwner) {
    if (
      (inviter?.email && normalizeEmail(inviter.email) === normalizedEmail) ||
      (actor?.email && normalizeEmail(actor.email) === normalizedEmail) ||
      (targetUser && targetUser.id === invitedByUserId)
    ) {
      throw new ForbiddenError('Event Admins cannot invite or modify their own team membership.');
    }

    if (callerPermissions === undefined) {
      const inviterMember = await prisma.eventTeamMember.findUnique({
        where: {
          eventId_userId: {
            eventId: event.id,
            userId: invitedByUserId,
          },
        },
      });
      callerPermissions = inviterMember ? parseAdminPermissions(inviterMember.permissions) : null;
    }

    // Event Admins cannot grant permissions they do not personally hold
    if (role === EventTeamRole.ADMIN || (permissions !== undefined && permissions !== null)) {
      assertAdminPermissionCeiling(callerPermissions, permissions);
    }
  }

  // 3. Prevent duplicate active memberships & prevent Event Admins from modifying existing Event Admins
  if (targetUser) {
    const activeMember = await prisma.eventTeamMember.findUnique({
      where: {
        eventId_userId: {
          eventId: event.id,
          userId: targetUser.id,
        },
      },
    });

    if (!isOwner && activeMember && activeMember.role === EventTeamRole.ADMIN) {
      throw new ForbiddenError('Only the event owner can modify an Event Admin membership.');
    }

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

  // 4b. SEC-10 Part A: Enforce actor-scoped and event-scoped invitation creation rate limits
  // Evaluated after authorization and validation so invalid or unauthorized requests cannot exhaust quota
  const actorCreateRate = await checkRedisRateLimitWithRetryAfter(
    `team_invite_create:actor:${invitedByUserId}`,
    TEAM_INVITE_CREATE_ACTOR_MAX_PER_HOUR,
    TEAM_INVITE_CREATE_WINDOW_MS
  );
  if (!actorCreateRate.allowed) {
    console.warn('[EventTeam] Invitation creation actor rate limit exceeded', {
      event: 'RATE_LIMIT_TRIGGERED',
      scope: 'team_invite_create_actor',
      actorUserId: invitedByUserId,
      eventId,
      retryAfterSeconds: actorCreateRate.retryAfterSeconds,
    });
    throw new TooManyRequestsError(
      'Too many team invitations created recently. Please wait before sending more invitations.',
      'TEAM_INVITATION_RATE_LIMIT',
      actorCreateRate.retryAfterSeconds
    );
  }

  const eventCreateRate = await checkRedisRateLimitWithRetryAfter(
    `team_invite_create:event:${eventId}`,
    TEAM_INVITE_CREATE_EVENT_MAX_PER_HOUR,
    TEAM_INVITE_CREATE_WINDOW_MS
  );
  if (!eventCreateRate.allowed) {
    console.warn('[EventTeam] Invitation creation event rate limit exceeded', {
      event: 'RATE_LIMIT_TRIGGERED',
      scope: 'team_invite_create_event',
      actorUserId: invitedByUserId,
      eventId,
      retryAfterSeconds: eventCreateRate.retryAfterSeconds,
    });
    throw new TooManyRequestsError(
      'This event has reached its hourly team invitation limit. Please wait before sending more invitations.',
      'TEAM_INVITATION_RATE_LIMIT',
      eventCreateRate.retryAfterSeconds
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

  if (invitation.status === TeamInvitationStatus.ACCEPTED) {
    throw new ConflictError(
      'This invitation has already been accepted. Please sign in to access your workspace.',
      'INVITATION_ALREADY_ACCEPTED'
    );
  }

  if (invitation.status === TeamInvitationStatus.EXPIRED || invitation.expiresAt < new Date()) {
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
          organizerId: true,
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

  if (invitation.status === TeamInvitationStatus.ACCEPTED) {
    throw new ConflictError(
      'This invitation has already been accepted',
      'INVITATION_ALREADY_ACCEPTED'
    );
  }

  if (invitation.status === TeamInvitationStatus.EXPIRED || invitation.expiresAt < new Date()) {
    throw new ForbiddenError('This invitation has expired');
  }

  if (invitation.status !== TeamInvitationStatus.PENDING) {
    throw new ConflictError(
      `Invitation is already ${String(invitation.status).toLowerCase()}`,
      'INVITATION_NOT_PENDING'
    );
  }

  // Verify signed-in email matches recipient
  if (normalizeEmail(user.email) !== normalizeEmail(invitation.email)) {
    throw new ForbiddenError('Signed-in account email does not match invitation recipient');
  }

  // S4R-01: Enforce server-side that Event ADMIN invitations require an ACTIVE password-protected
  // account (passwordHash !== null). Passwordless accounts (e.g. scanner staff) cannot accept ADMIN
  // invitations regardless of how they authenticated (OTP, /scanner, /login?mode=otp, or direct API).
  if (invitation.role === EventTeamRole.ADMIN) {
    const acceptingUser = await prisma.user.findUnique({
      where: { id: user.userId },
      select: { id: true, passwordHash: true, status: true },
    });
    if (!acceptingUser || acceptingUser.status !== AccountStatus.ACTIVE) {
      throw new ForbiddenError('Account is not active and cannot accept this invitation.');
    }
    if (!acceptingUser.passwordHash) {
      throw new ForbiddenError(
        'Event Admin invitations require a password-protected account. Please establish password credentials before accepting this role.',
        'ADMIN_PASSWORD_REQUIRED'
      );
    }
  }

  // Enforce delegation ceiling and self/admin modification protection if invited by an Event Admin
  if (invitation.invitedByUserId !== invitation.event.organizerId) {
    if (user.userId === invitation.invitedByUserId) {
      throw new ForbiddenError('Event Admins cannot accept an invitation to modify their own membership.');
    }

    const existingRecipientMember = await prisma.eventTeamMember.findUnique({
      where: {
        eventId_userId: {
          eventId: invitation.eventId,
          userId: user.userId,
        },
      },
    });

    if (existingRecipientMember && existingRecipientMember.role === EventTeamRole.ADMIN) {
      throw new ForbiddenError('Only the event owner can modify an Event Admin membership.');
    }

    const inviterMember = await prisma.eventTeamMember.findUnique({
      where: {
        eventId_userId: {
          eventId: invitation.eventId,
          userId: invitation.invitedByUserId,
        },
      },
    });

    if (
      !inviterMember ||
      inviterMember.status !== TeamMemberStatus.ACTIVE ||
      !hasEventPermission(inviterMember, 'canManageTeam')
    ) {
      throw new ForbiddenError('The administrator who issued this invitation no longer has team management authority.');
    }

    if (invitation.role === EventTeamRole.ADMIN || invitation.permissions) {
      assertAdminPermissionCeiling(parseAdminPermissions(inviterMember.permissions), invitation.permissions);
    }
  }

  // Execute acceptance in an atomic transaction with conditional single-use claim
  return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Re-verify ADMIN password requirement inside the transaction before claiming the invitation
    // so a passwordless user can never consume an ADMIN invitation or bypass via TOCTOU.
    if (invitation.role === EventTeamRole.ADMIN) {
      const txUser = await tx.user.findUnique({
        where: { id: user.userId },
        select: { passwordHash: true, status: true },
      });
      if (!txUser || txUser.status !== AccountStatus.ACTIVE) {
        throw new ForbiddenError('Account is not active and cannot accept this invitation.');
      }
      if (!txUser.passwordHash) {
        throw new ForbiddenError(
          'Event Admin invitations require a password-protected account. Please establish password credentials before accepting this role.',
          'ADMIN_PASSWORD_REQUIRED'
        );
      }
    }

    // 1. Atomically claim PENDING, non-expired, non-superseded invitation before any membership/link writes
    const claimNow = new Date();
    const claimed = await tx.eventTeamInvitation.updateMany({
      where: {
        id: invitation.id,
        tokenHash,
        status: TeamInvitationStatus.PENDING,
        expiresAt: { gt: claimNow },
      },
      data: {
        status: TeamInvitationStatus.ACCEPTED,
        acceptedAt: claimNow,
      },
    });

    if (claimed.count !== 1) {
      const currentInv = await tx.eventTeamInvitation.findUnique({
        where: { id: invitation.id },
        select: { status: true, expiresAt: true, tokenHash: true },
      });
      if (!currentInv || currentInv.status === TeamInvitationStatus.REVOKED) {
        throw new ForbiddenError('This invitation has been revoked');
      }
      if (currentInv.status === TeamInvitationStatus.ACCEPTED) {
        throw new ConflictError(
          'This invitation has already been accepted',
          'INVITATION_ALREADY_ACCEPTED'
        );
      }
      if (
        currentInv.status === TeamInvitationStatus.PENDING &&
        currentInv.tokenHash !== tokenHash
      ) {
        throw new ForbiddenError(
          'This invitation link has been superseded by a newer email. Please use the latest invitation link.',
          'INVITATION_TOKEN_SUPERSEDED'
        );
      }
      throw new ForbiddenError('This invitation has expired');
    }

    // 1b. If transitioning an existing HOST member to a non-HOST role (e.g., ADMIN),
    // archive their active or disabled personal Host promotional links first within the same
    // transaction so the trg_protect_host_membership_mutation database trigger is satisfied
    // and historical slug aliases and analytics remain intact.
    if (invitation.role !== EventTeamRole.HOST) {
      const existingMember = await tx.eventTeamMember.findUnique({
        where: {
          eventId_userId: {
            eventId: invitation.eventId,
            userId: user.userId,
          },
        },
      });

      if (existingMember && existingMember.role === EventTeamRole.HOST) {
        await tx.promotionLink.updateMany({
          where: {
            hostMemberId: existingMember.id,
            eventId: invitation.eventId,
            status: { not: 'ARCHIVED' },
          },
          data: {
            status: 'ARCHIVED',
          },
        });
      }
    }

    const effectivePermissions =
      invitation.role === EventTeamRole.ADMIN
        ? (parseAdminPermissions(invitation.permissions) as any)
        : Prisma.DbNull;

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
        permissions: effectivePermissions,
        invitedById: invitation.invitedByUserId,
      },
      update: {
        role: invitation.role,
        status: TeamMemberStatus.ACTIVE,
        permissions: effectivePermissions,
      },
    });

    let hostLinkResult: AcceptInvitationResult['hostLink'] | undefined;

    // 3. For HOST role: automatically generate or reactivate personal Host promotional link
    // Only activate link if resulting membership is HOST and ACTIVE
    if (invitation.role === EventTeamRole.HOST && member.status === TeamMemberStatus.ACTIVE) {
      const existingHostLink = await tx.promotionLink.findFirst({
        where: {
          eventId: invitation.eventId,
          hostMemberId: member.id,
        },
        include: {
          slugRegistry: {
            where: { isPrimary: true },
          },
        },
      });

      if (existingHostLink) {
        // Reactivate existing personal link if previously ARCHIVED or DISABLED
        if (existingHostLink.status !== 'ACTIVE') {
          await tx.promotionLink.update({
            where: { id: existingHostLink.id },
            data: { status: 'ACTIVE' },
          });
        }

        const primarySlug = existingHostLink.slugRegistry[0]?.slug;
        if (primarySlug) {
          hostLinkResult = {
            id: existingHostLink.id,
            slug: primarySlug,
            name: existingHostLink.name,
          };
        } else {
          // Edge-case fallback: ensure primary slug exists
          const hostSlug = await generateUniqueHostSlug(
            user.name || user.email.split('@')[0],
            invitation.event.slug,
            tx
          );
          await tx.promotionSlugRegistry.create({
            data: {
              slug: hostSlug,
              promotionLinkId: existingHostLink.id,
              isPrimary: true,
            },
          });
          hostLinkResult = {
            id: existingHostLink.id,
            slug: hostSlug,
            name: existingHostLink.name,
          };
        }
      } else {
        // Brand new Host: generate unique primary host slug and create the single link
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
export async function resendTeamInvitation(
  invitationId: string,
  eventId: string,
  actor?: TeamActorContext
) {
  const invitation = await prisma.eventTeamInvitation.findFirst({
    where: { id: invitationId, eventId },
    include: {
      event: {
        select: {
          title: true,
          organizerId: true,
          organizer: { select: { name: true } },
        },
      },
    },
  });

  if (!invitation) {
    throw new NotFoundError('Invitation not found');
  }

  if (invitation.status !== TeamInvitationStatus.PENDING) {
    throw new ConflictError(
      `Cannot resend invitation that is already ${String(invitation.status).toLowerCase()}`,
      invitation.status === TeamInvitationStatus.ACCEPTED
        ? 'INVITATION_ALREADY_ACCEPTED'
        : 'INVITATION_NOT_PENDING'
    );
  }

  if (actor && !actor.isOwner) {
    if (actor.email && normalizeEmail(actor.email) === normalizeEmail(invitation.email)) {
      throw new ForbiddenError('Event Admins cannot manage invitations for their own account.');
    }
    if (invitation.role === EventTeamRole.ADMIN || invitation.permissions) {
      assertAdminPermissionCeiling(actor.permissions, invitation.permissions);
    }
  }

  // SEC-10 Part B: Enforce atomic per-invitation 60s resend cooldown + actor and event resend rate limits
  const cooldownKey = `team_invite_resend:inv:${invitation.id}`;
  const cooldown = await acquireRedisCooldown(cooldownKey, TEAM_INVITE_RESEND_COOLDOWN_MS);
  if (!cooldown.allowed) {
    console.warn('[EventTeam] Invitation resend cooldown triggered', {
      event: 'RATE_LIMIT_TRIGGERED',
      scope: 'team_invite_resend_cooldown',
      invitationId: invitation.id,
      eventId,
      actorUserId: actor?.userId,
      retryAfterSeconds: cooldown.retryAfterSeconds,
    });
    throw new TooManyRequestsError(
      `Please wait at least ${cooldown.retryAfterSeconds} seconds before resending this invitation.`,
      'TEAM_INVITATION_RESEND_COOLDOWN',
      cooldown.retryAfterSeconds
    );
  }

  const actorUserId = actor?.userId || invitation.invitedByUserId;
  if (actorUserId) {
    const actorResendRate = await checkRedisRateLimitWithRetryAfter(
      `team_invite_resend:actor:${actorUserId}`,
      TEAM_INVITE_RESEND_ACTOR_MAX_PER_HOUR,
      TEAM_INVITE_RESEND_WINDOW_MS
    );
    if (!actorResendRate.allowed) {
      await releaseRedisCooldown(cooldownKey);
      console.warn('[EventTeam] Invitation resend actor rate limit exceeded', {
        event: 'RATE_LIMIT_TRIGGERED',
        scope: 'team_invite_resend_actor',
        invitationId: invitation.id,
        eventId,
        actorUserId,
        retryAfterSeconds: actorResendRate.retryAfterSeconds,
      });
      throw new TooManyRequestsError(
        'Too many invitation resend requests. Please wait before trying again.',
        'TEAM_INVITATION_RESEND_RATE_LIMIT',
        actorResendRate.retryAfterSeconds
      );
    }
  }

  const eventResendRate = await checkRedisRateLimitWithRetryAfter(
    `team_invite_resend:event:${eventId}`,
    TEAM_INVITE_RESEND_EVENT_MAX_PER_HOUR,
    TEAM_INVITE_RESEND_WINDOW_MS
  );
  if (!eventResendRate.allowed) {
    await releaseRedisCooldown(cooldownKey);
    console.warn('[EventTeam] Invitation resend event rate limit exceeded', {
      event: 'RATE_LIMIT_TRIGGERED',
      scope: 'team_invite_resend_event',
      invitationId: invitation.id,
      eventId,
      actorUserId,
      retryAfterSeconds: eventResendRate.retryAfterSeconds,
    });
    throw new TooManyRequestsError(
      'Too many invitation resend requests for this event. Please wait before trying again.',
      'TEAM_INVITATION_RESEND_RATE_LIMIT',
      eventResendRate.retryAfterSeconds
    );
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresInDays = 7;
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  // S4R-02: Atomically rotate tokenHash/expiresAt ONLY while status is still PENDING
  const rotated = await prisma.eventTeamInvitation.updateMany({
    where: {
      id: invitation.id,
      eventId,
      status: TeamInvitationStatus.PENDING,
    },
    data: {
      tokenHash,
      expiresAt,
    },
  });

  if (rotated.count !== 1) {
    await releaseRedisCooldown(cooldownKey).catch(() => {});
    const current = await prisma.eventTeamInvitation.findUnique({
      where: { id: invitation.id },
      select: { status: true },
    });
    const currentStatus = current?.status ? String(current.status).toLowerCase() : 'processed';
    throw new ConflictError(
      `Cannot resend invitation that is already ${currentStatus}`,
      current?.status === TeamInvitationStatus.ACCEPTED
        ? 'INVITATION_ALREADY_ACCEPTED'
        : 'INVITATION_NOT_PENDING'
    );
  }

  const baseUrl = env.CLIENT_URL || 'https://outside.vip';
  const inviteUrl = `${baseUrl}/team/invitations/${rawToken}`;
  const organizerDisplayName = invitation.event.organizer?.name || 'Outside.vip Organizer';

  await sendTeamInvitationEmail({
    to: invitation.email,
    eventTitle: invitation.event.title,
    organizerName: organizerDisplayName,
    role: invitation.role,
    inviteUrl,
    expiresInDays,
  }).catch((err) => {
    console.warn('[EventTeam] Failed to dispatch resend email:', err);
  });

  return {
    id: invitation.id,
    email: invitation.email,
    expiresAt,
  };
}

/**
 * Revokes a pending team invitation.
 */
export async function revokeTeamInvitation(
  invitationId: string,
  eventId: string,
  actor?: TeamActorContext
) {
  const invitation = await prisma.eventTeamInvitation.findFirst({
    where: { id: invitationId, eventId },
  });

  if (!invitation) {
    throw new NotFoundError('Invitation not found');
  }

  if (invitation.status !== TeamInvitationStatus.PENDING) {
    throw new ConflictError(
      `Cannot revoke invitation that is already ${String(invitation.status).toLowerCase()}`,
      invitation.status === TeamInvitationStatus.ACCEPTED
        ? 'INVITATION_ALREADY_ACCEPTED'
        : 'INVITATION_NOT_PENDING'
    );
  }

  if (actor && !actor.isOwner) {
    if (actor.email && normalizeEmail(actor.email) === normalizeEmail(invitation.email)) {
      throw new ForbiddenError('Event Admins cannot manage invitations for their own account.');
    }
    if (invitation.role === EventTeamRole.ADMIN) {
      if (invitation.invitedByUserId !== actor.userId) {
        throw new ForbiddenError('Only the event owner can revoke an Event Admin invitation created by another administrator or the owner.');
      }
      assertAdminPermissionCeiling(actor.permissions, invitation.permissions);
    }
  }

  // S4R-02: Atomically revoke ONLY while status is still PENDING so a concurrent accept
  // cannot be silently overwritten from ACCEPTED to REVOKED after membership creation.
  const revoked = await prisma.eventTeamInvitation.updateMany({
    where: {
      id: invitation.id,
      eventId,
      status: TeamInvitationStatus.PENDING,
    },
    data: {
      status: TeamInvitationStatus.REVOKED,
      revokedAt: new Date(),
    },
  });

  if (revoked.count !== 1) {
    const current = await prisma.eventTeamInvitation.findUnique({
      where: { id: invitation.id },
      select: { status: true },
    });
    const currentStatus = current?.status ? String(current.status).toLowerCase() : 'processed';
    throw new ConflictError(
      `Cannot revoke invitation that is already ${currentStatus}`,
      current?.status === TeamInvitationStatus.ACCEPTED
        ? 'INVITATION_ALREADY_ACCEPTED'
        : 'INVITATION_NOT_PENDING'
    );
  }

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
  },
  actor?: TeamActorContext
) {
  const member = await prisma.eventTeamMember.findFirst({
    where: { id: memberId, eventId },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
      event: {
        select: {
          slug: true,
          organizerId: true,
        },
      },
    },
  });

  if (!member) {
    throw new NotFoundError('Team member not found');
  }

  if (actor && !actor.isOwner) {
    // 1. An Event Admin must not update their own membership, permissions, or role
    if (member.userId === actor.userId || (actor.memberId && member.id === actor.memberId)) {
      throw new ForbiddenError('Event Admins cannot update their own membership, role, or permissions.');
    }

    // 2. An Event Admin must not modify another Event Admin's membership
    if (member.role === EventTeamRole.ADMIN) {
      throw new ForbiddenError('Only the event owner can modify an Event Admin membership.');
    }

    // 3. An Event Admin must not grant permissions they do not personally possess
    if (updates.role === EventTeamRole.ADMIN || (updates.permissions !== undefined && updates.permissions !== null)) {
      assertAdminPermissionCeiling(actor.permissions, updates.permissions);
    }
  }

  return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const targetRole = updates.role || member.role;
    const targetStatus = updates.status || member.status;

    // Enforce the same S4R-01 ADMIN credential and account-status invariants on
    // non-ADMIN -> ADMIN role promotions as on direct ADMIN invitation acceptance.
    if (member.role !== EventTeamRole.ADMIN && targetRole === EventTeamRole.ADMIN) {
      const txUser = await tx.user.findUnique({
        where: { id: member.userId },
        select: { id: true, status: true, passwordHash: true },
      });
      if (!txUser || txUser.status !== AccountStatus.ACTIVE) {
        throw new ForbiddenError('Account is not active and cannot be promoted to Event Admin.');
      }
      if (!txUser.passwordHash || !txUser.passwordHash.trim()) {
        throw new ForbiddenError(
          'Event Admin role requires a password-protected account. Please establish password credentials before promoting this user.',
          'ADMIN_PASSWORD_REQUIRED'
        );
      }
    }

    // STEP 1: De-escalation & Inactivation
    // If role is changing away from HOST: archive dependent links first
    if (member.role === EventTeamRole.HOST && targetRole !== EventTeamRole.HOST) {
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

    // If status is changing away from ACTIVE for a HOST: disable/archive links first
    if (member.role === EventTeamRole.HOST && targetRole === EventTeamRole.HOST && updates.status) {
      if (updates.status === TeamMemberStatus.INACTIVE) {
        await tx.promotionLink.updateMany({
          where: {
            hostMemberId: member.id,
            eventId,
            status: 'ACTIVE',
          },
          data: {
            status: 'DISABLED',
          },
        });
      } else if (updates.status === TeamMemberStatus.REVOKED) {
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
    }

    // STEP 2: Update EventTeamMember row
    const data: Prisma.EventTeamMemberUpdateInput = {};
    if (updates.role) {
      data.role = updates.role;
    }
    if (updates.status) {
      data.status = updates.status;
    }
    if (targetRole === EventTeamRole.ADMIN) {
      if (updates.permissions !== undefined) {
        data.permissions = (
          updates.permissions ? parseAdminPermissions(updates.permissions) : { ...DEFAULT_ADMIN_PERMISSIONS }
        ) as any;
      } else if (member.permissions) {
        data.permissions = parseAdminPermissions(member.permissions) as any;
      } else {
        data.permissions = { ...DEFAULT_ADMIN_PERMISSIONS } as any;
      }
    } else if (targetRole === EventTeamRole.HOST) {
      data.permissions = Prisma.DbNull;
    }

    const updatedMember = await tx.eventTeamMember.update({
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

    // STEP 3: Escalation & Activation
    // Now that EventTeamMember is updated to HOST and/or ACTIVE, update/create links to ACTIVE if applicable
    if (targetRole === EventTeamRole.HOST) {
      const initialLinkStatus = targetStatus === TeamMemberStatus.ACTIVE ? 'ACTIVE' : 'DISABLED';

      if (member.role !== EventTeamRole.HOST) {
        // Transitioning role from non-HOST to HOST
        const existingHostLink = await tx.promotionLink.findFirst({
          where: {
            eventId,
            hostMemberId: member.id,
          },
        });

        if (existingHostLink) {
          await tx.promotionLink.update({
            where: { id: existingHostLink.id },
            data: { status: initialLinkStatus },
          });
        } else {
          const hostSlug = await generateUniqueHostSlug(
            member.user?.name || member.user?.email.split('@')[0] || 'host',
            member.event.slug,
            tx
          );
          await tx.promotionLink.create({
            data: {
              eventId,
              type: 'HOST',
              status: initialLinkStatus,
              name: `${member.user?.name || 'Host'} Personal Link`,
              hostMemberId: member.id,
              createdById: member.userId,
              slugRegistry: {
                create: [{ slug: hostSlug, isPrimary: true }],
              },
            },
          });
        }
      } else if (updates.status === TeamMemberStatus.ACTIVE) {
        // Restoring existing HOST status to ACTIVE
        await tx.promotionLink.updateMany({
          where: {
            hostMemberId: member.id,
            eventId,
            status: { in: ['ARCHIVED', 'DISABLED'] },
          },
          data: {
            status: 'ACTIVE',
          },
        });
      }
    }

    return {
      ...updatedMember,
      permissions:
        updatedMember.role === EventTeamRole.ADMIN
          ? (parseAdminPermissions(updatedMember.permissions) as any)
          : null,
    };
  });
}

/**
 * Revokes an EventTeamMember's access.
 * If HOST, marks their personal promotional link as ARCHIVED.
 */
export async function revokeTeamMember(
  memberId: string,
  eventId: string,
  actor?: TeamActorContext
) {
  const member = await prisma.eventTeamMember.findFirst({
    where: { id: memberId, eventId },
  });

  if (!member) {
    throw new NotFoundError('Team member not found');
  }

  if (actor && !actor.isOwner) {
    // 1. An Event Admin must not revoke their own membership
    if (member.userId === actor.userId || (actor.memberId && member.id === actor.memberId)) {
      throw new ForbiddenError('Event Admins cannot revoke their own membership.');
    }

    // 2. An Event Admin must not revoke another Event Admin's membership
    if (member.role === EventTeamRole.ADMIN) {
      throw new ForbiddenError('Only the event owner can revoke an Event Admin membership.');
    }
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
      permissions:
        m.role === EventTeamRole.ADMIN ? parseAdminPermissions(m.permissions) : null,
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
      permissions:
        inv.role === EventTeamRole.ADMIN ? parseAdminPermissions(inv.permissions) : null,
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
