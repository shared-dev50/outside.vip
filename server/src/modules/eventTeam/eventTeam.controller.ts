import { Request, Response, NextFunction } from 'express';
import { EventTeamRole, TeamMemberStatus } from '@prisma/client';
import { BadRequestError, TooManyRequestsError, UnauthorizedError } from '../../utils/errors.js';
import {
  checkRedisRateLimitWithRetryAfter,
  hashRateLimitIdentifier,
} from '../../lib/session.service.js';
import {
  TEAM_INVITE_INSPECT_IP_BURST_MAX,
  TEAM_INVITE_INSPECT_IP_BURST_WINDOW_MS,
  TEAM_INVITE_INSPECT_IP_SUSTAINED_MAX,
  TEAM_INVITE_INSPECT_IP_SUSTAINED_WINDOW_MS,
} from '../promotions/promotions.constants.js';
import { resolveEventAuthorization } from './eventTeam.permissions.js';
import {
  inviteTeamMember,
  inspectTeamInvitation,
  acceptTeamInvitation,
  resendTeamInvitation,
  revokeTeamInvitation,
  updateTeamMember,
  revokeTeamMember,
  listTeamMembers,
  listHostAssignedEvents,
} from './eventTeam.service.js';

/**
 * Invites an Event Admin or Event Host.
 * Requires Event Owner or Event Admin with 'canManageTeam: true'.
 */
