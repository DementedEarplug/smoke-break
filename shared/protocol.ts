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
 * Meeting links get opened on everyone's machine, so only accept https links to
 * a known meeting service, and only ever store or open the canonical form this
 * returns. Other URL parsers (the OS's, for one) read backslashes, whitespace
 * and control characters differently from `URL`, so those are refused outright.
 * Returns '' for "no link yet" and null for anything unacceptable.
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
    MEETING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  return ok ? url.href : null;
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
  members: MemberView[];
  brk: Break | null;
}

/** `token` is the hub's access token, for hubs that require one. */
export type ClientMsg =
  | { type: 'create'; teamName: string; clientId: string; name: string; token?: string }
  | { type: 'hello'; teamCode: string; clientId: string; name: string; token?: string }
  /** Owner only: replace the invite code. Everyone connected gets the new one. */
  | { type: 'rotateCode' }
  /** Owner only: remove a member (by public id) and keep them from rejoining. */
  | { type: 'removeMember'; id: string }
  | { type: 'invite' }
  | { type: 'setLength'; lengthMin: number }
  | { type: 'join'; light?: boolean }
  | { type: 'light' }
  | { type: 'leave' }
  | { type: 'settings'; zoomLink?: string; defaultLengthMin?: number; teamName?: string };

export type ServerMsg =
  /** `you` is your public id: compare it with member and participant ids. */
  | { type: 'state'; team: TeamView; you: string; serverNow: number }
  | { type: 'error'; message: string; fatal?: boolean; code?: ErrorCode };

/**
 * Why a fatal error happened. Clients forget their saved team only for
 * 'bad-code' and 'removed'; for the others they keep it and try again later.
 */
export type ErrorCode = 'bad-code' | 'removed' | 'rate-limited' | 'unauthorized' | 'full';

const ERROR_CODES: readonly ErrorCode[] = ['bad-code', 'removed', 'rate-limited', 'unauthorized', 'full'];
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

function parseMember(v: unknown): MemberView | null {
  if (!isObj(v)) return null;
  const { id, name, online } = v;
  if (!str(id, 1, ID_MAX) || !str(name, 0, NAME_MAX) || typeof online !== 'boolean') return null;
  return { id, name, online };
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
  const brk = v.brk === null ? null : parseBreak(v.brk);
  const ok =
    members &&
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

/** Fatal errors after which the saved team is gone for good; anything else is worth retrying. */
export const forgetsTeam = (code: ErrorCode | undefined): boolean => code === 'bad-code' || code === 'removed';
