// The saved team file: its format, migration from older formats, and safe writes.

import { randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_LENGTH_MIN, type MeetingProviderKind, clampLength, normalizeMeetingLink } from '../shared/protocol.ts';
import { cleanName } from './names.ts';

/** Where teams are saved: $SMOKE_BREAK_DATA_DIR/teams.json, else .data/teams.json in the repo. */
export function dataFileFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.SMOKE_BREAK_DATA_DIR?.trim();
  return dir ? resolve(dir, 'teams.json') : resolve(import.meta.dirname, '../.data/teams.json');
}

export const PUBLIC_ID = /^[A-Za-z0-9_-]{16}$/;
export const SAVED_CODE = /^[A-Z0-9]{4,16}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;
/** Read limits, so a hand-edited file can't make the hub hold huge lists. New entries are capped lower by the hub. */
const MAX_SAVED_ROSTER = 1000;
const MAX_SAVED_BANNED = 1000;
const MAX_SAVED_PENDING = 100;
export const MAX_ALIASES = 5;

export type BanReason = 'removed' | 'denied';

export interface SavedMember {
  /** Public id. */
  id: string;
  /** Last name they used; '' for people from before the roster existed, until they reconnect. */
  name: string;
  /** The access-token label they joined with, if the hub uses per-person tokens. */
  label?: string;
}

export interface SavedBan {
  id: string;
  label?: string;
  reason: BanReason;
}

export interface SavedPending {
  id: string;
  name: string;
  label?: string;
  /** When they first asked (ms). */
  at: number;
}

export interface SavedTeam {
  code: string;
  /** Earlier codes, oldest first. They only let in people already on the roster. */
  aliases: string[];
  idSalt: string;
  ref: string;
  name: string;
  defaultLengthMin: number;
  zoomLink: string;
  meetingProvider: MeetingProviderKind;
  ownerId: string | null;
  lastActive: number;
  requireApproval: boolean;
  roster: SavedMember[];
  banned: SavedBan[];
  pending: SavedPending[];
}

export const randomRef = () => randomBytes(4).toString('hex');

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const labelOf = (v: unknown) => (typeof v === 'string' && LABEL.test(v) ? v : undefined);

/** Keeps the last occurrence of each id, in order, at most `max` (the newest). */
function byId<T extends { id: string }>(items: T[], max: number): T[] {
  const m = new Map<string, T>();
  for (const x of items) {
    m.delete(x.id);
    m.set(x.id, x);
  }
  return [...m.values()].slice(-max);
}

function parseRoster(r: Record<string, unknown>): SavedMember[] {
  // Before the roster, `known` listed the public ids of everyone who had joined; their names weren't kept.
  const raw = Array.isArray(r.roster) ? r.roster : Array.isArray(r.known) ? r.known : [];
  const out: SavedMember[] = [];
  for (const x of raw) {
    if (typeof x === 'string' && PUBLIC_ID.test(x)) out.push({ id: x, name: '' });
    else if (isObj(x) && typeof x.id === 'string' && PUBLIC_ID.test(x.id)) {
      const m: SavedMember = { id: x.id, name: typeof x.name === 'string' ? cleanName(x.name, '') : '' };
      const label = labelOf(x.label);
      if (label) m.label = label;
      out.push(m);
    }
  }
  return byId(out, MAX_SAVED_ROSTER);
}

function parseBanned(r: Record<string, unknown>): SavedBan[] {
  const raw = Array.isArray(r.banned) ? r.banned : [];
  const out: SavedBan[] = [];
  for (const x of raw) {
    // Bans used to be bare public ids, all from removals.
    if (typeof x === 'string' && PUBLIC_ID.test(x)) out.push({ id: x, reason: 'removed' });
    else if (isObj(x) && typeof x.id === 'string' && PUBLIC_ID.test(x.id)) {
      const b: SavedBan = { id: x.id, reason: x.reason === 'denied' ? 'denied' : 'removed' };
      const label = labelOf(x.label);
      if (label) b.label = label;
      out.push(b);
    }
  }
  return byId(out, MAX_SAVED_BANNED);
}

