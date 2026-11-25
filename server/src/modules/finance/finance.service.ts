import crypto from 'crypto';
import Stripe from 'stripe';
import { LedgerEntryType, PayoutStatus, Role, TransferStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { stripe } from '../../lib/stripe.js';
import { env } from '../../config/env.js';
import { getAllAllowedOrigins } from '../../config/cors.js';
import { recordAdminAuditLog } from '../../lib/auditLogger.js';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../utils/errors.js';
import {
  classifyStripeError,
  classifyTransferCreateError,
  logStripeDiagnostic,
} from './stripeError.js';
import {
  getConfiguredStripeConnectCountries,
  DEFAULT_STRIPE_CONNECT_COUNTRY,
  isStripeExpressCountrySupported,
  isSupportedPlatformCurrency,
  StripeConnectCountry,
} from './stripeCountries.js';

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
  defaultCurrency: string | null;
  country: string | null;
  supportedCountries?: StripeConnectCountry[];
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
  transferBalanceMessage: string,
  persistedCountry?: string | null
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
    defaultCurrency: null,
    country: persistedCountry || null,
    supportedCountries: getConfiguredStripeConnectCountries(),
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
      stripeAccountCountry: true,
    },
  });

  if (!user) {
    throw new NotFoundError('Organizer user not found');
  }

  if (!env.STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
    return buildDisconnectedStatus(
      'configuration_unavailable',
      'Stripe payments are currently being configured for this platform. Please check back shortly.',
      'Payout services are temporarily unavailable while platform configuration is being completed.',
      user.stripeAccountCountry
    );
  }

  if (!user.stripeAccountId) {
    return buildDisconnectedStatus(
      'not_connected',
      'Complete Stripe onboarding to start receiving ticket payments.',
      'Payouts will be enabled once Stripe verifies your identity and banking credentials.',
      user.stripeAccountCountry
    );
  }

  try {
    const account = await stripe.accounts.retrieve(user.stripeAccountId);

    if (!user.stripeAccountCountry && account.country) {
      prisma.user
        .update({
          where: { id: user.id },
          data: { stripeAccountCountry: account.country },
        })
        .catch(() => {});
    }

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

    // Transfer Balance & Bank Payout Readiness evaluation:
    // Strictly requires active transfers capability AND payouts_enabled === true AND explicit US/USD compatibility
    const transfersActive = account.capabilities?.transfers === 'active';
    const payoutsEnabled = Boolean(account.payouts_enabled);
    const effectiveCountry = account.country || user.stripeAccountCountry || null;
    const countryCompatible =
      Boolean(effectiveCountry) && isStripeExpressCountrySupported(effectiveCountry);
    const currencyCompatible =
      Boolean(account.default_currency) && isSupportedPlatformCurrency(account.default_currency);

    let transferStatus: 'enabled' | 'action_required' | 'disabled' = 'disabled';
    let transferMessage = '';

    if (disabledReason) {
      transferStatus = 'disabled';
      transferMessage = `Disabled by Stripe: ${disabledReason}`;
    } else if (!countryCompatible) {
      transferStatus = 'disabled';
      transferMessage = effectiveCountry
        ? `Unsupported Stripe account country (${effectiveCountry}). Only US Connect Express accounts are supported for this launch.`
        : 'Missing Stripe account country. Only verified US Connect Express accounts are supported for this launch.';
    } else if (!currencyCompatible) {
      transferStatus = 'disabled';
      transferMessage = account.default_currency
        ? `Incompatible Stripe settlement currency (${account.default_currency.toUpperCase()}). USD settlement is required.`
        : 'Missing Stripe settlement currency. USD settlement is required.';
    } else if (pastDueRaw.length > 0) {
      transferStatus = 'action_required';
      transferMessage =
        'Action required: Your Stripe account has past-due verification requirements. Please complete them in Stripe.';
    } else if (transfersActive && payoutsEnabled) {
      transferStatus = 'enabled';
      transferMessage =
        'Enabled: Balance transfers and external bank payouts are fully functional.';
    } else if (transfersActive && !payoutsEnabled) {
      transferStatus = 'action_required';
      transferMessage =
        'Bank account required: Transfers capability is active, but bank payouts are not enabled yet. Link and verify a bank account in Stripe before publishing paid events or withdrawing funds.';
    } else if (currentlyDueRaw.length > 0) {
      transferStatus = 'action_required';
      transferMessage =
        'Action required: Complete required banking or identity documentation to enable withdrawals.';
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
      defaultCurrency: account.default_currency ? account.default_currency.toUpperCase() : null,
      country: account.country || user.stripeAccountCountry || null,
      supportedCountries: getConfiguredStripeConnectCountries(),
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
        'Payouts are paused until a valid Stripe account is reconnected.',
        user.stripeAccountCountry
      );
    }

    if (classified.category === 'configuration_unavailable') {
      return buildDisconnectedStatus(
        'configuration_unavailable',
        'Stripe payments are currently being configured for this platform. Please check back shortly.',
        'Payout services are temporarily unavailable while platform configuration is being completed.',
        user.stripeAccountCountry
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
 * Supports country selection with strict server-side allowlist validation.
 */
const CONNECT_ACCOUNT_CREATION_LEASE_MS = 30_000;
const CONNECT_CONCURRENT_POLL_INTERVAL_MS = 50;
const CONNECT_CONCURRENT_POLL_MAX_WAIT_MS = 1_500;

function validateOnboardingRedirectUrl(
  rawUrl: string | undefined,
  fieldName: 'returnUrl' | 'refreshUrl',
  fallbackUrl: string
): string {
  if (!rawUrl) {
    return fallbackUrl;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestError(`Invalid ${fieldName}: malformed URL.`, 'INVALID_REDIRECT_URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestError(`Invalid ${fieldName}: only HTTP(S) URLs are allowed.`, 'INVALID_REDIRECT_URL');
  }

  const allowedOrigins = getAllAllowedOrigins();
  if (!allowedOrigins.has(parsed.origin)) {
    throw new BadRequestError(
      `Invalid ${fieldName}: redirect origin '${parsed.origin}' is not allowlisted.`,
      'INVALID_REDIRECT_URL'
    );
  }

  return parsed.toString();
}

const CONNECT_ACCOUNT_RECOVERY_MAX_PAGES = 10;

type ConnectAccountLookupResult =
  | { status: 'found'; account: Stripe.Account }
  | { status: 'not_found' }
  | { status: 'ambiguous'; accountIds: string[] }
  | { status: 'incomplete'; scannedPages: number }
  | { status: 'error'; error: unknown };

async function tryFindExistingStripeAccountForCreationKey(params: {
  userId: string;
  creationKey: string;
  startedAt?: Date | null;
}): Promise<ConnectAccountLookupResult> {
  try {
    const matches: Stripe.Account[] = [];
    const seenIds = new Set<string>();
    const createdGte =
      params.startedAt && Number.isFinite(params.startedAt.getTime())
        ? Math.max(0, Math.floor(params.startedAt.getTime() / 1000) - 60)
        : undefined;

    let startingAfter: string | undefined;
    let pageCount = 0;
    let hasMore = true;

    while (hasMore && pageCount < CONNECT_ACCOUNT_RECOVERY_MAX_PAGES) {
      pageCount += 1;
      const listParams: Stripe.AccountListParams = {
        limit: 100,
        ...(createdGte !== undefined ? { created: { gte: createdGte } } : {}),
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      };

      const page = await stripe.accounts.list(listParams);
      const data = page.data || [];
      let advanced = false;

      for (const acct of data) {
        if (!acct?.id || seenIds.has(acct.id)) {
          continue;
        }
        seenIds.add(acct.id);
        advanced = true;

        if (
          acct.metadata?.userId === params.userId &&
          acct.metadata?.creationKey === params.creationKey
        ) {
          matches.push(acct);
        }
      }

      hasMore = Boolean(page.has_more);
      const lastId = data.length > 0 ? data[data.length - 1]?.id : undefined;
      if (!hasMore || !lastId || !advanced || lastId === startingAfter) {
        if (hasMore && (!lastId || !advanced || lastId === startingAfter)) {
          // Stripe returned a stalling cursor while claiming has_more; fail closed.
          return { status: 'incomplete', scannedPages: pageCount };
        }
        break;
      }
      startingAfter = lastId;
    }

    if (matches.length > 1) {
      return {
        status: 'ambiguous',
        accountIds: matches.map((acct) => acct.id),
      };
    }

    if (matches.length === 1) {
      if (hasMore && pageCount >= CONNECT_ACCOUNT_RECOVERY_MAX_PAGES) {
        // Scan truncated before confirming no duplicate account exists beyond page cap.
        return { status: 'incomplete', scannedPages: pageCount };
      }
      return { status: 'found', account: matches[0] };
    }

    if (hasMore) {
      return { status: 'incomplete', scannedPages: pageCount };
    }

    return { status: 'not_found' };
  } catch (err) {
    return { status: 'error', error: err };
  }
}

async function releaseConnectCreationClaim(params: {
  userId: string;
  lockId: string;
  clearCreationKey: boolean;
}): Promise<void> {
  await prisma.user.updateMany({
    where: {
      id: params.userId,
      stripeAccountCreationLockedBy: params.lockId,
    },
    data: {
      stripeAccountCreationLockedBy: null,
      stripeAccountCreationLockedUntil: null,
      ...(params.clearCreationKey
        ? { stripeAccountCreationKey: null, stripeAccountCreationStartedAt: null }
        : {}),
    },
  });
}

async function provisionConnectExpressAccountSafely(params: {
  userId: string;
  userEmail: string;
  targetCountry: string;
  allowReplacePreviousAccountId?: string | null;
}): Promise<{ accountId: string; resolvedCountry: string }> {
  const effectiveStripeKey = process.env.STRIPE_SECRET_KEY ?? env.STRIPE_SECRET_KEY;
  if (!effectiveStripeKey || effectiveStripeKey === 'sk_test_placeholder') {
    throw new ServiceUnavailableError(
      'Stripe Connect onboarding is currently unavailable while platform configuration is being completed. Please check back shortly.',
      'STRIPE_CONFIGURATION_UNAVAILABLE'
    );
  }

  const lockId = `connect_claim_${crypto.randomBytes(8).toString('hex')}`;
  const isReplacementFlow = Boolean(params.allowReplacePreviousAccountId);

  const attemptClaim = async (): Promise<
    | {
        status: 'claimed';
        creationKey: string;
        creationStartedAt: Date;
        isRecoveringPreviousAttempt: boolean;
        existingCountry: string | null;
      }
    | { status: 'already_connected'; accountId: string; country: string | null }
    | { status: 'locked_by_other' }
  > => {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + CONNECT_ACCOUNT_CREATION_LEASE_MS);

    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          stripeAccountId: string | null;
          stripeAccountCountry: string | null;
          stripeAccountCreationKey: string | null;
          stripeAccountCreationLockedBy: string | null;
          stripeAccountCreationLockedUntil: Date | null;
          stripeAccountCreationStartedAt: Date | null;
        }>
      >`
        SELECT
          id,
          "stripeAccountId",
          "stripeAccountCountry",
          "stripeAccountCreationKey",
          "stripeAccountCreationLockedBy",
          "stripeAccountCreationLockedUntil",
          "stripeAccountCreationStartedAt"
        FROM "User"
        WHERE id = ${params.userId}
        FOR UPDATE
      `;

      const lockedUser = rows[0];
      if (!lockedUser) {
        throw new NotFoundError('Organizer user not found');
      }

      if (
        !isReplacementFlow &&
        lockedUser.stripeAccountId
      ) {
        return {
          status: 'already_connected' as const,
          accountId: lockedUser.stripeAccountId,
          country: lockedUser.stripeAccountCountry,
        };
      }

      if (
        isReplacementFlow &&
        lockedUser.stripeAccountId &&
        lockedUser.stripeAccountId !== params.allowReplacePreviousAccountId
      ) {
        return {
          status: 'already_connected' as const,
          accountId: lockedUser.stripeAccountId,
          country: lockedUser.stripeAccountCountry,
        };
      }

      if (
        lockedUser.stripeAccountCreationLockedUntil &&
        lockedUser.stripeAccountCreationLockedUntil.getTime() > now.getTime()
      ) {
        return { status: 'locked_by_other' as const };
      }

      const isRecoveringPreviousAttempt = Boolean(lockedUser.stripeAccountCreationKey);
      const creationKey =
        lockedUser.stripeAccountCreationKey ||
        `ck_${crypto.randomBytes(12).toString('hex')}`;
      const creationStartedAt =
        isRecoveringPreviousAttempt && lockedUser.stripeAccountCreationStartedAt
          ? lockedUser.stripeAccountCreationStartedAt
          : now;

      await tx.user.update({
        where: { id: params.userId },
        data: {
          stripeAccountCreationKey: creationKey,
          stripeAccountCreationLockedBy: lockId,
          stripeAccountCreationLockedUntil: leaseUntil,
          stripeAccountCreationStartedAt: creationStartedAt,
        },
      });

      return {
        status: 'claimed' as const,
        creationKey,
        creationStartedAt,
        isRecoveringPreviousAttempt,
        existingCountry: lockedUser.stripeAccountCountry,
      };
    });
  };

  let claim = await attemptClaim();
  const pollDeadline = Date.now() + CONNECT_CONCURRENT_POLL_MAX_WAIT_MS;
  while (claim.status === 'locked_by_other' && Date.now() < pollDeadline) {
    await new Promise((resolve) => setTimeout(resolve, CONNECT_CONCURRENT_POLL_INTERVAL_MS));
    claim = await attemptClaim();
  }

  if (claim.status === 'already_connected') {
    return {
      accountId: claim.accountId,
      resolvedCountry: claim.country || params.targetCountry,
    };
  }

  if (claim.status === 'locked_by_other') {
    throw new ConflictError(
      'Stripe Express account creation is already in progress. Please wait a moment and try again.',
      'CONNECT_ONBOARDING_IN_PROGRESS'
    );
  }

  const { creationKey, creationStartedAt, isRecoveringPreviousAttempt } = claim;

  // Outside DB locks: if recovering a prior timed-out or crashed attempt, inspect Stripe first.
  // Fail closed if Stripe account discovery is ambiguous, incomplete, or errors.
  if (isRecoveringPreviousAttempt) {
    const recoveryLookup = await tryFindExistingStripeAccountForCreationKey({
      userId: params.userId,
      creationKey,
      startedAt: creationStartedAt,
    });

    if (recoveryLookup.status === 'found') {
      const recoveredAccount = recoveryLookup.account;
      const resolvedCountry = recoveredAccount.country || params.targetCountry;
      const saved = await prisma.user.updateMany({
        where: {
          id: params.userId,
          ...(isReplacementFlow
            ? { stripeAccountId: params.allowReplacePreviousAccountId }
            : { stripeAccountId: null }),
        },
        data: {
          stripeAccountId: recoveredAccount.id,
          stripeAccountCountry: resolvedCountry,
          ...(recoveredAccount.default_currency
            ? { stripeAccountDefaultCurrency: recoveredAccount.default_currency.toUpperCase() }
            : {}),
          stripeAccountCreationKey: null,
          stripeAccountCreationLockedBy: null,
          stripeAccountCreationLockedUntil: null,
          stripeAccountCreationStartedAt: null,
        },
      });
      if (saved.count > 0) {
        return { accountId: recoveredAccount.id, resolvedCountry };
      }
      const freshUser = await prisma.user.findUnique({
        where: { id: params.userId },
        select: { stripeAccountId: true, stripeAccountCountry: true },
      });
      if (freshUser?.stripeAccountId) {
        await releaseConnectCreationClaim({ userId: params.userId, lockId, clearCreationKey: true });
        return {
          accountId: freshUser.stripeAccountId,
          resolvedCountry: freshUser.stripeAccountCountry || resolvedCountry,
        };
      }
    } else if (recoveryLookup.status === 'ambiguous') {
      console.error(
        JSON.stringify({
          level: 'error',
          category: 'CONNECT_ACCOUNT_RECOVERY_AMBIGUOUS',
          userId: params.userId,
          accountIds: recoveryLookup.accountIds,
        })
      );
      await releaseConnectCreationClaim({ userId: params.userId, lockId, clearCreationKey: false });
      throw new ServiceUnavailableError(
        'Multiple Stripe Connect accounts matched your pending onboarding attempt. Support verification is required before continuing.',
        'CONNECT_ACCOUNT_RECOVERY_AMBIGUOUS'
      );
    } else if (recoveryLookup.status === 'incomplete' || recoveryLookup.status === 'error') {
      logStripeDiagnostic('provisionConnectExpressAccountSafely.recoveryLookup', recoveryLookup.status === 'error' ? recoveryLookup.error : new Error('Incomplete paginated account recovery'), {
        userId: params.userId,
        status: recoveryLookup.status,
      });
      await releaseConnectCreationClaim({ userId: params.userId, lockId, clearCreationKey: false });
      throw new ServiceUnavailableError(
        'Stripe account creation verification is temporarily unavailable. Please try onboarding again shortly without creating a duplicate account.',
        'CONNECT_ACCOUNT_CREATION_PENDING_RECOVERY'
      );
    }
  }

  try {
    const account = await stripe.accounts.create(
      {
        type: 'express',
        country: params.targetCountry,
        email: params.userEmail,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: 'individual',
        metadata: {
          userId: params.userId,
          creationKey,
          platform: 'outside.vip',
        },
      },
      {
        idempotencyKey: `acct_create_${params.userId}_${creationKey}`,
      }
    );

    const resolvedCountry = account.country || params.targetCountry;
    await prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: {
          id: params.userId,
          ...(isReplacementFlow
            ? { stripeAccountId: params.allowReplacePreviousAccountId }
            : { stripeAccountId: null }),
        },
        data: {
          stripeAccountId: account.id,
          stripeAccountCountry: resolvedCountry,
          ...(account.default_currency
            ? { stripeAccountDefaultCurrency: account.default_currency.toUpperCase() }
            : {}),
          stripeAccountCreationKey: null,
          stripeAccountCreationLockedBy: null,
          stripeAccountCreationLockedUntil: null,
          stripeAccountCreationStartedAt: null,
        },
      });

      if (updated.count === 0) {
        await tx.user.updateMany({
          where: {
            id: params.userId,
            stripeAccountCreationLockedBy: lockId,
          },
          data: {
            stripeAccountCreationKey: null,
            stripeAccountCreationLockedBy: null,
            stripeAccountCreationLockedUntil: null,
            stripeAccountCreationStartedAt: null,
          },
        });
      }
    });

    const latest = await prisma.user.findUnique({
      where: { id: params.userId },
      select: { stripeAccountId: true, stripeAccountCountry: true },
    });

    return {
      accountId: latest?.stripeAccountId || account.id,
      resolvedCountry: latest?.stripeAccountCountry || resolvedCountry,
    };
  } catch (error: any) {
    logStripeDiagnostic('createOnboardingLink.accounts.create', error, {
      userId: params.userId,
      country: params.targetCountry,
    });

    if (
      error?.code === 'country_unsupported' ||
      error?.param === 'country' ||
      error?.raw?.code === 'country_unsupported' ||
      /country.*unsupported|country is not supported/i.test(error?.message || '')
    ) {
      await releaseConnectCreationClaim({ userId: params.userId, lockId, clearCreationKey: true });
      throw new BadRequestError(
        `Stripe does not currently support Express accounts in ${params.targetCountry}. Please select another country.`,
        'STRIPE_COUNTRY_UNSUPPORTED'
      );
    }

    const classifiedCreate = classifyTransferCreateError(error);
    if (classifiedCreate.disposition === 'AMBIGUOUS') {
      // Quick non-locking recovery lookup in case Stripe created the account before timeout/drop
      const recoveryLookup = await tryFindExistingStripeAccountForCreationKey({
        userId: params.userId,
        creationKey,
        startedAt: creationStartedAt,
      });
      if (recoveryLookup.status === 'found') {
        const recoveredAccount = recoveryLookup.account;
        const resolvedCountry = recoveredAccount.country || params.targetCountry;
        await prisma.user.updateMany({
          where: {
            id: params.userId,
            ...(isReplacementFlow
              ? { stripeAccountId: params.allowReplacePreviousAccountId }
              : { stripeAccountId: null }),
          },
          data: {
            stripeAccountId: recoveredAccount.id,
            stripeAccountCountry: resolvedCountry,
            ...(recoveredAccount.default_currency
              ? { stripeAccountDefaultCurrency: recoveredAccount.default_currency.toUpperCase() }
              : {}),
            stripeAccountCreationKey: null,
            stripeAccountCreationLockedBy: null,
            stripeAccountCreationLockedUntil: null,
            stripeAccountCreationStartedAt: null,
          },
        });
        return { accountId: recoveredAccount.id, resolvedCountry };
      }
      if (recoveryLookup.status === 'ambiguous') {
        console.error(
          JSON.stringify({
            level: 'error',
            category: 'CONNECT_ACCOUNT_RECOVERY_AMBIGUOUS',
            userId: params.userId,
            accountIds: recoveryLookup.accountIds,
          })
        );
      }

      // Preserve creationKey & startedAt across ambiguous errors so the next retry uses the exact same key & bounds!
      await releaseConnectCreationClaim({ userId: params.userId, lockId, clearCreationKey: false });
      throw new ServiceUnavailableError(
        'Stripe account creation timed out before confirmation. Retry onboarding safely to recover or complete your setup without creating a duplicate account.',
        'CONNECT_ACCOUNT_CREATION_PENDING_RECOVERY'
      );
    }

    await releaseConnectCreationClaim({ userId: params.userId, lockId, clearCreationKey: true });
    const classified = classifyStripeError(error);
    if (
      classified.category === 'configuration_unavailable' ||
      classified.category === 'service_unavailable'
    ) {
      throw new ServiceUnavailableError(classified.safeMessage, classified.code);
    }
    throw new BadRequestError(
      classified.safeMessage || 'Could not create Stripe connected account. Please try again later.',
      classified.code || 'STRIPE_ACCOUNT_CREATION_FAILED'
    );
  }
}

