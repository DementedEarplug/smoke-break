// Pixel-art sprites, drawn procedurally onto a low-res canvas that CSS scales
// up with `image-rendering: pixelated`. All coordinates are in art pixels.

import { ADVANCE, glyphBits } from './font.ts';
import { type LighterSkin, type PackSkin, LIGHTER_SKINS, PACK_SKINS } from './skins.ts';

/** Logical canvas size. */
export const W = 64;
export const H = 84;

export const PACK_X = 14;
export const PACK_W = 22;
/** Top row of the pack's front body; cigarettes rise out above this line. */
export const MOUTH_Y = 62;
export const BODY_H = 18;
export const LID_H = 6;

export const FILTER_LEN = 6;
/** Rows of a fully slid-out cigarette that stay tucked inside the pack. */
export const BURIED = 3;
export const CIG_W = 3;

export const LIGHTER_X = 41;
export const LIGHTER_BASE_Y = 79;

export const K = '#1a1020';

const PAPER = ['#ffffff', '#efe9dc', '#c4bcae'];
const TOBACCO = ['#b07a3e', '#8a5a2a', '#6a4220'];
const EMBER = ['#ffb040', '#fff0a0', '#ff5a1a'];
const EMBER_DIM = ['#d04a1a', '#ff8a30', '#902010'];
const EMBER_DEAD = ['#5a5a5a', '#3a3a3a', '#2a2a2a'];
const ASH = ['#d0d0d0', '#b0b0b4', '#8a8a90'];
const FILTER = ['#f0b060', '#d8903a', '#a8682a'];
const FILTER_SPOT = '#c47a30';
const BAND = ['#f8e08a', '#e8c860', '#b89838'];

export const SMOKE = ['#f2f2f8', '#d4d4e0', '#b0b0c4', '#8c8ca4'];

/** Pixel pen with an optional color remap (used to grey out the pack in do-not-disturb). */
export class Pen {
  // Plain fields (no parameter properties) so Node can run this file for scripts/make-icons.ts.
  readonly ctx: CanvasRenderingContext2D;
  tint: ((c: string) => string) | null;

  constructor(ctx: CanvasRenderingContext2D, tint: ((c: string) => string) | null = null) {
    this.ctx = ctx;
    this.tint = tint;
  }

  px(x: number, y: number, c: string) {
    this.ctx.fillStyle = this.tint ? this.tint(c) : c;
    this.ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
  }

  rect(x: number, y: number, w: number, h: number, c: string) {
    this.ctx.fillStyle = this.tint ? this.tint(c) : c;
    this.ctx.fillRect(Math.round(x), Math.round(y), w, h);
  }
}

const greyCache = new Map<string, string>();
/** Desaturate toward a cool grey. */
export function greyTint(c: string): string {
  let out = greyCache.get(c);
  if (!out) {
    const n = parseInt(c.slice(1), 16);
    const l = 0.3 * (n >> 16) + 0.59 * ((n >> 8) & 255) + 0.11 * (n & 255);
    const v = Math.round(l * 0.75 + 40);
    out = `rgb(${v},${v},${Math.min(255, v + 14)})`;
    greyCache.set(c, out);
  }
  return out;
}

// ── Pack ────────────────────────────────────────────────────────────────────

/** Open lid behind the cigarettes. `flap` is 0 (closed) → 1 (open). */
export function drawPackBack(pen: Pen, flap: number, oy: number, skin: PackSkin = PACK_SKINS[0]) {
  if (flap < 0.34) return;
  const lidH = flap < 0.67 ? 3 : 5;
  const top = MOUTH_Y - lidH + oy;
  const x0 = PACK_X + 1;
  const w = PACK_W - 2;
  pen.rect(x0, top, w, lidH, '#d9b77a');
  pen.rect(x0, top, w, 1, K);
  pen.rect(x0 + 1, top + 1, w - 2, 1, skin.main);
  pen.rect(x0, top, 1, lidH, K);
  pen.rect(x0 + w - 1, top, 1, lidH, K);
  // Foil lining just inside the mouth.
  pen.rect(x0 + 1, MOUTH_Y - 1 + oy, w - 2, 1, '#c9c9d4');
  pen.px(x0 + 2, MOUTH_Y - 1 + oy, '#f4f4fa');
  pen.px(x0 + 6, MOUTH_Y - 1 + oy, '#f4f4fa');
}

