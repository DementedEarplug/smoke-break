// Who this device is to a hub. Kept free of DOM and Tauri so it can be unit tested.
//
// The client id is the only proof of who you are (and of team ownership), so a
// hub must not be able to learn an id that works on another hub. Each device
// keeps one random secret and derives a different id for every hub from it:
// HMAC-SHA256(secret, hub address). A hub you were tricked into connecting to
// sees an id that means nothing anywhere else.
//
// On the desktop (macOS) the secret lives in the login Keychain rather than in
// web storage, which any process running as the user can read; see
// `vaultSecret` and `src-tauri/src/token.rs`.

/** The bits of `Storage` used here. */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const SECRET_KEY = 'sb:deviceSecret';
/** Set once the secret is in the Keychain: from then on it is only read from there. */
export const SECRET_IN_VAULT_KEY = 'sb:deviceSecretInKeychain';
/** What a device secret looks like (the Keychain side checks the same). */
export const DEVICE_SECRET = /^[A-Za-z0-9_-]{32,128}$/;
/** Before per-hub ids: one id for every hub. */
export const LEGACY_ID_KEY = 'sb:clientId';
/** An id pinned to one hub: the legacy id after migration, or a random one where WebCrypto is missing. */
export const idKey = (hub: string) => `sb:clientId@${hub}`;

/** What the hub accepts as a client id. */
export const CLIENT_ID = /^[A-Za-z0-9_-]{16,64}$/;

const DERIVE_LABEL = 'smoke-break client id v1\n';

export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Random base64url string; `crypto.getRandomValues` works without a secure context. */
export function randomId(bytes = 18): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** HMAC-SHA256(secret, hub) as base64url: 43 characters. */
export async function deriveClientId(secret: string, hub: string, subtle: SubtleCrypto): Promise<string> {
  const enc = new TextEncoder();
  const key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await subtle.sign('HMAC', key, enc.encode(DERIVE_LABEL + hub));
  return base64url(new Uint8Array(mac));
}

/**
 * Before per-hub ids there was one `sb:clientId` for every hub. It stays the id
 * for the hub configured at upgrade time, so nobody loses their place or
 * ownership there, and stops being sent anywhere else.
 */
export function migrateLegacyId(store: KeyValue, hub: string) {
  const legacy = store.getItem(LEGACY_ID_KEY);
  if (!legacy) return;
  if (!store.getItem(idKey(hub)) && CLIENT_ID.test(legacy)) store.setItem(idKey(hub), legacy);
  store.removeItem(LEGACY_ID_KEY);
}

/** The Keychain item for the device secret (see the `device_secret_*` commands). */
export interface SecretVault {
  /** The stored secret, or null if there is none. Throws if the Keychain can't be used. */
  get(): Promise<string | null>;
  /**
   * Replaces any existing item with a new one holding `secret`, so the item is
   * always one this app created, and returns the secret now stored. Within one
   * run of the app only the first call creates; later ones (the other window)
   * get that secret back.
   */
  create(secret: string): Promise<string>;
}

/**
 * The device secret from the Keychain, moving the one in web storage there
 * (and out of web storage) the first time. Returns null where there is no
 * Keychain or it refused, and the secret stays in web storage as before.
 */
export async function vaultSecret(store: KeyValue, vault: SecretVault | null): Promise<string | null> {
  if (!vault) return null;
  try {
    if (store.getItem(SECRET_IN_VAULT_KEY) === '1') {
      const stored = await vault.get();
      if (stored && DEVICE_SECRET.test(stored)) {
        store.removeItem(SECRET_KEY);
        return stored;
      }
      // The item is gone (deleted by hand): start a new one below.
    }
    const local = store.getItem(SECRET_KEY);
    const created = await vault.create(local && DEVICE_SECRET.test(local) ? local : randomId(32));
    if (!DEVICE_SECRET.test(created)) return null;
    store.setItem(SECRET_IN_VAULT_KEY, '1');
    store.removeItem(SECRET_KEY);
    return created;
  } catch {
    return null;
  }
}

/**
 * This device's client id for `hub`. Where WebCrypto is missing (the browser
 * version on a plain-http LAN address, which isn't a secure context) each hub
 * gets its own random id instead; there the page and its storage belong to
 * the hub that served it anyway.
 */
export async function clientIdFor(
  store: KeyValue,
  hub: string,
  subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null,
  /** The secret from the Keychain (`vaultSecret`), if there is one; else web storage holds it. */
  vaulted: string | null = null,
): Promise<string> {
  const pinned = store.getItem(idKey(hub));
  if (pinned && CLIENT_ID.test(pinned)) return pinned;
  if (!subtle) {
    const id = randomId();
    store.setItem(idKey(hub), id);
    return id;
  }
  if (vaulted) return deriveClientId(vaulted, hub, subtle);
  let secret = store.getItem(SECRET_KEY);
  if (!secret || secret.length < 32) {
    secret = randomId(32);
    store.setItem(SECRET_KEY, secret);
  }
  return deriveClientId(secret, hub, subtle);
}
