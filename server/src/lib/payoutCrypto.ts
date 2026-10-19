import crypto from 'crypto';
import { env } from '../config/env.js';

// Derive a fixed 32-byte key from JWT_SECRET using scrypt
const ENCRYPTION_SALT = 'outside-vip-payout-salt-2026';
const encryptionKey = crypto.scryptSync(env.JWT_SECRET, ENCRYPTION_SALT, 32);

/**
 * Masks an account number, preserving only the last 4 characters.
 * Example: "1234567890" -> "•••• •••• •••• 7890"
 */
export function maskAccountNumber(rawNumber: string): string {
  const trimmed = rawNumber.trim();
  const digitsOnly = trimmed.replace(/\s+/g, '');
  if (digitsOnly.length <= 4) {
    return `•••• ${digitsOnly}`;
  }
  const last4 = digitsOnly.slice(-4);
  return `•••• •••• •••• ${last4}`;
}

/**
 * Extracts the last 4 characters of an account number.
 */
export function getAccountNumberLast4(rawNumber: string): string {
  const digitsOnly = rawNumber.trim().replace(/\s+/g, '');
  return digitsOnly.slice(-4);
}

/**
 * Encrypts an account number using AES-256-GCM.
 * Never stores plain text account numbers in the database.
 */
export function encryptAccountNumber(rawNumber: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  
  let encrypted = cipher.update(rawNumber.trim(), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM encrypted account number.
 */
export function decryptAccountNumber(encryptedString: string): string {
  const parts = encryptedString.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted account number format');
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);

  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Strips raw/encrypted secrets before returning payout details in API responses.
 * Never returns accountNumberEncrypted or unmasked bank credentials.
 */
export function sanitizePayoutDetails<T extends Record<string, any> | null | undefined>(payoutDetails: T): T {
  if (!payoutDetails) return payoutDetails;

  const { accountNumberEncrypted, ...safeDetails } = payoutDetails;
  return safeDetails as T;
}
