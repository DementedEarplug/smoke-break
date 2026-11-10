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
//
// `--check <path/to/Smoke Break.app>` builds nothing: it verifies an app that
// is already built (the last step before handing it to MDM) and prints a
// pass/fail table, exiting non-zero if anything failed:
//
//   npm run desktop:build:enterprise -- --check "src-tauri/target/…/Smoke Break.app"
//
// It reads the build record the app carries (`src-tauri/build.rs`: hub, server
// lock, whether a shared token was set, meeting host), the CSP compiled into
// the executable, and asks `codesign`, `spctl` and `stapler` about the
// signature. VITE_SERVER_URL / SMOKE_BREAK_MEETING_HOST, if set, must match
// what the app was built with. `--allow-unsigned` turns a missing signature
// into a warning (for a test build only).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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

// ── Checking a built app ────────────────────────────────────────────────────

/** What `src-tauri/build.rs` recorded about the build, embedded in the executable. */
export interface BuildRecord {
  server: string;
  lock: string;
  token: string;
  meetingHost: string;
}

const RECORD_START = 'smoke-break-build-info:v1 ';
const RECORD_END = ' :end';

/** The build record in the app's executables: exactly one, the same in all of them. */
export function readBuildRecord(binaries: { name: string; data: Buffer }[]): { record: BuildRecord } | { error: string } {
  const found = new Set<string>();
  for (const { data } of binaries) {
    let at = data.indexOf(RECORD_START);
    while (at >= 0) {
      const end = data.indexOf(RECORD_END, at);
      // Records are short; anything longer isn't one.
      if (end < 0 || end - at > 2048) break;
      found.add(data.subarray(at + RECORD_START.length, end).toString('latin1'));
      at = data.indexOf(RECORD_START, end);
    }
  }
  if (found.size === 0) return { error: 'no build record in the executable: built from older sources? Rebuild it' };
  if (found.size > 1) return { error: `${found.size} different build records in the app` };
  const fields = new Map<string, string>();
  for (const part of [...found][0].split(' ')) {
    const eq = part.indexOf('=');
    if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const get = (k: string) => fields.get(k);
  const server = get('server');
  const lock = get('lock');
  const token = get('token');
  const meetingHost = get('meeting-host');
  if (server === undefined || lock === undefined || token === undefined || meetingHost === undefined) {
    return { error: `the build record is incomplete: ${JSON.stringify([...found][0])}` };
  }
  return { record: { server, lock, token, meetingHost } };
}

/** A command's combined output and exit status (null: it couldn't be run). */
export interface ToolResult {
  status: number | null;
  output: string;
}

export interface SignatureInfo {
  signed: boolean;
  adhoc: boolean;
  hardenedRuntime: boolean;
  authority: string | null;
  teamId: string | null;
  /** `Notarization Ticket=stapled`. */
  stapled: boolean;
}

/** Reads `codesign -dv --verbose=4 <app>` (it prints to stderr). */
export function parseCodesignDisplay(r: ToolResult): SignatureInfo {
  const out = r.output;
  const signed = r.status === 0 && !/not signed at all/.test(out);
  const flags = /CodeDirectory[^\n]*flags=0x[0-9a-f]+\(([^)]*)\)/.exec(out)?.[1] ?? '';
  const teamId = /^TeamIdentifier=(.+)$/m.exec(out)?.[1]?.trim() ?? null;
  return {
    signed,
    adhoc: signed && (/^Signature=adhoc$/m.test(out) || flags.split(',').includes('adhoc')),
    hardenedRuntime: signed && flags.split(',').includes('runtime'),
    authority: /^Authority=(.+)$/m.exec(out)?.[1]?.trim() ?? null,
    teamId: teamId && teamId !== 'not set' ? teamId : null,
    stapled: signed && /^Notarization Ticket=stapled$/m.test(out),
  };
}

/**
 * Reads `spctl --assess --type execute --verbose <app>`. With Gatekeeper
 * turned off on this Mac (`override=security disabled`) it accepts anything,
 * so its verdict says nothing about the app.
 */
