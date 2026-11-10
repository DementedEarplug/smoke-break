// Review 4 (low-severity findings), items 1-5: handing teams over doesn't free a
// slot, every change that sends a team its state is limited per person, a bad
// data file can't fill the disk, checking a token costs the same however many
// there are, and strict mode (SMOKE_BREAK_ENTERPRISE=1) enforces the
// recommended settings.

import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccessTokens, MAX_TOKEN_LINES, parseTokensFile } from './accessTokens.ts';
import { runAdmin } from './admin.ts';
import { checkDeployment, createHub } from './hub.ts';
import { type Client, type StateMsg, hubHarness, saved, sleep, tempDir } from './hubHarness.ts';
import { MAX_COPIES, keepCopy } from './persistence.ts';

const h = hubHarness();

const ALICE = 'alice-token-0123456789abcdef';
const BOB = 'bob-token-0123456789abcdefgh';
const MAL = 'mallory-token-0123456789abcd';
const ALL = `alice:${ALICE}\nbob:${BOB}\nmallory:${MAL}\n`;

function tokensFile(lines = ALL) {
  const file = join(tempDir(), 'tokens');
  writeFileSync(file, lines);
  chmodSync(file, 0o600);
  return file;
}

const events = () => h.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
const statesSince = (c: Client, from: number) => c.msgs.slice(from).filter((m) => m.type === 'state');

/** `owner` makes a team (approval off); `others` join it with their tokens. */
async function teamOf(owner: [string, string], ...others: [string, string][]) {
  const o = (await h.create(`${owner[0]}-client-id-000000`, owner[0], 'T', undefined, owner[1])).c;
  o.send({ type: 'settings', requireApproval: false });
  const code = (await o.state((m) => !m.team.requireApproval)).team.code;
  const rest: Client[] = [];
  for (const [name, token] of others) rest.push((await h.hello(code, `${name}-client-id-000000`, name, undefined, token)).c);
  await o.state((m) => m.team.members.length === others.length + 1);
  return { o, code, rest };
}

