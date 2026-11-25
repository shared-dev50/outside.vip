import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AdminPermissionsModal,
  DEFAULT_ADMIN_PERMISSIONS,
  SAFE_ADMIN_PERMISSIONS,
  DELEGABLE_PERMISSION_COUNT,
  countActiveDelegablePermissions,
  sanitizeAdminPermissions,
  computeSafeDefaultsForCaller,
} from '../src/components/team/AdminPermissionsModal';
import { EventTeamModal } from '../src/components/team/EventTeamModal';
import { TeamInvitationPage } from '../src/pages/TeamInvitationPage';
import { OrganizerDashboardPage } from '../src/pages/OrganizerDashboardPage';
import { CreateEventPage } from '../src/pages/CreateEventPage';
import { EventPreviewPage } from '../src/pages/EventPreviewPage';
import { api, setActiveCsrfToken } from '../src/lib/api';
import { OrganizerEventItem, User } from '../src/types';

const mockEvent: OrganizerEventItem = {
  id: 'evt-team-test-101',
  slug: 'sol-fest-nairobi',
  organizerId: 'org-user-1',
  organizer: {
    id: 'org-user-1',
    name: 'Sol Collective Africa',
    avatarUrl: null,
  },
  title: 'Sol Fest Africa 2026',
  tagline: 'Music & Visual Arts',
  description: 'Annual cultural festival in Nairobi.',
  category: 'FESTIVAL',
  status: 'PUBLISHED',
  coverImageUrl: 'https://images.unsplash.com/photo-1492684223066-81342ee5ff30',
  venueName: 'Uhuru Gardens',
  venueAddress: 'Langata Road',
  city: 'Nairobi',
  country: 'Kenya',
  startAt: '2026-11-20T18:00:00.000Z',
  endAt: '2026-11-21T06:00:00.000Z',
  timezone: 'Africa/Nairobi',
  isSoldOut: false,
  isFeatured: true,
  minPriceInCents: 3500,
  currency: 'USD',
  ticketTiers: [],
  totalCapacity: 5000,
  ticketsSold: 1200,
  revenueInCents: 4200000,
  revenueFormatted: '$42,000',
};

