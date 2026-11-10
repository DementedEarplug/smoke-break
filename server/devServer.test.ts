// Item 9: the dev and preview servers don't serve audit notes, and send framing/sniffing headers.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from './hubHarness.ts';

const ROOT = resolve(import.meta.dirname, '..');
const CONFIG = join(ROOT, 'vite.config.ts');

describe('dev and preview servers (item 9)', () => {
  const saved = process.env.SMOKE_BREAK_DATA_DIR;
  beforeAll(() => {
    // The config reads this when it loads: never let a test touch the repo's real team file.
    process.env.SMOKE_BREAK_DATA_DIR = tempDir();
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.SMOKE_BREAK_DATA_DIR;
    else process.env.SMOKE_BREAK_DATA_DIR = saved;
  });

  const expectHeaders = (r: Response) => {
    expect(r.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  };

  it('dev server refuses audit notes and sends the headers', async () => {
    const { createServer } = await import('vite');
    const server = await createServer({ configFile: CONFIG, root: ROOT, server: { port: 19610, strictPort: true, host: '127.0.0.1' }, logLevel: 'silent' });
    await server.listen();
    try {
      const get = (p: string) => fetch(`http://127.0.0.1:19610${p}`);
      for (const p of ['/AUDIT.md', '/SECURITY-AUDIT.md', '/security-audit.md', '/AUDIT.md?raw', `/@fs${ROOT}/SECURITY-AUDIT.md`, '/.data/teams.json']) {
        const r = await get(p);
        await r.arrayBuffer(); // never look at the body
        expect(r.status, p).toBe(403);
      }
      const page = await get('/index.html');
      expect(page.status).toBe(200);
      expectHeaders(page);
      expectHeaders(await get('/no-such-file.md'));
    } finally {
      await server.close();
    }
  });

  it('preview server sends the headers', async () => {
    const { preview } = await import('vite');
    const dist = tempDir();
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>t</title>');
    const server = await preview({ configFile: CONFIG, root: ROOT, build: { outDir: dist }, preview: { port: 19611, strictPort: true, host: '127.0.0.1' }, logLevel: 'silent' });
    try {
      const r = await fetch('http://127.0.0.1:19611/');
      expect(r.status).toBe(200);
      expectHeaders(r);
    } finally {
      await server.close();
    }
  });
});
