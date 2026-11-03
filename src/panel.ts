// Desktop "Team & settings" window, opened from the tray: onboarding, team
// info, and settings. The overlay reloads whenever the identity changes here.

import './style.css';
import { emit } from '@tauri-apps/api/event';
import * as platform from './platform.ts';
import { createSession } from './session.ts';
import { type JoinMsg, createAppearancePanel, createTeamPanel, h, showOnboarding } from './shell.ts';

document.documentElement.classList.add('sb-panel-window');
const app = document.getElementById('app')!;

function onboard(error?: string) {
  showOnboarding(app, {
    prefillName: platform.savedName() || (localStorage.getItem('sb:lastName') ?? ''),
    error,
    onSubmit: (first) => start(first, true),
  });
}

function start(first: JoinMsg, joining: boolean) {
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
    onFatal(message) {
      platform.leaveTeam();
      onboard(message);
    },
    onStatus: (s) => panel.setStatus(s),
  });

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
if (identity) {
  start({ type: 'hello', teamCode: identity.teamCode, clientId: identity.clientId, name: identity.name }, false);
} else {
  onboard();
}
