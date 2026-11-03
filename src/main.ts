// Browser prototype: a fake "desktop" with the floating pack and the team panel.

import './style.css';
import { loadAppearance, onAppearanceChange, saveAppearance } from './appearance.ts';
import * as platform from './platform.ts';
import { createSession } from './session.ts';
import { type JoinMsg, createAppearancePanel, createTeamPanel, h, showOnboarding } from './shell.ts';
import { lighterSkin, packSkin } from './widget/skins.ts';
import { Widget } from './widget/widget.ts';

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);

// A "fresh" tab is a separate teammate for local testing: drop the copied identity.
const fresh = params.has('fresh');
if (fresh) {
  platform.resetTabIdentity();
  params.delete('fresh');
  history.replaceState(null, '', `${location.pathname}?${params}`);
}

function onboard(error?: string) {
  showOnboarding(app, {
    teamCode: params.get('team') ?? undefined,
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
    onTeam(team) {
      if (params.get('team') !== team.code) {
        params.set('team', team.code);
        history.replaceState(null, '', `${location.pathname}?${params}`);
      }
      widget.setTeam(team);
      panel.setTeam(team);
    },
    onError(message) {
      widget.showToast(message);
      panel.setError(message);
    },
    onFatal: onboard,
    onStatus: (s) => panel.setStatus(s),
  });

  const look = loadAppearance();
  const widget = new Widget(desktop, {
    me: first.clientId,
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
    me: first.clientId,
    net,
    hint: 'Click the pack to start a break · drag to move it · right-click for do-not-disturb',
    actions: () => {
      const teammateTab = h('button', { textContent: 'Open a teammate tab' });
      teammateTab.onclick = () => window.open(`${location.pathname}?team=${params.get('team')}&fresh=1`, '_blank');
      return [teammateTab];
    },
  });
  net.connect();
}

const name = platform.savedName();
const teamCode = params.get('team');
if (name && teamCode) {
  start({ type: 'hello', teamCode: teamCode.toUpperCase(), clientId: platform.clientId(), name });
} else {
  onboard();
}
