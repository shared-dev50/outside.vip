import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { 
  PlusCircle, 
  TrendingUp, 
  Ticket, 
  Calendar, 
  QrCode, 
  Eye, 
  ShieldCheck
} from 'lucide-react';

export const OrganizerDashboardPage: React.FC = () => {
  const { user } = useAuth();

  // Mock organizer metrics for the demo
  const stats = [
    { label: 'Gross Ticket Sales', value: '$48,450', change: '+18.4%', icon: TrendingUp },
    { label: 'Tickets Issued', value: '1,280', change: '+12%', icon: Ticket },
    { label: 'Check-In Velocity', value: '84.2%', change: '+5%', icon: QrCode },
    { label: 'Live Experiences', value: '3 Active', change: '0 Draft', icon: Calendar },
  ];

  const organizerEvents = [
    {
      id: '1',
      title: 'SOL FEST: Under The Baobab Tree',
      slug: 'sol-fest-baobab-edition-2026',
      status: 'PUBLISHED',
      category: 'FESTIVAL',
      date: 'Sat, Oct 24, 2026',
      city: 'Kilifi',
      sold: 1053,
      capacity: 2350,
      revenue: '$38,200',
    },
    {
      id: '2',
      title: 'SUB-TERRAIN: Industrial Warehouse Session 004',
      slug: 'sub-terrain-industrial-warehouse-004',
      status: 'PUBLISHED',
      category: 'NIGHTLIFE',
      date: 'Fri, Nov 06, 2026',
      city: 'Nairobi',
      sold: 242,
      capacity: 600,
      revenue: '$5,750',
    },
    {
      id: '3',
      title: 'SYNAPSE: Emerging Tech & Creative Media Summit',
      slug: 'outside-synapse-future-tech-summit',
      status: 'PUBLISHED',
      category: 'TECH',
      date: 'Sat, Nov 14, 2026',
      city: 'Nairobi',
      sold: 155,
      capacity: 400,
      revenue: '$4,500',
    },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-10">
      {/* Header bar with Create Event CTA */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="text-xs uppercase font-mono tracking-widest text-brand-neon font-semibold mb-1 flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4" />
            Organizer Command Center
          </div>
          <h1 className="text-3xl font-display font-bold text-white tracking-tight">
            {user?.organizer?.displayName || 'Sol Collective & Sound'}
          </h1>
          <p className="text-sm text-slate-400">
            Real-time event performance, ticket inventory, and scanner authorization.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link
            to="/organizer/events/new"
            className="flex items-center gap-2 px-6 py-3 rounded-full bg-brand-neon hover:bg-brand-neon-hover text-black font-display font-bold text-sm transition-all shadow-neon-sm hover:scale-[1.02]"
          >
            <PlusCircle className="w-4 h-4" />
            Create Event
          </Link>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="p-6 rounded-3xl glass-panel space-y-3">
              <div className="flex items-center justify-between text-slate-400">
                <span className="text-xs font-mono uppercase tracking-wider">{stat.label}</span>
                <div className="w-8 h-8 rounded-xl bg-surface-850 flex items-center justify-center text-brand-neon border border-surface-700">
                  <Icon className="w-4 h-4" />
                </div>
              </div>
              <div className="font-display font-bold text-3xl text-white">{stat.value}</div>
              <div className="text-xs text-emerald-400 font-medium flex items-center gap-1">
                <span>{stat.change}</span>
                <span className="text-slate-500">vs last month</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Events Table Section */}
      <div className="glass-panel rounded-3xl overflow-hidden border border-surface-800">
        <div className="p-6 sm:p-8 flex items-center justify-between border-b border-surface-800">
          <div>
            <h2 className="font-display font-bold text-xl text-white">Managed Experiences</h2>
            <p className="text-xs text-slate-400">Monitor sales windows, inventory locks, and door scanners</p>
          </div>
          <Link
            to="/organizer/events/new"
            className="text-xs font-mono text-brand-neon hover:underline font-bold uppercase"
          >
            + New Event Draft
          </Link>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-900/60 text-slate-400 text-xs font-mono uppercase tracking-wider border-b border-surface-800">
              <tr>
                <th className="px-6 py-4">Event Details</th>
                <th className="px-6 py-4">Status</th>
                <th className="px-6 py-4">Inventory Sold</th>
                <th className="px-6 py-4">Gross Revenue</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-800">
              {organizerEvents.map((evt) => {
                const percentage = Math.round((evt.sold / evt.capacity) * 100);
                return (
                  <tr key={evt.id} className="hover:bg-surface-900/40 transition-colors">
                    <td className="px-6 py-5">
                      <div className="font-bold text-white text-base">{evt.title}</div>
                      <div className="text-xs text-slate-400 flex items-center gap-2 mt-1">
                        <span>{evt.date}</span>
                        <span>•</span>
                        <span>{evt.city}</span>
                        <span>•</span>
                        <span className="font-mono text-brand-neon">{evt.category}</span>
                      </div>
                    </td>

                    <td className="px-6 py-5">
                      <span className="px-3 py-1 rounded-full text-[11px] font-mono uppercase tracking-wider font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        {evt.status}
                      </span>
                    </td>

                    <td className="px-6 py-5">
                      <div className="space-y-1.5 w-48">
                        <div className="flex justify-between text-xs font-mono">
                          <span className="text-white font-bold">{evt.sold} sold</span>
                          <span className="text-slate-400">/ {evt.capacity}</span>
                        </div>
                        <div className="w-full h-1.5 rounded-full bg-surface-800 overflow-hidden">
                          <div
                            className="h-full bg-brand-neon rounded-full"
                            style={{ width: `${percentage}%` }}
                          />
                        </div>
                      </div>
                    </td>

                    <td className="px-6 py-5 font-mono font-bold text-white text-base">
                      {evt.revenue}
                    </td>

                    <td className="px-6 py-5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Link
                          to={`/events/${evt.slug}`}
                          className="p-2 rounded-lg bg-surface-850 hover:bg-surface-800 text-slate-300 hover:text-white border border-surface-700"
                          title="View Public Page"
                        >
                          <Eye className="w-4 h-4" />
                        </Link>
                        <Link
                          to="/scanner"
                          className="p-2 rounded-lg bg-surface-850 hover:bg-surface-800 text-brand-neon hover:text-brand-neon border border-surface-700"
                          title="Open Check-In Scanner"
                        >
                          <QrCode className="w-4 h-4" />
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
