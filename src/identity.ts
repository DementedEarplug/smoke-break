// Who this device is to a hub. Kept free of DOM and Tauri so it can be unit tested.
//
// The client id is the only proof of who you are (and of team ownership), so a
// hub must not be able to learn an id that works on another hub. Each device
// keeps one random secret and derives a different id for every hub from it:
// HMAC-SHA256(secret, hub address). A hub you were tricked into connecting to
// sees an id that means nothing anywhere else.
//
// The desktop app on macOS keeps the secret, and ids pinned to a hub, in the
// login Keychain and derives ids in Rust (`src-tauri/src/identity.rs`): the
// secret never enters the webview, which only asks for "my id for hub X"
// (`IdentityVault`). `moveToKeychain` moves what older versions kept in web
// storage there, once. Where there is no Keychain (the browser version, other
// platforms) everything stays in web storage and `clientIdFor` derives here;
// both derivations are checked against `shared/client-id-vectors.json`.

/** The bits of `Storage` used here. */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A store whose keys can be listed (`Storage`). */
export interface ListableKeyValue extends KeyValue {
  readonly length: number;
  key(i: number): string | null;
}

export const SECRET_KEY = 'sb:deviceSecret';
/** Set once the secret is in the Keychain: from then on it is only read from there. */
export const SECRET_IN_VAULT_KEY = 'sb:deviceSecretInKeychain';
/** Hubs whose pinned id is in the Keychain (JSON list): only those are looked up there. */
export const PINNED_IN_VAULT_KEY = 'sb:pinnedIdsInKeychain';
/** What a device secret looks like (the Keychain side checks the same). */
export const DEVICE_SECRET = /^[A-Za-z0-9_-]{32,128}$/;
/** Before per-hub ids: one id for every hub. */
export const LEGACY_ID_KEY = 'sb:clientId';
/** An id pinned to one hub: the legacy id after migration, or a random one where WebCrypto is missing. */
export const idKey = (hub: string) => `sb:clientId@${hub}`;
const ID_KEY_PREFIX = idKey('');

/** What the hub accepts as a client id. */
export const CLIENT_ID = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Do-not-disturb, per hub. Keyed by the hub address, which isn't secret:
 * nothing in web storage is keyed by (or holds) a client id.
 */
export const dndKey = (hub: string) => `sb:dnd@${hub}`;
/** Older versions kept do-not-disturb in localStorage under `sb:dnd:<client id>`, which put the id there too. */
export const LEGACY_DND_PREFIX = 'sb:dnd:';

/**
 * Carries do-not-disturb from an older version's `sb:dnd:<clientId>` (in
 * `legacy`, localStorage) over to `dndKey(hub)` in `store`, unless that is set
 * already, then deletes every `sb:dnd:` key whose suffix looks like a client
 * id, so none is left in web storage. With `clientId` null (not known, e.g. no
 * team yet or the Keychain refused) nothing is carried over; the old keys go
 * anyway.
 */
export function migrateDnd(legacy: ListableKeyValue, store: KeyValue, hub: string, clientId: string | null) {
  const keys: string[] = [];
  for (let i = 0; i < legacy.length; i++) {
    const k = legacy.key(i);
    if (k?.startsWith(LEGACY_DND_PREFIX) && CLIENT_ID.test(k.slice(LEGACY_DND_PREFIX.length))) keys.push(k);
  }
  if (!keys.length) return;
  const old = clientId === null ? null : legacy.getItem(LEGACY_DND_PREFIX + clientId);
  if (old !== null && store.getItem(dndKey(hub)) === null) store.setItem(dndKey(hub), old === '1' ? '1' : '0');
  for (const k of keys) legacy.removeItem(k);
}

export const DERIVE_LABEL = 'smoke-break client id v1\n';

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

/**
 * A hub address in the form the Keychain side accepts (`check_hub` in
 * `src-tauri/src/token.rs`): ws(s), a host, no user or fragment, canonical.
 */
export function isHubKey(hub: string): boolean {
  if (hub.length > 512 || /[\s\u0000-\u001f\u007f]/.test(hub)) return false;
  try {
    const url = new URL(hub);
    return (
      (url.protocol === 'ws:' || url.protocol === 'wss:') &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.href === hub
    );
  } catch {
    return false;
  }
}

