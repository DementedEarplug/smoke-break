// Realtime hub: one shared break per team, broadcast to every connected pack.
// The server owns the clock: every deadline is scheduled here.

import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
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
  WS_PROTOCOL,
  clampLength,
  normalizeMeetingLink,
  tokenFromProtocols,
} from '../shared/protocol.ts';
import { AccessTokens, type TokensChange } from './accessTokens.ts';
import {
  type OriginPolicy,
  type TrustedProxies,
  addressKey,
  clientAddress,
  isAllowedHost,
  isAllowedOrigin,
  parseTrustedProxies,
} from './addresses.ts';
import { type AuditClass, type AuditLimits, createAuditLog } from './audit.ts';
import * as machine from './breakMachine.ts';
import { envBool } from './env.ts';
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
  keepCopy,
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
  /** Teams nobody has used for this long are forgotten (on load, and by housekeeping). */
  teamIdleDays: number;
  /**
   * When the hub is full, a team that never had a break with two or more people
   * and has at most one token label on its roster may be forgotten to make room
   * once it has been idle this long. Any other team is never forgotten to make
   * room: new teams are refused instead.
   */
  junkTeamIdleMs: number;
  /**
   * Teams one token label may hold: those it owns plus those it made that
   * still exist (handing a team over doesn't free its slot). At this many it
   * can't make another or be handed one.
   */
  teamsPerLabel: number;
  createsPerIpPerHour: number;
  /** New teams per hour across the whole hub from connections without a per-person token. */
  createsPerHour: number;
  /** New teams per day for each per-person token label (instead of the hub-wide limit). */
  createsPerLabelPerDay: number;
  /** Wrong invite codes allowed per address (or token label) every 10 minutes, so codes can't be guessed. */
  badCodesPerIp: number;
  /** Delay before saying a code is wrong. */
  badCodeDelayMs: number;
  /**
   * Identified connections (past create/hello) per address, or per token label.
   * Each desktop app holds two, so this is about twice the people behind one address.
   */
  connectionsPerIp: number;
  /** Identified connections in total. */
  maxConnections: number;
  /**
   * Connections that haven't said create/hello yet, per address (IPv6 by /56)
   * or per token label. Kept apart from identified ones, so strangers can't use those up.
   */
  unidentifiedPerIp: number;
  /** Connections that haven't said create/hello yet, in total. */
  maxUnidentified: number;
  /** Messages other than create/hello a new connection may send first; one more closes it. */
  messagesBeforeHello: number;
  /** Roster size: people who belong to a team, online or not. */
  maxMembersPerTeam: number;
  /** Open sockets one person may hold in a team; one more closes their oldest. */
  maxSocketsPerMember: number;
  /** Identities (roster entries plus join requests) one token label may hold in a team. */
  identitiesPerLabel: number;
  /** Join requests waiting for the owner, per team. */
  maxPending: number;
  /** Of those, how many may come from one address (or token label). */
  pendingPerIp: number;
  /** New join requests one address (or token label) may make per hour, across all teams. */
  pendingRequestsPerIpPerHour: number;
  /** Someone the owner turned away can't ask that team again for this long. */
  denyMs: number;
  /** Unanswered join requests are dropped after this long. */
  pendingTtlMs: number;
  /** Per-socket message rate: bursts of `messageBurst`, then `messagesPerSecond`. */
  messageBurst: number;
  messagesPerSecond: number;
  /** Message budget shared by all sockets from one address (or token label). */
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
  /**
   * What one team's state updates may cost per second, all its sockets together:
   * after an update of N bytes in all, the next waits at least N / this seconds
   * (so a large team's updates are spaced further apart).
   */
  teamBroadcastBytesPerSecond: number;
  /** Ping this often; a socket that hasn't answered the previous ping is dropped. */
  pingIntervalMs: number;
  /** A socket must say create/hello within this long. */
  helloTimeoutMs: number;
  /** How long a closed tab keeps its spot in a break before it's stubbed out. */
  disconnectGraceMs: number;
  /** One person (roster entry, and token label) can start a new break at most this often. */
  breakCooldownMs: number;
  /**
   * Changes one person makes that send the whole team its state, per roster
   * entry and per token label every `joinLeaveWindowMs`, in two budgets of
   * this size: one for joining or leaving a break and changing a pending
   * break's length, one for coming online or going offline, a new name, and
   * an owner's settings. Over it, break and settings changes are refused, a
   * new name isn't taken, and coming and going reach the team with its next
   * update (at the latest when the window is up).
   */
  joinLeavePerWindow: number;
  joinLeaveWindowMs: number;
  /** Owner actions per minute for each owner and team: remove, hand over, change the code. */
  ownerActionsPerMinute: number;
  /** Approvals and denials per minute for each owner and team. */
  approvalsPerMinute: number;
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
  junkTeamIdleMs: DAY_MS,
  teamsPerLabel: envInt('SMOKE_BREAK_TEAMS_PER_LABEL', 5),
  createsPerIpPerHour: 10,
  createsPerHour: 100,
  createsPerLabelPerDay: 20,
  badCodesPerIp: 20,
  badCodeDelayMs: 500,
  // An office behind one NAT or proxy address: ~250 people with the app open.
  connectionsPerIp: envInt('SMOKE_BREAK_CONNECTIONS_PER_IP', 500),
  maxConnections: envInt('SMOKE_BREAK_MAX_CONNECTIONS', 10_000),
  // Apps say hello as soon as they connect, so even an office reconnecting at once holds few of these.
  unidentifiedPerIp: 100,
  maxUnidentified: 2000,
  messagesBeforeHello: 2,
  maxMembersPerTeam: 200,
  maxSocketsPerMember: 4,
  identitiesPerLabel: envInt('SMOKE_BREAK_IDENTITIES_PER_LABEL', 3),
  maxPending: 20,
  pendingPerIp: 3,
  pendingRequestsPerIpPerHour: 20,
  pendingTtlMs: 3 * DAY_MS,
  denyMs: DAY_MS,
  messageBurst: 30,
  messagesPerSecond: 10,
  // After a hub restart a whole office reconnects at once: one hello per socket.
  addressMessageBurst: 600,
  addressMessagesPerSecond: 50,
  maxBufferedBytes: 256 * 1024,
  maxTotalBufferedBytes: 64 * 1024 * 1024,
  bufferCheckMs: 1000,
  broadcastIntervalMs: 150,
  // A 150-person team's update is ~3 MB across its 300 sockets: at most one every ~1.5 s.
  teamBroadcastBytesPerSecond: 2_000_000,
  pingIntervalMs: 30_000,
  helloTimeoutMs: 3000,
  disconnectGraceMs: 20_000,
  breakCooldownMs: 10_000,
  joinLeavePerWindow: 6,
  joinLeaveWindowMs: 10_000,
  ownerActionsPerMinute: 5,
  // One owner may have a whole team waiting after an upgrade (maxPending is 20).
  approvalsPerMinute: 20,
  saveDelayMs: 200,
  lastActiveResolutionMs: HOUR_MS,
  housekeepingMs: HOUR_MS,
  tokensPollMs: 2000,
  auditLinesPerSecond: 50,
  auditBurst: 200,
  auditPreLinesPerSecond: 2,
  auditPreBurst: 10,
  auditPeopleLinesPerSecond: 20,
  auditPeopleBurst: 200,
  auditCriticalLinesPerSecond: 20,
  auditCriticalBurst: 200,
  auditQueueMax: 10_000,
  auditPerKeyPerMinute: 5,
  auditSummaryMs: 60_000,
};
/** A socket that keeps flooding after being throttled this many times is closed. */
const MAX_DROPPED_MESSAGES = 50;
/** Audit lines that are never dropped: over their budget they're queued. */
const CRITICAL = { cls: 'critical' } as const;

export interface HubOptions {
  dataFile: string;
  limits?: Partial<HubLimits>;
  /**
   * A token shared by everyone, offered as a WebSocket subprotocol (see
   * `tokenProtocol`). Default: SMOKE_BREAK_ACCESS_TOKEN. Can't be combined with a tokens file.
   */
  accessToken?: string;
  /**
   * File of `label:token` lines, one label per person: a label is an identity
   * (removing one of its devices removes the person). Default: SMOKE_BREAK_ACCESS_TOKENS_FILE.
   */
  accessTokensFile?: string;
  /**
   * A secret the reverse proxy sends in `X-Smoke-Break-Proxy`. When set, upgrades
   * without it are refused, so a local process can't connect around the proxy
   * (or fake X-Forwarded-For). Default: SMOKE_BREAK_PROXY_SECRET.
   */
  proxySecret?: string;
  /** The hub listens on a Unix socket only the proxy can open: peers without an IP address are the proxy. */
  unixSocket?: boolean;
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
  /**
   * Strict mode: refuse to start without the recommended protections, and keep
   * owner approval on for every team. Default: SMOKE_BREAK_ENTERPRISE (an on/off setting, see env.ts).
   */
  enterprise?: boolean;
  /** The TCP address the hub listens on (not with a Unix socket), checked in strict mode. */
  listenHost?: string;
  /** The hop from a proxy on another machine is encrypted some other way (SMOKE_BREAK_ENCRYPTED_HOP). */
  encryptedHop?: boolean;
}

