import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Building2,
  Landmark,
  ShieldCheck,
  Info,
  Clock,
  CheckCircle2,
  HelpCircle,
  TrendingUp,
  X,
} from 'lucide-react';

export const FinanceOrganizationPage: React.FC = () => {

  useEffect(() => {
    const originalBg = document.body.style.backgroundColor;
    document.body.style.backgroundColor = '#FAF8F5';
    return () => {
      document.body.style.backgroundColor = originalBg;
    };
  }, []);

  const [activeTab, setActiveTab] = useState<'overview' | 'organization' | 'payouts' | 'settlement'>('overview');
  const [notification, setNotification] = useState<{ message: string; type: 'info' | 'success' } | null>(null);

  const handleSimulatedAction = (actionName: string) => {
    setNotification({
      type: 'info',
      message: `Static Presentation Preview: ${actionName} is disabled. Financial configuration and bank verification will be wired up in a future task.`,
    });
    setTimeout(() => setNotification(null), 6000);
  };

  return (
    <div className="relative min-h-screen bg-[#FAF8F5] text-stone-900 selection:bg-stone-900 selection:text-white pb-24 overflow-x-hidden">
      {/* Subtle Background Contours (Outside.vip visual language) */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden select-none" aria-hidden="true">
        <svg
          className="absolute -top-10 -left-10 w-96 h-96 opacity-20 text-[#D8D2C5]"
          viewBox="0 0 400 400"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        >
          <path d="M-50,100 C80,80 120,220 280,180 C360,160 420,240 450,300" />
          <path d="M-50,130 C90,110 140,240 300,200 C380,180 430,260 460,330" />
          <path d="M-50,160 C100,140 160,260 320,220 C400,200 440,280 470,360" />
        </svg>
      </div>

      {/* Floating Notification */}
      {notification && (
        <div className="fixed top-20 right-4 z-50 max-w-md animate-in slide-in-from-top-2">
          <div className="p-4 rounded-xl border bg-white/95 border-amber-300 text-stone-900 shadow-xl backdrop-blur-md flex items-start gap-3">
            <Info className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
            <div className="flex-1 text-xs text-stone-800 leading-relaxed font-sans">
              {notification.message}
            </div>
            <button onClick={() => setNotification(null)} className="text-stone-400 hover:text-stone-700">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Main Container */}
      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 space-y-6">
        {/* Navigation Breadcrumb & Back Link */}
        <div className="flex items-center gap-3">
          <Link
            to="/organizer"
            className="p-2 rounded-lg bg-white hover:bg-stone-100 text-stone-600 hover:text-stone-900 border border-stone-300 transition-colors shrink-0 shadow-2xs"
            title="Return to Organizer Dashboard"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="flex items-center gap-2 text-xs font-mono text-stone-500">
            <Link to="/organizer" className="hover:text-stone-900 transition-colors">
              Organizer
            </Link>
            <span>/</span>
            <span className="text-stone-900 font-bold">Finance & Organization</span>
          </div>
        </div>

        {/* Header Block */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-stone-200">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#EFECE5]/80 border border-[#DDD7CB]/70 text-[#7A7165] text-[10px] font-mono uppercase tracking-[0.22em] font-bold shadow-xs mb-2">
              <span className="w-1.5 h-1.5 rounded-full bg-[#96846D]" />
              <span>Financial Command & Settlement</span>
            </div>
            <h1 className="font-display font-black text-2xl sm:text-3xl text-stone-900 tracking-tight">
              Finance & Organization Settings
            </h1>
            <p className="text-xs sm:text-sm text-stone-600 mt-1 max-w-2xl font-sans">
              Separated financial identity, tax entity profile, and settlement bank configuration for Outside.vip event proceeds.
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <div className="px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-300 text-amber-800 text-[11px] font-mono font-bold flex items-center gap-1.5 shadow-2xs">
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              <span>Static Presentation Only</span>
            </div>
          </div>
        </div>

        {/* Static Presentation Notice Banner */}
        <div className="bg-amber-50/90 border border-amber-300 rounded-2xl p-5 shadow-xs">
          <div className="flex items-start gap-3.5">
            <div className="p-2 rounded-xl bg-amber-100 text-amber-800 shrink-0">
              <Info className="w-5 h-5" />
            </div>
            <div className="space-y-1 text-xs">
              <h4 className="font-mono font-bold uppercase tracking-wider text-amber-900">
                Notice on Settlement & Payout Setup (Preview Only)
              </h4>
              <p className="font-sans text-amber-900 leading-relaxed font-medium">
                This page is a static UI demonstration of the upcoming Outside.vip Finance & Organization module, separated from the event creation flow. Payout processing and live bank verification are not yet enabled on this page, and no real financial or banking credentials are submitted or stored.
              </p>
            </div>
          </div>
        </div>

        {/* Tab Controls */}
        <div className="flex items-center gap-2 border-b border-stone-200 pb-px overflow-x-auto">
          {[
            { id: 'overview', label: 'Overview & Status', icon: TrendingUp },
            { id: 'organization', label: 'Organisation Identity', icon: Building2 },
            { id: 'payouts', label: 'Payout Bank Settings', icon: Landmark },
            { id: 'settlement', label: 'Settlement Schedule', icon: Clock },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center gap-2 px-4 py-2.5 text-xs font-mono transition-colors whitespace-nowrap border-b-2 font-bold ${
                  isActive
                    ? 'border-stone-900 text-stone-900'
                    : 'border-transparent text-stone-500 hover:text-stone-800'
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? 'text-stone-900' : 'text-stone-400'}`} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Tab 1: Overview & Status */}
        {activeTab === 'overview' && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="md:col-span-2 space-y-6">
              {/* Account Overview Card */}
              <div className="bg-white rounded-2xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs">
                <div className="flex items-center justify-between pb-4 border-b border-stone-100">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-stone-100 flex items-center justify-center text-stone-800 font-bold font-display text-base">
                      SC
                    </div>
                    <div>
                      <h2 className="font-display font-black text-lg text-stone-900 uppercase">
                        Sol Collective Entertainment Ltd
                      </h2>
                      <span className="text-xs font-mono text-stone-500">
                        Registered Company • Kenya • ID: CPR/2024/189201
                      </span>
                    </div>
                  </div>
                  <span className="px-2.5 py-1 rounded text-[10px] font-mono uppercase bg-amber-50 border border-amber-300 text-amber-800 font-bold">
                    Setup Pending Verification
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs font-mono">
                  <div className="p-3.5 rounded-xl bg-[#FAF8F5] border border-stone-200 space-y-1">
                    <span className="text-[10px] uppercase text-stone-500 block">Default Settlement Currency</span>
                    <span className="font-bold text-stone-900 text-sm">USD ($)</span>
                  </div>
                  <div className="p-3.5 rounded-xl bg-[#FAF8F5] border border-stone-200 space-y-1">
                    <span className="text-[10px] uppercase text-stone-500 block">Active Settlement Bank</span>
                    <span className="font-bold text-stone-900 text-sm">Standard Chartered</span>
                  </div>
                  <div className="p-3.5 rounded-xl bg-[#FAF8F5] border border-stone-200 space-y-1">
                    <span className="text-[10px] uppercase text-stone-500 block">Masked Account</span>
                    <span className="font-bold text-stone-900 text-sm">•••• •••• •••• 4892</span>
                  </div>
                </div>

                <div className="space-y-3 pt-2">
                  <h3 className="font-mono text-xs uppercase tracking-wider font-bold text-stone-900">
                    Settlement Readiness Checklist
                  </h3>
                  <div className="space-y-2 text-xs font-sans">
                    <div className="flex items-center gap-2 text-emerald-800 bg-emerald-50/70 border border-emerald-200 p-2.5 rounded-lg font-mono">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      <span>Organisation legal details documented</span>
                    </div>
                    <div className="flex items-center gap-2 text-emerald-800 bg-emerald-50/70 border border-emerald-200 p-2.5 rounded-lg font-mono">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      <span>Authorised financial representative designated</span>
                    </div>
                    <div className="flex items-center gap-2 text-amber-800 bg-amber-50/70 border border-amber-200 p-2.5 rounded-lg font-mono">
                      <Clock className="w-4 h-4 text-amber-600 shrink-0" />
                      <span>Bank account automated verification pending deployment</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Fee Protection Summary */}
              <div className="bg-stone-900 text-white rounded-2xl p-6 sm:p-8 space-y-4 shadow-sm border border-stone-800">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
                    <ShieldCheck className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-mono font-bold text-sm uppercase tracking-wider text-white">
                      Outside.vip Zero-Deduction Organizer Guarantee
                    </h3>
                    <p className="text-xs text-stone-400 font-sans mt-0.5">
                      Platform fee (10%), service fee ($0.95/ticket), and Stripe processing fee (2.9% + $0.30) are paid entirely by buyers at checkout.
                    </p>
                  </div>
                </div>
                <div className="text-xs font-sans text-stone-300 leading-relaxed bg-stone-950/60 p-4 rounded-xl border border-stone-800">
                  Organizers receive 100% of their configured ticket price directly to their settlement bank account upon payout clearance. No hidden cuts, chargeback escrow deductions, or unexpected platform surcharges.
                </div>
              </div>
            </div>

            {/* Sidebar Quick Actions */}
            <div className="space-y-6">
              <div className="bg-white rounded-2xl border border-stone-200/90 p-6 space-y-4 shadow-xs text-xs font-mono">
                <h3 className="font-bold text-stone-900 uppercase tracking-wider">Quick Actions (Preview)</h3>
                <div className="space-y-2">
                  <button
                    onClick={() => handleSimulatedAction('Verify Bank Details')}
                    className="w-full py-2.5 px-3 rounded-lg bg-stone-900 hover:bg-black text-white text-xs font-semibold transition-colors flex items-center justify-center gap-2"
                  >
                    <Landmark className="w-4 h-4" />
                    <span>Verify Bank Details</span>
                  </button>
                  <button
                    onClick={() => handleSimulatedAction('Request Financial Audit Export')}
                    className="w-full py-2.5 px-3 rounded-lg bg-white hover:bg-stone-100 text-stone-800 border border-stone-300 text-xs font-semibold transition-colors"
                  >
                    Export Settlement Ledger
                  </button>
                </div>
              </div>

              <div className="bg-white rounded-2xl border border-stone-200/90 p-6 space-y-3 shadow-xs text-xs font-sans">
                <div className="flex items-center gap-2 font-mono font-bold text-stone-900 uppercase">
                  <HelpCircle className="w-4 h-4 text-stone-500" />
                  <span>Frequently Asked Questions</span>
                </div>
                <div className="space-y-2.5 text-stone-600 text-xs">
                  <div>
                    <strong className="text-stone-800 block">When will payouts be automated?</strong>
                    <span>Automated bank settlements are undergoing financial compliance review and will launch in an upcoming release.</span>
                  </div>
                  <div>
                    <strong className="text-stone-800 block">What currencies are supported?</strong>
                    <span>Outside.vip supports multi-currency settlement including USD, KES, EUR, and GBP.</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Organisation Identity */}
        {activeTab === 'organization' && (
          <div className="bg-white rounded-2xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs max-w-4xl">
            <div className="flex items-center gap-3 pb-4 border-b border-stone-100">
              <div className="w-9 h-9 rounded-lg bg-stone-100 flex items-center justify-center text-stone-700">
                <Building2 className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-display font-black text-lg text-stone-900 uppercase tracking-tight">
                  Organisation Identity & Tax Registration
                </h2>
                <p className="text-xs text-stone-500 font-sans mt-0.5">
                  Legal entity information for Outside.vip ticketing compliance and organizer identification.
                </p>
              </div>
            </div>

            <div className="space-y-4 pt-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                    Organisation Type
                  </label>
                  <input
                    type="text"
                    disabled
                    value="Registered Company (Ltd)"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-stone-100 border border-stone-200 text-stone-700 text-xs font-mono cursor-not-allowed"
                  />
                </div>
                <div>
                  <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                    Registered Name
                  </label>
                  <input
                    type="text"
                    disabled
                    value="Sol Collective Entertainment Ltd"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-stone-100 border border-stone-200 text-stone-700 text-xs font-mono cursor-not-allowed"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                    Registration / Certificate Number
                  </label>
                  <input
                    type="text"
                    disabled
                    value="CPR/2024/189201"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-stone-100 border border-stone-200 text-stone-700 text-xs font-mono cursor-not-allowed"
                  />
                </div>
                <div>
                  <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                    Country of Incorporation
                  </label>
                  <input
                    type="text"
                    disabled
                    value="Kenya"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-stone-100 border border-stone-200 text-stone-700 text-xs font-mono cursor-not-allowed"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                  Physical Office Address
                </label>
                <input
                  type="text"
                  disabled
                  value="Westlands Commercial Center, Block B, 4th Floor, Nairobi"
                  className="w-full px-3.5 py-2.5 rounded-lg bg-stone-100 border border-stone-200 text-stone-700 text-xs font-mono cursor-not-allowed"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-stone-100">
                <div>
                  <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                    Authorised Financial Representative
                  </label>
                  <input
                    type="text"
                    disabled
                    value="Sol Omondi"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-stone-100 border border-stone-200 text-stone-700 text-xs font-mono cursor-not-allowed"
                  />
                </div>
                <div>
                  <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                    Finance Contact Email
                  </label>
                  <input
                    type="email"
                    disabled
                    value="accounts@solcollective.ke"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-stone-100 border border-stone-200 text-stone-700 text-xs font-mono cursor-not-allowed"
                  />
                </div>
              </div>
            </div>

            <div className="pt-4 flex items-center justify-between border-t border-stone-100">
              <span className="text-[11px] font-mono text-stone-400">
                Static UI Preview • Inputs locked for review
              </span>
              <button
                type="button"
                onClick={() => handleSimulatedAction('Edit Organization Identity')}
                className="px-4 py-2 rounded-lg bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase tracking-wider font-bold transition-colors"
              >
                Edit Details (Preview)
              </button>
            </div>
          </div>
        )}

        {/* Tab 3: Payout Bank Settings */}
        {activeTab === 'payouts' && (
          <div className="bg-white rounded-2xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs max-w-4xl">
            <div className="flex items-center gap-3 pb-4 border-b border-stone-100">
              <div className="w-9 h-9 rounded-lg bg-stone-100 flex items-center justify-center text-stone-700">
                <Landmark className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-display font-black text-lg text-stone-900 uppercase tracking-tight">
                  Settlement & Payout Banking Account
                </h2>
                <p className="text-xs text-stone-500 font-sans mt-0.5">
                  Designated commercial bank account for ticket revenue disbursement.
                </p>
              </div>
            </div>

            {/* Saved Masked Banner */}
            <div className="p-4 rounded-xl bg-stone-50 border border-stone-200 text-xs font-mono flex items-center justify-between">
              <div className="flex items-center gap-2.5 text-stone-700">
                <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>Configured Settlement Account:</span>
                <span className="font-bold text-stone-900 font-mono">•••• •••• •••• 4892</span>
              </div>
              <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-300 text-[10px] uppercase font-bold">
                Placeholder
              </span>
            </div>

            <div className="space-y-4 pt-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                    Account Holder Name
                  </label>
                  <input
                    type="text"
                    disabled
                    value="Sol Collective Entertainment Ltd"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-stone-100 border border-stone-200 text-stone-700 text-xs font-mono cursor-not-allowed"
                  />
                </div>
                <div>
                  <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                    Bank Name
                  </label>
                  <input
                    type="text"
                    disabled
                    value="Standard Chartered Bank Kenya"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-stone-100 border border-stone-200 text-stone-700 text-xs font-mono cursor-not-allowed"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                    Bank Country
                  </label>
                  <input
                    type="text"
                    disabled
                    value="Kenya"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-stone-100 border border-stone-200 text-stone-700 text-xs font-mono cursor-not-allowed"
                  />
                </div>
                <div>
                  <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                    Settlement Currency
                  </label>
                  <input
                    type="text"
                    disabled
                    value="USD ($)"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-stone-100 border border-stone-200 text-stone-700 text-xs font-mono cursor-not-allowed"
                  />
                </div>
                <div>
                  <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                    SWIFT / BIC Code
                  </label>
                  <input
                    type="text"
                    disabled
                    value="SCBLKENX"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-stone-100 border border-stone-200 text-stone-700 text-xs font-mono cursor-not-allowed"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                <div>
                  <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                    Bank Branch
                  </label>
                  <input
                    type="text"
                    disabled
                    value="Westlands Branch (042)"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-stone-100 border border-stone-200 text-stone-700 text-xs font-mono cursor-not-allowed"
                  />
                </div>
                <div>
                  <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                    Clearing / Routing Code
                  </label>
                  <input
                    type="text"
                    disabled
                    value="02042"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-stone-100 border border-stone-200 text-stone-700 text-xs font-mono cursor-not-allowed"
                  />
                </div>
              </div>
            </div>

            <div className="pt-4 flex items-center justify-between border-t border-stone-100">
              <span className="text-[11px] font-mono text-stone-400">
                Outside.vip never stores unencrypted banking details.
              </span>
              <button
                type="button"
                onClick={() => handleSimulatedAction('Change Settlement Bank Account')}
                className="px-4 py-2 rounded-lg bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase tracking-wider font-bold transition-colors"
              >
                Change Bank (Preview)
              </button>
            </div>
          </div>
        )}

        {/* Tab 4: Settlement Schedule */}
        {activeTab === 'settlement' && (
          <div className="bg-white rounded-2xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs max-w-4xl">
            <div className="flex items-center gap-3 pb-4 border-b border-stone-100">
              <div className="w-9 h-9 rounded-lg bg-stone-100 flex items-center justify-center text-stone-700">
                <Clock className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-display font-black text-lg text-stone-900 uppercase tracking-tight">
                  Disbursement Cadence & Settlement Terms
                </h2>
                <p className="text-xs text-stone-500 font-sans mt-0.5">
                  Configured disbursement schedules and clearing rules.
                </p>
              </div>
            </div>

            <div className="space-y-4 text-xs font-mono">
              <div className="p-4 rounded-xl bg-[#FAF8F5] border border-stone-200 space-y-2">
                <span className="text-stone-900 font-bold uppercase block">Weekly Tuesday Settlement</span>
                <p className="font-sans text-stone-600 text-xs leading-relaxed">
                  Cleared ticket proceeds from completed orders are aggregated and transferred every Tuesday at 09:00 EAT directly to the configured settlement bank account.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-[#FAF8F5] border border-stone-200 space-y-2">
                <span className="text-stone-900 font-bold uppercase block">Minimum Payout Threshold</span>
                <p className="font-sans text-stone-600 text-xs leading-relaxed">
                  Default threshold: $50.00 USD. Balances below this threshold roll over to the subsequent weekly settlement window without fees.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-[#FAF8F5] border border-stone-200 space-y-2">
                <span className="text-stone-900 font-bold uppercase block">Post-Event Final Reconciliation</span>
                <p className="font-sans text-stone-600 text-xs leading-relaxed">
                  Final event reconciliation and door ticket settlement closes within 48 hours following conclusion of the experience.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default FinanceOrganizationPage;
