// Realtime hub: one shared break per team, broadcast to every connected pack.
// The server owns the clock: every deadline is scheduled here.

import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  type Break,
  DEFAULT_LENGTH_MIN,
  type ErrorCode,
  type MeetingProviderKind,
  type TeamView,
  clampLength,
  normalizeMeetingLink,
} from '../shared/protocol.ts';
import * as machine from './breakMachine.ts';
import { TokenBucket, WindowLimiter } from './limits.ts';
import { fixedLinkProvider, getProvider } from './meeting.ts';

/** Dev demo mode: e.g. SMOKE_BREAK_MINUTE_MS=3000 makes a 12-minute break last 36 seconds. */
const MINUTE_MS = Number(process.env.SMOKE_BREAK_MINUTE_MS) || 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** 32^10 = 2^50 codes. Teams created before this have 6-character codes, which keep working. */
const CODE_LENGTH = 10;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const BAD_CODE_WINDOW_MS = 600_000;
/** Remembered and removed members per team, so the saved file stays small. */
const MAX_KNOWN = 1000;
const MAX_BANNED = 1000;

/** A positive integer from the environment, or the fallback. */
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
const envList = (s: string | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const envFlag = (s: string | undefined) => /^(1|true|yes|on)$/i.test(s?.trim() ?? '');

export interface HubLimits {
  /** Largest WebSocket message accepted; real messages are well under 1 KiB. */
  maxPayloadBytes: number;
  maxTeams: number;
  /** Saved teams nobody has used for this long are forgotten. */
  teamIdleDays: number;
  /** A team used within this many days is never forgotten to make room; new teams are refused instead. */
  teamKeepDays: number;
  createsPerIpPerHour: number;
  /** New teams per hour across the whole hub, however many addresses they come from. */
  createsPerHour: number;
  /** Wrong invite codes allowed per address every 10 minutes, so codes can't be guessed. */
  badCodesPerIp: number;
  /** Wrong invite codes allowed across the whole hub every 10 minutes, so guessing can't be spread over addresses. */
  badCodes: number;
  /** Delay before saying a code is wrong. */
  badCodeDelayMs: number;
  /** Each desktop app holds two connections, so this is about twice the people behind one address. */
  connectionsPerIp: number;
  maxConnections: number;
  maxMembersPerTeam: number;
  /** Per-socket message rate: bursts of `messageBurst`, then `messagesPerSecond`. */
  messageBurst: number;
  messagesPerSecond: number;
  /** A socket with more than this waiting to be sent has stopped reading and is dropped. */
  maxBufferedBytes: number;
  /** Ping this often; a socket that hasn't answered the previous ping is dropped. */
  pingIntervalMs: number;
  /** A socket must say create/hello within this long. */
  helloTimeoutMs: number;
  /** How long a closed tab keeps its spot in a break before it's stubbed out. */
  disconnectGraceMs: number;
  /** One person can start a new break at most this often. */
  breakCooldownMs: number;
  saveDelayMs: number;
  /** A team's last-used time is only bumped (and saved) this often. */
  lastActiveResolutionMs: number;
}

export const DEFAULT_LIMITS: HubLimits = {
  maxPayloadBytes: 16 * 1024,
  maxTeams: envInt('SMOKE_BREAK_MAX_TEAMS', 2000),
  teamIdleDays: 90,
  teamKeepDays: 7,
  createsPerIpPerHour: 10,
  createsPerHour: 100,
  badCodesPerIp: 20,
  badCodes: 200,
  badCodeDelayMs: 500,
  // An office behind one NAT or proxy address: ~250 people with the app open.
  connectionsPerIp: envInt('SMOKE_BREAK_CONNECTIONS_PER_IP', 500),
  maxConnections: envInt('SMOKE_BREAK_MAX_CONNECTIONS', 10_000),
  maxMembersPerTeam: 200,
  messageBurst: 30,
  messagesPerSecond: 10,
  maxBufferedBytes: 1024 * 1024,
  pingIntervalMs: 30_000,
  helloTimeoutMs: 10_000,
  disconnectGraceMs: 20_000,
  breakCooldownMs: 10_000,
  saveDelayMs: 200,
  lastActiveResolutionMs: HOUR_MS,
};
/** A socket that keeps flooding after being throttled this many times is closed. */
const MAX_DROPPED_MESSAGES = 50;

export interface HubOptions {
  dataFile: string;
  limits?: Partial<HubLimits>;
  /** Every create/hello must carry this. Default: SMOKE_BREAK_ACCESS_TOKEN. */
  accessToken?: string;
  /** Take the client address from X-Forwarded-For. Default: SMOKE_BREAK_TRUST_PROXY. */
  trustProxy?: boolean;
  /** Hostnames the hub answers to. Default: SMOKE_BREAK_PUBLIC_HOST (comma-separated). */
  publicHosts?: string[];
  /** Extra web origins allowed to connect. Default: SMOKE_BREAK_ALLOWED_ORIGINS (comma-separated). */
  allowedOrigins?: string[];
  /** Dev server only: accept pages served from localhost by the same server. */
  allowLocalhostPages?: boolean;
  /** Where audit lines go. Default: stdout. */
  log?: (line: string) => void;
}

/** Where teams are saved: $SMOKE_BREAK_DATA_DIR/teams.json, else .data/teams.json in the repo. */
export function dataFileFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.SMOKE_BREAK_DATA_DIR?.trim();
  return dir ? resolve(dir, 'teams.json') : resolve(import.meta.dirname, '../.data/teams.json');
}