/**
 * Creates or continues Stripe onboarding via an Account Link.
 * Serializes concurrent initial account creations with a DB lease + durable creationKey,
 * protects valid or in-flight connected accounts against unsafe self-service `reconnect: true`,
 * and restricts onboarding countries & redirect origins strictly.
 */
export async function createOnboardingLink(
  userId: string,
  returnUrl?: string,
  refreshUrl?: string,
  reconnect?: boolean,
  country?: string
): Promise<{ url: string; stripeAccountId: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      stripeAccountId: true,
      stripeAccountCountry: true,
    },
  });

  if (!user) {
    throw new NotFoundError('Organizer user not found');
  }

  const effectiveStripeKey = process.env.STRIPE_SECRET_KEY ?? env.STRIPE_SECRET_KEY;
  if (!effectiveStripeKey || effectiveStripeKey === 'sk_test_placeholder') {
    throw new ServiceUnavailableError(
      'Stripe Connect onboarding is currently unavailable while platform configuration is being completed. Please check back shortly.',
      'STRIPE_CONFIGURATION_UNAVAILABLE'
    );
  }

  const defaultReturnUrl = `${env.CLIENT_URL}/organizer/finance?stripe_return=true`;
  const defaultRefreshUrl = `${env.CLIENT_URL}/organizer/finance?stripe_refresh=true`;
  const validatedReturnUrl = validateOnboardingRedirectUrl(returnUrl, 'returnUrl', defaultReturnUrl);
  const validatedRefreshUrl = validateOnboardingRedirectUrl(refreshUrl, 'refreshUrl', defaultRefreshUrl);

  if (country !== undefined) {
    const normalizedCountry = country.trim().toUpperCase();
    if (!isStripeExpressCountrySupported(normalizedCountry)) {
      throw new BadRequestError(
        `Country '${country}' is not supported for Stripe Connect Express onboarding on this platform. Please select an eligible country.`,
        'UNSUPPORTED_COUNTRY'
      );
    }
  }

  let accountId = user.stripeAccountId;

  if (!accountId) {
    const targetCountry = country
      ? country.trim().toUpperCase()
      : DEFAULT_STRIPE_CONNECT_COUNTRY;

    if (!isStripeExpressCountrySupported(targetCountry)) {
      throw new BadRequestError(
        `Country '${targetCountry}' is not supported for Stripe Connect Express onboarding on this platform. Please select an eligible country.`,
        'UNSUPPORTED_COUNTRY'
      );
    }

    const provisioned = await provisionConnectExpressAccountSafely({
      userId: user.id,
      userEmail: user.email,
      targetCountry,
    });
    accountId = provisioned.accountId;
  } else if (reconnect === true) {
    // Guard reconnect: true so valid, funded, or in-flight connected accounts cannot be
    // silently replaced or orphaned via self-service onboarding.
    const pendingTransfer = await prisma.organizerTransfer.findFirst({
      where: {
        organizerId: user.id,
        status: TransferStatus.PENDING,
      },
      select: { id: true, transferNumber: true },
    });

    if (pendingTransfer) {
      throw new ConflictError(
        `Cannot replace your Stripe account while transfer #${pendingTransfer.transferNumber} is still pending verification.`,
        'TRANSFER_RECONCILIATION_PENDING'
      );
    }

    let existingAccessible = false;
    try {
      await stripe.accounts.retrieve(accountId);
      existingAccessible = true;
    } catch (retrieveErr: any) {
      const classified = classifyStripeError(retrieveErr);
      if (classified.category !== 'invalid_or_inaccessible') {
        if (
          classified.category === 'configuration_unavailable' ||
          classified.category === 'service_unavailable'
        ) {
          throw new ServiceUnavailableError(classified.safeMessage, classified.code);
        }
        throw new BadRequestError(classified.safeMessage, classified.code);
      }
    }

    if (existingAccessible) {
      throw new BadRequestError(
        'Your connected Stripe Express account is still active and accessible. Self-service replacement is disabled to protect your payout history; contact support/admin if replacement is required.',
        'RECONNECT_NOT_ALLOWED'
      );
    }

    const targetCountry = country
      ? country.trim().toUpperCase()
      : user.stripeAccountCountry && isStripeExpressCountrySupported(user.stripeAccountCountry)
        ? user.stripeAccountCountry
        : DEFAULT_STRIPE_CONNECT_COUNTRY;

    if (!isStripeExpressCountrySupported(targetCountry)) {
      throw new BadRequestError(
        `Country '${targetCountry}' is not supported for Stripe Connect Express onboarding on this platform. Please select an eligible country.`,
        'UNSUPPORTED_COUNTRY'
      );
    }

    const provisioned = await provisionConnectExpressAccountSafely({
      userId: user.id,
      userEmail: user.email,
      targetCountry,
      allowReplacePreviousAccountId: accountId,
    });
    accountId = provisioned.accountId;
  } else {
    // Existing connected account: retain original country without recreating
    if (!user.stripeAccountCountry) {
      try {
        const existingAccount = await stripe.accounts.retrieve(accountId);
        if (existingAccount?.country) {
          await prisma.user.update({
            where: { id: user.id },
            data: { stripeAccountCountry: existingAccount.country },
          });
        }
      } catch {
        // Proceed with onboarding link generation even if retrieval fails
      }
    }
  }

  try {
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: validatedRefreshUrl,
      return_url: validatedReturnUrl,
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
 * Explicit admin-audited workflow to replace an organizer's connected Stripe Express account
 * while preserving all historical OrganizerTransfer and ConnectedPayout records.
 */
export async function adminReplaceConnectedAccount(params: {
  adminUserId: string;
  adminEmail: string;
  organizerId: string;
  country?: string;
  reason: string;
  ipAddress?: string;
}): Promise<{
  organizerId: string;
  previousStripeAccountId: string | null;
  newStripeAccountId: string;
  onboardingUrl: string;
}> {
  const organizer = await prisma.user.findUnique({
    where: { id: params.organizerId },
    select: {
      id: true,
      email: true,
      stripeAccountId: true,
      stripeAccountCountry: true,
    },
  });

  if (!organizer) {
    throw new NotFoundError('Organizer user not found');
  }

  const pendingTransfer = await prisma.organizerTransfer.findFirst({
    where: {
      organizerId: organizer.id,
      status: TransferStatus.PENDING,
    },
    select: { id: true, transferNumber: true },
  });

  if (pendingTransfer) {
    throw new ConflictError(
      `Cannot replace connected account while transfer #${pendingTransfer.transferNumber} is still pending reconciliation.`,
      'TRANSFER_RECONCILIATION_PENDING'
    );
  }

  const targetCountry = params.country
    ? params.country.trim().toUpperCase()
    : organizer.stripeAccountCountry && isStripeExpressCountrySupported(organizer.stripeAccountCountry)
      ? organizer.stripeAccountCountry
      : DEFAULT_STRIPE_CONNECT_COUNTRY;

  if (!isStripeExpressCountrySupported(targetCountry)) {
    throw new BadRequestError(
      `Country '${targetCountry}' is not supported for Stripe Connect Express onboarding.`,
      'UNSUPPORTED_COUNTRY'
    );
  }

  const previousStripeAccountId = organizer.stripeAccountId;
  const provisioned = await provisionConnectExpressAccountSafely({
    userId: organizer.id,
    userEmail: organizer.email,
    targetCountry,
    allowReplacePreviousAccountId: previousStripeAccountId,
  });

  const accountLink = await stripe.accountLinks.create({
    account: provisioned.accountId,
    refresh_url: `${env.CLIENT_URL}/organizer/finance?stripe_refresh=true`,
    return_url: `${env.CLIENT_URL}/organizer/finance?stripe_return=true`,
    type: 'account_onboarding',
  });

  await recordAdminAuditLog({
    actorUserId: params.adminUserId,
    actorEmail: params.adminEmail,
    action: 'ADMIN_CONNECT_ACCOUNT_REPLACED',
    targetType: 'User',
    targetId: organizer.id,
    metadata: {
      previousStripeAccountId,
      newStripeAccountId: provisioned.accountId,
      country: provisioned.resolvedCountry,
      reason: params.reason,
    },
    ipAddress: params.ipAddress,
  });

  return {
    organizerId: organizer.id,
    previousStripeAccountId,
    newStripeAccountId: provisioned.accountId,
    onboardingUrl: accountLink.url,
  };
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

  const effectiveStripeKey = (process.env.STRIPE_SECRET_KEY ?? env.STRIPE_SECRET_KEY ?? '').trim();
  if (!effectiveStripeKey || effectiveStripeKey === 'sk_test_placeholder') {
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

    // Reconcile delayed/missed payout.* webhooks into local ConnectedPayout snapshots
    if (typeof (prisma as any)?.connectedPayout?.upsert === 'function') {
      for (const p of payouts.data) {
        let localStatus: PayoutStatus = PayoutStatus.PENDING;
        if (p.status === 'paid') {
          localStatus = PayoutStatus.PAID;
        } else if (p.status === 'failed') {
          localStatus = PayoutStatus.FAILED;
        } else if (p.status === 'canceled') {
          localStatus = PayoutStatus.CANCELLED;
        }

        const arrivalDate = p.arrival_date ? new Date(p.arrival_date * 1000) : null;
        await prisma.connectedPayout.upsert({
          where: { stripePayoutId: p.id },
          update: {
            status: localStatus,
            arrivalDate,
            failureCode: p.failure_code || null,
            failureMessage: p.failure_message || null,
          },
          create: {
            stripePayoutId: p.id,
            organizerId: userId,
            stripeAccountId: user.stripeAccountId,
            amountInCents: p.amount,
            currency: p.currency.toUpperCase(),
            status: localStatus,
            arrivalDate,
            failureCode: p.failure_code || null,
            failureMessage: p.failure_message || null,
          },
        });
      }
    }

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

interface OrganizerDisputeOwnership {
  orderIds: Set<string>;
  disputeIds: Set<string>;
  chargeIds: Set<string>;
  paymentIntentIds: Set<string>;
}

function sanitizeDisputeItem(d: Stripe.Dispute): SanitizedDisputeItem {
  return {
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
  };
}

function addNonEmptyIdentifier(target: Set<string>, value: unknown): void {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) {
      target.add(trimmed);
    }
  }
}

async function resolveOrganizerDisputeOwnership(
  userId: string
): Promise<OrganizerDisputeOwnership> {
  const [ownedOrders, organizerLedgerEntries] = await Promise.all([
    prisma.order.findMany({
      where: { event: { organizerId: userId } },
      select: {
        id: true,
        paymentReference: true,
        stripeSettledChargeId: true,
        transactions: {
          select: {
            providerTransactionId: true,
            rawResponse: true,
          },
        },
        refunds: {
          select: {
            stripePaymentIntentId: true,
            stripeChargeId: true,
          },
        },
      },
    }),
    prisma.financialLedgerEntry.findMany({
      where: {
        organizerId: userId,
        stripeReferenceId: { not: null },
      },
      select: {
        type: true,
        orderId: true,
        stripeReferenceId: true,
        metadata: true,
      },
    }),
  ]);

  const orderIds = new Set<string>();
  const disputeIds = new Set<string>();
  const chargeIds = new Set<string>();
  const paymentIntentIds = new Set<string>();

  for (const order of ownedOrders) {
    addNonEmptyIdentifier(orderIds, order.id);
    addNonEmptyIdentifier(paymentIntentIds, order.paymentReference);
    addNonEmptyIdentifier(chargeIds, order.stripeSettledChargeId);

    for (const tx of order.transactions) {
      const ref = tx.providerTransactionId?.trim();
      if (ref) {
        if (ref.startsWith('ch_')) {
          chargeIds.add(ref);
        } else if (ref.startsWith('pi_')) {
          paymentIntentIds.add(ref);
        } else {
          // Support synthetic non-prefixed transaction IDs in tests
          chargeIds.add(ref);
          paymentIntentIds.add(ref);
        }
      }

      if (tx.rawResponse && typeof tx.rawResponse === 'object' && !Array.isArray(tx.rawResponse)) {
        const latestCharge = (tx.rawResponse as Record<string, unknown>).latest_charge;
        if (typeof latestCharge === 'string') {
          addNonEmptyIdentifier(chargeIds, latestCharge);
        } else if (
          latestCharge &&
          typeof latestCharge === 'object' &&
          typeof (latestCharge as Record<string, unknown>).id === 'string'
        ) {
          addNonEmptyIdentifier(chargeIds, (latestCharge as Record<string, unknown>).id);
        }
      }
    }

    for (const refund of order.refunds) {
      addNonEmptyIdentifier(paymentIntentIds, refund.stripePaymentIntentId);
      addNonEmptyIdentifier(chargeIds, refund.stripeChargeId);
    }
  }

  for (const entry of organizerLedgerEntries) {
    addNonEmptyIdentifier(orderIds, entry.orderId);
    const ref = entry.stripeReferenceId?.trim();

    if (
      entry.type === LedgerEntryType.DISPUTE_HOLD ||
      entry.type === LedgerEntryType.DISPUTE_WON ||
      entry.type === LedgerEntryType.DISPUTE_LOST
    ) {
      if (ref) {
        disputeIds.add(ref);
      }
      if (entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata)) {
        addNonEmptyIdentifier(chargeIds, (entry.metadata as Record<string, unknown>).stripeChargeId);
      }
    } else if (ref) {
      if (ref.startsWith('ch_')) {
        chargeIds.add(ref);
      } else if (ref.startsWith('pi_')) {
        paymentIntentIds.add(ref);
      }
    }
  }

  return { orderIds, disputeIds, chargeIds, paymentIntentIds };
}

