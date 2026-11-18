import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  Camera, 
  CameraOff,
  RotateCw,
  Keyboard, 
  ShieldCheck, 
  RefreshCw,
  Loader2,
  Lock,
  KeyRound,
  WifiOff,
} from 'lucide-react';
import { api } from '../lib/api';
import { useOptionalAuth } from '../context/AuthContext';
import { User } from '../types';
import { 
  CameraStatus, 
  getCameraErrorDetails, 
  extractTicketToken, 
  isDuplicateScan, 
  decodeVideoFrame 
} from '../lib/scanner';

type ScanStatus =
  | 'idle'
  | 'valid'
  | 'already_used'
  | 'invalid'
  | 'wrong_event'
  | 'cancelled'
  | 'unpaid'
  | 'forbidden'
  | 'session_expired'
  | 'not_yet_valid'
  | 'expired'
  | 'network_error';

interface EventOption {
  id: string;
  title: string;
  slug: string;
}

const DEFAULT_EVENTS: EventOption[] = [];

interface ScannerPageProps {
  initialUser?: User | null;
}

function useOptionalNavigate() {
  try {
    return useNavigate();
  } catch {
    return (to: any) => {
      if (typeof window !== 'undefined') {
        window.location.href = typeof to === 'string' ? to : to.pathname;
      }
    };
  }
}

