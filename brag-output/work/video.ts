// Launch video for Smoke Break. Every frame is drawn with the app's own Scene,
// sprites, skins, bitmap font and bubble art. Frames are rendered in order via
// window.renderFrame(f); jumping backwards replays from frame 0 with the same seed.

import type { Break, Participant } from '../../shared/protocol.ts';
import { drawText, textWidth, wrap } from '../../src/widget/font.ts';
import { packPreview } from '../../src/widget/preview.ts';
import { Scene } from '../../src/widget/scene.ts';
import { LIGHTER_SKINS, PACK_SKINS, lighterSkin, packSkin } from '../../src/widget/skins.ts';
import * as S from '../../src/widget/sprites.ts';
import { type Theme, packSkinsFor } from '../../src/widget/theme.ts';

const FPS = 30;
export const TOTAL = 36 * FPS;
const DT = 1 / FPS;
const VW = 1920;
const VH = 1080;

const INK = '#1a1020';
const PAPER = '#fffaf0';
const PAPER_SHADE = '#e8dcc4';
const RED = '#d23a3a';
const SOFT = '#c9c2d8';
const MONO = "'SF Mono', Menlo, ui-monospace, monospace";

// ── Determinism ─────────────────────────────────────────────────────────────

let seed = 1;
Math.random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
let fakeNow = 0;
performance.now = () => fakeNow;

// ── Helpers ─────────────────────────────────────────────────────────────────

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

function offscreen(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const P = (id: string, name: string, litAt: number | null = null): Participant => ({ id, name, joinedAt: 0, litAt });
const MAYA = (lit: number | null = null) => P('maya', 'Maya', lit);
const THEO = (lit: number | null = null) => P('theo', 'Theo', lit);
const SAM = (lit: number | null = null) => P('sam', 'Sam', lit);

function brk(p: Partial<Break> & { participants: Participant[] }): Break {
  return {
    id: 'b1',
    phase: 'pending',
    startedBy: 'maya',
    startedByName: 'Maya',
    lengthMin: 12,
    minuteMs: 60_000,
    createdAt: 0,
    pendingExpiresAt: null,
    litAt: null,
    endsAt: null,
    outAt: null,
    outReason: null,
    meetingRequested: false,
    meetingUrl: null,
    ...p,
  };
}

/** Pixel-font text at an integer scale, with the app's hard ink shadow. */
function pixelText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, s: number, color: string, shadow = true) {
  const up = text.toUpperCase();
  if (shadow) {
    const o = Math.max(2, Math.round(s / 2));
    ctx.save();
    ctx.translate(Math.round(x) + o, Math.round(y) + o);
    ctx.scale(s, s);
    drawText(ctx, up, 0, 0, INK);
    ctx.restore();
  }
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.scale(s, s);
  drawText(ctx, up, 0, 0, color);
  ctx.restore();
}

/** Lines that type on quickly, then hold. */
function typedLines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  x: number,
  y: number,
  s: number,
  lt: number,
  start: number,
  opts: { color?: string; lineGap?: number; center?: boolean; cps?: number } = {},
) {
  const cps = opts.cps ?? 80;
  let budget = Math.floor((lt - start) * cps);
  lines.forEach((line, i) => {
    if (budget <= 0) return;
    const shown = line.slice(0, budget);
    budget -= line.length;
    const lx = opts.center ? x - (textWidth(line) * s) / 2 : x;
    pixelText(ctx, shown, lx, y + i * (5 * s + (opts.lineGap ?? 3 * s)), s, opts.color ?? PAPER);
  });
}

function monoText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, alpha = 1) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = `600 ${size}px ${MONO}`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = INK;
  ctx.fillText(text, x + 3, y + 3);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

// ── Bubble (same art as Widget.renderBubble) ────────────────────────────────

