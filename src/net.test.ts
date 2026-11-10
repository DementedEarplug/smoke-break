import { afterEach, describe, expect, it, vi } from 'vitest';
import { WS_PROTOCOL, tokenFromProtocols } from '../shared/protocol.ts';

vi.mock('./platform.ts', () => ({ serverProblem: () => null }));

const { BURST_CHARS, FLOOD_MESSAGE, MAX_MESSAGE_CHARS, Net, PENDING_RETRY_MS, STATE_EVERY_MS, protocolsFor } = await import('./net.ts');
const { MAX_CLOCK_OFFSET_MS } = await import('./widget/limits.ts');

class FakeSocket {
  static OPEN = 1;
  static opened: { url: string; protocols: string[] }[] = [];
  static last: FakeSocket;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[] = [],
  ) {
    FakeSocket.opened.push({ url, protocols });
    FakeSocket.last = this;
  }
  closed = false;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  /** The hub accepted the upgrade. */
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  /** The connection ended (before opening: refused or unreachable). */
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const hello = () => ({ type: 'hello' as const, teamCode: 'ABCDE23456', clientId: 'c'.repeat(24), name: 'Sam' });
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  // Restore spies first: a spy on a fake setTimeout would otherwise outlive the fake timers.
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeSocket.opened = [];
});

