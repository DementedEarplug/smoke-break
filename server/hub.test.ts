import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ClientMsg, ServerMsg } from '../shared/protocol.ts';
import { createHub } from './hub.ts';

type StateMsg = Extract<ServerMsg, { type: 'state' }>;

/** A test client that records every message from the hub. */
class Client {
  readonly msgs: ServerMsg[] = [];
  private waiters: (() => void)[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      this.msgs.push(JSON.parse(String(raw)));
      for (const w of this.waiters.splice(0)) w();
    });
  }
  send(msg: ClientMsg | Record<string, unknown>) {
    this.ws.send(JSON.stringify(msg));
  }
  /** Resolves with the first message at or after index `from` matching `pred`, waiting if needed. */
  async next<T extends ServerMsg>(pred: (m: ServerMsg) => m is T, from = 0): Promise<T> {
    for (;;) {
      const found = this.msgs.slice(from).find(pred);
      if (found) return found;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out waiting for message')), 2000);
        this.waiters.push(() => (clearTimeout(t), resolve()));
      });
    }
  }
  state(pred: (m: StateMsg) => boolean = () => true, from?: number) {
    return this.next((m): m is StateMsg => m.type === 'state' && pred(m), from);
  }
  error(from?: number) {
    return this.next((m): m is Extract<ServerMsg, { type: 'error' }> => m.type === 'error', from);
  }
}

let server: Server;
let hub: ReturnType<typeof createHub>;
let url: string;
const clients: Client[] = [];

beforeEach(async () => {
  hub = createHub({ dataFile: join(mkdtempSync(join(tmpdir(), 'sb-hub-')), 'teams.json') });
  server = createServer();
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  hub.close();
  await new Promise((r) => server.close(r));
});

async function connect(): Promise<Client> {
  const ws = new WebSocket(url);
  const c = new Client(ws);
  clients.push(c);
  await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)));
  return c;
}

const ALEX = 'alex-secret-client-id-0001';
const SAM = 'sam-secret-client-id-00002';

async function team() {
  const alex = await connect();
  alex.send({ type: 'create', teamName: 'Crew', clientId: ALEX, name: 'Alex' });
  const { team: t } = await alex.state();
  const sam = await connect();
  sam.send({ type: 'hello', teamCode: t.code, clientId: SAM, name: 'Sam' });
  await sam.state((m) => m.team.members.length === 2);
  return { alex, sam, code: t.code };
}

describe('hub identity', () => {
  it('never sends anyone a clientId', async () => {
    const { alex, sam } = await team();
    await alex.state((m) => m.team.members.length === 2);
    alex.send({ type: 'invite' });
    await sam.state((m) => !!m.team.brk);
    const wire = JSON.stringify([...alex.msgs, ...sam.msgs]);
    expect(wire).not.toContain(ALEX);
    expect(wire).not.toContain(SAM);
  });

  it('tells each member their own public id', async () => {
    const { alex, sam } = await team();
    const a = await alex.state((m) => m.team.members.length === 2);
    const s = await sam.state((m) => m.team.members.length === 2);
    expect(a.you).not.toBe(s.you);
    expect(a.team.members.map((m) => m.id).sort()).toEqual([a.you, s.you].sort());
  });

  it("can't act as a teammate using their public id", async () => {
    const { alex, sam, code } = await team();
    alex.send({ type: 'invite' });
    const s = await sam.state((m) => m.team.brk?.participants.length === 1);
    const alexPublic = s.team.brk!.participants[0].id;
    const mallory = await connect();
    mallory.send({ type: 'hello', teamCode: code, clientId: alexPublic.padEnd(16, '0'), name: 'Alex' });
    const m = await mallory.state();
    expect(m.you).not.toBe(alexPublic);
    expect(m.team.brk!.participants.map((p) => p.id)).toEqual([alexPublic]);
  });

  it('gives a newcomer with a taken name a different one', async () => {
    const { code } = await team();
    const imposter = await connect();
    imposter.send({ type: 'hello', teamCode: code, clientId: 'imposter-client-id-00003', name: 'ALEX' });
    const m = await imposter.state();
    expect(m.team.members.map((x) => x.name)).toEqual(['Alex', 'Sam', 'ALEX 2']);
  });

  it('keeps your name when you reconnect', async () => {
    const { code } = await team();
    const again = await connect();
    again.send({ type: 'hello', teamCode: code, clientId: ALEX, name: 'Alex' });
    const m = await again.state();
    expect(m.team.members.map((x) => x.name)).toEqual(['Alex', 'Sam']);
  });

  it('rejects short, guessable client ids', async () => {
    const c = await connect();
    c.send({ type: 'create', teamName: 'x', clientId: 'a', name: 'A' });
    expect((await c.error()).fatal).toBe(true);
  });
});