const bubbleCache = new Map<string, HTMLCanvasElement>();
function bubbleCanvas(text: string) {
  let c = bubbleCache.get(text);
  if (c) return c;
  const lines = wrap(text, 15);
  const w = Math.max(...lines.map(textWidth)) + 8;
  const bodyH = lines.length * 7 + 5;
  c = offscreen(w, bodyH + 2);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = INK;
  ctx.fillRect(1, 0, w - 2, bodyH);
  ctx.fillRect(0, 1, w, bodyH - 2);
  ctx.fillStyle = PAPER;
  ctx.fillRect(1, 1, w - 2, bodyH - 2);
  ctx.fillStyle = PAPER_SHADE;
  ctx.fillRect(1, bodyH - 2, w - 2, 1);
  const tx = Math.floor(w / 2) - 2;
  ctx.fillStyle = INK;
  ctx.fillRect(tx, bodyH - 1, 5, 1);
  ctx.fillRect(tx + 1, bodyH, 3, 1);
  ctx.fillRect(tx + 2, bodyH + 1, 1, 1);
  ctx.fillStyle = PAPER_SHADE;
  ctx.fillRect(tx + 1, bodyH - 1, 3, 1);
  ctx.fillRect(tx + 2, bodyH, 1, 1);
  lines.forEach((line, i) => drawText(ctx, line, Math.round((w - textWidth(line)) / 2), 3 + i * 7, INK));
  bubbleCache.set(text, c);
  return c;
}

// ── A pack on someone's screen, driven by a script ──────────────────────────

interface Frame {
  brk: Break | null;
  bubble: string | null;
  /** Server clock (ms). Defaults to local time. */
  now?: number;
  /** Local ms of the lighter flick. */
  flickAt?: number | null;
}

class Actor {
  readonly canvas = offscreen(S.W, S.H);
  readonly scene = new Scene(this.canvas.getContext('2d')!);
  t = 0;
  frame: Frame = { brk: null, bubble: null };
  constructor(
    readonly me: string,
    readonly script: (t: number) => Frame,
    readonly pack = 'classic',
    readonly lighter = 'classic',
    readonly theme: Theme = 'smoke',
  ) {}

  step(dt: number) {
    this.t += dt;
    fakeNow = this.t * 1000;
    const f = this.script(this.t);
    this.frame = f;
    const input = {
      brk: f.brk,
      me: this.me,
      dnd: false,
      now: f.now ?? this.t * 1000,
      flickAt: f.flickAt ?? null,
      packSkin: packSkin(this.pack),
      lighterSkin: lighterSkin(this.lighter),
      theme: this.theme,
    };
    this.scene.update(input, dt);
    this.scene.draw(input);
  }

  /** Pre-roll so smoke is already drifting on the first frame. */
  preroll(seconds: number) {
    const keep = this.script;
    const first = keep(0);
    (this as { script: (t: number) => Frame }).script = () => first;
    for (let i = 0; i < seconds * FPS; i++) this.step(DT);
    (this as { script: (t: number) => Frame }).script = keep;
    this.t = 0;
  }

  /** Draw with the pack's bottom-center at (cx, bottom). */
  drawAt(ctx: CanvasRenderingContext2D, cx: number, bottom: number, s: number) {
    this.draw(ctx, cx - (S.PACK_X + S.PACK_W / 2) * s, bottom - (S.MOUTH_Y + S.BODY_H) * s, s);
  }

  draw(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.canvas, x, y, S.W * s, S.H * s);
    const text = this.frame.bubble;
    if (!text) return;
    const b = bubbleCanvas(text);
    const anchor = Math.min(this.scene.contentTop - 3, S.H - 30);
    const cx = x + (S.PACK_X + S.PACK_W / 2) * s;
    const bx = Math.round(clamp(cx - (b.width * s) / 2, 40, VW - 40 - b.width * s));
    const by = Math.round(y + anchor * s - b.height * s);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowOffsetX = 3 * (s / 3);
    ctx.shadowOffsetY = 3 * (s / 3);
    ctx.drawImage(b, bx, by, b.width * s, b.height * s);
    ctx.restore();
  }
}

// ── Cursor ──────────────────────────────────────────────────────────────────

