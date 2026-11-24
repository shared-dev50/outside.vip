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
  OrganizerOrdersResponse,
  EventTeamRole,
  EventAdminPermissions,
  EventTeamMemberItem,
  EventTeamInvitationItem,
  EventTeamData,
  TeamInvitationMetadata,
  AcceptTeamInvitationResult,
  PromotionLinkItem,
  PromotionLinkStatus,
  EventPromotionalAnalytics,
  CustomizeSlugResult,
  HostAssignedEventItem,
  HostPromotionalAnalytics,
  OrderRefundSummary,
  RefundQuotePreview,
  InitiateOrderRefundPayload,
  InitiateOrderRefundResult,
} from '../types';

export interface EventStaffMember {
  id: string;
  userId: string;
  email: string;
  name: string;
  status: 'ACTIVE' | 'REVOKED';
  assignedAt: string;
  assignedByName: string;
}

export interface EventStaffInvitationItem {
  id: string;
  email: string;
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
  expiresAt: string;
  createdAt: string;
  invitedByName: string;
  canResend: boolean;
  resendCooldownSeconds: number;
}

export interface EventTeamResponse {
  staff: EventStaffMember[];
  invitations: EventStaffInvitationItem[];
}

export interface ScannerGateItem {
  id: string;
  title: string;
  slug: string;
  startAt: string;
  endAt: string;
  venueName?: string | null;
  city?: string | null;
  country?: string | null;
  role: 'ADMIN' | 'ORGANIZER' | 'STAFF';
}

export interface StaffInvitationMetadataResponse {
  invitation: {
    id: string;
    status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
    expiresAt: string;
    maskedEmail: string;
    hasPassword: boolean;
    requiresLogin: boolean;
    isCurrentAccount: boolean;
    isAssignmentActive?: boolean;
    canResumeSession?: boolean;
  };
  event: {
    id: string;
    title: string;
    slug: string;
    startAt: string;
    endAt: string;
    venueName: string;
    city: string;
    country: string;
    organizerName: string;
  };
}

const PROXIED_API_HOSTS = new Set([
  'outside-vip.onrender.com',
  'outside.vip',
  'www.outside.vip',
  'outside-vip.vercel.app',
]);

/**
 * Resolves the API base URL. Defaults to relative `/api` so browser requests
 * route through the same-origin Vercel `/api/:path*` proxy, preserving
 * `__Host-` session cookies and avoiding cross-origin CORS preflights.
 */