function doesDisputeBelongToOrganizer(
  dispute: Stripe.Dispute,
  ownership: OrganizerDisputeOwnership
): boolean {
  if (ownership.disputeIds.has(dispute.id)) {
    return true;
  }

  const chargeObj =
    typeof dispute.charge === 'object' && dispute.charge !== null
      ? (dispute.charge as Stripe.Charge)
      : null;
  const chargeId =
    typeof dispute.charge === 'string' ? dispute.charge : chargeObj?.id;

  if (chargeId && ownership.chargeIds.has(chargeId)) {
    return true;
  }

  const piFromDispute =
    typeof dispute.payment_intent === 'string'
      ? dispute.payment_intent
      : (dispute.payment_intent as Stripe.PaymentIntent | null)?.id;
  const piFromCharge = chargeObj
    ? typeof chargeObj.payment_intent === 'string'
      ? chargeObj.payment_intent
      : (chargeObj.payment_intent as Stripe.PaymentIntent | null)?.id
    : undefined;
  const paymentIntentId = piFromDispute || piFromCharge;

  if (paymentIntentId && ownership.paymentIntentIds.has(paymentIntentId)) {
    return true;
  }

  const metaOrderId =
    dispute.metadata?.orderId || chargeObj?.metadata?.orderId;
  if (metaOrderId && ownership.orderIds.has(metaOrderId)) {
    return true;
  }

  return false;
}

