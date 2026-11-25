import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  Receipt,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { useOptionalAuth } from '../context/AuthContext';
import { OrderDetailsModal } from '../components/orders/OrderDetailsModal';
import { OrderRefundModal } from '../components/orders/OrderRefundModal';
import { OrderStatus, OrganizerOrderItem } from '../types';

type SortOption =
  | 'created_desc'
  | 'created_asc'
  | 'total_desc'
  | 'total_asc'
  | 'order_asc';

function parseSortOption(raw: string | null): SortOption {
  if (
    raw === 'created_desc' ||
    raw === 'created_asc' ||
    raw === 'total_desc' ||
    raw === 'total_asc' ||
    raw === 'order_asc'
  ) {
    return raw;
  }
  return 'created_desc';
}

function toApiSort(option: SortOption): {
  sortBy: 'createdAt' | 'updatedAt' | 'totalInCents' | 'orderNumber';
  sortOrder: 'asc' | 'desc';
} {
  switch (option) {
    case 'created_asc':
      return { sortBy: 'createdAt', sortOrder: 'asc' };
    case 'total_desc':
      return { sortBy: 'totalInCents', sortOrder: 'desc' };
    case 'total_asc':
      return { sortBy: 'totalInCents', sortOrder: 'asc' };
    case 'order_asc':
      return { sortBy: 'orderNumber', sortOrder: 'asc' };
    case 'created_desc':
    default:
      return { sortBy: 'createdAt', sortOrder: 'desc' };
  }
}

function formatTotal(cents: number, currency: string): string {
  const code = (currency || 'USD').toUpperCase();
  if (cents === 0) return 'FREE';
  return `${(cents / 100).toFixed(2)} ${code}`;
}

function orderStatusBadge(order: OrganizerOrderItem): { label: string; className: string } {
  const refunded = order.refundedAmountInCents ?? 0;
  const pendingRefund = order.pendingRefundAmountInCents ?? 0;

  if (order.status === 'COMPLETED' && pendingRefund > 0) {
    return {
      label: 'Refund Pending',
      className: 'bg-amber-50 text-amber-800 border-amber-200',
    };
  }
  if (order.status === 'COMPLETED' && refunded > 0 && refunded < order.totalInCents) {
    return {
      label: 'Partially Refunded',
      className: 'bg-amber-50 text-amber-800 border-amber-200',
    };
  }

  switch (order.status) {
    case 'COMPLETED':
      return { label: 'Paid', className: 'bg-emerald-50 text-emerald-800 border-emerald-200' };
    case 'PENDING':
      return { label: 'Pending', className: 'bg-amber-50 text-amber-800 border-amber-200' };
    case 'REFUNDED':
      return { label: 'Refunded', className: 'bg-rose-50 text-rose-800 border-rose-200' };
    case 'CANCELLED':
      return { label: 'Cancelled', className: 'bg-stone-100 text-stone-700 border-stone-300' };
    case 'EXPIRED':
      return { label: 'Expired', className: 'bg-stone-100 text-stone-600 border-stone-200' };
    default:
      return { label: order.status, className: 'bg-stone-100 text-stone-700 border-stone-200' };
  }
}

