// platform.ts reads `window`, `location` and web storage when it loads, so each
// test sets those up as the desktop app would have them and imports it fresh.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MemoryStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const REAL = 'wss://breaks.acme.example/ws';
const EVIL = 'wss://breaks.evil.example/ws';
const LEGACY_ID = 'abcdef0123456789abcdef01';

let local: MemoryStorage;
/** Stands in for the macOS Keychain behind the token_* commands; null = not available. */
let keychain: Map<string, string> | null;
/** The device secret's Keychain item, kept in the same map. */
const SECRET_ITEM = 'device-secret';
let createdThisRun = false;

async function loadPlatform(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', new MemoryStorage());
  vi.stubGlobal('location', { protocol: 'tauri:', host: 'localhost' });
  vi.stubGlobal('window', {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args: { hub: string; token?: string; secret?: string }) => {
        if (!keychain) throw new Error('no keychain here');
        if (cmd === 'token_get') return keychain.get(args.hub) ?? null;
        if (cmd === 'token_set') {
          if (args.token) keychain.set(args.hub, args.token);
          else keychain.delete(args.hub);
          return null;
        }
        if (cmd === 'device_secret_get') return keychain.get(SECRET_ITEM) ?? null;
        if (cmd === 'device_secret_create') {
          // Like the Rust side: the first create in a run wins.
          if (!createdThisRun) keychain.set(SECRET_ITEM, args.secret!);
          createdThisRun = true;
          return keychain.get(SECRET_ITEM);
        }
        throw new Error(`unexpected ${cmd}`);
      },
    },
  });
  const platform = await import('./platform.ts');
  await platform.ready;
  return platform;
}

beforeEach(() => {
  local = new MemoryStorage();
  keychain = new Map();
  createdThisRun = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('upgrading from one identity for every hub', () => {
  beforeEach(() => {
    local.setItem('sb:server', REAL);
    local.setItem('sb:clientId', LEGACY_ID);
    local.setItem('sb:name', 'Sam');
    local.setItem('sb:team', 'TEAMCODE23');
    local.setItem('sb:token', 'per-user-token');
  });

  it('keeps id, team and token for the hub configured at upgrade time', async () => {
    const p = await loadPlatform();
    expect(await p.clientId()).toBe(LEGACY_ID);
    expect(await p.loadIdentity()).toEqual({ hub: REAL, clientId: LEGACY_ID, name: 'Sam', teamCode: 'TEAMCODE23' });
    expect(await p.hubToken(REAL)).toBe('per-user-token');
    // The token moved into the Keychain; nothing global is left behind.
    expect(keychain!.get(REAL)).toBe('per-user-token');
    for (const k of ['sb:clientId', 'sb:team', 'sb:token']) expect(local.getItem(k)).toBeNull();
    expect([...local.map.values()]).not.toContain('per-user-token');
  });

  it('gives another hub a different id, no token and no team', async () => {
    const p = await loadPlatform();
    expect(p.saveServerUrl(EVIL)).toBeNull();
    expect(p.currentHub()).toBe(EVIL);
    const id = await p.clientId();
    expect(id).not.toBe(LEGACY_ID);
    expect(id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(p.savedTeam()).toBe('');
    expect(await p.loadIdentity()).toBeNull();
    expect(await p.hubToken(EVIL)).toBe('');
    // Back on the real hub, everything is still there.
    expect(p.saveServerUrl(REAL)).toBeNull();
    expect(await p.clientId()).toBe(LEGACY_ID);
    expect(p.savedTeam()).toBe('TEAMCODE23');
  });

  it('keeps the token in per-hub web storage where the Keychain is unavailable', async () => {
    keychain = null;
    const p = await loadPlatform();
    expect(await p.hubToken(REAL)).toBe('per-user-token');
    expect(await p.hubToken(EVIL)).toBe('');
    expect(local.getItem('sb:token')).toBeNull();
  });

  it('migrates once even when both windows start at the same time', async () => {
    const p = await loadPlatform();
    const again = await loadPlatform();
    expect(await again.clientId()).toBe(LEGACY_ID);
    expect(await p.clientId()).toBe(LEGACY_ID);
  });
});

describe('access tokens', () => {
  it('sends the built-in token only to the built-in hub', async () => {
    const p = await loadPlatform({ VITE_SERVER_URL: REAL, VITE_HUB_TOKEN: 'built-in' });
    expect(await p.hubToken(REAL)).toBe('built-in');
    expect(await p.hubToken(EVIL)).toBe('');
  });

  it('prefers a saved per-user token, per hub', async () => {
    const p = await loadPlatform({ VITE_SERVER_URL: REAL, VITE_HUB_TOKEN: 'built-in' });
    await p.saveHubToken('  mine  ', REAL);
    expect(await p.hubToken(REAL)).toBe('mine');
    expect(await p.savedHubToken(EVIL)).toBe('');
    await p.saveHubToken('', REAL);
    expect(await p.hubToken(REAL)).toBe('built-in');
    expect(keychain!.has(REAL)).toBe(false);
  });
});

describe('VITE_LOCK_SERVER', () => {
  it('ignores a saved server and refuses to change it', async () => {
    local.setItem('sb:server', EVIL);
    const p = await loadPlatform({ VITE_SERVER_URL: REAL, VITE_LOCK_SERVER: '1' });
    expect(p.serverLocked).toBe(true);
    expect(p.serverIsConfigurable).toBe(false);
    expect(p.serverUrl()).toBe(REAL);
    expect(p.saveServerUrl('wss://elsewhere.example/ws')).toBeNull();
    expect(p.serverUrl()).toBe(REAL);
  });

  it('is off unless set', async () => {
    local.setItem('sb:server', EVIL);
    const p = await loadPlatform({ VITE_SERVER_URL: REAL, VITE_LOCK_SERVER: '' });
    expect(p.serverIsConfigurable).toBe(true);
    expect(p.serverUrl()).toBe(EVIL);
  });
});

describe('device secret', () => {
  const SECRET = 'S'.repeat(43);

  it('moves into the Keychain and out of web storage, keeping the ids', async () => {
    local.setItem('sb:server', REAL);
    local.setItem('sb:deviceSecret', SECRET);
    const p = await loadPlatform();
    const id = await p.clientId();
    expect(keychain!.get(SECRET_ITEM)).toBe(SECRET);
    expect(local.getItem('sb:deviceSecret')).toBeNull();
    expect([...local.map.values()]).not.toContain(SECRET);
    // The next start (a new run of the app) reads it back and derives the same id.
    createdThisRun = false;
    const again = await loadPlatform();
    expect(await again.clientId()).toBe(id);
    expect(keychain!.get(SECRET_ITEM)).toBe(SECRET);
  });

  it('stays in web storage where there is no Keychain', async () => {
    keychain = null;
    local.setItem('sb:server', REAL);
    const p = await loadPlatform();
    const id = await p.clientId();
    expect(local.getItem('sb:deviceSecret')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await (await loadPlatform()).clientId()).toBe(id);
  });
});
