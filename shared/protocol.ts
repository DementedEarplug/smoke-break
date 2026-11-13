// Types and constants shared by the client and the server.

export const MIN_LENGTH_MIN = 10;
export const MAX_LENGTH_MIN = 15;
export const DEFAULT_LENGTH_MIN = 12;
export const MINUTE_MS = 60_000;
/** How long an invite waits for a second person before "maybe later", in minutes. */
export const PENDING_TIMEOUT_MIN = 5;
/** How long the "out" phase lingers so clients can play the stub-out. */
export const OUT_LINGER_MS = 4_000;

export function clampLength(min: number): number {
  if (!Number.isFinite(min)) return DEFAULT_LENGTH_MIN;
  return Math.min(MAX_LENGTH_MIN, Math.max(MIN_LENGTH_MIN, Math.round(min)));
}

/** Meeting links must point at one of these hosts (or a subdomain), over https. */
export const MEETING_HOSTS = ['zoom.us', 'zoom.com', 'zoomgov.com'];

const MEETING_LINK_MAX = 2000;

/**
 * The meeting paths we open: join (`/j/`), webinar (`/w/`), start (`/s/`) and
 * web-client join (`/wc/join/`) by meeting number, or a personal link
 * (`/my/<name>`). Zoom also hosts pages people write themselves, so any other
 * path on a Zoom host is refused. `src-tauri/src/meeting.rs` applies the same
 * rule; `shared/meeting-links.json` holds the test cases both run.
 */
const MEETING_PATH = /^\/(?:(?:j|w|s|wc\/join)\/[0-9]{1,20}|my\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

/** What a good link looks like, for error messages. */
export const MEETING_LINK_EXAMPLE = 'https://zoom.us/j/1234567890?pwd=…';

/**
 * Meeting links get opened on everyone's machine, so only accept https links to
 * a meeting on a known meeting service, and only ever store or open the
 * canonical form this returns (the query, which carries the passcode, is kept;
 * the fragment is dropped). Other URL parsers (the OS's, for one) read
 * backslashes, whitespace and control characters differently from `URL`, so
 * those are refused outright. Returns '' for "no link yet" and null for
 * anything unacceptable.
 */
export function normalizeMeetingLink(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  if (s === '') return '';
  if (s.length > MEETING_LINK_MAX || /[\s\\\u0000-\u001f\u007f-\u009f]/.test(s)) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const ok =
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    url.port === '' &&
    // No empty labels (".zoom.us", "a..zoom.us"), so "a subdomain" means a real one.
    !host.split('.').includes('') &&
    MEETING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) &&
    MEETING_PATH.test(url.pathname);
  if (!ok) return null;
  url.hash = '';
  return url.href;
}

export const isValidMeetingLink = (s: unknown): boolean => normalizeMeetingLink(s) !== null;

/** Idle is represented by `brk: null`. */
export type Phase = 'pending' | 'lighter' | 'lit' | 'out';
export type OutReason = 'burned' | 'nobody' | 'cancelled' | 'everyone-left';
export type MeetingProviderKind = 'fixed-link' | 'zoom-api';

export interface Participant {
  id: string;
  name: string;
  joinedAt: number;
  litAt: number | null;
}

export interface Break {
  id: string;
  phase: Phase;
  startedBy: string;
  startedByName: string;
  lengthMin: number;
  /** Length of a break "minute" in ms. Always 60s except in dev demo mode. */
  minuteMs: number;
  createdAt: number;
  pendingExpiresAt: number | null;
  litAt: number | null;
  endsAt: number | null;
  outAt: number | null;
  outReason: OutReason | null;
  /** Participants still in the break. Kept during "out" for the stub-out animation. */
  participants: Participant[];
  meetingRequested: boolean;
  meetingUrl: string | null;
}

export interface MemberView {
  /** Public id, not the member's private clientId. */
  id: string;
  name: string;
  online: boolean;
  /**
   * Whose access token this person connected with, when the hub uses per-person
   * tokens. Unlike the name, they can't choose it. Only the owner receives it.
   */
  label?: string;
}

