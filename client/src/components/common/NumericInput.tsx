import React, { useState, useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { Minus, Plus, ChevronUp, ChevronDown } from 'lucide-react';

export interface NumericInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max' | 'step' | 'prefix'> {
  value: number | string | null | undefined;
  onChange: (value: number | '', rawString: string) => void;
  min?: number;
  max?: number;
  step?: number;
  allowDecimals?: boolean;
  decimalPlaces?: number;
  allowNegative?: boolean;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  showSteppers?: boolean;
  stepperType?: 'buttons' | 'stacked' | 'none';
  stepperAriaLabel?: {
    increment?: string;
    decrement?: string;
  };
  clampOnBlur?: boolean;
  emptyValueFallback?: number | null;
  formatOnBlur?: boolean;
  wrapperClassName?: string;
}

/**
 * Precision-aware stepper helper to avoid IEEE floating-point arithmetic errors (e.g. 0.1 + 0.2 = 0.30000000000000004)
 */
export function stepNumber(current: number, stepDelta: number, precision: number = 0): number {
  const factor = Math.pow(10, Math.max(0, precision));
  return Math.round((current + stepDelta) * factor) / factor;
}

/**
 * Pure parsing function for numeric inputs with support for decimal points, signs, and character restrictions.
 */
export function parseNumericString(
  raw: string,
  options: {
    allowDecimals?: boolean;
    decimalPlaces?: number;
    allowNegative?: boolean;
  } = {}
): { cleanString: string; numericValue: number | '' } {
  const { allowDecimals = true, decimalPlaces, allowNegative = false } = options;

  if (raw === '' || raw === null || raw === undefined) {
    return { cleanString: '', numericValue: '' };
  }

  // Remove commas, spaces, currency symbols if pasted
  let s = String(raw).replace(/[,\s$]/g, '');

  // Handle negative sign
  let isNegative = false;
  if (allowNegative && s.startsWith('-')) {
    isNegative = true;
    s = s.slice(1);
  } else {
    s = s.replace(/-/g, '');
  }

  if (allowDecimals) {
    const parts = s.split('.');
    let integerPart = parts[0].replace(/\D/g, '');
    let decimalPart = parts.length > 1 ? parts.slice(1).join('').replace(/\D/g, '') : null;

    if (decimalPlaces !== undefined && decimalPart !== null) {
      decimalPart = decimalPart.slice(0, decimalPlaces);
    }

    let cleanString = isNegative ? '-' : '';
    if (integerPart === '' && decimalPart !== null) {
      cleanString += `.${decimalPart}`;
    } else {
      cleanString += integerPart;
      if (decimalPart !== null) {
        cleanString += `.${decimalPart}`;
      }
    }

    if (cleanString === '' || cleanString === '-' || cleanString === '.') {
      return { cleanString, numericValue: '' };
    }

    const num = parseFloat(cleanString);
    return {
      cleanString,
      numericValue: isNaN(num) ? '' : num,
    };
  } else {
    const integerPart = s.replace(/\D/g, '');
    const cleanString = (isNegative ? '-' : '') + integerPart;

    if (cleanString === '' || cleanString === '-') {
      return { cleanString, numericValue: '' };
    }

    const num = parseInt(cleanString, 10);
    return {
      cleanString,
      numericValue: isNaN(num) ? '' : num,
    };
  }
}