describe('teams per label can’t be dodged by handing teams over (item 1)', () => {
  it('counts teams a label made that still exist, whoever owns them now, and logs both counts', async () => {
    h.start({ accessTokensFile: tokensFile(), limits: { teamsPerLabel: 2 } });
    const { o: alice, rest } = await teamOf(['alice', ALICE], ['bob', BOB]);
    const bobId = (rest[0].lastState() as StateMsg).you;
    alice.send({ type: 'transferOwner', id: bobId });
    await alice.state((m) => m.team.ownerId === bobId);
    // Alice owns nothing now, but made one team: one more, and that's it.
    expect((await h.create('alice-client-id-000001', 'Alice', 'T2', undefined, ALICE)).msg.type).toBe('state');
    expect((await h.create('alice-client-id-000002', 'Alice', 'T3', undefined, ALICE)).msg).toMatchObject({ code: 'full', fatal: true });
    const creates = events().filter((l) => l.event === 'create' && l.label === 'alice');
    expect(creates.map((l) => [l.labelTeams, l.labelOwns, l.labelCreated])).toEqual([
      [1, 1, 1],
      [2, 1, 2],
    ]);
    expect(events().find((l) => l.event === 'transfer-owner')).toMatchObject({
      label: 'alice',
      toLabel: 'bob',
      createdBy: 'alice',
      labelOwns: 0,
      labelCreated: 1,
      toLabelOwns: 1,
      toLabelCreated: 0,
    });
  });

  it('refuses to hand a team to someone who already holds the most teams', async () => {
    h.start({ accessTokensFile: tokensFile(), limits: { teamsPerLabel: 2 } });
    for (let i = 0; i < 2; i++) expect((await h.create(`bob-client-id-00000${i}`, 'Bob', `B${i}`, undefined, BOB)).msg.type).toBe('state');
    const { o: alice, rest } = await teamOf(['alice', ALICE], ['bob', BOB]);
    const bobId = (rest[0].lastState() as StateMsg).you;
    const from = alice.msgs.length;
    alice.send({ type: 'transferOwner', id: bobId });
    const err = await alice.error(from);
    expect(err.message).toMatch(/already has 2 teams/);
    expect(err.fatal).toBeUndefined();
    await sleep(50);
    expect(alice.lastState().team.ownerId).toBe(alice.lastState().you);
    expect(events().some((l) => l.event === 'limit' && l.kind === 'teams-per-label' && l.label === 'alice')).toBe(true);
    expect(events().some((l) => l.event === 'transfer-owner')).toBe(false);
    // One of her own devices can still take it: it's Alice's team either way.
    const laptop = (await h.hello(alice.lastState().team.code, 'alice-laptop-client-id0', 'Alice2', undefined, ALICE)).msg as StateMsg;
    alice.send({ type: 'transferOwner', id: laptop.you });
    await alice.state((m) => m.team.ownerId === laptop.you);
  });

  it('keeps who made a team in the file; teams from before count for their owner', async () => {
    const owner = { id: 'aaaaaaaaaaaaaaaa', name: 'A', label: 'alice' };
    const other = { id: 'bbbbbbbbbbbbbbbb', name: 'B', label: 'bob' };
    writeFileSync(
      h.dataFile,
      JSON.stringify([
        saved({ code: 'OLDTEAM234', ref: '00000001', ownerId: owner.id, roster: [owner, other] }),
        saved({ code: 'MADEBYBOB2', ref: '00000002', ownerId: owner.id, roster: [owner, other], createdBy: 'bob' }),
      ]),
    );
    h.start({ accessTokensFile: tokensFile(), limits: { teamsPerLabel: 2 } });
    // Make it save.
    expect((await h.create('mallory-client-id-00000', 'M', 'M', undefined, MAL)).msg.type).toBe('state');
    await sleep(300);
    const file = JSON.parse(readFileSync(h.dataFile, 'utf8')) as { ref: string; createdBy: string | null }[];
    expect(Object.fromEntries(file.map((t) => [t.ref, t.createdBy]))).toMatchObject({ '00000001': 'alice', '00000002': 'bob' });
    // Bob made one of them (and owns none): one more for him; Alice owns two: none for her.
    expect((await h.create('bob-client-id-000000000', 'Bob', 'B', undefined, BOB)).msg.type).toBe('state');
    expect((await h.create('bob-client-id-000000001', 'Bob', 'B', undefined, BOB)).msg).toMatchObject({ code: 'full' });
    expect((await h.create('alice-client-id-000000', 'Alice', 'A', undefined, ALICE)).msg).toMatchObject({ code: 'full' });
  });

  it('admin set-owner is not held to the cap, says so, and keeps who made the team', () => {
    const file = join(tempDir(), 'teams.json');
    const owner = { id: 'aaaaaaaaaaaaaaaa', name: 'A', label: 'alice' };
    const other = { id: 'bbbbbbbbbbbbbbbb', name: 'B', label: 'bob' };
    writeFileSync(file, JSON.stringify([saved({ code: 'ADMINTEAM2', ref: '0a0b0c0d', ownerId: owner.id, roster: [owner, other] })]));
    chmodSync(file, 0o600);
    const out: string[] = [];
    expect(runAdmin(['--file', file, 'set-owner', '0a0b0c0d', other.id], (l) => out.push(l))).toBe(0);
    expect(out.join('\n')).toMatch(/isn't held to the hub's limit of teams per label.*Label bob now holds 1 team/);
    expect(JSON.parse(readFileSync(file, 'utf8'))[0]).toMatchObject({ ownerId: other.id, createdBy: 'alice' });
  });
});

