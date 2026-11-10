import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type AppFacts,
  CSP_BASE,
  type Row,
  buildEnv,
  checkApp,
  checkArgs,
  checkEmbeddedCsp,
  checkEnv,
  checkHubUrl,
  connectSrc,
  connectSrcDirectives,
  cspDirectives,
  failed,
  formatTable,
  inCodeOutsideRecord,
  isMeetingHost,
  makeOverride,
  parseCodesignDisplay,
  parseSpctl,
  pinnedPolicy,
  readBuildRecord,
  readLockMarker,
  targetOf,
} from './enterprise-build.ts';
import * as fx from './fixtures/check-app.ts';

const GOOD = { VITE_SERVER_URL: 'wss://breaks.acme.internal/ws', SMOKE_BREAK_MEETING_HOST: 'acme.zoom.us' };

const planOf = (env: Record<string, string | undefined>) => {
  const r = checkEnv(env);
  if ('errors' in r) throw new Error(r.errors.join('\n'));
  return r.plan;
};
const errorsOf = (env: Record<string, string | undefined>) => {
  const r = checkEnv(env);
  return 'errors' in r ? r.errors : [];
};

describe('checkEnv', () => {
  it('accepts a wss hub and a Zoom host', () => {
    expect(planOf(GOOD)).toEqual({
      serverUrl: 'wss://breaks.acme.internal/ws',
      hubOrigin: 'wss://breaks.acme.internal',
      meetingHost: 'acme.zoom.us',
      signingIdentity: null,
      certificateFromEnv: false,
    });
  });

  it('refuses without the hub address or the meeting host, saying what to set', () => {
    const errors = errorsOf({});
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/Set VITE_SERVER_URL/);
    expect(errors[1]).toMatch(/Set SMOKE_BREAK_MEETING_HOST/);
    expect(errorsOf({ ...GOOD, VITE_SERVER_URL: '  ' })[0]).toMatch(/Set VITE_SERVER_URL/);
  });

  it.each([
    ['ws://breaks.acme.internal/ws', /wss:\/\//],
    ['https://breaks.acme.internal/ws', /wss:\/\//],
    ['breaks.acme.internal', /isn't an address/],
    ['wss://user:pw@breaks.acme.internal/ws', /plain/],
    ['wss://[::1]:8443/ws', /host name/],
    ['wss://*.acme.internal/ws', /host name/],
  ])('refuses VITE_SERVER_URL=%s', (url, why) => {
    const errors = errorsOf({ ...GOOD, VITE_SERVER_URL: url });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(why);
  });

  it.each(['zoom.us.evil.example', 'evilzoom.us', 'Acme.Zoom.us', '.zoom.us', 'acme..zoom.us', 'acme.zoom.us/x', 'example.com'])(
    'refuses SMOKE_BREAK_MEETING_HOST=%s',
    (host) => {
      expect(errorsOf({ ...GOOD, SMOKE_BREAK_MEETING_HOST: host })[0]).toMatch(/must be a Zoom host/);
    },
  );

  it('refuses a shared access token', () => {
    const errors = errorsOf({ ...GOOD, VITE_HUB_TOKEN: 'shared-secret' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Unset VITE_HUB_TOKEN/);
    // Only the problem is named, never the token itself.
    expect(errors[0]).not.toContain('shared-secret');
    expect(errorsOf({ ...GOOD, VITE_HUB_TOKEN: '' })).toEqual([]);
  });

  it('refuses an explicit VITE_LOCK_SERVER=0', () => {
    expect(errorsOf({ ...GOOD, VITE_LOCK_SERVER: '0' })[0]).toMatch(/unlocked/);
    expect(errorsOf({ ...GOOD, VITE_LOCK_SERVER: '1' })).toEqual([]);
  });

  it('passes the signing identity through', () => {
    const plan = planOf({ ...GOOD, APPLE_SIGNING_IDENTITY: 'Developer ID Application: Acme Inc (TEAMID1234)' });
    expect(plan.signingIdentity).toBe('Developer ID Application: Acme Inc (TEAMID1234)');
    expect(planOf({ ...GOOD, APPLE_CERTIFICATE: 'base64…' }).certificateFromEnv).toBe(true);
  });
});

describe('checkHubUrl', () => {
  it('keeps a non-default port in the origin and drops the default one', () => {
    expect(checkHubUrl('wss://hub.example:8443/ws')).toEqual({ url: 'wss://hub.example:8443/ws', origin: 'wss://hub.example:8443' });
    expect(checkHubUrl('WSS://Hub.Example:443/ws#x')).toEqual({ url: 'wss://hub.example/ws', origin: 'wss://hub.example' });
  });
});

describe('isMeetingHost', () => {
  it('matches the Rust rule', () => {
    expect(isMeetingHost('zoom.us')).toBe(true);
    expect(isMeetingHost('acme.zoom.us')).toBe(true);
    expect(isMeetingHost('acme.zoomgov.com')).toBe(true);
    expect(isMeetingHost('notzoom.us')).toBe(false);
  });
});

const CONF = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));

describe('makeOverride', () => {
  const override = (env = GOOD) =>
    makeOverride(planOf(env), CONF.app.security) as { app: { security: Record<string, string> }; bundle?: { macOS: { signingIdentity: string } } };

  it('pins connect-src to exactly the hub in both CSPs, each one policy string with connect-src first', () => {
    const o = override();
    const pinned = "connect-src 'self' ipc: http://ipc.localhost wss://breaks.acme.internal; ";
    expect(o.app.security.csp.startsWith(pinned)).toBe(true);
    expect(o.app.security.devCsp.startsWith(pinned)).toBe(true);
    expect(JSON.stringify(o)).not.toMatch(/wss: |wss:;|localhost:\*|127\.0\.0\.1/);
    expect(o.bundle).toBeUndefined();
    // What --check reads in the binary.
    for (const policy of [o.app.security.csp, o.app.security.devCsp]) {
      expect(checkEmbeddedCsp([{ name: 'x', data: Buffer.from(`\0${policy}\0`) }], 'wss://breaks.acme.internal')).toEqual([]);
    }
  });

  it('keeps the rest of each CSP from tauri.conf.json, whose connect-src it replaces', () => {
    const o = override();
    for (const key of ['csp', 'devCsp']) {
      // The base is what the app's own connect-src starts with, so nothing it needs is lost.
      expect(CONF.app.security[key]['connect-src'].startsWith(`${CSP_BASE} wss:`)).toBe(true);
      const want = cspDirectives(CONF.app.security[key]);
      want.set('connect-src', [...CSP_BASE.split(' '), 'wss://breaks.acme.internal']);
      expect(cspDirectives(o.app.security[key])).toEqual(want);
    }
    expect(o.app.security.devCsp).toMatch(/style-src 'self' 'unsafe-inline'/);
    expect(o.app.security.csp).not.toMatch(/unsafe-inline/);
  });

  it('takes a policy string as the base too, and refuses one with nothing but connect-src', () => {
    expect(pinnedPolicy("default-src 'self'; connect-src *; img-src data:", 'wss://h.example')).toBe(
      "connect-src 'self' ipc: http://ipc.localhost wss://h.example; default-src 'self'; img-src data:",
    );
    expect(() => pinnedPolicy({ 'connect-src': '*' }, 'wss://h.example')).toThrow(/no CSP/);
    expect(() => pinnedPolicy(null, 'wss://h.example')).toThrow(/no CSP/);
  });

  it('names the signing identity when there is one', () => {
    const o = makeOverride(planOf({ ...GOOD, APPLE_SIGNING_IDENTITY: 'Developer ID Application: Acme' }), CONF.app.security) as {
      bundle: { macOS: { signingIdentity: string } };
    };
    expect(o.bundle.macOS.signingIdentity).toBe('Developer ID Application: Acme');
  });
});

describe('buildEnv', () => {
  it('locks the server and clears any shared token', () => {
    const env = buildEnv({ PATH: '/bin', ...GOOD, VITE_SERVER_URL: 'wss://Breaks.acme.internal:443/ws' }, planOf(GOOD));
    expect(env).toMatchObject({
      PATH: '/bin',
      VITE_SERVER_URL: 'wss://breaks.acme.internal/ws',
      VITE_LOCK_SERVER: '1',
      SMOKE_BREAK_MEETING_HOST: 'acme.zoom.us',
      VITE_HUB_TOKEN: '',
    });
  });
});

describe('targetOf', () => {
  it('finds the target in the tauri build arguments', () => {
    expect(targetOf([])).toBeNull();
    expect(targetOf(['--target', 'universal-apple-darwin'])).toBe('universal-apple-darwin');
    expect(targetOf(['--verbose', '--target=aarch64-apple-darwin'])).toBe('aarch64-apple-darwin');
    expect(targetOf(['-t', 'x86_64-apple-darwin'])).toBe('x86_64-apple-darwin');
  });
});

describe('checkEmbeddedCsp', () => {
  const origin = 'wss://breaks.acme.internal';
  const bin = (...strings: string[]) => [{ name: 'smoke-break', data: Buffer.from(`\x7fELF…${strings.join('')}…more`) }];
  const DEFAULT = "'self' ipc: http://ipc.localhost wss: ws://localhost:* ws://127.0.0.1:* ws://[::1]:*";
  /** A policy string as Tauri compiles it: one string literal, packed against others. */
  const policy = (sources: string) => `connect-src ${sources}; default-src 'self'; object-src 'none'`;

  it('accepts a binary whose every connect-src is exactly the app and the hub, in any order', () => {
    expect(checkEmbeddedCsp(bin(policy(connectSrc(origin)), 'object-src', policy(connectSrc(origin))), origin)).toEqual([]);
    expect(checkEmbeddedCsp(bin(`default-src 'self'; connect-src  ${origin} http://ipc.localhost 'self'\tipc:; img-src data:`), origin)).toEqual([]);
  });

  // The reviewers' cases: each one starts with the pinned sources and goes on.
  it.each([
    [`${connectSrc(origin)} wss:`, 'wss:'],
    [`${connectSrc(origin)} https://x wss://*`, 'https://x wss://*'],
    [`'self' ipc: http://ipc.localhost wss://breaks.acme.internal.attacker.example`, 'wss://breaks.acme.internal.attacker.example'],
    [`${connectSrc(origin)} *`, '*'],
  ])('refuses connect-src %s', (sources, extra) => {
    const problems = checkEmbeddedCsp(bin(policy(sources)), origin);
    expect(problems).toContain(`smoke-break: a connect-src also allows ${extra}`);
    // And as the reviewers built it: a JSON-ish string, not a complete directive.
    expect(checkEmbeddedCsp(bin(`xx"connect-src":"${sources}"yy`), origin).length).toBeGreaterThan(0);
  });

  it('refuses a connect-src that lacks the hub, or is pinned to another one', () => {
    expect(checkEmbeddedCsp(bin(policy(CSP_BASE)), origin)).toEqual([`smoke-break: a connect-src lacks ${origin}`]);
    expect(checkEmbeddedCsp(bin(policy(connectSrc('wss://other.example'))), origin)).toEqual([
      'smoke-break: a connect-src also allows wss://other.example',
      `smoke-break: a connect-src lacks ${origin}`,
    ]);
  });

  it('refuses a connect-src whose end can’t be told, whatever follows it', () => {
    // Last in a policy, or a directive map's name and value as separate strings.
    for (const packed of [`default-src 'self'; connect-src ${connectSrc(origin)}`, `connect-src${connectSrc(origin)}default-src'self'`]) {
      const problems = checkEmbeddedCsp(bin(packed), origin);
      expect(problems.some((p) => /isn't a complete directive/.test(p))).toBe(true);
    }
    // Upper case is still connect-src.
    expect(checkEmbeddedCsp(bin(policy(connectSrc(origin)), 'CONNECT-SRC *'), origin).some((p) => /isn't a complete directive/.test(p))).toBe(true);
  });

  it('refuses the default, wide CSP', () => {
    const problems = checkEmbeddedCsp(bin('connect-src', DEFAULT, "default-src'self'"), origin);
    expect(problems.some((p) => /isn't a complete directive/.test(p))).toBe(true);
    expect(problems.some((p) => /ws:\/\/localhost:\*/.test(p))).toBe(true);
    expect(problems.some((p) => /sources outside any complete directive/.test(p))).toBe(true);
  });

  it('refuses a binary with the pinned CSP and a wide one left over (e.g. devCsp)', () => {
    expect(checkEmbeddedCsp(bin(policy(connectSrc(origin)), DEFAULT), origin)).not.toEqual([]);
    expect(checkEmbeddedCsp(bin(policy(connectSrc(origin)), `${CSP_BASE} wss:`), origin)).toEqual([
      `smoke-break: connect-src sources outside any complete directive: "${CSP_BASE} wss:...more"`,
    ]);
  });

  it('refuses a binary without any connect-src', () => {
    expect(checkEmbeddedCsp(bin("default-src 'self';"), origin)).toEqual([`smoke-break: no connect-src in it (the pinned one is ${connectSrc(origin)})`]);
  });

  it('refuses an empty bundle', () => expect(checkEmbeddedCsp([], origin)).toEqual(['no executable found in the app bundle']));

  it('reads each connect-src up to its own ;', () => {
    const found = connectSrcDirectives(`..connect-src a b;c connect-src\x00d;`);
    expect(found.map((d) => d.sources)).toEqual([['a', 'b'], null]);
  });
});

// ── --check ──────────────────────────────────────────────────────────────────

const HUB = 'wss://breaks.acme.internal/ws';
const ORIGIN = 'wss://breaks.acme.internal';
const DEFAULT_CSP = "'self' ipc: http://ipc.localhost wss: ws://localhost:* ws://127.0.0.1:* ws://[::1]:*";
const record = (fields: string) => `smoke-break-build-info:v1 ${fields} :end`;
const GOOD_RECORD = record(`server=${HUB} lock=on token=none meeting-host=acme.zoom.us`);
/** The hub lock src-tauri/src/lock.rs obeys, as build.rs compiles it in. */
const lockMarker = (state: string, hub: string) => `sb-lock:v1:${state}:${hub} :end`;
const LOCK = lockMarker('on', HUB);
/** The pinned CSP as the enterprise build writes it (one policy string). */
const POLICY = (origin = ORIGIN) => `connect-src ${connectSrc(origin)}; default-src 'self'; object-src 'none'`;
/** An executable as the linker lays it out: string literals back to back, among other bytes. */
const exe = (...strings: string[]) => [{ name: 'Contents/MacOS/smoke-break', data: Buffer.from(`\xcf\xfa\xed\xfe…${strings.join('')}…`, 'latin1') }];
const GOOD_EXE = () => exe(POLICY(), "object-src'none'", POLICY(), 'acme.zoom.us', LOCK, GOOD_RECORD);
const ok = (output: string) => ({ status: 0, output });

/** A notarized Developer ID build of the right config; each test changes one thing. */
const goodFacts = (): AppFacts => ({
  binaries: GOOD_EXE(),
  codesignDisplay: ok(fx.CODESIGN_DEVELOPER_ID),
  codesignVerify: ok(fx.VERIFY_OK),
  spctl: ok(fx.SPCTL_NOTARIZED),
  stapler: ok(fx.STAPLER_OK),
});
const verdicts = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.check, r.verdict]));

describe('readBuildRecord', () => {
  it('reads the record build.rs embeds', () => {
    expect(readBuildRecord(GOOD_EXE())).toEqual({ record: { server: HUB, lock: 'on', token: 'none', meetingHost: 'acme.zoom.us' } });
  });

  it('refuses none, several different, or an incomplete one', () => {
    expect(readBuildRecord(exe('nothing here'))).toMatchObject({ error: expect.stringMatching(/no build record/) });
    expect(readBuildRecord(exe(GOOD_RECORD, record('server= lock=off token=none meeting-host=')))).toMatchObject({
      error: expect.stringMatching(/2 different/),
    });
    expect(readBuildRecord(exe(record('server=x')))).toMatchObject({ error: expect.stringMatching(/incomplete/) });
    // The same record twice (e.g. a universal binary's two slices) is fine.
    expect(readBuildRecord(exe(GOOD_RECORD, GOOD_RECORD))).toHaveProperty('record');
  });
});

describe('parseCodesignDisplay', () => {
  it('reads a Developer ID signature with the hardened runtime', () => {
    expect(parseCodesignDisplay(ok(fx.CODESIGN_DEVELOPER_ID))).toEqual({
      signed: true,
      adhoc: false,
      hardenedRuntime: true,
      authority: 'Developer ID Application: Acme Inc (TEAMID1234)',
      teamId: 'TEAMID1234',
      stapled: true,
    });
    expect(parseCodesignDisplay(ok(fx.CODESIGN_NO_RUNTIME))).toMatchObject({ signed: true, hardenedRuntime: false, stapled: false });
  });

  it('tells ad-hoc and unsigned apart from signed', () => {
    expect(parseCodesignDisplay(ok(fx.CODESIGN_ADHOC))).toMatchObject({ signed: true, adhoc: true, hardenedRuntime: false, teamId: null });
    expect(parseCodesignDisplay({ status: 1, output: fx.CODESIGN_UNSIGNED })).toMatchObject({ signed: false, adhoc: false });
    expect(parseCodesignDisplay({ status: null, output: 'spawnSync codesign ENOENT' }).signed).toBe(false);
  });
});

describe('parseSpctl', () => {
  it('reads accepted, rejected, and a Mac with Gatekeeper off', () => {
    expect(parseSpctl(ok(fx.SPCTL_NOTARIZED))).toEqual({ accepted: true, source: 'Notarized Developer ID', gatekeeperOff: false });
    expect(parseSpctl({ status: 3, output: fx.SPCTL_REJECTED })).toEqual({ accepted: false, source: 'Unnotarized Developer ID', gatekeeperOff: false });
    expect(parseSpctl(ok(fx.SPCTL_GATEKEEPER_OFF)).gatekeeperOff).toBe(true);
  });
});

describe('checkApp', () => {
  it('passes a notarized Developer ID build of the right config', () => {
    const rows = checkApp(goodFacts(), { serverUrl: HUB, meetingHost: 'acme.zoom.us' });
    expect(rows.filter((r) => r.verdict !== 'pass')).toEqual([]);
    expect(failed(rows)).toBe(false);
    expect(Object.keys(verdicts(rows))).toEqual([
      'Build record',
      'Hub address',
      'Server lock',
      'Shared access token',
      'Meeting host pinned',
      'CSP connect-src',
      'Signed',
      'codesign --verify --deep --strict',
      'Hardened runtime',
      'Notarization',
    ]);
  });

  it('checks against what the app was built with when nothing is expected', () => {
    expect(failed(checkApp(goodFacts()))).toBe(false);
  });

  it.each([
    ['unlocked', record(`server=${HUB} lock=off token=none meeting-host=acme.zoom.us`), 'Server lock'],
    ['a shared token', record(`server=${HUB} lock=on token=set meeting-host=acme.zoom.us`), 'Shared access token'],
    ['no meeting host', record(`server=${HUB} lock=on token=none meeting-host=`), 'Meeting host pinned'],
    ['a non-Zoom meeting host', record(`server=${HUB} lock=on token=none meeting-host=evil.example`), 'Meeting host pinned'],
    ['no hub', record('server= lock=on token=none meeting-host=acme.zoom.us'), 'Hub address'],
    ['a plain ws hub', record('server=ws://breaks.acme.internal/ws lock=on token=none meeting-host=acme.zoom.us'), 'Hub address'],
  ])('fails an app built %s', (_what, rec, check) => {
    const facts = { ...goodFacts(), binaries: exe(POLICY(), 'acme.zoom.us', 'evil.example', LOCK, rec) };
    const rows = checkApp(facts);
    expect(verdicts(rows)[check]).toBe('fail');
    expect(failed(rows)).toBe(true);
  });

  it('reads the hub lock the native code obeys', () => {
    expect(readLockMarker(GOOD_EXE())).toEqual({ lock: { on: true, hub: HUB } });
    expect(readLockMarker(exe(LOCK, LOCK))).toEqual({ lock: { on: true, hub: HUB } });
    expect(readLockMarker(exe(lockMarker('off', '')))).toEqual({ lock: { on: false, hub: '' } });
    expect(readLockMarker(exe(lockMarker('on', 'wss://h.example:8443/ws')))).toEqual({ lock: { on: true, hub: 'wss://h.example:8443/ws' } });
    expect(readLockMarker(exe('nothing'))).toMatchObject({ error: expect.stringMatching(/older sources/) });
    expect(readLockMarker(exe(LOCK, lockMarker('off', HUB)))).toMatchObject({ error: expect.stringMatching(/2 different/) });
    expect(readLockMarker(exe(lockMarker('maybe', HUB)))).toMatchObject({ error: expect.stringMatching(/unreadable/) });
  });

  it('fails a locked app whose native commands are not locked to the hub (built from older sources)', () => {
    const old = { ...goodFacts(), binaries: exe(POLICY(), 'acme.zoom.us', HUB, GOOD_RECORD) };
    const rows = checkApp(old);
    expect(verdicts(rows)['Server lock']).toBe('fail');
    expect(rows.find((r) => r.check === 'Server lock')?.detail).toMatch(/older sources/);
  });

  it('checks the native lock even when the hub has no path, so its address is in the CSP too', () => {
    // The CSP names the hub origin, which is the whole address here: finding the
    // address in the binary would prove nothing. Only the lock marker counts.
    const hub = 'wss://breaks.acme.internal';
    const rec = record(`server=${hub} lock=on token=none meeting-host=acme.zoom.us`);
    const old = { ...goodFacts(), binaries: exe(POLICY(), 'acme.zoom.us', rec) };
    expect(verdicts(checkApp(old))['Server lock']).toBe('fail');
    const unlockedNative = { ...goodFacts(), binaries: exe(POLICY(), 'acme.zoom.us', lockMarker('off', hub), rec) };
    expect(checkApp(unlockedNative).find((r) => r.check === 'Server lock')).toMatchObject({ verdict: 'fail', detail: expect.stringMatching(/unlocked/) });
    const good = { ...goodFacts(), binaries: exe(POLICY(), 'acme.zoom.us', lockMarker('on', hub), rec) };
    expect(checkApp(good).find((r) => r.check === 'Server lock')).toMatchObject({ verdict: 'pass', detail: expect.stringContaining('wss://breaks.acme.internal/ only') });
  });

  it('fails an app whose native lock is for another hub than the one it was built for', () => {
    for (const other of ['wss://other.example/ws', 'wss://breaks.acme.internal/other', '', 'ws://breaks.acme.internal/ws']) {
      const facts = { ...goodFacts(), binaries: exe(POLICY(), 'acme.zoom.us', lockMarker('on', other), GOOD_RECORD) };
      expect(verdicts(checkApp(facts))['Server lock'], other).toBe('fail');
    }
    // The same hub written differently is the same hub.
    const same = { ...goodFacts(), binaries: exe(POLICY(), 'acme.zoom.us', lockMarker('on', 'WSS://Breaks.acme.internal:443/ws'), GOOD_RECORD) };
    expect(verdicts(checkApp(same))['Server lock']).toBe('pass');
  });

  it('fails an app whose meeting host is only named in the build record', () => {
    // What a real build looks like: the record, then the pinned host among other literals.
    expect(inCodeOutsideRecord(Buffer.from(`${GOOD_RECORD}panelacme.zoom.userror`), 'acme.zoom.us')).toBe(true);
    expect(inCodeOutsideRecord(Buffer.from(`x${GOOD_RECORD}y`), 'acme.zoom.us')).toBe(false);
    expect(inCodeOutsideRecord(Buffer.from(`${GOOD_RECORD}${GOOD_RECORD}`), 'acme.zoom.us')).toBe(false);
    const recordOnly = { ...goodFacts(), binaries: exe(POLICY(), "object-src'none'", LOCK, GOOD_RECORD) };
    const rows = checkApp(recordOnly);
    expect(verdicts(rows)['Meeting host pinned']).toBe('fail');
    expect(rows.find((r) => r.check === 'Meeting host pinned')?.detail).toMatch(/only in the build record/);
  });

  it('fails an app built for another hub or meeting host than expected', () => {
    expect(verdicts(checkApp(goodFacts(), { serverUrl: 'wss://other.example/ws' }))['Hub address']).toBe('fail');
    expect(verdicts(checkApp(goodFacts(), { meetingHost: 'other.zoom.us' }))['Meeting host pinned']).toBe('fail');
  });

  it('fails a wide or missing CSP, and a missing build record', () => {
    const wide = { ...goodFacts(), binaries: exe(POLICY(), DEFAULT_CSP, 'acme.zoom.us', LOCK, GOOD_RECORD) };
    expect(verdicts(checkApp(wide))['CSP connect-src']).toBe('fail');
    const unpinned = { ...goodFacts(), binaries: exe('connect-src', DEFAULT_CSP, 'acme.zoom.us', LOCK, GOOD_RECORD) };
    expect(verdicts(checkApp(unpinned))['CSP connect-src']).toBe('fail');
    // The reviewers' wider lists that start like the pinned one.
    for (const extra of [' wss:', ' https://x wss://*', '.attacker.example']) {
      const wider = { ...goodFacts(), binaries: exe(`connect-src ${connectSrc(ORIGIN)}${extra}; default-src 'self'`, 'acme.zoom.us', LOCK, GOOD_RECORD) };
      const row = checkApp(wider).find((r) => r.check === 'CSP connect-src')!;
      expect(row.verdict, extra).toBe('fail');
      expect(row.detail).not.toMatch(/^only/);
    }
    const old = { ...goodFacts(), binaries: exe(POLICY(), 'acme.zoom.us') };
    expect(verdicts(checkApp(old))).toMatchObject({ 'Build record': 'fail', 'CSP connect-src': 'fail' });
    // Built without a hub: the CSP is still checked against the expected one, and says what's wrong.
    const plain = { ...goodFacts(), binaries: exe('connect-src', DEFAULT_CSP, record('server= lock=off token=none meeting-host=')) };
    const row = checkApp(plain, { serverUrl: HUB }).find((r) => r.check === 'CSP connect-src')!;
    expect(row.verdict).toBe('fail');
    expect(row.detail).toMatch(/still allows ws:\/\/localhost:\*/);
    // And it passes a pinned CSP against the expected hub even when the record's hub is missing.
    const noHub = { ...goodFacts(), binaries: exe(POLICY(), LOCK, record('server= lock=on token=none meeting-host=acme.zoom.us')) };
    expect(verdicts(checkApp(noHub, { serverUrl: HUB }))).toMatchObject({ 'Hub address': 'fail', 'CSP connect-src': 'pass' });
  });

  it('fails an unsigned or ad-hoc app unless asked to allow it, and skips the signature checks', () => {
    for (const codesignDisplay of [{ status: 1, output: fx.CODESIGN_UNSIGNED }, ok(fx.CODESIGN_ADHOC)]) {
      const facts = { ...goodFacts(), codesignDisplay, spctl: null, stapler: null };
      expect(verdicts(checkApp(facts)).Signed).toBe('fail');
      const allowed = checkApp(facts, { allowUnsigned: true });
      expect(verdicts(allowed)).toMatchObject({
        Signed: 'warn',
        'codesign --verify --deep --strict': 'skip',
        'Hardened runtime': 'skip',
        Notarization: 'skip',
      });
      expect(failed(allowed)).toBe(false);
    }
  });

  it('fails a signature that does not verify, or lacks the hardened runtime', () => {
    expect(verdicts(checkApp({ ...goodFacts(), codesignVerify: { status: 1, output: fx.VERIFY_MODIFIED } }))['codesign --verify --deep --strict']).toBe(
      'fail',
    );
    const noRuntime = { ...goodFacts(), codesignDisplay: ok(fx.CODESIGN_NO_RUNTIME), stapler: { status: 65, output: fx.STAPLER_NONE } };
    expect(verdicts(checkApp(noRuntime))['Hardened runtime']).toBe('fail');
  });

  it('warns about a signed app that is not notarized, and fails a notarized one spctl refuses', () => {
    const unnotarized = {
      ...goodFacts(),
      codesignDisplay: ok(fx.CODESIGN_DEVELOPER_ID.replace('Notarization Ticket=stapled\n', '')),
      spctl: { status: 3, output: fx.SPCTL_REJECTED },
      stapler: { status: 65, output: fx.STAPLER_NONE },
    };
    const rows = checkApp(unnotarized);
    expect(verdicts(rows).Notarization).toBe('warn');
    expect(failed(rows)).toBe(false);
    expect(verdicts(checkApp({ ...goodFacts(), spctl: { status: 3, output: fx.SPCTL_REJECTED } })).Notarization).toBe('fail');
  });

  it('does not trust spctl on a Mac with Gatekeeper turned off', () => {
    const rows = checkApp({ ...goodFacts(), spctl: ok(fx.SPCTL_GATEKEEPER_OFF) });
    expect(verdicts(rows).Notarization).toBe('fail');
    expect(rows.find((r) => r.check === 'Notarization')!.detail).toMatch(/Gatekeeper is turned off/);
  });
});

describe('formatTable', () => {
  it('prints one aligned line per check', () => {
    const table = formatTable([
      { check: 'Short', verdict: 'pass', detail: 'fine' },
      { check: 'A longer check', verdict: 'fail', detail: 'broken' },
    ]);
    expect(table.split('\n')).toEqual(['  PASS  Short           fine', '  FAIL  A longer check  broken']);
  });
});

describe('checkArgs', () => {
  it('finds --check and its app, and nothing else', () => {
    expect(checkArgs(['--target', 'universal-apple-darwin'])).toBeNull();
    expect(checkArgs(['--check', 'Smoke Break.app'])).toEqual({ app: 'Smoke Break.app', allowUnsigned: false });
    expect(checkArgs(['--check', 'a.app', '--allow-unsigned'])).toEqual({ app: 'a.app', allowUnsigned: true });
    expect(checkArgs(['--check'])).toMatchObject({ error: expect.any(String) });
    expect(checkArgs(['--check', '--allow-unsigned'])).toMatchObject({ error: expect.any(String) });
    expect(checkArgs(['--check', 'a.app', '--target', 'x'])).toMatchObject({ error: expect.any(String) });
  });
});
