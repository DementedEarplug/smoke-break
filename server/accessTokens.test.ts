// Item 3: per-person access tokens: labels, revocation, bans and quotas per label.

import { chmodSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTokensFile } from './accessTokens.ts';
import { type ErrorMsg, type StateMsg, hubHarness, sleep, tempDir } from './hubHarness.ts';

const h = hubHarness();

const ALICE_TOKEN = 'alice-token-0123456789abcdef';
const BOB_TOKEN = 'bob-token-0123456789abcdefgh';
const MAL_TOKEN = 'mallory-token-0123456789abcd';
const SHARED = 'shared-token-0123456789abcdef';

function tokensFile(lines: string, mode = 0o600) {
  const file = join(tempDir(), 'tokens');
  writeFileSync(file, lines);
  chmodSync(file, mode);
  return file;
}
const ALL = `# people\nalice:${ALICE_TOKEN}\nbob:${BOB_TOKEN}\n\nmallory:${MAL_TOKEN}\n`;

describe('tokens file format (item 3)', () => {
  it('reads label:token lines with comments and blank lines', () => {
    expect(parseTokensFile(ALL).map((e) => e.label)).toEqual(['alice', 'bob', 'mallory']);
  });

  it.each([
    ['no colon', `alice ${ALICE_TOKEN}`, /line 1/],
    ['empty label', `:${ALICE_TOKEN}`, /line 1/],
    ['short token', 'alice:short', /16-512/],
    ['space in token', `alice:${ALICE_TOKEN} x`, /16-512/],
    ['repeated token', `alice:${ALICE_TOKEN}\nbob:${ALICE_TOKEN}`, /line 2/],
  ])('refuses %s, without echoing the token', (_name, text, err) => {
    let message = '';
    try {
      parseTokensFile(text);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(err);
    expect(message).not.toContain(ALICE_TOKEN);
  });

  it('refuses to start with both a shared token and a tokens file (item 1)', () => {
    expect(() => h.start({ accessTokensFile: tokensFile(ALL), accessToken: SHARED })).toThrow(
      /SMOKE_BREAK_ACCESS_TOKENS_FILE and SMOKE_BREAK_ACCESS_TOKEN are both set/,
    );
    h.start();
  });

  it('refuses to start with a file others can read, or a malformed one', () => {
    expect(() => h.start({ accessTokensFile: tokensFile(ALL, 0o644) })).toThrow(/other users.*chmod 600/);
    expect(() => h.start({ accessTokensFile: tokensFile('alice:x') })).toThrow(/SMOKE_BREAK_ACCESS_TOKENS_FILE: line 1/);
    expect(() => h.start({ accessTokensFile: join(tempDir(), 'missing') })).toThrow(/ENOENT/);
    h.start();
  });
});

describe('per-person tokens on the hub (item 3)', () => {
  it('lets in any listed token, and logs the label, never the token', async () => {
    h.start({ accessTokensFile: tokensFile(ALL) });
    const { msg } = await h.create('alice-client-id-0000000', 'Alice', 'T', undefined, ALICE_TOKEN);
    const code = (msg as StateMsg).team.code;
    expect((await h.hello(code, 'bob-client-id-000000000', 'B', undefined, BOB_TOKEN)).msg).toMatchObject({ code: 'pending' });
    await expect(h.connect({}, 'not-a-token-at-all-000000')).rejects.toThrow(/401/);
    await expect(h.connect({}, SHARED)).rejects.toThrow(/401/);
    const lines = h.logs.map((l) => JSON.parse(l));
    expect(lines.find((l) => l.event === 'create')).toMatchObject({ label: 'alice' });
    expect(lines.find((l) => l.event === 'join-requested')).toMatchObject({ label: 'bob' });
    const all = h.logs.join('\n');
    for (const t of [ALICE_TOKEN, BOB_TOKEN, SHARED]) expect(all).not.toContain(t);
  });

  it('closes the sockets of a revoked label as soon as the file changes', async () => {
    const file = tokensFile(ALL);
    h.start({ accessTokensFile: file, limits: { tokensPollMs: 50 } });
    const alice = (await h.create('alice-client-id-0000000', 'Alice', 'T', undefined, ALICE_TOKEN)).c;
    const code = alice.lastState().team.code;
    alice.send({ type: 'settings', requireApproval: false });
    await alice.state((m) => !m.team.requireApproval);
    const bob = (await h.hello(code, 'bob-client-id-000000000', 'Bob', undefined, BOB_TOKEN)).c;
    writeFileSync(file, `alice:${ALICE_TOKEN}\n`); // bob's line is gone
    expect(await bob.fatal()).toMatchObject({ code: 'unauthorized' });
    await bob.closed;
    await sleep(100);
    expect(alice.ws.readyState).toBe(alice.ws.OPEN);
    await expect(h.connect({}, BOB_TOKEN)).rejects.toThrow(/401/);
    expect(h.logs.some((l) => l.includes('"tokens-reloaded"') && l.includes('"bob"'))).toBe(true);
  });

  it('fails closed while the file is broken, says so once with the reason, and recovers (item 5)', async () => {
    const file = tokensFile(ALL);
    h.start({ accessTokensFile: file });
    const alice = (await h.create('alice-client-id-0000000', 'Alice', 'T', undefined, ALICE_TOKEN)).c;
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(' '));
    try {
      // A bad edit: the hub must not keep the old list (which may hold a line the admin just deleted).
      writeFileSync(file, `alice:${ALICE_TOKEN}\nbob ${BOB_TOKEN}\n`);
      h.hub.reloadTokens();
      h.hub.reloadTokens();
      chmodSync(file, 0o644);
      h.hub.reloadTokens();
    } finally {
      console.error = orig;
    }
    expect(errors.filter((e) => /NO access token is valid/.test(e))).toHaveLength(2); // once per reason
    expect(errors[0]).toMatch(/line 2/);
    expect(errors[1]).toMatch(/other users/);
    expect(errors.join('\n')).not.toContain(BOB_TOKEN);
    expect(h.logs.filter((l) => l.includes('"tokens-file-broken"'))).toHaveLength(2);
    // Connected people are closed with "keep the team, retry later"; nobody new gets a socket.
    expect(await alice.fatal()).toMatchObject({ code: 'unauthorized' });
    await alice.closed;
    await expect(h.connect({}, ALICE_TOKEN)).rejects.toThrow(/401/);
    expect(h.hub.stats().tokensBroken).toBe(true);
    // Fixed (written whole and renamed into place): back to normal.
    const fixed = tokensFile(ALL);
    renameSync(fixed, file);
    h.hub.reloadTokens();
    expect(h.hub.stats().tokensBroken).toBe(false);
    expect((await h.create('alice-client-id-0000000', 'Alice', 'T', undefined, ALICE_TOKEN)).msg.type).toBe('state');
  });

  it("won't let a removed person back in under a new client id with the same token", async () => {
    h.start({ accessTokensFile: tokensFile(ALL) });
    const alice = (await h.create('alice-client-id-0000000', 'Alice', 'T', undefined, ALICE_TOKEN)).c;
    const code = alice.lastState().team.code;
    alice.send({ type: 'settings', requireApproval: false });
    await alice.state((m) => !m.team.requireApproval);
    const mal = (await h.hello(code, 'mallory-client-id-00000', 'Mallory', undefined, MAL_TOKEN)).msg as StateMsg;
    const from = alice.msgs.length;
    alice.send({ type: 'removeMember', id: mal.you });
    const after = await alice.state((m) => m.team.code !== code, from);
    // Mallory learned the new code somehow: a new identity under her token still can't get in.
    expect((await h.hello(after.team.code, 'mallory-fresh-id-000000', 'M', undefined, MAL_TOKEN)).msg).toMatchObject({ code: 'removed' });
    // Bob, with his own token, can.
    expect((await h.hello(after.team.code, 'bob-client-id-000000000', 'Bob', undefined, BOB_TOKEN)).msg.type).toBe('state');
    expect(h.logs.some((l) => l.includes('"remove-member"') && l.includes('"removedLabel":"mallory"'))).toBe(true);
  });

  it('caps identities per label per team', async () => {
    h.start({ accessTokensFile: tokensFile(ALL), limits: { identitiesPerLabel: 2 } });
    const alice = (await h.create('alice-client-id-0000000', 'Alice', 'T', undefined, ALICE_TOKEN)).c;
    const code = alice.lastState().team.code;
    const ask = async (i: number) => ((await h.hello(code, `mallory-client-id-${i}0000`, `M${i}`, undefined, MAL_TOKEN)).msg as ErrorMsg).code;
    expect(await ask(1)).toBe('pending');
    expect(await ask(2)).toBe('pending');
    expect(await ask(3)).toBe('full');
  });

  it('counts team creation per label instead of per address and hub-wide (items 2, 3)', async () => {
    const make = async (token: string, i: number) => {
      const m = (await h.create(`creator-client-id-${i}00000`, 'C', 'T', undefined, token)).msg;
      return m.type === 'error' ? m.code : m.type;
    };
    // Unlabelled (shared token): the per-address and hub-wide limits.
    h.start({ accessToken: SHARED, limits: { createsPerHour: 1, createsPerIpPerHour: 100 } });
    expect([await make(SHARED, 1), await make(SHARED, 2)]).toEqual(['state', 'rate-limited']);
    // Each label has its own quota of 2; neither the hub-wide nor the per-address one (all from 127.0.0.1) applies.
    h.start({ accessTokensFile: tokensFile(ALL), limits: { createsPerHour: 1, createsPerLabelPerDay: 2, createsPerIpPerHour: 1 } });
    expect([await make(ALICE_TOKEN, 3), await make(ALICE_TOKEN, 4), await make(ALICE_TOKEN, 5)]).toEqual(['state', 'state', 'rate-limited']);
    expect(await make(BOB_TOKEN, 6)).toBe('state');
  });
});
