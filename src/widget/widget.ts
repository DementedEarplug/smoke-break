// The floating pack widget: canvas scene, speech bubble, length controls,
// dragging, and click handling. Runs inside a page (browser prototype) or as
// the whole content of the transparent desktop overlay window.

import {
  type Break,
  type ClientMsg,
  MAX_LENGTH_MIN,
  MIN_LENGTH_MIN,
  type TeamView,
} from '../../shared/protocol.ts';
import { drawText, textWidth, wrap } from './font.ts';
import { type Hit, Scene } from './scene.ts';
import { type LighterSkin, type PackSkin, LIGHTER_SKINS, PACK_SKINS } from './skins.ts';
import { COPY, type Theme } from './theme.ts';
import { H, MOUTH_Y, PACK_W, PACK_X, W } from './sprites.ts';

const BUBBLE_MAX_CHARS = 15;
/** How long the freshly lit cigarette shows before the call opens. */
const LIT_PAUSE_MS = 700;
/** Open the call anyway if the animation never gets there (e.g. a slow server). */
const MAX_LIGHT_WAIT_MS = 4000;
/** Gap (art pixels) between the bubble's tail and whatever is tallest in the scene. */
const BUBBLE_GAP = 3;
const DRAG_THRESHOLD = 4;

export interface WidgetOptions {
  /** Private per-identity key for local storage (so teammate tabs don't share settings). */
  storageKey: string;
  now(): number;
  send(msg: ClientMsg): void;
  /** Set when the widget is the whole overlay window rather than an element on a page. */
  host?: WidgetHost;
  /** Screen pixels per art pixel. */
  scale?: number;
  /** Pinch or ⌃-scroll on the pack: +1 bigger, -1 smaller. */
  onResizeRequest?(direction: 1 | -1): void;
}

export interface WidgetHost {
  /** Hand the drag to the OS so the window itself moves. */
  startWindowDrag(): void;
  /** Open a link in the default browser / Zoom app. */
  openUrl(url: string): void;
  onDndChange(on: boolean): void;
}

