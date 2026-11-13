// Item 2: a persistent roster, owner approval, removal that sticks, old codes only for the roster, ownership.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicId } from './hub.ts';
import { ALEX, type Client, type ErrorMsg, SAM, type StateMsg, hubHarness, saved, sleep } from './hubHarness.ts';
import { parseSavedTeam } from './persistence.ts';

const h = hubHarness();

const KIM = 'kim-secret-client-id-00003';

/** Kim asks to join; resolves once the owner sees the request. */
async function knock(owner: Client, code: string, clientId = KIM, name = 'Kim') {
  const from = owner.msgs.length;
  const { msg } = await h.hello(code, clientId, name);
  expect(msg).toMatchObject({ type: 'error', fatal: true, code: 'pending' });
  const s = await owner.state((m) => m.team.pending.some((p) => p.name.startsWith(name)), from);
  return s.team.pending.find((p) => p.name.startsWith(name))!.id;
}

describe('roster (item 2)', () => {
  it('lists everyone on the team, offline people included, and keeps their names reserved', async () => {
    h.start({ limits: { disconnectGraceMs: 50 } });
    const { alex, sam, code } = await h.team();
    sam.ws.close();
    await alex.state((m) => m.team.members.some((x) => x.name === 'Sam' && !x.online));
    await sleep(150); // past the grace period: Sam is off the break, still on the roster
    const s = alex.lastState();
    expect(s.team.members.map((m) => [m.name, m.online])).toEqual([
      ['Alex', true],
      ['Sam', false],
    ]);
    // An impostor can't take an offline member's name.
    const { msg } = await h.hello(code, 'impostor-client-id-0000', 'Sam');
    expect((msg as StateMsg).team.members.map((m) => m.name)).toEqual(['Alex', 'Sam', 'Sam 2']);
  });

  it('survives a restart, names and all', async () => {
    const { code } = await h.team();
    h.hub.flush();
    h.start();
    const { msg } = await h.hello(code, ALEX, 'Alex');
    expect((msg as StateMsg).team.members).toEqual([
      { id: expect.any(String), name: 'Alex', online: true },
      { id: expect.any(String), name: 'Sam', online: false },
    ]);
  });
});

describe('owner approval (item 2)', () => {
  it('is on for new teams: a right code from someone new waits for the owner', async () => {
    const { alex, sam, code } = await h.team({ approval: true });
    expect(alex.lastState().team.requireApproval).toBe(true);
    const kimId = await knock(alex, code);
    // Only the owner sees who's waiting.
    await sleep(100);
    expect(sam.lastState().team.pending).toEqual([]);
    expect(JSON.stringify(sam.msgs)).not.toContain('Kim');
    // Asking again doesn't add a second request.
    expect((await h.hello(code, KIM, 'Kim')).msg).toMatchObject({ code: 'pending' });
    await sleep(100);
    expect(alex.lastState().team.pending).toHaveLength(1);
    // Only the owner can answer.
    sam.send({ type: 'approveMember', id: kimId, allow: true });
    expect((await sam.error(sam.msgs.length - 0)).message).toMatch(/owner/);
    alex.send({ type: 'approveMember', id: kimId, allow: true });
    await alex.state((m) => m.team.members.some((x) => x.name === 'Kim') && m.team.pending.length === 0);
    const { msg } = await h.hello(code, KIM, 'Kim');
    expect(msg).toMatchObject({ type: 'state', you: kimId });
  });

  it('turning someone away bans them (denied), and saying so', async () => {
    const { alex, code } = await h.team({ approval: true });
    const kimId = await knock(alex, code);
    alex.send({ type: 'approveMember', id: kimId, allow: false });
    await alex.state((m) => m.team.pending.length === 0 && !m.team.members.some((x) => x.id === kimId));
    expect((await h.hello(code, KIM, 'Kim')).msg).toMatchObject({ type: 'error', fatal: true, code: 'denied' });
    // Answering a request that isn't there is an error, not a crash.
    const from = alex.msgs.length;
    alex.send({ type: 'approveMember', id: kimId, allow: true });
    expect((await alex.error(from)).message).toMatch(/No such request/);
  });

  it('shows waiting people under a name nobody on the roster has', async () => {
    const { alex, code } = await h.team({ approval: true });
    await knock(alex, code, KIM, 'Alex');
    expect(alex.lastState().team.pending.map((p) => p.name)).toEqual(['Alex 2']);
  });

  it('caps requests per team and per address, and drops old ones', async () => {
    h.start({ trustProxy: true, limits: { maxPending: 3, pendingPerIp: 2, pendingTtlMs: 300 } });
    const { alex, code } = await h.team({ approval: true });
    const ask = async (i: number, ip: string) =>
      (await h.hello(code, `asker-client-id-${String(i).padStart(6, '0')}`, `P${i}`, await h.connectFrom(ip))).msg as ErrorMsg;
    expect((await ask(1, '10.0.0.1')).code).toBe('pending');
    expect((await ask(2, '10.0.0.1')).code).toBe('pending');
    expect((await ask(3, '10.0.0.1')).code).toBe('rate-limited'); // two per address
    expect((await ask(4, '10.0.0.2')).code).toBe('pending');
    expect((await ask(5, '10.0.0.3')).code).toBe('rate-limited'); // three per team
    await alex.state((m) => m.team.pending.length === 3);
    await sleep(350);
    // Expired: there's room again, and the old ones are gone from the owner's list.
    expect((await ask(6, '10.0.0.3')).code).toBe('pending');
    await alex.state((m) => m.team.pending.length === 1 && m.team.pending[0].name === 'P6');
  });

  it('when switched off, a right code joins directly; it is on for teams saved before approvals', async () => {
    writeFileSync(h.dataFile, JSON.stringify([saved({ code: 'OLDTEAM234', ownerId: publicId('OLDTEAM234', ALEX), known: [publicId('OLDTEAM234', ALEX)] })]));
    h.start();
    const { c: alex, msg } = await h.hello('OLDTEAM234', ALEX, 'Alex');
    expect((msg as StateMsg).team.requireApproval).toBe(true);
    expect((await h.hello('OLDTEAM234', KIM, 'Kim')).msg).toMatchObject({ code: 'pending' });
    alex.send({ type: 'settings', requireApproval: false });
    await alex.state((m) => !m.team.requireApproval);
    // Kim's request is still there; now Kim just gets in.
    expect((await h.hello('OLDTEAM234', KIM, 'Kim')).msg.type).toBe('state');
    expect(h.logs.some((l) => l.includes('"requireApproval"'))).toBe(true);
  });
});

