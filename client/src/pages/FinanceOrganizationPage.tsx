import React, { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Building2,
  Landmark,
  ShieldCheck,
  Clock,
  CheckCircle2,
  AlertCircle,
  X,
  ExternalLink,
  RefreshCw,
  Wallet,
  AlertTriangle,
  ArrowUpRight,
  ArrowRight,
  RotateCcw,
  Send,
  Receipt,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  StripeConnectedAccountStatus,
  StripeBalanceResponse,
  StripePayoutItem,
  StripeDisputeItem,
  OrganizerPayoutDetails,
  PayoutDetailsInput,
  OrganizerTransferItem,
  FinancialLedgerEntryItem,
} from '../types';

/**
 * Strips raw secrets, account IDs, and technical exception traces from any client-displayed message.
 */
function sanitizeClientErrorMessage(msg?: string): string {
  if (!msg) return 'Could not load finance dashboard. Please try again.';
  const clean = msg
    .replace(/sk_(?:live|test)_[a-zA-Z0-9*]{4,}/gi, '[REDACTED]')
    .replace(/rk_(?:live|test)_[a-zA-Z0-9*]{4,}/gi, '[REDACTED]')
    .replace(/whsec_[a-zA-Z0-9*]{4,}/gi, '[REDACTED]')
    .replace(/pk_(?:live|test)_[a-zA-Z0-9*]{4,}/gi, '[REDACTED]')
    .replace(/acct_[a-zA-Z0-9*]{6,}/gi, '[REDACTED]');

  if (
    /Stripe|Invalid API Key|resource_missing|account_inaccessible|No such account|StripeInvalidRequestError/i.test(
      clean
    )
  ) {
    return 'Payment and payout services encountered an issue. Please try again later or reconnect your Stripe account.';
  }
  return clean;
}

/**
 * Format minor currency units (cents) into user-friendly currency string.
 */
