import React, { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import {
  Users,
  UserPlus,
  Mail,
  ShieldCheck,
  RotateCw,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import {
  api,
  EventStaffMember,
  EventStaffInvitationItem,
} from '../lib/api';
import { OrganizerEventItem } from '../types';

export const TeamsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  const [events, setEvents] = useState<OrganizerEventItem[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>('');
  const [isLoadingEvents, setIsLoadingEvents] = useState<boolean>(true);

  // Team state
  const [staff, setStaff] = useState<EventStaffMember[]>([]);
  const [invitations, setInvitations] = useState<EventStaffInvitationItem[]>([]);
  const [isLoadingTeam, setIsLoadingTeam] = useState<boolean>(false);
  const [teamError, setTeamError] = useState<string | null>(null);

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState<string>('');
  const [isSubmittingInvite, setIsSubmittingInvite] = useState<boolean>(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  // Action states
  const [actionInProgressId, setActionInProgressId] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // Load organizer events
  useEffect(() => {
    let isMounted = true;
    async function fetchEvents() {
      setIsLoadingEvents(true);
      try {
        const res = await api.organizer.listEvents();
        if (isMounted && res.events) {
          setEvents(res.events);
          const paramEvent = searchParams.get('event');
          if (paramEvent && res.events.some((e) => e.id === paramEvent || e.slug === paramEvent)) {
            const found = res.events.find((e) => e.id === paramEvent || e.slug === paramEvent);
            if (found) setSelectedEventId(found.id);
          } else if (res.events.length > 0) {
            setSelectedEventId(res.events[0].id);
          }
        }
      } catch (err: any) {
        console.error('Failed to load organizer events:', err);
      } finally {
        if (isMounted) setIsLoadingEvents(false);
      }
    }

    fetchEvents();
    return () => {
      isMounted = false;
    };
  }, []);

  // Sync selected event to URL param
  const handleSelectEvent = (id: string) => {
    setSelectedEventId(id);
    setSearchParams(id ? { event: id } : {});
    setInviteError(null);
    setInviteSuccess(null);
    setActionFeedback(null);
  };

  // Load team data for selected event
  const fetchTeam = async (eventId: string) => {
    if (!eventId) return;
    setIsLoadingTeam(true);
    setTeamError(null);
    try {
      const res = await api.staff.getTeam(eventId);
      setStaff(res.staff || []);
      setInvitations(res.invitations || []);
    } catch (err: any) {
      setTeamError(
        err?.message ||
          err?.error?.message ||
          'Failed to load scanner staff for this event.'
      );
    } finally {
      setIsLoadingTeam(false);
    }
  };

  useEffect(() => {
    if (selectedEventId) {
      fetchTeam(selectedEventId);
    } else {
      setStaff([]);
      setInvitations([]);
    }
  }, [selectedEventId]);

  // Invite new staff
  const handleInviteStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEventId || !inviteEmail.trim() || isSubmittingInvite) return;

    setIsSubmittingInvite(true);
    setInviteError(null);
    setInviteSuccess(null);
    setActionFeedback(null);

    try {
      const res = await api.staff.invite(selectedEventId, inviteEmail.trim());
      setInviteEmail('');
      if (res.emailDeliveryFailed) {
        setInviteSuccess(
          'Invitation record created, but email dispatch failed. You can resend shortly.'
        );
      } else {
        setInviteSuccess(`Invitation link dispatched to ${res.invitation.email}.`);
      }
      await fetchTeam(selectedEventId);
    } catch (err: any) {
      setInviteError(
        err?.message ||
          err?.error?.message ||
          'Failed to dispatch invitation. Please check the email and try again.'
      );
    } finally {
      setIsSubmittingInvite(false);
    }
  };

  // Resend invitation
  const handleResend = async (invitationId: string) => {
    if (!selectedEventId || actionInProgressId) return;
    setActionInProgressId(invitationId);
    setActionFeedback(null);

    try {
      const res = await api.staff.resendInvitation(selectedEventId, invitationId);
      setActionFeedback({
        type: 'success',
        message: res.message || 'Invitation resent successfully.',
      });
      await fetchTeam(selectedEventId);
    } catch (err: any) {
      setActionFeedback({
        type: 'error',
        message: err?.message || err?.error?.message || 'Failed to resend invitation.',
      });
    } finally {
      setActionInProgressId(null);
    }
  };

  // Revoke invitation
  const handleRevokeInvitation = async (invitationId: string) => {
    if (!selectedEventId || actionInProgressId) return;
    if (!window.confirm('Are you sure you want to revoke this pending staff invitation?')) {
      return;
    }

    setActionInProgressId(invitationId);
    setActionFeedback(null);

    try {
      await api.staff.revokeInvitation(selectedEventId, invitationId);
      setActionFeedback({
        type: 'success',
        message: 'Pending invitation revoked.',
      });
      await fetchTeam(selectedEventId);
    } catch (err: any) {
      setActionFeedback({
        type: 'error',
        message: err?.message || err?.error?.message || 'Failed to revoke invitation.',
      });
    } finally {
      setActionInProgressId(null);
    }
  };

  // Revoke active staff member
  const handleRevokeMember = async (userId: string, name: string) => {
    if (!selectedEventId || actionInProgressId) return;
    if (
      !window.confirm(
        `Are you sure you want to remove ${name || 'this staff member'} from scanning access? Existing check-in records will remain credited.`
      )
    ) {
      return;
    }

    setActionInProgressId(userId);
    setActionFeedback(null);

    try {
      await api.staff.revokeMember(selectedEventId, userId);
      setActionFeedback({
        type: 'success',
        message: `${name || 'Staff member'} scanning access has been revoked.`,
      });
      await fetchTeam(selectedEventId);
    } catch (err: any) {
      setActionFeedback({
        type: 'error',
        message: err?.message || err?.error?.message || 'Failed to revoke staff access.',
      });
    } finally {
      setActionInProgressId(null);
    }
  };

  const selectedEvent = events.find((e) => e.id === selectedEventId);

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-stone-200 pb-6">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-stone-100 border border-stone-200 text-stone-700 text-xs font-mono uppercase tracking-wider font-semibold mb-2">
            <Users className="w-3.5 h-3.5" />
            Door Operations & Teams
          </div>
          <h1 className="text-2xl sm:text-3xl font-display font-bold text-stone-900 tracking-tight">
            Scanner Staff Management
          </h1>
          <p className="text-stone-500 text-sm mt-1 max-w-xl">
            Grant event-specific ticket verification access to door staff via passwordless email verification. Staff cannot view financials or organizer settings.
          </p>
        </div>

        <Link
          to="/scanner"
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-semibold uppercase tracking-wider transition-colors shadow-sm self-start sm:self-auto"
        >
          <ShieldCheck className="w-4 h-4" />
          Open Scanner
        </Link>
      </div>

      {/* Event Switcher */}
      <div className="p-4 rounded-2xl bg-white border border-stone-200 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="w-full sm:w-auto flex-1 space-y-1">
          <label className="text-[11px] font-mono text-stone-500 uppercase font-semibold block">
            Select Event to Manage Team
          </label>
          {isLoadingEvents ? (
            <div className="flex items-center gap-2 text-xs font-mono text-stone-400 py-1">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading your events...
            </div>
          ) : events.length === 0 ? (
            <p className="text-xs text-stone-500">
              No events found. Create an event first to invite scanner staff.
            </p>
          ) : (
            <select
              value={selectedEventId}
              onChange={(e) => handleSelectEvent(e.target.value)}
              className="w-full sm:w-96 px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-200 text-stone-900 text-xs font-semibold focus:outline-none focus:border-stone-900"
            >
              {events.map((evt) => (
                <option key={evt.id} value={evt.id}>
                  {evt.title} ({evt.status})
                </option>
              ))}
            </select>
          )}
        </div>

        {selectedEvent && (
          <div className="text-xs font-mono text-stone-500 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span>Event Status: <strong>{selectedEvent.status}</strong></span>
          </div>
        )}
      </div>

      {/* Action Notification Banner */}
      {actionFeedback && (
        <div
          className={`p-4 rounded-xl text-xs flex items-center gap-3 ${
            actionFeedback.type === 'success'
              ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border border-rose-200 text-rose-800'
          }`}
        >
          {actionFeedback.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
          )}
          <p className="font-medium">{actionFeedback.message}</p>
        </div>
      )}

      {selectedEventId && (
        <div className="space-y-8">
          {/* Invite Staff Section */}
          <div className="bg-white rounded-2xl p-6 sm:p-8 border border-stone-200 shadow-sm space-y-4">
            <div className="flex items-center gap-2 text-stone-900 font-display font-bold text-lg">
              <UserPlus className="w-5 h-5" />
              <h2>Invite Scanner Staff Member</h2>
            </div>
            <p className="text-xs text-stone-600 leading-relaxed max-w-xl">
              Enter the staff member's email. They will receive a link to verify their address with a 6-digit code and immediately start scanning at the door.
            </p>

            <form onSubmit={handleInviteStaff} className="flex flex-col sm:flex-row gap-3 pt-2">
              <div className="relative flex-1">
                <Mail className="w-4 h-4 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="email"
                  required
                  placeholder="staff@venue.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-stone-50 border border-stone-200 text-stone-900 text-sm focus:outline-none focus:border-stone-900"
                />
              </div>
              <button
                type="submit"
                disabled={isSubmittingInvite || !inviteEmail.trim()}
                className="px-6 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-semibold uppercase tracking-wider transition-colors inline-flex items-center justify-center gap-2 disabled:opacity-50 shadow-sm"
              >
                {isSubmittingInvite ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Sending Invite...
                  </>
                ) : (
                  <>
                    <UserPlus className="w-4 h-4" />
                    Send Invitation
                  </>
                )}
              </button>
            </form>

            {inviteSuccess && (
              <p className="text-xs text-emerald-700 font-medium inline-flex items-center gap-1.5 pt-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {inviteSuccess}
              </p>
            )}

            {inviteError && (
              <p className="text-xs text-rose-700 font-medium inline-flex items-center gap-1.5 pt-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                {inviteError}
              </p>
            )}
          </div>

          {teamError && (
            <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
              <p>{teamError}</p>
            </div>
          )}

          {/* Active Staff Table */}
          <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden space-y-0">
            <div className="p-6 border-b border-stone-200 flex items-center justify-between">
              <div>
                <h2 className="font-display font-bold text-stone-900 text-base">
                  Active Scanner Staff ({staff.length})
                </h2>
                <p className="text-xs text-stone-500 mt-0.5">
                  Members authorized to admit tickets at this event gate
                </p>
              </div>
              <button
                type="button"
                onClick={() => fetchTeam(selectedEventId)}
                title="Refresh team list"
                className="p-2 rounded-xl border border-stone-200 text-stone-600 hover:bg-stone-50 transition-colors"
              >
                <RotateCw className="w-4 h-4" />
              </button>
            </div>

            {isLoadingTeam ? (
              <div className="py-12 text-center text-xs font-mono text-stone-400 flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading team members...
              </div>
            ) : staff.length === 0 ? (
              <div className="py-10 text-center space-y-2">
                <Users className="w-8 h-8 text-stone-300 mx-auto" />
                <p className="text-xs text-stone-500 font-mono">
                  No active staff members assigned to this event yet.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-stone-100">
                {staff.map((member) => (
                  <div
                    key={member.id}
                    className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-stone-50/50 transition-colors"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-stone-900 text-sm">
                          {member.name || member.email.split('@')[0]}
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[10px] font-mono font-semibold uppercase tracking-wider border border-emerald-200">
                          Active
                        </span>
                      </div>
                      <p className="text-xs font-mono text-stone-500">{member.email}</p>
                      <p className="text-[11px] text-stone-400">
                        Added {new Date(member.assignedAt).toLocaleDateString()} by {member.assignedByName}
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={actionInProgressId === member.userId}
                      onClick={() => handleRevokeMember(member.userId, member.name)}
                      className="px-3.5 py-1.5 rounded-xl border border-rose-200 text-rose-700 hover:bg-rose-50 text-xs font-medium transition-colors inline-flex items-center gap-1.5 self-start sm:self-auto disabled:opacity-50"
                    >
                      {actionInProgressId === member.userId ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                      Revoke Access
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Pending Invitations Table */}
          <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden space-y-0">
            <div className="p-6 border-b border-stone-200">
              <h2 className="font-display font-bold text-stone-900 text-base">
                Pending Staff Invitations ({invitations.length})
              </h2>
              <p className="text-xs text-stone-500 mt-0.5">
                Awaiting email code verification from invitee
              </p>
            </div>

            {isLoadingTeam ? (
              <div className="py-12 text-center text-xs font-mono text-stone-400 flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading invitations...
              </div>
            ) : invitations.length === 0 ? (
              <div className="py-10 text-center space-y-2">
                <Mail className="w-8 h-8 text-stone-300 mx-auto" />
                <p className="text-xs text-stone-500 font-mono">
                  No pending staff invitations for this event.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-stone-100">
                {invitations.map((invite) => (
                  <div
                    key={invite.id}
                    className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-stone-50/50 transition-colors"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-stone-900 text-sm">{invite.email}</span>
                        <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px] font-mono font-semibold uppercase tracking-wider border border-amber-200">
                          Pending OTP
                        </span>
                      </div>
                      <p className="text-[11px] text-stone-400 font-mono">
                        Sent {new Date(invite.createdAt).toLocaleDateString()} · Expires {new Date(invite.expiresAt).toLocaleDateString()}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 self-start sm:self-auto">
                      <button
                        type="button"
                        disabled={!invite.canResend || actionInProgressId === invite.id}
                        onClick={() => handleResend(invite.id)}
                        className="px-3 py-1.5 rounded-xl border border-stone-200 text-stone-700 hover:bg-stone-50 text-xs font-medium transition-colors inline-flex items-center gap-1.5 disabled:opacity-50"
                      >
                        {actionInProgressId === invite.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <RotateCw className="w-3.5 h-3.5" />
                        )}
                        {invite.resendCooldownSeconds > 0
                          ? `Wait ${invite.resendCooldownSeconds}s`
                          : 'Resend Link'}
                      </button>

                      <button
                        type="button"
                        disabled={actionInProgressId === invite.id}
                        onClick={() => handleRevokeInvitation(invite.id)}
                        className="p-2 rounded-xl border border-rose-200 text-rose-700 hover:bg-rose-50 transition-colors disabled:opacity-50"
                        title="Revoke invitation"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
