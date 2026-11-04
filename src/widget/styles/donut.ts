// Donut break: a bakery box of donuts. Joining pops yours up; lighting up lifts
// it out and tips the sprinkle shaker over it, then it sits beside the box,
// where it gets eaten bite by bite as the timer.

import type { LighterSkin, PackSkin } from '../skins.ts';
import { ADVANCE } from '../font.ts';
import { BODY_H, K, LIGHTER_BASE_Y, LIGHTER_X, MOUTH_Y, PACK_W, PACK_X, Pen, W, drawGlyphs, drawRotated } from '../sprites.ts';
import {
  type BreakStyle,
  type Item,
  type Rect,
  type SceneView,
  type StyleModule,
  type Tool,
  approach,
  easeInOut,
  easeOutBack,
} from './style.ts';

const GROUND = MOUTH_Y + BODY_H;
const X0 = PACK_X;
const X1 = PACK_X + PACK_W - 1;
/** Top edge of the open box; donuts peek out above it. */
const BOX_TOP = GROUND - 14;
const LID_H = 4;

// Donuts: 9×7, seen from the front.
const DONUT_W = 9;
const DONUT_H = 7;
const DONUT = ['..FFFFF..', '.FhFFFFF.', 'FhFF.FFFF', 'DFF...FDD', 'DDDD.DDDD', '.DDDDDDD.', '..sssss..'];
const HOLE = { c: 4, r: 3 };
const DOUGH = { D: '#e0a050', s: '#b07830' };
const FROSTINGS: [string, string][] = [
  ['#ff7ab0', '#ffc0dc'],
  ['#6a3a1a', '#9a6a40'],
  ['#fff0c8', '#ffffff'],
  ['#7ac8ff', '#c8ecff'],
  ['#b07ae8', '#dcc0ff'],
];
const SPRINKLES = ['#ff4a4a', '#4ad0ff', '#ffe040', '#6ae06a', '#ffffff', '#ff8ad0'];
/** Where sprinkles land on the frosting, in the order they appear. */
const SPRINKLE_AT: [number, number][] = [
  [3, 0],
  [6, 1],
  [2, 2],
  [7, 2],
  [4, 1],
  [6, 3],
  [5, 0],
];
const CRUMB = '#d09040';
/** Peeking out of the box. */
const POP_H = 3;
/** Where my donut is held up to be sprinkled. */
const HOLD = { x: X0 + Math.floor((PACK_W - DONUT_W) / 2), top: BOX_TOP - 22 };
/** Lit donuts sit in a little pyramid on the ground to the right of the box. */
const STAND_X = X1 + 3;

// The sprinkle shaker: 6×12, cap on top.
const SHAKER_W = 6;
const SHAKER_H = 12;
const SHAKER_REST = { cx: LIGHTER_X + 1 + (SHAKER_W - 1) / 2, cy: LIGHTER_BASE_Y - (SHAKER_H - 1) / 2 };

interface Pose {
  x: number;
  top: number;
  inBox: boolean;
}

/** Same frosting for the same person on everyone's screen. */
function frostingOf(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return FROSTINGS[Math.abs(h) % FROSTINGS.length];
}

class Donut implements BreakStyle {
  readonly top = BOX_TOP - LID_H;
  readonly puffColors: string[] = [];
  readonly travels = true;
  readonly settled = true;

  layout(n: number) {
    const spacing = n <= 2 ? DONUT_W : Math.max(2, Math.floor((PACK_W - 2 - DONUT_W) / (n - 1)));
    return { start: Math.round(X0 + PACK_W / 2 - ((n - 1) * spacing + DONUT_W) / 2), spacing };
  }

  stand(slot: number): [number, number] {
    // Rows of three, then two on top offset by half, and so on.
    let row = 0;
    let i = slot;
    while (i >= (row % 2 ? 2 : 3)) {
      i -= row % 2 ? 2 : 3;
      row++;
    }
    return [STAND_X + i * (DONUT_W - 1) + (row % 2 ? 4 : 0), GROUND - row * (DONUT_H - 1)];
  }

