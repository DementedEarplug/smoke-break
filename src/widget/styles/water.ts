// Water break: a water cooler whose jug drains as the timer. Everyone's cup sits
// in the cooler's nook, and filling yours is lighting up.

import { ADVANCE } from '../font.ts';
import { type Drink, type LighterSkin, type Liquid, type PackSkin, WATER } from '../skins.ts';
import {
  BODY_H,
  CIG_W,
  FLAME_FRAMES,
  type FlameState,
  K,
  LIGHTER_BASE_Y,
  LIGHTER_X,
  MOUTH_Y,
  PACK_W,
  PACK_X,
  Pen,
  drawGlyphs,
} from '../sprites.ts';
import {
  type BreakStyle,
  type Item,
  type Rect,
  type SceneView,
  type StyleModule,
  type Tool,
  approach,
  easeOutBack,
  flickFlame,
} from './style.ts';

const AIR = '#e6f4fc';
const AIR_LIGHT = '#ffffff';
const AIR_SHADE = '#b8d4e4';
const PAPER_CUP: [string, string, string] = ['#ffffff', '#e8eef4', '#b8c4d0'];
const RECESS = '#2a2838';

class Water implements BreakStyle {
  readonly top = JUG_TOP;
  readonly puffColors: string[] = [];
  readonly travels = false;
  /** Water left in the cooler's jug; refills once a break is over. */
  private jugLevel = 1;

  get settled() {
    return this.jugLevel === 1;
  }

  // Cups have to fit the water cooler's nook, which is narrower than the pack.
  layout(n: number) {
    const spacing = n <= 4 ? 4 : 3;
    return { start: Math.round(PACK_X + PACK_W / 2 - ((n - 1) * spacing + CIG_W) / 2), spacing };
  }

  stand(): [number, number] {
    return [0, 0];
  }

  animate(v: Item, _mine: boolean, _view: SceneView, dt: number) {
    v.appear = approach(v.appear, 1, dt * 5);
    if (v.appear >= 1 && v.out <= 0) v.rise = approach(v.rise, v.wantRise, dt * 1.6);
  }

  caught(v: Item) {
    return v.rise >= 1;
  }

  burst() {}

  update(view: SceneView, breakOn: boolean, dt: number) {
    this.jugLevel = approach(this.jugLevel, breakOn ? view.burnFrac : 1, dt * 0.8);
  }

  /** The jug drains as the timer and each person's cup sits in the nook. */
  draw(view: SceneView, packPen: Pen, pen: Pen, skin: PackSkin) {
    const { ctx } = pen;
    const lit = view.phase === 'lit' && view.items.size > 0;
    drawCooler(packPen, view.oy, skin, this.jugLevel, view.t, lit);
    const bottom = NOOK.tray - 1 + view.oy;
    ctx.save();
    ctx.beginPath();
    ctx.rect(NOOK.x, NOOK.top + 2 + view.oy, NOOK.w, NOOK.tray - NOOK.top - 2);
    ctx.clip();
    for (const v of view.items.values()) {
      // Cups slide up onto the tray when someone joins and drop away when they leave.
      const gone = v.removing === 'stub' ? v.stub : 0;
      const drop = Math.round((1 - easeOutBack(v.appear)) * 5 + gone * 5);
      const x = Math.round(v.x);
      drawPaperCup(pen, x, bottom + drop, v.lit && !v.removing ? 1 : v.rise, skin.drink);
      view.hitItem({ x: x - 1, y: bottom - 4, w: CIG_W + 2, h: 6 }, v.id);
    }
    ctx.restore();
  }

  drawTool(view: SceneView, pen: Pen, tool: Tool): Rect {
    const flame = flickFlame(tool.since);
    const x = LIGHTER_X;
    const base = LIGHTER_BASE_Y + Math.round((1 - easeOutBack(view.lighterShow)) * 22);
    const frame = flame === 'none' ? Math.floor(view.t * 2) : Math.floor(view.t * 12);
    drawCup(pen, x, base, flame, frame, tool.skin, tool.pack.drink?.liquid ?? WATER);
    return { x: x - 1, y: base - 20, w: 10, h: 21 };
  }

  body(oy: number): Rect {
    return { x: COOLER_X, y: JUG_TOP + oy, w: COOLER_W, h: MOUTH_Y + BODY_H - JUG_TOP };
  }
}

// ── Art ─────────────────────────────────────────────────────────────────────

