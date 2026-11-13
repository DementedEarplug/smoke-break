// What the desktop app writes to web storage and sends between its windows,
// run end to end: the real settings window (`panel.ts`) and overlay
// (`overlay.ts`) against a stand-in DOM, hub and Rust side. Web storage is a
// plain file any process running as the user can read, so nothing that proves
// who someone is (access token, device secret, client id) may ever reach it,
// nor an event payload. Each window may also only call what its capability
// file in src-tauri/capabilities/ allows.

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HUB = 'wss://breaks.acme.example/ws';
const TOKEN = 'per-user-token-3f9c0d1e';
const SECRET_ITEM = 'device-secret';

// ── Web storage that remembers every write ──────────────────────────────────

class RecordingStorage {
  map = new Map<string, string>();
  writes: [key: string, value: string][] = [];
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
    this.writes.push([k, String(v)]);
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

// ── A DOM just big enough for the app's own code ────────────────────────────

const ctx = new Proxy({} as Record<string | symbol, unknown>, {
  get: (t, k) => (k in t ? t[k] : () => {}),
  set: (t, k, v) => ((t[k] = v), true),
});

class El {
  children: (El | string)[] = [];
  style: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() {} };
  listeners = new Map<string, ((e: unknown) => void)[]>();
  className = '';
  hidden = false;
  disabled = false;
  value = '';
  placeholder = '';
  onclick: (() => unknown) | null = null;
  width = 0;
  height = 0;
  offsetLeft = 0;
  offsetTop = 0;
  private text = '';
  constructor(readonly tagName: string) {}
  get textContent(): string {
    return this.text || this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(v: string) {
    this.text = String(v);
    this.children = [];
  }
  append(...c: (El | string)[]) {
    this.children.push(...c.filter((x) => x !== ''));
  }
  replaceChildren(...c: (El | string)[]) {
    this.children = [];
    this.append(...c);
  }
  addEventListener(type: string, f: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]);
  }
  setAttribute() {}
  focus() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 1, height: 1 };
  }
  getContext() {
    return ctx;
  }
  /** Every element under this one. */
  *all(): Generator<El> {
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      yield c;
      yield* c.all();
    }
  }
  find(pred: (e: El) => boolean): El {
    for (const e of this.all()) if (pred(e)) return e;
    throw new Error(`not found in ${this.textContent.slice(0, 200)}`);
  }
  button(text: string) {
    return this.find((e) => e.tagName === 'button' && e.textContent === text);
  }
  input(placeholder: string) {
    return this.find((e) => e.tagName === 'input' && e.placeholder === placeholder);
  }
}

let app: El;
const frames: FrameRequestCallback[] = [];
/** Runs queued animation frames, except the pack's own (it would keep itself going). */
function runFrames() {
  for (const f of frames.splice(0)) if (f.name !== 'frame') f(0);
}

// ── The hub ─────────────────────────────────────────────────────────────────

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  state(code: string) {
    const team = {
      code,
      name: 'Team',
      defaultLengthMin: 12,
      zoomLink: '',
      hasZoomLink: false,
      meetingProvider: 'fixed-link',
      ownerId: 'm-sam',
      members: [{ id: 'm-sam', name: 'Sam', online: true, label: 'sam' }],
      requireApproval: false,
      pending: [],
      brk: null,
    };
    this.onmessage?.({ data: JSON.stringify({ type: 'state', team, you: 'm-sam', serverNow: Date.now() }) });
    // The next animation frame, where the app handles the newest state (src/net.ts).
    runFrames();
  }
}

// ── The Rust side and the Keychain behind it ────────────────────────────────

let keychain: Map<string, string>;
let runSecret: string | null;
/** Every command a window called: which window, what, with what, and what came back. */
let calls: { label: string; cmd: string; args: Record<string, unknown>; out?: unknown }[];
/** Commands a window called that its capability file doesn't allow. */
let refused: string[];
const callbacks = new Map<number, (e: unknown) => void>();
let label = 'panel';
/** A locked build's Rust side answers for its built-in hub only (src-tauri/src/lock.rs). */
let lockedTo: string | null = null;

