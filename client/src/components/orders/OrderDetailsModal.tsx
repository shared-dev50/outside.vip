import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  Clock,
  Info,
  Loader2,
  Mail,
  Phone,
  RefreshCw,
  RotateCcw,
  Ticket as TicketIcon,
  User as UserIcon,
  X,
} from 'lucide-react';
import { api } from '../../lib/api';
import {
  OrderRefundStatus,
  OrderStatus,
  OrganizerOrderItem,
  TicketStatus,
} from '../../types';

interface OrderDetailsModalProps {
  order: OrganizerOrderItem;
  onClose: () => void;
  onStartRefund: (orderId: string) => void;
}

function formatMoney(cents: number, currency: string): string {
  const code = (currency || 'USD').toUpperCase();
  if (cents === 0) return 'FREE';
  return `${(cents / 100).toFixed(2)} ${code}`;
}

function formatCentsExact(cents: number, currency: string): string {
  const code = (currency || 'USD').toUpperCase();
  return `${(cents / 100).toFixed(2)} ${code}`;
}

function orderStatusMeta(status: OrderStatus): { label: string; className: string } {
  switch (status) {
    case 'COMPLETED':
      return { label: 'Paid', className: 'bg-emerald-50 text-emerald-800 border-emerald-200' };
    case 'PENDING':
      return { label: 'Pending Payment', className: 'bg-amber-50 text-amber-800 border-amber-200' };
    case 'REFUNDED':
      return { label: 'Refunded', className: 'bg-rose-50 text-rose-800 border-rose-200' };
    case 'CANCELLED':
      return { label: 'Cancelled', className: 'bg-stone-100 text-stone-700 border-stone-300' };
    case 'EXPIRED':
      return { label: 'Expired', className: 'bg-stone-100 text-stone-600 border-stone-200' };
    default:
      return { label: status, className: 'bg-stone-100 text-stone-700 border-stone-200' };
  }
}

