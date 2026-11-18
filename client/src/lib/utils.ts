/**
 * Shared Client Utilities for Outside.vip
 */

/**
 * Resolves the base origin for URL parsing safely across browser and SSR/test environments.
 */
function getBaseOrigin(): string {
  if (typeof window !== 'undefined' && window.location && window.location.origin) {
    return window.location.origin;
  }
  return 'http://localhost';
}

const FORBIDDEN_AUTH_PATHS = [
  '/login',
  '/signin',
  '/register',
  '/forgot-password',
];

/**
 * Sanitizes an untrusted redirect URL to guarantee it resolves strictly to a safe,
 * internal application path on the current origin.
 *
 * Requirements & Security Controls:
 * 1. Missing, empty, or non-string inputs default to `defaultUrl` (default: '/organizer').
 * 2. Only internal relative paths on the current origin are allowed.
 * 3. External absolute URLs (e.g. 'https://evil.com', 'http://attacker.com') are rejected.
 * 4. Protocol-relative URLs (e.g. '//evil.com', '///evil.com') are rejected.
 * 5. Backslash-based parser confusion tricks (e.g. '/\\evil.com', '\\\\evil.com') are rejected.
 * 6. Non-HTTP/HTTPS schemes (e.g. 'javascript:alert(1)', 'data:text/html,...') are rejected.
 * 7. Authentication routes and sub-paths (/login, /signin, /register, /forgot-password) are rejected to prevent redirect loops.
 * 8. Single and multi-layer percent-encoded paths (e.g. '/%6c%6f%67%69%6e', '/%256c%256f%2567%2569%256e') are safely decoded and rejected.
 * 9. Legitimate internal query parameters and hash fragments (e.g. '/events/summer-fest?tab=tickets#passes') are preserved.
 * 10. Malformed URLs fail closed to `defaultUrl`.
 */
export function sanitizeRedirectUrl(url?: string | null, defaultUrl = '/organizer'): string {
  if (!url || typeof url !== 'string') {
    return defaultUrl;
  }

  const trimmed = url.trim();
  if (!trimmed) {
    return defaultUrl;
  }

  // Backslashes are never legitimate in application route paths and are frequently used in parser confusion attacks
  if (trimmed.includes('\\')) {
    return defaultUrl;
  }

  // Reject multiple leading slashes (e.g. //evil.com, ///evil.com)
  if (/^\/{2,}/.test(trimmed)) {
    return defaultUrl;
  }

  const baseOrigin = getBaseOrigin();
  let parsed: URL;

  try {
    // If url is relative, new URL(url, baseOrigin) resolves against baseOrigin.
    // If url is absolute, new URL(url, baseOrigin) resolves against url's own origin.
    parsed = new URL(trimmed, baseOrigin);
  } catch {
    // Malformed URL string
    return defaultUrl;
  }

  // Must strictly match the application origin and protocol
  let baseParsed: URL;
  try {
    baseParsed = new URL(baseOrigin);
  } catch {
    baseParsed = new URL('http://localhost');
  }

  if (parsed.origin !== baseParsed.origin || parsed.protocol !== baseParsed.protocol) {
    return defaultUrl;
  }

  // Ensure pathname begins with a single slash and not multiple slashes
  if (!parsed.pathname.startsWith('/') || /^\/{2,}/.test(parsed.pathname)) {
    return defaultUrl;
  }

  // Decode percent-encoding repeatedly to catch double- or triple-encoded bypasses
  let decodedPath = parsed.pathname;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decodedPath);
      if (next === decodedPath) break;
      decodedPath = next;
    } catch {
      return defaultUrl;
    }
  }

  // If decoded path contains backslashes, null bytes, or control characters, reject
  if (decodedPath.includes('\\') || decodedPath.includes('\0') || /[\x00-\x1F\x7F]/.test(decodedPath)) {
    return defaultUrl;
  }

  // Normalize path for comparison (lowercase, collapsed slashes, strip trailing slash except root)
  const normalizedPath = decodedPath.toLowerCase().replace(/\/+/g, '/').replace(/\/$/, '') || '/';

  // Prevent redirect loops into authentication endpoints
  const isAuthRoute = FORBIDDEN_AUTH_PATHS.some((authPath) => {
    return normalizedPath === authPath || normalizedPath.startsWith(`${authPath}/`);
  });

  if (isAuthRoute) {
    return defaultUrl;
  }

  // Construct clean relative destination preserving query parameters and hash fragment
  const destination = parsed.pathname + parsed.search + parsed.hash;

  // Final sanity check: destination must start with single slash and not double slash
  if (!destination.startsWith('/') || destination.startsWith('//')) {
    return defaultUrl;
  }

  return destination;
}

