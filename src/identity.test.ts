import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_ID,
  type KeyValue,
  LEGACY_ID_KEY,
  SECRET_KEY,
  clientIdFor,
  deriveClientId,
  idKey,
  migrateLegacyId,
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