export function resolveApiBaseUrl(rawUrl?: string): string {
  const url = (rawUrl ?? '').trim();
  if (!url) {
    return '/api';
  }

  const clean = url.replace(/\/+$/, '');

  if (!clean || clean === '/api') {
    return '/api';
  }

  try {
    const parsed = new URL(clean);
    if (
      PROXIED_API_HOSTS.has(parsed.hostname.toLowerCase()) ||
      (typeof window !== 'undefined' &&
        window.location?.origin &&
        parsed.origin === window.location.origin)
    ) {
      return '/api';
    }
  } catch {
    // Relative path
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
  public retryAfter?: number;

  constructor(
    message: string,
    statusCode: number,
    details?: Array<{ field: string; message: string }>,
    data?: any,
    code?: string,
    retryAfter?: number
  ) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.data = data;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

let activeCsrfToken: string | null = null;

export function getActiveCsrfToken(): string | null {
  return activeCsrfToken;
}

export function setActiveCsrfToken(token: string | null): void {
  activeCsrfToken = token;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const hasJsonBody =
    options.body !== undefined &&
    options.body !== null &&
    (typeof FormData === 'undefined' || !(options.body instanceof FormData));
  const headers: Record<string, string> = {
    ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
    ...(MUTATING_METHODS.has(method) && activeCsrfToken
      ? { 'X-CSRF-Token': activeCsrfToken }
      : {}),
    ...((options.headers as Record<string, string>) || {}),
  };

  const response = await fetch(buildApiUrl(endpoint), {
    ...options,
    credentials: 'include',
    headers,
  });

  if (typeof response.headers?.get === 'function') {
    const headerCsrf = response.headers.get('x-csrf-token');
    if (headerCsrf) {
      activeCsrfToken = headerCsrf;
    }
  }

  const json: ApiResponse<T> = await response.json().catch(() => ({
    success: false,
    data: null as any,
    error: { message: 'Unexpected network response', statusCode: response.status },
  }));

  if (json?.data && typeof (json.data as any).csrfToken === 'string') {
    activeCsrfToken = (json.data as any).csrfToken;
  }

  if (!response.ok || !json.success) {
    const message =
      json.error?.message ||
      (json as any)?.message ||
      (json.data as any)?.message ||
      'An unexpected error occurred';
    const statusCode = json.error?.statusCode || response.status;
    const code = (json.error as any)?.code || (json.data as any)?.result;
    const rawBodyRetryAfter = (json.error as any)?.retryAfter;
    const rawHeaderRetryAfter =
      typeof response.headers?.get === 'function'
        ? response.headers.get('retry-after')
        : null;
    const parsedHeaderRetryAfter =
      rawHeaderRetryAfter !== null && rawHeaderRetryAfter !== ''
        ? Number(rawHeaderRetryAfter)
        : NaN;
    const retryAfter =
      typeof rawBodyRetryAfter === 'number' && Number.isFinite(rawBodyRetryAfter) && rawBodyRetryAfter > 0
        ? rawBodyRetryAfter
        : Number.isFinite(parsedHeaderRetryAfter) && parsedHeaderRetryAfter > 0
          ? parsedHeaderRetryAfter
          : undefined;

    throw new ApiError(message, statusCode, json.error?.details, json.data, code, retryAfter);
  }

  return (json as any).data !== undefined ? (json as any).data : (json as any);
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
  signal?: AbortSignal,
  withCredentials = false
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('Upload was aborted by user.'));
    }

    const xhr = new XMLHttpRequest();
    if (withCredentials) {
      xhr.withCredentials = true;
    }

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
    getWorkspace: () => request<{ organizer: User['organizer'] }>('/organizer/workspace'),
    upsertWorkspace: (payload: {
      displayName: string;
      bio?: string | null;
      websiteUrl?: string | null;
      instagramHandle?: string | null;
      twitterHandle?: string | null;
      logoUrl?: string | null;
    }) =>
      request<{ organizer: User['organizer'] }>('/organizer/workspace', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    listEvents: () => request<{ events: OrganizerEventItem[] }>('/organizer/events'),
    getOrders: (params?: {
      status?: string;
      eventId?: string;
      search?: string;
      page?: number;
      limit?: number;
      sortBy?: 'createdAt' | 'updatedAt' | 'totalInCents' | 'orderNumber';
      sortOrder?: 'asc' | 'desc';
    }) => {
      const searchParams = new URLSearchParams();
      if (params?.status) searchParams.append('status', params.status);
      if (params?.eventId) searchParams.append('eventId', params.eventId);
      if (params?.search) searchParams.append('search', params.search);
      if (params?.page) searchParams.append('page', params.page.toString());
      if (params?.limit) searchParams.append('limit', params.limit.toString());
      if (params?.sortBy) searchParams.append('sortBy', params.sortBy);
      if (params?.sortOrder) searchParams.append('sortOrder', params.sortOrder);
      const query = searchParams.toString() ? `?${searchParams.toString()}` : '';
      return request<OrganizerOrdersResponse>(`/organizer/orders${query}`);
    },
    getEvent: (id: string) =>
      request<{
        event: Event & {
          isOwner?: boolean;
          accessRole?: 'OWNER' | 'ADMIN';
          permissions?: EventAdminPermissions | null;
        };
      }>(`/organizer/events/${id}`),
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
    getOrderRefunds: (orderId: string) =>
      request<OrderRefundSummary>(`/organizer/orders/${encodeURIComponent(orderId)}/refunds`),
    previewOrderRefund: (
      orderId: string,
      payload: {
        ticketIds: string[];
        refundStripeProcessingFee?: boolean;
        feeBearer?: 'ORGANIZER' | 'PLATFORM' | 'SHARED';
        restoreInventory?: boolean;
        allowCheckedInOverride?: boolean;
        overrideReason?: string;
      }
    ) =>
      request<RefundQuotePreview>(
        `/organizer/orders/${encodeURIComponent(orderId)}/refunds/preview`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        }
      ),
    initiateOrderRefund: (orderId: string, payload: InitiateOrderRefundPayload) =>
      request<InitiateOrderRefundResult>(
        `/organizer/orders/${encodeURIComponent(orderId)}/refunds`,
        {
          method: 'POST',
          headers: payload.idempotencyKey
            ? { 'Idempotency-Key': payload.idempotencyKey }
            : undefined,
          body: JSON.stringify(payload),
        }
      ),
    checkInTicket: (payload: { token: string; eventId?: string; idempotencyKey?: string }) =>
      request<{
        result: 'SUCCESS' | 'ALREADY_CHECKED_IN' | 'INVALID_TOKEN' | 'WRONG_EVENT' | 'CANCELLED_TICKET' | 'REFUND_PENDING_TICKET' | 'REFUNDED_TICKET' | 'UNPAID_ORDER' | 'TICKET_NOT_YET_VALID' | 'TICKET_EXPIRED';
        message: string;
        ticket?: any;
        totalCheckedIn?: number;
      }>('/organizer/check-in', {
        method: 'POST',
        headers: payload.idempotencyKey ? { 'Idempotency-Key': payload.idempotencyKey } : undefined,
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
        if (activeCsrfToken) {
          headers['X-CSRF-Token'] = activeCsrfToken;
        }

        if (typeof XMLHttpRequest !== 'undefined') {
          const serverJson = await xhrPost<any>(
            buildApiUrl('/organizer/upload'),
            serverFormData,
            headers,
            onProgress,
            signal,
            true
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
          credentials: 'include',
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
    csrf: () => request<{ csrfToken: string }>('/auth/csrf'),
    me: () => request<{ user: User; csrfToken?: string }>('/auth/me'),
    login: (credentials: { email: string; password: string }) =>
      request<{ user: User; csrfToken?: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(credentials),
      }),
    requestLoginOtp: (payload: { email: string }) =>
      request<{ message: string; cooldownSeconds: number; expiresInMinutes: number }>(
        '/auth/otp/request',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        }
      ),
    verifyLoginOtp: (payload: { email: string; code: string }) =>
      request<{ user: User; csrfToken?: string }>('/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    register: (data: { email: string; password: string; name: string; role?: string; organizerDisplayName?: string }) =>
      request<{ user: User; csrfToken?: string; verificationRequired?: boolean }>('/auth/register', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    logout: async () => {
      const res = await request<{ message: string }>('/auth/logout', {
        method: 'POST',
      });
      activeCsrfToken = null;
      return res;
    },
    logoutAll: async () => {
      const res = await request<{ revokedCount: number; message: string }>('/auth/logout-all', {
        method: 'POST',
      });
      activeCsrfToken = null;
      return res;
    },
    changePassword: (payload: { currentPassword: string; newPassword: string }) =>
      request<{ message: string; csrfToken?: string }>('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    verifyEmail: (payload: { code: string; email?: string }) =>
      request<{ user: User; csrfToken?: string }>('/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    resendVerification: (payload?: { email?: string }) =>
      request<{ message: string; expiresAt: string; cooldownSeconds: number }>(
        '/auth/resend-verification',
        {
          method: 'POST',
          body: JSON.stringify(payload || {}),
        }
      ),
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

      const headers: HeadersInit = {};
      if (token) {
        headers['x-order-token'] = token;
      }

      const res = await fetch(buildApiUrl(`/orders/${orderNumber}/tickets/pdf${qs}`), {
        method: 'GET',
        credentials: 'include',
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
  staff: {
    getTeam: (eventId: string) =>
      request<EventTeamResponse>(`/organizer/events/${eventId}/team`),
    invite: (eventId: string, email: string) =>
      request<{
        invitation: EventStaffInvitationItem;
        emailDeliveryFailed?: boolean;
        message?: string;
      }>(`/organizer/events/${eventId}/team/invitations`, {
        method: 'POST',
        body: JSON.stringify({ email }),
      }),
    resendInvitation: (eventId: string, invitationId: string) =>
      request<{
        success: boolean;
        message: string;
        cooldownSeconds: number;
      }>(`/organizer/events/${eventId}/team/invitations/${invitationId}/resend`, {
        method: 'POST',
      }),
    revokeInvitation: (eventId: string, invitationId: string) =>
      request<{ success: boolean; message: string }>(
        `/organizer/events/${eventId}/team/invitations/${invitationId}`,
        { method: 'DELETE' }
      ),
    revokeMember: (eventId: string, userId: string) =>
      request<{ success: boolean; message: string }>(
        `/organizer/events/${eventId}/team/members/${userId}`,
        { method: 'DELETE' }
      ),
  },
  staffInvitation: {
    getMetadata: (token: string) =>
      request<StaffInvitationMetadataResponse>(`/staff/invitations/${token}`),
    requestOtp: (token: string) =>
      request<{
        message: string;
        cooldownSeconds: number;
        expiresInMinutes: number;
      }>(`/staff/invitations/${token}/request-otp`, {
        method: 'POST',
      }),
    verifyOtp: (token: string, code: string) =>
      request<{
        user: any;
        csrfToken?: string;
        token?: string;
        eventId: string;
        status: string;
      }>(`/staff/invitations/${token}/verify-otp`, {
        method: 'POST',
        body: JSON.stringify({ code }),
      }),
    acceptWithSession: (token: string) =>
      request<{
        success: boolean;
        user: any;
        eventId: string;
        status: string;
      }>(`/staff/invitations/${token}/accept`, {
        method: 'POST',
      }),
  },
  scanner: {
    ping: () =>
      request<{
        timestamp: number;
      }>('/scanner/ping'),
    getGates: () =>
      request<{
        events: ScannerGateItem[];
      }>('/scanner/gates'),
    checkIn: (payload: { token: string; eventId?: string; idempotencyKey?: string }) =>
      request<{
        result:
          | 'SUCCESS'
          | 'ALREADY_CHECKED_IN'
          | 'INVALID_TOKEN'
          | 'WRONG_EVENT'
          | 'CANCELLED_TICKET'
          | 'REFUND_PENDING_TICKET'
          | 'REFUNDED_TICKET'
          | 'UNPAID_ORDER'
          | 'TICKET_NOT_YET_VALID'
          | 'TICKET_EXPIRED';
        message: string;
        ticket?: any;
        totalCheckedIn?: number;
      }>('/scanner/check-in', {
        method: 'POST',
        headers: payload.idempotencyKey ? { 'Idempotency-Key': payload.idempotencyKey } : undefined,
        body: JSON.stringify(payload),
      }),
  },
  team: {
    getTeam: async (eventId: string): Promise<EventTeamData> => {
      const res = await request<{ team: EventTeamData }>(`/events/${eventId}/team`);
      return res.team;
    },
    invite: async (
      eventId: string,
      data: {
        email: string;
        role: EventTeamRole;
        permissions?: Partial<EventAdminPermissions> | null;
      }
    ): Promise<EventTeamInvitationItem> => {
      const res = await request<{ invitation: EventTeamInvitationItem }>(
        `/events/${eventId}/team/invitations`,
        {
          method: 'POST',
          body: JSON.stringify(data),
        }
      );
      return res.invitation;
    },
    resendInvitation: async (
      eventId: string,
      invitationId: string
    ): Promise<EventTeamInvitationItem> => {
      const res = await request<{ invitation: EventTeamInvitationItem }>(
        `/events/${eventId}/team/invitations/${invitationId}/resend`,
        { method: 'POST' }
      );
      return res.invitation;
    },
    revokeInvitation: async (
      eventId: string,
      invitationId: string
    ): Promise<{ success: boolean; message: string }> => {
      return request<{ success: boolean; message: string }>(
        `/events/${eventId}/team/invitations/${invitationId}`,
        { method: 'DELETE' }
      );
    },
    updateMember: async (
      eventId: string,
      memberId: string,
      data: {
        role?: EventTeamRole;
        status?: 'ACTIVE' | 'INACTIVE';
        permissions?: Partial<EventAdminPermissions> | null;
      }
    ): Promise<EventTeamMemberItem> => {
      const res = await request<{ member: EventTeamMemberItem }>(
        `/events/${eventId}/team/members/${memberId}`,
        {
          method: 'PATCH',
          body: JSON.stringify(data),
        }
      );
      return res.member;
    },
    revokeMember: async (
      eventId: string,
      memberId: string
    ): Promise<{ success: boolean; message: string }> => {
      return request<{ success: boolean; message: string }>(
        `/events/${eventId}/team/members/${memberId}`,
        { method: 'DELETE' }
      );
    },
    inspectInvitation: async (token: string): Promise<TeamInvitationMetadata> => {
      const res = await request<{ invitation: TeamInvitationMetadata }>(
        `/team/invitations/${encodeURIComponent(token)}`
      );
      return res.invitation;
    },
    acceptInvitation: async (token: string): Promise<AcceptTeamInvitationResult> => {
      const res = await request<{ membership: AcceptTeamInvitationResult }>(
        `/team/invitations/${encodeURIComponent(token)}/accept`,
        { method: 'POST' }
      );
      return res.membership;
    },
  },
  promotions: {
    getLinks: async (eventId: string): Promise<PromotionLinkItem[]> => {
      const res = await request<{ links: PromotionLinkItem[] }>(
        `/events/${eventId}/promotions/links`
      );
      return res.links;
    },
    createCampaignLink: async (
      eventId: string,
      data: { name: string; slug?: string }
    ): Promise<PromotionLinkItem> => {
      const res = await request<{ link: PromotionLinkItem }>(
        `/events/${eventId}/promotions/links`,
        {
          method: 'POST',
          body: JSON.stringify(data),
        }
      );
      return res.link;
    },
    updateLink: async (
      eventId: string,
      linkId: string,
      data: { name?: string; status?: PromotionLinkStatus }
    ): Promise<PromotionLinkItem> => {
      const res = await request<{ link: PromotionLinkItem }>(
        `/events/${eventId}/promotions/links/${linkId}`,
        {
          method: 'PATCH',
          body: JSON.stringify(data),
        }
      );
      return res.link;
    },
    customizeSlug: async (
      eventId: string,
      linkId: string,
      slug: string
    ): Promise<CustomizeSlugResult> => {
      return request<CustomizeSlugResult>(
        `/events/${eventId}/promotions/links/${linkId}/slug`,
        {
          method: 'POST',
          body: JSON.stringify({ slug }),
        }
      );
    },
    getAnalytics: async (
      eventId: string,
      params?: { linkId?: string; startDate?: string; endDate?: string }
    ): Promise<EventPromotionalAnalytics> => {
      const query = new URLSearchParams();
      if (params?.linkId) query.append('linkId', params.linkId);
      if (params?.startDate) query.append('startDate', params.startDate);
      if (params?.endDate) query.append('endDate', params.endDate);
      const queryStr = query.toString() ? `?${query.toString()}` : '';

      const res = await request<{ analytics: EventPromotionalAnalytics }>(
        `/events/${eventId}/promotions/analytics${queryStr}`
      );
      return res.analytics;
    },
  },
  host: {
    getEvents: async (): Promise<HostAssignedEventItem[]> => {
      const res = await request<{ events: HostAssignedEventItem[] }>('/host/events');
      return res.events;
    },
    getAnalytics: async (eventId: string): Promise<HostPromotionalAnalytics> => {
      return request<HostPromotionalAnalytics>(`/host/events/${eventId}/analytics`);
    },
    customizeSlug: async (
      eventId: string,
      slug: string
    ): Promise<CustomizeSlugResult> => {
      return request<CustomizeSlugResult>(`/host/events/${eventId}/slug`, {
        method: 'PATCH',
        body: JSON.stringify({ slug }),
      });
    },
  },
};


