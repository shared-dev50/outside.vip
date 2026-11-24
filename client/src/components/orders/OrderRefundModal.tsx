import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Ticket as TicketIcon,
  X,
  XCircle,
} from 'lucide-react';
import { api } from '../../lib/api';
import {
  OrderRefundStatus,
  RefundQuotePreview,
  RefundSummaryTicket,
  TicketStatus,
} from '../../types';

interface OrderRefundModalProps {
  orderId: string;
  onClose: () => void;
  onRefundUpdated?: () => void;
}

function formatCents(cents: number, currency: string): string {
  const code = (currency || 'USD').toUpperCase();
  return `${(cents / 100).toFixed(2)} ${code}`;
}

function ticketStatusBadge(status: TicketStatus): { label: string; className: string } {
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

function refundStatusBadge(status: OrderRefundStatus): { label: string; className: string } {
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

export const OrderRefundModal: React.FC<OrderRefundModalProps> = ({
  orderId,
  onClose,
  onRefundUpdated,
}) => {
  const queryClient = useQueryClient();

  const [selectedTicketIds, setSelectedTicketIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [restoreInventory, setRestoreInventory] = useState(true);
  const [refundStripeProcessingFee, setRefundStripeProcessingFee] = useState(false);
  const [feeBearer, setFeeBearer] = useState<'ORGANIZER' | 'PLATFORM' | 'SHARED'>('ORGANIZER');
  const [allowCheckedInOverride, setAllowCheckedInOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [quotePreview, setQuotePreview] = useState<RefundQuotePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccessMessage, setSubmitSuccessMessage] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(
    () => `refund-ui-${orderId}-${crypto.randomUUID()}`
  );

  const {
    data: summary,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['order-refund-summary', orderId],
    queryFn: () => api.organizer.getOrderRefunds(orderId),
  });

  const canOverrideCheckedIn = Boolean(summary?.capabilities.canOverrideCheckedIn);
  const canShiftFeeToPlatform = Boolean(summary?.capabilities.canShiftFeeToPlatform);
  const isFreeOrder = Boolean(summary?.order.isFreeOrder);

  const selectedTickets = useMemo(() => {
    if (!summary) return [];
    const selectedSet = new Set(selectedTicketIds);
    return summary.tickets.filter((t) => selectedSet.has(t.id));
  }, [summary, selectedTicketIds]);

  const hasCheckedInSelected = useMemo(
    () => selectedTickets.some((t) => t.status === 'CHECKED_IN'),
    [selectedTickets]
  );

  // Clear checked-in override whenever admin deselects all checked-in tickets
  useEffect(() => {
    if (!hasCheckedInSelected && allowCheckedInOverride) {
      setAllowCheckedInOverride(false);
      setOverrideReason('');
    }
  }, [hasCheckedInSelected, allowCheckedInOverride]);

  // Automatic quote preview when valid selection & options change
  useEffect(() => {
    let active = true;

    if (!summary || selectedTicketIds.length === 0) {
      setQuotePreview(null);
      setPreviewError(null);
      return;
    }

    if (hasCheckedInSelected) {
      if (!canOverrideCheckedIn || !allowCheckedInOverride || overrideReason.trim().length < 5) {
        setQuotePreview(null);
        setPreviewError(
          canOverrideCheckedIn
            ? 'Enable ADMIN checked-in override and provide an override reason (min 5 characters) to preview checked-in tickets.'
            : 'Checked-in tickets cannot be refunded by organizers.'
        );
        return;
      }
    }

    setPreviewError(null);
    api.organizer
      .previewOrderRefund(orderId, {
        ticketIds: selectedTicketIds,
        refundStripeProcessingFee: isFreeOrder ? false : refundStripeProcessingFee,
        feeBearer: canShiftFeeToPlatform ? feeBearer : 'ORGANIZER',
        restoreInventory,
        allowCheckedInOverride: canOverrideCheckedIn ? allowCheckedInOverride : false,
        overrideReason:
          canOverrideCheckedIn && allowCheckedInOverride ? overrideReason.trim() : undefined,
      })
      .then((quote) => {
        if (active) {
          setQuotePreview(quote);
        }
      })
      .catch((err: any) => {
        if (active) {
          setQuotePreview(null);
          setPreviewError(err?.message || 'Unable to compute refund preview.');
        }
      });

    return () => {
      active = false;
    };
  }, [
    summary,
    orderId,
    selectedTicketIds,
    refundStripeProcessingFee,
    feeBearer,
    restoreInventory,
    allowCheckedInOverride,
    overrideReason,
    canOverrideCheckedIn,
    canShiftFeeToPlatform,
    hasCheckedInSelected,
    isFreeOrder,
  ]);

  const initiateMutation = useMutation({
    mutationFn: async () => {
      return api.organizer.initiateOrderRefund(orderId, {
        ticketIds: selectedTicketIds,
        reason: reason.trim(),
        refundStripeProcessingFee: isFreeOrder ? false : refundStripeProcessingFee,
        feeBearer: canShiftFeeToPlatform ? feeBearer : 'ORGANIZER',
        restoreInventory,
        allowCheckedInOverride: canOverrideCheckedIn ? allowCheckedInOverride : false,
        overrideReason:
          canOverrideCheckedIn && allowCheckedInOverride ? overrideReason.trim() : undefined,
        idempotencyKey,
        confirm: confirmChecked,
      });
    },
    onSuccess: async (res) => {
      setSubmitError(null);
      setConfirmChecked(false);
      setSelectedTicketIds([]);
      setReason('');
      setAllowCheckedInOverride(false);
      setOverrideReason('');
      setIdempotencyKey(`refund-ui-${orderId}-${crypto.randomUUID()}`);
      setSubmitSuccessMessage(
        res.mode === 'FREE_LOCAL_CANCELLED'
          ? `Cancelled ${res.cancelledTicketIds?.length || 0} free ticket(s) locally.`
          : res.replayed
          ? `Refund request #${res.orderRefundId} is already queued (${res.status}).`
          : `Refund queued (${formatCents(res.refundAmountInCents, res.currency)}). Confirmation emails send only after Stripe confirms completion.`
      );
      await refetch();
      await queryClient.invalidateQueries({ queryKey: ['organizer-orders'] });
      onRefundUpdated?.();
    },
    onError: (err: any) => {
      setSubmitSuccessMessage(null);
      setSubmitError(err?.message || 'Failed to initiate refund.');
    },
  });

  const toggleTicket = (ticket: RefundSummaryTicket) => {
    const canSelect = canOverrideCheckedIn
      ? ticket.refundEligibleForAdmin
      : ticket.refundEligibleForOrganizer;
    if (!canSelect) return;

    setSubmitError(null);
    setSubmitSuccessMessage(null);
    setConfirmChecked(false);
    setIdempotencyKey(`refund-ui-${orderId}-${crypto.randomUUID()}`);

    setSelectedTicketIds((prev) =>
      prev.includes(ticket.id) ? prev.filter((id) => id !== ticket.id) : [...prev, ticket.id]
    );
  };

  const canSubmit =
    Boolean(quotePreview) &&
    selectedTicketIds.length > 0 &&
    reason.trim().length >= 3 &&
    confirmChecked &&
    !initiateMutation.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="order-refund-modal-title"
    >
      <div className="bg-white border border-stone-200 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 z-10 bg-white border-b border-stone-200 px-6 py-4 flex items-center justify-between">
          <div>
            <h2 id="order-refund-modal-title" className="text-lg font-bold text-stone-900">
              {summary ? `Manage Refunds · Order #${summary.order.orderNumber}` : 'Manage Refunds'}
            </h2>
            {summary && (
              <p className="text-xs text-stone-500 mt-0.5">
                {summary.order.eventTitle} · {summary.order.customerName} ({summary.order.customerEmail})
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-stone-500 hover:bg-stone-100 hover:text-stone-900"
            aria-label="Close refund modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {isLoading && (
            <div className="flex items-center justify-center py-12 text-stone-500 gap-2 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading order tickets & refund history...
            </div>
          )}

          {error && (
            <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-sm flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{(error as any)?.message || 'Unable to load refund details for this order.'}</span>
            </div>
          )}

          {summary && (
            <>
              {/* Financial Summary Bar */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-stone-50 border border-stone-200 rounded-xl p-4 text-xs">
                <div>
                  <span className="text-stone-500 block">Order Paid Total</span>
                  <strong className="text-sm text-stone-900">
                    {formatCents(summary.order.totalInCents, summary.order.currency)}
                  </strong>
                </div>
                <div>
                  <span className="text-stone-500 block">Refunded</span>
                  <strong className="text-sm text-rose-700">
                    {formatCents(summary.order.refundedAmountInCents, summary.order.currency)}
                  </strong>
                </div>
                <div>
                  <span className="text-stone-500 block">Pending Refund</span>
                  <strong className="text-sm text-amber-700">
                    {formatCents(summary.order.pendingRefundAmountInCents, summary.order.currency)}
                  </strong>
                </div>
                <div>
                  <span className="text-stone-500 block">Remaining Refundable</span>
                  <strong className="text-sm text-emerald-700">
                    {formatCents(summary.order.remainingRefundableInCents, summary.order.currency)}
                  </strong>
                </div>
              </div>

              {submitSuccessMessage && (
                <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{submitSuccessMessage}</span>
                </div>
              )}

              {submitError && (
                <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2">
                  <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{submitError}</span>
                </div>
              )}

              {/* Ticket Selection */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-stone-900 flex items-center gap-1.5">
                    <TicketIcon className="w-4 h-4 text-stone-600" />
                    Select Individual Tickets
                  </h3>
                  <span className="text-xs text-stone-500">
                    {selectedTicketIds.length} selected
                  </span>
                </div>

                <div className="divide-y divide-stone-200 border border-stone-200 rounded-xl overflow-hidden">
                  {summary.tickets.map((ticket) => {
                    const selectable = canOverrideCheckedIn
                      ? ticket.refundEligibleForAdmin
                      : ticket.refundEligibleForOrganizer;
                    const checked = selectedTicketIds.includes(ticket.id);
                    const badge = ticketStatusBadge(ticket.status);

                    return (
                      <label
                        key={ticket.id}
                        className={`flex items-center justify-between gap-3 px-4 py-3 text-xs transition-colors ${
                          selectable ? 'cursor-pointer hover:bg-stone-50' : 'bg-stone-50/70 opacity-75 cursor-not-allowed'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!selectable}
                            onChange={() => toggleTicket(ticket)}
                            className="mt-0.5 h-4 w-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900"
                          />
                          <div>
                            <div className="font-semibold text-stone-900">
                              {ticket.tierName} · <span className="font-mono text-[11px]">{ticket.ticketCode}</span>
                            </div>
                            <div className="text-stone-500 mt-0.5">
                              {ticket.attendeeName || summary.order.customerName} ({ticket.attendeeEmail || summary.order.customerEmail})
                            </div>
                            {ticket.status === 'CHECKED_IN' && !canOverrideCheckedIn && (
                              <div className="text-[11px] text-amber-700 mt-1">
                                Checked-in tickets cannot be refunded by organizers.
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-3 shrink-0">
                          <span className="font-mono text-stone-700">
                            {isFreeOrder
                              ? 'FREE'
                              : formatCents(
                                  ticket.allocatedGrossInCents +
                                    ticket.allocatedPlatformFeeInCents +
                                    ticket.allocatedServiceFeeInCents,
                                  summary.order.currency
                                )}
                          </span>
                          <span className={`px-2 py-0.5 rounded-full border font-semibold ${badge.className}`}>
                            {badge.label}
                          </span>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Admin Checked-In Override Controls (never rendered for organizers) */}
              {canOverrideCheckedIn && hasCheckedInSelected && (
                <div className="p-4 rounded-xl bg-amber-50 border border-amber-300 space-y-3 text-xs">
                  <div className="flex items-center gap-2 font-semibold text-amber-900">
                    <ShieldAlert className="w-4 h-4" />
                    Platform ADMIN Checked-In Override Required
                  </div>
                  <label className="flex items-center gap-2 text-amber-900 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allowCheckedInOverride}
                      onChange={(e) => setAllowCheckedInOverride(e.target.checked)}
                      className="h-4 w-4 rounded border-amber-400"
                    />
                    Override checked-in restriction for selected ticket(s) (logged to AdminAuditLog)
                  </label>
                  {allowCheckedInOverride && (
                    <input
                      type="text"
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                      placeholder="Mandatory ADMIN override reason (min 5 characters)..."
                      className="w-full px-3 py-2 rounded-lg border border-amber-300 bg-white text-stone-900"
                    />
                  )}
                </div>
              )}

              {/* Refund Options */}
              {selectedTicketIds.length > 0 && (
                <div className="space-y-4 bg-stone-50 border border-stone-200 rounded-xl p-4 text-xs">
                  <div className="space-y-1.5">
                    <label htmlFor="refund-reason-input" className="font-semibold text-stone-900 block">
                      {isFreeOrder ? 'Cancellation Reason' : 'Refund Reason'} (required)
                    </label>
                    <input
                      id="refund-reason-input"
                      type="text"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="e.g. Attendee unable to attend / duplicate purchase"
                      className="w-full px-3 py-2 rounded-lg border border-stone-300 bg-white text-stone-900"
                    />
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                    <label className="flex items-center gap-2 text-stone-800 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={restoreInventory}
                        onChange={(e) => setRestoreInventory(e.target.checked)}
                        className="h-4 w-4 rounded border-stone-300"
                      />
                      Restore tier inventory (if event sales remain active)
                    </label>

                    {!isFreeOrder && (
                      <label className="flex items-center gap-2 text-stone-800 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={refundStripeProcessingFee}
                          onChange={(e) => setRefundStripeProcessingFee(e.target.checked)}
                          className="h-4 w-4 rounded border-stone-300"
                        />
                        Include Stripe processing fee in buyer refund
                      </label>
                    )}
                  </div>

                  {!isFreeOrder && canShiftFeeToPlatform && (
                    <div className="space-y-1">
                      <label className="font-semibold text-stone-900 block">
                        Processing Fee Bearer (ADMIN only)
                      </label>
                      <select
                        value={feeBearer}
                        onChange={(e) =>
                          setFeeBearer(e.target.value as 'ORGANIZER' | 'PLATFORM' | 'SHARED')
                        }
                        className="px-3 py-1.5 rounded-lg border border-stone-300 bg-white text-stone-900"
                      >
                        <option value="ORGANIZER">Organizer</option>
                        <option value="PLATFORM">Platform</option>
                        <option value="SHARED">Shared (50/50)</option>
                      </select>
                    </div>
                  )}

                  {/* Authoritative Quote Breakdown */}
                  {previewError && (
                    <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-800">
                      {previewError}
                    </div>
                  )}

                  {quotePreview && (
                    <div className="bg-white border border-stone-200 rounded-lg p-3.5 space-y-2">
                      <div className="font-semibold text-stone-900">
                        {quotePreview.isFreeCancellation
                          ? 'Free Ticket Cancellation Preview'
                          : 'Authoritative Refund Quote Preview'}
                      </div>
                      {!quotePreview.isFreeCancellation && (
                        <div className="grid grid-cols-2 gap-y-1 text-stone-600">
                          <span>Ticket Subtotal:</span>
                          <span className="text-right font-mono">
                            {formatCents(quotePreview.ticketSubtotalInCents, quotePreview.currency)}
                          </span>
                          <span>Buyer Service Fee Refunded:</span>
                          <span className="text-right font-mono">
                            {formatCents(quotePreview.serviceFeeReversedInCents, quotePreview.currency)}
                          </span>
                          <span>Platform Fee Reversed:</span>
                          <span className="text-right font-mono">
                            {formatCents(quotePreview.platformFeeReversedInCents, quotePreview.currency)}
                          </span>
                          <span>
                            Stripe Processing Fee (
                            {quotePreview.refundStripeProcessingFee
                              ? `included, borne by ${quotePreview.feeBearer}`
                              : 'non-refundable / excluded'}
                            ):
                          </span>
                          <span className="text-right font-mono">
                            {formatCents(quotePreview.stripeProcessingFeeInCents, quotePreview.currency)}
                          </span>
                          <span className="font-semibold text-stone-900 pt-1 border-t border-stone-200">
                            Buyer Refund Total:
                          </span>
                          <span className="text-right font-mono font-bold text-stone-900 pt-1 border-t border-stone-200">
                            {formatCents(quotePreview.buyerRefundAmountInCents, quotePreview.currency)}
                          </span>
                          <span className="text-stone-500">Organizer Balance Debit:</span>
                          <span className="text-right font-mono text-stone-700">
                            {formatCents(quotePreview.organizerDebitInCents, quotePreview.currency)}
                          </span>
                          {quotePreview.platformExpenseInCents > 0 && (
                            <>
                              <span className="text-stone-500">Platform Expense Absorbed:</span>
                              <span className="text-right font-mono text-stone-700">
                                {formatCents(quotePreview.platformExpenseInCents, quotePreview.currency)}
                              </span>
                            </>
                          )}
                        </div>
                      )}

                      <label className="flex items-start gap-2 pt-2 border-t border-stone-200 text-stone-800 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={confirmChecked}
                          onChange={(e) => setConfirmChecked(e.target.checked)}
                          className="mt-0.5 h-4 w-4 rounded border-stone-300"
                        />
                        <span>
                          I confirm immediately voiding the selected ticket(s) and{' '}
                          {quotePreview.isFreeCancellation
                            ? 'cancelling them locally.'
                            : `initiating a ${formatCents(quotePreview.buyerRefundAmountInCents, quotePreview.currency)} refund to the buyer.`}
                        </span>
                      </label>

                      <div className="pt-2 flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => initiateMutation.mutate()}
                          disabled={!canSubmit}
                          className="px-4 py-2 rounded-lg bg-stone-900 hover:bg-stone-800 text-white font-semibold disabled:opacity-40 inline-flex items-center gap-2"
                        >
                          {initiateMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                          {quotePreview.isFreeCancellation
                            ? 'Confirm Free Cancellation'
                            : 'Confirm & Queue Refund'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Historical & Active Refunds */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-stone-900 flex items-center gap-1.5">
                    <Clock className="w-4 h-4 text-stone-600" />
                    Refund History
                  </h3>
                  <button
                    type="button"
                    onClick={() => refetch()}
                    className="inline-flex items-center gap-1 text-xs text-stone-600 hover:text-stone-900"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Refresh
                  </button>
                </div>

                {summary.refunds.length === 0 ? (
                  <p className="text-xs text-stone-500 border border-dashed border-stone-200 rounded-xl p-4 text-center">
                    No refund transactions recorded on this order yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {summary.refunds.map((ref) => {
                      const badge = refundStatusBadge(ref.status);
                      return (
                        <div
                          key={ref.id}
                          className="border border-stone-200 rounded-xl p-3.5 text-xs space-y-1.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="font-semibold text-stone-900">
                              {formatCents(ref.amountInCents, ref.currency)} ·{' '}
                              <span className="font-mono text-[11px] text-stone-500">
                                {ref.ticketIds.length} ticket(s)
                              </span>
                            </div>
                            <span className={`px-2 py-0.5 rounded-full border font-semibold ${badge.className}`}>
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
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
