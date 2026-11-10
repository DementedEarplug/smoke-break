import type { IncomingMessage } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  addressKey,
  cleanName,
  clientAddress,
  dataFileFromEnv,
  isAllowedHost,
  isAllowedOrigin,
  nameKey,
  parseSavedTeam,
  parseTrustedProxies,
} from './hub.ts';
import { ALEX, type ErrorMsg, SAM, type StateMsg, hubHarness, saved, sleep, tempFile } from './hubHarness.ts';
import { WindowLimiter } from './limits.ts';

const h = hubHarness();
const { connect, connectFrom, hello } = h;
const team = (o?: { approval?: boolean }) => h.team(o);
const startHub = (...a: Parameters<typeof h.start>) => h.start(...a);
const logs = () => h.logs;

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
    startHub({ limits: { messageBurst: 1e9, messagesPerSecond: 1e9, addressMessageBurst: 1e9, addressMessagesPerSecond: 1e9 } });
    const { alex, sam, code } = await team();
    const stranger = await connect();
    stranger.send({ type: 'hello', clientId: 'stranger-client-id-0001', name: 'x', teamCode: { toString: 1 } });
    expect(await stranger.error()).toMatchObject({ fatal: true, code: 'bad-code' });
    const types = ['create', 'hello', 'invite', 'setLength', 'join', 'light', 'leave', 'settings', 'rotateCode', 'removeMember', 'approveMember', 'transferOwner', '__proto__', 1, null];
    const keys = ['clientId', 'name', 'teamName', 'teamCode', 'lengthMin', 'light', 'zoomLink', 'defaultLengthMin', 'requireApproval', 'id', 'allow', 'token', '__proto__'];
    for (const sock of [sam, alex]) {
      for (const type of types) for (const k of keys) for (const v of nasty) if (type !== 'rotateCode') sock.send({ type, [k]: v });
      for (const raw of ['', '{', 'null', '[]', '"x"', '123', '{"type":"settings","zoomLink":{"trim":1}}']) sock.ws.send(raw);
      sock.ws.send(Buffer.from([0xff, 0xfe, 0x00]), { binary: true });
      await sleep(100);
    }
    // Still serving, nobody was thrown out, and the code and owner weren't touched by any of it.
    expect(sam.ws.readyState).toBe(WebSocket.OPEN);
    expect(alex.ws.readyState).toBe(WebSocket.OPEN);
    const { msg } = await hello(code, SAM, 'Sam');
    const s = msg as StateMsg;
    expect(s.type).toBe('state');
    expect(s.team.code).toBe(code);
    expect(s.team.ownerId).toBe(alex.lastState().you);
    expect(s.team.members).toHaveLength(2);
  });

  it('rejects a wrong-typed setting without changing anything', async () => {
    const { alex } = await team();
    let from = alex.msgs.length;
    alex.send({ type: 'settings', teamName: 'Renamed', defaultLengthMin: { valueOf: 1 } });
    expect((await alex.error(from)).message).toMatch(/number/);
    from = alex.msgs.length;
    alex.send({ type: 'setLength', lengthMin: { valueOf: 1, toString: 1 } });
    expect((await alex.error(from)).message).toMatch(/number/);
    from = alex.msgs.length;
    alex.send({ type: 'settings', teamName: 'Renamed', requireApproval: 'yes' });
    expect((await alex.error(from)).message).toMatch(/requireApproval/);
    expect(alex.lastState().team.name).toBe('Crew');
  });
});

