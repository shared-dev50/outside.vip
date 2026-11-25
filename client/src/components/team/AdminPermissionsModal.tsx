import React, { useState, useEffect } from 'react';
import {
  Shield,
  ShieldAlert,
  AlertTriangle,
  X,
  Check,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { EventAdminPermissions } from '../../types';

export const DEFAULT_ADMIN_PERMISSIONS: Readonly<EventAdminPermissions> = Object.freeze({
  canEditDetails: false,
  canManageTickets: false,
  canViewOrders: false,
  canManageTeam: false,
  canManagePromotions: false,
  canViewAnalytics: false,
  canManageRefunds: false,
  canManagePayouts: false,
  canCancelEvent: false,
  canDeleteEvent: false,
});

export const SAFE_ADMIN_PERMISSIONS: Readonly<EventAdminPermissions> = Object.freeze({
  canEditDetails: true,
  canManageTickets: true,
  canViewOrders: true,
  canManageTeam: false,
  canManagePromotions: true,
  canViewAnalytics: true,
  canManageRefunds: false,
  canManagePayouts: false,
  canCancelEvent: false,
  canDeleteEvent: false,
});

export const DELEGABLE_ADMIN_PERMISSION_KEYS = [
  'canEditDetails',
  'canManageTickets',
  'canViewOrders',
  'canManageTeam',
  'canManagePromotions',
  'canViewAnalytics',
  'canCancelEvent',
  'canDeleteEvent',
] as const;

export type DelegableAdminPermissionKey = (typeof DELEGABLE_ADMIN_PERMISSION_KEYS)[number];

export const DELEGABLE_PERMISSION_COUNT = DELEGABLE_ADMIN_PERMISSION_KEYS.length;

export function countActiveDelegablePermissions(
  permissions?: Partial<EventAdminPermissions> | null
): number {
  if (!permissions) return 0;
  return DELEGABLE_ADMIN_PERMISSION_KEYS.filter((key) => Boolean(permissions[key])).length;
}

export function sanitizeAdminPermissions(
  raw?: Partial<EventAdminPermissions> | null
): EventAdminPermissions {
  return {
    ...DEFAULT_ADMIN_PERMISSIONS,
    ...(raw || {}),
    canManageRefunds: false,
    canManagePayouts: false,
  };
}

export function computeSafeDefaultsForCaller(
  callerIsOwner: boolean,
  callerPermissions?: Partial<EventAdminPermissions> | null
): EventAdminPermissions {
  const next: EventAdminPermissions = { ...DEFAULT_ADMIN_PERMISSIONS };
  for (const key of DELEGABLE_ADMIN_PERMISSION_KEYS) {
    const allowedByCaller = callerIsOwner || Boolean(callerPermissions?.[key]);
    next[key] = Boolean(SAFE_ADMIN_PERMISSIONS[key]) && allowedByCaller;
  }
  return next;
}

interface PermissionDefinition {
  key: DelegableAdminPermissionKey;
  label: string;
  description: string;
}

const EVENT_OPS_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'canEditDetails',
    label: 'Edit Event Details',
    description: 'Update title, description, venue location, schedule, and poster imagery.',
  },
  {
    key: 'canManageTickets',
    label: 'Manage Ticket Tiers',
    description: 'Create, adjust capacity, change pricing, and configure tier visibility.',
  },
  {
    key: 'canViewOrders',
    label: 'View Attendee Orders',
    description: 'Access event order history, buyer contact details, and revenue summaries.',
  },
];

const GROWTH_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'canManageTeam',
    label: 'Manage Event Team',
    description: 'Invite new Event Admins or Hosts, modify roles, and revoke team access.',
  },
  {
    key: 'canManagePromotions',
    label: 'Manage Promotional Links',
    description: 'Create and manage marketing campaign links, customize slugs, and assign host links.',
  },
  {
    key: 'canViewAnalytics',
    label: 'View Traffic Analytics',
    description: 'Inspect unique visitor counts, click logs, and campaign traffic performance.',
  },
];