const ARROW = [
  'K..........',
  'KK.........',
  'KWK........',
  'KWWK.......',
  'KWWWK......',
  'KWWWWK.....',
  'KWWWWWK....',
  'KWWWWWWK...',
  'KWWWWWWWK..',
  'KWWWWWWWWK.',
  'KWWWWWKKKKK',
  'KWWKWWK....',
  'KWK.KWWK...',
  'KK..KWWK...',
  'K....KWWK..',
  '.....KKK...',
];

type Key = [t: number, x: number, y: number];
function cursorAt(keys: Key[], t: number): [number, number] {
  if (t <= keys[0][0]) return [keys[0][1], keys[0][2]];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, x0, y0] = keys[i - 1];
      const [t1, x1, y1] = keys[i];
      const k = easeInOut(clamp((t - t0) / (t1 - t0)));
      return [lerp(x0, x1, k), lerp(y0, y1, k)];
    }
  }
  const last = keys[keys.length - 1];
  return [last[1], last[2]];
}

function drawCursor(ctx: CanvasRenderingContext2D, keys: Key[], clicks: number[], t: number, s = 5) {
  const [x, y] = cursorAt(keys, t);
  for (const c of clicks) {
    const k = (t - c) / 0.3;
    if (k < 0 || k > 1) continue;
    ctx.save();
    ctx.globalAlpha *= 1 - k;
    ctx.strokeStyle = PAPER;
    ctx.lineWidth = s;
    const r = 10 + k * 40;
    ctx.strokeRect(Math.round(x - r), Math.round(y - r), Math.round(r * 2), Math.round(r * 2));
    ctx.restore();
  }
  const pressed = clicks.some((c) => t >= c && t < c + 0.12);
  const ox = Math.round(x);
  const oy = Math.round(y + (pressed ? s : 0));
  ARROW.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const ch = row[rx];
      if (ch === '.') continue;
      ctx.fillStyle = ch === 'K' ? INK : '#ffffff';
      ctx.fillRect(ox + rx * s, oy + ry * s, s, s);
    }
  });
}

// ── Background ──────────────────────────────────────────────────────────────

const bg = offscreen(VW, VH);
{
  const ctx = bg.getContext('2d')!;
  // 160deg CSS gradient ≈ top-left to bottom-right, slightly steep.
  const g = ctx.createLinearGradient(VW * 0.33, 0, VW * 0.67, VH);
  g.addColorStop(0, '#3b4a6b');
  g.addColorStop(0.6, '#2a2f48');
  g.addColorStop(1, '#241f36');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  for (let x = 0; x < VW; x += 36) ctx.fillRect(x, 0, 2, VH);
  for (let y = 0; y < VH; y += 36) ctx.fillRect(0, y, VW, 2);
}

// ── Shots ───────────────────────────────────────────────────────────────────

interface Shot<T = any> {
  start: number;
  end: number;
  make: () => T;
  tick: (st: T, lt: number) => void;
  draw: (ctx: CanvasRenderingContext2D, st: T, lt: number) => void;
}

const lit = (litAt: number, participants: Participant[], extra: Partial<Break> = {}) =>
  brk({ phase: 'lit', litAt, endsAt: litAt + 12 * 60_000, participants, meetingRequested: true, ...extra });

// 1. Hook: the pack on Maya's screen. She clicks it.
const HOOK = { cx: 1420, bottom: 900, s: 13 };
const HOOK_CLICK = 2.0;
const hook: Shot<{ a: Actor }> = {
  start: 0,
  end: 4,
  make: () => ({
    a: new Actor('maya', (t) => ({
      brk: t < HOOK_CLICK ? null : brk({ participants: [MAYA()] }),
      bubble: t < 0.5 ? null : t < HOOK_CLICK ? 'Click for a smoke break' : 'Waiting for takers...',
    })),
  }),
  tick: (st) => st.a.step(DT),
  draw: (ctx, st, lt) => {
    typedLines(ctx, ['A cigarette pack', 'that floats on', 'your screen.'], 150, 360, 11, lt, 0.1, { cps: 40 });
    st.a.drawAt(ctx, HOOK.cx, HOOK.bottom, HOOK.s);
    const px = HOOK.cx + 30;
    const py = HOOK.bottom - 7 * HOOK.s;
    drawCursor(
      ctx,
      [
        [0.4, 1900, 1040],
        [1.7, px, py],
        [2.6, px + 6, py + 6],
        [3.6, px + 200, py + 160],
      ],
      [HOOK_CLICK],
      lt,
    );
  },
};

