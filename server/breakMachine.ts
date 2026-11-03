// Pure break state machine: idle (null) → pending → lighter → lit → out → idle.
// Every function takes the current break and returns the next one plus side
// effects for the caller to run, so it can be tested without timers or sockets.

import {
  type Break,
  type OutReason,
  MINUTE_MS,
  OUT_LINGER_MS,
  PENDING_TIMEOUT_MIN,
  clampLength,
} from '../shared/protocol.ts';

export type Effect = { type: 'meeting:start' } | { type: 'meeting:end' };

export interface Result {
  brk: Break | null;
  effects: Effect[];
  error?: string;
}

export interface Who {
  id: string;
  name: string;
}

const ok = (brk: Break | null, effects: Effect[] = []): Result => ({ brk, effects });
const fail = (brk: Break | null, error: string): Result => ({ brk, effects: [], error });

export const isActive = (brk: Break | null): brk is Break => !!brk && brk.phase !== 'out';

function toOut(b: Break, reason: OutReason, now: number): Result {
  b.phase = 'out';
  b.outAt = now;
  b.outReason = reason;
  b.pendingExpiresAt = null;
  return ok(b, b.meetingRequested ? [{ type: 'meeting:end' }] : []);
}

export function invite(
  brk: Break | null,
  who: Who,
  lengthMin: number,
  now: number,
  id: string,
  minuteMs = MINUTE_MS,
): Result {
  if (isActive(brk)) return join(brk, who, now);
  return ok({
    id,
    phase: 'pending',
    startedBy: who.id,
    startedByName: who.name,
    lengthMin: clampLength(lengthMin),
    minuteMs,
    createdAt: now,
    pendingExpiresAt: now + PENDING_TIMEOUT_MIN * minuteMs,
    litAt: null,
    endsAt: null,
    outAt: null,
    outReason: null,
    participants: [{ id: who.id, name: who.name, joinedAt: now, litAt: null }],
    meetingRequested: false,
    meetingUrl: null,
  });
}

export function setLength(brk: Break | null, whoId: string, lengthMin: number): Result {
  if (!brk || brk.startedBy !== whoId) return fail(brk, 'Only whoever started the break can change its length.');
  if (brk.phase !== 'pending' || brk.participants.length > 1) {
    return fail(brk, 'The length is locked once someone joins.');
  }
  return ok({ ...brk, lengthMin: clampLength(lengthMin) });
}

/** Join a break. `light` joins and lights in one step (late joiners). */
export function join(brk: Break | null, who: Who, now: number, light = false): Result {
  if (!isActive(brk)) return fail(brk, 'There is no break to join.');
  if (brk.participants.some((p) => p.id === who.id)) {
    return light ? lightUp(brk, who.id, now) : ok(brk);
  }
  const b = structuredClone(brk);
  b.participants.push({ id: who.id, name: who.name, joinedAt: now, litAt: null });
  const effects: Effect[] = [];
  if (b.phase === 'pending' && b.participants.length >= 2) {
    b.phase = 'lighter';
    b.pendingExpiresAt = null;
    if (!b.meetingRequested) {
      b.meetingRequested = true;
      effects.push({ type: 'meeting:start' });
    }
  }
  if (!light) return ok(b, effects);
  const lit = lightUp(b, who.id, now);
  return { ...lit, effects: [...effects, ...lit.effects] };
}

export function lightUp(brk: Break | null, whoId: string, now: number): Result {
  if (!isActive(brk)) return fail(brk, 'There is no break to light.');
  if (brk.phase === 'pending') return fail(brk, 'Wait for someone to join first.');
  const idx = brk.participants.findIndex((p) => p.id === whoId);
  if (idx < 0) return fail(brk, 'Join the break first.');
  if (brk.participants[idx].litAt !== null) return ok(brk);
  const b = structuredClone(brk);
  b.participants[idx].litAt = now;
  if (b.phase === 'lighter') {
    b.phase = 'lit';
    b.litAt = now;
    b.endsAt = now + b.lengthMin * b.minuteMs;
  }
  return ok(b);
}

/** Stub out early, or put an unlit cigarette back in the pack. */
export function leave(brk: Break | null, whoId: string, now: number): Result {
  if (!isActive(brk) || !brk.participants.some((p) => p.id === whoId)) return ok(brk);
  const b = structuredClone(brk);
  b.participants = b.participants.filter((p) => p.id !== whoId);
  if (b.participants.length === 0) {
    return toOut(b, b.phase === 'lit' ? 'everyone-left' : 'cancelled', now);
  }
  if (b.phase === 'lighter' && b.participants.length < 2) {
    b.phase = 'pending';
    b.pendingExpiresAt = now + PENDING_TIMEOUT_MIN * b.minuteMs;
  }
  return ok(b);
}

/** Advance time-based transitions. */
export function tick(brk: Break | null, now: number): Result {
  if (!brk) return ok(null);
  if (brk.phase === 'pending' && brk.pendingExpiresAt !== null && now >= brk.pendingExpiresAt) {
    return toOut(structuredClone(brk), 'nobody', now);
  }
  if (brk.phase === 'lit' && brk.endsAt !== null && now >= brk.endsAt) {
    return toOut(structuredClone(brk), 'burned', now);
  }
  if (brk.phase === 'out' && brk.outAt !== null && now >= brk.outAt + OUT_LINGER_MS) {
    return ok(null);
  }
  return ok(brk);
}

export function nextDeadline(brk: Break | null): number | null {
  if (!brk) return null;
  switch (brk.phase) {
    case 'pending':
      return brk.pendingExpiresAt;
    case 'lit':
      return brk.endsAt;
    case 'out':
      return brk.outAt === null ? null : brk.outAt + OUT_LINGER_MS;
    default:
      return null;
  }
}
