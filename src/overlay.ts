// Desktop overlay window: a transparent, frameless, always-on-top window that
// contains only the pack. Clicks on empty pixels fall through to the apps below.

import './style.css';
import { type Appearance, loadAppearance, onAppearanceChange, saveAppearance } from './appearance.ts';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  type Window,
  availableMonitors,
  currentMonitor,
  cursorPosition,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from '@tauri-apps/api/window';
import { normalizeMeetingLink } from '../shared/protocol.ts';
import * as platform from './platform.ts';
import { createSession } from './session.ts';
import { lighterSkin, packSkin } from './widget/skins.ts';
import { BODY_H, H, MOUTH_Y, PACK_W, PACK_X, W } from './widget/sprites.ts';
import { Widget } from './widget/widget.ts';

const POS_KEY = 'sb:overlayPos';
/** Cursor polling: fast near the window, slow when the cursor is far away. */
const CURSOR_POLL_MS = 40;
const CURSOR_POLL_FAR_MS = 200;
/** "Near" means within this many CSS px of the window. */
const CURSOR_NEAR_PX = 300;
/** Room under the pack for the length buttons (fixed size, not scaled). */
const CONTROLS_SPACE = 44;
const CONTROLS_HALF_WIDTH = 72;
/** Tallest bubble plus fully slid-out cigarettes, in art pixels above the canvas bottom. */
const HEADROOM = 100;

/** Window size and where the widget sits in it, for a given scale (CSS px). */
function layoutFor(scale: number) {
  const packCenter = (PACK_X + PACK_W / 2) * scale;
  // The bubble can overhang the canvas on the left; the length buttons can too at small sizes.
  const left = Math.max(9 * scale, CONTROLS_HALF_WIDTH - packCenter + 4);
  const width = left + Math.max(W * scale, packCenter + CONTROLS_HALF_WIDTH) + 4;
  const height = HEADROOM * scale + CONTROLS_SPACE;
  // Distance from the window top to the pack's bottom edge.
  const packBottom = height - CONTROLS_SPACE - (H - MOUTH_Y - BODY_H) * scale;
  return { left, width, height, packCenterX: left + packCenter, packBottom };
}

document.documentElement.classList.add('sb-overlay');
const win = getCurrentWindow();

// Joining or leaving a team happens in the settings window; start over when it does.
void listen('identity-changed', () => location.reload());

const identity = platform.loadIdentity();
// A refused server address is explained (and fixed) in the settings window.
if (identity && !platform.serverProblem()) {
  void start(identity);
} else {
  void win.hide();
  void invoke('show_panel');
}

async function start(id: platform.Identity) {
  let mouseDown = false;

  let askedForToken = false;
  const net = createSession(
    { type: 'hello', teamCode: id.teamCode, clientId: id.clientId, name: id.name },
    {
      onTeam: (team, you) => widget.setTeam(team, you),
      onError: (message) => widget.showToast(message),
      onFatal: async (_message, forget) => {
        // The team is gone (bad code, or we were removed): back to onboarding.
        // Otherwise (e.g. the server address is refused) the settings window
        // explains and keeps the team.
        if (forget) platform.leaveTeam();
        await win.hide();
        await invoke('show_panel');
      },
      onRetrying: (message, code) => {
        // Keep the team and let the session back off; just say why the pack is quiet.
        widget.showToast(message, 6000);
        if (code === 'unauthorized' && !askedForToken) {
          // Only someone typing in the right token fixes this; the settings window asks for it.
          askedForToken = true;
          void invoke('show_panel');
        }
      },
    },
  );

  let look = loadAppearance();
  const widget = new Widget(document.getElementById('app')!, {
    storageKey: id.clientId,
    now: () => net.now(),
    send: (m) => net.send(m),
    scale: look.scale,
    onResizeRequest: (dir) => saveAppearance({ scale: loadAppearance().scale + dir }),
    host: {
      startWindowDrag() {
        mouseDown = false;
        void win.startDragging();
      },
      // The Rust side checks the link again (https, exact Zoom host) and opens
      // only its own re-serialized copy; JS has no general "open a URL" permission.
      openUrl: (url) => {
        const link = normalizeMeetingLink(url);
        if (!link) return widget.showToast("That meeting link doesn't look right, so it wasn't opened", 5000);
        invoke('open_meeting', { url: link }).catch(() =>
          widget.showToast("Couldn't open the meeting link", 5000),
        );
      },
      onDndChange: (on) => void invoke('set_dnd', { on }),
    },
  });
  net.connect();

  const positionWidget = (scale: number) => {
    widget.root.style.left = `${layoutFor(scale).left}px`;
    widget.root.style.bottom = `${CONTROLS_SPACE}px`;
  };
  widget.setSkins(packSkin(look.pack), lighterSkin(look.lighter));
  widget.setTheme(look.theme);
  positionWidget(look.scale);
  const { width, height } = layoutFor(look.scale);
  await win.setSize(new LogicalSize(width, height));

  onAppearanceChange(async (next: Appearance) => {
    const prev = look;
    look = next;
    widget.setSkins(packSkin(next.pack), lighterSkin(next.lighter));
    widget.setTheme(next.theme);
    if (next.scale === prev.scale) return;
    await resizeKeepingPack(win, prev.scale, next.scale);
    positionWidget(next.scale);
    widget.setScale(next.scale);
  });

  // Keep the tray's checkbox and the pack in sync.
  void invoke('set_dnd', { on: widget.doNotDisturb });
  void listen<boolean>('dnd', (e) => widget.setDnd(e.payload));

  window.addEventListener('pointerdown', () => (mouseDown = true));
  window.addEventListener('pointerup', () => (mouseDown = false));

  await placeWindow(win);
  await win.show();
  await clickThrough(win, widget, () => mouseDown);
}

