import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MEETING_LINK_EXAMPLE,
  WS_PROTOCOL,
  forgetsTeam,
  normalizeMeetingLink,
  parseServerMsg,
  tokenFromProtocols,
  tokenProtocol,
} from './protocol.ts';

// Shared with the Rust validator (src-tauri/src/meeting.rs), so the two can't drift apart.
const vectors = JSON.parse(readFileSync(new URL('./meeting-links.json', import.meta.url), 'utf8')) as {
  accept: [string, string][];
  reject: string[];
};

describe('normalizeMeetingLink', () => {
  it.each(vectors.accept)('accepts %j', (raw, out) => expect(normalizeMeetingLink(raw)).toBe(out));
  it.each(vectors.reject)('rejects %j', (raw) => expect(normalizeMeetingLink(raw)).toBeNull());

  it('treats empty as "no link yet"', () => expect(normalizeMeetingLink('')).toBe(''));

  it('rejects over-long links', () => {
    expect(normalizeMeetingLink(`https://zoom.us/j/1?pwd=${'a'.repeat(2000)}`)).toBeNull();
  });

  it('rejects non-strings', () => {
    for (const v of [null, undefined, 1, {}, { toString: 1 }, ['https://zoom.us/j/1']]) {
      expect(normalizeMeetingLink(v)).toBeNull();
    }
  });

  it('has a valid example for error messages', () => {
    expect(normalizeMeetingLink(MEETING_LINK_EXAMPLE.replace('…', 'abc'))).not.toBeNull();
  });
});

const member = { id: 'm1', name: 'Sam', online: true };
const participant = { id: 'm1', name: 'Sam', joinedAt: 1000, litAt: null };
const brk = {
  id: 'b1',
  phase: 'lit',
  startedBy: 'm1',
  startedByName: 'Sam',
  lengthMin: 12,
  minuteMs: 60_000,
  createdAt: 1000,
  pendingExpiresAt: null,
  litAt: 2000,
  endsAt: 3000,
  outAt: null,
  outReason: null,
  participants: [participant],
  meetingRequested: true,
  meetingUrl: 'https://zoom.us/j/1',
};
const team = {
  code: 'ABCDE23456',
  name: 'Team',
  defaultLengthMin: 12,
  zoomLink: '',
  hasZoomLink: true,
  meetingProvider: 'fixed-link',
  ownerId: 'm1',
  members: [member, { id: 'm2', name: 'Alex', online: false }],
  requireApproval: true,
  pending: [{ id: 'p1', name: 'Alex', online: true }],
  brk,
};
const state = (t: object = team, extra: object = {}) =>
  JSON.stringify({ type: 'state', you: 'm1', serverNow: 5000, team: t, ...extra });
const withTeam = (patch: object) => state({ ...team, ...patch });
const withBreak = (patch: object) => withTeam({ brk: { ...brk, ...patch } });