export function parseSpctl(r: ToolResult): { accepted: boolean; source: string | null; gatekeeperOff: boolean } {
  return {
    accepted: r.status === 0 && /: accepted$/m.test(r.output),
    source: /^source=(.+)$/m.exec(r.output)?.[1]?.trim() ?? null,
    gatekeeperOff: /^override=security disabled$/m.test(r.output),
  };
}

/** Everything `checkApp` decides on, gathered by `gatherFacts` (or a test). */
export interface AppFacts {
  binaries: { name: string; data: Buffer }[];
  codesignDisplay: ToolResult;
  codesignVerify: ToolResult;
  /** Only asked for an app signed with a real identity. */
  spctl: ToolResult | null;
  stapler: ToolResult | null;
}

export interface Expected {
  /** The hub the app must be locked to; by default whatever it was built with. */
  serverUrl?: string;
  meetingHost?: string;
  allowUnsigned?: boolean;
}

export type Verdict = 'pass' | 'fail' | 'warn' | 'skip';
export interface Row {
  check: string;
  verdict: Verdict;
  detail: string;
}

/** The pass/fail table for a built app. Any `fail` means: don't ship it. */
export function checkApp(facts: AppFacts, expected: Expected = {}): Row[] {
  const rows: Row[] = [];
  const row = (check: string, verdict: Verdict, detail: string) => rows.push({ check, verdict, detail });

  const r = readBuildRecord(facts.binaries);
  const record = 'record' in r ? r.record : null;
  row('Build record', record ? 'pass' : 'fail', record ? 'found in the executable' : (r as { error: string }).error);

  // The hub: as built, and (if given) as expected.
  let hubOrigin: string | null = null;
  if (record) {
    const built = record.server ? checkHubUrl(record.server) : { error: 'none set (VITE_SERVER_URL was empty)' };
    if ('error' in built) {
      row('Hub address', 'fail', `built with ${JSON.stringify(record.server)}: ${built.error}`);
    } else if (expected.serverUrl && expected.serverUrl !== built.url) {
      row('Hub address', 'fail', `built for ${built.url}, expected ${expected.serverUrl}`);
    } else {
      hubOrigin = built.origin;
      row('Hub address', 'pass', built.url);
    }
    row('Server lock', record.lock === 'on' ? 'pass' : 'fail', record.lock === 'on' ? 'on: the Server field is hidden' : 'off: built without VITE_LOCK_SERVER=1');
    row(
      'Shared access token',
      record.token === 'none' ? 'pass' : 'fail',
      record.token === 'none' ? 'none (VITE_HUB_TOKEN was empty)' : 'VITE_HUB_TOKEN was set: anyone with the app can extract it',
    );
    const host = record.meetingHost;
    if (!host) row('Meeting host pinned', 'fail', 'not pinned: built without SMOKE_BREAK_MEETING_HOST');
    else if (!isMeetingHost(host)) row('Meeting host pinned', 'fail', `${JSON.stringify(host)} isn't a Zoom host`);
    else if (expected.meetingHost && expected.meetingHost !== host) row('Meeting host pinned', 'fail', `pinned to ${host}, expected ${expected.meetingHost}`);
    else if (!facts.binaries.some((b) => b.data.includes(host))) row('Meeting host pinned', 'fail', `${host} isn't in the executable`);
    else row('Meeting host pinned', 'pass', host);
  }

  if (hubOrigin) {
    const problems = checkEmbeddedCsp(facts.binaries, hubOrigin);
    row('CSP connect-src', problems.length ? 'fail' : 'pass', problems.length ? problems.join('; ') : `only ${connectSrc(hubOrigin)}`);
  } else {
    row('CSP connect-src', 'fail', 'not checked: no usable hub address to check it against');
  }

  // The signature.
  const sig = parseCodesignDisplay(facts.codesignDisplay);
  const unsigned = facts.codesignDisplay.status === null ? 'codesign could not be run' : sig.adhoc ? 'ad-hoc signed only' : 'not signed';
  if (!sig.signed || sig.adhoc) {
    row('Signed', expected.allowUnsigned ? 'warn' : 'fail', `${unsigned}: not for MDM (sign with your Developer ID)`);
  } else {
    row('Signed', 'pass', [sig.authority, sig.teamId && `team ${sig.teamId}`].filter(Boolean).join(', ') || 'signed');
  }
  if (!sig.signed || sig.adhoc) {
    // Nothing a Developer ID signature would give is there to check.
    for (const check of ['codesign --verify --deep --strict', 'Hardened runtime', 'Notarization']) row(check, 'skip', unsigned);
    return rows;
  }
  const verified = facts.codesignVerify.status === 0;
  const firstLine = facts.codesignVerify.output.trim().split('\n').find((l) => l.trim()) ?? '';
  row('codesign --verify --deep --strict', verified ? 'pass' : 'fail', verified ? 'valid on disk, all nested code too' : firstLine || 'failed');
  row('Hardened runtime', sig.hardenedRuntime ? 'pass' : 'fail', sig.hardenedRuntime ? 'flags include runtime' : 'flags lack runtime (required for notarization)');
  const stapled = facts.stapler?.status === 0 || sig.stapled;
  const assessed = facts.spctl ? parseSpctl(facts.spctl) : null;
  const notarized = stapled || (!!assessed?.source?.includes('Notarized') && !assessed.source.includes('Unnotarized'));
  if (!notarized) {
    row('Notarization', 'warn', 'not notarized (no stapled ticket): Gatekeeper may refuse it outside MDM');
  } else if (assessed?.gatekeeperOff) {
    row('Notarization', 'fail', 'Gatekeeper is turned off on this Mac (spctl: override=security disabled), so spctl’s verdict means nothing: run --check on a Mac with Gatekeeper on');
  } else if (assessed?.accepted) {
    row('Notarization', 'pass', `spctl: accepted, ${assessed.source ?? 'no source given'}${stapled ? '; ticket stapled' : ''}`);
  } else {
    row('Notarization', 'fail', `notarized${stapled ? ' (ticket stapled)' : ''} but spctl did not accept it: ${facts.spctl?.output.trim() || 'no output'}`);
  }
  return rows;
}