const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]}, ${names[1]} +${names.length - 2}`;
}

export class Widget {
  readonly root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private bubble: HTMLCanvasElement;
  private controls: HTMLDivElement;
  private lengthLabel: HTMLSpanElement;
  private scene: Scene;

  private team: TeamView | null = null;
  private dnd: boolean;
  private flickAt: number | null = null;
  /** My public member id; empty until the first state arrives. */
  private me = '';
  /** Lit but waiting for the light-up animation to finish before opening the call. */
  private meetingAfterLight: { since: number; litSeen: number | null } | null = null;
  /** Browser: the delayed popup was blocked, so the next click on the pack opens it. */
  private meetingBlocked = false;
  private toast: { text: string; until: number } | null = null;
  private hover: Hit | null = null;
  private pendingMeetingWindow: Window | null = null;
  /** Desktop: open the meeting as soon as its link arrives. */
  private pendingMeetingOpen = false;
  private lastBubbleText: string | null = null;
  private drag: { id: number; x: number; y: number; left: number; top: number; moved: boolean; hit: Hit } | null =
    null;
  private wheelAccum = 0;
  private scale: number;
  private packSkin: PackSkin = PACK_SKINS[0];
  private lighterSkin: LighterSkin = LIGHTER_SKINS[0];
  private theme: Theme = 'smoke';

  constructor(
    parent: HTMLElement,
    private readonly opts: WidgetOptions,
  ) {
    this.dnd = localStorage.getItem(this.dndKey) === '1';
    this.scale = opts.scale ?? 3;
    this.root = document.createElement('div');
    this.root.className = opts.host ? 'sb-widget sb-widget--overlay' : 'sb-widget';

    this.bubble = document.createElement('canvas');
    this.bubble.className = 'sb-bubble';

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'sb-scene';
    this.canvas.width = W;
    this.canvas.height = H;

    this.controls = document.createElement('div');
    this.controls.className = 'sb-controls';
    const minus = this.pixelButton('-', () => this.adjustLength(-1));
    const plus = this.pixelButton('+', () => this.adjustLength(1));
    this.lengthLabel = document.createElement('span');
    this.lengthLabel.className = 'sb-length';
    this.controls.append(minus, this.lengthLabel, plus);

    this.root.append(this.canvas, this.bubble, this.controls);
    this.applyScale();
    parent.append(this.root);

    this.scene = new Scene(this.canvas.getContext('2d')!);
    if (!opts.host) this.restorePosition();
    this.bindEvents();

    let last = performance.now();
    const frame = (t: number) => {
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      this.tick(dt);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  /** `you` is my public member id, as used in the break's participants. */
  setTeam(team: TeamView, you: string) {
    this.team = team;
    this.me = you;
    const url = team.brk?.meetingUrl;
    if (url && this.pendingMeetingWindow) {
      this.pendingMeetingWindow.location.href = url;
      this.pendingMeetingWindow = null;
    }
    if (url && this.pendingMeetingOpen) {
      this.pendingMeetingOpen = false;
      this.opts.host?.openUrl(url);
    }
  }

  setScale(scale: number) {
    if (scale === this.scale) return;
    this.scale = scale;
    this.applyScale();
    if (!this.opts.host) this.moveTo(this.root.offsetLeft, this.root.offsetTop);
  }

  setSkins(pack: PackSkin, lighter: LighterSkin) {
    this.packSkin = pack;
    this.lighterSkin = lighter;
  }

  setTheme(theme: Theme) {
    this.theme = theme;
  }

  private get copy() {
    return COPY[this.theme];
  }

  private applyScale() {
    const s = this.scale;
    this.root.style.width = `${W * s}px`;
    this.root.style.height = `${H * s}px`;
    this.canvas.style.width = `${W * s}px`;
    this.canvas.style.height = `${H * s}px`;
    this.controls.style.left = `${(PACK_X + PACK_W / 2) * s}px`;
    // Re-render the bubble at the new size.
    this.lastBubbleText = null;
  }

  setDnd(on: boolean) {
    if (on === this.dnd) return;
    this.dnd = on;
    localStorage.setItem(this.dndKey, on ? '1' : '0');
    this.showToast(on ? 'Do not disturb on' : 'Do not disturb off', 1500);
    this.opts.host?.onDndChange(on);
  }

  get doNotDisturb() {
    return this.dnd;
  }

  /** Whether a point (window CSS px) is on something clickable; everything else lets clicks through. */
  isInteractiveAt(clientX: number, clientY: number): boolean {
    if (this.drag) return true;
    if (!this.controls.hidden) {
      const r = this.controls.getBoundingClientRect();
      if (clientX >= r.left && clientX < r.right && clientY >= r.top && clientY < r.bottom) return true;
    }
    return this.hitAt({ clientX, clientY }) !== null;
  }

  /** Hover from a polled cursor position, for windows that don't get mouse-move events. */
  setHoverAt(clientX: number, clientY: number) {
    if (this.drag) return;
    this.hover = this.hitAt({ clientX, clientY });
    this.canvas.style.cursor = this.hover ? 'pointer' : 'default';
  }

  clearHover() {
    if (!this.drag) this.hover = null;
  }

  showToast(text: string, ms = 3000) {
    this.toast = { text, until: performance.now() + ms };
  }

  // ── Frame ─────────────────────────────────────────────────────────────────

  private get brk(): Break | null {
    return this.team?.brk ?? null;
  }

  private get myParticipant() {
    return this.brk?.participants.find((p) => p.id === this.me) ?? null;
  }

  private get canAdjustLength() {
    const b = this.brk;
    return !!b && b.phase === 'pending' && b.startedBy === this.me && b.participants.length === 1;
  }

  private tick(dt: number) {
    const input = {
      brk: this.brk,
      me: this.me,
      dnd: this.dnd,
      now: this.opts.now(),
      flickAt: this.flickAt,
      packSkin: this.packSkin,
      lighterSkin: this.lighterSkin,
      theme: this.theme,
    };
    this.scene.update(input, dt);
    this.scene.draw(input);
    this.maybeOpenMeeting();

    if (this.toast && performance.now() > this.toast.until) this.toast = null;
    this.renderBubble(this.bubbleText());
    // Smoke rises above the cigarettes, so keep the bubble from bouncing with every puff.
    const anchor = Math.min(this.scene.contentTop - BUBBLE_GAP, H - 30);
    this.bubble.style.bottom = `${(H - anchor) * this.scale}px`;

    const adjustable = this.canAdjustLength;
    this.controls.hidden = !adjustable;
    if (adjustable) this.lengthLabel.textContent = `${this.brk!.lengthMin} min`;
  }

  private bubbleText(): string | null {
    if (this.toast) return this.toast.text;
    const b = this.brk;
    const me = this.me;
    const mine = this.myParticipant;
    const hover = this.hover;

    if (!b || (this.dnd && !mine)) {
      if (hover?.target === 'pack' && !this.drag?.moved) {
        return this.dnd ? 'Do not disturb' : `Click for a ${this.copy.breakName}`;
      }
      return null;
    }

    const others = b.participants.filter((p) => p.id !== me).map((p) => p.name);
    const names = joinNames(b.participants.map((p) => p.name));
    const plural = b.participants.length > 1;

    switch (b.phase) {
      case 'pending':
        if (mine) return hover?.target === 'myCig' ? 'Click to put it back' : 'Waiting for takers...';
        return `${b.startedByName} wants a ${b.lengthMin}-min ${this.copy.breakName}`;
      case 'lighter':
        if (mine) return hover?.target === 'myCig' ? 'Click to put it back' : this.copy.lightUp;
        return `${names} ${plural ? 'are' : 'is'} heading out. Click to join`;
      case 'lit': {
        const left = b.endsAt === null ? 0 : b.endsAt - this.opts.now();
        if (mine && mine.litAt === null) return this.copy.lightUp;
        if (mine) {
          if (hover?.target === 'myCig') return `${fmtClock((left / b.minuteMs) * 60_000)} left. ${this.copy.leaveLit}`;
          if (hover?.cigId) return this.scene.nameOf(hover.cigId);
          return left < b.minuteMs ? this.copy.lastMinute : null;
        }
        const who = joinNames(b.participants.map((p) => p.name));
        return `${who} ${plural ? 'are' : 'is'} on a break. ${Math.ceil(left / b.minuteMs)} min left. Click to join`;
      }
      case 'out':
        if (!mine) return null;
        if (b.outReason === 'burned') {
          return this.team?.meetingProvider === 'fixed-link' ? "Break's over. Time to hop off Zoom" : "Break's over";
        }
        if (b.outReason === 'nobody') return 'Maybe later';
        return others.length ? null : 'Maybe later';
    }
  }

  private renderBubble(text: string | null) {
    if (text === this.lastBubbleText) return;
    this.lastBubbleText = text;
    this.bubble.hidden = text === null;
    if (text === null) return;

    const lines = wrap(text, BUBBLE_MAX_CHARS);
    const textW = Math.max(...lines.map(textWidth));
    const w = textW + 8;
    const bodyH = lines.length * 7 + 5;
    const h = bodyH + 2;
    const c = this.bubble;
    c.width = w;
    c.height = h;
    const s = this.scale;
    c.style.width = `${w * s}px`;
    c.style.height = `${h * s}px`;
    c.style.left = `${(PACK_X + PACK_W / 2) * s - (w * s) / 2}px`;

    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    const K = '#1a1020';
    const FILL = '#fffaf0';
    // Body with clipped corners.
    ctx.fillStyle = K;
    ctx.fillRect(1, 0, w - 2, bodyH);
    ctx.fillRect(0, 1, w, bodyH - 2);
    ctx.fillStyle = FILL;
    ctx.fillRect(1, 1, w - 2, bodyH - 2);
    ctx.fillStyle = '#e8dcc4';
    ctx.fillRect(1, bodyH - 2, w - 2, 1);
    // Tail: a 5-wide triangle under the middle, outlined.
    const tx = Math.floor(w / 2) - 2;
    ctx.fillStyle = K;
    ctx.fillRect(tx, bodyH - 1, 5, 1);
    ctx.fillRect(tx + 1, bodyH, 3, 1);
    ctx.fillRect(tx + 2, bodyH + 1, 1, 1);
    ctx.fillStyle = '#e8dcc4';
    ctx.fillRect(tx + 1, bodyH - 1, 3, 1);
    ctx.fillRect(tx + 2, bodyH, 1, 1);
    lines.forEach((line, i) => {
      const lx = Math.round((w - textWidth(line)) / 2);
      drawText(ctx, line, lx, 3 + i * 7, K);
    });
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  private click(hit: Hit) {
    const b = this.brk;
    const mine = this.myParticipant;

    if (hit.target === 'lighter') return this.light();
    if (hit.target === 'myCig') return this.opts.send({ type: 'leave' });

    if (this.dnd && !mine) return this.showToast('Do not disturb is on. Right-click to turn off');
    if (!b || b.phase === 'out') return this.opts.send({ type: 'invite' });
    if (!mine) {
      if (b.phase === 'lit') {
        // Late joiner: join, light, and open the call in one click.
        this.flickAt = performance.now();
        this.opts.send({ type: 'join', light: true });
        return this.openMeetingAfterLight();
      }
      return this.opts.send({ type: 'join' });
    }
    if (b.phase === 'pending') return this.showToast('Waiting for someone to join...');
    if (mine.litAt === null) return this.light();
    if (this.meetingBlocked) {
      this.meetingBlocked = false;
      return this.openMeeting();
    }
    this.showToast(this.copy.leaveToast);
  }

  private light() {
    this.flickAt = performance.now();
    this.opts.send({ type: 'light' });
    this.openMeetingAfterLight();
  }

  /** Let people watch their cigarette catch before the call takes focus. */
  private openMeetingAfterLight() {
    this.meetingBlocked = false;
    this.meetingAfterLight = { since: performance.now(), litSeen: null };
  }

  private maybeOpenMeeting() {
    const wait = this.meetingAfterLight;
    if (!wait) return;
    if (!this.myParticipant) {
      this.meetingAfterLight = null;
      return;
    }
    const now = performance.now();
    if (wait.litSeen === null && this.scene.isLit(this.me)) wait.litSeen = now;
    if ((wait.litSeen !== null && now - wait.litSeen >= LIT_PAUSE_MS) || now - wait.since >= MAX_LIGHT_WAIT_MS) {
      this.meetingAfterLight = null;
      this.openMeeting();
    }
  }

  /**
   * Browsers allow popups for a few seconds after a click, which covers the
   * light-up animation; if it's blocked anyway, the next click on the pack opens it.
   */
  private openMeeting() {
    const team = this.team;
    const url = team?.brk?.meetingUrl;
    const host = this.opts.host;
    if (host) {
      if (url) host.openUrl(url);
      else if (team?.meetingProvider === 'fixed-link' && !team.zoomLink) {
        this.showToast('No Zoom link yet. Add one in settings', 4000);
      } else this.pendingMeetingOpen = true;
    } else if (url) {
      const w = window.open(url, '_blank');
      if (w) w.opener = null;
      else this.popupBlocked();
    } else if (team?.meetingProvider === 'fixed-link' && !team.zoomLink) {
      this.showToast('No Zoom link yet. Add one in settings', 4000);
    } else {
      // The link is still being created: open a tab now and point it there when it arrives.
      const w = window.open('about:blank', '_blank');
      if (w) w.opener = null;
      else this.popupBlocked();
      this.pendingMeetingWindow = w;
    }
  }

  private popupBlocked() {
    this.meetingBlocked = true;
    this.showToast('Click the pack to open the call', 5000);
  }

  private adjustLength(delta: number) {
    if (!this.canAdjustLength) return;
    const next = Math.min(MAX_LENGTH_MIN, Math.max(MIN_LENGTH_MIN, this.brk!.lengthMin + delta));
    if (next !== this.brk!.lengthMin) this.opts.send({ type: 'setLength', lengthMin: next });
  }

  /** Per identity, so teammate tabs in one browser don't share it. */
  private get dndKey() {
    return `sb:dnd:${this.opts.storageKey}`;
  }

  private toggleDnd() {
    this.setDnd(!this.dnd);
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private pixelButton(label: string, onClick: () => void) {
    const btn = document.createElement('button');
    btn.className = 'sb-pixel-btn';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  private toScene(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  }

  private hitAt(e: { clientX: number; clientY: number }) {
    const p = this.toScene(e);
    return this.scene.hit(p.x, p.y, this.me);
  }

  private bindEvents() {
    const c = this.canvas;

    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const hit = this.hitAt(e);
      if (!hit) return;
      c.setPointerCapture(e.pointerId);
      this.drag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        left: this.root.offsetLeft,
        top: this.root.offsetTop,
        moved: false,
        hit,
      };
    });

    c.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (d && d.id === e.pointerId) {
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) d.moved = true;
        if (!d.moved) return;
        if (this.opts.host) {
          // The OS takes over from here and we may never see the pointerup.
          c.releasePointerCapture(e.pointerId);
          this.drag = null;
          this.opts.host.startWindowDrag();
        } else {
          this.moveTo(d.left + dx, d.top + dy);
        }
        return;
      }
      this.hover = this.hitAt(e);
      c.style.cursor = this.hover ? 'pointer' : 'default';
    });

    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.drag = null;
      if (d.moved) this.savePosition();
      else if (e.type === 'pointerup') this.click(d.hit);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      if (!this.drag) this.hover = null;
    });

    c.addEventListener('contextmenu', (e) => {
      if (!this.hitAt(e)) return;
      e.preventDefault();
      this.toggleDnd();
    });

    c.addEventListener(
      'wheel',
      (e) => {
        if (!this.hitAt(e)) return;
        // Pinch on a trackpad arrives as ⌃-scroll.
        if (e.ctrlKey && this.opts.onResizeRequest) {
          e.preventDefault();
          this.wheelAccum += e.deltaY;
          if (Math.abs(this.wheelAccum) >= 30) {
            this.opts.onResizeRequest(this.wheelAccum < 0 ? 1 : -1);
            this.wheelAccum = 0;
          }
          return;
        }
        if (!this.canAdjustLength) return;
        e.preventDefault();
        this.wheelAccum += e.deltaY;
        if (Math.abs(this.wheelAccum) >= 40) {
          this.adjustLength(this.wheelAccum < 0 ? 1 : -1);
          this.wheelAccum = 0;
        }
      },
      { passive: false },
    );

    if (!this.opts.host) {
      window.addEventListener('resize', () => this.moveTo(this.root.offsetLeft, this.root.offsetTop));
    }
  }

  // ── Position ──────────────────────────────────────────────────────────────

  private moveTo(left: number, top: number) {
    // Keep at least the pack on screen.
    const s = this.scale;
    const minLeft = -PACK_X * s;
    const maxLeft = window.innerWidth - (PACK_X + PACK_W) * s;
    const minTop = -(MOUTH_Y - 10) * s;
    const maxTop = window.innerHeight - H * s;
    this.root.style.left = `${Math.round(Math.min(maxLeft, Math.max(minLeft, left)))}px`;
    this.root.style.top = `${Math.round(Math.min(maxTop, Math.max(minTop, top)))}px`;
  }

  private savePosition() {
    localStorage.setItem('sb:pos', JSON.stringify({ left: this.root.offsetLeft, top: this.root.offsetTop }));
  }

  private restorePosition() {
    try {
      const p = JSON.parse(localStorage.getItem('sb:pos') ?? '');
      if (typeof p.left === 'number' && typeof p.top === 'number') return this.moveTo(p.left, p.top);
    } catch {
      // Fall through to the default spot.
    }
    this.moveTo(window.innerWidth - W * this.scale - 40, window.innerHeight - H * this.scale - 40);
  }
}
