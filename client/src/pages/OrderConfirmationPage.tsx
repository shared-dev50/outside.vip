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
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 space-y-8">
      <div>
        <Link
          to="/events"
          className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-900 transition-colors font-medium"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Discover
        </Link>
      </div>

      {/* Confirmation Banner */}
      <div className="p-8 rounded-2xl bg-white border border-gray-200 shadow-sm text-center space-y-3">
        <div className="w-14 h-14 rounded-full bg-emerald-50 text-emerald-600 mx-auto flex items-center justify-center border border-emerald-200">
          <CheckCircle2 className="w-7 h-7" />
        </div>
        <div className="space-y-1">
          <h1 className="font-display font-bold text-2xl sm:text-3xl text-gray-900">
            Order Confirmed & Secured
          </h1>
          <p className="text-sm text-gray-600">
            Official pass issued for Outside.vip order{' '}
            <span className="font-mono text-gray-900 font-bold">{order.orderNumber}</span>
          </p>
        </div>
        <div className="text-xs text-gray-500 font-mono">
          Confirmation sent to <span className="text-gray-900 font-medium">{order.customerEmail}</span>
        </div>
      </div>

      {/* Digital Ticket Passes */}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="font-display font-bold text-xl text-gray-900 flex items-center gap-2">
            <TicketIcon className="w-5 h-5 text-gray-700" />
            Your Digital Admissions ({order.tickets.length})
          </h2>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-gray-600 hover:text-gray-900 transition-colors font-semibold px-3 py-1.5 rounded-lg border border-gray-200 hover:border-gray-300"
          >
            <Download className="w-4 h-4" />
            Print Passes
          </button>
        </div>

        {order.tickets.map((tkt, idx) => (
          <div
            key={tkt.id}
            className="rounded-2xl bg-white border border-gray-200 shadow-sm overflow-hidden"
          >
            <div className="grid grid-cols-1 md:grid-cols-12 divide-y md:divide-y-0 md:divide-x divide-gray-200">
              {/* Ticket Left Info */}
              <div className="p-6 md:p-8 md:col-span-8 space-y-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-display font-bold text-base text-gray-900">
                      outside<span className="text-gray-400">.vip</span>
                    </span>
                    <span className="text-[10px] font-mono uppercase text-gray-500 px-2 py-0.5 rounded bg-gray-100 border border-gray-200">
                      Pass #{idx + 1}
                    </span>
                  </div>

                  <span
                    className={`px-3 py-1 rounded-full text-[10px] font-mono uppercase tracking-wider font-bold ${
                      tkt.status === 'CHECKED_IN'
                        ? 'bg-amber-50 text-amber-700 border border-amber-200'
                        : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                    }`}
                  >
                    {tkt.status === 'CHECKED_IN' ? 'Admitted / Used' : 'Ready for Door'}
                  </span>
                </div>

                <div className="space-y-2">
                  <h3 className="font-display font-bold text-xl sm:text-2xl text-gray-900">
                    {order.eventTitle}
                  </h3>
                  <div className="space-y-1 text-xs text-gray-500">
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-gray-400" />
                      <span>{order.date}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-gray-400" />
                      <span>{order.venue}</span>
                    </div>
                  </div>
                </div>

                <div className="pt-4 border-t border-gray-100 flex items-center justify-between">
                  <div>
                    <span className="text-[10px] font-mono uppercase text-gray-400 block">
                      Attendee
                    </span>
                    <span className="font-bold text-gray-900 text-sm">{tkt.attendee}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] font-mono uppercase text-gray-400 block">
                      Tier
                    </span>
                    <span className="font-bold text-gray-900 text-sm font-mono">{tkt.tier}</span>
                  </div>
                </div>
              </div>

              {/* Ticket Right QR Pass */}
              <div className="p-6 md:p-8 md:col-span-4 bg-gray-50 flex flex-col items-center justify-center text-center space-y-3">
                {/* Visual QR Code Display */}
                <div className="p-3 rounded-xl bg-white border border-gray-200 shadow-sm">
                  {/* Clean SVG QR pattern */}
                  <svg
                    viewBox="0 0 100 100"
                    className="w-28 h-28"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <rect width="100" height="100" fill="white" />
                    {/* Corners */}
                    <rect x="10" y="10" width="25" height="25" stroke="#111827" strokeWidth="5" />
                    <rect x="17" y="17" width="11" height="11" fill="#111827" />
                    <rect x="65" y="10" width="25" height="25" stroke="#111827" strokeWidth="5" />
                    <rect x="72" y="17" width="11" height="11" fill="#111827" />
                    <rect x="10" y="65" width="25" height="25" stroke="#111827" strokeWidth="5" />
                    <rect x="17" y="72" width="11" height="11" fill="#111827" />
                    {/* Center matrix dots */}
                    <rect x="42" y="15" width="6" height="6" fill="#111827" />
                    <rect x="52" y="15" width="6" height="6" fill="#111827" />
                    <rect x="42" y="25" width="6" height="6" fill="#111827" />
                    <rect x="15" y="42" width="6" height="6" fill="#111827" />
                    <rect x="25" y="42" width="6" height="6" fill="#111827" />
                    <rect x="45" y="45" width="10" height="10" fill="#111827" />
                    <rect x="65" y="45" width="6" height="6" fill="#111827" />
                    <rect x="75" y="45" width="6" height="6" fill="#111827" />
                    <rect x="42" y="65" width="6" height="6" fill="#111827" />
                    <rect x="52" y="75" width="6" height="6" fill="#111827" />
                    <rect x="65" y="65" width="6" height="6" fill="#111827" />
                    <rect x="75" y="75" width="6" height="6" fill="#111827" />
                    <rect x="85" y="65" width="6" height="6" fill="#111827" />
                  </svg>
                </div>

                <div className="space-y-1">
                  <span className="text-[10px] font-mono text-gray-500 block">
                    Security Token
                  </span>
                  <span className="text-xs font-mono font-bold text-gray-800">
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
