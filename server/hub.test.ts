import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, type ClientOptions } from 'ws';
import type { ClientMsg, ErrorCode, ServerMsg } from '../shared/protocol.ts';
import { isValidMeetingLink } from '../shared/protocol.ts';
import {
  type HubOptions,
  addressKey,
  cleanName,
  clientAddress,
  createHub,
  dataFileFromEnv,
  isAllowedHost,
  isAllowedOrigin,
  nameKey,
  parseSavedTeam,
} from './hub.ts';
import { WindowLimiter } from './limits.ts';

type StateMsg = Extract<ServerMsg, { type: 'state' }>;
type ErrorMsg = Extract<ServerMsg, { type: 'error' }>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A test client that records every message from the hub. */
class Client {
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
  first() {
    return this.next((_m): _m is ServerMsg => true);
  }
  state(pred: (m: StateMsg) => boolean = () => true, from?: number) {
    return this.next((m): m is StateMsg => m.type === 'state' && pred(m), from);
  }
  error(from?: number) {
    return this.next((m): m is ErrorMsg => m.type === 'error', from);
  }
  lastState() {
    return this.msgs.filter((m): m is StateMsg => m.type === 'state').at(-1)!;
  }
}

let server: Server;
let hub: ReturnType<typeof createHub>;
let url: string;
let dataFile: string;
let logs: string[] = [];
const clients: Client[] = [];

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'sb-hub-')), 'teams.json');

/** (Re)starts the hub on `file` (default: the current test's data file). */
function startHub(opts: Partial<HubOptions> = {}, file = dataFile) {
  hub?.close();
  dataFile = file;
  hub = createHub({ dataFile, accessToken: '', trustProxy: false, publicHosts: [], allowedOrigins: [], log: (l) => logs.push(l), ...opts });
}

beforeEach(async () => {
  logs = [];
  dataFile = tempFile();
  startHub();
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

async function connect(options: ClientOptions = {}): Promise<Client> {
  const ws = new WebSocket(url, options);
  const c = new Client(ws);
  clients.push(c);
  await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)));
  return c;
}

/** Connects from a given address (needs trustProxy). */
const connectFrom = (ip: string) => connect({ headers: { 'x-forwarded-for': ip } });

const ALEX = 'alex-secret-client-id-0001';
const SAM = 'sam-secret-client-id-00002';

async function team() {
  const alex = await connect();
  alex.send({ type: 'create', teamName: 'Crew', clientId: ALEX, name: 'Alex' });
  const { team: t } = await alex.state();
  const sam = await connect();
  sam.send({ type: 'hello', teamCode: t.code, clientId: SAM, name: 'Sam' });
  await sam.state((m) => m.team.members.length === 2);
  await alex.state((m) => m.team.members.length === 2);
  return { alex, sam, code: t.code };
}

async function hello(code: string, clientId: string, name = 'J', c?: Client) {
  c ??= await connect();
  c.send({ type: 'hello', teamCode: code, clientId, name });
  return { c, msg: await c.first() };
}

const saved = (over: Record<string, unknown>) => ({
  name: 'Old',
  defaultLengthMin: 12,
  zoomLink: '',
  meetingProvider: 'fixed-link',
  ownerId: null,
  lastActive: Date.now(),
  ...over,
});

describe('hub identity', () => {
  it('never sends anyone a clientId', async () => {
    const { alex, sam } = await team();
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
    const { msg } = await hello(code, 'imposter-client-id-00003', 'ALEX');
    expect((msg as StateMsg).team.members.map((x) => x.name)).toEqual(['Alex', 'Sam', 'ALEX 2']);
  });

  it('keeps your name when you reconnect', async () => {
    const { code } = await team();
    const { msg } = await hello(code, ALEX, 'Alex');
    expect((msg as StateMsg).team.members.map((x) => x.name)).toEqual(['Alex', 'Sam']);
  });

  it('rejects short, guessable client ids', async () => {
    const c = await connect();
    c.send({ type: 'create', teamName: 'x', clientId: 'a', name: 'A' });
    expect((await c.error()).fatal).toBe(true);
  });
});

