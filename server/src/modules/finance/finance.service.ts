import Stripe from 'stripe';
import { prisma } from '../../db/prisma.js';
import { stripe } from '../../lib/stripe.js';
import { env } from '../../config/env.js';
import { BadRequestError, NotFoundError, ServiceUnavailableError } from '../../utils/errors.js';
import {
  classifyStripeError,
  logStripeDiagnostic,
} from './stripeError.js';

export interface HumanReadableRequirement {
  code: string;
  description: string;
}

export interface SanitizedExternalAccount {
  id: string;
  bankName: string;
  accountHolderName: string;
  last4: string;
  routingNumber: string | null;
  currency: string;
  isDefault: boolean;
  status: string;
}

export interface ConnectedAccountStatusResponse {
  connected: boolean;
  connectionStatus:
    | 'connected'
    | 'not_connected'
    | 'invalid_or_inaccessible'
    | 'configuration_unavailable'
    | 'service_unavailable';
  stripeAccountId: string | null;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  sellTickets: {
    enabled: boolean;
    status: 'enabled' | 'action_required' | 'disabled';
    message: string;
  };
  transferBalance: {
    enabled: boolean;
    status: 'enabled' | 'action_required' | 'disabled';
    message: string;
  };
  requirements: {
    currentlyDue: HumanReadableRequirement[];
    eventuallyDue: HumanReadableRequirement[];
    pastDue: HumanReadableRequirement[];
    disabledReason: string | null;
    pendingVerification: string[];
    rawCurrentlyDue: string[];
  };
  payoutSchedule: {
    interval: 'manual' | 'daily' | 'weekly' | 'monthly';
    delayDays: number;
    weeklyAnchor: string | null;
    monthlyAnchor: number | null;
  } | null;
  externalAccounts: SanitizedExternalAccount[];
  defaultCurrency: string;
  country: string | null;
}

export interface BalanceCurrencyItem {
  amount: number;
  currency: string;
  sourceTypes?: Record<string, number>;
}

export interface ConnectedAccountBalanceResponse {
  available: BalanceCurrencyItem[];
  pending: BalanceCurrencyItem[];
}

export interface SanitizedPayoutItem {
  id: string;
  amount: number;
  currency: string;
  status: string;
  arrivalDate: string | null;
  created: string;
  destination: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}

export interface SanitizedDisputeItem {
  id: string;
  amount: number;
  currency: string;
  status: string;
  reason: string;
  created: string;
  dueBy: string | null;
  isChargeRefundable: boolean;
}

export interface PayoutScheduleInput {
  interval: 'manual' | 'daily' | 'weekly' | 'monthly';
  weeklyAnchor?: string;
  monthlyAnchor?: number;
  delayDays?: number;
}

/**
 * Helper to construct clean, uniform disconnected / unavailable status payloads.
 */
function buildDisconnectedStatus(
  connectionStatus:
    | 'not_connected'
    | 'invalid_or_inaccessible'
    | 'configuration_unavailable'
    | 'service_unavailable',
  sellTicketsMessage: string,
  transferBalanceMessage: string
): ConnectedAccountStatusResponse {
  return {
    connected: false,
    connectionStatus,
    stripeAccountId: null,
    detailsSubmitted: false,
    chargesEnabled: false,
    payoutsEnabled: false,
    sellTickets: {
      enabled: false,
      status: 'disabled',
      message: sellTicketsMessage,
    },
    transferBalance: {
      enabled: false,
      status: 'disabled',
      message: transferBalanceMessage,
    },
    requirements: {
      currentlyDue: [],
      eventuallyDue: [],
      pastDue: [],
      disabledReason: null,
      pendingVerification: [],
      rawCurrentlyDue: [],
    },
    payoutSchedule: null,
    externalAccounts: [],
    defaultCurrency: 'USD',
    country: null,
  };
}

/**
 * Translates raw Stripe requirement codes to user-friendly action items.
 */