// 2. Invite: three screens.
const PANEL_W = 540;
const PANEL_Y = 270;
const PANEL_H = 740;
const INVITE_BOTTOM = PANEL_Y + PANEL_H - 60;
const panelX = (i: number) => 90 + i * (PANEL_W + 60);

function drawPanel(ctx: CanvasRenderingContext2D, x: number, label: string) {
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(x + 12, PANEL_Y + 12, PANEL_W, PANEL_H);
  ctx.fillStyle = INK;
  ctx.fillRect(x, PANEL_Y, PANEL_W, PANEL_H);
  ctx.fillStyle = '#323d5c';
  ctx.fillRect(x + 6, PANEL_Y + 60, PANEL_W - 12, PANEL_H - 66);
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  for (let gx = x + 6; gx < x + PANEL_W - 6; gx += 30) ctx.fillRect(gx, PANEL_Y + 60, 2, PANEL_H - 66);
  for (let gy = PANEL_Y + 60; gy < PANEL_Y + PANEL_H - 6; gy += 30) ctx.fillRect(x + 6, gy, PANEL_W - 12, 2);
  ctx.fillStyle = PAPER;
  ctx.fillRect(x + 6, PANEL_Y + 6, PANEL_W - 12, 48);
  ctx.fillStyle = PAPER_SHADE;
  ctx.fillRect(x + 6, PANEL_Y + 48, PANEL_W - 12, 6);
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = [RED, '#e6b34a', '#5fd08e'][i];
    ctx.fillRect(x + 24 + i * 26, PANEL_Y + 21, 14, 14);
  }
  pixelText(ctx, label, x + PANEL_W - 24 - textWidth(label.toUpperCase()) * 4, PANEL_Y + 18, 4, INK, false);
}

/** A screen with a pack on it, clipped to the screen. */
function drawScreen(ctx: CanvasRenderingContext2D, x: number, label: string, a: Actor) {
  drawPanel(ctx, x, label);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 6, PANEL_Y + 60, PANEL_W - 12, PANEL_H - 66);
  ctx.clip();
  a.drawAt(ctx, x + PANEL_W / 2, INVITE_BOTTOM, 7);
  ctx.restore();
}

const INVITE_LAND = 0.5;
const THEO_JOIN = 2.5;
const SAM_JOIN = 5.0;
const invite: Shot<{ actors: Actor[] }> = {
  start: 4,
  end: 10,
  make: () => {
    const phase = (n: number) =>
      n === 1 ? brk({ participants: [MAYA()] }) : brk({ phase: 'lighter', meetingRequested: true, participants: n === 2 ? [MAYA(), THEO()] : [MAYA(), THEO(), SAM()] });
    const count = (t: number) => (t < THEO_JOIN ? 1 : t < SAM_JOIN ? 2 : 3);
    return {
      actors: [
        new Actor('maya', (t) => ({ brk: phase(count(t)), bubble: count(t) === 1 ? 'Waiting for takers...' : 'Light up?' })),
        new Actor('theo', (t) => ({
          brk: t < INVITE_LAND ? null : phase(count(t)),
          bubble: t < INVITE_LAND ? null : count(t) === 1 ? 'Maya wants a 12-min smoke break' : 'Light up?',
        })),
        new Actor('sam', (t) => ({
          brk: t < INVITE_LAND ? null : phase(count(t)),
          bubble:
            t < INVITE_LAND ? null : count(t) === 1 ? 'Maya wants a 12-min smoke break' : count(t) === 2 ? 'Maya & Theo are heading out. Click to join' : 'Light up?',
        })),
      ],
    };
  },
  tick: (st) => st.actors.forEach((a) => a.step(DT)),
  draw: (ctx, st, lt) => {
    typedLines(ctx, ['Click it. Your whole team gets the invite.'], VW / 2, 130, 7, lt, 0.1, { center: true, cps: 45 });
    const labels = ["Maya's screen", "Theo's screen", "Sam's screen"];
    st.actors.forEach((a, i) => drawScreen(ctx, panelX(i), labels[i], a));
    const packY = INVITE_BOTTOM - 8 * 7;
    drawCursor(ctx, [[1.0, panelX(1) + 470, PANEL_Y + 700], [2.2, panelX(1) + 285, packY], [3.0, panelX(1) + 300, packY + 20], [4.0, panelX(1) + 470, PANEL_Y + 720]], [THEO_JOIN], lt, 4);
    drawCursor(ctx, [[3.4, panelX(2) + 90, PANEL_Y + 690], [4.7, panelX(2) + 285, packY]], [SAM_JOIN], lt, 4);
  },
};

