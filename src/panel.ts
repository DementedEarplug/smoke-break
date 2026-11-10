// Desktop "Team & settings" window, opened from the tray: onboarding, team
// info, and settings. The overlay reloads whenever the identity changes here.

import './style.css';
import { emit } from '@tauri-apps/api/event';
import type { Net } from './net.ts';
import * as platform from './platform.ts';
import { createSession } from './session.ts';
import { type JoinMsg, createAppearancePanel, createTeamPanel, h, showOnboarding } from './shell.ts';

document.documentElement.classList.add('sb-panel-window');
const app = document.getElementById('app')!;
/** The running session, so going back to onboarding can stop its retries. */
let current: Net | null = null;

function onboard(error?: string, keep?: { teamCode?: string; askToken?: boolean }) {
  current?.close();
  current = null;
  showOnboarding(app, {
    prefillName: platform.savedName() || (localStorage.getItem('sb:lastName') ?? ''),
    error,
    // Still a member of the saved team: offer to rejoin it (e.g. with a new token or server).
    teamCode: keep?.teamCode,
    askToken: keep?.askToken,
    onOtherTeam: () => onboard(),
    onSubmit: (first) => start(first, true),
  });
}

/**
 * `hub` is the hub `first.clientId` was made for. `joining` is set when this
 * came from onboarding: the overlay then starts over once the team is known.
 */
function start(first: JoinMsg, joining: boolean, hub = platform.currentHub()) {
  current?.close();
  const panelEl = h('div', { class: 'sb-card sb-panel sb-panel--window' });
  const lookEl = h('div', { class: 'sb-card sb-panel sb-panel--window' });
  app.replaceChildren(panelEl, lookEl);
  createAppearancePanel(lookEl);

  const announce = () => {
    if (!joining) return;
    joining = false;
    void emit('identity-changed');
  };
  const net = createSession(
    first,
    {
      onTeam(team, you) {
        panel.setTeam(team, you);
        announce();
      },
      onError: (message) => panel.setError(message),
      onFatal(message, _forget, code) {
        // The session has already dropped a team that's gone for good (bad
        // code, removed, owner said no); anything else keeps it to retry later.
        const askToken = code === 'unauthorized';
        const saved = platform.savedTeam(hub);
        onboard(message, saved || askToken ? { teamCode: saved, askToken } : undefined);
      },
      onRetrying(message, code, retryInMs) {
        if (code === 'unauthorized') {
          // Retrying won't help until someone enters the right token.
          const teamCode = platform.savedTeam(hub) || (first.type === 'hello' ? first.teamCode : '');
          return onboard(message, { teamCode, askToken: true });
        }
        panel.setNotice(`${message} Trying again in ${Math.round(retryInMs / 1000)} s.`);
      },
      onCantConnect(message, withToken) {
        // Probably a token the hub refused at the door, possibly just the
        // network. Keep backing off, say so, and offer to fix the token.
        const teamCode = platform.savedTeam(hub) || (first.type === 'hello' ? first.teamCode : '');
        panel.setNotice(message, {
          label: withToken ? 'Change access token' : 'Enter access token',
          run: () => onboard(message, { teamCode, askToken: true }),
        });
      },
      onPending() {
        // The session saved the team and keeps asking; the overlay picks it up
        // and waits quietly (hidden) too.
        panel.setWaiting(first.type === 'hello' ? first.teamCode : '');
        announce();
      },
      onStatus: (s) => panel.setStatus(s),
    },
    hub,
  );
  current = net;

  /** Stop, forget the team (on this hub), and let the overlay know. */
  const leave = () => {
    net.close();
    platform.leaveTeam(hub);
    void emit('identity-changed');
    onboard();
  };
  const panel = createTeamPanel(panelEl, {
    net,
    hint: 'Click the pack to start a break · drag it anywhere · right-click it for do-not-disturb',
    actions: () => {
      const button = h('button', { textContent: 'Leave team', className: 'secondary' });
      button.onclick = leave;
      return [button];
    },
    onCancelWaiting: leave,
  });
  net.connect();
}

void (async () => {
  const identity = await platform.loadIdentity();
  const problem = platform.serverProblem();
  if (identity && problem) {
    // e.g. an old plain ws:// address to another machine: fix it without losing the team.
    onboard(problem, { teamCode: identity.teamCode });
  } else if (identity) {
    start(
      { type: 'hello', teamCode: identity.teamCode, clientId: identity.clientId, name: identity.name },
      false,
      identity.hub,
    );
  } else {
    onboard(problem ?? undefined);
  }
})();
