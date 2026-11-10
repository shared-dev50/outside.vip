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
  OrganizerPayoutDetails,
  PayoutDetailsInput,
  CombinedEarningsBreakdown,
  JoinWaitlistInput,
  JoinWaitlistResult,
  WaitlistOfferInfo,
  OrganizerWaitlistResponse,
  StripeConnectedAccountStatus,
  StripeBalanceResponse,
  StripePayoutItem,
  StripeDisputeItem,
  OrganizerTransferItem,
  FinancialLedgerEntryItem,
  WithdrawalRequestPayload,
  WithdrawalResponse,
  StripeConnectCountry,
} from '../types';

export function resolveApiBaseUrl(rawUrl?: string): string {
  const url = (rawUrl ?? '').trim();
  if (!url) {
    return '/api';
  }

  const clean = url.replace(/\/+$/, '');

  if (!clean || clean === '/api') {
    return '/api';
  }

  if (clean.endsWith('/api')) {
    return clean;
  }

  return `${clean}/api`;
}

export function buildApiUrl(endpoint: string, base: string = API_BASE): string {
  const cleanBase = base.replace(/\/+$/, '');
  let path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

  if (path === '/api') {
    path = '';
  } else if (path.startsWith('/api/')) {
    path = path.slice(4);
  }

  return `${cleanBase}${path}`;
}

const rawEnvUrl =
  typeof import.meta !== 'undefined' && import.meta.env
    ? (import.meta.env.VITE_API_URL as string | undefined)
    : undefined;

export const API_BASE = resolveApiBaseUrl(rawEnvUrl);

export class ApiError extends Error {
  public statusCode: number;
  public details?: Array<{ field: string; message: string }>;
  public data?: any;
  public code?: string;

  constructor(
    message: string,
    statusCode: number,
    details?: Array<{ field: string; message: string }>,
    data?: any,
    code?: string
  ) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.data = data;
    this.code = code;
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

  const response = await fetch(buildApiUrl(endpoint), {
    ...options,
    headers,
  });

  const json: ApiResponse<T> = await response.json().catch(() => ({
    success: false,
    data: null as any,
    error: { message: 'Unexpected network response', statusCode: response.status },
  }));

  if (!response.ok || !json.success) {
    const message =
      json.error?.message ||
      (json.data as any)?.message ||
      'An unexpected error occurred';
    const statusCode = json.error?.statusCode || response.status;
    const code = (json.error as any)?.code || (json.data as any)?.result;

    throw new ApiError(message, statusCode, json.error?.details, json.data, code);
  }

  return json.data;
}

export interface UploadProgressPayload {
  loaded: number;
  total: number;
  percent: number;
  state: 'uploading' | 'processing';
}