const MARK: Record<Verdict, string> = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP' };

export function formatTable(rows: Row[]): string {
  const width = Math.max(...rows.map((r) => r.check.length));
  return rows.map((r) => `  ${MARK[r.verdict]}  ${r.check.padEnd(width)}  ${r.detail}`).join('\n');
}

export const failed = (rows: Row[]) => rows.some((r) => r.verdict === 'fail');

function runTool(cmd: string, args: string[]): ToolResult {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) return { status: null, output: String(r.error.message) };
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Reads the app's executables and asks the system tools about its signature. Changes nothing. */
export function gatherFacts(app: string): AppFacts {
  const macos = join(app, 'Contents', 'MacOS');
  const binaries = existsSync(macos)
    ? readdirSync(macos)
        .filter((name) => statSync(join(macos, name)).isFile())
        .map((name) => ({ name: `Contents/MacOS/${name}`, data: readFileSync(join(macos, name)) }))
    : [];
  const codesignDisplay = runTool('codesign', ['-dv', '--verbose=4', app]);
  const sig = parseCodesignDisplay(codesignDisplay);
  const realSignature = sig.signed && !sig.adhoc;
  return {
    binaries,
    codesignDisplay,
    codesignVerify: realSignature ? runTool('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]) : { status: null, output: '' },
    spctl: realSignature ? runTool('spctl', ['--assess', '--type', 'execute', '--verbose', app]) : null,
    stapler: realSignature ? runTool('xcrun', ['stapler', 'validate', app]) : null,
  };
}

/** `--check <app>` and `--allow-unsigned`, or null when building. */
export function checkArgs(args: string[]): { app: string; allowUnsigned: boolean } | { error: string } | null {
  const i = args.indexOf('--check');
  if (i < 0) return null;
  const app = args[i + 1];
  if (!app || app.startsWith('--')) return { error: '--check needs the path to the built .app' };
  const rest = args.filter((a, j) => j !== i && j !== i + 1);
  const unknown = rest.filter((a) => a !== '--allow-unsigned');
  if (unknown.length) return { error: `--check takes no other arguments than --allow-unsigned, not ${unknown.join(' ')}` };
  return { app, allowUnsigned: rest.includes('--allow-unsigned') };
}

function fail(lines: string[]): never {
  console.error(['', 'Enterprise build refused:', ...lines.map((l) => `  - ${l}`), '', 'See src-tauri/SIGNING.md.', ''].join('\n'));
  process.exit(1);
}

/** `--check`: verify an already-built app; exits non-zero if anything failed. */
function checkMain(app: string, allowUnsigned: boolean) {
  if (!app.endsWith('.app') || !existsSync(join(app, 'Contents', 'MacOS'))) fail([`${app} isn't a built .app`]);
  const expected: Expected = { allowUnsigned };
  const errors: string[] = [];
  const server = (process.env.VITE_SERVER_URL ?? '').trim();
  if (server) {
    const r = checkHubUrl(server);
    if ('error' in r) errors.push(`VITE_SERVER_URL ${r.error}`);
    else expected.serverUrl = r.url;
  }
  const host = (process.env.SMOKE_BREAK_MEETING_HOST ?? '').trim();
  if (host) expected.meetingHost = host;
  if (errors.length) fail(errors);
  const rows = checkApp(gatherFacts(app), expected);
  const bad = failed(rows);
  console.log(['', `Checked ${app}:`, formatTable(rows), ''].join('\n'));
  if (bad) {
    console.error('Something above FAILED: don’t ship this app. See src-tauri/SIGNING.md.\n');
    process.exit(1);
  }
  const warned = rows.some((r) => r.verdict === 'warn');
  console.log(`${warned ? 'No check failed; read the WARN lines before you ship.' : 'All checks passed.'} Package it for MDM (SIGNING.md, section 4).\n`);
}

function main() {
  const args = process.argv.slice(2);
  const check = checkArgs(args);
  if (check && 'error' in check) fail([check.error]);
  if (check) return checkMain(check.app, check.allowUnsigned);
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
  // The same checks as `--check`, against what was asked for.
  const unsigned = !plan.signingIdentity && !plan.certificateFromEnv;
  const rows = checkApp(gatherFacts(app), { serverUrl: plan.serverUrl, meetingHost: plan.meetingHost, allowUnsigned: unsigned });
  // The frontend (and with it the hub address) is compressed inside the binary; check the build output too.
  const assets = join(ROOT, 'dist', 'assets');
  const js = existsSync(assets) ? readdirSync(assets).filter((f) => f.endsWith('.js')) : [];
  const inFrontend = js.some((f) => readFileSync(join(assets, f), 'utf8').includes(plan.serverUrl));
  rows.push({
    check: 'Frontend built for the hub',
    verdict: inFrontend ? 'pass' : 'fail',
    detail: inFrontend ? `${plan.serverUrl} in dist/assets` : `${plan.serverUrl} isn't in dist/assets: was the frontend built with it?`,
  });
  console.log(['', 'Checks on the built app:', formatTable(rows), ''].join('\n'));
  if (failed(rows)) fail(['The built app is NOT what was asked for; don’t ship it (see the FAIL lines above).']);

  console.log(
    [
      '',
      'Enterprise build done. Pinned:',
      `  Hub (locked, VITE_LOCK_SERVER=1)  ${plan.serverUrl}`,
      `  CSP connect-src (csp + devCsp)    ${connectSrc(plan.hubOrigin)}`,
      `  Meeting links only on             https://${plan.meetingHost}/…`,
      '  Shared access token               none (people enter their own)',
      `  Signing                           ${plan.signingIdentity ?? (plan.certificateFromEnv ? 'from APPLE_CERTIFICATE' : 'UNSIGNED')}`,
      `  Config override                   ${relative(ROOT, overridePath)}`,
      `  App                               ${relative(ROOT, app)}`,
      '',
      'Next: package it for MDM, and run the checks once more on what you hand over:',
      `  npm run desktop:build:enterprise -- --check "${relative(ROOT, app)}"`,
      '',
    ].join('\n'),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
