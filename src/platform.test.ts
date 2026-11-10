// platform.ts reads `window`, `location` and web storage when it loads, so each
// test sets those up as the desktop app would have them and imports it fresh.

import { createHmac } from 'node:crypto';
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
/**
 * Stands in for the Rust side and the macOS login Keychain behind it
 * (src-tauri/src/token.rs, identity.rs): items by account. null = a platform
 * without a Keychain (`keychain_available` is false).
 */
let keychain: Map<string, string> | null;
/** The Keychain is there but refuses (locked, the person clicked Deny). */
let refusing: boolean;
/** What the Rust side holds for this run of the app; `restart()` clears it. */
let run: { secret: string | null; tokens: Map<string, string> };
/** Every value the commands handed to the webview. */
let handedOut: unknown[];
const SECRET_ITEM = 'device-secret';
const REFUSED = 'Keychain error -25293';

const derive = (secret: string, hub: string) =>
  createHmac('sha256', secret).update(`smoke-break client id v1\n${hub}`).digest('base64url');

function restart() {
  run = { secret: null, tokens: new Map() };
}

type Args = { hub: string; token?: string; id?: string; pinned?: boolean; legacySecret?: string | null; storedBefore?: boolean };

function command(cmd: string, a: Args): unknown {
  if (cmd === 'keychain_available') return keychain !== null;
  if (!keychain) throw new Error('no Keychain on this platform');
  switch (cmd) {
    case 'token_get':
      if (run.tokens.has(a.hub)) return run.tokens.get(a.hub) || null;
      if (refusing) throw REFUSED;
      return keychain.get(a.hub) ?? null;
    case 'token_set':
      if (refusing) {
        run.tokens.set(a.hub, a.token!);
        return REFUSED;
      }
      if (a.token) keychain.set(a.hub, a.token);
      else keychain.delete(a.hub);
      run.tokens.delete(a.hub);
      return null;
    case 'identity_init':
      if (refusing) throw REFUSED;
      if (run.secret) return null;
      if (a.legacySecret) keychain.set(SECRET_ITEM, a.legacySecret);
      else if (!a.storedBefore || !keychain.has(SECRET_ITEM)) keychain.set(SECRET_ITEM, 'K'.repeat(43));
      run.secret = keychain.get(SECRET_ITEM)!;
      return null;
    case 'client_id_pin':
      if (refusing) throw REFUSED;
      keychain.set(`client-id@${a.hub}`, a.id!);
      return null;
    case 'client_id': {
      if (refusing) throw REFUSED;
      const pinned = keychain.get(`client-id@${a.hub}`);
      if (a.pinned && pinned) return pinned;
      if (!run.secret) throw 'the device secret isn’t loaded yet';
      return derive(run.secret, a.hub);
    }
  }
  throw new Error(`unexpected ${cmd}`);
}

