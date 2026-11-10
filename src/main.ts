// Browser prototype: a fake "desktop" with the floating pack and the team panel.

import './style.css';
import { INVITE_CODE } from '../shared/protocol.ts';
import { loadAppearance, onAppearanceChange, saveAppearance } from './appearance.ts';
import * as platform from './platform.ts';
import { createSession } from './session.ts';
import {
  APP_PATH,
  type JoinMsg,
  appLink,
  cleanInviteCode,
  createAppearancePanel,
  createTeamPanel,
  h,
  showOnboarding,
} from './shell.ts';
import { lighterSkin, packSkin } from './widget/skins.ts';
import { Widget } from './widget/widget.ts';

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);

/** Keeps the address bar on the app's own path, whatever path the page was opened on. */
const replaceUrl = () => history.replaceState(null, '', `${APP_PATH}?${params}`);

// A "fresh" tab is a separate teammate for local testing: drop the copied identity.
const fresh = params.has('fresh');
if (fresh) {
  platform.resetTabIdentity();
  params.delete('fresh');
  replaceUrl();
}

/** The invite code from the link, if it is one. */
function linkedTeam(): string | null {
  const code = cleanInviteCode(params.get('team') ?? '');
  return INVITE_CODE.test(code) ? code : null;
}

function onboard(error?: string, askToken = false) {
  showOnboarding(app, {
    teamCode: linkedTeam() ?? undefined,
    askToken,
    prefillName: platform.savedName() || (fresh ? '' : (localStorage.getItem('sb:lastName') ?? '')),
    error,
    onSubmit: start,
  });
}

function start(first: JoinMsg) {
  const desktop = h('div', { class: 'sb-desktop' });
  const panelEl = h('aside', { class: 'sb-card sb-panel' });
  const lookEl = h('aside', { class: 'sb-card sb-panel' });
  desktop.append(h('div', { class: 'sb-side' }, panelEl, lookEl));
  app.replaceChildren(desktop);
  createAppearancePanel(lookEl);

  const net = createSession(first, {
    onTeam(team, you) {
      if (params.get('team') !== team.code) {
        params.set('team', team.code);
        replaceUrl();
      }
      widget.setTeam(team, you);
      panel.setTeam(team, you);
    },
    onError(message) {
      widget.showToast(message);
      panel.setError(message);
    },
    onFatal(message, forget, code) {
      // The link's code is dead: don't offer to join it again.
      if (forget) {
        params.delete('team');
        replaceUrl();
      }
      onboard(message, code === 'unauthorized');
    },
    onRetrying(message, code, retryInMs) {
      // Only a corrected token fixes this one: ask for it.
      if (code === 'unauthorized') {
        net.close();
        return onboard(message, true);
      }
      widget.showToast(message, 6000);
      panel.setNotice(`${message} Trying again in ${Math.round(retryInMs / 1000)} s.`);
    },
    onStatus: (s) => panel.setStatus(s),
  });

  const look = loadAppearance();
  const widget = new Widget(desktop, {
    storageKey: first.clientId,
    now: () => net.now(),
    send: (m) => net.send(m),
    scale: look.scale,
    onResizeRequest: (dir) => saveAppearance({ scale: loadAppearance().scale + dir }),
  });
  widget.setSkins(packSkin(look.pack), lighterSkin(look.lighter));
  widget.setTheme(look.theme);
  onAppearanceChange((a) => {
    widget.setScale(a.scale);
    widget.setSkins(packSkin(a.pack), lighterSkin(a.lighter));
    widget.setTheme(a.theme);
  });
  const panel = createTeamPanel(panelEl, {
    net,
    hint: 'Click the pack to start a break · drag to move it · right-click for do-not-disturb',
    actions: () => {
      const teammateTab = h('button', { textContent: 'Open a teammate tab' });
      teammateTab.onclick = () => {
        const code = params.get('team');
        window.open(appLink(code ? { team: code, fresh: '1' } : { fresh: '1' }), '_blank');
      };
      return [teammateTab];
    },
  });
  net.connect();
}

if (window.top !== window.self) {
  // Framed by another page (clickjacking): don't show anything clickable.
  // The server should also send `frame-ancestors 'none'`, which a <meta> can't.
  app.replaceChildren(h('p', { textContent: 'Open Smoke Break in its own tab.' }));
} else {
  const name = platform.savedName();
  const teamCode = linkedTeam();
  if (name && teamCode) {
    start({ type: 'hello', teamCode, clientId: platform.clientId(), name });
  } else {
    onboard();
  }
}