describe('every change that sends the team its state is limited per person (item 2)', () => {
  it('limits changing a pending break’s length like joining and leaving', async () => {
    h.start({ accessTokensFile: tokensFile(), limits: { joinLeavePerWindow: 3, joinLeaveWindowMs: 60_000 } });
    const { o: alice, rest } = await teamOf(['alice', ALICE], ['bob', BOB]);
    const [bob] = rest;
    bob.send({ type: 'invite' });
    await alice.state((m) => m.team.brk?.phase === 'pending');
    for (let i = 0; i < 3; i++) {
      const from = alice.msgs.length;
      bob.send({ type: 'setLength', lengthMin: i % 2 ? 10 : 15 });
      await alice.state((m) => m.team.brk!.lengthMin === (i % 2 ? 10 : 15), from);
    }
    await sleep(50);
    const a0 = alice.msgs.length;
    const b0 = bob.msgs.length;
    bob.send({ type: 'setLength', lengthMin: 10 });
    expect((await bob.error(b0)).message).toMatch(/Slow down/);
    await sleep(100);
    expect(statesSince(alice, a0)).toEqual([]);
    expect(events().some((l) => l.event === 'limit' && l.kind === 'set-length' && l.label === 'bob')).toBe(true);
    // Setting it to what it already is costs nothing and sends nothing.
    bob.send({ type: 'setLength', lengthMin: 15 });
    await sleep(100);
    expect(statesSince(alice, a0)).toEqual([]);
  });

  it('limits new names on reconnect, keeps the old one when over, and logs each change of a roster name', async () => {
    h.start({ accessTokensFile: tokensFile(), limits: { joinLeavePerWindow: 4, joinLeaveWindowMs: 60_000 } });
    const { o: alice, code } = await teamOf(['alice', ALICE]);
    const bobId = 'bob-client-id-000000000';
    const names: string[] = [];
    // Each round: connect under a new name (one change), then drop (another).
    for (let i = 0; i < 4; i++) {
      const { c, msg } = await h.hello(code, bobId, `Bob${i}`, undefined, BOB);
      names.push((msg as StateMsg).team.members.find((m) => m.id === (msg as StateMsg).you)!.name);
      c.ws.close();
      await c.closed;
      await sleep(30);
    }
    expect(names).toEqual(['Bob0', 'Bob1', 'Bob1', 'Bob1']);
    const renames = events().filter((l) => l.event === 'rename');
    expect(renames).toEqual([expect.objectContaining({ label: 'bob', from: 'Bob0', to: 'Bob1', team: expect.any(String), member: expect.any(String) })]);
    expect(events().some((l) => l.event === 'limit' && l.kind === 'rename' && l.label === 'bob')).toBe(true);
    void alice;
  });

  it('sends coming and going at most a few times per window, and the last state always arrives', async () => {
    h.start({ accessTokensFile: tokensFile(), limits: { joinLeavePerWindow: 4, joinLeaveWindowMs: 600 } });
    const { o: alice, code } = await teamOf(['alice', ALICE]);
    await sleep(700);
    const a0 = alice.msgs.length;
    const t0 = Date.now();
    let last: Client | null = null;
    for (let i = 0; i < 20; i++) {
      last = (await h.hello(code, 'bob-client-id-000000000', 'Bob', undefined, BOB)).c;
      if (i < 19) {
        last.ws.close();
        await last.closed;
      }
    }
    // 39 changes of Bob's presence (20 online, 19 offline); without a limit, about one update each.
    // With it: 4 per window at once, plus one held-back update per window.
    const windows = Math.ceil((Date.now() - t0) / 600);
    await sleep(700);
    const sent = statesSince(alice, a0).length;
    expect(sent).toBeLessThanOrEqual(5 * windows + 1);
    expect(sent).toBeLessThan(15);
    // Bob is online in the end, and Alice was told.
    expect(alice.lastState().team.members.find((m) => m.name === 'Bob')!.online).toBe(true);
    expect(events().some((l) => l.event === 'limit' && l.kind === 'presence' && l.label === 'bob')).toBe(true);
    void last;
  });

  it('limits owners’ settings changes', async () => {
    h.start({ limits: { joinLeavePerWindow: 4, joinLeaveWindowMs: 60_000 } });
    const { alex, sam } = await h.team(); // two changes for Alex: coming online, and switching approval off
    for (let i = 1; i <= 2; i++) {
      alex.send({ type: 'settings', teamName: `Crew ${i}` });
      await sam.state((m) => m.team.name === `Crew ${i}`);
    }
    const s0 = sam.msgs.length;
    const a0 = alex.msgs.length;
    alex.send({ type: 'settings', teamName: 'Crew 3' });
    expect((await alex.error(a0)).message).toMatch(/Slow down/);
    await sleep(100);
    expect(statesSince(sam, s0)).toEqual([]);
    expect(events().some((l) => l.event === 'limit' && l.kind === 'settings')).toBe(true);
  });
});

