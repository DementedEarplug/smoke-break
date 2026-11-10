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

function start(first: JoinMsg, joining: boolean) {
  current?.close();
  const panelEl = h('div', { class: 'sb-card sb-panel sb-panel--window' });
  const lookEl = h('div', { class: 'sb-card sb-panel sb-panel--window' });
  app.replaceChildren(panelEl, lookEl);
  createAppearancePanel(lookEl);

  const net = createSession(first, {
    onTeam(team, you) {
      panel.setTeam(team, you);
      if (joining) {
        joining = false;
        void emit('identity-changed');
      }
    },
    onError: (message) => panel.setError(message),
    onFatal(message, forget, code) {
      // Only a bad code or being removed loses the team; anything else keeps it to retry later.
      if (forget) platform.leaveTeam();
      const askToken = code === 'unauthorized';
      const saved = platform.savedTeam();
      onboard(message, saved || askToken ? { teamCode: saved, askToken } : undefined);
    },
    onRetrying(message, code, retryInMs) {
      if (code === 'unauthorized') {
        // Retrying won't help until someone enters the right token.
        const teamCode = platform.savedTeam() || (first.type === 'hello' ? first.teamCode : '');
        return onboard(message, { teamCode, askToken: true });
      }
      panel.setNotice(`${message} Trying again in ${Math.round(retryInMs / 1000)} s.`);
    },
    onStatus: (s) => panel.setStatus(s),
  });
  current = net;

  const panel = createTeamPanel(panelEl, {
    net,
    hint: 'Click the pack to start a break · drag it anywhere · right-click it for do-not-disturb',
    actions: () => {
      const leave = h('button', { textContent: 'Leave team', className: 'secondary' });
      leave.onclick = () => {
        net.close();
        platform.leaveTeam();
        void emit('identity-changed');
        onboard();
      };
      return [leave];
    },
  });
  net.connect();
}

const identity = platform.loadIdentity();
const problem = platform.serverProblem();
if (identity && problem) {
  // e.g. an old plain ws:// address to another machine: fix it without losing the team.
  onboard(problem, { teamCode: identity.teamCode });
} else if (identity) {
  start({ type: 'hello', teamCode: identity.teamCode, clientId: identity.clientId, name: identity.name }, false);
} else {
  onboard(problem ?? undefined);
}