function formatCurrency(amountInCents: number, currency: string = 'USD'): string {
  const amount = amountInCents / 100;
  const curr = currency.toUpperCase();

  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: curr,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${curr} ${amount.toFixed(2)}`;
  }
}

/**
 * Format ISO date string into readable date.
 */
function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

export const FinanceOrganizationPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    const originalBg = document.body.style.backgroundColor;
    document.body.style.backgroundColor = '#FAF8F5';
    return () => {
      document.body.style.backgroundColor = originalBg;
    };
  }, []);

  // Main state
  const [accountStatus, setAccountStatus] = useState<StripeConnectedAccountStatus | null>(null);
  const [balance, setBalance] = useState<StripeBalanceResponse | null>(null);
  const [transfers, setTransfers] = useState<OrganizerTransferItem[]>([]);
  const [payouts, setPayouts] = useState<StripePayoutItem[]>([]);
  const [disputes, setDisputes] = useState<StripeDisputeItem[]>([]);
  const [ledgerEntries, setLedgerEntries] = useState<FinancialLedgerEntryItem[]>([]);
  const [payoutDetails, setPayoutDetails] = useState<OrganizerPayoutDetails | null>(null);

  // UI state
  const [activeTab, setActiveTab] = useState<'finance' | 'organization'>('finance');
  const [historyTab, setHistoryTab] = useState<'transfers' | 'payouts' | 'ledger'>('transfers');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notification, setNotification] = useState<{
    message: string;
    type: 'info' | 'success' | 'warning' | 'error';
  } | null>(null);

  // Withdrawal modal state
  const [isWithdrawModalOpen, setIsWithdrawModalOpen] = useState<boolean>(false);
  const [withdrawAmountDollars, setWithdrawAmountDollars] = useState<string>('');
  const [withdrawNotes, setWithdrawNotes] = useState<string>('');
  const [isSubmittingWithdrawal, setIsSubmittingWithdrawal] = useState<boolean>(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  // Edit organization form state
  const [isEditingOrg, setIsEditingOrg] = useState<boolean>(false);
  const [orgForm, setOrgForm] = useState<PayoutDetailsInput>({
    orgType: 'Company',
    orgTypeOther: '',
    registeredName: '',
    registrationNumber: '',
    country: 'Kenya',
    address: '',
    contactPersonName: '',
    contactEmail: '',
    accountHolderName: '',
    bankName: '',
    bankCountry: 'Kenya',
    accountCurrency: 'USD',
  });
  const [isSavingOrg, setIsSavingOrg] = useState<boolean>(false);

  // Load all finance and organization data
  const loadDashboardData = useCallback(async (isRefresh = false) => {
    if (isRefresh) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }
    setError(null);

    try {
      // 1. Fetch connected Stripe account status
      const statusRes = await api.finance.getStatus();
      setAccountStatus(statusRes);

      // 2. Fetch Posh-inspired ledger balances & transfers
      const [balRes, transfersRes, payoutsRes, disputesRes, ledgerRes] = await Promise.all([
        api.finance.getBalance().catch(() => null),
        api.finance.getTransfers(1, 20).catch(() => ({ total: 0, transfers: [] })),
        statusRes.connected ? api.finance.getPayouts(20).catch(() => ({ payouts: [] })) : Promise.resolve({ payouts: [] }),
        statusRes.connected ? api.finance.getDisputes(10).catch(() => ({ disputes: [] })) : Promise.resolve({ disputes: [] }),
        api.finance.getLedger({ page: 1, limit: 20 }).catch(() => ({ total: 0, entries: [] })),
      ]);

      setBalance(balRes);
      setTransfers(transfersRes?.transfers || []);
      setPayouts(payoutsRes?.payouts || []);
      setDisputes(disputesRes?.disputes || []);
      setLedgerEntries(ledgerRes?.entries || []);

      // 3. Fetch Organization Legal Details
      try {
        const orgRes = await api.organizer.getPayoutDetails();
        if (orgRes.payoutDetails) {
          setPayoutDetails(orgRes.payoutDetails);
          setOrgForm({
            orgType: orgRes.payoutDetails.orgType,
            orgTypeOther: orgRes.payoutDetails.orgTypeOther || '',
            registeredName: orgRes.payoutDetails.registeredName,
            registrationNumber: orgRes.payoutDetails.registrationNumber || '',
            country: orgRes.payoutDetails.country,
            address: orgRes.payoutDetails.address || '',
            contactPersonName: orgRes.payoutDetails.contactPersonName,
            contactEmail: orgRes.payoutDetails.contactEmail,
            accountHolderName: orgRes.payoutDetails.accountHolderName,
            bankName: orgRes.payoutDetails.bankName,
            bankCountry: orgRes.payoutDetails.bankCountry,
            accountCurrency: orgRes.payoutDetails.accountCurrency,
          });
        }
      } catch {
        // Payout details optional init
      }
    } catch (err: any) {
      console.error('Failed to load finance data:', err);
      if (err?.code === 'STRIPE_CONFIGURATION_UNAVAILABLE') {
        setError('Stripe Connect is currently being configured on Outside.vip. Payouts and account management will be available shortly.');
      } else if (err?.code === 'INVALID_CONNECTED_ACCOUNT') {
        setError('Your connected Stripe account could not be found or is no longer accessible. Please reconnect your account.');
      } else if (err?.code === 'STRIPE_SERVICE_UNAVAILABLE') {
        setError('Stripe services are temporarily unreachable. Please check your connection and try refreshing in a few moments.');
      } else {
        setError(sanitizeClientErrorMessage(err?.message));
      }
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  // Handle URL return parameters from Stripe
  useEffect(() => {
    const isReturn = searchParams.get('stripe_return') === 'true';
    const isRefresh = searchParams.get('stripe_refresh') === 'true';

    if (isReturn) {
      setNotification({
        type: 'success',
        message: 'Successfully returned from Stripe! Refreshing your account and payment methods...',
      });
      searchParams.delete('stripe_return');
      setSearchParams(searchParams, { replace: true });
    } else if (isRefresh) {
      setNotification({
        type: 'warning',
        message: 'Your previous Stripe onboarding session expired. Click below to resume or complete your setup.',
      });
      searchParams.delete('stripe_refresh');
      setSearchParams(searchParams, { replace: true });
    }

    loadDashboardData();
  }, [loadDashboardData, searchParams, setSearchParams]);

  // Handle Start / Continue Onboarding
  const handleStartOrContinueOnboarding = async (options?: { reconnect?: boolean }) => {
    setActionLoading('onboarding');
    setError(null);
    try {
      const isReconnect =
        options?.reconnect || accountStatus?.connectionStatus === 'invalid_or_inaccessible';
      const res = await api.finance.createOnboardingLink({ reconnect: isReconnect });
      if (res?.url) {
        window.location.href = res.url;
      } else {
        throw new Error('No redirect URL received from Stripe onboarding service');
      }
    } catch (err: any) {
      console.error('Failed to create onboarding link:', err);
      let friendlyMsg = 'Could not initiate Stripe onboarding. Please try again.';
      if (err?.code === 'STRIPE_CONFIGURATION_UNAVAILABLE') {
        friendlyMsg = 'Stripe Connect is currently being configured for this platform. Please check back shortly.';
      } else if (err?.code === 'STRIPE_SERVICE_UNAVAILABLE') {
        friendlyMsg = 'Stripe services are temporarily unreachable. Please try again in a few moments.';
      } else if (err?.message) {
        friendlyMsg = sanitizeClientErrorMessage(err.message);
      }
      setError(friendlyMsg);
    } finally {
      setActionLoading(null);
    }
  };

  // Handle Open Stripe Express Dashboard
  const handleOpenStripeDashboard = async () => {
    setActionLoading('dashboard');
    setError(null);
    try {
      const res = await api.finance.createLoginLink();
      if (res?.url) {
        window.open(res.url, '_blank', 'noopener,noreferrer');
      } else {
        throw new Error('No dashboard link received');
      }
    } catch (err: any) {
      console.error('Failed to open Stripe dashboard:', err);
      let friendlyMsg = 'Could not access the Stripe Express dashboard. Please try again.';
      if (err?.code === 'INVALID_CONNECTED_ACCOUNT') {
        friendlyMsg = 'Your connected Stripe account is no longer valid. Please reconnect your account.';
      } else if (err?.message) {
        friendlyMsg = sanitizeClientErrorMessage(err.message);
      }
      setError(friendlyMsg);
    } finally {
      setActionLoading(null);
    }
  };

  // Handle Request Withdrawal submission
  const handleWithdrawalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setWithdrawError(null);

    const amountFloat = parseFloat(withdrawAmountDollars);
    if (isNaN(amountFloat) || amountFloat < 1.0) {
      setWithdrawError('Minimum withdrawal amount is $1.00 USD.');
      return;
    }

    const amountInCents = Math.round(amountFloat * 100);
    const availableCents = balance?.availableInCents ?? (balance?.available?.[0]?.amount || 0);
    const recoverableCents = balance?.recoverableInCents ?? 0;
    const netAvailable = Math.max(0, availableCents - recoverableCents);

    if (amountInCents > netAvailable) {
      setWithdrawError(`Amount exceeds your eligible available balance of ${formatCurrency(netAvailable)}.`);
      return;
    }

    setIsSubmittingWithdrawal(true);
    try {
      const result = await api.finance.withdraw({
        amountInCents,
        notes: withdrawNotes || undefined,
      });

      setNotification({
        type: 'success',
        message: `Withdrawal of ${formatCurrency(result.amountInCents)} initiated successfully! Transfer ID: ${result.transferNumber}.`,
      });

      setIsWithdrawModalOpen(false);
      setWithdrawAmountDollars('');
      setWithdrawNotes('');

      // Refresh dashboard data
      await loadDashboardData(true);
    } catch (err: any) {
      console.error('Withdrawal failed:', err);
      setWithdrawError(sanitizeClientErrorMessage(err?.message || 'Withdrawal could not be completed. Please try again.'));
    } finally {
      setIsSubmittingWithdrawal(false);
    }
  };

  // Handle Save Organization Legal Details
  const handleSaveOrgDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingOrg(true);
    try {
      const res = await api.organizer.updatePayoutDetails(orgForm);
      if (res.payoutDetails) {
        setPayoutDetails(res.payoutDetails);
        setIsEditingOrg(false);
        setNotification({
          type: 'success',
          message: 'Organization details updated successfully.',
        });
      }
    } catch (err: any) {
      console.error('Failed to update organization details:', err);
      setError(err?.message || 'Could not save organization details.');
    } finally {
      setIsSavingOrg(false);
    }
  };

  // Resolved balances
  const availableCents = balance?.availableInCents ?? (balance?.available?.[0]?.amount || 0);
  const pendingCents = balance?.pendingInCents ?? (balance?.pending?.[0]?.amount || 0);
  const transferredCents = balance?.transferredInCents ?? 0;
  const lifetimeCents = balance?.lifetimeEarningsInCents ?? (availableCents + pendingCents + transferredCents);
  const recoverableCents = balance?.recoverableInCents ?? 0;
  const netAvailableCents = balance?.netAvailableInCents ?? Math.max(0, availableCents - recoverableCents);

  return (
    <div className="min-h-screen bg-[#FAF8F5] pb-24 font-sans text-stone-900">
      {/* Top Banner Navigation */}
      <div className="sticky top-0 z-30 bg-[#FAF8F5]/90 backdrop-blur-md border-b border-stone-200/80 px-4 sm:px-8 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            to="/organizer/dashboard"
            className="w-8 h-8 rounded-full border border-stone-200 bg-white hover:bg-stone-50 flex items-center justify-center text-stone-600 transition-colors shadow-2xs"
            title="Back to Organizer Dashboard"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="font-display font-black text-sm uppercase tracking-wider text-stone-900">
              Finance & Organization
            </h1>
            <p className="text-[11px] font-mono text-stone-600">
              Posh-inspired payouts, balances & Stripe Connect Express
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => loadDashboardData(true)}
            disabled={isRefreshing || isLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-stone-200 bg-white hover:bg-stone-50 text-xs font-mono text-stone-700 font-bold transition-all disabled:opacity-50 shadow-2xs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Refresh</span>
          </button>

          {accountStatus?.connected && (
            <button
              onClick={handleOpenStripeDashboard}
              disabled={actionLoading === 'dashboard'}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-stone-900 hover:bg-black text-white text-xs font-mono font-bold transition-all shadow-2xs disabled:opacity-50"
            >
              <span>Stripe Express</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-8 pt-6 space-y-6">
        {/* Global Error Banner */}
        {error && (
          <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200 flex items-start gap-3 text-rose-900 text-xs animate-fadeIn">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <span className="font-bold block text-rose-950 font-mono text-[11px] uppercase">
                Notice
              </span>
              <span>{error}</span>
            </div>
            <button
              onClick={() => setError(null)}
              className="text-rose-500 hover:text-rose-700 p-1 rounded-md"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Global Notification Banner */}
        {notification && (
          <div
            className={`p-4 rounded-2xl border flex items-start gap-3 text-xs animate-fadeIn ${
              notification.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : notification.type === 'warning'
                ? 'bg-amber-50 border-amber-200 text-amber-900'
                : 'bg-sky-50 border-sky-200 text-sky-900'
            }`}
          >
            <CheckCircle2
              className={`w-4 h-4 shrink-0 mt-0.5 ${
                notification.type === 'success'
                  ? 'text-emerald-600'
                  : notification.type === 'warning'
                  ? 'text-amber-600'
                  : 'text-sky-600'
              }`}
            />
            <div className="flex-1 font-sans">{notification.message}</div>
            <button
              onClick={() => setNotification(null)}
              className="text-stone-400 hover:text-stone-600 p-1"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Main Navigation Tabs */}
        <div className="flex items-center gap-2 border-b border-stone-200 pb-2">
          <button
            onClick={() => setActiveTab('finance')}
            className={`px-4 py-2 rounded-xl font-mono text-xs uppercase tracking-wider font-bold transition-all flex items-center gap-2 ${
              activeTab === 'finance'
                ? 'bg-stone-900 text-white shadow-xs'
                : 'text-stone-600 hover:text-stone-900 hover:bg-stone-100'
            }`}
          >
            <Wallet className="w-3.5 h-3.5" />
            <span>Finance & Payouts</span>
          </button>
          <button
            onClick={() => setActiveTab('organization')}
            className={`px-4 py-2 rounded-xl font-mono text-xs uppercase tracking-wider font-bold transition-all flex items-center gap-2 ${
              activeTab === 'organization'
                ? 'bg-stone-900 text-white shadow-xs'
                : 'text-stone-600 hover:text-stone-900 hover:bg-stone-100'
            }`}
          >
            <Building2 className="w-3.5 h-3.5" />
            <span>Organization Profile</span>
          </button>
        </div>

        {activeTab === 'finance' ? (
          <div className="space-y-8 animate-fadeIn">
            {/* SECTION A: ACCOUNT CONNECTION STATUS */}
            <div className="bg-white rounded-2xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-stone-100">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-stone-100 flex items-center justify-center text-stone-700 shrink-0">
                    <ShieldCheck className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="font-display font-black text-lg text-stone-900 uppercase tracking-tight">
                      Stripe Express Account Status
                    </h2>
                    <p className="text-xs text-stone-600 font-sans mt-0.5">
                      Your identity and payout banking destination hosted securely by Stripe Connect.
                    </p>
                  </div>
                </div>

                <div>
                  {accountStatus?.connectionStatus === 'invalid_or_inaccessible' ? (
                    <button
                      onClick={() => handleStartOrContinueOnboarding({ reconnect: true })}
                      disabled={actionLoading === 'onboarding'}
                      className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-mono uppercase tracking-wider font-bold transition-all shadow-sm hover:shadow-md disabled:opacity-50"
                    >
                      {actionLoading === 'onboarding' ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          <span>Connecting...</span>
                        </>
                      ) : (
                        <>
                          <RotateCcw className="w-4 h-4" />
                          <span>Reconnect Stripe account</span>
                        </>
                      )}
                    </button>
                  ) : !accountStatus?.connected ? (
                    <button
                      onClick={() => handleStartOrContinueOnboarding()}
                      disabled={actionLoading === 'onboarding'}
                      className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase tracking-wider font-bold transition-all shadow-sm hover:shadow-md disabled:opacity-50"
                    >
                      {actionLoading === 'onboarding' ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          <span>Connecting...</span>
                        </>
                      ) : (
                        <>
                          <span>Start Stripe onboarding</span>
                          <ArrowUpRight className="w-4 h-4" />
                        </>
                      )}
                    </button>
                  ) : accountStatus.sellTickets.status === 'action_required' ||
                    accountStatus.transferBalance.status === 'action_required' ? (
                    <button
                      onClick={() => handleStartOrContinueOnboarding()}
                      disabled={actionLoading === 'onboarding'}
                      className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-mono uppercase tracking-wider font-bold transition-all shadow-sm hover:shadow-md disabled:opacity-50"
                    >
                      {actionLoading === 'onboarding' ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          <span>Loading...</span>
                        </>
                      ) : (
                        <>
                          <AlertTriangle className="w-4 h-4" />
                          <span>Continue onboarding</span>
                          <ArrowRight className="w-4 h-4" />
                        </>
                      )}
                    </button>
                  ) : (
                    <button
                      onClick={handleOpenStripeDashboard}
                      disabled={actionLoading === 'dashboard'}
                      className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-white hover:bg-stone-50 text-stone-900 border border-stone-300 text-xs font-mono uppercase tracking-wider font-bold transition-all shadow-2xs hover:shadow-xs disabled:opacity-50"
                    >
                      {actionLoading === 'dashboard' ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          <span>Opening...</span>
                        </>
                      ) : (
                        <>
                          <span>Manage account in Stripe</span>
                          <ExternalLink className="w-4 h-4 text-stone-500" />
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>

              {/* Status Notice Banners */}
              {accountStatus?.connectionStatus === 'invalid_or_inaccessible' && (
                <div className="p-4 bg-amber-50/90 border border-amber-200/90 rounded-xl flex items-start gap-3 text-amber-900 text-xs">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold block text-amber-950 font-mono text-[11px] uppercase">
                      Reconnection Required
                    </span>
                    <span>
                      Your connected Stripe Express account is no longer accessible. Reconnect your account to resume payouts and withdrawals.
                    </span>
                  </div>
                </div>
              )}

              {/* Capabilities Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div
                  className={`p-5 rounded-xl border transition-colors ${
                    accountStatus?.sellTickets.enabled
                      ? 'bg-emerald-50/50 border-emerald-200'
                      : accountStatus?.sellTickets.status === 'action_required'
                      ? 'bg-amber-50/50 border-amber-200'
                      : 'bg-stone-50 border-stone-200'
                  }`}
                >
                  <div className="flex items-center justify-between pb-3">
                    <span className="font-mono text-xs font-bold text-stone-900 uppercase tracking-wider">
                      Ticket Sales
                    </span>
                    {accountStatus?.sellTickets.enabled ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-mono font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                        <span>Enabled</span>
                      </span>
                    ) : accountStatus?.sellTickets.status === 'action_required' ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-mono font-bold bg-amber-100 text-amber-800 border border-amber-300">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                        <span>Action Required</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-mono font-bold bg-stone-200 text-stone-700">
                        <span>Disabled</span>
                      </span>
                    )}
                  </div>
                  <p className="text-xs font-sans text-stone-700 leading-relaxed">
                    {accountStatus
                      ? accountStatus.sellTickets.message
                      : 'Complete Stripe onboarding to start accepting attendee ticket orders.'}
                  </p>
                </div>

                <div
                  className={`p-5 rounded-xl border transition-colors ${
                    accountStatus?.transferBalance.enabled
                      ? 'bg-emerald-50/50 border-emerald-200'
                      : accountStatus?.transferBalance.status === 'action_required'
                      ? 'bg-amber-50/50 border-amber-200'
                      : 'bg-stone-50 border-stone-200'
                  }`}
                >
                  <div className="flex items-center justify-between pb-3">
                    <span className="font-mono text-xs font-bold text-stone-900 uppercase tracking-wider">
                      Transfers & Withdrawals
                    </span>
                    {accountStatus?.transferBalance.enabled ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-mono font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                        <span>Enabled</span>
                      </span>
                    ) : accountStatus?.transferBalance.status === 'action_required' ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-mono font-bold bg-amber-100 text-amber-800 border border-amber-300">
                        <Clock className="w-3.5 h-3.5 text-amber-600" />
                        <span>Action Required</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-mono font-bold bg-stone-200 text-stone-700">
                        <span>Disabled</span>
                      </span>
                    )}
                  </div>
                  <p className="text-xs font-sans text-stone-700 leading-relaxed">
                    {accountStatus
                      ? accountStatus.transferBalance.message
                      : 'Withdrawal capabilities activate as soon as identity & bank details verify.'}
                  </p>
                </div>
              </div>
            </div>

            {/* SECTION B: POSH-INSPIRED BALANCE CARDS */}
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-3">
                    <h2 className="font-display font-black text-lg text-stone-900 uppercase tracking-tight">
                      Organizer Balances
                    </h2>
                    <span className="px-2.5 py-0.5 rounded-full text-[11px] font-mono font-bold bg-stone-100 text-stone-700 border border-stone-200">
                      Lifetime: {formatCurrency(lifetimeCents)}
                    </span>
                  </div>
                  <p className="text-xs text-stone-600 font-sans mt-0.5">
                    Live financial ledger tracking funds from ticket sales through settlement and withdrawals.
                  </p>
                </div>

                {accountStatus?.connected && (
                  <button
                    onClick={() => {
                      setWithdrawAmountDollars(netAvailableCents > 0 ? (netAvailableCents / 100).toFixed(2) : '');
                      setWithdrawError(null);
                      setIsWithdrawModalOpen(true);
                    }}
                    disabled={netAvailableCents < 100 || !accountStatus?.transferBalance.enabled}
                    className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase tracking-wider font-bold transition-all shadow-sm hover:shadow-md disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Send className="w-4 h-4 text-emerald-400" />
                    <span>Request Withdrawal</span>
                  </button>
                )}
              </div>

              {/* Recoverable Liability Notice if any */}
              {recoverableCents > 0 && (
                <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-3 text-amber-900 text-xs">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <span className="font-bold block font-mono text-[11px] uppercase">
                      Post-Transfer Recoverable Balance: {formatCurrency(recoverableCents)}
                    </span>
                    <span>
                      An attendee refund or dispute occurred after a previous withdrawal. This amount is tracked as a liability and automatically offset against incoming available ticket sales.
                    </span>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {/* Available Balance Card */}
                <div className="bg-white rounded-2xl border border-stone-200/90 p-6 space-y-3 shadow-xs relative overflow-hidden">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono uppercase text-stone-500 font-bold tracking-wider">
                      Available Balance
                    </span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-50 text-emerald-800 border border-emerald-200 uppercase">
                      Eligible to Transfer
                    </span>
                  </div>

                  <div className="space-y-1">
                    <div className="font-display font-black text-3xl sm:text-4xl text-stone-900 tracking-tight">
                      {formatCurrency(availableCents)}
                    </div>
                    {recoverableCents > 0 && (
                      <div className="text-[11px] font-mono text-stone-500">
                        Net eligible: <strong className="text-emerald-700">{formatCurrency(netAvailableCents)}</strong>
                      </div>
                    )}
                  </div>

                  <p className="text-[11px] font-sans text-stone-500 leading-relaxed">
                    Funds cleared and ready for immediate withdrawal to your Stripe Express account.
                  </p>

                  <div className="pt-2">
                    <button
                      onClick={() => {
                        setWithdrawAmountDollars(netAvailableCents > 0 ? (netAvailableCents / 100).toFixed(2) : '');
                        setWithdrawError(null);
                        setIsWithdrawModalOpen(true);
                      }}
                      disabled={netAvailableCents < 100 || !accountStatus?.transferBalance.enabled}
                      className="w-full py-2 px-3 rounded-lg bg-[#FAF8F5] hover:bg-stone-100 border border-stone-200 text-stone-800 text-xs font-mono font-bold uppercase tracking-wider transition-colors disabled:opacity-40"
                    >
                      Withdraw Funds
                    </button>
                  </div>
                </div>

                {/* Pending Balance Card */}
                <div className="bg-white rounded-2xl border border-stone-200/90 p-6 space-y-3 shadow-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono uppercase text-stone-500 font-bold tracking-wider">
                      Pending Balance
                    </span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-50 text-amber-800 border border-amber-200 uppercase">
                      Settling
                    </span>
                  </div>

                  <div className="space-y-1">
                    <div className="font-display font-black text-3xl sm:text-4xl text-stone-700 tracking-tight">
                      {formatCurrency(pendingCents)}
                    </div>
                  </div>

                  <p className="text-[11px] font-sans text-stone-500 leading-relaxed">
                    Ticket revenue undergoing standard bank clearance. Moves to available upon settlement. Event completion is not required.
                  </p>
                </div>

                {/* Transferred Balance Card */}
                <div className="bg-white rounded-2xl border border-stone-200/90 p-6 space-y-3 shadow-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono uppercase text-stone-500 font-bold tracking-wider">
                      Transferred Balance
                    </span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-sky-50 text-sky-800 border border-sky-200 uppercase">
                      In Express
                    </span>
                  </div>

                  <div className="space-y-1">
                    <div className="font-display font-black text-3xl sm:text-4xl text-stone-700 tracking-tight">
                      {formatCurrency(transferredCents)}
                    </div>
                  </div>

                  <p className="text-[11px] font-sans text-stone-500 leading-relaxed">
                    Total funds moved from Outside.vip to your Stripe Express account for subsequent bank payout.
                  </p>
                </div>
              </div>
            </div>

            {/* SECTION C: WITHDRAWAL & TRANSFER HISTORY / AUDITABLE LEDGER */}
            <div className="bg-white rounded-2xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-stone-100">
                <div>
                  <h2 className="font-display font-black text-lg text-stone-900 uppercase tracking-tight">
                    Financial Activity & History
                  </h2>
                  <p className="text-xs text-stone-600 font-sans mt-0.5">
                    Track platform transfers, bank payouts, and comprehensive ledger transactions.
                  </p>
                </div>

                <div className="flex items-center gap-1 bg-stone-100 p-1 rounded-xl">
                  <button
                    onClick={() => setHistoryTab('transfers')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-mono uppercase font-bold transition-all ${
                      historyTab === 'transfers'
                        ? 'bg-white text-stone-900 shadow-2xs'
                        : 'text-stone-500 hover:text-stone-900'
                    }`}
                  >
                    Transfers ({transfers.length})
                  </button>
                  <button
                    onClick={() => setHistoryTab('payouts')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-mono uppercase font-bold transition-all ${
                      historyTab === 'payouts'
                        ? 'bg-white text-stone-900 shadow-2xs'
                        : 'text-stone-500 hover:text-stone-900'
                    }`}
                  >
                    Bank Payouts ({payouts.length})
                  </button>
                  <button
                    onClick={() => setHistoryTab('ledger')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-mono uppercase font-bold transition-all ${
                      historyTab === 'ledger'
                        ? 'bg-white text-stone-900 shadow-2xs'
                        : 'text-stone-500 hover:text-stone-900'
                    }`}
                  >
                    Ledger Activity
                  </button>
                </div>
              </div>

              {/* Sub-Tab 1: Platform-to-Connected Transfers */}
              {historyTab === 'transfers' && (
                <div className="space-y-4">
                  {transfers.length === 0 ? (
                    <div className="text-center py-12 space-y-2">
                      <Send className="w-8 h-8 text-stone-300 mx-auto" />
                      <div className="font-mono text-xs font-bold text-stone-700 uppercase">
                        No Transfers Yet
                      </div>
                      <p className="text-xs font-sans text-stone-500 max-w-sm mx-auto">
                        When you request a withdrawal or an admin initiates a transfer to your Stripe Express account, it will appear here.
                      </p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs font-sans">
                        <thead>
                          <tr className="border-b border-stone-200 text-stone-500 font-mono uppercase text-[10px]">
                            <th className="pb-3 font-bold">Transfer Ref</th>
                            <th className="pb-3 font-bold">Amount</th>
                            <th className="pb-3 font-bold">Status</th>
                            <th className="pb-3 font-bold">Type</th>
                            <th className="pb-3 font-bold">Date</th>
                            <th className="pb-3 font-bold">Stripe ID</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-stone-100 font-mono">
                          {transfers.map((t) => (
                            <tr key={t.id} className="hover:bg-stone-50/60 transition-colors">
                              <td className="py-3.5 font-bold text-stone-900">
                                {t.transferNumber}
                              </td>
                              <td className="py-3.5 font-bold text-emerald-700">
                                {formatCurrency(t.amountInCents, t.currency)}
                              </td>
                              <td className="py-3.5">
                                <span
                                  className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                                    t.status === 'SUCCEEDED'
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : t.status === 'PENDING'
                                      ? 'bg-amber-100 text-amber-800'
                                      : 'bg-rose-100 text-rose-800'
                                  }`}
                                >
                                  {t.status}
                                </span>
                                {t.failureMessage && (
                                  <span className="block text-[10px] text-rose-600 font-sans mt-0.5">
                                    {t.failureMessage}
                                  </span>
                                )}
                              </td>
                              <td className="py-3.5 text-stone-600 text-[11px]">
                                {t.sourceType === 'ADMIN_INITIATED' ? 'Admin Transfer' : 'Organizer Withdrawal'}
                              </td>
                              <td className="py-3.5 text-stone-600 font-sans">
                                {formatDate(t.createdAt)}
                              </td>
                              <td className="py-3.5 text-stone-500 text-[11px]">
                                {t.stripeTransferId ? (
                                  <span className="truncate max-w-[120px] inline-block" title={t.stripeTransferId}>
                                    {t.stripeTransferId}
                                  </span>
                                ) : (
                                  '—'
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Sub-Tab 2: Bank Payouts */}
              {historyTab === 'payouts' && (
                <div className="space-y-4">
                  {payouts.length === 0 ? (
                    <div className="text-center py-12 space-y-2">
                      <Landmark className="w-8 h-8 text-stone-300 mx-auto" />
                      <div className="font-mono text-xs font-bold text-stone-700 uppercase">
                        No Bank Payouts Recorded
                      </div>
                      <p className="text-xs font-sans text-stone-500 max-w-sm mx-auto">
                        Automatic or scheduled payouts from your Stripe Express account to your external bank account will be listed here.
                      </p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs font-sans">
                        <thead>
                          <tr className="border-b border-stone-200 text-stone-500 font-mono uppercase text-[10px]">
                            <th className="pb-3 font-bold">Amount</th>
                            <th className="pb-3 font-bold">Status</th>
                            <th className="pb-3 font-bold">Arrival Date</th>
                            <th className="pb-3 font-bold">Initiated</th>
                            <th className="pb-3 font-bold">Destination</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-stone-100 font-mono">
                          {payouts.map((p) => (
                            <tr key={p.id} className="hover:bg-stone-50/60 transition-colors">
                              <td className="py-3.5 font-bold text-stone-900">
                                {formatCurrency(p.amount, p.currency)}
                              </td>
                              <td className="py-3.5">
                                <span
                                  className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                                    p.status === 'paid'
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : p.status === 'in_transit' || p.status === 'pending'
                                      ? 'bg-blue-100 text-blue-800'
                                      : 'bg-rose-100 text-rose-800'
                                  }`}
                                >
                                  {p.status.replace('_', ' ')}
                                </span>
                                {p.failureMessage && (
                                  <span className="block text-[10px] text-rose-600 font-sans mt-0.5">
                                    {p.failureMessage}
                                  </span>
                                )}
                              </td>
                              <td className="py-3.5 text-stone-600 font-sans">
                                {formatDate(p.arrivalDate)}
                              </td>
                              <td className="py-3.5 text-stone-500 font-sans">
                                {formatDate(p.created)}
                              </td>
                              <td className="py-3.5 text-stone-600">
                                {p.destination || 'Bank Account'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Sub-Tab 3: Ledger Activity */}
              {historyTab === 'ledger' && (
                <div className="space-y-4">
                  {ledgerEntries.length === 0 ? (
                    <div className="text-center py-12 space-y-2">
                      <Receipt className="w-8 h-8 text-stone-300 mx-auto" />
                      <div className="font-mono text-xs font-bold text-stone-700 uppercase">
                        No Ledger Entries Yet
                      </div>
                      <p className="text-xs font-sans text-stone-500 max-w-sm mx-auto">
                        Every ticket sale, fee allocation, clearance, and refund is immutably recorded in the double-entry financial ledger.
                      </p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs font-sans">
                        <thead>
                          <tr className="border-b border-stone-200 text-stone-500 font-mono uppercase text-[10px]">
                            <th className="pb-3 font-bold">Date</th>
                            <th className="pb-3 font-bold">Type</th>
                            <th className="pb-3 font-bold">Description</th>
                            <th className="pb-3 font-bold">Amount</th>
                            <th className="pb-3 font-bold">Balance</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-stone-100 font-mono">
                          {ledgerEntries.map((e) => (
                            <tr key={e.id} className="hover:bg-stone-50/60 transition-colors">
                              <td className="py-3.5 text-stone-500 text-[11px]">
                                {formatDate(e.createdAt)}
                              </td>
                              <td className="py-3.5">
                                <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-stone-100 text-stone-800">
                                  {e.entryType.replace(/_/g, ' ')}
                                </span>
                              </td>
                              <td className="py-3.5 text-stone-700 font-sans max-w-sm">
                                {e.description}
                              </td>
                              <td
                                className={`py-3.5 font-bold ${
                                  e.amountInCents > 0
                                    ? 'text-emerald-700'
                                    : e.amountInCents < 0
                                    ? 'text-rose-600'
                                    : 'text-stone-500'
                                }`}
                              >
                                {e.amountInCents > 0 ? '+' : ''}
                                {formatCurrency(e.amountInCents, e.currency)}
                              </td>
                              <td className="py-3.5 text-[11px] text-stone-500">
                                {e.balanceType}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* SECTION D: PAYMENT METHODS (MASKED BANK ACCOUNTS) */}
            <div className="bg-white rounded-2xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-stone-100">
                <div>
                  <h2 className="font-display font-black text-lg text-stone-900 uppercase tracking-tight">
                    Bank Accounts & Payment Methods
                  </h2>
                  <p className="text-xs text-stone-600 font-sans mt-0.5">
                    External bank accounts configured on your Stripe Express account.
                  </p>
                </div>

                <div>
                  <button
                    onClick={accountStatus?.connected ? handleOpenStripeDashboard : () => handleStartOrContinueOnboarding()}
                    disabled={actionLoading !== null}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase tracking-wider font-bold transition-all shadow-2xs hover:shadow-xs disabled:opacity-50"
                  >
                    <Landmark className="w-4 h-4" />
                    <span>{accountStatus?.connected ? 'Manage bank in Stripe' : 'Add payment method'}</span>
                  </button>
                </div>
              </div>

              {accountStatus?.externalAccounts && accountStatus.externalAccounts.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {accountStatus.externalAccounts.map((ext) => (
                    <div
                      key={ext.id}
                      className="p-5 rounded-xl border border-stone-200 bg-[#FAF8F5] space-y-3 text-xs font-mono shadow-2xs"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Landmark className="w-4 h-4 text-stone-600" />
                          <span className="font-bold text-stone-900">{ext.bankName}</span>
                        </div>
                        {ext.isDefault && (
                          <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-300 text-[10px] uppercase font-bold">
                            Default
                          </span>
                        )}
                      </div>

                      <div className="space-y-1 text-stone-600">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-stone-500">Account Number:</span>
                          <span className="font-bold text-stone-900">•••• •••• •••• {ext.last4}</span>
                        </div>
                        {ext.routingNumber && (
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] text-stone-500">Routing Number:</span>
                            <span className="text-stone-700">{ext.routingNumber}</span>
                          </div>
                        )}
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-stone-500">Account Holder:</span>
                          <span className="text-stone-800 truncate max-w-[180px]">{ext.accountHolderName}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-6 rounded-xl border border-dashed border-stone-300 text-center space-y-2">
                  <Landmark className="w-6 h-6 text-stone-400 mx-auto" />
                  <div className="font-mono text-xs font-bold text-stone-700 uppercase">
                    No External Bank Account Linked
                  </div>
                  <p className="text-xs font-sans text-stone-500 max-w-md mx-auto">
                    Click the button above to link your payout bank account through Stripe&apos;s hosted onboarding.
                  </p>
                </div>
              )}
            </div>

            {/* SECTION E: DISPUTES & CHARGEBACKS */}
            <div className="bg-white rounded-2xl border border-stone-200/90 p-6 sm:p-8 space-y-5 shadow-xs">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-stone-100">
                <div>
                  <h2 className="font-display font-black text-lg text-stone-900 uppercase tracking-tight">
                    Disputes & Claims
                  </h2>
                  <p className="text-xs text-stone-600 font-sans mt-0.5">
                    Monitor attendee chargebacks and formal dispute resolution.
                  </p>
                </div>

                {accountStatus?.connected && (
                  <button
                    onClick={handleOpenStripeDashboard}
                    className="inline-flex items-center gap-1.5 text-xs font-mono font-bold text-stone-700 hover:text-stone-900 underline"
                  >
                    <span>View in Stripe</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {disputes.length === 0 ? (
                <div className="p-6 rounded-xl bg-stone-50 border border-stone-200 text-center space-y-1">
                  <CheckCircle2 className="w-6 h-6 text-emerald-600 mx-auto" />
                  <div className="font-mono text-xs font-bold text-stone-800 uppercase">
                    Zero Active Disputes
                  </div>
                  <p className="text-xs font-sans text-stone-500">
                    Your account has an excellent standing with zero chargebacks or contested transactions.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs font-sans">
                    <thead>
                      <tr className="border-b border-stone-200 text-stone-500 font-mono uppercase text-[10px]">
                        <th className="pb-3 font-bold">Dispute ID</th>
                        <th className="pb-3 font-bold">Amount</th>
                        <th className="pb-3 font-bold">Status</th>
                        <th className="pb-3 font-bold">Reason</th>
                        <th className="pb-3 font-bold">Opened</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-100 font-mono">
                      {disputes.map((d) => (
                        <tr key={d.id} className="hover:bg-stone-50/60 transition-colors">
                          <td className="py-3.5 font-bold text-stone-900">{d.id}</td>
                          <td className="py-3.5 font-bold text-rose-600">
                            {formatCurrency(d.amount, d.currency)}
                          </td>
                          <td className="py-3.5">
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-100 text-amber-800">
                              {d.status}
                            </span>
                          </td>
                          <td className="py-3.5 text-stone-700 font-sans">{d.reason}</td>
                          <td className="py-3.5 text-stone-500 font-sans">{formatDate(d.created)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* TAB 2: ORGANIZATION PROFILE */
          <div className="bg-white rounded-2xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs animate-fadeIn">
            <div className="flex items-center justify-between pb-4 border-b border-stone-100">
              <div>
                <h2 className="font-display font-black text-lg text-stone-900 uppercase tracking-tight">
                  Legal Organization Details
                </h2>
                <p className="text-xs text-stone-600 font-sans mt-0.5">
                  Business name and corporate identity used for invoicing and compliance.
                </p>
              </div>

              {!isEditingOrg && (
                <button
                  onClick={() => setIsEditingOrg(true)}
                  className="px-4 py-2 rounded-xl border border-stone-200 bg-stone-50 hover:bg-stone-100 text-xs font-mono uppercase font-bold text-stone-800 transition-colors"
                >
                  Edit Details
                </button>
              )}
            </div>

            {isEditingOrg ? (
              <form onSubmit={handleSaveOrgDetails} className="space-y-4 max-w-xl">
                <div>
                  <label className="block text-xs font-mono uppercase text-stone-600 mb-1 font-bold">
                    Organization Type
                  </label>
                  <select
                    value={orgForm.orgType}
                    onChange={(e) => setOrgForm({ ...orgForm, orgType: e.target.value as any })}
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-sans focus:outline-hidden focus:border-stone-900 bg-white"
                  >
                    <option value="Company">Company / LLC</option>
                    <option value="Individual">Sole Proprietorship / Individual</option>
                    <option value="NonProfit">Non-Profit</option>
                    <option value="Other">Other</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-mono uppercase text-stone-600 mb-1 font-bold">
                    Registered Business Name
                  </label>
                  <input
                    type="text"
                    required
                    value={orgForm.registeredName}
                    onChange={(e) => setOrgForm({ ...orgForm, registeredName: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-sans focus:outline-hidden focus:border-stone-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-mono uppercase text-stone-600 mb-1 font-bold">
                    Business Registration / Tax ID
                  </label>
                  <input
                    type="text"
                    value={orgForm.registrationNumber || ''}
                    onChange={(e) => setOrgForm({ ...orgForm, registrationNumber: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-sans focus:outline-hidden focus:border-stone-900"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-mono uppercase text-stone-600 mb-1 font-bold">
                      Contact Person
                    </label>
                    <input
                      type="text"
                      required
                      value={orgForm.contactPersonName}
                      onChange={(e) => setOrgForm({ ...orgForm, contactPersonName: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-sans focus:outline-hidden focus:border-stone-900"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-mono uppercase text-stone-600 mb-1 font-bold">
                      Contact Email
                    </label>
                    <input
                      type="email"
                      required
                      value={orgForm.contactEmail}
                      onChange={(e) => setOrgForm({ ...orgForm, contactEmail: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-sans focus:outline-hidden focus:border-stone-900"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-3">
                  <button
                    type="submit"
                    disabled={isSavingOrg}
                    className="px-5 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold transition-all disabled:opacity-50"
                  >
                    {isSavingOrg ? 'Saving...' : 'Save Organization'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsEditingOrg(false)}
                    className="px-4 py-2.5 rounded-xl border border-stone-200 text-stone-600 hover:text-stone-900 text-xs font-mono uppercase font-bold"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 text-xs font-mono">
                <div className="p-4 rounded-xl bg-[#FAF8F5] border border-stone-200 space-y-1">
                  <span className="text-[10px] uppercase text-stone-500 block">Registered Name</span>
                  <span className="font-bold text-stone-900 text-sm">
                    {payoutDetails?.registeredName || 'Not Set'}
                  </span>
                </div>

                <div className="p-4 rounded-xl bg-[#FAF8F5] border border-stone-200 space-y-1">
                  <span className="text-[10px] uppercase text-stone-500 block">Organization Type</span>
                  <span className="font-bold text-stone-900 text-sm">
                    {payoutDetails?.orgType || 'Company'}
                  </span>
                </div>

                <div className="p-4 rounded-xl bg-[#FAF8F5] border border-stone-200 space-y-1">
                  <span className="text-[10px] uppercase text-stone-500 block">Contact Person</span>
                  <span className="font-bold text-stone-900 text-sm">
                    {payoutDetails?.contactPersonName || 'Not Set'}
                  </span>
                </div>

                <div className="p-4 rounded-xl bg-[#FAF8F5] border border-stone-200 space-y-1">
                  <span className="text-[10px] uppercase text-stone-500 block">Contact Email</span>
                  <span className="font-bold text-stone-900 text-sm">
                    {payoutDetails?.contactEmail || 'Not Set'}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* WITHDRAWAL MODAL */}
      {isWithdrawModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-fadeIn">
          <div className="bg-white rounded-3xl border border-stone-200 max-w-md w-full p-6 sm:p-8 space-y-6 shadow-2xl relative">
            <button
              onClick={() => setIsWithdrawModalOpen(false)}
              className="absolute top-5 right-5 text-stone-400 hover:text-stone-700 p-1 rounded-full"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="space-y-1">
              <div className="flex items-center gap-2 text-stone-900 font-display font-black text-xl uppercase tracking-tight">
                <Send className="w-5 h-5 text-emerald-600" />
                <span>Request Withdrawal</span>
              </div>
              <p className="text-xs text-stone-600 font-sans">
                Transfer eligible earnings from your Outside.vip balance to your connected Stripe Express account.
              </p>
            </div>

            {withdrawError && (
              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <span>{withdrawError}</span>
              </div>
            )}

            <form onSubmit={handleWithdrawalSubmit} className="space-y-5">
              {/* Available balance indicator */}
              <div className="p-4 rounded-2xl bg-[#FAF8F5] border border-stone-200 flex items-center justify-between">
                <div>
                  <span className="text-[10px] font-mono uppercase text-stone-500 block font-bold">
                    Eligible Balance
                  </span>
                  <span className="font-display font-black text-2xl text-stone-900">
                    {formatCurrency(netAvailableCents)}
                  </span>
                </div>
                <span className="px-2.5 py-1 rounded text-[10px] font-mono font-bold bg-emerald-100 text-emerald-800 uppercase">
                  Available Now
                </span>
              </div>

              {/* Amount input */}
              <div className="space-y-2">
                <label className="block text-xs font-mono uppercase text-stone-700 font-bold">
                  Withdrawal Amount (USD)
                </label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-stone-400 font-mono font-bold text-sm">
                    $
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    min="1.00"
                    required
                    placeholder="0.00"
                    value={withdrawAmountDollars}
                    onChange={(e) => setWithdrawAmountDollars(e.target.value)}
                    className="w-full pl-8 pr-4 py-3 rounded-xl border border-stone-300 font-mono text-base font-bold text-stone-900 focus:outline-hidden focus:border-stone-900 focus:ring-1 focus:ring-stone-900"
                  />
                </div>

                {/* Quick-select amount buttons */}
                <div className="flex items-center gap-2 pt-1">
                  {[25, 50, 100].map((amt) => {
                    const cents = amt * 100;
                    if (cents > netAvailableCents) return null;
                    return (
                      <button
                        key={amt}
                        type="button"
                        onClick={() => setWithdrawAmountDollars(amt.toFixed(2))}
                        className="px-2.5 py-1 rounded-lg border border-stone-200 text-xs font-mono font-bold text-stone-700 hover:bg-stone-100"
                      >
                        ${amt}
                      </button>
                    );
                  })}
                  {netAvailableCents >= 100 && (
                    <button
                      type="button"
                      onClick={() => setWithdrawAmountDollars((netAvailableCents / 100).toFixed(2))}
                      className="px-2.5 py-1 rounded-lg border border-emerald-300 bg-emerald-50 text-xs font-mono font-bold text-emerald-800 hover:bg-emerald-100"
                    >
                      Full Balance
                    </button>
                  )}
                </div>
              </div>

              {/* Destination account confirmation */}
              <div className="space-y-1.5 p-3.5 rounded-xl border border-stone-200 bg-stone-50/70 text-xs font-mono">
                <span className="text-[10px] uppercase text-stone-500 font-bold block">
                  Destination Account
                </span>
                <div className="flex items-center gap-2 text-stone-800">
                  <Landmark className="w-4 h-4 text-stone-600 shrink-0" />
                  <span className="font-bold">
                    {accountStatus?.externalAccounts?.[0]
                      ? `${accountStatus.externalAccounts[0].bankName} (•••• ${accountStatus.externalAccounts[0].last4})`
                      : 'Connected Stripe Express Account'}
                  </span>
                </div>
              </div>

              {/* Optional reference notes */}
              <div className="space-y-1">
                <label className="block text-[11px] font-mono uppercase text-stone-500 font-bold">
                  Reference Note (Optional)
                </label>
                <input
                  type="text"
                  maxLength={100}
                  placeholder="e.g. Venue deposit payout"
                  value={withdrawNotes}
                  onChange={(e) => setWithdrawNotes(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs font-sans focus:outline-hidden focus:border-stone-900"
                />
              </div>

              {/* Action buttons */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsWithdrawModalOpen(false)}
                  className="px-4 py-2.5 rounded-xl border border-stone-200 text-stone-600 hover:text-stone-900 text-xs font-mono uppercase font-bold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingWithdrawal}
                  className="inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase tracking-wider font-bold transition-all disabled:opacity-50 shadow-sm"
                >
                  {isSubmittingWithdrawal ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Transferring...</span>
                    </>
                  ) : (
                    <>
                      <span>Confirm Withdrawal</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
export default FinanceOrganizationPage;