/**
 * The app connects with these WebSocket subprotocols: `WS_PROTOCOL`, plus
 * `tokenProtocol(token)` when it has an access token. A hub that requires
 * tokens checks it before accepting the connection at all, so strangers can't
 * hold sockets open. The hub always answers with `WS_PROTOCOL`.
 */
export const WS_PROTOCOL = 'sb.v1';
const TOKEN_PROTOCOL_PREFIX = 'sb.token.';
/** Tokens travel base64url-encoded (UTF-8), since a subprotocol can't hold arbitrary characters. */
export function tokenProtocol(token: string): string {
  const bytes = new TextEncoder().encode(token);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return TOKEN_PROTOCOL_PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** The token from a list of offered subprotocols, or null if there isn't a well-formed one. */
export function tokenFromProtocols(offered: Iterable<string>): string | null {
  for (const p of offered) {
    if (!p.startsWith(TOKEN_PROTOCOL_PREFIX)) continue;
    const b64 = p.slice(TOKEN_PROTOCOL_PREFIX.length);
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(b64)) return null;
    try {
      const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
      return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    } catch {
      return null;
    }
  }
  return null;
}

export interface TeamView {
  code: string;
  name: string;
  defaultLengthMin: number;
  /** The team's fixed link. Only the owner receives it; everyone else gets ''. */
  zoomLink: string;
  /** Whether a link is set, for members who don't receive it. */
  hasZoomLink: boolean;
  meetingProvider: MeetingProviderKind;
  /** Public id of the member who can change team settings (whoever created the team). */
  ownerId: string | null;
  /** Everyone on the team's roster, including people who are offline right now. */
  members: MemberView[];
  /** New people need the owner's OK before they can join with the invite code. */
  requireApproval: boolean;
  /** People waiting for that OK. Only the owner receives them; everyone else gets []. */
  pending: MemberView[];
  /** `meetingUrl` is only filled in for people taking part in the break. */
  brk: Break | null;
}

/** `token` is the hub's access token, for hubs that require one. */
export type ClientMsg =
  | { type: 'create'; teamName: string; clientId: string; name: string; token?: string }
  | { type: 'hello'; teamCode: string; clientId: string; name: string; token?: string }
  /** Owner only: replace the invite code. Everyone connected gets the new one. */
  | { type: 'rotateCode' }
  /**
   * Owner only: remove a member (by public id, online or not) and keep them from
   * rejoining. The hub also replaces the invite code, since they know the old one.
   */
  | { type: 'removeMember'; id: string }
  /** Owner only: let a waiting person in, or turn them away (they can ask again after a day). */
  | { type: 'approveMember'; id: string; allow: boolean }
  /** Owner only: hand the team to another member on the roster. */
  | { type: 'transferOwner'; id: string }
  | { type: 'invite' }
  | { type: 'setLength'; lengthMin: number }
  | { type: 'join'; light?: boolean }
  | { type: 'light' }
  | { type: 'leave' }
  | { type: 'settings'; zoomLink?: string; defaultLengthMin?: number; teamName?: string; requireApproval?: boolean };

export type ServerMsg =
  /** `you` is your public id: compare it with member and participant ids. */
  | { type: 'state'; team: TeamView; you: string; serverNow: number }
  | { type: 'error'; message: string; fatal?: boolean; code?: ErrorCode };

/**
 * Why a fatal error happened. Clients forget their saved team only for
 * 'bad-code', 'removed' and 'denied'; for the others they keep it and try again
 * later. 'pending' means the owner hasn't let them in yet: keep the team, say
 * so, and ask again every so often.
 */
export type ErrorCode = 'bad-code' | 'removed' | 'denied' | 'pending' | 'rate-limited' | 'unauthorized' | 'full';

const ERROR_CODES: readonly ErrorCode[] = ['bad-code', 'removed', 'denied', 'pending', 'rate-limited', 'unauthorized', 'full'];
const PHASES: readonly Phase[] = ['pending', 'lighter', 'lit', 'out'];
const OUT_REASONS: readonly OutReason[] = ['burned', 'nobody', 'cancelled', 'everyone-left'];
const PROVIDERS: readonly MeetingProviderKind[] = ['fixed-link', 'zoom-api'];