const SENSITIVE_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'canCancelEvent',
    label: 'Cancel Event Occurrence',
    description: 'Cancel live or scheduled event occurrences and cancel their active waitlist entries.',
  },
  {
    key: 'canDeleteEvent',
    label: 'Delete Draft & Archive Event',
    description: 'Permanently delete draft events with no ticket sales and transition events to archived status.',
  },
];

export interface AdminPermissionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  initialPermissions?: Partial<EventAdminPermissions> | null;
  onSave: (permissions: EventAdminPermissions) => void | Promise<void>;
  isSaving?: boolean;
  callerIsOwner?: boolean;
  callerPermissions?: Partial<EventAdminPermissions> | null;
}

export const AdminPermissionsModal: React.FC<AdminPermissionsModalProps> = ({
  isOpen,
  onClose,
  title = 'Configure Admin Permissions',
  subtitle = 'Fine-tune event management permissions for this administrator. By default, all permissions are denied.',
  initialPermissions,
  onSave,
  isSaving = false,
  callerIsOwner,
  callerPermissions,
}) => {
  const isUnrestrictedCaller =
    callerIsOwner !== undefined ? callerIsOwner : callerPermissions === undefined;

  const canDelegateKey = (key: keyof EventAdminPermissions): boolean => {
    if (key === 'canManageRefunds' || key === 'canManagePayouts') {
      return false;
    }
    if (isUnrestrictedCaller) {
      return true;
    }
    return Boolean(callerPermissions?.[key]);
  };

  const buildInitialState = (): EventAdminPermissions => {
    const sanitized = sanitizeAdminPermissions(initialPermissions);
    if (isUnrestrictedCaller) {
      return sanitized;
    }
    const clamped: EventAdminPermissions = { ...DEFAULT_ADMIN_PERMISSIONS };
    for (const key of DELEGABLE_ADMIN_PERMISSION_KEYS) {
      clamped[key] = Boolean(sanitized[key]) && canDelegateKey(key);
    }
    return clamped;
  };

  const [permissions, setPermissions] = useState<EventAdminPermissions>(buildInitialState);

  useEffect(() => {
    if (isOpen) {
      setPermissions(buildInitialState());
    }
  }, [isOpen, initialPermissions, callerIsOwner, callerPermissions]);

  if (!isOpen) return null;

  const togglePermission = (key: keyof EventAdminPermissions) => {
    if (!canDelegateKey(key)) {
      return;
    }
    setPermissions((prev) => ({
      ...prev,
      [key]: !prev[key],
      canManageRefunds: false,
      canManagePayouts: false,
    }));
  };

  const applySafeDefaults = () => {
    setPermissions(computeSafeDefaultsForCaller(isUnrestrictedCaller, callerPermissions));
  };

  const clearAll = () => {
    setPermissions({ ...DEFAULT_ADMIN_PERMISSIONS });
  };

  const countActive = countActiveDelegablePermissions(permissions);
  const countSensitive = SENSITIVE_PERMISSIONS.filter((p) => permissions[p.key]).length;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload: EventAdminPermissions = { ...DEFAULT_ADMIN_PERMISSIONS };
    for (const key of DELEGABLE_ADMIN_PERMISSION_KEYS) {
      payload[key] = Boolean(permissions[key]) && canDelegateKey(key);
    }
    onSave(payload);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] bg-white rounded-2xl border border-stone-200 shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-stone-100 bg-[#FAF8F5]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-stone-900 text-white flex items-center justify-center shadow-2xs">
              <Shield className="w-4 h-4 text-amber-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-display font-bold text-base text-stone-900">
                  {title}
                </h3>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-stone-100 border border-stone-200 text-stone-700 font-semibold">
                  {`${countActive}/${DELEGABLE_PERMISSION_COUNT} Active`}
                </span>
                {countSensitive > 0 && (
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-rose-50 border border-rose-200 text-rose-700 font-semibold">
                    {countSensitive} Sensitive
                  </span>
                )}
              </div>
              <p className="text-[11px] text-stone-500 font-sans mt-0.5 line-clamp-1">
                {subtitle}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Quick presets bar */}
        <div className="px-6 py-2.5 bg-stone-50/80 border-b border-stone-100 flex items-center justify-between text-xs font-mono">
          <span className="text-stone-500 uppercase tracking-wider text-[10px] font-semibold">
            Permission Presets:
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={applySafeDefaults}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white hover:bg-stone-100 text-stone-700 border border-stone-200 shadow-2xs text-[11px] transition-colors cursor-pointer font-medium"
            >
              <Sparkles className="w-3 h-3 text-amber-500" />
              Safe Defaults
            </button>
            <button
              type="button"
              onClick={clearAll}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white hover:bg-stone-100 text-stone-700 border border-stone-200 shadow-2xs text-[11px] transition-colors cursor-pointer font-medium"
            >
              <RotateCcw className="w-3 h-3 text-stone-400" />
              Deny All
            </button>
          </div>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {!isUnrestrictedCaller && (
            <div className="p-3 rounded-xl bg-amber-50/70 border border-amber-200 text-[11px] text-amber-900 font-sans">
              <strong className="font-semibold">Delegation scope:</strong> You can only grant permissions that you currently hold for this event.
            </div>
          )}

          {/* Section 1: Event Operations */}
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-stone-100 pb-1.5">
              <h4 className="text-xs font-mono uppercase font-bold tracking-wider text-stone-700">
                1. Event Operations
              </h4>
              <span className="text-[10px] font-mono text-stone-400">Core Event Editing</span>
            </div>
            <div className="space-y-2">
              {EVENT_OPS_PERMISSIONS.map((perm) => {
                const isItemDisabled = !canDelegateKey(perm.key);
                return (
                  <label
                    key={perm.key}
                    className={`flex items-start gap-3 p-3 rounded-xl border transition-colors select-none ${
                      isItemDisabled
                        ? 'bg-stone-50/70 border-stone-200/80 opacity-65 cursor-not-allowed'
                        : permissions[perm.key]
                        ? 'bg-amber-50/30 border-amber-200/90 cursor-pointer'
                        : 'bg-white border-stone-200 hover:border-stone-300 cursor-pointer'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={permissions[perm.key]}
                      disabled={isItemDisabled}
                      onChange={() => togglePermission(perm.key)}
                      className={`mt-0.5 h-4 w-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900 accent-stone-900 ${
                        isItemDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-stone-900 block">
                          {perm.label}
                        </span>
                        {isItemDisabled && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono uppercase font-bold bg-stone-200/80 text-stone-700 border border-stone-300">
                            Outside Your Access
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-stone-500 leading-relaxed block mt-0.5">
                        {perm.description}
                      </span>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Section 2: Team & Growth Operations */}
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-stone-100 pb-1.5">
              <h4 className="text-xs font-mono uppercase font-bold tracking-wider text-stone-700">
                2. Team &amp; Promotional Operations
              </h4>
              <span className="text-[10px] font-mono text-stone-400">Marketing &amp; Team Staff</span>
            </div>
            <div className="space-y-2">
              {GROWTH_PERMISSIONS.map((perm) => {
                const isItemDisabled = !canDelegateKey(perm.key);
                return (
                  <label
                    key={perm.key}
                    className={`flex items-start gap-3 p-3 rounded-xl border transition-colors select-none ${
                      isItemDisabled
                        ? 'bg-stone-50/70 border-stone-200/80 opacity-65 cursor-not-allowed'
                        : permissions[perm.key]
                        ? 'bg-amber-50/30 border-amber-200/90 cursor-pointer'
                        : 'bg-white border-stone-200 hover:border-stone-300 cursor-pointer'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={permissions[perm.key]}
                      disabled={isItemDisabled}
                      onChange={() => togglePermission(perm.key)}
                      className={`mt-0.5 h-4 w-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900 accent-stone-900 ${
                        isItemDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-stone-900 block">
                          {perm.label}
                        </span>
                        {isItemDisabled && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono uppercase font-bold bg-stone-200/80 text-stone-700 border border-stone-300">
                            Outside Your Access
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-stone-500 leading-relaxed block mt-0.5">
                        {perm.description}
                      </span>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Section 3: Sensitive / High-Risk Operations */}
          <div className="space-y-3 p-4 rounded-xl bg-rose-50/50 border border-rose-200/80">
            <div className="flex items-start gap-2.5">
              <ShieldAlert className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <div className="flex items-center gap-2">
                  <h4 className="text-xs font-mono uppercase font-bold tracking-wider text-rose-900">
                    3. High-Risk Operations
                  </h4>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono uppercase font-bold bg-rose-100 text-rose-800 border border-rose-200">
                    Caution Required
                  </span>
                </div>
                <p className="text-[11px] text-rose-700 mt-0.5">
                  High-risk event lifecycle actions. Grant these permissions only to trusted co-organizers.
                </p>
              </div>
            </div>

            <div className="space-y-2 pt-1">
              {SENSITIVE_PERMISSIONS.map((perm) => {
                const isItemDisabled = !canDelegateKey(perm.key);
                return (
                  <label
                    key={perm.key}
                    className={`flex items-start gap-3 p-3 rounded-xl border transition-colors select-none ${
                      isItemDisabled
                        ? 'bg-stone-50/70 border-stone-200/80 opacity-65 cursor-not-allowed'
                        : permissions[perm.key]
                        ? 'bg-rose-100/60 border-rose-300 text-rose-950 font-medium cursor-pointer'
                        : 'bg-white/80 border-rose-200 hover:border-rose-300 cursor-pointer'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={permissions[perm.key]}
                      disabled={isItemDisabled}
                      onChange={() => togglePermission(perm.key)}
                      className={`mt-0.5 h-4 w-4 rounded border-rose-300 focus:ring-rose-500 accent-rose-600 ${
                        isItemDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-xs font-semibold ${isItemDisabled ? 'text-stone-700' : 'text-stone-900'}`}>
                          {perm.label}
                        </span>
                        {isItemDisabled && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono uppercase font-bold bg-stone-200/80 text-stone-700 border border-stone-300">
                            Outside Your Access
                          </span>
                        )}
                        {!isItemDisabled && permissions[perm.key] && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-mono text-rose-700 font-bold uppercase">
                            <AlertTriangle className="w-2.5 h-2.5" />
                            Enabled
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-stone-600 leading-relaxed block mt-0.5">
                        {perm.description}
                      </span>
                    </div>
                  </label>
                );
              })}
            </div>

            <div className="mt-2 pt-2.5 border-t border-rose-200/70 text-[11px] text-stone-600 space-y-1 font-sans">
              <p>Payouts and payout settings are managed by the event owner.</p>
              <p>Refund delegation is not currently available.</p>
            </div>
          </div>
        </form>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-stone-100 bg-[#FAF8F5] flex items-center justify-between">
          <span className="text-[11px] font-mono text-stone-500">
            {countActive === 0
              ? 'Deny-by-default (0 granted)'
              : `${countActive} of ${DELEGABLE_PERMISSION_COUNT} permission${countActive === 1 ? '' : 's'} granted`}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving}
              className="px-4 py-2 rounded-xl border border-stone-200 text-xs font-mono text-stone-600 hover:text-stone-900 hover:bg-stone-50 transition-colors shadow-2xs cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isSaving}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-semibold tracking-wider transition-colors shadow-xs disabled:opacity-50 cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              {isSaving ? 'Saving...' : 'Save Permissions'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

