// Review 3 (low-severity findings), items 1-6: the audit log can't be drowned by
// outsiders, join/leave can't make the hub resend a big team's state without
// limit, teams can't be hoarded, the data file must hold at least one valid team,
// and a label is one person.

import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createHub, publicId } from './hub.ts';
import { type Client, type StateMsg, hubHarness, saved, sleep, tempDir } from './hubHarness.ts';

const h = hubHarness();

const ALICE = 'alice-token-0123456789abcdef';
const BOB = 'bob-token-0123456789abcdefgh';
const MAL = 'mallory-token-0123456789abcd';
const ALL = `alice:${ALICE}\nbob:${BOB}\nmallory:${MAL}\n`;
const DAY = 86_400_000;

function tokensFile(lines = ALL) {
  const file = join(tempDir(), 'tokens');
  writeFileSync(file, lines);
  chmodSync(file, 0o600);
  return file;
}

const events = () => h.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
const errorsSince = (c: Client, from: number) => c.msgs.slice(from).filter((m) => m.type === 'error');

describe('audit log under a flood of refused upgrades (item 1)', () => {
  it('gives refused upgrades a small budget of their own; owners’ approvals and revocations are still logged', async () => {
    const file = tokensFile();
    h.start({ accessTokensFile: file, trustProxy: true, limits: { tokensPollMs: 30, auditPreBurst: 5, auditPreLinesPerSecond: 1 } });
    const alice = (await h.create('alice-client-id-0000000', 'Alice', 'T', undefined, ALICE)).c;
    const code = alice.lastState().team.code;
    expect((await h.hello(code, 'bob-client-id-000000000', 'Bob', undefined, BOB)).msg).toMatchObject({ code: 'pending' });
    const req = await alice.state((m) => m.team.pending.length === 1);
    const before = h.logs.length;
    // 300 upgrades without a token, each from its own /64: each has its own once-a-minute key.
    await Promise.all(
      Array.from({ length: 300 }, (_, i) => h.connectFrom(`2001:db8:${(i >> 8).toString(16)}:${(i & 255).toString(16)}::1`).catch(() => {})),
    );
    alice.send({ type: 'approveMember', id: req.team.pending[0].id, allow: true });
    await alice.state((m) => m.team.members.length === 2);
    writeFileSync(file, `alice:${ALICE}\n`); // Bob and Mallory are revoked
    await sleep(150);
    h.hub.summarizeAudit();
    const lines = events().slice(before);
    const refused = lines.filter((l) => l.event === 'limit' && l.kind === 'unauthorized');
    expect(refused.length).toBeLessThanOrEqual(6);
    expect(lines.some((l) => l.event === 'approve-member' && l.approvedLabel === 'bob')).toBe(true);
    expect(lines.some((l) => l.event === 'tokens-reloaded')).toBe(true);
    // The rest are counted, by kind.
    const dropped = lines.find((l) => l.event === 'audit-dropped' && l.class === 'pre')!;
    expect(dropped).toMatchObject({ kinds: { unauthorized: expect.any(Number) } });
    expect(refused.length + (dropped.count as number)).toBe(300);
  });

  it('logs every closed connection of a revoked label in one line', async () => {
    const file = tokensFile();
    h.start({ accessTokensFile: file, limits: { tokensPollMs: 30 } });
    const { code } = await (async () => {
      const a = (await h.create('alice-client-id-0000000', 'Alice', 'T', undefined, ALICE)).c;
      a.send({ type: 'settings', requireApproval: false });
      return { code: (await a.state((m) => !m.team.requireApproval)).team.code };
    })();
    const m1 = (await h.hello(code, 'mallory-client-id-00001', 'M', undefined, MAL)).c;
    const m2 = (await h.hello(code, 'mallory-client-id-00001', 'M', undefined, MAL)).c;
    writeFileSync(file, `alice:${ALICE}\nbob:${BOB}\n`);
    await Promise.all([m1.closed, m2.closed]);
    const revoked = events().filter((l) => l.event === 'token-revoked');
    expect(revoked).toEqual([expect.objectContaining({ label: 'mallory', connections: 2, teams: [expect.any(String)] })]);
  });
});