function ticketStatusMeta(status: TicketStatus): { label: string; className: string } {
  switch (status) {
    case 'ISSUED':
      return { label: 'Issued', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
    case 'CHECKED_IN':
      return { label: 'Checked In', className: 'bg-sky-50 text-sky-700 border-sky-200' };
    case 'REFUND_PENDING':
      return { label: 'Refund Pending', className: 'bg-amber-50 text-amber-800 border-amber-300' };
    case 'REFUNDED':
      return { label: 'Refunded', className: 'bg-rose-50 text-rose-700 border-rose-200' };
    case 'CANCELLED':
      return { label: 'Cancelled', className: 'bg-stone-100 text-stone-700 border-stone-300' };
    default:
      return { label: status, className: 'bg-stone-100 text-stone-700 border-stone-200' };
  }
}

function refundStatusMeta(status: OrderRefundStatus): { label: string; className: string } {
  switch (status) {
    case 'SUCCEEDED':
      return { label: 'Succeeded', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
    case 'PENDING':
      return { label: 'Queued', className: 'bg-amber-50 text-amber-800 border-amber-200' };
    case 'PROCESSING':
    case 'STRIPE_PENDING':
      return { label: 'Stripe Pending', className: 'bg-sky-50 text-sky-700 border-sky-200' };
    case 'MANUAL_REVIEW_REQUIRED':
      return { label: 'Manual Review', className: 'bg-rose-50 text-rose-700 border-rose-300' };
    case 'MANUALLY_RESOLVED':
      return { label: 'Resolved', className: 'bg-stone-100 text-stone-700 border-stone-300' };
    case 'CANCELLED':
      return { label: 'Cancelled', className: 'bg-stone-100 text-stone-600 border-stone-300' };
    default:
      return { label: status, className: 'bg-stone-100 text-stone-700 border-stone-200' };
  }
}

export const OrderDetailsModal: React.FC<OrderDetailsModalProps> = ({
  order,
  onClose,
  onStartRefund,
}) => {
  const canManageRefunds = Boolean(order.canManageRefunds);

  const {
    data: refundSummary,
    isLoading: isLoadingRefundSummary,
    error: refundSummaryError,
    refetch: refetchSummary,
  } = useQuery({
    queryKey: ['order-refund-summary', order.id],
    queryFn: () => api.organizer.getOrderRefunds(order.id),
    enabled: canManageRefunds,
    retry: false,
  });

  const effectiveStatus = refundSummary?.order.status ?? order.status;
  const currency = (refundSummary?.order.currency ?? order.currency ?? 'USD').toUpperCase();
  const totalInCents = refundSummary?.order.totalInCents ?? order.totalInCents;
  const refundedInCents =
    refundSummary?.order.refundedAmountInCents ?? order.refundedAmountInCents ?? 0;
  const pendingRefundInCents =
    refundSummary?.order.pendingRefundAmountInCents ?? order.pendingRefundAmountInCents ?? 0;
  const remainingRefundableInCents =
    refundSummary?.order.remainingRefundableInCents ??
    Math.max(0, totalInCents - refundedInCents - pendingRefundInCents);
  const isFreeOrder = refundSummary?.order.isFreeOrder ?? totalInCents === 0;
  const canOverrideCheckedIn = Boolean(refundSummary?.capabilities.canOverrideCheckedIn);

  const ticketStats = useMemo(() => {
    const tickets = refundSummary?.tickets || [];
    const pendingCount = tickets.filter(
      (t) => t.status === 'REFUND_PENDING' || t.activeRefundLock
    ).length;
    const refundedCount = tickets.filter((t) => t.status === 'REFUNDED').length;
    const cancelledCount = tickets.filter((t) => t.status === 'CANCELLED').length;
    const checkedInCount = tickets.filter((t) => t.status === 'CHECKED_IN').length;
    const eligibleCount = tickets.filter((t) =>
      canOverrideCheckedIn ? t.refundEligibleForAdmin : t.refundEligibleForOrganizer
    ).length;

    return {
      totalCount: tickets.length,
      pendingCount,
      refundedCount,
      cancelledCount,
      checkedInCount,
      eligibleCount,
    };
  }, [refundSummary, canOverrideCheckedIn]);

  const ineligibilityReason = useMemo(() => {
    if (!canManageRefunds) {
      return 'Refund actions and individual ticket allocations are restricted to the event owner or platform administrators.';
    }
    if (isLoadingRefundSummary || refundSummaryError || !refundSummary) {
      return null;
    }
    if (ticketStats.eligibleCount > 0) {
      return null;
    }
    if (effectiveStatus === 'REFUNDED') {
      return 'All refundable tickets on this order have already been refunded.';
    }
    if (effectiveStatus !== 'COMPLETED') {
      return `Refunds can only be initiated on completed orders (current status: ${effectiveStatus.toLowerCase()}).`;
    }
    if (ticketStats.totalCount === 0) {
      return 'No issued tickets are attached to this order.';
    }
    if (ticketStats.pendingCount > 0 && ticketStats.pendingCount + ticketStats.refundedCount + ticketStats.cancelledCount >= ticketStats.totalCount) {
      return 'All remaining active tickets already have a refund in progress.';
    }
    if (ticketStats.checkedInCount > 0 && !canOverrideCheckedIn) {
      return 'Checked-in tickets cannot be refunded by organizers.';
    }
    return 'No eligible tickets remain for refund on this order.';
  }, [
    canManageRefunds,
    isLoadingRefundSummary,
    refundSummaryError,
    refundSummary,
    ticketStats,
    effectiveStatus,
    canOverrideCheckedIn,
  ]);

  const statusBadge = orderStatusMeta(effectiveStatus);
  const canClickRefundTickets =
    canManageRefunds && !isLoadingRefundSummary && Boolean(refundSummary) && ticketStats.eligibleCount > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-xs p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="order-details-modal-title"
    >
      <div className="bg-white border border-stone-200 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden">
        <div className="bg-white border-b border-stone-200 px-6 py-4 flex items-start justify-between gap-4 shrink-0">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2
                id="order-details-modal-title"
                className="font-display text-lg sm:text-xl font-extrabold text-stone-900 tracking-tight"
              >
                Order #{order.orderNumber}
              </h2>
              <span
                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${statusBadge.className}`}
              >
                {statusBadge.label}
              </span>
            </div>
            <p className="text-xs text-stone-500">
              {order.event.title}
              {order.event.venueName ? ` · ${order.event.venueName}` : ''}
              {order.event.city ? `, ${order.event.city}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-stone-500 hover:bg-stone-100 hover:text-stone-900 transition-colors"
            aria-label="Close order details dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto flex-1">
          {/* Order Overview */}
          <section aria-label="Order overview" className="space-y-3">
            <h3 className="text-xs font-mono uppercase tracking-wider font-semibold text-stone-500">
              Order Overview
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-[#FAF8F5] border border-stone-200/90 rounded-xl p-4 text-xs">
              <div className="space-y-2.5">
                <div className="flex items-start gap-2">
                  <Calendar className="w-4 h-4 text-stone-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-stone-500">Order Date</div>
                    <div className="font-semibold text-stone-900">
                      {new Date(order.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <TicketIcon className="w-4 h-4 text-stone-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-stone-500">Event</div>
                    <div className="font-semibold text-stone-900">{order.event.title}</div>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-stone-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-stone-500">Original Payment Total</div>
                    <div className="font-mono font-bold text-sm text-stone-900">
                      {formatMoney(totalInCents, currency)}
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-2.5">
                <div className="flex items-start gap-2">
                  <UserIcon className="w-4 h-4 text-stone-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-stone-500">Customer Name</div>
                    <div className="font-semibold text-stone-900">{order.customerName}</div>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <Mail className="w-4 h-4 text-stone-400 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div className="text-stone-500">Customer Email</div>
                    <div className="font-medium text-stone-900 break-all">{order.customerEmail}</div>
                  </div>
                </div>
                {order.customerPhone && (
                  <div className="flex items-start gap-2">
                    <Phone className="w-4 h-4 text-stone-400 shrink-0 mt-0.5" />
                    <div>
                      <div className="text-stone-500">Customer Phone</div>
                      <div className="font-mono font-medium text-stone-900">
                        {order.customerPhone}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Refund Metrics Bar */}
          <section aria-label="Refund summary" className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="p-3.5 rounded-xl bg-white border border-stone-200">
              <span className="text-stone-500 block">Already Refunded</span>
              <strong className="text-sm font-mono text-rose-700 mt-0.5 block">
                {formatCentsExact(refundedInCents, currency)}
              </strong>
            </div>
            <div className="p-3.5 rounded-xl bg-white border border-stone-200">
              <span className="text-stone-500 block">Pending Refund</span>
              <strong className="text-sm font-mono text-amber-700 mt-0.5 block">
                {formatCentsExact(pendingRefundInCents, currency)}
              </strong>
              {refundSummary && (
                <span className="text-[11px] text-stone-500">
                  {ticketStats.pendingCount} ticket(s) pending
                </span>
              )}
            </div>
            <div className="p-3.5 rounded-xl bg-white border border-stone-200">
              <span className="text-stone-500 block">Eligible Tickets</span>
              <strong className="text-sm font-mono text-emerald-700 mt-0.5 block">
                {refundSummary ? ticketStats.eligibleCount : '—'}
              </strong>
              {refundSummary && (
                <span className="text-[11px] text-stone-500">
                  of {ticketStats.totalCount} ticket(s)
                </span>
              )}
            </div>
            <div className="p-3.5 rounded-xl bg-white border border-stone-200">
              <span className="text-stone-500 block">Remaining Refundable</span>
              <strong className="text-sm font-mono text-stone-900 mt-0.5 block">
                {formatCentsExact(remainingRefundableInCents, currency)}
              </strong>
            </div>
          </section>

          {/* Tickets Section */}
          <section aria-label="Order tickets" className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-mono uppercase tracking-wider font-semibold text-stone-500 flex items-center gap-1.5">
                <TicketIcon className="w-3.5 h-3.5" />
                Tickets ({refundSummary ? refundSummary.tickets.length : order.ticketsCount})
              </h3>
            </div>

            {!canManageRefunds && (
              <div className="divide-y divide-stone-200 border border-stone-200 rounded-xl overflow-hidden">
                {order.items.map((item) => (
                  <div
                    key={item.id}
                    className="px-4 py-3 flex items-center justify-between gap-3 text-xs bg-white"
                  >
                    <div>
                      <div className="font-semibold text-stone-900">{item.tierName}</div>
                      <div className="text-stone-500">
                        {item.quantity} × {formatMoney(item.unitPriceInCents, currency)}
                      </div>
                    </div>
                    <div className="font-mono font-semibold text-stone-900">
                      {formatMoney(item.subtotalInCents, currency)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {canManageRefunds && isLoadingRefundSummary && (
              <div className="flex items-center justify-center py-8 text-stone-500 gap-2 text-xs border border-stone-200 rounded-xl bg-stone-50/50">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading ticket details and refund history...
              </div>
            )}

            {canManageRefunds && refundSummaryError && (
              <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center justify-between gap-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    {(refundSummaryError as any)?.message ||
                      'Unable to load ticket and refund details.'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => refetchSummary()}
                  className="px-2.5 py-1 rounded-lg bg-white border border-rose-200 font-semibold text-rose-700 hover:bg-rose-100 shrink-0"
                >
                  Retry
                </button>
              </div>
            )}

            {canManageRefunds && refundSummary && (
              <>
                {refundSummary.tickets.length === 0 ? (
                  <div className="p-4 rounded-xl border border-dashed border-stone-200 text-xs text-stone-500 text-center">
                    No issued tickets exist on this order yet.
                  </div>
                ) : (
                  <div className="divide-y divide-stone-200 border border-stone-200 rounded-xl overflow-hidden">
                    {refundSummary.tickets.map((ticket) => {
                      const badge = ticketStatusMeta(ticket.status);
                      const isEligible = canOverrideCheckedIn
                        ? ticket.refundEligibleForAdmin
                        : ticket.refundEligibleForOrganizer;
                      const feeTotal =
                        ticket.allocatedPlatformFeeInCents +
                        ticket.allocatedServiceFeeInCents +
                        ticket.allocatedProcessingFeeInCents;

                      return (
                        <div
                          key={ticket.id}
                          className="px-4 py-3.5 bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                        >
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-stone-900">{ticket.tierName}</span>
                              <span className="font-mono text-[11px] text-stone-500">
                                #{ticket.ticketCode}
                              </span>
                              <span
                                className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold ${badge.className}`}
                              >
                                {badge.label}
                              </span>
                              {isEligible && (
                                <span className="px-2 py-0.5 rounded-full bg-stone-100 text-stone-700 border border-stone-200 text-[11px] font-medium">
                                  Eligible for Refund
                                </span>
                              )}
                            </div>

                            {(ticket.attendeeName || ticket.attendeeEmail) && (
                              <div className="text-stone-500">
                                {ticket.attendeeName || order.customerName}
                                {ticket.attendeeEmail ? ` (${ticket.attendeeEmail})` : ''}
                              </div>
                            )}

                            <div className="text-[11px] text-stone-500 flex flex-wrap items-center gap-3">
                              <span>
                                Check-in:{' '}
                                <strong className="font-medium text-stone-700">
                                  {ticket.checkedInAt
                                    ? `Checked in (${new Date(ticket.checkedInAt).toLocaleString()})`
                                    : 'Not checked in'}
                                </strong>
                              </span>
                              {ticket.refundedAt && (
                                <span className="text-rose-700">
                                  Refunded {new Date(ticket.refundedAt).toLocaleString()}
                                </span>
                              )}
                              {!isFreeOrder && (
                                <span>
                                  Allocation: {formatCentsExact(ticket.allocatedGrossInCents, currency)} +{' '}
                                  {formatCentsExact(feeTotal, currency)} fees
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="text-left sm:text-right shrink-0">
                            <div className="font-mono font-semibold text-stone-900">
                              {isFreeOrder
                                ? 'FREE'
                                : formatCentsExact(ticket.allocatedBuyerTotalInCents, currency)}
                            </div>
                            <div className="text-[11px] text-stone-400">Buyer allocation</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </section>

          {/* Refund History */}
          {canManageRefunds && refundSummary && (
            <section aria-label="Refund history" className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-mono uppercase tracking-wider font-semibold text-stone-500 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" />
                  Refund History
                </h3>
                <button
                  type="button"
                  onClick={() => refetchSummary()}
                  className="inline-flex items-center gap-1 text-xs font-medium text-stone-600 hover:text-stone-900"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Refresh
                </button>
              </div>

              {refundSummary.refunds.length === 0 ? (
                <p className="text-xs text-stone-500 border border-dashed border-stone-200 rounded-xl p-4 text-center">
                  No refund transactions recorded on this order yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {refundSummary.refunds.map((ref) => {
                    const badge = refundStatusMeta(ref.status);
                    return (
                      <div
                        key={ref.id}
                        className="border border-stone-200 rounded-xl p-3.5 text-xs space-y-1.5 bg-white"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-semibold text-stone-900">
                            {formatCentsExact(ref.amountInCents, ref.currency)} ·{' '}
                            <span className="font-mono text-[11px] text-stone-500">
                              {ref.ticketIds.length} ticket(s)
                            </span>
                          </div>
                          <span
                            className={`px-2 py-0.5 rounded-full border font-semibold ${badge.className}`}
                          >
                            {badge.label}
                          </span>
                        </div>
                        <div className="text-stone-600">
                          Reason: {ref.reason}
                          {ref.stripeRefundId && (
                            <span className="ml-2 font-mono text-stone-500">
                              ({ref.stripeRefundId})
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-stone-400">
                          Created {new Date(ref.createdAt).toLocaleString()}
                          {ref.succeededAt
                            ? ` · Completed ${new Date(ref.succeededAt).toLocaleString()}`
                            : ''}
                        </div>
                        {ref.requiresManualResolution && ref.lastErrorMessage && (
                          <div className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-1.5">
                            Manual review: {ref.lastErrorMessage}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {ineligibilityReason && (
            <div className="p-3.5 rounded-xl bg-stone-50 border border-stone-200 text-stone-700 text-xs flex items-start gap-2.5">
              <Info className="w-4 h-4 text-stone-500 shrink-0 mt-0.5" />
              <span>{ineligibilityReason}</span>
            </div>
          )}
        </div>

        <div className="bg-stone-50 border-t border-stone-200 px-6 py-3.5 flex flex-wrap items-center justify-end gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl border border-stone-300 bg-white hover:bg-stone-100 text-stone-700 text-xs font-semibold transition-colors"
          >
            Close
          </button>
          {canClickRefundTickets && (
            <button
              type="button"
              onClick={() => onStartRefund(order.id)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-semibold transition-colors shadow-xs"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Refund Tickets
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
