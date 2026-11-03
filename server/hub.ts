// Realtime hub: one shared break per team, broadcast to every connected pack.
// The server owns the clock: every deadline is scheduled here.

import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  type Break,
  type ClientMsg,
  DEFAULT_LENGTH_MIN,
  type MeetingProviderKind,
  type ServerMsg,
  type TeamView,
  clampLength,
  isValidMeetingLink,
} from '../shared/protocol.ts';
import * as machine from './breakMachine.ts';
import { TokenBucket, WindowLimiter } from './limits.ts';
import { fixedLinkProvider, getProvider } from './meeting.ts';

/** Dev demo mode: e.g. SMOKE_BREAK_MINUTE_MS=3000 makes a 12-minute break last 36 seconds. */
const MINUTE_MS = Number(process.env.SMOKE_BREAK_MINUTE_MS) || 60_000;
/** How long a closed tab keeps its spot in a break before it's stubbed out. */
const DISCONNECT_GRACE_MS = 20_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DAY_MS = 86_400_000;

export interface HubLimits {
  /** Largest WebSocket message accepted; real messages are well under 1 KiB. */
  maxPayloadBytes: number;
  maxTeams: number;
  /** Saved teams nobody has used for this long are forgotten. */
  teamIdleDays: number;
  createsPerIpPerHour: number;
  /** Wrong invite codes allowed per IP every 10 minutes, so codes can't be guessed. */
  badCodesPerIp: number;
  /** Delay before saying a code is wrong. */
  badCodeDelayMs: number;
  connectionsPerIp: number;
  /** Per-socket message rate: bursts of `messageBurst`, then `messagesPerSecond`. */
  messageBurst: number;
  messagesPerSecond: number;
}

export const DEFAULT_LIMITS: HubLimits = {
  maxPayloadBytes: 16 * 1024,
  maxTeams: Number(process.env.SMOKE_BREAK_MAX_TEAMS) || 2000,
  teamIdleDays: 90,
  createsPerIpPerHour: 10,
  badCodesPerIp: 20,
  badCodeDelayMs: 500,
  connectionsPerIp: 30,
  messageBurst: 30,
  messagesPerSecond: 10,
};
/** A socket that keeps flooding after being throttled this many times is closed. */
const MAX_DROPPED_MESSAGES = 50;

interface Member {
  /** The client's private clientId. Proves who a socket is; never sent to anyone. */
  key: string;
  /** Public id shown to teammates and used in breaks. */
  id: string;
  name: string;
  sockets: Set<WebSocket>;
  leaveTimer: ReturnType<typeof setTimeout> | null;
}

interface Team {
  code: string;
  name: string;
  defaultLengthMin: number;
  zoomLink: string;
  meetingProvider: MeetingProviderKind;
  /** Public id of the creator, the only one who can change team settings. */
  ownerId: string | null;
  members: Map<string, Member>;
  /** Last time anyone connected or the team was created (ms). */
  lastActive: number;
  brk: Break | null;
  timer: ReturnType<typeof setTimeout> | null;
}

type SavedTeam = Pick<Team, 'code' | 'name' | 'defaultLengthMin' | 'zoomLink' | 'meetingProvider' | 'ownerId' | 'lastActive'>;

const NAME_MAX = 24;
const cleanName = (s: unknown, fallback: string) =>
  (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX) : '') || fallback;

/** clientIds are the only proof of identity, so they must be long random strings. */
const CLIENT_ID = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Teammates see a one-way hash of the clientId, scoped to the team: stable across
 * reconnects, but it can't be turned back into the clientId to impersonate someone.
 */
export const publicId = (teamCode: string, clientId: string) =>
  createHash('sha256').update(`${teamCode}:${clientId}`).digest('base64url').slice(0, 16);

const clientIp = (req: IncomingMessage) => req.socket.remoteAddress ?? 'unknown';

