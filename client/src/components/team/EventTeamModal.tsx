import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOptionalAuth } from '../../context/AuthContext';
import {
  Users,
  UserPlus,
  Shield,
  ShieldAlert,
  Megaphone,
  ScanLine,
  Mail,
  RotateCw,
  Trash2,
  Copy,
  Check,
  AlertCircle,
  X,
  Clock,
  CheckCircle2,
  Power,
  Settings2,
  ArrowRightLeft,
  Filter,
  Share2,
} from 'lucide-react';
import { SocialShareModal } from '../promotions/SocialShareModal';
import {
  api,
  EventStaffMember,
  EventStaffInvitationItem,
} from '../../lib/api';
import {
  OrganizerEventItem,
  EventTeamMemberItem,
  EventAdminPermissions,
  EventTeamRole,
} from '../../types';
import {
  AdminPermissionsModal,
  DEFAULT_ADMIN_PERMISSIONS,
  DELEGABLE_PERMISSION_COUNT,
  countActiveDelegablePermissions,
} from './AdminPermissionsModal';

export type UnifiedTeamRole = 'STAFF' | 'HOST' | 'ADMIN';
export type RoleFilter = 'ALL' | 'STAFF' | 'HOST' | 'ADMIN';

export interface EventTeamModalProps {
  isOpen?: boolean;
  onClose?: () => void;
  event: OrganizerEventItem | null;
  isInline?: boolean;
}