/** What `checkDeployment` looks at. */
export interface Deployment {
  enterprise: boolean;
  tokenMode: 'file' | 'shared' | 'none';
  publicHosts: readonly string[];
  proxySecret: boolean;
  unixSocket: boolean;
  /**
   * X-Forwarded-For is believed from some peers: SMOKE_BREAK_TRUST_PROXY is
   * set, or strict mode trusts loopback by default (see `defaultsToLoopbackProxy`).
   */
  trustsProxy: boolean;
  listenHost?: string;
  /** SMOKE_BREAK_ENCRYPTED_HOP: the deployer says the hop from a remote proxy is encrypted some other way. */
  encryptedHop?: boolean;
}

export const isLoopbackHost = (host: string) => {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || (isIP(h) === 4 && h.startsWith('127.')) || h.startsWith('::ffff:127.');
};

/**
 * Strict mode on a loopback TCP address with a proxy secret and no
 * SMOKE_BREAK_TRUST_PROXY: the proxy is on this machine, so its
 * X-Forwarded-For is believed from loopback (otherwise every audit line and
 * per-address limit would name the proxy instead of the client).
 */
export function defaultsToLoopbackProxy(d: Omit<Deployment, 'tokenMode' | 'publicHosts'>): boolean {
  return d.enterprise && d.listenHost !== undefined && !d.unixSocket && d.proxySecret && !d.trustsProxy && isLoopbackHost(d.listenHost);
}

/**
 * The recommended protections a deployment lacks. In strict mode they're
 * `missing` (the hub won't start); otherwise each is one startup `warning`.
 * A non-loopback `HOST` means the hop from the proxy is plain ws://: a warning outside strict
 * mode, and `missing` in it unless SMOKE_BREAK_ENCRYPTED_HOP says the hop is encrypted.
 */
export function checkDeployment(d: Deployment): { missing: string[]; warnings: string[] } {
  const remoteHost = d.listenHost !== undefined && !d.unixSocket && !isLoopbackHost(d.listenHost);
  const plainHop = remoteHost && !d.encryptedHop
    ? [
        `HOST=${d.listenHost} is not a loopback address: connections reach the hub as plain ws:// (unencrypted), so anyone on the network between the proxy and the hub can read every access token, the proxy secret, invite codes and meeting links. Keep the proxy on this machine (HOST=127.0.0.1 or SMOKE_BREAK_SOCKET), or encrypt that hop (a private link, WireGuard, or TLS terminated on this host).`,
      ]
    : [];
  if (d.enterprise) {
    const missing: string[] = [];
    if (d.tokenMode !== 'file') {
      missing.push(
        d.tokenMode === 'shared'
          ? 'per-person tokens: set SMOKE_BREAK_ACCESS_TOKENS_FILE instead of the shared SMOKE_BREAK_ACCESS_TOKEN'
          : 'per-person tokens: set SMOKE_BREAK_ACCESS_TOKENS_FILE',
      );
    }
    if (!d.publicHosts.length) missing.push("the hub's name: set SMOKE_BREAK_PUBLIC_HOST");
    if (!d.proxySecret && !d.unixSocket) missing.push('a way to keep out connections around the proxy: set SMOKE_BREAK_PROXY_SECRET or SMOKE_BREAK_SOCKET');
    if (remoteHost && !d.proxySecret) {
      missing.push(`HOST=${d.listenHost} is not a loopback address: set SMOKE_BREAK_PROXY_SECRET, or listen on 127.0.0.1 or SMOKE_BREAK_SOCKET`);
    }
    // Without it every audit line names the proxy, not where a token was used from.
    if (remoteHost && !d.trustsProxy) {
      missing.push(`the proxy's address: set SMOKE_BREAK_TRUST_PROXY to it (HOST=${d.listenHost} is not a loopback address, so it isn't assumed)`);
    }
    // Strict mode doesn't run with tokens crossing a network in the clear on a warning alone.
    if (plainHop.length) {
      missing.push(`${plainHop[0]} If that hop is already encrypted, say so with SMOKE_BREAK_ENCRYPTED_HOP=1.`);
    }
    return { missing, warnings: [] };
  }
  const warnings: string[] = [...plainHop];
  if (!d.publicHosts.length) {
    warnings.push('SMOKE_BREAK_PUBLIC_HOST is not set: connections for any Host name are accepted (no protection against DNS rebinding). Set it to the hub\'s name.');
  }
  if (d.trustsProxy && !d.unixSocket && !d.proxySecret) {
    warnings.push(
      'SMOKE_BREAK_TRUST_PROXY is set without SMOKE_BREAK_PROXY_SECRET or SMOKE_BREAK_SOCKET: any process that can reach the hub from a trusted address can connect around the proxy and write its own X-Forwarded-For.',
    );
  }
  if (d.tokenMode === 'shared') {
    warnings.push(
      'one shared access token (SMOKE_BREAK_ACCESS_TOKEN): it can\'t be revoked for one person, limits are per address instead of per person, and anyone holding it can block new teams hub-wide. Use SMOKE_BREAK_ACCESS_TOKENS_FILE for a company deployment.',
    );
  } else if (d.tokenMode === 'none') {
    warnings.push(
      'no access token required: anyone who can reach this hub can connect, make teams and ask to join them. Set SMOKE_BREAK_ACCESS_TOKENS_FILE for anything but local use.',
    );
  }
  return { missing: [], warnings };
}

/** One person online in a team (with one or more sockets). */
interface Member {
  /** Public id shown to teammates and used in breaks. */
  id: string;
  sockets: Set<WebSocket>;
  leaveTimer: ReturnType<typeof setTimeout> | null;
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
  /** 'denied' only: when they may ask again. */
  until?: number;
}

interface LabelBan {
  label: string;
  reason: BanReason;
  until?: number;
}

interface PendingEntry {
  id: string;
  name: string;
  label: string | null;
  at: number;
  /** Limit key (address or label) it came from (not saved). */
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
  /** People the owner removed (for good) or turned away (for `denyMs`). */
  banned: Map<string, BanEntry>;
  /** Token labels removed as a whole (or turned away for a while): no new identity under them. */
  labelBans: Map<string, LabelBan>;
  /** A break with two or more people has happened. */
  hadGroupBreak: boolean;
  /** Token label of whoever made it: it counts against their quota of teams even after it's handed over. */
  createdBy: string | null;
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
  /** Wait before the next broadcast: `broadcastIntervalMs`, or longer after a big one. */
  bcastGapMs: number;
  /** A broadcast held back because someone was over their limit of changes (see `broadcastLater`). */
  laterTimer: ReturnType<typeof setTimeout> | null;
}

