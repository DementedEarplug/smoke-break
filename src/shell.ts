// Shared UI for joining a team and managing it: onboarding, the team panel,
// and team settings. Used by the browser prototype and the desktop settings window.

import {
  type ClientMsg,
  INVITE_CODE,
  MAX_LENGTH_MIN,
  MEETING_LINK_EXAMPLE,
  MIN_LENGTH_MIN,
  type MemberView,
  type TeamView,
  normalizeMeetingLink,
} from '../shared/protocol.ts';
import { SIZES, loadAppearance, onAppearanceChange, saveAppearance } from './appearance.ts';
import type { Net, NetStatus } from './net.ts';
import * as platform from './platform.ts';
import { lookalikeIds, whoTags } from './roster.ts';
import { hubKey } from './serverUrl.ts';
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
    placeholder: 'If your server needs one',
    type: 'password',
    autocomplete: 'off',
  });
  const showToken = platform.isDesktop || !!opts.askToken;
  /** Where the token is kept, and anything wrong with keeping it there. */
  const tokenHint = h('p', { class: 'sb-hint', textContent: '' });
  const tokenWarn = h('p', { class: 'sb-warn', textContent: '' });
  const showTokenNotes = (hub: string) => {
    tokenHint.textContent = platform.tokenStorageHint();
    tokenWarn.textContent = platform.tokenNotice(hub);
  };

  /**
   * Tokens are saved per hub. The field shows the saved one for the address in
   * the Server field, and follows it when the address changes, so a token
   * meant for one hub is never saved for (and sent to) another.
   */
  let shown = { hub: platform.currentHub(), token: '' };
  const fillToken = async (hub: string) => {
    const saved = await platform.savedHubToken(hub);
    showTokenNotes(hub);
    // Leave it alone if the person has typed over it meanwhile.
    if (token.value !== shown.token) return;
    token.value = saved;
    shown = { hub, token: saved };
  };
  if (showToken) {
    void fillToken(shown.hub);
    server.addEventListener('change', () => {
      if (!checkServerUrlOk(server.value)) return;
      void fillToken(hubKey(server.value));
    });
  }

  /** Checks and saves the name and connection settings; null if something needs fixing. */
  let busy = false;
  const saveFields = async (): Promise<{ name: string; clientId: string } | null> => {
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
    const hub = platform.currentHub();
    // Only save what was typed for this hub (or its own saved token, unchanged).
    // If the Keychain won't keep it, it's used for this run only; the team panel says so.
    if (showToken && (token.value !== shown.token || shown.hub === hub)) await platform.saveHubToken(token.value, hub);
    platform.saveName(n);
    try {
      return { name: n, clientId: await platform.clientId(hub) };
    } catch (e) {
      // The Keychain refused the identity: say why; pressing the button again retries.
      errorEl.textContent = e instanceof Error ? e.message : String(e);
      return null;
    }
  };
  /** Runs a submit once at a time (saving the token and making the id take a moment). */
  const submit = (make: (f: { name: string; clientId: string }) => JoinMsg | null) => async () => {
    if (busy) return;
    busy = true;
    try {
      const f = await saveFields();
      const first = f && make(f);
      if (first) opts.onSubmit(first);
    } finally {
      busy = false;
    }
  };

  const card = h('form', { class: 'sb-card sb-onboarding' }, h('h1', { textContent: appTitle() }));
  card.addEventListener('submit', (e) => e.preventDefault());
  card.append(h('label', {}, 'Name', name));

  if (teamCode) {
    const join = h('button', { type: 'submit', textContent: `Join team ${teamCode}` });
    join.onclick = submit((f) => ({ type: 'hello', teamCode, clientId: f.clientId, name: f.name }));
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
    create.onclick = submit((f) => ({ type: 'create', teamName: teamName.value, clientId: f.clientId, name: f.name }));
    const code = h('input', { placeholder: 'Invite code', maxLength: INVITE_CODE_INPUT_MAX, className: 'sb-code' });
    const join = h('button', { type: 'button', textContent: 'Join' });
    const joinCode = () => {
      const c = cleanInviteCode(code.value);
      if (!c) {
        code.focus();
        return null;
      }
      if (!INVITE_CODE.test(c)) {
        errorEl.textContent = "That doesn't look like an invite code. Check it with whoever sent it.";
        code.focus();
        return null;
      }
      return c;
    };
    join.onclick = () => {
      const c = joinCode();
      if (c) void submit((f) => ({ type: 'hello', teamCode: c, clientId: f.clientId, name: f.name }))();
    };
    card.append(
      h('fieldset', {}, h('legend', { textContent: 'New team' }), teamName, create),
      h('fieldset', {}, h('legend', { textContent: 'Have an invite code?' }), code, join),
    );
  }
  if (platform.serverIsConfigurable) card.append(h('label', {}, 'Server', server));
  if (showToken) card.append(h('label', {}, 'Access token', token), tokenHint, tokenWarn);
  card.append(errorEl);
  container.replaceChildren(h('div', { class: 'sb-center' }, card));
  name.focus();
}

