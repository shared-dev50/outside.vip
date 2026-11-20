import React, { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import {
  Users,
  ShieldCheck,
  Loader2,
} from 'lucide-react';
import { api } from '../lib/api';
import { OrganizerEventItem } from '../types';
import { EventTeamModal } from '../components/team/EventTeamModal';

export const TeamsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  const [events, setEvents] = useState<OrganizerEventItem[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>('');
  const [isLoadingEvents, setIsLoadingEvents] = useState<boolean>(true);

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
          <div className="p-12 text-center bg-white rounded-2xl border border-stone-200 text-stone-400 font-mono text-xs">
            Select an event above to view and manage its team members, promotional hosts, and scanner staff.
          </div>
        )
      )}
    </div>
  );
};
