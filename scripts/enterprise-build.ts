// The documented way to build Smoke Break for a company (src-tauri/SIGNING.md):
// one hub, pinned everywhere.
//
//   VITE_SERVER_URL=wss://breaks.acme.internal/ws \
//   SMOKE_BREAK_MEETING_HOST=acme.zoom.us \
//   APPLE_SIGNING_IDENTITY="Developer ID Application: Acme Inc (TEAMID1234)" \
//   npm run desktop:build:enterprise -- --target universal-apple-darwin
//
// It refuses to build unless the hub address and the meeting host are set,
// locks the app to that hub (VITE_LOCK_SERVER=1), pins the webviews' CSP
// `connect-src` to exactly that hub (release and dev CSP alike), runs
// `tauri build` with that config, and then checks the CSP compiled into the
// app before printing what was pinned. Arguments after `--` go to `tauri build`.
//
// A shared access token (VITE_HUB_TOKEN) is refused: it is in every copy of
// the app and can't be revoked for one person. People enter their own token
// in the app instead.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MEETING_HOSTS } from '../shared/protocol.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAURI_DIR = join(ROOT, 'src-tauri');

/** What the windows need to talk to the app itself; the hub is added after these. */
export const CSP_BASE = "'self' ipc: http://ipc.localhost";
/** Found in the default (unpinned) CSP after `wss:`; none of these may be left in the built app. */
export const WIDE_SOURCES = ['ws://localhost:*', 'ws://127.0.0.1:*', 'ws://[::1]:*'];

export interface Plan {
  /** The hub address baked into the app (`VITE_SERVER_URL`). */
  serverUrl: string;
  /** What `connect-src` allows besides the app itself: `wss://host[:port]`. */
  hubOrigin: string;
  meetingHost: string;
  /** `APPLE_SIGNING_IDENTITY`, if set. */
  signingIdentity: string | null;
  /** Signing happens from `APPLE_CERTIFICATE` (CI) instead of a named identity. */
  certificateFromEnv: boolean;
}

type Env = Record<string, string | undefined>;

/** Checks the build environment; returns the plan, or every problem with what to set. */
export function checkEnv(env: Env): { plan: Plan } | { errors: string[] } {
  const errors: string[] = [];

  const raw = (env.VITE_SERVER_URL ?? '').trim();
  let hubOrigin = '';
  let serverUrl = '';
  if (!raw) {
    errors.push('Set VITE_SERVER_URL to your hub, e.g. VITE_SERVER_URL=wss://breaks.acme.internal/ws');
  } else {
    const r = checkHubUrl(raw);
    if ('error' in r) errors.push(`VITE_SERVER_URL ${r.error}`);
    else ({ url: serverUrl, origin: hubOrigin } = r);
  }

  const meetingHost = (env.SMOKE_BREAK_MEETING_HOST ?? '').trim();
  if (!meetingHost) {
    errors.push("Set SMOKE_BREAK_MEETING_HOST to your company's Zoom host, e.g. SMOKE_BREAK_MEETING_HOST=acme.zoom.us");
  } else if (!isMeetingHost(meetingHost)) {
    errors.push(
      `SMOKE_BREAK_MEETING_HOST must be a Zoom host in lower case, like acme.zoom.us (one of ${MEETING_HOSTS.join(', ')} or a subdomain), not ${JSON.stringify(meetingHost)}`,
    );
  }

  if (env.VITE_HUB_TOKEN) {
    errors.push(
      'Unset VITE_HUB_TOKEN: a shared token is in every copy of the app and can’t be revoked for one person. Give each person their own token (SMOKE_BREAK_ACCESS_TOKENS_FILE on the hub); they enter it in the app.',
    );
  }
  const lock = env.VITE_LOCK_SERVER;
  if (lock !== undefined && lock !== '' && !/^(1|true|yes)$/i.test(lock)) {
    errors.push(`VITE_LOCK_SERVER=${lock} would leave the server unlocked; unset it (this build sets it to 1).`);
  }

  if (errors.length) return { errors };
  return {
    plan: {
      serverUrl,
      hubOrigin,
      meetingHost,
      signingIdentity: env.APPLE_SIGNING_IDENTITY?.trim() || null,
      certificateFromEnv: !!env.APPLE_CERTIFICATE,
    },
  };
}

/** A `wss://` hub address whose origin can stand in a CSP source as is. */
export function checkHubUrl(raw: string): { url: string; origin: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `isn't an address: ${JSON.stringify(raw)}. It should look like wss://breaks.acme.internal/ws` };
  }
  if (url.protocol !== 'wss:') return { error: `must start with wss:// (encrypted), not ${url.protocol}//` };
  if (/[\s\\]/.test(raw) || url.username || url.password) return { error: 'must be a plain wss://host/path address' };
  // A CSP host-source can't hold an IPv6 literal, wildcards or anything unusual.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(url.hostname)) {
    return { error: `needs a host name (letters, digits, dots and dashes), not ${JSON.stringify(url.hostname)}` };
  }
  url.hash = '';
  return { url: url.href, origin: url.origin };
}

/** Same rule as `is_meeting_host` in src-tauri/src/meeting.rs, for an exact host. */
export function isMeetingHost(host: string): boolean {
  return (
    /^[a-z0-9.-]+$/.test(host) &&
    !host.split('.').includes('') &&
    MEETING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  );
}

export const connectSrc = (hubOrigin: string) => `${CSP_BASE} ${hubOrigin}`;

/**
 * The config Tauri merges into tauri.conf.json (JSON Merge Patch: only these
 * keys change). `devCsp` is only used by `tauri dev`, but pinning it too keeps
 * the wide list out of the binary altogether.
 */