describe('removal (item 2)', () => {
  it('removes an offline member, bans them and rotates the code', async () => {
    h.start({ limits: { disconnectGraceMs: 30 } });
    const { alex, sam, code } = await h.team();
    const samId = sam.lastState().you;
    sam.ws.close();
    await alex.state((m) => m.team.members.some((x) => x.id === samId && !x.online), alex.msgs.length);
    const from = alex.msgs.length;
    alex.send({ type: 'removeMember', id: samId });
    const after = await alex.state((m) => !m.team.members.some((x) => x.id === samId), from);
    expect(after.team.code).not.toBe(code);
    // Banned with the old code and the new one alike.
    expect((await h.hello(code, SAM, 'Sam')).msg).toMatchObject({ type: 'error' });
    expect((await h.hello(after.team.code, SAM, 'Sam')).msg).toMatchObject({ type: 'error', code: 'removed' });
    // A fresh identity with the old code gets nowhere (it's only an alias for the roster)…
    expect((await h.hello(code, 'fresh-sam-client-id-0000', 'Sam')).msg).toMatchObject({ code: 'bad-code' });
    // …and the ban survives a restart.
    h.hub.flush();
    h.start();
    expect((await h.hello(after.team.code, SAM, 'Sam')).msg).toMatchObject({ code: 'removed' });
  });

  it('closes a removed member’s sockets before the new code goes out, and takes them out of the break', async () => {
    const { alex, sam, code } = await h.team();
    const extra = (await h.hello(code, SAM, 'Sam')).c;
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
    for (const c of [sam, extra]) {
      expect(await c.fatal()).toMatchObject({ code: 'removed' });
      await c.closed;
    }
    const after = await alex.state((m) => m.team.code !== code);
    expect(after.team.brk?.participants.map((p) => p.id) ?? []).not.toContain(samId);
    await sleep(100);
    for (const c of [sam, extra]) expect(JSON.stringify(c.msgs)).not.toContain(after.team.code);
  });

  it('can remove a member who never reconnected after a migration (no name yet)', async () => {
    const owner = publicId('MIGRATED23', ALEX);
    const ghost = 'ghostghostghost1';
    writeFileSync(h.dataFile, JSON.stringify([saved({ code: 'MIGRATED23', ownerId: owner, known: [owner, ghost] })]));
    h.start();
    const { c: alex, msg } = await h.hello('MIGRATED23', ALEX, 'Alex');
    expect((msg as StateMsg).team.members).toEqual([
      { id: owner, name: 'Alex', online: true },
      { id: ghost, name: '', online: false },
    ]);
    alex.send({ type: 'removeMember', id: ghost });
    const s = await alex.state((m) => m.team.members.length === 1);
    expect(s.team.code).not.toBe('MIGRATED23');
  });
});

