import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_ID,
  type KeyValue,
  LEGACY_ID_KEY,
  SECRET_IN_VAULT_KEY,
  SECRET_KEY,
  type SecretVault,
  clientIdFor,
  deriveClientId,
  idKey,
  migrateLegacyId,
  vaultSecret,
} from './identity.ts';

const subtle = webcrypto.subtle as SubtleCrypto;

class MemoryStore implements KeyValue {
  readonly map = new Map<string, string>();
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

/** Stands in for the Keychain item, with the create-once-per-run rule of the Rust side. */
class FakeVault implements SecretVault {
  item: string | null = null;
  createdThisRun: string | null = null;
  creates = 0;
  broken = false;
  async get() {
    if (this.broken) throw new Error('Keychain error');
    return this.item;
  }
  async create(secret: string) {
    if (this.broken) throw new Error('Keychain error');
    if (this.createdThisRun) return this.createdThisRun;
    this.creates++;
    this.item = secret;
    this.createdThisRun = secret;
    return secret;
  }
  /** The app quits and starts again. */
  restart() {
    this.createdThisRun = null;
  }
}

describe('vaultSecret', () => {
  const OLD = 'O'.repeat(43);

  it('moves the secret out of web storage into the Keychain, keeping every id', async () => {
    const store = new MemoryStore();
    store.setItem(SECRET_KEY, OLD);
    const before = await clientIdFor(store, HUB_A, subtle);
    const vault = new FakeVault();
    const secret = await vaultSecret(store, vault);
    expect(secret).toBe(OLD);
    expect(vault.item).toBe(OLD);
    expect(store.getItem(SECRET_KEY)).toBeNull();
    expect(store.getItem(SECRET_IN_VAULT_KEY)).toBe('1');
    // Same id as before the move, so nobody loses their place or ownership.
    expect(await clientIdFor(store, HUB_A, subtle, secret)).toBe(before);
    // Nothing is written back to web storage.
    expect(store.getItem(SECRET_KEY)).toBeNull();
  });

  it('makes a new secret in the Keychain on a fresh install', async () => {
    const store = new MemoryStore();
    const vault = new FakeVault();
    const secret = await vaultSecret(store, vault);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(vault.item).toBe(secret);
    expect(store.getItem(SECRET_KEY)).toBeNull();
  });

  it('only reads the Keychain once the secret is there, and never replaces it', async () => {
    const store = new MemoryStore();
    const vault = new FakeVault();
    const first = await vaultSecret(store, vault);
    vault.restart();
    expect(await vaultSecret(store, vault)).toBe(first);
    expect(vault.creates).toBe(1);
  });

  it('gives both windows the same secret when they start together', async () => {
    const store = new MemoryStore();
    const vault = new FakeVault();
    const [a, b] = await Promise.all([vaultSecret(store, vault), vaultSecret(store, vault)]);
    expect(a).toBe(b);
    expect(vault.creates).toBe(1);
  });

  it('replaces whatever item was there before the first move', async () => {
    // Pre-created by someone else, e.g. with an access list that lets any app read it.
    const vault = new FakeVault();
    vault.item = 'P'.repeat(43);
    const store = new MemoryStore();
    store.setItem(SECRET_KEY, OLD);
    expect(await vaultSecret(store, vault)).toBe(OLD);
    expect(vault.item).toBe(OLD);
  });

  it('keeps using web storage where there is no Keychain or it refuses', async () => {
    for (const vault of [null, Object.assign(new FakeVault(), { broken: true })]) {
      const store = new MemoryStore();
      store.setItem(SECRET_KEY, OLD);
      expect(await vaultSecret(store, vault)).toBeNull();
      expect(store.getItem(SECRET_KEY)).toBe(OLD);
      expect(store.getItem(SECRET_IN_VAULT_KEY)).toBeNull();
    }
  });

  it('starts a new secret if the Keychain item was deleted', async () => {
    const store = new MemoryStore();
    const vault = new FakeVault();
    const first = await vaultSecret(store, vault);
    vault.item = null;
    vault.restart();
    const second = await vaultSecret(store, vault);
    expect(second).not.toBe(first);
    expect(vault.item).toBe(second);
  });
});