/**
 * Bounds for what the app accepts from a hub. A hostile or broken hub must not
 * be able to freeze the overlay with huge values, so these are generous for a
 * real team but far below anything that would hurt. Invite codes were 6
 * characters and are now up to 10; allow a little slack beyond that.
 */
export const INVITE_CODE = /^[A-Z0-9]{4,16}$/;
const ID_MAX = 64;
const NAME_MAX = 64;
const MESSAGE_MAX = 500;
const MAX_MEMBERS = 500;
/** Demo mode shortens a break minute to a few seconds; nothing real is outside this range. */
const MINUTE_MS_MIN = 100;
const MINUTE_MS_MAX = 10 * MINUTE_MS;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && v.length >= min && v.length <= max;
/** Timestamps and other times: finite, not negative. */
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const timeOrNull = (v: unknown): v is number | null => v === null || time(v);
const oneOf = <T extends string>(v: unknown, options: readonly T[]): v is T =>
  typeof v === 'string' && (options as readonly string[]).includes(v);
const lengthOk = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= MIN_LENGTH_MIN && v <= MAX_LENGTH_MIN;

function parseParticipant(v: unknown): Participant | null {
  if (!isObj(v)) return null;
  const { id, name, joinedAt, litAt } = v;
  if (!str(id, 1, ID_MAX) || !str(name, 0, NAME_MAX) || !time(joinedAt) || !timeOrNull(litAt)) return null;
  return { id, name, joinedAt, litAt };
}

/**
 * Access-token labels are `letters, digits and . _ @ + -` on today's hubs. The
 * owner reads them as who someone really is, so accept only short, visible
 * text: no control, format (bidi, zero-width), separator or private-use
 * characters that could make one label pass for another.
 */
export const LABEL_MAX = 64;
const LABEL = /^[^\p{C}\p{Z}]+$/u;
export const isValidLabel = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= LABEL_MAX * 2 && Array.from(v).length <= LABEL_MAX && LABEL.test(v);

function parseMember(v: unknown): MemberView | null {
  if (!isObj(v)) return null;
  const { id, name, online, label } = v;
  if (!str(id, 1, ID_MAX) || !str(name, 0, NAME_MAX) || typeof online !== 'boolean') return null;
  // A hub without per-person tokens (or a non-owner's view) sends none.
  if (label === undefined || label === null) return { id, name, online };
  if (!isValidLabel(label)) return null;
  return { id, name, online, label };
}

/** Parses every element, or returns null if the array is too long or any element is bad. */
function parseList<T>(v: unknown, parse: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v) || v.length > MAX_MEMBERS) return null;
  const out: T[] = [];
  for (const x of v) {
    const item = parse(x);
    if (!item) return null;
    out.push(item);
  }
  return out;
}

function parseBreak(v: unknown): Break | null {
  if (!isObj(v)) return null;
  const participants = parseList(v.participants, parseParticipant);
  const ok =
    participants &&
    str(v.id, 1, ID_MAX) &&
    oneOf(v.phase, PHASES) &&
    str(v.startedBy, 0, ID_MAX) &&
    str(v.startedByName, 0, NAME_MAX) &&
    lengthOk(v.lengthMin) &&
    typeof v.minuteMs === 'number' &&
    Number.isFinite(v.minuteMs) &&
    v.minuteMs >= MINUTE_MS_MIN &&
    v.minuteMs <= MINUTE_MS_MAX &&
    time(v.createdAt) &&
    timeOrNull(v.pendingExpiresAt) &&
    timeOrNull(v.litAt) &&
    timeOrNull(v.endsAt) &&
    timeOrNull(v.outAt) &&
    (v.outReason === null || oneOf(v.outReason, OUT_REASONS)) &&
    typeof v.meetingRequested === 'boolean' &&
    (v.meetingUrl === null || typeof v.meetingUrl === 'string');
  if (!ok) return null;
  return {
    id: v.id as string,
    phase: v.phase as Phase,
    startedBy: v.startedBy as string,
    startedByName: v.startedByName as string,
    lengthMin: v.lengthMin as number,
    minuteMs: v.minuteMs as number,
    createdAt: v.createdAt as number,
    pendingExpiresAt: v.pendingExpiresAt as number | null,
    litAt: v.litAt as number | null,
    endsAt: v.endsAt as number | null,
    outAt: v.outAt as number | null,
    outReason: v.outReason as OutReason | null,
    participants,
    meetingRequested: v.meetingRequested as boolean,
    // Only ever hand the canonical form on; anything we wouldn't open becomes "no link".
    meetingUrl: normalizeMeetingLink(v.meetingUrl) || null,
  };
}

