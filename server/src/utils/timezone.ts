export interface TimezoneOption {
  iana: string;
  name: string;
  region: 'US' | 'Africa' | 'Europe' | 'Global';
}

export const TIMEZONE_CATALOG: TimezoneOption[] = [
  // US Timezones (Prioritized)
  { iana: 'America/New_York', name: 'Eastern Time', region: 'US' },
  { iana: 'America/Chicago', name: 'Central Time', region: 'US' },
  { iana: 'America/Denver', name: 'Mountain Time', region: 'US' },
  { iana: 'America/Phoenix', name: 'Mountain Time (Arizona - No DST)', region: 'US' },
  { iana: 'America/Los_Angeles', name: 'Pacific Time', region: 'US' },
  { iana: 'America/Anchorage', name: 'Alaska Time', region: 'US' },
  { iana: 'Pacific/Honolulu', name: 'Hawaii Time', region: 'US' },

  // African Timezones
  { iana: 'Africa/Nairobi', name: 'Nairobi', region: 'Africa' },
  { iana: 'Africa/Cairo', name: 'Cairo', region: 'Africa' },
  { iana: 'Africa/Johannesburg', name: 'Johannesburg', region: 'Africa' },
  { iana: 'Africa/Lagos', name: 'Lagos', region: 'Africa' },

  // International / Global Timezones
  { iana: 'Europe/London', name: 'London (GMT / BST)', region: 'Europe' },
  { iana: 'Europe/Paris', name: 'Paris / Central Europe', region: 'Europe' },
  { iana: 'Asia/Dubai', name: 'Dubai', region: 'Global' },
  { iana: 'Asia/Tokyo', name: 'Tokyo', region: 'Global' },
];

/**
 * Format dynamic display string with daylight saving time abbreviation and GMT offset.
 * e.g. "Eastern — America/New_York (EST, GMT-5)" or "(EDT, GMT-4)"
 */
export function formatTimezoneLabel(iana: string, refDate: Date = new Date()): string {
  const match = TIMEZONE_CATALOG.find((t) => t.iana === iana);
  const friendlyName = match ? match.name : iana;

  try {
    const tzPart = new Intl.DateTimeFormat('en-US', {
      timeZone: iana,
      timeZoneName: 'short',
    })
      .formatToParts(refDate)
      .find((p) => p.type === 'timeZoneName')?.value;

    const offsetPart = new Intl.DateTimeFormat('en-US', {
      timeZone: iana,
      timeZoneName: 'shortOffset',
    })
      .formatToParts(refDate)
      .find((p) => p.type === 'timeZoneName')?.value;

    const suffix = [tzPart, offsetPart].filter(Boolean).filter((v, idx, arr) => arr.indexOf(v) === idx).join(', ');
    return `${friendlyName} — ${iana}${suffix ? ` (${suffix})` : ''}`;
  } catch {
    return `${friendlyName} — ${iana}`;
  }
}

const US_STATE_TO_TIMEZONE: Record<string, string> = {
  // Eastern
  CT: 'America/New_York',
  DE: 'America/New_York',
  DC: 'America/New_York',
  FL: 'America/New_York',
  GA: 'America/New_York',
  IN: 'America/New_York',
  KY: 'America/New_York',
  ME: 'America/New_York',
  MD: 'America/New_York',
  MA: 'America/New_York',
  MI: 'America/New_York',
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NY: 'America/New_York',
  NC: 'America/New_York',
  OH: 'America/New_York',
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  VT: 'America/New_York',
  VA: 'America/New_York',
  WV: 'America/New_York',

  // Central
  AL: 'America/Chicago',
  AR: 'America/Chicago',
  IL: 'America/Chicago',
  IA: 'America/Chicago',
  KS: 'America/Chicago',
  LA: 'America/Chicago',
  MN: 'America/Chicago',
  MS: 'America/Chicago',
  MO: 'America/Chicago',
  NE: 'America/Chicago',
  ND: 'America/Chicago',
  OK: 'America/Chicago',
  SD: 'America/Chicago',
  TN: 'America/Chicago',
  TX: 'America/Chicago',
  WI: 'America/Chicago',

  // Mountain
  CO: 'America/Denver',
  ID: 'America/Denver',
  MT: 'America/Denver',
  NM: 'America/Denver',
  UT: 'America/Denver',
  WY: 'America/Denver',

  // Arizona (Mountain no DST)
  AZ: 'America/Phoenix',

  // Pacific
  CA: 'America/Los_Angeles',
  NV: 'America/Los_Angeles',
  OR: 'America/Los_Angeles',
  WA: 'America/Los_Angeles',

  // Alaska & Hawaii
  AK: 'America/Anchorage',
  HI: 'Pacific/Honolulu',
};

/**
 * Infer the standard IANA timezone reliably from venue coordinates, US state, or country.
 */
export function inferTimezoneFromLocation(params: {
  latitude?: number | null;
  longitude?: number | null;
  stateCode?: string | null;
  country?: string | null;
  countryCode?: string | null;
}): string | null {
  const { latitude, longitude, stateCode, country, countryCode } = params;

  // 1. By US state abbreviation
  if (stateCode) {
    const cleanState = stateCode.trim().toUpperCase();
    if (US_STATE_TO_TIMEZONE[cleanState]) {
      return US_STATE_TO_TIMEZONE[cleanState];
    }
  }

  // 2. By Kenya / East Africa indicators
  const normalizedCountry = (country || '').toLowerCase().trim();
  const normalizedCountryCode = (countryCode || '').toUpperCase().trim();
  if (
    normalizedCountryCode === 'KE' ||
    normalizedCountry === 'kenya' ||
    normalizedCountryCode === 'UG' ||
    normalizedCountryCode === 'TZ'
  ) {
    return 'Africa/Nairobi';
  }

  // 3. By coordinates if available
  if (typeof latitude === 'number' && typeof longitude === 'number') {
    // East Africa box
    if (latitude >= -5 && latitude <= 5.5 && longitude >= 33 && longitude <= 42) {
      return 'Africa/Nairobi';
    }

    // United Kingdom box
    if (latitude >= 49.5 && latitude <= 60 && longitude >= -8.5 && longitude <= 2) {
      return 'Europe/London';
    }

    // Hawaii box
    if (latitude >= 18 && latitude <= 23 && longitude >= -162 && longitude <= -154) {
      return 'Pacific/Honolulu';
    }

    // Alaska box
    if (latitude >= 51 && latitude <= 72 && longitude >= -170 && longitude <= -129) {
      return 'America/Anchorage';
    }

    // Continental US longitude bands
    if (latitude >= 24 && latitude <= 50) {
      if (longitude < -114.5) {
        return 'America/Los_Angeles'; // Pacific
      }
      if (longitude >= -114.5 && longitude < -102) {
        // Check if inside Arizona
        if (latitude >= 31.3 && latitude <= 37.0 && longitude >= -114.8 && longitude <= -109.0) {
          return 'America/Phoenix';
        }
        return 'America/Denver'; // Mountain
      }
      if (longitude >= -102 && longitude < -85.5) {
        return 'America/Chicago'; // Central
      }
      if (longitude >= -85.5 && longitude <= -66.5) {
        return 'America/New_York'; // Eastern
      }
    }
  }

  // 4. Default fallback if US country identified without specific coords
  if (
    normalizedCountryCode === 'US' ||
    normalizedCountry === 'united states' ||
    normalizedCountry === 'usa' ||
    normalizedCountry === 'united states of america'
  ) {
    return 'America/New_York';
  }

  return null;
}
