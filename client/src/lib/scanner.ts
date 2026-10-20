import jsQR from 'jsqr';

export type CameraStatus =
  | 'idle'
  | 'requesting'
  | 'active'
  | 'permission_denied'
  | 'not_found'
  | 'in_use'
  | 'unsupported'
  | 'insecure'
  | 'error';

export type CameraErrorType =
  | 'permission_denied'
  | 'not_found'
  | 'in_use'
  | 'unsupported'
  | 'insecure'
  | 'unknown';

/**
 * Maps raw browser getUserMedia exceptions into user-friendly diagnostic states and messages.
 */
export function getCameraErrorDetails(err: any): { type: CameraErrorType; message: string } {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return {
      type: 'permission_denied',
      message: 'Camera permission was denied. Please allow camera access in your browser or site settings.',
    };
  }

  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return {
      type: 'not_found',
      message: 'No camera hardware was detected on this device.',
    };
  }

  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return {
      type: 'in_use',
      message: 'The camera is currently occupied by another application or browser tab. Please close other camera apps and retry.',
    };
  }

  if (name === 'OverconstrainedError') {
    return {
      type: 'not_found',
      message: 'No camera was found matching the requested orientation or resolution.',
    };
  }

  if (err?.message) {
    return {
      type: 'unknown',
      message: err.message,
    };
  }

  if (typeof window !== 'undefined') {
    const isLocalhost =
      window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (!window.isSecureContext && !isLocalhost) {
      return {
        type: 'insecure',
        message: 'Camera video streaming requires a secure HTTPS connection.',
      };
    }
  }

  if (typeof navigator !== 'undefined' && !navigator.mediaDevices?.getUserMedia) {
    return {
      type: 'unsupported',
      message: 'Your browser does not support camera access. Please use Safari, Chrome, Edge, or Firefox.',
    };
  }

  return {
    type: 'unknown',
    message: 'Failed to start camera preview. Please check device permissions and try again.',
  };
}

/**
 * Extracts the clean ticket secret token from decoded QR payloads.
 * Handles raw tokens, URLs (e.g. ?token=...), JSON objects, and paths.
 */
export function extractTicketToken(scannedText: string): string {
  if (!scannedText) return '';
  const trimmed = scannedText.trim();

  // 1. JSON payload
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.token === 'string' && parsed.token.trim()) {
        return parsed.token.trim();
      }
      if (typeof parsed.ticketToken === 'string' && parsed.ticketToken.trim()) {
        return parsed.ticketToken.trim();
      }
    } catch {}
  }

  // 2. URL payload
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const url = new URL(trimmed);
      const queryToken =
        url.searchParams.get('token') ||
        url.searchParams.get('t') ||
        url.searchParams.get('ticketToken');
      if (queryToken && queryToken.trim()) {
        return queryToken.trim();
      }

      // Check path ending in token
      const segments = url.pathname.split('/').filter(Boolean);
      const last = segments[segments.length - 1];
      if (last && (last.startsWith('tkt_') || last.startsWith('tkt_sec_'))) {
        return last.trim();
      }
    } catch {}
  }

  return trimmed;
}

/**
 * Determines whether a scanned token is a duplicate within the cooldown window.
 */
export function isDuplicateScan(
  token: string,
  lastScanned: { token: string; timestamp: number } | null,
  cooldownMs: number = 3000
): boolean {
  if (!token || !lastScanned) return false;
  if (token !== lastScanned.token) return false;
  return Date.now() - lastScanned.timestamp < cooldownMs;
}

/**
 * Decodes a single video frame using native BarcodeDetector if available, falling back to jsQR.
 */
export async function decodeVideoFrame(
  video: HTMLVideoElement,
  offscreenCanvas?: HTMLCanvasElement
): Promise<string | null> {
  if (video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) {
    return null;
  }

  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) {
    return null;
  }

  // 1. Prefer native hardware-accelerated BarcodeDetector if supported
  if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
    try {
      const detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
      const barcodes = await detector.detect(video);
      if (barcodes.length > 0 && barcodes[0].rawValue) {
        return barcodes[0].rawValue;
      }
    } catch {
      // Continue to jsQR fallback below
    }
  }

  // 2. Fall back to jsQR via canvas getImageData
  const canvas = offscreenCanvas || document.createElement('canvas');
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(video, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const code = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'dontInvert',
  });

  return code?.data ? code.data : null;
}
