import { Request, Response, NextFunction } from 'express';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://js.stripe.com",
  "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://www.youtube.com https://www.youtube-nocookie.com",
  "connect-src 'self' https://api.stripe.com https://api.cloudinary.com https://outside.vip https://www.outside.vip https://api.outside.vip https://outside-vip.onrender.com",
  "img-src 'self' data: blob: https://res.cloudinary.com https://images.unsplash.com https://*.stripe.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);

  // Set Cache-Control: no-store on authentication and sensitive account/order/organizer responses
  const path = req.originalUrl || req.path || '';
  if (
    path.startsWith('/api/auth') ||
    path.startsWith('/api/organizer') ||
    path.startsWith('/api/orders')
  ) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  next();
}