/**
 * The window ignores the mouse except over the pack, lighter, cigarettes, or
 * length buttons. While ignoring, the webview gets no events, so poll the cursor.
 */
async function clickThrough(win: Window, widget: Widget, isMouseDown: () => boolean) {
  let origin = await win.outerPosition();
  let scale = await win.scaleFactor();
  void win.onMoved((e) => (origin = e.payload));
  void win.onScaleChanged((e) => (scale = e.payload.scaleFactor));

  let ignoring: boolean | null = null;
  const setIgnore = (on: boolean) => {
    if (on === ignoring) return;
    ignoring = on;
    void win.setIgnoreCursorEvents(on);
  };

  const poll = async () => {
    let next = CURSOR_POLL_MS;
    try {
      const p = await cursorPosition();
      const x = (p.x - origin.x) / scale;
      const y = (p.y - origin.y) / scale;
      const inside = x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
      const dx = Math.max(0, -x, x - window.innerWidth);
      const dy = Math.max(0, -y, y - window.innerHeight);
      if (Math.hypot(dx, dy) > CURSOR_NEAR_PX && !isMouseDown()) next = CURSOR_POLL_FAR_MS;
      setIgnore(!(isMouseDown() || (inside && widget.isInteractiveAt(x, y))));
      if (inside) widget.setHoverAt(x, y);
      else widget.clearHover();
    } catch {
      // Window is closing or the API isn't ready; try again next tick.
    }
    setTimeout(poll, next);
  };
  setIgnore(true);
  void poll();
}

/** Resize the window for a new scale, keeping the pack's bottom-center where it was on screen. */
async function resizeKeepingPack(win: Window, from: number, to: number) {
  const a = layoutFor(from);
  const b = layoutFor(to);
  const [pos, dpr] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
  await win.setSize(new LogicalSize(b.width, b.height));
  await win.setPosition(
    new PhysicalPosition(
      Math.round(pos.x + (a.packCenterX - b.packCenterX) * dpr),
      Math.round(pos.y + (a.packBottom - b.packBottom) * dpr),
    ),
  );
}

/** Restore the last position if it's still on a screen, otherwise bottom-right of the current one. */
async function placeWindow(win: Window) {
  const size = await win.outerSize();
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) ?? '') as { x: number; y: number };
    const monitors = await availableMonitors();
    const onScreen = monitors.some(
      (m) =>
        saved.x + size.width / 2 >= m.position.x &&
        saved.x + size.width / 2 < m.position.x + m.size.width &&
        saved.y + size.height / 2 >= m.position.y &&
        saved.y + size.height / 2 < m.position.y + m.size.height,
    );
    if (onScreen) await win.setPosition(new PhysicalPosition(saved.x, saved.y));
    else throw new Error('off screen');
  } catch {
    const m = await currentMonitor();
    if (m) {
      const margin = 24 * m.scaleFactor;
      await win.setPosition(
        new PhysicalPosition(
          Math.round(m.position.x + m.size.width - size.width - margin),
          Math.round(m.position.y + m.size.height - size.height - margin * 3),
        ),
      );
    }
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  void win.onMoved((e) => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => localStorage.setItem(POS_KEY, JSON.stringify(e.payload)), 300);
  });
}
