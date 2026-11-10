// Where we're running (browser prototype vs. desktop app) and the bits that
// differ between them: identity storage, the server address and its token.
//
// Everything that proves who you are to a hub (client id, access token) and the
// team you're in is kept per hub, so pointing the app at another server never
// hands that server something that works on the real one.

import { invoke } from '@tauri-apps/api/core';
import {
  type IdentityVault,
  type KeyValue,
  LEGACY_ID_KEY,
  SECRET_KEY,
  clientIdFor,
  isHubKey,
  migrateLegacyId,
  moveToKeychain,
  vaultClientId,
} from './identity.ts';
import { checkServerUrl, hubKey } from './serverUrl.ts';

export const isDesktop = '__TAURI_INTERNALS__' in window;

/** Served over http(s), e.g. the Vite dev server, which hosts the hub on /ws. */
const servedOverHttp = location.protocol === 'http:' || location.protocol === 'https:';

/**
 * Identity storage. In the browser each tab is its own teammate (sessionStorage);
 * on the desktop it's one person per machine (localStorage, shared by all windows).
 */
const store: Storage = isDesktop ? localStorage : sessionStorage;

export interface Identity {
  /** The hub this identity belongs to (see `currentHub`); connect only there. */
  hub: string;
  clientId: string;
  name: string;
  teamCode: string;
}

// ── Server ──────────────────────────────────────────────────────────────────

const DEFAULT_SERVER = import.meta.env.VITE_SERVER_URL || 'ws://localhost:8787/ws';

/**
 * Built with `VITE_LOCK_SERVER=1`: the app only ever talks to the built-in hub
 * (`VITE_SERVER_URL`). The Server field is hidden and a saved address is
 * ignored, so nobody can be talked into pointing the app somewhere else.
 */
export const serverLocked = /^(1|true|yes)$/i.test(String(import.meta.env.VITE_LOCK_SERVER ?? ''));

/** Only needed when the page isn't served by the hub itself (the built desktop app). */
export const serverIsConfigurable = !servedOverHttp && !serverLocked;

/** The configured hub address; check it with `checkServerUrl` before connecting. */
export function serverUrl(): string {
  if (servedOverHttp) {
    // The browser prototype talks to the server that served the page, so the
    // connection is exactly as secure as the page itself.
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }
  if (serverLocked) return DEFAULT_SERVER;
  return localStorage.getItem('sb:server') || DEFAULT_SERVER;
}

/** The configured hub, in the form per-hub data is filed under. */
export function currentHub(): string {
  return hubKey(serverUrl());
}

/** Why a hub address can't be used, or null if it's fine. */
export function serverProblem(url = serverUrl()): string | null {
  if (servedOverHttp) return null;
  const r = checkServerUrl(url);
  return 'error' in r ? r.error : null;
}

/** Saves a checked address (or clears it for the default); returns an error message if it's not acceptable. */
export function saveServerUrl(raw: string): string | null {
  if (!serverIsConfigurable) return null;
  if (!raw.trim()) {
    localStorage.removeItem('sb:server');
    return null;
  }
  const r = checkServerUrl(raw);
  if ('error' in r) return r.error;
  localStorage.setItem('sb:server', r.url);
  return null;
}

// ── Name and team ───────────────────────────────────────────────────────────

const teamKey = (hub: string) => `sb:team@${hub}`;
const LEGACY_TEAM_KEY = 'sb:team';

export function savedName(): string {
  return store.getItem('sb:name') ?? '';
}

export function saveName(name: string) {
  store.setItem('sb:name', name);
  localStorage.setItem('sb:lastName', name);
}

/** The team saved for a hub (by default the configured one). */
export function savedTeam(hub = currentHub()): string {
  return store.getItem(teamKey(hub)) ?? '';
}

export function saveTeam(code: string, hub = currentHub()) {
  store.setItem(teamKey(hub), code);
}

/** Forget the team on a hub (keeps the name for next time). */
export function leaveTeam(hub = currentHub()) {
  store.removeItem(teamKey(hub));
}

// ── Keychain ────────────────────────────────────────────────────────────────

/**
 * Desktop on macOS: access tokens, the device secret and pinned ids live in
 * the login Keychain (`src-tauri/src/token.rs`), never in web storage. Set by
 * `ready`. Elsewhere (the browser version, other platforms) web storage holds
 * them, which `tokenStorageHint` says.
 */
let keychain = false;

async function keychainAvailable(): Promise<boolean> {
  if (!isDesktop) return false;
  try {
    return await invoke<boolean>('keychain_available');
  } catch {
    // Can't tell: assume there is one, so nothing secret goes to web storage.
    return true;
  }
}

