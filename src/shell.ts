// Shared UI for joining a team and managing it: onboarding, the team panel,
// and team settings. Used by the browser prototype and the desktop settings window.

import {
  type ClientMsg,
  MAX_LENGTH_MIN,
  MIN_LENGTH_MIN,
  type TeamView,
} from '../shared/protocol.ts';
import { SIZES, loadAppearance, onAppearanceChange, saveAppearance } from './appearance.ts';
import type { Net, NetStatus } from './net.ts';
import * as platform from './platform.ts';
import { lighterPreview, packPreview } from './widget/preview.ts';
import { LIGHTER_SKINS, packSkin } from './widget/skins.ts';
import { COPY, THEMES, packSkinsFor } from './widget/theme.ts';

/** App name for the current break style ("Smoke Break" or "Water Break"). */
const appTitle = () => COPY[loadAppearance().theme].title;

// Keep the window/tab title in step with the break style.
document.title = appTitle();
onAppearanceChange((a) => {
  document.title = COPY[a.theme].title;
});

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  el.append(...children);
  return el;
}

/** First message to send: create a team, or join one by code. */
export type JoinMsg = Extract<ClientMsg, { type: 'create' } | { type: 'hello' }>;

// ── Onboarding ──────────────────────────────────────────────────────────────

export function showOnboarding(
  container: HTMLElement,
  opts: {
    /** Pre-filled invite code (e.g. from an invite link). */
    teamCode?: string;
    prefillName?: string;
    error?: string;
    onSubmit(first: JoinMsg): void;
  },
) {
  const teamCode = opts.teamCode?.toUpperCase() ?? '';
  const name = h('input', { placeholder: 'Your name', maxLength: 24, value: opts.prefillName ?? '' });
  const errorEl = h('p', { class: 'sb-error', textContent: opts.error ?? '' });
  const server = h('input', { value: platform.serverUrl(), placeholder: 'ws://localhost:8787/ws' });

  const requireName = () => {
    const n = name.value.trim();
    if (!n) {
      errorEl.textContent = 'Tell your team who you are first.';
      name.focus();
      return null;
    }
    platform.saveName(n);
    if (platform.serverIsConfigurable) platform.saveServerUrl(server.value);
    return n;
  };

  const card = h('form', { class: 'sb-card sb-onboarding' }, h('h1', { textContent: appTitle() }));
  card.addEventListener('submit', (e) => e.preventDefault());
  card.append(h('label', {}, 'Name', name));

  if (teamCode) {
    const join = h('button', { type: 'submit', textContent: `Join team ${teamCode}` });
    join.onclick = () => {
      const n = requireName();
      if (n) opts.onSubmit({ type: 'hello', teamCode, clientId: platform.clientId(), name: n });
    };
    const other = h('a', { href: location.pathname, textContent: 'Start or join a different team' });
    card.append(join, other);
  } else {
    const teamName = h('input', { placeholder: 'Team name', maxLength: 24 });
    const create = h('button', { type: 'submit', textContent: 'Start a team' });
    create.onclick = () => {
      const n = requireName();
      if (n) opts.onSubmit({ type: 'create', teamName: teamName.value, clientId: platform.clientId(), name: n });
    };
    const code = h('input', { placeholder: 'Invite code', maxLength: 6, className: 'sb-code' });
    const join = h('button', { type: 'button', textContent: 'Join' });
    join.onclick = () => {
      const n = requireName();
      const c = code.value.trim().toUpperCase();
      if (n && c) opts.onSubmit({ type: 'hello', teamCode: c, clientId: platform.clientId(), name: n });
    };
    card.append(
      h('fieldset', {}, h('legend', { textContent: 'New team' }), teamName, create),
      h('fieldset', {}, h('legend', { textContent: 'Have an invite code?' }), code, join),
    );
  }
  if (platform.serverIsConfigurable) card.append(h('label', {}, 'Server', server));
  card.append(errorEl);
  container.replaceChildren(h('div', { class: 'sb-center' }, card));
  name.focus();
}

