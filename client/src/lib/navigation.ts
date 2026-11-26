import { HostAssignedEventItem, OrganizerEventItem, User } from '../types';
import type { ScannerGateItem } from './api';

export type WorkspaceKey =
  | 'organizer'
  | 'orders'
  | 'teams'
  | 'finance'
  | 'scanner'
  | 'host';

export interface NavigationDestination {
  key: WorkspaceKey;
  to: string;
  label: string;
}

export interface NavigationCapabilitiesInput {
  organizerEvents?: OrganizerEventItem[];
  organizerEventsResolved?: boolean;
  organizerEventsError?: boolean;
  hostEvents?: HostAssignedEventItem[];
  hostEventsResolved?: boolean;
  hostEventsError?: boolean;
  scannerGates?: ScannerGateItem[];
  scannerGatesResolved?: boolean;
  scannerGatesError?: boolean;
}

export interface ResolvedNavigationCapabilities {
  hasOrganizerDashboard: boolean;
  hasOrders: boolean;
  hasTeam: boolean;
  hasFinanceAndOrg: boolean;
  hasDoorScanner: boolean;
  hasHostWorkspace: boolean;
  hasCreateEvent: boolean;
  isResolvingCapabilities: boolean;
}

export interface NavigationState {
  capabilities: ResolvedNavigationCapabilities;
  destinations: NavigationDestination[];
  visibleByKey: Record<WorkspaceKey, boolean>;
  showCreateEvent: boolean;
}

export const WORKSPACE_DESTINATIONS: readonly NavigationDestination[] = [
  { key: 'organizer', to: '/organizer', label: 'Organizer Dashboard' },
  { key: 'orders', to: '/orders', label: 'Orders' },
  { key: 'teams', to: '/teams', label: 'Team' },
  { key: 'finance', to: '/organizer/finance', label: 'Finance & Organisation' },
  { key: 'scanner', to: '/scanner', label: 'Door Scanner' },
  { key: 'host', to: '/host', label: 'Host Workspace' },
];

export const EMPTY_NAVIGATION_CAPABILITIES: ResolvedNavigationCapabilities = {
  hasOrganizerDashboard: false,
  hasOrders: false,
  hasTeam: false,
  hasFinanceAndOrg: false,
  hasDoorScanner: false,
  hasHostWorkspace: false,
  hasCreateEvent: true,
  isResolvingCapabilities: false,
};

export function deriveNavigationState(
  user: Pick<User, 'id' | 'role' | 'emailVerified'> | null | undefined,
  input: NavigationCapabilitiesInput = {}
): NavigationState {
  if (!user) {
    return {
      capabilities: {
        ...EMPTY_NAVIGATION_CAPABILITIES,
        hasCreateEvent: true,
      },
      destinations: [],
      visibleByKey: {
        organizer: false,
        orders: false,
        teams: false,
        finance: false,
        scanner: false,
        host: false,
      },
      showCreateEvent: true,
    };
  }

  const isVerified = user.emailVerified !== false;
  const isPlatformAdmin = user.role === 'ADMIN';
  const isAccountOrganizer = user.role === 'ORGANIZER';

  const organizerEvents =
    isVerified && input.organizerEventsResolved && !input.organizerEventsError && Array.isArray(input.organizerEvents)
      ? input.organizerEvents
      : [];

  const hostEvents =
    isVerified && input.hostEventsResolved && !input.hostEventsError && Array.isArray(input.hostEvents)
      ? input.hostEvents
      : [];

  const scannerGates =
    isVerified && input.scannerGatesResolved && !input.scannerGatesError && Array.isArray(input.scannerGates)
      ? input.scannerGates
      : [];

  const hasOwnedEvent = organizerEvents.some((evt) =>
    evt.isOwner !== undefined ? evt.isOwner : evt.organizerId === user.id
  );
  const hasOwnedPublishedEvent = organizerEvents.some((evt) => {
    const isOwner = evt.isOwner !== undefined ? evt.isOwner : evt.organizerId === user.id;
    return isOwner && evt.status === 'PUBLISHED';
  });
  const hasEventAdminMembership = organizerEvents.some((evt) => {
    const isOwner = evt.isOwner !== undefined ? evt.isOwner : evt.organizerId === user.id;
    return !isOwner && (evt.accessRole === 'ADMIN' || Boolean(evt.permissions));
  });
  const hasCanViewOrdersPermission = organizerEvents.some((evt) =>
    Boolean(evt.permissions?.canViewOrders)
  );
  const hasCanManageTeamPermission = organizerEvents.some((evt) =>
    Boolean(evt.permissions?.canManageTeam)
  );

  const hasHostAssignment = hostEvents.length > 0;
  const hasScannerStaffAssignment = scannerGates.some((gate) => gate.role === 'STAFF');
  const hasOwnedPublishedGate = scannerGates.some((gate) => gate.role === 'ORGANIZER');

  const hasOrganizerDashboard =
    isVerified && (isPlatformAdmin || isAccountOrganizer || hasOwnedEvent || hasEventAdminMembership);
  const hasOrders =
    isVerified && (isPlatformAdmin || isAccountOrganizer || hasCanViewOrdersPermission);
  const hasTeam =
    isVerified && (isPlatformAdmin || isAccountOrganizer || hasCanManageTeamPermission);
  const hasFinanceAndOrg =
    isVerified && (isPlatformAdmin || isAccountOrganizer);
  const hasDoorScanner =
    isVerified &&
    (isPlatformAdmin ||
      hasScannerStaffAssignment ||
      hasOwnedPublishedGate ||
      (isAccountOrganizer && hasOwnedPublishedEvent));
  const hasHostWorkspace = isVerified && hasHostAssignment;

  const isCollaboratorWithoutOrganizerRights =
    user.role === 'ATTENDEE' &&
    !hasEventAdminMembership &&
    !hasOwnedEvent &&
    (hasHostAssignment || hasScannerStaffAssignment || hasOwnedPublishedGate);

  const showCreateEvent =
    isPlatformAdmin || isAccountOrganizer || !isCollaboratorWithoutOrganizerRights;

  const isResolvingCapabilities =
    isVerified &&
    ((user.role !== 'ADMIN' && !input.organizerEventsResolved && !input.organizerEventsError) ||
      (!input.hostEventsResolved && !input.hostEventsError) ||
      (user.role !== 'ADMIN' && !input.scannerGatesResolved && !input.scannerGatesError));

  const visibleByKey: Record<WorkspaceKey, boolean> = {
    organizer: hasOrganizerDashboard,
    orders: hasOrders,
    teams: hasTeam,
    finance: hasFinanceAndOrg,
    scanner: hasDoorScanner,
    host: hasHostWorkspace,
  };

  const destinations = WORKSPACE_DESTINATIONS.filter((dest) => visibleByKey[dest.key]);

  return {
    capabilities: {
      hasOrganizerDashboard,
      hasOrders,
      hasTeam,
      hasFinanceAndOrg,
      hasDoorScanner,
      hasHostWorkspace,
      hasCreateEvent: showCreateEvent,
      isResolvingCapabilities,
    },
    destinations,
    visibleByKey,
    showCreateEvent,
  };
}
