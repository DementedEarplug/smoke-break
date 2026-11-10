import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./platform.ts', () => ({ serverProblem: () => null }));

const { Net, PENDING_RETRY_MS } = await import('./net.ts');

class FakeSocket {
  static OPEN = 1;
  static opened: string[] = [];
  readyState = 0;
  constructor(readonly url: string) {
    FakeSocket.opened.push(url);
  }
  send() {}
  close() {}
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeSocket.opened = [];
});

describe('Net', () => {
  it('only ever connects to the hub it was made for', () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const net = new Net('wss://hub.example/ws', () => ({ type: 'leave' }), () => {}, () => {});
    net.connect();
    expect(FakeSocket.opened).toEqual(['wss://hub.example/ws']);
  });

  it('asks again every 10-15 s while waiting for approval, without backing off', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const net = new Net('wss://hub.example/ws', () => ({ type: 'leave' }), () => {}, () => {});
    const delays: number[] = [];
    for (const r of [0, 1, 0.5, 0, 1, 0, 1, 0, 1, 0]) {
      vi.spyOn(Math, 'random').mockReturnValueOnce(r);
      expect(net.retryPending()).toBe(PENDING_RETRY_MS);
      delays.push(timeouts.mock.lastCall![1] as number);
    }
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(10_000);
      expect(d).toBeLessThanOrEqual(15_000);
    }
    // Steady: the tenth wait is no longer than the first.
    expect(delays[9]).toBe(delays[0]);
  });

  it('backs off on other refusals', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    const net = new Net('wss://hub.example/ws', () => ({ type: 'leave' }), () => {}, () => {});
    const first = net.retryLater();
    expect(net.retryLater()).toBe(first * 2);
  });
});