export const OrdersPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const auth = useOptionalAuth();
  const user = auth?.user;
  const clearSessionState = auth?.clearSessionState;
  const queryClient = useQueryClient();

  const initialStatus = (searchParams.get('status') as OrderStatus) || undefined;
  const initialEventId = searchParams.get('eventid') || '';
  const initialSearch = searchParams.get('search') || '';
  const initialPage = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const initialSort = parseSortOption(searchParams.get('sort'));

  const [searchTerm, setSearchTerm] = useState(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch.trim());
  const [eventId, setEventId] = useState(initialEventId);
  const [selectedStatus, setSelectedStatus] = useState<OrderStatus | undefined>(initialStatus);
  const [currentPage, setCurrentPage] = useState<number>(initialPage);
  const [sortOption, setSortOption] = useState<SortOption>(initialSort);

  const [detailOrderId, setDetailOrderId] = useState<string | null>(null);
  const [detailFallbackOrder, setDetailFallbackOrder] = useState<OrganizerOrderItem | null>(null);
  const [activeRefundOrderId, setActiveRefundOrderId] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = searchTerm.trim();
    if (trimmed === debouncedSearch) return;
    const timer = setTimeout(() => {
      setDebouncedSearch(trimmed);
      setCurrentPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm, debouncedSearch]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedStatus) params.set('status', selectedStatus);
    if (eventId.trim()) params.set('eventid', eventId.trim());
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (sortOption !== 'created_desc') params.set('sort', sortOption);
    if (currentPage > 1) params.set('page', currentPage.toString());
    setSearchParams(params, { replace: true });
  }, [debouncedSearch, eventId, selectedStatus, sortOption, currentPage, setSearchParams]);

  const { sortBy, sortOrder } = toApiSort(sortOption);

  const {
    data,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: ['organizer-orders', debouncedSearch, eventId, selectedStatus, sortOption, currentPage],
    queryFn: () =>
      api.organizer.getOrders({
        status: selectedStatus,
        eventId: eventId.trim() || undefined,
        search: debouncedSearch || undefined,
        page: currentPage,
        limit: 12,
        sortBy,
        sortOrder,
      }),
    placeholderData: keepPreviousData,
  });

  const { data: eventsData } = useQuery({
    queryKey: ['organizer-events-for-orders-filter'],
    queryFn: () => api.organizer.listEvents(),
    enabled: Boolean(data),
    retry: false,
  });

  const ordersErrorStatus = (error as any)?.statusCode || (error as any)?.status;
  useEffect(() => {
    if (ordersErrorStatus === 401) {
      clearSessionState?.();
    }
  }, [ordersErrorStatus, clearSessionState]);

  const orders = data?.orders ?? [];
  const pagination = data?.pagination;
  const totalPages = Math.max(1, pagination?.totalPages || 1);
  const totalOrders = pagination?.total ?? orders.length;
  const pageSize = pagination?.limit ?? 12;

  const eventFilterOptions = useMemo(() => {
    const map = new Map<string, string>();
    const isAdmin = user?.role === 'ADMIN';

    for (const evt of eventsData?.events || []) {
      const canView =
        Boolean(evt.isOwner ?? evt.organizerId === user?.id) ||
        isAdmin ||
        Boolean(evt.permissions?.canViewOrders);
      if (canView && !map.has(evt.id)) {
        map.set(evt.id, evt.title);
      }
    }

    for (const ord of orders) {
      if (ord.event?.id && !map.has(ord.event.id)) {
        map.set(ord.event.id, ord.event.title);
      }
    }

    return Array.from(map.entries())
      .map(([id, title]) => ({ id, title }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [eventsData, orders, user]);

  const activeDetailOrder = useMemo(() => {
    if (!detailOrderId) return null;
    return (
      orders.find((o) => o.id === detailOrderId) ??
      (detailFallbackOrder?.id === detailOrderId ? detailFallbackOrder : null)
    );
  }, [detailOrderId, orders, detailFallbackOrder]);

  const hasActiveFilters = Boolean(debouncedSearch || searchTerm.trim() || eventId.trim() || selectedStatus);

  const handleSearchChange = (term: string) => {
    setSearchTerm(term);
    if (term.trim() === '' && debouncedSearch !== '') {
      setDebouncedSearch('');
      setCurrentPage(1);
    }
  };

  const handleEventChange = (nextEventId: string) => {
    setEventId(nextEventId);
    setCurrentPage(1);
  };

  const handleStatusChange = (status: OrderStatus | undefined) => {
    setSelectedStatus(status);
    setCurrentPage(1);
  };

  const handleSortChange = (nextSort: SortOption) => {
    setSortOption(nextSort);
    setCurrentPage(1);
  };

  const clearFilters = () => {
    setSearchTerm('');
    setDebouncedSearch('');
    setEventId('');
    setSelectedStatus(undefined);
    setSortOption('created_desc');
    setCurrentPage(1);
  };

  const openOrderDetails = (order: OrganizerOrderItem) => {
    setDetailFallbackOrder(order);
    setDetailOrderId(order.id);
    setActiveRefundOrderId(null);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#FAF8F5] text-stone-900">
        <div className="max-w-[1536px] mx-auto px-4 sm:px-6 lg:px-8 xl:px-10 py-8 sm:py-10 space-y-6 animate-pulse">
          <div className="space-y-2 pb-6 border-b border-stone-200/80">
            <div className="h-5 w-40 bg-stone-200 rounded-full" />
            <div className="h-8 w-56 bg-stone-200 rounded-lg" />
            <div className="h-4 w-80 bg-stone-200/80 rounded" />
          </div>
          <div className="h-16 bg-white border border-stone-200 rounded-2xl" />
          <div className="h-80 bg-white border border-stone-200 rounded-2xl" />
        </div>
      </div>
    );
  }

  if (error) {
    const isForbidden = ordersErrorStatus === 403;
    return (
      <div className="min-h-screen bg-[#FAF8F5] text-stone-900 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white border border-stone-200/90 rounded-2xl shadow-sm p-8 text-center space-y-4">
          {isForbidden ? (
            <ShieldAlert className="w-10 h-10 text-amber-600 mx-auto" />
          ) : (
            <AlertCircle className="w-10 h-10 text-rose-600 mx-auto" />
          )}
          <div className="space-y-1.5">
            <h2 className="font-display font-bold text-xl text-stone-900">
              {isForbidden ? 'Organizer Order Access Required' : 'Unable to Load Orders'}
            </h2>
            <p className="text-xs text-stone-600 leading-relaxed">
              {isForbidden
                ? 'Orders are scoped to events you organize or manage with View Orders permissions.'
                : (error as any)?.message ||
                  'Something went wrong while fetching orders. Please try again.'}
            </p>
          </div>
          <div className="flex items-center justify-center gap-2.5 pt-2">
            {isForbidden ? (
              <Link
                to="/organizer"
                className="px-4 py-2 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-semibold transition-colors"
              >
                Go to Organizer Portal
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => refetch()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-semibold transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Retry
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const rangeStart = totalOrders === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const rangeEnd = Math.min(totalOrders, (currentPage - 1) * pageSize + orders.length);

  return (
    <div className="min-h-screen bg-[#FAF8F5] text-stone-900 selection:bg-stone-900 selection:text-white">
      <div className="max-w-[1536px] mx-auto px-4 sm:px-6 lg:px-8 xl:px-10 py-8 sm:py-10 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-stone-200/90">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#EFECE5]/80 border border-[#DDD7CB]/70 text-[#7A7165] text-[10px] sm:text-[11px] font-mono uppercase tracking-[0.22em] font-bold mb-2">
              <span className="w-1.5 h-1.5 rounded-full bg-[#96846D]" />
              <span>Organizer Orders</span>
            </div>
            <h1 className="font-display font-extrabold text-2xl sm:text-3xl text-stone-900 tracking-tight">
              Orders & Refunds
            </h1>
            <p className="text-xs sm:text-sm text-stone-600 mt-1 max-w-2xl">
              Review ticket orders for your events, inspect attendee purchase details, and issue ticket-based refunds.
            </p>
          </div>

          <div className="flex items-center gap-2.5 self-start sm:self-auto">
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white hover:bg-stone-100 text-stone-700 border border-stone-200/90 text-xs font-semibold shadow-2xs transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* Filter Toolbar */}
        <div className="bg-white border border-stone-200/90 rounded-2xl shadow-xs p-4 space-y-3">
          <div className="flex flex-col lg:flex-row lg:items-center gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
              <input
                type="text"
                placeholder="Search order #, customer, email, or event..."
                value={searchTerm}
                onChange={(e) => handleSearchChange(e.target.value)}
                aria-label="Search orders"
                className="w-full pl-10 pr-9 py-2 text-sm bg-stone-50/70 border border-stone-200 rounded-xl text-stone-900 placeholder:text-stone-400 focus:outline-none focus:bg-white focus:border-stone-900 transition-colors"
              />
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => handleSearchChange('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-stone-400 hover:text-stone-700"
                  aria-label="Clear search input"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <div className="relative">
                <select
                  value={eventId}
                  onChange={(e) => handleEventChange(e.target.value)}
                  className="appearance-none text-xs sm:text-sm font-medium text-stone-800 bg-white border border-stone-200 rounded-xl pl-3.5 pr-9 py-2 hover:border-stone-400 focus:outline-none focus:border-stone-900 transition-colors cursor-pointer max-w-[220px]"
                  aria-label="Filter orders by event"
                >
                  <option value="">All Permitted Events</option>
                  {eventFilterOptions.map((evt) => (
                    <option key={evt.id} value={evt.id}>
                      {evt.title}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
              </div>

              <div className="relative">
                <select
                  value={selectedStatus || ''}
                  onChange={(e) =>
                    handleStatusChange((e.target.value as OrderStatus) || undefined)
                  }
                  className="appearance-none text-xs sm:text-sm font-medium text-stone-800 bg-white border border-stone-200 rounded-xl pl-3.5 pr-9 py-2 hover:border-stone-400 focus:outline-none focus:border-stone-900 transition-colors cursor-pointer"
                  aria-label="Filter orders by status"
                >
                  <option value="">All Statuses</option>
                  <option value="COMPLETED">Paid</option>
                  <option value="PENDING">Pending</option>
                  <option value="REFUNDED">Refunded</option>
                  <option value="CANCELLED">Cancelled</option>
                  <option value="EXPIRED">Expired</option>
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
              </div>

              <div className="relative">
                <select
                  value={sortOption}
                  onChange={(e) => handleSortChange(e.target.value as SortOption)}
                  className="appearance-none text-xs sm:text-sm font-medium text-stone-800 bg-white border border-stone-200 rounded-xl pl-3.5 pr-9 py-2 hover:border-stone-400 focus:outline-none focus:border-stone-900 transition-colors cursor-pointer"
                  aria-label="Sort orders"
                >
                  <option value="created_desc">Newest First</option>
                  <option value="created_asc">Oldest First</option>
                  <option value="total_desc">Highest Total</option>
                  <option value="total_asc">Lowest Total</option>
                  <option value="order_asc">Order # (A–Z)</option>
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
              </div>

              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="px-3 py-2 rounded-xl text-xs font-semibold text-stone-600 hover:text-stone-900 hover:bg-stone-100 transition-colors"
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Orders Table / Empty State */}
        <div className="bg-white border border-stone-200/90 rounded-2xl shadow-xs overflow-hidden">
          {orders.length === 0 ? (
            <div className="px-6 py-16 text-center space-y-3">
              <Receipt className="w-10 h-10 text-stone-300 mx-auto" />
              <div className="space-y-1">
                <h2 className="font-display font-bold text-base text-stone-900">
                  {hasActiveFilters ? 'No matching orders found' : 'No orders yet'}
                </h2>
                <p className="text-xs text-stone-500 max-w-md mx-auto">
                  {hasActiveFilters
                    ? 'Try adjusting your search query, event filter, or status filter.'
                    : 'Orders from attendees purchasing tickets to your events will appear here.'}
                </p>
              </div>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-semibold transition-colors"
                >
                  Reset Filters
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead className="bg-stone-50/90 border-b border-stone-200 text-[11px] font-mono uppercase tracking-wider text-stone-500">
                    <tr>
                      <th className="px-5 py-3.5 font-semibold">Order</th>
                      <th className="px-4 py-3.5 font-semibold">Date</th>
                      <th className="px-4 py-3.5 font-semibold">Event</th>
                      <th className="px-4 py-3.5 font-semibold">Tickets</th>
                      <th className="px-4 py-3.5 font-semibold">Total</th>
                      <th className="px-4 py-3.5 font-semibold">Status</th>
                      <th className="px-5 py-3.5 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-stone-200/80">
                    {orders.map((order) => {
                      const refundedCents = order.refundedAmountInCents ?? 0;
                      const pendingRefundCents = order.pendingRefundAmountInCents ?? 0;
                      const remainingRefundable = Math.max(
                        0,
                        order.totalInCents - refundedCents - pendingRefundCents
                      );
                      const currency = (order.currency || 'USD').toUpperCase();
                      const badge = orderStatusBadge(order);
                      const showRefundAction =
                        Boolean(order.canManageRefunds) &&
                        order.status === 'COMPLETED' &&
                        (remainingRefundable > 0 || order.totalInCents === 0);

                      return (
                        <tr
                          key={order.id}
                          onClick={() => openOrderDetails(order)}
                          className="hover:bg-stone-50/80 transition-colors cursor-pointer"
                        >
                          <td className="px-5 py-3.5 font-mono font-semibold text-stone-900 whitespace-nowrap">
                            #{order.orderNumber}
                          </td>
                          <td className="px-4 py-3.5 text-xs text-stone-600 whitespace-nowrap">
                            {new Date(order.createdAt).toLocaleString()}
                          </td>
                          <td className="px-4 py-3.5 font-medium text-stone-900 max-w-[260px] truncate">
                            {order.event.title}
                          </td>
                          <td className="px-4 py-3.5 font-mono text-stone-700 whitespace-nowrap">
                            {order.ticketsCount}
                          </td>
                          <td className="px-4 py-3.5 font-mono font-semibold text-stone-900 whitespace-nowrap">
                            {formatTotal(order.totalInCents, currency)}
                          </td>
                          <td className="px-4 py-3.5 text-xs whitespace-nowrap">
                            <span
                              className={`inline-flex items-center px-2.5 py-0.5 rounded-full font-semibold border ${badge.className}`}
                            >
                              {badge.label}
                            </span>
                          </td>
                          <td
                            className="px-5 py-3.5 text-right whitespace-nowrap"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="inline-flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => openOrderDetails(order)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-stone-200 bg-white hover:bg-stone-100 text-stone-800 text-xs font-semibold transition-colors"
                              >
                                <Eye className="w-3.5 h-3.5 text-stone-500" />
                                View Order
                              </button>
                              {showRefundAction && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setDetailOrderId(null);
                                    setActiveRefundOrderId(order.id);
                                  }}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-stone-300 bg-stone-900 hover:bg-black text-white text-xs font-semibold transition-colors"
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
                                  Manage Refund
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination Footer */}
              <div className="px-5 py-3.5 bg-stone-50/70 border-t border-stone-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-stone-600">
                <div>
                  Showing <strong className="text-stone-900">{rangeStart}</strong>–
                  <strong className="text-stone-900">{rangeEnd}</strong> of{' '}
                  <strong className="text-stone-900">{totalOrders}</strong> orders
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={currentPage <= 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-stone-200 bg-white hover:bg-stone-100 text-stone-700 font-medium disabled:opacity-40 disabled:pointer-events-none transition-colors"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    Previous
                  </button>
                  <span className="font-mono px-2 text-stone-700">
                    Page {currentPage} of {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={currentPage >= totalPages}
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-stone-200 bg-white hover:bg-stone-100 text-stone-700 font-medium disabled:opacity-40 disabled:pointer-events-none transition-colors"
                  >
                    Next
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {activeDetailOrder && !activeRefundOrderId && (
        <OrderDetailsModal
          order={activeDetailOrder}
          onClose={() => {
            setDetailOrderId(null);
            setDetailFallbackOrder(null);
          }}
          onStartRefund={(orderId) => {
            setActiveRefundOrderId(orderId);
          }}
        />
      )}

      {activeRefundOrderId && (
        <OrderRefundModal
          orderId={activeRefundOrderId}
          onClose={() => setActiveRefundOrderId(null)}
          onRefundUpdated={async () => {
            await queryClient.invalidateQueries({
              queryKey: ['order-refund-summary', activeRefundOrderId],
            });
            refetch();
          }}
        />
      )}
    </div>
  );
};