async function loadPlatform(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', new MemoryStorage());
  vi.stubGlobal('location', { protocol: 'tauri:', host: 'localhost' });
  vi.stubGlobal('window', {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args: Args) => {
        const out = command(cmd, args);
        handedOut.push(out);
        return out;
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
  refusing = false;
  handedOut = [];
  restart();
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
    // Token and pinned id moved into the Keychain; nothing global is left behind.
    expect(keychain!.get(REAL)).toBe('per-user-token');
    expect(keychain!.get(`client-id@${REAL}`)).toBe(LEGACY_ID);
    for (const k of ['sb:clientId', `sb:clientId@${REAL}`, 'sb:team', 'sb:token', `sb:token@${REAL}`]) {
      expect(local.getItem(k)).toBeNull();
    }
    expect([...local.map.values()]).not.toContain('per-user-token');
    expect([...local.map.values()]).not.toContain(LEGACY_ID);
  });

  it('keeps the same id on the next start, from the Keychain', async () => {
    const id = await (await loadPlatform()).clientId();
    restart();
    expect(await (await loadPlatform()).clientId()).toBe(id);
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

  it('keeps everything in per-hub web storage where there is no Keychain (other platforms)', async () => {
    keychain = null;
    const p = await loadPlatform();
    expect(await p.clientId()).toBe(LEGACY_ID);
    expect(await p.hubToken(REAL)).toBe('per-user-token');
    expect(await p.hubToken(EVIL)).toBe('');
    expect(local.getItem('sb:token')).toBeNull();
    expect(local.getItem(`sb:token@${REAL}`)).toBe('per-user-token');
    expect(p.tokenStorageHint()).toMatch(/no Keychain/);
  });

  it('migrates once even when both windows start at the same time', async () => {
    const [p, again] = await Promise.all([loadPlatform(), loadPlatform()]);
    expect(await again.clientId()).toBe(LEGACY_ID);
    expect(await p.clientId()).toBe(LEGACY_ID);
  });

  it('keeps the old id in web storage, and makes up nothing, until the Keychain takes it', async () => {
    refusing = true;
    const p = await loadPlatform();
    await expect(p.clientId()).rejects.toBeInstanceOf(p.IdentityUnavailable);
    await expect(p.loadIdentity()).rejects.toThrow(/won’t make up a new identity/);
    expect(local.getItem(`sb:clientId@${REAL}`)).toBe(LEGACY_ID);
    expect(local.getItem('sb:deviceSecret')).toBeNull();
    // Trying again once the Keychain works gives the same id as before.
    refusing = false;
    expect(await p.clientId()).toBe(LEGACY_ID);
    expect(local.getItem(`sb:clientId@${REAL}`)).toBeNull();
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
    expect(p.tokenStorageHint()).toMatch(/login Keychain/);
  });

  it('keeps a token the Keychain refuses in memory for this run only, never in web storage, and says so', async () => {
    refusing = true;
    const p = await loadPlatform();
    const message = await p.saveHubToken('typed-token', REAL);
    expect(message).toMatch(/Couldn’t save your access token to the Keychain/);
    expect(message).toMatch(/enter it again next time/);
    expect(p.tokenNotice(REAL)).toBe(message);
    expect(await p.hubToken(REAL)).toBe('typed-token');
    expect([...local.map.values()]).not.toContain('typed-token');
    // The app quits; next time it's gone and has to be entered again.
    restart();
    refusing = false;
    const next = await loadPlatform();
    expect(await next.hubToken(REAL)).toBe('');
    expect(next.tokenNotice(REAL)).toBe('');
  });

  it('says when the saved token can’t be read', async () => {
    keychain!.set(REAL, 'saved');
    refusing = true;
    const p = await loadPlatform();
    expect(await p.savedHubToken(REAL)).toBe('');
    expect(p.tokenNotice(REAL)).toMatch(/Couldn’t read your saved access token/);
    refusing = false;
    expect(await p.savedHubToken(REAL)).toBe('saved');
    expect(p.tokenNotice(REAL)).toBe('');
  });

  it('moves a token an older version left in web storage into the Keychain', async () => {
    local.setItem(`sb:token@${REAL}`, 'left-behind');
    const p = await loadPlatform();
    expect(keychain!.get(REAL)).toBe('left-behind');
    expect(local.getItem(`sb:token@${REAL}`)).toBeNull();
    expect(await p.hubToken(REAL)).toBe('left-behind');
  });

  it('leaves such a token where it is until the Keychain takes it, using it from memory meanwhile', async () => {
    local.setItem(`sb:token@${REAL}`, 'left-behind');
    refusing = true;
    const p = await loadPlatform();
    expect(await p.hubToken(REAL)).toBe('left-behind');
    expect(p.tokenNotice(REAL)).toMatch(/Couldn’t save/);
    expect(local.getItem(`sb:token@${REAL}`)).toBe('left-behind');
    // A new token typed meanwhile replaces it, and it isn't written to web storage.
    await p.saveHubToken('new-one', REAL);
    expect(local.getItem(`sb:token@${REAL}`)).toBeNull();
    expect(await p.hubToken(REAL)).toBe('new-one');
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
    expect(id).toBe(derive(SECRET, REAL));
    expect(keychain!.get(SECRET_ITEM)).toBe(SECRET);
    expect(local.getItem('sb:deviceSecret')).toBeNull();
    expect([...local.map.values()]).not.toContain(SECRET);
    // The next start (a new run of the app) reads it back and derives the same id.
    restart();
    const again = await loadPlatform();
    expect(await again.clientId()).toBe(id);
    expect(keychain!.get(SECRET_ITEM)).toBe(SECRET);
  });

  it('never reaches the webview: only derived ids come back', async () => {
    local.setItem('sb:server', REAL);
    const p = await loadPlatform();
    await p.clientId();
    await p.clientId(EVIL);
    const secret = keychain!.get(SECRET_ITEM)!;
    expect(handedOut.map(String).some((v) => v.includes(secret))).toBe(false);
    expect([...local.map.values()].some((v) => v.includes(secret))).toBe(false);
  });

  it('is not replaced by a new one when the Keychain refuses', async () => {
    local.setItem('sb:server', REAL);
    local.setItem('sb:deviceSecret', SECRET);
    refusing = true;
    const p = await loadPlatform();
    await expect(p.clientId()).rejects.toThrow(/Keychain error -25293/);
    // Still where it was, to be moved on a later try; no stand-in identity.
    expect(local.getItem('sb:deviceSecret')).toBe(SECRET);
    expect(local.getItem('sb:deviceSecretInKeychain')).toBeNull();
    refusing = false;
    expect(await p.clientId()).toBe(derive(SECRET, REAL));
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
