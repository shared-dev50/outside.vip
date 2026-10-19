import React from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { 
  CheckCircle2, 
  Calendar, 
  MapPin, 
  Ticket as TicketIcon, 
  Download, 
  ArrowLeft,
  AlertCircle,
  Clock
} from 'lucide-react';
import { api } from '../lib/api';

export const OrderConfirmationPage: React.FC = () => {
  const { orderNumber } = useParams<{ orderNumber: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['order', orderNumber, token],
    queryFn: () => api.orders.getByOrderNumber(orderNumber!, token),
    enabled: Boolean(orderNumber),
    refetchInterval: (query) => {
      const status = query.state.data?.order?.status;
      return status === 'PENDING' ? 2000 : false;
    },
    retry: 2,
  });

  const order = data?.order;

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(d);
  };

  const formatPrice = (cents?: number, currency = 'USD') => {
    if (cents === undefined || cents === 0) return 'Free';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  };

  // 1. Loading State
  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 space-y-8 animate-pulse">
        <div className="h-4 w-28 bg-gray-200 rounded" />
        <div className="p-8 rounded-2xl bg-white border border-gray-200 shadow-sm space-y-4 text-center">
          <div className="w-14 h-14 rounded-full bg-gray-200 mx-auto" />
          <div className="h-8 w-64 bg-gray-200 mx-auto rounded" />
          <div className="h-4 w-48 bg-gray-200 mx-auto rounded" />
        </div>
        <div className="space-y-4">
          <div className="h-48 bg-white border border-gray-200 rounded-2xl" />
        </div>
      </div>
    );
  }

  // 2. Error / Unauthorized State
  if (error || !order) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center space-y-4">
        <div className="w-12 h-12 rounded-full bg-rose-50 text-rose-600 mx-auto flex items-center justify-center border border-rose-200">
          <AlertCircle className="w-6 h-6" />
        </div>
        <h1 className="font-display font-bold text-2xl text-gray-900">
          Access Restricted or Order Not Found
        </h1>
        <p className="text-gray-500 text-xs leading-relaxed">
          We could not load details for order <span className="font-mono text-gray-800 font-bold">{orderNumber}</span>. Please verify that you are accessing this page using the direct link provided in your checkout confirmation or email receipt.
        </p>
        <div className="pt-2 flex items-center justify-center gap-3">
          <Link
            to="/events"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gray-900 text-white font-medium text-xs hover:bg-black transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to discover
          </Link>
          <button
            onClick={() => refetch()}
            className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 text-xs font-medium"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const isConfirmed = order.status === 'COMPLETED';
  const isPending = order.status === 'PENDING';
  const tickets = order.tickets || [];

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
        <div
          className={`w-14 h-14 rounded-full mx-auto flex items-center justify-center border ${
            isConfirmed
              ? 'bg-emerald-50 text-emerald-600 border-emerald-200'
              : isPending
              ? 'bg-amber-50 text-amber-600 border-amber-200'
              : 'bg-gray-50 text-gray-600 border-gray-200'
          }`}
        >
          {isConfirmed ? (
            <CheckCircle2 className="w-7 h-7" />
          ) : (
            <Clock className="w-7 h-7 animate-spin" />
          )}
        </div>
        <div className="space-y-1">
          <h1 className="font-display font-bold text-2xl sm:text-3xl text-gray-900">
            {isConfirmed
              ? 'Order Confirmed & Secured'
              : isPending
              ? 'Payment Processing'
              : `Order ${order.status}`}
          </h1>
          <p className="text-sm text-gray-600">
            {isConfirmed
              ? `Official pass issued for Outside.vip order `
              : 'Awaiting webhook verification for Outside.vip order '}
            <span className="font-mono text-gray-900 font-bold">{order.orderNumber}</span>
          </p>
        </div>
        <div className="text-xs text-gray-500 font-mono">
          Receipt and pass details sent to{' '}
          <span className="text-gray-900 font-medium">{order.customerEmail}</span> · Total:{' '}
          <span className="font-bold text-gray-900">
            {formatPrice(order.totalInCents, order.currency)}
          </span>
        </div>
      </div>

      {/* Digital Ticket Passes */}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="font-display font-bold text-xl text-gray-900 flex items-center gap-2">
            <TicketIcon className="w-5 h-5 text-gray-700" />
            Your Digital Admissions ({tickets.length})
          </h2>
          {tickets.length > 0 && (
            <button
              onClick={() => window.print()}
              className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-gray-600 hover:text-gray-900 transition-colors font-semibold px-3 py-1.5 rounded-lg border border-gray-200 hover:border-gray-300"
            >
              <Download className="w-4 h-4" />
              Print Passes
            </button>
          )}
        </div>

        {tickets.length === 0 && isPending && (
          <div className="p-8 rounded-2xl bg-white border border-gray-200 text-center space-y-3">
            <Clock className="w-6 h-6 text-amber-500 mx-auto animate-pulse" />
            <div className="font-bold text-sm text-gray-900">Payment in transit</div>
            <p className="text-xs text-gray-500 max-w-sm mx-auto">
              Your ticket passes are generating automatically as soon as Stripe verifies payment completion.
            </p>
            <div className="pt-1">
              <button
                type="button"
                onClick={() => refetch()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 text-xs font-medium transition-colors shadow-sm"
              >
                Check status now
              </button>
            </div>
          </div>
        )}

        {tickets.map((tkt, idx) => (
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
                    {order.event?.title || 'Outside.vip Event Pass'}
                  </h3>
                  <div className="space-y-1 text-xs text-gray-500">
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-gray-400" />
                      <span>{formatDate(order.event?.startAt)}</span>
                    </div>
                    {order.event?.venueName && (
                      <div className="flex items-center gap-2">
                        <MapPin className="w-4 h-4 text-gray-400" />
                        <span>
                          {order.event.venueName}, {order.event.city}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="pt-4 border-t border-gray-100 flex items-center justify-between">
                  <div>
                    <span className="text-[10px] font-mono uppercase text-gray-400 block">
                      Attendee
                    </span>
                    <span className="font-bold text-gray-900 text-sm">
                      {tkt.attendeeName || order.customerName}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] font-mono uppercase text-gray-400 block">
                      Tier
                    </span>
                    <span className="font-bold text-gray-900 text-sm font-mono">
                      {tkt.ticketTier?.name || 'Standard Pass'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Ticket Right QR Pass */}
              <div className="p-6 md:p-8 md:col-span-4 bg-gray-50 flex flex-col items-center justify-center text-center space-y-3">
                {/* Visual QR Code Display */}
                <div className="p-3 rounded-xl bg-white border border-gray-200 shadow-sm">
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
                  <span className="text-xs font-mono font-bold text-gray-800 break-all px-2">
                    {tkt.ticketToken}
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

export default OrderConfirmationPage;