  animate(v: Item, mine: boolean, view: SceneView, dt: number) {
    v.appear = approach(v.appear, 1, dt * 5);
    if (v.appear >= 1 && v.out <= 0) v.rise = approach(v.rise, v.wantRise, dt * 2.4);
    if (mine && !v.lit) {
      v.turn = approach(v.turn, v.wantRise && v.rise >= 1 ? 1 : 0, dt * 2.2);
      if (v.turn >= 1 && view.lighterLift >= 0.95) v.ignite = approach(v.ignite, 1, dt * 1.2);
    } else {
      v.out = approach(v.out, v.wantRise && v.rise >= 1 ? 1 : 0, dt * (v.turn > 0 ? 1.8 : 2.2));
      if (!v.lit && v.out >= 1) v.ignite = 1;
    }
  }

  caught(v: Item) {
    return v.ignite >= 1;
  }

  burst(v: Item, view: SceneView) {
    const { x, top } = this.pose(v, view);
    if (v.removing) {
      for (let i = 0; i < 4; i++) view.bit(x + 1 + i * 1.5, top + 2, (Math.random() - 0.5) * 8, CRUMB);
    } else {
      for (let i = 0; i < 3; i++) view.bit(x + 1 + i * 2, top - 1, (Math.random() - 0.5) * 6, SPRINKLES[i * 2]);
    }
  }

  update() {}

  /** How much has been eaten, 0–1. */
  private bitten(v: Item, view: SceneView) {
    if (!v.lit) return 0;
    const eaten = view.litAt === null ? 0 : 1 - view.burnFrac;
    return v.removing === 'stub' ? eaten + (1 - eaten) * v.stub : eaten;
  }

  private pose(v: Item, view: SceneView): Pose {
    if (v.out <= 0 && v.turn <= 0) {
      // In the box: peeks up when joining, then lifts all the way out to be lit.
      const visible = easeOutBack(v.appear) * (POP_H + (DONUT_H + 1 - POP_H) * easeInOut(v.rise));
      return { x: Math.round(v.x), top: BOX_TOP + view.oy - Math.round(Math.max(0, visible)), inBox: true };
    }
    const pulled = { x: v.x, top: BOX_TOP + view.oy - DONUT_H - 1 };
    let from = pulled;
    let to = pulled;
    let k: number;
    if (v.out <= 0) {
      // Mine, held up over the box for the sprinkles.
      k = easeInOut(v.turn);
      to = HOLD;
    } else {
      // Hopping over to sit beside the box. Sinks into the ground when finished.
      k = v.out;
      from = v.turn > 0 ? HOLD : pulled;
      to = { x: v.standX, top: v.standY - DONUT_H };
    }
    const xk = 1 - (1 - k) ** 2;
    const yk = v.out > 0 ? k * k : k;
    const sink = v.out > 0 ? Math.round((1 - v.appear) * DONUT_H) : 0;
    return {
      x: Math.round(from.x + (to.x - from.x) * xk),
      top: Math.round(from.top + (to.top - from.top) * yk - Math.sin(Math.PI * k) * 5 + sink),
      inBox: false,
    };
  }

  draw(view: SceneView, packPen: Pen, pen: Pen, skin: PackSkin) {
    const { ctx } = pen;
    drawLidBack(packPen, view.flap, view.oy, skin);

    const poses: [Item, Pose][] = [];
    for (const v of view.items.values()) poses.push([v, this.pose(v, view)]);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, BOX_TOP + view.oy + 1);
    ctx.clip();
    for (const [v, g] of poses) if (g.inBox) this.drawOne(view, pen, v, g);
    ctx.restore();