export const NumericInput = forwardRef<HTMLInputElement, NumericInputProps>(
  (
    {
      value,
      onChange,
      min,
      max,
      step = 1,
      allowDecimals = false,
      decimalPlaces,
      allowNegative = false,
      prefix,
      suffix,
      showSteppers = false,
      stepperType = 'none',
      stepperAriaLabel,
      clampOnBlur = true,
      emptyValueFallback,
      formatOnBlur = false,
      wrapperClassName = '',
      className = '',
      disabled,
      readOnly,
      placeholder,
      onBlur,
      onFocus,
      onKeyDown,
      ...restInputProps
    },
    ref
  ) => {
    const internalInputRef = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => internalInputRef.current as HTMLInputElement);

    const [isFocused, setIsFocused] = useState(false);

    // Initial string value based on prop
    const formatInitialValue = (val: number | string | null | undefined): string => {
      if (val === '' || val === null || val === undefined) return '';
      return String(val);
    };

    const [textValue, setTextValue] = useState<string>(() => formatInitialValue(value));

    // Synchronize textValue when external prop changes
    useEffect(() => {
      if (!isFocused) {
        setTextValue(formatInitialValue(value));
      } else {
        // If focused and external value changed to a distinct number/empty (e.g. preset button or reset)
        const currentParsed = textValue === '' ? '' : parseFloat(textValue);
        const propParsed =
          value === '' || value === null || value === undefined
            ? ''
            : typeof value === 'number'
            ? value
            : parseFloat(String(value));

        if (currentParsed !== propParsed && (propParsed === '' || !isNaN(Number(propParsed)))) {
          setTextValue(formatInitialValue(value));
        }
      }
    }, [value, isFocused]);

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      let raw = e.target.value;

      // Smart zero replacement:
      // If previous display was "0" and user typed a digit 1-9 (resulting in "05", etc.),
      // replace "0" with that digit so the user does not have to select/delete the zero first.
      if (textValue === '0' && raw.length === 2 && raw.startsWith('0') && raw[1] !== '.') {
        raw = raw[1];
      }

      const { cleanString, numericValue } = parseNumericString(raw, {
        allowDecimals,
        decimalPlaces,
        allowNegative,
      });

      setTextValue(cleanString);
      onChange(numericValue, cleanString);
    };

    const handleStep = (direction: 'up' | 'down') => {
      if (disabled || readOnly) return;

      const effectiveStep = step || 1;
      const stepDelta = direction === 'up' ? effectiveStep : -effectiveStep;
      const precision = allowDecimals ? (decimalPlaces ?? 2) : 0;

      let nextNumeric: number;

      if (textValue === '' || value === '' || value === null || value === undefined) {
        if (direction === 'up') {
          if (min !== undefined && min > 0) {
            nextNumeric = min;
          } else {
            nextNumeric = (min !== undefined ? min : 0) + effectiveStep;
          }
        } else {
          nextNumeric = min !== undefined ? min : 0;
        }
      } else {
        const parsed = typeof value === 'number' ? value : parseFloat(textValue);
        const base = isNaN(parsed) ? (min ?? 0) : parsed;
        nextNumeric = stepNumber(base, stepDelta, precision);
      }

      if (min !== undefined && nextNumeric < min) {
        nextNumeric = min;
      }
      if (max !== undefined && nextNumeric > max) {
        nextNumeric = max;
      }

      const nextStr =
        allowDecimals && decimalPlaces !== undefined && decimalPlaces > 0 && textValue.includes('.')
          ? nextNumeric.toFixed(decimalPlaces)
          : String(nextNumeric);

      setTextValue(nextStr);
      onChange(nextNumeric, nextStr);
    };

    const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
      setIsFocused(false);

      if (textValue === '' || textValue === '-' || textValue === '.') {
        if (emptyValueFallback !== undefined && emptyValueFallback !== null) {
          const fallbackStr = String(emptyValueFallback);
          setTextValue(fallbackStr);
          onChange(emptyValueFallback, fallbackStr);
        } else {
          setTextValue('');
          onChange('', '');
        }
      } else {
        let num = parseFloat(textValue);
        if (isNaN(num)) {
          if (emptyValueFallback !== undefined && emptyValueFallback !== null) {
            const fallbackStr = String(emptyValueFallback);
            setTextValue(fallbackStr);
            onChange(emptyValueFallback, fallbackStr);
          } else {
            setTextValue('');
            onChange('', '');
          }
        } else {
          if (clampOnBlur) {
            if (min !== undefined && num < min) {
              num = min;
            }
            if (max !== undefined && num > max) {
              num = max;
            }
          }

          let formatted: string;
          if (formatOnBlur && allowDecimals && decimalPlaces !== undefined) {
            formatted = num.toFixed(decimalPlaces);
          } else {
            // Strip trailing decimal dot if left hanging (e.g. "12." -> "12")
            formatted = textValue.endsWith('.') ? textValue.slice(0, -1) : textValue;
            if (clampOnBlur && (min !== undefined || max !== undefined)) {
              formatted = String(num);
            }
          }

          setTextValue(formatted);
          onChange(num, formatted);
        }
      }

      onBlur?.(e);
    };

    const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
      setIsFocused(true);
      onFocus?.(e);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        handleStep('up');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        handleStep('down');
      }
      onKeyDown?.(e);
    };

    const needsWrapper = Boolean(
      prefix ||
      suffix ||
      showSteppers ||
      stepperType === 'buttons' ||
      stepperType === 'stacked' ||
      wrapperClassName
    );

    const hasCustomPl = className.includes('pl-');
    const prefixPaddingClass = prefix && !hasCustomPl ? 'pl-6' : '';
    const hasCustomPr = className.includes('pr-');
    const hasSteppers = showSteppers || stepperType === 'buttons' || stepperType === 'stacked';
    const stepperPaddingClass = hasSteppers && !hasCustomPr ? (stepperType === 'stacked' ? 'pr-7' : 'pr-14') : '';
    const suffixPaddingClass = suffix && !hasCustomPr && !hasSteppers ? 'pr-7' : '';

    const inputElement = (
      <input
        ref={internalInputRef}
        type="text"
        inputMode={allowDecimals ? 'decimal' : 'numeric'}
        value={textValue}
        onChange={handleInputChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        className={`${needsWrapper ? 'w-full' : ''} ${prefixPaddingClass} ${stepperPaddingClass} ${suffixPaddingClass} ${className}`.trim()}
        {...restInputProps}
      />
    );

    if (!needsWrapper) {
      return inputElement;
    }

    return (
      <div className={`relative flex items-center ${wrapperClassName}`}>
        {prefix && (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400 font-mono font-medium text-xs sm:text-sm select-none z-10">
            {prefix}
          </span>
        )}
        <div className="relative w-full flex items-center">
          {inputElement}
          {suffix && (
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 font-mono text-xs select-none">
              {suffix}
            </span>
          )}
          {hasSteppers && stepperType === 'stacked' && (
            <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex flex-col justify-center">
              <button
                type="button"
                tabIndex={-1}
                disabled={disabled || readOnly || (max !== undefined && typeof value === 'number' && value >= max)}
                onClick={() => handleStep('up')}
                className="text-stone-400 hover:text-stone-800 disabled:opacity-20 transition-colors p-0.5"
                aria-label={stepperAriaLabel?.increment || 'Increase value'}
              >
                <ChevronUp className="w-3 h-3" />
              </button>
              <button
                type="button"
                tabIndex={-1}
                disabled={disabled || readOnly || (min !== undefined && typeof value === 'number' && value <= min)}
                onClick={() => handleStep('down')}
                className="text-stone-400 hover:text-stone-800 disabled:opacity-20 transition-colors p-0.5"
                aria-label={stepperAriaLabel?.decrement || 'Decrease value'}
              >
                <ChevronDown className="w-3 h-3" />
              </button>
            </div>
          )}
          {hasSteppers && stepperType !== 'stacked' && (
            <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
              <button
                type="button"
                tabIndex={-1}
                disabled={disabled || readOnly || (min !== undefined && typeof value === 'number' && value <= min)}
                onClick={() => handleStep('down')}
                className="w-5 h-5 rounded flex items-center justify-center text-stone-500 hover:text-stone-900 hover:bg-stone-200/60 disabled:opacity-25 transition-colors cursor-pointer"
                aria-label={stepperAriaLabel?.decrement || 'Decrease value'}
              >
                <Minus className="w-3 h-3" />
              </button>
              <button
                type="button"
                tabIndex={-1}
                disabled={disabled || readOnly || (max !== undefined && typeof value === 'number' && value >= max)}
                onClick={() => handleStep('up')}
                className="w-5 h-5 rounded flex items-center justify-center text-stone-500 hover:text-stone-900 hover:bg-stone-200/60 disabled:opacity-25 transition-colors cursor-pointer"
                aria-label={stepperAriaLabel?.increment || 'Increase value'}
              >
                <Plus className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
);

NumericInput.displayName = 'NumericInput';
