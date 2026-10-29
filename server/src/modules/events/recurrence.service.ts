import { RecurrenceFrequency } from '@prisma/client';

export interface RecurrenceRuleInput {
  frequency: RecurrenceFrequency | 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval?: number;
  byWeekday?: number[]; // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  endDate?: string | Date | null;
  count?: number | null;
}

export interface OccurrenceScheduleItem {
  occurrenceIndex: number;
  startAt: Date;
  endAt: Date;
}

const MAX_SAFE_OCCURRENCES = 52;

/**
 * Normalizes and extracts parts in a specific timezone
 */
function getDatePartsInTimezone(date: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const partMap: Record<string, string> = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year: parseInt(partMap.year, 10),
    month: parseInt(partMap.month, 10), // 1-12
    day: parseInt(partMap.day, 10),
    hour: parseInt(partMap.hour === '24' ? '0' : partMap.hour, 10),
    minute: parseInt(partMap.minute, 10),
    second: parseInt(partMap.second, 10),
    weekday: weekdayMap[partMap.weekday] ?? 0,
  };
}

/**
 * Creates a UTC Date representing the specified wall-clock time in the given timezone
 */
function createDateInTimezone(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string
): Date {
  // Approximate with UTC first
  const pad = (n: number) => n.toString().padStart(2, '0');
  const targetIsoString = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;

  // Construct UTC timestamp
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  // Determine timezone offset difference
  const parts = getDatePartsInTimezone(guess, timezone);
  const guessAsLocalIso = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;

  const diffMs = new Date(targetIsoString + 'Z').getTime() - new Date(guessAsLocalIso + 'Z').getTime();
  guess = new Date(guess.getTime() + diffMs);

  return guess;
}

/**
 * Calculates occurrence start and end dates based on recurrence rules
 */
