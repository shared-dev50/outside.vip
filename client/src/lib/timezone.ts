export interface TimezoneOption {
  iana: string;
  name: string;
  region: 'US' | 'Africa' | 'Europe' | 'Global';
}

export interface TimezoneGroup {
  groupName: string;
  options: TimezoneOption[];
}

export const TIMEZONE_GROUPS: TimezoneGroup[] = [
  {
    groupName: 'United States',
    options: [
      { iana: 'America/New_York', name: 'Eastern Time', region: 'US' },
      { iana: 'America/Chicago', name: 'Central Time', region: 'US' },
      { iana: 'America/Denver', name: 'Mountain Time', region: 'US' },
      { iana: 'America/Phoenix', name: 'Mountain Time (Arizona - No DST)', region: 'US' },
      { iana: 'America/Los_Angeles', name: 'Pacific Time', region: 'US' },
      { iana: 'America/Anchorage', name: 'Alaska Time', region: 'US' },
      { iana: 'Pacific/Honolulu', name: 'Hawaii Time', region: 'US' },
    ],
  },
  {
    groupName: 'Africa',
    options: [
      { iana: 'Africa/Nairobi', name: 'Nairobi (East Africa)', region: 'Africa' },
      { iana: 'Africa/Johannesburg', name: 'Johannesburg (South Africa)', region: 'Africa' },
      { iana: 'Africa/Lagos', name: 'Lagos (West Africa)', region: 'Africa' },
      { iana: 'Africa/Cairo', name: 'Cairo (Egypt)', region: 'Africa' },
    ],
  },
  {
    groupName: 'Europe & International',
    options: [
      { iana: 'Europe/London', name: 'London (GMT / BST)', region: 'Europe' },
      { iana: 'Europe/Paris', name: 'Paris / Berlin (CET / CEST)', region: 'Europe' },
      { iana: 'Asia/Dubai', name: 'Dubai (GST)', region: 'Global' },
      { iana: 'Asia/Tokyo', name: 'Tokyo (JST)', region: 'Global' },
    ],
  },
];

export const ALL_TIMEZONES = TIMEZONE_GROUPS.flatMap((g) => g.options);

export const DEFAULT_US_TIMEZONE = 'America/New_York';

/**
 * Format dynamic display string with daylight saving time abbreviation and GMT offset.
 * Automatically adapts when daylight saving time is active or inactive.
 * e.g. "Eastern Time — America/New_York (EDT, GMT-4)" in summer, or "(EST, GMT-5)" in winter
 */
export function formatTimezoneDisplay(iana: string, refDate: Date = new Date()): string {
  const match = ALL_TIMEZONES.find((t) => t.iana === iana);
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

    const parts = [tzPart, offsetPart].filter(Boolean).filter((v, idx, arr) => arr.indexOf(v) === idx);
    const suffix = parts.join(', ');
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

  // Arizona
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
 * Infer standard IANA timezone reliably from venue coordinates, US state, or country.
 */
export function inferTimezoneFromLocation(params: {
  latitude?: number | null;
  longitude?: number | null;
  stateCode?: string | null;
  country?: string | null;
  countryCode?: string | null;
}): string | null {
  const { latitude, longitude, stateCode, country, countryCode } = params;

  if (stateCode) {
    const cleanState = stateCode.trim().toUpperCase();
    if (US_STATE_TO_TIMEZONE[cleanState]) {
      return US_STATE_TO_TIMEZONE[cleanState];
    }
  }

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

  if (typeof latitude === 'number' && typeof longitude === 'number') {
    // East Africa box
    if (latitude >= -5 && latitude <= 5.5 && longitude >= 33 && longitude <= 42) {
      return 'Africa/Nairobi';
    }

    // UK box
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
        return 'America/Los_Angeles';
      }
      if (longitude >= -114.5 && longitude < -102) {
        if (latitude >= 31.3 && latitude <= 37.0 && longitude >= -114.8 && longitude <= -109.0) {
          return 'America/Phoenix';
        }
        return 'America/Denver';
      }
      if (longitude >= -102 && longitude < -85.5) {
        return 'America/Chicago';
      }
      if (longitude >= -85.5 && longitude <= -66.5) {
        return 'America/New_York';
      }
    }
  }

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

/**
 * Converts a datetime-local input string ("YYYY-MM-DDTHH:mm") interpreted in an IANA timezone
 * to an exact UTC ISO 8601 string, correctly adjusting for daylight saving time (DST).
 */
export function toIsoValueInTimezone(localString?: string | null, timezone?: string | null): string | null {
  if (!localString || !localString.trim()) return null;
  const match = localString.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) {
    const d = new Date(localString);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const [, yearStr, monthStr, dayStr, hourStr, minStr] = match;
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minStr, 10);

  const tz = timezone || 'UTC';
  try {
    const pad = (n: number) => n.toString().padStart(2, '0');
    const targetIsoString = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00`;
    let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

    const getParts = (d: Date) => {
      const f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const parts = f.formatToParts(d);
      const res: Record<string, string> = {};
      for (const p of parts) res[p.type] = p.value;
      const h = res.hour === '24' ? '00' : res.hour;
      return `${res.year}-${res.month}-${res.day}T${h}:${res.minute}:00`;
    };

    const guessLocal = getParts(guess);
    const diffMs = new Date(targetIsoString + 'Z').getTime() - new Date(guessLocal + 'Z').getTime();
    guess = new Date(guess.getTime() + diffMs);

    // Double check for DST transition boundary accuracy
    const refinedLocal = getParts(guess);
    const diffMs2 = new Date(targetIsoString + 'Z').getTime() - new Date(refinedLocal + 'Z').getTime();
    if (diffMs2 !== 0) {
      guess = new Date(guess.getTime() + diffMs2);
    }

    return guess.toISOString();
  } catch {
    const d = new Date(localString);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
}

/**
 * Formats a UTC ISO string or Date into "YYYY-MM-DDTHH:mm" in the specified IANA timezone,
 * suitable for binding directly into <input type="datetime-local" />.
 */
export function toInputValueInTimezone(dateInput?: string | Date | null, timezone?: string | null): string {
  if (!dateInput) return '';
  const dt = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (isNaN(dt.getTime())) return '';
  const tz = timezone || 'UTC';
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = f.formatToParts(dt);
    const res: Record<string, string> = {};
    for (const p of parts) res[p.type] = p.value;
    const hr = res.hour === '24' ? '00' : res.hour;
    return `${res.year}-${res.month}-${res.day}T${hr}:${res.minute}`;
  } catch {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  }
}