interface Member {
  /** The client's private clientId. Proves who a socket is; never sent to anyone. */
  key: string;
  /** Public id shown to teammates and used in breaks. */
  id: string;
  name: string;
  sockets: Set<WebSocket>;
  leaveTimer: ReturnType<typeof setTimeout> | null;
  lastInviteAt: number;
}

interface Team {
  code: string;
  /**
   * Salt for members' public ids: the team's first code. It stays when the code
   * is rotated, so the owner and removed members keep their ids.
   */
  idSalt: string;
  /** Random, non-secret id that names the team in logs instead of its code. */
  ref: string;
  name: string;
  defaultLengthMin: number;
  /** Always the canonical form from normalizeMeetingLink, or ''. */
  zoomLink: string;
  meetingProvider: MeetingProviderKind;
  /** Public id of the creator, the only one who can change team settings. */
  ownerId: string | null;
  /** Public ids of everyone who has joined, oldest first. Returning members get past a wrong-code lockout. */
  known: Set<string>;
  /** Public ids the owner removed. They can't rejoin. */
  banned: Set<string>;
  members: Map<string, Member>;
  /** Last time anyone connected or left, or the team was created (ms). */
  lastActive: number;
  brk: Break | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface SavedTeam {
  code: string;
  idSalt: string;
  ref: string;
  name: string;
  defaultLengthMin: number;
  zoomLink: string;
  meetingProvider: MeetingProviderKind;
  ownerId: string | null;
  lastActive: number;
  known: string[];
  banned: string[];
}

/** One open socket. */
interface Conn {
  /** Client address, for logs. */
  ip: string;
  /** Address used for per-address limits (IPv6 grouped by /64). */
  key: string;
  alive: boolean;
  /** new → (pending, while a refusal is delayed) → joined, or done once refused or removed. */
  state: 'new' | 'pending' | 'joined' | 'done';
  team: Team | null;
  me: Member | null;
  helloTimer: ReturnType<typeof setTimeout>;
  /** Messages dropped by the rate limit. */
  dropped: number;
}

// ── Names ────────────────────────────────────────────────────────────────

const NAME_MAX = 24;
/** Control, format (zero-width, bidi), surrogate, private-use and line/paragraph separator characters, plus blank-looking letters. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800]/gu;

export function cleanName(s: unknown, fallback: string): string {
  if (typeof s !== 'string') return fallback;
  const cleaned = s.slice(0, 500).normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  // Cut by code points so an emoji isn't split in half.
  return Array.from(cleaned).slice(0, NAME_MAX).join('').trim() || fallback;
}

/**
 * Common Latin lookalikes (Cyrillic, Greek, l/1/I, 0/O), after lowercasing.
 * Not a full confusables table; enough that "Alex" and "Аlex" can't coexist.
 */
const LOOKALIKES: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', һ: 'h', ӏ: 'i', ԛ: 'q', ԝ: 'w',
  α: 'a', β: 'b', ε: 'e', ζ: 'z', η: 'h', ι: 'i', κ: 'k', μ: 'm', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'y', χ: 'x',
  l: 'i', '1': 'i', '|': 'i', '0': 'o',
};

/** What two names are compared by: NFKC, case-folded, lookalikes merged. */
export function nameKey(name: string): string {
  const folded = name.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFKC');
  return Array.from(folded, (c) => LOOKALIKES[c] ?? c).join('');
}

// ── Identity ─────────────────────────────────────────────────────────────

/** clientIds are the only proof of identity, so they must be long random strings. */
const CLIENT_ID = /^[A-Za-z0-9_-]{16,64}$/;
const PUBLIC_ID = /^[A-Za-z0-9_-]{16}$/;
const SAVED_CODE = /^[A-Z0-9]{4,16}$/;

/**
 * Teammates see a one-way hash of the clientId, scoped to the team: stable across
 * reconnects, but it can't be turned back into the clientId to impersonate someone.
 */
export const publicId = (idSalt: string, clientId: string) =>
  createHash('sha256').update(`${idSalt}:${clientId}`).digest('base64url').slice(0, 16);

/** What people type is forgiven case, spaces and dashes. */
const normalizeCode = (s: string) => s.toUpperCase().replace(/[\s-]/g, '');

// ── Addresses, hosts and origins ─────────────────────────────────────────

/**
 * The client's address. Behind a reverse proxy every socket comes from the
 * proxy, so with `trustProxy` the right-most X-Forwarded-For entry (the one
 * our proxy added) is used. Without it the header is ignored: anyone can send it.
 */
export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  if (!trustProxy) return peer;
  const header = req.headers['x-forwarded-for'];
  const last = (Array.isArray(header) ? header.join(',') : (header ?? '')).split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  return last && isIP(last) ? last : peer;
}

/**
 * The key per-address limits use. One machine usually gets a whole IPv6 /64,
 * so IPv6 addresses are grouped by it; IPv4-mapped addresses count as IPv4.
 */
