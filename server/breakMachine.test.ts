import { describe, expect, it } from 'vitest';
import { MINUTE_MS, OUT_LINGER_MS, PENDING_TIMEOUT_MIN } from '../shared/protocol.ts';

const PENDING_TIMEOUT_MS = PENDING_TIMEOUT_MIN * MINUTE_MS;
import { invite, join, leave, lightUp, nextDeadline, setLength, tick } from './breakMachine.ts';

const alex = { id: 'a', name: 'Alex' };
const sam = { id: 's', name: 'Sam' };
const kim = { id: 'k', name: 'Kim' };
const T = 1_000_000;

function litBreak() {
  let r = invite(null, alex, 12, T, 'b1');
  r = join(r.brk, sam, T + 1);
  r = lightUp(r.brk, 'a', T + 2);
  return r.brk!;
}

describe('break machine', () => {
  it('invite creates a pending break with the default length, clamped to 10–15', () => {
    expect(invite(null, alex, 12, T, 'b1').brk).toMatchObject({ phase: 'pending', lengthMin: 12 });
    expect(invite(null, alex, 20, T, 'b1').brk!.lengthMin).toBe(15);
    expect(invite(null, alex, 3, T, 'b1').brk!.lengthMin).toBe(10);
  });

  it('demo mode scales every timer by the minute length', () => {
    let r = invite(null, alex, 12, T, 'b1', 1000);
    expect(r.brk!.pendingExpiresAt).toBe(T + PENDING_TIMEOUT_MIN * 1000);
    r = join(r.brk, sam, T);
    expect(lightUp(r.brk, 'a', T).brk!.endsAt).toBe(T + 12 * 1000);
  });

  it('only the starter can change the length, and only before anyone joins', () => {
    const pending = invite(null, alex, 12, T, 'b1').brk;
    expect(setLength(pending, 'a', 14).brk!.lengthMin).toBe(14);
    expect(setLength(pending, 's', 14).error).toBeDefined();
    const joined = join(pending, sam, T).brk;
    expect(setLength(joined, 'a', 14).error).toBeDefined();
  });

  it('a second person moves the break to the lighter and requests a meeting once', () => {
    const r = join(invite(null, alex, 12, T, 'b1').brk, sam, T + 1);
    expect(r.brk!.phase).toBe('lighter');
    expect(r.effects).toEqual([{ type: 'meeting:start' }]);
    expect(join(r.brk, kim, T + 2).effects).toEqual([]);
  });

  it('cannot light with one cigarette', () => {
    expect(lightUp(invite(null, alex, 12, T, 'b1').brk, 'a', T).error).toBeDefined();
  });

  it('first light starts the server timer for the chosen length', () => {
    const brk = litBreak();
    expect(brk.phase).toBe('lit');
    expect(brk.endsAt).toBe(T + 2 + 12 * 60_000);
    expect(nextDeadline(brk)).toBe(brk.endsAt);
  });

  it('late joiners can join and light in one step without moving the timer', () => {
    const brk = litBreak();
    const r = join(brk, kim, T + 60_000, true);
    expect(r.brk!.participants.find((p) => p.id === 'k')!.litAt).toBe(T + 60_000);
    expect(r.brk!.endsAt).toBe(brk.endsAt);
  });

  it('nobody joins: pending expires to "nobody", then back to idle', () => {
    const pending = invite(null, alex, 12, T, 'b1').brk;
    expect(tick(pending, T + PENDING_TIMEOUT_MS - 1).brk!.phase).toBe('pending');
    const out = tick(pending, T + PENDING_TIMEOUT_MS).brk!;
    expect(out).toMatchObject({ phase: 'out', outReason: 'nobody' });
    expect(tick(out, out.outAt! + OUT_LINGER_MS).brk).toBeNull();
  });

  it('burning down ends the break and the meeting', () => {
    const brk = litBreak();
    const r = tick(brk, brk.endsAt!);
    expect(r.brk).toMatchObject({ phase: 'out', outReason: 'burned' });
    expect(r.effects).toEqual([{ type: 'meeting:end' }]);
  });

  it('leaving early keeps the break going for everyone else', () => {
    const r = leave(litBreak(), 'a', T + 10);
    expect(r.brk!.phase).toBe('lit');
    expect(r.brk!.participants.map((p) => p.id)).toEqual(['s']);
    expect(leave(r.brk, 's', T + 11).brk).toMatchObject({ phase: 'out', outReason: 'everyone-left' });
  });

  it('dropping below two at the lighter goes back to pending', () => {
    const lighter = join(invite(null, alex, 12, T, 'b1').brk, sam, T).brk;
    const r = leave(lighter, 's', T + 5);
    expect(r.brk).toMatchObject({ phase: 'pending', pendingExpiresAt: T + 5 + PENDING_TIMEOUT_MS });
  });

  it('the starter putting their cigarette back cancels a pending break', () => {
    const r = leave(invite(null, alex, 12, T, 'b1').brk, 'a', T + 5);
    expect(r.brk).toMatchObject({ phase: 'out', outReason: 'cancelled' });
    expect(r.effects).toEqual([]);
  });

  it('clicking the pack during an active break joins instead of starting a new one', () => {
    const pending = invite(null, alex, 12, T, 'b1').brk;
    const r = invite(pending, sam, 12, T + 1, 'b2');
    expect(r.brk!.id).toBe('b1');
    expect(r.brk!.participants).toHaveLength(2);
  });
});