/** Cooler cabinet: narrower than the pack and a little taller. */
const COOLER_X = PACK_X + 2;
const COOLER_W = PACK_W - 4;
const CABINET_TOP = MOUTH_Y - 2;
/** Top row of the upside-down jug. */
const JUG_TOP = MOUTH_Y - 25;
const JUG_NECK_BOTTOM = CABINET_TOP - 1;
/** Dispenser nook where the team's cups sit, and the tray row they stand on. */
const NOOK = { x: COOLER_X + 1, w: COOLER_W - 2, top: CABINET_TOP + 3, tray: CABINET_TOP + 10 };

/** Left/right columns of the jug outline on a given row (relative to JUG_TOP). */
function jugSpan(r: number): [number, number] {
  const L = COOLER_X + 1;
  const R = COOLER_X + COOLER_W - 2;
  const neck = JUG_NECK_BOTTOM - JUG_TOP - 1;
  if (r === 0) return [L + 2, R - 2];
  if (r === 1) return [L + 1, R - 1];
  if (r >= neck) return [L + 5, R - 5];
  if (r === neck - 1) return [L + 3, R - 3];
  if (r === neck - 2) return [L + 2, R - 2];
  if (r === neck - 3) return [L + 1, R - 1];
  return [L, R];
}

/**
 * Upside-down jug on a cabinet. `level` (0–1) is the water left in the jug; it
 * drains as the break's timer. `glug` sends bubbles up through the water.
 */
function drawCooler(pen: Pen, oy: number, skin: PackSkin, level: number, t: number, glug: boolean) {
  const liq = skin.drink?.liquid ?? WATER;
  // Jug.
  const rows = JUG_NECK_BOTTOM - JUG_TOP + 1;
  const inner = rows - 1;
  const waterTop = JUG_TOP + 1 + Math.round(inner * (1 - Math.min(1, Math.max(0, level))));
  for (let r = 0; r < rows; r++) {
    const y = JUG_TOP + r + oy;
    const [x0, x1] = jugSpan(r);
    if (r === 0) {
      pen.rect(x0, y, x1 - x0 + 1, 1, K);
      continue;
    }
    pen.px(x0, y, K);
    pen.px(x1, y, K);
    const wet = JUG_TOP + r >= waterTop && level > 0;
    const ridge = r === 8 || r === 14;
    for (let x = x0 + 1; x < x1; x++) {
      let c: string;
      if (wet) c = JUG_TOP + r === waterTop ? liq.surface : x === x0 + 1 ? liq.light : x === x1 - 1 ? liq.dark : liq.main;
      else c = x === x0 + 1 ? AIR_LIGHT : x === x1 - 1 ? AIR_SHADE : AIR;
      if (ridge && x > x0 + 1 && x < x1 - 1) c = wet ? liq.dark : AIR_SHADE;
      pen.px(x, y, c);
    }
  }
  if (glug && level > 0) {
    const span = JUG_NECK_BOTTOM - waterTop;
    for (let i = 0; i < 3; i++) {
      const k = (t * 0.7 + i * 0.37) % 1;
      const y = Math.round(JUG_NECK_BOTTOM - k * span);
      if (y <= waterTop) continue;
      const [x0, x1] = jugSpan(y - JUG_TOP);
      const x = x0 + 2 + ((i * 5 + Math.floor(t * 1.5 + i)) % Math.max(1, x1 - x0 - 3));
      pen.px(x, y + oy, liq.surface);
    }
  }
  // Fruit bobbing just under the surface, riding it down as the jug drains.
  if (skin.drink && level > 0) {
    skin.drink.fruit.forEach(([color, shine], i) => {
      const y = waterTop + 1 + [0, 2, 1][i % 3] + (Math.floor(t * 1.5 + i * 0.7) % 2);
      if (y + 1 >= JUG_NECK_BOTTOM) return;
      const x = COOLER_X + 4 + i * 4;
      const [l, r] = jugSpan(y + 1 - JUG_TOP);
      if (x <= l + 1 || x + 1 >= r - 1) return;
      pen.rect(x, y + oy, 2, 2, color);
      pen.px(x, y + oy, shine);
    });
  }

  // Cabinet, colored by the pack skin.
  const x0 = COOLER_X;
  const x1 = COOLER_X + COOLER_W - 1;
  const bottom = MOUTH_Y + BODY_H - 1;
  for (let y = CABINET_TOP; y <= bottom; y++) {
    for (let x = x0; x <= x1; x++) {
      const yy = y + oy;
      if (y === CABINET_TOP || y === bottom || x === x0 || x === x1) {
        pen.px(x, yy, K);
        continue;
      }
      const top = y < NOOK.top;
      if (top) pen.px(x, yy, x === x0 + 1 ? skin.mainLight : x === x1 - 1 ? skin.mainDark : skin.main);
      else if (y < NOOK.tray) pen.px(x, yy, RECESS);
      else if (y === NOOK.tray) pen.px(x, yy, x % 2 ? '#8a8a98' : '#5a5a68');
      else if (y === NOOK.tray + 1) pen.px(x, yy, skin.trim);
      else pen.px(x, yy, x === x1 - 1 ? skin.baseShade : y === bottom - 1 ? skin.baseBottom : skin.base);
    }
  }
  // Hot and cold taps over the nook.
  const tapY = NOOK.top + oy;
  for (const [tx, color] of [
    [x0 + 5, '#4a90ff'],
    [x1 - 6, '#ff5a5a'],
  ] as const) {
    pen.rect(tx, tapY, 2, 1, '#c8c8d4');
    pen.px(tx, tapY + 1, color);
    pen.px(tx + 1, tapY + 1, '#8a8a98');
  }
  const textW = skin.monogram.length * ADVANCE - 1;
  drawGlyphs(pen, skin.monogram, x0 + Math.floor((COOLER_W - textW) / 2), NOOK.tray + 3 + oy, skin.label);
}