describe('hub names (L1)', () => {
  it.each([
    ['Alex​', 'Alex'],
    ['‮evil‬', 'evil'],
    ['A\u0000l\u0007e\u001bx', 'Alex'],
    ['  lots   of\n space ', 'lots of space'],
    ['​‍﻿', 'Someone'],
    ['😀'.repeat(30), '😀'.repeat(24)],
  ])('cleanName(%j) → %j', (input, out) => expect(cleanName(input, 'Someone')).toBe(out));

  it('compares names without case, width or lookalike tricks', () => {
    expect(nameKey('Alex')).toBe(nameKey('ALEX'));
    expect(nameKey('Alex')).toBe(nameKey('Ａｌｅｘ')); // fullwidth
    expect(nameKey('Alex')).toBe(nameKey('Аlex')); // Cyrillic А
    expect(nameKey('Alex')).not.toBe(nameKey('Alan'));
  });

  it("won't let a lookalike name sit beside the real one", async () => {
    const { code } = await team();
    const names = [];
    for (const [i, n] of ['Alex​', 'Аlex', 'Ａｌｅｘ', '‮Alex'].entries()) {
      const { msg } = await hello(code, `lookalike-client-id-000${i}`, n);
      names.push((msg as StateMsg).team.members.at(-1)!.name);
    }
    expect(names).toEqual(['Alex 2', 'Аlex 3', 'Ａｌｅｘ 4', 'Alex 5']);
  });
});

describe('hub crash resistance (C1)', () => {
  const nasty: unknown[] = [null, 0, -1, 1e308, '', 'x'.repeat(5000), [], {}, { toString: 1 }, { valueOf: 1, toString: 1 }, true, '__proto__', [[[]]]];

  it('survives non-primitive and wrong-typed fields from strangers and members', async () => {
    const { alex, sam, code } = await team();
    const stranger = await connect();
    stranger.send({ type: 'hello', clientId: 'stranger-client-id-0001', name: 'x', teamCode: { toString: 1 } });
    expect(await stranger.error()).toMatchObject({ fatal: true, code: 'bad-code' });
    const types = ['create', 'hello', 'invite', 'setLength', 'join', 'light', 'leave', 'settings', 'rotateCode', 'removeMember', '__proto__', 1, null];
    const keys = ['clientId', 'name', 'teamName', 'teamCode', 'lengthMin', 'light', 'zoomLink', 'defaultLengthMin', 'id', 'token', '__proto__'];
    for (const sock of [sam, alex]) {
      for (const type of types) for (const k of keys) for (const v of nasty) if (type !== 'rotateCode') sock.send({ type, [k]: v });
      for (const raw of ['', '{', 'null', '[]', '"x"', '123', '{"type":"settings","zoomLink":{"trim":1}}']) sock.ws.send(raw);
      sock.ws.send(Buffer.from([0xff, 0xfe, 0x00]), { binary: true });
      await sleep(50);
    }
    // Still serving, and the team wasn't damaged by any of it.
    const { msg } = await hello(code, 'checker-client-id-00001', 'Check');
    const s = msg as StateMsg;
    expect(s.type).toBe('state');
    expect(s.team.name).toBe('Crew');
    expect(s.team.code).toBe(code);
  });

  it('rejects a wrong-typed setting without changing anything', async () => {
    const { alex } = await team();
    let from = alex.msgs.length;
    alex.send({ type: 'settings', teamName: 'Renamed', defaultLengthMin: { valueOf: 1 } });
    expect((await alex.error(from)).message).toMatch(/number/);
    from = alex.msgs.length;
    alex.send({ type: 'setLength', lengthMin: { valueOf: 1, toString: 1 } });
    expect((await alex.error(from)).message).toMatch(/number/);
    expect(alex.lastState().team.name).toBe('Crew');
  });
});

describe('meeting links (H1)', () => {
  it.each([
    ['', true],
    ['https://zoom.us/j/123', true],
    ['https://us02web.zoom.us/j/123?pwd=abc', true],
    ['https://app.zoom.com/wc/123', true],
    ['http://zoom.us/j/123', false],
    ['javascript:alert(1)', false],
    ['https://evil.example/login', false],
    ['https://zoom.us.evil.example/j/1', false],
    ['https://evilzoom.us/j/1', false],
    ['https://zoom.us@evil.example/j/1', false],
    ['https://zoom.us\\@evil.example/x', false],
    ['not a url', false],
  ])('%s → %s', (link, ok) => expect(isValidMeetingLink(link)).toBe(ok));

  it('stores and sends only the canonical form', async () => {
    const { alex } = await team();
    const from = alex.msgs.length;
    alex.send({ type: 'settings', zoomLink: 'https://ZOOM.us/j/1' });
    expect((await alex.state((s) => !!s.team.zoomLink, from)).team.zoomLink).toBe('https://zoom.us/j/1');
    alex.send({ type: 'settings', zoomLink: 'https://zoom.us\\@evil.example/x' });
    expect((await alex.error(from)).message).toMatch(/zoom/i);
  });

  it('normalizes saved links on load and drops ones that no longer pass', () => {
    const now = Date.now();
    expect(parseSavedTeam(saved({ code: 'ABCDEF', zoomLink: 'https://Zoom.US/j/9' }), now)!.zoomLink).toBe('https://zoom.us/j/9');
    expect(parseSavedTeam(saved({ code: 'ABCDEF', zoomLink: 'https://zoom.us\\@evil.example/x' }), now)!.zoomLink).toBe('');
    expect(parseSavedTeam(saved({ code: 'ABCDEF', zoomLink: { href: 'x' } }), now)!.zoomLink).toBe('');
  });
});

