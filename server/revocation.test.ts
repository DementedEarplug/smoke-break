// Review 2, item 1: revoking or removing a person cuts them off, whatever token or identity they come back with.

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicId } from './hub.ts';
import { type Client, type StateMsg, hubHarness, saved, sleep, tempDir } from './hubHarness.ts';

const h = hubHarness();

const ALICE = 'alice-token-0123456789abcdef';
const BOB = 'bob-token-0123456789abcdefgh';
const MAL = 'mallory-token-0123456789abcd';
const SHARED = 'shared-token-0123456789abcdef';
const ALICE_ID = 'alice-client-id-0000000';
const BOB_ID = 'bob-client-id-000000000';
const ALL = `alice:${ALICE}\nbob:${BOB}\nmallory:${MAL}\n`;

function tokensFile(lines: string) {
  const file = join(tempDir(), 'tokens');
  writeFileSync(file, lines);
  chmodSync(file, 0o600);
  return file;
}

/** Alice (owner) creates a team with approval off; returns her client and the code. */
async function aliceTeam(): Promise<{ alice: Client; code: string }> {
  const alice = (await h.create(ALICE_ID, 'Alice', 'T', undefined, ALICE)).c;
  alice.send({ type: 'settings', requireApproval: false });
  const s = await alice.state((m) => !m.team.requireApproval);
  return { alice, code: s.team.code };
}

describe('a revoked label (item 1)', () => {
  it("can't get back in with a colleague's token and its old client id, and its team is reported for an admin", async () => {
    const file = tokensFile(ALL);
    h.start({ accessTokensFile: file, limits: { tokensPollMs: 30 } });
    const { alice, code } = await aliceTeam();
    const bob = (await h.hello(code, BOB_ID, 'Bob', undefined, BOB)).c;
    writeFileSync(file, `bob:${BOB}\nmallory:${MAL}\n`); // Alice has left the company
    expect(await alice.fatal()).toMatchObject({ code: 'unauthorized' });
    // Her own token doesn't even get a socket.
    await expect(h.connect({}, ALICE)).rejects.toThrow(/401/);
    // Her old client id with Bob's (or Mallory's) token: her roster entry only takes her label.
    for (const token of [BOB, MAL]) {
      expect((await h.hello(code, ALICE_ID, 'Alice', undefined, token)).msg).toMatchObject({ type: 'error', fatal: true, code: 'unauthorized' });
    }
    await sleep(50);
    expect(bob.ws.readyState).toBe(bob.ws.OPEN);
    expect(bob.lastState().team.ownerId).toBe(publicId(code, ALICE_ID));
    const line = h.logs.map((l) => JSON.parse(l)).find((l) => l.event === 'owner-token-revoked');
    expect(line).toMatchObject({ team: expect.any(String), owner: publicId(code, ALICE_ID), label: 'alice', fix: expect.stringContaining('set-owner') });
  });

  it("can't use a labelled roster entry under a shared token either (hub switched to one)", async () => {
    h.start({ accessTokensFile: tokensFile(ALL) });
    const { code } = await aliceTeam();
    h.hub.flush();
    h.start({ accessToken: SHARED });
    expect((await h.hello(code, ALICE_ID, 'Alice', undefined, SHARED)).msg).toMatchObject({ code: 'unauthorized' });
  });

  it('loses its waiting join requests, at once or when the hub starts', async () => {
    const file = tokensFile(ALL);
    h.start({ accessTokensFile: file, limits: { tokensPollMs: 30 } });
    const alice = (await h.create(ALICE_ID, 'Alice', 'T', undefined, ALICE)).c;
    const code = alice.lastState().team.code;
    expect((await h.hello(code, 'mallory-client-id-00000', 'M', undefined, MAL)).msg).toMatchObject({ code: 'pending' });
    expect((await h.hello(code, BOB_ID, 'Bob', undefined, BOB)).msg).toMatchObject({ code: 'pending' });
    await alice.state((m) => m.team.pending.length === 2);
    writeFileSync(file, `alice:${ALICE}\nbob:${BOB}\n`);
    const s = await alice.state((m) => m.team.pending.length === 1);
    expect(s.team.pending[0]).toMatchObject({ name: 'Bob', label: 'bob' });
    // Removed from the file while the hub was down: dropped on startup.
    h.hub.flush();
    h.start({ accessTokensFile: tokensFile(`alice:${ALICE}\n`) });
    const back = (await h.hello(code, ALICE_ID, 'Alice', undefined, ALICE)).msg as StateMsg;
    expect(back.team.pending).toEqual([]);
  });
});

