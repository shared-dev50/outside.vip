import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { 
  CheckCircle2, 
  Calendar, 
  MapPin, 
  Ticket as TicketIcon, 
  Download, 
  ArrowLeft
} from 'lucide-react';

export const OrderConfirmationPage: React.FC = () => {
  const { orderNumber = 'OUT-2026-89412' } = useParams<{ orderNumber: string }>();

  // Sample confirmed order data matching the seed
  const order = {
    orderNumber,
    eventTitle: 'SOL FEST: Under The Baobab Tree',
    date: 'Sat, Oct 24, 2026 · 2:00 PM',
    venue: 'The Baobab Amphitheatre, Kilifi',
    customerName: 'Alex Mwangi',
    customerEmail: 'alex@outside.vip',
    total: '$240.00',
    tickets: [
      {
        id: '1',
        token: 'tkt_sec_7a9f2e3b8c1d4e5f',
        tier: 'VIP Creek Terrace',
        attendee: 'Alex Mwangi',
        status: 'ISSUED',
      },
      {
        id: '2',
        token: 'tkt_sec_1d8c4e5f7a9f2e3b',
        tier: 'VIP Creek Terrace',
        attendee: 'Zainab Wanjiru',
        status: 'CHECKED_IN',
      },
    ],
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-12 space-y-10">
      <div>
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Experiences
        </Link>
      </div>

      {/* Confirmation Banner */}
      <div className="p-8 rounded-3xl glass-panel text-center space-y-4 border-emerald-500/30">
        <div className="w-16 h-16 rounded-full bg-emerald-500/20 text-emerald-400 mx-auto flex items-center justify-center border border-emerald-500/40 shadow-neon-sm">
          <CheckCircle2 className="w-8 h-8" />
        </div>
        <div className="space-y-1">
          <h1 className="font-display font-black text-3xl text-white">
            Order Confirmed & Secured
          </h1>
          <p className="text-sm text-slate-400">
            Official pass issued for Outside.vip order{' '}
            <span className="font-mono text-brand-neon font-bold">{order.orderNumber}</span>
          </p>
        </div>
        <div className="text-xs text-slate-400 font-mono">
          Confirmation sent to <span className="text-white">{order.customerEmail}</span>
        </div>
      </div>

      {/* Digital Ticket Passes */}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="font-display font-bold text-xl text-white flex items-center gap-2">
            <TicketIcon className="w-5 h-5 text-brand-neon" />
            Your Digital Admissions ({order.tickets.length})
          </h2>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-2 text-xs font-mono uppercase text-slate-400 hover:text-white transition-colors"
          >
            <Download className="w-4 h-4" />
            Print Passes
          </button>
        </div>

        {order.tickets.map((tkt, idx) => (
          <div
            key={tkt.id}
            className="rounded-3xl glass-panel overflow-hidden border border-surface-700/80 shadow-2xl relative"
          >
            <div className="grid grid-cols-1 md:grid-cols-12 divide-y md:divide-y-0 md:divide-x divide-surface-800">
              {/* Ticket Left Info */}
              <div className="p-6 md:p-8 md:col-span-8 space-y-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-display font-black text-lg text-white">
                      OUTSIDE<span className="text-brand-neon">.VIP</span>
                    </span>
                    <span className="text-[10px] font-mono uppercase text-slate-400 px-2 py-0.5 rounded bg-surface-900 border border-surface-800">
                      Pass #{idx + 1}
                    </span>
                  </div>

                  <span
                    className={`px-3 py-1 rounded-full text-[10px] font-mono uppercase tracking-wider font-bold ${
                      tkt.status === 'CHECKED_IN'
                        ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                        : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    }`}
                  >
                    {tkt.status === 'CHECKED_IN' ? 'Admitted / Used' : 'Ready for Door'}
                  </span>
                </div>

                <div className="space-y-2">
                  <h3 className="font-display font-black text-2xl text-white">
                    {order.eventTitle}
                  </h3>
                  <div className="space-y-1 text-xs text-slate-400">
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-brand-neon" />
                      <span>{order.date}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-brand-neon" />
                      <span>{order.venue}</span>
                    </div>
                  </div>
                </div>

                <div className="pt-4 border-t border-surface-800 flex items-center justify-between">
                  <div>
                    <span className="text-[10px] font-mono uppercase text-slate-400 block">
                      Attendee
                    </span>
                    <span className="font-bold text-white text-sm">{tkt.attendee}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] font-mono uppercase text-slate-400 block">
                      Tier
                    </span>
                    <span className="font-bold text-brand-neon text-sm font-mono">{tkt.tier}</span>
                  </div>
                </div>
              </div>

              {/* Ticket Right QR Pass */}
              <div className="p-6 md:p-8 md:col-span-4 bg-surface-900/60 flex flex-col items-center justify-center text-center space-y-3">
                {/* Visual QR Code Display */}
                <div className="p-3 rounded-2xl bg-white shadow-xl">
                  {/* Clean SVG QR pattern */}
                  <svg
                    viewBox="0 0 100 100"
                    className="w-28 h-28"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <rect width="100" height="100" fill="white" />
                    {/* Corners */}
                    <rect x="10" y="10" width="25" height="25" stroke="black" strokeWidth="5" />
                    <rect x="17" y="17" width="11" height="11" fill="black" />
                    <rect x="65" y="10" width="25" height="25" stroke="black" strokeWidth="5" />
                    <rect x="72" y="17" width="11" height="11" fill="black" />
                    <rect x="10" y="65" width="25" height="25" stroke="black" strokeWidth="5" />
                    <rect x="17" y="72" width="11" height="11" fill="black" />
                    {/* Center matrix dots */}
                    <rect x="42" y="15" width="6" height="6" fill="black" />
                    <rect x="52" y="15" width="6" height="6" fill="black" />
                    <rect x="42" y="25" width="6" height="6" fill="black" />
                    <rect x="15" y="42" width="6" height="6" fill="black" />
                    <rect x="25" y="42" width="6" height="6" fill="black" />
                    <rect x="45" y="45" width="10" height="10" fill="black" />
                    <rect x="65" y="45" width="6" height="6" fill="black" />
                    <rect x="75" y="45" width="6" height="6" fill="black" />
                    <rect x="42" y="65" width="6" height="6" fill="black" />
                    <rect x="52" y="75" width="6" height="6" fill="black" />
                    <rect x="65" y="65" width="6" height="6" fill="black" />
                    <rect x="75" y="75" width="6" height="6" fill="black" />
                    <rect x="85" y="65" width="6" height="6" fill="black" />
                  </svg>
                </div>

                <div className="space-y-1">
                  <span className="text-[10px] font-mono text-slate-500 block">
                    Security Token
                  </span>
                  <span className="text-xs font-mono font-bold text-slate-300">
                    {tkt.token}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