    drawBox(packPen, view.flap, view.oy, skin);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, GROUND);
    ctx.clip();
    // Bottom rows first so the pyramid stacks.
    const out = poses.filter(([, g]) => !g.inBox).sort((a, b) => b[1].top - a[1].top);
    for (const [v, g] of out) this.drawOne(view, pen, v, g);
    ctx.restore();
  }

  private drawOne(view: SceneView, pen: Pen, v: Item, g: Pose) {
    const bitten = this.bitten(v, view);
    // A few crumbs fall with every bite.
    const bites = Math.floor(bitten * 12);
    if (v.lit && bites > v.lastAsh) {
      const a = bitten * Math.PI * 2;
      const cx = g.x + HOLE.c + Math.sin(a) * 4;
      const cy = g.top + HOLE.r - Math.cos(a) * 3;
      for (let i = 0; i < 2; i++) view.bit(cx + i, cy, (Math.random() - 0.5) * 6, CRUMB);
    }
    v.lastAsh = bites;
    drawDonut(pen, g.x, g.top, frostingOf(v.id), Math.round(v.ignite * SPRINKLE_AT.length), bitten, v.seed);
    view.hitItem({ x: g.x - 1, y: g.top - 1, w: DONUT_W + 2, h: g.inBox ? BOX_TOP + view.oy - g.top + 1 : DONUT_H + 2 }, v.id);
    if (bitten < 1) view.contentTop = Math.min(view.contentTop, g.top);
  }

  drawTool(view: SceneView, pen: Pen, tool: Tool): Rect {
    const lift = easeInOut(view.lighterLift);
    let cx = SHAKER_REST.cx;
    let cy = SHAKER_REST.cy + Math.round((1 - easeOutBack(view.lighterShow)) * 22);
    // Tips over, cap down, above my donut; wobbles while it's waiting.
    let angle = Math.PI * lift;
    if (lift > 0) {
      const tx = HOLD.x + (DONUT_W - 1) / 2;
      const ty = HOLD.top - 2 - SHAKER_H / 2;
      cx += (tx - cx) * lift;
      cy += (ty - cy) * lift - Math.sin(Math.PI * lift) * 6;
    } else if (!tool.lighting) {
      angle = Math.floor(view.t * 2) % 2 ? 0.15 : 0;
    }
    const shaking = !!tool.mine && tool.lighting && tool.mine.ignite > 0;
    if (shaking) {
      cx += Math.floor(view.t * 14) % 2 ? 1 : -1;
      if (Math.random() < 0.5) view.bit(cx + (Math.random() - 0.5) * 4, cy + SHAKER_H / 2, (Math.random() - 0.5) * 2, SPRINKLES[Math.floor(Math.random() * SPRINKLES.length)]);
    }
    drawRotated(pen, cx, cy, SHAKER_W, SHAKER_H, (c, r) => shakerCell(c, r, tool.skin), angle);
    return { x: Math.round(cx - SHAKER_W / 2) - 2, y: Math.round(cy - SHAKER_H / 2) - 1, w: SHAKER_W + 4, h: SHAKER_H + 2 };
  }

  body(oy: number): Rect {
    return { x: X0, y: BOX_TOP - LID_H + oy, w: PACK_W, h: GROUND - BOX_TOP + LID_H };
  }
}

// ── Art ─────────────────────────────────────────────────────────────────────

/** The open lid, standing up behind the donuts. */
function drawLidBack(pen: Pen, flap: number, oy: number, skin: PackSkin) {
  if (flap < 0.34) return;
  const h = flap < 0.67 ? 4 : 8;
  const top = BOX_TOP - h + oy;
  for (let y = top; y < BOX_TOP + oy; y++) {
    for (let x = X0 + 1; x < X1; x++) {
      const edge = y === top || x === X0 + 1 || x === X1 - 1;
      pen.px(x, y, edge ? K : y === top + 1 ? skin.main : '#f6ead0');
    }
  }
}

