// WebSocket client with auto-reconnect and a server-synced clock.

import { type ClientMsg, type ServerMsg, parseServerMsg } from '../shared/protocol.ts';
import { serverUrl } from './platform.ts';

export type NetStatus = 'connecting' | 'open' | 'closed';

const CLOCK_SAMPLES = 20;

export class Net {
  private ws: WebSocket | null = null;
  private retryMs = 500;
  /** serverTime - localTime. */
  private offset = 0;
  /** Recent offset samples; see `syncClock`. */
  private samples: number[] = [];

  constructor(
    /** First message on every (re)connect. */
    public hello: () => ClientMsg,
    private readonly onMessage: (msg: ServerMsg) => void,
    private readonly onStatus: (s: NetStatus) => void,
  ) {}

  connect() {
    this.onStatus('connecting');
    const ws = new WebSocket(serverUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 500;
      this.samples = [];
      this.onStatus('open');
      ws.send(JSON.stringify(this.hello()));
    };
    ws.onmessage = (e) => {
      const msg = parseServerMsg(e.data);
      if (!msg) return;
      if (msg.type === 'state') this.syncClock(msg.serverNow);
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.onStatus('closed');
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(5000, this.retryMs * 2);
    };
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

  close() {
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
