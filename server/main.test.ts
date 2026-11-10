// Item 6 (and item 5's default bind address): `npm run server` startup.

import { spawn } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from './hubHarness.ts';

const MAIN = resolve(import.meta.dirname, 'main.ts');

/** Runs the hub with a clean environment (never the repo's real data dir). */
function run(env: Record<string, string>, untilOutput?: RegExp) {
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
        if (!sent && untilOutput.test(out)) (sent = true), child.kill('SIGTERM');
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
      expect(code).toBe(1);
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
    const bad = await run({ PORT: '19303', SMOKE_BREAK_ACCESS_TOKENS_FILE: file });
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/SMOKE_BREAK_ACCESS_TOKENS_FILE: line 1/);
    const proxy = await run({ PORT: '19303', SMOKE_BREAK_TRUST_PROXY: 'everyone' });
    expect(proxy.code).toBe(1);
    expect(proxy.out).toMatch(/SMOKE_BREAK_TRUST_PROXY/);
  });

  it('listens on 127.0.0.1 by default and stops cleanly', async () => {
    const { code, out } = await run({ PORT: '19302' }, /data file:/);
    expect(out).toMatch(/ws:\/\/127\.0\.0\.1:19302/);
    expect(out).toMatch(/SIGTERM: saving/);
    expect(code).toBe(0);
  });
});
