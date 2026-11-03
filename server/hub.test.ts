import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ClientMsg, ServerMsg } from '../shared/protocol.ts';
import { isValidMeetingLink } from '../shared/protocol.ts';
import { createHub, isAllowedOrigin } from './hub.ts';

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

describe('isValidMeetingLink', () => {
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
    ['not a url', false],
  ])('%s → %s', (link, ok) => expect(isValidMeetingLink(link)).toBe(ok));
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

  it("rejects settings from anyone but the owner", async () => {
    const { alex, sam } = await team();
    const from = sam.msgs.length;
    sam.send({ type: 'settings', zoomLink: 'https://zoom.us/j/evil', teamName: 'Hijacked' });
    expect((await sam.error(from)).message).toMatch(/owner/);
    const last = alex.msgs.filter((m): m is StateMsg => m.type === 'state').at(-1)!;
    expect(last.team.name).toBe('Crew');
    expect(last.team.zoomLink).toBe('');
  });

  it('rejects non-Zoom links', async () => {
    const { alex } = await team();
    const from = alex.msgs.length;
    alex.send({ type: 'settings', zoomLink: 'https://evil.example/login' });
    expect((await alex.error(from)).message).toMatch(/zoom/i);
  });
});

describe('hub limits', () => {
  it('closes sockets that send oversized messages', async () => {
    const c = await connect();
    const closed = new Promise<number>((r) => c.ws.once('close', r));
    c.ws.send('x'.repeat(64 * 1024));
    expect(await closed).toBe(1009);
  });

  it('limits how many teams one address can create', async () => {
    hub.close();
    hub = createHub({ dataFile: join(mkdtempSync(join(tmpdir(), 'sb-hub-')), 'teams.json'), limits: { createsPerIpPerHour: 2 } });
    const results = [];
    for (let i = 0; i < 3; i++) {
      const c = await connect();
      c.send({ type: 'create', teamName: `T${i}`, clientId: `creator-client-id-${i}-000`, name: 'A' });
      results.push((await c.next((_m): _m is ServerMsg => true)).type);
    }
    expect(results).toEqual(['state', 'state', 'error']);
  });

  it('refuses new teams when full of active ones, else forgets the stalest empty one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-hub-'));
    const saved = { name: 'Old', defaultLengthMin: 12, zoomLink: '', meetingProvider: 'fixed-link', ownerId: null };
    writeFileSync(
      join(dir, 'teams.json'),
      JSON.stringify([
        { ...saved, code: 'OLDONE', lastActive: Date.now() - 5 * 86_400_000 },
        { ...saved, code: 'NEWONE', lastActive: Date.now() - 86_400_000 },
        { ...saved, code: 'GONEEE', lastActive: Date.now() - 365 * 86_400_000 },
      ]),
    );
    hub.close();
    hub = createHub({ dataFile: join(dir, 'teams.json'), limits: { maxTeams: 2 } });
    const join_ = async (code: string) => {
      const c = await connect();
      c.send({ type: 'hello', teamCode: code, clientId: `joiner-client-id-${code}`, name: 'J' });
      return c.next((_m): _m is ServerMsg => true);
    };
    // A year-old team was dropped on load.
    expect((await join_('GONEEE')).type).toBe('error');
    const c = await connect();
    c.send({ type: 'create', teamName: 'Fresh', clientId: 'fresh-client-id-00000', name: 'F' });
    expect((await c.state()).team.name).toBe('Fresh');
    // OLDONE was the stalest empty team, so it made room; NEWONE is still there.
    expect((await join_('OLDONE')).type).toBe('error');
    expect((await join_('NEWONE')).type).toBe('state');
    // Now both teams have people in them, so there's no room.
    const d = await connect();
    d.send({ type: 'create', teamName: 'More', clientId: 'more-client-id-000000', name: 'M' });
    expect((await d.error()).message).toMatch(/full/);
  });

  it('throttles message floods', async () => {
    const { alex } = await team();
    const closed = new Promise<number>((r) => alex.ws.once('close', r));
    for (let i = 0; i < 200; i++) alex.send({ type: 'leave' });
    expect(await closed).toBe(1008);
  });

  it('caps connections per address', async () => {
    hub.close();
    hub = createHub({ dataFile: join(mkdtempSync(join(tmpdir(), 'sb-hub-')), 'teams.json'), limits: { connectionsPerIp: 2 } });
    await connect();
    await connect();
    await expect(connect()).rejects.toThrow(/429/);
  });
});

