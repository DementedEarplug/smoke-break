// The scene against a hostile hub: however many people a break has and however
// fast they change, the work per frame stays bounded.

import { describe, expect, it } from 'vitest';
import type { Break, Participant } from '../../shared/protocol.ts';
import { MAX_ITEMS, MAX_LEAVING_ITEMS, MAX_PARTICLES } from './limits.ts';
import { Scene, type SceneInput } from './scene.ts';
import { LIGHTER_SKINS, PACK_SKINS } from './skins.ts';
import { THEMES } from './theme.ts';

/** A 2D context that draws nothing. */
const ctx = new Proxy({} as Record<string | symbol, unknown>, {
  get: (t, k) => (k in t ? t[k] : () => {}),
  set: (t, k, v) => ((t[k] = v), true),
}) as unknown as CanvasRenderingContext2D;

const people = (n: number, prefix = 'p'): Participant[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, name: 'N'.repeat(64), joinedAt: 0, litAt: 1 }));

const brk = (participants: Participant[]): Break => ({
  id: 'b',
  phase: 'lit',
  startedBy: participants[0]?.id ?? '',
  startedByName: 'S',
  lengthMin: 15,
  minuteMs: 100,
  createdAt: 0,
  pendingExpiresAt: null,
  litAt: 1,
  endsAt: 1e300,
  outAt: null,
  outReason: null,
  participants,
  meetingRequested: false,
  meetingUrl: null,
});

const input = (b: Break, theme: SceneInput['theme']): SceneInput => ({
  brk: b,
  me: 'p499',
  dnd: false,
  now: 0,
  flickAt: null,
  packSkin: PACK_SKINS[0],
  lighterSkin: LIGHTER_SKINS[0],
  theme,
});

describe('Scene', () => {
  it.each(THEMES.map((t) => t.id))('draws a bounded number of items and particles for a 500-person break (%s)', (theme) => {
    const scene = new Scene(ctx);
    for (let frame = 0; frame < 600; frame++) {
      // Everyone swapped out for new people on every frame.
      const i = input(brk(people(500, `f${frame}-`)), theme);
      if (frame % 2) i.brk!.participants.push(people(500)[499]);
      scene.update(i, 1 / 60);
      scene.draw(i);
      expect(scene.items.size).toBeLessThanOrEqual(MAX_ITEMS + MAX_LEAVING_ITEMS);
      expect(scene['particles'].length).toBeLessThanOrEqual(MAX_PARTICLES);
    }
  });

  it('keeps my own item among those drawn, and the timer within the break', () => {
    const scene = new Scene(ctx);
    const i = input(brk(people(500)), 'smoke');
    scene.update(i, 1 / 60);
    expect(scene.items.has('p499')).toBe(true);
    expect(scene.remainingMs).toBe(15 * 100);
    expect(scene.burnFrac).toBe(1);
  });
});
