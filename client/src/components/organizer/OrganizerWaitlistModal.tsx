import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Clock, Users, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { OrganizerEventItem } from '../../types';

export interface OrganizerWaitlistModalProps {
  isOpen: boolean;
  onClose: () => void;
  event: OrganizerEventItem | null;
}

export const OrganizerWaitlistModal: React.FC<OrganizerWaitlistModalProps> = ({
  isOpen,
  onClose,
  event,
}) => {
  if (!isOpen || !event) return null;

  const {
    data,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['organizer-waitlist', event.id],
    queryFn: () => api.organizer.getWaitlist(event.id),
    enabled: Boolean(event.id),
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'WAITING':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-blue-50 text-blue-700 border border-blue-200">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
            Waiting
          </span>
        );
      case 'OFFERED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-amber-50 text-amber-800 border border-amber-300">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            Offered
          </span>
        );
      case 'PURCHASED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-emerald-50 text-emerald-800 border border-emerald-300">
            <CheckCircle2 className="w-3 h-3 text-emerald-600" />
            Fulfilled
          </span>
        );
      case 'EXPIRED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-rose-50 text-rose-700 border border-rose-200">
            Expired
          </span>
        );
      case 'DECLINED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-stone-100 text-stone-600 border border-stone-200">
            Declined
          </span>
        );
      case 'CANCELLED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-stone-100 text-stone-500 border border-stone-200">
            Cancelled
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-stone-100 text-stone-600">
            {status}
          </span>
        );
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[90vh] bg-white rounded-2xl border border-stone-200 shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-100 bg-[#FAF8F5]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-stone-900 text-white flex items-center justify-center shadow-2xs">
              <Clock className="w-4 h-4 text-amber-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-display font-bold text-base text-stone-900">
                  Event Waitlist
                </h3>
                <span className="text-xs text-stone-400">·</span>
                <span className="text-xs text-stone-600 font-sans truncate max-w-[280px]">
                  {event.title}
                </span>
              </div>
              <p className="text-[11px] text-stone-500 font-mono">
                Automated FIFO queue &amp; purchase offer tracking
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="p-2 rounded-lg text-stone-500 hover:text-stone-900 hover:bg-stone-100 transition-colors cursor-pointer"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin text-stone-900' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {isLoading ? (
            <div className="p-16 text-center space-y-3">
              <RefreshCw className="w-6 h-6 animate-spin text-stone-700 mx-auto" />
              <div className="text-xs font-mono text-stone-500 uppercase tracking-wider">
                Loading waitlist metrics...
              </div>
            </div>
          ) : error ? (
            <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>Failed to load waitlist data. Please ensure you are authorized.</span>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <h4 className="text-xs font-mono uppercase font-bold text-stone-700 tracking-wider">
                  Tier Queues &amp; Allocations
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {data?.tierSummaries.map((tier) => (
                    <div
                      key={tier.tierId}
                      className="p-3.5 rounded-xl border border-stone-200 bg-[#FAF8F5] space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-display font-bold text-sm text-stone-900 truncate">
                          {tier.tierName}
                        </span>
                        {tier.waitlistEnabled ? (
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-amber-50 text-amber-800 border border-amber-300 font-bold">
                            Enabled
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-stone-100 text-stone-500 font-bold">
                            Disabled
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-3 gap-1 pt-1 text-center font-mono">
                        <div className="p-1.5 rounded-lg bg-white border border-stone-100">
                          <div className="text-[10px] text-stone-500">Waiting</div>
                          <div className="font-bold text-xs text-blue-700">{tier.waitingCount}</div>
                        </div>
                        <div className="p-1.5 rounded-lg bg-white border border-stone-100">
                          <div className="text-[10px] text-stone-500">Offered</div>
                          <div className="font-bold text-xs text-amber-700">{tier.offeredCount}</div>
                        </div>
                        <div className="p-1.5 rounded-lg bg-white border border-stone-100">
                          <div className="text-[10px] text-stone-500">Fulfilled</div>
                          <div className="font-bold text-xs text-emerald-700">{tier.purchasedCount}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-mono uppercase font-bold text-stone-700 tracking-wider">
                    Registrations ({data?.entries.length || 0})
                  </h4>
                  <span className="text-[11px] text-stone-500 font-sans">
                    Ordered by FIFO registration time
                  </span>
                </div>

                {!data?.entries.length ? (
                  <div className="p-8 text-center rounded-xl bg-stone-50 border border-stone-200 space-y-2">
                    <Users className="w-8 h-8 text-stone-400 mx-auto" />
                    <div className="text-xs font-bold text-stone-700">No waitlist entries yet</div>
                    <p className="text-[11px] text-stone-500 max-w-sm mx-auto">
                      Fans will appear here once ticket tiers sell out and customers join the queue.
                    </p>
                  </div>
                ) : (
                  <div className="bg-white rounded-xl border border-stone-200 overflow-hidden shadow-2xs">
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs border-collapse">
                        <thead className="bg-[#FAF8F5] text-stone-500 font-mono uppercase text-[10px] tracking-wider border-b border-stone-200">
                          <tr>
                            <th className="px-4 py-3">Customer</th>
                            <th className="px-4 py-3">Tier</th>
                            <th className="px-4 py-3">Qty</th>
                            <th className="px-4 py-3">Status</th>
                            <th className="px-4 py-3">Registered</th>
                            <th className="px-4 py-3">Offer Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-stone-100">
                          {data.entries.map((entry) => {
                            const latestOffer = entry.offers?.[entry.offers.length - 1];
                            return (
                              <tr key={entry.id} className="hover:bg-stone-50/70">
                                <td className="px-4 py-3 align-middle">
                                  <div className="font-semibold text-stone-900">
                                    {entry.customerName}
                                  </div>
                                  <div className="text-[11px] text-stone-500 font-mono">
                                    {entry.customerEmail}
                                  </div>
                                </td>
                                <td className="px-4 py-3 align-middle font-medium text-stone-800">
                                  {entry.ticketTier.name}
                                </td>
                                <td className="px-4 py-3 align-middle font-mono font-bold text-stone-900">
                                  {entry.quantity}
                                </td>
                                <td className="px-4 py-3 align-middle">
                                  {getStatusBadge(entry.status)}
                                </td>
                                <td className="px-4 py-3 align-middle font-mono text-[11px] text-stone-500">
                                  {new Date(entry.createdAt).toLocaleDateString()}{' '}
                                  {new Date(entry.createdAt).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}
                                </td>
                                <td className="px-4 py-3 align-middle text-[11px] font-mono">
                                  {latestOffer ? (
                                    <div className="space-y-0.5">
                                      <span className="font-bold text-stone-800">
                                        {latestOffer.status}
                                      </span>
                                      {latestOffer.status === 'PENDING' && (
                                        <div className="text-[10px] text-amber-700">
                                          Expires {new Date(latestOffer.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </div>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-stone-400">—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-3 border-t border-stone-200 bg-[#FAF8F5] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono font-bold uppercase tracking-wider transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
