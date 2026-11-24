import { StripeConnectedAccountStatus } from '../types';
import { FormTicketTier } from './ticketCreation';

export function isStripeReadyForPaidPublishing(
  status: StripeConnectedAccountStatus | null | undefined
): boolean {
  const countryOk = Boolean(status?.country) && status!.country!.toUpperCase() === 'US';
  const currencyOk =
    Boolean(status?.defaultCurrency) && status!.defaultCurrency!.toUpperCase() === 'USD';
  return Boolean(
    status &&
      status.connected &&
      status.detailsSubmitted &&
      status.payoutsEnabled &&
      status.transferBalance?.enabled &&
      countryOk &&
      currencyOk
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

