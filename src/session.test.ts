import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMsg, ServerMsg } from '../shared/protocol.ts';

// The real platform module reads `window`; the session only needs these bits.
const saved = { team: 'OLDCODE234' };
vi.mock('./platform.ts', () => ({
  savedTeam: () => saved.team,
  saveTeam: (c: string) => (saved.team = c),
  withToken: <T extends object>(m: T) => ({ ...m, token: 'tok' }),
}));

/** A stand-in for Net that lets the test play the hub. */
const fake = vi.hoisted(() => ({
  hello: null as null | (() => unknown),
  deliver: null as null | ((m: unknown) => void),
  closed: 0,
  retried: 0,
}));
vi.mock('./net.ts', () => ({
  Net: class {
    constructor(hello: () => unknown, onMessage: (m: unknown) => void) {
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
  brk: null,
});

function setup(first: ClientMsg = { type: 'hello', teamCode: 'OLDCODE234', clientId: 'c'.repeat(24), name: 'Sam' }) {
  const h = { onTeam: vi.fn(), onError: vi.fn(), onFatal: vi.fn(), onRetrying: vi.fn() };
  createSession(first as never, h);
  const deliver = (m: ServerMsg) => fake.deliver!(m);
  return { h, deliver };
}

beforeEach(() => {
  saved.team = 'OLDCODE234';
  fake.closed = 0;
  fake.retried = 0;
});

describe('session fatal errors', () => {
  it.each(['bad-code', 'removed'] as const)('forgets the team on %s', (code) => {
    const { h, deliver } = setup();
    deliver({ type: 'error', message: 'gone', fatal: true, code });
    expect(h.onFatal).toHaveBeenCalledWith('gone', true, code);
    expect(fake.closed).toBe(1);
    expect(fake.retried).toBe(0);
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

  it('passes non-fatal errors through', () => {
    const { h, deliver } = setup();
    deliver({ type: 'error', message: 'nope' });
    expect(h.onError).toHaveBeenCalledWith('nope');
  });
});

describe('session hello', () => {
  it('sends the access token', () => {
    setup();
    expect(fake.hello!()).toMatchObject({ type: 'hello', teamCode: 'OLDCODE234', token: 'tok' });
  });

  it('rejoins by the new code after the owner replaces it', () => {
    const { deliver } = setup();
    deliver({ type: 'state', team: team('NEWCODE234'), you: 'me', serverNow: 1 });
    expect(saved.team).toBe('NEWCODE234');
    expect(fake.hello!()).toMatchObject({ type: 'hello', teamCode: 'NEWCODE234', token: 'tok' });
  });
});
