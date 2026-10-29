import { env } from '../../config/env.js';

export interface WaitlistOfferEmailPayload {
  to: string;
  customerName: string;
  eventTitle: string;
  eventSlug: string;
  tierName: string;
  quantity: number;
  claimUrl: string;
  declineUrl: string;
  expiresAt: Date;
}

export interface SentEmailRecord {
  id: string;
  to: string;
  customerName: string;
  eventTitle: string;
  tierName: string;
  quantity: number;
  claimUrl: string;
  expiresAt: Date;
  sentAt: Date;
}

// In-memory log of sent emails for testing, auditing, and fallback observation
export const sentWaitlistEmails: SentEmailRecord[] = [];

/**
 * Resets the in-memory sent emails list (primarily used for test isolation).
 */
export function resetSentWaitlistEmails(): void {
  sentWaitlistEmails.length = 0;
}

/**
 * Sends a ticket waitlist offer notification to the customer.
 * Uses the configured EMAIL_FROM address and formats a clean, branded email.
 * Safe to call: handles failures gracefully without crashing transaction caller.
 */
export async function sendWaitlistOfferEmail(
  payload: WaitlistOfferEmailPayload
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const expiresAtFormatted = payload.expiresAt.toLocaleString('en-US', {
      timeZone: 'UTC',
      dateStyle: 'medium',
      timeStyle: 'short',
    }) + ' UTC';

    const emailRecord: SentEmailRecord = {
      id: `mail_wlot_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      to: payload.to,
      customerName: payload.customerName,
      eventTitle: payload.eventTitle,
      tierName: payload.tierName,
      quantity: payload.quantity,
      claimUrl: payload.claimUrl,
      expiresAt: payload.expiresAt,
      sentAt: new Date(),
    };

    sentWaitlistEmails.push(emailRecord);

    // If an external SMTP or email API (e.g. Resend) is configured in future environments,
    // dispatch here. In current environment, record structured log and track in sentWaitlistEmails.
    if (process.env.NODE_ENV !== 'test') {
      console.log(
        `[WaitlistEmail] 🎟️ Ticket offer email dispatched from ${env.EMAIL_FROM} to ${payload.to}:\n` +
        `  Event: ${payload.eventTitle}\n` +
        `  Tier: ${payload.quantity}x ${payload.tierName}\n` +
        `  Claim URL: ${payload.claimUrl}\n` +
        `  Expires: ${expiresAtFormatted}`
      );
    }

    return {
      success: true,
      messageId: emailRecord.id,
    };
  } catch (error: any) {
    console.error(`[WaitlistEmail] Failed to dispatch email to ${payload.to}:`, error);
    return {
      success: false,
      error: error?.message || 'Failed to dispatch waitlist notification email',
    };
  }
}