const derive = (secret: string, hub: string) =>
  createHmac('sha256', secret).update(`smoke-break client id v1\n${hub}`).digest('base64url');

/** What a capability file lets its window call, as IPC command names. */
function allowedCommands(window: string): Set<string> {
  const file = new URL(`../src-tauri/capabilities/${window}.json`, import.meta.url);
  const cap = JSON.parse(readFileSync(file, 'utf8')) as { windows: string[]; permissions: string[] };
  expect(cap.windows).toEqual([window]);
  return new Set(
    cap.permissions.map((p) => {
      const core = /^core:(\w+):allow-(.+)$/.exec(p);
      if (core) return `plugin:${core[1]}|${core[2].replace(/-/g, '_')}`;
      expect(p).toMatch(/^allow-[a-z-]+$/);
      return p.slice('allow-'.length).replace(/-/g, '_');
    }),
  );
}
const ALLOWED: Record<string, Set<string>> = { overlay: allowedCommands('overlay'), panel: allowedCommands('panel') };

function command(cmd: string, a: Record<string, unknown>): unknown {
  const hub = a.hub as string;
  if (lockedTo && 'hub' in a && hub !== lockedTo) throw 'this build only talks to its built-in hub';
  switch (cmd) {
    case 'keychain_available':
      return true;
    case 'token_get':
      return keychain.get(hub) ?? null;
    case 'token_set':
      if (a.token) keychain.set(hub, a.token as string);
      else keychain.delete(hub);
      return null;
    case 'identity_init':
      if (!runSecret) {
        if (a.legacySecret) keychain.set(SECRET_ITEM, a.legacySecret as string);
        else if (!a.storedBefore || !keychain.has(SECRET_ITEM)) keychain.set(SECRET_ITEM, 'K'.repeat(20) + 'e'.repeat(23));
        runSecret = keychain.get(SECRET_ITEM)!;
      }
      return null;
    case 'client_id_pin':
      keychain.set(`client-id@${hub}`, a.id as string);
      return null;
    case 'client_id':
      if (!runSecret) throw 'the device secret isn’t loaded yet';
      return (a.pinned && keychain.get(`client-id@${hub}`)) || derive(runSecret, hub);
    case 'plugin:event|listen':
      return calls.length;
    case 'window_outer_position':
    case 'window_cursor_position':
      // Never answers the cursor: the overlay would poll it for ever.
      return cmd.endsWith('cursor_position') ? new Promise(() => {}) : { x: 100, y: 100 };
    case 'window_outer_size':
      return { width: 240, height: 360 };
    case 'window_scale_factor':
      return 2;
    case 'window_available_monitors':
      return [];
    default:
      return null;
  }
}

function trigger(window: string, event: string, payload: unknown) {
  const listens = calls.filter((c) => c.label === window && c.cmd === 'plugin:event|listen' && c.args.event === event);
  expect(listens.length, `${window} listens to ${event}`).toBeGreaterThan(0);
  for (const l of listens) callbacks.get(l.args.handler as number)!({ event, id: 0, payload });
}

const tick = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

let local: RecordingStorage;
let session: RecordingStorage;

function stubWindow() {
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('location', { protocol: 'tauri:', host: 'localhost', reload() {} });
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('document', {
    createElement: (t: string) => new El(t),
    getElementById: () => app,
    documentElement: new El('html'),
    title: '',
  });
  vi.stubGlobal('window', {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener() {},
    __TAURI_INTERNALS__: {
      metadata: {
        get currentWindow() {
          return { label };
        },
        get currentWebview() {
          return { windowLabel: label, label };
        },
      },
      transformCallback(f: (e: unknown) => void) {
        const id = callbacks.size + 1;
        callbacks.set(id, f);
        return id;
      },
      async invoke(cmd: string, args: Record<string, unknown> = {}) {
        const call: (typeof calls)[number] = { label, cmd, args };
        calls.push(call);
        if (!ALLOWED[label].has(cmd)) {
          refused.push(`${label}: ${cmd}`);
          throw `${cmd} not allowed`;
        }
        call.out = await command(cmd, args);
        return call.out;
      },
    },
  });
}

