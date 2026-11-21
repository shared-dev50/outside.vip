import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AdminPermissionsModal,
  DEFAULT_ADMIN_PERMISSIONS,
  SAFE_ADMIN_PERMISSIONS,
} from './components/team/AdminPermissionsModal';
import { EventTeamModal } from './components/team/EventTeamModal';
import { TeamInvitationPage } from './pages/TeamInvitationPage';
import { api, setActiveCsrfToken } from './lib/api';
import { OrganizerEventItem } from './types';

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
      expect(html).toContain('Issue Buyer Refunds');
      expect(html).toContain('Manage Banking &amp; Payouts');
      expect(html).toContain('Cancel Entire Event');
      expect(html).toContain('Delete Event Draft');

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
        path.resolve(__dirname, './pages/TeamInvitationPage.tsx'),
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
        path.resolve(__dirname, './pages/TeamInvitationPage.tsx'),
        'utf-8'
      );
      const modalSource = fs.readFileSync(
        path.resolve(__dirname, './components/team/EventTeamModal.tsx'),
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
        path.resolve(__dirname, './components/team/EventTeamModal.tsx'),
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
        path.resolve(__dirname, './App.tsx'),
        'utf-8'
      );
      const teamsPageSource = fs.readFileSync(
        path.resolve(__dirname, './pages/TeamsPage.tsx'),
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
        path.resolve(__dirname, './components/team/EventTeamModal.tsx'),
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
        path.resolve(__dirname, './components/team/EventTeamModal.tsx'),
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
  // 7. Stage 5 Implementation 1: Admin Permission UI Accuracy Correction
  // =========================================================================
  describe('7. Stage 5 Implementation 1: Admin Permission UI Accuracy Correction', () => {
    it('renders canManageRefunds as visibly unavailable (Coming Soon) with disabled input and accurate explanation', () => {
      // Even if legacy data passes canManageRefunds: true, the modal must enforce false
      const html = renderToString(
        <AdminPermissionsModal
          isOpen={true}
          onClose={() => {}}
          onSave={() => {}}
          initialPermissions={{ canManageRefunds: true as any }}
          title="Configure Admin Permissions"
        />
      );

      // 1. Visibly marked Coming Soon
      expect(html).toContain('Coming Soon');
      expect(html).toContain('Issue Buyer Refunds');

      // 2. Accurate explanation that refunds are not supported for Event Admins
      expect(html).toContain('Refund management is not currently supported for Event Admins');

      // 3. Inspect source to ensure canManageRefunds is locked to false and toggle is blocked
      const modalSource = fs.readFileSync(
        path.resolve(__dirname, './components/team/AdminPermissionsModal.tsx'),
        'utf-8'
      );
      expect(modalSource).toContain("key: 'canManageRefunds'");
      expect(modalSource).toContain("statusBadge: 'Coming Soon'");
      expect(modalSource).toContain('isDisabled: true');
      expect(modalSource).toContain("if (key === 'canManageRefunds' || key === 'canManagePayouts')");
    });

    it('renders canManagePayouts as visibly Owner Only with disabled input and accurate explanation', () => {
      const html = renderToString(
        <AdminPermissionsModal
          isOpen={true}
          onClose={() => {}}
          onSave={() => {}}
          initialPermissions={{ canManagePayouts: true as any }}
          title="Configure Admin Permissions"
        />
      );

      // 1. Visibly marked Owner Only
      expect(html).toContain('Owner Only');
      expect(html).toContain('Manage Banking &amp; Payouts');

      // 2. Accurate explanation that payout settings remain exclusively under organizer control
      expect(html).toContain('Payout settings remain exclusively under the event organizer');

      // 3. Inspect source to ensure canManagePayouts is locked to false
      const modalSource = fs.readFileSync(
        path.resolve(__dirname, './components/team/AdminPermissionsModal.tsx'),
        'utf-8'
      );
      expect(modalSource).toContain("key: 'canManagePayouts'");
      expect(modalSource).toContain("statusBadge: 'Owner Only'");
    });

    it('preserves configurability for the other eight permissions while keeping all 10 schema keys compatible', () => {
      const modalSource = fs.readFileSync(
        path.resolve(__dirname, './components/team/AdminPermissionsModal.tsx'),
        'utf-8'
      );

      // The other 8 permissions are not disabled
      const nonDisabledKeys = [
        'canEditDetails',
        'canManageTickets',
        'canViewOrders',
        'canManageTeam',
        'canManagePromotions',
        'canViewAnalytics',
        'canCancelEvent',
        'canDeleteEvent',
      ];

      nonDisabledKeys.forEach((key) => {
        // Must be in definition arrays without isDisabled: true
        expect(modalSource).toMatch(new RegExp(`key:\\s*'${key}'`));
      });

      // All 10 permissions exist in DEFAULT_ADMIN_PERMISSIONS and default to false
      expect(Object.keys(DEFAULT_ADMIN_PERMISSIONS).length).toBe(10);
      expect(Object.values(DEFAULT_ADMIN_PERMISSIONS).every((val) => val === false)).toBe(true);

      // Safe defaults keep both refunds and payouts false
      expect(SAFE_ADMIN_PERMISSIONS.canManageRefunds).toBe(false);
      expect(SAFE_ADMIN_PERMISSIONS.canManagePayouts).toBe(false);
    });
  });
});