// 3. Light up: Theo's screen. His cigarette comes out, is held sideways in the
// lighter's flame, catches and stands beside the pack; then Zoom opens.
const LIGHT_PACK = { cx: 420, bottom: 990, s: 15 };
const FLICK = 1.5;
/** Theo's cigarette catches FLICK + ~1.5s (the Scene's own timing); Zoom opens a beat after. */
const ZOOM_AT = 4.0;
const SAM_LIGHTS = 4.6;
const lightUp: Shot<{ a: Actor }> = {
  start: 10,
  end: 18,
  make: () => {
    const a = new Actor('theo', (t) => ({
      brk: lit(-2000, [MAYA(-2000), THEO(t >= FLICK ? FLICK * 1000 : null), SAM(t >= SAM_LIGHTS ? SAM_LIGHTS * 1000 : null)]),
      bubble: t < FLICK ? 'Light up?' : t >= ZOOM_AT - 0.3 && t < ZOOM_AT + 1.4 ? 'Opening Zoom' : null,
      flickAt: t >= FLICK ? FLICK * 1000 : null,
    }));
    a.preroll(1.5);
    return { a };
  },
  tick: (st) => st.a.step(DT),
  draw: (ctx, st, lt) => {
    typedLines(ctx, ['Two join. A lighter appears.', 'Light up and Zoom opens.'], 960, 170, 7, lt, 0.1, { cps: 45 });
    const { cx, bottom, s } = LIGHT_PACK;
    st.a.drawAt(ctx, cx, bottom, s);
    drawZoom(ctx, lt);
    const lx = cx + (S.LIGHTER_X + 5 - 25) * s;
    const ly = bottom - (S.MOUTH_Y + S.BODY_H - S.LIGHTER_BASE_Y + 8) * s;
    drawCursor(ctx, [[0.2, 860, 1060], [1.2, lx, ly], [1.7, lx + 10, ly + 10], [2.6, 900, 1120]], [FLICK], lt);
  },
};

