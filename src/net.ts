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
/**
 * What a hub may send, in characters: this much a second on average, in
 * bursts of up to `BURST_CHARS`. A real hub sends a team at most 2 MB a second
 * in all (`teamBroadcastBytesPerSecond` in server/hub.ts), and only part of
 * that to one app. Past it the connection is dropped and retried: a hostile hub
 * can't keep the app busy parsing.
 */
export const BUDGET_CHARS_PER_SEC = 4_000_000;
export const BURST_CHARS = 4 * MAX_MESSAGE_CHARS;
export const FLOOD_MESSAGE = 'The hub sent far more than a hub should; reconnecting.';
/** How often state frames are handled when there are no animation frames (a hidden window, tests). */
export const STATE_EVERY_MS = 50;
/** How a real hub starts a state frame (server/hub.ts); such frames are parsed only when handled. */
const STATE_PREFIX = '{"type":"state",';
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

/** A frame's size: characters, or bytes for a binary one. */
function sizeOf(data: unknown): number {
  if (typeof data === 'string') return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size;
  return 0;
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
  /**
   * The newest state frame not handled yet (raw, or parsed if it didn't look
   * like one before parsing), and the scheduled handling: see `takeState`.
   */
  private pendingState: string | ServerMsg | null = null;
  private stateFrame: number | undefined;
  private stateTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * What is left of the hub's budget (see `BUDGET_CHARS_PER_SEC`) and when it
   * was last topped up. It carries over reconnects, so reconnecting doesn't
   * refill it.
   */
  private budget = BURST_CHARS;
  private budgetAt = Date.now();

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
    this.dropState();
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
    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws) return;
      if (!this.spend(sizeOf(e.data))) return this.flooded(ws);
      if (typeof e.data === 'string' && e.data.length > MAX_MESSAGE_CHARS) return;
      // A state frame replaces the last one and is parsed only when handled.
      if (typeof e.data === 'string' && e.data.startsWith(STATE_PREFIX)) return this.takeState(e.data);
      const msg = parseServerMsg(e.data);
      if (!msg) return;
      if (msg.type === 'state') return this.takeState(msg);
      // Errors are handled at once, in order, and never dropped.
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      // The hub's last word before it hung up still counts.
      this.handleState();
      if (this.ws !== ws) return;
      this.ws = null;
      if (!opened) return this.failed(!!token);
      this.onStatus('closed');
      this.reconnectSoon();
    };
  }

  /**
   * Keeps only the newest state frame and handles it at the next animation
   * frame, or within `STATE_EVERY_MS` where there are none (a hidden window
   * gets no animation frames): however fast a hub sends, the app parses and
   * draws at most one state per frame.
   */
  private takeState(frame: string | ServerMsg) {
    this.pendingState = frame;
    if (this.stateTimer !== undefined) return;
    const run = () => this.handleState();
    this.stateTimer = setTimeout(run, STATE_EVERY_MS);
    if (typeof requestAnimationFrame === 'function') this.stateFrame = requestAnimationFrame(run);
  }

  private handleState() {
    const frame = this.pendingState;
    this.dropState();
    const msg = typeof frame === 'string' ? parseServerMsg(frame) : frame;
    if (!msg) return;
    if (msg.type === 'state') {
      // Only a working session resets the backoff: a hub that accepts the
      // socket and then refuses us shouldn't get a fast retry loop.
      this.retryMs = RETRY_MIN_MS;
      this.refusedMs = REFUSED_MIN_MS;
      this.syncClock(msg.serverNow);
    }
    this.onMessage(msg);
  }

  /** Forgets a state not handled yet: it belongs to a connection that is gone. */
  private dropState() {
    this.pendingState = null;
    clearTimeout(this.stateTimer);
    this.stateTimer = undefined;
    if (this.stateFrame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.stateFrame);
    this.stateFrame = undefined;
  }

  /** Takes `chars` from the hub's budget; false once it is used up. */
  private spend(chars: number): boolean {
    const now = Date.now();
    const refill = (Math.max(0, now - this.budgetAt) * BUDGET_CHARS_PER_SEC) / 1000;
    this.budget = Math.min(BURST_CHARS, this.budget + refill) - chars;
    this.budgetAt = now;
    return this.budget >= 0;
  }

  /** The hub sends more than its budget: hang up, say so, and try again later. */
  private flooded(ws: WebSocket) {
    this.ws = null;
    this.dropState();
    ws.close();
    this.onStatus('closed');
    this.reconnectSoon();
    this.onMessage({ type: 'error', message: FLOOD_MESSAGE });
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
    this.dropState();
    ws?.close();
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  now() {
    return Date.now() + this.offset;
  }
}
