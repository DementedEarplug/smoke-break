// Realtime hub: one shared break per team, broadcast to every connected pack.
// The server owns the clock: every deadline is scheduled here.

import { createHash, randomInt, randomUUID } from 'node:crypto';
import { chmodSync, constants as fsConstants, copyFileSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { dirname } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  type Break,
  DEFAULT_LENGTH_MIN,
  type ErrorCode,
  type MeetingProviderKind,
  type MemberView,
  type TeamView,
  clampLength,
  normalizeMeetingLink,
} from '../shared/protocol.ts';
import { AccessTokens } from './accessTokens.ts';
import {
  type OriginPolicy,
  type TrustedProxies,
  addressKey,
  clientAddress,
  isAllowedHost,
  isAllowedOrigin,
  parseTrustedProxies,
} from './addresses.ts';
import { type AuditLimits, createAuditLog } from './audit.ts';
import * as machine from './breakMachine.ts';
import { TokenBucket, WindowLimiter } from './limits.ts';
import { fixedLinkProvider, getProvider } from './meeting.ts';
import { cleanName, nameKey, uniqueName } from './names.ts';
import {
  type BanReason,
  MAX_ALIASES,
  PUBLIC_ID,
  type SavedTeam,
  checkDataDir,
  isLegacyEntry,
  parseSavedTeam,
  randomRef,
  writeAtomic,
} from './persistence.ts';

export { addressKey, clientAddress, isAllowedHost, isAllowedOrigin, parseTrustedProxies } from './addresses.ts';
export { cleanName, nameKey } from './names.ts';
export { dataFileFromEnv, parseSavedTeam, type SavedTeam } from './persistence.ts';

/** Dev demo mode: e.g. SMOKE_BREAK_MINUTE_MS=3000 makes a 12-minute break last 36 seconds. */
const MINUTE_MS = Number(process.env.SMOKE_BREAK_MINUTE_MS) || 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** 32^10 = 2^50 codes. Shorter codes from older hubs are replaced on load (and kept as aliases for the roster). */
const CODE_LENGTH = 10;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const BAD_CODE_WINDOW_MS = 600_000;
/** Removed and turned-away people per team, so the saved file stays small. */
const MAX_BANNED = 1000;
/** Per-address message budgets kept; the least recently used are dropped beyond this. */
const MAX_ADDRESS_BUCKETS = 50_000;