describe('hub invite codes', () => {
  it('locks out an address that guesses too many codes', async () => {
    hub.close();
    hub = createHub({
      dataFile: join(mkdtempSync(join(tmpdir(), 'sb-hub-')), 'teams.json'),
      limits: { badCodesPerIp: 2, badCodeDelayMs: 0 },
    });
    const owner = await connect();
    owner.send({ type: 'create', teamName: 'Real', clientId: 'owner-client-id-000000', name: 'O' });
    const real = (await owner.state()).team.code;
    const guess = async (c: string) => {
      const g = await connect();
      g.send({ type: 'hello', teamCode: c, clientId: 'guesser-client-id-0000', name: 'G' });
      return g.next((_m): _m is ServerMsg => true);
    };
    expect(await guess('AAAAAA')).toMatchObject({ type: 'error', message: expect.stringMatching(/No team/) });
    expect(await guess('BBBBBB')).toMatchObject({ type: 'error', message: expect.stringMatching(/No team/) });
    expect(await guess('CCCCCC')).toMatchObject({ type: 'error', message: expect.stringMatching(/Too many/) });
    // Even the right code is refused until the window passes.
    expect(await guess(real)).toMatchObject({ type: 'error', message: expect.stringMatching(/Too many/) });
  });
});

describe('hub origins', () => {
  it.each([
    [undefined, true],
    ['tauri://localhost', true],
    ['http://tauri.localhost', true],
    ['http://localhost:5173', true],
    ['https://evil.example', false],
    ['http://localhost:9999', false],
    ['null', false],
  ])('origin %s → %s', (origin, ok) => expect(isAllowedOrigin(origin, 'localhost:5173')).toBe(ok));

  it('refuses sockets from other web pages', async () => {
    const ws = new WebSocket(url, { origin: 'https://evil.example' });
    await expect(new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)))).rejects.toThrow(/403/);
  });
});

describe('hub persistence', () => {
  it('saves teams readable only by this user', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sb-hub-')), 'data', 'teams.json');
    hub.close();
    hub = createHub({ dataFile: file });
    const c = await connect();
    c.send({ type: 'create', teamName: 'Saved', clientId: 'saver-client-id-000000', name: 'S' });
    await c.state();
    await new Promise((r) => setTimeout(r, 300));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))[0].name).toBe('Saved');
  });
});

describe('hub breaks', () => {
  it('runs a break end to end and hands out the Zoom link', async () => {
    const { alex, sam } = await team();
    alex.send({ type: 'settings', zoomLink: 'https://zoom.us/j/42' });
    await sam.state((m) => m.team.zoomLink === 'https://zoom.us/j/42');
    alex.send({ type: 'invite' });
    await sam.state((m) => m.team.brk?.phase === 'pending');
    sam.send({ type: 'join' });
    await alex.state((m) => m.team.brk?.phase === 'lighter');
    alex.send({ type: 'light' });
    const lit = await sam.state((m) => m.team.brk?.phase === 'lit' && !!m.team.brk.meetingUrl);
    expect(lit.team.brk!.meetingUrl).toBe('https://zoom.us/j/42');
    expect(lit.team.brk!.endsAt).toBeGreaterThan(lit.serverNow);
  });

  it("leave only takes yourself out of a break", async () => {
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
