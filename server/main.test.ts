// Item 6 (and item 5's default bind address): `npm run server` startup.

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { WS_PROTOCOL } from '../shared/protocol.ts';
import { tempDir } from './hubHarness.ts';

const MAIN = resolve(import.meta.dirname, 'main.ts');

/**
 * Runs the hub with a clean environment (never the repo's real data dir).
 * Once `untilOutput` appears, `whileUp` runs, then the hub gets SIGTERM.
 */
function run(env: Record<string, string>, untilOutput?: RegExp, whileUp?: () => Promise<void>) {
  const child = spawn(process.execPath, [MAIN], {
    env: { PATH: process.env.PATH ?? '', SMOKE_BREAK_DATA_DIR: tempDir(), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return new Promise<{ code: number | null; out: string }>((res) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    if (untilOutput) {
      let sent = false;
      const check = () => {
        if (sent || !untilOutput.test(out)) return;
        sent = true;
        void (whileUp ?? (async () => {}))().finally(() => child.kill('SIGTERM'));
      };
      child.stdout.on('data', check);
    }
    child.on('exit', (code) => (clearTimeout(timer), res({ code, out })));
  });
}

describe('standalone hub startup (item 6)', () => {
  it('exits non-zero, saying why, when the port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as AddressInfo).port;
    try {
      const { code, out } = await run({ PORT: String(port) });
      expect(code).toBe(1); // may pass: a supervisor should retry
      expect(out).toMatch(/already in use/);
      expect(out).not.toMatch(/kept running/);
    } finally {
      blocker.close();
    }
  });

  it('exits non-zero on a bad tokens file or proxy list', async () => {
    const file = join(tempDir(), 'tokens');
    writeFileSync(file, 'alice:short');
    chmodSync(file, 0o600);
    const bad = await run({ PORT: '20340', SMOKE_BREAK_ACCESS_TOKENS_FILE: file });
    expect(bad.code).toBe(78); // only an admin can fix it: a supervisor shouldn't restart
    expect(bad.out).toMatch(/SMOKE_BREAK_ACCESS_TOKENS_FILE: line 1/);
    const proxy = await run({ PORT: '20340', SMOKE_BREAK_TRUST_PROXY: 'everyone' });
    expect(proxy.code).toBe(78);
    expect(proxy.out).toMatch(/SMOKE_BREAK_TRUST_PROXY/);
  });

  it('refuses to start with both a shared token and a tokens file (item 1)', async () => {
    const file = join(tempDir(), 'tokens');
    writeFileSync(file, 'alice:alice-token-0123456789abcdef\n');
    chmodSync(file, 0o600);
    const { code, out } = await run({ PORT: '20340', SMOKE_BREAK_ACCESS_TOKENS_FILE: file, SMOKE_BREAK_ACCESS_TOKEN: 'shared-token-0123456789abcdef' });
    expect(code).toBe(78);
    expect(out).toMatch(/both set\. Use one/);
  });

  it('refuses to start on a team file it cannot parse, naming it and the copy it kept (item 3)', async () => {
    const dir = tempDir();
    const file = join(dir, 'teams.json');
    writeFileSync(file, '[{"code": "ABCDEF", "na');
    const { code, out } = await run({ PORT: '20340', SMOKE_BREAK_DATA_DIR: dir });
    expect(code).toBe(78);
    const copy = readdirSync(dir).find((f) => f.startsWith('teams.json.corrupt-'))!;
    expect(out).toContain(`${file} is not a valid team list`);
    expect(out).toContain(join(dir, copy));
    expect(readFileSync(file, 'utf8')).toBe('[{"code": "ABCDEF", "na');
  });

  it('listens on a Unix socket (0660), believing the proxy’s X-Forwarded-For, and removes a stale socket (item 4)', async () => {
    const dir = tempDir();
    const path = join(dir, 'hub.sock');
    // A socket file left behind by a hub that died: a hard link outlives the server that made it.
    const old = createServer();
    await new Promise<void>((r) => old.listen(join(dir, 'old.sock'), r));
    linkSync(join(dir, 'old.sock'), path);
    await new Promise((r) => old.close(r));
    expect(lstatSync(path).isSocket()).toBe(true);
    let mode = 0;
    let protocol = '';
    const { code, out } = await run({ SMOKE_BREAK_SOCKET: path }, /data file:/, async () => {
      mode = lstatSync(path).mode & 0o777;
      const ws = new WebSocket(`ws+unix:${path}:/ws`, [WS_PROTOCOL], { headers: { 'x-forwarded-for': '10.1.2.3' } });
      await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
      protocol = ws.protocol;
      ws.send('junk');
      ws.send('junk');
      ws.send('junk'); // one more than allowed before hello: closed, and the limit line names the forwarded address
      await new Promise((r) => ws.once('close', r));
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(mode).toBe(0o660);
    expect(protocol).toBe(WS_PROTOCOL);
    expect(out).toContain(`ws://unix:${path}/ws`);
    expect(out).toMatch(/"messages-before-hello","ip":"10\.1\.2\.3"/);
    expect(code).toBe(0);
    expect(existsSync(path)).toBe(false); // removed on shutdown
  });

  it("won't remove a file that isn't a socket, or one a live hub is listening on (item 4)", async () => {
    const dir = tempDir();
    const file = join(dir, 'not-a-socket');
    writeFileSync(file, 'keep me');
    const notSocket = await run({ SMOKE_BREAK_SOCKET: file });
    expect(notSocket.code).toBe(78);
    expect(notSocket.out).toMatch(/not a socket/);
    expect(readFileSync(file, 'utf8')).toBe('keep me');
    const path = join(dir, 'live.sock');
    const live = createServer();
    await new Promise<void>((r) => live.listen(path, r));
    try {
      const busy = await run({ SMOKE_BREAK_SOCKET: path });
      expect(busy.code).toBe(1);
      expect(busy.out).toMatch(/already listening/);
    } finally {
      live.close();
    }
  });

  it('warns at startup when it runs with a shared token or none at all (review 3, item 4)', async () => {
    const open = await run({ PORT: '20341' }, /data file:/);
    expect(open.out).toMatch(/WARNING: no access token required/);
    const shared = await run({ PORT: '20342', SMOKE_BREAK_ACCESS_TOKEN: 'shared-token-0123456789abcdef' }, /data file:/);
    expect(shared.out).toMatch(/WARNING: one shared access token.*block new teams hub-wide/);
    const file = join(tempDir(), 'tokens');
    writeFileSync(file, 'alice:alice-token-0123456789abcdef\n');
    chmodSync(file, 0o600);
    const perPerson = await run({ PORT: '20343', SMOKE_BREAK_ACCESS_TOKENS_FILE: file, SMOKE_BREAK_PUBLIC_HOST: 'breaks.example.com' }, /data file:/);
    expect(perPerson.out).toMatch(/per-person tokens \(1 labels\)/);
    expect(perPerson.out).not.toMatch(/WARNING/);
  });

  it('in strict mode (SMOKE_BREAK_ENTERPRISE=1) refuses to start with exit status 78, listing everything missing (review 4, item 5)', async () => {
    const { code, out } = await run({ PORT: '20345', HOST: '0.0.0.0', SMOKE_BREAK_ENTERPRISE: '1', SMOKE_BREAK_ACCESS_TOKEN: 'shared-token-0123456789abcdef' });
    expect(code).toBe(78);
    expect(out).toMatch(/Strict mode \(SMOKE_BREAK_ENTERPRISE\) is on, but this hub is missing/);
    for (const what of [/instead of the shared SMOKE_BREAK_ACCESS_TOKEN/, /SMOKE_BREAK_PUBLIC_HOST/, /SMOKE_BREAK_PROXY_SECRET or SMOKE_BREAK_SOCKET/, /HOST=0\.0\.0\.0 is not a loopback/]) {
      expect(out).toMatch(what);
    }
    const file = join(tempDir(), 'tokens');
    writeFileSync(file, 'alice:alice-token-0123456789abcdef\n');
    chmodSync(file, 0o600);
    const ok = await run(
      { PORT: '20346', SMOKE_BREAK_ENTERPRISE: '1', SMOKE_BREAK_ACCESS_TOKENS_FILE: file, SMOKE_BREAK_PUBLIC_HOST: 'breaks.example.com', SMOKE_BREAK_PROXY_SECRET: 'proxy-secret-0123456789abcdef' },
      /data file:/,
    );
    expect(ok.out).toMatch(/strict mode: on/);
    expect(ok.out).not.toMatch(/WARNING/);
    expect(ok.code).toBe(0);
  });

  it('warns once per missing protection without strict mode (review 4, item 5)', async () => {
    const { out } = await run({ PORT: '20347', SMOKE_BREAK_TRUST_PROXY: '127.0.0.1' }, /data file:/);
    expect(out.match(/WARNING/g)).toHaveLength(3);
    expect(out).toMatch(/WARNING: SMOKE_BREAK_PUBLIC_HOST is not set/);
    expect(out).toMatch(/WARNING: SMOKE_BREAK_TRUST_PROXY is set without SMOKE_BREAK_PROXY_SECRET or SMOKE_BREAK_SOCKET/);
    expect(out).toMatch(/WARNING: no access token required/);
  });

  it('listens on 127.0.0.1 by default and stops cleanly', async () => {
    const { code, out } = await run({ PORT: '20344' }, /data file:/);
    expect(out).toMatch(/ws:\/\/127\.0\.0\.1:20344/);
    expect(out).toMatch(/SIGTERM: saving/);
    expect(code).toBe(0);
  });
});
