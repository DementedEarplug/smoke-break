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
   * closed. `forget` is set when the team is gone for good (bad invite code, or
   * we were removed), so the caller should drop the saved team.
   */
  onFatal(message: string, forget: boolean, code?: ErrorCode): void;
  /**
   * The hub refused us for now (rate limit, full, access token, or no reason
   * given). The saved team is kept and the session retries by itself in `retryInMs`.
   */
  onRetrying?(message: string, code: ErrorCode | undefined, retryInMs: number): void;
  onStatus?(status: NetStatus): void;
}

/** Call `connect()` on the result once the handlers' targets exist. */
export function createSession(first: JoinMsg, handlers: SessionHandlers): Net {
  let hello = first;
  const net = new Net(
    // Read the token on every connect, so a corrected one is used on the next retry.
    () => platform.withToken(hello),
    (msg) => {
      if (msg.type === 'error') {
        if (!msg.fatal) return handlers.onError(msg.message);
        const forget = forgetsTeam(msg.code);
        // A refused "create" has no team to keep retrying for: back to onboarding.
        if (forget || hello.type === 'create' || !handlers.onRetrying) {
          net.close();
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
      if (platform.savedTeam() !== msg.team.code) platform.saveTeam(msg.team.code);
      handlers.onTeam(msg.team, msg.you);
    },
    (s) => handlers.onStatus?.(s),
    (problem) => {
      // Nothing to send on an address we won't use; the saved team stays.
      handlers.onFatal(problem, false);
    },
  );
  return net;
}