function drawZoom(ctx: CanvasRenderingContext2D, lt: number) {
  const k = easeOut(clamp((lt - ZOOM_AT) / 0.45));
  if (k <= 0) return;
  const w = 900;
  const h = 560;
  const x = Math.round(lerp(VW + 40, 960, k));
  const y = 330;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(x + 12, y + 12, w, h);
  ctx.fillStyle = INK;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#2d8cff';
  ctx.fillRect(x + 6, y + 6, w - 12, 50);
  pixelText(ctx, 'Zoom  -  Smoke break', x + 28, y + 21, 4, '#ffffff', false);
  ctx.fillStyle = '#17151f';
  ctx.fillRect(x + 6, y + 62, w - 12, h - 68);
  const tiles: [string, string, number][] = [
    ['Maya', '#a82a35', ZOOM_AT + 0.5],
    ['Theo', '#244a9a', ZOOM_AT + 1.0],
    ['Sam', '#1f6b45', SAM_LIGHTS + 0.9],
  ];
  const tw = 270;
  const th = 300;
  tiles.forEach(([name, color, at], i) => {
    const a = clamp((lt - at) / 0.2);
    if (a <= 0) return;
    const tx = x + 30 + i * (tw + 15);
    const ty = y + 100;
    ctx.save();
    ctx.globalAlpha *= a;
    ctx.fillStyle = color;
    ctx.fillRect(tx, ty, tw, th);
    pixelText(ctx, name[0], tx + tw / 2 - 30, ty + th / 2 - 60, 20, PAPER);
    pixelText(ctx, name, tx + 14, ty + th - 34, 4, PAPER);
    ctx.restore();
  });
  // Toolbar.
  ctx.fillStyle = '#26232f';
  ctx.fillRect(x + 6, y + h - 80, w - 12, 74);
  ctx.fillStyle = '#e04a4a';
  ctx.fillRect(x + w - 140, y + h - 62, 110, 38);
  pixelText(ctx, 'Leave', x + w - 124, y + h - 53, 4, '#ffffff', false);
}

// 4. The cigarette is the timer.
const TIMER_PACK = { cx: 480, bottom: 950, s: 11 };
const BURN_FROM = 0.3;
/** The last minute burns slower so "Last drag!" can be read. */
const LAST_MIN = 2.3;
const BURN_TO = 2.9;
const OUT = 3.0;
const timer: Shot<{ a: Actor }> = {
  start: 18,
  end: 23,
  make: () => {
    const total = 12 * 60_000;
    const start = 11.5 * 60_000;
    const rem = (t: number) =>
      t < LAST_MIN
        ? lerp(start, 60_000, clamp((t - BURN_FROM) / (LAST_MIN - BURN_FROM)))
        : Math.max(0, lerp(60_000, 0, clamp((t - LAST_MIN) / (BURN_TO - LAST_MIN))));
    const litAt = 1;
    const endsAt = litAt + total;
    const ps = [MAYA(1), THEO(1), SAM(1)];
    const a = new Actor('theo', (t) => {
      const r = rem(t);
      const b = t < OUT ? lit(litAt, ps) : lit(litAt, ps, { phase: 'out', outReason: 'burned', outAt: endsAt });
      const clock = `${Math.floor(r / 60_000)}:${String(Math.floor((r % 60_000) / 1000)).padStart(2, '0')}`;
      return {
        brk: b,
        now: endsAt - r,
        bubble: t >= OUT ? "Break's over. Time to hop off Zoom" : r >= 60_000 ? `${clock} left. Click to stub out` : 'Last drag!',
      };
    });
    a.preroll(2.5);
    return { a };
  },
  tick: (st) => st.a.step(DT),
  draw: (ctx, st, lt) => {
    typedLines(ctx, ['The cigarette', 'is the timer.'], 960, 400, 12, lt, 0.1, { cps: 40 });
    if (lt > 0.8) monoText(ctx, '10 to 15 minutes. Your team picks.', 966, 640, 40, SOFT, clamp((lt - 0.8) / 0.3));
    const { cx: px, bottom, s } = TIMER_PACK;
    st.a.drawAt(ctx, px, bottom, s);
    // Hovering Theo's cigarette, the second one standing beside the pack.
    const cx = px + (S.PACK_X + S.PACK_W + 2 + 4 + 1 - (S.PACK_X + S.PACK_W / 2)) * s;
    const cy = bottom - 6 * s;
    drawCursor(ctx, [[0, cx + 60, cy + 200], [0.3, cx, cy], [2.8, cx, cy + 4], [3.5, cx + 260, cy + 300]], [], lt);
  },
};

