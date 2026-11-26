import { useQueries } from '@tanstack/react-query';
import { api, ScannerGateItem } from '../lib/api';
import { HostAssignedEventItem, OrganizerEventItem, User } from '../types';
import {
  deriveNavigationState,
  NavigationCapabilitiesInput,
  NavigationState,
} from '../lib/navigation';

export const NAVIGATION_CAPABILITY_STALE_TIME_MS = 60_000;

/**
 * Discovers event-scoped capabilities (Event Admin permissions, Event Host
 * assignments, and Door Staff / owned-published scanner gates) in parallel
 * via existing read-only endpoints using React Query.
 */
export function useNavigationCapabilities(
  user: Pick<User, 'id' | 'role' | 'emailVerified'> | null | undefined,
  overrideCapabilities?: NavigationCapabilitiesInput
): NavigationState {
  const isVerifiedUser = Boolean(user && user.emailVerified !== false);
  const isPlatformAdmin = user?.role === 'ADMIN';
  const hasOverride = Boolean(overrideCapabilities);

  const [organizerEventsQuery, hostEventsQuery, scannerGatesQuery] = useQueries({
    queries: [
      {
        queryKey: ['organizer-events'] as const,
        queryFn: async (): Promise<{ events: OrganizerEventItem[] }> => api.organizer.listEvents(),
        enabled: !hasOverride && isVerifiedUser && !isPlatformAdmin,
        staleTime: NAVIGATION_CAPABILITY_STALE_TIME_MS,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      {
        queryKey: ['host-events'] as const,
        queryFn: async (): Promise<HostAssignedEventItem[]> => api.host.getEvents(),
        enabled: !hasOverride && isVerifiedUser,
        staleTime: NAVIGATION_CAPABILITY_STALE_TIME_MS,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      {
        queryKey: ['scanner-gates'] as const,
        queryFn: async (): Promise<{ events: ScannerGateItem[] }> => api.scanner.getGates(),
        enabled: !hasOverride && isVerifiedUser && !isPlatformAdmin,
        staleTime: NAVIGATION_CAPABILITY_STALE_TIME_MS,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    ],
  });

  if (overrideCapabilities) {
    return deriveNavigationState(user, overrideCapabilities);
  }

  return deriveNavigationState(user, {
    organizerEvents: organizerEventsQuery.data?.events,
    organizerEventsResolved: organizerEventsQuery.isSuccess,
    organizerEventsError: organizerEventsQuery.isError,
    hostEvents: hostEventsQuery.data,
    hostEventsResolved: hostEventsQuery.isSuccess,
    hostEventsError: hostEventsQuery.isError,
    scannerGates: scannerGatesQuery.data?.events,
    scannerGatesResolved: scannerGatesQuery.isSuccess,
    scannerGatesError: scannerGatesQuery.isError,
  });
}