/** Loads one window's page as the app would, in its own module graph. */
async function openWindow(which: 'panel' | 'overlay') {
  vi.resetModules();
  label = which;
  app = new El('div');
  await import(which === 'panel' ? './panel.ts' : './overlay.ts');
  await tick();
  return app;
}

beforeEach(() => {
  local = new RecordingStorage();
  session = new RecordingStorage();
  keychain = new Map();
  runSecret = null;
  calls = [];
  refused = [];
  callbacks.clear();
  frames.length = 0;
  FakeSocket.all = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Every secret the app handled: the token, the device secret, and each client id it was given. */
const secrets = () =>
  [TOKEN, keychain.get(SECRET_ITEM), ...calls.filter((c) => c.cmd === 'client_id').map((c) => c.out as string)].filter(
    (s): s is string => !!s,
  );

function expectNoSecretIn(what: string, text: string) {
  for (const s of secrets()) expect(text.includes(s), `${what} holds a secret`).toBe(false);
}

describe.each([
  ['a locked build (the enterprise one)', { VITE_SERVER_URL: HUB, VITE_LOCK_SERVER: '1' }],
  ['an unlocked build', { VITE_SERVER_URL: HUB, VITE_LOCK_SERVER: '' }],
])('the desktop app, %s', (_what, env) => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    lockedTo = env.VITE_LOCK_SERVER ? HUB : null;
    stubWindow();
  });

  it('never puts a token, the device secret or a client id in web storage or an event', async () => {
    // Onboarding in the settings window: name, token, invite code, Join.
    const panel = await openWindow('panel');
    panel.input('Your name').value = 'Sam';
    panel.input('If your server needs one').value = TOKEN;
    panel.input('Invite code').value = 'ABCDE23456';
    panel.button('Join').onclick!();
    await tick();
    expect(keychain.get(HUB)).toBe(TOKEN);

    // Joining: the hub takes us in.
    const panelHub = FakeSocket.all.at(-1)!;
    expect(panelHub.url).toBe(HUB);
    panelHub.open();
    expect(panelHub.sent[0]).toMatchObject({ type: 'hello', teamCode: 'ABCDE23456', token: TOKEN });
    panelHub.state('ABCDE23456');
    runFrames();
    await tick();

    // Rotating the invite code (we own the team).
    panel.button('New invite code').onclick!();
    panel.button('New code').onclick!();
    expect(panelHub.sent.at(-1)).toEqual({ type: 'rotateCode' });
    panelHub.state('NEWCODE234');
    runFrames();

    // Changing the look.
    panel.button('L').onclick!();
    panel.button('Water').onclick!();
    await tick();

    // The overlay starts with the identity the settings window saved.
    const overlayApp = await openWindow('overlay');
    const overlayHub = FakeSocket.all.at(-1)!;
    expect(overlayHub).not.toBe(panelHub);
    overlayHub.open();
    expect(overlayHub.sent[0]).toMatchObject({ type: 'hello', teamCode: 'NEWCODE234', token: TOKEN });
    overlayHub.state('NEWCODE234');
    expect(overlayApp.children.length).toBe(1);

    // Do not disturb, from the tray and back, then the pack moved.
    trigger('overlay', 'dnd', true);
    trigger('overlay', 'dnd', false);
    trigger('overlay', 'dnd', true);
    trigger('overlay', 'tauri://move', { x: 10, y: 20 });
    await new Promise((r) => setTimeout(r, 350));
    await tick();

    // The hub rotates the code again while the overlay is connected.
    overlayHub.state('THIRD23456');

    // Each window called only what its capability file allows.
    expect(refused).toEqual([]);
    expect(calls.some((c) => c.label === 'overlay' && c.cmd === 'token_set')).toBe(false);

    // The secrets were there all along (or this test proves nothing)...
    expect(secrets().length).toBeGreaterThanOrEqual(3);
    expect(secrets()).toContain(derive(keychain.get(SECRET_ITEM)!, HUB));
    // ...and none of them reached web storage, in a key or a value, at any point.
    for (const [store, s] of [
      ['localStorage', local],
      ['sessionStorage', session],
    ] as const) {
      for (const [k, v] of s.writes) expectNoSecretIn(`${store} ${k}`, `${k}\n${v}`);
    }
    // Nor an event between the windows.
    for (const c of calls.filter((c) => c.cmd.startsWith('plugin:event|emit'))) {
      expectNoSecretIn(`event ${String(c.args.event)}`, JSON.stringify(c.args));
    }

    // Exactly this is in web storage (src-tauri/SIGNING.md lists it).
    const expected = [
      ...(env.VITE_LOCK_SERVER ? [] : ['sb:server']),
      'sb:deviceSecretInKeychain',
      'sb:name',
      'sb:lastName',
      `sb:team@${HUB}`,
      'sb:appearance',
      `sb:dnd@${HUB}`,
      'sb:overlayPos',
    ];
    expect(new Set(local.writes.map(([k]) => k))).toEqual(new Set(expected));
    expect(session.writes).toEqual([]);
    expect(local.getItem(`sb:team@${HUB}`)).toBe('THIRD23456');
    expect(local.getItem(`sb:dnd@${HUB}`)).toBe('1');
    expect(JSON.parse(local.getItem('sb:appearance')!)).toMatchObject({ scale: 4, theme: 'water' });
    // The tray's checkbox followed the pack.
    expect(calls.filter((c) => c.cmd === 'set_dnd').map((c) => c.args.on)).toEqual([false, true, false, true]);
  });

  it('carries do-not-disturb kept under the client id by older versions over to the hub, and deletes that key', async () => {
    // An earlier start of this version moved the device secret into the Keychain.
    keychain.set(SECRET_ITEM, 'S'.repeat(43));
    const id = derive('S'.repeat(43), HUB);
    local.setItem('sb:deviceSecretInKeychain', '1');
    local.setItem('sb:name', 'Sam');
    local.setItem(`sb:team@${HUB}`, 'ABCDE23456');
    local.setItem(`sb:dnd:${id}`, '1');
    local.setItem(`sb:dnd:${'x'.repeat(43)}`, '0');
    local.writes = [];

    await openWindow('overlay');
    const hub = FakeSocket.all.at(-1)!;
    hub.open();
    expect(hub.sent[0]).toMatchObject({ clientId: id });
    // Still on, now filed under the hub; the tray was told.
    expect(local.getItem(`sb:dnd@${HUB}`)).toBe('1');
    expect(calls.find((c) => c.cmd === 'set_dnd')?.args).toEqual({ on: true });
    expect([...local.map.keys()].filter((k) => k.startsWith('sb:dnd:'))).toEqual([]);
    expect([...local.map.keys(), ...local.map.values()].some((s) => s.includes(id))).toBe(false);
    expect(refused).toEqual([]);
  });

  it('deletes those old keys at startup even before anyone has joined a team', async () => {
    local.setItem(`sb:dnd:${'y'.repeat(43)}`, '1');
    await openWindow('panel');
    expect([...local.map.keys()].filter((k) => k.startsWith('sb:dnd'))).toEqual([]);
  });

  it('lets the overlay use a token an older version left in web storage until the settings window has moved it', async () => {
    keychain.set(SECRET_ITEM, 'S'.repeat(43));
    local.setItem('sb:deviceSecretInKeychain', '1');
    local.setItem('sb:name', 'Sam');
    local.setItem(`sb:team@${HUB}`, 'ABCDE23456');
    local.setItem(`sb:token@${HUB}`, TOKEN);

    await openWindow('overlay');
    const hub = FakeSocket.all.at(-1)!;
    hub.open();
    expect(hub.sent[0]).toMatchObject({ token: TOKEN });
    // The overlay never saves tokens: it's still there for the settings window to move.
    expect(local.getItem(`sb:token@${HUB}`)).toBe(TOKEN);
    expect(refused).toEqual([]);

    await openWindow('panel');
    expect(keychain.get(HUB)).toBe(TOKEN);
    expect(local.getItem(`sb:token@${HUB}`)).toBeNull();
  });
});
