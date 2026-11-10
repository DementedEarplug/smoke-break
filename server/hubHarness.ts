// Test harness for the hub: a real hub on a temp data file, behind a real HTTP server, and recording clients.

import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';
import { WebSocket, type ClientOptions } from 'ws';
import { type ClientMsg, type ServerMsg, WS_PROTOCOL, tokenProtocol } from '../shared/protocol.ts';
import { type HubOptions, createHub } from './hub.ts';

export type StateMsg = Extract<ServerMsg, { type: 'state' }>;
export type ErrorMsg = Extract<ServerMsg, { type: 'error' }>;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const tempDir = () => mkdtempSync(join(tmpdir(), 'sb-hub-'));
export const tempFile = () => join(tempDir(), 'teams.json');

/** A test client that records every message from the hub. */
export class Client {
  readonly msgs: ServerMsg[] = [];
  readonly closed: Promise<number>;
  private waiters: (() => void)[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      this.msgs.push(JSON.parse(String(raw)));
      for (const w of this.waiters.splice(0)) w();
    });
    this.closed = new Promise((r) => ws.once('close', r));
  }
  send(msg: ClientMsg | Record<string, unknown>) {
    this.ws.send(JSON.stringify(msg));
  }
  /** Resolves with the first message at or after index `from` matching `pred`, waiting if needed. */
  async next<T extends ServerMsg>(pred: (m: ServerMsg) => m is T, from = 0, timeoutMs = 2000): Promise<T> {
    for (;;) {
      const found = this.msgs.slice(from).find(pred);
      if (found) return found;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
        this.waiters.push(() => (clearTimeout(t), resolve()));
      });
    }
  }
  first() {
    return this.next((_m): _m is ServerMsg => true);
  }
  state(pred: (m: StateMsg) => boolean = () => true, from?: number) {
    return this.next((m): m is StateMsg => m.type === 'state' && pred(m), from);
  }
  error(from?: number) {
    return this.next((m): m is ErrorMsg => m.type === 'error', from);
  }
  fatal(from?: number) {
    return this.next((m): m is ErrorMsg => m.type === 'error' && !!m.fatal, from);
  }
  lastState() {
    return this.msgs.filter((m): m is StateMsg => m.type === 'state').at(-1)!;
  }
  states() {
    return this.msgs.filter((m): m is StateMsg => m.type === 'state');
  }
}

export const ALEX = 'alex-secret-client-id-0001';
export const SAM = 'sam-secret-client-id-00002';

/** Fast but realistic: broadcasts are still coalesced, just over a shorter window. */
const TEST_LIMITS = { broadcastIntervalMs: 20 };

/** A hub on a temp data file, behind a real HTTP server, plus helpers. Members are arrow functions so they can be destructured. */
export class HubHarness {
  server!: Server;
  hub!: ReturnType<typeof createHub>;
  url = '';
  dataFile = '';
  logs: string[] = [];
  clients: Client[] = [];

  /** (Re)starts the hub on `file` (default: the current test's data file). */
  start = (opts: Partial<HubOptions> = {}, file = this.dataFile): ReturnType<typeof createHub> => {
    this.hub?.close();
    this.dataFile = file;
    this.hub = createHub({
      dataFile: file,
      accessToken: '',
      accessTokensFile: '',
      trustProxy: false,
      publicHosts: [],
      allowedOrigins: [],
      log: (l) => this.logs.push(l),
      ...opts,
      limits: { ...TEST_LIMITS, ...opts.limits },
    });
    return this.hub;
  };

  /** Connects like the app: with a token, it's offered as a subprotocol next to WS_PROTOCOL. */
  connect = async (options: ClientOptions = {}, token?: string): Promise<Client> => {
    const ws = token ? new WebSocket(this.url, [WS_PROTOCOL, tokenProtocol(token)], options) : new WebSocket(this.url, options);
    const c = new Client(ws);
    this.clients.push(c);
    await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)));
    return c;
  };

  /** Connects from a given address (needs a trusted proxy: the test server's peer is 127.0.0.1). */
  connectFrom = (ip: string, options: ClientOptions = {}, token?: string): Promise<Client> =>
    this.connect({ ...options, headers: { ...options.headers, 'x-forwarded-for': ip } }, token);

  hello = async (code: string, clientId: string, name = 'J', client?: Client, token?: string) => {
    const c = client ?? (await this.connect({}, token));
    c.send({ type: 'hello', teamCode: code, clientId, name, ...(token ? { token } : {}) });
    return { c, msg: await c.first() };
  };

  create = async (clientId: string, name = 'A', teamName = 'T', client?: Client, token?: string) => {
    const c = client ?? (await this.connect({}, token));
    c.send({ type: 'create', teamName, clientId, name, ...(token ? { token } : {}) });
    return { c, msg: await c.first() };
  };

  /**
   * Alex creates "Crew"; Sam asks to join, Alex lets him in, Sam connects.
   * Approval is then switched off (so tests can add people freely) unless `approval`.
   */
  team = async ({ approval = false } = {}) => {
    const alex = await this.connect();
    alex.send({ type: 'create', teamName: 'Crew', clientId: ALEX, name: 'Alex' });
    const { team: t } = await alex.state();
    const knock = await this.hello(t.code, SAM, 'Sam');
    expect(knock.msg).toMatchObject({ type: 'error', fatal: true, code: 'pending' });
    const req = await alex.state((m) => m.team.pending.length === 1);
    alex.send({ type: 'approveMember', id: req.team.pending[0].id, allow: true });
    await alex.state((m) => m.team.members.length === 2);
    const sam = await this.connect();
    sam.send({ type: 'hello', teamCode: t.code, clientId: SAM, name: 'Sam' });
    await sam.state((m) => m.team.members.length === 2);
    await alex.state((m) => m.team.members.every((x) => x.online));
    if (!approval) {
      alex.send({ type: 'settings', requireApproval: false });
      await alex.state((m) => !m.team.requireApproval);
      await sam.state((m) => !m.team.requireApproval);
    }
    return { alex, sam, code: t.code };
  };
}

/**
 * Registers before/after hooks and returns helpers bound to the current test's
 * hub. Every test gets a fresh hub on a fresh temp data file.
 */
export function hubHarness(): HubHarness {
  const h = new HubHarness();

  beforeEach(async () => {
    h.logs = [];
    h.dataFile = tempFile();
    h.start();
    h.server = createServer();
    h.server.on('upgrade', (req, socket, head) => h.hub.handleUpgrade(req, socket, head));
    await new Promise<void>((r) => h.server.listen(0, '127.0.0.1', r));
    h.url = `ws://127.0.0.1:${(h.server.address() as AddressInfo).port}/ws`;
  });

  afterEach(async () => {
    for (const c of h.clients.splice(0)) c.ws.terminate();
    h.hub.close();
    await new Promise((r) => h.server.close(r));
  });

  return h;
}

/** A saved team entry in the current file format, for writing test data files. */
export const saved = (over: Record<string, unknown>) => ({
  name: 'Old',
  defaultLengthMin: 12,
  zoomLink: '',
  meetingProvider: 'fixed-link',
  ownerId: null,
  lastActive: Date.now(),
  ...over,
});