// 5. Water: same break, Sam's screen shows a water cooler instead.
const WATER_X = [330, 1050];
const SAM_DRINKS = 1.0;
const water: Shot<{ actors: Actor[] }> = {
  start: 23,
  end: 27,
  make: () => {
    const b = (t: number) =>
      lit(-30_000, [MAYA(-30_000), THEO(-30_000), SAM(t >= SAM_DRINKS ? SAM_DRINKS * 1000 : null)]);
    const now = (t: number) => 2.5 * 60_000 + t * 1000;
    const theo = new Actor('theo', (t) => ({ brk: b(t), now: now(t), bubble: null }));
    const sam = new Actor(
      'sam',
      (t) => ({
        brk: b(t),
        now: now(t),
        bubble: t < SAM_DRINKS ? 'Drink up?' : null,
        flickAt: t >= SAM_DRINKS ? SAM_DRINKS * 1000 : null,
      }),
      'classic',
      'classic',
      'water',
    );
    theo.preroll(2);
    sam.preroll(2);
    return { actors: [theo, sam] };
  },
  tick: (st) => st.actors.forEach((a) => a.step(DT)),
  draw: (ctx, st, lt) => {
    typedLines(ctx, ['Not a smoker? Switch to water.'], VW / 2, 110, 7, lt, 0.1, { center: true, cps: 45 });
    if (lt > 0.9) {
      const line = 'Same break. Everyone picks their own style.';
      ctx.save();
      ctx.font = `600 36px ${MONO}`;
      const w = ctx.measureText(line).width;
      ctx.restore();
      monoText(ctx, line, VW / 2 - w / 2, 190, 36, SOFT, clamp((lt - 0.9) / 0.3));
    }
    drawScreen(ctx, WATER_X[0], "Theo's screen", st.actors[0]);
    drawScreen(ctx, WATER_X[1], "Sam's screen", st.actors[1]);
    // Sam fills a cup from the cooler.
    const ox = WATER_X[1] + PANEL_W / 2 - (S.PACK_X + S.PACK_W / 2) * 7;
    const oy = INVITE_BOTTOM - (S.MOUTH_Y + S.BODY_H) * 7;
    const cx = ox + (S.LIGHTER_X + 5) * 7;
    const cy = oy + (S.LIGHTER_BASE_Y - 8) * 7;
    drawCursor(ctx, [[0, WATER_X[1] + 500, PANEL_Y + 720], [0.75, cx, cy], [1.6, cx + 10, cy + 10], [2.4, WATER_X[1] + 520, PANEL_Y + 740]], [SAM_DRINKS], lt, 4);
  },
};

// 6. Skins: packs on the beat, lighters on the eighths.
const PACK_TILES = packSkinsFor('smoke').map((s) => packPreview(s, 1));
const PACKS_AT = 0.5;
const PACK_STEP = 0.5;
const LIGHTERS_AT = 3.75;
const LIGHTER_STEP = 0.25;
const skins: Shot<null> = {
  start: 27,
  end: 33,
  make: () => null,
  tick: () => {},
  draw: (ctx, _st, lt) => {
    typedLines(ctx, ['Pick your pack. And your lighter.'], VW / 2, 120, 7, lt, 0.1, { center: true, cps: 45 });
    ctx.imageSmoothingEnabled = false;
    const ps = 8;
    packSkinsFor('smoke').forEach((skin, i) => {
      const at = PACKS_AT + i * PACK_STEP;
      const k = clamp((lt - at) / 0.3);
      if (k <= 0) return;
      const sc = easeOutBack(k);
      const img = PACK_TILES[i];
      const cx = 240 + i * 240;
      const bottom = 520;
      const w = img.width * ps * sc;
      const h = img.height * ps * sc;
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(cx - 80, bottom + 6, 160, 8);
      ctx.drawImage(img, Math.round(cx - w / 2), Math.round(bottom - h), Math.round(w), Math.round(h));
      const name = skin.name;
      pixelText(ctx, name, cx - (textWidth(name.toUpperCase()) * 3) / 2, bottom + 34, 3, SOFT);
    });
    const ls = 8;
    LIGHTER_SKINS.forEach((skin, i) => {
      const at = LIGHTERS_AT + i * LIGHTER_STEP;
      const k = clamp((lt - at) / 0.3);
      if (k <= 0) return;
      const c = lighterTile;
      const cctx = c.getContext('2d')!;
      cctx.clearRect(0, 0, c.width, c.height);
      S.drawLighter(new S.Pen(cctx), 0, 20, 'flame', Math.floor(lt * 8 + i), skin);
      const sc = easeOutBack(k);
      const cx = 250 + i * 203;
      const bottom = 870;
      const w = c.width * ls * sc;
      const h = c.height * ls * sc;
      ctx.drawImage(c, Math.round(cx - w / 2), Math.round(bottom - h), Math.round(w), Math.round(h));
      pixelText(ctx, skin.name, cx - (textWidth(skin.name.toUpperCase()) * 3) / 2, bottom + 30, 3, SOFT);
    });
  },
};
const lighterTile = offscreen(8, 21);

