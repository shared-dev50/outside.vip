import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

export interface PasswordInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  containerClassName?: string;
  toggleClassName?: string;
}

export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className = '', containerClassName = '', toggleClassName = '', disabled, ...props }, ref) => {
    const [isVisible, setIsVisible] = useState(false);

    const hasRightPadding = /\bpr-\d|\bpr-\[|\bpx-\d|\bp-\d/.test(className);
    const resolvedInputClassName = hasRightPadding ? className : `${className} pr-11`.trim();

    return (
      <div className={`relative ${containerClassName}`.trim()}>
        <input
          {...props}
          ref={ref}
          type={isVisible ? 'text' : 'password'}
          disabled={disabled}
          className={resolvedInputClassName}
        />
        <button
          type="button"
          onClick={() => setIsVisible((prev) => !prev)}
          disabled={disabled}
          aria-label={isVisible ? 'Hide password' : 'Show password'}
          aria-pressed={isVisible}
          title={isVisible ? 'Hide password' : 'Show password'}
          className={`absolute right-2.5 top-1/2 -translate-y-1/2 inline-flex items-center justify-center p-1.5 rounded-md text-stone-500 hover:text-stone-800 dark:text-[#958F86] dark:hover:text-[#F3F1EC] focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 dark:focus-visible:ring-[#F3F1EC] transition-colors disabled:opacity-50 disabled:pointer-events-none ${toggleClassName}`.trim()}
        >
          {isVisible ? (
            <EyeOff className="w-4 h-4" aria-hidden="true" />
          ) : (
            <Eye className="w-4 h-4" aria-hidden="true" />
          )}
        </button>
      </div>
    );
  }
);

PasswordInput.displayName = 'PasswordInput';
