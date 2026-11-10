// Item 3: per-person access tokens: labels, revocation, bans and quotas per label.

import { chmodSync, writeFileSync } from 'node:fs';
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

  it('refuses to start with a file others can read, or a malformed one', () => {
    expect(() => h.start({ accessTokensFile: tokensFile(ALL, 0o644) })).toThrow(/other users.*chmod 600/);
    expect(() => h.start({ accessTokensFile: tokensFile('alice:x') })).toThrow(/SMOKE_BREAK_ACCESS_TOKENS_FILE: line 1/);
    expect(() => h.start({ accessTokensFile: join(tempDir(), 'missing') })).toThrow(/ENOENT/);
    h.start();
  });
});

describe('per-person tokens on the hub (item 3)', () => {
  it('lets in any listed token or the shared one, and logs the label, never the token', async () => {
    h.start({ accessTokensFile: tokensFile(ALL), accessToken: SHARED });
    const { msg } = await h.create('alice-client-id-0000000', 'Alice', 'T', undefined, ALICE_TOKEN);
    const code = (msg as StateMsg).team.code;
    expect((await h.hello(code, 'shared-client-id-000000', 'S', undefined, SHARED)).msg).toMatchObject({ code: 'pending' });
    expect((await h.hello(code, 'nobody-client-id-000000', 'N', undefined, 'not-a-token-at-all-000000')).msg).toMatchObject({ code: 'unauthorized' });
    const lines = h.logs.map((l) => JSON.parse(l));
    expect(lines.find((l) => l.event === 'create')).toMatchObject({ label: 'alice' });
    expect(lines.find((l) => l.event === 'join-requested')).not.toHaveProperty('label');
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
    expect((await h.hello(code, 'bob-client-id-000000000', 'Bob', undefined, BOB_TOKEN)).msg).toMatchObject({ code: 'unauthorized' });
    expect(h.logs.some((l) => l.includes('"tokens-reloaded"') && l.includes('"bob"'))).toBe(true);
  });

  it('keeps the last good list when the file turns bad', async () => {
    const file = tokensFile(ALL);
    h.start({ accessTokensFile: file });
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(' '));
    try {
      writeFileSync(file, 'garbage');
      h.hub.reloadTokens();
    } finally {
      console.error = orig;
    }
    expect(String(errors[0])).toMatch(/Keeping the previous token list/);
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

  it('counts team creation per label instead of hub-wide', async () => {
    h.start({ accessTokensFile: tokensFile(ALL), accessToken: SHARED, limits: { createsPerHour: 1, createsPerLabelPerDay: 2, createsPerIpPerHour: 100 } });
    const make = async (token: string, i: number) => {
      const m = (await h.create(`creator-client-id-${i}00000`, 'C', 'T', undefined, token)).msg;
      return m.type === 'error' ? m.code : m.type;
    };
    // Unlabelled (shared token): the hub-wide limit of 1.
    expect([await make(SHARED, 1), await make(SHARED, 2)]).toEqual(['state', 'rate-limited']);
    // Each label has its own quota of 2, untouched by the hub-wide one.
    expect([await make(ALICE_TOKEN, 3), await make(ALICE_TOKEN, 4), await make(ALICE_TOKEN, 5)]).toEqual(['state', 'state', 'rate-limited']);
    expect(await make(BOB_TOKEN, 6)).toBe('state');
  });
});
