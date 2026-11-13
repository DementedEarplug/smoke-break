// Connects to the hub as a team member and keeps the saved identity in sync.

import { type ErrorCode, type TeamView, forgetsTeam } from '../shared/protocol.ts';
import { Net, type NetStatus } from './net.ts';
import * as platform from './platform.ts';
import type { JoinMsg } from './shell.ts';

export interface SessionHandlers {
  /** `you` is your public member id in this team. */
  onTeam(team: TeamView, you: string): void;
  /** Recoverable errors (e.g. a rejected setting). */
  onError(message: string): void;
  /**
   * The team couldn't be joined and we've stopped trying; the connection is
   * closed. `forget` is set when the team is gone (bad invite code, removed,
   * or the owner said no for now); the session has already dropped it from
   * the saved identity.
   */
  onFatal(message: string, forget: boolean, code?: ErrorCode): void;
  /**
   * The hub refused us for now (rate limit, full, access token, or no reason
   * given). The saved team is kept and the session retries by itself in `retryInMs`.
   */
  onRetrying?(message: string, code: ErrorCode | undefined, retryInMs: number): void;
  /**
   * The team owner hasn't let us in yet. The team is saved and the session asks
   * again by itself every 10-15 s until they decide.
   */
  onPending?(message: string, retryInMs: number): void;
  /**
   * Connecting keeps failing before the hub even answers. That is what a hub
   * that refused our access token (or wants one we don't have) looks like, and
   * also what an unreachable one looks like: `message` says both. The session
   * keeps retrying, more and more slowly; `withToken` says whether we offered one.
   */
  onCantConnect?(message: string, withToken: boolean): void;
  onStatus?(status: NetStatus): void;
}

/** Failed attempts in a row before `onCantConnect`: one blip isn't worth a message. */
export const CANT_CONNECT_AFTER = 2;

/** What to tell someone whose connection attempts keep failing. */
export function cantConnectMessage(withToken: boolean): string {
  return withToken
    ? 'Can’t connect to the hub. It’s unreachable, or it didn’t accept your access token: this hub needs a valid one. If the network is fine, check your token (or ask for a new one).'
    : 'Can’t connect to the hub. It’s unreachable, or it needs an access token: if you were given one, enter it.';
}

/**
 * Call `connect()` on the result once the handlers' targets exist. `hub` is
 * the hub `first.clientId` was made for; the session only ever talks to it.
 */
export function createSession(first: JoinMsg, handlers: SessionHandlers, hub = platform.currentHub()): Net {
  let hello = first;
  /** The team this session is for, once known. */
  const teamCode = () => (hello.type === 'hello' ? hello.teamCode : null);
  const net = new Net(
    hub,
    () => hello,
    (msg) => {
      if (msg.type === 'error') {
        if (!msg.fatal) return handlers.onError(msg.message);
        const code = teamCode();
        if (msg.code === 'pending' && code) {
          // Keep the team, so a restart picks up the wait where it left off.
          if (platform.savedTeam(hub) !== code) platform.saveTeam(code, hub);
          const retryInMs = net.retryPending();
          if (handlers.onPending) handlers.onPending(msg.message, retryInMs);
          else handlers.onRetrying?.(msg.message, msg.code, retryInMs);
          return;
        }
        const forget = forgetsTeam(msg.code);
        // A refused "create" has no team to keep retrying for: back to onboarding.
        if (forget || hello.type === 'create' || !handlers.onRetrying) {
          net.close();
          // Gone for good: stop retrying and drop it, unless the saved team is another one.
          if (forget && code && platform.savedTeam(hub) === code) platform.leaveTeam(hub);
          handlers.onFatal(msg.message, forget, msg.code);
        } else {
          handlers.onRetrying(msg.message, msg.code, net.retryLater());
        }
        return;
      }
      // Reconnects rejoin this team by its current code: after creating it, or
      // after the owner replaced the code.
      if (hello.type === 'create' || hello.teamCode !== msg.team.code) {
        hello = { type: 'hello', teamCode: msg.team.code, clientId: hello.clientId, name: hello.name };
      }
      if (platform.savedTeam(hub) !== msg.team.code) platform.saveTeam(msg.team.code, hub);
      handlers.onTeam(msg.team, msg.you);
    },
    (s) => handlers.onStatus?.(s),
    (problem) => {
      // Nothing to send on an address we won't use; the saved team stays.
      handlers.onFatal(problem, false);
    },
    {
      // Read the token on every connect, so a corrected one is used on the next retry.
      token: () => platform.hubToken(hub),
      onConnectFailed(failures, withToken) {
        if (failures >= CANT_CONNECT_AFTER) handlers.onCantConnect?.(cantConnectMessage(withToken), withToken);
      },
    },
  );
  return net;
}
