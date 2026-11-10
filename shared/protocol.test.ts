import { describe, expect, it } from 'vitest';
import { forgetsTeam, normalizeMeetingLink, parseServerMsg } from './protocol.ts';

describe('normalizeMeetingLink', () => {
  it.each([
    ['https://zoom.us/j/123?pwd=abc', 'https://zoom.us/j/123?pwd=abc'],
    ['https://acme.zoom.us/j/123', 'https://acme.zoom.us/j/123'],
    ['https://zoom.com/j/1', 'https://zoom.com/j/1'],
    ['https://us02web.zoomgov.com/j/1', 'https://us02web.zoomgov.com/j/1'],
    // Canonical form: lowercase host, explicit path, default port dropped.
    ['https://ZOOM.us', 'https://zoom.us/'],
    ['https://zoom.us:443/j/1', 'https://zoom.us/j/1'],
    ['', ''],
  ])('accepts %s', (raw, out) => expect(normalizeMeetingLink(raw)).toBe(out));

  it.each([
    // The audit's bypass: WHATWG URL reads host zoom.us, macOS reads evil.example.
    'https://zoom.us\\@evil.example/.zoom.us/x',
    'https://evil.example/.zoom.us/x',
    'https://evil.example/?https://zoom.us/',
    'https://zoom.us.evil.example/j/1',
    'https://evilzoom.us/j/1',
    'https://zoom.us./j/1',
    'https://user@zoom.us/j/1',
    'https://user:pw@zoom.us/j/1',
    'https://zoom.us:8443/j/1',
    'http://zoom.us/j/1',
    'javascript:alert(1)//zoom.us',
    'zoom.us/j/1',
    'https://zoom.us/j/1\t',
    'https://zoom.us/j/1\n',
    'https://zoom.us/j/ 1',
    ' https://zoom.us/j/1',
    'https://zoom.us/j/1\u0000',
    'https://zoom.us/j/1\u0085',
    'https://zoom.us/j/1 ',
    `https://zoom.us/${'a'.repeat(2000)}`,
  ])('rejects %j', (raw) => expect(normalizeMeetingLink(raw)).toBeNull());

  it('rejects non-strings', () => {
    for (const v of [null, undefined, 1, {}, { toString: 1 }, ['https://zoom.us/']]) {
      expect(normalizeMeetingLink(v)).toBeNull();
    }
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
  members: [member],
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
    const ok = parseServerMsg(withBreak({ meetingUrl: 'https://ZOOM.us' }));
    expect(ok?.type === 'state' && ok.team.brk?.meetingUrl).toBe('https://zoom.us/');
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

describe('forgetsTeam', () => {
  it('forgets only for bad-code and removed', () => {
    expect(forgetsTeam('bad-code')).toBe(true);
    expect(forgetsTeam('removed')).toBe(true);
    for (const c of ['rate-limited', 'full', 'unauthorized', undefined] as const) expect(forgetsTeam(c)).toBe(false);
  });
});
