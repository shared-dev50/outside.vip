import React, { useState } from 'react';
import {
  Plus,
  Trash2,
  Ticket,
  ChevronDown,
  ChevronUp,
  EyeOff,
  PauseCircle,
  SlidersHorizontal,
} from 'lucide-react';
import { NumericInput } from '../common/NumericInput';
import { calculateTierEarnings, formatCents } from '../../lib/fees';
import { FormTicketTier, TicketTierFieldErrors } from '../../lib/ticketCreation';

interface TicketTierEditorSectionProps {
  ticketTiers: FormTicketTier[];
  timezone: string;
  tierErrors: Record<string, TicketTierFieldErrors>;
  onAddTier: () => void;
  onRemoveTier: (tempId: string) => void;
  onUpdateTier: (tempId: string, field: keyof FormTicketTier, value: any) => void;
}

export const TicketTierEditorSection: React.FC<TicketTierEditorSectionProps> = ({
  ticketTiers,
  timezone,
  tierErrors,
  onAddTier,
  onRemoveTier,
  onUpdateTier,
}) => {
  const [expandedAdditionalSettings, setExpandedAdditionalSettings] = useState<
    Record<string, boolean>
  >({});

  const toggleAdditionalSettings = (tempId: string) => {
    setExpandedAdditionalSettings((prev) => ({
      ...prev,
      [tempId]: !prev[tempId],
    }));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-display font-black text-stone-900 uppercase tracking-tight">
            Tickets & Capacity
          </h3>
          <p className="text-xs text-stone-500 font-sans">
            Create one or more ticket types with independent pricing, quantity, and availability rules. Enter 0 for free tickets.
          </p>
        </div>
        {ticketTiers.length > 0 && (
          <button
            type="button"
            data-testid="add-ticket-btn"
            onClick={onAddTier}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-stone-900 hover:bg-black text-white font-mono text-xs font-semibold uppercase tracking-wider transition-colors shadow-2xs shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Ticket</span>
          </button>
        )}
      </div>

      {ticketTiers.length === 0 ? (
        <div
          data-testid="empty-tickets-state"
          className="rounded-xl border-2 border-dashed border-stone-300 bg-[#FAF8F5] px-6 py-10 text-center space-y-4"
        >
          <div className="w-11 h-11 rounded-full bg-white border border-stone-200 text-stone-700 flex items-center justify-center mx-auto shadow-2xs">
            <Ticket className="w-5 h-5" />
          </div>
          <div className="space-y-1 max-w-md mx-auto">
            <h4 className="font-display font-black text-base text-stone-900 uppercase tracking-tight">
              No tickets added yet
            </h4>
            <p className="text-xs text-stone-600 font-sans leading-relaxed">
              Add at least one ticket to set your ticket name, price, and quantity before publishing your event.
            </p>
          </div>
          <div>
            <button
              type="button"
              data-testid="empty-add-ticket-btn"
              onClick={onAddTier}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-stone-900 hover:bg-black text-white font-mono text-xs font-semibold uppercase tracking-wider transition-colors shadow-2xs"
            >
              <Plus className="w-4 h-4" />
              <span>Add Ticket</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {ticketTiers.map((tier, idx) => {
            const errors = tierErrors[tier.tempId] || {};
            const hasEnteredPrice = tier.price !== '' && !isNaN(Number(tier.price));
            const tierEarnings = calculateTierEarnings(
              hasEnteredPrice ? Math.round(Number(tier.price) * 100) : 0,
              Math.max(0, Number(tier.totalCapacity) || 0)
            );
            const isAdditionalOpen = Boolean(expandedAdditionalSettings[tier.tempId]);
            const additionalPanelId = `additional-settings-${tier.tempId}`;

            return (
              <div
                key={tier.tempId}
                data-testid={`ticket-tier-card-${idx}`}
                className="rounded-xl border border-stone-200 bg-[#FAF8F5] p-5 space-y-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-stone-200 text-stone-700 font-mono text-xs font-bold flex items-center justify-center shrink-0">
                      {idx + 1}
                    </span>
                    <span className="font-display font-black text-base text-stone-900 uppercase">
                      {tier.name.trim() || `Ticket #${idx + 1}`}
                    </span>
                    {tier.soldQuantity && tier.soldQuantity > 0 ? (
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-emerald-50 text-emerald-700 border border-emerald-300 font-bold">
                        {tier.soldQuantity} Sold
                      </span>
                    ) : null}
                    {tier.status === 'SOLD_OUT' && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-stone-900 text-white font-bold">
                        Sold Out
                      </span>
                    )}
                    {tier.isHidden && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-stone-200 text-stone-800 border border-stone-300 font-bold">
                        <EyeOff className="w-3 h-3" />
                        <span>Hidden</span>
                      </span>
                    )}
                    {tier.salesDisabled && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-amber-50 text-amber-800 border border-amber-300 font-bold">
                        <PauseCircle className="w-3 h-3" />
                        <span>Sales Disabled</span>
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveTier(tier.tempId)}
                    className="p-1.5 rounded-md hover:bg-stone-200/80 text-stone-400 hover:text-rose-600 transition-colors"
                    title="Remove ticket"
                    aria-label={`Remove ${tier.name.trim() || `Ticket #${idx + 1}`}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                <div className="space-y-3">
                  <div>
                    <label
                      htmlFor={`tier-name-${tier.tempId}`}
                      className="block text-[11px] font-mono uppercase text-stone-700 font-bold mb-1"
                    >
                      Ticket Name <span className="text-rose-600">*</span>
                    </label>
                    <input
                      id={`tier-name-${tier.tempId}`}
                      type="text"
                      value={tier.name}
                      placeholder="e.g. Early Bird, VIP, Regular Admission"
                      onChange={(e) => onUpdateTier(tier.tempId, 'name', e.target.value)}
                      className={`w-full px-3 py-2 rounded-lg bg-white border text-stone-900 placeholder-stone-400 text-xs focus:outline-none ${
                        errors.name
                          ? 'border-rose-400 focus:border-rose-500'
                          : 'border-stone-300 focus:border-stone-900'
                      }`}
                    />
                    {errors.name && (
                      <p className="text-[11px] text-rose-600 font-medium mt-1">{errors.name}</p>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor={`tier-description-${tier.tempId}`}
                      className="block text-[11px] font-mono uppercase text-stone-700 font-bold mb-1"
                    >
                      Ticket Description <span className="text-stone-400 font-normal normal-case">(Optional)</span>
                    </label>
                    <input
                      id={`tier-description-${tier.tempId}`}
                      type="text"
                      value={tier.description}
                      placeholder="e.g. Includes venue entry and access to the main floor"
                      onChange={(e) => onUpdateTier(tier.tempId, 'description', e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-900 placeholder-stone-400 text-xs focus:outline-none focus:border-stone-900"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3.5 rounded-lg bg-stone-100/70 border border-stone-200">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[11px] font-mono uppercase text-stone-800 font-bold">
                        Gross Price (You Receive) <span className="text-rose-600">*</span>
                      </label>
                      <span className="text-[10px] text-stone-500 font-sans">Before fees</span>
                    </div>
                    <NumericInput
                      value={tier.price}
                      onChange={(val) => onUpdateTier(tier.tempId, 'price', val)}
                      min={0}
                      step={1}
                      allowDecimals={true}
                      decimalPlaces={2}
                      prefix="$"
                      placeholder="e.g. 25.00"
                      className={`w-full px-3 py-2 rounded-lg bg-white border text-stone-900 placeholder-stone-400 text-xs font-mono font-semibold focus:outline-none ${
                        errors.price
                          ? 'border-rose-400 focus:border-rose-500'
                          : 'border-stone-300 focus:border-stone-900'
                      }`}
                    />
                    {errors.price ? (
                      <p className="text-[11px] text-rose-600 font-medium mt-1">{errors.price}</p>
                    ) : (
                      <p className="text-[10px] text-stone-500 mt-1 leading-tight">
                        Amount you earn per ticket before fees. Enter 0 for a free ticket.
                      </p>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[11px] font-mono uppercase text-stone-800 font-bold">
                        Display Price (Customer Pays) <span className="text-rose-600">*</span>
                      </label>
                      <span className="text-[10px] text-stone-500 font-sans">All-in</span>
                    </div>
                    <NumericInput
                      value={tier.displayPrice}
                      onChange={(val) => onUpdateTier(tier.tempId, 'displayPrice', val)}
                      min={0}
                      step={1}
                      allowDecimals={true}
                      decimalPlaces={2}
                      prefix="$"
                      placeholder="e.g. 29.59"
                      className={`w-full px-3 py-2 rounded-lg bg-white border text-stone-900 placeholder-stone-400 text-xs font-mono font-semibold focus:outline-none ${
                        errors.price
                          ? 'border-rose-400 focus:border-rose-500'
                          : 'border-stone-300 focus:border-stone-900'
                      }`}
                    />
                    <p className="text-[10px] text-stone-500 mt-1 leading-tight">
                      All-in price advertised to fans (includes all platform & processing fees).
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] font-mono uppercase text-stone-700 font-bold mb-1">
                      Quantity / Capacity <span className="text-rose-600">*</span>
                    </label>
                    <NumericInput
                      value={tier.totalCapacity}
                      onChange={(val) => onUpdateTier(tier.tempId, 'totalCapacity', val)}
                      min={1}
                      step={10}
                      allowDecimals={false}
                      placeholder="e.g. 100"
                      className={`w-full px-3 py-2 rounded-lg bg-white border text-stone-900 placeholder-stone-400 text-xs font-mono focus:outline-none ${
                        errors.totalCapacity
                          ? 'border-rose-400 focus:border-rose-500'
                          : 'border-stone-300 focus:border-stone-900'
                      }`}
                    />
                    {errors.totalCapacity && (
                      <p className="text-[11px] text-rose-600 font-medium mt-1">
                        {errors.totalCapacity}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-[11px] font-mono uppercase text-stone-700 font-bold mb-1">
                      Min / Order
                    </label>
                    <NumericInput
                      value={tier.minPerOrder}
                      onChange={(val) => onUpdateTier(tier.tempId, 'minPerOrder', val)}
                      min={1}
                      step={1}
                      allowDecimals={false}
                      placeholder="e.g. 1"
                      className={`w-full px-3 py-2 rounded-lg bg-white border text-stone-900 placeholder-stone-400 text-xs font-mono focus:outline-none ${
                        errors.minPerOrder
                          ? 'border-rose-400 focus:border-rose-500'
                          : 'border-stone-300 focus:border-stone-900'
                      }`}
                    />
                    {errors.minPerOrder && (
                      <p className="text-[11px] text-rose-600 font-medium mt-1">
                        {errors.minPerOrder}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-[11px] font-mono uppercase text-stone-700 font-bold mb-1">
                      Max / Order
                    </label>
                    <NumericInput
                      value={tier.maxPerOrder}
                      onChange={(val) => onUpdateTier(tier.tempId, 'maxPerOrder', val)}
                      min={1}
                      step={1}
                      allowDecimals={false}
                      placeholder="e.g. 6"
                      className={`w-full px-3 py-2 rounded-lg bg-white border text-stone-900 placeholder-stone-400 text-xs font-mono focus:outline-none ${
                        errors.maxPerOrder
                          ? 'border-rose-400 focus:border-rose-500'
                          : 'border-stone-300 focus:border-stone-900'
                      }`}
                    />
                    {errors.maxPerOrder && (
                      <p className="text-[11px] text-rose-600 font-medium mt-1">
                        {errors.maxPerOrder}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-lg bg-white border border-stone-200">
                  <div className="space-y-0.5 max-w-md">
                    <div className="flex items-center gap-2">
                      <label className="text-xs font-mono uppercase font-bold text-stone-900 cursor-pointer">
                        Enable Waitlist
                      </label>
                      {tier.waitlistEnabled ? (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-amber-50 text-amber-800 border border-amber-300 font-bold">
                          Queue Active When Sold Out
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-stone-100 text-stone-500 font-bold">
                          Off
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-stone-500 leading-snug">
                      Automatically queue fans when sold out. If tickets become available through cancellations or capacity increases, purchase offers are automatically issued in FIFO order.
                    </p>
                    {tier.id && (tier.waitlistWaitingCount !== undefined || tier.waitlistOfferedCount !== undefined) ? (
                      <div className="flex items-center gap-3 pt-1 text-[11px] font-mono text-stone-700">
                        <span>Waiting: <strong className="text-stone-900">{tier.waitlistWaitingCount || 0}</strong></span>
                        <span>Active Offers: <strong className="text-amber-700">{tier.waitlistOfferedCount || 0}</strong></span>
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(tier.waitlistEnabled)}
                    aria-label="Enable Waitlist"
                    onClick={() => {
                      onUpdateTier(tier.tempId, 'waitlistEnabled', !tier.waitlistEnabled);
                    }}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      tier.waitlistEnabled ? 'bg-amber-600' : 'bg-stone-300'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        tier.waitlistEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                <div className="p-3.5 rounded-lg bg-white border border-stone-200 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-0.5 max-w-md">
                      <div className="flex items-center gap-2">
                        <label className="text-xs font-mono uppercase font-bold text-stone-900 cursor-pointer">
                          Limit Ticket Sales Period
                        </label>
                        {tier.hasSalesPeriod ? (
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-emerald-50 text-emerald-800 border border-emerald-300 font-bold">
                            Active Window
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-stone-100 text-stone-500 font-bold">
                            Open Sales
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-stone-500 leading-snug">
                        Restrict when fans can purchase this ticket. Before the start time or after the end time, this tier will not be available for checkout.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={Boolean(tier.hasSalesPeriod)}
                      aria-label="Limit Ticket Sales Period"
                      onClick={() => {
                        onUpdateTier(tier.tempId, 'hasSalesPeriod', !tier.hasSalesPeriod);
                      }}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                        tier.hasSalesPeriod ? 'bg-stone-900' : 'bg-stone-300'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          tier.hasSalesPeriod ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>

                  {tier.hasSalesPeriod && (
                    <div className="pt-2 border-t border-stone-100 space-y-2">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[10px] font-mono uppercase text-stone-700 font-bold mb-1">
                            Sales Start Date & Time
                          </label>
                          <input
                            type="datetime-local"
                            value={tier.salesStartAt || ''}
                            onChange={(e) => onUpdateTier(tier.tempId, 'salesStartAt', e.target.value)}
                            className="w-full px-3 py-2 rounded-lg bg-stone-50 border border-stone-300 text-stone-900 text-xs focus:outline-none focus:border-stone-900"
                          />
                          <span className="text-[10px] text-stone-400 mt-0.5 block">
                            Before this time, ticket cannot be purchased.
                          </span>
                        </div>
                        <div>
                          <label className="block text-[10px] font-mono uppercase text-stone-700 font-bold mb-1">
                            Sales End Date & Time
                          </label>
                          <input
                            type="datetime-local"
                            value={tier.salesEndAt || ''}
                            onChange={(e) => onUpdateTier(tier.tempId, 'salesEndAt', e.target.value)}
                            className="w-full px-3 py-2 rounded-lg bg-stone-50 border border-stone-300 text-stone-900 text-xs focus:outline-none focus:border-stone-900"
                          />
                          <span className="text-[10px] text-stone-400 mt-0.5 block">
                            After this time, sales will close automatically.
                          </span>
                        </div>
                      </div>
                      {errors.salesPeriod && (
                        <p className="text-[11px] text-rose-600 font-medium">{errors.salesPeriod}</p>
                      )}
                      <div className="text-[10px] font-mono text-stone-500">
                        Timezone: <strong>{timezone}</strong>
                      </div>
                    </div>
                  )}
                </div>

                <div className="p-3.5 rounded-lg bg-white border border-stone-200 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-0.5 max-w-md">
                      <div className="flex items-center gap-2">
                        <label className="text-xs font-mono uppercase font-bold text-stone-900 cursor-pointer">
                          Limit Ticket Validity
                        </label>
                        {tier.hasTicketValidity ? (
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-indigo-50 text-indigo-800 border border-indigo-300 font-bold">
                            Entry Restricted
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-stone-100 text-stone-500 font-bold">
                            Full Event Window
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-stone-500 leading-snug">
                        Restrict when an already-purchased ticket can be used for door entry. Gate scanners will reject passes scanned outside this designated window.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={Boolean(tier.hasTicketValidity)}
                      aria-label="Limit Ticket Validity"
                      onClick={() => {
                        onUpdateTier(tier.tempId, 'hasTicketValidity', !tier.hasTicketValidity);
                      }}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                        tier.hasTicketValidity ? 'bg-stone-900' : 'bg-stone-300'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          tier.hasTicketValidity ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>

                  {tier.hasTicketValidity && (
                    <div className="pt-2 border-t border-stone-100 space-y-2">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[10px] font-mono uppercase text-stone-700 font-bold mb-1">
                            Validity Start Date & Time
                          </label>
                          <input
                            type="datetime-local"
                            value={tier.validityStartAt || ''}
                            onChange={(e) => onUpdateTier(tier.tempId, 'validityStartAt', e.target.value)}
                            className="w-full px-3 py-2 rounded-lg bg-stone-50 border border-stone-300 text-stone-900 text-xs focus:outline-none focus:border-stone-900"
                          />
                          <span className="text-[10px] text-stone-400 mt-0.5 block">
                            Pass cannot be scanned before this time.
                          </span>
                        </div>
                        <div>
                          <label className="block text-[10px] font-mono uppercase text-stone-700 font-bold mb-1">
                            Validity End Date & Time
                          </label>
                          <input
                            type="datetime-local"
                            value={tier.validityEndAt || ''}
                            onChange={(e) => onUpdateTier(tier.tempId, 'validityEndAt', e.target.value)}
                            className="w-full px-3 py-2 rounded-lg bg-stone-50 border border-stone-300 text-stone-900 text-xs focus:outline-none focus:border-stone-900"
                          />
                          <span className="text-[10px] text-stone-400 mt-0.5 block">
                            Pass expires for entry after this time.
                          </span>
                        </div>
                      </div>
                      {errors.validityPeriod && (
                        <p className="text-[11px] text-rose-600 font-medium">
                          {errors.validityPeriod}
                        </p>
                      )}
                      <div className="text-[10px] font-mono text-stone-500">
                        Timezone: <strong>{timezone}</strong>. Appears on attendee passes and ticket PDFs.
                      </div>
                    </div>
                  )}
                </div>

                {/* Collapsible Additional settings section (collapsed by default) */}
                <div className="rounded-lg bg-white border border-stone-200 overflow-hidden">
                  <button
                    type="button"
                    data-testid={`additional-settings-toggle-${idx}`}
                    aria-expanded={isAdditionalOpen}
                    aria-controls={additionalPanelId}
                    onClick={() => toggleAdditionalSettings(tier.tempId)}
                    className="w-full px-3.5 py-3 flex items-center justify-between gap-3 text-left hover:bg-stone-50 transition-colors cursor-pointer"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <SlidersHorizontal className="w-3.5 h-3.5 text-stone-600 shrink-0" />
                      <span className="text-xs font-mono uppercase font-bold text-stone-900">
                        Additional settings
                      </span>
                      {!isAdditionalOpen && (tier.isHidden || tier.salesDisabled) && (
                        <span className="text-[10px] font-mono text-stone-500">
                          (
                          {[
                            tier.isHidden ? 'Hidden' : null,
                            tier.salesDisabled ? 'Sales disabled' : null,
                          ]
                            .filter(Boolean)
                            .join(', ')}
                          )
                        </span>
                      )}
                    </div>
                    {isAdditionalOpen ? (
                      <ChevronUp className="w-4 h-4 text-stone-500 shrink-0" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-stone-500 shrink-0" />
                    )}
                  </button>

                  {isAdditionalOpen && (
                    <div
                      id={additionalPanelId}
                      data-testid={`additional-settings-panel-${idx}`}
                      className="px-3.5 pb-3.5 pt-2 border-t border-stone-100 space-y-3"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg bg-[#FAF8F5] border border-stone-200/80">
                        <div className="space-y-0.5 max-w-md">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-mono uppercase font-bold text-stone-900">
                              Hide ticket
                            </span>
                            {tier.isHidden ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-stone-900 text-white font-bold">
                                Hidden
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-stone-200/70 text-stone-600 font-bold">
                                Visible
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-stone-500 leading-snug">
                            Exclude this ticket from the public event page and discovery listings. Hidden tickets cannot be purchased publicly.
                          </p>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          data-testid={`hide-ticket-switch-${idx}`}
                          aria-checked={Boolean(tier.isHidden)}
                          aria-label="Hide ticket"
                          onClick={() => onUpdateTier(tier.tempId, 'isHidden', !tier.isHidden)}
                          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                            tier.isHidden ? 'bg-stone-900' : 'bg-stone-300'
                          }`}
                        >
                          <span
                            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                              tier.isHidden ? 'translate-x-5' : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </div>

                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg bg-[#FAF8F5] border border-stone-200/80">
                        <div className="space-y-0.5 max-w-md">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-mono uppercase font-bold text-stone-900">
                              Disable ticket sales
                            </span>
                            {tier.salesDisabled ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-amber-100 text-amber-900 border border-amber-300 font-bold">
                                Sales Paused
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-stone-200/70 text-stone-600 font-bold">
                                On Sale
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-stone-500 leading-snug">
                            Stop new purchases for this ticket and display it as unavailable. Already-issued tickets remain valid for entry.
                          </p>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          data-testid={`disable-sales-switch-${idx}`}
                          aria-checked={Boolean(tier.salesDisabled)}
                          aria-label="Disable ticket sales"
                          onClick={() =>
                            onUpdateTier(tier.tempId, 'salesDisabled', !tier.salesDisabled)
                          }
                          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                            tier.salesDisabled ? 'bg-amber-600' : 'bg-stone-300'
                          }`}
                        >
                          <span
                            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                              tier.salesDisabled ? 'translate-x-5' : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="p-3.5 rounded-lg bg-white border border-stone-200 text-[11px] font-mono space-y-1.5">
                  <div className="flex items-center justify-between text-stone-700">
                    <span>Gross Ticket Earnings:</span>
                    <span className="font-bold text-emerald-600">
                      {hasEnteredPrice ? formatCents(tierEarnings.organizerEarningsInCents) : '—'}
                    </span>
                  </div>
                  {!hasEnteredPrice ? (
                    <div className="text-[10px] text-stone-400 italic">
                      Enter a ticket price (or 0 for free) to preview fees and projected earnings.
                    </div>
                  ) : tierEarnings.organizerEarningsInCents > 0 ? (
                    <>
                      <div className="flex items-center justify-between text-stone-500 text-[10px]">
                        <span>· Platform Fee (10%):</span>
                        <span>{formatCents(tierEarnings.platformFeeInCents)}</span>
                      </div>
                      <div className="flex items-center justify-between text-stone-500 text-[10px]">
                        <span>· Fixed Service Fee ($0.95):</span>
                        <span>{formatCents(tierEarnings.serviceFeeInCents)}</span>
                      </div>
                      <div className="flex items-center justify-between text-stone-500 text-[10px]">
                        <span>· Payment Processing (est. 2.9% + $0.30):</span>
                        <span>{formatCents(tierEarnings.processingFeeInCents)}</span>
                      </div>
                      <div className="flex items-center justify-between text-stone-600 font-semibold pt-0.5">
                        <span>Combined Service Fee:</span>
                        <span>{formatCents(tierEarnings.customerServiceFeeInCents)}</span>
                      </div>
                    </>
                  ) : (
                    <div className="text-[10px] text-stone-400 italic">
                      Free ticket tier — no platform or processing fees charged.
                    </div>
                  )}
                  <div className="flex items-center justify-between pt-1.5 border-t border-stone-200 text-stone-900 font-bold">
                    <span>All-In Display Price (Fan Pays):</span>
                    <span className="font-extrabold text-stone-900">
                      {!hasEnteredPrice
                        ? '—'
                        : tierEarnings.displayPriceInCents === 0
                        ? 'Free ($0.00)'
                        : formatCents(tierEarnings.displayPriceInCents)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between pt-1 border-t border-stone-100 text-stone-900 font-bold">
                    <span>Projected Sold Out Earnings ({tierEarnings.capacity} tickets):</span>
                    <span className="text-emerald-700 font-extrabold">
                      {hasEnteredPrice ? formatCents(tierEarnings.projectedEarningsInCents) : '—'}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
