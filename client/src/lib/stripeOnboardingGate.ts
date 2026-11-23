import { StripeConnectedAccountStatus } from '../types';
import { FormTicketTier } from './ticketCreation';

export function isStripeReadyForPaidPublishing(
  status: StripeConnectedAccountStatus | null | undefined
): boolean {
  return Boolean(
    status &&
    status.connected &&
    status.detailsSubmitted &&
    status.transferBalance?.enabled
  );
}

export function hasVisiblePaidTicketTier(
  tiers: Array<Pick<FormTicketTier, 'isHidden' | 'price' | 'totalCapacity'>>
): boolean {
  return tiers.some(
    (tier) =>
      !tier.isHidden &&
      Number(tier.totalCapacity) > 0 &&
      tier.price !== '' &&
      Number(tier.price) > 0
  );
}

export function isStripeOnboardingIncompleteError(err: any): boolean {
  return err?.code === 'STRIPE_ONBOARDING_INCOMPLETE';
}

export function buildEventEditStripeUrls(
  origin: string,
  eventId: string
): { returnUrl: string; refreshUrl: string } {
  const cleanOrigin = origin.replace(/\/+$/, '');
  const basePath = `${cleanOrigin}/organizer/events/${encodeURIComponent(eventId)}/edit`;
  return {
    returnUrl: `${basePath}?stripe_return=true`,
    refreshUrl: `${basePath}?stripe_refresh=true`,
  };
}