const checkServerUrlOk = (raw: string) => !!raw.trim() && platform.serverProblem(raw.trim()) === null;

// ── Team panel ──────────────────────────────────────────────────────────────

const ERROR_SHOW_MS = 8000;

export interface TeamPanel {
  setTeam(team: TeamView, you: string): void;
  setStatus(status: NetStatus): void;
  setError(message: string): void;
  /**
   * A connection problem to show until the next team update ('' clears it),
   * optionally with a button that does something about it.
   */
  setNotice(message: string, action?: NoticeAction): void;
  /** The owner hasn't let us into this team yet: show the waiting screen until `setTeam`. */
  setWaiting(teamCode: string): void;
}

export interface NoticeAction {
  label: string;
  run(): void;
}

export function createTeamPanel(
  panel: HTMLElement,
  opts: {
    net: Net;
    /** Extra buttons for the host (e.g. "Open a teammate tab", "Leave team"). */
    actions?: () => HTMLElement[];
    hint: string;
    /** "Cancel" on the waiting screen: stop asking and forget the team. */
    onCancelWaiting(): void;
    /** A standing warning, e.g. the access token is only kept until the app quits ('' for none). */
    storageNotice?(): string;
  },
): TeamPanel {
  let team: TeamView | null = null;
  let you = '';
  let status: NetStatus = 'connecting';
  let settingsOpen = false;
  let panelError = '';
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  let notice = '';
  let noticeAction: NoticeAction | undefined;
  /** Waiting for the owner's OK to join this team ('' when not waiting). */
  let waitingFor = '';
  /** Owner actions waiting for a second click: 'rotate', or `remove:<id>` / `owner:<id>` for a member. */
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
    const problems: HTMLElement[] = [notice, panelError].filter(Boolean).map((m) => h('p', { class: 'sb-error', textContent: m }));
    if (notice && noticeAction) {
      const act = noticeAction;
      const b = h('button', { textContent: act.label, className: 'secondary' });
      b.onclick = () => act.run();
      problems.splice(1, 0, h('div', { class: 'sb-row sb-notice-action' }, b));
    }
    const stored = opts.storageNotice?.() ?? '';
    if (stored) problems.push(h('p', { class: 'sb-warn', textContent: stored }));
    if (waitingFor) {
      const cancel = h('button', { textContent: 'Cancel', className: 'secondary' });
      cancel.onclick = () => opts.onCancelWaiting();
      panel.replaceChildren(
        h('h2', { textContent: appTitle() }),
        h('p', { textContent: 'Waiting for the owner to let you in…' }),
        h(
          'p',
          { class: 'sb-hint' },
          'Team ',
          h('code', { textContent: waitingFor }),
          '. You’re on the list; this checks again every few seconds and carries on by itself once they say yes.',
        ),
        h('div', { class: 'sb-row' }, cancel),
      );
      return;
    }
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
    const t = team;
    /** Entries whose names look the same as another's: they get their id shown too. */
    const alike = lookalikeIds(t.members, t.pending);
    /**
     * The access-token label (only the owner receives it) is who someone
     * really is; the name is what they typed. Shown next to the name, with the
     * start of the id where that alone doesn't tell people apart.
     */
    const who = (m: MemberView, waiting: boolean): HTMLElement[] => {
      const tags = whoTags(m, { lookalike: alike.has(m.id), waiting });
      const out: HTMLElement[] = [];
      if (tags.label) {
        out.push(
          h('span', {
            class: 'sb-label',
            textContent: tags.label,
            title: 'Whose access token they use: who they really are. The name is just what they typed.',
          }),
        );
      }
      if (tags.id) out.push(h('code', { class: 'sb-id', textContent: tags.id, title: 'Start of their id' }));
      return out;
    };
    /** Inline confirm for one member; only one of a member's actions asks at a time. */
    const memberActions = (m: MemberView) => {
      const whom = m.label ? `${m.name} (${m.label})` : m.name;
      const consequences = m.label
        ? `This removes every device that uses ${m.label}’s access token, and none of them can rejoin.`
        : 'They can’t rejoin.';
      const remove = () =>
        confirmable(
          `remove:${m.id}`,
          'Remove',
          `Remove ${whom}? ${consequences} The invite code changes too: teammates who are offline will need the new one from you.`,
          'Remove',
          () => net.send({ type: 'removeMember', id: m.id }),
        );
      const makeOwner = () =>
        confirmable(
          `owner:${m.id}`,
          'Make owner',
          `Make ${whom} the owner? They’ll manage the team and its settings, and you won’t any more.`,
          'Make owner',
          () => net.send({ type: 'transferOwner', id: m.id }),
        );
      if (confirming === `remove:${m.id}`) return [remove()];
      if (confirming === `owner:${m.id}`) return [makeOwner()];
      return [remove(), makeOwner()];
    };
    const members = h(
      'ul',
      { class: 'sb-members' },
      ...t.members.map((m) => {
        const li = h(
          'li',
          { class: m.online ? 'online' : '', title: m.online ? 'Online' : 'Offline' },
          m.name + (m.id === you ? ' (you)' : ''),
          ...who(m, false),
        );
        if (m.id === t.ownerId) li.append(h('span', { class: 'sb-tag', textContent: 'owner' }));
        // Removing also keeps them from rejoining with the code they have.
        if (isOwner && m.id !== you) li.append(...memberActions(m));
        return li;
      }),
    );
    // Only the owner receives the waiting list. Names are whatever people typed;
    // the label (or else the start of their id) says who is really asking.
    const waiting =
      isOwner && t.pending.length
        ? h(
            'div',
            { class: 'sb-waiting' },
            h('p', { class: 'sb-field-label', textContent: 'Waiting to join' }),
            h(
              'ul',
              { class: 'sb-members' },
              ...t.pending.map((m) => {
                const allow = h('button', { textContent: 'Allow' });
                allow.onclick = () => net.send({ type: 'approveMember', id: m.id, allow: true });
                // Not for good: the hub lets them ask again after a day.
                const deny = h('button', {
                  textContent: 'Not now',
                  className: 'secondary',
                  title: 'Turn them away for now. They can ask again after a day.',
                });
                deny.onclick = () => net.send({ type: 'approveMember', id: m.id, allow: false });
                return h('li', { class: 'online' }, m.name, ...who(m, true), allow, deny);
              }),
            ),
            h('p', {
              class: 'sb-hint',
              textContent:
                'Names are what people typed in. The boxed name after it, when there is one, is whose access token they use: that is who is really asking. Only let in people you expect. “Not now” turns someone away for a day; after that they can ask again.',
            }),
          )
        : '';
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
      waiting,
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
    const approve = h('input', { type: 'checkbox', checked: team.requireApproval });
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
        err.textContent = `That isn’t a Zoom meeting link. Paste the meeting’s invite link, like ${MEETING_LINK_EXAMPLE} (or …/my/your.name).`;
        return zoom.focus();
      }
      panelError = '';
      opts.net.send({
        type: 'settings',
        teamName: name.value,
        zoomLink: link,
        defaultLengthMin: Number(length.value),
        requireApproval: approve.checked,
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
      h('label', { class: 'sb-radio' }, approve, 'Approve new members'),
      h('p', {
        class: 'sb-hint',
        textContent: 'New people who have the invite code wait until you let them in. People already on the team aren’t affected.',
      }),
      err,
      h('div', { class: 'sb-row' }, save, cancel),
    );
  }

  /**
   * Updates from the hub redraw the panel at most once a frame: a team can
   * have hundreds of rows, and a hub may send updates as fast as it likes.
   */
  let redrawQueued = false;
  const redraw = () => {
    if (redrawQueued) return;
    redrawQueued = true;
    requestAnimationFrame(() => {
      redrawQueued = false;
      render();
    });
  };

  render();
  return {
    setTeam(t, me) {
      team = t;
      you = me;
      notice = '';
      noticeAction = undefined;
      waitingFor = '';
      // Ownership can move to someone else while their settings are open.
      if (settingsOpen && t.ownerId !== me) settingsOpen = false;
      redraw();
    },
    setWaiting(teamCode) {
      waitingFor = teamCode;
      settingsOpen = false;
      redraw();
    },
    setStatus(s) {
      status = s;
      redraw();
    },
    setError(message) {
      panelError = message;
      redraw();
      // Errors are about something just done; don't leave them up for good.
      clearTimeout(errorTimer);
      errorTimer = setTimeout(() => {
        panelError = '';
        redraw();
      }, ERROR_SHOW_MS);
    },
    setNotice(message, action) {
      notice = message;
      noticeAction = message ? action : undefined;
      redraw();
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
