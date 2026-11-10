// WebSocket client with auto-reconnect and a server-synced clock.

import { type ClientMsg, type ServerMsg, parseServerMsg } from '../shared/protocol.ts';
import { serverProblem, serverUrl } from './platform.ts';

export type NetStatus = 'connecting' | 'open' | 'closed';

const CLOCK_SAMPLES = 20;
/** Reconnect delays after a dropped connection. */
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 5000;
/**
 * Delays after the hub refused us (rate limit, full, wrong access token).
 * Much slower, so a refused app doesn't keep the hub's limits topped up.
 */
const REFUSED_MIN_MS = 15_000;
const REFUSED_MAX_MS = 5 * 60_000;

export class Net {
  private ws: WebSocket | null = null;
  private retryMs = RETRY_MIN_MS;
  private refusedMs = REFUSED_MIN_MS;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** serverTime - localTime. */
  private offset = 0;
  /** Recent offset samples; see `syncClock`. */
  private samples: number[] = [];

  constructor(
    /** First message on every (re)connect. */
    public hello: () => ClientMsg,
    private readonly onMessage: (msg: ServerMsg) => void,
    private readonly onStatus: (s: NetStatus) => void,
    /** The configured hub address isn't acceptable (e.g. plain ws:// to another machine). */
    private readonly onBadServer: (message: string) => void = () => {},
  ) {}

  connect() {
    clearTimeout(this.retryTimer);
    const problem = serverProblem();
    if (problem) {
      this.ws = null;
      this.onStatus('closed');
      this.onBadServer(problem);
      return;
    }
    this.onStatus('connecting');
    const ws = new WebSocket(serverUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.samples = [];
      this.onStatus('open');
      ws.send(JSON.stringify(this.hello()));
    };
    ws.onmessage = (e) => {
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
      this.onStatus('closed');
      this.schedule(this.retryMs);
      this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
    };
  }

  /** The hub refused us for now: drop the connection and try again later, backing off each time. Returns the delay. */
  retryLater(): number {
    this.close();
    const delay = this.refusedMs;
    this.refusedMs = Math.min(REFUSED_MAX_MS, this.refusedMs * 2);
    this.schedule(delay);
    return delay;
  }

  private schedule(ms: number) {
    clearTimeout(this.retryTimer);
    // Jitter, so a hub restart doesn't get every app back in the same instant.
    this.retryTimer = setTimeout(() => this.connect(), ms * (0.8 + Math.random() * 0.4));
  }

  /**
   * Each message reaches us some time after `serverNow` was stamped, so every
   * sample underestimates the offset by that delay. The largest recent sample
   * came through fastest and is the best estimate; keeping only recent ones
   * lets the estimate follow clock drift.
   */
  private syncClock(serverNow: number) {
    this.samples.push(serverNow - Date.now());
    if (this.samples.length > CLOCK_SAMPLES) this.samples.shift();
    this.offset = Math.max(...this.samples);
  }

  /** Disconnect and stop reconnecting (until `connect()` or `retryLater()`). */
  close() {
    clearTimeout(this.retryTimer);
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
