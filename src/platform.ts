// Where we're running (browser prototype vs. desktop app) and the bits that
// differ between them: identity storage and the server address.

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

export function serverUrl(): string {
  if (servedOverHttp) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }
  return localStorage.getItem('sb:server') || DEFAULT_SERVER;
}

export function saveServerUrl(url: string) {
  if (url.trim()) localStorage.setItem('sb:server', url.trim());
  else localStorage.removeItem('sb:server');
}