describe('old codes (item 2)', () => {
  it('replaces 6-character codes on load; the old code works only for the roster', async () => {
    const owner = publicId('ABCDEF', ALEX);
    const sam = publicId('ABCDEF', SAM);
    writeFileSync(h.dataFile, JSON.stringify([saved({ code: 'ABCDEF', ownerId: owner, known: [owner, sam] })]));
    h.start();
    const { msg } = await h.hello('abc-def', SAM, 'Sam');
    const s = msg as StateMsg;
    expect(s.type).toBe('state');
    expect(s.you).toBe(sam); // same public id: the id salt didn't change
    expect(s.team.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    // A teammate from before the upgrade who isn't on the roster asks the owner, old code or new.
    expect((await h.hello('ABCDEF', KIM, 'Kim')).msg).toMatchObject({ code: 'pending' });
    expect((await h.hello(s.team.code, KIM, 'Kim')).msg).toMatchObject({ code: 'pending' });
    // The upgrade was saved, with the old code kept as an alias, and the file before it kept aside.
    h.hub.flush();
    const file = JSON.parse(readFileSync(h.dataFile, 'utf8'));
    expect(file[0]).toMatchObject({ code: s.team.code, aliases: ['ABCDEF'], requireApproval: true });
    expect(readdirSync(dirname(h.dataFile)).some((f) => f.startsWith('teams.json.pre-roster-'))).toBe(true);
    h.start();
    const { c: alex, msg: back } = await h.hello('ABCDEF', ALEX, 'Alex');
    expect(back.type).toBe('state');
    // Once the owner replaces the code, the old short one is dead to anyone not on the roster.
    const from = alex.msgs.length;
    alex.send({ type: 'rotateCode' });
    await alex.state((m) => m.team.code !== s.team.code, from);
    expect((await h.hello('ABCDEF', 'someone-new-client-id-01', 'Lee')).msg).toMatchObject({ code: 'bad-code' });
  });
});

describe('ownership (item 2)', () => {
  it('lets the owner hand the team to someone on the roster', async () => {
    const { alex, sam } = await h.team();
    const samId = sam.lastState().you;
    let from = sam.msgs.length;
    sam.send({ type: 'transferOwner', id: samId });
    expect((await sam.error(from)).message).toMatch(/owner/);
    from = alex.msgs.length;
    alex.send({ type: 'transferOwner', id: 'nobodynobodynobo' });
    expect((await alex.error(from)).message).toMatch(/No such member/);
    alex.send({ type: 'settings', zoomLink: 'https://zoom.us/j/99' });
    await alex.state((m) => m.team.zoomLink !== '');
    alex.send({ type: 'transferOwner', id: samId });
    const s = await sam.state((m) => m.team.ownerId === samId);
    expect(s.team.zoomLink).toBe('https://zoom.us/j/99');
    const a = await alex.state((m) => m.team.ownerId === samId);
    expect(a.team.zoomLink).toBe('');
    from = alex.msgs.length;
    alex.send({ type: 'rotateCode' });
    expect((await alex.error(from)).message).toMatch(/owner/);
    expect(h.logs.some((l) => l.includes('"transfer-owner"'))).toBe(true);
  });
});

describe('saved format migration (item 2)', () => {
  it('turns known ids into roster entries, keeps owners and bans, turns approval on', () => {
    const now = Date.now();
    const t = parseSavedTeam(
      saved({ code: 'ABCDEFGHJK', ownerId: 'ownerownerowner1', known: ['memberAmemberAme', 'ownerownerowner1'], banned: ['bannedbannedbann'] }),
      now,
    )!;
    expect(t.roster).toEqual([
      { id: 'memberAmemberAme', name: '' },
      { id: 'ownerownerowner1', name: '' },
    ]);
    expect(t.banned).toEqual([{ id: 'bannedbannedbann', reason: 'removed' }]);
    expect(t.requireApproval).toBe(true);
    expect(t.aliases).toEqual([]);
    // The owner is put on the roster even if `known` didn't list them.
    expect(parseSavedTeam(saved({ code: 'ABCDEFGHJK', ownerId: 'ownerownerowner1' }), now)!.roster).toEqual([{ id: 'ownerownerowner1', name: '' }]);
    // A banned id is never on the roster.
    expect(parseSavedTeam(saved({ code: 'ABCDEFGHJK', known: ['bannedbannedbann'], banned: ['bannedbannedbann'] }), now)!.roster).toEqual([]);
  });

  it('round-trips the new format', async () => {
    const { alex, code } = await h.team({ approval: true });
    await knock(alex, code);
    h.hub.flush();
    const file = JSON.parse(readFileSync(h.dataFile, 'utf8'));
    const t = parseSavedTeam(file[0], Date.now())!;
    expect(t.roster.map((m) => m.name)).toEqual(['Alex', 'Sam']);
    expect(t.pending.map((p) => p.name)).toEqual(['Kim']);
    expect(JSON.stringify(parseSavedTeam(JSON.parse(JSON.stringify(t)), Date.now()))).toBe(JSON.stringify(t));
  });
});