describe('Net', () => {
  it('only ever connects to the hub it was made for', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const net = new Net('wss://hub.example/ws', hello, () => {}, () => {});
    net.connect();
    await flush();
    expect(FakeSocket.opened.map((o) => o.url)).toEqual(['wss://hub.example/ws']);
  });

  it('offers just the protocol when there is no token', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const net = new Net('wss://hub.example/ws', hello, () => {}, () => {}, undefined, { token: async () => '' });
    net.connect();
    await flush();
    expect(FakeSocket.opened[0].protocols).toEqual([WS_PROTOCOL]);
    FakeSocket.last.open();
    expect(JSON.parse(FakeSocket.last.sent[0])).toEqual(hello());
  });

  it('offers the token as a subprotocol, protocol first, and still sends it in the hello', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const net = new Net('wss://hub.example/ws', hello, () => {}, () => {}, undefined, { token: async () => 'tøken-1' });
    net.connect();
    await flush();
    const { protocols } = FakeSocket.opened[0];
    // A hub that predates token subprotocols picks the first one it's offered.
    expect(protocols[0]).toBe(WS_PROTOCOL);
    expect(protocols).toHaveLength(2);
    expect(tokenFromProtocols(protocols)).toBe('tøken-1');
    FakeSocket.last.open();
    expect(JSON.parse(FakeSocket.last.sent[0])).toEqual({ ...hello(), token: 'tøken-1' });
  });

  it('reads the token again on every connect', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    let token = 'old';
    const net = new Net('wss://hub.example/ws', hello, () => {}, () => {}, undefined, { token: () => token });
    net.connect();
    await vi.advanceTimersByTimeAsync(0);
    token = 'new';
    FakeSocket.last.drop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.opened.map((o) => tokenFromProtocols(o.protocols))).toEqual(['old', 'new']);
  });

  it('opens nothing when closed while the token is being read', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    let release = (_: string) => {};
    const net = new Net('wss://hub.example/ws', hello, () => {}, () => {}, undefined, {
      token: () => new Promise<string>((r) => (release = r)),
    });
    net.connect();
    net.close();
    release('t');
    await flush();
    expect(FakeSocket.opened).toEqual([]);
  });

  it('builds the subprotocol list', () => {
    expect(protocolsFor('')).toEqual([WS_PROTOCOL]);
    expect(tokenFromProtocols(protocolsFor('abc'))).toBe('abc');
  });

  it('reports attempts that never open, and keeps backing off', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const failures: [number, boolean][] = [];
    const net = new Net('wss://hub.example/ws', hello, () => {}, () => {}, undefined, {
      token: async () => 'bad',
      onConnectFailed: (n, withToken) => failures.push([n, withToken]),
    });
    net.connect();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(0);
      FakeSocket.last.drop();
      delays.push(timeouts.mock.lastCall![1] as number);
      await vi.advanceTimersByTimeAsync(delays[i]);
    }
    expect(failures).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, true]));
    // A couple of quick retries, then slower and slower, up to a minute; never giving up.
    expect(delays.slice(0, 2)).toEqual([500, 1000]);
    expect(delays.slice(2)).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(FakeSocket.opened).toHaveLength(9);
    // Once one opens, the count starts over.
    FakeSocket.last.open();
    FakeSocket.last.drop();
    await vi.advanceTimersByTimeAsync(5000);
    FakeSocket.last.drop();
    expect(failures.at(-1)).toEqual([1, true]);
  });

  it('says whether a token was offered when an attempt fails', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const failures: boolean[] = [];
    const net = new Net('wss://hub.example/ws', hello, () => {}, () => {}, undefined, {
      onConnectFailed: (_, withToken) => failures.push(withToken),
    });
    net.connect();
    await flush();
    FakeSocket.last.drop();
    net.close();
    expect(failures).toEqual([false]);
  });

  it('asks again every 10-15 s while waiting for approval, without backing off', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const net = new Net('wss://hub.example/ws', hello, () => {}, () => {});
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
    const net = new Net('wss://hub.example/ws', hello, () => {}, () => {});
    const first = net.retryLater();
    expect(net.retryLater()).toBe(first * 2);
  });

  describe('against a hostile hub', () => {
    /** A valid state; `pad` makes it bigger (a field the app ignores). */
    const state = (serverNow: number, pad = '') =>
      JSON.stringify({
        type: 'state',
        you: 'me',
        serverNow,
        pad,
        team: {
          code: 'ABCDE23456',
          name: 'T',
          defaultLengthMin: 12,
          zoomLink: '',
          meetingProvider: 'fixed-link',
          ownerId: null,
          members: [],
          brk: null,
        },
      });

    async function connected() {
      vi.stubGlobal('WebSocket', FakeSocket);
      const got: { type: string; serverNow?: number; message?: string }[] = [];
      const statuses: string[] = [];
      const net = new Net('wss://hub.example/ws', hello, (m) => got.push(m), (s) => statuses.push(s));
      net.connect();
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
      else await flush();
      const socket = FakeSocket.last;
      socket.open();
      return { net, got, statuses, socket, deliver: (data: string) => socket.onmessage!({ data }) };
    }
    /** Lets a scheduled state be handled (no animation frames here). */
    const handled = () => new Promise((r) => setTimeout(r, STATE_EVERY_MS + 10));

    it("can't move the clock more than a week", async () => {
      const { net, got, deliver } = await connected();
      deliver(state(1e300));
      await handled();
      expect(got).toHaveLength(1);
      expect(net.now() - Date.now()).toBeLessThanOrEqual(MAX_CLOCK_OFFSET_MS + 1000);
      expect(Number.isFinite(net.now())).toBe(true);
      net.close();
      const again = await connected();
      again.deliver(state(0));
      await handled();
      expect(Date.now() - again.net.now()).toBeLessThanOrEqual(MAX_CLOCK_OFFSET_MS + 1000);
      again.net.close();
    });

    it("doesn't even parse a message bigger than any real one", async () => {
      const { net, got, deliver } = await connected();
      const parse = vi.spyOn(JSON, 'parse');
      deliver(state(Date.now(), 'x'.repeat(MAX_MESSAGE_CHARS)));
      await handled();
      expect(parse).not.toHaveBeenCalled();
      expect(got).toEqual([]);
      // A real-sized one still goes through.
      deliver(state(Date.now()));
      await handled();
      expect(got).toHaveLength(1);
      net.close();
    });

    it('parses and handles only the newest of many states that come at once', async () => {
      vi.useFakeTimers();
      const { net, got, deliver } = await connected();
      const parse = vi.spyOn(JSON, 'parse');
      for (let i = 1; i <= 1000; i++) deliver(state(Date.now() + i));
      expect(got).toEqual([]);
      await vi.advanceTimersByTimeAsync(STATE_EVERY_MS);
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ type: 'state', serverNow: Date.now() - STATE_EVERY_MS + 1000 });
      expect(parse).toHaveBeenCalledTimes(1);
      // Nothing more is pending.
      await vi.advanceTimersByTimeAsync(STATE_EVERY_MS * 4);
      expect(got).toHaveLength(1);
      net.close();
    });

    it('handles states once per animation frame where there are frames', async () => {
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
      vi.stubGlobal('cancelAnimationFrame', () => {});
      const { net, got, deliver } = await connected();
      for (let i = 0; i < 100; i++) deliver(state(Date.now()));
      expect(frames).toHaveLength(1);
      frames.shift()!(0);
      expect(got).toHaveLength(1);
      net.close();
    });

    it('still delivers every error, in order and at once, between states', async () => {
      vi.useFakeTimers();
      const { net, got, deliver } = await connected();
      const error = (message: string) => JSON.stringify({ type: 'error', message });
      deliver(state(1));
      deliver(error('first'));
      deliver(state(2));
      deliver(error('second'));
      deliver(state(3));
      expect(got.map((m) => m.message)).toEqual(['first', 'second']);
      await vi.advanceTimersByTimeAsync(STATE_EVERY_MS);
      expect(got.map((m) => m.message ?? m.serverNow)).toEqual(['first', 'second', 3]);
      net.close();
    });

    it('handles a state that doesn’t look like one until parsed the same way', async () => {
      vi.useFakeTimers();
      const { net, got, deliver } = await connected();
      for (let i = 1; i <= 50; i++) deliver(` ${state(i)}`);
      await vi.advanceTimersByTimeAsync(STATE_EVERY_MS);
      expect(got.map((m) => m.serverNow)).toEqual([50]);
      net.close();
    });

    it('drops a state not handled yet when the connection is closed, and handles it when the hub hangs up', async () => {
      vi.useFakeTimers();
      const first = await connected();
      first.deliver(state(1));
      first.net.close();
      await vi.advanceTimersByTimeAsync(STATE_EVERY_MS);
      expect(first.got).toEqual([]);
      const second = await connected();
      second.deliver(state(2));
      second.socket.drop();
      expect(second.got.map((m) => m.serverNow)).toEqual([2]);
      second.net.close();
    });

    it('hangs up on a hub that sends more than its budget, says so, and reconnects with the usual backoff', async () => {
      vi.useFakeTimers();
      const { net, got, statuses, socket, deliver } = await connected();
      const big = state(Date.now(), 'x'.repeat(MAX_MESSAGE_CHARS - 1000));
      const n = Math.ceil(BURST_CHARS / big.length) + 1;
      for (let i = 0; i < n && !socket.closed; i++) deliver(big);
      expect(socket.closed).toBe(true);
      expect(statuses.at(-1)).toBe('closed');
      expect(got).toEqual([{ type: 'error', message: FLOOD_MESSAGE }]);
      // What is left of that connection is ignored, and nothing is handled late.
      deliver(state(Date.now()));
      await vi.advanceTimersByTimeAsync(STATE_EVERY_MS);
      expect(got).toHaveLength(1);
      // The usual quick reconnect.
      await vi.advanceTimersByTimeAsync(1000);
      expect(FakeSocket.opened).toHaveLength(2);
      net.close();
    });

    it('lets a hub send at a real hub’s pace for as long as it likes', async () => {
      vi.useFakeTimers();
      const { net, got, socket, deliver } = await connected();
      // A full-size state 6 times a second (one every broadcast interval) is
      // more than a real hub sends one app; it stays connected.
      const big = state(Date.now(), 'x'.repeat(500_000));
      for (let i = 0; i < 60; i++) {
        deliver(big);
        await vi.advanceTimersByTimeAsync(150);
      }
      expect(socket.closed).toBe(false);
      expect(got.length).toBeGreaterThan(50);
      net.close();
    });
  });
});