export function addressKey(ip: string): string {
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) return ip.slice(7);
  const bare = ip.split('%')[0];
  if (isIP(bare) !== 6) return ip;
  const halves = bare.split('::');
  const groups = (s: string | undefined) => (s ? s.split(':') : []);
  const width = (g: string[]) => g.reduce((n, x) => n + (x.includes('.') ? 2 : 1), 0);
  const left = groups(halves[0]);
  const right = groups(halves[1]);
  const full = halves.length === 2 ? [...left, ...Array(8 - width(left) - width(right)).fill('0'), ...right] : left;
  return `${full.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/** The desktop app's own origins (macOS/Linux, Windows). */
const APP_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

export interface OriginPolicy {
  publicHosts?: string[];
  allowedOrigins?: string[];
  allowLocalhostPages?: boolean;
}

function parseHost(host: string | undefined): URL | null {
  if (!host) return null;
  try {
    return new URL(`http://${host}`);
  } catch {
    return null;
  }
}

const hostListed = (u: URL, p: OriginPolicy) =>
  (p.publicHosts ?? []).some((h) => h.toLowerCase() === u.hostname || h.toLowerCase() === u.host) ||
  (!!p.allowLocalhostPages && LOCAL_HOSTNAMES.includes(u.hostname));

/**
 * With SMOKE_BREAK_PUBLIC_HOST set, the request's Host must be one of those
 * names, so a DNS-rebound name pointing at the hub is turned away.
 */
export function isAllowedHost(host: string | undefined, policy: OriginPolicy): boolean {
  if (!policy.publicHosts?.length) return true;
  const u = parseHost(host);
  return !!u && hostListed(u, policy);
}

/**
 * Browsers send an Origin with every WebSocket, so this stops other web pages
 * from driving the hub. Allowed: the desktop app, SMOKE_BREAK_ALLOWED_ORIGINS,
 * and pages served from the same host only when that host is a configured
 * public host (or localhost, for the dev server). "Same host as the request"
 * alone isn't enough: DNS rebinding makes any page match it. Non-browser
 * clients send no Origin and are let through.
 */
export function isAllowedOrigin(origin: string | undefined, host: string | undefined, policy: OriginPolicy = {}): boolean {
  if (origin === undefined) return true;
  if (APP_ORIGINS.includes(origin) || (policy.allowedOrigins ?? []).includes(origin)) return true;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  const h = parseHost(host);
  return !!h && o.host === h.host && hostListed(o, policy);
}

// ── Saved teams ──────────────────────────────────────────────────────────

const randomRef = () => randomBytes(4).toString('hex');
const idList = (v: unknown, max: number) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && PUBLIC_ID.test(x)).slice(-max) : [];

/**
 * Checks every field of a saved team. Returns null for entries that can't be
 * used (no valid code); fixes up anything else rather than trusting it.
 */
export function parseSavedTeam(t: unknown, now: number): SavedTeam | null {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const r = t as Record<string, unknown>;
  if (typeof r.code !== 'string' || !SAVED_CODE.test(r.code)) return null;
  const lastActive = typeof r.lastActive === 'number' && Number.isFinite(r.lastActive) ? Math.min(r.lastActive, now) : now;
  return {
    code: r.code,
    idSalt: typeof r.idSalt === 'string' && r.idSalt.length > 0 && r.idSalt.length <= 64 ? r.idSalt : r.code,
    ref: typeof r.ref === 'string' && /^[0-9a-f]{8}$/.test(r.ref) ? r.ref : randomRef(),
    name: cleanName(r.name, 'My team'),
    defaultLengthMin: typeof r.defaultLengthMin === 'number' ? clampLength(r.defaultLengthMin) : DEFAULT_LENGTH_MIN,
    // Saved links get the same check (and canonical form) as new ones.
    zoomLink: normalizeMeetingLink(r.zoomLink ?? '') ?? '',
    meetingProvider: r.meetingProvider === 'zoom-api' ? 'zoom-api' : 'fixed-link',
    ownerId: typeof r.ownerId === 'string' && PUBLIC_ID.test(r.ownerId) ? r.ownerId : null,
    lastActive,
    known: idList(r.known, MAX_KNOWN),
    banned: idList(r.banned, MAX_BANNED),
  };
}

/** Writes via a temp file and rename, so a crash mid-write never leaves a half-written file. */
function writeAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // Zoom links can carry the meeting passcode, so only this user may read the file.
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600); // in case the temp file was left over with other permissions
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

type ErrorFrame = { type: 'error'; message: string; fatal?: boolean; code?: ErrorCode };

// ── The hub ──────────────────────────────────────────────────────────────