export function drawPackFront(pen: Pen, flap: number, oy: number, skin: PackSkin = PACK_SKINS[0]) {
  const closed = flap < 0.34;
  if (closed) {
    const top = MOUTH_Y - LID_H + oy;
    pen.rect(PACK_X, top, PACK_W, LID_H, skin.main);
    pen.rect(PACK_X + 1, top, PACK_W - 2, 1, K);
    pen.rect(PACK_X, top + 1, 1, LID_H - 1, K);
    pen.rect(PACK_X + PACK_W - 1, top + 1, 1, LID_H - 1, K);
    pen.rect(PACK_X + 2, top + 1, 6, 1, skin.mainLight);
    pen.rect(PACK_X + PACK_W - 2, top + 1, 1, LID_H - 1, skin.mainDark);
  }

  for (let r = 0; r < BODY_H; r++) {
    for (let c = 0; c < PACK_W; c++) {
      const x = PACK_X + c;
      const y = MOUTH_Y + r + oy;
      if (c === 0 || c === PACK_W - 1 || r === BODY_H - 1) {
        pen.px(x, y, K);
        continue;
      }
      if (r === 0) {
        pen.px(x, y, closed ? skin.crease : K);
        continue;
      }
      pen.px(x, y, packBodyColor(skin, r, c));
    }
  }
  const textW = skin.monogram.length * ADVANCE - 1;
  drawGlyphs(pen, skin.monogram, PACK_X + Math.floor((PACK_W - textW) / 2), MOUTH_Y + 11 + oy, skin.label);
}

function packBodyColor(skin: PackSkin, r: number, c: number): string {
  const main = c === 1 ? skin.mainLight : c === PACK_W - 2 ? skin.mainDark : skin.main;
  const base = c === PACK_W - 2 ? skin.baseShade : r === BODY_H - 2 ? skin.baseBottom : skin.base;
  if (skin.style === 'solid') {
    // Framed label box around the monogram.
    const inBox = r >= 9 && r <= BODY_H - 2 && c >= 5 && c <= 16;
    if (!inBox) return main;
    return r === 9 || r === BODY_H - 2 || c === 5 || c === 16 ? skin.trim : skin.base;
  }
  // Chevron: the colored top's lower edge peaks in the middle. Band: it's straight.
  const edge = skin.style === 'chevron' ? 4 + Math.floor(Math.abs(c - (PACK_W - 1) / 2) * 0.5) : 6;
  if (r < edge) return main;
  if (r === edge) return skin.trim;
  return base;
}

export function drawShadow(pen: Pen, spread: number) {
  const y = MOUTH_Y + BODY_H + 1;
  const half = Math.round(PACK_W / 2 - 1 + spread);
  const cx = PACK_X + PACK_W / 2;
  pen.rect(cx - half, y, half * 2, 1, 'rgba(0,0,0,0.22)');
  pen.rect(cx - half + 3, y + 1, half * 2 - 6, 1, 'rgba(0,0,0,0.14)');
}

// ── Cigarette ───────────────────────────────────────────────────────────────

export type TipState = 'unlit' | 'lit' | 'dim' | 'dead';

/** Color of row `i` (0 = top, ash first) and column `c` of a cigarette, or null for a gap. */
function cigCell(i: number, c: number, paperLen: number, tip: TipState, ashLen: number): string | null {
  if (i < ashLen) return i === 0 && ashLen > 1 && c !== 1 ? null : ASH[c]; // Ragged top on the ash.
  i -= ashLen;
  if (i < paperLen) {
    const pal = i > 0 ? PAPER : tip === 'unlit' ? TOBACCO : tip === 'lit' ? EMBER : tip === 'dim' ? EMBER_DIM : EMBER_DEAD;
    return pal[c];
  }
  i -= paperLen;
  if (i === 0) return BAND[c];
  return c < 2 && (i + c) % 3 === 0 ? FILTER_SPOT : FILTER[c];
}

export const cigLength = (paperLen: number, ashLen: number) => ashLen + paperLen + FILTER_LEN;

/**
 * Draws a vertical cigarette whose top (including ash) is at `top`.
 * `paperLen` counts the tip row; at 0 only the filter is left.
 */
export function drawCig(pen: Pen, x: number, top: number, paperLen: number, tip: TipState, ashLen: number) {
  const total = cigLength(paperLen, ashLen);
  for (let i = 0; i < total; i++) {
    for (let c = 0; c < CIG_W; c++) {
      const color = cigCell(i, c, paperLen, tip, ashLen);
      if (color) pen.px(x + c, top + i, color);
    }
  }
}