/**
 * Retrieves disputes associated with ticket sales from the platform Stripe account.
 * Customer charges are created on the Outside.vip platform account (merchant of record),
 * so disputes must be retrieved from the platform Stripe account, NOT the organizer's Express account.
 * Platform ADMIN receives platform-wide disputes; ORGANIZER accounts receive only disputes
 * matched via database ownership records and Stripe identifiers.
 */
export async function getConnectedAccountDisputes(
  userId: string,
  limit: number = 10,
  options?: { isPlatformAdmin?: boolean }
): Promise<{ disputes: SanitizedDisputeItem[] }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripeAccountId: true, role: true },
  });

  if (!user) {
    return { disputes: [] };
  }

  // Require both caller context (when supplied) and authoritative DB role to confirm platform ADMIN
  const isPlatformAdmin = options
    ? Boolean(options.isPlatformAdmin && user.role === Role.ADMIN)
    : user.role === Role.ADMIN;

  if (!isPlatformAdmin && !user.stripeAccountId) {
    return { disputes: [] };
  }

  if (!env.STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
    return { disputes: [] };
  }

  const boundedLimit = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), 50)
    : 10;

  try {
    if (isPlatformAdmin) {
      // Platform-level dispute retrieval: Query platform Stripe account without { stripeAccount } header
      const disputes = await stripe.disputes.list({
        limit: boundedLimit,
      });

      return {
        disputes: disputes.data.map(sanitizeDisputeItem),
      };
    }

    const ownership = await resolveOrganizerDisputeOwnership(userId);
    if (
      ownership.disputeIds.size === 0 &&
      ownership.chargeIds.size === 0 &&
      ownership.paymentIntentIds.size === 0 &&
      ownership.orderIds.size === 0
    ) {
      return { disputes: [] };
    }

    const matchedDisputes: Stripe.Dispute[] = [];
    const seenDisputeIds = new Set<string>();
    let startingAfter: string | undefined;
    const maxPages = 10;
    const pageLimit = 100;

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const page = await stripe.disputes.list({
        limit: pageLimit,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });

      for (const dispute of page.data) {
        if (seenDisputeIds.has(dispute.id)) continue;
        seenDisputeIds.add(dispute.id);

        if (doesDisputeBelongToOrganizer(dispute, ownership)) {
          matchedDisputes.push(dispute);
          if (matchedDisputes.length >= boundedLimit) {
            break;
          }
        }
      }

      if (
        matchedDisputes.length >= boundedLimit ||
        !page.has_more ||
        page.data.length === 0
      ) {
        break;
      }

      startingAfter = page.data[page.data.length - 1].id;
    }

    return {
      disputes: matchedDisputes.map(sanitizeDisputeItem),
    };
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

