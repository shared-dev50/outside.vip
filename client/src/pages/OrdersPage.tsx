import { api } from "../lib/api";
import { useOptionalAuth } from "../context/AuthContext";
import { OrderRefundModal } from "../components/orders/OrderRefundModal";
import { OrderStatus } from "../types";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ChevronDown, RotateCcw, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

export const OrdersPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const auth = useOptionalAuth();
  const clearSessionState = auth?.clearSessionState;

  const initialStatus = (searchParams.get("status") as OrderStatus) || undefined;
  const initialEventId = searchParams.get("eventid") || "";
  const initialSearch = searchParams.get("search") || "";
  const initialPage = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const initialSortBy = searchParams.get("sort") || "date_asc";

  const [searchTerm, setSearchTerm] = useState(initialSearch);
  const [eventId, setEventId] = useState(initialEventId);
  const [selectedStatus, setSelectedStatus] = useState<OrderStatus | undefined>(initialStatus);
  const [currentPage, setCurrentPage] = useState<number>(initialPage);
  const [sortBy, setSortBy] = useState<string>(initialSortBy);
  const [activeRefundOrderId, setActiveRefundOrderId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams();

    if (selectedStatus) params.set("status", selectedStatus);
    if (eventId.trim()) params.set("eventid", eventId.trim());
    if (searchTerm.trim()) params.set("search", searchTerm.trim());
    if (sortBy && sortBy !== "date_asc") params.set("sort", sortBy);
    if (currentPage > 1) params.set("page", currentPage.toString());
    setSearchParams(params, { replace: true });
  }, [searchTerm, eventId, selectedStatus, sortBy, currentPage, setSearchParams]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["organizer-orders", searchTerm, eventId, selectedStatus, sortBy, currentPage],
    queryFn: () =>
      api.organizer.getOrders({
        status: selectedStatus,
        eventId: eventId.trim() || undefined,
        search: searchTerm.trim() || undefined,
        page: currentPage,
        limit: 12,
        sortOrder: "asc",
      }),
  });

  const ordersErrorStatus = (error as any)?.statusCode || (error as any)?.status;
  useEffect(() => {
    if (ordersErrorStatus === 401) {
      clearSessionState?.();
    }
  }, [ordersErrorStatus, clearSessionState]);

  const orders = data?.orders;

  const handleSearchChange = (term: string) => {
    setSearchTerm(term);
    setCurrentPage(1);
  };

  const handleStatusChange = (status: OrderStatus | undefined) => {
    setSelectedStatus(status);
    setCurrentPage(1);
  };

  const handleSortChange = (sort: string) => {
    setSortBy(sort);
    setCurrentPage(1);
  };

  const clearFilters = () => {
    setSearchTerm("");
    setEventId("");
    setSelectedStatus(undefined);
    setSortBy("date_asc");
    setCurrentPage(1);
  };

  const pagination = data?.pagination;
  const totalPages = pagination?.totalPages || 1;
  const totalOrders = pagination?.total ?? (orders?.length ?? 0);

  void refetch;
  void handleSortChange;
  void clearFilters;
  void totalPages;
  void totalOrders;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-white">
        <div className="bg-[#08090C] text-white py-3 px-4 text-center text-xs font-mono">
          Loading Organizer orders...
        </div>
        <div className="max-w-7xl mx-auto px-4 py-12 animate-pulse space-y-6">
          <div className="h-6 w-32 bg-gray-200 rounded" />
          <div className="aspect-[16/10] max-w-3xl bg-gray-200 rounded-lg" />
          <div className="h-10 w-2/3 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  if (error || !orders) {
    return (
      <div className="min-h-screen bg-[#08090C] text-white flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-[#0E1015] border border-white/10 rounded-2xl p-8 text-center space-y-4">
          <AlertCircle className="w-10 h-10 text-rose-400 mx-auto" />
          <h2 className="font-display font-bold text-xl text-white">Order Not Found</h2>
          <p className="text-xs text-gray-400">
            This order does not exist or you do not have permission to view it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Orders</h1>
      </div>
      <div className="flex items-center gap-3 w-full lg:w-auto">
        <div className="relative flex-1 lg:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
          <input
            type="text"
            placeholder="Search by name or order #..."
            value={searchTerm}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="input input-bordered w-64"
          />
          {searchTerm && (
            <button
              onClick={() => handleSearchChange("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700"
              aria-label="Clear search input"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="relative">
          <select
            value={selectedStatus || ""}
            onChange={(e) =>
              handleStatusChange((e.target.value as OrderStatus) || undefined)
            }
            className="appearance-none font-sans text-sm sm:text-base font-semibold text-stone-900 bg-white border border-stone-300 rounded-lg pl-4 pr-10 py-2 sm:py-2.5 shadow-2xs hover:border-stone-900 focus:outline-none focus:border-stone-900 transition-colors cursor-pointer"
            aria-label="Filter orders by status"
          >
            <option value="">All Statuses</option>
            <option value="COMPLETED">Paid</option>
            <option value="PENDING">Pending</option>
            <option value="REFUNDED">Refunded</option>
            <option value="CANCELLED">Cancelled</option>
            <option value="EXPIRED">Expired</option>
          </select>
          <ChevronDown className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-500 pointer-events-none" />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse bg-white border border-stone-200 rounded-xl overflow-hidden text-sm">
          <thead className="bg-stone-50 border-b border-stone-200 text-xs uppercase tracking-wider text-stone-600">
            <tr>
              <th className="px-4 py-3 font-semibold">Order #</th>
              <th className="px-4 py-3 font-semibold">Date</th>
              <th className="px-4 py-3 font-semibold">Customer</th>
              <th className="px-4 py-3 font-semibold">Event</th>
              <th className="px-4 py-3 font-semibold">Tickets</th>
              <th className="px-4 py-3 font-semibold">Total</th>
              <th className="px-4 py-3 font-semibold">Status & Refunds</th>
              <th className="px-4 py-3 font-semibold text-right">Actions</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-stone-200">
            {orders.map((order) => {
              const refundedCents = order.refundedAmountInCents ?? 0;
              const pendingRefundCents = order.pendingRefundAmountInCents ?? 0;
              const currency = (order.currency || "USD").toUpperCase();

              return (
                <tr key={order.id} className="hover:bg-stone-50/70">
                  <td className="px-4 py-3 font-mono font-semibold text-stone-900">
                    #{order.orderNumber}
                  </td>
                  <td className="px-4 py-3 text-xs text-stone-600 whitespace-nowrap">
                    {new Date(order.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-stone-900">{order.customerName}</div>
                    <div className="text-xs text-stone-500">{order.customerEmail}</div>
                  </td>
                  <td className="px-4 py-3 text-stone-800">{order.event.title}</td>
                  <td className="px-4 py-3 text-stone-700">{order.ticketsCount}</td>
                  <td className="px-4 py-3 font-mono font-medium text-stone-900 whitespace-nowrap">
                    {order.totalInCents === 0
                      ? "FREE"
                      : `${(order.totalInCents / 100).toFixed(2)} ${currency}`}
                  </td>
                  <td className="px-4 py-3 space-y-1 text-xs">
                    <span className="inline-block px-2 py-0.5 rounded-full font-semibold border bg-stone-100 text-stone-800 border-stone-200">
                      {order.status}
                    </span>
                    {refundedCents > 0 && (
                      <div className="text-rose-700 font-medium">
                        Refunded: {(refundedCents / 100).toFixed(2)} {currency}
                      </div>
                    )}
                    {pendingRefundCents > 0 && (
                      <div className="text-amber-700 font-medium">
                        Pending Refund: {(pendingRefundCents / 100).toFixed(2)} {currency}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {order.canManageRefunds && order.status === "COMPLETED" && (
                      <button
                        type="button"
                        onClick={() => setActiveRefundOrderId(order.id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-stone-300 bg-white hover:bg-stone-900 hover:text-white text-stone-800 text-xs font-semibold transition-colors"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Manage Refunds
                      </button>
                    )}
                    {order.canManageRefunds && order.status === "REFUNDED" && (
                      <button
                        type="button"
                        onClick={() => setActiveRefundOrderId(order.id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-stone-200 bg-stone-50 hover:bg-stone-200 text-stone-700 text-xs font-medium transition-colors"
                      >
                        Refund Details
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {activeRefundOrderId && (
        <OrderRefundModal
          orderId={activeRefundOrderId}
          onClose={() => setActiveRefundOrderId(null)}
          onRefundUpdated={() => {
            refetch();
          }}
        />
      )}
    </div>
  );
};