describe('parseServerMsg', () => {
  it.each([
    ['not json', null],
    ['null', null],
    ['42', null],
    ['[]', null],
    ['{"type":"nope"}', null],
    ['{"type":"error"}', null],
    ['{"type":"error","message":5}', null],
    ['{"type":"error","message":"x","fatal":"yes"}', null],
    ['{"type":"state","you":"x","serverNow":1}', null],
    ['{"type":"state","you":"x","serverNow":"1","team":{"code":"A","members":[]}}', null],
  ])('rejects %s', (raw, out) => expect(parseServerMsg(raw)).toBe(out));

  it('ignores non-text frames', () => expect(parseServerMsg(new ArrayBuffer(2))).toBeNull());

  it('accepts errors, keeping only known codes', () => {
    expect(parseServerMsg('{"type":"error","message":"no"}')).toEqual({ type: 'error', message: 'no' });
    expect(parseServerMsg('{"type":"error","message":"no","fatal":true,"code":"removed","x":1}')).toEqual({
      type: 'error',
      message: 'no',
      fatal: true,
      code: 'removed',
    });
    expect(parseServerMsg('{"type":"error","message":"no","fatal":true,"code":"weird"}')).toEqual({
      type: 'error',
      message: 'no',
      fatal: true,
    });
  });

  it('rejects over-long error messages', () => {
    expect(parseServerMsg(JSON.stringify({ type: 'error', message: 'x'.repeat(501) }))).toBeNull();
  });

  it('accepts a full state and returns only known fields', () => {
    const msg = parseServerMsg(state({ ...team, extra: 'x' }, { more: 1 }));
    expect(msg).toEqual({ type: 'state', you: 'm1', serverNow: 5000, team });
  });

  it('accepts idle teams and old 6-character codes', () => {
    expect(parseServerMsg(withTeam({ brk: null, code: 'ABC234' }))).not.toBeNull();
    expect(parseServerMsg(withTeam({ ownerId: null, members: [] }))).not.toBeNull();
  });

  it('derives hasZoomLink for hubs that predate it', () => {
    const { hasZoomLink: _, ...old } = team;
    const a = parseServerMsg(state({ ...old, zoomLink: 'https://zoom.us/j/1' }));
    expect(a?.type === 'state' && a.team.hasZoomLink).toBe(true);
    const b = parseServerMsg(state(old));
    expect(b?.type === 'state' && b.team.hasZoomLink).toBe(false);
  });

  it('only passes on canonical meeting links', () => {
    const bad = parseServerMsg(
      withTeam({ zoomLink: 'https://zoom.us\\@evil.example/', brk: { ...brk, meetingUrl: 'https://evil.example/.zoom.us/x' } }),
    );
    expect(bad?.type === 'state' && bad.team.zoomLink).toBe('');
    expect(bad?.type === 'state' && bad.team.brk?.meetingUrl).toBeNull();
    const ok = parseServerMsg(withBreak({ meetingUrl: 'https://ZOOM.us/j/1#x' }));
    expect(ok?.type === 'state' && ok.team.brk?.meetingUrl).toBe('https://zoom.us/j/1');
    // A Zoom host but not a meeting: dropped like any other bad link.
    const page = parseServerMsg(withTeam({ zoomLink: 'https://zoom.us/signin', brk: { ...brk, meetingUrl: 'https://zoom.us/' } }));
    expect(page?.type === 'state' && page.team.zoomLink).toBe('');
    expect(page?.type === 'state' && page.team.brk?.meetingUrl).toBeNull();
  });

  it('accepts a break without a link (non-participants get none)', () => {
    const msg = parseServerMsg(withBreak({ meetingUrl: null }));
    expect(msg?.type === 'state' && msg.team.brk?.meetingUrl).toBeNull();
  });

  it('defaults approvals for hubs that predate them', () => {
    const { requireApproval: _a, pending: _p, ...old } = team;
    const msg = parseServerMsg(state(old));
    expect(msg?.type === 'state' && msg.team.requireApproval).toBe(false);
    expect(msg?.type === 'state' && msg.team.pending).toEqual([]);
  });

  it('keeps the roster, offline members and the waiting list', () => {
    const msg = parseServerMsg(state(team));
    expect(msg?.type === 'state' && msg.team.members).toEqual(team.members);
    expect(msg?.type === 'state' && msg.team.pending).toEqual(team.pending);
    expect(msg?.type === 'state' && msg.team.requireApproval).toBe(true);
    // Only known member fields survive.
    const extra = parseServerMsg(withTeam({ pending: [{ id: 'p1', name: 'A', online: true, clientId: 'secret' }] }));
    expect(extra?.type === 'state' && extra.team.pending).toEqual([{ id: 'p1', name: 'A', online: true }]);
  });

  it('keeps access-token labels, which only the owner receives', () => {
    const labelled = { id: 'm3', name: 'Alex', online: true, label: 'alex.k@acme' };
    const msg = parseServerMsg(withTeam({ members: [member, labelled], pending: [{ ...labelled, id: 'p9', label: 'bob' }] }));
    expect(msg?.type === 'state' && msg.team.members).toEqual([member, labelled]);
    expect(msg?.type === 'state' && msg.team.pending).toEqual([{ ...labelled, id: 'p9', label: 'bob' }]);
    // A null label is the same as none.
    const none = parseServerMsg(withTeam({ members: [{ ...member, label: null }] }));
    expect(none?.type === 'state' && none.team.members).toEqual([member]);
    // Up to 64 characters, counted as characters.
    expect(parseServerMsg(withTeam({ members: [{ ...member, label: 'x'.repeat(64) }] }))).not.toBeNull();
    expect(parseServerMsg(withTeam({ members: [{ ...member, label: 'é'.repeat(64) }] }))).not.toBeNull();
  });

  it.each([
    ['empty', ''],
    ['too long', 'x'.repeat(65)],
    ['not a string', 5],
    ['an object', { toString: 'alice' }],
    ['a space', 'alice smith'],
    ['a newline', 'alice\nbob'],
    ['a control character', 'ali\u0007ce'],
    ['a bidi override', 'ali\u202ece'],
    ['a zero-width space', 'ali\u200bce'],
    ['a private-use character', 'ali\ue000ce'],
    ['a lone surrogate', 'ali\ud800ce'],
  ])('rejects a label that is %s', (_, label) => {
    expect(parseServerMsg(withTeam({ members: [{ ...member, label }] }))).toBeNull();
    expect(parseServerMsg(withTeam({ pending: [{ ...member, label }] }))).toBeNull();
  });

  it.each(['pending', 'denied'] as const)('keeps the %s error code', (code) => {
    expect(parseServerMsg(JSON.stringify({ type: 'error', message: 'm', fatal: true, code }))).toEqual({
      type: 'error',
      message: 'm',
      fatal: true,
      code,
    });
  });

  it.each([
    ['team code too long', withTeam({ code: 'A'.repeat(17) })],
    ['team code with odd characters', withTeam({ code: 'AB/CD' })],
    ['team name too long', withTeam({ name: 'x'.repeat(65) })],
    ['default length out of range', withTeam({ defaultLengthMin: 1e9 })],
    ['unknown provider', withTeam({ meetingProvider: 'evil' })],
    ['hasZoomLink not a boolean', withTeam({ hasZoomLink: 'yes' })],
    ['zoomLink not a string', withTeam({ zoomLink: 5 })],
    ['members not an array', withTeam({ members: {} })],
    ['too many members', withTeam({ members: Array(501).fill(member) })],
    ['bad member', withTeam({ members: [{ id: 'x', name: 'y' }] })],
    ['member name too long', withTeam({ members: [{ ...member, name: 'x'.repeat(65) }] })],
    ['requireApproval not a boolean', withTeam({ requireApproval: 'yes' })],
    ['requireApproval null', withTeam({ requireApproval: null })],
    ['pending not an array', withTeam({ pending: {} })],
    ['pending null', withTeam({ pending: null })],
    ['too many pending', withTeam({ pending: Array(501).fill(member) })],
    ['bad pending entry', withTeam({ pending: [{ id: '', name: 'y', online: true }] })],
    ['pending name too long', withTeam({ pending: [{ ...member, name: 'x'.repeat(65) }] })],
    ['pending id too long', withTeam({ pending: [{ ...member, id: 'x'.repeat(65) }] })],
    ['brk not an object', withTeam({ brk: 'x' })],
    ['unknown phase', withBreak({ phase: 'boom' })],
    ['unknown outReason', withBreak({ outReason: 'boom' })],
    ['lengthMin too big', withBreak({ lengthMin: 1e9 })],
    ['lengthMin fractional', withBreak({ lengthMin: 12.5 })],
    ['minuteMs zero', withBreak({ minuteMs: 0 })],
    ['minuteMs huge', withBreak({ minuteMs: 1e12 })],
    ['endsAt not finite', withBreak({ endsAt: '1e999' })],
    ['negative timestamp', withBreak({ createdAt: -1 })],
    ['meetingRequested missing', withBreak({ meetingRequested: undefined })],
    ['too many participants', withBreak({ participants: Array(501).fill(participant) })],
    ['bad participant', withBreak({ participants: [{ ...participant, litAt: 'now' }] })],
    ['serverNow not finite', state(team, { serverNow: null })],
    ['empty you', state(team, { you: '' })],
  ])('rejects state with %s', (_, raw) => expect(parseServerMsg(raw)).toBeNull());
});