/**
 * A cigarette turned `angle` radians clockwise from upright (π/2 points the tip
 * right), centered on (cx, cy). Sampled at half pixels so diagonals stay solid.
 */
export function drawCigTurned(
  pen: Pen,
  cx: number,
  cy: number,
  paperLen: number,
  tip: TipState,
  ashLen: number,
  angle: number,
) {
  const total = cigLength(paperLen, ashLen);
  const dx = Math.sin(angle);
  const dy = -Math.cos(angle);
  for (let i = 0; i < total; i += 0.5) {
    for (let c = 0; c < CIG_W; c += 0.5) {
      const color = cigCell(Math.floor(i), Math.floor(c), paperLen, tip, ashLen);
      if (!color) continue;
      const along = (total - 1) / 2 - i;
      const across = c - (CIG_W - 1) / 2;
      pen.px(Math.round(cx + along * dx - across * dy), Math.round(cy + along * dy + across * dx), color);
    }
  }
}

// ── Lighter ─────────────────────────────────────────────────────────────────

export const FLAME_FRAMES = [
  ['.o.', '.yo', 'oyo', 'oWy', '.b.'],
  ['o..', '.o.', 'oyo', 'yWo', '.b.'],
];

export type FlameState = 'none' | 'spark' | 'flame';

/** 8×15 lighter standing on `baseY`. */
export function drawLighter(
  pen: Pen,
  x: number,
  baseY: number,
  flame: FlameState,
  frame: number,
  skin: LighterSkin = LIGHTER_SKINS[0],
) {
  const capTop = baseY - 14;
  // Body.
  pen.rect(x, baseY - 10, 8, 11, K);
  if (skin.stripes) {
    skin.stripes.forEach((c, i) => pen.rect(x + 1, baseY - 10 + i, 6, 1, c));
  } else {
    pen.rect(x + 1, baseY - 10, 6, 10, skin.body);
    pen.rect(x + 1, baseY - 10, 1, 10, skin.light);
    pen.rect(x + 6, baseY - 10, 1, 10, skin.shade);
  }
  pen.rect(x + 2, baseY - 4, 4, 2, skin.accent);
  // Metal cap with vent holes.
  pen.rect(x, capTop, 8, 4, K);
  pen.rect(x + 1, capTop + 1, 6, 3, skin.cap);
  pen.rect(x + 6, capTop + 1, 1, 3, skin.capShade);
  pen.px(x + 4, capTop + 2, '#5a5a68');
  pen.px(x + 6, capTop + 2, '#5a5a68');
  // Striker wheel.
  const spin = frame % 2 === 0;
  pen.rect(x + 1, capTop - 1, 2, 2, spin ? '#707080' : '#a0a0b0');
  pen.px(x + 1, capTop - 1, spin ? '#a0a0b0' : '#707080');

  if (flame === 'spark') {
    const sparks = [
      [3, -2],
      [5, -3],
      [2, -4],
      [6, -2],
    ];
    for (let i = 0; i < 2; i++) {
      const [sx, sy] = sparks[(frame + i * 2) % sparks.length];
      pen.px(x + sx, capTop + sy, skin.flame.core);
    }
  } else if (flame === 'flame') {
    const colors: Record<string, string> = {
      o: skin.flame.outer,
      y: skin.flame.mid,
      W: skin.flame.core,
      b: skin.flame.base,
    };
    FLAME_FRAMES[frame % 2].forEach((row, ry) => {
      for (let rx = 0; rx < 3; rx++) {
        const ch = row[rx];
        if (ch !== '.') pen.px(x + 4 + rx - 1, capTop - 5 + ry, colors[ch]);
      }
    });
  }
}

// ── Smoke & bits ────────────────────────────────────────────────────────────

export function drawPuff(pen: Pen, x: number, y: number, size: number, color: string) {
  x = Math.round(x);
  y = Math.round(y);
  if (size <= 1) pen.px(x, y, color);
  else if (size === 2) pen.rect(x, y, 2, 2, color);
  else {
    pen.rect(x - 1, y, 3, 1, color);
    pen.rect(x, y - 1, 1, 3, color);
  }
}

export function drawGlyphs(pen: Pen, text: string, x: number, y: number, color: string) {
  let cx = x;
  for (const ch of text) {
    const g = glyphBits(ch);
    for (let i = 0; i < 15; i++) if (g[i] === '1') pen.px(cx + (i % 3), y + Math.floor(i / 3), color);
    cx += ADVANCE;
  }
}