export function createHub(opts: { dataFile: string; limits?: Partial<HubLimits> }) {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const teams = new Map<string, Team>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxPayloadBytes });
  const creates = new WindowLimiter(limits.createsPerIpPerHour, 3_600_000);
  const badCodes = new WindowLimiter(limits.badCodesPerIp, 600_000);
  const connections = new Map<string, number>();

  load();

  function load() {
    try {
      const saved = JSON.parse(readFileSync(opts.dataFile, 'utf8')) as SavedTeam[];
      const now = Date.now();
      for (const t of saved) {
        const lastActive = t.lastActive ?? now;
        if (now - lastActive > limits.teamIdleDays * DAY_MS) continue;
        // Drop saved links that no longer pass validation rather than opening them.
        const zoomLink = isValidMeetingLink(t.zoomLink) ? t.zoomLink : '';
        teams.set(t.code, {
          ...t,
          zoomLink,
          ownerId: t.ownerId ?? null,
          lastActive,
          members: new Map(),
          brk: null,
          timer: null,
        });
      }
    } catch {
      // No saved teams yet.
    }
  }

  let saveQueued = false;
  function save() {
    if (saveQueued) return;
    saveQueued = true;
    setTimeout(() => {
      saveQueued = false;
      const out: SavedTeam[] = [...teams.values()].map(
        ({ code, name, defaultLengthMin, zoomLink, meetingProvider, ownerId, lastActive }) => ({
          code,
          name,
          defaultLengthMin,
          zoomLink,
          meetingProvider,
          ownerId,
          lastActive,
        }),
      );
      mkdirSync(dirname(opts.dataFile), { recursive: true });
      writeFileSync(opts.dataFile, JSON.stringify(out, null, 2));
    }, 200);
  }

  /** Makes room for a new team by forgetting the least recently used empty one. */
  function roomForTeam(): boolean {
    if (teams.size < limits.maxTeams) return true;
    let stalest: Team | null = null;
    for (const t of teams.values()) {
      if (t.members.size || t.brk) continue;
      if (!stalest || t.lastActive < stalest.lastActive) stalest = t;
    }
    if (!stalest) return false;
    teams.delete(stalest.code);
    return true;
  }

  function newCode(): string {
    let code: string;
    do {
      code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (teams.has(code));
    return code;
  }

  function view(team: Team): TeamView {
    return {
      code: team.code,
      name: team.name,
      defaultLengthMin: team.defaultLengthMin,
      zoomLink: team.zoomLink,
      meetingProvider: team.meetingProvider,
      ownerId: team.ownerId,
      members: [...team.members.values()].map((m) => ({ id: m.id, name: m.name, online: m.sockets.size > 0 })),
      brk: team.brk,
    };
  }

  function send(ws: WebSocket, msg: ServerMsg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function broadcast(team: Team) {
    const v = view(team);
    const serverNow = Date.now();
    for (const m of team.members.values()) {
      for (const ws of m.sockets) send(ws, { type: 'state', team: v, you: m.id, serverNow });
    }
  }

  function schedule(team: Team) {
    if (team.timer) clearTimeout(team.timer);
    team.timer = null;
    const deadline = machine.nextDeadline(team.brk);
    if (deadline === null) return;
    team.timer = setTimeout(() => {
      team.timer = null;
      apply(team, machine.tick(team.brk, Date.now()));
    }, Math.max(0, deadline - Date.now()) + 5);
  }

  function apply(team: Team, result: machine.Result, ws?: WebSocket) {
    if (result.error) {
      if (ws) send(ws, { type: 'error', message: result.error });
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
        .catch(() => null)
        // Fallback: if the provider fails, quietly use the fixed link so a break always starts.
        .then((url) => url ?? fixedLinkProvider.startMeeting(ctx))
        .then((url) => {
          if (team.brk?.id !== brk.id) return;
          team.brk = { ...team.brk, meetingUrl: url };
          broadcast(team);
        });
    } else {
      provider.endMeeting(ctx).catch(() => {});
    }
  }

  /** Two people can't share a display name, so nobody can pass as someone else. */
  function uniqueName(team: Team, key: string, name: string) {
    const taken = new Set(
      [...team.members.values()].filter((m) => m.key !== key).map((m) => m.name.toLowerCase()),
    );
    for (let n = 2, candidate = name; ; n++) {
      if (!taken.has(candidate.toLowerCase())) return candidate;
      const suffix = ` ${n}`;
      candidate = name.slice(0, NAME_MAX - suffix.length) + suffix;
    }
  }

  function attach(team: Team, ws: WebSocket, clientId: string, name: string) {
    let m = team.members.get(clientId);
    if (!m) {
      m = { key: clientId, id: publicId(team.code, clientId), name, sockets: new Set(), leaveTimer: null };
      team.members.set(clientId, m);
    }
    // Teams saved before owners existed: the first person back becomes the owner.
    team.ownerId ??= m.id;
    team.lastActive = Date.now();
    save();
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
      m.leaveTimer = setTimeout(() => {
        m.leaveTimer = null;
        if (m.sockets.size > 0) return;
        team.members.delete(m.key);
        apply(team, machine.leave(team.brk, m.id, Date.now()));
      }, DISCONNECT_GRACE_MS);
    }
    broadcast(team);
  }

  function handle(team: Team, me: Member, ws: WebSocket, msg: ClientMsg) {
    const now = Date.now();
    const who = { id: me.id, name: me.name };
    switch (msg.type) {
      case 'invite':
        return apply(team, machine.invite(team.brk, who, team.defaultLengthMin, now, randomUUID(), MINUTE_MS), ws);
      case 'setLength':
        return apply(team, machine.setLength(team.brk, me.id, Number(msg.lengthMin)), ws);
      case 'join':
        return apply(team, machine.join(team.brk, who, now, !!msg.light), ws);
      case 'light':
        return apply(team, machine.lightUp(team.brk, me.id, now), ws);
      case 'leave':
        return apply(team, machine.leave(team.brk, me.id, now), ws);
      case 'settings': {
        if (me.id !== team.ownerId) {
          return send(ws, { type: 'error', message: 'Only the team owner can change settings.' });
        }
        if (typeof msg.zoomLink === 'string') {
          const link = msg.zoomLink.trim();
          if (!isValidMeetingLink(link)) {
            return send(ws, { type: 'error', message: 'The Zoom link must be an https://…zoom.us link.' });
          }
          team.zoomLink = link;
          // Fixed links are known up front, so an active break picks up the new one.
          if (team.meetingProvider === 'fixed-link' && team.brk?.meetingRequested) {
            team.brk = { ...team.brk, meetingUrl: link || null };
          }
        }
        if (msg.defaultLengthMin !== undefined) team.defaultLengthMin = clampLength(Number(msg.defaultLengthMin));
        if (msg.teamName !== undefined) team.name = cleanName(msg.teamName, team.name);
        save();
        return broadcast(team);
      }
    }
  }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = clientIp(req);
    let team: Team | null = null;
    let me: Member | null = null;
    const bucket = new TokenBucket(limits.messageBurst, limits.messagesPerSecond);
    let dropped = 0;
    // e.g. an oversized frame. ws closes the socket itself; without a listener the error would crash the hub.
    ws.on('error', () => {});

    ws.on('message', (raw) => {
      if (!bucket.take()) {
        if (++dropped > MAX_DROPPED_MESSAGES) ws.close(1008, 'Too many messages');
        return;
      }
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

      if (msg.type === 'create' || msg.type === 'hello') {
        if (team) return;
        const clientId = typeof msg.clientId === 'string' ? msg.clientId : '';
        if (!CLIENT_ID.test(clientId)) return send(ws, { type: 'error', message: 'Invalid client id.', fatal: true });
        const name = cleanName(msg.name, 'Someone');
        if (msg.type === 'create') {
          if (!creates.take(ip)) {
            return send(ws, { type: 'error', message: 'Too many new teams. Try again later.', fatal: true });
          }
          if (!roomForTeam()) {
            return send(ws, { type: 'error', message: 'This server is full. Try again later.', fatal: true });
          }
          const code = newCode();
          team = {
            code,
            name: cleanName(msg.teamName, 'My team'),
            defaultLengthMin: DEFAULT_LENGTH_MIN,
            zoomLink: '',
            meetingProvider: 'fixed-link',
            ownerId: publicId(code, clientId),
            members: new Map(),
            lastActive: Date.now(),
            brk: null,
            timer: null,
          };
          teams.set(code, team);
          save();
        } else {
          // Once an address has guessed wrong too often, refuse even right codes for a while.
          const blocked = badCodes.blocked(ip);
          team = blocked ? null : (teams.get(String(msg.teamCode).toUpperCase().trim()) ?? null);
          if (!team) {
            const message = blocked || !badCodes.take(ip)
              ? 'Too many wrong invite codes. Try again in a few minutes.'
              : 'No team with that invite code.';
            setTimeout(() => send(ws, { type: 'error', message, fatal: true }), limits.badCodeDelayMs);
            return;
          }
        }
        me = attach(team, ws, clientId, name);
        return;
      }

      if (team && me) handle(team, me, ws, msg);
    });

    ws.on('close', () => {
      const n = (connections.get(ip) ?? 1) - 1;
      if (n > 0) connections.set(ip, n);
      else connections.delete(ip);
      if (team && me) detach(team, me, ws);
    });
  });

  return {
    /** Stops timers so tests can exit cleanly. */
    close() {
      for (const team of teams.values()) {
        if (team.timer) clearTimeout(team.timer);
        for (const m of team.members.values()) if (m.leaveTimer) clearTimeout(m.leaveTimer);
      }
      wss.close();
    },
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      const ip = clientIp(req);
      if ((connections.get(ip) ?? 0) >= limits.connectionsPerIp) {
        socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        connections.set(ip, (connections.get(ip) ?? 0) + 1);
        wss.emit('connection', ws, req);
      });
    },
  };
}