// 7. Outro.
const outro: Shot<{ a: Actor }> = {
  start: 33,
  end: 36,
  make: () => {
    const a = new Actor('viewer', () => ({
      brk: lit(1, [MAYA(1), THEO(1), SAM(1)]),
      now: 4 * 60_000,
      bubble: null,
    }));
    a.preroll(3);
    return { a };
  },
  tick: (st) => st.a.step(DT),
  draw: (ctx, st, lt) => {
    st.a.drawAt(ctx, 440, 900, 12);
    const k = clamp(lt / 0.35);
    const s = 18;
    ctx.save();
    ctx.globalAlpha *= k;
    pixelText(ctx, 'Smoke Break', 900, 450 + Math.round((1 - easeOut(k)) * 20), s, RED);
    ctx.restore();
    if (lt > 0.4) monoText(ctx, 'Lives in your menu bar.', 906, 590, 46, PAPER, clamp((lt - 0.4) / 0.3));
    if (lt > 0.8) monoText(ctx, 'A Mac desktop app for teams.', 906, 660, 46, SOFT, clamp((lt - 0.8) / 0.3));
  },
};

const SHOTS: Shot[] = [hook, invite, lightUp, timer, water, skins, outro];

// ── Engine ──────────────────────────────────────────────────────────────────

const view = document.getElementById('v') as HTMLCanvasElement;
const vctx = view.getContext('2d')!;
let last = -1;
let states = new Map<Shot, unknown>();

function reset() {
  seed = 1;
  states = new Map();
  last = -1;
}

function stepTo(f: number) {
  const t = f / FPS;
  const shot = SHOTS.find((s) => t >= s.start && t < s.end) ?? SHOTS[SHOTS.length - 1];
  if (!states.has(shot)) states.set(shot, shot.make());
  shot.tick(states.get(shot), t - shot.start);
  return shot;
}

function render(f: number) {
  if (f <= last) reset();
  let shot: Shot = SHOTS[0];
  for (let g = last + 1; g <= f; g++) shot = stepTo(g);
  last = f;
  const t = f / FPS;
  const lt = t - shot.start;
  const dur = shot.end - shot.start;
  vctx.imageSmoothingEnabled = false;
  vctx.drawImage(bg, 0, 0);
  // Dip through the background between shots: old content out, new content in.
  const fadeIn = shot === SHOTS[0] ? 1 : clamp(lt / 0.2);
  const fadeOut = shot === SHOTS[SHOTS.length - 1] ? 1 : clamp((dur - lt) / 0.17);
  vctx.save();
  vctx.globalAlpha = Math.min(fadeIn, fadeOut);
  vctx.translate(0, Math.round((1 - easeOut(fadeIn)) * 16));
  shot.draw(vctx, states.get(shot), lt);
  vctx.restore();
}

declare global {
  interface Window {
    renderFrame: (f: number) => string;
    drawFrame: (f: number) => void;
    TOTAL: number;
    ready: boolean;
  }
}

window.TOTAL = TOTAL;
window.drawFrame = (f) => render(f);
window.renderFrame = (f) => {
  render(f);
  return view.toDataURL('image/png');
};
document.fonts.ready.then(() => {
  window.ready = true;
});