describe('hub settings', () => {
  it('lets the owner change settings', async () => {
    const { alex } = await team();
    const from = alex.msgs.length;
    alex.send({ type: 'settings', zoomLink: 'https://zoom.us/j/1', teamName: 'Renamed' });
    const m = await alex.state((s) => s.team.name === 'Renamed', from);
    expect(m.team.zoomLink).toBe('https://zoom.us/j/1');
    expect(m.team.ownerId).toBe(m.you);
  });

  it('rejects settings from anyone but the owner', async () => {
    const { alex, sam } = await team();
    const from = sam.msgs.length;
    sam.send({ type: 'settings', zoomLink: 'https://zoom.us/j/evil', teamName: 'Hijacked' });
    expect((await sam.error(from)).message).toMatch(/owner/);
    const last = alex.lastState();
    expect(last.team.name).toBe('Crew');
    expect(last.team.zoomLink).toBe('');
  });

  it('rejects non-Zoom links', async () => {
    const { alex } = await team();
    const from = alex.msgs.length;
    alex.send({ type: 'settings', zoomLink: 'https://evil.example/login' });
    expect((await alex.error(from)).message).toMatch(/zoom/i);
  });

  it('only sends the Zoom link itself to the owner (L5)', async () => {
    const { alex, sam } = await team();
    alex.send({ type: 'settings', zoomLink: 'https://zoom.us/j/42' });
    const owner = await alex.state((m) => m.team.zoomLink !== '');
    const member = await sam.state((m) => m.team.hasZoomLink);
    expect(owner.team).toMatchObject({ zoomLink: 'https://zoom.us/j/42', hasZoomLink: true });
    expect(member.team.zoomLink).toBe('');
    expect(JSON.stringify(sam.msgs)).not.toContain('zoom.us/j/42');
  });
});

