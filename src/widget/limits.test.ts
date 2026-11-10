import { describe, expect, it } from 'vitest';
import type { Participant } from '../../shared/protocol.ts';
import {
  BUBBLE_MAX_CHARS,
  BUBBLE_MAX_LINES,
  MAX_CLOCK_OFFSET_MS,
  MAX_ITEMS,
  bubbleLines,
  clockOffset,
  shownParticipants,
  timeLeft,
} from './limits.ts';

const people = (n: number): Participant[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, joinedAt: i, litAt: null }));

describe('shownParticipants', () => {
  it('draws everyone in a real-sized break', () => {
    const list = people(MAX_ITEMS);
    expect(shownParticipants(list, 'p3')).toBe(list);
  });

  it('draws at most MAX_ITEMS of a huge one, me always among them', () => {
    const list = people(500);
    expect(shownParticipants(list, 'p1')).toHaveLength(MAX_ITEMS);
    const shown = shownParticipants(list, 'p499');
    expect(shown).toHaveLength(MAX_ITEMS);
    expect(shown.some((p) => p.id === 'p499')).toBe(true);
    expect(shownParticipants(list, 'not-in-it')).toHaveLength(MAX_ITEMS);
  });
});

describe('bubbleLines', () => {
  it('wraps short text as before', () => {
    expect(bubbleLines('Waiting for takers...')).toEqual(['WAITING FOR', 'TAKERS...']);
  });

  it('keeps any text the hub sends to a few short lines', () => {
    for (const text of ['x'.repeat(500), 'word '.repeat(100), `${'N'.repeat(64)} & ${'M'.repeat(64)} are heading out. Click to join`]) {
      const lines = bubbleLines(text);
      expect(lines.length).toBeLessThanOrEqual(BUBBLE_MAX_LINES);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(BUBBLE_MAX_CHARS);
      expect(lines.at(-1)).toMatch(/\.\.\.$/);
    }
  });
});

describe('timeLeft', () => {
  const b = { lengthMin: 12, minuteMs: 60_000, endsAt: 1_000_000 };

  it('is the time to endsAt', () => expect(timeLeft(b, 1_000_000 - 5_000)).toBe(5_000));

  it('is never negative nor longer than the break', () => {
    expect(timeLeft(b, 2_000_000)).toBe(0);
    expect(timeLeft({ ...b, endsAt: Number.MAX_VALUE }, 0)).toBe(12 * 60_000);
    expect(timeLeft({ ...b, endsAt: 1e300 }, -1e300)).toBe(12 * 60_000);
    expect(timeLeft({ ...b, endsAt: null }, 0)).toBe(0);
    expect(timeLeft(b, Number.NaN)).toBe(0);
  });
});

describe('clockOffset', () => {
  it('takes the largest sample', () => expect(clockOffset([-20, 150, 30])).toBe(150));

  it('never moves the clock more than a week, whatever the hub says', () => {
    expect(clockOffset([1e300 - Date.now()])).toBe(MAX_CLOCK_OFFSET_MS);
    expect(clockOffset([0 - Date.now()])).toBe(-MAX_CLOCK_OFFSET_MS);
    expect(clockOffset([])).toBe(0);
    expect(clockOffset([Number.NaN])).toBe(0);
  });
});
