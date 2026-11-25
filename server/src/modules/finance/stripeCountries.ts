export interface StripeConnectCountry {
  code: string; // ISO 3166-1 alpha-2
  name: string;
}

export const STRIPE_EXPRESS_COUNTRY_CATALOG: StripeConnectCountry[] = [
  { code: 'US', name: 'United States' },
  { code: 'CA', name: 'Canada' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'AU', name: 'Australia' },
  { code: 'AT', name: 'Austria' },
  { code: 'BE', name: 'Belgium' },
  { code: 'BG', name: 'Bulgaria' },
  { code: 'HR', name: 'Croatia' },
  { code: 'CY', name: 'Cyprus' },
  { code: 'CZ', name: 'Czech Republic' },
  { code: 'DK', name: 'Denmark' },
  { code: 'EE', name: 'Estonia' },
  { code: 'FI', name: 'Finland' },
  { code: 'FR', name: 'France' },
  { code: 'DE', name: 'Germany' },
  { code: 'GR', name: 'Greece' },
  { code: 'HK', name: 'Hong Kong' },
  { code: 'HU', name: 'Hungary' },
  { code: 'IE', name: 'Ireland' },
  { code: 'IT', name: 'Italy' },
  { code: 'JP', name: 'Japan' },
  { code: 'LV', name: 'Latvia' },
  { code: 'LI', name: 'Liechtenstein' },
  { code: 'LT', name: 'Lithuania' },
  { code: 'LU', name: 'Luxembourg' },
  { code: 'MT', name: 'Malta' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'NO', name: 'Norway' },
  { code: 'PL', name: 'Poland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'RO', name: 'Romania' },
  { code: 'SG', name: 'Singapore' },
  { code: 'SK', name: 'Slovakia' },
  { code: 'SI', name: 'Slovenia' },
  { code: 'ES', name: 'Spain' },
  { code: 'SE', name: 'Sweden' },
  { code: 'CH', name: 'Switzerland' },
];

export const DEFAULT_STRIPE_CONNECT_COUNTRY = 'US';
export const DEFAULT_PLATFORM_CURRENCY = 'USD';

const CATALOG_MAP = new Map<string, StripeConnectCountry>(
  STRIPE_EXPRESS_COUNTRY_CATALOG.map((c) => [c.code, c])
);

/**
 * Resolves launch-permitted Connect onboarding countries from environment configuration.
 * Initial US/USD commercial launch defaults strictly to ['US'].
 */
export function getConfiguredStripeConnectCountries(
  rawAllowlist = process.env.STRIPE_CONNECT_SUPPORTED_COUNTRIES
): StripeConnectCountry[] {
  const configured = (rawAllowlist || DEFAULT_STRIPE_CONNECT_COUNTRY)
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter((code) => CATALOG_MAP.has(code));

  const unique = Array.from(new Set(configured));
  if (unique.length === 0) {
    return [CATALOG_MAP.get(DEFAULT_STRIPE_CONNECT_COUNTRY)!];
  }
  return unique.map((code) => CATALOG_MAP.get(code)!);
}

/**
 * Initial commercial launch exports US-only by default.
 */
export const STRIPE_EXPRESS_SUPPORTED_COUNTRIES: StripeConnectCountry[] =
  getConfiguredStripeConnectCountries();

export const STRIPE_EXPRESS_COUNTRY_CODES = new Set(
  STRIPE_EXPRESS_SUPPORTED_COUNTRIES.map((c) => c.code)
);

export function isStripeExpressCountrySupported(code: string | undefined | null): boolean {
  if (!code || typeof code !== 'string') return false;
  const normalized = code.trim().toUpperCase();
  const activeCountries = getConfiguredStripeConnectCountries();
  return activeCountries.some((c) => c.code === normalized);
}

export function getStripeCountryName(code: string | undefined | null): string {
  if (!code) return '';
  const normalized = code.trim().toUpperCase();
  return CATALOG_MAP.get(normalized)?.name || normalized;
}

/**
 * Validates that the configured platform currencies strictly remain single-currency USD
 * while OrganizerBalance maintains a single `@unique userId` currency column.
 */
export function validatePlatformCurrencyConfig(
  rawCurrencies = process.env.PLATFORM_SUPPORTED_CURRENCIES
): string[] {
  const effectiveRaw = rawCurrencies === undefined ? DEFAULT_PLATFORM_CURRENCY : rawCurrencies;
  const tokens = effectiveRaw
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.length > 0);

  if (tokens.length === 0) {
    throw new Error(
      'FATAL: PLATFORM_SUPPORTED_CURRENCIES cannot be empty while OrganizerBalance enforces a single currency per organizer. Only USD is supported.'
    );
  }

  const invalid = tokens.filter((code) => !/^[A-Z]{3}$/.test(code));
  if (invalid.length > 0) {
    throw new Error(
      `FATAL: Invalid PLATFORM_SUPPORTED_CURRENCIES="${effectiveRaw}". Expected 3-letter ISO currency code "${DEFAULT_PLATFORM_CURRENCY}".`
    );
  }

  const unique = Array.from(new Set(tokens));
  if (unique.length !== 1 || unique[0] !== DEFAULT_PLATFORM_CURRENCY) {
    throw new Error(
      `FATAL: Unsupported PLATFORM_SUPPORTED_CURRENCIES="${effectiveRaw}". Only ["${DEFAULT_PLATFORM_CURRENCY}"] is supported while OrganizerBalance enforces a single currency per organizer.`
    );
  }

  return [DEFAULT_PLATFORM_CURRENCY];
}

export function getConfiguredSupportedCurrencies(
  rawCurrencies = process.env.PLATFORM_SUPPORTED_CURRENCIES
): string[] {
  return validatePlatformCurrencyConfig(rawCurrencies);
}

export function isSupportedPlatformCurrency(currency: string | undefined | null): boolean {
  if (!currency || typeof currency !== 'string') return false;
  const normalized = currency.trim().toUpperCase();
  return getConfiguredSupportedCurrencies().includes(normalized);
}
