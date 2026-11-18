import { api } from "@/lib/api";
import { OrderStatus } from "@/types";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { useEffect, useState } from "react";
import {  useSearchParams } from "react-router-dom";

export const OrdersPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  const initialStatus =(searchParams.get("status") as OrderStatus) || undefined;
  const initialEventId = searchParams.get("eventid") || "";
  const initialSearch = searchParams.get("search") || "";
  const initialPage = Math.max(1,parseInt(searchParams.get("page") || "1", 10) || 1,);
  const initialSortBy = searchParams.get("sort") || "date_asc";

  const [searchTerm, setSearchTerm] = useState(initialSearch);
  const [eventId, setEventId] = useState(initialEventId);
  const [selectedStatus, setSelectedStatus] = useState<OrderStatus | undefined>(initialStatus);
  const [currentPage, setCurrentPage] = useState<number>(initialPage);
  const [sortBy, setSortBy] = useState<string>(initialSortBy);

  useEffect(() => {
    const params = new URLSearchParams();

    if (selectedStatus) params.set("status", selectedStatus);
    if (eventId.trim()) params.set("eventid", searchTerm.trim());
    if (searchTerm.trim()) params.set("search", searchTerm.trim());
    if (sortBy && sortBy !== "date_asc") params.set("sort", sortBy);
    if (currentPage > 1) params.set("page", currentPage.toString());
    setSearchParams(params, { replace: true });}, [ searchTerm, selectedStatus,sortBy,currentPage,setSearchParams]);

    const { data, isLoading, error, refetch } = useQuery({
        queryKey: ['events-discover', searchTerm, selectedStatus, sortBy, currentPage],
        queryFn: () =>
          api.organizer.getOrders({
            status: selectedStatus,
            eventId,
            search: searchTerm.trim() || undefined,        
            page: currentPage,
            limit: 12,
            sortOrder: 'asc',
          }),
      });

    const order = data?.orders;
    console.log(order);

  const handleSearchChange = (term: string) => {
    setSearchTerm(term);
    setCurrentPage(1);
  };

   const handleSortChange = (sort: string) => {
    setSortBy(sort);
    setCurrentPage(1);
  };

  const clearFilters = () => {
    setSearchTerm('');
    setSelectedStatus(undefined);
    setSortBy('date_asc');
    setCurrentPage(1);
  };

  const events = data?.orders || [];
  const pagination = data?.pagination;
  const totalPages = pagination?.totalPages || 1;
  const totalEvents = pagination?.total ?? events.length;
  
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
  if (error || !order) {
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
        <input
          type="text"
          placeholder="Search by name or order #..."
          value={searchTerm}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="input input-bordered w-64"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="table table-zebra w-full">
          <thead>
            <tr>
              <th>
                <input
                  type="text"
                  placeholder="Order #"
                  className="input input-sm input-bordered w-full"
                />
              </th>
              <th>
                <input
                  type="text"
                  placeholder="Date"
                  className="input input-sm input-bordered w-full"
                />
              </th>
              <th>
                <input
                  type="text"
                  placeholder="Event"
                  className="input input-sm input-bordered w-full"
                />
              </th>
              <th>
                <input
                  type="text"
                  placeholder="Tickets"
                  className="input input-sm input-bordered w-full"
                />
              </th>
              <th>
                <input
                  type="text"
                  placeholder="Total"
                  className="input input-sm input-bordered w-full"
                />
              </th>
            </tr>
          </thead>

          <tbody>
             {order?.map(order => (
              <tr key={order.id}>
                <td>{order.orderNumber}</td>
                <td>{order.createdAt}</td>
                <td>{order.event.title}</td>
                <td>{order.ticketsCount}</td>
                <td>$ {Number(order.totalInCents * order.ticketsCount).toFixed(2)}</td>
              </tr>
                ))}
           
            <tr>
              <td>OUT-2026-89413</td>
              <td>27-April-2026</td>
              <td>SOL FEST: Under The Baobab Tree</td>
              <td>$5</td>
              <td>$100</td>
            </tr>
            <tr>
              <td>OUT-2026-89414</td>
              <td>26-June-2026</td>
              <td>ALTE CRUISE: Sunset Rooftop Session</td>
              <td>$2</td>
              <td>$40</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
};