/** The message of a refused Tauri command (a string) or an Error. */
const reason = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e));

/** Where tokens are kept, for the hint under the token field. */
export function tokenStorageHint(): string {
  if (keychain) return 'Kept in your login Keychain.';
  if (isDesktop) return 'There’s no Keychain on this system, so it’s kept in the app’s own storage, which other programs running as you can read.';
  return 'Kept in this browser’s storage for this server.';
}

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * The Keychain refused to give out (or store) this device's identity. Nothing
 * is made up instead: a new identity would silently lose the person's place
 * and team ownership. Show `message` and let them try again.
 */
export class IdentityUnavailable extends Error {
  constructor(why: string) {
    super(
      `Couldn’t get your identity from the Keychain (${why}). Smoke Break keeps who you are there and won’t make up a new identity, which would lose your place in your team. Unlock the Keychain or allow access when macOS asks, then try again.`,
    );
    this.name = 'IdentityUnavailable';
  }
}

/** The `identity_*` / `client_id*` commands: the device secret never comes back out of Rust. */
const keychainIdentity: IdentityVault = {
  init: (legacySecret, storedBefore) => invoke('identity_init', { legacySecret, storedBefore }),
  pin: (hub, id) => invoke('client_id_pin', { hub, id }),
  clientId: (hub, pinned) => invoke<string>('client_id', { hub, pinned }),
};

/** The move into the Keychain, while it runs or once it worked; null after a failure, so the next call tries again. */
let identityMoved: Promise<void> | null = null;

function keychainIdentityReady(): Promise<void> {
  identityMoved ??= moveToKeychain(store, keychainIdentity).catch((e) => {
    identityMoved = null;
    throw new IdentityUnavailable(reason(e));
  });
  return identityMoved;
}

/**
 * This device's client id for a hub (by default the configured one). Throws
 * `IdentityUnavailable` if the Keychain refuses; call again to retry.
 */
export async function clientId(hub = currentHub()): Promise<string> {
  await ready;
  if (!keychain) return clientIdFor(store, hub);
  await keychainIdentityReady();
  try {
    return await vaultClientId(store, keychainIdentity, hub);
  } catch (e) {
    throw new IdentityUnavailable(reason(e));
  }
}

/** Throws `IdentityUnavailable` if the Keychain refuses (see `clientId`). */
export async function loadIdentity(): Promise<Identity | null> {
  await ready;
  const hub = currentHub();
  const name = savedName();
  const teamCode = savedTeam(hub);
  return name && teamCode ? { hub, clientId: await clientId(hub), name, teamCode } : null;
}

/** Drop this tab's identity so it acts as a new teammate (browser testing). */
export function resetTabIdentity() {
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) keys.push(store.key(i) ?? '');
  for (const k of keys) {
    if (k === 'sb:name' || k === SECRET_KEY || k.startsWith(LEGACY_ID_KEY) || k.startsWith(LEGACY_TEAM_KEY)) {
      store.removeItem(k);
    }
  }
}

// ── Access token ────────────────────────────────────────────────────────────

const DEFAULT_TOKEN = import.meta.env.VITE_HUB_TOKEN || '';
const TOKEN_MAX = 512;
/**
 * Where there is no Keychain (browser, other platforms), tokens are kept here.
 * On macOS this only ever holds what an older version left behind, until it
 * has been moved to the Keychain.
 */
const tokenKey = (hub: string) => `sb:token@${hub}`;
const TOKEN_KEY_PREFIX = tokenKey('');
const LEGACY_TOKEN_KEY = 'sb:token';

/** The built-in token belongs to the built-in hub and is never sent anywhere else. */
function builtInToken(hub: string): string {
  if (!DEFAULT_TOKEN) return '';
  // The browser version only talks to the server that served it (and the token).
  if (servedOverHttp) return DEFAULT_TOKEN;
  return hub === hubKey(DEFAULT_SERVER) ? DEFAULT_TOKEN : '';
}

/** Problems keeping a hub's token in the Keychain this run, by hub (this window only). */
const tokenProblems = new Map<string, { reading: boolean; message: string }>();

/**
 * Why the token for `hub` isn't safely saved, or '' if it is (or there's
 * nothing to say). Shown in onboarding and the team panel.
 */
export function tokenNotice(hub = currentHub()): string {
  return tokenProblems.get(hub)?.message ?? '';
}

const notSavedMessage = (why: string) =>
  `Couldn’t save your access token to the Keychain (${why}). It’s kept only until you quit Smoke Break: you’ll need to enter it again next time.`;