describe('removing a person (item 1)', () => {
  it('removes and bans every identity under their label, and the label, before the new code goes out', async () => {
    h.start({ accessTokensFile: tokensFile(ALL), limits: { identitiesPerLabel: 3 } });
    const { alice, code } = await aliceTeam();
    const m1 = (await h.hello(code, 'mallory-client-id-00001', 'Mallory', undefined, MAL)).c;
    const m2 = (await h.hello(code, 'mallory-client-id-00002', 'Mal', undefined, MAL)).c;
    const bob = (await h.hello(code, BOB_ID, 'Bob', undefined, BOB)).c;
    alice.send({ type: 'settings', requireApproval: true });
    await alice.state((m) => m.team.requireApproval);
    expect((await h.hello(code, 'mallory-client-id-00003', 'M3', undefined, MAL)).msg).toMatchObject({ code: 'pending' });
    const before = await alice.state((m) => m.team.members.length === 4 && m.team.pending.length === 1);
    const id1 = m1.lastState().you;
    const id2 = m2.lastState().you;

    alice.send({ type: 'removeMember', id: id1 });
    for (const c of [m1, m2]) {
      expect(await c.fatal()).toMatchObject({ code: 'removed' });
      await c.closed;
    }
    const after = await alice.state((m) => m.team.code !== code);
    expect(after.team.members.map((m) => m.name)).toEqual(['Alice', 'Bob']);
    expect(after.team.pending).toEqual([]);
    await sleep(50);
    for (const c of [m1, m2]) expect(JSON.stringify(c.msgs)).not.toContain(after.team.code);
    expect(bob.ws.readyState).toBe(bob.ws.OPEN);
    expect(before.team.pending[0].label).toBe('mallory');
    // No way back: any old identity or a new one, with the new code; the old code is dead to them.
    for (const id of ['mallory-client-id-00001', 'mallory-client-id-00002', 'mallory-client-id-00009']) {
      expect((await h.hello(after.team.code, id, 'M', undefined, MAL)).msg).toMatchObject({ code: 'removed' });
    }
    expect((await h.hello(code, 'mallory-client-id-00001', 'M', undefined, MAL)).msg).toMatchObject({ type: 'error', fatal: true });
    const line = h.logs.map((l) => JSON.parse(l)).find((l) => l.event === 'remove-member');
    expect(line).toMatchObject({ removed: id1, removedLabel: 'mallory', alsoRemoved: [id2] });
    // And it sticks across a restart.
    h.hub.flush();
    const file = JSON.parse(readFileSync(h.dataFile, 'utf8'));
    expect(file[0].bannedLabels).toEqual([{ label: 'mallory', reason: 'removed' }]);
  });

  it("removes only that device when it's under the owner's own label", async () => {
    h.start({ accessTokensFile: tokensFile(ALL) });
    const { alice, code } = await aliceTeam();
    const old = (await h.hello(code, 'alice-old-laptop-id-000', 'Alice', undefined, ALICE)).c;
    await alice.state((m) => m.team.members.length === 2);
    const from = alice.msgs.length;
    alice.send({ type: 'removeMember', id: old.lastState().you });
    expect(await old.fatal()).toMatchObject({ code: 'removed' });
    const s = await alice.state((m) => m.team.members.length === 1, from);
    expect(alice.ws.readyState).toBe(alice.ws.OPEN);
    expect((await h.hello(s.team.code, 'alice-new-laptop-id-000', 'Alice', undefined, ALICE)).msg.type).toBe('state');
  });
});

