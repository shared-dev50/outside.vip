/**
 * Client-side International Phone Number Validation and Formatting
 */

export interface PhoneValidationResult {
  isValid: boolean;
  normalized?: string;
  error?: string;
}

export function validateAndNormalizePhone(rawPhone?: string | null): PhoneValidationResult {
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

  if (/[a-zA-Z]/.test(trimmed)) {
    return {
      isValid: false,
      error: 'Phone number cannot contain letters.',
    };
  }

  if (!/^[+\d\s().-]+$/.test(trimmed)) {
    return {
      isValid: false,
      error: 'Please enter a valid phone number (e.g. +1 555-123-4567 or +254 712 345678).',
    };
  }

  const digitsOnly = trimmed.replace(/\D/g, '');

  if (digitsOnly.length < 7) {
    return {
      isValid: false,
      error: 'Phone number is too short. Please provide a valid number with area or country code.',
    };
  }

  if (digitsOnly.length > 15) {
    return {
      isValid: false,
      error: 'Phone number is too long (maximum 15 digits).',
    };
  }

  let normalized: string;

  if (trimmed.startsWith('+')) {
    normalized = `+${digitsOnly}`;
  } else if (trimmed.startsWith('00')) {
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
      normalized = `+254${digitsOnly.substring(1)}`;
    } else {
      normalized = `+1${digitsOnly}`;
    }
  } else if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
    normalized = `+${digitsOnly}`;
  } else if (digitsOnly.length === 12 && digitsOnly.startsWith('254')) {
    normalized = `+${digitsOnly}`;
  } else {
    normalized = `+${digitsOnly}`;
  }

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