function parsePending(r: Record<string, unknown>, now: number): SavedPending[] {
  const raw = Array.isArray(r.pending) ? r.pending : [];
  const out: SavedPending[] = [];
  for (const x of raw) {
    if (!isObj(x) || typeof x.id !== 'string' || !PUBLIC_ID.test(x.id)) continue;
    const at = typeof x.at === 'number' && Number.isFinite(x.at) ? Math.min(x.at, now) : now;
    const p: SavedPending = { id: x.id, name: cleanName(x.name, 'Someone'), at };
    const label = labelOf(x.label);
    if (label) p.label = label;
    out.push(p);
  }
  return byId(out, MAX_SAVED_PENDING);
}

/**
 * Checks every field of a saved team and migrates older formats: `known` ids
 * become roster entries without a name, bare banned ids become removals, the
 * owner is always on the roster, and approval is on unless the file says
 * otherwise. Returns null for entries that can't be used (no valid code);
 * fixes up anything else rather than trusting it.
 */
export function parseSavedTeam(t: unknown, now: number): SavedTeam | null {
  if (!isObj(t)) return null;
  const r = t;
  if (typeof r.code !== 'string' || !SAVED_CODE.test(r.code)) return null;
  const code = r.code;
  const lastActive = typeof r.lastActive === 'number' && Number.isFinite(r.lastActive) ? Math.min(r.lastActive, now) : now;
  const ownerId = typeof r.ownerId === 'string' && PUBLIC_ID.test(r.ownerId) ? r.ownerId : null;
  const banned = parseBanned(r);
  const bannedIds = new Set(banned.map((b) => b.id));
  const roster = parseRoster(r).filter((m) => !bannedIds.has(m.id));
  if (ownerId && !roster.some((m) => m.id === ownerId)) roster.unshift({ id: ownerId, name: '' });
  const rosterIds = new Set(roster.map((m) => m.id));
  const aliases = Array.isArray(r.aliases)
    ? [...new Set(r.aliases.filter((a): a is string => typeof a === 'string' && SAVED_CODE.test(a) && a !== code))].slice(-MAX_ALIASES)
    : [];
  return {
    code,
    aliases,
    idSalt: typeof r.idSalt === 'string' && r.idSalt.length > 0 && r.idSalt.length <= 64 ? r.idSalt : code,
    ref: typeof r.ref === 'string' && /^[0-9a-f]{8}$/.test(r.ref) ? r.ref : randomRef(),
    name: cleanName(r.name, 'My team'),
    defaultLengthMin: typeof r.defaultLengthMin === 'number' ? clampLength(r.defaultLengthMin) : DEFAULT_LENGTH_MIN,
    // Saved links get the same check (and canonical form) as new ones.
    zoomLink: normalizeMeetingLink(r.zoomLink ?? '') ?? '',
    meetingProvider: r.meetingProvider === 'zoom-api' ? 'zoom-api' : 'fixed-link',
    ownerId,
    lastActive,
    requireApproval: typeof r.requireApproval === 'boolean' ? r.requireApproval : true,
    roster,
    banned,
    pending: parsePending(r, now).filter((p) => !rosterIds.has(p.id) && !bannedIds.has(p.id)),
  };
}

/** True if a saved entry predates the roster format, so loading it changes what's on disk. */
export const isLegacyEntry = (t: unknown) => isObj(t) && !Array.isArray(t.roster);

/**
 * The data directory must not be writable by other users: they could swap the
 * file or plant links in it. Creates it (0700) if it doesn't exist. Throws with
 * the reason otherwise.
 */
export function checkDataDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory.`);
  if (st.mode & 0o022) {
    throw new Error(
      `${dir} can be written by other users (mode ${(st.mode & 0o777).toString(8)}), so they could replace the team file. Run: chmod 700 ${dir}`,
    );
  }
}

/**
 * Writes via a temp file and rename, so a crash mid-write never leaves a
 * half-written file. The temp file has a random name and is created fresh
 * (never following a planted symlink or reusing someone else's file), readable
 * only by this user.
 */
export function writeAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  // Zoom links can carry the meeting passcode, so only this user may read the file.
  let fd: number | null = openSync(tmp, flags, 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) closeSync(fd);
    rmSync(tmp, { force: true }); // only ever a file this call created
    throw err;
  }
}