export function translateStripeRequirement(code: string): string {
  const requirementMap: Record<string, string> = {
    'individual.verification.document':
      'Upload a government-issued photo ID (Passport, National ID, or Driver’s License)',
    'individual.verification.additional_document':
      'Upload a secondary identity or address verification document',
    'individual.id_number': 'Provide legal tax or identification number',
    'individual.ssn_last_4': 'Provide last 4 digits of identification number',
    'individual.address': 'Confirm personal residential address',
    'individual.dob': 'Confirm date of birth',
    'individual.email': 'Confirm representative email address',
    'individual.phone': 'Confirm representative phone number',
    external_account: 'Add a verified electronic settlement bank account (ACH/Direct Deposit)',
    'business_profile.url': 'Provide a public event or business website/social profile',
    'business_profile.mcc': 'Select merchant category classification',
    'tos_acceptance.date': 'Accept Stripe Connected Account terms of service',
    'tos_acceptance.ip': 'Confirm Stripe Connected Account agreement',
    'company.tax_id': 'Provide registered business tax identification number',
    'company.verification.document':
      'Upload business registration or certificate of incorporation document',
    'relationship.representative': 'Designate an authorized business representative',
    'relationship.owner': 'Declare all ultimate beneficial owners holding 25% or more equity',
    'relationship.executive': 'Declare an authorized executive officer',
  };

  if (requirementMap[code]) {
    return requirementMap[code];
  }

  // Fallback: convert snake_case or dot.separated to readable sentence
  return code.replace(/[._]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Resolves the authenticated organizer's connected Stripe account status.
 * Distinguishes cleanly between:
 * - No connected account
 * - Invalid or inaccessible connected account
 * - Stripe platform configuration issue
 * - Temporary Stripe service failure
 */
export async function getConnectedAccountStatus(
  userId: string
): Promise<ConnectedAccountStatusResponse> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      stripeAccountId: true,
    },
  });

  if (!user) {
    throw new NotFoundError('Organizer user not found');
  }

  if (!env.STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
    return buildDisconnectedStatus(
      'configuration_unavailable',
      'Stripe payments are currently being configured for this platform. Please check back shortly.',
      'Payout services are temporarily unavailable while platform configuration is being completed.'
    );
  }

  if (!user.stripeAccountId) {
    return buildDisconnectedStatus(
      'not_connected',
      'Complete Stripe onboarding to start receiving ticket payments.',
      'Payouts will be enabled once Stripe verifies your identity and banking credentials.'
    );
  }

  try {
    const account = await stripe.accounts.retrieve(user.stripeAccountId);

    const currentlyDueRaw = account.requirements?.currently_due || [];
    const eventuallyDueRaw = account.requirements?.eventually_due || [];
    const pastDueRaw = account.requirements?.past_due || [];
    const pendingVerification = account.requirements?.pending_verification || [];
    const disabledReason = account.requirements?.disabled_reason || null;

    const currentlyDueMapped: HumanReadableRequirement[] = currentlyDueRaw.map((code) => ({
      code,
      description: translateStripeRequirement(code),
    }));

    const eventuallyDueMapped: HumanReadableRequirement[] = eventuallyDueRaw.map((code) => ({
      code,
      description: translateStripeRequirement(code),
    }));

    const pastDueMapped: HumanReadableRequirement[] = pastDueRaw.map((code) => ({
      code,
      description: translateStripeRequirement(code),
    }));

    // Sell Tickets evaluation:
    const cardPaymentsActive =
      account.capabilities?.card_payments === 'active' || Boolean(account.charges_enabled);

    let sellTicketsStatus: 'enabled' | 'action_required' | 'disabled' = 'disabled';
    let sellTicketsMessage = '';

    if (cardPaymentsActive && pastDueRaw.length === 0) {
      sellTicketsStatus = 'enabled';
      sellTicketsMessage =
        'Enabled: Your account is authorized to accept ticket sales and process payments.';
    } else if (pastDueRaw.length > 0 || currentlyDueRaw.length > 0) {
      sellTicketsStatus = 'action_required';
      sellTicketsMessage =
        'Action required: Stripe requires additional identity or business information to enable ticket sales.';
    } else {
      sellTicketsStatus = 'action_required';
      sellTicketsMessage = 'Pending verification: Stripe is reviewing your submitted details.';
    }

    // Transfer Balance evaluation:
    const transfersActive =
      account.capabilities?.transfers === 'active' || Boolean(account.payouts_enabled);

    let transferStatus: 'enabled' | 'action_required' | 'disabled' = 'disabled';
    let transferMessage = '';

    if (transfersActive && Boolean(account.payouts_enabled)) {
      transferStatus = 'enabled';
      transferMessage = 'Enabled: Automated balance transfers and bank payouts are fully functional.';
    } else if (disabledReason) {
      transferStatus = 'disabled';
      transferMessage = `Disabled by Stripe: ${disabledReason}`;
    } else if (currentlyDueRaw.length > 0 || pastDueRaw.length > 0) {
      transferStatus = 'action_required';
      transferMessage =
        'Action required: Complete required banking or tax documentation to unlock payouts.';
    } else {
      transferStatus = 'action_required';
      transferMessage =
        'Pending verification: Bank account or identity review is underway by Stripe.';
    }

    // Map external accounts with sensitive fields strictly masked
    const externalAccounts: SanitizedExternalAccount[] = (
      account.external_accounts?.data || []
    ).map((ext) => {
      const isBank = ext.object === 'bank_account';
      const bank = ext as Stripe.BankAccount;
      return {
        id: ext.id,
        bankName: isBank ? bank.bank_name || 'Bank Account' : 'Debit Card',
        accountHolderName: isBank ? bank.account_holder_name || user.name : user.name,
        last4: ext.last4 || '••••',
        routingNumber: isBank && bank.routing_number ? `••••${bank.routing_number.slice(-4)}` : null,
        currency: ext.currency ? ext.currency.toUpperCase() : 'USD',
        isDefault: Boolean((ext as any).default_for_currency),
        status: (ext as any).status || 'verified',
      };
    });

    const schedule = account.settings?.payouts?.schedule;
    const payoutSchedule = schedule
      ? {
          interval: (schedule.interval as 'manual' | 'daily' | 'weekly' | 'monthly') || 'daily',
          delayDays: typeof schedule.delay_days === 'number' ? schedule.delay_days : 2,
          weeklyAnchor: schedule.weekly_anchor || null,
          monthlyAnchor: schedule.monthly_anchor || null,
        }
      : null;

    return {
      connected: true,
      connectionStatus: 'connected',
      stripeAccountId: account.id,
      detailsSubmitted: Boolean(account.details_submitted),
      chargesEnabled: Boolean(account.charges_enabled),
      payoutsEnabled: Boolean(account.payouts_enabled),
      sellTickets: {
        enabled: sellTicketsStatus === 'enabled',
        status: sellTicketsStatus,
        message: sellTicketsMessage,
      },
      transferBalance: {
        enabled: transferStatus === 'enabled',
        status: transferStatus,
        message: transferMessage,
      },
      requirements: {
        currentlyDue: currentlyDueMapped,
        eventuallyDue: eventuallyDueMapped,
        pastDue: pastDueMapped,
        disabledReason,
        pendingVerification,
        rawCurrentlyDue: currentlyDueRaw,
      },
      payoutSchedule,
      externalAccounts,
      defaultCurrency: account.default_currency ? account.default_currency.toUpperCase() : 'USD',
      country: account.country || null,
    };
  } catch (error: any) {
    logStripeDiagnostic('getConnectedAccountStatus', error, {
      userId,
      stripeAccountId: user.stripeAccountId,
    });

    const classified = classifyStripeError(error);

    // Do not silently recreate a new account on read errors; surface safe status for user reconnection
    if (classified.category === 'invalid_or_inaccessible') {
      return buildDisconnectedStatus(
        'invalid_or_inaccessible',
        'The previously connected Stripe account is no longer valid or accessible. Please reconnect your Stripe account to resume ticket sales.',
        'Payouts are paused until a valid Stripe account is reconnected.'
      );
    }

    if (classified.category === 'configuration_unavailable') {
      return buildDisconnectedStatus(
        'configuration_unavailable',
        'Stripe payments are currently being configured for this platform. Please check back shortly.',
        'Payout services are temporarily unavailable while platform configuration is being completed.'
      );
    }

    if (classified.category === 'service_unavailable') {
      throw new ServiceUnavailableError(classified.safeMessage, classified.code);
    }

    throw new BadRequestError(classified.safeMessage, classified.code);
  }
}