/** A positive integer from the environment, or the fallback. */
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
const envList = (s: string | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

export interface HubLimits extends AuditLimits {
  /** Largest WebSocket message accepted; real messages are well under 1 KiB. */
  maxPayloadBytes: number;
  maxTeams: number;
  /** Saved teams nobody has used for this long are forgotten. */
  teamIdleDays: number;
  /** A team used within this many days is never forgotten to make room; new teams are refused instead. */
  teamKeepDays: number;
  /** A team nobody but its creator ever joined, idle this long, is the first to go when the hub is full. */
  junkTeamIdleMs: number;
  createsPerIpPerHour: number;
  /** New teams per hour across the whole hub from connections without a per-person token. */
  createsPerHour: number;
  /** New teams per day for each per-person token label (instead of the hub-wide limit). */
  createsPerLabelPerDay: number;
  /** Wrong invite codes allowed per address every 10 minutes, so codes can't be guessed. */
  badCodesPerIp: number;
  /** Delay before saying a code is wrong. */
  badCodeDelayMs: number;
  /** Each desktop app holds two connections, so this is about twice the people behind one address. */
  connectionsPerIp: number;
  maxConnections: number;
  /** Roster size: people who belong to a team, online or not. */
  maxMembersPerTeam: number;
  /** Open sockets one person may hold in a team; one more closes their oldest. */
  maxSocketsPerMember: number;
  /** Identities (roster entries plus join requests) one token label may hold in a team. */
  identitiesPerLabel: number;
  /** Join requests waiting for the owner, per team. */
  maxPending: number;
  /** Of those, how many may come from one address. */
  pendingPerIp: number;
  /** New join requests one address may make per hour, across all teams. */
  pendingRequestsPerIpPerHour: number;
  /** Unanswered join requests are dropped after this long. */
  pendingTtlMs: number;
  /** Per-socket message rate: bursts of `messageBurst`, then `messagesPerSecond`. */
  messageBurst: number;
  messagesPerSecond: number;
  /** Message budget shared by all sockets from one address. */
  addressMessageBurst: number;
  addressMessagesPerSecond: number;
  /** A socket with more than this waiting to be sent has stopped reading and is dropped. */
  maxBufferedBytes: number;
  /** Waiting to be sent across all sockets; over this, the sockets with the most waiting are dropped. */
  maxTotalBufferedBytes: number;
  /** How often the total is checked (it is also checked when sends add up past the limit). */
  bufferCheckMs: number;
  /** A team's state goes out at most this often; the last change always goes out. */
  broadcastIntervalMs: number;
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
  /** How often expired join requests are cleared. */
  housekeepingMs: number;
  /** How often the per-person tokens file is checked for changes. */
  tokensPollMs: number;
}

export const DEFAULT_LIMITS: HubLimits = {
  maxPayloadBytes: 16 * 1024,
  maxTeams: envInt('SMOKE_BREAK_MAX_TEAMS', 2000),
  teamIdleDays: 90,
  teamKeepDays: 7,
  junkTeamIdleMs: DAY_MS,
  createsPerIpPerHour: 10,
  createsPerHour: 100,
  createsPerLabelPerDay: 20,
  badCodesPerIp: 20,
  badCodeDelayMs: 500,
  // An office behind one NAT or proxy address: ~250 people with the app open.
  connectionsPerIp: envInt('SMOKE_BREAK_CONNECTIONS_PER_IP', 500),
  maxConnections: envInt('SMOKE_BREAK_MAX_CONNECTIONS', 10_000),
  maxMembersPerTeam: 200,
  maxSocketsPerMember: 4,
  identitiesPerLabel: envInt('SMOKE_BREAK_IDENTITIES_PER_LABEL', 3),
  maxPending: 20,
  pendingPerIp: 3,
  pendingRequestsPerIpPerHour: 20,
  pendingTtlMs: 3 * DAY_MS,
  messageBurst: 30,
  messagesPerSecond: 10,
  // After a hub restart a whole office reconnects at once: one hello per socket.
  addressMessageBurst: 600,
  addressMessagesPerSecond: 50,
  maxBufferedBytes: 256 * 1024,
  maxTotalBufferedBytes: 64 * 1024 * 1024,
  bufferCheckMs: 1000,
  broadcastIntervalMs: 150,
  pingIntervalMs: 30_000,
  helloTimeoutMs: 10_000,
  disconnectGraceMs: 20_000,
  breakCooldownMs: 10_000,
  saveDelayMs: 200,
  lastActiveResolutionMs: HOUR_MS,
  housekeepingMs: HOUR_MS,
  tokensPollMs: 2000,
  auditLinesPerSecond: 50,
  auditBurst: 200,
  auditPerKeyPerMinute: 5,
  auditSummaryMs: 60_000,
};
/** A socket that keeps flooding after being throttled this many times is closed. */
const MAX_DROPPED_MESSAGES = 50;

export interface HubOptions {
  dataFile: string;
  limits?: Partial<HubLimits>;
  /** A token shared by everyone; create/hello must carry it (or a per-person one). Default: SMOKE_BREAK_ACCESS_TOKEN. */
  accessToken?: string;
  /** File of `label:token` lines, one per person or group. Default: SMOKE_BREAK_ACCESS_TOKENS_FILE. */
  accessTokensFile?: string;
  /**
   * Reverse proxies whose X-Forwarded-For is believed: IPs and CIDR ranges, or
   * true for loopback only. Default: SMOKE_BREAK_TRUST_PROXY.
   */
  trustProxy?: boolean | string | string[];
  /** Hostnames the hub answers to. Default: SMOKE_BREAK_PUBLIC_HOST (comma-separated). */
  publicHosts?: string[];
  /** Extra web origins allowed to connect. Default: SMOKE_BREAK_ALLOWED_ORIGINS (comma-separated). */
  allowedOrigins?: string[];
  /** Dev server only: accept pages served from localhost by the same server. */
  allowLocalhostPages?: boolean;
  /** Where audit lines go. Default: stdout. */
  log?: (line: string) => void;
}

/** One person online in a team (with one or more sockets). */
interface Member {
  /** Public id shown to teammates and used in breaks. */
  id: string;
  sockets: Set<WebSocket>;
  leaveTimer: ReturnType<typeof setTimeout> | null;
  lastInviteAt: number;
}

interface RosterEntry {
  id: string;
  /** '' until someone migrated from an older hub reconnects. */
  name: string;
  label: string | null;
}

interface BanEntry {
  id: string;
  label: string | null;
  reason: BanReason;
}

interface PendingEntry {
  id: string;
  name: string;
  label: string | null;
  at: number;
  /** Address key it came from (not saved). */
  addr: string | null;
}

interface Team {
  code: string;
  /** Earlier codes, oldest first: they only let in people on the roster. */
  aliases: string[];
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
  /** Public id of the owner, the only one who can change team settings and who's on the team. */
  ownerId: string | null;
  requireApproval: boolean;
  /** Everyone who belongs to the team, by public id, oldest first. */
  roster: Map<string, RosterEntry>;
  /** People the owner removed or turned away. They can't rejoin. */
  banned: Map<string, BanEntry>;
  /** People waiting for the owner to let them in. */
  pending: Map<string, PendingEntry>;
  /** Roster members with open sockets (or within the disconnect grace period), by public id. */
  online: Map<string, Member>;
  /** Last time anyone connected or left, or the team was created (ms). */
  lastActive: number;
  brk: Break | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** A state broadcast is queued. */
  bcastQueued: boolean;
  bcastTimer: ReturnType<typeof setTimeout> | null;
  lastBroadcastAt: number;
}

/** One open socket. */
interface Conn {
  /** Client address, for logs. */
  ip: string;
  /** Address used for per-address limits (IPv6 grouped by /64). */
  key: string;
  alive: boolean;
  /** new → (refusing, while a refusal is delayed) → joined, or done once refused or removed. */
  state: 'new' | 'refusing' | 'joined' | 'done';
  team: Team | null;
  me: Member | null;
  /** Per-person token label, if it used one. */
  label: string | null;
  /** Which token let it in, so revoking that token closes it. */
  tokenDigest: Buffer | null;
  helloTimer: ReturnType<typeof setTimeout>;
  /** Messages dropped by the rate limits. */
  dropped: number;
}

// ── Identity ─────────────────────────────────────────────────────────────

/** clientIds are the only proof of identity, so they must be long random strings. */
const CLIENT_ID = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Teammates see a one-way hash of the clientId, scoped to the team: stable across
 * reconnects, but it can't be turned back into the clientId to impersonate someone.
 */
export const publicId = (idSalt: string, clientId: string) =>
  createHash('sha256').update(`${idSalt}:${clientId}`).digest('base64url').slice(0, 16);

/** What people type is forgiven case, spaces and dashes. */
const normalizeCode = (s: string) => s.toUpperCase().replace(/[\s-]/g, '');

const sameBreak = (a: Break | null, b: Break | null) => a === b || JSON.stringify(a) === JSON.stringify(b);

type ErrorFrame = { type: 'error'; message: string; fatal?: boolean; code?: ErrorCode };

// ── The hub ──────────────────────────────────────────────────────────────

export function createHub(opts: HubOptions) {
  const limits: HubLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const log = opts.log ?? ((line: string) => console.log(line));
  // Anything misconfigured throws here, before any timer starts or socket is accepted.
  checkDataDir(dirname(opts.dataFile));
  const trusted: TrustedProxies = parseTrustedProxies(opts.trustProxy ?? process.env.SMOKE_BREAK_TRUST_PROXY);
  const tokens = new AccessTokens({
    shared: opts.accessToken ?? process.env.SMOKE_BREAK_ACCESS_TOKEN?.trim() ?? '',
    file: opts.accessTokensFile ?? process.env.SMOKE_BREAK_ACCESS_TOKENS_FILE?.trim() ?? '',
    pollMs: limits.tokensPollMs,
    onReload: (valid) => guard(() => closeRevoked(valid)),
    log: (event, fields) => audit(event, fields),
  });
  const auditLog = createAuditLog(log, limits);
  const audit = auditLog.audit;
  const policy: OriginPolicy = {
    publicHosts: (opts.publicHosts ?? envList(process.env.SMOKE_BREAK_PUBLIC_HOST)).map((h) => h.toLowerCase()),
    allowedOrigins: opts.allowedOrigins ?? envList(process.env.SMOKE_BREAK_ALLOWED_ORIGINS),
    allowLocalhostPages: opts.allowLocalhostPages ?? false,
  };

  const teams = new Set<Team>();
  /** Current invite codes. */
  const codes = new Map<string, Team>();
  /** Earlier codes that still work for people on the roster. */
  const aliasCodes = new Map<string, Team>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxPayloadBytes, clientTracking: false });
  const conns = new Map<WebSocket, Conn>();
  const connectionsPerKey = new Map<string, number>();
  const addressBuckets = new Map<string, TokenBucket>();
  const creates = new WindowLimiter(limits.createsPerIpPerHour, HOUR_MS);
  const createsGlobal = new WindowLimiter(limits.createsPerHour, HOUR_MS);
  const createsPerLabel = new WindowLimiter(limits.createsPerLabelPerDay, DAY_MS);
  const badCodes = new WindowLimiter(limits.badCodesPerIp, BAD_CODE_WINDOW_MS);
  const joinRequests = new WindowLimiter(limits.pendingRequestsPerIpPerHour, HOUR_MS);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  /** False when the data file couldn't be read or backed up: never overwrite what we couldn't read. */
  let persist = true;

  const who = (c: Conn) => (c.label ? { ip: c.ip, label: c.label } : { ip: c.ip });
  /** Owners can repeat harmless actions as fast as the rate limits allow; their lines are throttled per team too. */
  const ownerThrottle = (event: string, team: Team, me: Member) => ({ key: `${event}|${team.ref}|${me.id}`, perMinute: 20 });
  /** Limit hits are logged at most once a minute per limit and address. */
  function limitHit(kind: string, c: { ip: string; label?: string | null }, key = c.ip) {
    audit('limit', c.label ? { kind, ip: c.ip, label: c.label } : { kind, ip: c.ip }, { key: `limit|${kind}|${key}`, perMinute: 1 });
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

  // ── Codes ──────────────────────────────────────────────────────────────

  function newCode(): string {
    let code: string;
    do {
      code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (codes.has(code) || aliasCodes.has(code));
    return code;
  }

  /** Gives the team a new code; the old one becomes an alias that only works for the roster. */
  function replaceCode(team: Team) {
    const old = team.code;
    codes.delete(old);
    team.aliases.push(old);
    aliasCodes.set(old, team);
    while (team.aliases.length > MAX_ALIASES) aliasCodes.delete(team.aliases.shift()!);
    team.code = newCode();
    codes.set(team.code, team);
  }

  // ── Loading and saving ─────────────────────────────────────────────────

  function fromSaved(t: SavedTeam): Team {
    return {
      ...t,
      roster: new Map(t.roster.map((m) => [m.id, { id: m.id, name: m.name, label: m.label ?? null }])),
      banned: new Map(t.banned.map((b) => [b.id, { id: b.id, label: b.label ?? null, reason: b.reason }])),
      pending: new Map(t.pending.map((p) => [p.id, { id: p.id, name: p.name, label: p.label ?? null, at: p.at, addr: null }])),
      online: new Map(),
      brk: null,
      timer: null,
      bcastQueued: false,
      bcastTimer: null,
      lastBroadcastAt: 0,
    };
  }

  function toSaved(t: Team): SavedTeam {
    const withLabel = <T extends object>(x: T, label: string | null) => (label ? { ...x, label } : x);
    return {
      code: t.code,
      aliases: [...t.aliases],
      idSalt: t.idSalt,
      ref: t.ref,
      name: t.name,
      defaultLengthMin: t.defaultLengthMin,
      zoomLink: t.zoomLink,
      meetingProvider: t.meetingProvider,
      ownerId: t.ownerId,
      lastActive: t.lastActive,
      requireApproval: t.requireApproval,
      roster: [...t.roster.values()].map((m) => withLabel({ id: m.id, name: m.name }, m.label)),
      banned: [...t.banned.values()].map((b) => withLabel({ id: b.id, reason: b.reason }, b.label)),
      pending: [...t.pending.values()].map((p) => withLabel({ id: p.id, name: p.name, at: p.at }, p.label)),
    };
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
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
      if (!t || codes.has(t.code)) {
        invalid++;
        continue;
      }
      if (now - t.lastActive > limits.teamIdleDays * DAY_MS) {
        expired++;
        continue;
      }
      const rawLink = (raw as Record<string, unknown>).zoomLink;
      if (typeof rawLink === 'string' && rawLink !== '' && t.zoomLink === '') droppedLinks++;
      const team = fromSaved(t);
      teams.add(team);
      codes.set(team.code, team);
    }
    // Aliases after every current code is known: a current code always wins.
    for (const team of teams) {
      team.aliases = team.aliases.filter((a) => !codes.has(a) && !aliasCodes.has(a));
      for (const a of team.aliases) aliasCodes.set(a, team);
    }
    // Codes from before 10 characters are replaced; the old one keeps working only for the roster.
    let upgraded = 0;
    for (const team of teams) {
      if (team.code.length < CODE_LENGTH) {
        replaceCode(team);
        upgraded++;
      }
    }
    if (invalid) console.error(`[smoke-break] !!! Skipped ${invalid} saved team(s) in ${opts.dataFile} that aren't valid.`);
    if (droppedLinks) console.warn(`[smoke-break] Dropped ${droppedLinks} saved meeting link(s) that aren't allowed Zoom links.`);
    const migrated = data.some(isLegacyEntry);
    if (migrated || upgraded) {
      // The file is about to be rewritten in the new format: keep the old one, like a corrupt file.
      if (backup('pre-roster')) save();
    }
    audit('load', { teams: teams.size, invalid, expired, droppedLinks, migrated, upgradedCodes: upgraded });
  }

  /** Keeps a private copy of the data file. False (and saving switched off) if that fails. */
  function backup(tag: string): boolean {
    const copy = `${opts.dataFile}.${tag}-${Date.now()}`;
    try {
      copyFileSync(opts.dataFile, copy, fsConstants.COPYFILE_EXCL);
      chmodSync(copy, 0o600);
      console.warn(`[smoke-break] Kept a copy of the previous ${opts.dataFile} at ${copy}.`);
      return true;
    } catch (err) {
      persist = false;
      console.error(`[smoke-break] !!! Couldn't copy ${opts.dataFile} to ${copy} (${(err as Error).message}). Teams will NOT be saved until this is fixed.`);
      return false;
    }
  }

  /** The file exists but isn't a team list: keep a copy before it can be overwritten. */
  function quarantine() {
    if (backup('corrupt')) console.error(`[smoke-break] !!! ${opts.dataFile} is not a valid team list. Starting with no teams.`);
    else console.error(`[smoke-break] !!! ${opts.dataFile} is not a valid team list and couldn't be backed up.`);
  }

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
    try {
      writeAtomic(opts.dataFile, JSON.stringify([...teams].map(toSaved), null, 2));
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
    if (team.bcastTimer) clearTimeout(team.bcastTimer);
    for (const m of team.online.values()) if (m.leaveTimer) clearTimeout(m.leaveTimer);
    teams.delete(team);
    codes.delete(team.code);
    for (const a of team.aliases) aliasCodes.delete(a);
  }

  /**
   * Makes room for a new team. First choice: a team only its creator ever
   * joined, idle for a day (junk). Otherwise the least recently used empty
   * team, but never one used in the last `teamKeepDays`: then the new team is refused.
   */
  function roomForTeam(): boolean {
    if (teams.size < limits.maxTeams) return true;
    const now = Date.now();
    const keepAfter = now - limits.teamKeepDays * DAY_MS;
    const junkAfter = now - limits.junkTeamIdleMs;
    let junk: Team | null = null;
    let stale: Team | null = null;
    for (const t of teams) {
      if (t.online.size || t.brk) continue;
      if (t.roster.size <= 1 && !t.banned.size && !t.pending.size && t.lastActive <= junkAfter) {
        if (!junk || t.lastActive < junk.lastActive) junk = t;
      } else if (t.lastActive <= keepAfter && (!stale || t.lastActive < stale.lastActive)) stale = t;
    }
    const victim = junk ?? stale;
    if (!victim) return false;
    forget(victim);
    audit('team-forgotten', { team: victim.ref, reason: junk ? 'unused, room for a new team' : 'room for a new team' });
    save();
    return true;
  }

  // ── Sending ────────────────────────────────────────────────────────────

  const isOnline = (team: Team, id: string) => (team.online.get(id)?.sockets.size ?? 0) > 0;

  function pendingView(team: Team): MemberView[] {
    return [...team.pending.values()].map((p) => ({ id: p.id, name: p.name, online: false }));
  }

  /**
   * Builds state frames for one team. The team view is serialized at most four
   * times (owner or not × in the break or not), not once per socket: only the
   * owner gets the team link and join requests, only participants get the
   * break's meeting link.
   */
  function framer(team: Team) {
    const serverNow = Date.now();
    const brk = team.brk;
    const base: TeamView = {
      code: team.code,
      name: team.name,
      defaultLengthMin: team.defaultLengthMin,
      zoomLink: '',
      hasZoomLink: team.zoomLink !== '',
      meetingProvider: team.meetingProvider,
      ownerId: team.ownerId,
      members: [...team.roster.values()].map((m) => ({ id: m.id, name: m.name, online: isOnline(team, m.id) })),
      requireApproval: team.requireApproval,
      pending: [],
      brk: brk && brk.meetingUrl ? { ...brk, meetingUrl: null } : brk,
    };
    const inBreak = new Set(brk?.meetingUrl ? brk.participants.map((p) => p.id) : []);
    const cache = new Map<number, string>();
    return (id: string) => {
      const owner = id === team.ownerId;
      const part = inBreak.has(id);
      const k = (owner ? 2 : 0) + (part ? 1 : 0);
      let json = cache.get(k);
      if (json === undefined) {
        const v: TeamView = { ...base };
        if (owner) (v.zoomLink = team.zoomLink), (v.pending = pendingView(team));
        if (part) v.brk = brk;
        cache.set(k, (json = JSON.stringify(v)));
      }
      return `{"type":"state","team":${json},"you":${JSON.stringify(id)},"serverNow":${serverNow}}`;
    };
  }

  /** Bytes sent since the total was last measured: a cheap trigger for the hub-wide check. */
  let sentSinceCheck = 0;
  let lastBufferCheck = 0;

  /** Drops sockets that have stopped reading instead of buffering for them without limit. */
  function sendRaw(ws: WebSocket, frame: string) {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > limits.maxBufferedBytes) {
      const c = conns.get(ws);
      if (c) limitHit('send-buffer', c, c.key);
      ws.terminate();
      return;
    }
    ws.send(frame);
    sentSinceCheck += frame.length;
    if (sentSinceCheck > limits.maxTotalBufferedBytes / 4) checkTotalBuffered(false);
  }

  /**
   * Bounds what the hub holds for slow readers in total, not just per socket:
   * over `maxTotalBufferedBytes`, the sockets with the most waiting are dropped
   * until it's back under half of that.
   */
  function checkTotalBuffered(scheduled: boolean) {
    const now = Date.now();
    if (!scheduled && now - lastBufferCheck < 50) return;
    lastBufferCheck = now;
    sentSinceCheck = 0;
    let total = 0;
    const heavy: [WebSocket, number][] = [];
    for (const ws of conns.keys()) {
      const b = ws.bufferedAmount;
      if (b > 0) (total += b), heavy.push([ws, b]);
    }
    if (total <= limits.maxTotalBufferedBytes) return;
    heavy.sort((a, b) => b[1] - a[1]);
    for (const [ws, b] of heavy) {
      if (total <= limits.maxTotalBufferedBytes / 2) break;
      const c = conns.get(ws);
      if (c) limitHit('send-buffer-total', c, '*');
      ws.terminate();
      total -= b;
    }
  }

  function sendError(ws: WebSocket, message: string, fatal = false, code?: ErrorCode) {
    const msg: ErrorFrame = { type: 'error', message };
    if (fatal) msg.fatal = true;
    if (code) msg.code = code;
    sendRaw(ws, JSON.stringify(msg));
  }

  function sendState(team: Team, ws: WebSocket, id: string) {
    sendRaw(ws, framer(team)(id));
  }

  /**
   * Queues the team's state for everyone in it. Call only when something they
   * see changed. Goes out at once if nothing went out in the last
   * `broadcastIntervalMs`, else when that's up; changes in between share it.
   */
  function broadcast(team: Team) {
    if (team.bcastQueued || closed) return;
    team.bcastQueued = true;
    const run = () =>
      guard(() => {
        team.bcastTimer = null;
        team.bcastQueued = false;
        if (!closed && teams.has(team)) broadcastNow(team);
      });
    const wait = team.lastBroadcastAt + limits.broadcastIntervalMs - Date.now();
    if (wait <= 0) queueMicrotask(run);
    else team.bcastTimer = setTimeout(run, wait);
  }

  function broadcastNow(team: Team) {
    team.lastBroadcastAt = Date.now();
    const frame = framer(team);
    for (const m of team.online.values()) {
      if (!m.sockets.size) continue;
      const f = frame(m.id);
      for (const ws of m.sockets) sendRaw(ws, f);
    }
  }

  // ── Breaks ─────────────────────────────────────────────────────────────

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

  /** Applies a state machine result; nothing is sent if nothing changed. */
  function apply(team: Team, result: machine.Result, ws?: WebSocket) {
    if (result.error) {
      if (ws) sendError(ws, result.error);
      return;
    }
    if (!result.effects.length && sameBreak(result.brk, team.brk)) return;
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
          if ((link || null) === team.brk.meetingUrl) return;
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

  // ── Roster ─────────────────────────────────────────────────────────────

  /** Name keys taken on the roster (offline people included), except `exceptId`'s own. */
  function rosterNames(team: Team, exceptId?: string): Set<string> {
    const taken = new Set<string>();
    for (const m of team.roster.values()) if (m.id !== exceptId && m.name) taken.add(nameKey(m.name));
    return taken;
  }

  function ban(team: Team, id: string, label: string | null, reason: BanReason) {
    team.banned.delete(id);
    team.banned.set(id, { id, label, reason });
    if (team.banned.size > MAX_BANNED) team.banned.delete(team.banned.keys().next().value!);
  }

  /** Identities (roster and waiting) a token label holds in a team, other than `exceptId`. */
  function identitiesOf(team: Team, label: string, exceptId: string): number {
    let n = 0;
    for (const m of team.roster.values()) if (m.label === label && m.id !== exceptId) n++;
    for (const p of team.pending.values()) if (p.label === label && p.id !== exceptId) n++;
    return n;
  }

  /** Drops join requests older than `pendingTtlMs`. True if any were dropped. */
  function prunePending(team: Team, now = Date.now()): boolean {
    let dropped = false;
    for (const p of team.pending.values()) {
      if (now - p.at < limits.pendingTtlMs) continue;
      team.pending.delete(p.id);
      dropped = true;
    }
    return dropped;
  }

  function addToRoster(team: Team, id: string, name: string, label: string | null) {
    team.pending.delete(id);
    team.roster.set(id, { id, name: uniqueName(rosterNames(team, id), name), label });
    save();
  }

  /** Puts a socket in the team for a roster member, and sends it the state at once. */
  function attach(team: Team, ws: WebSocket, conn: Conn, id: string, name: string): Member {
    const entry = team.roster.get(id)!;
    let m = team.online.get(id);
    if (!m) {
      m = { id, sockets: new Set(), leaveTimer: null, lastInviteAt: -Infinity };
      team.online.set(id, m);
    }
    let changed = m.sockets.size === 0;
    // Teams saved before owners existed: the first person back becomes the owner.
    if (team.ownerId === null) {
      team.ownerId = id;
      changed = true;
      save();
    }
    // One person holds a few sockets (the desktop app uses two). More would let one member multiply every broadcast.
    while (m.sockets.size >= limits.maxSocketsPerMember) {
      const oldest: WebSocket = m.sockets.values().next().value!;
      m.sockets.delete(oldest);
      const c = conns.get(oldest);
      if (c) (c.state = 'done'), (c.team = null), (c.me = null);
      limitHit('sockets-per-member', conn, `${team.ref}|${id}`);
      sendError(oldest, 'You have too many windows open on this team; this one was closed.', true, 'rate-limited');
      oldest.close(1008, 'Too many connections for one person');
    }
    m.sockets.add(ws);
    if (m.leaveTimer) clearTimeout(m.leaveTimer);
    m.leaveTimer = null;
    const unique = uniqueName(rosterNames(team, id), name);
    if (unique !== entry.name) {
      entry.name = unique;
      changed = true;
      save();
    }
    if (conn.label && !entry.label) {
      entry.label = conn.label;
      save();
    }
    touch(team);
    sendState(team, ws, id);
    if (changed) broadcast(team);
    return m;
  }

  function detach(team: Team, m: Member, ws: WebSocket) {
    if (!m.sockets.delete(ws) || m.sockets.size > 0) return;
    // A team in use right up to now shouldn't look idle just because nobody reconnected since.
    touch(team);
    m.leaveTimer = setTimeout(() => {
      m.leaveTimer = null;
      guard(() => {
        if (m.sockets.size > 0 || team.online.get(m.id) !== m) return;
        team.online.delete(m.id);
        apply(team, machine.leave(team.brk, m.id, Date.now()));
      });
    }, limits.disconnectGraceMs);
    broadcast(team);
  }

  /** Closes a member's sockets (they're out of the team), without telling the rest of the team yet. */
  function disconnectMember(team: Team, id: string, message: string, code: ErrorCode) {
    const m = team.online.get(id);
    if (!m) return;
    team.online.delete(id);
    if (m.leaveTimer) clearTimeout(m.leaveTimer);
    for (const s of m.sockets) {
      const c = conns.get(s);
      if (c) (c.state = 'done'), (c.team = null), (c.me = null);
      sendError(s, message, true, code);
      s.close(1008, code);
    }
    m.sockets.clear();
  }

  // ── create / hello ─────────────────────────────────────────────────────

  /** Refuses a create/hello: a fatal error (after `delayMs`), then the socket is closed. */
  function refuse(conn: Conn, ws: WebSocket, message: string, code: ErrorCode | undefined, reason: string, delayMs = 0) {
    conn.state = delayMs ? 'refusing' : 'done';
    // A stranger can cause these as fast as they can connect: throttled per reason and address.
    audit('join-failed', { ...who(conn), reason }, { key: `join-failed|${reason}|${conn.key}` });
    const go = () => {
      conn.state = 'done';
      sendError(ws, message, true, code);
      ws.close(1008, reason.slice(0, 100));
    };
    if (delayMs) later(go, delayMs);
    else go();
  }

  function onHello(conn: Conn, ws: WebSocket, msg: Record<string, unknown>) {
    if (conn.state !== 'new') return;
    const access = tokens.check(msg.token);
    if (!access) {
      return refuse(conn, ws, 'This hub needs an access token. Ask whoever runs it.', 'unauthorized', 'unauthorized');
    }
    conn.label = access.label;
    conn.tokenDigest = access.digest;
    const clientId = typeof msg.clientId === 'string' ? msg.clientId : '';
    if (!CLIENT_ID.test(clientId)) return refuse(conn, ws, 'Invalid client id.', undefined, 'invalid-client-id');
    const name = cleanName(msg.name, 'Someone');
    if (msg.type === 'create') createTeam(conn, ws, clientId, name, msg.teamName);
    else joinTeam(conn, ws, clientId, name, msg.teamCode);
  }

  function createTeam(conn: Conn, ws: WebSocket, clientId: string, name: string, teamName: unknown) {
    if (!creates.take(conn.key)) {
      limitHit('creates-per-ip', conn, conn.key);
      return refuse(conn, ws, 'Too many new teams. Try again later.', 'rate-limited', 'creates-per-ip');
    }
    // People with their own token have their own quota; the hub-wide one is for everyone else.
    if (conn.label ? !createsPerLabel.take(conn.label) : !createsGlobal.take('*')) {
      limitHit(conn.label ? 'creates-per-label' : 'creates-global', conn, conn.label ?? '*');
      return refuse(conn, ws, 'Too many new teams on this server. Try again later.', 'rate-limited', conn.label ? 'creates-per-label' : 'creates-global');
    }
    if (!roomForTeam()) {
      limitHit('teams-full', conn, '*');
      return refuse(conn, ws, 'This server is full. Try again later.', 'full', 'teams-full');
    }
    const code = newCode();
    const ownerId = publicId(code, clientId);
    const team: Team = {
      code,
      aliases: [],
      idSalt: code,
      ref: randomRef(),
      name: cleanName(teamName, 'My team'),
      defaultLengthMin: DEFAULT_LENGTH_MIN,
      zoomLink: '',
      meetingProvider: 'fixed-link',
      ownerId,
      requireApproval: true,
      roster: new Map([[ownerId, { id: ownerId, name, label: conn.label }]]),
      banned: new Map(),
      pending: new Map(),
      online: new Map(),
      lastActive: Date.now(),
      brk: null,
      timer: null,
      bcastQueued: false,
      bcastTimer: null,
      lastBroadcastAt: 0,
    };
    teams.add(team);
    codes.set(code, team);
    save();
    audit('create', { ...who(conn), team: team.ref, member: ownerId, name });
    join(conn, ws, team, ownerId, name);
  }

  function join(conn: Conn, ws: WebSocket, team: Team, id: string, name: string) {
    clearTimeout(conn.helloTimer);
    conn.state = 'joined';
    conn.team = team;
    conn.me = attach(team, ws, conn, id, name);
  }

  function joinTeam(conn: Conn, ws: WebSocket, clientId: string, name: string, teamCode: unknown) {
    const code = typeof teamCode === 'string' && teamCode.length <= 64 ? normalizeCode(teamCode) : '';
    const current = code ? codes.get(code) : undefined;
    const team = current ?? (code ? aliasCodes.get(code) : undefined);
    const id = team ? publicId(team.idSalt, clientId) : '';
    const onRoster = !!team && team.roster.has(id);
    // Someone on the roster with a right (or recent) code isn't guessing: the lockout doesn't apply to them.
    if (badCodes.blocked(conn.key) && !onRoster) {
      limitHit('bad-codes', conn, conn.key);
      return refuse(conn, ws, 'Too many wrong invite codes. Try again in a few minutes.', 'rate-limited', 'locked-out', limits.badCodeDelayMs);
    }
    // An old code only lets the roster straight in; from anyone else it's wrong. One exception:
    // a short code from before rosters existed, on a team whose owner hasn't replaced the code
    // since, counts as a request the owner can turn down. That's how teammates from before the
    // upgrade get back in instead of being told their team is gone. (Teams saved before owners
    // existed have nobody to let people in, so there the first one back still gets in.)
    const legacyRequest =
      !!team && team.requireApproval && code.length < CODE_LENGTH && team.aliases.length === 1 && team.aliases[0] === code;
    if (!team || (!current && !onRoster && team.ownerId !== null && !legacyRequest)) {
      badCodes.take(conn.key);
      return refuse(conn, ws, 'No team with that invite code.', 'bad-code', 'bad-code', limits.badCodeDelayMs);
    }
    const banned = team.banned.get(id);
    if (banned) return refuseBanned(conn, ws, banned.reason);
    if (onRoster) {
      join(conn, ws, team, id, name);
      return audit('join', { ...who(conn), team: team.ref, member: id, name: team.roster.get(id)!.name }, { key: `join|${team.ref}|${id}` });
    }

    // Someone new, with the current code.
    if (conn.label) {
      // A person removed under their own token can't come back as a "new device".
      const labelBan = [...team.banned.values()].find((b) => b.label === conn.label);
      if (labelBan) return refuseBanned(conn, ws, labelBan.reason);
      if (identitiesOf(team, conn.label, id) >= limits.identitiesPerLabel) {
        limitHit('identities-per-label', conn, `${team.ref}|${conn.label}`);
        return refuse(conn, ws, 'Too many devices on this team for your access token. Ask the owner to remove an old one.', 'full', 'identities-per-label');
      }
    }
    if (team.roster.size >= limits.maxMembersPerTeam) {
      limitHit('members-per-team', conn, team.ref);
      return refuse(conn, ws, 'This team is full.', 'full', 'team-full');
    }
    // An ownerless team (saved before owners existed) has nobody to approve: the first one in becomes the owner.
    if (team.requireApproval && team.ownerId !== null) return requestToJoin(conn, ws, team, id, name);
    addToRoster(team, id, name, conn.label);
    join(conn, ws, team, id, name);
    audit('join', { ...who(conn), team: team.ref, member: id, name: team.roster.get(id)!.name, first: true });
  }

  function refuseBanned(conn: Conn, ws: WebSocket, reason: BanReason) {
    return reason === 'denied'
      ? refuse(conn, ws, "The team's owner didn't let you in.", 'denied', 'denied', limits.badCodeDelayMs)
      : refuse(conn, ws, 'You were removed from this team.', 'removed', 'removed', limits.badCodeDelayMs);
  }

  /** Approval is on: record (or keep) a request for the owner, and tell the joiner to wait. */
  function requestToJoin(conn: Conn, ws: WebSocket, team: Team, id: string, name: string) {
    const now = Date.now();
    if (prunePending(team, now)) (save(), broadcast(team));
    if (!team.pending.has(id)) {
      let fromHere = 0;
      for (const p of team.pending.values()) if (p.addr === conn.key) fromHere++;
      const why =
        team.pending.size >= limits.maxPending ? 'pending-full' : fromHere >= limits.pendingPerIp ? 'pending-per-ip' : !joinRequests.take(conn.key) ? 'pending-rate' : null;
      if (why) {
        limitHit(why, conn, why === 'pending-full' ? team.ref : conn.key);
        return refuse(conn, ws, 'Too many people are waiting to join this team. Try again later.', 'rate-limited', why);
      }
      // Waiting names can't pass for someone on the roster (or another waiting person) either.
      const taken = rosterNames(team);
      for (const p of team.pending.values()) taken.add(nameKey(p.name));
      const entry = { id, name: uniqueName(taken, name), label: conn.label, at: now, addr: conn.key };
      team.pending.set(id, entry);
      save();
      broadcast(team);
      audit('join-requested', { ...who(conn), team: team.ref, member: id, name: entry.name }, { key: `join-requested|${conn.key}` });
    }
    refuse(conn, ws, "The team's owner needs to let you in. Ask them, then try again.", 'pending', 'pending');
  }

  // ── Owner actions ──────────────────────────────────────────────────────

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
    if (msg.requireApproval !== undefined && typeof msg.requireApproval !== 'boolean') {
      return sendError(ws, 'requireApproval must be true or false.');
    }

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
    if (typeof msg.requireApproval === 'boolean' && msg.requireApproval !== team.requireApproval) {
      team.requireApproval = msg.requireApproval;
      changed.push('requireApproval');
    }
    // Nothing changed, nothing sent: a no-op must not cost a broadcast.
    if (!changed.length) return;
    save();
    audit('settings', { ...who(conn), team: team.ref, member: me.id, changed }, ownerThrottle('settings', team, me));
    broadcast(team);
  }

  function rotateCode(team: Team, me: Member, ws: WebSocket, conn: Conn) {
    if (me.id !== team.ownerId) return sendError(ws, 'Only the team owner can change the invite code.');
    replaceCode(team);
    save();
    audit('rotate-code', { ...who(conn), team: team.ref, member: me.id }, ownerThrottle('rotate-code', team, me));
    broadcast(team);
  }

  /** Takes anyone on the roster (online or not) off the team for good, and replaces the code they know. */
  function removeMember(team: Team, me: Member, ws: WebSocket, conn: Conn, msg: Record<string, unknown>) {
    if (me.id !== team.ownerId) return sendError(ws, 'Only the team owner can remove people.');
    const id = typeof msg.id === 'string' ? msg.id : '';
    if (id === me.id) return sendError(ws, "You can't remove yourself.");
    const entry = PUBLIC_ID.test(id) ? team.roster.get(id) : undefined;
    if (!entry) return sendError(ws, 'No such member.');

    team.roster.delete(id);
    ban(team, id, entry.label, 'removed');
    // Their sockets are closed before anything is broadcast, so the new code never reaches them.
    disconnectMember(team, id, 'You were removed from this team.', 'removed');
    replaceCode(team);
    save();
    audit('remove-member', { ...who(conn), team: team.ref, member: me.id, removed: id, removedLabel: entry.label ?? undefined });
    apply(team, machine.leave(team.brk, id, Date.now()));
    broadcast(team);
  }

  function approveMember(team: Team, me: Member, ws: WebSocket, conn: Conn, msg: Record<string, unknown>) {
    if (me.id !== team.ownerId) return sendError(ws, 'Only the team owner can let people in.');
    if (typeof msg.allow !== 'boolean') return sendError(ws, 'allow must be true or false.');
    const id = typeof msg.id === 'string' ? msg.id : '';
    prunePending(team);
    const entry = team.pending.get(id);
    if (!entry) return sendError(ws, 'No such request.');
    if (msg.allow) {
      if (team.roster.size >= limits.maxMembersPerTeam) return sendError(ws, 'The team is full.');
      addToRoster(team, id, entry.name, entry.label);
      audit('approve-member', { ...who(conn), team: team.ref, member: me.id, approved: id, approvedLabel: entry.label ?? undefined });
    } else {
      team.pending.delete(id);
      ban(team, id, entry.label, 'denied');
      audit('deny-member', { ...who(conn), team: team.ref, member: me.id, denied: id, deniedLabel: entry.label ?? undefined });
    }
    save();
    broadcast(team);
  }

  function transferOwner(team: Team, me: Member, ws: WebSocket, conn: Conn, msg: Record<string, unknown>) {
    if (me.id !== team.ownerId) return sendError(ws, 'Only the team owner can hand the team over.');
    const id = typeof msg.id === 'string' ? msg.id : '';
    if (id === me.id) return sendError(ws, 'You already own this team.');
    if (!PUBLIC_ID.test(id) || !team.roster.has(id)) return sendError(ws, 'No such member.');
    team.ownerId = id;
    save();
    audit('transfer-owner', { ...who(conn), team: team.ref, member: me.id, to: id });
    broadcast(team);
  }

  function handle(conn: Conn, ws: WebSocket, msg: Record<string, unknown>) {
    const team = conn.team!;
    const me = conn.me!;
    const now = Date.now();
    const self = { id: me.id, name: team.roster.get(me.id)?.name ?? '' };
    switch (msg.type) {
      case 'invite': {
        const starting = !machine.isActive(team.brk);
        if (starting && now - me.lastInviteAt < limits.breakCooldownMs) {
          limitHit('break-cooldown', conn, me.id);
          return sendError(ws, 'Wait a few seconds before starting another break.');
        }
        if (starting) me.lastInviteAt = now;
        return apply(team, machine.invite(team.brk, self, team.defaultLengthMin, now, randomUUID(), MINUTE_MS), ws);
      }
      case 'setLength':
        if (typeof msg.lengthMin !== 'number') return sendError(ws, 'The length must be a number of minutes.');
        return apply(team, machine.setLength(team.brk, me.id, msg.lengthMin), ws);
      case 'join':
        return apply(team, machine.join(team.brk, self, now, msg.light === true), ws);
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
      case 'approveMember':
        return approveMember(team, me, ws, conn, msg);
      case 'transferOwner':
        return transferOwner(team, me, ws, conn, msg);
    }
  }

  // ── Sockets ────────────────────────────────────────────────────────────

  /** The message budget shared by every socket from one address. */
  function addressBucket(key: string): TokenBucket {
    let b = addressBuckets.get(key);
    if (b) addressBuckets.delete(key);
    else b = new TokenBucket(limits.addressMessageBurst, limits.addressMessagesPerSecond);
    addressBuckets.set(key, b); // most recently used last
    if (addressBuckets.size > MAX_ADDRESS_BUCKETS) addressBuckets.delete(addressBuckets.keys().next().value!);
    return b;
  }

  function onMessage(conn: Conn, ws: WebSocket, raw: RawData, isBinary: boolean, bucket: TokenBucket) {
    if (conn.state === 'done' || conn.state === 'refusing') return;
    if (!bucket.take() || !addressBucket(conn.key).take()) {
      if (++conn.dropped > MAX_DROPPED_MESSAGES) {
        limitHit('message-flood', conn, conn.key);
        conn.state = 'done';
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

  /** After the tokens file changed: connections whose token is gone are closed. */
  function closeRevoked(valid: (label: string | null, digest: Buffer | null) => boolean) {
    for (const [ws, conn] of conns) {
      if (conn.state !== 'joined' || valid(conn.label, conn.tokenDigest)) continue;
      conn.state = 'done';
      audit('token-revoked', { ...who(conn), team: conn.team?.ref }, { key: `token-revoked|${conn.label}`, perMinute: 1 });
      sendError(ws, 'Your access to this hub was revoked.', true, 'unauthorized');
      ws.close(1008, 'unauthorized');
    }
  }

  function onConnection(ws: WebSocket, ip: string, key: string) {
    const conn: Conn = {
      ip,
      key,
      alive: true,
      state: 'new',
      team: null,
      me: null,
      label: null,
      tokenDigest: null,
      dropped: 0,
      // A socket that never says who it is would otherwise hold a connection slot forever.
      helloTimer: setTimeout(() => {
        if (conn.state !== 'new') return;
        limitHit('hello-timeout', conn, key);
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
        if (team && me && team.online.get(me.id) === me) detach(team, me, ws);
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

  const bufferCheck = setInterval(() => guard(() => checkTotalBuffered(true)), limits.bufferCheckMs);
  bufferCheck.unref();

  const housekeeping = setInterval(
    () =>
      guard(() => {
        for (const team of teams) if (prunePending(team)) (save(), broadcast(team));
      }),
    limits.housekeepingMs,
  );
  housekeeping.unref();

  const reject = (socket: Duplex, status: string) =>
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);

  return {
    /** Writes any pending save now. */
    flush,
    /** Re-reads the per-person tokens file now (it is also checked every `tokensPollMs`). */
    reloadTokens: () => tokens.reload(),
    /** Writes the audit log's suppressed-lines summary now. */
    summarizeAudit: () => auditLog.summarize(),
    /** Numbers for tests and the startup line. */
    stats: () => ({ teams: teams.size, connections: conns.size, tokenLabels: tokens.labels, tokensRequired: tokens.required }),
    /** Stops timers, closes every socket and writes any pending save. */
    close() {
      if (closed) return;
      flush();
      closed = true;
      clearInterval(heartbeat);
      clearInterval(bufferCheck);
      clearInterval(housekeeping);
      tokens.close();
      auditLog.close();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const team of teams) {
        if (team.timer) clearTimeout(team.timer);
        if (team.bcastTimer) clearTimeout(team.bcastTimer);
        for (const m of team.online.values()) if (m.leaveTimer) clearTimeout(m.leaveTimer);
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
        const ip = clientAddress(req, trusted);
        const key = addressKey(ip);
        if (!isAllowedHost(req.headers.host, policy) || !isAllowedOrigin(req.headers.origin, req.headers.host, policy)) {
          limitHit('origin', { ip }, key);
          return reject(socket, '403 Forbidden');
        }
        if (conns.size >= limits.maxConnections) {
          limitHit('connections-total', { ip }, '*');
          return reject(socket, '503 Service Unavailable');
        }
        if ((connectionsPerKey.get(key) ?? 0) >= limits.connectionsPerIp) {
          limitHit('connections-per-ip', { ip }, key);
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
