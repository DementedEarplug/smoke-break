// Bounds on what a hub's data can make the pack do. `parseServerMsg` already
// keeps every string and number within limits that are generous for a real
// team (500 people, 64-character names, any time stamp). Within those limits a
// hostile or broken hub still chooses everything, so the pack bounds its own
// work too: how much it draws per frame, how big the bubble gets, and how far
// times it is given can move its clock. Kept free of DOM so it can be unit
// tested.

import type { Break, Participant } from '../../shared/protocol.ts';
import { wrap } from './font.ts';

/** Items (cigarettes, cups, ...) drawn for one break; more than fit anywhere. */
export const MAX_ITEMS = 24;
/** Items still animating out on top of those, before the oldest go at once. */
export const MAX_LEAVING_ITEMS = 24;
/** Smoke puffs and falling bits alive at once. */
export const MAX_PARTICLES = 160;
/** Characters per bubble line, and lines per bubble (the last one ends in "..."). */
export const BUBBLE_MAX_CHARS = 15;
export const BUBBLE_MAX_LINES = 6;
/** The pack's clock follows the hub's, but never by more than a week either way. */
export const MAX_CLOCK_OFFSET_MS = 7 * 24 * 60 * 60_000;
/** A promised call whose link hasn't come after this long isn't opened any more. */
export const LINK_WAIT_MS = 60_000;

/**
 * The participants to draw: the first `MAX_ITEMS`, always including me (so my
 * own cigarette can be lit and clicked however many people joined).
 */
export function shownParticipants(participants: Participant[], me: string, max = MAX_ITEMS): Participant[] {
  if (participants.length <= max) return participants;
  const shown = participants.slice(0, max);
  if (!shown.some((p) => p.id === me)) {
    const mine = participants.find((p) => p.id === me);
    if (mine) shown[max - 1] = mine;
  }
  return shown;
}

/** The bubble's lines: wrapped, and cut short (ending in "...") past `BUBBLE_MAX_LINES`. */
export function bubbleLines(text: string): string[] {
  const lines = wrap(text, BUBBLE_MAX_CHARS);
  if (lines.length <= BUBBLE_MAX_LINES) return lines;
  const kept = lines.slice(0, BUBBLE_MAX_LINES);
  const last = kept[BUBBLE_MAX_LINES - 1];
  kept[BUBBLE_MAX_LINES - 1] = `${last.slice(0, BUBBLE_MAX_CHARS - 3)}...`;
  return kept;
}

/**
 * Time left in a lit break: never negative, and never more than the whole
 * break, whatever `endsAt` (and the clock) say.
 */
export function timeLeft(b: Pick<Break, 'endsAt' | 'lengthMin' | 'minuteMs'>, now: number): number {
  if (b.endsAt === null) return 0;
  const left = b.endsAt - now;
  if (!Number.isFinite(left)) return 0;
  return Math.min(b.lengthMin * b.minuteMs, Math.max(0, left));
}

/**
 * serverTime - localTime from recent samples: the largest (it came through
 * fastest), held within `MAX_CLOCK_OFFSET_MS` so a hub sending absurd times
 * can't push the clock anywhere.
 */
export function clockOffset(samples: number[]): number {
  if (!samples.length) return 0;
  const best = Math.max(...samples);
  if (Number.isNaN(best)) return 0;
  return Math.min(MAX_CLOCK_OFFSET_MS, Math.max(-MAX_CLOCK_OFFSET_MS, best));
}