export function makeOverride(plan: Plan): object {
  const pinned = { 'connect-src': connectSrc(plan.hubOrigin) };
  const out: Record<string, unknown> = { app: { security: { csp: pinned, devCsp: pinned } } };
  if (plan.signingIdentity) out.bundle = { macOS: { signingIdentity: plan.signingIdentity } };
  return out;
}

/** The environment `tauri build` (and the `npm run build` it runs first) gets. */
export function buildEnv(env: Env, plan: Plan): Env {
  return {
    ...env,
    VITE_SERVER_URL: plan.serverUrl,
    VITE_LOCK_SERVER: '1',
    SMOKE_BREAK_MEETING_HOST: plan.meetingHost,
    VITE_HUB_TOKEN: '',
  };
}

/** `--target <triple>` (or `--target=<triple>`, `-t <triple>`) from the arguments for `tauri build`. */
export function targetOf(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--target' || a === '-t') && args[i + 1]) return args[i + 1];
    if (a.startsWith('--target=')) return a.slice('--target='.length);
  }
  return null;
}

/**
 * Problems with the CSP compiled into the app's executables: the pinned
 * `connect-src` must be there, and nothing of the default wide one.
 */
export function checkEmbeddedCsp(binaries: { name: string; data: Buffer }[], hubOrigin: string): string[] {
  if (!binaries.length) return ['no executable found in the app bundle'];
  const problems: string[] = [];
  const pinned = connectSrc(hubOrigin);
  for (const { name, data } of binaries) {
    if (!data.includes(pinned)) problems.push(`${name}: the pinned connect-src (${pinned}) isn't in it`);
    for (const wide of WIDE_SOURCES) {
      if (data.includes(wide)) problems.push(`${name}: still allows ${wide}`);
    }
    // Every connect-src the app carries starts the same way; each must go on to
    // the hub, not to a bare `wss:` (any host).
    let at = data.indexOf(`${CSP_BASE} `);
    while (at >= 0) {
      const rest = data.subarray(at + CSP_BASE.length + 1, at + CSP_BASE.length + 1 + hubOrigin.length).toString('latin1');
      if (rest !== hubOrigin) problems.push(`${name}: a connect-src goes on with ${JSON.stringify(rest)} instead of the hub`);
      at = data.indexOf(`${CSP_BASE} `, at + 1);
    }
  }
  return [...new Set(problems)];
}

function fail(lines: string[]): never {
  console.error(['', 'Enterprise build refused:', ...lines.map((l) => `  - ${l}`), '', 'See src-tauri/SIGNING.md.', ''].join('\n'));
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const checked = checkEnv(process.env);
  if ('errors' in checked) fail(checked.errors);
  const { plan } = checked;

  const outDir = join(TAURI_DIR, 'target', 'enterprise-build');
  mkdirSync(outDir, { recursive: true });
  const overridePath = join(outDir, 'tauri.override.json');
  writeFileSync(overridePath, `${JSON.stringify(makeOverride(plan), null, 2)}\n`);

  if (!plan.signingIdentity && !plan.certificateFromEnv) {
    console.warn('\nNote: neither APPLE_SIGNING_IDENTITY nor APPLE_CERTIFICATE is set, so the app will be unsigned. Fine for a test, not for MDM.\n');
  }
  const tauri = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
  const run = spawnSync(tauri, ['build', '--config', overridePath, ...args], {
    cwd: ROOT,
    env: buildEnv(process.env, plan),
    stdio: 'inherit',
  });
  if (run.status !== 0) fail([`tauri build failed (exit ${run.status ?? run.signal})`]);

  const target = targetOf(args);
  const bundleDir = join(TAURI_DIR, 'target', ...(target ? [target] : []), 'release', 'bundle', 'macos');
  const apps = existsSync(bundleDir) ? readdirSync(bundleDir).filter((f) => f.endsWith('.app')) : [];
  if (apps.length !== 1) fail([`expected one .app in ${relative(ROOT, bundleDir)}, found ${apps.length}; the CSP wasn't checked`]);
  const app = join(bundleDir, apps[0]);
  const macos = join(app, 'Contents', 'MacOS');
  const binaries = readdirSync(macos).map((name) => ({ name: `Contents/MacOS/${name}`, data: readFileSync(join(macos, name)) }));
  const problems = checkEmbeddedCsp(binaries, plan.hubOrigin);
  // The frontend (and with it the hub address) is compressed inside the binary; check the build output instead.
  const assets = join(ROOT, 'dist', 'assets');
  const js = existsSync(assets) ? readdirSync(assets).filter((f) => f.endsWith('.js')) : [];
  if (!js.some((f) => readFileSync(join(assets, f), 'utf8').includes(plan.serverUrl))) {
    problems.push(`the hub address ${plan.serverUrl} isn't in dist/assets: was the frontend built with it?`);
  }
  if (problems.length) fail(['The built app is NOT pinned as intended; don’t ship it:', ...problems]);

  console.log(
    [
      '',
      'Enterprise build done. Pinned:',
      `  Hub (locked, VITE_LOCK_SERVER=1)  ${plan.serverUrl}`,
      `  CSP connect-src (csp + devCsp)    ${connectSrc(plan.hubOrigin)}   ✓ checked in the binary`,
      `  Meeting links only on             https://${plan.meetingHost}/…`,
      '  Shared access token               none (people enter their own)',
      `  Signing                           ${plan.signingIdentity ?? (plan.certificateFromEnv ? 'from APPLE_CERTIFICATE' : 'UNSIGNED')}`,
      `  Config override                   ${relative(ROOT, overridePath)}`,
      `  App                               ${relative(ROOT, app)}`,
      '',
      'Next: check the signature and notarization (SIGNING.md step 3), then package for MDM.',
      '',
    ].join('\n'),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