describe('joining and leaving a break (item 2)', () => {
  it('allows a handful of changes per person, then says slow down and changes nothing', async () => {
    h.start({ limits: { joinLeavePerWindow: 4, joinLeaveWindowMs: 60_000 } });
    const { alex, sam } = await h.team();
    alex.send({ type: 'invite' });
    await sam.state((m) => m.team.brk?.phase === 'pending');
    for (let i = 0; i < 4; i++) {
      const from = alex.msgs.length;
      sam.send({ type: i % 2 ? 'leave' : 'join' });
      await alex.state((m) => m.team.brk!.participants.length === (i % 2 ? 1 : 2), from);
    }
    await sleep(50);
    const a0 = alex.msgs.length;
    const s0 = sam.msgs.length;
    sam.send({ type: 'join' });
    sam.send({ type: 'invite' }); // joining a running break, by another name
    const err = await sam.error(s0);
    expect(err.message).toMatch(/Slow down/);
    expect(err.fatal).toBeUndefined();
    await sleep(100);
    expect(alex.msgs.slice(a0)).toEqual([]); // nothing changed, nothing sent
    expect(sam.ws.readyState).toBe(WebSocket.OPEN);
    expect(events().some((l) => l.event === 'limit' && l.kind === 'join-leave')).toBe(true);
    // Others still can.
    const from = sam.msgs.length;
    alex.send({ type: 'leave' });
    await sam.state((m) => m.team.brk?.phase === 'out', from);
  });

  it('counts every device under one label together', async () => {
    h.start({ accessTokensFile: tokensFile(), limits: { joinLeavePerWindow: 2, joinLeaveWindowMs: 60_000 } });
    const alice = (await h.create('alice-client-id-0000000', 'Alice', 'T', undefined, ALICE)).c;
    alice.send({ type: 'settings', requireApproval: false });
    const code = (await alice.state((m) => !m.team.requireApproval)).team.code;
    const d1 = (await h.hello(code, 'mallory-client-id-00001', 'M1', undefined, MAL)).c;
    const d2 = (await h.hello(code, 'mallory-client-id-00002', 'M2', undefined, MAL)).c;
    alice.send({ type: 'invite' });
    await d1.state((m) => m.team.brk?.phase === 'pending');
    d1.send({ type: 'join' });
    await alice.state((m) => m.team.brk?.participants.length === 2);
    d1.send({ type: 'leave' });
    await alice.state((m) => m.team.brk?.participants.length === 1);
    const from = d2.msgs.length;
    d2.send({ type: 'join' });
    expect((await d2.error(from)).message).toMatch(/Slow down/);
  });

  it("spaces a big team's updates out so its bytes per second stay bounded", async () => {
    // ~700-byte frames to two sockets: at 2000 bytes/s the next update waits ~0.7 s.
    h.start({ limits: { teamBroadcastBytesPerSecond: 2000 } });
    const { alex, sam } = await h.team();
    await sleep(1000);
    const s0 = sam.msgs.length;
    const t0 = Date.now();
    alex.send({ type: 'settings', teamName: 'One' });
    await sam.state((m) => m.team.name === 'One', s0);
    const t1 = Date.now();
    alex.send({ type: 'settings', teamName: 'Two' });
    alex.send({ type: 'settings', teamName: 'Three' });
    await sam.state((m) => m.team.name === 'Three', s0);
    const t2 = Date.now();
    const bytes = JSON.stringify(sam.msgs.at(-1)).length * 2;
    expect(t1 - t0).toBeLessThan(200);
    expect(t2 - t1).toBeGreaterThanOrEqual(Math.floor((bytes * 1000) / 2000) - 50);
    // Changes in between shared one update.
    expect(sam.msgs.slice(s0).filter((m) => m.type === 'state')).toHaveLength(2);
  });
});

