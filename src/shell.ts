// Shared UI for joining a team and managing it: onboarding, the team panel,
// and team settings. Used by the browser prototype and the desktop settings window.

import {
  type ClientMsg,
  INVITE_CODE,
  MAX_LENGTH_MIN,
  MIN_LENGTH_MIN,
  type TeamView,
  normalizeMeetingLink,
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

/**
 * Where the browser version lives. Links are built from this, never from
 * `location.pathname`: a crafted path like `//evil.example/` would otherwise
 * turn them into links to another site.
 */
export const APP_PATH = import.meta.env.BASE_URL;

/** A link to the browser version, optionally for a team. */
export function appLink(params: Record<string, string> = {}): string {
  const url = new URL(APP_PATH, location.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.href;
}

/** Invite codes are 6 (older teams) to 10 characters; people may paste them with spaces or dashes. */
export const cleanInviteCode = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();
const INVITE_CODE_INPUT_MAX = 16;

export function showOnboarding(
  container: HTMLElement,
  opts: {
    /** Pre-filled invite code (e.g. from an invite link, or the saved team). */
    teamCode?: string;
    prefillName?: string;
    error?: string;
    /** Show the access token field even where the server isn't configurable (e.g. the hub refused the token). */
    askToken?: boolean;
    /** Replaces the "different team" link (the desktop app has no page to link to). */
    onOtherTeam?(): void;
    onSubmit(first: JoinMsg): void;
  },
) {
  const cleaned = cleanInviteCode(opts.teamCode ?? '');
  const teamCode = INVITE_CODE.test(cleaned) ? cleaned : '';
  const name = h('input', { placeholder: 'Your name', maxLength: 24, value: opts.prefillName ?? '' });
  const errorEl = h('p', { class: 'sb-error', textContent: opts.error ?? '' });
  const server = h('input', { value: platform.serverUrl(), placeholder: 'wss://breaks.example.com/ws' });
  // The built-in token (if any) isn't shown; a value here overrides it.
  const token = h('input', {
    value: platform.savedHubToken(),
    placeholder: 'If your server needs one',
    type: 'password',
    autocomplete: 'off',
  });
  const showToken = platform.serverIsConfigurable || !!opts.askToken;

  /** Checks and saves the name and connection settings; false if something needs fixing. */
  const saveFields = () => {
    const n = name.value.trim();
    if (!n) {
      errorEl.textContent = 'Tell your team who you are first.';
      name.focus();
      return null;
    }
    if (platform.serverIsConfigurable) {
      const problem = platform.saveServerUrl(server.value);
      if (problem) {
        errorEl.textContent = problem;
        server.focus();
        return null;
      }
    }
    if (showToken) platform.saveHubToken(token.value);
    platform.saveName(n);
    return n;
  };

  const card = h('form', { class: 'sb-card sb-onboarding' }, h('h1', { textContent: appTitle() }));
  card.addEventListener('submit', (e) => e.preventDefault());
  card.append(h('label', {}, 'Name', name));

  if (teamCode) {
    const join = h('button', { type: 'submit', textContent: `Join team ${teamCode}` });
    join.onclick = () => {
      const n = saveFields();
      if (n) opts.onSubmit({ type: 'hello', teamCode, clientId: platform.clientId(), name: n });
    };
    const label = 'Start or join a different team';
    let other: HTMLElement;
    if (opts.onOtherTeam) {
      other = h('button', { type: 'button', className: 'secondary', textContent: label });
      other.onclick = () => opts.onOtherTeam!();
    } else {
      other = h('a', { href: appLink(), textContent: label });
    }
    card.append(join, other);
  } else {
    const teamName = h('input', { placeholder: 'Team name', maxLength: 24 });
    const create = h('button', { type: 'submit', textContent: 'Start a team' });
    create.onclick = () => {
      const n = saveFields();
      if (n) opts.onSubmit({ type: 'create', teamName: teamName.value, clientId: platform.clientId(), name: n });
    };
    const code = h('input', { placeholder: 'Invite code', maxLength: INVITE_CODE_INPUT_MAX, className: 'sb-code' });
    const join = h('button', { type: 'button', textContent: 'Join' });
    join.onclick = () => {
      const c = cleanInviteCode(code.value);
      if (!c) return code.focus();
      if (!INVITE_CODE.test(c)) {
        errorEl.textContent = "That doesn't look like an invite code. Check it with whoever sent it.";
        return code.focus();
      }
      const n = saveFields();
      if (n) opts.onSubmit({ type: 'hello', teamCode: c, clientId: platform.clientId(), name: n });
    };
    card.append(
      h('fieldset', {}, h('legend', { textContent: 'New team' }), teamName, create),
      h('fieldset', {}, h('legend', { textContent: 'Have an invite code?' }), code, join),
    );
  }
  if (platform.serverIsConfigurable) card.append(h('label', {}, 'Server', server));
  if (showToken) card.append(h('label', {}, 'Access token', token));
  card.append(errorEl);
  container.replaceChildren(h('div', { class: 'sb-center' }, card));
  name.focus();
}

// ── Team panel ──────────────────────────────────────────────────────────────

const ERROR_SHOW_MS = 8000;

export interface TeamPanel {
  setTeam(team: TeamView, you: string): void;
  setStatus(status: NetStatus): void;
  setError(message: string): void;
  /** A connection problem to show until the next team update ('' clears it). */
  setNotice(message: string): void;
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
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  let notice = '';
  /** Owner actions waiting for a second click: 'rotate', or the id of a member to remove. */
  let confirming: string | null = null;

  const inviteLink = () => appLink({ team: team!.code });

  /** A button that asks again inline before doing something that can't be undone. */
  const confirmable = (key: string, label: string, question: string, yes: string, act: () => void) => {
    if (confirming !== key) {
      const b = h('button', { textContent: label, className: 'secondary' });
      b.onclick = () => {
        confirming = key;
        render();
      };
      return b;
    }
    const ok = h('button', { textContent: yes });
    ok.onclick = () => {
      confirming = null;
      act();
      render();
    };
    const no = h('button', { textContent: 'Cancel', className: 'secondary' });
    no.onclick = () => {
      confirming = null;
      render();
    };
    return h('div', { class: 'sb-confirm' }, h('p', { textContent: question }), h('div', { class: 'sb-row' }, ok, no));
  };

  function render() {
    if (settingsOpen) return;
    const problems = [notice, panelError].filter(Boolean).map((m) => h('p', { class: 'sb-error', textContent: m }));
    if (!team) {
      panel.replaceChildren(
        h('h2', { textContent: appTitle() }),
        h('p', { textContent: status === 'open' ? 'Joining…' : 'Connecting…' }),
        ...problems,
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

    const net = opts.net;
    const members = h(
      'ul',
      { class: 'sb-members' },
      ...team.members.map((m) => {
        const li = h('li', { class: m.online ? 'online' : '' }, m.name + (m.id === you ? ' (you)' : ''));
        // Removing also keeps them from rejoining with the code they have.
        if (isOwner && m.id !== you) {
          li.append(
            ' ',
            confirmable(`remove:${m.id}`, 'Remove', `Remove ${m.name} from the team?`, 'Remove', () =>
              net.send({ type: 'removeMember', id: m.id }),
            ),
          );
        }
        return li;
      }),
    );
    const rotate = isOwner
      ? confirmable(
          'rotate',
          'New invite code',
          'Make a new invite code? The current one stops working, also for teammates who are offline right now: they’ll need the new one.',
          'New code',
          () => net.send({ type: 'rotateCode' }),
        )
      : '';

    panel.replaceChildren(
      h('h2', { textContent: team.name }),
      h(
        'p',
        { class: 'sb-meta' },
        'Invite code ',
        h('code', { textContent: team.code }),
        status === 'open' ? '' : h('span', { class: 'sb-status', textContent: ` · ${status}…` }),
      ),
      ...problems,
      h('div', { class: 'sb-row' }, copy, isOwner ? settings : '', ...(opts.actions?.() ?? [])),
      rotate,
      members,
      // Only the owner receives the link itself; everyone gets `hasZoomLink`.
      team.hasZoomLink
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
      // Send only the canonical form; the hub checks again.
      const link = normalizeMeetingLink(zoom.value.trim());
      if (link === null) {
        err.textContent = 'That isn’t a Zoom link. Paste the https://…zoom.us/j/… link from your meeting.';
        return zoom.focus();
      }
      panelError = '';
      opts.net.send({
        type: 'settings',
        teamName: name.value,
        zoomLink: link,
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
      notice = '';
      render();
    },
    setStatus(s) {
      status = s;
      render();
    },
    setError(message) {
      panelError = message;
      render();
      // Errors are about something just done; don't leave them up for good.
      clearTimeout(errorTimer);
      errorTimer = setTimeout(() => {
        panelError = '';
        render();
      }, ERROR_SHOW_MS);
    },
    setNotice(message) {
      notice = message;
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
