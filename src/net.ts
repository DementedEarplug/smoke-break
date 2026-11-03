// WebSocket client with auto-reconnect and a server-synced clock.

import { type ClientMsg, type ServerMsg, parseServerMsg } from '../shared/protocol.ts';
import { serverUrl } from './platform.ts';

export type NetStatus = 'connecting' | 'open' | 'closed';

export class Net {
  private ws: WebSocket | null = null;
  private retryMs = 500;
  /** serverTime - localTime. */
  private offset = 0;

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
      this.onStatus('open');
      ws.send(JSON.stringify(this.hello()));
    };
    ws.onmessage = (e) => {
      const msg = parseServerMsg(e.data);
      if (!msg) return;
      if (msg.type === 'state') this.offset = msg.serverNow - Date.now();
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.onStatus('closed');
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(5000, this.retryMs * 2);
    };
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