function parseTeam(v: unknown): TeamView | null {
  if (!isObj(v)) return null;
  const members = parseList(v.members, parseMember);
  // Hubs from before approvals send neither field: nobody is waiting.
  const pending = v.pending === undefined ? [] : parseList(v.pending, parseMember);
  const brk = v.brk === null ? null : parseBreak(v.brk);
  const ok =
    members &&
    pending &&
    (v.requireApproval === undefined || typeof v.requireApproval === 'boolean') &&
    (v.brk === null || brk) &&
    typeof v.code === 'string' &&
    INVITE_CODE.test(v.code) &&
    str(v.name, 0, NAME_MAX) &&
    lengthOk(v.defaultLengthMin) &&
    typeof v.zoomLink === 'string' &&
    (v.hasZoomLink === undefined || typeof v.hasZoomLink === 'boolean') &&
    oneOf(v.meetingProvider, PROVIDERS) &&
    (v.ownerId === null || str(v.ownerId, 1, ID_MAX));
  if (!ok) return null;
  const zoomLink = normalizeMeetingLink(v.zoomLink) ?? '';
  return {
    code: v.code as string,
    name: v.name as string,
    defaultLengthMin: v.defaultLengthMin as number,
    zoomLink,
    // Hubs from before `hasZoomLink` send the link to everyone instead.
    hasZoomLink: typeof v.hasZoomLink === 'boolean' ? v.hasZoomLink : zoomLink !== '',
    meetingProvider: v.meetingProvider as MeetingProviderKind,
    ownerId: v.ownerId as string | null,
    members,
    requireApproval: v.requireApproval === true,
    pending,
    brk,
  };
}

/**
 * Parses a frame from the hub, or returns null if it isn't a message we
 * understand. The hub isn't trusted with the overlay's health: every field the
 * app uses is type- and range-checked, and the result is a fresh object with
 * only those fields, so nothing unexpected rides along.
 */
export function parseServerMsg(data: unknown): ServerMsg | null {
  if (typeof data !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObj(parsed)) return null;
  const m = parsed;
  if (m.type === 'error') {
    const { message, fatal, code } = m;
    if (!str(message, 0, MESSAGE_MAX)) return null;
    if (fatal !== undefined && typeof fatal !== 'boolean') return null;
    const out: Extract<ServerMsg, { type: 'error' }> = { type: 'error', message };
    if (fatal !== undefined) out.fatal = fatal;
    // An unknown code (a newer hub) is treated like no code: keep the team and retry.
    if (oneOf(code, ERROR_CODES)) out.code = code;
    return out;
  }
  if (m.type === 'state') {
    if (!str(m.you, 1, ID_MAX) || !time(m.serverNow)) return null;
    const team = parseTeam(m.team);
    return team ? { type: 'state', team, you: m.you, serverNow: m.serverNow } : null;
  }
  return null;
}

/**
 * Fatal errors after which the app forgets the saved team; anything else is
 * worth retrying. A denied request isn't permanent (they can ask again after
 * a day, with the invite code), but retrying on our own would only be refused.
 */
export const forgetsTeam = (code: ErrorCode | undefined): boolean =>
  code === 'bad-code' || code === 'removed' || code === 'denied';
