import { z } from 'zod';
import { Role, EventTeamRole, Event } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { ForbiddenError, NotFoundError } from '../../utils/errors.js';


export const EventAdminPermissionsSchema = z
  .object({
    canEditDetails: z.boolean().default(false),
    canManageTickets: z.boolean().default(false),
    canViewOrders: z.boolean().default(false),
    canManageTeam: z.boolean().default(false),
    canManagePromotions: z.boolean().default(false),
    canViewAnalytics: z.boolean().default(false),
    canManageRefunds: z.boolean().default(false),
    canManagePayouts: z.boolean().default(false),
    canCancelEvent: z.boolean().default(false),
    canDeleteEvent: z.boolean().default(false),
  })
  .strict();

export type EventAdminPermissions = z.infer<typeof EventAdminPermissionsSchema>;

export const DEFAULT_ADMIN_PERMISSIONS: Readonly<EventAdminPermissions> = Object.freeze({
  canEditDetails: false,
  canManageTickets: false,
  canViewOrders: false,
  canManageTeam: false,
  canManagePromotions: false,
  canViewAnalytics: false,
  canManageRefunds: false,
  canManagePayouts: false,
  canCancelEvent: false,
  canDeleteEvent: false,
});


export function parseAdminPermissions(raw?: unknown): EventAdminPermissions {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_ADMIN_PERMISSIONS };
  }
  const result = EventAdminPermissionsSchema.safeParse(raw);
  if (!result.success) {
    return { ...DEFAULT_ADMIN_PERMISSIONS };
  }
  return result.data;
}


export function hasEventPermission(
  member: { role: EventTeamRole; permissions?: unknown },
  permissionKey: keyof EventAdminPermissions
): boolean {
  if (member.role !== EventTeamRole.ADMIN) {
    return false;
  }
  const parsed = parseAdminPermissions(member.permissions);
  return Boolean(parsed[permissionKey]);
}

export interface EventAuthorizationContext {
  isOwner: boolean;
  isAdmin: boolean;
  isHost: boolean;
  event: Event;
  memberId?: string;
  permissions?: EventAdminPermissions | null;
}


export async function resolveEventAuthorization(
  eventIdOrSlug: string,
  user: { userId: string; role: Role },
  requiredPermission?: keyof EventAdminPermissions
): Promise<EventAuthorizationContext> {
  const event = await prisma.event.findFirst({
    where: {
      OR: [{ id: eventIdOrSlug }, { slug: eventIdOrSlug }],
    },
  });

  if (!event) {
    throw new NotFoundError('Event not found');
  }

  if (event.organizerId === user.userId) {
    return {
      isOwner: true,
      isAdmin: false,
      isHost: false,
      event,
      permissions: null,
    };
  }

  const member = await prisma.eventTeamMember.findUnique({
    where: {
      eventId_userId: {
        eventId: event.id,
        userId: user.userId,
      },
    },
  });

  if (member && member.status === 'ACTIVE') {
    if (member.role === EventTeamRole.ADMIN) {
      const perms = parseAdminPermissions(member.permissions);
      if (requiredPermission) {
        if (!perms[requiredPermission]) {
          throw new ForbiddenError(
            `Access denied. You lack the '${requiredPermission}' permission for this event.`
          );
        }
      }
      return {
        isOwner: false,
        isAdmin: true,
        isHost: false,
        event,
        memberId: member.id,
        permissions: perms,
      };
    }

    if (member.role === EventTeamRole.HOST) {
      if (requiredPermission) {
        throw new ForbiddenError('Event hosts are restricted to personal promotional links and traffic.');
      }
      return {
        isOwner: false,
        isAdmin: false,
        isHost: true,
        event,
        memberId: member.id,
        permissions: null,
      };
    }
  }

  // 3. Platform Admin fallback: Platform ADMIN does NOT have automatic access to organizer financial credentials
  if (user.role === Role.ADMIN) {
    if (requiredPermission === 'canManagePayouts') {
      throw new ForbiddenError('Platform administrators cannot access organizer financial credentials.');
    }
    return {
      isOwner: false,
      isAdmin: true,
      isHost: false,
      event,
      permissions: {
        ...DEFAULT_ADMIN_PERMISSIONS,
        canEditDetails: true,
        canViewOrders: true,
        canManagePromotions: true,
        canViewAnalytics: true,
      },
    };
  }

  throw new ForbiddenError('You are not an authorized member of this event team.');
}