/**
 * Stores (or with '' deletes) a hub's token in the Keychain. If the Keychain
 * refuses, the Rust side keeps it in memory until the app quits (never in web
 * storage), and this returns why.
 */
async function keychainSet(hub: string, token: string): Promise<string | null> {
  try {
    return (await invoke<string | null>('token_set', { hub, token })) ?? null;
  } catch (e) {
    return reason(e);
  }
}

async function readToken(hub: string): Promise<string> {
  if (!keychain) return localStorage.getItem(tokenKey(hub)) || '';
  try {
    const t = await invoke<string | null>('token_get', { hub });
    if (tokenProblems.get(hub)?.reading) tokenProblems.delete(hub);
    return t || '';
  } catch (e) {
    tokenProblems.set(hub, {
      reading: true,
      message: `Couldn’t read your saved access token from the Keychain (${reason(e)}). Allow access when macOS asks, or enter the token again.`,
    });
    return '';
  }
}

/** Returns why the token couldn't be saved for good, or null. */
async function writeToken(token: string, hub: string): Promise<string | null> {
  const t = token.trim().slice(0, TOKEN_MAX);
  if (!keychain) {
    if (t) localStorage.setItem(tokenKey(hub), t);
    else localStorage.removeItem(tokenKey(hub));
    return null;
  }
  const problem = await keychainSet(hub, t);
  // Whatever an older version left in web storage is replaced either way.
  localStorage.removeItem(tokenKey(hub));
  if (problem === null) {
    tokenProblems.delete(hub);
    return null;
  }
  const message = t ? notSavedMessage(problem) : `Couldn’t remove your access token from the Keychain (${problem}).`;
  tokenProblems.set(hub, { reading: false, message });
  return message;
}

/** The saved token for a hub only (for the onboarding field; the built-in one isn't shown). */
export async function savedHubToken(hub = currentHub()): Promise<string> {
  await ready;
  return readToken(hub);
}

/** Saves a hub's token; returns a message for the person if it couldn't be saved for good. */
export async function saveHubToken(token: string, hub = currentHub()): Promise<string | null> {
  await ready;
  return writeToken(token, hub);
}

/** A hub's access token: one entered in onboarding, else the built-in one if this is its hub, else none. */
export async function hubToken(hub: string): Promise<string> {
  return (await savedHubToken(hub)) || builtInToken(hub);
}

/**
 * macOS: tokens an older version kept in web storage (before the Keychain, or
 * when it refused) move to the Keychain. Each leaves web storage only once the
 * Keychain has it; until then the Rust side holds it in memory for this run.
 */
async function moveTokensToKeychain() {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(TOKEN_KEY_PREFIX)) keys.push(k);
  }
  for (const k of keys) {
    const hub = k.slice(TOKEN_KEY_PREFIX.length);
    const token = localStorage.getItem(k);
    if (token === null) continue;
    if (!token || !isHubKey(hub)) {
      localStorage.removeItem(k);
      continue;
    }
    const problem = await keychainSet(hub, token.slice(0, TOKEN_MAX));
    if (problem === null) localStorage.removeItem(k);
    else tokenProblems.set(hub, { reading: false, message: notSavedMessage(problem) });
  }
}

// ── Upgrade from one identity for every hub ─────────────────────────────────

/**
 * Before per-hub data the client id, team and token were saved once for
 * whatever hub was configured. They now belong to the hub configured at
 * upgrade time, and are never sent to any other. Then, on macOS, whatever
 * secret is still in web storage moves to the Keychain.
 */
async function migrate(kv: KeyValue) {
  const hub = currentHub();
  migrateLegacyId(kv, hub);
  const team = kv.getItem(LEGACY_TEAM_KEY);
  if (team !== null) {
    if (team && !kv.getItem(teamKey(hub))) kv.setItem(teamKey(hub), team);
    kv.removeItem(LEGACY_TEAM_KEY);
  }
  const token = localStorage.getItem(LEGACY_TOKEN_KEY);
  if (token !== null) {
    if (token && !localStorage.getItem(tokenKey(hub))) localStorage.setItem(tokenKey(hub), token);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  }
  // The browser version keeps one teammate per tab in session storage.
  keychain = await keychainAvailable();
  if (!keychain) return;
  await moveTokensToKeychain();
  // Started here so it's under way early; `clientId` waits for it (and retries it).
  keychainIdentityReady().catch(() => {});
}

/** Await before reading identity or tokens; every entry point does. */
export const ready: Promise<void> = migrate(store).catch((e) => console.error('Smoke Break: migration failed', e));
