import { env, normalizeEmail } from '../config/env.js';

export interface VerificationEmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  code: string;
  expiresInMinutes: number;
  sentAt: Date;
}

export const sentVerificationEmails: VerificationEmailMessage[] = [];

export function resetSentVerificationEmails(): void {
  sentVerificationEmails.length = 0;
}

export function getLatestVerificationEmail(email: string): VerificationEmailMessage | undefined {
  const normalized = normalizeEmail(email);
  for (let i = sentVerificationEmails.length - 1; i >= 0; i--) {
    if (normalizeEmail(sentVerificationEmails[i].to) === normalized) {
      return sentVerificationEmails[i];
    }
  }
  return undefined;
}

export async function sendVerificationOtpEmail(params: {
  to: string;
  name: string;
  code: string;
  expiresInMinutes?: number;
}): Promise<VerificationEmailMessage> {
  const expiresInMinutes = params.expiresInMinutes ?? 10;
  const from = env.EMAIL_FROM || 'Outside.vip <no-reply@outside.vip>';
  const subject = `${params.code} is your Outside.vip verification code`;

  const text = [
    `Hi ${params.name},`,
    '',
    `Your Outside.vip verification code is: ${params.code}`,
    '',
    `This single-use code expires in ${expiresInMinutes} minutes.`,
    'If you did not request this code, you can safely ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0A0A0C; color: #F5F5F7; padding: 32px; border-radius: 16px; max-width: 520px; margin: 0 auto;">
      <p style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.14em; color: #FF5500; margin: 0 0 8px;">Outside.vip Security</p>
      <h1 style="font-size: 24px; margin: 0 0 16px; color: #FFFFFF;">Verify your email address</h1>
      <p style="font-size: 15px; line-height: 1.6; color: #B8B8C2;">
        Hi ${params.name}, enter the 6-digit verification code below to verify your email address and unlock organizer capabilities on Outside.vip:
      </p>
      <div style="margin: 24px 0; padding: 18px 24px; background: #141418; border: 1px solid #2A2A32; border-radius: 12px; text-align: center;">
        <span style="font-family: monospace; font-size: 32px; font-weight: 700; letter-spacing: 0.25em; color: #FF5500;">${params.code}</span>
      </div>
      <p style="font-size: 13px; color: #8E8E99; margin-top: 16px;">
        This code is single-use and expires in <strong>${expiresInMinutes} minutes</strong>.
      </p>
    </div>
  `.trim();

  const message: VerificationEmailMessage = {
    to: normalizeEmail(params.to),
    from,
    subject,
    text,
    html,
    code: params.code,
    expiresInMinutes,
    sentAt: new Date(),
  };

  sentVerificationEmails.push(message);

  const resendApiKey = process.env.RESEND_API_KEY || env.RESEND_API_KEY;
  if (resendApiKey && env.NODE_ENV !== 'test') {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject,
          text,
          html,
        }),
      });
      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        console.error(`[EmailService] Resend API returned ${response.status}: ${errBody}`);
      }
    } catch (err) {
      console.error('[EmailService] Failed to dispatch verification email via Resend:', err);
    }
  } else if (env.NODE_ENV !== 'test') {
    console.info(
      `[EmailService] Verification code for ${message.to}: ${params.code} (expires in ${expiresInMinutes}m)`
    );
  }

  return message;
}