describe('copies of a bad data file (item 3)', () => {
  it('keeps one copy of the same bad file however often the hub is started on it', () => {
    writeFileSync(h.dataFile, '[{"code": "ABCDEF", "na');
    for (let i = 0; i < 5; i++) expect(() => createHub({ dataFile: h.dataFile, accessToken: '', accessTokensFile: '', log: () => {} })).toThrow(/not a valid team list.*corrupt-/);
    expect(readdirSync(dirname(h.dataFile)).filter((f) => f.startsWith('teams.json.corrupt-'))).toHaveLength(1);
  });

  it('keeps at most MAX_COPIES of each kind, deleting the oldest, and never another kind’s', () => {
    const dir = tempDir();
    const file = join(dir, 'teams.json');
    writeFileSync(file, 'roster file');
    keepCopy(file, 'pre-roster', 1000);
    const made: string[] = [];
    for (let i = 0; i < MAX_COPIES + 3; i++) {
      writeFileSync(file, `broken ${i}`);
      made.push(keepCopy(file, 'corrupt', 2000 + i).path);
    }
    const left = readdirSync(dir).sort();
    expect(left.filter((f) => f.includes('.corrupt-'))).toEqual(made.slice(-MAX_COPIES).map((p) => p.slice(dir.length + 1)));
    expect(left).toContain('teams.json.pre-roster-1000');
    for (const f of left.filter((f) => f !== 'teams.json')) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    // The same content again, under any kind: the copy already kept.
    writeFileSync(file, 'roster file');
    expect(keepCopy(file, 'corrupt', 9999)).toEqual({ path: join(dir, 'teams.json.pre-roster-1000'), existed: true });
  });
});

describe('access tokens: cost and bounds (item 4)', () => {
  const fileOf = (n: number) => {
    const lines = Array.from({ length: n }, (_, i) => `user${i}:${'t'.repeat(20)}${String(i).padStart(8, '0')}`);
    return tokensFile(`${lines.join('\n')}\n`);
  };
  const costOf = (n: number) => {
    const t = new AccessTokens({ shared: '', file: fileOf(n), pollMs: 1e9, onReload: () => {}, log: () => {} });
    try {
      expect(t.check(`${'t'.repeat(20)}${String(n - 1).padStart(8, '0')}`)?.label).toBe(`user${n - 1}`);
      expect(t.check('wrong-token-0123456789abc')).toBeNull();
      const t0 = performance.now();
      for (let i = 0; i < 5000; i++) t.check(`wrong-token-${i}-xxxxxxxxxxxxxxx`);
      return (performance.now() - t0) / 5000;
    } finally {
      t.close();
    }
  };

  it('costs about the same for a wrong token with 100 or 50,000 people', () => {
    costOf(100); // warm up
    const small = costOf(100);
    const big = costOf(MAX_TOKEN_LINES);
    // A scan of 50,000 digests took ~500x as long; a lookup takes about the same.
    expect(big).toBeLessThan(small * 10 + 0.01);
  });

  it('refuses a file with too many lines, or labels and tokens that are too long, without echoing a token', () => {
    const many = `${Array.from({ length: MAX_TOKEN_LINES + 1 }, () => '# comment').join('\n')}\n`;
    expect(() => parseTokensFile(many)).toThrow(`at most ${MAX_TOKEN_LINES}`);
    expect(() => parseTokensFile(`${'a'.repeat(65)}:${ALICE}`)).toThrow(/1-64/);
    const long = 'x'.repeat(513);
    let message = '';
    try {
      parseTokensFile(`alice:${long}`);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/16-512/);
    expect(message).not.toContain(long);
    expect(() => h.start({ accessTokensFile: tokensFile(many) })).toThrow(/SMOKE_BREAK_ACCESS_TOKENS_FILE: it has 50001 lines/);
    h.start();
  });
});

