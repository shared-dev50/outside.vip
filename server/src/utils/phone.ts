/**
 * International Phone Number Validation and Normalization
 * Supports standard E.164 formats, North American 10/11 digits, UK, Kenyan,
 * and general international formats with or without country calling codes.
 */

export interface PhoneValidationResult {
  isValid: boolean;
  normalized?: string;
  error?: string;
}

/**
 * Normalizes and validates an international phone number.
 * Returns normalized E.164-style phone string (e.g. +15551234567, +254712345678)
 * or an error message if invalid.
 */
export function normalizePhoneNumber(rawPhone?: string | null): PhoneValidationResult {
  if (!rawPhone || typeof rawPhone !== 'string') {
    return {
      isValid: false,
      error: 'Phone number is required.',
    };
  }

  const trimmed = rawPhone.trim();
  if (!trimmed) {
    return {
      isValid: false,
      error: 'Phone number is required.',
    };
  }

  // Reject strings containing letters or suspicious special characters
  if (/[a-zA-Z]/.test(trimmed)) {
    return {
      isValid: false,
      error: 'Phone number cannot contain alphabetic characters.',
    };
  }

  // Allowed characters: digits, spaces, hyphens, parentheses, plus, dots
  if (!/^[+\d\s().-]+$/.test(trimmed)) {
    return {
      isValid: false,
      error: 'Please enter a valid phone number (e.g. +1 555-123-4567 or +254 712 345678).',
    };
  }

  const startsWithPlus = trimmed.startsWith('+');

  // Strip all non-digit characters
  const digitsOnly = trimmed.replace(/\D/g, '');

  if (digitsOnly.length < 7) {
    return {
      isValid: false,
      error: 'Phone number is too short. Please provide a valid phone number with area/country code.',
    };
  }

  if (digitsOnly.length > 15) {
    return {
      isValid: false,
      error: 'Phone number is too long (maximum 15 digits).',
    };
  }

  let normalized: string;

  if (startsWithPlus) {
    normalized = `+${digitsOnly}`;
  } else if (trimmed.startsWith('00')) {
    // International prefix '00' (used in Europe/UK)
    const after00 = digitsOnly.substring(2);
    if (after00.length < 7 || after00.length > 15) {
      return {
        isValid: false,
        error: 'Please enter a valid international phone number.',
      };
    }
    normalized = `+${after00}`;
  } else if (digitsOnly.length === 10) {
    if (digitsOnly.startsWith('0')) {
      // Common Kenyan mobile format (e.g. 0712345678 or 0112345678) -> +254...
      normalized = `+254${digitsOnly.substring(1)}`;
    } else {
      // Standard US/Canada 10-digit number -> +1...
      normalized = `+1${digitsOnly}`;
    }
  } else if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
    // US 11-digit with country code 1
    normalized = `+${digitsOnly}`;
  } else if (digitsOnly.length === 12 && digitsOnly.startsWith('254')) {
    // Kenya with 254
    normalized = `+${digitsOnly}`;
  } else {
    // General international number provided without '+'
    normalized = `+${digitsOnly}`;
  }

  // Final sanity check for E.164: + followed by 7-15 digits
  if (!/^\+[1-9]\d{6,14}$/.test(normalized)) {
    return {
      isValid: false,
      error: 'Please enter a valid international phone number (e.g. +1 555-123-4567 or +254 712 345678).',
    };
  }

  return {
    isValid: true,
    normalized,
  };
}
