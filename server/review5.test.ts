// Review 5, items 1-3: on/off settings can't fail open, strict mode knows where
// a token was used from, and a device from before per-person tokens can't get
// around a removal or a revocation.

import { spawn } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envBool } from './env.ts';
import { checkDeployment, defaultsToLoopbackProxy, publicId } from './hub.ts';
import { type Client, hubHarness, saved, sleep, tempDir } from './hubHarness.ts';

const h = hubHarness();
const MAIN = resolve(import.meta.dirname, 'main.ts');
const HOST = 'hub.example.com';
const SECRET = 'proxy-secret-0123456789abcdef';
const tok = (label: string) => `${label}-token-0123456789abcdef`;

function tokensFile(labels: string[]) {
  const file = join(tempDir(), 'tokens');
  writeFileSync(file, labels.map((l) => `${l}:${tok(l)}\n`).join(''));
  chmodSync(file, 0o600);
  return file;
}

const events = () => h.logs.map((l) => JSON.parse(l) as Record<string, unknown>);

/** Runs `npm run server` with a clean environment; SIGTERM once `untilOutput` appears. */
function run(env: Record<string, string>, untilOutput?: RegExp) {
  const child = spawn(process.execPath, [MAIN], {
    env: { PATH: process.env.PATH ?? '', SMOKE_BREAK_DATA_DIR: tempDir(), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let sent = false;
  const check = () => !sent && untilOutput?.test(out) && (sent = child.kill('SIGTERM'));
  child.stdout.on('data', (d) => ((out += d), check()));
  child.stderr.on('data', (d) => (out += d));
  return new Promise<{ code: number | null; out: string }>((res) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.on('exit', (code) => (clearTimeout(timer), res({ code, out })));
  });
}

describe('on/off settings (item 1)', () => {
  it('reads 1/true/yes/on as on and unset/empty/0/false/no/off as off, in any case, and refuses anything else', () => {
    for (const v of ['1', 'true', 'TRUE', ' yes ', 'On']) expect(envBool('X', { X: v })).toBe(true);
    for (const v of [undefined, '', '  ', '0', 'false', 'No', 'OFF']) expect(envBool('X', { X: v })).toBe(false);
    for (const v of ['2', 'enabled', 'tru', 'y']) {
      expect(() => envBool('SMOKE_BREAK_ENTERPRISE', { SMOKE_BREAK_ENTERPRISE: v })).toThrow(/SMOKE_BREAK_ENTERPRISE=.*use 1, true, yes or on .* 0, false, no, off/);
    }
  });

  it('SMOKE_BREAK_ENTERPRISE=true or yes turns strict mode on; a value it doesn’t know stops the hub with status 78', async () => {
    for (const [v, port] of [['true', '20600'], [' YES ', '20601'], ['on', '20602']]) {
      const { code, out } = await run({ PORT: port, SMOKE_BREAK_ENTERPRISE: v, SMOKE_BREAK_ACCESS_TOKEN: 'shared-token-0123456789abcdef' });
      expect(code).toBe(78);
      expect(out).toMatch(/Strict mode \(SMOKE_BREAK_ENTERPRISE\) is on, but this hub is missing/);
    }
    const bad = await run({ PORT: '20603', SMOKE_BREAK_ENTERPRISE: 'enabled' });
    expect(bad.code).toBe(78);
    expect(bad.out).toMatch(/SMOKE_BREAK_ENTERPRISE="enabled" is not an on\/off value/);
    const off = await run({ PORT: '20604', SMOKE_BREAK_ENTERPRISE: 'false' }, /data file:/);
    expect(off.out).toMatch(/strict mode: off/);
    expect(off.code).toBe(0);
  });
});

describe('strict mode knows where a token was used from (items 2 and 4)', () => {
  const base = { enterprise: true, tokenMode: 'file' as const, publicHosts: [HOST], proxySecret: true, unixSocket: false, trustsProxy: false };

  it('trusts loopback by default on a loopback HOST, and refuses a remote HOST without SMOKE_BREAK_TRUST_PROXY', () => {
    expect(defaultsToLoopbackProxy({ ...base, listenHost: '127.0.0.1' })).toBe(true);
    expect(defaultsToLoopbackProxy({ ...base, listenHost: '10.0.0.2' })).toBe(false);
    expect(defaultsToLoopbackProxy({ ...base, enterprise: false, listenHost: '127.0.0.1' })).toBe(false);
    expect(defaultsToLoopbackProxy({ ...base, unixSocket: true, listenHost: undefined })).toBe(false);
    expect(defaultsToLoopbackProxy({ ...base, trustsProxy: true, listenHost: '127.0.0.1' })).toBe(false);
    expect(checkDeployment({ ...base, listenHost: '10.0.0.2', encryptedHop: true }).missing).toEqual([expect.stringMatching(/set SMOKE_BREAK_TRUST_PROXY/)]);
    // Even with the proxy's address, strict mode won't start while that hop is plain ws://…
    expect(checkDeployment({ ...base, trustsProxy: true, listenHost: '10.0.0.2' })).toEqual({
      missing: [expect.stringMatching(/HOST=10\.0\.0\.2 is not a loopback address: connections reach the hub as plain ws:\/\/.*SMOKE_BREAK_ENCRYPTED_HOP=1/)],
      warnings: [],
    });
    // …unless the deployer says it is encrypted some other way.
    expect(checkDeployment({ ...base, trustsProxy: true, listenHost: '10.0.0.2', encryptedHop: true })).toEqual({ missing: [], warnings: [] });
    // Outside strict mode it stays a warning.
    expect(checkDeployment({ ...base, enterprise: false, trustsProxy: true, listenHost: '10.0.0.2' }).warnings).toEqual([
      expect.stringMatching(/HOST=10\.0\.0\.2 is not a loopback address/),
    ]);
    expect(checkDeployment({ ...base, trustsProxy: true, listenHost: '127.0.0.1' })).toEqual({ missing: [], warnings: [] });
    // Outside strict mode nothing is refused for it.
    expect(checkDeployment({ ...base, enterprise: false, listenHost: '10.0.0.2' }).missing).toEqual([]);
  });

  it('names the client, not the proxy, in the audit log when SMOKE_BREAK_TRUST_PROXY is unset', async () => {
    h.start({ enterprise: true, publicHosts: [HOST], accessTokensFile: tokensFile(['alice']), proxySecret: SECRET, listenHost: '127.0.0.1' });
    expect(h.hub.stats().loopbackProxyDefault).toBe(true);
    const c = await h.connect({ headers: { host: HOST, 'x-smoke-break-proxy': SECRET, 'x-forwarded-for': '203.0.113.7' } }, tok('alice'));
    c.send({ type: 'create', teamName: 'T', clientId: 'alice-client-id-000000', name: 'Alice' });
    await c.state();
    expect(events().find((e) => e.event === 'create')).toMatchObject({ ip: '203.0.113.7', label: 'alice' });
    // Outside strict mode, nothing changes: X-Forwarded-For isn't believed without SMOKE_BREAK_TRUST_PROXY.
    h.start({ publicHosts: [HOST], accessTokensFile: tokensFile(['alice']), proxySecret: SECRET, listenHost: '127.0.0.1' });
    expect(h.hub.stats().loopbackProxyDefault).toBe(false);
  });

  it('npm run server: refuses a remote HOST without the proxy’s address or with a plain hop (78), and says it trusts loopback by default', async () => {
    const strict = { SMOKE_BREAK_ENTERPRISE: '1', SMOKE_BREAK_ACCESS_TOKENS_FILE: tokensFile(['alice']), SMOKE_BREAK_PUBLIC_HOST: HOST, SMOKE_BREAK_PROXY_SECRET: SECRET };
    const refused = await run({ ...strict, PORT: '20610', HOST: '0.0.0.0' });
    expect(refused.code).toBe(78);
    expect(refused.out).toMatch(/the proxy's address: set SMOKE_BREAK_TRUST_PROXY/);
    const plain = await run({ ...strict, PORT: '20611', HOST: '0.0.0.0', SMOKE_BREAK_TRUST_PROXY: '10.0.0.5' });
    expect(plain.code).toBe(78);
    expect(plain.out).toMatch(/HOST=0\.0\.0\.0 is not a loopback address: connections reach the hub as plain ws:\/\//);
    expect(plain.out).toMatch(/SMOKE_BREAK_ENCRYPTED_HOP=1/);
    const remote = await run({ ...strict, PORT: '20611', HOST: '0.0.0.0', SMOKE_BREAK_TRUST_PROXY: '10.0.0.5', SMOKE_BREAK_ENCRYPTED_HOP: 'yes' }, /data file:/);
    expect(remote.out).not.toMatch(/WARNING/);
    expect(remote.code).toBe(0);
    const local = await run({ ...strict, PORT: '20612' }, /data file:/);
    expect(local.out).toMatch(/trusted proxies: loopback \(strict mode default\)/);
    expect(local.out).not.toMatch(/WARNING/);
    expect(local.code).toBe(0);
  });
});

describe('a device from before per-person tokens (item 3)', () => {
  const CODE = 'ABCDEFGHJK';
  const cid = { o: 'owner-device-id-000000001', m1: 'mal-laptop-device-id-0001', m2: 'mal-desktop-device-id-002', r: 'rita-old-device-id-000001' };
  const id = (c: string) => publicId(CODE, c);
  const strict = (labels: string[]) => ({ enterprise: true, publicHosts: [HOST], accessTokensFile: tokensFile(labels), unixSocket: true });
  const as = (label: string) => h.connect({ headers: { host: HOST } }, tok(label));

  function writeTeam(roster: Record<string, unknown>[], over: Record<string, unknown> = {}) {
    writeFileSync(
      h.dataFile,
      JSON.stringify([saved({ code: CODE, aliases: [], idSalt: CODE, ref: 'abcdef01', ownerId: id(cid.o), requireApproval: true, hadGroupBreak: true, createdBy: 'o', roster, banned: [], bannedLabels: [], pending: [], ...over })]),
    );
  }

  async function hello(label: string, code: string, clientId: string, name: string) {
    const c = await as(label);
    c.send({ type: 'hello', teamCode: code, clientId, name });
    return { c, msg: await c.first() };
  }

  async function owner(): Promise<Client> {
    const o = (await hello('o', CODE, cid.o, 'Owner')).c;
    await o.state();
    return o;
  }

  it('reviewer’s scenario: after the owner removes label m, m’s unlabeled device can’t get in with m’s token and the old code', async () => {
    writeTeam([{ id: id(cid.o), name: 'Owner', label: 'o' }, { id: id(cid.m1), name: 'Mal', label: 'm' }, { id: id(cid.m2), name: 'Mal desktop' }]);
    h.start(strict(['o', 'm']));
    expect(events().find((e) => e.event === 'load')).toMatchObject({ enterprise: true, unlabeledMembers: 1 });
    const o = await owner();
    o.send({ type: 'removeMember', id: id(cid.m1) });
    const after = await o.state((m) => m.team.code !== CODE);
    expect(after.team.members.map((m) => m.name)).toEqual(['Owner', 'Mal desktop']);

    const m2 = await hello('m', CODE, cid.m2, 'Mal');
    expect(m2.msg).toMatchObject({ type: 'error', fatal: true, code: 'removed' });
    expect(m2.c.msgs.some((m) => m.type === 'state')).toBe(false);
    // The entry is gone and that device is banned too, so another token or the new code doesn't help.
    const now = await o.state((m) => m.team.members.length === 1);
    expect(now.team.members.map((m) => m.id)).toEqual([id(cid.o)]);
    expect(events()).toContainEqual(expect.objectContaining({ event: 'unlabeled-member', member: id(cid.m2), outcome: 'dropped', label: 'm' }));
    expect((await hello('o', now.team.code, cid.m2, 'Mal')).msg).toMatchObject({ code: 'removed' });
  });

  it('the owner can’t hand the team to an entry that isn’t tied to a token yet (review 6)', async () => {
    writeTeam([{ id: id(cid.o), name: 'Owner', label: 'o' }, { id: id(cid.r), name: 'Rita' }, { id: id(cid.m1), name: 'Mal', label: 'm' }]);
    h.start(strict(['o', 'm']));
    const o = await owner();
    let from = o.msgs.length;
    o.send({ type: 'transferOwner', id: id(cid.r) });
    expect((await o.error(from)).message).toMatch(/hasn't connected since this hub started using per-person access tokens/);
    // Someone already tied to their own token can still take it.
    from = o.msgs.length;
    o.send({ type: 'transferOwner', id: id(cid.m1) });
    expect((await o.state((m) => m.team.ownerId === id(cid.m1), from)).team.ownerId).toBe(id(cid.m1));
  });

  it('a revoked person can’t use their unlabeled device with a colleague’s token: the owner sees it waiting, under that token’s label', async () => {
    // Rita's line is gone from the tokens file; Carl is a colleague with a valid token.
    writeTeam([{ id: id(cid.o), name: 'Owner', label: 'o' }, { id: id(cid.r), name: 'Rita' }], { aliases: ['OLDCODE234'] });
    h.start(strict(['o', 'carl']));
    const o = await owner();
    for (const code of ['OLDCODE234', CODE, 'OLDCODE234']) {
      const r = await hello('carl', code, cid.r, 'Carl');
      expect(r.msg).toMatchObject({ type: 'error', fatal: true, code: 'pending' });
      expect(r.c.msgs.some((m) => m.type === 'state')).toBe(false);
    }
    const s = await o.state((m) => m.team.pending.length === 1);
    expect(s.team.members.map((m) => m.name)).toEqual(['Owner']);
    expect(s.team.pending).toEqual([expect.objectContaining({ id: id(cid.r), name: 'Rita', label: 'carl' })]);
    expect(events()).toContainEqual(expect.objectContaining({ event: 'unlabeled-member', member: id(cid.r), outcome: 'waiting', label: 'carl' }));
    // Turned away: that device can't ask again.
    o.send({ type: 'approveMember', id: id(cid.r), allow: false });
    await o.state((m) => m.team.pending.length === 0);
    expect((await hello('carl', CODE, cid.r, 'Carl')).msg).toMatchObject({ code: 'denied' });
  });

  it('a teammate who hasn’t reconnected since the switch to per-person tokens is approved once, then gets in with the old code and gets the new one', async () => {
    writeTeam([{ id: id(cid.o), name: 'Owner' }, { id: id(cid.m2), name: 'Mel' }], { aliases: ['OLDCODE234'] });
    h.start(strict(['o', 'mel']));
    // The owner's own entry binds on first use, so the owner can let the rest in.
    const o = await owner();
    expect(o.lastState().team.members.find((m) => m.id === id(cid.o))?.label).toBe('o');
    expect(events()).toContainEqual(expect.objectContaining({ event: 'unlabeled-member', member: id(cid.o), outcome: 'bound', owner: true }));
    expect((await hello('mel', 'OLDCODE234', cid.m2, 'Mel')).msg).toMatchObject({ code: 'pending' });
    await o.state((m) => m.team.pending.length === 1);
    o.send({ type: 'approveMember', id: id(cid.m2), allow: true });
    await o.state((m) => m.team.members.some((x) => x.id === id(cid.m2) && x.label === 'mel'));
    const mel = await hello('mel', 'OLDCODE234', cid.m2, 'Mel');
    expect(mel.msg).toMatchObject({ type: 'state', team: { code: CODE } });
  });

  it('without strict mode and with approval off, the first token used still binds the entry (as before)', async () => {
    writeTeam([{ id: id(cid.o), name: 'Owner', label: 'o' }, { id: id(cid.m2), name: 'Mel' }], { requireApproval: false });
    h.start({ publicHosts: [HOST], accessTokensFile: tokensFile(['o', 'mel']) });
    expect(events().find((e) => e.event === 'load')?.unlabeledMembers).toBeUndefined();
    const mel = await hello('mel', CODE, cid.m2, 'Mel');
    expect(mel.msg).toMatchObject({ type: 'state' });
    expect(events()).toContainEqual(expect.objectContaining({ event: 'unlabeled-member', member: id(cid.m2), outcome: 'bound' }));
    await sleep(20);
    // Bound: from now on only that label can use it.
    expect((await hello('o', CODE, cid.m2, 'Mel')).msg).toMatchObject({ code: 'unauthorized' });
  });
});
