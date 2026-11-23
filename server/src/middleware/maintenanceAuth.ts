import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { ServiceUnavailableError, UnauthorizedError } from '../utils/errors.js';

function getConfiguredMaintenanceSecret(): string {
  return (process.env.CRON_SECRET || process.env.MAINTENANCE_KEY || '').trim();
}

function timingSafeSecretEquals(provided: string, expected: string): boolean {
  const providedDigest = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * Enforces fail-closed bearer/header secret authentication on internal maintenance endpoints.
 * Rejects all requests when neither CRON_SECRET nor MAINTENANCE_KEY is configured.
 */
export function requireMaintenanceAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    const expectedSecret = getConfiguredMaintenanceSecret();
    if (!expectedSecret) {
      throw new ServiceUnavailableError(
        'Maintenance endpoint credentials are not configured.',
        'MAINTENANCE_SECRET_NOT_CONFIGURED'
      );
    }

    const authHeader = req.headers.authorization;
    const bearerToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : '';
    const customHeaderRaw = req.headers['x-cron-secret'] || req.headers['x-maintenance-key'];
    const customHeader = typeof customHeaderRaw === 'string' ? customHeaderRaw.trim() : '';

    const candidate = bearerToken || customHeader;
    if (!candidate || !timingSafeSecretEquals(candidate, expectedSecret)) {
      throw new UnauthorizedError('Unauthorized: Invalid or missing maintenance secret');
    }

    next();
  } catch (error) {
    next(error);
  }
}