/**
 * Creates or continues Stripe onboarding via an Account Link.
 * When `reconnect: true` is explicitly provided, replaces an invalid or stale account ID.
 * Does NOT silently create new accounts on background read errors.
 */
export async function createOnboardingLink(
  userId: string,
  returnUrl?: string,
  refreshUrl?: string,
  reconnect?: boolean
): Promise<{ url: string; stripeAccountId: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      stripeAccountId: true,
    },
  });

  if (!user) {
    throw new NotFoundError('Organizer user not found');
  }

  if (!env.STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
    throw new ServiceUnavailableError(
      'Stripe Connect onboarding is currently unavailable while platform configuration is being completed. Please check back shortly.',
      'STRIPE_CONFIGURATION_UNAVAILABLE'
    );
  }

  let accountId = user.stripeAccountId;

  // Create a new Express connected account if one does not exist or if explicitly requested to reconnect
  if (!accountId || reconnect === true) {
    try {
      const account = await stripe.accounts.create({
        type: 'express',
        email: user.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: 'individual',
        metadata: {
          userId: user.id,
          platform: 'outside.vip',
        },
      });

      accountId = account.id;

      await prisma.user.update({
        where: { id: user.id },
        data: { stripeAccountId: accountId },
      });
    } catch (error: any) {
      logStripeDiagnostic('createOnboardingLink.accounts.create', error, { userId });
      const classified = classifyStripeError(error);
      if (classified.category === 'configuration_unavailable') {
        throw new ServiceUnavailableError(classified.safeMessage, classified.code);
      }
      if (classified.category === 'service_unavailable') {
        throw new ServiceUnavailableError(classified.safeMessage, classified.code);
      }
      throw new BadRequestError(
        'Could not create Stripe connected account. Please try again later.',
        classified.code
      );
    }
  }

  // Generate the Stripe-hosted onboarding Account Link
  const baseReturn = returnUrl || `${env.CLIENT_URL}/organizer/finance?stripe_return=true`;
  const baseRefresh = refreshUrl || `${env.CLIENT_URL}/organizer/finance?stripe_refresh=true`;

  try {
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: baseRefresh,
      return_url: baseReturn,
      type: 'account_onboarding',
    });

    return {
      url: accountLink.url,
      stripeAccountId: accountId,
    };
  } catch (error: any) {
    logStripeDiagnostic('createOnboardingLink.accountLinks.create', error, {
      userId,
      accountId,
    });

    const classified = classifyStripeError(error);

    if (classified.category === 'invalid_or_inaccessible') {
      throw new BadRequestError(
        'Your existing Stripe account is no longer accessible. Please choose Reconnect to link a fresh account.',
        'INVALID_CONNECTED_ACCOUNT'
      );
    }

    if (classified.category === 'configuration_unavailable') {
      throw new ServiceUnavailableError(classified.safeMessage, classified.code);
    }

    if (classified.category === 'service_unavailable') {
      throw new ServiceUnavailableError(classified.safeMessage, classified.code);
    }

    throw new BadRequestError(
      'Could not generate Stripe onboarding link. Please try again.',
      'ONBOARDING_LINK_FAILED'
    );
  }
}