export function calculateOccurrences(params: {
  baseStartAt: Date | string;
  baseEndAt: Date | string;
  timezone?: string;
  rule: RecurrenceRuleInput;
}): OccurrenceScheduleItem[] {
  const startAt = new Date(params.baseStartAt);
  const endAt = new Date(params.baseEndAt);
  const timezone = params.timezone || 'Africa/Nairobi';
  const durationMs = endAt.getTime() - startAt.getTime();

  if (durationMs <= 0) {
    throw new Error('Event end time must be after the start time');
  }

  const interval = Math.max(1, Math.min(12, params.rule.interval || 1));
  const frequency = params.rule.frequency;
  const countLimit = params.rule.count
    ? Math.min(MAX_SAFE_OCCURRENCES, Math.max(1, params.rule.count))
    : MAX_SAFE_OCCURRENCES;

  const endDateLimit = params.rule.endDate ? new Date(params.rule.endDate) : null;

  const startParts = getDatePartsInTimezone(startAt, timezone);
  const occurrences: OccurrenceScheduleItem[] = [];

  // Occurrence #1 is always the base event
  occurrences.push({
    occurrenceIndex: 1,
    startAt,
    endAt,
  });

  if (countLimit <= 1) {
    return occurrences;
  }

  if (frequency === 'DAILY') {
    let currentDay = new Date(startAt.getTime());
    let index = 2;

    while (occurrences.length < countLimit) {
      // Advance by interval days
      currentDay = new Date(currentDay.getTime() + interval * 24 * 60 * 60 * 1000);
      const dayParts = getDatePartsInTimezone(currentDay, timezone);
      const nextStart = createDateInTimezone(
        dayParts.year,
        dayParts.month,
        dayParts.day,
        startParts.hour,
        startParts.minute,
        startParts.second,
        timezone
      );

      if (endDateLimit && nextStart.getTime() > endDateLimit.getTime()) {
        break;
      }

      occurrences.push({
        occurrenceIndex: index++,
        startAt: nextStart,
        endAt: new Date(nextStart.getTime() + durationMs),
      });
    }
  } else if (frequency === 'WEEKLY') {
    const rawByWeekday = params.rule.byWeekday && params.rule.byWeekday.length > 0
      ? [...new Set(params.rule.byWeekday)].sort((a, b) => a - b)
      : [startParts.weekday];

    // Weekly generation
    let weekOffset = 0;
    let index = 2;
    const baseWeekday = startParts.weekday;

    // Advance weeks until count or endDate reached
    while (occurrences.length < countLimit && weekOffset < 52 * interval) {
      for (const targetWeekday of rawByWeekday) {
        if (weekOffset === 0 && targetWeekday <= baseWeekday) {
          // Already handled or in past for week 0
          continue;
        }

        const daysToAdd = weekOffset * 7 + (targetWeekday - baseWeekday);
        const approxTarget = new Date(startAt.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
        const parts = getDatePartsInTimezone(approxTarget, timezone);

        const nextStart = createDateInTimezone(
          parts.year,
          parts.month,
          parts.day,
          startParts.hour,
          startParts.minute,
          startParts.second,
          timezone
        );

        if (endDateLimit && nextStart.getTime() > endDateLimit.getTime()) {
          return occurrences;
        }

        occurrences.push({
          occurrenceIndex: index++,
          startAt: nextStart,
          endAt: new Date(nextStart.getTime() + durationMs),
        });

        if (occurrences.length >= countLimit) {
          return occurrences;
        }
      }

      weekOffset += interval;
    }
  } else if (frequency === 'MONTHLY') {
    let index = 2;
    let monthOffset = interval;

    while (occurrences.length < countLimit && monthOffset < 120) {
      let targetMonth = startParts.month + monthOffset;
      let targetYear = startParts.year;

      while (targetMonth > 12) {
        targetMonth -= 12;
        targetYear += 1;
      }

      // Clamp day to maximum days in target month
      const daysInTargetMonth = new Date(targetYear, targetMonth, 0).getDate();
      const targetDay = Math.min(startParts.day, daysInTargetMonth);

      const nextStart = createDateInTimezone(
        targetYear,
        targetMonth,
        targetDay,
        startParts.hour,
        startParts.minute,
        startParts.second,
        timezone
      );

      if (endDateLimit && nextStart.getTime() > endDateLimit.getTime()) {
        break;
      }

      occurrences.push({
        occurrenceIndex: index++,
        startAt: nextStart,
        endAt: new Date(nextStart.getTime() + durationMs),
      });

      monthOffset += interval;
    }
  }

  return occurrences;
}

/**
 * Formats a clean date suffix for occurrence slugs, e.g. "2026-11-20"
 */
export function formatOccurrenceSlugSuffix(date: Date, timezone: string = 'Africa/Nairobi'): string {
  const parts = getDatePartsInTimezone(date, timezone);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/**
 * Formats a human-readable summary of the recurrence schedule
 */
export function formatRecurrenceSummary(
  rule: RecurrenceRuleInput,
  startDate?: Date,
  timezone: string = 'Africa/Nairobi'
): string {
  const interval = rule.interval || 1;
  const freq = rule.frequency;

  const weekdayNames = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
  let scheduleStr = '';

  if (freq === 'DAILY') {
    scheduleStr = interval === 1 ? 'Daily' : `Every ${interval} days`;
  } else if (freq === 'WEEKLY') {
    const days = (rule.byWeekday && rule.byWeekday.length > 0 ? rule.byWeekday : [startDate ? getDatePartsInTimezone(startDate, timezone).weekday : 5])
      .map((d) => weekdayNames[d])
      .join(', ');
    scheduleStr = interval === 1 ? `Weekly on ${days}` : `Every ${interval} weeks on ${days}`;
  } else if (freq === 'MONTHLY') {
    scheduleStr = interval === 1 ? 'Monthly' : `Every ${interval} months`;
  }

  if (rule.count) {
    scheduleStr += ` • ${rule.count} occurrences`;
  } else if (rule.endDate) {
    const end = new Date(rule.endDate);
    scheduleStr += ` • until ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  return scheduleStr;
}