describe('Stage 3: Event Team Management & Admin Permissions Frontend', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    setActiveCsrfToken('mock-csrf-token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Admin Permissions Modal & Logical Grouping
  // =========================================================================
  describe('1. AdminPermissionsModal Specification & Deny-by-Default Guardrails', () => {
    it('defines 10 distinct permissions defaulting to false (deny-by-default)', () => {
      expect(DEFAULT_ADMIN_PERMISSIONS).toEqual({
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

      // Exactly 10 permissions
      expect(Object.keys(DEFAULT_ADMIN_PERMISSIONS).length).toBe(10);
      // All false
      expect(Object.values(DEFAULT_ADMIN_PERMISSIONS).every((val) => val === false)).toBe(true);
    });

    it('defines SAFE_ADMIN_PERMISSIONS with non-sensitive operations enabled and sensitive operations denied', () => {
      // Event operations and promotions/analytics are safe
      expect(SAFE_ADMIN_PERMISSIONS.canEditDetails).toBe(true);
      expect(SAFE_ADMIN_PERMISSIONS.canManageTickets).toBe(true);
      expect(SAFE_ADMIN_PERMISSIONS.canViewOrders).toBe(true);
      expect(SAFE_ADMIN_PERMISSIONS.canManagePromotions).toBe(true);
      expect(SAFE_ADMIN_PERMISSIONS.canViewAnalytics).toBe(true);

      // Sensitive operations MUST remain false in safe defaults
      expect(SAFE_ADMIN_PERMISSIONS.canManageRefunds).toBe(false);
      expect(SAFE_ADMIN_PERMISSIONS.canManagePayouts).toBe(false);
      expect(SAFE_ADMIN_PERMISSIONS.canCancelEvent).toBe(false);
      expect(SAFE_ADMIN_PERMISSIONS.canDeleteEvent).toBe(false);
      expect(SAFE_ADMIN_PERMISSIONS.canManageTeam).toBe(false);
    });

    it('renders the three logical sections and sensitive warning banners when open', () => {
      const html = renderToString(
        <AdminPermissionsModal
          isOpen={true}
          onClose={() => {}}
          onSave={() => {}}
          title="Configure Admin Permissions"
        />
      );

      // Section 1: Event Operations
      expect(html).toContain('1. Event Operations');
      expect(html).toContain('Edit Event Details');
      expect(html).toContain('Manage Ticket Tiers');
      expect(html).toContain('View Attendee Orders');

      // Section 2: Team & Promotional Operations
      expect(html).toContain('2. Team &amp; Promotional Operations');
      expect(html).toContain('Manage Event Team');
      expect(html).toContain('Manage Promotional Links');
      expect(html).toContain('View Traffic Analytics');

      // Section 3: High-Risk Sensitive Operations
      expect(html).toContain('3. High-Risk Operations');
      expect(html).toContain('Caution Required');
      expect(html).toContain('Cancel Event Occurrence');
      expect(html).toContain('Delete Draft &amp; Archive Event');
      expect(html).toContain('Payouts and payout settings are managed by the event owner.');
      expect(html).toContain('Refund delegation is not currently available.');
      expect(html).not.toContain('Issue Buyer Refunds');
      expect(html).not.toContain('Manage Banking &amp; Payouts');

      // Presets
      expect(html).toContain('Safe Defaults');
      expect(html).toContain('Deny All');
    });

    it('returns null when isOpen is false', () => {
      const html = renderToString(
        <AdminPermissionsModal
          isOpen={false}
          onClose={() => {}}
          onSave={() => {}}
        />
      );
      expect(html).toBe('');
    });
  });

  // =========================================================================
  // 2. EventTeamModal Specification & Member Roster
  // =========================================================================
  describe('2. EventTeamModal UI & Role-Specific Member Display', () => {
    it('renders modal header, tab navigation, and invite button for the target event', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventTeamModal
              isOpen={true}
              onClose={() => {}}
              event={mockEvent}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('Event Team &amp; Hosts');
      expect(html).toContain('Sol Fest Africa 2026');
      expect(html).toContain('Active Team');
      expect(html).toContain('Pending Invites');
      expect(html).toContain('Invite Member');
    });

    it('returns null when isOpen is false or event is null', () => {
      const htmlClosed = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventTeamModal isOpen={false} onClose={() => {}} event={mockEvent} />
          </MemoryRouter>
        </QueryClientProvider>
      );
      expect(htmlClosed).toBe('');

      const htmlNoEvent = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventTeamModal isOpen={true} onClose={() => {}} event={null} />
          </MemoryRouter>
        </QueryClientProvider>
      );
      expect(htmlNoEvent).toBe('');
    });

    it('renders active working link and copy button ONLY for active Hosts, not for inactive or revoked hosts', () => {
      queryClient.setQueryData(['event-team', mockEvent.id], {
        members: [
          {
            id: 'host-active-1',
            userId: 'user-active-1',
            name: 'Active Promoter',
            email: 'active@outside.vip',
            role: 'HOST' as const,
            status: 'ACTIVE' as const,
            permissions: null,
            hostLink: {
              id: 'link-1',
              slug: 'active-slug',
              name: 'Active Host Link',
            },
            createdAt: '2026-11-20T10:00:00Z',
          },
          {
            id: 'host-inactive-2',
            userId: 'user-inactive-2',
            name: 'Paused Promoter',
            email: 'paused@outside.vip',
            role: 'HOST' as const,
            status: 'INACTIVE' as const,
            permissions: null,
            hostLink: {
              id: 'link-2',
              slug: 'paused-slug',
              name: 'Paused Host Link',
            },
            createdAt: '2026-11-20T10:00:00Z',
          },
          {
            id: 'host-revoked-3',
            userId: 'user-revoked-3',
            name: 'Revoked Promoter',
            email: 'revoked@outside.vip',
            role: 'HOST' as const,
            status: 'REVOKED' as const,
            permissions: null,
            hostLink: {
              id: 'link-3',
              slug: 'revoked-slug',
              name: 'Revoked Host Link',
            },
            createdAt: '2026-11-20T10:00:00Z',
          },
        ],
        invitations: [],
      });

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventTeamModal isOpen={true} onClose={() => {}} event={mockEvent} />
          </MemoryRouter>
        </QueryClientProvider>
      );

      // Active host gets working link and copy button
      expect(html).toContain('/r/active-slug');
      expect(html).toContain('title="Copy Promotional Link"');

      // Inactive host gets paused notice and NO working link badge
      expect(html).toContain('Link paused (member inactive)');
      expect(html).not.toContain('/r/paused-slug');

      // Revoked host gets archived notice and NO working link badge
      expect(html).toContain('Link archived');
      expect(html).not.toContain('/r/revoked-slug');
    });
  });

  // =========================================================================
  // 3. TeamInvitationPage Public Inspection & Auth Workflows
  // =========================================================================
  describe('3. TeamInvitationPage Public Inspection & Account Protection', () => {
    it('renders inspecting loader initially while fetching invitation metadata', () => {
      const html = renderToString(
        <MemoryRouter initialEntries={['/team/invitations/test-token-123']}>
          <TeamInvitationPage />
        </MemoryRouter>
      );

      expect(html).toContain('Inspecting Team Invitation...');
    });

    it('uses masked invitation email strictly for display and delegates ownership validation to the backend', () => {
      const pageSource = fs.readFileSync(
        path.resolve(__dirname, '../src/pages/TeamInvitationPage.tsx'),
        'utf-8'
      );

      // Masked email must NOT be used for authorization comparison
      expect(pageSource).not.toMatch(/user\.email\s*===?\s*invitation\.emailMasked/);
      expect(pageSource).not.toMatch(/invitation\.emailMasked\s*===?\s*user\.email/);

      // Masked email is used strictly for presentation
      expect(pageSource).toContain('Invited recipient:');
      expect(pageSource).toContain('{invitation.emailMasked}');

      // Acceptance delegates to backend API with token, letting backend enforce verified email matching
      expect(pageSource).toContain('await api.team.acceptInvitation(token)');
    });

    it('dynamically resolves window.location.origin and does not assume production hostname', () => {
      const pageSource = fs.readFileSync(
        path.resolve(__dirname, '../src/pages/TeamInvitationPage.tsx'),
        'utf-8'
      );
      const modalSource = fs.readFileSync(
        path.resolve(__dirname, '../src/components/team/EventTeamModal.tsx'),
        'utf-8'
      );

      // Verifies window.location.origin is queried dynamically
      expect(pageSource).toContain('window.location?.origin');
      expect(modalSource).toContain('window.location?.origin');
    });
  });

  // =========================================================================
  // 4. api.team Client API Contracts
  // =========================================================================
  describe('4. api.team API Client Endpoints & Payload Contracts', () => {
    it('api.team.getTeam fetches event team members and pending invitations', async () => {
      const mockTeamData = {
        members: [
          {
            id: 'mem-1',
            userId: 'user-1',
            name: 'Wanjiku Admin',
            email: 'wanjiku@outside.vip',
            role: 'ADMIN' as const,
            status: 'ACTIVE' as const,
            permissions: DEFAULT_ADMIN_PERMISSIONS,
            createdAt: '2026-11-20T10:00:00Z',
          },
          {
            id: 'mem-2',
            userId: 'user-2',
            name: 'Otieno Host',
            email: 'otieno@outside.vip',
            role: 'HOST' as const,
            status: 'ACTIVE' as const,
            permissions: null,
            hostLink: {
              id: 'link-host-1',
              slug: 'otieno-sol',
              name: 'Otieno Official Host Link',
            },
            createdAt: '2026-11-20T10:30:00Z',
          },
        ],
        invitations: [
          {
            id: 'inv-1',
            email: 'promoter@solfest.ke',
            role: 'HOST' as const,
            status: 'PENDING' as const,
            permissions: null,
            expiresAt: '2026-11-27T10:00:00Z',
            createdAt: '2026-11-20T10:00:00Z',
          },
        ],
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              team: mockTeamData,
            }),
        } as any)
      );

      const result = await api.team.getTeam('evt-team-test-101');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('/events/evt-team-test-101/team');
      expect(result.members.length).toBe(2);
      expect(result.members[0].role).toBe('ADMIN');
      expect(result.members[1].hostLink?.slug).toBe('otieno-sol');
      expect(result.invitations.length).toBe(1);
    });

    it('api.team.invite dispatches invitation with role and optional admin permissions', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => {
        const body = JSON.parse(init?.body as string);
        expect(body.email).toBe('newadmin@outside.vip');
        expect(body.role).toBe('ADMIN');
        expect(body.permissions.canEditDetails).toBe(true);

        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              invitation: {
                id: 'inv-admin-new',
                email: 'newadmin@outside.vip',
                role: 'ADMIN',
                status: 'PENDING',
                permissions: body.permissions,
                expiresAt: '2026-11-27T12:00:00Z',
                createdAt: '2026-11-20T12:00:00Z',
              },
            }),
        } as any);
      });

      const inv = await api.team.invite('evt-team-test-101', {
        email: 'newadmin@outside.vip',
        role: 'ADMIN',
        permissions: { ...SAFE_ADMIN_PERMISSIONS },
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(inv.id).toBe('inv-admin-new');
      expect(inv.email).toBe('newadmin@outside.vip');
    });

    it('api.team.resendInvitation dispatches POST to resend endpoint', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => {
        expect(init?.method).toBe('POST');
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              invitation: {
                id: 'inv-123',
                email: 'host@outside.vip',
                role: 'HOST',
                status: 'PENDING',
                expiresAt: '2026-11-28T12:00:00Z',
                createdAt: '2026-11-20T12:00:00Z',
              },
            }),
        } as any);
      });

      const updated = await api.team.resendInvitation('evt-team-test-101', 'inv-123');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('/events/evt-team-test-101/team/invitations/inv-123/resend');
      expect(updated.id).toBe('inv-123');
    });

    it('api.team.revokeInvitation dispatches DELETE request', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => {
        expect(init?.method).toBe('DELETE');
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              message: 'Invitation revoked',
            }),
        } as any);
      });

      const res = await api.team.revokeInvitation('evt-team-test-101', 'inv-123');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('/events/evt-team-test-101/team/invitations/inv-123');
      expect(res.success).toBe(true);
    });

    it('api.team.updateMember dispatches PATCH request with role, status, or permissions', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => {
        expect(init?.method).toBe('PATCH');
        const body = JSON.parse(init?.body as string);
        expect(body.status).toBe('INACTIVE');

        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              member: {
                id: 'mem-99',
                userId: 'user-99',
                name: 'Promoter',
                email: 'promoter@outside.vip',
                role: 'HOST',
                status: 'INACTIVE',
                permissions: null,
                createdAt: '2026-11-20T10:00:00Z',
              },
            }),
        } as any);
      });

      const member = await api.team.updateMember('evt-team-test-101', 'mem-99', {
        status: 'INACTIVE',
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(member.status).toBe('INACTIVE');
    });

    it('api.team.revokeMember dispatches DELETE request to revoke membership', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => {
        expect(init?.method).toBe('DELETE');
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              message: 'Team member access revoked',
            }),
        } as any);
      });

      const res = await api.team.revokeMember('evt-team-test-101', 'mem-99');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('/events/evt-team-test-101/team/members/mem-99');
      expect(res.success).toBe(true);
    });

    it('api.team.inspectInvitation fetches public invitation metadata without credentials', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              invitation: {
                id: 'inv-public-1',
                eventId: 'evt-team-test-101',
                eventTitle: 'Sol Fest Africa 2026',
                eventSlug: 'sol-fest-nairobi',
                organizerName: 'Sol Collective Africa',
                role: 'HOST',
                emailMasked: 'o***@outside.vip',
                status: 'PENDING',
                expiresAt: '2026-11-27T12:00:00Z',
              },
            }),
        } as any)
      );

      const metadata = await api.team.inspectInvitation('valid-token-xyz');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('/team/invitations/valid-token-xyz');
      expect(metadata.eventTitle).toBe('Sol Fest Africa 2026');
      expect(metadata.role).toBe('HOST');
      expect(metadata.emailMasked).toBe('o***@outside.vip');
    });

    it('api.team.acceptInvitation posts to accept endpoint and receives activated membership & hostLink', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => {
        expect(init?.method).toBe('POST');
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              membership: {
                memberId: 'mem-new-host',
                eventId: 'evt-team-test-101',
                role: 'HOST',
                status: 'ACTIVE',
                hostLink: {
                  id: 'link-auto-1',
                  slug: 'sol-fest-nairobi-host-otieno',
                  name: 'Otieno Official Host Link',
                },
              },
            }),
        } as any);
      });

      const result = await api.team.acceptInvitation('valid-token-xyz');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('/team/invitations/valid-token-xyz/accept');
      expect(result.role).toBe('HOST');
      expect(result.status).toBe('ACTIVE');
      expect(result.hostLink?.slug).toBe('sol-fest-nairobi-host-otieno');
    });
  });

  // =========================================================================
  // 5. Unified Event Team Workspace (Stage 3 Implementation 5)
  // =========================================================================
  describe('5. Unified Event Team Workspace & Multi-Role Integration', () => {
    it('renders combined unified roster with Door Scanners, Hosts, and Admins', () => {
      // 1. Seed Hosts & Admins
      queryClient.setQueryData(['event-team', mockEvent.id], {
        members: [
          {
            id: 'mem-admin-1',
            userId: 'user-admin-1',
            name: 'Kipchoge Admin',
            email: 'admin@outside.vip',
            role: 'ADMIN' as const,
            status: 'ACTIVE' as const,
            permissions: DEFAULT_ADMIN_PERMISSIONS,
            createdAt: '2026-11-20T08:00:00Z',
          },
          {
            id: 'mem-host-1',
            userId: 'user-host-1',
            name: 'Amina Host',
            email: 'amina@outside.vip',
            role: 'HOST' as const,
            status: 'ACTIVE' as const,
            permissions: null,
            hostLink: {
              id: 'link-amina',
              slug: 'amina-vip',
              name: 'Amina Official Link',
            },
            createdAt: '2026-11-20T09:00:00Z',
          },
        ],
        invitations: [
          {
            id: 'inv-host-1',
            email: 'pendinghost@outside.vip',
            role: 'HOST' as const,
            status: 'PENDING' as const,
            permissions: null,
            expiresAt: '2026-11-27T10:00:00Z',
            createdAt: '2026-11-20T10:00:00Z',
          },
        ],
      });

      // 2. Seed Door Scanner Staff
      queryClient.setQueryData(['event-staff', mockEvent.id], {
        staff: [
          {
            id: 'staff-1',
            userId: 'user-staff-1',
            name: 'Baraka Scanner',
            email: 'baraka@gate.vip',
            role: 'STAFF' as const,
            status: 'ACTIVE' as const,
            assignedAt: '2026-11-20T09:30:00Z',
          },
        ],
        invitations: [
          {
            id: 'staff-inv-1',
            email: 'gatestaff@outside.vip',
            status: 'PENDING' as const,
            expiresAt: '2026-11-27T10:00:00Z',
            createdAt: '2026-11-20T10:00:00Z',
          },
        ],
      });

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventTeamModal isOpen={true} onClose={() => {}} event={mockEvent} />
          </MemoryRouter>
        </QueryClientProvider>
      );

      // Verify header and filter pill tallies
      expect(html).toContain('Event Team &amp; Hosts');
      expect(html).toContain('All Roles (');
      expect(html).toContain('Door Scanners (');
      expect(html).toContain('Event Hosts (');
      expect(html).toContain('Event Admins (');
      expect(html).toContain('Pending Invites (');

      // Verify Admin member
      expect(html).toContain('Kipchoge Admin');
      expect(html).toContain('admin@outside.vip');
      expect(html).toContain('Admin');

      // Verify Host member with personal link
      expect(html).toContain('Amina Host');
      expect(html).toContain('amina@outside.vip');
      expect(html).toContain('Host');
      expect(html).toContain('/r/amina-vip');

      // Verify Scanner Staff member with gate capability
      expect(html).toContain('Baraka Scanner');
      expect(html).toContain('baraka@gate.vip');
      expect(html).toContain('Scanner Staff');
      expect(html).toContain('Gate Check-In &amp; QR Scanning');
    });

    it('supports inline embedding inside TeamsPage (isInline=true) without modal overlay', () => {
      queryClient.setQueryData(['event-team', mockEvent.id], {
        members: [],
        invitations: [],
      });
      queryClient.setQueryData(['event-staff', mockEvent.id], {
        staff: [],
        invitations: [],
      });

      const htmlInline = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventTeamModal isOpen={true} onClose={() => {}} event={mockEvent} isInline={true} />
          </MemoryRouter>
        </QueryClientProvider>
      );

      // In inline mode, the fixed modal overlay backdrop is omitted
      expect(htmlInline).not.toContain('fixed inset-0 z-50 bg-black/60 backdrop-blur-xs');
      expect(htmlInline).toContain('Event Team &amp; Hosts');
      expect(htmlInline).toContain('rounded-2xl border border-stone-200');
    });

    it('enforces strict architectural separation between api.staff and api.team in EventTeamModal', () => {
      const modalSource = fs.readFileSync(
        path.resolve(__dirname, '../src/components/team/EventTeamModal.tsx'),
        'utf-8'
      );

      // Staff invitations route exclusively to api.staff.invite
      expect(modalSource).toContain('staffInviteMutation = useMutation({');
      expect(modalSource).toContain('api.staff.invite(event.id, email)');

      // Host & Admin invitations route to api.team.invite
      expect(modalSource).toContain('teamInviteMutation = useMutation({');
      expect(modalSource).toContain('api.team.invite(event.id, data)');

      // Revocations route to distinct backend controllers
      expect(modalSource).toContain('api.staff.revokeMember(event.id, userId)');
      expect(modalSource).toContain('api.team.revokeMember(event.id, memberId)');
      expect(modalSource).toContain('api.staff.revokeInvitation(event.id, invitationId)');
      expect(modalSource).toContain('api.team.revokeInvitation(event.id, invitationId)');

      // Resends route to distinct endpoints
      expect(modalSource).toContain('api.staff.resendInvitation(event.id, invitationId)');
      expect(modalSource).toContain('api.team.resendInvitation(event.id, invitationId)');
    });

    it('ensures TeamsPage enforces RequireAuth with event-scoped authorization and embeds unified EventTeamModal', () => {
      const appSource = fs.readFileSync(
        path.resolve(__dirname, '../src/App.tsx'),
        'utf-8'
      );
      const teamsPageSource = fs.readFileSync(
        path.resolve(__dirname, '../src/pages/TeamsPage.tsx'),
        'utf-8'
      );

      // Route-level authentication protection in App.tsx (event-scoped authorization enforced in TeamsPage + backend)
      expect(appSource).toMatch(/path="\/teams"[\s\S]*?<RequireAuth>[\s\S]*?<TeamsPage \/>/);
      expect(teamsPageSource).toContain('canManageTeam');

      // Embeds unified EventTeamModal in inline mode
      expect(teamsPageSource).toContain('<EventTeamModal');
      expect(teamsPageSource).toContain('event={selectedEvent}');
      expect(teamsPageSource).toContain('isInline={true}');

      // Provides navigation link to scanner portal
      expect(teamsPageSource).toContain('to="/scanner"');
    });
  });

  // =========================================================================
  // 6. Stage 3 Implementation 5.1: Unified Invitation Dropdown Correction
  // =========================================================================
  describe('6. Stage 3 Implementation 5.1: Unified Invitation Dropdown & Scanner Restrictions', () => {
    it('renders role dropdown with exactly Door Scanner, Event Admin, and Event Host without separate role cards', () => {
      const modalSource = fs.readFileSync(
        path.resolve(__dirname, '../src/components/team/EventTeamModal.tsx'),
        'utf-8'
      );

      // Verifies select element and exact option labels
      expect(modalSource).toContain('<select');
      expect(modalSource).toContain('id="invite-role-select"');
      expect(modalSource).toContain('<option value="STAFF">Door Scanner</option>');
      expect(modalSource).toContain('<option value="ADMIN">Event Admin</option>');
      expect(modalSource).toContain('<option value="HOST">Event Host</option>');

      // Verifies that radio-card selection has been removed
      expect(modalSource).not.toContain('name="unifiedRole"');
      expect(modalSource).not.toContain('type="radio"');
    });

    it('dynamically adapts form sections based on selected role', () => {
      const modalSource = fs.readFileSync(
        path.resolve(__dirname, '../src/components/team/EventTeamModal.tsx'),
        'utf-8'
      );

      // 1. Door Scanner section
      expect(modalSource).toContain("inviteRole === 'STAFF'");
      expect(modalSource).toContain('Door Scanner Access');
      expect(modalSource).toContain('6-digit email OTP');
      expect(modalSource).toContain('No Outside.vip account or password required');

      // 2. Event Admin section & permission configuration
      expect(modalSource).toContain("inviteRole === 'ADMIN'");
      expect(modalSource).toContain('Event Administrator Access');
      expect(modalSource).toContain('Admin Permissions');
      expect(modalSource).toContain('Configure Permissions');
      expect(modalSource).toContain('setIsInvitePermsModalOpen(true)');

      // 3. Event Host section
      expect(modalSource).toContain("inviteRole === 'HOST'");
      expect(modalSource).toContain('Event Host Access');
      expect(modalSource).toContain('personal promotional link (/r/:slug)');
      expect(modalSource).toContain('Host Workspace');

      // Single submit button adapting its text
      expect(modalSource).toContain('Send Door Scanner Invite');
      expect(modalSource).toContain('Send Event Admin Invite');
      expect(modalSource).toContain('Send Event Host Invite');
    });

    it('verifies exact default value of all 10 permissions and confirms frontend and backend agree on deny-by-default', () => {
      const backendPermissionsSource = fs.readFileSync(
        path.resolve(__dirname, '../../server/src/modules/eventTeam/eventTeam.permissions.ts'),
        'utf-8'
      );

      // Verify all 10 permissions default to false in DEFAULT_ADMIN_PERMISSIONS
      const expectedAllFalse = {
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
      };

      expect(DEFAULT_ADMIN_PERMISSIONS).toEqual(expectedAllFalse);
      expect(Object.keys(DEFAULT_ADMIN_PERMISSIONS).length).toBe(10);
      expect(Object.values(DEFAULT_ADMIN_PERMISSIONS).every((v) => v === false)).toBe(true);

      // Verify backend schema defaults every permission to false
      expect(backendPermissionsSource).toContain('canEditDetails: z.boolean().default(false)');
      expect(backendPermissionsSource).toContain('canManageTickets: z.boolean().default(false)');
      expect(backendPermissionsSource).toContain('canViewOrders: z.boolean().default(false)');
      expect(backendPermissionsSource).toContain('canManageTeam: z.boolean().default(false)');
      expect(backendPermissionsSource).toContain('canManagePromotions: z.boolean().default(false)');
      expect(backendPermissionsSource).toContain('canViewAnalytics: z.boolean().default(false)');
      expect(backendPermissionsSource).toContain('canManageRefunds: z.boolean().default(false)');
      expect(backendPermissionsSource).toContain('canManagePayouts: z.boolean().default(false)');
      expect(backendPermissionsSource).toContain('canCancelEvent: z.boolean().default(false)');
      expect(backendPermissionsSource).toContain('canDeleteEvent: z.boolean().default(false)');
    });

    it('displays owner-restricted messaging and preserves Host/Admin management when scanner access returns 403', () => {
      // Seed Hosts & Admins normally
      queryClient.setQueryData(['event-team', mockEvent.id], {
        members: [
          {
            id: 'mem-admin-co',
            userId: 'user-admin-co',
            name: 'Co-Organizer Admin',
            email: 'co-org@outside.vip',
            role: 'ADMIN' as const,
            status: 'ACTIVE' as const,
            permissions: DEFAULT_ADMIN_PERMISSIONS,
            createdAt: '2026-11-20T08:00:00Z',
          },
        ],
        invitations: [],
      });

      // Seed Scanner query with isRestricted: true (simulating 403 Forbidden for non-owner Event Admin)
      queryClient.setQueryData(['event-staff', mockEvent.id], {
        staff: [],
        invitations: [],
        isRestricted: true,
      });

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventTeamModal isOpen={true} onClose={() => {}} event={mockEvent} />
          </MemoryRouter>
        </QueryClientProvider>
      );

      // 1. Filter pill must NOT say (0) for Door Scanners — it must say Restricted
      expect(html).toMatch(/Door Scanners\s*\([^\)]*Restricted/);

      // 2. Clear owner-restricted notice banner rendered in member view
      expect(html).toContain('Door scanner staff management is restricted to the event organizer (owner)');
      expect(html).toContain('Scanner staff are omitted from this view');

      // 3. Host and Admin members remain fully visible and functional
      expect(html).toContain('Co-Organizer Admin');
      expect(html).toContain('co-org@outside.vip');

      // 4. Footer indicates scanner staff is restricted rather than 0
      expect(html).toContain('scanner restricted');
    });
  });

  // =========================================================================
  // 7. P2-01 Dormant Toggle Removal, Accurate Copy, /8 Counts & Caller-Scoped Delegation
  // =========================================================================
  describe('7. P2-01 Dormant Permission Toggles & Accurate UI Representation', () => {
    it('removes dormant canManageRefunds and canManagePayouts checkboxes, shows owner/refund informational notes, and uses /8 counts', () => {
      // Even if legacy data passes canManageRefunds: true and canManagePayouts: true, both are sanitized to false
      const html = renderToString(
        <AdminPermissionsModal
          isOpen={true}
          onClose={() => {}}
          onSave={() => {}}
          initialPermissions={{
            canEditDetails: true,
            canManageRefunds: true as any,
            canManagePayouts: true as any,
          }}
          title="Configure Admin Permissions"
        />
      );

      // 1. Neither dormant toggle appears as a checkbox or label
      expect(html).not.toContain('Issue Buyer Refunds');
      expect(html).not.toContain('Manage Banking &amp; Payouts');
      expect(html).not.toContain('Coming Soon');

      // 2. Concise informational notes are rendered
      expect(html).toContain('Payouts and payout settings are managed by the event owner.');
      expect(html).toContain('Refund delegation is not currently available.');

      // 3. Counts accurately use /8 (never /10) and ignore legacy dormant trues
      expect(html).toContain('1/8 Active');
      expect(html).toContain('1 of 8 permission granted');
      expect(html).not.toContain('/10');
      expect(html).not.toContain('of 10');

      // 4. Helper sanitization forces dormant keys to false while keeping 10-key compatibility
      const sanitized = sanitizeAdminPermissions({
        canEditDetails: true,
        canManageRefunds: true,
        canManagePayouts: true,
      });
      expect(sanitized.canEditDetails).toBe(true);
      expect(sanitized.canManageRefunds).toBe(false);
      expect(sanitized.canManagePayouts).toBe(false);
      expect(countActiveDelegablePermissions(sanitized)).toBe(1);
      expect(DELEGABLE_PERMISSION_COUNT).toBe(8);
    });

    it('renders accurate descriptions for canViewOrders, canCancelEvent, and canDeleteEvent (F3 & F8)', () => {
      const html = renderToString(
        <AdminPermissionsModal
          isOpen={true}
          onClose={() => {}}
          onSave={() => {}}
          title="Configure Admin Permissions"
        />
      );

      // canViewOrders must not claim ticket check-in log access
      expect(html).not.toContain('ticket check-in logs');
      expect(html).toContain('Access event order history, buyer contact details, and revenue summaries.');

      // canCancelEvent must not claim automatic attendee email notifications
      expect(html).not.toContain('automatic attendee notifications');
      expect(html).toContain('Cancel live or scheduled event occurrences and cancel their active waitlist entries.');

      // canDeleteEvent describes draft deletion and archived transition
      expect(html).toContain('Permanently delete draft events with no ticket sales and transition events to archived status.');
    });

    it('enforces caller-scoped delegation and restricts Safe Defaults to caller ceiling (F5)', () => {
      const delegatorPerms = {
        ...DEFAULT_ADMIN_PERMISSIONS,
        canEditDetails: true,
        canViewOrders: true,
        canManageTeam: true,
      };

      const html = renderToString(
        <AdminPermissionsModal
          isOpen={true}
          onClose={() => {}}
          onSave={() => {}}
          callerIsOwner={false}
          callerPermissions={delegatorPerms}
          title="Configure Admin Permissions"
        />
      );

      // Delegation notice banner rendered for non-owner Event Admin delegator
      expect(html).toContain('You can only grant permissions that you currently hold for this event.');
      expect(html).toContain('Outside Your Access');

      // Safe Defaults for this delegator intersects SAFE_ADMIN_PERMISSIONS with caller ceiling
      const safeForDelegator = computeSafeDefaultsForCaller(false, delegatorPerms);
      expect(safeForDelegator.canEditDetails).toBe(true);
      expect(safeForDelegator.canViewOrders).toBe(true);
      expect(safeForDelegator.canManageTickets).toBe(false);
      expect(safeForDelegator.canManagePromotions).toBe(false);
      expect(safeForDelegator.canViewAnalytics).toBe(false);
      expect(safeForDelegator.canManageTeam).toBe(false);
      expect(safeForDelegator.canCancelEvent).toBe(false);
      expect(safeForDelegator.canDeleteEvent).toBe(false);

      // Owner retains full SAFE_ADMIN_PERMISSIONS preset
      const safeForOwner = computeSafeDefaultsForCaller(true, null);
      expect(safeForOwner).toEqual(SAFE_ADMIN_PERMISSIONS);
    });

    it('displays /8 permission counts in EventTeamModal for admin members and preserves all 10 schema keys', () => {
      queryClient.setQueryData(['event-team', mockEvent.id], {
        members: [
          {
            id: 'mem-admin-count',
            userId: 'user-admin-count',
            name: 'Count Admin',
            email: 'count-admin@outside.vip',
            role: 'ADMIN' as const,
            status: 'ACTIVE' as const,
            permissions: {
              ...DEFAULT_ADMIN_PERMISSIONS,
              canEditDetails: true,
              canManageTickets: true,
              canManageRefunds: true as any,
            },
            createdAt: '2026-11-20T08:00:00Z',
          },
        ],
        invitations: [],
      });
      queryClient.setQueryData(['event-staff', mockEvent.id], {
        staff: [],
        invitations: [],
      });

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventTeamModal isOpen={true} onClose={() => {}} event={mockEvent} />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('2/8 perms');
      expect(html).not.toContain('/10 perms');

      // All 10 permissions remain in DEFAULT_ADMIN_PERMISSIONS & SAFE_ADMIN_PERMISSIONS for schema compatibility
      expect(Object.keys(DEFAULT_ADMIN_PERMISSIONS).length).toBe(10);
      expect(Object.values(DEFAULT_ADMIN_PERMISSIONS).every((val) => val === false)).toBe(true);
      expect(SAFE_ADMIN_PERMISSIONS.canManageRefunds).toBe(false);
      expect(SAFE_ADMIN_PERMISSIONS.canManagePayouts).toBe(false);
    });
  });

  // =========================================================================
  // 8. P2-01 Dashboard & Event Editor Permission Gating (F1 & F3)
  // =========================================================================
  describe('8. P2-01 OrganizerDashboardPage & CreateEventPage Permission Gating', () => {
    const adminUser: User = {
      id: 'event-admin-user-99',
      name: 'Event Admin',
      email: 'event-admin@outside.vip',
      role: 'ATTENDEE',
      emailVerified: true,
    };

    const mockStats = {
      totalEvents: 1,
      publishedEvents: 1,
      draftEvents: 0,
      ticketsSold: 10,
      grossRevenueInCents: 0,
      grossRevenueFormatted: '$0.00',
      currency: 'USD',
    };

    it('F1: ticket-only Event Admin sees ticket management link on dashboard and ticket-only mode in CreateEventPage without detail editing or publishing', () => {
      const ticketOnlyEvent: OrganizerEventItem = {
        ...mockEvent,
        isOwner: false,
        accessRole: 'ADMIN',
        permissions: {
          ...DEFAULT_ADMIN_PERMISSIONS,
          canManageTickets: true,
        },
      };

      const dashboardHtml = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <OrganizerDashboardPage
              initialUser={adminUser}
              initialIsLoading={false}
              initialEvents={[ticketOnlyEvent]}
              initialStats={mockStats}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(dashboardHtml).toContain('Manage Ticket Tiers');
      expect(dashboardHtml).toContain(`/organizer/events/${ticketOnlyEvent.id}/edit?step=tickets`);
      expect(dashboardHtml).not.toContain('Cancel Event Occurrence');
      expect(dashboardHtml).not.toContain('title="Unpublish event (hide from discovery)"');
      expect(dashboardHtml).not.toContain('title="Publish event to Outside.vip"');

      // CreateEventPage in ticket-only mode
      queryClient.setQueryData(['organizer-event', ticketOnlyEvent.id], {
        event: {
          ...ticketOnlyEvent,
          seriesId: 'series-123',
        },
      });

      const editorHtml = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[`/organizer/events/${ticketOnlyEvent.id}/edit`]}>
            <Routes>
              <Route
                path="/organizer/events/:id/edit"
                element={<CreateEventPage initialUser={adminUser} initialIsLoading={false} />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(editorHtml).toContain('Ticket Management Mode');
      expect(editorHtml).toContain('Save Tickets');
      expect(editorHtml).toContain('Save Ticket Changes');
      expect(editorHtml).not.toContain('Event Details &amp; Artwork');
      expect(editorHtml).not.toContain('Attendee Guidelines &amp; Door Policies');
      expect(editorHtml).not.toContain('Publish Live');
      expect(editorHtml).not.toContain('Finance &amp; Payout Settings');
      expect(editorHtml).not.toContain('Cancel Event Occurrence');
      expect(editorHtml).not.toContain('Cancel Entire Series');
    });

    it('F1: details-only Event Admin locks ticket tiers on Step 3 and hides finance/publish controls', () => {
      const detailsOnlyEvent: OrganizerEventItem = {
        ...mockEvent,
        status: 'DRAFT',
        isOwner: false,
        accessRole: 'ADMIN',
        permissions: {
          ...DEFAULT_ADMIN_PERMISSIONS,
          canEditDetails: true,
        },
      };

      queryClient.setQueryData(['organizer-event', detailsOnlyEvent.id], {
        event: detailsOnlyEvent,
      });

      const editorHtml = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[`/organizer/events/${detailsOnlyEvent.id}/edit?step=tickets`]}>
            <Routes>
              <Route
                path="/organizer/events/:id/edit"
                element={<CreateEventPage initialUser={adminUser} initialIsLoading={false} />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(editorHtml).toContain('Ticket Tiers Locked');
      expect(editorHtml).toContain('Attendee Guidelines &amp; Door Policies');
      expect(editorHtml).not.toContain('Publish Live');
      expect(editorHtml).not.toContain('Finance &amp; Payout Settings');
    });

    it('F3: cancel-only Event Admin can reach Cancel Event Occurrence on dashboard and editor, while Series Cancellation and Finance remain restricted', () => {
      const cancelOnlyEvent: OrganizerEventItem = {
        ...mockEvent,
        status: 'PUBLISHED',
        isOwner: false,
        accessRole: 'ADMIN',
        permissions: {
          ...DEFAULT_ADMIN_PERMISSIONS,
          canCancelEvent: true,
        },
      };

      const dashboardHtml = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <OrganizerDashboardPage
              initialUser={adminUser}
              initialIsLoading={false}
              initialEvents={[cancelOnlyEvent]}
              initialStats={mockStats}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(dashboardHtml).toContain('Cancel Event Occurrence');
      expect(dashboardHtml).not.toContain('Edit Event &amp; Ticket Tiers');
      expect(dashboardHtml).not.toContain('Manage Ticket Tiers');
      expect(dashboardHtml).not.toContain('title="Unpublish event (hide from discovery)"');
      expect(dashboardHtml).not.toContain('title="Publish event to Outside.vip"');

      // Direct navigation to /edit for a cancel-only admin on a recurring series event
      queryClient.setQueryData(['organizer-event', cancelOnlyEvent.id], {
        event: {
          ...cancelOnlyEvent,
          seriesId: 'series-999',
        },
      });

      const editorHtml = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[`/organizer/events/${cancelOnlyEvent.id}/edit`]}>
            <Routes>
              <Route
                path="/organizer/events/:id/edit"
                element={<CreateEventPage initialUser={adminUser} initialIsLoading={false} />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(editorHtml).toContain('Cancel Event Occurrence');
      expect(editorHtml).not.toContain('Cancel Entire Series');
      expect(editorHtml).not.toContain('Finance &amp; Payout Settings');
      expect(editorHtml).not.toContain('Save Draft');
      expect(editorHtml).not.toContain('Publish Live');
    });
  });

  // =========================================================================
  // 9. P2-01 EventPreviewPage Action Controls Gating
  // =========================================================================
  describe('9. P2-01 EventPreviewPage Action Controls Gating', () => {
    const ownerUser: User = {
      id: mockEvent.organizerId,
      name: 'Owner User',
      email: 'owner@outside.vip',
      role: 'ORGANIZER',
      emailVerified: true,
    };

    const platformAdminUser: User = {
      id: 'platform-admin-user-1',
      name: 'Platform Admin',
      email: 'platform-admin@outside.vip',
      role: 'ADMIN',
      emailVerified: true,
    };

    const eventAdminUser: User = {
      id: 'event-admin-preview-1',
      name: 'Preview Event Admin',
      email: 'preview-admin@outside.vip',
      role: 'ATTENDEE',
      emailVerified: true,
    };

    const renderPreview = (eventPayload: OrganizerEventItem, currentUser: User) => {
      queryClient.setQueryData(['organizer-event', eventPayload.id], {
        event: eventPayload,
      });

      return renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[`/organizer/events/${eventPayload.id}/preview`]}>
            <Routes>
              <Route
                path="/organizer/events/:id/preview"
                element={<EventPreviewPage initialUser={currentUser} />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      );
    };

    it('renders Edit Event and Publish/Unpublish controls for Event Owner and Platform ADMIN', () => {
      const draftOwnerEvent: OrganizerEventItem = {
        ...mockEvent,
        id: 'evt-preview-owner-draft',
        status: 'DRAFT',
        isOwner: true,
        permissions: null,
      };
      const ownerDraftHtml = renderPreview(draftOwnerEvent, ownerUser);
      expect(ownerDraftHtml).toContain('Edit Event');
      expect(ownerDraftHtml).toContain(`/organizer/events/${draftOwnerEvent.id}/edit`);
      expect(ownerDraftHtml).toContain('Publish Live Now');

      const publishedPlatformEvent: OrganizerEventItem = {
        ...mockEvent,
        id: 'evt-preview-platform-live',
        status: 'PUBLISHED',
        isOwner: false,
        permissions: null,
      };
      const platformHtml = renderPreview(publishedPlatformEvent, platformAdminUser);
      expect(platformHtml).toContain('Edit Event');
      expect(platformHtml).toContain('Unpublish');
      expect(platformHtml).toContain('Public Page');
    });

    it('shows Edit Event Details and hides Publish/Unpublish for details-only Event Admin', () => {
      const detailsOnlyDraft: OrganizerEventItem = {
        ...mockEvent,
        id: 'evt-preview-details-only',
        status: 'DRAFT',
        isOwner: false,
        accessRole: 'ADMIN',
        permissions: {
          ...DEFAULT_ADMIN_PERMISSIONS,
          canEditDetails: true,
        },
      };

      const html = renderPreview(detailsOnlyDraft, eventAdminUser);
      expect(html).toContain('Sol Fest Africa 2026');
      expect(html).toContain('Dashboard');
      expect(html).toContain('Edit Event Details');
      expect(html).toContain(`/organizer/events/${detailsOnlyDraft.id}/edit`);
      expect(html).not.toContain('Add Ticket Tiers in Editor');
      expect(html).not.toContain('?step=tickets');
      expect(html).not.toContain('Publish Live Now');
      expect(html).not.toContain('Unpublish');
    });

    it('shows Manage Ticket Tiers (?step=tickets) and hides Publish/Unpublish for ticket-only Event Admin', () => {
      const ticketOnlyLive: OrganizerEventItem = {
        ...mockEvent,
        id: 'evt-preview-ticket-only',
        status: 'PUBLISHED',
        isOwner: false,
        accessRole: 'ADMIN',
        permissions: {
          ...DEFAULT_ADMIN_PERMISSIONS,
          canManageTickets: true,
        },
      };

      const html = renderPreview(ticketOnlyLive, eventAdminUser);
      expect(html).toContain('Sol Fest Africa 2026');
      expect(html).toContain('Manage Ticket Tiers');
      expect(html).toContain('Add Ticket Tiers in Editor');
      expect(html).toContain(`/organizer/events/${ticketOnlyLive.id}/edit?step=tickets`);
      expect(html).toContain('Public Page');
      expect(html).not.toContain('Publish Live Now');
      expect(html).not.toContain('Unpublish');
    });

    it('hides Edit and Publish/Unpublish controls while preserving preview access for read-only Event Admin', () => {
      const readOnlyLive: OrganizerEventItem = {
        ...mockEvent,
        id: 'evt-preview-readonly',
        status: 'PUBLISHED',
        isOwner: false,
        accessRole: 'ADMIN',
        permissions: {
          ...DEFAULT_ADMIN_PERMISSIONS,
          canViewOrders: true,
        },
      };

      const html = renderPreview(readOnlyLive, eventAdminUser);
      expect(html).toContain('Sol Fest Africa 2026');
      expect(html).toContain('Live Published Event');
      expect(html).toContain('Dashboard');
      expect(html).toContain('Public Page');
      expect(html).not.toContain(`/organizer/events/${readOnlyLive.id}/edit`);
      expect(html).not.toContain('Add Ticket Tiers in Editor');
      expect(html).not.toContain('Edit Event');
      expect(html).not.toContain('Manage Ticket Tiers');
      expect(html).not.toContain('Publish Live Now');
      expect(html).not.toContain('Unpublish');
    });
  });
});

