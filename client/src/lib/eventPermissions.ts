import { EventAdminPermissions, EventStatus, User } from '../types';

export interface EventAuthorizationTarget {
  id: string;
  organizerId?: string;
  status?: EventStatus | string;
  seriesId?: string | null;
  isOwner?: boolean;
  permissions?: Partial<EventAdminPermissions> | null;
}

export interface OrganizerEventUiPermissions {
  isEventOwner: boolean;
  isPlatformAdmin: boolean;
  canManageTeam: boolean;
  canViewPromotions: boolean;
  canViewWaitlist: boolean;
  canEditDetails: boolean;
  canManageTickets: boolean;
  canEditEvent: boolean;
  canCancelOccurrence: boolean;
  canCancelSeries: boolean;
  canPreviewEvent: boolean;
  canPublishOrUnpublish: boolean;
  canDeleteEvent: boolean;
  canViewOrders: boolean;
  canAccessFinance: boolean;
  editPath: string;
  editLabel: string;
}

/**
 * Resolves UI action permissions for an organizer event or draft from the
 * event's server-supplied authorization metadata and current authenticated user.
 */
export function resolveOrganizerEventUiPermissions(
  event: EventAuthorizationTarget | null | undefined,
  user: Pick<User, 'id' | 'role'> | null | undefined
): OrganizerEventUiPermissions {
  const isPlatformAdmin = user?.role === 'ADMIN';

  if (!event) {
    return {
      isEventOwner: true,
      isPlatformAdmin,
      canManageTeam: true,
      canViewPromotions: true,
      canViewWaitlist: true,
      canEditDetails: true,
      canManageTickets: true,
      canEditEvent: true,
      canCancelOccurrence: false,
      canCancelSeries: false,
      canPreviewEvent: true,
      canPublishOrUnpublish: true,
      canDeleteEvent: false,
      canViewOrders: true,
      canAccessFinance: true,
      editPath: '',
      editLabel: 'Edit Event',
    };
  }

  const isEventOwner =
    event.isOwner !== undefined
      ? event.isOwner
      : Boolean(user && event.organizerId === user.id);
  const perms = event.permissions || null;
  const hasFullAuthority = isEventOwner || isPlatformAdmin;

  const canEditDetails = hasFullAuthority || Boolean(perms?.canEditDetails);
  const canManageTickets = hasFullAuthority || Boolean(perms?.canManageTickets);
  const canEditEvent = canEditDetails || canManageTickets;
  const canCancelOccurrence =
    (hasFullAuthority || Boolean(perms?.canCancelEvent)) &&
    event.status !== 'CANCELLED';
  const canCancelSeries = Boolean(event.seriesId) && hasFullAuthority;
  const canDeleteEvent = hasFullAuthority || Boolean(perms?.canDeleteEvent);
  const canViewOrders = hasFullAuthority || Boolean(perms?.canViewOrders);

  const editPath =
    canManageTickets && !canEditDetails
      ? `/organizer/events/${event.id}/edit?step=tickets`
      : `/organizer/events/${event.id}/edit`;

  const editLabel =
    canEditDetails && canManageTickets
      ? 'Edit Event & Ticket Tiers'
      : canManageTickets
      ? 'Manage Ticket Tiers'
      : 'Edit Event Details';

  return {
    isEventOwner,
    isPlatformAdmin,
    canManageTeam: hasFullAuthority || Boolean(perms?.canManageTeam),
    canViewPromotions:
      hasFullAuthority || Boolean(perms?.canManagePromotions || perms?.canViewAnalytics),
    canViewWaitlist: isEventOwner,
    canEditDetails,
    canManageTickets,
    canEditEvent,
    canCancelOccurrence,
    canCancelSeries,
    canPreviewEvent:
      hasFullAuthority ||
      Boolean(
        perms?.canEditDetails ||
          perms?.canManageTickets ||
          perms?.canCancelEvent ||
          perms?.canDeleteEvent ||
          perms?.canViewOrders
      ),
    canPublishOrUnpublish: hasFullAuthority,
    canDeleteEvent,
    canViewOrders,
    canAccessFinance: isEventOwner,
    editPath,
    editLabel,
  };
}