export async function handleInviteTeamMember(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) throw new UnauthorizedError('Authentication required');

    const eventId = req.params.eventId;
    const authCtx = await resolveEventAuthorization(eventId, user, 'canManageTeam');

    const { email, role, permissions } = req.body;
    if (!email || typeof email !== 'string') {
      throw new BadRequestError('Valid email address required');
    }
    if (!role || (role !== EventTeamRole.ADMIN && role !== EventTeamRole.HOST)) {
      throw new BadRequestError('Role must be ADMIN or HOST');
    }

    const invitation = await inviteTeamMember({
      eventId,
      invitedByUserId: user.userId,
      email,
      role,
      permissions: role === EventTeamRole.ADMIN ? permissions : null,
      actor: {
        userId: user.userId,
        email: user.email,
        isOwner: authCtx.isOwner,
        memberId: authCtx.memberId,
        permissions: authCtx.permissions,
      },
    });

    res.status(201).json({
      success: true,
      invitation,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Inspects public invitation metadata without requiring prior authentication.
 * SEC-10 Part C: Enforces trusted-proxy IP burst and sustained rate limits without logging tokens or raw IPs.
 */
export async function handleInspectTeamInvitation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
    const ipHash = hashRateLimitIdentifier(clientIp);

    const burstRate = await checkRedisRateLimitWithRetryAfter(
      `team_invite_inspect:burst:${ipHash}`,
      TEAM_INVITE_INSPECT_IP_BURST_MAX,
      TEAM_INVITE_INSPECT_IP_BURST_WINDOW_MS
    );
    if (!burstRate.allowed) {
      console.warn('[EventTeam] Public invitation inspection burst rate limit exceeded', {
        event: 'RATE_LIMIT_TRIGGERED',
        scope: 'team_invite_inspect_ip_burst',
        retryAfterSeconds: burstRate.retryAfterSeconds,
      });
      throw new TooManyRequestsError(
        'Too many invitation inspection requests. Please wait before trying again.',
        'TEAM_INVITATION_INSPECT_RATE_LIMIT',
        burstRate.retryAfterSeconds
      );
    }

    const sustainedRate = await checkRedisRateLimitWithRetryAfter(
      `team_invite_inspect:sustained:${ipHash}`,
      TEAM_INVITE_INSPECT_IP_SUSTAINED_MAX,
      TEAM_INVITE_INSPECT_IP_SUSTAINED_WINDOW_MS
    );
    if (!sustainedRate.allowed) {
      console.warn('[EventTeam] Public invitation inspection sustained rate limit exceeded', {
        event: 'RATE_LIMIT_TRIGGERED',
        scope: 'team_invite_inspect_ip_sustained',
        retryAfterSeconds: sustainedRate.retryAfterSeconds,
      });
      throw new TooManyRequestsError(
        'Too many invitation inspection requests. Please wait before trying again.',
        'TEAM_INVITATION_INSPECT_RATE_LIMIT',
        sustainedRate.retryAfterSeconds
      );
    }

    const rawToken = req.params.token;
    const metadata = await inspectTeamInvitation(rawToken);
    res.json({
      success: true,
      invitation: metadata,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Accepts a team invitation.
 * Requires authenticated user with a verified email matching the invitation recipient.
 */
export async function handleAcceptTeamInvitation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) throw new UnauthorizedError('Authentication required');

    const rawToken = req.params.token;
    const result = await acceptTeamInvitation(rawToken, {
      userId: user.userId,
      email: user.email,
      emailVerified: user.emailVerified,
    });

    res.json({
      success: true,
      membership: result,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Resends a pending team invitation.
 * Requires Event Owner or Event Admin with 'canManageTeam: true'.
 */
export async function handleResendTeamInvitation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) throw new UnauthorizedError('Authentication required');

    const { eventId, invitationId } = req.params;
    const authCtx = await resolveEventAuthorization(eventId, user, 'canManageTeam');

    const updated = await resendTeamInvitation(invitationId, eventId, {
      userId: user.userId,
      email: user.email,
      isOwner: authCtx.isOwner,
      memberId: authCtx.memberId,
      permissions: authCtx.permissions,
    });
    res.json({
      success: true,
      invitation: updated,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Revokes a pending team invitation.
 * Requires Event Owner or Event Admin with 'canManageTeam: true'.
 */
export async function handleRevokeTeamInvitation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) throw new UnauthorizedError('Authentication required');

    const { eventId, invitationId } = req.params;
    const authCtx = await resolveEventAuthorization(eventId, user, 'canManageTeam');

    await revokeTeamInvitation(invitationId, eventId, {
      userId: user.userId,
      email: user.email,
      isOwner: authCtx.isOwner,
      memberId: authCtx.memberId,
      permissions: authCtx.permissions,
    });
    res.json({
      success: true,
      message: 'Invitation revoked',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Updates an EventTeamMember's role or permissions.
 * Requires Event Owner or Event Admin with 'canManageTeam: true'.
 */
export async function handleUpdateTeamMember(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) throw new UnauthorizedError('Authentication required');

    const { eventId, memberId } = req.params;
    const authCtx = await resolveEventAuthorization(eventId, user, 'canManageTeam');

    const { role, permissions, status } = req.body;
    const updated = await updateTeamMember(
      memberId,
      eventId,
      {
        role: role as EventTeamRole | undefined,
        permissions,
        status: status as TeamMemberStatus | undefined,
      },
      {
        userId: user.userId,
        email: user.email,
        isOwner: authCtx.isOwner,
        memberId: authCtx.memberId,
        permissions: authCtx.permissions,
      }
    );

    res.json({
      success: true,
      member: updated,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Revokes an EventTeamMember's membership.
 * Requires Event Owner or Event Admin with 'canManageTeam: true'.
 */
export async function handleRevokeTeamMember(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) throw new UnauthorizedError('Authentication required');

    const { eventId, memberId } = req.params;
    const authCtx = await resolveEventAuthorization(eventId, user, 'canManageTeam');

    await revokeTeamMember(memberId, eventId, {
      userId: user.userId,
      email: user.email,
      isOwner: authCtx.isOwner,
      memberId: authCtx.memberId,
      permissions: authCtx.permissions,
    });
    res.json({
      success: true,
      message: 'Team member access revoked',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Lists all active team members and pending invitations for an event.
 * Requires Event Owner or Event Admin with 'canManageTeam: true'.
 */
export async function handleListTeamMembers(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) throw new UnauthorizedError('Authentication required');

    const eventId = req.params.eventId;
    await resolveEventAuthorization(eventId, user, 'canManageTeam');

    const team = await listTeamMembers(eventId);
    res.json({
      success: true,
      team,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Returns events where the current authenticated user is an active Event Host.
 */
export async function handleListHostEvents(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) throw new UnauthorizedError('Authentication required');

    const events = await listHostAssignedEvents(user.userId);
    res.json({
      success: true,
      events,
    });
  } catch (err) {
    next(err);
  }
}