describe('labels for the owner (item 1)', () => {
  it('sends each member’s and waiting person’s label to the owner only', async () => {
    h.start({ accessTokensFile: tokensFile(ALL) });
    const alice = (await h.create(ALICE_ID, 'Alice', 'T', undefined, ALICE)).c;
    const code = alice.lastState().team.code;
    await h.hello(code, BOB_ID, 'Alice', undefined, BOB); // a name that pretends to be someone else
    const req = await alice.state((m) => m.team.pending.length === 1);
    expect(req.team.pending[0]).toEqual({ id: expect.any(String), name: 'Alice 2', online: false, label: 'bob' });
    alice.send({ type: 'approveMember', id: req.team.pending[0].id, allow: true });
    const s = await alice.state((m) => m.team.members.length === 2);
    expect(s.team.members.map((m) => m.label)).toEqual(['alice', 'bob']);
    const bob = (await h.hello(code, BOB_ID, 'Alice', undefined, BOB)).msg as StateMsg;
    expect(bob.team.members.map((m) => m.label)).toEqual([undefined, undefined]);
    expect(JSON.stringify(bob)).not.toContain('"label"');
  });
});

describe('turning someone away (item 1)', () => {
  it('lasts a day, not forever, for that identity and its label', async () => {
    h.start({ accessTokensFile: tokensFile(ALL), limits: { denyMs: 1000, badCodeDelayMs: 0 } });
    const alice = (await h.create(ALICE_ID, 'Alice', 'T', undefined, ALICE)).c;
    const code = alice.lastState().team.code;
    await h.hello(code, 'mallory-client-id-00001', 'M', undefined, MAL);
    const req = await alice.state((m) => m.team.pending.length === 1);
    const from = alice.msgs.length;
    alice.send({ type: 'approveMember', id: req.team.pending[0].id, allow: false });
    await alice.state((m) => m.team.pending.length === 0, from);
    const denied = (await h.hello(code, 'mallory-client-id-00001', 'M', undefined, MAL)).msg;
    expect(denied).toMatchObject({ code: 'denied', message: expect.stringMatching(/tomorrow/) });
    expect((await h.hello(code, 'mallory-client-id-00002', 'M', undefined, MAL)).msg).toMatchObject({ code: 'denied' });
    // Someone else isn't affected.
    expect((await h.hello(code, BOB_ID, 'Bob', undefined, BOB)).msg).toMatchObject({ code: 'pending' });
    h.hub.flush();
    const file = JSON.parse(readFileSync(h.dataFile, 'utf8'));
    expect(file[0].banned[0]).toMatchObject({ reason: 'denied', label: 'mallory', until: expect.any(Number) });
    expect(file[0].bannedLabels[0]).toMatchObject({ label: 'mallory', reason: 'denied', until: expect.any(Number) });
    await sleep(1050);
    expect((await h.hello(code, 'mallory-client-id-00001', 'M', undefined, MAL)).msg).toMatchObject({ code: 'pending' });
  });

  it('turns permanent denials from older files into ones that run out', async () => {
    const owner = publicId('DENIEDTM23', ALICE_ID);
    const kim = publicId('DENIEDTM23', 'kim-secret-client-id-0003');
    writeFileSync(h.dataFile, JSON.stringify([saved({ code: 'DENIEDTM23', ownerId: owner, roster: [{ id: owner, name: 'A' }], banned: [{ id: kim, reason: 'denied' }] })]));
    h.start({ limits: { denyMs: 200 } });
    expect((await h.hello('DENIEDTM23', 'kim-secret-client-id-0003', 'Kim')).msg).toMatchObject({ code: 'denied' });
    await sleep(250);
    expect((await h.hello('DENIEDTM23', 'kim-secret-client-id-0003', 'Kim')).msg).toMatchObject({ code: 'pending' });
  });

  it('keeps removals for good, and keeps a label ban an older file only implied', async () => {
    const owner = publicId('REMOVEDT23', ALICE_ID);
    const mal = publicId('REMOVEDT23', 'mallory-client-id-00001');
    writeFileSync(
      h.dataFile,
      JSON.stringify([saved({ code: 'REMOVEDT23', ownerId: owner, roster: [{ id: owner, name: 'A', label: 'alice' }], banned: [{ id: mal, reason: 'removed', label: 'mallory' }] })]),
    );
    h.start({ accessTokensFile: tokensFile(ALL) });
    expect((await h.hello('REMOVEDT23', 'mallory-client-id-00002', 'M', undefined, MAL)).msg).toMatchObject({ code: 'removed' });
  });
});
