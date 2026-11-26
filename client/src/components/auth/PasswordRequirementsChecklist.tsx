import React from 'react';
import { Check } from 'lucide-react';
import {
  PASSWORD_REQUIREMENT_RULES,
  evaluatePasswordPolicy,
} from '../../lib/passwordPolicy';

interface PasswordRequirementsChecklistProps {
  password: string;
}

export const PasswordRequirementsChecklist: React.FC<PasswordRequirementsChecklistProps> = ({
  password,
}) => {
  const { checks } = evaluatePasswordPolicy(password);
  const hasTyped = password.length > 0;

  return (
    <div
      aria-label="Password requirements"
      className="mt-2 rounded-lg bg-[#FAF8F5] dark:bg-[#1A1D27] border border-stone-200/80 dark:border-[#2A2F3D] px-3 py-2.5 space-y-1.5"
    >
      <div className="text-[10px] font-mono uppercase tracking-wider text-stone-500 dark:text-[#958F86] font-semibold">
        Password requirements
      </div>
      <ul className="space-y-1">
        {PASSWORD_REQUIREMENT_RULES.map((rule) => {
          const met = checks[rule.key];
          return (
            <li
              key={rule.key}
              className={`flex items-center gap-1.5 text-[11px] font-sans transition-colors ${
                met
                  ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                  : hasTyped
                    ? 'text-stone-600 dark:text-[#CBC6BC]'
                    : 'text-stone-500 dark:text-[#958F86]'
              }`}
            >
              <span
                aria-hidden="true"
                className={`w-3.5 h-3.5 rounded-full inline-flex items-center justify-center shrink-0 border ${
                  met
                    ? 'bg-emerald-100 dark:bg-emerald-950/60 border-emerald-400 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400'
                    : 'border-stone-300 dark:border-[#3A4154] text-transparent'
                }`}
              >
                <Check className="w-2.5 h-2.5" />
              </span>
              <span>{rule.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
