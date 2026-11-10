// Where we're running (browser prototype vs. desktop app) and the bits that
// differ between them: identity storage, the server address and its token.
//
// Everything that proves who you are to a hub (client id, access token) and the
// team you're in is kept per hub, so pointing the app at another server never
// hands that server something that works on the real one.

import { invoke } from '@tauri-apps/api/core';
import { type KeyValue, LEGACY_ID_KEY, SECRET_KEY, clientIdFor, migrateLegacyId } from './identity.ts';
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

/** This device's client id for a hub (by default the configured one). */
export async function clientId(hub = currentHub()): Promise<string> {
  await ready;
  return clientIdFor(store, hub);
}

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
/** Fallback storage where the Keychain isn't available (browser, non-macOS, Keychain refused). */
const tokenKey = (hub: string) => `sb:token@${hub}`;
const LEGACY_TOKEN_KEY = 'sb:token';

/** The built-in token belongs to the built-in hub and is never sent anywhere else. */
function builtInToken(hub: string): string {
  if (!DEFAULT_TOKEN) return '';
  // The browser version only talks to the server that served it (and the token).
  if (servedOverHttp) return DEFAULT_TOKEN;
  return hub === hubKey(DEFAULT_SERVER) ? DEFAULT_TOKEN : '';
}

/**
 * Desktop on macOS: tokens live in the login Keychain (see `src-tauri/src/token.rs`),
 * not in the webview's storage. Returns undefined where that isn't available.
 */
async function keychainGet(hub: string): Promise<string | null | undefined> {
  if (!isDesktop) return undefined;
  try {
    return await invoke<string | null>('token_get', { hub });
  } catch {
    return undefined;
  }
}

/** Stores (or with '' deletes) a hub's token in the Keychain; false if that didn't work. */
async function keychainSet(hub: string, token: string): Promise<boolean> {
  if (!isDesktop) return false;
  try {
    await invoke('token_set', { hub, token });
    return true;
  } catch {
    return false;
  }
}

async function readToken(hub: string): Promise<string> {
  return (await keychainGet(hub)) || localStorage.getItem(tokenKey(hub)) || '';
}

async function writeToken(token: string, hub: string) {
  const t = token.trim().slice(0, TOKEN_MAX);
  if (await keychainSet(hub, t)) {
    localStorage.removeItem(tokenKey(hub));
  } else if (t) {
    localStorage.setItem(tokenKey(hub), t);
  } else {
    localStorage.removeItem(tokenKey(hub));
  }
}

/** The saved token for a hub only (for the onboarding field; the built-in one isn't shown). */
export async function savedHubToken(hub = currentHub()): Promise<string> {
  await ready;
  return readToken(hub);
}

export async function saveHubToken(token: string, hub = currentHub()) {
  await ready;
  await writeToken(token, hub);
}

/** A hub's access token: one entered in onboarding, else the built-in one if this is its hub, else none. */
export async function hubToken(hub: string): Promise<string> {
  return (await savedHubToken(hub)) || builtInToken(hub);
}

/** Adds the hub's access token to a create/hello, when there is one. */
export async function withToken<T extends object>(msg: T, hub: string): Promise<T & { token?: string }> {
  const token = await hubToken(hub);
  return token ? { ...msg, token } : msg;
}

// ── Upgrade from one identity for every hub ─────────────────────────────────

/**
 * Before per-hub data the client id, team and token were saved once for
 * whatever hub was configured. They now belong to the hub configured at
 * upgrade time, and are never sent to any other.
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
    if (token && !(await readToken(hub))) await writeToken(token, hub);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  }
}

/** Await before reading identity or tokens; every entry point does. */
export const ready: Promise<void> = migrate(store).catch((e) => console.error('Smoke Break: migration failed', e));