describe('team hoarding (item 3)', () => {
  it('caps the teams one label owns, and logs each label’s totals', async () => {
    h.start({ accessTokensFile: tokensFile(), limits: { teamsPerLabel: 2 } });
    for (let i = 0; i < 2; i++) expect((await h.create(`alice-client-id-000000${i}`, 'Alice', `T${i}`, undefined, ALICE)).msg.type).toBe('state');
    expect((await h.create('alice-client-id-0000009', 'Alice', 'T9', undefined, ALICE)).msg).toMatchObject({ type: 'error', fatal: true, code: 'full' });
    // Someone else isn't affected.
    expect((await h.create('bob-client-id-000000000', 'Bob', 'B', undefined, BOB)).msg.type).toBe('state');
    const creates = events().filter((l) => l.event === 'create' && l.label === 'alice');
    expect(creates.map((l) => [l.labelTeams, l.labelCreatesToday])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(events().some((l) => l.event === 'limit' && l.kind === 'teams-per-label')).toBe(true);
  });

  it('never forgets a team with two people (labels) on it, or one that had a group break; forgets one person’s devices', async () => {
    const roster2 = [
      { id: 'aaaaaaaaaaaaaaaa', name: 'A', label: 'alice' },
      { id: 'bbbbbbbbbbbbbbbb', name: 'B', label: 'bob' },
    ];
    const devices = [
      { id: 'cccccccccccccccc', name: 'M', label: 'mallory' },
      { id: 'dddddddddddddddd', name: 'M2', label: 'mallory' },
    ];
    const lonely = [{ id: 'eeeeeeeeeeeeeeee', name: 'E' }];
    const old = Date.now() - 30 * DAY;
    writeFileSync(
      h.dataFile,
      JSON.stringify([
        saved({ code: 'TWOPEOPLE2', ref: '00000001', ownerId: 'aaaaaaaaaaaaaaaa', roster: roster2, hadGroupBreak: false, lastActive: old - DAY }),
        saved({ code: 'HADBREAK23', ref: '00000002', ownerId: 'eeeeeeeeeeeeeeee', roster: lonely, hadGroupBreak: true, lastActive: old - DAY }),
        saved({ code: 'HOARDED234', ref: '00000003', ownerId: 'cccccccccccccccc', roster: devices, hadGroupBreak: false, lastActive: old }),
      ]),
    );
    h.start({ accessTokensFile: tokensFile(), limits: { maxTeams: 3 } });
    expect((await h.create('bob-client-id-000000000', 'Bob', 'New', undefined, BOB)).msg.type).toBe('state');
    expect(events().find((l) => l.event === 'team-forgotten')).toMatchObject({ team: '00000003', ownerLabel: 'mallory' });
    // The hub is full of real teams now: refused, and both real teams are still there.
    expect((await h.create('alice-client-id-0000000', 'Alice', 'Another', undefined, ALICE)).msg).toMatchObject({ code: 'full' });
    expect((await h.hello('TWOPEOPLE2', 'someone-client-id-000000', 'S', undefined, ALICE)).msg).toMatchObject({ code: 'pending' });
    expect((await h.hello('HADBREAK23', 'someone-client-id-000001', 'S', undefined, BOB)).msg).toMatchObject({ code: 'pending' });
  });

  it('forgets teams nobody has used for teamIdleDays while running, not just on load', async () => {
    const owner = { id: 'aaaaaaaaaaaaaaaa', name: 'A' };
    writeFileSync(h.dataFile, JSON.stringify([saved({ code: 'IDLETEAM23', ref: '00000009', ownerId: owner.id, roster: [owner], lastActive: Date.now() - DAY + 300 })]));
    h.start({ limits: { teamIdleDays: 1, housekeepingMs: 100 } });
    await sleep(700);
    expect(events().find((l) => l.event === 'team-forgotten')).toMatchObject({ team: '00000009', reason: 'idle 1 days' });
    expect((await h.hello('IDLETEAM23', 'someone-client-id-000000')).msg).toMatchObject({ code: 'bad-code' });
  });
});

describe('the team file (item 5)', () => {
  it('refuses to start when the file has entries but none is a valid team', () => {
    writeFileSync(h.dataFile, JSON.stringify([{ code: 'lower' }, null, 'junk']));
    expect(() => createHub({ dataFile: h.dataFile, accessToken: '', accessTokensFile: '', log: () => {} })).toThrow(/None of the 3 entries .* is a valid team.*corrupt-/);
    expect(readdirSync(dirname(h.dataFile)).some((f) => f.startsWith('teams.json.corrupt-'))).toBe(true);
    // An empty list is fine: no teams yet.
    writeFileSync(h.dataFile, '[]');
    expect(() => createHub({ dataFile: h.dataFile, accessToken: '', accessTokensFile: '', log: () => {} }).close()).not.toThrow();
  });

  it('starts when only some are invalid, naming each dropped one and keeping the file as it was', async () => {
    const original = JSON.stringify([
      saved({ code: 'GOODTEAM23', ref: '0000000a' }),
      saved({ code: 'bad', ref: '0000000b' }),
      saved({ code: 'GOODTEAM23', ref: '0000000c' }), // same code again
      { ref: 'not-a-ref', code: 42 },
    ]);
    writeFileSync(h.dataFile, original);
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(' '));
    try {
      h.start();
    } finally {
      console.error = orig;
    }
    const text = errors.join('\n');
    expect(text).toContain('Dropped team 0000000b (entry 2)');
    expect(text).toContain('Dropped team 0000000c (entry 3)');
    expect(text).toContain('Dropped entry 4 (no ref)');
    expect(text).not.toContain('GOODTEAM23');
    const copy = readdirSync(dirname(h.dataFile)).find((f) => f.startsWith('teams.json.partial-'))!;
    expect(readFileSync(join(dirname(h.dataFile), copy), 'utf8')).toBe(original);
    expect(events().find((l) => l.event === 'load')).toMatchObject({ teams: 1, invalid: 3 });
    expect((await h.hello('GOODTEAM23', 'someone-client-id-000000')).msg).toMatchObject({ code: 'pending' });
    expect(existsSync(h.dataFile)).toBe(true);
  });
});

