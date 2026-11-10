import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMsg, ServerMsg } from '../shared/protocol.ts';

// The real platform module reads `window`; the session only needs these bits.
// Saved teams are per hub, like the real thing.
const HUB = 'wss://hub.example/ws';
const saved = new Map<string, string>();
const tokenHubs: string[] = [];
vi.mock('./platform.ts', () => ({
  currentHub: () => 'wss://other.example/ws',
  savedTeam: (hub: string) => saved.get(hub) ?? '',
  saveTeam: (c: string, hub: string) => saved.set(hub, c),
  leaveTeam: (hub: string) => saved.delete(hub),
  withToken: async <T extends object>(m: T, hub: string) => {
    tokenHubs.push(hub);
    return { ...m, token: `tok for ${hub}` };
  },
}));

/** A stand-in for Net that lets the test play the hub. */
const fake = vi.hoisted(() => ({
  url: '',
  hello: null as null | (() => Promise<unknown>),
  deliver: null as null | ((m: unknown) => void),
  closed: 0,
  retried: 0,
  pendingRetries: 0,
}));
vi.mock('./net.ts', () => ({
  Net: class {
    constructor(url: string, hello: () => Promise<unknown>, onMessage: (m: unknown) => void) {
      fake.url = url;
      fake.hello = hello;
      fake.deliver = onMessage;
    }
    close() {
      fake.closed++;
    }
    retryLater() {
      fake.retried++;
      return 15_000;
    }
    retryPending() {
      fake.pendingRetries++;
      return 12_500;
    }
  },
}));

const { createSession } = await import('./session.ts');

const team = (code: string) => ({
  code,
  name: 'T',
  defaultLengthMin: 12,
  zoomLink: '',
  hasZoomLink: false,
  meetingProvider: 'fixed-link' as const,
  ownerId: null,
  members: [],
  requireApproval: false,
  pending: [],
  brk: null,
});

function setup(first: ClientMsg = { type: 'hello', teamCode: 'OLDCODE234', clientId: 'c'.repeat(24), name: 'Sam' }) {
  const h = { onTeam: vi.fn(), onError: vi.fn(), onFatal: vi.fn(), onRetrying: vi.fn(), onPending: vi.fn() };
  createSession(first as never, h, HUB);
  const deliver = (m: ServerMsg) => fake.deliver!(m);
  return { h, deliver };
}

beforeEach(() => {
  saved.clear();
  saved.set(HUB, 'OLDCODE234');
  saved.set('wss://other.example/ws', 'OTHERTEAM2');
  tokenHubs.length = 0;
  fake.closed = 0;
  fake.retried = 0;
  fake.pendingRetries = 0;
});

describe('session fatal errors', () => {
  it.each(['bad-code', 'removed', 'denied'] as const)('forgets the team on %s and stops', (code) => {
    const { h, deliver } = setup();
    deliver({ type: 'error', message: 'gone', fatal: true, code });
    expect(h.onFatal).toHaveBeenCalledWith('gone', true, code);
    expect(fake.closed).toBe(1);
    expect(fake.retried).toBe(0);
    expect(fake.pendingRetries).toBe(0);
    // Only this hub's saved team goes.
    expect(saved.has(HUB)).toBe(false);
    expect(saved.get('wss://other.example/ws')).toBe('OTHERTEAM2');
  });

  it("doesn't drop a different saved team when a typed-in code is refused", () => {
    const { h, deliver } = setup({ type: 'hello', teamCode: 'TYPEDCODE2', clientId: 'c'.repeat(24), name: 'Sam' });
    deliver({ type: 'error', message: 'no such team', fatal: true, code: 'bad-code' });
    expect(h.onFatal).toHaveBeenCalledWith('no such team', true, 'bad-code');
    expect(saved.get(HUB)).toBe('OLDCODE234');
  });

  it.each(['rate-limited', 'full', 'unauthorized', undefined] as const)('keeps the team and backs off on %s', (code) => {
    const { h, deliver } = setup();
    deliver({ type: 'error', message: 'later', fatal: true, code });
    expect(h.onFatal).not.toHaveBeenCalled();
    expect(h.onRetrying).toHaveBeenCalledWith('later', code, 15_000);
    expect(fake.retried).toBe(1);
  });

  it("doesn't keep retrying a refused create", () => {
    const { h, deliver } = setup({ type: 'create', teamName: 'T', clientId: 'c'.repeat(24), name: 'Sam' });
    deliver({ type: 'error', message: 'full', fatal: true, code: 'full' });
    expect(h.onFatal).toHaveBeenCalledWith('full', false, 'full');
    expect(fake.retried).toBe(0);
  });

  it('waits for approval with a steady retry and keeps the team', () => {
    const { h, deliver } = setup({ type: 'hello', teamCode: 'NEWTEAM234', clientId: 'c'.repeat(24), name: 'Sam' });
    for (let i = 0; i < 5; i++) deliver({ type: 'error', message: 'wait', fatal: true, code: 'pending' });
    expect(h.onPending).toHaveBeenCalledWith('wait', 12_500);
    expect(h.onPending).toHaveBeenCalledTimes(5);
    expect(fake.pendingRetries).toBe(5);
    // Not the growing backoff, and not given up.
    expect(fake.retried).toBe(0);
    expect(h.onFatal).not.toHaveBeenCalled();
    expect(h.onRetrying).not.toHaveBeenCalled();
    // Saved, so a restart keeps waiting for the same team.
    expect(saved.get(HUB)).toBe('NEWTEAM234');
  });

  it('stops for good when the owner says no after a wait', () => {
    const { h, deliver } = setup({ type: 'hello', teamCode: 'NEWTEAM234', clientId: 'c'.repeat(24), name: 'Sam' });
    deliver({ type: 'error', message: 'wait', fatal: true, code: 'pending' });
    deliver({ type: 'error', message: 'no', fatal: true, code: 'denied' });
    expect(h.onFatal).toHaveBeenCalledWith('no', true, 'denied');
    expect(fake.closed).toBe(1);
    expect(saved.has(HUB)).toBe(false);
  });

  it('carries on once let in', () => {
    const { h, deliver } = setup({ type: 'hello', teamCode: 'NEWTEAM234', clientId: 'c'.repeat(24), name: 'Sam' });
    deliver({ type: 'error', message: 'wait', fatal: true, code: 'pending' });
    deliver({ type: 'state', team: team('NEWTEAM234'), you: 'me', serverNow: 1 });
    expect(h.onTeam).toHaveBeenCalled();
    expect(saved.get(HUB)).toBe('NEWTEAM234');
  });

  it('passes non-fatal errors through', () => {
    const { h, deliver } = setup();
    deliver({ type: 'error', message: 'nope' });
    expect(h.onError).toHaveBeenCalledWith('nope');
  });
});

describe('session hello', () => {
  it('talks only to the hub its identity is for, with that hub\'s token', async () => {
    setup();
    expect(fake.url).toBe(HUB);
    await expect(fake.hello!()).resolves.toMatchObject({ type: 'hello', teamCode: 'OLDCODE234', token: `tok for ${HUB}` });
    expect(tokenHubs).toEqual([HUB]);
  });

  it('rejoins by the new code after the owner replaces it', async () => {
    const { deliver } = setup();
    deliver({ type: 'state', team: team('NEWCODE234'), you: 'me', serverNow: 1 });
    expect(saved.get(HUB)).toBe('NEWCODE234');
    expect(saved.get('wss://other.example/ws')).toBe('OTHERTEAM2');
    await expect(fake.hello!()).resolves.toMatchObject({ type: 'hello', teamCode: 'NEWCODE234' });
  });
});
