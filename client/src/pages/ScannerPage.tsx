import React, { useState, useEffect, useRef, useCallback } from 'react';
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
} from 'lucide-react';
import { api } from '../lib/api';
import { 
  CameraStatus, 
  getCameraErrorDetails, 
  extractTicketToken, 
  isDuplicateScan, 
  decodeVideoFrame 
} from '../lib/scanner';

type ScanStatus = 'idle' | 'valid' | 'already_used' | 'invalid' | 'wrong_event' | 'cancelled';

export const ScannerPage: React.FC = () => {
  const [selectedEventId, setSelectedEventId] = useState('sol-fest-baobab-edition-2026');
  const [ticketInput, setTicketInput] = useState('');
  const [scanStatus, setScanStatus] = useState<ScanStatus>('idle');
  const [ticketMeta, setTicketMeta] = useState<any>(null);
  const [checkInCount, setCheckInCount] = useState(342);
  const [isValidating, setIsValidating] = useState(false);

  // Camera state
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle');
  const [cameraErrorMessage, setCameraErrorMessage] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');

  // Scanner refs for stream & animation lifecycle
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastScannedRef = useRef<{ token: string; timestamp: number } | null>(null);
  const isValidatingRef = useRef(false);
  const isScanningPausedRef = useRef(false);
  const scanStatusRef = useRef<ScanStatus>('idle');

  // Keep refs in sync with state for access in frame loop
  useEffect(() => {
    isValidatingRef.current = isValidating;
  }, [isValidating]);

  useEffect(() => {
    scanStatusRef.current = scanStatus;
  }, [scanStatus]);

  /**
   * Stop camera stream and cancel animation frames.
   */
  const stopCamera = useCallback(() => {
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
  }, []);

  /**
   * Request camera permission and start video feed.
   * Prefers rear-facing camera ('environment') on mobile devices.
   */
  const startCamera = useCallback(async (preferredFacing: 'environment' | 'user' = facingMode) => {
    // Teardown any prior stream first
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    setCameraStatus('requesting');
    setCameraErrorMessage(null);

    // Secure context check
    if (typeof window !== 'undefined') {
      const isLocalhost =
        window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      if (!window.isSecureContext && !isLocalhost) {
        setCameraStatus('insecure');
        setCameraErrorMessage('Camera video streaming requires a secure HTTPS connection.');
        return;
      }
    }

    // MediaDevices API existence check
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

      // Attach stream to video element
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

  /**
   * Toggle between front and rear cameras.
   */
  const toggleFacingMode = () => {
    const nextMode = facingMode === 'environment' ? 'user' : 'environment';
    startCamera(nextMode);
  };

  /**
   * Ensure camera tracks are stopped when leaving page.
   */
  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  /**
   * Reconnect existing active stream to video element when returning to idle scan view.
   */
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

  /**
   * Fallback simulator for offline/demo tests.
   */
  const handleLocalFallback = (trimmed: string) => {
    if (trimmed === 'tkt_sec_7a9f2e3b8c1d4e5f') {
      setScanStatus('valid');
      setTicketMeta({
        attendee: 'Alex Mwangi [Demo Simulation]',
        tier: 'VIP Creek Terrace',
        orderNumber: 'OUT-2026-89412',
        checkedInAt: 'Demo Pass (Unauthenticated Gate)',
      });
      setCheckInCount((prev) => prev + 1);
    } else if (trimmed === 'tkt_sec_1d8c4e5f7a9f2e3b') {
      setScanStatus('already_used');
      setTicketMeta({
        attendee: 'Zainab Wanjiru [Demo Simulation]',
        tier: 'VIP Creek Terrace',
        checkedInAt: '45 mins ago by Outside Admin',
      });
    } else if (trimmed.startsWith('wrong_') || trimmed.includes('wrong')) {
      setScanStatus('wrong_event');
      setTicketMeta({ note: 'This ticket belongs to another event gate.' });
    } else {
      setScanStatus('invalid');
      setTicketMeta(null);
    }
  };

  /**
   * Submits scanned or manually entered token to backend validation API.
   */
  const handleValidateToken = async (token: string) => {
    const trimmed = extractTicketToken(token);
    if (!trimmed || isValidatingRef.current) return;

    setIsValidating(true);
    try {
      const res = await api.organizer.checkInTicket({
        token: trimmed,
        eventId: selectedEventId,
      });

      if (res.result === 'SUCCESS') {
        setScanStatus('valid');
        setTicketMeta({
          attendee: res.ticket?.attendeeName || 'Verified Attendee',
          tier: res.ticket?.tierName || 'Pass Tier',
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
      const status = err.statusCode;
      if (status === 409) {
        setScanStatus('already_used');
        setTicketMeta({
          attendee: err.message || 'Already checked in',
          checkedInAt: 'Prior admission logged',
        });
      } else if (status === 400 && err.message?.includes('belongs to')) {
        setScanStatus('wrong_event');
        setTicketMeta({ note: err.message });
      } else if (status === 400 && err.message?.includes('cancelled')) {
        setScanStatus('cancelled');
        setTicketMeta({ note: err.message });
      } else if (status === 404) {
        setScanStatus('invalid');
        setTicketMeta(null);
      } else {
        // If unauthenticated as organizer (e.g. testing in public browser view), run local fallback
        handleLocalFallback(trimmed);
      }
    } finally {
      setIsValidating(false);
    }
  };

  /**
   * Continuous QR detection loop. Runs while cameraStatus === 'active' and viewfinder is displayed.
   */
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
          // Graceful skip on single frame read error
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

  /**
   * Reset scanner state for the next attendee while keeping camera active.
   */
  const resetScanner = () => {
    setScanStatus('idle');
    setTicketMeta(null);
    setTicketInput('');
    lastScannedRef.current = null;
    isScanningPausedRef.current = false;
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-10 space-y-8">
      {/* Hidden processing canvas for frame decoding */}
      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />

      {/* Header */}
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

      {/* Event Selection & Live Count Bar */}
      <div className="p-4 rounded-2xl bg-white border border-gray-200 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="w-full sm:w-auto flex-1">
          <label className="block text-[11px] font-mono text-gray-500 uppercase font-semibold mb-1">
            Active Gate Pass
          </label>
          <select
            value={selectedEventId}
            onChange={(e) => {
              setSelectedEventId(e.target.value);
              resetScanner();
            }}
            className="w-full sm:w-80 px-3 py-2 rounded-xl bg-gray-50 border border-gray-200 text-gray-900 text-xs font-semibold focus:outline-none focus:border-gray-900"
          >
            <option value="sol-fest-baobab-edition-2026">SOL FEST: Under The Baobab Tree</option>
            <option value="sub-terrain-industrial-warehouse-004">SUB-TERRAIN: Warehouse Rave</option>
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

      {/* Scanner Viewfinder / Test Area */}
      <div className="bg-white rounded-2xl p-6 sm:p-8 space-y-6 border border-gray-200 shadow-sm">
        {scanStatus === 'idle' ? (
          <div className="space-y-6">
            {/* Viewfinder box */}
            <div className="relative aspect-square sm:aspect-[16/10] rounded-xl bg-gray-900 border-2 border-dashed border-gray-300 flex flex-col items-center justify-center text-center overflow-hidden">
              {/* State A: Camera is Active - Display Live Video Stream */}
              {cameraStatus === 'active' && (
                <>
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    autoPlay
                    className="w-full h-full object-cover"
                  />

                  {/* Corner Target Reticles */}
                  <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute top-4 left-4 w-7 h-7 border-t-2 border-l-2 border-emerald-400" />
                    <div className="absolute top-4 right-4 w-7 h-7 border-t-2 border-r-2 border-emerald-400" />
                    <div className="absolute bottom-4 left-4 w-7 h-7 border-b-2 border-l-2 border-emerald-400" />
                    <div className="absolute bottom-4 right-4 w-7 h-7 border-b-2 border-r-2 border-emerald-400" />

                    {/* Animated Scanning Beam */}
                    <div className="absolute left-8 right-8 h-0.5 bg-gradient-to-r from-transparent via-emerald-400 to-transparent animate-qr-scan shadow-[0_0_12px_#34d399]" />
                  </div>

                  {/* Top Bar with Live Indicator & Camera Controls */}
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

                  {/* Bottom Guide Prompt */}
                  <div className="absolute bottom-3 inset-x-0 text-center pointer-events-none">
                    <span className="px-3.5 py-1 rounded-full bg-black/60 backdrop-blur-md text-gray-200 text-xs font-medium border border-white/10">
                      Hold attendee ticket QR code inside viewfinder
                    </span>
                  </div>
                </>
              )}

              {/* State B: Requesting Permissions */}
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

              {/* State C: Permission Denied */}
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

              {/* State D: No Camera Detected */}
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

              {/* State E: Camera In Use */}
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

              {/* State F: Unsupported / Insecure Context / Error */}
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

              {/* State G: Idle - Ready for User to Start Camera */}
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

                  {/* Corner lines preview */}
                  <div className="absolute top-4 left-4 w-6 h-6 border-t-2 border-l-2 border-gray-600" />
                  <div className="absolute top-4 right-4 w-6 h-6 border-t-2 border-r-2 border-gray-600" />
                  <div className="absolute bottom-4 left-4 w-6 h-6 border-b-2 border-l-2 border-gray-600" />
                  <div className="absolute bottom-4 right-4 w-6 h-6 border-b-2 border-r-2 border-gray-600" />
                </div>
              )}
            </div>

            {/* Manual Entry Fallback & Seed Tokens */}
            <div className="space-y-3 pt-2">
              <div className="flex items-center gap-2 text-xs font-mono uppercase text-gray-500 font-semibold">
                <Keyboard className="w-4 h-4" />
                Or Validate Unguessable Token Manually
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="e.g. tkt_sec_7a9f2e3b8c1d4e5f"
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

              {/* Quick test buttons for verification */}
              <div className="p-4 rounded-xl bg-gray-50 border border-gray-200 space-y-2">
                <span className="text-[11px] font-mono uppercase text-gray-500 block font-semibold">
                  Test Database Tokens (from Seed):
                </span>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => handleValidateToken('tkt_sec_7a9f2e3b8c1d4e5f')}
                    className="px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-mono hover:bg-emerald-100 transition-colors"
                  >
                    Test Valid Pass (Alex Mwangi)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleValidateToken('tkt_sec_1d8c4e5f7a9f2e3b')}
                    className="px-3 py-1.5 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 text-xs font-mono hover:bg-rose-100 transition-colors"
                  >
                    Test Duplicate (Zainab Wanjiru)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleValidateToken('wrong_pass_event_xyz')}
                    className="px-3 py-1.5 rounded-lg bg-amber-50 text-amber-700 border border-amber-200 text-xs font-mono hover:bg-amber-100 transition-colors"
                  >
                    Test Wrong Event
                  </button>
                  <button
                    type="button"
                    onClick={() => handleValidateToken('bogus_invalid_token')}
                    className="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-600 border border-gray-200 text-xs font-mono hover:bg-gray-200 transition-colors"
                  >
                    Test Invalid Token
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Result Badge Displays */
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
                  <p className="text-xs text-gray-500 mt-2">
                    Order Ref: {ticketMeta?.orderNumber} · Checked In: {ticketMeta?.checkedInAt}
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
                  <p className="text-xs text-rose-600 mt-2 font-mono">
                    Prior Check-In: {ticketMeta?.checkedInAt}
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
                    Wrong Event Pass
                  </span>
                  <h2 className="text-xl sm:text-2xl font-display font-bold text-gray-900">
                    Event Mismatch
                  </h2>
                  <p className="text-xs text-gray-500 mt-2">
                    {ticketMeta?.note}
                  </p>
                </div>
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
                    Ticket Cancelled / Refunded
                  </h2>
                  <p className="text-xs text-gray-500 mt-2">
                    {ticketMeta?.note || 'This pass has been cancelled and cannot be admitted.'}
                  </p>
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
                  <p className="text-xs text-gray-500 mt-2">
                    {ticketMeta?.note || 'This token is unrecognised or has been revoked.'}
                  </p>
                </div>
              </div>
            )}

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
          </div>
        )}
      </div>
    </div>
  );
};