/**
 * Creates a single-use login link into the Stripe Express Dashboard.
 * If details are not submitted yet, gracefully generates an onboarding link.
 */
export async function createAccountLoginOrUpdateLink(
  userId: string,
  returnUrl?: string
): Promise<{ url: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, stripeAccountId: true },
  });

  if (!user || !user.stripeAccountId) {
    throw new BadRequestError(
      'No connected Stripe account found. Please complete onboarding first.',
      'NO_CONNECTED_ACCOUNT'
    );
  }

  if (!env.STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
    throw new ServiceUnavailableError(
      'Stripe management dashboard is temporarily unavailable while platform configuration is being completed.',
      'STRIPE_CONFIGURATION_UNAVAILABLE'
    );
  }

  try {
    const loginLink = await stripe.accounts.createLoginLink(user.stripeAccountId);
    return { url: loginLink.url };
  } catch (error: any) {
    logStripeDiagnostic('createAccountLoginOrUpdateLink.createLoginLink', error, {
      userId,
      stripeAccountId: user.stripeAccountId,
    });

    const classified = classifyStripeError(error);

    if (classified.category === 'invalid_or_inaccessible') {
      throw new BadRequestError(
        'The connected Stripe account is no longer accessible. Please reconnect your Stripe account in Finance settings.',
        'INVALID_CONNECTED_ACCOUNT'
      );
    }

    if (classified.category === 'configuration_unavailable') {
      throw new ServiceUnavailableError(classified.safeMessage, classified.code);
    }

    // Fallback: If login link fails because account is still onboarding, create onboarding link
    try {
      const baseReturn = returnUrl || `${env.CLIENT_URL}/organizer/finance?stripe_return=true`;
      const baseRefresh = `${env.CLIENT_URL}/organizer/finance?stripe_refresh=true`;

      const accountLink = await stripe.accountLinks.create({
        account: user.stripeAccountId,
        refresh_url: baseRefresh,
        return_url: baseReturn,
        type: 'account_onboarding',
      });

      return { url: accountLink.url };
    } catch (fallbackError: any) {
      logStripeDiagnostic('createAccountLoginOrUpdateLink.fallback', fallbackError, {
        userId,
        stripeAccountId: user.stripeAccountId,
      });

      const fallbackClassified = classifyStripeError(fallbackError);

      if (fallbackClassified.category === 'invalid_or_inaccessible') {
        throw new BadRequestError(
          'The connected Stripe account is no longer accessible. Please reconnect your Stripe account in Finance settings.',
          'INVALID_CONNECTED_ACCOUNT'
        );
      }

      if (fallbackClassified.category === 'configuration_unavailable') {
        throw new ServiceUnavailableError(fallbackClassified.safeMessage, fallbackClassified.code);
      }

      throw new BadRequestError(
        'Could not open Stripe management portal. Please try again.',
        'LOGIN_LINK_FAILED'
      );
    }
  }
}