// ── Team panel ──────────────────────────────────────────────────────────────

export interface TeamPanel {
  setTeam(team: TeamView, you: string): void;
  setStatus(status: NetStatus): void;
  setError(message: string): void;
}

export function createTeamPanel(
  panel: HTMLElement,
  opts: {
    net: Net;
    /** Extra buttons for the host (e.g. "Open a teammate tab", "Leave team"). */
    actions?: () => HTMLElement[];
    hint: string;
  },
): TeamPanel {
  let team: TeamView | null = null;
  let you = '';
  let status: NetStatus = 'connecting';
  let settingsOpen = false;
  let panelError = '';

  const inviteLink = () => `${location.origin}${location.pathname}?team=${team!.code}`;

  function render() {
    if (settingsOpen) return;
    if (!team) {
      panel.replaceChildren(
        h('h2', { textContent: appTitle() }),
        h('p', { textContent: status === 'open' ? 'Joining…' : 'Connecting…' }),
      );
      return;
    }
    // The desktop app has no shareable URL, so it shares the code instead.
    const shareText = platform.isDesktop ? team.code : inviteLink();
    const copyLabel = platform.isDesktop ? 'Copy invite code' : 'Copy invite link';
    const copy = h('button', { textContent: copyLabel });
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(shareText);
        copy.textContent = 'Copied!';
      } catch {
        prompt('Invite', shareText);
      }
      setTimeout(() => (copy.textContent = copyLabel), 1500);
    };
    const isOwner = team.ownerId === you;
    const owner = team.members.find((m) => m.id === team!.ownerId);
    const settings = h('button', { textContent: 'Settings' });
    settings.onclick = () => {
      settingsOpen = true;
      renderSettings();
    };

    const members = h(
      'ul',
      { class: 'sb-members' },
      ...team.members.map((m) =>
        h('li', { class: m.online ? 'online' : '' }, m.name + (m.id === you ? ' (you)' : '')),
      ),
    );

    panel.replaceChildren(
      h('h2', { textContent: team.name }),
      h(
        'p',
        { class: 'sb-meta' },
        'Invite code ',
        h('code', { textContent: team.code }),
        status === 'open' ? '' : h('span', { class: 'sb-status', textContent: ` · ${status}…` }),
      ),
      h('div', { class: 'sb-row' }, copy, isOwner ? settings : '', ...(opts.actions?.() ?? [])),
      members,
      team.zoomLink
        ? ''
        : h('p', {
            class: 'sb-warn',
            textContent: isOwner
              ? 'No Zoom link set yet. Add one in Settings.'
              : `No Zoom link set yet. Ask ${owner?.name ?? 'the team owner'} to add one.`,
          }),
      isOwner ? '' : h('p', { class: 'sb-hint', textContent: `${owner?.name ?? 'The team owner'} manages team settings.` }),
      h('p', { class: 'sb-hint', textContent: opts.hint }),
    );
  }

  function renderSettings() {
    if (!team) return;
    const name = h('input', { value: team.name, maxLength: 24 });
    const zoom = h('input', { value: team.zoomLink, placeholder: 'https://zoom.us/j/…', type: 'url' });
    const length = h('select');
    for (let m = MIN_LENGTH_MIN; m <= MAX_LENGTH_MIN; m++) {
      length.append(h('option', { value: String(m), textContent: `${m} min`, selected: m === team.defaultLengthMin }));
    }
    const provider = h(
      'fieldset',
      {},
      h('legend', { textContent: 'Zoom' }),
      h('label', { class: 'sb-radio' }, h('input', { type: 'radio', name: 'provider', checked: true }), 'Fixed link'),
      h(
        'label',
        { class: 'sb-radio disabled' },
        h('input', { type: 'radio', name: 'provider', disabled: true }),
        'Fresh meeting each break (coming later)',
      ),
    );
    const err = h('p', { class: 'sb-error', textContent: panelError });
    const close = () => {
      settingsOpen = false;
      render();
    };
    const save = h('button', { textContent: 'Save' });
    save.onclick = () => {
      panelError = '';
      opts.net.send({
        type: 'settings',
        teamName: name.value,
        zoomLink: zoom.value.trim(),
        defaultLengthMin: Number(length.value),
      });
      close();
    };
    const cancel = h('button', { textContent: 'Cancel', className: 'secondary' });
    cancel.onclick = close;
    panel.replaceChildren(
      h('h2', { textContent: 'Team settings' }),
      h('label', {}, 'Team name', name),
      provider,
      h('label', {}, 'Zoom link', zoom),
      h('label', {}, 'Default break length', length),
      h('p', { class: 'sb-hint', textContent: 'Whoever starts a break can change its length before anyone joins.' }),
      err,
      h('div', { class: 'sb-row' }, save, cancel),
    );
  }

  render();
  return {
    setTeam(t, me) {
      team = t;
      you = me;
      render();
    },
    setStatus(s) {
      status = s;
      render();
    },
    setError(message) {
      panelError = message;
      render();
    },
  };
}