describe('token subprotocol', () => {
  const offered = (token: string) => [WS_PROTOCOL, tokenProtocol(token)];

  it('round-trips tokens, as a valid subprotocol', () => {
    for (const t of ['3f9c0a7e', 'a'.repeat(512), 'p@ss:w/rd+=?', 'x']) {
      const p = tokenProtocol(t);
      // RFC 6455 subprotocols are HTTP tokens: no separators, spaces or padding.
      expect(p).toMatch(/^sb\.token\.[A-Za-z0-9_-]+$/);
      expect(tokenFromProtocols(offered(t))).toBe(t);
    }
  });

  it('round-trips non-ASCII tokens as UTF-8', () => {
    for (const t of ['jalapeño-tøken', '鍵🔑', '\u{10ffff}']) expect(tokenFromProtocols(offered(t))).toBe(t);
  });

  it('finds the token whatever its position, and none when none is offered', () => {
    expect(tokenFromProtocols([tokenProtocol('abc'), WS_PROTOCOL])).toBe('abc');
    expect(tokenFromProtocols([WS_PROTOCOL])).toBeNull();
    expect(tokenFromProtocols([])).toBeNull();
    expect(tokenFromProtocols(new Set(['other', WS_PROTOCOL]))).toBeNull();
  });

  it.each([
    ['empty', 'sb.token.'],
    ['standard base64 characters', 'sb.token.ab+/'],
    ['padding', 'sb.token.YQ=='],
    ['an impossible length', 'sb.token.A'],
    ['invalid UTF-8', `sb.token.${Buffer.from([0xff, 0xfe]).toString('base64url')}`],
    ['a truncated character', `sb.token.${Buffer.from('é').subarray(0, 1).toString('base64url')}`],
    ['spaces', 'sb.token.YWJj ZA'],
  ])('rejects a malformed token: %s', (_, p) => expect(tokenFromProtocols([WS_PROTOCOL, p])).toBeNull());

  it('rejects over-long tokens instead of decoding them', () => {
    // 1024 base64 characters (768 bytes) is the most the hub will decode.
    expect(tokenFromProtocols([`sb.token.${'A'.repeat(1024)}`])).toHaveLength(768);
    expect(tokenFromProtocols([`sb.token.${'A'.repeat(1025)}`])).toBeNull();
    expect(tokenFromProtocols(offered('t'.repeat(1000)))).toBeNull();
  });
});

describe('forgetsTeam', () => {
  it('forgets only for bad-code, removed and denied', () => {
    expect(forgetsTeam('bad-code')).toBe(true);
    expect(forgetsTeam('removed')).toBe(true);
    expect(forgetsTeam('denied')).toBe(true);
    for (const c of ['pending', 'rate-limited', 'full', 'unauthorized', undefined] as const) expect(forgetsTeam(c)).toBe(false);
  });
});