export const ScannerPage: React.FC<ScannerPageProps> = ({ initialUser }) => {
  const navigate = useOptionalNavigate();
  const auth = useOptionalAuth();
  const user = initialUser !== undefined ? initialUser : auth?.user;

  const [inviteToken] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const paramToken = params.get('invite') || params.get('invitation') || params.get('token');
      if (paramToken) {
        try {
          sessionStorage.setItem('outside_scanner_invite_token', paramToken);
        } catch {}

        // Sanitize the URL immediately: remove invite, invitation, and token query parameters
        // using window.history.replaceState to avoid creating a new browser history entry,
        // while preserving unrelated query parameters such as event or slug.
        try {
          if (window.history && typeof window.history.replaceState === 'function') {
            const url = new URL(window.location.href);
            url.searchParams.delete('invite');
            url.searchParams.delete('invitation');
            url.searchParams.delete('token');
            const cleanSearch = url.searchParams.toString();
            const cleanPath = url.pathname + (cleanSearch ? `?${cleanSearch}` : '') + url.hash;
            window.history.replaceState(window.history.state, document.title, cleanPath);
          }
        } catch {}

        return paramToken;
      }
      try {
        return sessionStorage.getItem('outside_scanner_invite_token');
      } catch {
        return null;
      }
    }
    return null;
  });

  const [selectedEventId, setSelectedEventId] = useState('');
  const [eventsList, setEventsList] = useState<EventOption[]>(DEFAULT_EVENTS);
  const [isLoadingEvents, setIsLoadingEvents] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [ticketInput, setTicketInput] = useState('');
  const [scanStatus, setScanStatus] = useState<ScanStatus>('idle');
  const [ticketMeta, setTicketMeta] = useState<any>(null);
  const [checkInCount, setCheckInCount] = useState(0);
  const [isValidating, setIsValidating] = useState(false);

  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle');
  const [cameraErrorMessage, setCameraErrorMessage] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastScannedRef = useRef<{ token: string; timestamp: number } | null>(null);
  const isValidatingRef = useRef(false);
  const isScanningPausedRef = useRef(false);
  const scanStatusRef = useRef<ScanStatus>('idle');
  const pendingScanRef = useRef<{
    token: string;
    gateId?: string;
    idempotencyKey: string;
  } | null>(null);

  // Keep refs in sync with state for access in frame loop
  useEffect(() => {
    isValidatingRef.current = isValidating;
  }, [isValidating]);

  useEffect(() => {
    scanStatusRef.current = scanStatus;
  }, [scanStatus]);

  useEffect(() => {
    let isMounted = true;
    const fetchEvents = async () => {
      setIsLoadingEvents(true);
      try {
        const gatesRes = await api.scanner.getGates();
        if (isMounted && gatesRes.events && gatesRes.events.length > 0) {
          const list: EventOption[] = gatesRes.events.map((e) => ({
            id: e.id,
            title: e.title,
            slug: e.slug,
          }));
          setEventsList(list);
          setIsLoadingEvents(false);
          return;
        }

        if (isMounted && user?.role === 'ATTENDEE') {
          setEventsList([]);
          setIsLoadingEvents(false);
          return;
        }
      } catch (err) {
        console.warn('Could not load scanner gates directly:', err);
        if (isMounted && user?.role === 'ATTENDEE') {
          setEventsList([]);
          setIsLoadingEvents(false);
          return;
        }
      }

      try {
        const orgRes = await api.organizer.listEvents();
        if (isMounted && orgRes.events && orgRes.events.length > 0) {
          const list: EventOption[] = orgRes.events.map((e) => ({
            id: e.id,
            title: e.title,
            slug: e.slug,
          }));
          setEventsList((prev) => {
            const map = new Map<string, EventOption>();
            [...prev, ...list].forEach((item) => {
              map.set(item.id, item);
              if (item.slug) map.set(item.slug, item);
            });
            return Array.from(new Set(Array.from(map.values())));
          });
        }
      } catch {}

      try {
        const publicRes = await api.events.list({ limit: 100 });
        if (isMounted && publicRes.events && publicRes.events.length > 0) {
          const list: EventOption[] = publicRes.events.map((e) => ({
            id: e.id,
            title: e.title,
            slug: e.slug,
          }));
          setEventsList((prev) => {
            const map = new Map<string, EventOption>();
            [...prev, ...list].forEach((item) => {
              map.set(item.id, item);
              if (item.slug) map.set(item.slug, item);
            });
            return Array.from(new Set(Array.from(map.values())));
          });
        }
      } catch (err) {
        console.warn('Could not load public events for scanner:', err);
      } finally {
        if (isMounted) setIsLoadingEvents(false);
      }
    };

    fetchEvents();

    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const eventParam = params.get('event') || params.get('slug');
      if (eventParam) {
        setSelectedEventId(eventParam);
      }
    }

    return () => {
      isMounted = false;
    };
  }, [user?.role, refreshTrigger]);

  // ========================================================
  // Camera & Viewfinder Resource Management
  // ========================================================
  const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  const isPingingRef = useRef(false);
  const heartbeatTimerRef = useRef<NodeJS.Timeout | null>(null);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  const stopCamera = useCallback(() => {
    stopHeartbeat();

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {}
      });
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setCameraStatus('idle');
    setCameraErrorMessage(null);
  }, [stopHeartbeat]);

  useEffect(() => {
    let isMounted = true;

    const sendHeartbeat = async () => {
      if (isPingingRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (cameraStatus !== 'active') return;
      if (scanStatusRef.current === 'forbidden' || scanStatusRef.current === 'session_expired') return;

      isPingingRef.current = true;
      try {
        await api.scanner.ping();
      } catch (err: any) {
        if (!isMounted) return;
        const status = err?.statusCode;
        if (status === 401) {
          scanStatusRef.current = 'session_expired';
          isScanningPausedRef.current = true;
          pendingScanRef.current = null;
          stopCamera();
          stopHeartbeat();
          setScanStatus('session_expired');
          setTicketMeta({
            note: 'Your scanner session has expired due to inactivity. Please resume your session.',
          });
          return;
        }
        if (status === 403) {
          scanStatusRef.current = 'forbidden';
          isScanningPausedRef.current = true;
          pendingScanRef.current = null;
          stopCamera();
          stopHeartbeat();
          setScanStatus('forbidden');
          setTicketMeta({
            note: err?.message || 'You do not have permission to check in tickets at this gate. Your staff assignment may have been revoked.',
          });
          return;
        }
        console.warn('[Scanner Heartbeat] Transient ping failure:', err?.message || err);
      } finally {
        isPingingRef.current = false;
      }
    };

    const startHeartbeat = () => {
      if (heartbeatTimerRef.current) return;
      heartbeatTimerRef.current = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    };

    const handleVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'visible') {
        if (cameraStatus === 'active' && scanStatusRef.current !== 'forbidden' && scanStatusRef.current !== 'session_expired') {
          sendHeartbeat();
          startHeartbeat();
        }
      } else {
        stopHeartbeat();
      }
    };

    if (cameraStatus === 'active' && scanStatusRef.current !== 'forbidden' && scanStatusRef.current !== 'session_expired') {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        startHeartbeat();
      }
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', handleVisibilityChange);
      }
    } else {
      stopHeartbeat();
    }

    return () => {
      isMounted = false;
      stopHeartbeat();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, [cameraStatus, stopCamera, stopHeartbeat]);

  const startCamera = useCallback(async (preferredFacing: 'environment' | 'user' = facingMode) => {
    if (scanStatusRef.current === 'forbidden' || scanStatusRef.current === 'session_expired') {
      return;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    setCameraStatus('requesting');
    setCameraErrorMessage(null);

      if (typeof window !== 'undefined') {
      const isLocalhost =
        window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      if (!window.isSecureContext && !isLocalhost) {
        setCameraStatus('insecure');
        setCameraErrorMessage('Camera video streaming requires a secure HTTPS connection.');
        return;
      }
    }

      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setCameraStatus('unsupported');
      setCameraErrorMessage(
        'Your browser does not support camera access. Please use Safari, Chrome, Edge, or Firefox.'
      );
      return;
    }

    try {
      let stream: MediaStream;
      try {
        // Attempt ideal facing mode (rear camera first)
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: preferredFacing },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      } catch (err: any) {
        // If facingMode constraint failed (e.g. desktop webcam without environment mode), retry with basic video
        if (err?.name === 'OverconstrainedError' || err?.name === 'ConstraintNotSatisfiedError') {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        } else {
          throw err;
        }
      }

      streamRef.current = stream;
      setFacingMode(preferredFacing);
      setCameraStatus('active');
      setCameraErrorMessage(null);
      isScanningPausedRef.current = false;
      lastScannedRef.current = null;

          if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true');
        videoRef.current.muted = true;
        try {
          await videoRef.current.play();
        } catch (playErr) {
          console.warn('Video auto-playback deferred:', playErr);
        }
      }
    } catch (err: any) {
      const details = getCameraErrorDetails(err);
      setCameraStatus(details.type as CameraStatus);
      setCameraErrorMessage(details.message);
    }
  }, [facingMode]);

  const toggleFacingMode = () => {
    const nextMode = facingMode === 'environment' ? 'user' : 'environment';
    startCamera(nextMode);
  };

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  useEffect(() => {
    if (scanStatus === 'idle' && cameraStatus === 'active' && streamRef.current && videoRef.current) {
      if (videoRef.current.srcObject !== streamRef.current) {
        videoRef.current.srcObject = streamRef.current;
        videoRef.current.setAttribute('playsinline', 'true');
        videoRef.current.muted = true;
        videoRef.current.play().catch(() => {});
      }
      isScanningPausedRef.current = false;
    }
  }, [scanStatus, cameraStatus]);

  const handleValidateToken = async (
    token: string,
    overrideGateId?: string,
    isRetry = false
  ) => {
    if (
      scanStatusRef.current === 'forbidden' ||
      scanStatusRef.current === 'session_expired'
    ) {
      return;
    }

    const trimmed = extractTicketToken(token);
    if (!trimmed || isValidatingRef.current) return;

    // Synchronous guard against rapid clicks / enter key / camera frames
    isValidatingRef.current = true;
    setIsValidating(true);
    const gateId = overrideGateId !== undefined ? overrideGateId : selectedEventId;

    let idempotencyKey: string;
    if (
      isRetry &&
      pendingScanRef.current &&
      pendingScanRef.current.token === trimmed &&
      pendingScanRef.current.gateId === (gateId || undefined)
    ) {
      idempotencyKey = pendingScanRef.current.idempotencyKey;
    } else {
      idempotencyKey = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      pendingScanRef.current = {
        token: trimmed,
        gateId: gateId || undefined,
        idempotencyKey,
      };
    }

    try {
      const res = await api.scanner.checkIn({
        token: trimmed,
        eventId: gateId || undefined,
        idempotencyKey,
      });

      if (res.result === 'SUCCESS') {
        // Confirmed successful admission clears pending retry state
        pendingScanRef.current = null;
        setScanStatus('valid');
        setTicketMeta({
          attendee: res.ticket?.attendeeName || 'Verified Attendee',
          tier: res.ticket?.tierName || 'Pass Tier',
          eventTitle: res.ticket?.eventTitle || '',
          orderNumber: res.ticket?.orderNumber || '',
          checkedInAt: 'Just now',
        });
        if (typeof res.totalCheckedIn === 'number') {
          setCheckInCount(res.totalCheckedIn);
        } else {
          setCheckInCount((prev) => prev + 1);
        }
      }
    } catch (err: any) {
      const code = err.code || err.data?.result;
      const status = err.statusCode;
      const message = err.message || '';

      // On definitive server rejection, clear the pending scan operation
      const isDefinitiveServerRejection =
        code === 'WRONG_EVENT' ||
        code === 'ALREADY_CHECKED_IN' ||
        status === 409 ||
        code === 'CANCELLED_TICKET' ||
        code === 'UNPAID_ORDER' ||
        code === 'INVALID_TOKEN' ||
        status === 404 ||
        code === 'TICKET_NOT_YET_VALID' ||
        code === 'TICKET_EXPIRED' ||
        status === 401 ||
        status === 403;

      if (isDefinitiveServerRejection) {
        pendingScanRef.current = null;
      }

      if (code === 'WRONG_EVENT' || message.toLowerCase().includes('belongs to')) {
        setScanStatus('wrong_event');
        setTicketMeta({
          note: message,
          token: trimmed,
          wrongEvent: err.data?.ticket || err.data?.event,
        });
      } else if (code === 'ALREADY_CHECKED_IN' || status === 409) {
        setScanStatus('already_used');
        setTicketMeta({
          attendee: err.data?.ticket?.attendeeName || message || 'Already checked in',
          tier: err.data?.ticket?.tierName,
          orderNumber: err.data?.ticket?.orderNumber,
          checkedInAt: err.data?.ticket?.checkedInAt
            ? new Date(err.data.ticket.checkedInAt).toLocaleTimeString()
            : 'Prior admission logged',
          checkedBy: err.data?.ticket?.checkedBy || 'Door Staff',
        });
      } else if (code === 'CANCELLED_TICKET' || message.toLowerCase().includes('cancelled')) {
        setScanStatus('cancelled');
        setTicketMeta({ note: message || 'This ticket has been cancelled or refunded.' });
      } else if (code === 'UNPAID_ORDER' || message.toLowerCase().includes('unpaid')) {
        setScanStatus('unpaid');
        setTicketMeta({ note: message || 'The order for this ticket is not completed.' });
      } else if (code === 'INVALID_TOKEN' || status === 404) {
        setScanStatus('invalid');
        setTicketMeta({ note: message || 'Scanned credential does not exist in the database.' });
      } else if (code === 'TICKET_NOT_YET_VALID' || message.toLowerCase().includes('not yet valid')) {
        setScanStatus('not_yet_valid');
        setTicketMeta({
          note: message || 'This ticket is not yet valid for entry.',
          attendee: err.data?.ticket?.attendeeName,
          tier: err.data?.ticket?.tierName,
        });
      } else if (code === 'TICKET_EXPIRED' || message.toLowerCase().includes('validity expired') || message.toLowerCase().includes('expired')) {
        setScanStatus('expired');
        setTicketMeta({
          note: message || 'This ticket validity window has expired.',
          attendee: err.data?.ticket?.attendeeName,
          tier: err.data?.ticket?.tierName,
        });
      } else if (status === 401) {
        scanStatusRef.current = 'session_expired';
        isScanningPausedRef.current = true;
        pendingScanRef.current = null;
        stopCamera();
        stopHeartbeat();
        setScanStatus('session_expired');
        setTicketMeta({
          note: message || 'Your scanner session has expired due to inactivity. Please resume your session.',
        });
      } else if (status === 403) {
        scanStatusRef.current = 'forbidden';
        isScanningPausedRef.current = true;
        pendingScanRef.current = null;
        stopCamera();
        stopHeartbeat();
        setScanStatus('forbidden');
        setTicketMeta({
          note: message || 'You do not have permission to check in tickets at this gate. Your staff assignment may have been revoked.',
        });
      } else {
        // Uncertain outcome (network dropout, dropped socket, timeout)
        // Keep pendingScanRef.current so Retry Check-In sends the EXACT same idempotencyKey!
        setScanStatus('network_error');
        setTicketMeta({
          note: message || 'Unable to connect to the check-in service. Please check your network connection and retry.',
        });
      }
    } finally {
      isValidatingRef.current = false;
      setIsValidating(false);
    }
  };

  const handleRetry = () => {
    if (
      scanStatusRef.current === 'forbidden' ||
      scanStatusRef.current === 'session_expired' ||
      !pendingScanRef.current ||
      isValidatingRef.current
    ) return;
    handleValidateToken(
      pendingScanRef.current.token,
      pendingScanRef.current.gateId,
      true
    );
  };

  useEffect(() => {
    if (cameraStatus !== 'active') return;

    let isMounted = true;
    let lastDetectionTime = 0;

    const scanLoop = async () => {
      if (!isMounted) return;

      const now = Date.now();
      const video = videoRef.current;

      // Throttle detection to ~120ms to minimize mobile CPU & thermal overhead
      if (
        video &&
        !isScanningPausedRef.current &&
        !isValidatingRef.current &&
        scanStatusRef.current === 'idle' &&
        now - lastDetectionTime > 120
      ) {
        lastDetectionTime = now;
        try {
          const rawScanned = await decodeVideoFrame(video, canvasRef.current || undefined);
          if (rawScanned && isMounted) {
            const cleanToken = extractTicketToken(rawScanned);
            if (cleanToken && !isDuplicateScan(cleanToken, lastScannedRef.current, 3500)) {
              lastScannedRef.current = { token: cleanToken, timestamp: now };
              isScanningPausedRef.current = true;
              handleValidateToken(cleanToken);
            }
          }
        } catch {
                }
      }

      if (isMounted && cameraStatus === 'active') {
        animationFrameRef.current = requestAnimationFrame(scanLoop);
      }
    };

    animationFrameRef.current = requestAnimationFrame(scanLoop);

    return () => {
      isMounted = false;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [cameraStatus]);

  const resetScanner = () => {
    if (scanStatusRef.current === 'forbidden' || scanStatusRef.current === 'session_expired') {
      return;
    }
    setScanStatus('idle');
    setTicketMeta(null);
    setTicketInput('');
    lastScannedRef.current = null;
    isScanningPausedRef.current = false;
    pendingScanRef.current = null;
  };

  const hasNoAssignedGates = user?.role === 'ATTENDEE' && !isLoadingEvents && eventsList.length === 0;

  return (
    <div className="max-w-3xl mx-auto px-4 py-10 space-y-8">
      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />

      <div className="text-center space-y-2">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gray-100 border border-gray-200 text-gray-700 text-xs font-mono uppercase tracking-wider font-semibold">
          <ShieldCheck className="w-3.5 h-3.5" />
          Outside.vip Door Operations
        </div>
        <h1 className="font-display font-bold text-2xl sm:text-3xl text-gray-900 tracking-tight">
          Browser Check-In Scanner
        </h1>
        <p className="text-gray-500 text-sm max-w-md mx-auto">
          Cryptographically unguessable token validation with atomic duplicate prevention.
        </p>
      </div>

      {hasNoAssignedGates ? (
        <div className="bg-white rounded-2xl p-8 sm:p-12 text-center border border-gray-200 shadow-sm space-y-4">
          <div className="w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto border border-amber-200/60">
            <Lock className="w-7 h-7" />
          </div>
          <div className="space-y-1.5">
            <h2 className="font-display font-bold text-xl text-gray-900 tracking-tight">
              No Assigned Event Gates
            </h2>
            <p className="text-sm text-gray-500 max-w-md mx-auto leading-relaxed">
              You do not have any active scanner staff assignments. You need an active event assignment before scanning tickets.
            </p>
          </div>
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setRefreshTrigger((prev) => prev + 1)}
              className="px-4 py-2 rounded-xl bg-gray-900 text-white text-xs font-semibold hover:bg-gray-800 transition-colors inline-flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Check for Assignments
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="p-4 rounded-2xl bg-white border border-gray-200 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="w-full sm:w-auto flex-1">
          <div className="flex items-center justify-between sm:justify-start gap-2 mb-1">
            <label className="text-[11px] font-mono text-gray-500 uppercase font-semibold">
              Active Gate Pass
            </label>
            {isLoadingEvents && (
              <span className="text-[10px] text-gray-400 font-mono inline-flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading gates...
              </span>
            )}
          </div>
          <select
            value={selectedEventId}
            onChange={(e) => {
              setSelectedEventId(e.target.value);
              resetScanner();
            }}
            className="w-full sm:w-96 px-3 py-2 rounded-xl bg-gray-50 border border-gray-200 text-gray-900 text-xs font-semibold focus:outline-none focus:border-gray-900"
          >
            <option value="">All Gates · Auto-Detect Event</option>
            {eventsList.map((evt) => (
              <option key={evt.id} value={evt.slug || evt.id}>
                {evt.title}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <span className="text-[10px] uppercase font-mono text-gray-500 block">Admissions</span>
            <span className="font-display font-bold text-lg text-gray-900 font-mono">{checkInCount} Checked In</span>
          </div>
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
        </div>
      </div>

      <div className="bg-white rounded-2xl p-6 sm:p-8 space-y-6 border border-gray-200 shadow-sm">
        {scanStatus === 'idle' ? (
          <div className="space-y-6">
            <div className="relative aspect-square sm:aspect-[16/10] rounded-xl bg-gray-900 border-2 border-dashed border-gray-300 flex flex-col items-center justify-center text-center overflow-hidden">
              {cameraStatus === 'active' && (
                <>
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    autoPlay
                    className="w-full h-full object-cover"
                  />

                  <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute top-4 left-4 w-7 h-7 border-t-2 border-l-2 border-emerald-400" />
                    <div className="absolute top-4 right-4 w-7 h-7 border-t-2 border-r-2 border-emerald-400" />
                    <div className="absolute bottom-4 left-4 w-7 h-7 border-b-2 border-l-2 border-emerald-400" />
                    <div className="absolute bottom-4 right-4 w-7 h-7 border-b-2 border-r-2 border-emerald-400" />

                    <div className="absolute left-8 right-8 h-0.5 bg-gradient-to-r from-transparent via-emerald-400 to-transparent animate-qr-scan shadow-[0_0_12px_#34d399]" />
                  </div>

                  <div className="absolute top-3 inset-x-3 flex items-center justify-between pointer-events-auto">
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-black/60 backdrop-blur-md text-white text-[11px] font-mono font-medium border border-white/10">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                      Live Viewfinder ({facingMode === 'environment' ? 'Rear' : 'Front'})
                    </span>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={toggleFacingMode}
                        title="Switch camera"
                        className="p-2 rounded-xl bg-black/60 backdrop-blur-md text-white hover:bg-black/80 transition-colors border border-white/10"
                      >
                        <RotateCw className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={stopCamera}
                        title="Stop camera"
                        className="p-2 rounded-xl bg-black/60 backdrop-blur-md text-white hover:bg-black/80 transition-colors border border-white/10"
                      >
                        <CameraOff className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div className="absolute bottom-3 inset-x-0 text-center pointer-events-none">
                    <span className="px-3.5 py-1 rounded-full bg-black/60 backdrop-blur-md text-gray-200 text-xs font-medium border border-white/10">
                      Hold attendee ticket QR code inside viewfinder
                    </span>
                  </div>
                </>
              )}

              {cameraStatus === 'requesting' && (
                <div className="p-6 text-center text-white space-y-3">
                  <Loader2 className="w-8 h-8 animate-spin mx-auto text-emerald-400" />
                  <div className="font-semibold text-sm sm:text-base">
                    Requesting Camera Access...
                  </div>
                  <p className="text-xs text-gray-400 max-w-xs mx-auto">
                    Please allow camera permissions in your browser prompt to activate the scanner.
                  </p>
                </div>
              )}

              {cameraStatus === 'permission_denied' && (
                <div className="p-6 text-center text-white space-y-3 max-w-sm">
                  <div className="w-12 h-12 rounded-2xl bg-amber-500/20 text-amber-400 flex items-center justify-center mx-auto border border-amber-500/30">
                    <AlertTriangle className="w-6 h-6" />
                  </div>
                  <div className="font-semibold text-sm sm:text-base text-white">
                    Camera Permission Denied
                  </div>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    {cameraErrorMessage ||
                      'Camera permission was denied. Please allow camera access in your browser or device permissions to scan passes.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => startCamera()}
                    className="px-4 py-2 rounded-xl bg-white text-gray-900 text-xs font-semibold hover:bg-gray-100 transition-colors inline-flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Try Again
                  </button>
                </div>
              )}

              {cameraStatus === 'not_found' && (
                <div className="p-6 text-center text-white space-y-3 max-w-sm">
                  <div className="w-12 h-12 rounded-2xl bg-gray-800 text-gray-400 flex items-center justify-center mx-auto border border-gray-700">
                    <CameraOff className="w-6 h-6" />
                  </div>
                  <div className="font-semibold text-sm sm:text-base text-white">
                    No Camera Detected
                  </div>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    No camera hardware was found on this device. You can validate passes manually using the token entry box below.
                  </p>
                  <button
                    type="button"
                    onClick={() => startCamera()}
                    className="px-4 py-2 rounded-xl bg-white text-gray-900 text-xs font-semibold hover:bg-gray-100 transition-colors inline-flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Re-check Devices
                  </button>
                </div>
              )}

              {cameraStatus === 'in_use' && (
                <div className="p-6 text-center text-white space-y-3 max-w-sm">
                  <div className="w-12 h-12 rounded-2xl bg-amber-500/20 text-amber-400 flex items-center justify-center mx-auto border border-amber-500/30">
                    <AlertTriangle className="w-6 h-6" />
                  </div>
                  <div className="font-semibold text-sm sm:text-base text-white">
                    Camera Occupied
                  </div>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    The camera is currently in use by another application or browser tab. Please close other camera apps and retry.
                  </p>
                  <button
                    type="button"
                    onClick={() => startCamera()}
                    className="px-4 py-2 rounded-xl bg-white text-gray-900 text-xs font-semibold hover:bg-gray-100 transition-colors inline-flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Retry Camera
                  </button>
                </div>
              )}

              {(cameraStatus === 'unsupported' || cameraStatus === 'insecure' || cameraStatus === 'error') && (
                <div className="p-6 text-center text-white space-y-3 max-w-sm">
                  <div className="w-12 h-12 rounded-2xl bg-rose-500/20 text-rose-400 flex items-center justify-center mx-auto border border-rose-500/30">
                    <XCircle className="w-6 h-6" />
                  </div>
                  <div className="font-semibold text-sm sm:text-base text-white">
                    {cameraStatus === 'insecure'
                      ? 'HTTPS Connection Required'
                      : cameraStatus === 'unsupported'
                      ? 'Browser Unsupported'
                      : 'Camera Initialization Failed'}
                  </div>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    {cameraErrorMessage || 'Unable to start camera video preview.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => startCamera()}
                    className="px-4 py-2 rounded-xl bg-white text-gray-900 text-xs font-semibold hover:bg-gray-100 transition-colors inline-flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Retry
                  </button>
                </div>
              )}

              {cameraStatus === 'idle' && (
                <div className="p-6 text-center flex flex-col items-center justify-center space-y-3">
                  <div className="w-16 h-16 rounded-2xl bg-white/10 backdrop-blur shadow-sm flex items-center justify-center text-white mb-1 border border-white/10">
                    <Camera className="w-8 h-8" />
                  </div>
                  <div className="text-white font-semibold text-sm sm:text-base">
                    Device Camera Scanner
                  </div>
                  <p className="text-xs text-gray-400 max-w-xs">
                    Position attendee Outside.vip ticket QR code inside the viewfinder for instant verification.
                  </p>
                  <button
                    type="button"
                    onClick={() => startCamera()}
                    className="mt-2 px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-gray-950 font-semibold text-xs uppercase tracking-wider transition-colors inline-flex items-center gap-2 shadow-lg shadow-emerald-500/20"
                  >
                    <Camera className="w-4 h-4" />
                    Start Camera
                  </button>

                  <div className="absolute top-4 left-4 w-6 h-6 border-t-2 border-l-2 border-gray-600" />
                  <div className="absolute top-4 right-4 w-6 h-6 border-t-2 border-r-2 border-gray-600" />
                  <div className="absolute bottom-4 left-4 w-6 h-6 border-b-2 border-l-2 border-gray-600" />
                  <div className="absolute bottom-4 right-4 w-6 h-6 border-b-2 border-r-2 border-gray-600" />
                </div>
              )}
            </div>

            <div className="space-y-3 pt-2">
              <div className="flex items-center gap-2 text-xs font-mono uppercase text-gray-500 font-semibold">
                <Keyboard className="w-4 h-4" />
                Or Validate Unguessable Token Manually
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="e.g. tkt_sec_..."
                  value={ticketInput}
                  onChange={(e) => setTicketInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleValidateToken(ticketInput);
                    }
                  }}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-white border border-gray-200 text-gray-900 placeholder-gray-400 text-sm font-mono focus:outline-none focus:border-gray-900"
                />
                <button
                  type="button"
                  onClick={() => handleValidateToken(ticketInput)}
                  disabled={isValidating || !ticketInput.trim()}
                  className="px-5 py-2.5 rounded-xl bg-gray-900 hover:bg-black text-white font-medium text-sm transition-colors disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {isValidating && <Loader2 className="w-4 h-4 animate-spin" />}
                  Verify
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="py-8 text-center space-y-6">
            {scanStatus === 'valid' && (
              <div className="space-y-4">
                <div className="w-20 h-20 rounded-full bg-emerald-50 text-emerald-600 mx-auto flex items-center justify-center border border-emerald-200">
                  <CheckCircle2 className="w-10 h-10" />
                </div>
                <div>
                  <span className="px-3.5 py-1 rounded-full bg-emerald-50 text-emerald-700 font-mono font-semibold text-xs uppercase tracking-wider border border-emerald-200 inline-block mb-3">
                    Valid Admission · Admit 1
                  </span>
                  <h2 className="text-2xl sm:text-3xl font-display font-bold text-gray-900">
                    {ticketMeta?.attendee}
                  </h2>
                  <p className="text-sm font-semibold text-gray-700 mt-1 font-mono">
                    {ticketMeta?.tier}
                  </p>
                  {ticketMeta?.eventTitle && (
                    <p className="text-xs text-emerald-700 font-medium mt-1">
                      Event: {ticketMeta.eventTitle}
                    </p>
                  )}
                  <p className="text-xs text-gray-500 mt-2">
                    {ticketMeta?.orderNumber && `Order Ref: ${ticketMeta.orderNumber} · `}Checked In: {ticketMeta?.checkedInAt}
                  </p>
                </div>
              </div>
            )}

            {scanStatus === 'already_used' && (
              <div className="space-y-4">
                <div className="w-20 h-20 rounded-full bg-rose-50 text-rose-600 mx-auto flex items-center justify-center border border-rose-200">
                  <XCircle className="w-10 h-10" />
                </div>
                <div>
                  <span className="px-3.5 py-1 rounded-full bg-rose-50 text-rose-700 font-mono font-semibold text-xs uppercase tracking-wider border border-rose-200 inline-block mb-3">
                    Already Used · Duplicate Prevented
                  </span>
                  <h2 className="text-2xl sm:text-3xl font-display font-bold text-gray-900">
                    {ticketMeta?.attendee}
                  </h2>
                  {ticketMeta?.tier && (
                    <p className="text-sm text-gray-600 mt-1 font-mono">
                      {ticketMeta.tier}
                    </p>
                  )}
                  <p className="text-xs text-rose-600 mt-2 font-mono">
                    Prior Check-In: {ticketMeta?.checkedInAt} {ticketMeta?.checkedBy ? `by ${ticketMeta.checkedBy}` : ''}
                  </p>
                </div>
              </div>
            )}

            {scanStatus === 'wrong_event' && (
              <div className="space-y-4">
                <div className="w-20 h-20 rounded-full bg-amber-50 text-amber-600 mx-auto flex items-center justify-center border border-amber-200">
                  <AlertTriangle className="w-10 h-10" />
                </div>
                <div>
                  <span className="px-3.5 py-1 rounded-full bg-amber-50 text-amber-700 font-mono font-semibold text-xs uppercase tracking-wider border border-amber-200 inline-block mb-3">
                    Wrong Event Pass · Gate Mismatch
                  </span>
                  <h2 className="text-xl sm:text-2xl font-display font-bold text-gray-900">
                    Ticket Belongs to Another Event
                  </h2>
                  <p className="text-sm text-gray-700 mt-2 max-w-md mx-auto">
                    {ticketMeta?.note || 'This pass was issued for a different event than the selected gate.'}
                  </p>
                  {ticketMeta?.wrongEvent?.attendeeName && (
                    <div className="mt-3 inline-block px-4 py-2 rounded-xl bg-gray-50 border border-gray-200 text-xs font-mono text-gray-700">
                      Attendee: <strong className="text-gray-900">{ticketMeta.wrongEvent.attendeeName}</strong>
                      {ticketMeta.wrongEvent.tierName && (
                        <span> · {ticketMeta.wrongEvent.tierName}</span>
                      )}
                    </div>
                  )}
                </div>

                {ticketMeta?.wrongEvent && (ticketMeta.wrongEvent.eventSlug || ticketMeta.wrongEvent.eventId) && (
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() => {
                        const targetGate = ticketMeta.wrongEvent.eventSlug || ticketMeta.wrongEvent.eventId;
                        setSelectedEventId(targetGate);
                        handleValidateToken(ticketMeta.token, targetGate);
                      }}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-medium text-xs uppercase tracking-wider transition-colors shadow-sm"
                    >
                      <RotateCw className="w-4 h-4" />
                      Switch Gate to "{ticketMeta.wrongEvent.eventTitle || 'Target Event'}" & Admit
                    </button>
                  </div>
                )}
              </div>
            )}

            {scanStatus === 'cancelled' && (
              <div className="space-y-4">
                <div className="w-20 h-20 rounded-full bg-rose-50 text-rose-600 mx-auto flex items-center justify-center border border-rose-200">
                  <XCircle className="w-10 h-10" />
                </div>
                <div>
                  <span className="px-3.5 py-1 rounded-full bg-rose-50 text-rose-700 font-mono font-semibold text-xs uppercase tracking-wider border border-rose-200 inline-block mb-3">
                    Cancelled Pass · Entry Denied
                  </span>
                  <h2 className="text-xl sm:text-2xl font-display font-bold text-gray-900">
                    Ticket Cancelled or Refunded
                  </h2>
                  <p className="text-xs text-gray-500 mt-2 max-w-md mx-auto">
                    {ticketMeta?.note || 'This pass has been cancelled and cannot be admitted.'}
                  </p>
                </div>
              </div>
            )}

            {scanStatus === 'unpaid' && (
              <div className="space-y-4">
                <div className="w-20 h-20 rounded-full bg-rose-50 text-rose-600 mx-auto flex items-center justify-center border border-rose-200">
                  <AlertTriangle className="w-10 h-10" />
                </div>
                <div>
                  <span className="px-3.5 py-1 rounded-full bg-rose-50 text-rose-700 font-mono font-semibold text-xs uppercase tracking-wider border border-rose-200 inline-block mb-3">
                    Unpaid Pass · Admission Denied
                  </span>
                  <h2 className="text-xl sm:text-2xl font-display font-bold text-gray-900">
                    Order Payment Incomplete
                  </h2>
                  <p className="text-xs text-gray-500 mt-2 max-w-md mx-auto">
                    {ticketMeta?.note || 'The order associated with this pass was not completed.'}
                  </p>
                </div>
              </div>
            )}

            {scanStatus === 'forbidden' && (
              <div className="space-y-4">
                <div className="w-20 h-20 rounded-full bg-rose-50 text-rose-600 mx-auto flex items-center justify-center border border-rose-200">
                  <Lock className="w-10 h-10" />
                </div>
                <div>
                  <span className="px-3.5 py-1 rounded-full bg-rose-50 text-rose-700 font-mono font-semibold text-xs uppercase tracking-wider border border-rose-200 inline-block mb-3">
                    Access Denied · Authorization Required
                  </span>
                  <h2 className="text-xl sm:text-2xl font-display font-bold text-gray-900">
                    Unauthorized Gate Staff
                  </h2>
                  <p className="text-xs text-gray-500 mt-2 max-w-md mx-auto">
                    {ticketMeta?.note || 'You do not have permission to check in tickets at this gate. Your staff assignment may have been revoked.'}
                  </p>
                </div>
              </div>
            )}

            {scanStatus === 'session_expired' && (
              <div className="space-y-4">
                <div className="w-20 h-20 rounded-full bg-amber-50 text-amber-600 mx-auto flex items-center justify-center border border-amber-200">
                  <KeyRound className="w-10 h-10" />
                </div>
                <div>
                  <span className="px-3.5 py-1 rounded-full bg-amber-100 text-amber-800 font-mono font-semibold text-xs uppercase tracking-wider border border-amber-300 inline-block mb-3">
                    Session Expired · Re-authentication Required
                  </span>
                  <h2 className="text-xl sm:text-2xl font-display font-bold text-gray-900">
                    Scanner Session Expired
                  </h2>
                  <p className="text-xs text-gray-600 mt-2 max-w-md mx-auto leading-relaxed">
                    {ticketMeta?.note || 'Your scanner session has expired due to inactivity. Your staff event assignment remains active. Please resume your session to continue scanning tickets.'}
                  </p>
                </div>

                <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
                  {inviteToken ? (
                    <button
                      type="button"
                      onClick={() => navigate(`/staff/invitations/${inviteToken}`)}
                      className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-semibold text-xs uppercase tracking-wider transition-colors shadow-sm"
                    >
                      <RotateCw className="w-4 h-4" />
                      Resume Staff Session
                    </button>
                  ) : (
                    <div className="w-full max-w-xs space-y-2">
                      <p className="text-[11px] text-gray-500">
                        Open your original staff invitation email to restore your session with a verification code.
                      </p>
                      <button
                        type="button"
                        onClick={() => window.location.reload()}
                        className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-gray-900 hover:bg-black text-white font-semibold text-xs uppercase tracking-wider transition-colors shadow-sm"
                      >
                        <RefreshCw className="w-4 h-4" />
                        Reload Scanner
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {scanStatus === 'not_yet_valid' && (
              <div className="space-y-4">
                <div className="w-20 h-20 rounded-full bg-amber-50 text-amber-600 mx-auto flex items-center justify-center border border-amber-200">
                  <AlertTriangle className="w-10 h-10" />
                </div>
                <div>
                  <span className="px-3.5 py-1 rounded-full bg-amber-100 text-amber-800 font-mono font-semibold text-xs uppercase tracking-wider border border-amber-300 inline-block mb-3">
                    Ticket Not Yet Valid
                  </span>
                  <h2 className="text-xl sm:text-2xl font-display font-bold text-gray-900">
                    Admission Not Started
                  </h2>
                  <p className="text-xs text-gray-600 mt-2 max-w-md mx-auto">
                    {ticketMeta?.note || 'This ticket is not yet valid for entry.'}
                  </p>
                  {ticketMeta?.tier && (
                    <div className="mt-3 inline-block px-3 py-1 bg-gray-50 border border-gray-200 rounded-lg text-xs font-mono text-gray-700">
                      Tier: <strong>{ticketMeta.tier}</strong>
                    </div>
                  )}
                </div>
              </div>
            )}

            {scanStatus === 'expired' && (
              <div className="space-y-4">
                <div className="w-20 h-20 rounded-full bg-rose-50 text-rose-600 mx-auto flex items-center justify-center border border-rose-200">
                  <XCircle className="w-10 h-10" />
                </div>
                <div>
                  <span className="px-3.5 py-1 rounded-full bg-rose-100 text-rose-800 font-mono font-semibold text-xs uppercase tracking-wider border border-rose-300 inline-block mb-3">
                    Ticket Validity Expired
                  </span>
                  <h2 className="text-xl sm:text-2xl font-display font-bold text-gray-900">
                    Entry Window Closed
                  </h2>
                  <p className="text-xs text-gray-600 mt-2 max-w-md mx-auto">
                    {ticketMeta?.note || 'This ticket has expired and can no longer be used for admission.'}
                  </p>
                  {ticketMeta?.tier && (
                    <div className="mt-3 inline-block px-3 py-1 bg-gray-50 border border-gray-200 rounded-lg text-xs font-mono text-gray-700">
                      Tier: <strong>{ticketMeta.tier}</strong>
                    </div>
                  )}
                </div>
              </div>
            )}

            {scanStatus === 'invalid' && (
              <div className="space-y-4">
                <div className="w-20 h-20 rounded-full bg-gray-100 text-gray-500 mx-auto flex items-center justify-center border border-gray-200">
                  <XCircle className="w-10 h-10" />
                </div>
                <div>
                  <span className="px-3.5 py-1 rounded-full bg-gray-100 text-gray-600 font-mono font-semibold text-xs uppercase tracking-wider border border-gray-200 inline-block mb-3">
                    Invalid Pass Token
                  </span>
                  <h2 className="text-xl sm:text-2xl font-display font-bold text-gray-900">
                    No Matching Ticket Record
                  </h2>
                  <p className="text-xs text-gray-500 mt-2 max-w-md mx-auto">
                    {ticketMeta?.note || 'This token does not exist in the database or could not be recognized.'}
                  </p>
                </div>
              </div>
            )}

            {scanStatus === 'network_error' && (
              <div className="space-y-4">
                <div className="w-20 h-20 rounded-full bg-amber-50 text-amber-600 mx-auto flex items-center justify-center border border-amber-200">
                  <WifiOff className="w-10 h-10" />
                </div>
                <div>
                  <span className="px-3.5 py-1 rounded-full bg-amber-100 text-amber-800 font-mono font-semibold text-xs uppercase tracking-wider border border-amber-300 inline-block mb-3">
                    Connection Error · Unverified
                  </span>
                  <h2 className="text-xl sm:text-2xl font-display font-bold text-gray-900">
                    Network Connection Failed
                  </h2>
                  <p className="text-xs text-gray-600 mt-2 max-w-md mx-auto">
                    {ticketMeta?.note || 'Unable to reach the check-in server. Admission cannot be confirmed offline.'}
                  </p>
                </div>
                <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={handleRetry}
                    disabled={isValidating}
                    className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-medium text-sm transition-colors shadow-sm disabled:opacity-50"
                  >
                    {isValidating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    Retry Check-In
                  </button>
                  <button
                    type="button"
                    onClick={resetScanner}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gray-100 text-gray-700 font-medium text-sm hover:bg-gray-200 transition-colors"
                  >
                    Abandon / Scan Next
                  </button>
                </div>
              </div>
            )}

            {scanStatus !== 'network_error' && scanStatus !== 'session_expired' && (
              <div className="pt-4">
                <button
                  type="button"
                  onClick={resetScanner}
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-gray-900 text-white font-medium text-sm hover:bg-black transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                  Scan Next Ticket
                </button>
              </div>
            )}
          </div>
        )}
      </div>
        </>
      )}
    </div>
  );
};
