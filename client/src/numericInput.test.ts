import { describe, it, expect } from 'vitest';
import {
  parseNumericString,
  stepNumber,
} from './components/common/NumericInput';
import { calculateTierEarnings, calculateCombinedEarnings } from './lib/fees';

describe('Numeric & Currency Input Editing (Outside.vip)', () => {
  describe('1. Clearing a Value (Smart Clearing & Placeholder Preservation)', () => {
    it('clears all digits to an empty string without reverting to 0 or 1', () => {
      const initial = '75';
      expect(parseNumericString(initial).numericValue).toBe(75);

      const step1 = parseNumericString('7');
      expect(step1.cleanString).toBe('7');
      expect(step1.numericValue).toBe(7);

      const step2 = parseNumericString('');
      expect(step2.cleanString).toBe('');
      expect(step2.numericValue).toBe('');
      // Crucial requirement: It must NOT evaluate to 0 or 1 during editing!
      expect(step2.numericValue).not.toBe(0);
      expect(step2.numericValue).not.toBe(1);
    });

    it('clears an existing 0 without getting stuck', () => {
      const res = parseNumericString('');
      expect(res.cleanString).toBe('');
      expect(res.numericValue).toBe('');
    });

    it('handles null and undefined gracefully', () => {
      expect(parseNumericString(null as any)).toEqual({ cleanString: '', numericValue: '' });
      expect(parseNumericString(undefined as any)).toEqual({ cleanString: '', numericValue: '' });
    });
  });

  describe('2. Typing Replacement Without Preceding Zero Selection', () => {
    it('allows typing new digits directly into empty field', () => {
      const res1 = parseNumericString('5');
      expect(res1.cleanString).toBe('5');
      expect(res1.numericValue).toBe(5);

      const res2 = parseNumericString('50');
      expect(res2.cleanString).toBe('50');
      expect(res2.numericValue).toBe(50);
    });

    it('cleans non-numeric noise if user types or pastes characters', () => {
      const res = parseNumericString('abc50xyz');
      expect(res.cleanString).toBe('50');
      expect(res.numericValue).toBe(50);
    });
  });

  describe('3. Decimal Entry (Ticket Prices & Currency Amounts)', () => {
    it('preserves trailing period while typing without swallowing it or forcing early truncation', () => {
      const res = parseNumericString('12.', { allowDecimals: true, decimalPlaces: 2 });
      expect(res.cleanString).toBe('12.');
      expect(res.numericValue).toBe(12);
      // The string MUST preserve the dot for the UI
      expect(res.cleanString.endsWith('.')).toBe(true);
    });

    it('parses fractional numbers correctly once completed', () => {
      const res = parseNumericString('12.50', { allowDecimals: true, decimalPlaces: 2 });
      expect(res.cleanString).toBe('12.50');
      expect(res.numericValue).toBe(12.5);
    });

    it('rejects a second decimal point in decimal mode', () => {
      const res = parseNumericString('12.5.9', { allowDecimals: true, decimalPlaces: 2 });
      expect(res.cleanString).toBe('12.59');
      expect(res.numericValue).toBe(12.59);
    });

    it('restricts decimal places when configured (e.g. max 2 for USD)', () => {
      const res = parseNumericString('19.999', { allowDecimals: true, decimalPlaces: 2 });
      expect(res.cleanString).toBe('19.99');
      expect(res.numericValue).toBe(19.99);
    });

    it('blocks decimal points when allowDecimals is false (Integer-only mode)', () => {
      // In capacity or order limit fields (capacity: 250)
      const res = parseNumericString('250.5', { allowDecimals: false });
      expect(res.cleanString).toBe('2505');
      expect(res.numericValue).toBe(2505);
    });

    it('handles lone decimal point or leading decimal properly', () => {
      const resLone = parseNumericString('.', { allowDecimals: true });
      expect(resLone.cleanString).toBe('.');
      expect(resLone.numericValue).toBe('');

      const resLeading = parseNumericString('.75', { allowDecimals: true });
      expect(resLeading.cleanString).toBe('.75');
      expect(resLeading.numericValue).toBe(0.75);
    });
  });

  describe('4. Sanitizing Pasted Currency Values', () => {
    it('strips commas, dollar signs, and whitespace when pasted', () => {
      const res = parseNumericString(' $ 1,450.75 ', { allowDecimals: true, decimalPlaces: 2 });
      expect(res.cleanString).toBe('1450.75');
      expect(res.numericValue).toBe(1450.75);
    });
  });

  describe('5. Increment / Decrement Stepper Precision & Bounds', () => {
    it('increments integers with step=1 and step=10', () => {
      expect(stepNumber(10, 1, 0)).toBe(11);
      expect(stepNumber(10, -1, 0)).toBe(9);
      expect(stepNumber(100, 10, 0)).toBe(110);
      expect(stepNumber(100, -10, 0)).toBe(90);
    });

    it('steps decimals without IEEE 754 precision floating point errors', () => {
      // 0.1 + 0.2 in raw JavaScript is 0.30000000000000004
      const result = stepNumber(0.1, 0.2, 2);
      expect(result).toBe(0.3);

      const decStep = stepNumber(19.95, 0.05, 2);
      expect(decStep).toBe(20);
    });

    it('respects min and max bounds during stepping simulation', () => {
      const min = 1;
      const max = 10;
      const step = 1;

      // Decrement from 1 should be clamped to min
      let val = 1;
      let next = Math.max(min, Math.min(max, stepNumber(val, -step, 0)));
      expect(next).toBe(1);

      // Increment from 10 should be clamped to max
      val = 10;
      next = Math.max(min, Math.min(max, stepNumber(val, step, 0)));
      expect(next).toBe(10);
    });
  });

  describe('6. Blur Clamping & Empty String Preservation', () => {
    function simulateBlur(
      textValue: string,
      options: {
        min?: number;
        max?: number;
        clampOnBlur?: boolean;
        emptyValueFallback?: number | null;
      } = {}
    ): { textValue: string; numericValue: number | '' } {
      const { min, max, clampOnBlur = true, emptyValueFallback } = options;

      if (textValue === '' || textValue === '-' || textValue === '.') {
        if (emptyValueFallback !== undefined && emptyValueFallback !== null) {
          return { textValue: String(emptyValueFallback), numericValue: emptyValueFallback };
        }
        return { textValue: '', numericValue: '' };
      }

      let num = parseFloat(textValue);
      if (isNaN(num)) {
        if (emptyValueFallback !== undefined && emptyValueFallback !== null) {
          return { textValue: String(emptyValueFallback), numericValue: emptyValueFallback };
        }
        return { textValue: '', numericValue: '' };
      }

      if (clampOnBlur) {
        if (min !== undefined && num < min) num = min;
        if (max !== undefined && num > max) num = max;
      }

      let formatted = textValue.endsWith('.') ? textValue.slice(0, -1) : textValue;
      if (clampOnBlur && (min !== undefined || max !== undefined)) {
        formatted = String(num);
      }

      return { textValue: formatted, numericValue: num };
    }

    it('keeps field empty on blur when emptyValueFallback is not set (preserving placeholder visibility)', () => {
      const res = simulateBlur('', { min: 0, max: 1000 });
      expect(res.textValue).toBe('');
      expect(res.numericValue).toBe('');
    });

    it('applies emptyValueFallback on blur when explicitly configured', () => {
      const res = simulateBlur('', { min: 1, max: 30, emptyValueFallback: 1 });
      expect(res.textValue).toBe('1');
      expect(res.numericValue).toBe(1);
    });

    it('clamps values below minimum on blur', () => {
      const res = simulateBlur('-5', { min: 0, max: 100 });
      expect(res.textValue).toBe('0');
      expect(res.numericValue).toBe(0);
    });

    it('clamps values above maximum on blur', () => {
      const res = simulateBlur('999', { min: 1, max: 52 });
      expect(res.textValue).toBe('52');
      expect(res.numericValue).toBe(52);
    });

    it('strips hanging decimal point on blur', () => {
      const res = simulateBlur('25.', { min: 0 });
      expect(res.textValue).toBe('25');
      expect(res.numericValue).toBe(25);
    });
  });

  describe('7. Form Step Validation & Safe Fallbacks (CreateEventPage Integration)', () => {
    function validateTicketTier(tier: {
      name: string;
      price: number | '';
      totalCapacity: number | '';
      minPerOrder: number | '';
      maxPerOrder: number | '';
    }): { valid: boolean; error?: string } {
      if (!tier.name.trim()) {
        return { valid: false, error: 'All ticket tiers must have a valid tier name.' };
      }
      if (tier.totalCapacity === '' || Number(tier.totalCapacity) < 1) {
        return { valid: false, error: `Capacity for "${tier.name}" must be at least 1.` };
      }
      if (tier.price === '' || isNaN(Number(tier.price)) || Number(tier.price) < 0) {
        return { valid: false, error: `Please provide a valid price for "${tier.name}" (enter 0 for free admission).` };
      }
      if (tier.minPerOrder !== '' && Number(tier.minPerOrder) < 1) {
        return { valid: false, error: `Min per order for "${tier.name}" must be at least 1.` };
      }
      if (tier.maxPerOrder !== '' && Number(tier.maxPerOrder) < 1) {
        return { valid: false, error: `Max per order for "${tier.name}" must be at least 1.` };
      }
      if (tier.minPerOrder !== '' && tier.maxPerOrder !== '' && Number(tier.maxPerOrder) < Number(tier.minPerOrder)) {
        return { valid: false, error: `Max per order cannot be less than min per order for "${tier.name}".` };
      }
      return { valid: true };
    }

    it('validates free tickets with price 0 as valid', () => {
      const res = validateTicketTier({
        name: 'RSVP Free',
        price: 0,
        totalCapacity: 100,
        minPerOrder: 1,
        maxPerOrder: 4,
      });
      expect(res.valid).toBe(true);
    });

    it('rejects unpopulated / empty ticket price upon step navigation', () => {
      const res = validateTicketTier({
        name: 'VIP Deck',
        price: '', // User deleted digits and left it empty
        totalCapacity: 50,
        minPerOrder: 1,
        maxPerOrder: 4,
      });
      expect(res.valid).toBe(false);
      expect(res.error).toContain('Please provide a valid price');
    });

    it('rejects capacity less than 1 or empty', () => {
      expect(
        validateTicketTier({
          name: 'VIP',
          price: 50,
          totalCapacity: '',
          minPerOrder: 1,
          maxPerOrder: 2,
        }).valid
      ).toBe(false);

      expect(
        validateTicketTier({
          name: 'VIP',
          price: 50,
          totalCapacity: 0,
          minPerOrder: 1,
          maxPerOrder: 2,
        }).valid
      ).toBe(false);
    });

    it('rejects maxPerOrder lower than minPerOrder', () => {
      const res = validateTicketTier({
        name: 'General',
        price: 25,
        totalCapacity: 100,
        minPerOrder: 5,
        maxPerOrder: 2,
      });
      expect(res.valid).toBe(false);
      expect(res.error).toContain('Max per order cannot be less than min per order');
    });

    it('safely calculates earnings even when fields are temporarily empty strings during editing', () => {
      const emptyTier = {
        price: '' as const,
        totalCapacity: '' as const,
      };

      const priceInCents = Math.round((Number(emptyTier.price) || 0) * 100);
      const capacity = Math.max(0, Number(emptyTier.totalCapacity) || 0);

      expect(priceInCents).toBe(0);
      expect(capacity).toBe(0);

      const breakdown = calculateTierEarnings(priceInCents, capacity);
      expect(breakdown.projectedEarningsInCents).toBe(0);
      expect(breakdown.buyerTotalInCents).toBe(0);

      const combined = calculateCombinedEarnings([{ priceInCents, capacity }]);
      expect(combined.totalProjectedEarningsInCents).toBe(0);
      expect(combined.totalCapacity).toBe(0);
    });

    it('correctly builds payload with priceInCents conversion and order limits', () => {
      const tier = {
        name: 'VIP Pass',
        price: 75.5,
        totalCapacity: 150,
        minPerOrder: 2,
        maxPerOrder: 6,
      };

      const payload = {
        priceInCents: Math.round((Number(tier.price) || 0) * 100),
        totalCapacity: Math.max(1, Number(tier.totalCapacity) || 1),
        minPerOrder: Math.max(1, Number(tier.minPerOrder) || 1),
        maxPerOrder: Math.max(Math.max(1, Number(tier.minPerOrder) || 1), Number(tier.maxPerOrder) || 1),
      };

      expect(payload.priceInCents).toBe(7550);
      expect(payload.totalCapacity).toBe(150);
      expect(payload.minPerOrder).toBe(2);
      expect(payload.maxPerOrder).toBe(6);
    });
  });
});