describe('meeting links (H1)', () => {
  // Which links pass is tested with the protocol (shared/protocol.test.ts); here, what the hub does with them.
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
    sam.send({ type: 'settings', zoomLink: 'https://zoom.us/j/evil', teamName: 'Hijacked', requireApproval: false });
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
    for (let i = 0; i < 3; i++) results.push((await h.create(`creator-client-id-${i}-000`, 'A', `T${i}`)).msg);
    expect(results.map((m) => m.type)).toEqual(['state', 'state', 'error']);
    expect(results[2]).toMatchObject({ fatal: true, code: 'rate-limited' });
  });

  it('limits new teams across all addresses (H4)', async () => {
    startHub({ trustProxy: true, limits: { createsPerHour: 2 } });
    const codes = [];
    for (let i = 0; i < 3; i++) {
      const c = await connectFrom(`10.0.0.${i + 1}`);
      const m = (await h.create(`spread-client-id-${i}-000`, 'A', 'T', c)).msg;
      codes.push(m.type === 'error' ? m.code : m.type);
    }
    expect(codes).toEqual(['state', 'state', 'rate-limited']);
  });

  it('counts a whole IPv6 /64 as one address (H4)', async () => {
    startHub({ trustProxy: true, limits: { createsPerIpPerHour: 1 } });
    const create = async (ip: string, i: number) => (await h.create(`v6-client-id-${i}-00000`, 'A', 'T', await connectFrom(ip))).msg.type;
    expect(await create('2001:db8:1:2::1', 1)).toBe('state');
    expect(await create('2001:db8:1:2:ffff:ffff:ffff:ffff', 2)).toBe('error');
    expect(await create('2001:db8:1:3::1', 3)).toBe('state');
  });

  it('never forgets a recently used team to make room; refuses the new one instead (H4)', async () => {
    const day = 86_400_000;
    // Teams other people have used (several on the roster), so they aren't junk.
    const roster = [{ id: 'aaaaaaaaaaaaaaaa', name: 'A' }, { id: 'bbbbbbbbbbbbbbbb', name: 'B' }];
    writeFileSync(
      h.dataFile,
      JSON.stringify([
        saved({ code: 'OLDONE2345', roster, requireApproval: false, lastActive: Date.now() - 10 * day }),
        saved({ code: 'RECENT2345', roster, requireApproval: false, lastActive: Date.now() - 2 * day }),
        saved({ code: 'GONEEE2345', roster, requireApproval: false, lastActive: Date.now() - 365 * day }),
      ]),
    );
    startHub({ limits: { maxTeams: 2 } });
    // A year-old team was dropped on load.
    expect((await hello('GONEEE2345', 'joiner-client-id-GONEEE')).msg).toMatchObject({ type: 'error', code: 'bad-code' });
    expect((await h.create('fresh-client-id-00000', 'F', 'Fresh')).msg).toMatchObject({ type: 'state', team: { name: 'Fresh' } });
    // OLDONE was idle for 10 days, so it made room.
    expect((await hello('OLDONE2345', 'joiner-client-id-OLDONE')).msg.type).toBe('error');
    // RECENT was used two days ago, and nobody is in it right now, but it isn't forgotten.
    expect((await h.create('more-client-id-000000', 'M', 'More')).msg).toMatchObject({ type: 'error', fatal: true, code: 'full' });
    expect((await hello('RECENT2345', 'joiner-client-id-RECENT')).msg.type).toBe('state');
  });

  it('forgets junk teams (only the creator, idle a day) first, even if recently used (item 3)', async () => {
    const day = 86_400_000;
    const roster = [{ id: 'aaaaaaaaaaaaaaaa', name: 'A' }, { id: 'bbbbbbbbbbbbbbbb', name: 'B' }];
    writeFileSync(
      h.dataFile,
      JSON.stringify([
        saved({ code: 'REALTEAM23', roster, ownerId: 'aaaaaaaaaaaaaaaa', requireApproval: false, lastActive: Date.now() - 30 * day }),
        saved({ code: 'JUNKTEAM23', roster: [roster[0]], ownerId: 'aaaaaaaaaaaaaaaa', lastActive: Date.now() - 2 * day }),
        saved({ code: 'NEWJUNK234', roster: [roster[0]], ownerId: 'aaaaaaaaaaaaaaaa', lastActive: Date.now() - 3_600_000 }),
      ]),
    );
    startHub({ limits: { maxTeams: 3 } });
    expect((await h.create('fresh-client-id-00000', 'F', 'Fresh')).msg.type).toBe('state');
    // The two-day-old junk team went, though the 30-day-old real team is older.
    expect((await hello('JUNKTEAM23', 'joiner-client-id-000001')).msg).toMatchObject({ code: 'bad-code' });
    expect((await hello('REALTEAM23', 'joiner-client-id-000002')).msg.type).toBe('state');
    expect(logs().some((l) => /team-forgotten.*unused/.test(l))).toBe(true);
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

  it('caps the roster, but lets existing members back in', async () => {
    startHub({ limits: { maxMembersPerTeam: 2 } });
    const { code } = await team();
    expect((await hello(code, 'third-client-id-000000')).msg).toMatchObject({ type: 'error', fatal: true, code: 'full' });
    expect((await hello(code, SAM, 'Sam')).msg.type).toBe('state');
  });

  it('drops a socket that stops reading instead of buffering for it (H3)', async () => {
    startHub({
      limits: {
        maxBufferedBytes: 4096,
        broadcastIntervalMs: 0,
        messageBurst: 1e9,
        messagesPerSecond: 1e9,
        addressMessageBurst: 1e9,
        addressMessagesPerSecond: 1e9,
        auditLinesPerSecond: 1e9,
        auditBurst: 1e9,
      },
    });
    const { alex, sam, code } = await team();
    // A bigger team makes bigger frames, so the kernel's socket buffer fills sooner.
    for (let i = 0; i < 40; i++) (await hello(code, `filler-client-id-${String(i).padStart(4, '0')}`, `Filler ${i} ${'y'.repeat(12)}`)).c.ws.close();
    (sam.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    const samGone = alex.state((m) => m.team.members.some((x) => x.name === 'Sam' && !x.online), alex.msgs.length);
    samGone.catch(() => {});
    let gone = false;
    void samGone.then(() => (gone = true));
    // Every rename is a real change, so every one goes out (a no-op would send nothing at all).
    // Coalescing merges changes in the same tick into one frame, so spread them out.
    for (let i = 0; i < 3000 && !gone; i++) {
      alex.send({ type: 'settings', teamName: `Crew ${i} ${'x'.repeat(10)}` });
      await sleep(1);
    }
    expect(gone).toBe(true);
    expect(logs().some((l) => JSON.parse(l).kind === 'send-buffer')).toBe(true);
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
  it('locks out an address that guesses too many codes', async () => {
    startHub({ limits: { badCodesPerIp: 2, badCodeDelayMs: 0 } });
    const real = ((await h.create('owner-client-id-000000', 'O', 'Real')).msg as StateMsg).team.code;
    const guess = async (c: string) => (await hello(c, 'guesser-client-id-0000', 'G')).msg;
    expect(await guess('AAAAAA')).toMatchObject({ type: 'error', code: 'bad-code', message: expect.stringMatching(/No team/) });
    expect(await guess('BBBBBB')).toMatchObject({ type: 'error', code: 'bad-code' });
    expect(await guess('CCCCCC')).toMatchObject({ type: 'error', code: 'rate-limited', message: expect.stringMatching(/Too many/) });
    // Even the right code is refused for someone not on the roster, until the window passes.
    expect(await guess(real)).toMatchObject({ type: 'error', code: 'rate-limited' });
  });

  it('lets roster members back in during a lockout, even after a restart (M1)', async () => {
    startHub({ limits: { badCodesPerIp: 2, badCodeDelayMs: 0 } });
    const { alex, sam, code } = await team();
    alex.ws.close();
    sam.ws.close();
    h.hub.flush();
    startHub({ limits: { badCodesPerIp: 2, badCodeDelayMs: 0 } });
    for (const g of ['AAAAAA', 'BBBBBB', 'CCCCCC']) await hello(g, 'guesser-client-id-0000');
    expect((await hello(code, SAM, 'Sam')).msg.type).toBe('state');
    expect((await hello(code, ALEX, 'Alex')).msg.type).toBe('state');
    expect((await hello(code, 'newbie-client-id-00000')).msg).toMatchObject({ type: 'error', code: 'rate-limited' });
  });

  it('lets the first person back into an ownerless team saved before owners existed, and makes them owner', async () => {
    writeFileSync(h.dataFile, JSON.stringify([saved({ code: 'LEGACY2345' })]));
    startHub({ limits: { badCodesPerIp: 1, badCodeDelayMs: 0 } });
    const first = await hello('LEGACY2345', ALEX, 'Alex');
    expect(first.msg).toMatchObject({ type: 'state' });
    expect((first.msg as StateMsg).team.ownerId).toBe((first.msg as StateMsg).you);
    // From then on, approval applies to everyone else.
    expect((await hello('LEGACY2345', SAM, 'Sam')).msg).toMatchObject({ type: 'error', code: 'pending' });
  });

  it('has no hub-wide wrong-code lockout: guesses from many addresses lock out only those addresses (item 2)', async () => {
    startHub({ trustProxy: true, limits: { badCodesPerIp: 1, badCodeDelayMs: 0 } });
    const real = ((await h.create('owner-client-id-000000', 'O', 'Real', await connectFrom('10.9.9.9'))).msg as StateMsg).team.code;
    for (let i = 0; i < 30; i++) await hello('ZZZZZZZZZZ', `spread-guess-id-${i}-000`, 'G', await connectFrom(`203.0.113.${i + 1}`));
    // A new colleague with the right code still reaches the owner.
    expect((await hello(real, 'newhire-client-id-0000', 'N', await connectFrom('10.1.1.1'))).msg).toMatchObject({ code: 'pending' });
    // A locked-out address is still locked out.
    expect((await hello(real, 'other-client-id-000000', 'N', await connectFrom('203.0.113.1'))).msg).toMatchObject({ code: 'rate-limited' });
  });

  it('lets the owner rotate the code; everyone connected gets the new one, the old one only works for the roster (H5)', async () => {
    const { alex, sam, code } = await team();
    const before = alex.lastState();
    sam.send({ type: 'rotateCode' });
    expect((await sam.error(sam.msgs.length)).message).toMatch(/owner/);
    alex.send({ type: 'rotateCode' });
    const s = await sam.state((m) => m.team.code !== code);
    const a = await alex.state((m) => m.team.code !== code);
    expect(s.team.code).toBe(a.team.code);
    expect(s.team.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    // Public ids (and so ownership) survive the rotation.
    expect(a.you).toBe(before.you);
    expect(a.team.ownerId).toBe(before.team.ownerId);
    // Someone new with the old code: as if it were wrong.
    expect((await hello(code, 'late-client-id-000000')).msg).toMatchObject({ type: 'error', code: 'bad-code' });
    expect((await hello(s.team.code, 'late-client-id-000000')).msg.type).toBe('state');
    // Sam was offline during a rotation? The old code still gets him in, and he learns the new one.
    const back = (await hello(code, SAM, 'Sam')).msg as StateMsg;
    expect(back.type).toBe('state');
    expect(back.team.code).toBe(s.team.code);
    // Saved, too.
    h.hub.flush();
    const file = readFileSync(h.dataFile, 'utf8');
    expect(file).toContain(`"code": "${s.team.code}"`);
    expect(file).not.toContain(`"code": "${code}"`);
  });

  it('keeps only the last few old codes', async () => {
    const { alex, code } = await team();
    for (let i = 0; i < 6; i++) {
      const from = alex.msgs.length;
      const prev = alex.lastState().team.code;
      alex.send({ type: 'rotateCode' });
      await alex.state((m) => m.team.code !== prev, from);
    }
    // Six rotations: the first code fell off the end of the five kept.
    expect((await hello(code, SAM, 'Sam')).msg).toMatchObject({ type: 'error', code: 'bad-code' });
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
    const code = ((await h.create('token-client-id-00000', 'A', 'T', undefined, TOKEN)).msg as StateMsg).team.code;
    expect((await hello(code, 'token-client-id-00001', 'B')).msg).toMatchObject({ type: 'error', code: 'unauthorized' });
    // With the token, they get as far as the owner's approval.
    expect((await hello(code, 'token-client-id-00001', 'B', undefined, TOKEN)).msg).toMatchObject({ type: 'error', code: 'pending' });
    expect(logs().join('\n')).not.toContain(TOKEN);
  });
});

describe('client addresses (M1, item 5)', () => {
  const req = (remoteAddress: string, xff?: string | string[]) =>
    ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as unknown as IncomingMessage;
  const loopback = parseTrustedProxies('1');
  const proxies = parseTrustedProxies('10.9.9.9, 10.20.0.0/16, fd00::/8');

  it('ignores X-Forwarded-For unless the peer is a trusted proxy', () => {
    expect(clientAddress(req('10.9.9.9', '1.2.3.4'), null)).toBe('10.9.9.9');
    expect(clientAddress(req('10.9.9.9', '1.2.3.4'), proxies)).toBe('1.2.3.4');
    // `1` means loopback only: anyone else sending the header is ignored.
    expect(clientAddress(req('10.9.9.9', '1.2.3.4'), loopback)).toBe('10.9.9.9');
    expect(clientAddress(req('127.0.0.1', '1.2.3.4'), loopback)).toBe('1.2.3.4');
    expect(clientAddress(req('::ffff:127.0.0.1', '1.2.3.4'), loopback)).toBe('1.2.3.4');
    expect(clientAddress(req('::1', '1.2.3.4'), loopback)).toBe('1.2.3.4');
    expect(clientAddress(req('10.20.3.4', '1.2.3.4'), proxies)).toBe('1.2.3.4');
    expect(clientAddress(req('10.21.3.4', '1.2.3.4'), proxies)).toBe('10.21.3.4');
    expect(clientAddress(req('fd12::1', '1.2.3.4'), proxies)).toBe('1.2.3.4');
  });

  it('uses the right-most entry that is not one of our proxies', () => {
    expect(clientAddress(req('10.9.9.9', 'spoofed, 6.6.6.6, 1.2.3.4'), proxies)).toBe('1.2.3.4');
    expect(clientAddress(req('10.9.9.9', ['5.5.5.5', '1.2.3.4'], ), proxies)).toBe('1.2.3.4');
    // CDN → nginx: the inner proxy's entry is skipped when it's listed.
    expect(clientAddress(req('10.9.9.9', '6.6.6.6, 1.2.3.4, 10.20.0.7'), proxies)).toBe('1.2.3.4');
    expect(clientAddress(req('10.9.9.9', 'not-an-ip'), proxies)).toBe('10.9.9.9');
    expect(clientAddress(req('10.9.9.9'), proxies)).toBe('10.9.9.9');
  });

  it('parses SMOKE_BREAK_TRUST_PROXY strictly', () => {
    expect(parseTrustedProxies(undefined)).toBeNull();
    expect(parseTrustedProxies('')).toBeNull();
    expect(parseTrustedProxies('0')).toBeNull();
    expect(parseTrustedProxies(false)).toBeNull();
    for (const bad of ['yes please', '10.0.0.0/33', '10.0.0.1/x', 'proxy.example.com', '10.0.0.0/8/9', '::1/129']) {
      expect(() => parseTrustedProxies(bad)).toThrow(/SMOKE_BREAK_TRUST_PROXY/);
    }
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

  it('applies per-address limits to the forwarded address when the proxy is trusted', async () => {
    startHub({ trustProxy: true, limits: { connectionsPerIp: 1 } });
    await connectFrom('10.0.0.1');
    await connectFrom('10.0.0.2');
    // A spoofed left-hand entry doesn't make it a different address.
    await expect(connectFrom('9.9.9.9, 10.0.0.1')).rejects.toThrow(/429/);
  });

  it('ignores the header when the peer is not a trusted proxy', async () => {
    startHub({ trustProxy: '10.9.9.9', limits: { connectionsPerIp: 1 } });
    await connectFrom('10.0.0.1');
    await expect(connectFrom('10.0.0.2')).rejects.toThrow(/429/);
  });

  it('refuses to start with a malformed trusted proxy list', () => {
    expect(() => startHub({ trustProxy: 'not-an-address' })).toThrow(/SMOKE_BREAK_TRUST_PROXY/);
    startHub();
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
    const host = new URL(h.url).host;
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
    await h.create('saver-client-id-000000', 'S', 'Saved');
    await sleep(300);
    expect(statSync(h.dataFile).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(h.dataFile)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(h.dataFile, 'utf8'))[0].name).toBe('Saved');
    expect(readdirSync(dirname(h.dataFile))).toEqual(['teams.json']);
  });

  it('writes a pending save on close', async () => {
    startHub({ limits: { saveDelayMs: 60_000 } });
    await h.create('flush-client-id-000000', 'S', 'Flushed');
    expect(existsSync(h.dataFile)).toBe(false);
    h.hub.close();
    expect(JSON.parse(readFileSync(h.dataFile, 'utf8'))[0].name).toBe('Flushed');
  });

  it("doesn't rewrite the file when a roster member reconnects", async () => {
    const { code } = await team();
    await sleep(300);
    const before = statSync(h.dataFile).mtimeMs;
    await sleep(20);
    await hello(code, SAM, 'Sam');
    await sleep(300);
    expect(statSync(h.dataFile).mtimeMs).toBe(before);
    // Someone new is a real change.
    await hello(code, 'newcomer-client-id-0000');
    await sleep(300);
    expect(statSync(h.dataFile).mtimeMs).not.toBe(before);
  });

  it('keeps a copy of a file that does not parse, then carries on', async () => {
    writeFileSync(h.dataFile, '[{"code": "ABCDEF", "name": "half-writ');
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(' '));
    try {
      startHub();
    } finally {
      console.error = orig;
    }
    const copies = readdirSync(dirname(h.dataFile)).filter((f) => f.startsWith('teams.json.corrupt-'));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(dirname(h.dataFile), copies[0]), 'utf8')).toBe('[{"code": "ABCDEF", "name": "half-writ');
    expect(String(errors[0])).toMatch(/not a valid team list/);
    await h.create('after-client-id-000000', 'S', 'After');
    h.hub.flush();
    expect(JSON.parse(readFileSync(h.dataFile, 'utf8'))[0].name).toBe('After');
  });

  it('checks every field of saved teams', async () => {
    writeFileSync(
      h.dataFile,
      JSON.stringify([
        saved({ code: 'GOODONE234', name: { evil: 1 }, defaultLengthMin: '99', meetingProvider: 'rm -rf', ownerId: 42, lastActive: 'soon', requireApproval: 'no', roster: 'x' }),
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
    // Ownerless, so the first one in becomes owner (approval can't apply with nobody to approve).
    const { msg } = await hello('GOODONE234', 'field-client-id-000000');
    expect((msg as StateMsg).team).toMatchObject({ name: 'My team', defaultLengthMin: 12, meetingProvider: 'fixed-link', requireApproval: true });
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
    const final = await alex.state((m) => m.team.members.length === 1);

    const lines = logs().map((l) => JSON.parse(l));
    for (const l of lines) expect(l.ts).toMatch(/^\d{4}-\d\d-\d\dT/);
    const events = lines.map((l) => l.event);
    expect(events).toEqual(
      expect.arrayContaining(['create', 'join', 'join-requested', 'approve-member', 'join-failed', 'settings', 'rotate-code', 'remove-member']),
    );
    expect(lines.find((l) => l.event === 'join')).toMatchObject({ ip: '127.0.0.1', name: 'Sam' });
    expect(lines.find((l) => l.event === 'settings' && l.changed.includes('teamName')).changed).toEqual(['zoomLink', 'teamName']);
    const all = logs().join('\n');
    for (const secret of [code, rotated.team.code, final.team.code, 'WRONGCODE1', ALEX, SAM, 'zoom.us/j/777']) expect(all).not.toContain(secret);
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

  it('sends the meeting link only to people in the break (item 7)', async () => {
    const { alex, sam, code } = await team();
    alex.send({ type: 'settings', zoomLink: 'https://zoom.us/j/4242' });
    await sam.state((m) => m.team.hasZoomLink);
    const { c: kim } = await hello(code, 'kim-client-id-000000000', 'Kim');
    const { c: lee } = await hello(code, 'lee-client-id-000000000', 'Lee');
    // Sam starts, Kim joins: the owner (Alex) and Lee aren't in the break.
    sam.send({ type: 'invite' });
    await kim.state((m) => m.team.brk?.phase === 'pending');
    kim.send({ type: 'join' });
    const k = await kim.state((m) => !!m.team.brk?.meetingUrl);
    const s = await sam.state((m) => !!m.team.brk?.meetingUrl);
    expect(k.team.brk!.meetingUrl).toBe('https://zoom.us/j/4242');
    expect(s.team.brk!.meetingUrl).toBe('https://zoom.us/j/4242');
    await lee.state((m) => m.team.brk?.phase === 'lighter');
    await alex.state((m) => m.team.brk?.phase === 'lighter');
    await sleep(100);
    expect(lee.states().every((m) => m.team.brk?.meetingUrl == null)).toBe(true);
    expect(JSON.stringify(lee.msgs)).not.toContain('4242');
    expect(alex.states().every((m) => m.team.brk?.meetingUrl == null)).toBe(true);
    // Once Lee joins, Lee gets it too.
    lee.send({ type: 'join' });
    expect((await lee.state((m) => !!m.team.brk?.meetingUrl)).team.brk!.meetingUrl).toBe('https://zoom.us/j/4242');
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

// Keep the ErrorMsg type import used (handy in new tests).
export type { ErrorMsg };