/**
 * Verifies that an organizer's Stripe Connect Express account is sufficiently onboarded
 * and eligible to receive transfers before publishing a paid event.
 */
export async function assertStripeReadyForPaidPublishing(
  organizerId: string
): Promise<ConnectedAccountStatusResponse> {
  const status = await getConnectedAccountStatus(organizerId);

  const countryCompatible =
    Boolean(status.country) && isStripeExpressCountrySupported(status.country);
  const currencyCompatible =
    Boolean(status.defaultCurrency) && isSupportedPlatformCurrency(status.defaultCurrency);

  if (
    status.connected &&
    status.detailsSubmitted &&
    status.payoutsEnabled &&
    status.transferBalance.enabled &&
    countryCompatible &&
    currencyCompatible
  ) {
    return status;
  }

  const missingItems: string[] = [];

  if (!status.connected) {
    if (status.connectionStatus === 'not_connected') {
      missingItems.push(
        'Connect your Stripe Express account in Finance & Payouts to receive event revenue transfers'
      );
    } else {
      missingItems.push(status.transferBalance.message || status.sellTickets.message);
    }
  } else {
    if (!status.detailsSubmitted) {
      missingItems.push('Submit required business or identity onboarding details in Stripe Express');
    }
    if (status.requirements.disabledReason) {
      missingItems.push(`Resolve Stripe account restriction (${status.requirements.disabledReason})`);
    }
    if (!countryCompatible) {
      missingItems.push(
        status.country
          ? `Connected Stripe Express account country (${status.country}) is not supported for USD publishing`
          : 'Connected Stripe Express account country is missing; US account is required for USD publishing'
      );
    }
    if (!currencyCompatible) {
      missingItems.push(
        status.defaultCurrency
          ? `Connected Stripe Express account currency (${status.defaultCurrency}) must support USD settlements`
          : 'Connected Stripe Express account currency is missing; USD settlement is required'
      );
    }
    for (const req of status.requirements.pastDue) {
      missingItems.push(req.description);
    }
    for (const req of status.requirements.currentlyDue) {
      if (!missingItems.includes(req.description)) {
        missingItems.push(req.description);
      }
    }
    if (!status.payoutsEnabled) {
      const bankReqMsg =
        'Link and verify a bank account in Stripe Express so external payouts are enabled before publishing paid events';
      if (!missingItems.some((m) => m.toLowerCase().includes('bank account'))) {
        missingItems.push(bankReqMsg);
      }
    }
    if (!status.transferBalance.enabled && missingItems.length === 0) {
      missingItems.push(
        status.transferBalance.message ||
          'Ensure your Stripe Express account transfers and payout capabilities are active'
      );
    }
  }

  const explanation =
    missingItems.length > 0
      ? `Cannot publish paid event until Stripe onboarding is complete. What you need to complete: ${missingItems.join('; ')}. You can still save this event as a draft or publish free events without Stripe onboarding.`
      : 'Cannot publish paid event: A verified Stripe Connect Express account eligible to receive transfers and bank payouts is required.';

  throw new BadRequestError(explanation, 'STRIPE_ONBOARDING_INCOMPLETE');
}
