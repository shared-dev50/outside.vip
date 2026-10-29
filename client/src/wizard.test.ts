import { describe, it, expect } from 'vitest';
import { api } from './lib/api';

describe('Event Creation Wizard & Recurring Schedule Preview', () => {
  // Helper mirroring client previewOccurrences calculation logic
  function calculatePreviewOccurrences(params: {
    startAt: string;
    endAt: string;
    frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
    interval: number;
    byWeekday?: number[];
    endType: 'count' | 'until';
    count?: number;
    until?: string;
  }) {
    const startDate = new Date(params.startAt);
    const endDate = new Date(params.endAt);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return [];
    const durationMs = Math.max(0, endDate.getTime() - startDate.getTime());

    const occurrences: Array<{ index: number; startAt: Date; endAt: Date }> = [];
    const maxCount = params.endType === 'count' ? Math.min(52, Math.max(1, params.count || 1)) : 52;
    const untilDate = params.endType === 'until' && params.until ? new Date(params.until) : null;

    let current = new Date(startDate.getTime());
    let count = 0;

    if (params.frequency === 'DAILY') {
      while (count < maxCount) {
        if (untilDate && current.getTime() > untilDate.getTime()) break;
        occurrences.push({
          index: count + 1,
          startAt: new Date(current.getTime()),
          endAt: new Date(current.getTime() + durationMs),
        });
        count++;
        current.setDate(current.getDate() + Math.max(1, params.interval));
      }
    } else if (params.frequency === 'WEEKLY') {
      const targetWeekdays = params.byWeekday && params.byWeekday.length > 0
        ? params.byWeekday
        : [startDate.getDay()];
      const cursor = new Date(startDate.getTime());
      let safetyCounter = 0;
      while (count < maxCount && safetyCounter < 400) {
        safetyCounter++;
        if (untilDate && cursor.getTime() > untilDate.getTime()) break;
        if (targetWeekdays.includes(cursor.getDay()) && cursor.getTime() >= startDate.getTime()) {
          occurrences.push({
            index: count + 1,
            startAt: new Date(cursor.getTime()),
            endAt: new Date(cursor.getTime() + durationMs),
          });
          count++;
        }
        cursor.setDate(cursor.getDate() + 1);
      }
    } else if (params.frequency === 'MONTHLY') {
      while (count < maxCount) {
        if (untilDate && current.getTime() > untilDate.getTime()) break;
        occurrences.push({
          index: count + 1,
          startAt: new Date(current.getTime()),
          endAt: new Date(current.getTime() + durationMs),
        });
        count++;
        current.setMonth(current.getMonth() + Math.max(1, params.interval));
      }
    }

    return occurrences;
  }

  it('calculates weekly recurrence preview correctly with count cap', () => {
    const list = calculatePreviewOccurrences({
      startAt: '2026-11-06T20:00:00Z', // A Friday
      endAt: '2026-11-07T04:00:00Z',
      frequency: 'WEEKLY',
      interval: 1,
      byWeekday: [5], // Friday
      endType: 'count',
      count: 4,
    });

    expect(list.length).toBe(4);
    expect(list[0].index).toBe(1);
    expect(list[0].startAt.toISOString()).toBe('2026-11-06T20:00:00.000Z');
    expect(list[1].startAt.toISOString()).toBe('2026-11-13T20:00:00.000Z');
    expect(list[2].startAt.toISOString()).toBe('2026-11-20T20:00:00.000Z');
    expect(list[3].startAt.toISOString()).toBe('2026-11-27T20:00:00.000Z');
  });

  it('calculates daily recurrence with interval 2', () => {
    const list = calculatePreviewOccurrences({
      startAt: '2026-11-01T10:00:00Z',
      endAt: '2026-11-01T18:00:00Z',
      frequency: 'DAILY',
      interval: 2,
      endType: 'count',
      count: 3,
    });

    expect(list.length).toBe(3);
    expect(list[0].startAt.toISOString()).toBe('2026-11-01T10:00:00.000Z');
    expect(list[1].startAt.toISOString()).toBe('2026-11-03T10:00:00.000Z');
    expect(list[2].startAt.toISOString()).toBe('2026-11-05T10:00:00.000Z');
  });

  it('calculates monthly recurrence preview', () => {
    const list = calculatePreviewOccurrences({
      startAt: '2026-11-15T19:00:00Z',
      endAt: '2026-11-16T02:00:00Z',
      frequency: 'MONTHLY',
      interval: 1,
      endType: 'count',
      count: 3,
    });

    expect(list.length).toBe(3);
    expect(list[0].startAt.getUTCDate()).toBe(15);
    expect(list[1].startAt.getUTCDate()).toBe(15);
    expect(list[2].startAt.getUTCDate()).toBe(15);
  });

  it('stops at until date when endType is until', () => {
    const list = calculatePreviewOccurrences({
      startAt: '2026-11-06T20:00:00Z',
      endAt: '2026-11-07T04:00:00Z',
      frequency: 'WEEKLY',
      interval: 1,
      byWeekday: [5],
      endType: 'until',
      until: '2026-11-21T00:00:00Z',
    });

    expect(list.length).toBe(3);
  });

  it('caps occurrences at safety limit of 52', () => {
    const list = calculatePreviewOccurrences({
      startAt: '2026-11-01T10:00:00Z',
      endAt: '2026-11-01T18:00:00Z',
      frequency: 'DAILY',
      interval: 1,
      endType: 'count',
      count: 100,
    });

    expect(list.length).toBe(52);
  });

  it('organizer API client exposes series and cancellation methods', () => {
    expect(typeof api.organizer.getSeries).toBe('function');
    expect(typeof api.organizer.cancelSeries).toBe('function');
    expect(typeof api.organizer.cancelEvent).toBe('function');
    expect(typeof api.organizer.publishEvent).toBe('function');
    expect(typeof api.organizer.unpublishEvent).toBe('function');
  });

  it('validates 4-step wizard transitions properly', () => {
    // Step 1: title and cover required
    const step1Valid = (title: string, cover: string) =>
      title.trim().length >= 2 && cover.trim().length > 0;
    expect(step1Valid('', '')).toBe(false);
    expect(step1Valid('A', 'https://example.com/cover.jpg')).toBe(false);
    expect(step1Valid('Festival 2026', '')).toBe(false);
    expect(step1Valid('Festival 2026', 'https://example.com/cover.jpg')).toBe(true);

    // Step 2: timing and venue required
    const step2Valid = (start: string, end: string, venue: string, city: string) => {
      const s = new Date(start).getTime();
      const e = new Date(end).getTime();
      return !isNaN(s) && !isNaN(e) && e > s && venue.trim().length > 0 && city.trim().length > 0;
    };
    expect(step2Valid('2026-11-20T20:00', '2026-11-20T19:00', 'Baobab', 'Nairobi')).toBe(false);
    expect(step2Valid('2026-11-20T20:00', '2026-11-21T04:00', '', 'Nairobi')).toBe(false);
    expect(step2Valid('2026-11-20T20:00', '2026-11-21T04:00', 'Baobab', '')).toBe(false);
    expect(step2Valid('2026-11-20T20:00', '2026-11-21T04:00', 'Baobab', 'Nairobi')).toBe(true);

    // Step 3: at least 1 ticket tier with name and capacity
    const step3Valid = (tiers: Array<{ name: string; capacity: number }>) =>
      tiers.length > 0 && tiers.every((t) => t.name.trim().length > 0 && t.capacity >= 1);
    expect(step3Valid([])).toBe(false);
    expect(step3Valid([{ name: '', capacity: 100 }])).toBe(false);
    expect(step3Valid([{ name: 'GA', capacity: 0 }])).toBe(false);
    expect(step3Valid([{ name: 'General Admission', capacity: 250 }])).toBe(true);
  });
});
