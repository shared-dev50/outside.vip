import React, { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import {
  Users,
  ShieldCheck,
  Loader2,
  ShieldAlert,
} from 'lucide-react';
import { api } from '../lib/api';
import { OrganizerEventItem } from '../types';
import { useOptionalAuth } from '../context/AuthContext';
import { EventTeamModal } from '../components/team/EventTeamModal';

export interface TeamsPageProps {
  initialEvents?: OrganizerEventItem[];
}

export const TeamsPage: React.FC<TeamsPageProps> = ({ initialEvents }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const auth = useOptionalAuth();
  const user = auth?.user;
  const clearSessionState = auth?.clearSessionState;

  const filterTeamAuthorizedEvents = (rawEvents: OrganizerEventItem[]) =>
    rawEvents.filter((evt) => {
      if (user?.role === 'ADMIN') return true;
      const isOwner = evt.isOwner ?? (user ? evt.organizerId === user.id : false);
      return isOwner || Boolean(evt.permissions?.canManageTeam);
    });

  const initialAuthorized = initialEvents ? filterTeamAuthorizedEvents(initialEvents) : [];

  const [events, setEvents] = useState<OrganizerEventItem[]>(initialAuthorized);
  const [selectedEventId, setSelectedEventId] = useState<string>(
    initialAuthorized[0]?.id || ''
  );
  const [isLoadingEvents, setIsLoadingEvents] = useState<boolean>(
    initialEvents === undefined
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  // Load events where caller is Event Owner, Platform Admin, or Event Admin with canManageTeam
  useEffect(() => {
    if (initialEvents !== undefined) return;
    let isMounted = true;
    async function fetchEvents() {
      setIsLoadingEvents(true);
      setLoadError(null);
      try {
        const res = await api.organizer.listEvents();
        if (isMounted && res.events) {
          const teamEligible = filterTeamAuthorizedEvents(res.events);
          setEvents(teamEligible);
          const paramEvent = searchParams.get('event');
          if (
            paramEvent &&
            teamEligible.some((e) => e.id === paramEvent || e.slug === paramEvent)
          ) {
            const found = teamEligible.find((e) => e.id === paramEvent || e.slug === paramEvent);
            if (found) setSelectedEventId(found.id);
          } else if (teamEligible.length > 0) {
            setSelectedEventId(teamEligible[0].id);
          } else {
            setSelectedEventId('');
          }
        }
      } catch (err: any) {
        if (!isMounted) return;
        const status = err?.statusCode || err?.status;
        if (status === 401) {
          clearSessionState?.();
          return;
        }
        setLoadError(err?.message || 'Failed to load team-authorized events.');
      } finally {
        if (isMounted) setIsLoadingEvents(false);
      }
    }

    fetchEvents();
    return () => {
      isMounted = false;
    };
  }, [initialEvents, user?.id, user?.role, clearSessionState]);

  // Sync selected event to URL param
  const handleSelectEvent = (id: string) => {
    setSelectedEventId(id);
    setSearchParams(id ? { event: id } : {});
  };

  const selectedEvent = events.find((e) => e.id === selectedEventId) || null;

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-stone-200 pb-6">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-stone-100 border border-stone-200 text-stone-700 text-xs font-mono uppercase tracking-wider font-semibold mb-2">
            <Users className="w-3.5 h-3.5 text-stone-900" />
            Unified Team Workspace
          </div>
          <h1 className="text-2xl sm:text-3xl font-display font-bold text-stone-900 tracking-tight">
            Event Team &amp; Staff Management
          </h1>
          <p className="text-stone-500 text-sm mt-1 max-w-xl">
            Manage all event collaborators in one unified interface: Door Scanner Staff (gate access), Event Hosts (promotional links and private analytics), and Event Admins (configurable permissions).
          </p>
        </div>

        <Link
          to="/scanner"
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-semibold uppercase tracking-wider transition-colors shadow-sm self-start sm:self-auto"
        >
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
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
              <Loader2 className="w-4 h-4 animate-spin text-stone-700" /> Loading your events...
            </div>
          ) : events.length === 0 ? (
            <p className="text-xs text-stone-500">
              No events found. Create an event first to invite event team members or scanner staff.
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

      {/* Unified Team Workspace Content */}
      {selectedEvent ? (
        <EventTeamModal event={selectedEvent} isInline={true} />
      ) : (
        !isLoadingEvents && (
          <div className="p-10 text-center bg-white rounded-2xl border border-stone-200 space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-amber-50 border border-amber-200 text-amber-700 flex items-center justify-center mx-auto">
              <ShieldAlert className="w-6 h-6" />
            </div>
            <div className="space-y-1.5">
              <h2 className="font-display font-bold text-base text-stone-900">
                {loadError ? 'Unable to Load Event Teams' : 'No Team Management Access'}
              </h2>
              <p className="text-xs text-stone-600 max-w-md mx-auto leading-relaxed">
                {loadError ||
                  'Team management requires owning an event or holding an active Event Admin membership with the Manage Event Team permission.'}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
              <Link
                to="/organizer"
                className="px-4 py-2 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-semibold tracking-wider transition-colors"
              >
                Organizer Dashboard
              </Link>
              <Link
                to="/host"
                className="px-4 py-2 rounded-xl border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 text-xs font-mono uppercase font-semibold tracking-wider transition-colors"
              >
                Host Workspace
              </Link>
            </div>
          </div>
        )
      )}
    </div>
  );
};
