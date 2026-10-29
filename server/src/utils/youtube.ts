/**
 * Validates and extracts a 11-character YouTube video ID from various supported URL formats.
 * Accepts:
 *  - https://www.youtube.com/watch?v=XXXXXXXXXXX
 *  - https://m.youtube.com/watch?v=XXXXXXXXXXX
 *  - https://youtu.be/XXXXXXXXXXX
 *  - https://www.youtube.com/embed/XXXXXXXXXXX
 *  - https://www.youtube.com/shorts/XXXXXXXXXXX
 *  - https://www.youtube.com/v/XXXXXXXXXXX
 *
 * Rejects unsupported domains, arbitrary javascript schemes, or malformed identifiers.
 */
export function extractYouTubeVideoId(rawUrl?: string | null): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);

    // Enforce safe protocols
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    const host = parsed.hostname.toLowerCase();
    const isYouTubeHost =
      host === 'youtube.com' ||
      host === 'www.youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'youtube-nocookie.com' ||
      host === 'www.youtube-nocookie.com';
    const isShortHost = host === 'youtu.be' || host === 'www.youtu.be';

    if (!isYouTubeHost && !isShortHost) {
      return null;
    }

    let videoId: string | null = null;

    if (isShortHost) {
      // youtu.be/XXXXXXXXXXX
      const pathParts = parsed.pathname.split('/').filter(Boolean);
      if (pathParts.length > 0) {
        videoId = pathParts[0];
      }
    } else if (isYouTubeHost) {
      if (parsed.pathname === '/watch') {
        videoId = parsed.searchParams.get('v');
      } else if (
        parsed.pathname.startsWith('/embed/') ||
        parsed.pathname.startsWith('/v/') ||
        parsed.pathname.startsWith('/shorts/')
      ) {
        const pathParts = parsed.pathname.split('/').filter(Boolean);
        if (pathParts.length >= 2) {
          videoId = pathParts[1];
        }
      }
    }

    if (!videoId) return null;

    // YouTube video IDs are strictly 11 characters of [a-zA-Z0-9_-]
    const validIdRegex = /^[a-zA-Z0-9_-]{11}$/;
    if (!validIdRegex.test(videoId)) {
      return null;
    }

    return videoId;
  } catch {
    return null;
  }
}

/**
 * Normalizes a validated YouTube video ID or URL into standard canonical watch URL.
 */
export function normalizeYouTubeUrl(input?: string | null): string | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return `https://www.youtube.com/watch?v=${trimmed}`;
  }
  const id = extractYouTubeVideoId(trimmed);
  if (!id) return null;
  return `https://www.youtube.com/watch?v=${id}`;
}
