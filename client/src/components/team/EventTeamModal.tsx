import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Users,
  UserPlus,
  Shield,
  Megaphone,
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
} from 'lucide-react';
import { api } from '../../lib/api';
import {
  OrganizerEventItem,
  EventTeamMemberItem,
  EventAdminPermissions,
  EventTeamRole,
} from '../../types';
import {
  AdminPermissionsModal,
  DEFAULT_ADMIN_PERMISSIONS,
} from './AdminPermissionsModal';

export interface EventTeamModalProps {
  isOpen: boolean;
  onClose: () => void;
  event: OrganizerEventItem | null;
}

export const EventTeamModal: React.FC<EventTeamModalProps> = ({
  isOpen,
  onClose,
  event,
}) => {
  if (!isOpen || !event) return null;

  const queryClient = useQueryClient();

  // Navigation tab
  const [activeTab, setActiveTab] = useState<'MEMBERS' | 'INVITATIONS' | 'INVITE'>('MEMBERS');

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
  const [inviteRole, setInviteRole] = useState<EventTeamRole>('HOST');
  const [invitePermissions, setInvitePermissions] = useState<EventAdminPermissions>({
    ...DEFAULT_ADMIN_PERMISSIONS,
  });
  const [isInvitePermsModalOpen, setIsInvitePermsModalOpen] = useState(false);

  // Active member permissions editor modal
  const [editingMember, setEditingMember] = useState<EventTeamMemberItem | null>(null);

  // Confirmation dialogs
  const [memberToRevoke, setMemberToRevoke] = useState<EventTeamMemberItem | null>(null);
  const [roleChangeTarget, setRoleChangeTarget] = useState<{
    member: EventTeamMemberItem;
    targetRole: EventTeamRole;
  } | null>(null);

  // Clipboard copy feedback
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  // Fetch team members and pending invitations
  const {
    data: teamData,
    isLoading,
    isFetching,
    refetch,
    error,
  } = useQuery({
    queryKey: ['event-team', event.id],
    queryFn: () => api.team.getTeam(event.id),
    enabled: Boolean(event.id),
  });

  const members = teamData?.members || [];
  const invitations = teamData?.invitations || [];

  // Mutations
  const inviteMutation = useMutation({
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
      showNotification('error', err?.message || 'Failed to dispatch team invitation');
    },
  });

  const resendInvitationMutation = useMutation({
    mutationFn: (invitationId: string) => api.team.resendInvitation(event.id, invitationId),
    onSuccess: (invitation) => {
      queryClient.invalidateQueries({ queryKey: ['event-team', event.id] });
      showNotification('success', `Invitation resent to ${invitation.email}`);
    },
    onError: (err: any) => {
      showNotification('error', err?.message || 'Failed to resend invitation');
    },
  });

  const revokeInvitationMutation = useMutation({
    mutationFn: (invitationId: string) => api.team.revokeInvitation(event.id, invitationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-team', event.id] });
      showNotification('success', 'Invitation revoked successfully');
    },
    onError: (err: any) => {
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
      setEditingMember(null);
      setRoleChangeTarget(null);
      showNotification('success', `Team member ${updated.name || updated.email} updated`);
    },
    onError: (err: any) => {
      showNotification('error', err?.message || 'Failed to update team member');
    },
  });

  const revokeMemberMutation = useMutation({
    mutationFn: (memberId: string) => api.team.revokeMember(event.id, memberId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-team', event.id] });
      setMemberToRevoke(null);
      showNotification('success', 'Team member access revoked and personal links archived');
    },
    onError: (err: any) => {
      showNotification('error', err?.message || 'Failed to revoke team member access');
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
    if (!inviteEmail.trim()) {
      showNotification('error', 'Please enter a valid email address');
      return;
    }
    inviteMutation.mutate({
      email: inviteEmail.trim(),
      role: inviteRole,
      permissions: inviteRole === 'ADMIN' ? invitePermissions : null,
    });
  };

  const activeCount = members.filter((m) => m.status === 'ACTIVE').length;
  const pendingCount = invitations.length;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[90vh] bg-white rounded-2xl border border-stone-200 shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
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
                Event-scoped administrators and promotional traffic hosts
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="p-2 rounded-lg text-stone-500 hover:text-stone-900 hover:bg-stone-100 transition-colors cursor-pointer"
              title="Refresh Team List"
            >
              <RotateCw className={`w-4 h-4 ${isFetching ? 'animate-spin text-stone-900' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
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

        {/* Tab Navigation */}
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
              Active Team ({activeCount})
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
              Pending Invites ({pendingCount})
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
              <span>Loading team members...</span>
            </div>
          ) : error ? (
            <div className="py-12 text-center text-rose-600 font-mono text-xs">
              Failed to load event team. Please try again.
            </div>
          ) : activeTab === 'INVITE' ? (
            /* Invite View */
            <form onSubmit={handleInviteSubmit} className="max-w-xl mx-auto space-y-6 py-2">
              <div className="space-y-1">
                <h4 className="font-display font-bold text-lg text-stone-900">
                  Invite New Team Member
                </h4>
                <p className="text-xs text-stone-500">
                  Invitees receive an email invitation to join this event's team using their Outside.vip account.
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

              {/* Role Selection */}
              <div className="space-y-2">
                <label className="text-[11px] font-mono text-stone-600 uppercase font-semibold block">
                  Select Team Role
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Host Card */}
                  <label
                    className={`p-4 rounded-xl border cursor-pointer select-none transition-all ${
                      inviteRole === 'HOST'
                        ? 'border-amber-400 bg-amber-50/40 ring-1 ring-amber-400/50'
                        : 'border-stone-200 bg-white hover:border-stone-300'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-lg bg-amber-100 text-amber-800 flex items-center justify-center">
                          <Megaphone className="w-3.5 h-3.5" />
                        </div>
                        <span className="font-display font-bold text-sm text-stone-900">
                          Event Host
                        </span>
                      </div>
                      <input
                        type="radio"
                        name="role"
                        value="HOST"
                        checked={inviteRole === 'HOST'}
                        onChange={() => setInviteRole('HOST')}
                        className="accent-stone-900"
                      />
                    </div>
                    <p className="text-[11px] text-stone-500 leading-relaxed">
                      Dedicated promoter. Automatically receives a unique, customizable promotional link (/r/...) to track incoming traffic. No backend management permissions.
                    </p>
                  </label>

                  {/* Admin Card */}
                  <label
                    className={`p-4 rounded-xl border cursor-pointer select-none transition-all ${
                      inviteRole === 'ADMIN'
                        ? 'border-stone-900 bg-stone-50/60 ring-1 ring-stone-900/50'
                        : 'border-stone-200 bg-white hover:border-stone-300'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-lg bg-stone-900 text-white flex items-center justify-center">
                          <Shield className="w-3.5 h-3.5 text-amber-400" />
                        </div>
                        <span className="font-display font-bold text-sm text-stone-900">
                          Event Admin
                        </span>
                      </div>
                      <input
                        type="radio"
                        name="role"
                        value="ADMIN"
                        checked={inviteRole === 'ADMIN'}
                        onChange={() => setInviteRole('ADMIN')}
                        className="accent-stone-900"
                      />
                    </div>
                    <p className="text-[11px] text-stone-500 leading-relaxed">
                      Administrative team member. Can be granted granular permissions to edit details, manage tiers, view orders, or handle team members.
                    </p>
                  </label>
                </div>
              </div>

              {/* Admin Permissions Config Button */}
              {inviteRole === 'ADMIN' && (
                <div className="p-4 rounded-xl bg-stone-50 border border-stone-200 flex items-center justify-between">
                  <div>
                    <span className="text-xs font-semibold text-stone-900 block">
                      Admin Permissions
                    </span>
                    <span className="text-[11px] font-mono text-stone-500 mt-0.5 block">
                      {Object.values(invitePermissions).filter(Boolean).length} of 10 granted (deny-by-default)
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
              )}

              {/* Submit Buttons */}
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
                  disabled={inviteMutation.isPending}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  <Mail className="w-3.5 h-3.5" />
                  {inviteMutation.isPending ? 'Sending Invite...' : 'Send Invitation'}
                </button>
              </div>
            </form>
          ) : activeTab === 'INVITATIONS' ? (
            /* Pending Invitations View */
            invitations.length === 0 ? (
              <div className="py-16 text-center space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-stone-100 text-stone-400 flex items-center justify-center mx-auto">
                  <Mail className="w-6 h-6" />
                </div>
                <h4 className="font-display font-bold text-stone-800 text-sm">
                  No Pending Invitations
                </h4>
                <p className="text-xs text-stone-500 max-w-sm mx-auto">
                  All invited team members have accepted or expired. Click "Invite Member" to invite more admins or hosts.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-stone-200 text-[11px] font-mono uppercase text-stone-500">
                      <th className="py-2.5 px-3">Invitee Email</th>
                      <th className="py-2.5 px-3">Role</th>
                      <th className="py-2.5 px-3">Expires At</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100 font-sans">
                    {invitations.map((inv) => (
                      <tr key={inv.id} className="hover:bg-stone-50/50 transition-colors">
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
                              onClick={() => resendInvitationMutation.mutate(inv.id)}
                              disabled={resendInvitationMutation.isPending}
                              className="p-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-600 hover:text-stone-900 transition-colors cursor-pointer"
                              title="Resend Invitation Email"
                            >
                              <RotateCw className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => revokeInvitationMutation.mutate(inv.id)}
                              disabled={revokeInvitationMutation.isPending}
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
            )
          ) : (
            /* Active Members View */
            members.length === 0 ? (
              <div className="py-16 text-center space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-stone-100 text-stone-400 flex items-center justify-center mx-auto">
                  <Users className="w-6 h-6" />
                </div>
                <h4 className="font-display font-bold text-stone-800 text-sm">
                  No Team Members Yet
                </h4>
                <p className="text-xs text-stone-500 max-w-sm mx-auto">
                  Invite co-organizers as Event Admins or promotional partners as Event Hosts to help spread the word.
                </p>
                <button
                  type="button"
                  onClick={() => setActiveTab('INVITE')}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-xs cursor-pointer mt-2"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  Invite First Member
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
                      <th className="py-2.5 px-3">Promotional Link / Perms</th>
                      <th className="py-2.5 px-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100 font-sans">
                    {members.map((member) => (
                      <tr key={member.id} className="hover:bg-stone-50/50 transition-colors">
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
                                  ? `${Object.values(member.permissions).filter(Boolean).length}/10 perms`
                                  : 'Default (0)'}
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
            )
          )}
        </div>

        {/* Footer info bar */}
        <div className="px-6 py-3 border-t border-stone-100 bg-[#FAF8F5] flex items-center justify-between text-[11px] font-mono text-stone-500">
          <span>
            {members.length} team member{members.length === 1 ? '' : 's'} · {invitations.length} pending
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 rounded-lg border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 transition-colors cursor-pointer shadow-2xs"
          >
            Done
          </button>
        </div>
      </div>

      {/* Permissions Editor Modal for New Admin Invitation */}
      <AdminPermissionsModal
        isOpen={isInvitePermsModalOpen}
        onClose={() => setIsInvitePermsModalOpen(false)}
        title="Configure Initial Admin Permissions"
        subtitle={`Select permissions for ${inviteEmail || 'new administrator'}`}
        initialPermissions={invitePermissions}
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
          isSaving={updateMemberMutation.isPending}
          onSave={(perms) => {
            updateMemberMutation.mutate({
              memberId: editingMember.id,
              updates: { permissions: perms },
            });
          }}
        />
      )}

      {/* Role Change Confirmation Dialog */}
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

      {/* Revocation Confirmation Dialog */}
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
    </div>
  );
};