export const EventTeamModal: React.FC<EventTeamModalProps> = ({
  isOpen = true,
  onClose,
  event,
  isInline = false,
}) => {
  if ((!isOpen && !isInline) || !event) return null;

  const queryClient = useQueryClient();
  const auth = useOptionalAuth();
  const clearSessionState = auth?.clearSessionState;
  const currentUser = auth?.user;
  const isPlatformAdmin = currentUser?.role === 'ADMIN';
  const callerIsOwner =
    event.isOwner !== undefined
      ? event.isOwner
      : currentUser
      ? event.organizerId === currentUser.id
      : event.permissions === undefined;
  const callerPermissions: Partial<EventAdminPermissions> | null = callerIsOwner
    ? null
    : event.permissions
    ? event.permissions
    : isPlatformAdmin
    ? {
        ...DEFAULT_ADMIN_PERMISSIONS,
        canEditDetails: true,
        canViewOrders: true,
        canManagePromotions: true,
        canViewAnalytics: true,
      }
    : DEFAULT_ADMIN_PERMISSIONS;

  const handleAuthError = (err: any): boolean => {
    const status = err?.statusCode || err?.status;
    if (status === 401) {
      clearSessionState?.();
      return true;
    }
    return false;
  };

  // Navigation tab
  const [activeTab, setActiveTab] = useState<'MEMBERS' | 'INVITATIONS' | 'INVITE'>('MEMBERS');

  // Role category filter
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('ALL');

  // Notification state
  const [notification, setNotification] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  };

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<UnifiedTeamRole>('STAFF');
  const [invitePermissions, setInvitePermissions] = useState<EventAdminPermissions>({
    ...DEFAULT_ADMIN_PERMISSIONS,
  });
  const [isInvitePermsModalOpen, setIsInvitePermsModalOpen] = useState(false);

  // Active member permissions editor modal
  const [editingMember, setEditingMember] = useState<EventTeamMemberItem | null>(null);

  // Confirmation dialogs
  const [memberToRevoke, setMemberToRevoke] = useState<EventTeamMemberItem | null>(null);
  const [staffToRevoke, setStaffToRevoke] = useState<EventStaffMember | null>(null);
  const [staffInviteToRevoke, setStaffInviteToRevoke] = useState<EventStaffInvitationItem | null>(null);
  const [roleChangeTarget, setRoleChangeTarget] = useState<{
    member: EventTeamMemberItem;
    targetRole: EventTeamRole;
  } | null>(null);

  // Clipboard copy feedback
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  // Social Share Modal state
  const [sharingLink, setSharingLink] = useState<{ id: string; slug: string; name?: string } | null>(null);

  // 1. Fetch Event Team Members & Invitations (Hosts & Admins)
  const {
    data: teamData,
    isLoading: isLoadingTeam,
    isFetching: isFetchingTeam,
    refetch: refetchTeam,
    error: teamError,
  } = useQuery({
    queryKey: ['event-team', event.id],
    queryFn: () => api.team.getTeam(event.id),
    enabled: Boolean(event.id),
  });

  // 2. Fetch Door Scanner Staff & Invitations
  const {
    data: staffData,
    isLoading: isLoadingStaff,
    isFetching: isFetchingStaff,
    refetch: refetchStaff,
    error: staffError,
  } = useQuery({
    queryKey: ['event-staff', event.id],
    queryFn: async () => {
      try {
        const res = await api.staff.getTeam(event.id);
        return {
          staff: res.staff || [],
          invitations: res.invitations || [],
          isRestricted: false,
        };
      } catch (err: any) {
        // If caller is an Event Admin without staff access, handle gracefully with restricted flag
        if (
          err?.statusCode === 403 ||
          err?.status === 403 ||
          err?.message?.toLowerCase().includes('permission') ||
          err?.message?.toLowerCase().includes('forbidden')
        ) {
          return {
            staff: [] as EventStaffMember[],
            invitations: [] as EventStaffInvitationItem[],
            isRestricted: true,
          };
        }
        throw err;
      }
    },
    enabled: Boolean(event.id),
    retry: false,
  });

  const isStaffRestricted = Boolean((staffData as any)?.isRestricted);

  const teamErrorStatus = (teamError as any)?.statusCode || (teamError as any)?.status;
  const staffErrorStatus = (staffError as any)?.statusCode || (staffError as any)?.status;

  useEffect(() => {
    if (teamErrorStatus === 401 || staffErrorStatus === 401) {
      clearSessionState?.();
    }
  }, [teamErrorStatus, staffErrorStatus, clearSessionState]);

  const isLoading = !teamData && !staffData && (isLoadingTeam || isLoadingStaff);
  const isFetching = isFetchingTeam || isFetchingStaff;

  const refetchAll = () => {
    refetchTeam();
    refetchStaff();
  };

  const teamMembers = teamData?.members || [];
  const teamInvitations = teamData?.invitations || [];

  const staffMembers = (staffData?.staff || []) as EventStaffMember[];
  const staffInvitations = (staffData?.invitations || []) as EventStaffInvitationItem[];

  // Mutations for Host / Admin (api.team)
  const teamInviteMutation = useMutation({
    mutationFn: (data: {
      email: string;
      role: EventTeamRole;
      permissions?: Partial<EventAdminPermissions> | null;
    }) => api.team.invite(event.id, data),
    onSuccess: (invitation) => {
      queryClient.invalidateQueries({ queryKey: ['event-team', event.id] });
      setInviteEmail('');
      setInviteRole('HOST');
      setInvitePermissions({ ...DEFAULT_ADMIN_PERMISSIONS });
      setActiveTab('INVITATIONS');
      showNotification('success', `Invitation successfully dispatched to ${invitation.email}`);
    },
    onError: (err: any) => {
      if (handleAuthError(err)) return;
      showNotification('error', err?.message || 'Failed to dispatch team invitation');
    },
  });

  const teamResendInvitationMutation = useMutation({
    mutationFn: (invitationId: string) => api.team.resendInvitation(event.id, invitationId),
    onSuccess: (invitation) => {
      queryClient.invalidateQueries({ queryKey: ['event-team', event.id] });
      showNotification('success', `Invitation resent to ${invitation.email}`);
    },
    onError: (err: any) => {
      if (handleAuthError(err)) return;
      showNotification('error', err?.message || 'Failed to resend invitation');
    },
  });

  const teamRevokeInvitationMutation = useMutation({
    mutationFn: (invitationId: string) => api.team.revokeInvitation(event.id, invitationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-team', event.id] });
      showNotification('success', 'Invitation revoked successfully');
    },
    onError: (err: any) => {
      if (handleAuthError(err)) return;
      showNotification('error', err?.message || 'Failed to revoke invitation');
    },
  });

  const updateMemberMutation = useMutation({
    mutationFn: (params: {
      memberId: string;
      updates: {
        role?: EventTeamRole;
        status?: 'ACTIVE' | 'INACTIVE';
        permissions?: Partial<EventAdminPermissions> | null;
      };
    }) => api.team.updateMember(event.id, params.memberId, params.updates),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['event-team', event.id] });
      queryClient.invalidateQueries({ queryKey: ['event-promotion-links', event.id] });
      queryClient.invalidateQueries({ queryKey: ['event-promotion-analytics', event.id] });
      setEditingMember(null);
      setRoleChangeTarget(null);
      showNotification('success', `Team member ${updated.name || updated.email} updated`);
    },
    onError: (err: any) => {
      if (handleAuthError(err)) return;
      showNotification('error', err?.message || 'Failed to update team member');
    },
  });

  const revokeMemberMutation = useMutation({
    mutationFn: (memberId: string) => api.team.revokeMember(event.id, memberId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-team', event.id] });
      queryClient.invalidateQueries({ queryKey: ['event-promotion-links', event.id] });
      queryClient.invalidateQueries({ queryKey: ['event-promotion-analytics', event.id] });
      setMemberToRevoke(null);
      showNotification('success', 'Team member access revoked and personal links archived');
    },
    onError: (err: any) => {
      if (handleAuthError(err)) return;
      showNotification('error', err?.message || 'Failed to revoke team member access');
    },
  });

  // Mutations for Door Scanner Staff (api.staff)
  const staffInviteMutation = useMutation({
    mutationFn: (email: string) => api.staff.invite(event.id, email),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['event-staff', event.id] });
      setInviteEmail('');
      setInviteRole('STAFF');
      setActiveTab('INVITATIONS');
      showNotification(
        'success',
        `Door scanner invitation successfully dispatched to ${res.invitation.email}`
      );
    },
    onError: (err: any) => {
      if (handleAuthError(err)) return;
      showNotification('error', err?.message || 'Failed to dispatch staff invitation');
    },
  });

  const staffResendInvitationMutation = useMutation({
    mutationFn: (invitationId: string) => api.staff.resendInvitation(event.id, invitationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-staff', event.id] });
      showNotification('success', 'Staff invitation email resent successfully');
    },
    onError: (err: any) => {
      if (handleAuthError(err)) return;
      showNotification('error', err?.message || 'Failed to resend staff invitation');
    },
  });

  const staffRevokeInvitationMutation = useMutation({
    mutationFn: (invitationId: string) => api.staff.revokeInvitation(event.id, invitationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-staff', event.id] });
      setStaffInviteToRevoke(null);
      showNotification('success', 'Staff invitation revoked');
    },
    onError: (err: any) => {
      if (handleAuthError(err)) return;
      showNotification('error', err?.message || 'Failed to revoke staff invitation');
    },
  });

  const staffRevokeMemberMutation = useMutation({
    mutationFn: (userId: string) => api.staff.revokeMember(event.id, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-staff', event.id] });
      setStaffToRevoke(null);
      showNotification('success', 'Staff scanning access revoked');
    },
    onError: (err: any) => {
      if (handleAuthError(err)) return;
      showNotification('error', err?.message || 'Failed to revoke staff scanning access');
    },
  });

  const handleCopyLink = (slug: string) => {
    const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
    const url = origin ? `${origin}/r/${slug}` : `/r/${slug}`;
    navigator.clipboard.writeText(url);
    setCopiedSlug(slug);
    setTimeout(() => setCopiedSlug(null), 2000);
  };

  const handleInviteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email) {
      showNotification('error', 'Please enter a valid email address');
      return;
    }

    if (inviteRole === 'STAFF') {
      if (isStaffRestricted) {
        showNotification(
          'error',
          'Door scanner invitations are restricted to the event organizer (owner)'
        );
        return;
      }
      staffInviteMutation.mutate(email);
    } else {
      teamInviteMutation.mutate({
        email,
        role: inviteRole,
        permissions: inviteRole === 'ADMIN' ? invitePermissions : null,
      });
    }
  };

  // Counts calculation
  const activeStaffCount = staffMembers.filter((s) => s.status === 'ACTIVE').length;
  const activeHostsCount = teamMembers.filter((m) => m.role === 'HOST' && m.status === 'ACTIVE').length;
  const activeAdminsCount = teamMembers.filter((m) => m.role === 'ADMIN' && m.status === 'ACTIVE').length;
  const totalActiveCount = activeStaffCount + activeHostsCount + activeAdminsCount;

  const pendingStaffCount = staffInvitations.filter((i) => i.status === 'PENDING').length;
  const pendingHostsCount = teamInvitations.filter((i) => i.role === 'HOST' && i.status === 'PENDING').length;
  const pendingAdminsCount = teamInvitations.filter((i) => i.role === 'ADMIN' && i.status === 'PENDING').length;
  const totalPendingCount = pendingStaffCount + pendingHostsCount + pendingAdminsCount;

  // Filtered members list
  const filteredTeamMembers = teamMembers.filter((m) => {
    if (roleFilter === 'ALL') return true;
    if (roleFilter === 'HOST') return m.role === 'HOST';
    if (roleFilter === 'ADMIN') return m.role === 'ADMIN';
    return false;
  });

  const filteredStaffMembers = staffMembers.filter(() => {
    if (roleFilter === 'ALL' || roleFilter === 'STAFF') return true;
    return false;
  });

  const hasAnyActiveMembers = filteredTeamMembers.length > 0 || filteredStaffMembers.length > 0;

  // Filtered invitations list
  const filteredTeamInvitations = teamInvitations.filter((i) => {
    if (roleFilter === 'ALL') return true;
    if (roleFilter === 'HOST') return i.role === 'HOST';
    if (roleFilter === 'ADMIN') return i.role === 'ADMIN';
    return false;
  });

  const filteredStaffInvitations = staffInvitations.filter(() => {
    if (roleFilter === 'ALL' || roleFilter === 'STAFF') return true;
    return false;
  });

  const hasAnyPendingInvitations =
    filteredTeamInvitations.length > 0 || filteredStaffInvitations.length > 0;

  const isInviteSubmitting = teamInviteMutation.isPending || staffInviteMutation.isPending;

  // Render content
  const modalContent = (
    <div
      className={`w-full ${
        isInline
          ? 'bg-white rounded-2xl border border-stone-200 shadow-xs'
          : 'max-w-4xl max-h-[90vh] bg-white rounded-2xl border border-stone-200 shadow-2xl animate-in fade-in zoom-in-95 duration-200'
      } flex flex-col overflow-hidden`}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Workspace Header */}
      <div className="flex items-center justify-between px-6 py-4.5 border-b border-stone-100 bg-[#FAF8F5]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-stone-900 text-white flex items-center justify-center shadow-2xs">
            <Users className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-display font-bold text-base text-stone-900">
                Event Team &amp; Hosts
              </h3>
              <span className="text-xs text-stone-400">·</span>
              <span className="text-xs text-stone-600 font-sans truncate max-w-[280px]">
                {event.title}
              </span>
            </div>
            <p className="text-[11px] text-stone-500 font-mono">
              Event administrators, promotional hosts, and door scanner staff
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refetchAll}
            disabled={isFetching}
            className="p-2 rounded-lg text-stone-500 hover:text-stone-900 hover:bg-stone-100 transition-colors cursor-pointer"
            title="Refresh Team List"
          >
            <RotateCw className={`w-4 h-4 ${isFetching ? 'animate-spin text-stone-900' : ''}`} />
          </button>
          {!isInline && onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Notification Banner */}
      {notification && (
        <div
          className={`px-6 py-2.5 text-xs font-mono flex items-center justify-between border-b ${
            notification.type === 'success'
              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
              : 'bg-rose-50 text-rose-800 border-rose-200'
          }`}
        >
          <div className="flex items-center gap-2">
            {notification.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            ) : (
              <AlertCircle className="w-4 h-4 text-rose-600" />
            )}
            <span>{notification.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setNotification(null)}
            className="text-stone-500 hover:text-stone-800"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Primary Tab Navigation */}
      <div className="px-6 pt-3 border-b border-stone-200 bg-white flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('MEMBERS')}
            className={`px-3 py-2 text-xs font-mono font-bold uppercase tracking-wider border-b-2 transition-colors cursor-pointer ${
              activeTab === 'MEMBERS'
                ? 'border-stone-900 text-stone-900'
                : 'border-transparent text-stone-500 hover:text-stone-800'
            }`}
          >
            Active Team ({totalActiveCount})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('INVITATIONS')}
            className={`px-3 py-2 text-xs font-mono font-bold uppercase tracking-wider border-b-2 transition-colors cursor-pointer ${
              activeTab === 'INVITATIONS'
                ? 'border-stone-900 text-stone-900'
                : 'border-transparent text-stone-500 hover:text-stone-800'
            }`}
          >
            Pending Invites ({totalPendingCount})
          </button>
        </div>

        <button
          type="button"
          onClick={() => setActiveTab('INVITE')}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-2xs mb-2 cursor-pointer ${
            activeTab === 'INVITE'
              ? 'bg-stone-900 text-white'
              : 'bg-stone-100 hover:bg-stone-200 text-stone-800 border border-stone-200'
          }`}
        >
          <UserPlus className="w-3.5 h-3.5" />
          Invite Member
        </button>
      </div>

      {/* Tab Body */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="py-16 text-center text-stone-500 font-mono text-xs flex items-center justify-center gap-2">
            <RotateCw className="w-4 h-4 animate-spin text-stone-700" />
            <span>Loading team members and staff...</span>
          </div>
        ) : teamError ? (
          <div className="py-12 text-center text-rose-600 font-mono text-xs">
            Failed to load event team. Please try again.
          </div>
        ) : activeTab === 'INVITE' ? (
          /* ================================================================= */
          /* 1. UNIFIED INVITATION ENTRY POINT                                  */
          /* ================================================================= */
          <form onSubmit={handleInviteSubmit} className="max-w-2xl mx-auto space-y-6 py-2">
            <div className="space-y-1">
              <h4 className="font-display font-bold text-lg text-stone-900">
                Invite New Team Member
              </h4>
              <p className="text-xs text-stone-500">
                Select a team role to invite administrators, promotional hosts, or door scanner staff to this event.
              </p>
            </div>

            {/* Email Input */}
            <div className="space-y-1.5">
              <label className="text-[11px] font-mono text-stone-600 uppercase font-semibold block">
                Member Email Address
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@example.com"
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-stone-200 text-xs font-sans text-stone-900 placeholder:text-stone-400 focus:outline-none focus:border-stone-900 shadow-2xs"
                />
              </div>
            </div>

            {/* Role Selection Dropdown */}
            <div className="space-y-1.5">
              <label htmlFor="invite-role-select" className="text-[11px] font-mono text-stone-600 uppercase font-semibold block">
                Team Role
              </label>
              <select
                id="invite-role-select"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as UnifiedTeamRole)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-stone-200 text-xs font-sans text-stone-900 bg-white focus:outline-none focus:border-stone-900 shadow-2xs cursor-pointer"
              >
                <option value="STAFF">Door Scanner</option>
                <option value="ADMIN">Event Admin</option>
                <option value="HOST">Event Host</option>
              </select>
            </div>

            {/* Dynamic Role Adaptation */}
            {inviteRole === 'STAFF' && (
              <div className="p-4 rounded-xl bg-blue-50/60 border border-blue-200 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-800 flex items-center justify-center shrink-0 mt-0.5">
                    <ScanLine className="w-4 h-4" />
                  </div>
                  <div className="space-y-1">
                    <h5 className="font-display font-bold text-xs text-stone-900">
                      Door Scanner Access
                    </h5>
                    <p className="text-[11px] text-stone-600 leading-relaxed font-sans">
                      Gate ticket verification and attendee check-in. The invitee receives a 6-digit email OTP to instantly access the door scanner portal. No Outside.vip account or password required. Zero access to event settings, attendee personal information, ticket revenue, or dashboard analytics.
                    </p>
                  </div>
                </div>

                {isStaffRestricted && (
                  <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-xs font-mono flex items-start gap-2">
                    <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-bold">Restricted to Event Owner</div>
                      <p className="text-[11px] text-amber-800 mt-0.5 leading-relaxed font-sans">
                        Door scanner staff invitations can only be dispatched by the event organizer (owner) or platform administrators. As an Event Admin, you cannot invite scanner staff.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {inviteRole === 'ADMIN' && (
              <div className="space-y-3">
                <div className="p-4 rounded-xl bg-purple-50/60 border border-purple-200 flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-stone-900 text-white flex items-center justify-center shrink-0 mt-0.5">
                    <Shield className="w-4 h-4 text-amber-400" />
                  </div>
                  <div className="space-y-1">
                    <h5 className="font-display font-bold text-xs text-stone-900">
                      Event Administrator Access
                    </h5>
                    <p className="text-[11px] text-stone-600 leading-relaxed font-sans">
                      Co-organizer with granular operational permissions. Invitee must accept using a verified Outside.vip user account. All permissions follow a strict deny-by-default model. Only explicitly checked capabilities are granted.
                    </p>
                  </div>
                </div>

                {/* Admin Permissions Config Button */}
                <div className="p-4 rounded-xl bg-stone-50 border border-stone-200 flex items-center justify-between">
                  <div>
                    <span className="text-xs font-semibold text-stone-900 block">
                      Admin Permissions
                    </span>
                    <span className="text-[11px] font-mono text-stone-500 mt-0.5 block">
                      {`${countActiveDelegablePermissions(invitePermissions)} of ${DELEGABLE_PERMISSION_COUNT} granted (deny-by-default)`}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsInvitePermsModalOpen(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-stone-100 text-stone-700 border border-stone-300 text-xs font-mono font-medium shadow-2xs transition-colors cursor-pointer"
                  >
                    <Settings2 className="w-3.5 h-3.5" />
                    Configure Permissions
                  </button>
                </div>
              </div>
            )}

            {inviteRole === 'HOST' && (
              <div className="p-4 rounded-xl bg-amber-50/60 border border-amber-200 flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-800 flex items-center justify-center shrink-0 mt-0.5">
                  <Megaphone className="w-4 h-4" />
                </div>
                <div className="space-y-1">
                  <h5 className="font-display font-bold text-xs text-stone-900">
                    Event Host Access
                  </h5>
                  <p className="text-[11px] text-stone-600 leading-relaxed font-sans">
                    Promoter partner. Automatically receives a personal promotional link (/r/:slug) upon acceptance. Grants private access to the Host Workspace to track real-time link clicks and visitor-days. Strictly isolated from organizer financial data, ticket orders, and admin controls. Invitee must accept using a verified Outside.vip user account.
                  </p>
                </div>
              </div>
            )}

            {/* Submit Actions */}
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setActiveTab('MEMBERS')}
                className="px-4 py-2 rounded-xl border border-stone-200 text-xs font-mono text-stone-600 hover:text-stone-900 hover:bg-stone-50 transition-colors shadow-2xs cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isInviteSubmitting || (inviteRole === 'STAFF' && isStaffRestricted)}
                className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-xs disabled:opacity-50 cursor-pointer"
              >
                <Mail className="w-3.5 h-3.5" />
                {isInviteSubmitting
                  ? 'Sending Invite...'
                  : inviteRole === 'STAFF' && isStaffRestricted
                  ? 'Restricted to Event Owner'
                  : inviteRole === 'STAFF'
                  ? 'Send Door Scanner Invite'
                  : inviteRole === 'ADMIN'
                  ? 'Send Event Admin Invite'
                  : 'Send Event Host Invite'}
              </button>
            </div>
          </form>
        ) : activeTab === 'INVITATIONS' ? (
          /* ================================================================= */
          /* 2. UNIFIED PENDING INVITATIONS VIEW                               */
          /* ================================================================= */
          <div className="space-y-4">
            {/* Category Filter Bar */}
            <div className="flex items-center gap-1.5 pb-2 border-b border-stone-100 overflow-x-auto">
              <span className="text-[11px] font-mono text-stone-400 uppercase mr-1 flex items-center gap-1">
                <Filter className="w-3 h-3" /> Category:
              </span>
              <button
                type="button"
                onClick={() => setRoleFilter('ALL')}
                className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-colors cursor-pointer ${
                  roleFilter === 'ALL'
                    ? 'bg-stone-900 text-white font-bold'
                    : 'bg-stone-100 hover:bg-stone-200 text-stone-600'
                }`}
              >
                All Invites ({totalPendingCount})
              </button>
              <button
                type="button"
                onClick={() => setRoleFilter('STAFF')}
                className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-colors cursor-pointer ${
                  roleFilter === 'STAFF'
                    ? 'bg-blue-700 text-white font-bold'
                    : 'bg-stone-100 hover:bg-stone-200 text-stone-600'
                }`}
              >
                Door Scanners ({isStaffRestricted ? 'Restricted' : pendingStaffCount})
              </button>
              <button
                type="button"
                onClick={() => setRoleFilter('HOST')}
                className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-colors cursor-pointer ${
                  roleFilter === 'HOST'
                    ? 'bg-amber-700 text-white font-bold'
                    : 'bg-stone-100 hover:bg-stone-200 text-stone-600'
                }`}
              >
                Event Hosts ({pendingHostsCount})
              </button>
              <button
                type="button"
                onClick={() => setRoleFilter('ADMIN')}
                className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-colors cursor-pointer ${
                  roleFilter === 'ADMIN'
                    ? 'bg-purple-700 text-white font-bold'
                    : 'bg-stone-100 hover:bg-stone-200 text-stone-600'
                }`}
              >
                Event Admins ({pendingAdminsCount})
              </button>
            </div>

            {roleFilter === 'ALL' && isStaffRestricted && (
              <div className="flex items-center gap-2.5 p-3 rounded-xl bg-amber-50/70 border border-amber-200 text-amber-900 text-xs font-mono">
                <ShieldAlert className="w-4 h-4 text-amber-700 shrink-0" />
                <span>
                  <strong>Notice:</strong> Door scanner staff invitations are restricted to the event organizer (owner) and are not shown.
                </span>
              </div>
            )}

            {roleFilter === 'STAFF' && isStaffRestricted ? (
              <div className="py-16 text-center space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto border border-amber-200">
                  <ShieldAlert className="w-6 h-6" />
                </div>
                <h4 className="font-display font-bold text-stone-900 text-sm">
                  Door Scanner Invitations Restricted
                </h4>
                <p className="text-xs text-stone-600 max-w-md mx-auto leading-relaxed">
                  Door scanner staff invitations are restricted to the event organizer (owner) and platform administrators. You do not have permission to view or manage scanner invitations for this event.
                </p>
              </div>
            ) : !hasAnyPendingInvitations ? (
              <div className="py-16 text-center space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-stone-100 text-stone-400 flex items-center justify-center mx-auto">
                  <Mail className="w-6 h-6" />
                </div>
                <h4 className="font-display font-bold text-stone-800 text-sm">
                  No Pending {roleFilter !== 'ALL' ? roleFilter : ''} Invitations
                </h4>
                <p className="text-xs text-stone-500 max-w-sm mx-auto">
                  All invited members in this category have accepted or expired. Click &quot;Invite Member&quot; to add scanner staff, hosts, or admins.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-stone-200 text-[11px] font-mono uppercase text-stone-500">
                      <th className="py-2.5 px-3">Invitee Email</th>
                      <th className="py-2.5 px-3">Role</th>
                      <th className="py-2.5 px-3">Workflow / Auth</th>
                      <th className="py-2.5 px-3">Expires At</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100 font-sans">
                    {/* 1. Door Scanner Invitations */}
                    {filteredStaffInvitations.map((inv) => (
                      <tr key={`staff-inv-${inv.id}`} className="hover:bg-stone-50/50 transition-colors">
                        <td className="py-3 px-3 font-medium text-stone-900">
                          {inv.email}
                        </td>
                        <td className="py-3 px-3">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-blue-50 text-blue-700 border border-blue-200">
                            <ScanLine className="w-3 h-3" />
                            Scanner Staff
                          </span>
                        </td>
                        <td className="py-3 px-3 text-[11px] font-mono text-stone-500">
                          Email OTP Link
                        </td>
                        <td className="py-3 px-3 font-mono text-[11px] text-stone-500">
                          {new Date(inv.expiresAt).toLocaleDateString()}
                        </td>
                        <td className="py-3 px-3">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-amber-50 text-amber-700 border border-amber-200">
                            <Clock className="w-3 h-3" />
                            Pending
                          </span>
                        </td>
                        <td className="py-3 px-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => staffResendInvitationMutation.mutate(inv.id)}
                              disabled={staffResendInvitationMutation.isPending}
                              className="p-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-600 hover:text-stone-900 transition-colors cursor-pointer"
                              title="Resend Staff Invitation Email"
                            >
                              <RotateCw className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setStaffInviteToRevoke(inv)}
                              disabled={staffRevokeInvitationMutation.isPending}
                              className="p-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 hover:text-rose-800 transition-colors cursor-pointer"
                              title="Revoke Staff Invitation"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}

                    {/* 2. Team Invitations (Host / Admin) */}
                    {filteredTeamInvitations.map((inv) => (
                      <tr key={`team-inv-${inv.id}`} className="hover:bg-stone-50/50 transition-colors">
                        <td className="py-3 px-3 font-medium text-stone-900">
                          {inv.email}
                        </td>
                        <td className="py-3 px-3">
                          {inv.role === 'ADMIN' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-purple-50 text-purple-700 border border-purple-200">
                              <Shield className="w-3 h-3" />
                              Admin
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-amber-50 text-amber-800 border border-amber-300">
                              <Megaphone className="w-3 h-3" />
                              Host
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-[11px] font-mono text-stone-500">
                          Verified Outside.vip Account
                        </td>
                        <td className="py-3 px-3 font-mono text-[11px] text-stone-500">
                          {new Date(inv.expiresAt).toLocaleDateString()}
                        </td>
                        <td className="py-3 px-3">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-amber-50 text-amber-700 border border-amber-200">
                            <Clock className="w-3 h-3" />
                            Pending
                          </span>
                        </td>
                        <td className="py-3 px-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => teamResendInvitationMutation.mutate(inv.id)}
                              disabled={teamResendInvitationMutation.isPending}
                              className="p-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-600 hover:text-stone-900 transition-colors cursor-pointer"
                              title="Resend Invitation Email"
                            >
                              <RotateCw className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => teamRevokeInvitationMutation.mutate(inv.id)}
                              disabled={teamRevokeInvitationMutation.isPending}
                              className="p-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 hover:text-rose-800 transition-colors cursor-pointer"
                              title="Revoke Invitation"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : (
          /* ================================================================= */
          /* 3. UNIFIED ACTIVE MEMBERS VIEW                                    */
          /* ================================================================= */
          <div className="space-y-4">
            {/* Category Filter Bar */}
            <div className="flex items-center gap-1.5 pb-2 border-b border-stone-100 overflow-x-auto">
              <span className="text-[11px] font-mono text-stone-400 uppercase mr-1 flex items-center gap-1">
                <Filter className="w-3 h-3" /> Category:
              </span>
              <button
                type="button"
                onClick={() => setRoleFilter('ALL')}
                className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-colors cursor-pointer ${
                  roleFilter === 'ALL'
                    ? 'bg-stone-900 text-white font-bold'
                    : 'bg-stone-100 hover:bg-stone-200 text-stone-600'
                }`}
              >
                All Roles ({totalActiveCount})
              </button>
              <button
                type="button"
                onClick={() => setRoleFilter('STAFF')}
                className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-colors cursor-pointer ${
                  roleFilter === 'STAFF'
                    ? 'bg-blue-700 text-white font-bold'
                    : 'bg-stone-100 hover:bg-stone-200 text-stone-600'
                }`}
              >
                Door Scanners ({isStaffRestricted ? 'Restricted' : activeStaffCount})
              </button>
              <button
                type="button"
                onClick={() => setRoleFilter('HOST')}
                className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-colors cursor-pointer ${
                  roleFilter === 'HOST'
                    ? 'bg-amber-700 text-white font-bold'
                    : 'bg-stone-100 hover:bg-stone-200 text-stone-600'
                }`}
              >
                Event Hosts ({activeHostsCount})
              </button>
              <button
                type="button"
                onClick={() => setRoleFilter('ADMIN')}
                className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-colors cursor-pointer ${
                  roleFilter === 'ADMIN'
                    ? 'bg-purple-700 text-white font-bold'
                    : 'bg-stone-100 hover:bg-stone-200 text-stone-600'
                }`}
              >
                Event Admins ({activeAdminsCount})
              </button>
            </div>

            {roleFilter === 'ALL' && isStaffRestricted && (
              <div className="flex items-center gap-2.5 p-3 rounded-xl bg-amber-50/70 border border-amber-200 text-amber-900 text-xs font-mono">
                <ShieldAlert className="w-4 h-4 text-amber-700 shrink-0" />
                <span>
                  <strong>Notice:</strong> Door scanner staff management is restricted to the event organizer (owner). Scanner staff are omitted from this view.
                </span>
              </div>
            )}

            {roleFilter === 'STAFF' && isStaffRestricted ? (
              <div className="py-16 text-center space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto border border-amber-200">
                  <ShieldAlert className="w-6 h-6" />
                </div>
                <h4 className="font-display font-bold text-stone-900 text-sm">
                  Door Scanner Staff Management Restricted
                </h4>
                <p className="text-xs text-stone-600 max-w-md mx-auto leading-relaxed">
                  Door scanner staff management is restricted to the event organizer (owner) and platform administrators. You do not have permission to view or manage gate scanning staff for this event.
                </p>
              </div>
            ) : !hasAnyActiveMembers ? (
              <div className="py-16 text-center space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-stone-100 text-stone-400 flex items-center justify-center mx-auto">
                  <Users className="w-6 h-6" />
                </div>
                <h4 className="font-display font-bold text-stone-800 text-sm">
                  No Team Members in this Category
                </h4>
                <p className="text-xs text-stone-500 max-w-sm mx-auto">
                  {roleFilter === 'STAFF'
                    ? 'No door scanning staff assigned to this event yet. Invite gate staff to verify attendee passes.'
                    : roleFilter === 'HOST'
                    ? 'No promotional hosts assigned yet. Invite hosts to share personal links and track traffic.'
                    : roleFilter === 'ADMIN'
                    ? 'No event administrators assigned yet. Invite co-organizers with custom management permissions.'
                    : 'Invite co-organizers as Event Admins, promotional partners as Event Hosts, or door staff to scan tickets.'}
                </p>
                <button
                  type="button"
                  onClick={() => setActiveTab('INVITE')}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-xs cursor-pointer mt-2"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  Invite Member
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-stone-200 text-[11px] font-mono uppercase text-stone-500">
                      <th className="py-2.5 px-3">Member</th>
                      <th className="py-2.5 px-3">Role</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3">Access / Link / Perms</th>
                      <th className="py-2.5 px-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100 font-sans">
                    {/* 1. Door Scanner Staff Members */}
                    {filteredStaffMembers.map((staff) => (
                      <tr key={`staff-mem-${staff.id}`} className="hover:bg-stone-50/50 transition-colors">
                        <td className="py-3 px-3">
                          <div className="font-medium text-stone-900">
                            {staff.name || 'Scanner Staff'}
                          </div>
                          <div className="text-[11px] font-mono text-stone-500">
                            {staff.email}
                          </div>
                        </td>
                        <td className="py-3 px-3">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-blue-50 text-blue-700 border border-blue-200">
                            <ScanLine className="w-3 h-3" />
                            Scanner Staff
                          </span>
                        </td>
                        <td className="py-3 px-3">
                          {staff.status === 'ACTIVE' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-emerald-50 text-emerald-800 border border-emerald-300">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-rose-50 text-rose-700 border border-rose-200">
                              Revoked
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3 font-mono text-[11px] text-stone-600">
                          Gate Check-In &amp; QR Scanning
                        </td>
                        <td className="py-3 px-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {staff.status === 'ACTIVE' && (
                              <button
                                type="button"
                                onClick={() => setStaffToRevoke(staff)}
                                className="p-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 hover:text-rose-800 transition-colors cursor-pointer"
                                title="Revoke Scanner Access"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}

                    {/* 2. Team Members (Host & Admin) */}
                    {filteredTeamMembers.map((member) => (
                      <tr key={`team-mem-${member.id}`} className="hover:bg-stone-50/50 transition-colors">
                        <td className="py-3 px-3">
                          <div className="font-medium text-stone-900">
                            {member.name || 'Member'}
                          </div>
                          <div className="text-[11px] font-mono text-stone-500">
                            {member.email}
                          </div>
                        </td>
                        <td className="py-3 px-3">
                          {member.role === 'ADMIN' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-purple-50 text-purple-700 border border-purple-200">
                              <Shield className="w-3 h-3" />
                              Admin
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-amber-50 text-amber-800 border border-amber-300">
                              <Megaphone className="w-3 h-3" />
                              Host
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3">
                          {member.status === 'ACTIVE' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-emerald-50 text-emerald-800 border border-emerald-300">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                              Active
                            </span>
                          ) : member.status === 'INACTIVE' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-stone-100 text-stone-600 border border-stone-200">
                              <span className="w-1.5 h-1.5 rounded-full bg-stone-400" />
                              Inactive
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-rose-50 text-rose-700 border border-rose-200">
                              Revoked
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3 font-mono text-[11px]">
                          {member.role === 'HOST' ? (
                            member.status === 'ACTIVE' && member.hostLink?.slug ? (
                              <div className="flex items-center gap-1.5">
                                <span className="bg-stone-100 px-2 py-0.5 rounded text-stone-800 font-semibold">
                                  {`/r/${member.hostLink.slug}`}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => handleCopyLink(member.hostLink!.slug!)}
                                  className="p-1 rounded hover:bg-stone-200 text-stone-500 hover:text-stone-800 transition-colors cursor-pointer"
                                  title="Copy Promotional Link"
                                >
                                  {copiedSlug === member.hostLink.slug ? (
                                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                                  ) : (
                                    <Copy className="w-3.5 h-3.5" />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setSharingLink({
                                      id: member.hostLink!.id,
                                      slug: member.hostLink!.slug!,
                                      name: member.hostLink!.name || `${member.name}'s Host Link`,
                                    })
                                  }
                                  className="p-1 rounded hover:bg-stone-200 text-stone-500 hover:text-stone-800 transition-colors cursor-pointer"
                                  title="Share Host Link on Social"
                                >
                                  <Share2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ) : member.status === 'INACTIVE' ? (
                              <span className="text-stone-400 italic">Link paused (member inactive)</span>
                            ) : member.status === 'REVOKED' ? (
                              <span className="text-rose-400 italic">Link archived</span>
                            ) : (
                              <span className="text-stone-400 italic">No primary slug</span>
                            )
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <span className="text-stone-600">
                                {member.permissions
                                  ? `${countActiveDelegablePermissions(member.permissions)}/${DELEGABLE_PERMISSION_COUNT} perms`
                                  : `Default (0/${DELEGABLE_PERMISSION_COUNT})`}
                              </span>
                              <button
                                type="button"
                                onClick={() => setEditingMember(member)}
                                className="text-stone-400 hover:text-stone-800 p-0.5 rounded hover:bg-stone-100 transition-colors cursor-pointer"
                                title="Edit Permissions"
                              >
                                <Settings2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* Toggle Role Button */}
                            <button
                              type="button"
                              onClick={() =>
                                setRoleChangeTarget({
                                  member,
                                  targetRole: member.role === 'ADMIN' ? 'HOST' : 'ADMIN',
                                })
                              }
                              className="p-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-600 hover:text-stone-900 transition-colors cursor-pointer"
                              title={`Switch role to ${member.role === 'ADMIN' ? 'Host' : 'Admin'}`}
                            >
                              <ArrowRightLeft className="w-3.5 h-3.5" />
                            </button>

                            {/* Toggle Status Button (Active / Inactive) */}
                            {member.status !== 'REVOKED' && (
                              <button
                                type="button"
                                onClick={() =>
                                  updateMemberMutation.mutate({
                                    memberId: member.id,
                                    updates: {
                                      status: member.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                                    },
                                  })
                                }
                                disabled={updateMemberMutation.isPending}
                                className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                                  member.status === 'ACTIVE'
                                    ? 'bg-amber-50 hover:bg-amber-100 text-amber-700'
                                    : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700'
                                }`}
                                title={
                                  member.status === 'ACTIVE'
                                    ? 'Set Inactive (disables link)'
                                    : 'Activate Member'
                                }
                              >
                                <Power className="w-3.5 h-3.5" />
                              </button>
                            )}

                            {/* Revoke Button */}
                            {member.status !== 'REVOKED' && (
                              <button
                                type="button"
                                onClick={() => setMemberToRevoke(member)}
                                className="p-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 hover:text-rose-800 transition-colors cursor-pointer"
                                title="Revoke Membership"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer info bar */}
      <div className="px-6 py-3 border-t border-stone-100 bg-[#FAF8F5] flex items-center justify-between text-[11px] font-mono text-stone-500">
        <span>
          {isStaffRestricted
            ? `${totalActiveCount} active member${totalActiveCount === 1 ? '' : 's'} (${activeHostsCount} host, ${activeAdminsCount} admin · scanner restricted) · ${totalPendingCount} pending`
            : `${totalActiveCount} active member${totalActiveCount === 1 ? '' : 's'} (${activeStaffCount} scanner, ${activeHostsCount} host, ${activeAdminsCount} admin) · ${totalPendingCount} pending`}
        </span>
        {!isInline && onClose && (
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 rounded-lg border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 transition-colors cursor-pointer shadow-2xs"
          >
            Done
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      {isInline ? (
        modalContent
      ) : (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 sm:p-6"
          onClick={onClose}
        >
          {modalContent}
        </div>
      )}

      {/* Permissions Editor Modal for New Admin Invitation */}
      <AdminPermissionsModal
        isOpen={isInvitePermsModalOpen}
        onClose={() => setIsInvitePermsModalOpen(false)}
        title="Configure Initial Admin Permissions"
        subtitle={`Select permissions for ${inviteEmail || 'new administrator'}`}
        initialPermissions={invitePermissions}
        callerIsOwner={callerIsOwner}
        callerPermissions={callerPermissions}
        onSave={(perms) => {
          setInvitePermissions(perms);
          setIsInvitePermsModalOpen(false);
          showNotification('success', 'Admin permissions configured');
        }}
      />

      {/* Permissions Editor Modal for Existing Admin Member */}
      {editingMember && (
        <AdminPermissionsModal
          isOpen={Boolean(editingMember)}
          onClose={() => setEditingMember(null)}
          title={`Edit Permissions: ${editingMember.name || editingMember.email}`}
          subtitle="Updates take effect immediately on this administrator's session."
          initialPermissions={editingMember.permissions}
          callerIsOwner={callerIsOwner}
          callerPermissions={callerPermissions}
          isSaving={updateMemberMutation.isPending}
          onSave={(perms) => {
            updateMemberMutation.mutate({
              memberId: editingMember.id,
              updates: { permissions: perms },
            });
          }}
        />
      )}

      {/* Role Change Confirmation Dialog (Host <-> Admin) */}
      {roleChangeTarget && (
        <div className="fixed inset-0 z-60 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white rounded-2xl border border-stone-200 p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-700 border border-amber-200 flex items-center justify-center">
                <ArrowRightLeft className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-display font-bold text-base text-stone-900">
                  Change Team Role?
                </h3>
                <span className="text-[11px] font-mono text-stone-500">
                  Switching to {roleChangeTarget.targetRole}
                </span>
              </div>
            </div>

            <p className="text-xs text-stone-600 leading-relaxed">
              Are you sure you want to change{' '}
              <strong className="text-stone-900">
                {roleChangeTarget.member.name || roleChangeTarget.member.email}
              </strong>{' '}
              from {roleChangeTarget.member.role} to {roleChangeTarget.targetRole}?
            </p>

            {roleChangeTarget.member.role === 'HOST' && roleChangeTarget.targetRole === 'ADMIN' && (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
                <span className="font-semibold block mb-0.5">Note on Host Link:</span>
                Their personal promotional link will be automatically archived and traffic tracking disabled.
              </div>
            )}

            {roleChangeTarget.member.role === 'ADMIN' && roleChangeTarget.targetRole === 'HOST' && (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
                <span className="font-semibold block mb-0.5">Note on Host Link:</span>
                A new personal promotional short link with unique primary slug will be generated immediately.
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setRoleChangeTarget(null)}
                disabled={updateMemberMutation.isPending}
                className="px-4 py-2 rounded-xl border border-stone-200 text-xs font-mono text-stone-600 hover:text-stone-900 hover:bg-stone-50 transition-colors shadow-2xs cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() =>
                  updateMemberMutation.mutate({
                    memberId: roleChangeTarget.member.id,
                    updates: { role: roleChangeTarget.targetRole },
                  })
                }
                disabled={updateMemberMutation.isPending}
                className="px-4 py-2 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs font-mono uppercase tracking-wider transition-colors shadow-xs disabled:opacity-50 cursor-pointer"
              >
                {updateMemberMutation.isPending ? 'Updating...' : 'Confirm Role Change'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Revocation Confirmation Dialog for Host / Admin */}
      {memberToRevoke && (
        <div className="fixed inset-0 z-60 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white rounded-2xl border border-stone-200 p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="w-10 h-10 rounded-xl bg-rose-50 border border-rose-200 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-rose-600" />
              </div>
              <div>
                <h3 className="font-display font-bold text-base text-stone-900">
                  Revoke Team Access?
                </h3>
                <span className="text-[11px] font-mono text-stone-500">
                  Permanent membership revocation
                </span>
              </div>
            </div>

            <p className="text-xs text-stone-600 leading-relaxed">
              Are you sure you want to revoke team membership for{' '}
              <strong className="text-stone-900">
                {memberToRevoke.name || memberToRevoke.email}
              </strong>
              ? They will lose all management access to this event and any personal host promotional links will be archived.
            </p>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setMemberToRevoke(null)}
                disabled={revokeMemberMutation.isPending}
                className="px-4 py-2 rounded-xl border border-stone-200 text-xs font-mono text-stone-600 hover:text-stone-900 hover:bg-stone-50 transition-colors shadow-2xs cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => revokeMemberMutation.mutate(memberToRevoke.id)}
                disabled={revokeMemberMutation.isPending}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-semibold text-xs font-mono uppercase tracking-wider transition-colors shadow-xs disabled:opacity-50 cursor-pointer"
              >
                {revokeMemberMutation.isPending ? 'Revoking...' : 'Confirm Revoke'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Revocation Confirmation Dialog for Scanner Staff */}
      {staffToRevoke && (
        <div className="fixed inset-0 z-60 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white rounded-2xl border border-stone-200 p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="w-10 h-10 rounded-xl bg-rose-50 border border-rose-200 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-rose-600" />
              </div>
              <div>
                <h3 className="font-display font-bold text-base text-stone-900">
                  Revoke Scanner Access?
                </h3>
                <span className="text-[11px] font-mono text-stone-500">
                  Door scanner staff revocation
                </span>
              </div>
            </div>

            <p className="text-xs text-stone-600 leading-relaxed">
              Are you sure you want to remove door scanning access for{' '}
              <strong className="text-stone-900">
                {staffToRevoke.name || staffToRevoke.email}
              </strong>
              ? Existing check-in records will remain credited, but their access to scan tickets at the door will be terminated immediately.
            </p>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setStaffToRevoke(null)}
                disabled={staffRevokeMemberMutation.isPending}
                className="px-4 py-2 rounded-xl border border-stone-200 text-xs font-mono text-stone-600 hover:text-stone-900 hover:bg-stone-50 transition-colors shadow-2xs cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => staffRevokeMemberMutation.mutate(staffToRevoke.userId)}
                disabled={staffRevokeMemberMutation.isPending}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-semibold text-xs font-mono uppercase tracking-wider transition-colors shadow-xs disabled:opacity-50 cursor-pointer"
              >
                {staffRevokeMemberMutation.isPending ? 'Revoking...' : 'Confirm Revoke'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Revocation Confirmation Dialog for Staff Pending Invitation */}
      {staffInviteToRevoke && (
        <div className="fixed inset-0 z-60 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white rounded-2xl border border-stone-200 p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="w-10 h-10 rounded-xl bg-rose-50 border border-rose-200 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-rose-600" />
              </div>
              <div>
                <h3 className="font-display font-bold text-base text-stone-900">
                  Revoke Staff Invitation?
                </h3>
                <span className="text-[11px] font-mono text-stone-500">
                  Door scanner pending invite
                </span>
              </div>
            </div>

            <p className="text-xs text-stone-600 leading-relaxed">
              Are you sure you want to revoke the pending door staff invitation for{' '}
              <strong className="text-stone-900">{staffInviteToRevoke.email}</strong>?
              The recipient will no longer be able to use their invitation link or verification code.
            </p>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setStaffInviteToRevoke(null)}
                disabled={staffRevokeInvitationMutation.isPending}
                className="px-4 py-2 rounded-xl border border-stone-200 text-xs font-mono text-stone-600 hover:text-stone-900 hover:bg-stone-50 transition-colors shadow-2xs cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => staffRevokeInvitationMutation.mutate(staffInviteToRevoke.id)}
                disabled={staffRevokeInvitationMutation.isPending}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-semibold text-xs font-mono uppercase tracking-wider transition-colors shadow-xs disabled:opacity-50 cursor-pointer"
              >
                {staffRevokeInvitationMutation.isPending ? 'Revoking...' : 'Confirm Revoke'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Social Share Modal */}
      {sharingLink && (
        <SocialShareModal
          isOpen={Boolean(sharingLink)}
          onClose={() => setSharingLink(null)}
          event={{
            title: event.title,
            slug: event.slug,
            city: event.city,
            tagline: event.tagline,
            coverImageUrl: event.coverImageUrl,
            category: event.category,
          }}
          link={sharingLink}
        />
      )}
    </>
  );
};

