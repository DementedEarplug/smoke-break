// Connects to the hub as a team member and keeps the saved identity in sync.

import type { TeamView } from '../shared/protocol.ts';
import { Net, type NetStatus } from './net.ts';
import * as platform from './platform.ts';
import type { JoinMsg } from './shell.ts';

export interface SessionHandlers {
  onTeam(team: TeamView): void;
  /** Recoverable errors (e.g. a rejected setting). */
  onError(message: string): void;
  /** The team couldn't be joined at all; the connection is closed. */
  onFatal(message: string): void;
  onStatus?(status: NetStatus): void;
}

/** Call `connect()` on the result once the handlers' targets exist. */
export function createSession(first: JoinMsg, handlers: SessionHandlers): Net {
  let hello = first;
  const net = new Net(
    () => hello,
    (msg) => {
      if (msg.type === 'error') {
        if (msg.fatal) {
          net.close();
          handlers.onFatal(msg.message);
        } else {
          handlers.onError(msg.message);
        }
        return;
      }
      // After creating a team, reconnects should rejoin it rather than create another.
      if (hello.type === 'create') {
        hello = { type: 'hello', teamCode: msg.team.code, clientId: hello.clientId, name: hello.name };
      }
      if (platform.savedTeam() !== msg.team.code) platform.saveTeam(msg.team.code);
      handlers.onTeam(msg.team);
    },
    (s) => handlers.onStatus?.(s),
  );
  return net;
}