function xhrPost<T>(
  url: string,
  formData: FormData,
  headers: Record<string, string> = {},
  onProgress?: (progress: UploadProgressPayload) => void,
  signal?: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('Upload was aborted by user.'));
    }

    const xhr = new XMLHttpRequest();

    const onAbort = () => {
      xhr.abort();
      reject(new Error('Upload was cancelled.'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          const rawPercent = Math.round((event.loaded / event.total) * 100);
          const percent = Math.min(99, Math.max(0, rawPercent));
          onProgress({
            loaded: event.loaded,
            total: event.total,
            percent,
            state: 'uploading',
          });
        }
      };

      xhr.upload.onload = () => {
        onProgress({
          loaded: 1,
          total: 1,
          percent: 100,
          state: 'processing',
        });
      };
    }

    xhr.open('POST', url);

    Object.entries(headers).forEach(([key, val]) => {
      xhr.setRequestHeader(key, val);
    });

    xhr.onload = () => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }

      let parsed: any = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        parsed = null;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(parsed);
      } else {
        const errorMsg =
          parsed?.error?.message ||
          parsed?.message ||
          `Upload failed with status code ${xhr.status}`;
        reject(new Error(errorMsg));
      }
    };

    xhr.onerror = () => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      reject(new Error('Network error occurred during image upload. Please check your internet connection.'));
    };

    xhr.ontimeout = () => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      reject(new Error('Image upload timed out.'));
    };

    xhr.onabort = () => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      reject(new Error('Upload was cancelled.'));
    };

    xhr.send(formData);
  });
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
    bySlug: (slug: string, eventAccessToken?: string) =>
      request<{ event: Event }>(`/events/${slug}`, {
        headers: eventAccessToken ? { 'x-event-access-token': eventAccessToken } : undefined,
      }),
    verifyPassword: (slug: string, password: string) =>
      request<{ eventAccessToken: string; eventId: string; hasAccess: boolean }>(
        `/events/${slug}/verify-password`,
        {
          method: 'POST',
          body: JSON.stringify({ password }),
        }
      ),
  },
  organizer: {
    getDashboard: () => request<OrganizerDashboardStats>('/organizer/dashboard'),
    listEvents: () => request<{ events: OrganizerEventItem[] }>('/organizer/events'),
    getEvent: (id: string) => request<{ event: Event }>(`/organizer/events/${id}`),
    getPayoutDetails: () =>
      request<{ payoutDetails: OrganizerPayoutDetails | null }>('/organizer/payout-details'),
    updatePayoutDetails: (payload: PayoutDetailsInput) =>
      request<{ payoutDetails: OrganizerPayoutDetails }>('/organizer/payout-details', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
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
    publishEvent: (id: string, publishSeries?: boolean) =>
      request<{ event: Event; message: string }>(
        `/organizer/events/${id}/publish${publishSeries ? '?publishSeries=true' : ''}`,
        {
          method: 'POST',
        }
      ),
    unpublishEvent: (id: string, unpublishSeries?: boolean) =>
      request<{ event: Event; message: string }>(
        `/organizer/events/${id}/unpublish${unpublishSeries ? '?unpublishSeries=true' : ''}`,
        {
          method: 'POST',
        }
      ),
    cancelEvent: (id: string, reason?: string) =>
      request<{ event: Event; message: string }>(`/organizer/events/${id}/cancel`, {
        method: 'POST',
        ...(reason ? { body: JSON.stringify({ reason }) } : {}),
      }),
    getSeries: (id: string) =>
      request<{ series: any }>(`/organizer/series/${id}`),
    cancelSeries: (id: string, reason?: string) =>
      request<{ seriesId: string; cancelledCount: number; message: string }>(
        `/organizer/series/${id}/cancel`,
        {
          method: 'POST',
          ...(reason ? { body: JSON.stringify({ reason }) } : {}),
        }
      ),
    deleteEvent: (id: string) =>
      request<{ message: string }>(`/organizer/events/${id}`, {
        method: 'DELETE',
      }),
    getWaitlist: (eventId: string) =>
      request<OrganizerWaitlistResponse>(`/organizer/events/${eventId}/waitlist`),
    checkInTicket: (payload: { token: string; eventId?: string }) =>
      request<{
        result: 'SUCCESS' | 'ALREADY_CHECKED_IN' | 'INVALID_TOKEN' | 'WRONG_EVENT' | 'CANCELLED_TICKET' | 'UNPAID_ORDER' | 'TICKET_NOT_YET_VALID' | 'TICKET_EXPIRED';
        message: string;
        ticket?: any;
        totalCheckedIn?: number;
      }>('/organizer/check-in', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    uploadCoverImage: async (
      file: File,
      onProgress?: (progress: UploadProgressPayload) => void,
      signal?: AbortSignal
    ): Promise<{
      secure_url: string;
      public_id: string;
      thumbnailUrl?: string;
      format?: string;
      width?: number;
      height?: number;
    }> => {
      const token =
        typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
          ? window.localStorage.getItem('outside_token')
          : null;

      // Direct upload to Cloudinary
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
          signal,
        });

        const formData = new FormData();
        formData.append('file', file);
        formData.append('api_key', signData.apiKey);
        formData.append('timestamp', signData.timestamp.toString());
        formData.append('signature', signData.signature);
        formData.append('folder', signData.folder);

        if (typeof XMLHttpRequest !== 'undefined') {
          const cldJson = await xhrPost<any>(signData.uploadUrl, formData, {}, onProgress, signal);
          const secure_url = cldJson.secure_url;
          const public_id = cldJson.public_id;
          const thumbnailUrl = secure_url.includes('/upload/')
            ? secure_url.replace('/upload/', '/upload/c_fill,g_auto,w_600,h_400,q_auto,f_auto/')
            : secure_url;

          return {
            secure_url,
            public_id,
            thumbnailUrl,
            format: cldJson.format,
            width: cldJson.width,
            height: cldJson.height,
          };
        }

        const cldRes = await fetch(signData.uploadUrl, {
          method: 'POST',
          body: formData,
          signal,
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

        if (onProgress) {
          onProgress({ loaded: file.size, total: file.size, percent: 100, state: 'processing' });
        }

        return {
          secure_url,
          public_id,
          thumbnailUrl,
          format: cldJson.format,
          width: cldJson.width,
          height: cldJson.height,
        };
      } catch (directUploadErr: any) {
        if (signal?.aborted) {
          throw new Error('Upload was cancelled.');
        }

        // Fallback: upload via server
        const serverFormData = new FormData();
        serverFormData.append('image', file);

        const headers: Record<string, string> = {};
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }

        if (typeof XMLHttpRequest !== 'undefined') {
          const serverJson = await xhrPost<any>(
            buildApiUrl('/organizer/upload'),
            serverFormData,
            headers,
            onProgress,
            signal
          );

          if (!serverJson?.success) {
            throw new ApiError(
              serverJson?.error?.message || directUploadErr?.message || 'Failed to upload cover image',
              serverJson?.error?.statusCode || 500
            );
          }

          return serverJson.data;
        }

        const serverRes = await fetch(buildApiUrl('/organizer/upload'), {
          method: 'POST',
          headers,
          body: serverFormData,
          signal,
        });

        const serverJson = await serverRes.json().catch(() => null);

        if (!serverRes.ok || !serverJson?.success) {
          throw new ApiError(
            serverJson?.error?.message || directUploadErr?.message || 'Failed to upload cover image',
            serverJson?.error?.statusCode || serverRes.status
          );
        }

        if (onProgress) {
          onProgress({ loaded: file.size, total: file.size, percent: 100, state: 'processing' });
        }

        return serverJson.data;
      }
    },
    getEarningsPreview: (payload: { tiers: Array<{ priceInCents: number; capacity?: number }> }) =>
      request<{ preview: CombinedEarningsBreakdown }>('/organizer/earnings-preview', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    uploadImage: (
      file: File,
      onProgress?: (progress: UploadProgressPayload) => void,
      signal?: AbortSignal
    ) => api.organizer.uploadCoverImage(file, onProgress, signal),
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
    getPdfDownloadUrl: (orderNumber: string, token?: string | null, ticketId?: string) => {
      const params = new URLSearchParams();
      if (token) params.set('token', token);
      if (ticketId) params.set('ticketId', ticketId);
      const qs = params.toString() ? `?${params.toString()}` : '';
      return buildApiUrl(`/orders/${orderNumber}/tickets/pdf${qs}`);
    },
    downloadTicketsPdf: async (orderNumber: string, token?: string | null, ticketId?: string): Promise<void> => {
      const params = new URLSearchParams();
      if (token) params.set('token', token);
      if (ticketId) params.set('ticketId', ticketId);
      const qs = params.toString() ? `?${params.toString()}` : '';

      const authToken =
        typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
          ? window.localStorage.getItem('outside_token')
          : null;

      const headers: HeadersInit = {};
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }
      if (token) {
        headers['x-order-token'] = token;
      }

      const res = await fetch(buildApiUrl(`/orders/${orderNumber}/tickets/pdf${qs}`), {
        method: 'GET',
        headers,
      });

      if (!res.ok) {
        const errorJson = await res.json().catch(() => null);
        throw new ApiError(
          errorJson?.error?.message || 'Failed to download tickets PDF',
          res.status
        );
      }

      const blob = await res.blob();
      const contentDisposition = res.headers.get('content-disposition');
      let filename = `outside-vip-passes-${orderNumber}.pdf`;
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="?([^"]+)"?/);
        if (match && match[1]) filename = match[1];
      }

      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(blobUrl);
      document.body.removeChild(a);
    },
  },
  waitlist: {
    join: (eventSlug: string, payload: JoinWaitlistInput) =>
      request<JoinWaitlistResult>(`/events/${eventSlug}/waitlist`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    lookupOffer: (token: string) =>
      request<{ offer: WaitlistOfferInfo }>(`/waitlist/offers/${token}`),
    declineOffer: (token: string) =>
      request<{ success: boolean; message: string }>(`/waitlist/offers/${token}/decline`, {
        method: 'POST',
      }),
  },
  finance: {
    getStatus: () =>
      request<StripeConnectedAccountStatus>('/organizer/finance/account'),
    getSupportedCountries: () =>
      request<{ countries: StripeConnectCountry[]; defaultCountry: string }>(
        '/organizer/finance/countries'
      ),
    createOnboardingLink: (payload?: {
      returnUrl?: string;
      refreshUrl?: string;
      reconnect?: boolean;
      country?: string;
    }) =>
      request<{ url: string; stripeAccountId: string }>('/organizer/finance/onboarding-link', {
        method: 'POST',
        body: JSON.stringify(payload || {}),
      }),
    createLoginLink: (payload?: { returnUrl?: string }) =>
      request<{ url: string }>('/organizer/finance/login-link', {
        method: 'POST',
        body: JSON.stringify(payload || {}),
      }),
    getBalance: () =>
      request<StripeBalanceResponse>('/organizer/finance/balance'),
    getPayouts: (limit?: number) =>
      request<{ payouts: StripePayoutItem[] }>(
        `/organizer/finance/payouts${limit ? `?limit=${limit}` : ''}`
      ),
    getDisputes: (limit?: number) =>
      request<{ disputes: StripeDisputeItem[] }>(
        `/organizer/finance/disputes${limit ? `?limit=${limit}` : ''}`
      ),
    withdraw: (payload: WithdrawalRequestPayload) =>
      request<WithdrawalResponse>('/organizer/finance/withdraw', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    getTransfers: (page?: number, limit?: number) => {
      const params = new URLSearchParams();
      if (page) params.append('page', page.toString());
      if (limit) params.append('limit', limit.toString());
      const query = params.toString() ? `?${params.toString()}` : '';
      return request<{
        total: number;
        page: number;
        limit: number;
        totalPages: number;
        transfers: OrganizerTransferItem[];
      }>(`/organizer/finance/transfers${query}`);
    },
    getLedger: (options?: { page?: number; limit?: number; eventId?: string }) => {
      const params = new URLSearchParams();
      if (options?.page) params.append('page', options.page.toString());
      if (options?.limit) params.append('limit', options.limit.toString());
      if (options?.eventId) params.append('eventId', options.eventId);
      const query = params.toString() ? `?${params.toString()}` : '';
      return request<{
        total: number;
        page: number;
        limit: number;
        totalPages: number;
        entries: FinancialLedgerEntryItem[];
      }>(`/organizer/finance/ledger${query}`);
    },
    reconcile: () =>
      request<{
        isReconciled: boolean;
        discrepancies: string[];
        balanceRecord: any;
        ledgerTotals: any;
      }>('/organizer/finance/reconcile'),
    updatePayoutSchedule: (payload: {
      interval: 'manual' | 'daily' | 'weekly' | 'monthly';
      weeklyAnchor?: string;
      monthlyAnchor?: number;
      delayDays?: number;
    }) =>
      request<{
        success: boolean;
        payoutSchedule: {
          interval: string;
          delayDays: number;
          weeklyAnchor: string | null;
          monthlyAnchor: number | null;
        };
      }>('/organizer/finance/payout-schedule', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
  },
  places: {
    status: () =>
      request<{
        configured: boolean;
        defaultCountryCode?: string;
      }>('/places/status'),
    autocomplete: (params: { input: string; sessionToken?: string; countryCode?: string }) => {
      const searchParams = new URLSearchParams();
      searchParams.append('input', params.input);
      if (params.sessionToken) searchParams.append('sessionToken', params.sessionToken);
      if (params.countryCode) searchParams.append('countryCode', params.countryCode);
      return request<{
        configured: boolean;
        suggestions: Array<{
          placeId: string;
          text: string;
          mainText: string;
          secondaryText: string;
          types: string[];
        }>;
      }>(`/places/autocomplete?${searchParams.toString()}`);
    },
    details: (placeId: string, sessionToken?: string) => {
      const searchParams = new URLSearchParams();
      if (sessionToken) searchParams.append('sessionToken', sessionToken);
      const query = searchParams.toString() ? `?${searchParams.toString()}` : '';
      return request<{
        configured: boolean;
        details: {
          placeId: string;
          venueName: string;
          venueAddress: string;
          latitude: number | null;
          longitude: number | null;
          city: string;
          stateCode?: string | null;
          country: string;
          countryCode?: string | null;
          suggestedTimezone?: string | null;
        } | null;
      }>(`/places/details/${encodeURIComponent(placeId)}${query}`);
    },
  },
};