/**
 * Retrieves the live available and pending balances for the organizer's connected Stripe account.
 */
export async function getConnectedAccountBalance(
  userId: string
): Promise<ConnectedAccountBalanceResponse> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripeAccountId: true },
  });

  if (!user || !user.stripeAccountId) {
    return {
      available: [],
      pending: [],
    };
  }

  if (!env.STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
    return {
      available: [],
      pending: [],
    };
  }

  try {
    const balance = await stripe.balance.retrieve({
      stripeAccount: user.stripeAccountId,
    });

    const available: BalanceCurrencyItem[] = balance.available.map((b) => ({
      amount: b.amount,
      currency: b.currency.toUpperCase(),
      sourceTypes: b.source_types as any,
    }));

    const pending: BalanceCurrencyItem[] = balance.pending.map((b) => ({
      amount: b.amount,
      currency: b.currency.toUpperCase(),
      sourceTypes: b.source_types as any,
    }));

    return { available, pending };
  } catch (error: any) {
    logStripeDiagnostic('getConnectedAccountBalance', error, {
      userId,
      stripeAccountId: user.stripeAccountId,
    });

    const classified = classifyStripeError(error);

    if (classified.category === 'invalid_or_inaccessible') {
      throw new BadRequestError(
        'The connected Stripe account could not be found or is no longer accessible. Please reconnect your account in Finance settings.',
        'INVALID_CONNECTED_ACCOUNT'
      );
    }

    if (
      classified.category === 'configuration_unavailable' ||
      classified.category === 'service_unavailable'
    ) {
      throw new ServiceUnavailableError(classified.safeMessage, classified.code);
    }

    throw new BadRequestError(
      'Could not retrieve balance from Stripe. Please try again later.',
      'STRIPE_OPERATION_FAILED'
    );
  }
}

