import { ApiResponse, EventListResponse, Event, User, OrganizerDashboardStats, OrganizerEventItem } from '../types';

const API_BASE = '/api';

export class ApiError extends Error {
  public statusCode: number;
  public details?: Array<{ field: string; message: string }>;

  constructor(message: string, statusCode: number, details?: Array<{ field: string; message: string }>) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token =
    typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
      ? window.localStorage.getItem('outside_token')
      : null;
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  const json: ApiResponse<T> = await response.json().catch(() => ({
    success: false,
    data: null as any,
    error: { message: 'Unexpected network response', statusCode: response.status },
  }));

  if (!response.ok || !json.success) {
    throw new ApiError(
      json.error?.message || 'An unexpected error occurred',
      json.error?.statusCode || response.status,
      json.error?.details
    );
  }

  return json.data;
}

export const api = {
  events: {
    list: (params?: {
      search?: string;
      category?: string;
      city?: string;
      featuredOnly?: boolean;
      timeFilter?: string;
      sortBy?: string;
      page?: number;
      limit?: number;
    }) => {
      const query = new URLSearchParams();
      if (params?.search) query.set('search', params.search);
      if (params?.category) query.set('category', params.category);
      if (params?.city) query.set('city', params.city);
      if (params?.featuredOnly) query.set('featuredOnly', 'true');
      if (params?.timeFilter) query.set('timeFilter', params.timeFilter);
      if (params?.sortBy) query.set('sortBy', params.sortBy);
      if (params?.page) query.set('page', params.page.toString());
      if (params?.limit) query.set('limit', params.limit.toString());
      return request<EventListResponse>(`/events?${query.toString()}`);
    },
    featured: () => request<{ events: Event[] }>('/events/featured'),
    cities: () => request<{ cities: string[] }>('/events/cities'),
    bySlug: (slug: string) => request<{ event: Event }>(`/events/${slug}`),
  },
  organizer: {
    getDashboard: () => request<OrganizerDashboardStats>('/organizer/dashboard'),
    listEvents: () => request<{ events: OrganizerEventItem[] }>('/organizer/events'),
    getEvent: (id: string) => request<{ event: Event }>(`/organizer/events/${id}`),
    createEvent: (payload: any) =>
      request<{ event: Event }>('/organizer/events', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    updateEvent: (id: string, payload: any) =>
      request<{ event: Event }>(`/organizer/events/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    publishEvent: (id: string) =>
      request<{ event: Event; message: string }>(`/organizer/events/${id}/publish`, {
        method: 'POST',
      }),
    unpublishEvent: (id: string) =>
      request<{ event: Event; message: string }>(`/organizer/events/${id}/unpublish`, {
        method: 'POST',
      }),
    deleteEvent: (id: string) =>
      request<{ message: string }>(`/organizer/events/${id}`, {
        method: 'DELETE',
      }),
  },
  auth: {
    me: () => request<{ user: User }>('/auth/me'),
    login: (credentials: { email: string; password: string }) =>
      request<{ user: User; token: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(credentials),
      }),
    register: (data: { email: string; password: string; name: string; role?: string; organizerDisplayName?: string }) =>
      request<{ user: User; token: string }>('/auth/register', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
};