describe('strict mode, SMOKE_BREAK_ENTERPRISE=1 (item 5)', () => {
  const HOST = 'hub.example.com';
  const strict = { enterprise: true, publicHosts: [HOST] };

  it('refuses to start without per-person tokens, a public host and a proxy secret or socket, listing all of them', () => {
    let message = '';
    try {
      h.start({ enterprise: true, accessToken: 'shared-token-0123456789abcdef' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/SMOKE_BREAK_ENTERPRISE=1/);
    expect(message).toMatch(/SMOKE_BREAK_ACCESS_TOKENS_FILE instead of the shared SMOKE_BREAK_ACCESS_TOKEN/);
    expect(message).toMatch(/SMOKE_BREAK_PUBLIC_HOST/);
    expect(message).toMatch(/SMOKE_BREAK_PROXY_SECRET or SMOKE_BREAK_SOCKET/);
    expect(() => h.start({ ...strict, accessTokensFile: tokensFile() })).toThrow(/SMOKE_BREAK_PROXY_SECRET or SMOKE_BREAK_SOCKET/);
    // A non-loopback HOST is fine with the proxy secret; on a Unix socket, HOST doesn't apply.
    expect(() => h.start({ ...strict, accessTokensFile: tokensFile(), proxySecret: 'proxy-secret-0123456789ab', listenHost: '0.0.0.0' })).not.toThrow();
    expect(() => h.start({ ...strict, accessTokensFile: tokensFile(), unixSocket: true })).not.toThrow();
    expect(checkDeployment({ enterprise: true, tokenMode: 'file', publicHosts: [HOST], proxySecret: false, unixSocket: false, trustsProxy: false, listenHost: '0.0.0.0' }).missing).toEqual([
      expect.stringMatching(/SMOKE_BREAK_PROXY_SECRET or SMOKE_BREAK_SOCKET/),
      expect.stringMatching(/HOST=0\.0\.0\.0 is not a loopback address/),
    ]);
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      expect(checkDeployment({ enterprise: true, tokenMode: 'file', publicHosts: [HOST], proxySecret: false, unixSocket: false, trustsProxy: false, listenHost: host }).missing).toHaveLength(1);
    }
    h.start();
  });

  it('keeps owner approval on for every team, refusing to switch it off', async () => {
    const owner = { id: 'aaaaaaaaaaaaaaaa', name: 'A', label: 'alice' };
    writeFileSync(h.dataFile, JSON.stringify([saved({ code: 'OPENTEAM23', ref: '00000001', ownerId: owner.id, roster: [owner], requireApproval: false })]));
    h.start({ ...strict, accessTokensFile: tokensFile(), unixSocket: true });
    expect(events().find((l) => l.event === 'load')).toMatchObject({ enterprise: true, approvalSwitchedOn: 1 });
    const alice = await h.connect({ headers: { host: HOST } }, ALICE);
    alice.send({ type: 'create', teamName: 'T', clientId: 'alice-client-id-000000', name: 'Alice' });
    const s = await alice.state();
    expect(s.team.requireApproval).toBe(true);
    const from = alice.msgs.length;
    alice.send({ type: 'settings', requireApproval: false, teamName: 'Renamed' });
    expect((await alice.error(from)).message).toMatch(/approval .* can't be switched off/);
    await sleep(50);
    expect(alice.lastState().team).toMatchObject({ requireApproval: true, name: 'T' });
    // The team saved with approval off has it on again: a new person waits for the owner.
    const bob = await h.connect({ headers: { host: HOST } }, BOB);
    bob.send({ type: 'hello', teamCode: 'OPENTEAM23', clientId: 'bob-client-id-000000000', name: 'Bob' });
    expect(await bob.fatal()).toMatchObject({ code: 'pending' });
  });

  it('without strict mode, gives one warning per missing protection', () => {
    const base = { enterprise: false, tokenMode: 'file' as const, publicHosts: [HOST], proxySecret: true, unixSocket: false, trustsProxy: true };
    expect(checkDeployment(base)).toEqual({ missing: [], warnings: [] });
    expect(checkDeployment({ ...base, publicHosts: [] }).warnings).toEqual([expect.stringMatching(/SMOKE_BREAK_PUBLIC_HOST is not set/)]);
    expect(checkDeployment({ ...base, proxySecret: false }).warnings).toEqual([expect.stringMatching(/SMOKE_BREAK_TRUST_PROXY is set without/)]);
    expect(checkDeployment({ ...base, proxySecret: false, unixSocket: true }).warnings).toEqual([]);
    expect(checkDeployment({ ...base, tokenMode: 'shared' }).warnings).toEqual([expect.stringMatching(/one shared access token/)]);
    expect(checkDeployment({ ...base, tokenMode: 'none', publicHosts: [], proxySecret: false }).warnings).toHaveLength(3);
    expect(h.hub.stats().warnings).toEqual([expect.stringMatching(/PUBLIC_HOST/), expect.stringMatching(/no access token required/)]);
  });
});