/**
 * Retrieves real payout history from the connected Stripe account.
 */
export async function getConnectedAccountPayouts(
  userId: string,
  limit: number = 20
): Promise<{ payouts: SanitizedPayoutItem[] }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripeAccountId: true },
  });

  if (!user || !user.stripeAccountId) {
    return { payouts: [] };
  }

  if (!env.STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
    return { payouts: [] };
  }

  try {
    const payouts = await stripe.payouts.list(
      { limit: Math.min(Math.max(limit, 1), 100) },
      { stripeAccount: user.stripeAccountId }
    );

    const sanitized: SanitizedPayoutItem[] = payouts.data.map((p) => ({
      id: p.id,
      amount: p.amount,
      currency: p.currency.toUpperCase(),
      status: p.status,
      arrivalDate: p.arrival_date ? new Date(p.arrival_date * 1000).toISOString() : null,
      created: new Date(p.created * 1000).toISOString(),
      destination:
        typeof p.destination === 'string'
          ? p.destination
          : (p.destination as any)?.id || null,
      failureCode: p.failure_code || null,
      failureMessage: p.failure_message || null,
    }));

    return { payouts: sanitized };
  } catch (error: any) {
    logStripeDiagnostic('getConnectedAccountPayouts', error, {
      userId,
      stripeAccountId: user.stripeAccountId,
    });

    const classified = classifyStripeError(error);

    if (classified.category === 'invalid_or_inaccessible') {
      throw new BadRequestError(
        'The connected Stripe account could not be found or is no longer accessible. Please reconnect your account.',
        'INVALID_CONNECTED_ACCOUNT'
      );
    }

    if (
      classified.category === 'configuration_unavailable' ||
      classified.category === 'service_unavailable'
    ) {
      throw new ServiceUnavailableError(classified.safeMessage, classified.code);
    }

    throw new BadRequestError(
      'Could not retrieve payout history from Stripe. Please try again later.',
      'STRIPE_OPERATION_FAILED'
    );
  }
}

/**
 * Retrieves disputes associated with the connected Stripe account.
 */