/** One open socket. */
interface Conn {
  /** Client address, for logs. */
  ip: string;
  /** Address used for per-address limits (IPv6 grouped by /64). */
  key: string;
  /** What its limits are counted against: its token label if it has one, else `key`. */
  limitKey: string;
  /** What it counts against while unidentified: its token label, else its address with IPv6 grouped by /56. */
  preKey: string;
  /** Which connection count it's in: unidentified, identified, or neither once closed. */
  pool: 'pre' | 'joined' | null;
  /** Messages sent before create/hello. */
  preMsgs: number;
  alive: boolean;
  /** new → (refusing, while a refusal is delayed) → joined, or done once refused or removed. */
  state: 'new' | 'refusing' | 'joined' | 'done';
  team: Team | null;
  me: Member | null;
  /** Per-person token label, if it used one (known from the upgrade). */
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

/** The header a reverse proxy puts SMOKE_BREAK_PROXY_SECRET in. */
export const PROXY_HEADER = 'x-smoke-break-proxy';
const PROXY_SECRET = /^[\x21-\x7e]{16,512}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** The subprotocols a client offered, from its upgrade request. */
function offeredProtocols(req: IncomingMessage): string[] {
  const h = req.headers['sec-websocket-protocol'];
  return (Array.isArray(h) ? h.join(',') : (h ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
}

const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
function dec(m: Map<string, number>, k: string) {
  const n = (m.get(k) ?? 1) - 1;
  if (n > 0) m.set(k, n);
  else m.delete(k);
}

// ── The hub ──────────────────────────────────────────────────────────────

export function createHub(opts: HubOptions) {
  const limits: HubLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const log = opts.log ?? ((line: string) => console.log(line));
  // Anything misconfigured throws here, before any timer starts or socket is accepted.
  checkDataDir(dirname(opts.dataFile));
  const enterprise = opts.enterprise ?? envBool('SMOKE_BREAK_ENTERPRISE');
  let trusted: TrustedProxies = parseTrustedProxies(opts.trustProxy ?? process.env.SMOKE_BREAK_TRUST_PROXY);
  const proxySecret = opts.proxySecret ?? process.env.SMOKE_BREAK_PROXY_SECRET?.trim() ?? '';
  if (proxySecret && !PROXY_SECRET.test(proxySecret)) {
    throw new Error('SMOKE_BREAK_PROXY_SECRET must be 16-512 printable characters without spaces (e.g. openssl rand -hex 32).');
  }
  const proxyDigest = proxySecret ? sha256(proxySecret) : null;
  const tokens = new AccessTokens({
    shared: opts.accessToken ?? process.env.SMOKE_BREAK_ACCESS_TOKEN?.trim() ?? '',
    file: opts.accessTokensFile ?? process.env.SMOKE_BREAK_ACCESS_TOKENS_FILE?.trim() ?? '',
    pollMs: limits.tokensPollMs,
    onReload: (change) => guard(() => onTokensChange(change)),
    log: (event, fields) => audit(event, fields, CRITICAL),
  });
  const auditLog = createAuditLog(log, limits);
  const audit = auditLog.audit;
  const policy: OriginPolicy = {
    publicHosts: (opts.publicHosts ?? envList(process.env.SMOKE_BREAK_PUBLIC_HOST)).map((h) => h.toLowerCase()),
    allowedOrigins: opts.allowedOrigins ?? envList(process.env.SMOKE_BREAK_ALLOWED_ORIGINS),
    allowLocalhostPages: opts.allowLocalhostPages ?? false,
  };
  const setup = {
    enterprise,
    proxySecret: !!proxyDigest,
    unixSocket: opts.unixSocket ?? false,
    trustsProxy: trusted !== null,
    listenHost: opts.listenHost,
    encryptedHop: opts.encryptedHop ?? envBool('SMOKE_BREAK_ENCRYPTED_HOP'),
  };
  /** Strict mode's default: a proxy secret on loopback means the proxy is on this machine. */
  const loopbackProxyDefault = defaultsToLoopbackProxy(setup);
  if (loopbackProxyDefault) trusted = parseTrustedProxies(true);
  const deployment = checkDeployment({ ...setup, trustsProxy: trusted !== null, tokenMode: tokens.mode, publicHosts: policy.publicHosts ?? [] });
  if (deployment.missing.length) {
    tokens.close();
    auditLog.close();
    throw new Error(`Strict mode (SMOKE_BREAK_ENTERPRISE) is on, but this hub is missing:\n${deployment.missing.map((m) => `  - ${m}`).join('\n')}`);
  }

  const teams = new Set<Team>();
  /** Current invite codes. */
  const codes = new Map<string, Team>();
  /** Earlier codes that still work for people on the roster. */
  const aliasCodes = new Map<string, Team>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: limits.maxPayloadBytes,
    clientTracking: false,
    // The app offers WS_PROTOCOL (plus its token); answer with it. Clients that offer nothing get nothing back.
    handleProtocols: (offered) => (offered.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });
  const conns = new Map<WebSocket, Conn>();
  /** Unidentified connections per preKey, and identified ones per limitKey. */
  const preCounts = new Map<string, number>();
  const joinedCounts = new Map<string, number>();
  let preTotal = 0;
  let joinedTotal = 0;
  const messageBuckets = new Map<string, TokenBucket>();
  const creates = new WindowLimiter(limits.createsPerIpPerHour, HOUR_MS);
  const createsGlobal = new WindowLimiter(limits.createsPerHour, HOUR_MS);
  const createsPerLabel = new WindowLimiter(limits.createsPerLabelPerDay, DAY_MS);
  const badCodes = new WindowLimiter(limits.badCodesPerIp, BAD_CODE_WINDOW_MS);
  const joinRequests = new WindowLimiter(limits.pendingRequestsPerIpPerHour, HOUR_MS);
  /** New breaks, per roster entry and per token label in a team: one per cooldown, across reconnects. */
  const breakStarts = new WindowLimiter(1, limits.breakCooldownMs);
  /** Changes to a break (join, leave, length) that send the whole team its state, keyed like `breakStarts`. */
  const breakChanges = new WindowLimiter(limits.joinLeavePerWindow, limits.joinLeaveWindowMs);
  /** The same for everything else that does: coming and going, new names, owners' settings. */
  const otherChanges = new WindowLimiter(limits.joinLeavePerWindow, limits.joinLeaveWindowMs);
  const ownerActions = new WindowLimiter(limits.ownerActionsPerMinute, 60_000);
  const approvals = new WindowLimiter(limits.approvalsPerMinute, 60_000);
  /** Ownerless teams already reported in the log. */
  const ownerlessLogged = new WeakSet<Team>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  /** False when the data file couldn't be backed up before an upgrade: never overwrite what we couldn't keep. */
  let persist = true;

  const who = (c: Conn) => (c.label ? { ip: c.ip, label: c.label } : { ip: c.ip });
  /** Owners' settings changes count against the `people` log budget, throttled per team and owner. */
  const settingsThrottle = (team: Team, me: Member) => ({ key: `settings|${team.ref}|${me.id}`, perMinute: 20, cls: 'people' as const });
  /**
   * Limit hits are logged at most once a minute per limit and address. `pre`:
   * refused before anyone is authenticated, so it shares the small budget for those.
   */
  function limitHit(kind: string, c: { ip: string; label?: string | null }, key = c.ip, cls?: AuditClass) {
    audit('limit', c.label ? { kind, ip: c.ip, label: c.label } : { kind, ip: c.ip }, { key: `limit|${kind}|${key}`, perMinute: 1, cls });
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

  function fromSaved(t: SavedTeam, now: number): Team {
    // Denials used to be for good; from files of that time they last `denyMs` from now.
    const until = (b: { reason: BanReason; until?: number }) => (b.reason === 'denied' ? { until: b.until ?? now + limits.denyMs } : {});
    const { bannedLabels, ...rest } = t;
    return {
      ...rest,
      roster: new Map(t.roster.map((m) => [m.id, { id: m.id, name: m.name, label: m.label ?? null }])),
      banned: new Map(t.banned.map((b) => [b.id, { id: b.id, label: b.label ?? null, reason: b.reason, ...until(b) }])),
      labelBans: new Map(bannedLabels.map((b) => [b.label, { label: b.label, reason: b.reason, ...until(b) }])),
      pending: new Map(t.pending.map((p) => [p.id, { id: p.id, name: p.name, label: p.label ?? null, at: p.at, addr: null }])),
      online: new Map(),
      brk: null,
      timer: null,
      bcastQueued: false,
      bcastTimer: null,
      lastBroadcastAt: 0,
      bcastGapMs: 0,
      laterTimer: null,
    };
  }

  function toSaved(t: Team): SavedTeam {
    const withLabel = <T extends object>(x: T, label: string | null) => (label ? { ...x, label } : x);
    const withUntil = <T extends object>(x: T, until: number | undefined) => (until ? { ...x, until } : x);
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
      banned: [...t.banned.values()].map((b) => withUntil(withLabel({ id: b.id, reason: b.reason }, b.label), b.until)),
      bannedLabels: [...t.labelBans.values()].map((b) => withUntil({ label: b.label, reason: b.reason }, b.until)),
      pending: [...t.pending.values()].map((p) => withLabel({ id: p.id, name: p.name, at: p.at }, p.label)),
      hadGroupBreak: t.hadGroupBreak,
      createdBy: t.createdBy,
    };
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    load();
  } catch (err) {
    tokens.close();
    auditLog.close();
    throw err;
  }
  // Labels deleted from the tokens file while the hub was stopped.
  const presentLabels = tokens.present();
  if (presentLabels) forgetLabels(presentLabels, null);

  /**
   * Reads the saved teams. A file that exists but can't be read or isn't a
   * team list stops the hub from starting: running with no teams would make
   * every app forget its team, and the next save would overwrite the file.
   */
  function load() {
    let text: string;
    try {
      text = readFileSync(opts.dataFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // No saved teams yet.
      throw new Error(
        `Can't read the team file ${opts.dataFile} (${(err as Error).message}). Fix its owner or permissions; the hub won't start without its teams.`,
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    if (!Array.isArray(data)) {
      const copy = backup('corrupt');
      throw new Error(
        `The team file ${opts.dataFile} is not a valid team list` +
          (copy ? ` (a copy is kept at ${copy}).` : ' (and a copy could not be made).') +
          ' Restore a good copy (e.g. a teams.json.pre-roster-* one, or from backup), or move the file away to start with no teams.',
      );
    }
    const now = Date.now();
    /** Entries that can't be used, by their ref if they have one (never their code). */
    const invalidRefs: string[] = [];
    let expired = 0;
    let droppedLinks = 0;
    let approvalOn = 0;
    for (const [i, raw] of data.entries()) {
      const t = parseSavedTeam(raw, now);
      if (!t || codes.has(t.code)) {
        const ref = (raw as Record<string, unknown> | null)?.ref;
        invalidRefs.push(typeof ref === 'string' && /^[0-9a-f]{8}$/.test(ref) ? `team ${ref} (entry ${i + 1})` : `entry ${i + 1} (no ref)`);
        continue;
      }
      if (now - t.lastActive > limits.teamIdleDays * DAY_MS) {
        expired++;
        continue;
      }
      const rawLink = (raw as Record<string, unknown>).zoomLink;
      if (typeof rawLink === 'string' && rawLink !== '' && t.zoomLink === '') droppedLinks++;
      const team = fromSaved(t, now);
      // Strict mode: every team needs the owner's OK for new people, including teams that had it off.
      if (enterprise && !team.requireApproval) (team.requireApproval = true), approvalOn++;
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
    const invalid = invalidRefs.length;
    if (invalid) {
      // Not one usable entry: as bad as a corrupt file, and starting would make every app forget its team.
      if (invalid === data.length) {
        const copy = backup('corrupt');
        throw new Error(
          `None of the ${invalid} entries in the team file ${opts.dataFile} is a valid team` +
            (copy ? ` (a copy is kept at ${copy}).` : ' (and a copy could not be made).') +
            ' Restore a good copy (e.g. a teams.json.pre-roster-* or .partial-* one, or from backup), or move the file away to start with no teams.',
        );
      }
      // Some are: keep the file as it was before the next save drops the rest, and name each one dropped.
      if (!backup('partial')) persist = false;
      for (const ref of invalidRefs) console.error(`[smoke-break] !!! Dropped ${ref} of ${opts.dataFile}: it isn't a valid team.`);
      console.error(`[smoke-break] !!! Skipped ${invalid} of ${data.length} saved team(s) in ${opts.dataFile} that aren't valid.`);
    }
    if (droppedLinks) console.warn(`[smoke-break] Dropped ${droppedLinks} saved meeting link(s) that aren't allowed Zoom links.`);
    const migrated = data.some(isLegacyEntry);
    if (migrated || upgraded) {
      // The file is about to be rewritten in the new format: keep the old one, like a corrupt file.
      if (backup('pre-roster')) save();
      else persist = false;
    }
    // Strict mode: roster entries from before per-person tokens, each to be bound (the owner's) or re-approved on first use.
    let unlabeled = 0;
    if (enterprise) for (const team of teams) for (const m of team.roster.values()) if (!m.label) unlabeled++;
    if (approvalOn) {
      console.warn(`[smoke-break] Strict mode: switched owner approval back on for ${approvalOn} team(s).`);
      save(); // (not if a copy the save would need couldn't be kept: see above)
    }
    audit(
      'load',
      { teams: teams.size, invalid, invalidRefs: invalid ? invalidRefs.slice(0, 50) : undefined, expired, droppedLinks, migrated, upgradedCodes: upgraded, enterprise, approvalSwitchedOn: approvalOn || undefined, unlabeledMembers: enterprise ? unlabeled : undefined },
      CRITICAL,
    );
  }

  /**
   * Keeps a private copy of the data file (or finds an identical one already
   * kept: see `keepCopy`). Its path, or null if that failed.
   */
  function backup(tag: string): string | null {
    try {
      const { path, existed } = keepCopy(opts.dataFile, tag);
      console.warn(existed ? `[smoke-break] A copy of ${opts.dataFile} as it is now is already kept at ${path}.` : `[smoke-break] Kept a copy of the previous ${opts.dataFile} at ${path}.`);
      return path;
    } catch (err) {
      console.error(`[smoke-break] !!! Couldn't keep a copy of ${opts.dataFile} (${(err as Error).message}). Teams will NOT be saved until this is fixed.`);
      return null;
    }
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
    if (team.laterTimer) clearTimeout(team.laterTimer);
    for (const m of team.online.values()) if (m.leaveTimer) clearTimeout(m.leaveTimer);
    teams.delete(team);
    codes.delete(team.code);
    for (const a of team.aliases) aliasCodes.delete(a);
  }

  /**
   * A team that is really used: it had a break with two or more people, or
   * people with two different token labels (two people) are on its roster.
   * It's never forgotten to make room for a new team.
   */
  function reallyUsed(t: Team): boolean {
    if (t.hadGroupBreak) return true;
    let first: string | null = null;
    for (const m of t.roster.values()) {
      if (!m.label) continue;
      if (first === null) first = m.label;
      else if (m.label !== first) return true;
    }
    return false;
  }

  /**
   * Makes room for a new team by forgetting the least recently used junk team:
   * nobody in it now, idle for `junkTeamIdleMs`, and not really used (one
   * person's devices, however many, or a team made without per-person tokens
   * that never had a break with two or more people). If there is none, the new
   * team is refused: a team people really use is never forgotten for it.
   */
  function roomForTeam(): boolean {
    if (teams.size < limits.maxTeams) return true;
    const junkAfter = Date.now() - limits.junkTeamIdleMs;
    let junk: Team | null = null;
    for (const t of teams) {
      if (t.online.size || t.brk || t.lastActive > junkAfter || reallyUsed(t)) continue;
      if (!junk || t.lastActive < junk.lastActive) junk = t;
    }
    if (!junk) return false;
    forget(junk);
    audit('team-forgotten', { team: junk.ref, owner: junk.ownerId, ownerLabel: ownerLabel(junk) ?? undefined, reason: 'unused, room for a new team' }, CRITICAL);
    save();
    return true;
  }

  /**
   * Teams a token label holds, other than `except`: `owns` (its owner has the
   * label), `created` (made under the label, still there, whoever owns it now)
   * and `held` (either: what counts against `teamsPerLabel`).
   */
  function teamsOf(label: string, except?: Team): { owns: number; created: number; held: number } {
    const n = { owns: 0, created: 0, held: 0 };
    for (const t of teams) {
      if (t === except) continue;
      const owns = ownerLabel(t) === label;
      const created = t.createdBy === label;
      if (owns) n.owns++;
      if (created) n.created++;
      if (owns || created) n.held++;
    }
    return n;
  }

  // ── Sending ────────────────────────────────────────────────────────────

  const isOnline = (team: Team, id: string) => (team.online.get(id)?.sockets.size ?? 0) > 0;

  /** The owner sees whose token each person used, since anyone can type any name. */
  const withLabel = (v: MemberView, label: string | null): MemberView => (label ? { ...v, label } : v);

  function pendingView(team: Team): MemberView[] {
    return [...team.pending.values()].map((p) => withLabel({ id: p.id, name: p.name, online: false }, p.label));
  }

  /**
   * Builds state frames for one team. The team view is serialized at most four
   * times (owner or not × in the break or not), not once per socket: only the
   * owner gets the team link, join requests and token labels, only
   * participants get the break's meeting link.
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
        if (owner) {
          v.zoomLink = team.zoomLink;
          v.pending = pendingView(team);
          const labels = [...team.roster.values()].map((m) => m.label);
          v.members = base.members.map((m, i) => withLabel(m, labels[i]));
        }
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
   * `broadcastIntervalMs` (longer for a big team: see `teamBroadcastBytesPerSecond`),
   * else when that's up; changes in between share it.
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
    const wait = team.lastBroadcastAt + Math.max(limits.broadcastIntervalMs, team.bcastGapMs) - Date.now();
    if (wait <= 0) queueMicrotask(run);
    else team.bcastTimer = setTimeout(run, wait);
  }

  /**
   * For a change made by someone over their limit of changes: the team gets it
   * with the next update anyway, or at the latest once the limit's window is
   * up. However often they do it, that's one update per window.
   */
  function broadcastLater(team: Team) {
    if (team.bcastQueued || team.laterTimer || closed) return;
    team.laterTimer = setTimeout(() => {
      team.laterTimer = null;
      guard(() => {
        if (!closed && teams.has(team)) broadcast(team);
      });
    }, limits.joinLeaveWindowMs);
  }

  /**
   * Counts one change that sends the whole team its state (see
   * `joinLeavePerWindow`) against person `id` in `team` and, with a token, their
   * label. False, with a `limit` line, if either is over.
   */
  function takeChange(team: Team, id: string, conn: Conn, kind: string, now = Date.now()): boolean {
    const limiter = kind === 'join-leave' || kind === 'set-length' ? breakChanges : otherChanges;
    const keys = [`id|${team.ref}|${id}`];
    if (conn.label) keys.push(`label|${team.ref}|${conn.label}`);
    if (keys.some((k) => limiter.blocked(k, now))) {
      limitHit(kind, conn, keys.at(-1));
      return false;
    }
    for (const k of keys) limiter.take(k, now);
    return true;
  }

  function broadcastNow(team: Team) {
    team.lastBroadcastAt = Date.now();
    const frame = framer(team);
    let bytes = 0;
    for (const m of team.online.values()) {
      if (!m.sockets.size) continue;
      const f = frame(m.id);
      for (const ws of m.sockets) sendRaw(ws, f);
      bytes += f.length * m.sockets.size;
    }
    // A big team's update costs more: the next one waits long enough to keep the team within its byte rate.
    team.bcastGapMs = Math.ceil((bytes * 1000) / limits.teamBroadcastBytesPerSecond);
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
    if (!team.hadGroupBreak && (team.brk?.participants.length ?? 0) >= 2) {
      team.hadGroupBreak = true;
      save();
    }
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

  function ban(team: Team, id: string, label: string | null, reason: BanReason, until?: number) {
    team.banned.delete(id);
    team.banned.set(id, until ? { id, label, reason, until } : { id, label, reason });
    if (team.banned.size > MAX_BANNED) team.banned.delete(team.banned.keys().next().value!);
  }

  /** Bans a token label from the team; a removal is never weakened to a denial. */
  function banLabel(team: Team, label: string, reason: BanReason, until?: number) {
    if (team.labelBans.get(label)?.reason === 'removed' && reason !== 'removed') return;
    team.labelBans.delete(label);
    team.labelBans.set(label, until ? { label, reason, until } : { label, reason });
    if (team.labelBans.size > MAX_BANNED) team.labelBans.delete(team.labelBans.keys().next().value!);
  }

  /** A ban that still applies (an expired denial is dropped). */
  function activeBan<K, B extends { reason: BanReason; until?: number }>(map: Map<K, B>, key: K, now: number): B | null {
    const b = map.get(key);
    if (!b) return null;
    if (b.reason === 'denied' && (b.until ?? 0) <= now) {
      map.delete(key);
      save();
      return null;
    }
    return b;
  }

  /** Drops denials that have run out. True if any were dropped. */
  function pruneDenials(team: Team, now = Date.now()): boolean {
    let dropped = false;
    for (const map of [team.banned, team.labelBans] as Map<string, { reason: BanReason; until?: number }>[]) {
      for (const [k, b] of map) {
        if (b.reason === 'denied' && (b.until ?? 0) <= now) (map.delete(k), (dropped = true));
      }
    }
    return dropped;
  }

  /** The owner's own token label: removing or turning away one of their own devices mustn't ban it. */
  function ownerLabel(team: Team): string | null {
    return team.ownerId ? (team.roster.get(team.ownerId)?.label ?? null) : null;
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
      m = { id, sockets: new Set(), leaveTimer: null };
      team.online.set(id, m);
    }
    const comesOnline = m.sockets.size === 0;
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
    const renames = unique !== entry.name;
    // Coming online and a new name are sent to the whole team: limited per person, like joining a break.
    const allowed = comesOnline || renames ? takeChange(team, id, conn, renames && entry.name ? 'rename' : 'presence') : true;
    let changed = comesOnline;
    // Over the limit, the name stays as it was (unless there's none yet: someone from before the roster).
    if (renames && (allowed || !entry.name)) {
      // Owners let people in by name: a later change of name is on record.
      if (entry.name) {
        audit('rename', { ...who(conn), team: team.ref, member: id, from: entry.name, to: unique }, { key: `rename|${team.ref}|${conn.limitKey}` });
      }
      entry.name = unique;
      changed = true;
      save();
    }
    if (conn.label && !entry.label) {
      // An entry from before per-person tokens takes the label of the first token it's used with.
      entry.label = conn.label;
      save();
      audit('unlabeled-member', { ...who(conn), team: team.ref, member: id, outcome: 'bound', owner: id === team.ownerId || undefined }, CRITICAL);
    }
    touch(team);
    sendState(team, ws, id);
    if (changed) {
      if (allowed) broadcast(team);
      else broadcastLater(team);
    }
    return m;
  }

  function detach(team: Team, m: Member, ws: WebSocket, conn: Conn) {
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
    // Going offline is sent to the whole team: limited like coming online.
    if (takeChange(team, m.id, conn, 'presence')) broadcast(team);
    else broadcastLater(team);
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
    // A stranger can cause these as fast as they can connect: throttled per reason and address (or label).
    audit('join-failed', { ...who(conn), reason }, { key: `join-failed|${reason}|${conn.limitKey}` });
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
    // The token was checked before the socket was accepted; one in the message must be that same token.
    if (tokens.required && msg.token !== undefined && !tokens.sameToken(msg.token, conn.tokenDigest)) {
      return refuse(conn, ws, "This hub needs an access token. Ask whoever runs it.", 'unauthorized', 'token-mismatch');
    }
    const clientId = typeof msg.clientId === 'string' ? msg.clientId : '';
    if (!CLIENT_ID.test(clientId)) return refuse(conn, ws, 'Invalid client id.', undefined, 'invalid-client-id');
    // Identified connections have their own caps, which unidentified ones can't use up.
    if (joinedTotal >= limits.maxConnections) {
      limitHit('connections-total', conn, '*');
      return refuse(conn, ws, 'This server is busy. Try again later.', 'full', 'connections-total');
    }
    if ((joinedCounts.get(conn.limitKey) ?? 0) >= limits.connectionsPerIp) {
      const kind = conn.label ? 'connections-per-label' : 'connections-per-ip';
      limitHit(kind, conn, conn.limitKey);
      return refuse(conn, ws, 'Too many connections from here. Try again later.', 'rate-limited', kind);
    }
    const name = cleanName(msg.name, 'Someone');
    if (msg.type === 'create') createTeam(conn, ws, clientId, name, msg.teamName);
    else joinTeam(conn, ws, clientId, name, msg.teamCode);
  }

  function createTeam(conn: Conn, ws: WebSocket, clientId: string, name: string, teamName: unknown) {
    // One person can only hold a few teams (owned, or made and handed over), so nobody can hoard the hub's room for teams.
    if (conn.label && teamsOf(conn.label).held >= limits.teamsPerLabel) {
      limitHit('teams-per-label', conn, conn.limitKey);
      return refuse(
        conn,
        ws,
        `You already have ${limits.teamsPerLabel} teams (ones you own, and ones you made and handed over). Ask whoever runs the hub to delete one you no longer need.`,
        'full',
        'teams-per-label',
      );
    }
    // People with their own token have their own quota; the per-address and hub-wide ones are for everyone else.
    const why = conn.label
      ? !createsPerLabel.take(conn.label) && 'creates-per-label'
      : (!creates.take(conn.key) && 'creates-per-ip') || (!createsGlobal.take('*') && 'creates-global');
    if (why) {
      limitHit(why, conn, why === 'creates-global' ? '*' : conn.limitKey);
      return refuse(conn, ws, 'Too many new teams. Try again later.', 'rate-limited', why);
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
      labelBans: new Map(),
      hadGroupBreak: false,
      createdBy: conn.label,
      pending: new Map(),
      online: new Map(),
      lastActive: Date.now(),
      brk: null,
      timer: null,
      bcastQueued: false,
      bcastTimer: null,
      lastBroadcastAt: 0,
      bcastGapMs: 0,
      laterTimer: null,
    };
    teams.add(team);
    codes.set(code, team);
    save();
    // Per label: the teams it holds (owns, and made that still exist) and has made in the last day, so hoarding shows in the log.
    const held = conn.label ? teamsOf(conn.label) : null;
    const totals = held
      ? { labelTeams: held.held, labelOwns: held.owns, labelCreated: held.created, labelCreatesToday: createsPerLabel.count(conn.label!) }
      : {};
    audit('create', { ...who(conn), team: team.ref, member: ownerId, name, ...totals });
    join(conn, ws, team, ownerId, name);
  }

  /** Moves a connection from the unidentified count to the identified one. */
  function identify(conn: Conn) {
    leavePool(conn);
    conn.pool = 'joined';
    inc(joinedCounts, conn.limitKey);
    joinedTotal++;
  }

  function leavePool(conn: Conn) {
    if (conn.pool === 'pre') {
      dec(preCounts, conn.preKey);
      preTotal--;
    } else if (conn.pool === 'joined') {
      dec(joinedCounts, conn.limitKey);
      joinedTotal--;
    }
    conn.pool = null;
  }

  function join(conn: Conn, ws: WebSocket, team: Team, id: string, name: string) {
    clearTimeout(conn.helloTimer);
    conn.state = 'joined';
    conn.team = team;
    identify(conn);
    conn.me = attach(team, ws, conn, id, name);
  }

  function joinTeam(conn: Conn, ws: WebSocket, clientId: string, name: string, teamCode: unknown) {
    const code = typeof teamCode === 'string' && teamCode.length <= 64 ? normalizeCode(teamCode) : '';
    const current = code ? codes.get(code) : undefined;
    const team = current ?? (code ? aliasCodes.get(code) : undefined);
    const id = team ? publicId(team.idSalt, clientId) : '';
    const entry = team?.roster.get(id);
    // A roster entry made under a per-person token belongs to that token's label: no other
    // token (a colleague's, a shared one, none) can use it, so revoking the label cuts it off.
    if (entry?.label && entry.label !== conn.label) {
      return refuse(conn, ws, 'This device joined the team with a different access token. Use that one.', 'unauthorized', 'label-mismatch', limits.badCodeDelayMs);
    }
    const onRoster = !!entry;
    // Someone on the roster with a right (or recent) code isn't guessing: the lockout doesn't apply to them.
    if (badCodes.blocked(conn.limitKey) && !onRoster) {
      limitHit('bad-codes', conn, conn.limitKey);
      return refuse(conn, ws, 'Too many wrong invite codes. Try again in a few minutes.', 'rate-limited', 'locked-out', limits.badCodeDelayMs);
    }
    // An old code only lets the roster straight in; from anyone else it's wrong. One exception:
    // a short code from before rosters existed, on a team whose owner hasn't replaced the code
    // since, counts as a join request the owner can approve or turn down. That's how teammates
    // from before the upgrade get back in instead of being told their team is gone.
    const legacyRequest =
      !!team && team.requireApproval && code.length < CODE_LENGTH && team.aliases.length === 1 && team.aliases[0] === code;
    // Someone already waiting keeps waiting with an old code (say, a device from before per-person
    // tokens that was moved from the roster to the waiting list): only the owner's OK lets them in.
    const waiting = !!team && !current && !onRoster && team.pending.has(id);
    if (!team || (!current && !onRoster && !legacyRequest && !waiting)) {
      badCodes.take(conn.limitKey);
      return refuse(conn, ws, 'No team with that invite code.', 'bad-code', 'bad-code', limits.badCodeDelayMs);
    }
    const now = Date.now();
    const banned = activeBan(team.banned, id, now);
    if (banned) return refuseBanned(conn, ws, banned.reason);
    // A roster entry without a label is from before per-person tokens: it gets the label of
    // the first token it's used with, so until then it's checked like someone new.
    const unlabeled = !!entry && !entry.label && !!conn.label;
    // A label that was removed (or, for a while, turned away) can't come back as a "new device",
    // nor through a device of theirs that hasn't connected since the hub switched to per-person tokens.
    const labelBan = conn.label && (!onRoster || unlabeled) ? activeBan(team.labelBans, conn.label, now) : null;
    if (labelBan) {
      // That device is theirs: it goes the way their labelled ones went (never the owner's entry, so the team keeps its owner).
      if (unlabeled && id !== team.ownerId) {
        team.roster.delete(id);
        ban(team, id, conn.label, labelBan.reason, labelBan.until);
        save();
        broadcast(team);
        audit('unlabeled-member', { ...who(conn), team: team.ref, member: id, outcome: 'dropped', reason: labelBan.reason }, CRITICAL);
      }
      return refuseBanned(conn, ws, labelBan.reason);
    }
    if (waiting) {
      if (team.ownerId === null) return refuseOwnerless(conn, ws, team);
      return refuse(conn, ws, "The team's owner needs to let you in. Ask them, then try again.", 'pending', 'pending');
    }
    if (onRoster) {
      if (team.ownerId === null) return refuseOwnerless(conn, ws, team);
      // Where the owner decides who joins, that first token isn't taken on trust (it may be a revoked
      // person's device with a colleague's token): the owner approves it with its label in view. The
      // owner's own entry binds on first use, so that someone can approve the rest.
      if (unlabeled && id !== team.ownerId && (enterprise || team.requireApproval)) return rejoinRequest(conn, ws, team, id, entry.name || name);
      join(conn, ws, team, id, name);
      return audit('join', { ...who(conn), team: team.ref, member: id, name: team.roster.get(id)!.name }, { key: `join|${team.ref}|${id}` });
    }

    // Someone new.
    if (conn.label && identitiesOf(team, conn.label, id) >= limits.identitiesPerLabel) {
      limitHit('identities-per-label', conn, `${team.ref}|${conn.label}`);
      return refuse(conn, ws, 'Too many devices on this team for your access token. Ask the owner to remove an old one.', 'full', 'identities-per-label');
    }
    if (team.roster.size >= limits.maxMembersPerTeam) {
      limitHit('members-per-team', conn, team.ref);
      return refuse(conn, ws, 'This team is full.', 'full', 'team-full');
    }
    // A team saved before owners existed has nobody to let people in: they wait for the hub admin.
    if (team.ownerId === null) {
      if (recordRequest(conn, ws, team, id, name)) refuseOwnerless(conn, ws, team);
      return;
    }
    if (team.requireApproval) {
      if (!recordRequest(conn, ws, team, id, name)) return;
      return refuse(conn, ws, "The team's owner needs to let you in. Ask them, then try again.", 'pending', 'pending');
    }
    addToRoster(team, id, name, conn.label);
    join(conn, ws, team, id, name);
    audit('join', { ...who(conn), team: team.ref, member: id, name: team.roster.get(id)!.name, first: true });
  }

  /**
   * Moves a roster entry from before per-person tokens to the waiting list,
   * under the label of the token it was just used with, for the owner to
   * approve (or turn away) like anyone new.
   */
  function rejoinRequest(conn: Conn, ws: WebSocket, team: Team, id: string, name: string) {
    if (identitiesOf(team, conn.label!, id) >= limits.identitiesPerLabel) {
      limitHit('identities-per-label', conn, `${team.ref}|${conn.label}`);
      return refuse(conn, ws, 'Too many devices on this team for your access token. Ask the owner to remove an old one.', 'full', 'identities-per-label');
    }
    // The entry stays on the roster if the request is refused for being over a limit.
    if (!recordRequest(conn, ws, team, id, name)) return;
    team.roster.delete(id);
    save();
    broadcast(team);
    audit('unlabeled-member', { ...who(conn), team: team.ref, member: id, outcome: 'waiting' }, CRITICAL);
    return refuse(conn, ws, "The team's owner needs to let you in. Ask them, then try again.", 'pending', 'pending');
  }

  function refuseBanned(conn: Conn, ws: WebSocket, reason: BanReason) {
    return reason === 'denied'
      ? refuse(conn, ws, "The team's owner didn't let you in. You can ask again tomorrow.", 'denied', 'denied', limits.badCodeDelayMs)
      : refuse(conn, ws, 'You were removed from this team.', 'removed', 'removed', limits.badCodeDelayMs);
  }

  /** Nobody gets into an ownerless team (keep it, try later) until an admin runs `admin.ts set-owner`. */
  function refuseOwnerless(conn: Conn, ws: WebSocket, team: Team) {
    if (!ownerlessLogged.has(team)) {
      ownerlessLogged.add(team);
      audit('ownerless-team', { team: team.ref, fix: 'node server/admin.ts list, then set-owner <team-ref> <member-id>' }, CRITICAL);
    }
    refuse(conn, ws, 'This team has no owner, so nobody can let you in. Ask whoever runs the hub to make someone its owner.', 'pending', 'ownerless');
  }

  /**
   * Records (or keeps) a join request for the owner. False if it was refused
   * for being over a limit (the refusal is already on its way).
   */
  function recordRequest(conn: Conn, ws: WebSocket, team: Team, id: string, name: string): boolean {
    const now = Date.now();
    if (prunePending(team, now)) (save(), broadcast(team));
    if (team.pending.has(id)) return true;
    let fromHere = 0;
    for (const p of team.pending.values()) if (p.addr === conn.limitKey) fromHere++;
    const why =
      team.pending.size >= limits.maxPending
        ? 'pending-full'
        : fromHere >= limits.pendingPerIp
          ? 'pending-per-ip'
          : !joinRequests.take(conn.limitKey)
            ? 'pending-rate'
            : null;
    if (why) {
      limitHit(why, conn, why === 'pending-full' ? team.ref : conn.limitKey);
      refuse(conn, ws, 'Too many people are waiting to join this team. Try again later.', 'rate-limited', why);
      return false;
    }
    // Waiting names can't pass for someone on the roster (or another waiting person) either.
    // (Not their own roster name: someone moved from the roster to the waiting list keeps it.)
    const taken = rosterNames(team, id);
    for (const p of team.pending.values()) taken.add(nameKey(p.name));
    const entry = { id, name: uniqueName(taken, name), label: conn.label, at: now, addr: conn.limitKey };
    team.pending.set(id, entry);
    save();
    broadcast(team);
    audit('join-requested', { ...who(conn), team: team.ref, member: id, name: entry.name }, { key: `join-requested|${conn.limitKey}` });
    return true;
  }

  // ── Owner actions ──────────────────────────────────────────────────────

  /** Rate limits an owner action (per team and owner). False, after telling them, when over. */
  function ownerMay(limiter: WindowLimiter, team: Team, me: Member, ws: WebSocket, conn: Conn): boolean {
    if (limiter.take(`${team.ref}|${me.id}`)) return true;
    limitHit('owner-actions', conn, `${team.ref}|${me.id}`);
    sendError(ws, 'Slow down: try that again in a minute.');
    return false;
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
    if (msg.requireApproval !== undefined && typeof msg.requireApproval !== 'boolean') {
      return sendError(ws, 'requireApproval must be true or false.');
    }
    if (enterprise && msg.requireApproval === false) {
      return sendError(ws, "This hub requires the owner's approval for new members on every team, so it can't be switched off.");
    }

    const len = typeof msg.defaultLengthMin === 'number' ? clampLength(msg.defaultLengthMin) : team.defaultLengthMin;
    const name = typeof msg.teamName === 'string' ? cleanName(msg.teamName, team.name) : team.name;
    const approval = typeof msg.requireApproval === 'boolean' ? msg.requireApproval : team.requireApproval;
    const changed: string[] = [];
    if (link !== undefined && link !== team.zoomLink) changed.push('zoomLink');
    if (len !== team.defaultLengthMin) changed.push('defaultLengthMin');
    if (name !== team.name) changed.push('teamName');
    if (approval !== team.requireApproval) changed.push('requireApproval');
    // Nothing changed, nothing sent: a no-op must not cost a broadcast.
    if (!changed.length) return;
    if (!takeChange(team, me.id, conn, 'settings')) return sendError(ws, 'Slow down: wait a few seconds before changing settings again.');
    if (link !== undefined && link !== team.zoomLink) {
      team.zoomLink = link;
      // Fixed links are known up front, so an active break picks up the new one.
      if (team.meetingProvider === 'fixed-link' && team.brk?.meetingRequested) {
        team.brk = { ...team.brk, meetingUrl: link || null };
      }
    }
    team.defaultLengthMin = len;
    team.name = name;
    team.requireApproval = approval;
    save();
    audit('settings', { ...who(conn), team: team.ref, member: me.id, changed }, settingsThrottle(team, me));
    broadcast(team);
  }

  function rotateCode(team: Team, me: Member, ws: WebSocket, conn: Conn) {
    if (me.id !== team.ownerId) return sendError(ws, 'Only the team owner can change the invite code.');
    if (!ownerMay(ownerActions, team, me, ws, conn)) return;
    replaceCode(team);
    save();
    audit('rotate-code', { ...who(conn), team: team.ref, member: me.id }, CRITICAL);
    broadcast(team);
  }

  /**
   * Takes someone on the roster (online or not) off the team for good, and
   * replaces the code they know. A token label is one person, so someone with a
   * per-person token is removed as a person: every identity under that label
   * goes, and the label is banned, all before the new code goes out. An
   * identity under the owner's own label is one of the owner's devices: only
   * that device is removed (and its identity banned), never the owner's label.
   */
  function removeMember(team: Team, me: Member, ws: WebSocket, conn: Conn, msg: Record<string, unknown>) {
    if (me.id !== team.ownerId) return sendError(ws, 'Only the team owner can remove people.');
    const id = typeof msg.id === 'string' ? msg.id : '';
    if (id === me.id) return sendError(ws, "You can't remove yourself.");
    const entry = PUBLIC_ID.test(id) ? team.roster.get(id) : undefined;
    if (!entry) return sendError(ws, 'No such member.');
    if (!ownerMay(ownerActions, team, me, ws, conn)) return;

    const label = entry.label && entry.label !== ownerLabel(team) ? entry.label : null;
    const gone = label ? [...team.roster.values()].filter((m) => m.label === label) : [entry];
    for (const m of gone) {
      team.roster.delete(m.id);
      ban(team, m.id, m.label, 'removed');
      // Their sockets are closed before anything is broadcast, so the new code never reaches them.
      disconnectMember(team, m.id, 'You were removed from this team.', 'removed');
    }
    if (label) {
      banLabel(team, label, 'removed');
      for (const p of team.pending.values()) if (p.label === label) team.pending.delete(p.id);
    }
    replaceCode(team);
    save();
    const also = gone.filter((m) => m.id !== id).map((m) => m.id);
    audit(
      'remove-member',
      {
        ...who(conn),
        team: team.ref,
        member: me.id,
        removed: id,
        removedLabel: entry.label ?? undefined,
        ownDevice: entry.label && !label ? true : undefined,
        alsoRemoved: also.length ? also : undefined,
      },
      CRITICAL,
    );
    for (const m of gone) apply(team, machine.leave(team.brk, m.id, Date.now()));
    broadcast(team);
  }

  /** Lets a waiting person in, or turns them away: they (and their label) can't ask again for `denyMs`. */
  function approveMember(team: Team, me: Member, ws: WebSocket, conn: Conn, msg: Record<string, unknown>) {
    if (me.id !== team.ownerId) return sendError(ws, 'Only the team owner can let people in.');
    if (typeof msg.allow !== 'boolean') return sendError(ws, 'allow must be true or false.');
    const id = typeof msg.id === 'string' ? msg.id : '';
    prunePending(team);
    const entry = team.pending.get(id);
    if (!entry) return sendError(ws, 'No such request.');
    if (msg.allow && team.roster.size >= limits.maxMembersPerTeam) return sendError(ws, 'The team is full.');
    if (!ownerMay(approvals, team, me, ws, conn)) return;
    if (msg.allow) {
      addToRoster(team, id, entry.name, entry.label);
      audit('approve-member', { ...who(conn), team: team.ref, member: me.id, approved: id, approvedLabel: entry.label ?? undefined }, CRITICAL);
    } else {
      const until = Date.now() + limits.denyMs;
      team.pending.delete(id);
      ban(team, id, entry.label, 'denied', until);
      if (entry.label && entry.label !== ownerLabel(team)) {
        banLabel(team, entry.label, 'denied', until);
        for (const p of team.pending.values()) if (p.label === entry.label) team.pending.delete(p.id);
      }
      audit('deny-member', { ...who(conn), team: team.ref, member: me.id, denied: id, deniedLabel: entry.label ?? undefined }, CRITICAL);
    }
    save();
    broadcast(team);
  }

  function transferOwner(team: Team, me: Member, ws: WebSocket, conn: Conn, msg: Record<string, unknown>) {
    if (me.id !== team.ownerId) return sendError(ws, 'Only the team owner can hand the team over.');
    const id = typeof msg.id === 'string' ? msg.id : '';
    if (id === me.id) return sendError(ws, 'You already own this team.');
    const target = PUBLIC_ID.test(id) ? team.roster.get(id) : undefined;
    if (!target) return sendError(ws, 'No such member.');
    // With per-person tokens, an entry from before them isn't tied to anyone yet: whoever used that
    // device first, with any valid token, would become the owner without ever being approved.
    if (tokens.mode === 'file' && !target.label) {
      return sendError(ws, `${target.name || 'That person'} hasn't connected since this hub started using per-person access tokens. They need to connect once before they can own the team.`);
    }
    // Handing a team over doesn't free a slot (it still counts for whoever made it), and can't push anyone over the cap.
    const to = target.label ? teamsOf(target.label, team) : null;
    if (to && to.held >= limits.teamsPerLabel) {
      limitHit('teams-per-label', conn, `${team.ref}|${target.label}`);
      return sendError(ws, `${target.name || 'That person'} already has ${limits.teamsPerLabel} teams, so they can't take on another.`);
    }
    if (!ownerMay(ownerActions, team, me, ws, conn)) return;
    team.ownerId = id;
    save();
    // Both labels' totals after the handover, so teams moving between people show in the log.
    const from = conn.label ? teamsOf(conn.label) : null;
    const after = target.label ? teamsOf(target.label) : null;
    audit(
      'transfer-owner',
      {
        ...who(conn),
        team: team.ref,
        member: me.id,
        to: id,
        toLabel: target.label ?? undefined,
        createdBy: team.createdBy ?? undefined,
        labelOwns: from?.owns,
        labelCreated: from?.created,
        toLabelOwns: after?.owns,
        toLabelCreated: after?.created,
      },
      CRITICAL,
    );
    broadcast(team);
  }

  /**
   * Joins or leaves a break, or changes its length, if that changes anything:
   * a handful of changes per person every `joinLeaveWindowMs`, since each one
   * sends the whole team its state. Over that, they're told to slow down and
   * nothing changes.
   */
  function changeBreak(team: Team, me: Member, ws: WebSocket, conn: Conn, result: machine.Result, now: number, kind = 'join-leave') {
    if (!result.error && !result.effects.length && sameBreak(result.brk, team.brk)) return;
    if (!result.error && !takeChange(team, me.id, conn, kind, now)) {
      return sendError(ws, kind === 'join-leave' ? 'Slow down: wait a few seconds before joining or leaving again.' : 'Slow down: wait a few seconds before changing that again.');
    }
    apply(team, result, ws);
  }

  function handle(conn: Conn, ws: WebSocket, msg: Record<string, unknown>) {
    const team = conn.team!;
    const me = conn.me!;
    const now = Date.now();
    const self = { id: me.id, name: team.roster.get(me.id)?.name ?? '' };
    switch (msg.type) {
      case 'invite': {
        // During a break, inviting is joining it.
        if (machine.isActive(team.brk)) return changeBreak(team, me, ws, conn, machine.join(team.brk, self, now), now);
        // Per roster entry (so reconnecting doesn't reset it) and per label (so extra devices don't multiply it).
        const keys = [`id|${team.ref}|${me.id}`];
        if (conn.label) keys.push(`label|${team.ref}|${conn.label}`);
        if (keys.some((k) => breakStarts.blocked(k, now))) {
          limitHit('break-cooldown', conn, keys.at(-1));
          return sendError(ws, 'Wait a few seconds before starting another break.');
        }
        for (const k of keys) breakStarts.take(k, now);
        return apply(team, machine.invite(team.brk, self, team.defaultLengthMin, now, randomUUID(), MINUTE_MS), ws);
      }
      case 'setLength':
        if (typeof msg.lengthMin !== 'number') return sendError(ws, 'The length must be a number of minutes.');
        return changeBreak(team, me, ws, conn, machine.setLength(team.brk, me.id, msg.lengthMin), now, 'set-length');
      case 'join':
        return changeBreak(team, me, ws, conn, machine.join(team.brk, self, now, msg.light === true), now);
      case 'light':
        return apply(team, machine.lightUp(team.brk, me.id, now), ws);
      case 'leave':
        return changeBreak(team, me, ws, conn, machine.leave(team.brk, me.id, now), now);
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

  /** The message budget shared by every identified socket of one label, or (without a label) one address. */
  function messageBucket(key: string): TokenBucket {
    let b = messageBuckets.get(key);
    if (b) messageBuckets.delete(key);
    else b = new TokenBucket(limits.addressMessageBurst, limits.addressMessagesPerSecond);
    messageBuckets.set(key, b); // most recently used last
    if (messageBuckets.size > MAX_ADDRESS_BUCKETS) messageBuckets.delete(messageBuckets.keys().next().value!);
    return b;
  }

  function parseMessage(raw: RawData, isBinary: boolean): Record<string, unknown> | null {
    if (isBinary) return null;
    let data: unknown;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return null;
    }
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  }

  function onMessage(conn: Conn, ws: WebSocket, raw: RawData, isBinary: boolean, bucket: TokenBucket) {
    if (conn.state === 'done' || conn.state === 'refusing') return;
    if (conn.state === 'new') {
      // Not identified yet: a create/hello, or a couple of anything else, and nothing is
      // charged to a budget an identified socket depends on.
      const msg = parseMessage(raw, isBinary);
      if (msg && (msg.type === 'create' || msg.type === 'hello')) return onHello(conn, ws, msg);
      if (++conn.preMsgs > limits.messagesBeforeHello) {
        limitHit('messages-before-hello', conn, conn.preKey);
        conn.state = 'done';
        ws.close(1008, 'Say hello first');
      }
      return;
    }
    // Only a socket's own flooding closes it.
    if (!bucket.take()) {
      if (++conn.dropped > MAX_DROPPED_MESSAGES) {
        limitHit('message-flood', conn, conn.limitKey);
        conn.state = 'done';
        ws.close(1008, 'Too many messages');
      }
      return;
    }
    // The shared budget: running out of it drops the message, but never closes the socket.
    if (!messageBucket(conn.limitKey).take()) return limitHit('message-budget', conn, conn.limitKey);
    const msg = parseMessage(raw, isBinary);
    if (msg && conn.team && conn.me) handle(conn, ws, msg);
  }

  /** After the tokens file was read again (or turned out broken): connections whose token is gone are closed. */
  function closeRevoked(valid: (label: string | null, digest: Buffer | null) => boolean) {
    const message = tokens.broken
      ? "The hub can't check access tokens right now. Try again later."
      : 'Your access to this hub was revoked.';
    /** One line per label (never dropped), however many of its connections were closed. */
    const closed = new Map<string | null, { ips: Set<string>; teams: Set<string>; connections: number }>();
    for (const [ws, conn] of conns) {
      if ((conn.state !== 'joined' && conn.state !== 'new') || valid(conn.label, conn.tokenDigest)) continue;
      conn.state = 'done';
      let c = closed.get(conn.label);
      if (!c) closed.set(conn.label, (c = { ips: new Set(), teams: new Set(), connections: 0 }));
      c.connections++;
      if (c.ips.size < 20) c.ips.add(conn.ip);
      if (conn.team && c.teams.size < 20) c.teams.add(conn.team.ref);
      sendError(ws, message, true, 'unauthorized');
      ws.close(1008, 'unauthorized');
    }
    for (const [label, c] of closed) {
      audit('token-revoked', { label: label ?? undefined, connections: c.connections, ips: [...c.ips], teams: [...c.teams], broken: !!tokens.broken }, CRITICAL);
    }
  }

  function onTokensChange(change: TokensChange) {
    closeRevoked(change.valid);
    if (change.present) forgetLabels(change.present, change.revoked);
  }

  /**
   * Labels no longer in the tokens file: their join requests are dropped, and
   * teams they own are reported so an admin can hand them over (`revoked` null:
   * at startup, report every such team).
   */
  function forgetLabels(present: Set<string>, revoked: string[] | null) {
    if (revoked && !revoked.length) return;
    for (const team of teams) {
      let dropped = false;
      for (const p of team.pending.values()) {
        if (p.label && !present.has(p.label)) (team.pending.delete(p.id), (dropped = true));
      }
      if (dropped) (save(), broadcast(team));
      const label = ownerLabel(team);
      if (label && !present.has(label) && (!revoked || revoked.includes(label))) {
        audit(
          'owner-token-revoked',
          { team: team.ref, owner: team.ownerId, label, fix: `node server/admin.ts set-owner ${team.ref} <member-id> (see: node server/admin.ts list)` },
          CRITICAL,
        );
      }
    }
  }

  function onConnection(ws: WebSocket, ip: string, key: string, preKey: string, access: { label: string | null; digest: Buffer | null }) {
    const conn: Conn = {
      ip,
      key,
      limitKey: access.label ? `label:${access.label}` : key,
      preKey,
      pool: 'pre',
      preMsgs: 0,
      alive: true,
      state: 'new',
      team: null,
      me: null,
      label: access.label,
      tokenDigest: access.digest,
      dropped: 0,
      // A socket that never says who it is would otherwise hold a connection slot.
      helloTimer: setTimeout(() => {
        if (conn.state !== 'new') return;
        limitHit('hello-timeout', conn, preKey);
        ws.terminate();
      }, limits.helloTimeoutMs),
    };
    conns.set(ws, conn);
    inc(preCounts, preKey);
    preTotal++;
    const bucket = new TokenBucket(limits.messageBurst, limits.messagesPerSecond);
    // e.g. an oversized frame. ws closes the socket itself; without a listener the error would crash the hub.
    ws.on('error', () => {});
    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (raw, isBinary) => guard(() => onMessage(conn, ws, raw, isBinary, bucket)));
    ws.on('close', () =>
      guard(() => {
        clearTimeout(conn.helloTimer);
        conns.delete(ws);
        leavePool(conn);
        const { team, me } = conn;
        // Removed members were already taken out; don't touch whoever has their slot now.
        if (team && me && team.online.get(me.id) === me) detach(team, me, ws, conn);
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
        const idleBefore = Date.now() - limits.teamIdleDays * DAY_MS;
        for (const team of teams) {
          // Like on load: a team nobody has used for `teamIdleDays` is forgotten (never one in use right now).
          if (team.lastActive < idleBefore && !team.online.size && !team.brk) {
            forget(team);
            audit('team-forgotten', { team: team.ref, owner: team.ownerId, reason: `idle ${limits.teamIdleDays} days` }, CRITICAL);
            save();
            continue;
          }
          if (prunePending(team)) (save(), broadcast(team));
          if (pruneDenials(team)) save();
        }
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
    stats: () => ({
      teams: teams.size,
      connections: conns.size,
      identified: joinedTotal,
      unidentified: preTotal,
      tokenLabels: tokens.labels,
      tokensRequired: tokens.required,
      tokenMode: tokens.mode,
      tokensBroken: tokens.broken !== null,
      proxySecret: !!proxyDigest,
      /** Strict mode believes X-Forwarded-For from loopback, SMOKE_BREAK_TRUST_PROXY being unset (see `defaultsToLoopbackProxy`). */
      loopbackProxyDefault,
      enterprise,
      /** One startup warning each: recommended protections this hub runs without (never in strict mode, which refuses to start instead), and a non-loopback HOST. */
      warnings: deployment.warnings,
    }),
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
        if (team.laterTimer) clearTimeout(team.laterTimer);
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
        // With a proxy secret, only the proxy gets in: nobody can connect around it or fake X-Forwarded-For.
        if (proxyDigest) {
          const given = req.headers[PROXY_HEADER];
          if (typeof given !== 'string' || !timingSafeEqual(sha256(given), proxyDigest)) {
            const peer = req.socket.remoteAddress ?? 'unix';
            limitHit('proxy-secret', { ip: peer }, peer, 'pre');
            return reject(socket, '403 Forbidden');
          }
        }
        const ip = clientAddress(req, trusted, opts.unixSocket ?? false);
        const key = addressKey(ip);
        if (!isAllowedHost(req.headers.host, policy) || !isAllowedOrigin(req.headers.origin, req.headers.host, policy)) {
          limitHit('origin', { ip }, key, 'pre');
          return reject(socket, '403 Forbidden');
        }
        // The token comes with the upgrade (as a subprotocol), so strangers never get a socket.
        const access = tokens.check(tokens.required ? tokenFromProtocols(offeredProtocols(req)) : undefined);
        if (!access) {
          limitHit('unauthorized', { ip }, key, 'pre');
          return reject(socket, '401 Unauthorized');
        }
        // Until create/hello, a connection only counts against these small, separate budgets.
        const preKey = access.label ? `label:${access.label}` : addressKey(ip, 56);
        if (preTotal >= limits.maxUnidentified) {
          limitHit('unidentified-total', { ip, label: access.label }, '*');
          return reject(socket, '503 Service Unavailable');
        }
        if ((preCounts.get(preKey) ?? 0) >= limits.unidentifiedPerIp) {
          limitHit('unidentified-per-ip', { ip, label: access.label }, preKey);
          return reject(socket, '429 Too Many Requests');
        }
        wss.handleUpgrade(req, socket, head, (ws) => guard(() => onConnection(ws, ip, key, preKey, access)));
      } catch (err) {
        console.error('[smoke-break] internal error during upgrade (ignored):', err);
        socket.destroy();
      }
    },
  };
}
