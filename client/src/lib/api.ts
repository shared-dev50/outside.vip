import {
  ApiResponse,
  EventListResponse,
  Event,
  User,
  OrganizerDashboardStats,
  OrganizerEventItem,
  Order,
  CheckoutSessionInput,
  CheckoutSessionResult,
} from '../types';

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
    uploadCoverImage: async (file: File): Promise<{
      secure_url: string;
      public_id: string;
      thumbnailUrl?: string;
    }> => {
      const token =
        typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
          ? window.localStorage.getItem('outside_token')
          : null;

      // 1. Attempt signed direct-upload to Cloudinary from browser
      try {
        const signData = await request<{
          cloudName: string;
          apiKey: string;
          timestamp: number;
          folder: string;
          signature: string;
          uploadUrl: string;
        }>('/organizer/upload/sign', {
          method: 'POST',
        });

        const formData = new FormData();
        formData.append('file', file);
        formData.append('api_key', signData.apiKey);
        formData.append('timestamp', signData.timestamp.toString());
        formData.append('signature', signData.signature);
        formData.append('folder', signData.folder);

        const cldRes = await fetch(signData.uploadUrl, {
          method: 'POST',
          body: formData,
        });

        if (!cldRes.ok) {
          const errJson = await cldRes.json().catch(() => null);
          throw new Error(errJson?.error?.message || `Cloudinary direct upload failed (${cldRes.status})`);
        }

        const cldJson = await cldRes.json();
        const secure_url = cldJson.secure_url;
        const public_id = cldJson.public_id;
        const thumbnailUrl = secure_url.includes('/upload/')
          ? secure_url.replace('/upload/', '/upload/c_fill,g_auto,w_600,h_400,q_auto,f_auto/')
          : secure_url;

        return { secure_url, public_id, thumbnailUrl };
      } catch (directUploadErr: any) {
        // 2. Fall back to secure server-authorized upload endpoint
        const serverFormData = new FormData();
        serverFormData.append('image', file);

        const serverRes = await fetch(`${API_BASE}/organizer/upload`, {
          method: 'POST',
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: serverFormData,
        });

        const serverJson = await serverRes.json().catch(() => null);

        if (!serverRes.ok || !serverJson?.success) {
          throw new ApiError(
            serverJson?.error?.message || directUploadErr?.message || 'Failed to upload cover image',
            serverJson?.error?.statusCode || serverRes.status
          );
        }

        return serverJson.data;
      }
    },
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
  checkout: {
    createSession: (payload: CheckoutSessionInput) =>
      request<CheckoutSessionResult>('/checkout/create-session', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  },
  orders: {
    getByOrderNumber: (orderNumber: string, token?: string | null) => {
      const query = token ? `?token=${encodeURIComponent(token)}` : '';
      return request<{ order: Order }>(`/orders/${orderNumber}${query}`);
    },
  },
};