export async function getConnectedAccountDisputes(
  userId: string,
  limit: number = 10
): Promise<{ disputes: SanitizedDisputeItem[] }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripeAccountId: true },
  });

  if (!user || !user.stripeAccountId) {
    return { disputes: [] };
  }

  if (!env.STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
    return { disputes: [] };
  }

  try {
    const disputes = await stripe.disputes.list(
      { limit: Math.min(Math.max(limit, 1), 50) },
      { stripeAccount: user.stripeAccountId }
    );

    const sanitized: SanitizedDisputeItem[] = disputes.data.map((d) => ({
      id: d.id,
      amount: d.amount,
      currency: d.currency.toUpperCase(),
      status: d.status,
      reason: d.reason,
      created: new Date(d.created * 1000).toISOString(),
      dueBy: d.evidence_details?.due_by
        ? new Date(d.evidence_details.due_by * 1000).toISOString()
        : null,
      isChargeRefundable: Boolean(d.is_charge_refundable),
    }));

    return { disputes: sanitized };
  } catch (error: any) {
    logStripeDiagnostic('getConnectedAccountDisputes', error, {
      userId,
      stripeAccountId: user.stripeAccountId,
    });

    const classified = classifyStripeError(error);

    if (classified.category === 'invalid_or_inaccessible') {
      throw new BadRequestError(
        'The connected Stripe account could not be found or is no longer accessible.',
        'INVALID_CONNECTED_ACCOUNT'
      );
    }

    if (
      classified.category === 'configuration_unavailable' ||
      classified.category === 'service_unavailable'
    ) {
      throw new ServiceUnavailableError(classified.safeMessage, classified.code);
    }

    throw new BadRequestError(
      'Could not retrieve dispute information from Stripe. Please try again later.',
      'STRIPE_OPERATION_FAILED'
    );
  }
}

/**
 * Updates the payout schedule for the connected account where supported.
 */
export async function updateConnectedAccountPayoutSchedule(
  userId: string,
  input: PayoutScheduleInput
): Promise<{
  success: boolean;
  payoutSchedule: {
    interval: string;
    delayDays: number;
    weeklyAnchor: string | null;
    monthlyAnchor: number | null;
  };
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripeAccountId: true },
  });

  if (!user || !user.stripeAccountId) {
    throw new BadRequestError('No connected Stripe account found.', 'NO_CONNECTED_ACCOUNT');
  }

  if (!env.STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
    throw new ServiceUnavailableError(
      'Updating payout schedule is temporarily unavailable while platform configuration is being completed.',
      'STRIPE_CONFIGURATION_UNAVAILABLE'
    );
  }

  const scheduleUpdate: Stripe.AccountUpdateParams.Settings.Payouts.Schedule = {
    interval: input.interval,
  };

  if (input.interval === 'weekly' && input.weeklyAnchor) {
    scheduleUpdate.weekly_anchor = input.weeklyAnchor as any;
  }
  if (input.interval === 'monthly' && input.monthlyAnchor) {
    scheduleUpdate.monthly_anchor = input.monthlyAnchor;
  }
  if (typeof input.delayDays === 'number') {
    scheduleUpdate.delay_days = input.delayDays;
  }

  try {
    const updated = await stripe.accounts.update(user.stripeAccountId, {
      settings: {
        payouts: {
          schedule: scheduleUpdate,
        },
      },
    });

    const sched = updated.settings?.payouts?.schedule;
    return {
      success: true,
      payoutSchedule: {
        interval: sched?.interval || input.interval,
        delayDays: typeof sched?.delay_days === 'number' ? sched.delay_days : 2,
        weeklyAnchor: sched?.weekly_anchor || null,
        monthlyAnchor: sched?.monthly_anchor || null,
      },
    };
  } catch (error: any) {
    logStripeDiagnostic('updateConnectedAccountPayoutSchedule', error, {
      userId,
      stripeAccountId: user.stripeAccountId,
    });

    const classified = classifyStripeError(error);

    if (classified.category === 'invalid_or_inaccessible') {
      throw new BadRequestError(
        'The connected Stripe account is no longer accessible. Please reconnect your account.',
        'INVALID_CONNECTED_ACCOUNT'
      );
    }

    if (
      classified.category === 'configuration_unavailable' ||
      classified.category === 'service_unavailable'
    ) {
      throw new ServiceUnavailableError(classified.safeMessage, classified.code);
    }

    throw new BadRequestError(
      'Failed to update payout schedule in Stripe. Please try again.',
      'STRIPE_OPERATION_FAILED'
    );
  }
}