/** The box front, with its lid shut on top when there's no break. */
function drawBox(pen: Pen, flap: number, oy: number, skin: PackSkin) {
  const closed = flap < 0.34;
  if (closed) {
    const top = BOX_TOP - LID_H + oy;
    for (let y = top; y < BOX_TOP + oy; y++) {
      const inset = y === top ? 2 : 0;
      for (let x = X0 + inset; x <= X1 - inset; x++) {
        const edge = y === top || x === X0 || x === X1;
        pen.px(x, y, edge ? K : x === X0 + 1 ? skin.mainLight : x === X1 - 1 ? skin.mainDark : skin.main);
      }
    }
  }
  for (let y = BOX_TOP; y < GROUND; y++) {
    for (let x = X0; x <= X1; x++) {
      const yy = y + oy;
      if (x === X0 || x === X1 || y === GROUND - 1) {
        pen.px(x, yy, K);
        continue;
      }
      const r = y - BOX_TOP;
      let c: string;
      if (r === 0) c = closed ? skin.crease : K;
      else if (r < 4) c = x === X0 + 1 ? skin.mainLight : x === X1 - 1 ? skin.mainDark : skin.main;
      else if (r === 4) c = skin.trim;
      else c = x === X1 - 1 ? skin.baseShade : r === GROUND - BOX_TOP - 2 ? skin.baseBottom : skin.base;
      pen.px(x, yy, c);
    }
  }
  const textW = skin.monogram.length * ADVANCE - 1;
  drawGlyphs(pen, skin.monogram, X0 + Math.floor((PACK_W - textW) / 2), BOX_TOP + 6 + oy, skin.label);
}

function drawDonut(pen: Pen, x: number, top: number, [frost, shine]: [string, string], sprinkles: number, bitten: number, seed: number) {
  const sprinkled = new Map<string, string>();
  for (let i = 0; i < sprinkles; i++) {
    const [c, r] = SPRINKLE_AT[i];
    sprinkled.set(`${c},${r}`, SPRINKLES[(i + Math.floor(seed * SPRINKLES.length)) % SPRINKLES.length]);
  }
  for (let r = 0; r < DONUT_H; r++) {
    for (let c = 0; c < DONUT_W; c++) {
      const ch = DONUT[r][c];
      if (ch === '.') continue;
      // Eaten clockwise from the top.
      if (bitten > 0) {
        const a = Math.atan2(c - HOLE.c, -(r - HOLE.r));
        const turn = (a < 0 ? a + Math.PI * 2 : a) / (Math.PI * 2);
        if (turn < bitten || bitten >= 1) continue;
      }
      const color = sprinkled.get(`${c},${r}`) ?? (ch === 'F' ? frost : ch === 'h' ? shine : DOUGH[ch as 'D' | 's']);
      pen.px(x + c, top + r, color);
    }
  }
}

function shakerCell(c: number, r: number, skin: LighterSkin): string | null {
  const edge = c === 0 || c === SHAKER_W - 1;
  if (r === 0) return edge ? null : K;
  if (r <= 2) return edge ? K : r === 1 && c % 2 === 0 ? K : c === SHAKER_W - 2 ? skin.capShade : skin.cap;
  if (r === 3) return K;
  if (r === SHAKER_H - 1) return edge ? null : K;
  if (edge) return K;
  // A glass jar of sprinkles with a label band in the skin's colors.
  if (r === 6 || r === 7) return c === 1 ? skin.light : c === SHAKER_W - 2 ? skin.shade : skin.body;
  return SPRINKLES[(c * 3 + r * 5) % SPRINKLES.length];
}

export const donut: StyleModule = {
  create: () => new Donut(),
  previewBox: { x: X0, y: BOX_TOP - LID_H, w: PACK_W, h: GROUND - BOX_TOP + LID_H },
  drawPreview: (pen, skin) => drawBox(pen, 0, 0, skin),
  toolBox: { w: SHAKER_W, h: SHAKER_H },
  drawToolPreview: (pen, skin) =>
    drawRotated(pen, (SHAKER_W - 1) / 2, (SHAKER_H - 1) / 2, SHAKER_W, SHAKER_H, (c, r) => shakerCell(c, r, skin), 0),
};
