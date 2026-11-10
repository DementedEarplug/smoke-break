// WebSocket client with auto-reconnect and a server-synced clock.

import { type ClientMsg, type ServerMsg, WS_PROTOCOL, parseServerMsg, tokenProtocol } from '../shared/protocol.ts';
import { serverProblem } from './platform.ts';
import { clockOffset } from './widget/limits.ts';

export type NetStatus = 'connecting' | 'open' | 'closed';

const CLOCK_SAMPLES = 20;
/**
 * The largest message a real hub sends (a full team of 500 with a waiting
 * list as long, at the protocol's limits) is well under half of this; anything
 * bigger isn't even parsed.
 */
export const MAX_MESSAGE_CHARS = 2_000_000;
/** Reconnect delays after a dropped connection. */
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 5000;
/**
 * Delays after the hub refused us (rate limit, full, wrong access token).
 * Much slower, so a refused app doesn't keep the hub's limits topped up.
 */
const REFUSED_MIN_MS = 15_000;
const REFUSED_MAX_MS = 5 * 60_000;
/**
 * Waiting for the team owner to let us in: ask again at a steady pace (10-15 s
 * with the jitter in `schedule`), not a growing one, so the wait ends soon
 * after they click Allow.
 */
export const PENDING_RETRY_MS = 12_500;
/**
 * A hub that refuses the WebSocket upgrade (a missing or wrong access token)
 * looks exactly like one that can't be reached. After this many attempts in a
 * row that never opened, reconnects slow down to `UNREACHABLE_*`.
 */
const FAST_FAILURES = 3;
const UNREACHABLE_MIN_MS = 10_000;
const UNREACHABLE_MAX_MS = 60_000;

/** The first message on a connection: it carries the access token too. */
export type HelloMsg = Extract<ClientMsg, { type: 'create' } | { type: 'hello' }>;

/** The WebSocket subprotocols to offer a hub: the token travels in the upgrade request too. */
export function protocolsFor(token: string): string[] {
  return token ? [WS_PROTOCOL, tokenProtocol(token)] : [WS_PROTOCOL];
}

export interface NetOptions {
  /**
   * The access token for this hub ('' for none), read on every connect so a
   * corrected one is used on the next retry. It is offered as a subprotocol
   * and also sent in the hello.
   */
  token?: () => string | Promise<string>;
  /**
   * A connection attempt failed before it opened, `failures` times in a row
   * (reset once one opens). `withToken` says whether a token was offered.
   */
  onConnectFailed?(failures: number, withToken: boolean): void;
}

export class Net {
  private ws: WebSocket | null = null;
  private retryMs = RETRY_MIN_MS;
  private refusedMs = REFUSED_MIN_MS;
  private unreachableMs = UNREACHABLE_MIN_MS;
  /** Attempts in a row that closed without ever opening. */
  private failedOpens = 0;
  /** Bumped by every connect and close, so a token read that finishes late is dropped. */
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** serverTime - localTime. */
  private offset = 0;
  /** Recent offset samples; see `syncClock`. */
  private samples: number[] = [];

  constructor(
    /**
     * The hub to talk to, fixed for the life of this connection: the hello
     * carries a client id and token meant for this hub only, so a changed
     * server setting must never send them somewhere else.
     */
    readonly url: string,
    /** First message on every (re)connect, without the token (see `NetOptions.token`). */
    public hello: () => HelloMsg,
    private readonly onMessage: (msg: ServerMsg) => void,
    private readonly onStatus: (s: NetStatus) => void,
    /** The configured hub address isn't acceptable (e.g. plain ws:// to another machine). */
    private readonly onBadServer: (message: string) => void = () => {},
    private readonly opts: NetOptions = {},
  ) {}

  connect() {
    clearTimeout(this.retryTimer);
    const attempt = ++this.attempt;
    const old = this.ws;
    this.ws = null;
    old?.close();
    const problem = serverProblem(this.url);
    if (problem) {
      this.onStatus('closed');
      this.onBadServer(problem);
      return;
    }
    this.onStatus('connecting');
    void this.open(attempt);
  }