export function createHub(opts: HubOptions) {
  const limits: HubLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const accessToken = opts.accessToken ?? process.env.SMOKE_BREAK_ACCESS_TOKEN?.trim() ?? '';
  const tokenDigest = accessToken ? createHash('sha256').update(accessToken).digest() : null;
  const trustProxy = opts.trustProxy ?? envFlag(process.env.SMOKE_BREAK_TRUST_PROXY);
  const policy: OriginPolicy = {
    publicHosts: (opts.publicHosts ?? envList(process.env.SMOKE_BREAK_PUBLIC_HOST)).map((h) => h.toLowerCase()),
    allowedOrigins: opts.allowedOrigins ?? envList(process.env.SMOKE_BREAK_ALLOWED_ORIGINS),
    allowLocalhostPages: opts.allowLocalhostPages ?? false,
  };
  const log = opts.log ?? ((line: string) => console.log(line));

  const teams = new Map<string, Team>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxPayloadBytes, clientTracking: false });
  const conns = new Map<WebSocket, Conn>();
  const connectionsPerKey = new Map<string, number>();
  const creates = new WindowLimiter(limits.createsPerIpPerHour, HOUR_MS);
  const createsGlobal = new WindowLimiter(limits.createsPerHour, HOUR_MS);
  const badCodes = new WindowLimiter(limits.badCodesPerIp, BAD_CODE_WINDOW_MS);
  const badCodesGlobal = new WindowLimiter(limits.badCodes, BAD_CODE_WINDOW_MS);
  /** At most one log line per minute per limit and address, so a flood can't fill the disk. */
  const limitLogs = new WindowLimiter(1, 60_000);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  /** False when the data file couldn't be read or backed up: never overwrite what we couldn't read. */
  let persist = true;

  /** One JSON line per security-relevant event. Never codes, tokens, clientIds or links. */
  function audit(event: string, fields: Record<string, unknown> = {}) {
    try {
      log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
    } catch {
      // Logging must never take the hub down.
    }
  }
  function limitHit(kind: string, ip: string, key = ip) {
    if (limitLogs.take(`${kind}|${key}`)) audit('limit', { kind, ip });
  }

  function later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      timers.delete(t);
      guard(fn);
    }, ms);
    timers.add(t);
  }
  /** Runs a callback that may come from a timer: a bug is logged, never thrown out of the hub. */
  function guard(fn: () => void) {
    try {
      fn();
    } catch (err) {
      console.error('[smoke-break] internal error (ignored):', err);
    }
  }

  load();

  function load() {
    let text: string;
    try {
      text = readFileSync(opts.dataFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // No saved teams yet.
      persist = false;
      console.error(`[smoke-break] !!! Can't read ${opts.dataFile} (${(err as Error).message}). Teams will NOT be saved until this is fixed.`);
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    if (!Array.isArray(data)) return quarantine();
    const now = Date.now();
    let invalid = 0;
    let expired = 0;
    let droppedLinks = 0;
    for (const raw of data) {
      const t = parseSavedTeam(raw, now);
      if (!t || teams.has(t.code)) {
        invalid++;
        continue;
      }
      if (now - t.lastActive > limits.teamIdleDays * DAY_MS) {
        expired++;
        continue;
      }
      const rawLink = (raw as Record<string, unknown>).zoomLink;
      if (typeof rawLink === 'string' && rawLink !== '' && t.zoomLink === '') droppedLinks++;
      teams.set(t.code, {
        ...t,
        known: new Set(t.known),
        banned: new Set(t.banned),
        members: new Map(),
        brk: null,
        timer: null,
      });
    }
    if (invalid) console.error(`[smoke-break] !!! Skipped ${invalid} saved team(s) in ${opts.dataFile} that aren't valid.`);
    if (droppedLinks) console.warn(`[smoke-break] Dropped ${droppedLinks} saved meeting link(s) that aren't allowed Zoom links.`);
    audit('load', { teams: teams.size, invalid, expired, droppedLinks });
  }

  /** The file exists but isn't a team list: keep a copy before it can be overwritten. */
  function quarantine() {
    const backup = `${opts.dataFile}.corrupt-${Date.now()}`;
    try {
      copyFileSync(opts.dataFile, backup, fsConstants.COPYFILE_EXCL);
      chmodSync(backup, 0o600);
      console.error(`[smoke-break] !!! ${opts.dataFile} is not a valid team list. A copy is at ${backup}. Starting with no teams.`);
    } catch (err) {
      persist = false;
      console.error(
        `[smoke-break] !!! ${opts.dataFile} is not a valid team list and couldn't be backed up (${(err as Error).message}). Teams will NOT be saved until it is fixed or moved away.`,
      );
    }
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Call only when something saved actually changed. */
  function save() {
    if (!persist || saveTimer || closed) return;
    saveTimer = setTimeout(flush, limits.saveDelayMs);
  }
  /** Writes now if a save is pending. */
  function flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    const out: SavedTeam[] = [...teams.values()].map((t) => ({
      code: t.code,
      idSalt: t.idSalt,
      ref: t.ref,
      name: t.name,
      defaultLengthMin: t.defaultLengthMin,
      zoomLink: t.zoomLink,
      meetingProvider: t.meetingProvider,
      ownerId: t.ownerId,
      lastActive: t.lastActive,
      known: [...t.known],
      banned: [...t.banned],
    }));
    try {
      writeAtomic(opts.dataFile, JSON.stringify(out, null, 2));
    } catch (err) {
      console.error(`[smoke-break] !!! Saving teams to ${opts.dataFile} failed:`, err);
    }
  }

  /** Bumps a team's last-used time, but only saves it now and then. */
  function touch(team: Team) {
    const now = Date.now();
    if (now - team.lastActive < limits.lastActiveResolutionMs) return;
    team.lastActive = now;
    save();
  }

  function forget(team: Team) {
    if (team.timer) clearTimeout(team.timer);
    for (const m of team.members.values()) if (m.leaveTimer) clearTimeout(m.leaveTimer);
    teams.delete(team.code);
  }

  /**
   * Makes room for a new team by forgetting the least recently used empty one,
   * but never one used in the last `teamKeepDays`: then the new team is refused.
   */
  function roomForTeam(): boolean {
    if (teams.size < limits.maxTeams) return true;
    const keepAfter = Date.now() - limits.teamKeepDays * DAY_MS;
    let stalest: Team | null = null;
    for (const t of teams.values()) {
      if (t.members.size || t.brk || t.lastActive > keepAfter) continue;
      if (!stalest || t.lastActive < stalest.lastActive) stalest = t;
    }
    if (!stalest) return false;
    forget(stalest);
    audit('team-forgotten', { team: stalest.ref, reason: 'room for a new team' });
    save();
    return true;
  }

  function newCode(): string {
    let code: string;
    do {
      code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (teams.has(code));
    return code;
  }

  function view(team: Team): TeamView {
    return {
      code: team.code,
      name: team.name,
      defaultLengthMin: team.defaultLengthMin,
      // Only the owner gets the link itself (see broadcast); members get it in brk.meetingUrl during a break.
      zoomLink: '',
      hasZoomLink: team.zoomLink !== '',
      meetingProvider: team.meetingProvider,
      ownerId: team.ownerId,
      members: [...team.members.values()].map((m) => ({ id: m.id, name: m.name, online: m.sockets.size > 0 })),
      brk: team.brk,
    };
  }

  /** Drops sockets that have stopped reading instead of buffering for them without limit. */
  function sendRaw(ws: WebSocket, frame: string) {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > limits.maxBufferedBytes) {
      const c = conns.get(ws);
      if (c) limitHit('send-buffer', c.ip, c.key);
      ws.terminate();
      return;
    }
    ws.send(frame);
  }

  function sendError(ws: WebSocket, message: string, fatal = false, code?: ErrorCode) {
    const msg: ErrorFrame = { type: 'error', message };
    if (fatal) msg.fatal = true;
    if (code) msg.code = code;
    sendRaw(ws, JSON.stringify(msg));
  }

  /** The team view is serialized once (twice if the owner is online), not once per socket. */
  function broadcast(team: Team) {
    const v = view(team);
    const memberJson = JSON.stringify(v);
    let ownerJson: string | null = null;
    const serverNow = Date.now();
    for (const m of team.members.values()) {
      if (!m.sockets.size) continue;
      const teamJson = m.id === team.ownerId ? (ownerJson ??= JSON.stringify({ ...v, zoomLink: team.zoomLink })) : memberJson;
      const frame = `{"type":"state","team":${teamJson},"you":${JSON.stringify(m.id)},"serverNow":${serverNow}}`;
      for (const ws of m.sockets) sendRaw(ws, frame);
    }
  }

  function schedule(team: Team) {
    if (team.timer) clearTimeout(team.timer);
    team.timer = null;
    const deadline = machine.nextDeadline(team.brk);
    if (deadline === null) return;
    team.timer = setTimeout(() => {
      team.timer = null;
      guard(() => apply(team, machine.tick(team.brk, Date.now())));
    }, Math.max(0, deadline - Date.now()) + 5);
  }

  function apply(team: Team, result: machine.Result, ws?: WebSocket) {
    if (result.error) {
      if (ws) sendError(ws, result.error);
      return;
    }
    team.brk = result.brk;
    for (const effect of result.effects) runEffect(team, effect);
    schedule(team);
    broadcast(team);
  }

  function runEffect(team: Team, effect: machine.Effect) {
    const brk = team.brk;
    if (!brk) return;
    const ctx = { teamCode: team.code, breakId: brk.id, zoomLink: team.zoomLink };
    const provider = getProvider(team.meetingProvider);
    if (effect.type === 'meeting:start') {
      provider
        .startMeeting(ctx)
        .catch((err: unknown) => {
          console.warn(`[smoke-break] ${team.meetingProvider} failed for team ${team.ref}; using the fixed link.`, err);
          return null;
        })
        // Fallback: use the fixed link so a break always starts.
        .then((url) => url ?? fixedLinkProvider.startMeeting(ctx))
        .then((url) => {
          if (team.brk?.id !== brk.id) return;
          // Everyone's machine opens this link, so it gets the same check as the team setting, and only its canonical form is sent.
          const link = normalizeMeetingLink(url ?? '');
          if (link === null) console.warn(`[smoke-break] ignoring a meeting link that isn't an allowed Zoom URL (team ${team.ref}).`);
          team.brk = { ...team.brk, meetingUrl: link || null };
          broadcast(team);
        })
        .catch((err: unknown) => console.error('[smoke-break] internal error (ignored):', err));
    } else {
      provider.endMeeting(ctx).catch((err: unknown) => {
        console.warn(`[smoke-break] ending the ${team.meetingProvider} meeting failed for team ${team.ref}.`, err);
      });
    }
  }

  /** Two people can't share a display name (compared without case, width or lookalike tricks), so nobody can pass as someone else. */
  function uniqueName(team: Team, key: string, name: string) {
    const taken = new Set([...team.members.values()].filter((m) => m.key !== key).map((m) => nameKey(m.name)));
    for (let n = 2, candidate = name; ; n++) {
      if (!taken.has(nameKey(candidate))) return candidate;
      const suffix = ` ${n}`;
      candidate = Array.from(name).slice(0, NAME_MAX - suffix.length).join('') + suffix;
    }
  }

  function remember(team: Team, id: string) {
    if (team.known.has(id)) return;
    team.known.add(id);
    if (team.known.size > MAX_KNOWN) team.known.delete(team.known.values().next().value!);
    save();
  }

  function attach(team: Team, ws: WebSocket, clientId: string, name: string) {
    let m = team.members.get(clientId);
    if (!m) {
      m = { key: clientId, id: publicId(team.idSalt, clientId), name, sockets: new Set(), leaveTimer: null, lastInviteAt: -Infinity };
      team.members.set(clientId, m);
    }
    // Teams saved before owners existed: the first person back becomes the owner.
    if (team.ownerId === null) {
      team.ownerId = m.id;
      save();
    }
    remember(team, m.id);
    touch(team);
    m.name = uniqueName(team, clientId, name);
    m.sockets.add(ws);
    if (m.leaveTimer) clearTimeout(m.leaveTimer);
    m.leaveTimer = null;
    broadcast(team);
    return m;
  }

  function detach(team: Team, m: Member, ws: WebSocket) {
    m.sockets.delete(ws);
    if (m.sockets.size === 0) {
      // A team in use right up to now shouldn't look idle just because nobody reconnected since.
      touch(team);
      m.leaveTimer = setTimeout(() => {
        m.leaveTimer = null;
        guard(() => {
          if (m.sockets.size > 0 || team.members.get(m.key) !== m) return;
          team.members.delete(m.key);
          apply(team, machine.leave(team.brk, m.id, Date.now()));
        });
      }, limits.disconnectGraceMs);
    }
    broadcast(team);
  }

  /** Refuses a create/hello: a fatal error (after `delayMs`), then the socket is closed. */
  function refuse(conn: Conn, ws: WebSocket, message: string, code: ErrorCode | undefined, reason: string, delayMs = 0) {
    conn.state = delayMs ? 'pending' : 'done';
    audit('join-failed', { ip: conn.ip, reason });
    const go = () => {
      conn.state = 'done';
      sendError(ws, message, true, code);
      ws.close(1008, reason.slice(0, 100));
    };
    if (delayMs) later(go, delayMs);
    else go();
  }

  const tokenOk = (given: unknown) =>
    !tokenDigest || (typeof given === 'string' && timingSafeEqual(createHash('sha256').update(given).digest(), tokenDigest));

  function onHello(conn: Conn, ws: WebSocket, msg: Record<string, unknown>) {
    if (conn.state !== 'new') return;
    if (!tokenOk(msg.token)) {
      return refuse(conn, ws, 'This hub needs an access token. Ask whoever runs it.', 'unauthorized', 'unauthorized');
    }
    const clientId = typeof msg.clientId === 'string' ? msg.clientId : '';
    if (!CLIENT_ID.test(clientId)) return refuse(conn, ws, 'Invalid client id.', undefined, 'invalid-client-id');
    const name = cleanName(msg.name, 'Someone');
    let team: Team;

    if (msg.type === 'create') {
      if (!creates.take(conn.key)) {
        limitHit('creates-per-ip', conn.ip, conn.key);
        return refuse(conn, ws, 'Too many new teams. Try again later.', 'rate-limited', 'creates-per-ip');
      }
      if (!createsGlobal.take('*')) {
        limitHit('creates-global', conn.ip, '*');
        return refuse(conn, ws, 'Too many new teams on this server. Try again later.', 'rate-limited', 'creates-global');
      }
      if (!roomForTeam()) {
        limitHit('teams-full', conn.ip, '*');
        return refuse(conn, ws, 'This server is full. Try again later.', 'full', 'teams-full');
      }
      const code = newCode();
      team = {
        code,
        idSalt: code,
        ref: randomRef(),
        name: cleanName(msg.teamName, 'My team'),
        defaultLengthMin: DEFAULT_LENGTH_MIN,
        zoomLink: '',
        meetingProvider: 'fixed-link',
        ownerId: publicId(code, clientId),
        known: new Set(),
        banned: new Set(),
        members: new Map(),
        lastActive: Date.now(),
        brk: null,
        timer: null,
      };
      teams.set(code, team);
      save();
      audit('create', { ip: conn.ip, team: team.ref, member: team.ownerId, name });
    } else {
      const code = typeof msg.teamCode === 'string' && msg.teamCode.length <= 64 ? normalizeCode(msg.teamCode) : '';
      const found = code ? teams.get(code) : undefined;
      const id = found ? publicId(found.idSalt, clientId) : '';
      // Someone this team already knows, with the right code, isn't guessing: the lockout doesn't apply to them.
      // (Teams saved before `known` existed start with only their owner known.)
      const returning = !!found && (found.known.has(id) || found.ownerId === id);
      const blocked = badCodes.blocked(conn.key) || badCodesGlobal.blocked('*');
      if (blocked && !returning) {
        limitHit('bad-codes', conn.ip, conn.key);
        return refuse(conn, ws, 'Too many wrong invite codes. Try again in a few minutes.', 'rate-limited', 'locked-out', limits.badCodeDelayMs);
      }
      if (!found) {
        const counted = badCodes.take(conn.key) && badCodesGlobal.take('*');
        if (!counted) limitHit('bad-codes', conn.ip, conn.key);
        return counted
          ? refuse(conn, ws, 'No team with that invite code.', 'bad-code', 'bad-code', limits.badCodeDelayMs)
          : refuse(conn, ws, 'Too many wrong invite codes. Try again in a few minutes.', 'rate-limited', 'locked-out', limits.badCodeDelayMs);
      }
      if (found.banned.has(id)) {
        return refuse(conn, ws, 'You were removed from this team.', 'removed', 'removed', limits.badCodeDelayMs);
      }
      if (!found.members.has(clientId) && found.members.size >= limits.maxMembersPerTeam) {
        limitHit('members-per-team', conn.ip, found.ref);
        return refuse(conn, ws, 'This team is full.', 'full', 'team-full');
      }
      team = found;
    }

    clearTimeout(conn.helloTimer);
    conn.state = 'joined';
    conn.team = team;
    conn.me = attach(team, ws, clientId, name);
    if (msg.type === 'hello') audit('join', { ip: conn.ip, team: team.ref, member: conn.me.id, name: conn.me.name });
  }

  function settings(team: Team, me: Member, ws: WebSocket, conn: Conn, msg: Record<string, unknown>) {
    if (me.id !== team.ownerId) return sendError(ws, 'Only the team owner can change settings.');
    // Check everything first, so a bad field changes nothing.
    let link: string | undefined;
    if (msg.zoomLink !== undefined) {
      const normalized = typeof msg.zoomLink === 'string' ? normalizeMeetingLink(msg.zoomLink.trim()) : null;
      if (normalized === null) return sendError(ws, 'The Zoom link must be an https://…zoom.us link.');
      link = normalized;
    }
    if (msg.defaultLengthMin !== undefined && typeof msg.defaultLengthMin !== 'number') {
      return sendError(ws, 'The default length must be a number of minutes.');
    }
    if (msg.teamName !== undefined && typeof msg.teamName !== 'string') return sendError(ws, 'The team name must be text.');

    const changed: string[] = [];
    if (link !== undefined && link !== team.zoomLink) {
      team.zoomLink = link;
      changed.push('zoomLink');
      // Fixed links are known up front, so an active break picks up the new one.
      if (team.meetingProvider === 'fixed-link' && team.brk?.meetingRequested) {
        team.brk = { ...team.brk, meetingUrl: link || null };
      }
    }
    if (typeof msg.defaultLengthMin === 'number') {
      const len = clampLength(msg.defaultLengthMin);
      if (len !== team.defaultLengthMin) (team.defaultLengthMin = len), changed.push('defaultLengthMin');
    }
    if (typeof msg.teamName === 'string') {
      const name = cleanName(msg.teamName, team.name);
      if (name !== team.name) (team.name = name), changed.push('teamName');
    }
    if (changed.length) {
      save();
      audit('settings', { ip: conn.ip, team: team.ref, member: me.id, changed });
    }
    broadcast(team);
  }

  function rotateCode(team: Team, me: Member, ws: WebSocket, conn: Conn) {
    if (me.id !== team.ownerId) return sendError(ws, 'Only the team owner can change the invite code.');
    teams.delete(team.code);
    team.code = newCode();
    teams.set(team.code, team);
    save();
    audit('rotate-code', { ip: conn.ip, team: team.ref, member: me.id });
    broadcast(team);
  }

  function removeMember(team: Team, me: Member, ws: WebSocket, conn: Conn, msg: Record<string, unknown>) {
    if (me.id !== team.ownerId) return sendError(ws, 'Only the team owner can remove people.');
    const id = typeof msg.id === 'string' ? msg.id : '';
    if (id === me.id) return sendError(ws, "You can't remove yourself.");
    const target = [...team.members.values()].find((m) => m.id === id);
    if (!PUBLIC_ID.test(id) || (!target && !team.known.has(id))) return sendError(ws, 'No such member.');

    team.banned.add(id);
    if (team.banned.size > MAX_BANNED) team.banned.delete(team.banned.values().next().value!);
    team.known.delete(id);
    if (target) {
      team.members.delete(target.key);
      if (target.leaveTimer) clearTimeout(target.leaveTimer);
      for (const s of target.sockets) {
        const c = conns.get(s);
        if (c) (c.state = 'done'), (c.team = null), (c.me = null);
        sendError(s, 'You were removed from this team.', true, 'removed');
        s.close(1008, 'removed');
      }
      target.sockets.clear();
    }
    save();
    audit('remove-member', { ip: conn.ip, team: team.ref, member: me.id, removed: id });
    const left = machine.leave(team.brk, id, Date.now());
    if (left.error) broadcast(team);
    else apply(team, left);
  }

  function handle(conn: Conn, ws: WebSocket, msg: Record<string, unknown>) {
    const team = conn.team!;
    const me = conn.me!;
    const now = Date.now();
    const who = { id: me.id, name: me.name };
    switch (msg.type) {
      case 'invite': {
        const starting = !machine.isActive(team.brk);
        if (starting && now - me.lastInviteAt < limits.breakCooldownMs) {
          limitHit('break-cooldown', conn.ip, me.id);
          return sendError(ws, 'Wait a few seconds before starting another break.');
        }
        if (starting) me.lastInviteAt = now;
        return apply(team, machine.invite(team.brk, who, team.defaultLengthMin, now, randomUUID(), MINUTE_MS), ws);
      }
      case 'setLength':
        if (typeof msg.lengthMin !== 'number') return sendError(ws, 'The length must be a number of minutes.');
        return apply(team, machine.setLength(team.brk, me.id, msg.lengthMin), ws);
      case 'join':
        return apply(team, machine.join(team.brk, who, now, msg.light === true), ws);
      case 'light':
        return apply(team, machine.lightUp(team.brk, me.id, now), ws);
      case 'leave':
        return apply(team, machine.leave(team.brk, me.id, now), ws);
      case 'settings':
        return settings(team, me, ws, conn, msg);
      case 'rotateCode':
        return rotateCode(team, me, ws, conn);
      case 'removeMember':
        return removeMember(team, me, ws, conn, msg);
    }
  }

  function onMessage(conn: Conn, ws: WebSocket, raw: RawData, isBinary: boolean, bucket: TokenBucket) {
    if (!bucket.take()) {
      if (++conn.dropped > MAX_DROPPED_MESSAGES) {
        limitHit('message-flood', conn.ip, conn.key);
        ws.close(1008, 'Too many messages');
      }
      return;
    }
    if (isBinary) return;
    let data: unknown;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const msg = data as Record<string, unknown>;
    if (msg.type === 'create' || msg.type === 'hello') return onHello(conn, ws, msg);
    if (conn.state === 'joined' && conn.team && conn.me) handle(conn, ws, msg);
  }

  function onConnection(ws: WebSocket, ip: string, key: string) {
    const conn: Conn = {
      ip,
      key,
      alive: true,
      state: 'new',
      team: null,
      me: null,
      dropped: 0,
      // A socket that never says who it is would otherwise hold a connection slot forever.
      helloTimer: setTimeout(() => {
        if (conn.state !== 'new') return;
        limitHit('hello-timeout', ip, key);
        ws.terminate();
      }, limits.helloTimeoutMs),
    };
    conns.set(ws, conn);
    connectionsPerKey.set(key, (connectionsPerKey.get(key) ?? 0) + 1);
    const bucket = new TokenBucket(limits.messageBurst, limits.messagesPerSecond);
    // e.g. an oversized frame. ws closes the socket itself; without a listener the error would crash the hub.
    ws.on('error', () => {});
    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (raw, isBinary) => guard(() => onMessage(conn, ws, raw, isBinary, bucket)));
    ws.on('close', () =>
      guard(() => {
        clearTimeout(conn.helloTimer);
        conns.delete(ws);
        const n = (connectionsPerKey.get(key) ?? 1) - 1;
        if (n > 0) connectionsPerKey.set(key, n);
        else connectionsPerKey.delete(key);
        const { team, me } = conn;
        // Removed members were already taken out; don't touch whoever has their slot now.
        if (team && me && team.members.get(me.key) === me) detach(team, me, ws);
      }),
    );
  }

  /** Laptops that sleep leave dead sockets behind; a missed pong drops them. */
  const heartbeat = setInterval(() => {
    for (const [ws, conn] of conns) {
      if (!conn.alive) {
        ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, limits.pingIntervalMs);
  heartbeat.unref();

  const reject = (socket: Duplex, status: string) =>
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);

  return {
    /** Writes any pending save now. */
    flush,
    /** Stops timers, closes every socket and writes any pending save. */
    close() {
      if (closed) return;
      flush();
      closed = true;
      clearInterval(heartbeat);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const team of teams.values()) {
        if (team.timer) clearTimeout(team.timer);
        for (const m of team.members.values()) if (m.leaveTimer) clearTimeout(m.leaveTimer);
      }
      for (const [ws, conn] of conns) {
        clearTimeout(conn.helloTimer);
        ws.close(1001, 'Hub shutting down');
      }
      wss.close();
    },
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      // Node leaves upgrade sockets without an error listener; a client reset would otherwise crash the hub.
      socket.on('error', () => {});
      try {
        if (closed) return reject(socket, '503 Service Unavailable');
        const ip = clientAddress(req, trustProxy);
        if (!isAllowedHost(req.headers.host, policy) || !isAllowedOrigin(req.headers.origin, req.headers.host, policy)) {
          limitHit('origin', ip);
          return reject(socket, '403 Forbidden');
        }
        const key = addressKey(ip);
        if (conns.size >= limits.maxConnections) {
          limitHit('connections-total', ip, '*');
          return reject(socket, '503 Service Unavailable');
        }
        if ((connectionsPerKey.get(key) ?? 0) >= limits.connectionsPerIp) {
          limitHit('connections-per-ip', ip, key);
          return reject(socket, '429 Too Many Requests');
        }
        wss.handleUpgrade(req, socket, head, (ws) => guard(() => onConnection(ws, ip, key)));
      } catch (err) {
        console.error('[smoke-break] internal error during upgrade (ignored):', err);
        socket.destroy();
      }
    },
  };
}
