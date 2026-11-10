import { createHmac, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_ID,
  DERIVE_LABEL,
  type IdentityVault,
  type ListableKeyValue,
  LEGACY_ID_KEY,
  PINNED_IN_VAULT_KEY,
  SECRET_IN_VAULT_KEY,
  SECRET_KEY,
  clientIdFor,
  deriveClientId,
  dndKey,
  idKey,
  isHubKey,
  migrateDnd,
  migrateLegacyId,
  moveToKeychain,
  pinnedHubs,
  vaultClientId,
} from './identity.ts';

const subtle = webcrypto.subtle as SubtleCrypto;

/** Shared with the Rust derivation's tests (src-tauri/src/identity.rs). */
const vectors = JSON.parse(readFileSync(new URL('../shared/client-id-vectors.json', import.meta.url), 'utf8')) as {
  label: string;
  cases: { secret: string; hub: string; id: string }[];
};

class MemoryStore implements ListableKeyValue {
  readonly map = new Map<string, string>();
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
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const HUB_A = 'wss://breaks.acme.example/ws';
const HUB_B = 'wss://evil.example/ws';

describe('deriveClientId', () => {
  it('is a valid client id, stable for one hub and different for another', async () => {
    const secret = 'S'.repeat(43);
    const a = await deriveClientId(secret, HUB_A, subtle);
    expect(a).toMatch(CLIENT_ID);
    expect(a).toHaveLength(43);
    expect(await deriveClientId(secret, HUB_A, subtle)).toBe(a);
    expect(await deriveClientId(secret, HUB_B, subtle)).not.toBe(a);
    expect(await deriveClientId('T'.repeat(43), HUB_A, subtle)).not.toBe(a);
  });

  it('gives the ids in shared/client-id-vectors.json (the Rust side checks the same ones)', async () => {
    expect(vectors.label).toBe(DERIVE_LABEL);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(5);
    for (const c of vectors.cases) {
      expect(await deriveClientId(c.secret, c.hub, subtle)).toBe(c.id);
      // The vectors themselves are plain HMAC-SHA256, independent of either implementation.
      expect(createHmac('sha256', c.secret).update(DERIVE_LABEL + c.hub).digest('base64url')).toBe(c.id);
    }
  });

  it('matches a known HMAC-SHA256 value', async () => {
    // HMAC-SHA256(key "secret", "smoke-break client id v1\nwss://h/ws"), base64url.
    const { createHmac } = await import('node:crypto');
    const expected = createHmac('sha256', 'secret').update('smoke-break client id v1\nwss://h/ws').digest('base64url');
    expect(await deriveClientId('secret', 'wss://h/ws', subtle)).toBe(expected);
  });
});

describe('clientIdFor', () => {
  it('makes a device secret once and derives a different id per hub', async () => {
    const store = new MemoryStore();
    const a = await clientIdFor(store, HUB_A, subtle);
    const secret = store.getItem(SECRET_KEY);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const b = await clientIdFor(store, HUB_B, subtle);
    expect(a).toMatch(CLIENT_ID);
    expect(b).toMatch(CLIENT_ID);
    expect(a).not.toBe(b);
    // Same device, same hub: same id; the secret isn't replaced.
    expect(await clientIdFor(store, HUB_A, subtle)).toBe(a);
    expect(store.getItem(SECRET_KEY)).toBe(secret);
    // Nothing per hub is stored: the id is derived each time.
    expect(store.getItem(idKey(HUB_A))).toBeNull();
  });

  it('falls back to a random id per hub without WebCrypto (plain-http LAN page)', async () => {
    const store = new MemoryStore();
    const a = await clientIdFor(store, HUB_A, null);
    expect(a).toMatch(CLIENT_ID);
    expect(await clientIdFor(store, HUB_A, null)).toBe(a);
    expect(await clientIdFor(store, HUB_B, null)).not.toBe(a);
    expect(store.getItem(SECRET_KEY)).toBeNull();
  });
});

describe('migrateLegacyId', () => {
  const legacy = 'abcdef0123456789abcdef01';

  it('keeps the old id for the hub configured at upgrade time only', async () => {
    const store = new MemoryStore();
    store.setItem(LEGACY_ID_KEY, legacy);
    migrateLegacyId(store, HUB_A);
    expect(store.getItem(LEGACY_ID_KEY)).toBeNull();
    expect(await clientIdFor(store, HUB_A, subtle)).toBe(legacy);
    // Another hub never sees it.
    const b = await clientIdFor(store, HUB_B, subtle);
    expect(b).not.toBe(legacy);
    expect(b).toMatch(CLIENT_ID);
  });

  it('runs once: a second run (e.g. from the other window) changes nothing', async () => {
    const store = new MemoryStore();
    store.setItem(LEGACY_ID_KEY, legacy);
    migrateLegacyId(store, HUB_A);
    migrateLegacyId(store, HUB_B);
    expect(await clientIdFor(store, HUB_A, subtle)).toBe(legacy);
    expect(await clientIdFor(store, HUB_B, subtle)).not.toBe(legacy);
  });

  it('does nothing on a fresh install', () => {
    const store = new MemoryStore();
    migrateLegacyId(store, HUB_A);
    expect(store.map.size).toBe(0);
  });

  it("drops an old id the hub wouldn't accept anyway", async () => {
    const store = new MemoryStore();
    store.setItem(LEGACY_ID_KEY, 'bad id!');
    migrateLegacyId(store, HUB_A);
    expect(store.getItem(LEGACY_ID_KEY)).toBeNull();
    expect(await clientIdFor(store, HUB_A, subtle)).not.toBe('bad id!');
  });
});

/**
 * Stands in for the Rust side (`src-tauri/src/identity.rs`): the device secret
 * and pinned ids in the Keychain, init once per run, ids derived with the same
 * HMAC. The secret is never handed back.
 */
class FakeKeychain implements IdentityVault {
  secret: string | null = null;
  pins = new Map<string, string>();
  /** This run's secret, once init worked. */
  loaded: string | null = null;
  inits = 0;
  broken = false;
  async init(legacySecret: string | null, storedBefore: boolean) {
    if (this.broken) throw 'Keychain error -128: User canceled the operation.';
    if (this.loaded) return;
    this.inits++;
    if (legacySecret) this.secret = legacySecret;
    else if (!storedBefore || !this.secret) this.secret = 'K'.repeat(43) + this.inits;
    this.loaded = this.secret;
  }
  async pin(hub: string, id: string) {
    if (this.broken) throw 'Keychain error -25293';
    this.pins.set(hub, id);
  }
  async clientId(hub: string, pinned: boolean) {
    if (this.broken) throw 'Keychain error -25293';
    if (pinned && this.pins.has(hub)) return this.pins.get(hub)!;
    if (!this.loaded) throw 'the device secret isn’t loaded yet';
    return deriveClientId(this.loaded, hub, subtle);
  }
  /** The app quits and starts again. */
  restart() {
    this.loaded = null;
  }
}

describe('moveToKeychain', () => {
  const OLD = 'O'.repeat(43);
  const LEGACY = 'abcdef0123456789abcdef01';

  it('moves the secret out of web storage into the Keychain, keeping every id', async () => {
    const store = new MemoryStore();
    store.setItem(SECRET_KEY, OLD);
    const before = await clientIdFor(store, HUB_A, subtle);
    const keychain = new FakeKeychain();
    await moveToKeychain(store, keychain);
    expect(keychain.secret).toBe(OLD);
    expect(store.getItem(SECRET_KEY)).toBeNull();
    expect(store.getItem(SECRET_IN_VAULT_KEY)).toBe('1');
    // Same id as before the move, so nobody loses their place or ownership.
    expect(await vaultClientId(store, keychain, HUB_A)).toBe(before);
    expect([...store.map.values()]).not.toContain(OLD);
  });

  it('moves pinned ids into the Keychain and out of web storage, unchanged', async () => {
    const store = new MemoryStore();
    store.setItem(LEGACY_ID_KEY, LEGACY);
    migrateLegacyId(store, HUB_A);
    store.setItem(SECRET_KEY, OLD);
    const keychain = new FakeKeychain();
    await moveToKeychain(store, keychain);
    expect(keychain.pins.get(HUB_A)).toBe(LEGACY);
    expect(store.getItem(idKey(HUB_A))).toBeNull();
    expect(pinnedHubs(store)).toEqual([HUB_A]);
    expect([...store.map.values()]).not.toContain(LEGACY);
    expect(await vaultClientId(store, keychain, HUB_A)).toBe(LEGACY);
    // Another hub still gets its derived id, never the pinned one.
    expect(await vaultClientId(store, keychain, HUB_B)).toBe(await deriveClientId(OLD, HUB_B, subtle));
  });

  it('only looks up pinned ids for hubs it moved there itself', async () => {
    const store = new MemoryStore();
    const keychain = new FakeKeychain();
    await moveToKeychain(store, keychain);
    // Planted by someone else for a hub this device never pinned.
    keychain.pins.set(HUB_B, 'planted-id-0123456789');
    expect(await vaultClientId(store, keychain, HUB_B)).not.toBe('planted-id-0123456789');
  });

  it('drops pinned ids no hub could use', async () => {
    const store = new MemoryStore();
    store.setItem(idKey('WSS://Not.Canonical/ws'), LEGACY);
    store.setItem(idKey(HUB_A), 'bad id!');
    store.setItem(idKey('https://example.com/'), LEGACY);
    const keychain = new FakeKeychain();
    await moveToKeychain(store, keychain);
    expect(keychain.pins.size).toBe(0);
    expect([...store.map.keys()].filter((k) => k.startsWith('sb:clientId@'))).toEqual([]);
  });

  it('makes a new secret in the Keychain on a fresh install, and none in web storage', async () => {
    const store = new MemoryStore();
    const keychain = new FakeKeychain();
    await moveToKeychain(store, keychain);
    expect(keychain.secret).not.toBeNull();
    expect(store.getItem(SECRET_KEY)).toBeNull();
    expect(await vaultClientId(store, keychain, HUB_A)).toMatch(CLIENT_ID);
  });

  it('reads the stored secret on the next start and never replaces it', async () => {
    const store = new MemoryStore();
    const keychain = new FakeKeychain();
    await moveToKeychain(store, keychain);
    const id = await vaultClientId(store, keychain, HUB_A);
    keychain.restart();
    await moveToKeychain(store, keychain);
    expect(keychain.inits).toBe(2);
    expect(await vaultClientId(store, keychain, HUB_A)).toBe(id);
  });

  it('gives both windows the same identity when they start together', async () => {
    const store = new MemoryStore();
    store.setItem(SECRET_KEY, OLD);
    const keychain = new FakeKeychain();
    await Promise.all([moveToKeychain(store, keychain), moveToKeychain(store, keychain)]);
    expect(keychain.inits).toBe(1);
    expect(keychain.secret).toBe(OLD);
  });

  it('replaces whatever item was there before the first move', async () => {
    // Pre-created by someone else, e.g. with an access list that lets any app read it.
    const keychain = new FakeKeychain();
    keychain.secret = 'P'.repeat(43);
    const fresh = new MemoryStore();
    await moveToKeychain(fresh, keychain);
    expect(keychain.secret).not.toBe('P'.repeat(43));
    const upgraded = new MemoryStore();
    upgraded.setItem(SECRET_KEY, OLD);
    keychain.secret = 'P'.repeat(43);
    keychain.restart();
    await moveToKeychain(upgraded, keychain);
    expect(keychain.secret).toBe(OLD);
  });

  it('throws when the Keychain refuses, keeping everything in place to retry, and makes nothing up', async () => {
    const store = new MemoryStore();
    store.setItem(SECRET_KEY, OLD);
    store.setItem(idKey(HUB_A), LEGACY);
    const keychain = Object.assign(new FakeKeychain(), { broken: true });
    await expect(moveToKeychain(store, keychain)).rejects.toMatch(/Keychain error/);
    expect(store.getItem(SECRET_KEY)).toBe(OLD);
    expect(store.getItem(idKey(HUB_A))).toBe(LEGACY);
    expect(store.getItem(SECRET_IN_VAULT_KEY)).toBeNull();
    // Once the Keychain works again, the same identity comes through.
    keychain.broken = false;
    await moveToKeychain(store, keychain);
    expect(await vaultClientId(store, keychain, HUB_A)).toBe(LEGACY);
    expect(await vaultClientId(store, keychain, HUB_B)).toBe(await deriveClientId(OLD, HUB_B, subtle));
  });

  it('keeps a pinned id in web storage until the Keychain has it', async () => {
    const store = new MemoryStore();
    store.setItem(idKey(HUB_A), LEGACY);
    const keychain = new FakeKeychain();
    keychain.pin = async () => {
      throw 'Keychain error -25293';
    };
    await expect(moveToKeychain(store, keychain)).rejects.toBeTruthy();
    expect(store.getItem(idKey(HUB_A))).toBe(LEGACY);
    expect(store.getItem(PINNED_IN_VAULT_KEY)).toBeNull();
  });
});

describe('isHubKey', () => {
  it('accepts what the Keychain side accepts', () => {
    expect(isHubKey('wss://breaks.example.com/ws')).toBe(true);
    expect(isHubKey('ws://localhost:8787/ws')).toBe(true);
    expect(isHubKey('ws://[::1]:8787/ws')).toBe(true);
    expect(isHubKey('wss://breaks.example.com')).toBe(false);
    expect(isHubKey('WSS://breaks.example.com/ws')).toBe(false);
    expect(isHubKey('wss://breaks.example.com:443/ws')).toBe(false);
    expect(isHubKey('wss://breaks.example.com/ws#x')).toBe(false);
    expect(isHubKey('wss://u:p@breaks.example.com/ws')).toBe(false);
    expect(isHubKey('https://breaks.example.com/')).toBe(false);
    expect(isHubKey(`wss://${'a'.repeat(600)}.example/`)).toBe(false);
    expect(isHubKey('device-secret')).toBe(false);
  });
});

describe('migrateDnd', () => {
  const ID = 'abcdef0123456789abcdef01';
  const OTHER_ID = 'Zyxwvu9876543210Zyxwvu98';

  it('carries the setting over to the hub and deletes every key named after an id', () => {
    const legacy = new MemoryStore();
    const store = new MemoryStore();
    legacy.setItem(`sb:dnd:${ID}`, '1');
    legacy.setItem(`sb:dnd:${OTHER_ID}`, '0');
    legacy.setItem('sb:appearance', '{}');
    migrateDnd(legacy, store, HUB_A, ID);
    expect(store.getItem(dndKey(HUB_A))).toBe('1');
    expect([...legacy.map.keys()]).toEqual(['sb:appearance']);
  });

  it('keeps a setting already made for the hub', () => {
    const legacy = new MemoryStore();
    const store = new MemoryStore();
    legacy.setItem(`sb:dnd:${ID}`, '1');
    store.setItem(dndKey(HUB_A), '0');
    migrateDnd(legacy, store, HUB_A, ID);
    expect(store.getItem(dndKey(HUB_A))).toBe('0');
    expect(legacy.length).toBe(0);
  });

  it('deletes the old keys even when the id is not known, carrying nothing over', () => {
    const legacy = new MemoryStore();
    const store = new MemoryStore();
    legacy.setItem(`sb:dnd:${ID}`, '1');
    migrateDnd(legacy, store, HUB_A, null);
    expect(legacy.length).toBe(0);
    expect(store.length).toBe(0);
  });

  it('leaves keys alone that are not named after an id', () => {
    const legacy = new MemoryStore();
    legacy.setItem('sb:dnd:short', '1');
    legacy.setItem(dndKey(HUB_A), '1');
    migrateDnd(legacy, legacy, HUB_A, ID);
    expect(legacy.getItem('sb:dnd:short')).toBe('1');
    expect(legacy.getItem(dndKey(HUB_A))).toBe('1');
    // The new key is the hub address, which isn't secret.
    expect(dndKey(HUB_A)).toBe(`sb:dnd@${HUB_A}`);
  });
});