  private async open(attempt: number) {
    // The token may need a moment (it comes from the Keychain).
    let token = '';
    try {
      token = (await this.opts.token?.()) ?? '';
    } catch {
      token = '';
    }
    // Closed, or connecting again, meanwhile.
    if (attempt !== this.attempt) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, protocolsFor(token));
    } catch {
      // Only a malformed address or subprotocol throws here; treat it like a failed attempt.
      this.failed(!!token);
      return;
    }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true;
      this.failedOpens = 0;
      this.unreachableMs = UNREACHABLE_MIN_MS;
      this.samples = [];
      this.onStatus('open');
      const hello = this.hello();
      ws.send(JSON.stringify(token ? { ...hello, token } : hello));
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string' && e.data.length > MAX_MESSAGE_CHARS) return;
      const msg = parseServerMsg(e.data);
      if (!msg) return;
      if (msg.type === 'state') {
        // Only a working session resets the backoff: a hub that accepts the
        // socket and then refuses us shouldn't get a fast retry loop.
        this.retryMs = RETRY_MIN_MS;
        this.refusedMs = REFUSED_MIN_MS;
        this.syncClock(msg.serverNow);
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!opened) return this.failed(!!token);
      this.onStatus('closed');
      this.reconnectSoon();
    };
  }

  /** The usual reconnect after a dropped connection: quick, backing off to a few seconds. */
  private reconnectSoon() {
    this.schedule(this.retryMs);
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
  }

  /**
   * An attempt that never opened: the hub is down, unreachable, or refused the
   * upgrade (it does that for a missing or wrong access token). Say so, and
   * after a few quick retries slow down, so a refused app doesn't hammer it.
   */
  private failed(withToken: boolean) {
    this.failedOpens++;
    const attempt = this.attempt;
    this.onStatus('closed');
    this.opts.onConnectFailed?.(this.failedOpens, withToken);
    // A handler closed us (or connected again): leave the retries to that.
    if (attempt !== this.attempt) return;
    if (this.failedOpens < FAST_FAILURES) return this.reconnectSoon();
    this.schedule(this.unreachableMs);
    this.unreachableMs = Math.min(UNREACHABLE_MAX_MS, this.unreachableMs * 2);
  }

  /** The hub refused us for now: drop the connection and try again later, backing off each time. Returns the delay. */
  retryLater(): number {
    this.close();
    const delay = this.refusedMs;
    this.refusedMs = Math.min(REFUSED_MAX_MS, this.refusedMs * 2);
    this.schedule(delay);
    return delay;
  }

  /** Waiting for the owner's OK: drop the connection and ask again in 10-15 s. Returns the delay. */
  retryPending(): number {
    this.close();
    this.schedule(PENDING_RETRY_MS);
    return PENDING_RETRY_MS;
  }

  private schedule(ms: number) {
    clearTimeout(this.retryTimer);
    // Jitter, so a hub restart doesn't get every app back in the same instant.
    this.retryTimer = setTimeout(() => this.connect(), Math.round(ms * (0.8 + Math.random() * 0.4)));
  }

  /**
   * Each message reaches us some time after `serverNow` was stamped, so every
   * sample underestimates the offset by that delay. The largest recent sample
   * came through fastest and is the best estimate; keeping only recent ones
   * lets the estimate follow clock drift. A hub can't move it more than a
   * week (`clockOffset`).
   */
  private syncClock(serverNow: number) {
    this.samples.push(serverNow - Date.now());
    if (this.samples.length > CLOCK_SAMPLES) this.samples.shift();
    this.offset = clockOffset(this.samples);
  }

  /** Disconnect and stop reconnecting (until `connect()` or `retryLater()`). */
  close() {
    clearTimeout(this.retryTimer);
    this.attempt++;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  now() {
    return Date.now() + this.offset;
  }
}