describe('a label is one person (item 6)', () => {
  it("removing an identity under the owner's own label removes only that device, and says so in the log", async () => {
    h.start({ accessTokensFile: tokensFile() });
    const alice = (await h.create('alice-client-id-0000000', 'Alice', 'T', undefined, ALICE)).c;
    alice.send({ type: 'settings', requireApproval: false });
    const code = (await alice.state((m) => !m.team.requireApproval)).team.code;
    const laptop = (await h.hello(code, 'alice-laptop-client-id0', 'Alice', undefined, ALICE)).msg as StateMsg;
    await alice.state((m) => m.team.members.length === 2);
    const from = alice.msgs.length;
    alice.send({ type: 'removeMember', id: laptop.you });
    const s = await alice.state((m) => m.team.members.length === 1, from);
    expect(errorsSince(alice, from)).toEqual([]);
    expect(events().find((l) => l.event === 'remove-member')).toMatchObject({ removedLabel: 'alice', ownDevice: true });
    h.hub.flush();
    expect(JSON.parse(readFileSync(h.dataFile, 'utf8'))[0].bannedLabels).toEqual([]);
    // That device is banned; Alice herself, on a new device, is not.
    expect((await h.hello(s.team.code, 'alice-laptop-client-id0', 'Alice', undefined, ALICE)).msg).toMatchObject({ code: 'removed' });
    expect((await h.hello(s.team.code, 'alice-tablet-client-id0', 'Alice', undefined, ALICE)).msg.type).toBe('state');
    void publicId;
  });
});