describe('hub limits', () => {
  it('closes sockets that send oversized messages', async () => {
    const c = await connect();
    c.ws.send('x'.repeat(64 * 1024));
    expect(await c.closed).toBe(1009);
  });

  it('limits how many teams one address can create', async () => {
    startHub({ limits: { createsPerIpPerHour: 2 } });
    const results = [];
    for (let i = 0; i < 3; i++) {
      const c = await connect();
      c.send({ type: 'create', teamName: `T${i}`, clientId: `creator-client-id-${i}-000`, name: 'A' });
      results.push(await c.first());
    }
    expect(results.map((m) => m.type)).toEqual(['state', 'state', 'error']);
    expect(results[2]).toMatchObject({ fatal: true, code: 'rate-limited' });
  });

  it('limits new teams across all addresses (H4)', async () => {
    startHub({ trustProxy: true, limits: { createsPerHour: 2 } });
    const codes = [];
    for (let i = 0; i < 3; i++) {
      const c = await connectFrom(`10.0.0.${i + 1}`);
      c.send({ type: 'create', teamName: 'T', clientId: `spread-client-id-${i}-000`, name: 'A' });
      const m = await c.first();
      codes.push(m.type === 'error' ? m.code : m.type);
    }
    expect(codes).toEqual(['state', 'state', 'rate-limited']);
  });

  it('counts a whole IPv6 /64 as one address (H4)', async () => {
    startHub({ trustProxy: true, limits: { createsPerIpPerHour: 1 } });
    const create = async (ip: string, i: number) => {
      const c = await connectFrom(ip);
      c.send({ type: 'create', teamName: 'T', clientId: `v6-client-id-${i}-00000`, name: 'A' });
      return (await c.first()).type;
    };
    expect(await create('2001:db8:1:2::1', 1)).toBe('state');
    expect(await create('2001:db8:1:2:ffff:ffff:ffff:ffff', 2)).toBe('error');
    expect(await create('2001:db8:1:3::1', 3)).toBe('state');
  });

  it('never forgets a recently used team to make room; refuses the new one instead (H4)', async () => {
    const day = 86_400_000;
    writeFileSync(
      dataFile,
      JSON.stringify([
        saved({ code: 'OLDONE', lastActive: Date.now() - 10 * day }),
        saved({ code: 'RECENT', lastActive: Date.now() - 2 * day }),
        saved({ code: 'GONEEE', lastActive: Date.now() - 365 * day }),
      ]),
    );
    startHub({ limits: { maxTeams: 2 } });
    // A year-old team was dropped on load.
    expect((await hello('GONEEE', 'joiner-client-id-GONEEE')).msg).toMatchObject({ type: 'error', code: 'bad-code' });
    const c = await connect();
    c.send({ type: 'create', teamName: 'Fresh', clientId: 'fresh-client-id-00000', name: 'F' });
    expect((await c.state()).team.name).toBe('Fresh');
    // OLDONE was idle for 10 days, so it made room.
    expect((await hello('OLDONE', 'joiner-client-id-OLDONE')).msg.type).toBe('error');
    // RECENT was used two days ago, and nobody is in it right now, but it isn't forgotten.
    const d = await connect();
    d.send({ type: 'create', teamName: 'More', clientId: 'more-client-id-000000', name: 'M' });
    expect(await d.error()).toMatchObject({ fatal: true, code: 'full' });
    expect((await hello('RECENT', 'joiner-client-id-RECENT')).msg.type).toBe('state');
  });

  it('throttles message floods', async () => {
    const { alex } = await team();
    for (let i = 0; i < 200; i++) alex.send({ type: 'leave' });
    expect(await alex.closed).toBe(1008);
  });

  it('caps connections per address', async () => {
    startHub({ limits: { connectionsPerIp: 2 } });
    await connect();
    await connect();
    await expect(connect()).rejects.toThrow(/429/);
  });

  it('caps connections in total', async () => {
    startHub({ trustProxy: true, limits: { maxConnections: 2 } });
    await connectFrom('10.0.0.1');
    await connectFrom('10.0.0.2');
    await expect(connectFrom('10.0.0.3')).rejects.toThrow(/503/);
  });

  it('caps members per team, but lets existing members back in', async () => {
    startHub({ limits: { maxMembersPerTeam: 2 } });
    const { code } = await team();
    expect((await hello(code, 'third-client-id-000000')).msg).toMatchObject({ type: 'error', fatal: true, code: 'full' });
    expect((await hello(code, SAM, 'Sam')).msg.type).toBe('state');
  });

  it('drops a socket that stops reading instead of buffering for it (H3)', async () => {
    startHub({ limits: { maxBufferedBytes: 4096, messageBurst: 1e9, messagesPerSecond: 1e9 } });
    const { alex, sam } = await team();
    (sam.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    const samGone = alex.state((m) => m.team.members.some((x) => x.name === 'Sam' && !x.online));
    samGone.catch(() => {});
    let gone = false;
    void samGone.then(() => (gone = true));
    for (let i = 0; i < 100 && !gone; i++) {
      for (let j = 0; j < 500; j++) alex.send({ type: 'leave' });
      await sleep(20);
    }
    expect(gone).toBe(true);
    expect(logs.some((l) => JSON.parse(l).kind === 'send-buffer')).toBe(true);
  });

  it('cools down starting new breaks (L3)', async () => {
    const { alex, sam } = await team();
    alex.send({ type: 'invite' });
    await sam.state((m) => m.team.brk?.phase === 'pending');
    alex.send({ type: 'leave' });
    await sam.state((m) => m.team.brk?.phase === 'out');
    const from = alex.msgs.length;
    alex.send({ type: 'invite' });
    expect((await alex.error(from)).message).toMatch(/Wait/);
    // Someone else can still start one.
    sam.send({ type: 'invite' });
    await alex.state((m) => m.team.brk?.phase === 'pending');
  });
});

describe('hub timeouts (M2)', () => {
  it("closes sockets that don't say hello in time", async () => {
    startHub({ limits: { helloTimeoutMs: 100 } });
    const c = await connect();
    await Promise.race([c.closed, sleep(2000).then(() => Promise.reject(new Error('still open')))]);
  });

  it('drops sockets that stop answering pings, keeps ones that do', async () => {
    startHub({ limits: { pingIntervalMs: 100 } });
    const { alex, code } = await team();
    const dead = await connect({ autoPong: false });
    dead.send({ type: 'hello', teamCode: code, clientId: 'sleepy-client-id-00000', name: 'Sleepy' });
    await alex.state((m) => m.team.members.some((x) => x.name === 'Sleepy' && x.online));
    await alex.state((m) => m.team.members.some((x) => x.name === 'Sleepy' && !x.online));
    await dead.closed;
    expect(alex.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe('hub invite codes', () => {
  it('makes 10-character codes and still accepts saved 6-character ones (H5)', async () => {
    writeFileSync(dataFile, JSON.stringify([saved({ code: 'ABCDEF' })]));
    startHub();
    const { code } = await team();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    expect((await hello('abcdef', 'legacy-client-id-00000')).msg.type).toBe('state');
  });

  it('locks out an address that guesses too many codes', async () => {
    startHub({ limits: { badCodesPerIp: 2, badCodeDelayMs: 0 } });
    const owner = await connect();
    owner.send({ type: 'create', teamName: 'Real', clientId: 'owner-client-id-000000', name: 'O' });
    const real = (await owner.state()).team.code;
    const guess = async (c: string) => (await hello(c, 'guesser-client-id-0000', 'G')).msg;
    expect(await guess('AAAAAA')).toMatchObject({ type: 'error', code: 'bad-code', message: expect.stringMatching(/No team/) });
    expect(await guess('BBBBBB')).toMatchObject({ type: 'error', code: 'bad-code' });
    expect(await guess('CCCCCC')).toMatchObject({ type: 'error', code: 'rate-limited', message: expect.stringMatching(/Too many/) });
    // Even the right code is refused for someone the team doesn't know, until the window passes.
    expect(await guess(real)).toMatchObject({ type: 'error', code: 'rate-limited' });
  });

  it("lets members the team already knows back in during a lockout, even after a restart (M1)", async () => {
    startHub({ limits: { badCodesPerIp: 2, badCodeDelayMs: 0 } });
    const { alex, sam, code } = await team();
    alex.ws.close();
    sam.ws.close();
    hub.flush();
    startHub({ limits: { badCodesPerIp: 2, badCodeDelayMs: 0 } });
    for (const g of ['AAAAAA', 'BBBBBB', 'CCCCCC']) await hello(g, 'guesser-client-id-0000');
    expect((await hello(code, SAM, 'Sam')).msg.type).toBe('state');
    expect((await hello(code, ALEX, 'Alex')).msg.type).toBe('state');
    expect((await hello(code, 'newbie-client-id-00000')).msg).toMatchObject({ type: 'error', code: 'rate-limited' });
  });

  it('treats the owner of a team saved before members were remembered as known', async () => {
    writeFileSync(dataFile, JSON.stringify([saved({ code: 'LEGACY' })]));
    startHub({ limits: { badCodesPerIp: 1, badCodeDelayMs: 0 } });
    // The first person back becomes the owner of an ownerless legacy team.
    const first = await hello('LEGACY', ALEX, 'Alex');
    expect(first.msg.type).toBe('state');
    first.c.ws.close();
    hub.flush();
    const file = JSON.parse(readFileSync(dataFile, 'utf8'));
    file[0].known = [];
    writeFileSync(dataFile, JSON.stringify(file));
    startHub({ limits: { badCodesPerIp: 1, badCodeDelayMs: 0 } });
    for (const g of ['AAAAAA', 'BBBBBB']) await hello(g, 'guesser-client-id-0000');
    expect((await hello('LEGACY', ALEX, 'Alex')).msg.type).toBe('state');
  });

  it('limits wrong codes across all addresses (H5)', async () => {
    startHub({ trustProxy: true, limits: { badCodes: 3, badCodeDelayMs: 0 } });
    const results = [];
    for (let i = 0; i < 4; i++) {
      const c = await connectFrom(`10.1.0.${i + 1}`);
      results.push(((await hello('ZZZZZZZZZZ', `spread-guess-id-${i}-000`, 'G', c)).msg as ErrorMsg).code);
    }
    expect(results).toEqual<(ErrorCode | undefined)[]>(['bad-code', 'bad-code', 'bad-code', 'rate-limited']);
  });

  it('lets the owner rotate the code; everyone connected gets the new one (H5)', async () => {
    const { alex, sam, code } = await team();
    const before = alex.lastState();
    sam.send({ type: 'rotateCode' });
    expect((await sam.error(sam.msgs.length - 0)).message).toMatch(/owner/);
    alex.send({ type: 'rotateCode' });
    const s = await sam.state((m) => m.team.code !== code);
    const a = await alex.state((m) => m.team.code !== code);
    expect(s.team.code).toBe(a.team.code);
    expect(s.team.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    // Public ids (and so ownership) survive the rotation.
    expect(a.you).toBe(before.you);
    expect(a.team.ownerId).toBe(before.team.ownerId);
    expect((await hello(code, 'late-client-id-000000')).msg).toMatchObject({ type: 'error', code: 'bad-code' });
    expect((await hello(s.team.code, 'late-client-id-000000')).msg.type).toBe('state');
    // Saved, too.
    hub.flush();
    expect(readFileSync(dataFile, 'utf8')).toContain(s.team.code);
    expect(readFileSync(dataFile, 'utf8')).not.toContain(`"code": "${code}"`);
  });

  it('lets the owner remove a member, who stays out (H5)', async () => {
    const { alex, sam, code } = await team();
    alex.send({ type: 'invite' });
    await sam.state((m) => m.team.brk?.phase === 'pending');
    sam.send({ type: 'join' });
    const s = await alex.state((m) => m.team.brk?.participants.length === 2);
    const samId = s.team.members.find((m) => m.name === 'Sam')!.id;

    sam.send({ type: 'removeMember', id: s.you });
    expect((await sam.error()).message).toMatch(/owner/);
    alex.send({ type: 'removeMember', id: s.you });
    expect((await alex.error()).message).toMatch(/yourself/);

    alex.send({ type: 'removeMember', id: samId });
    expect(await sam.next((m): m is ErrorMsg => m.type === 'error' && !!m.fatal)).toMatchObject({ code: 'removed' });
    await sam.closed;
    const after = await alex.state((m) => !m.team.members.some((x) => x.id === samId));
    expect(after.team.brk?.participants.map((p) => p.id) ?? []).not.toContain(samId);

    expect((await hello(code, SAM, 'Sam')).msg).toMatchObject({ type: 'error', fatal: true, code: 'removed' });
    // The ban is saved.
    hub.flush();
    startHub();
    expect((await hello(code, SAM, 'Sam')).msg).toMatchObject({ type: 'error', code: 'removed' });
    expect((await hello(code, ALEX, 'Alex')).msg.type).toBe('state');
  });
});

describe('hub access token (H5)', () => {
  const TOKEN = 'a-long-random-hub-access-token-000000000';

  it('refuses create/hello without the right token', async () => {
    startHub({ accessToken: TOKEN });
    const tries = [undefined, '', 'wrong', { toString: 1 }, TOKEN.slice(0, -1)];
    for (const token of tries) {
      const c = await connect();
      c.send({ type: 'create', teamName: 'T', clientId: 'token-client-id-00000', name: 'A', token });
      expect(await c.first()).toMatchObject({ type: 'error', fatal: true, code: 'unauthorized' });
    }
    const ok = await connect();
    ok.send({ type: 'create', teamName: 'T', clientId: 'token-client-id-00000', name: 'A', token: TOKEN });
    const code = (await ok.state()).team.code;
    const h = await connect();
    h.send({ type: 'hello', teamCode: code, clientId: 'token-client-id-00001', name: 'B' });
    expect(await h.first()).toMatchObject({ type: 'error', code: 'unauthorized' });
    const h2 = await connect();
    h2.send({ type: 'hello', teamCode: code, clientId: 'token-client-id-00001', name: 'B', token: TOKEN });
    expect((await h2.first()).type).toBe('state');
    expect(logs.join('\n')).not.toContain(TOKEN);
  });
});

describe('client addresses (M1)', () => {
  const req = (remoteAddress: string, xff?: string | string[]) =>
    ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as unknown as IncomingMessage;

  it('ignores X-Forwarded-For unless told to trust the proxy', () => {
    expect(clientAddress(req('10.9.9.9', '1.2.3.4'), false)).toBe('10.9.9.9');
    expect(clientAddress(req('10.9.9.9', '1.2.3.4'), true)).toBe('1.2.3.4');
  });

  it('uses the right-most entry (the one our proxy added)', () => {
    expect(clientAddress(req('10.9.9.9', 'spoofed, 6.6.6.6, 1.2.3.4'), true)).toBe('1.2.3.4');
    expect(clientAddress(req('10.9.9.9', ['5.5.5.5', '1.2.3.4']), true)).toBe('1.2.3.4');
    expect(clientAddress(req('10.9.9.9', 'not-an-ip'), true)).toBe('10.9.9.9');
    expect(clientAddress(req('10.9.9.9'), true)).toBe('10.9.9.9');
  });

  it.each([
    ['1.2.3.4', '1.2.3.4'],
    ['::ffff:1.2.3.4', '1.2.3.4'],
    ['2001:db8:a:b:1:2:3:4', '2001:db8:a:b::/64'],
    ['2001:db8:a:b::9', '2001:db8:a:b::/64'],
    ['2001:0db8:000a:000b::', '2001:db8:a:b::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%en0', 'fe80:0:0:0::/64'],
  ])('addressKey(%s) → %s', (ip, key) => expect(addressKey(ip)).toBe(key));

  it('applies per-address limits to the forwarded address when trusted', async () => {
    startHub({ trustProxy: true, limits: { connectionsPerIp: 1 } });
    await connectFrom('10.0.0.1');
    await connectFrom('10.0.0.2');
    // A spoofed left-hand entry doesn't make it a different address.
    await expect(connectFrom('9.9.9.9, 10.0.0.1')).rejects.toThrow(/429/);
  });

  it('ignores the header when not trusted', async () => {
    startHub({ trustProxy: false, limits: { connectionsPerIp: 1 } });
    await connectFrom('10.0.0.1');
    await expect(connectFrom('10.0.0.2')).rejects.toThrow(/429/);
  });
});

describe('hub origins and hosts (M4)', () => {
  it.each([
    [undefined, true],
    ['tauri://localhost', true],
    ['http://tauri.localhost', true],
    ['https://evil.example', false],
    ['null', false],
    ['', false],
    // The standalone hub serves no page, so "same host as the request" isn't enough.
    ['http://localhost:5173', false],
  ])('standalone hub: origin %s → %s', (origin, ok) => expect(isAllowedOrigin(origin, 'localhost:5173')).toBe(ok));

  it.each([
    ['http://localhost:5173', 'localhost:5173', true],
    ['http://127.0.0.1:5173', '127.0.0.1:5173', true],
    ['http://localhost:9999', 'localhost:5173', false],
    // DNS rebinding: Origin and Host match, but they aren't localhost.
    ['http://evil.example:5173', 'evil.example:5173', false],
  ])('dev server: origin %s with host %s → %s', (origin, host, ok) =>
    expect(isAllowedOrigin(origin, host, { allowLocalhostPages: true })).toBe(ok),
  );

  it.each([
    ['https://hub.example.com', 'hub.example.com', true],
    ['https://evil.example', 'evil.example', false],
    ['https://hub.example.com', 'evil.example', false],
  ])('public host: origin %s with host %s → %s', (origin, host, ok) =>
    expect(isAllowedOrigin(origin, host, { publicHosts: ['hub.example.com'] })).toBe(ok),
  );

  it('checks Host against SMOKE_BREAK_PUBLIC_HOST', () => {
    const policy = { publicHosts: ['hub.example.com'] };
    expect(isAllowedHost('hub.example.com', policy)).toBe(true);
    expect(isAllowedHost('HUB.example.com:443', policy)).toBe(true);
    expect(isAllowedHost('evil.example', policy)).toBe(false);
    expect(isAllowedHost(undefined, policy)).toBe(false);
    expect(isAllowedHost('anything', {})).toBe(true);
  });

  it('refuses sockets from other web pages', async () => {
    await expect(connect({ origin: 'https://evil.example' })).rejects.toThrow(/403/);
  });

  it('refuses a rebound page on the standalone hub', async () => {
    const host = new URL(url).host;
    await expect(connect({ origin: `http://${host}` })).rejects.toThrow(/403/);
  });

  it('refuses upgrades for other Host names when a public host is set', async () => {
    startHub({ publicHosts: ['hub.example.com'] });
    await expect(connect({ headers: { host: 'evil.example' } })).rejects.toThrow(/403/);
    await connect({ headers: { host: 'hub.example.com' } });
    await connect({ headers: { host: 'hub.example.com' }, origin: 'https://hub.example.com' });
  });
});

describe('hub persistence (M5)', () => {
  it('saves teams readable only by this user, atomically', async () => {
    startHub({}, join(dirname(tempFile()), 'data', 'teams.json'));
    const c = await connect();
    c.send({ type: 'create', teamName: 'Saved', clientId: 'saver-client-id-000000', name: 'S' });
    await c.state();
    await sleep(300);
    expect(statSync(dataFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(dataFile, 'utf8'))[0].name).toBe('Saved');
    expect(readdirSync(dirname(dataFile))).toEqual(['teams.json']);
  });

  it('writes a pending save on close', async () => {
    startHub({ limits: { saveDelayMs: 60_000 } });
    const c = await connect();
    c.send({ type: 'create', teamName: 'Flushed', clientId: 'flush-client-id-000000', name: 'S' });
    await c.state();
    expect(existsSync(dataFile)).toBe(false);
    hub.close();
    expect(JSON.parse(readFileSync(dataFile, 'utf8'))[0].name).toBe('Flushed');
  });

  it("doesn't rewrite the file when a known member reconnects", async () => {
    const { code } = await team();
    await sleep(300);
    const before = statSync(dataFile).mtimeMs;
    await sleep(20);
    await hello(code, SAM, 'Sam');
    await sleep(300);
    expect(statSync(dataFile).mtimeMs).toBe(before);
    // Someone new is a real change.
    await hello(code, 'newcomer-client-id-0000');
    await sleep(300);
    expect(statSync(dataFile).mtimeMs).not.toBe(before);
  });

  it('keeps a copy of a file that does not parse, then carries on', async () => {
    writeFileSync(dataFile, '[{"code": "ABCDEF", "name": "half-writ');
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(' '));
    try {
      startHub();
    } finally {
      console.error = orig;
    }
    const copies = readdirSync(dirname(dataFile)).filter((f) => f.startsWith('teams.json.corrupt-'));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(dirname(dataFile), copies[0]), 'utf8')).toBe('[{"code": "ABCDEF", "name": "half-writ');
    expect(String(errors[0])).toMatch(/not a valid team list/);
    const c = await connect();
    c.send({ type: 'create', teamName: 'After', clientId: 'after-client-id-000000', name: 'S' });
    await c.state();
    hub.flush();
    expect(JSON.parse(readFileSync(dataFile, 'utf8'))[0].name).toBe('After');
  });

  it('checks every field of saved teams', async () => {
    writeFileSync(
      dataFile,
      JSON.stringify([
        saved({ code: 'GOODONE', name: { evil: 1 }, defaultLengthMin: '99', meetingProvider: 'rm -rf', ownerId: 42, lastActive: 'soon' }),
        saved({ code: { toString: 1 } }),
        saved({ code: 'lower' }),
        null,
        'junk',
      ]),
    );
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(' '));
    try {
      startHub();
    } finally {
      console.error = orig;
    }
    expect(String(errors[0])).toMatch(/Skipped 4/);
    const { msg } = await hello('GOODONE', 'field-client-id-000000');
    expect((msg as StateMsg).team).toMatchObject({ name: 'My team', defaultLengthMin: 12, meetingProvider: 'fixed-link' });
  });

  it('puts data where SMOKE_BREAK_DATA_DIR says, else .data/ in the repo (M3)', () => {
    expect(dataFileFromEnv({ SMOKE_BREAK_DATA_DIR: '/var/lib/smoke-break' })).toBe('/var/lib/smoke-break/teams.json');
    expect(dataFileFromEnv({})).toMatch(/smoke-break\/\.data\/teams\.json$/);
  });
});

describe('hub audit log (L6)', () => {
  it('logs one JSON line per event, without codes, clientIds, tokens or links', async () => {
    startHub({ limits: { badCodeDelayMs: 0 } });
    const { alex, sam, code } = await team();
    alex.send({ type: 'settings', zoomLink: 'https://zoom.us/j/777', teamName: 'Renamed' });
    await alex.state((m) => m.team.name === 'Renamed');
    await hello('WRONGCODE1', 'wrong-client-id-000000');
    alex.send({ type: 'rotateCode' });
    const rotated = await alex.state((m) => m.team.code !== code);
    alex.send({ type: 'removeMember', id: sam.lastState().you });
    await sam.closed;

    const lines = logs.map((l) => JSON.parse(l));
    for (const l of lines) expect(l.ts).toMatch(/^\d{4}-\d\d-\d\dT/);
    const events = lines.map((l) => l.event);
    expect(events).toEqual(expect.arrayContaining(['create', 'join', 'join-failed', 'settings', 'rotate-code', 'remove-member']));
    expect(lines.find((l) => l.event === 'join')).toMatchObject({ ip: '127.0.0.1', name: 'Sam' });
    expect(lines.find((l) => l.event === 'settings').changed).toEqual(['zoomLink', 'teamName']);
    const all = logs.join('\n');
    for (const secret of [code, rotated.team.code, 'WRONGCODE1', ALEX, SAM, 'zoom.us/j/777']) expect(all).not.toContain(secret);
  });
});

describe('WindowLimiter (L4)', () => {
  it('limits per key within the window', () => {
    const l = new WindowLimiter(2, 1000);
    expect([l.take('a', 0), l.take('a', 1), l.take('a', 2), l.take('b', 2)]).toEqual([true, true, false, true]);
    expect(l.blocked('a', 500)).toBe(true);
    expect(l.take('a', 1001)).toBe(true);
  });

  it('forgets quiet keys without scanning, and caps how many it keeps', () => {
    const l = new WindowLimiter(1, 1000, 100);
    for (let i = 0; i < 10_000; i++) l.take(`k${i}`, 0);
    expect(l.size).toBe(100);
    l.take('fresh', 5000);
    expect(l.size).toBe(1);
  });
});

describe('hub breaks', () => {
  it('runs a break end to end and hands out the Zoom link', async () => {
    const { alex, sam } = await team();
    alex.send({ type: 'settings', zoomLink: 'https://zoom.us/j/42' });
    await sam.state((m) => m.team.hasZoomLink);
    alex.send({ type: 'invite' });
    await sam.state((m) => m.team.brk?.phase === 'pending');
    sam.send({ type: 'join' });
    await alex.state((m) => m.team.brk?.phase === 'lighter');
    alex.send({ type: 'light' });
    const lit = await sam.state((m) => m.team.brk?.phase === 'lit' && !!m.team.brk.meetingUrl);
    expect(lit.team.brk!.meetingUrl).toBe('https://zoom.us/j/42');
    expect(lit.team.brk!.endsAt).toBeGreaterThan(lit.serverNow);
  });

  it('leave only takes yourself out of a break', async () => {
    const { alex, sam } = await team();
    alex.send({ type: 'invite' });
    await sam.state((m) => m.team.brk?.phase === 'pending');
    sam.send({ type: 'join' });
    const s = await sam.state((m) => m.team.brk?.participants.length === 2);
    sam.send({ type: 'leave' });
    const after = await alex.state((m) => m.team.brk?.participants.length === 1);
    expect(after.team.brk!.participants[0].id).toBe(s.team.brk!.participants[0].id);
    expect(after.team.brk!.participants[0].id).not.toBe(s.you);
  });
});
