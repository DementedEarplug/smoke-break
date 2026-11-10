import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CSP_BASE,
  buildEnv,
  checkEmbeddedCsp,
  checkEnv,
  checkHubUrl,
  connectSrc,
  isMeetingHost,
  makeOverride,
  targetOf,
} from './enterprise-build.ts';

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

describe('makeOverride', () => {
  it('pins connect-src to exactly the hub in both CSPs', () => {
    const o = makeOverride(planOf(GOOD)) as { app: { security: Record<string, Record<string, string>> }; bundle?: unknown };
    const pinned = "'self' ipc: http://ipc.localhost wss://breaks.acme.internal";
    expect(o.app.security.csp).toEqual({ 'connect-src': pinned });
    expect(o.app.security.devCsp).toEqual({ 'connect-src': pinned });
    expect(JSON.stringify(o)).not.toMatch(/wss: |localhost:\*|127\.0\.0\.1/);
    expect(o.bundle).toBeUndefined();
  });

  it('keeps the rest of the CSP from tauri.conf.json, whose connect-src it replaces', () => {
    const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
    for (const key of ['csp', 'devCsp']) {
      // The base is what the app's own connect-src starts with, so nothing it needs is lost.
      expect(conf.app.security[key]['connect-src'].startsWith(`${CSP_BASE} wss:`)).toBe(true);
    }
  });

  it('names the signing identity when there is one', () => {
    const o = makeOverride(planOf({ ...GOOD, APPLE_SIGNING_IDENTITY: 'Developer ID Application: Acme' })) as {
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

  it('accepts a binary with only the pinned connect-src (string literals packed back to back)', () => {
    expect(checkEmbeddedCsp(bin(connectSrc(origin), "object-src'none'", connectSrc(origin)), origin)).toEqual([]);
  });

  it('refuses the default, wide CSP', () => {
    const problems = checkEmbeddedCsp(bin(DEFAULT), origin);
    expect(problems.some((p) => /isn't in it/.test(p))).toBe(true);
    expect(problems.some((p) => /ws:\/\/localhost:\*/.test(p))).toBe(true);
    expect(problems.some((p) => /"wss: ws:\/\/loc/.test(p))).toBe(true);
  });

  it('refuses a binary with the pinned CSP and a wide one left over (e.g. devCsp)', () => {
    expect(checkEmbeddedCsp(bin(connectSrc(origin), DEFAULT), origin)).not.toEqual([]);
  });

  it('refuses a binary pinned to another hub', () => {
    expect(checkEmbeddedCsp(bin(connectSrc('wss://other.example')), origin)).not.toEqual([]);
  });

  it('refuses an empty bundle', () => expect(checkEmbeddedCsp([], origin)).toEqual(['no executable found in the app bundle']));
});
