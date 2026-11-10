// Review 2, items 2, 4, 6 and 8: strangers can't use up shared limits; one person can't lock
// out colleagues behind the same address; proxy secret; owner-action and break throttles; junk teams.

import type { IncomingMessage } from 'node:http';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { DEFAULT_LIMITS, PROXY_HEADER, clientAddress, parseTrustedProxies, publicId } from './hub.ts';
import { type Client, type StateMsg, hubHarness, saved, sleep, tempDir } from './hubHarness.ts';

const h = hubHarness();

const ALICE = 'alice-token-0123456789abcdef';
const BOB = 'bob-token-0123456789abcdefgh';
const MAL = 'mallory-token-0123456789abcd';
const ALL = `alice:${ALICE}\nbob:${BOB}\nmallory:${MAL}\n`;
const SECRET = 'proxy-secret-0123456789abcdef';

function tokensFile(lines = ALL) {
  const file = join(tempDir(), 'tokens');
  writeFileSync(file, lines);
  chmodSync(file, 0o600);
  return file;
}

/** Errors a client got since `from`. */
const errorsSince = (c: Client, from: number) => c.msgs.slice(from).filter((m) => m.type === 'error');

describe('unidentified connections (item 2)', () => {
  it('have short deadlines and message allowances by default', () => {
    expect(DEFAULT_LIMITS.helloTimeoutMs).toBeLessThanOrEqual(3000);
    expect(DEFAULT_LIMITS.messagesBeforeHello).toBe(2);
    expect(DEFAULT_LIMITS.unidentifiedPerIp).toBeLessThan(DEFAULT_LIMITS.connectionsPerIp);
    expect(DEFAULT_LIMITS.maxUnidentified).toBeLessThan(DEFAULT_LIMITS.maxConnections);
  });

  it('may send a couple of messages before hello, and are closed after that', async () => {
    const ok = await h.connect();
    ok.ws.send('junk');
    ok.send({ type: 'invite' });
    expect((await h.create('early-client-id-000000', 'E', 'T', ok)).msg.type).toBe('state');
    const bad = await h.connect();
    for (let i = 0; i < 3; i++) bad.ws.send('junk');
    expect(await bad.closed).toBe(1008);
    expect(h.logs.some((l) => l.includes('"messages-before-hello"'))).toBe(true);
  });

  it('count against a per-address budget that groups IPv6 by /56, apart from identified ones', async () => {
    h.start({ trustProxy: true, limits: { unidentifiedPerIp: 2, connectionsPerIp: 2 } });
    await h.connectFrom('2001:db8:0:100::1');
    await h.connectFrom('2001:db8:0:1ff:ffff::1'); // same /56
    await expect(h.connectFrom('2001:db8:0:180::1')).rejects.toThrow(/429/);
    // Another /56 has its own.
    const other = await h.connectFrom('2001:db8:0:200::1');
    // Identified connections from the full /56's neighbourhood (same /64 as the second) are counted elsewhere.
    expect((await h.create('v6-client-id-00000000', 'A', 'T', other)).msg.type).toBe('state');
    await h.connectFrom('2001:db8:0:200::2');
  });

  it("don't drain the address's message budget, so they can't get a real user's socket closed", async () => {
    h.start({ trustProxy: true, limits: { addressMessageBurst: 6, addressMessagesPerSecond: 0.001, messagesBeforeHello: 2 } });
    const { alex } = await h.team();
    // Lots of junk sockets on the same address, each sending what it's allowed before hello.
    const junk = await Promise.all(Array.from({ length: 40 }, () => h.connect()));
    for (const j of junk) (j.ws.send('x'), j.ws.send('y'));
    await sleep(100);
    const from = alex.msgs.length;
    alex.send({ type: 'light' }); // "There is no break to light."
    expect((await alex.error(from)).message).toMatch(/no break/i);
    expect(alex.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('time out quickly without saying hello', async () => {
    h.start({ limits: { helloTimeoutMs: 100 } });
    const c = await h.connect();
    await Promise.race([c.closed, sleep(1000).then(() => Promise.reject(new Error('still open')))]);
    await sleep(50);
    expect(h.hub.stats().unidentified).toBe(0);
  });
});

describe('an exhausted shared budget (item 2)', () => {
  it('drops messages but never closes a socket that kept to its own limit', async () => {
    h.start({ limits: { addressMessageBurst: 10, addressMessagesPerSecond: 0.001 } });
    const { alex, sam } = await h.team();
    for (let i = 0; i < 25; i++) sam.send({ type: 'light' }); // within Sam's own 30, past the shared 10
    await sleep(200);
    expect(sam.ws.readyState).toBe(WebSocket.OPEN);
    expect(alex.ws.readyState).toBe(WebSocket.OPEN);
    expect(h.logs.some((l) => l.includes('"message-budget"'))).toBe(true);
    expect(h.logs.some((l) => l.includes('"message-flood"'))).toBe(false);
  });
});

describe('limits keyed by token label (item 2)', () => {
  it('gives each label its own message budget, even behind one address', async () => {
    h.start({ accessTokensFile: tokensFile(), limits: { addressMessageBurst: 10, addressMessagesPerSecond: 0.001 } });
    const alice = (await h.create('alice-client-id-0000000', 'Alice', 'T', undefined, ALICE)).c;
    const mal = (await h.create('mallory-client-id-00000', 'M', 'T', undefined, MAL)).c;
    for (let i = 0; i < 25; i++) mal.send({ type: 'light' });
    await sleep(100);
    const from = alice.msgs.length;
    alice.send({ type: 'light' });
    expect((await alice.error(from)).message).toMatch(/no break/i);
  });

  it("locks out a label's wrong-code guesses, not its colleagues behind the same address", async () => {
    h.start({ accessTokensFile: tokensFile(), limits: { badCodesPerIp: 2, badCodeDelayMs: 0 } });
    const alice = (await h.create('alice-client-id-0000000', 'Alice', 'T', undefined, ALICE)).c;
    const code = alice.lastState().team.code;
    for (const g of ['AAAAAAAAAA', 'BBBBBBBBBB', 'CCCCCCCCCC']) await h.hello(g, 'mallory-client-id-00000', 'M', undefined, MAL);
    expect((await h.hello(code, 'mallory-client-id-00000', 'M', undefined, MAL)).msg).toMatchObject({ code: 'rate-limited' });
    expect((await h.hello(code, 'bob-client-id-000000000', 'Bob', undefined, BOB)).msg).toMatchObject({ code: 'pending' });
  });

  it('counts join requests per label, not per address', async () => {
    h.start({ accessTokensFile: tokensFile(), limits: { pendingPerIp: 1, pendingRequestsPerIpPerHour: 1, identitiesPerLabel: 10 } });
    const alice = (await h.create('alice-client-id-0000000', 'Alice', 'T', undefined, ALICE)).c;
    const code = alice.lastState().team.code;
    expect((await h.hello(code, 'mallory-client-id-00001', 'M', undefined, MAL)).msg).toMatchObject({ code: 'pending' });
    expect((await h.hello(code, 'mallory-client-id-00002', 'M', undefined, MAL)).msg).toMatchObject({ code: 'rate-limited' });
    expect((await h.hello(code, 'bob-client-id-000000000', 'Bob', undefined, BOB)).msg).toMatchObject({ code: 'pending' });
  });

  it('counts identified connections per label, not per address', async () => {
    h.start({ accessTokensFile: tokensFile(), limits: { connectionsPerIp: 2, maxSocketsPerMember: 10 } });
    const alice = (await h.create('alice-client-id-0000000', 'Alice', 'T', undefined, ALICE)).c;
    alice.send({ type: 'settings', requireApproval: false });
    const code = (await alice.state((m) => !m.team.requireApproval)).team.code;
    await h.hello(code, 'mallory-client-id-00001', 'M', undefined, MAL);
    await h.hello(code, 'mallory-client-id-00001', 'M', undefined, MAL);
    expect((await h.hello(code, 'mallory-client-id-00001', 'M', undefined, MAL)).msg).toMatchObject({ code: 'rate-limited' });
    expect((await h.hello(code, 'bob-client-id-000000000', 'Bob', undefined, BOB)).msg.type).toBe('state');
  });
});

describe('proxy secret (item 4)', () => {
  const viaProxy = (ip: string, secret = SECRET) => ({ headers: { 'x-forwarded-for': ip, [PROXY_HEADER]: secret } });

  it('refuses upgrades without it, and only then believes X-Forwarded-For', async () => {
    h.start({ trustProxy: true, proxySecret: SECRET, limits: { unidentifiedPerIp: 1 } });
    // A local process connecting around the proxy, with or without a made-up address.
    await expect(h.connect()).rejects.toThrow(/403/);
    await expect(h.connectFrom('10.0.0.1')).rejects.toThrow(/403/);
    await expect(h.connect(viaProxy('10.0.0.1', 'wrong-secret-0123456789abcd'))).rejects.toThrow(/403/);
    await expect(h.connect(viaProxy('10.0.0.1', SECRET.slice(0, -1)))).rejects.toThrow(/403/);
    await h.connect(viaProxy('10.0.0.1'));
    await expect(h.connect(viaProxy('10.0.0.1'))).rejects.toThrow(/429/);
    await h.connect(viaProxy('10.0.0.2'));
    expect(h.hub.stats().proxySecret).toBe(true);
    expect(h.logs.filter((l) => l.includes('"proxy-secret"'))).toHaveLength(1); // throttled
    expect(h.logs.join('\n')).not.toContain(SECRET);
  });

  it('must be long enough', () => {
    expect(() => h.start({ proxySecret: 'short' })).toThrow(/SMOKE_BREAK_PROXY_SECRET/);
    h.start();
  });

  it('a Unix socket peer is the proxy (its X-Forwarded-For is believed); a TCP peer still needs to be trusted', () => {
    const req = (remoteAddress: string | undefined, xff: string) =>
      ({ socket: { remoteAddress }, headers: { 'x-forwarded-for': xff } }) as unknown as IncomingMessage;
    expect(clientAddress(req(undefined, '1.2.3.4'), null, true)).toBe('1.2.3.4');
    expect(clientAddress(req(undefined, '1.2.3.4'), null, false)).toBe('unix');
    expect(clientAddress(req('127.0.0.1', '1.2.3.4'), null, true)).toBe('127.0.0.1');
    expect(clientAddress(req('127.0.0.1', '1.2.3.4'), parseTrustedProxies('1'), true)).toBe('1.2.3.4');
  });
});

describe('owner actions (item 6)', () => {
  it('are rate limited per owner and team', async () => {
    h.start({ limits: { ownerActionsPerMinute: 3 } });
    const { alex } = await h.team();
    const from = alex.msgs.length;
    for (let i = 0; i < 5; i++) alex.send({ type: 'rotateCode' });
    await sleep(200);
    expect(errorsSince(alex, from).map((e) => e.type === 'error' && e.message)).toEqual([expect.stringMatching(/Slow down/), expect.stringMatching(/Slow down/)]);
    expect(h.logs.filter((l) => l.includes('"rotate-code"'))).toHaveLength(3);
  });

  it("can't crowd other teams' events out of the log by handing a team back and forth", async () => {
    h.start({ limits: { auditBurst: 30, auditLinesPerSecond: 0.01 } });
    const { alex, sam } = await h.team();
    const ids = [alex.lastState().you, sam.lastState().you];
    for (let i = 0; i < 100; i++) [alex, sam][i % 2].send({ type: 'transferOwner', id: ids[(i + 1) % 2] });
    await sleep(300);
    expect(h.logs.filter((l) => l.includes('"transfer-owner"')).length).toBeLessThanOrEqual(2 * DEFAULT_LIMITS.ownerActionsPerMinute);
    // Another team's owner still gets their removal logged.
    const other = (await h.create('other-owner-client-id-00', 'O', 'Other')).c;
    other.send({ type: 'settings', requireApproval: false });
    const code = (await other.state((m) => !m.team.requireApproval)).team.code;
    const victim = (await h.hello(code, 'other-member-client-id0', 'V')).msg as StateMsg;
    await other.state((m) => m.team.members.length === 2);
    const from = other.msgs.length;
    other.send({ type: 'removeMember', id: victim.you });
    await other.state((m) => m.team.members.length === 1, from);
    expect(h.logs.some((l) => l.includes('"remove-member"'))).toBe(true);
  });

  it('approvals have their own, larger allowance', async () => {
    // One approval goes on letting Sam in; three more are allowed, the fourth isn't.
    h.start({ trustProxy: true, limits: { ownerActionsPerMinute: 1, approvalsPerMinute: 4 } });
    const { alex, code } = await h.team({ approval: true });
    for (let i = 0; i < 4; i++) await h.hello(code, `asker-client-id-${i}000000`, `P${i}`, await h.connectFrom(`10.0.0.${i + 1}`));
    const s = await alex.state((m) => m.team.pending.length === 4);
    const from = alex.msgs.length;
    for (const p of s.team.pending) alex.send({ type: 'approveMember', id: p.id, allow: true });
    await alex.state((m) => m.team.members.length === 5, from);
    await sleep(100);
    expect(errorsSince(alex, from)).toHaveLength(1);
  });
});

describe('break cooldown (item 8)', () => {
  it('survives reconnecting and covers every device under a label', async () => {
    h.start({ accessTokensFile: tokensFile() });
    const alice = (await h.create('alice-client-id-0000000', 'Alice', 'T', undefined, ALICE)).c;
    alice.send({ type: 'settings', requireApproval: false });
    const code = (await alice.state((m) => !m.team.requireApproval)).team.code;
    const laptop = (await h.hello(code, 'alice-laptop-client-id0', 'Alice', undefined, ALICE)).c;
    const bob = (await h.hello(code, 'bob-client-id-000000000', 'Bob', undefined, BOB)).c;
    alice.send({ type: 'invite' });
    await bob.state((m) => m.team.brk?.phase === 'pending');
    alice.send({ type: 'leave' });
    await bob.state((m) => m.team.brk?.phase === 'out');
    // Reconnecting doesn't reset it.
    alice.ws.close();
    const again = (await h.hello(code, 'alice-client-id-0000000', 'Alice', undefined, ALICE)).c;
    let from = again.msgs.length;
    again.send({ type: 'invite' });
    expect((await again.error(from)).message).toMatch(/Wait/);
    // Nor does another of her devices.
    from = laptop.msgs.length;
    laptop.send({ type: 'invite' });
    expect((await laptop.error(from)).message).toMatch(/Wait/);
    // Someone else can.
    bob.send({ type: 'invite' });
    await again.state((m) => m.team.brk?.phase === 'pending' && m.team.brk.startedByName === 'Bob');
  });
});

describe('junk teams (item 8)', () => {
  it('forgets a team made without a per-person token that never had a break with two people, however many joined', async () => {
    const day = 86_400_000;
    const ids = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'];
    const roster = ids.map((id, i) => ({ id, name: `P${i}` }));
    const old = Date.now() - 2 * day;
    writeFileSync(
      h.dataFile,
      JSON.stringify([
        saved({ code: 'PADDED2345', ref: '00000001', ownerId: ids[0], roster, hadGroupBreak: false, lastActive: old }),
        saved({ code: 'USEDTM2345', ref: '00000002', ownerId: ids[0], roster, hadGroupBreak: true, lastActive: old }),
        saved({ code: 'LABELL2345', ref: '00000003', ownerId: ids[0], roster: roster.map((m) => ({ ...m, label: 'alice' })), hadGroupBreak: false, lastActive: old }),
        // From before the field: several people on it, so taken to be really used.
        saved({ code: 'LEGACY2345', ref: '00000004', ownerId: ids[0], roster, lastActive: old }),
      ]),
    );
    h.start({ limits: { maxTeams: 4 } });
    expect((await h.create('fresh-client-id-00000', 'F', 'Fresh')).msg.type).toBe('state');
    expect(h.logs.some((l) => l.includes('"team-forgotten"') && l.includes('unused'))).toBe(true);
    expect((await h.hello('PADDED2345', 'someone-client-id-0000')).msg).toMatchObject({ code: 'bad-code' });
    // Several devices under one label are one person (review 3, item 3): junk too.
    expect((await h.create('more-client-id-000000', 'M', 'More')).msg.type).toBe('state');
    expect((await h.hello('LABELL2345', 'someone-client-id-0000')).msg).toMatchObject({ code: 'bad-code' });
    // Nothing else counts as junk: the next new team is refused.
    expect((await h.create('most-client-id-000000', 'M', 'Most')).msg).toMatchObject({ code: 'full' });
  });

  it('remembers once a break had two or more people', async () => {
    const { alex, sam } = await h.team();
    h.hub.flush();
    expect(JSON.parse(readFileSync(h.dataFile, 'utf8'))[0].hadGroupBreak).toBe(false);
    alex.send({ type: 'invite' });
    await sam.state((m) => m.team.brk?.phase === 'pending');
    sam.send({ type: 'join' });
    await alex.state((m) => m.team.brk?.participants.length === 2);
    h.hub.flush();
    await sleep(250);
    h.hub.flush();
    expect(JSON.parse(readFileSync(h.dataFile, 'utf8'))[0].hadGroupBreak).toBe(true);
    void publicId;
  });
});