// ── My pack (size & skins) ──────────────────────────────────────────────────

/** Personal appearance settings. Re-renders itself when they change anywhere. */
export function createAppearancePanel(panel: HTMLElement) {
  function render() {
    const look = loadAppearance();
    const copy = COPY[look.theme];

    const choices = <T,>(options: { value: T; label: string; title?: string }[], selected: T, pick: (v: T) => void) =>
      h(
        'div',
        { class: 'sb-sizes', role: 'radiogroup' },
        ...options.map(({ value, label, title }) => {
          const b = h('button', { textContent: label, className: value === selected ? 'selected' : '', title: title ?? '' });
          b.setAttribute('aria-checked', String(value === selected));
          b.setAttribute('role', 'radio');
          b.onclick = () => pick(value);
          return b;
        }),
      );

    const styles = choices(
      THEMES.map((t) => ({ value: t.id, label: t.name, title: COPY[t.id].title })),
      look.theme,
      (theme) => saveAppearance({ theme }),
    );
    const sizes = choices(
      SIZES.map(({ scale, label }) => ({ value: scale, label, title: `${scale}× pixels` })),
      look.scale,
      (scale) => saveAppearance({ scale }),
    );

    const tiles = <T extends { id: string; name: string }>(
      skins: T[],
      selected: string,
      preview: (s: T) => HTMLCanvasElement,
      pick: (id: string) => void,
    ) =>
      h(
        'div',
        { class: 'sb-skins', role: 'radiogroup' },
        ...skins.map((skin) => {
          const b = h(
            'button',
            { className: `sb-skin${skin.id === selected ? ' selected' : ''}`, title: skin.name },
            preview(skin),
            h('span', { textContent: skin.name }),
          );
          b.setAttribute('role', 'radio');
          b.setAttribute('aria-checked', String(skin.id === selected));
          b.onclick = () => pick(skin.id);
          return b;
        }),
      );

    panel.replaceChildren(
      h('h2', { textContent: copy.myPack }),
      h('p', { class: 'sb-field-label', textContent: 'Break style' }),
      styles,
      h('p', { class: 'sb-field-label', textContent: 'Size' }),
      sizes,
      h('p', { class: 'sb-field-label', textContent: copy.packLabel }),
      tiles(packSkinsFor(look.theme), look.pack, (s) => packPreview(s, 2, look.theme), (pack) => saveAppearance({ pack })),
      h('p', { class: 'sb-field-label', textContent: copy.lighterLabel }),
      tiles(
        LIGHTER_SKINS,
        look.lighter,
        (s) => lighterPreview(s, 2, look.theme, packSkin(look.pack)),
        (lighter) => saveAppearance({ lighter }),
      ),
      h('p', {
        class: 'sb-hint',
        textContent:
          'Only you see your style and skins, so teammates can pick differently for the same break. You can also pinch or ⌃-scroll on the pack to resize it.',
      }),
    );
  }
  render();
  onAppearanceChange(render);
}