/** A teammate's cup in the cooler's nook. `fill` 0–1 animates filling up. */
function drawPaperCup(pen: Pen, x: number, bottom: number, fill: number, drink?: Drink) {
  const liq = drink?.liquid ?? WATER;
  const cup = drink?.cup ?? PAPER_CUP;
  // Rim (the drink shows from above once it's full), body, narrow base.
  for (let c = 0; c < CIG_W; c++) pen.px(x + c, bottom - 3, fill >= 1 ? (c === 0 ? liq.light : liq.main) : fill > 0 ? liq.surface : cup[1]);
  for (let r = 2; r >= 1; r--) for (let c = 0; c < CIG_W; c++) pen.px(x + c, bottom - r, cup[c]);
  pen.px(x + 1, bottom, cup[1]);
}

/**
 * Water-break stand-in for the lighter: a cup in the lighter's skin colors.
 * While waiting a drip falls into it; clicked, water pours in and splashes.
 */
function drawCup(pen: Pen, x: number, baseY: number, flame: FlameState, frame: number, skin: LighterSkin, liq: Liquid) {
  const splash = { o: liq.main, y: liq.light, W: '#ffffff', b: liq.dark };
  const h = 11;
  const top = baseY - h + 1;
  for (let i = 0; i < h; i++) {
    const y = top + i;
    const inset = Math.floor(i / 5);
    const l = x + inset;
    const r = x + 7 - inset;
    if (i === 0 || i === h - 1) {
      pen.rect(l, y, r - l + 1, 1, K);
      continue;
    }
    pen.px(l, y, K);
    pen.px(r, y, K);
    for (let cx = l + 1; cx < r; cx++) {
      let c: string;
      if (i === 1) c = flame === 'flame' ? (cx === l + 1 ? liq.light : liq.main) : '#3a3848';
      else if (skin.stripes) c = skin.stripes[Math.min(skin.stripes.length - 1, i - 1)];
      else c = cx === l + 1 ? skin.light : cx === r - 1 ? skin.shade : skin.body;
      if (i === 5 || i === 6) c = i === 5 ? skin.accent : c;
      pen.px(cx, y, c);
    }
  }
  if (flame === 'none') {
    // A drip from above, hinting that the cup wants filling.
    const dy = frame % 2 === 0 ? 0 : 2;
    pen.px(x + 4, top - 5 + dy, liq.light);
    pen.px(x + 4, top - 4 + dy, liq.main);
  } else if (flame === 'spark') {
    pen.px(x + 3, top - 2, liq.light);
    pen.px(x + 5, top - 3, liq.light);
  } else {
    // Stream pouring in from above, with a splash at the rim.
    for (let y = top - 8; y < top; y++) pen.px(x + 4, y, (y + frame) % 3 ? liq.main : liq.light);
    FLAME_FRAMES[frame % 2].forEach((row, ry) => {
      if (ry > 2) return;
      for (let rx = 0; rx < 3; rx++) {
        const ch = row[rx] as keyof typeof splash | '.';
        if (ch !== '.') pen.px(x + 1 + rx * 2, top - 3 + ry, splash[ch]);
      }
    });
  }
}

export const water: StyleModule = {
  create: () => new Water(),
  previewBox: { x: COOLER_X, y: JUG_TOP, w: COOLER_W, h: MOUTH_Y + BODY_H - JUG_TOP },
  drawPreview: (pen, skin) => drawCooler(pen, 0, skin, 1, 0, false),
  drawToolPreview: (pen, skin, pack) => drawCup(pen, 0, 20, 'flame', 0, skin, pack.drink?.liquid ?? WATER),
};
