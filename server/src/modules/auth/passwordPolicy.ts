export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_UPPERCASE_REGEX = /[A-Z]/;
export const PASSWORD_NUMBER_REGEX = /[0-9]/;
export const PASSWORD_SPECIAL_CHAR_REGEX = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/;

export const PASSWORD_ACCEPTED_SPECIAL_CHARS = '!@#$%^&*()_+-=[]{}|;:\'",.<>/?`~\\';

export type PasswordRequirementKey = 'minLength' | 'uppercase' | 'number' | 'special';

export interface PasswordRequirementRule {
  key: PasswordRequirementKey;
  label: string;
  errorMessage: string;
  test: (password: string) => boolean;
}

export const PASSWORD_REQUIREMENT_RULES: ReadonlyArray<PasswordRequirementRule> = [
  {
    key: 'minLength',
    label: `At least ${PASSWORD_MIN_LENGTH} characters`,
    errorMessage: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
    test: (password) => password.length >= PASSWORD_MIN_LENGTH,
  },
  {
    key: 'uppercase',
    label: 'At least 1 uppercase letter (A-Z)',
    errorMessage: 'Password must include at least one uppercase letter (A-Z).',
    test: (password) => PASSWORD_UPPERCASE_REGEX.test(password),
  },
  {
    key: 'number',
    label: 'At least 1 number (0-9)',
    errorMessage: 'Password must include at least one number (0-9).',
    test: (password) => PASSWORD_NUMBER_REGEX.test(password),
  },
  {
    key: 'special',
    label: 'At least 1 special character (!@#$%^&* etc.)',
    errorMessage:
      'Password must include at least one special character (for example !@#$%^&*).',
    test: (password) => PASSWORD_SPECIAL_CHAR_REGEX.test(password),
  },
];

export interface PasswordPolicyEvaluation {
  valid: boolean;
  checks: Record<PasswordRequirementKey, boolean>;
  errors: string[];
  firstError: string | null;
}

export function evaluatePasswordPolicy(password: string): PasswordPolicyEvaluation {
  const checks: Record<PasswordRequirementKey, boolean> = {
    minLength: false,
    uppercase: false,
    number: false,
    special: false,
  };

  const errors: string[] = [];

  for (const rule of PASSWORD_REQUIREMENT_RULES) {
    const passed = rule.test(password);
    checks[rule.key] = passed;
    if (!passed) {
      errors.push(rule.errorMessage);
    }
  }

  return {
    valid: errors.length === 0,
    checks,
    errors,
    firstError: errors[0] ?? null,
  };
}
