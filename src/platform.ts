// Where we're running (browser prototype vs. desktop app) and the bits that
// differ between them: identity storage and the server address.

import { checkServerUrl } from './serverUrl.ts';

export const isDesktop = '__TAURI_INTERNALS__' in window;

/** Served over http(s), e.g. the Vite dev server, which hosts the hub on /ws. */
const servedOverHttp = location.protocol === 'http:' || location.protocol === 'https:';

/**
 * Identity storage. In the browser each tab is its own teammate (sessionStorage);
 * on the desktop it's one person per machine (localStorage, shared by all windows).
 */
const store: Storage = isDesktop ? localStorage : sessionStorage;

export interface Identity {
  clientId: string;
  name: string;
  teamCode: string;
}

function newId(): string {
  // crypto.randomUUID needs a secure context, which LAN http:// URLs aren't.
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function clientId(): string {
  let id = store.getItem('sb:clientId');
  if (!id) {
    id = newId();
    store.setItem('sb:clientId', id);
  }
  return id;
}

export function savedName(): string {
  return store.getItem('sb:name') ?? '';
}

export function saveName(name: string) {
  store.setItem('sb:name', name);
  localStorage.setItem('sb:lastName', name);
}

export function savedTeam(): string {
  return store.getItem('sb:team') ?? '';
}

export function saveTeam(code: string) {
  store.setItem('sb:team', code);
}

export function loadIdentity(): Identity | null {
  const name = savedName();
  const teamCode = savedTeam();
  return name && teamCode ? { clientId: clientId(), name, teamCode } : null;
}

/** Forget the team (keeps the name for next time). */
export function leaveTeam() {
  store.removeItem('sb:team');
}

/** Drop this tab's identity so it acts as a new teammate (browser testing). */
export function resetTabIdentity() {
  for (const k of ['sb:clientId', 'sb:name', 'sb:team']) store.removeItem(k);
}

const DEFAULT_SERVER = import.meta.env.VITE_SERVER_URL || 'ws://localhost:8787/ws';

/** Only needed when the page isn't served by the hub itself (the built desktop app). */
export const serverIsConfigurable = !servedOverHttp;

/** The configured hub address; check it with `checkServerUrl` before connecting. */
export function serverUrl(): string {
  if (servedOverHttp) {
    // The browser prototype talks to the server that served the page, so the
    // connection is exactly as secure as the page itself.
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }
  return localStorage.getItem('sb:server') || DEFAULT_SERVER;
}

/** Why the configured hub address can't be used, or null if it's fine. */
export function serverProblem(): string | null {
  if (servedOverHttp) return null;
  const r = checkServerUrl(serverUrl());
  return 'error' in r ? r.error : null;
}

/** Saves a checked address (or clears it for the default); returns an error message if it's not acceptable. */
export function saveServerUrl(raw: string): string | null {
  if (!raw.trim()) {
    localStorage.removeItem('sb:server');
    return null;
  }
  const r = checkServerUrl(raw);
  if ('error' in r) return r.error;
  localStorage.setItem('sb:server', r.url);
  return null;
}

const DEFAULT_TOKEN = import.meta.env.VITE_HUB_TOKEN || '';
const TOKEN_MAX = 512;

/** The hub's access token: one entered in onboarding, else the one built in, else none. */
export function hubToken(): string {
  return localStorage.getItem('sb:token') || DEFAULT_TOKEN;
}

/** The saved override only (for the onboarding field; the built-in one isn't shown). */
export function savedHubToken(): string {
  return localStorage.getItem('sb:token') ?? '';
}

export function saveHubToken(token: string) {
  const t = token.trim().slice(0, TOKEN_MAX);
  if (t) localStorage.setItem('sb:token', t);
  else localStorage.removeItem('sb:token');
}

/** Adds the access token to a create/hello, when there is one. */
export function withToken<T extends object>(msg: T): T & { token?: string } {
  const token = hubToken();
  return token ? { ...msg, token } : msg;
}