/** The Keychain side of the identity: the `identity_init`, `client_id_pin` and `client_id` commands. */
export interface IdentityVault {
  /**
   * Loads the device secret from the Keychain or stores one there, once per
   * run (later calls change nothing). `legacySecret` is one still in web
   * storage (it replaces any item, keeping every id); `storedBefore` says it
   * was stored in the Keychain earlier; with neither a new one is made.
   * Throws if the Keychain refuses.
   */
  init(legacySecret: string | null, storedBefore: boolean): Promise<void>;
  /** Keeps `id` as the id for `hub` in the Keychain. Throws if the Keychain refuses. */
  pin(hub: string, id: string): Promise<void>;
  /** The id for `hub`: the pinned one if `pinned`, else derived. Throws rather than make one up. */
  clientId(hub: string, pinned: boolean): Promise<string>;
}

/** Hubs whose pinned id is in the Keychain. */
export function pinnedHubs(store: KeyValue): string[] {
  try {
    const list: unknown = JSON.parse(store.getItem(PINNED_IN_VAULT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((h): h is string => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

function addPinnedHub(store: KeyValue, hub: string) {
  const list = pinnedHubs(store);
  if (!list.includes(hub)) store.setItem(PINNED_IN_VAULT_KEY, JSON.stringify([...list, hub]));
}

/**
 * Moves the identity out of web storage into the Keychain: the device secret
 * (or, on a fresh install, has one made there) and every id pinned to a hub.
 * Each piece leaves web storage only after the Keychain confirmed it, and the
 * ids stay exactly what they were (except ids for hubs this build can't use). Throws if the Keychain refuses; nothing is
 * made up meanwhile, and calling it again picks up where it stopped.
 */
export async function moveToKeychain(
  store: ListableKeyValue,
  vault: IdentityVault,
  /** Hubs this build may talk to (a locked build: only its own). Ids pinned to any other are dropped. */
  usable: (hub: string) => boolean = () => true,
): Promise<void> {
  const storedBefore = store.getItem(SECRET_IN_VAULT_KEY) === '1';
  const local = store.getItem(SECRET_KEY);
  const legacy = !storedBefore && local && DEVICE_SECRET.test(local) ? local : null;
  await vault.init(legacy, storedBefore);
  store.setItem(SECRET_IN_VAULT_KEY, '1');
  store.removeItem(SECRET_KEY);

  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k?.startsWith(ID_KEY_PREFIX)) keys.push(k);
  }
  for (const k of keys) {
    const hub = k.slice(ID_KEY_PREFIX.length);
    const id = store.getItem(k);
    // The other window may have moved it meanwhile.
    if (id === null) continue;
    // Not an id, or a hub this build could ever use (the Keychain side would
    // refuse it too): nothing to keep.
    if (!CLIENT_ID.test(id) || !isHubKey(hub) || !usable(hub)) {
      store.removeItem(k);
      continue;
    }
    await vault.pin(hub, id);
    addPinnedHub(store, hub);
    store.removeItem(k);
  }
}

/** This device's id for `hub` from the Keychain side; `moveToKeychain` must have finished. */
export function vaultClientId(store: KeyValue, vault: IdentityVault, hub: string): Promise<string> {
  return vault.clientId(hub, pinnedHubs(store).includes(hub));
}

/**
 * This device's client id for `hub` where there is no Keychain (the browser
 * version, other platforms): the secret and pinned ids live in web storage.
 * Where WebCrypto is missing (the browser version on a plain-http LAN address,
 * which isn't a secure context) each hub gets its own random id instead; there
 * the page and its storage belong to the hub that served it anyway.
 */
export async function clientIdFor(
  store: KeyValue,
  hub: string,
  subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null,
): Promise<string> {
  const pinned = store.getItem(idKey(hub));
  if (pinned && CLIENT_ID.test(pinned)) return pinned;
  if (!subtle) {
    const id = randomId();
    store.setItem(idKey(hub), id);
    return id;
  }
  let secret = store.getItem(SECRET_KEY);
  if (!secret || secret.length < 32) {
    secret = randomId(32);
    store.setItem(SECRET_KEY, secret);
  }
  return deriveClientId(secret, hub, subtle);
}
