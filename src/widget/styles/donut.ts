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
/** A wide bakery box, centered where the pack would be. */
const BOX_W = 32;
const X0 = PACK_X + Math.floor((PACK_W - BOX_W) / 2);
const X1 = X0 + BOX_W - 1;
/** Top edge of the open box; donuts peek out above it. */
const BOX_TOP = GROUND - 14;
const LID_H = 4;

// Donuts: 11×10, seen from a little above, frosting dripping over the dough.
const DONUT_W = 11;
const DONUT_H = 10;
const DONUT = [
  '...KKKKK...',
  '.KKFFFFFKK.',
  '.KFhhFFFFK.',
  'KFhFDDDFFFK',
  'KFFF...FFFK',
  'KFFF...FFDK',
  'KDFFFFFDFDK',
  '.KDFDFFDDK.',
  '..KsDDDsK..',
  '...KKKKK...',
];
const MID_R = 4.5;
const DOUGH = { D: '#e0a050', s: '#b07830', K };
/** Inside of a bitten donut. */
const CRUMB_IN = '#f4d48c';
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
  [4, 1],
  [7, 2],
  [2, 5],
  [8, 3],
  [5, 6],
  [8, 5],
  [2, 2],
];
/** Eaten a bite at a time from the right, leaving tooth marks. */
const BITES = 5;
const MARKS = [1.5, 4.5, 7.5];
const bitesTaken = (bitten: number) => (bitten >= 1 ? BITES + 1 : Math.min(BITES, Math.floor(bitten * (BITES + 1))));
/** How far in from the right the bites reach. */
const biteLine = (bites: number) => DONUT_W - (bites * DONUT_W) / (BITES + 1);
const isEaten = (c: number, r: number, bites: number) => {
  if (bites === 0) return false;
  const line = biteLine(bites) + 1;
  return c > line || MARKS.some((m) => (c - line) ** 2 + (r - m) ** 2 < 1.8 ** 2);
};
const CRUMB = '#d09040';
/** Peeking out of the box. */
const POP_H = 6;
/** Where my donut is held up to be sprinkled. */
const HOLD = { x: X0 + Math.floor((BOX_W - DONUT_W) / 2), top: BOX_TOP - 24 };
/** Lit donuts stack up on the ground to the right of the box. */
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
  readonly shadow = { x: X0, w: BOX_W };

  layout(n: number) {
    const spacing = n <= 2 ? DONUT_W : Math.max(2, Math.floor((BOX_W - 2 - DONUT_W) / (n - 1)));
    return { start: Math.round(X0 + BOX_W / 2 - ((n - 1) * spacing + DONUT_W) / 2), spacing };
  }

  stand(slot: number): [number, number] {
    // Two side by side, then one on top between them, and so on.
    const k = slot % 3;
    const row = Math.floor(slot / 3) * 2 + (k === 2 ? 1 : 0);
    const i = k === 2 ? 0 : k;
    return [STAND_X + i * (DONUT_W - 1) + (row % 2 ? 5 : 0), GROUND - row * (DONUT_H - 1)];
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
    const bites = bitesTaken(bitten);
    if (v.lit && bites > v.lastAsh && bites <= BITES) {
      const c = biteLine(bites) + 1;
      for (let i = 0; i < 3; i++) view.bit(g.x + c, g.top + MID_R + (i - 1) * 2, (Math.random() - 0.5) * 6, CRUMB);
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
    return { x: X0, y: BOX_TOP - LID_H + oy, w: BOX_W, h: GROUND - BOX_TOP + LID_H };
  }
}

// ── Art ─────────────────────────────────────────────────────────────────────

/** The open lid, standing up behind the donuts. */
function drawLidBack(pen: Pen, flap: number, oy: number, skin: PackSkin) {
  if (flap < 0.34) return;
  const h = flap < 0.67 ? 5 : 10;
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
  drawGlyphs(pen, skin.monogram, X0 + Math.floor((BOX_W - textW) / 2), BOX_TOP + 6 + oy, skin.label);
}

function drawDonut(pen: Pen, x: number, top: number, [frost, shine]: [string, string], sprinkles: number, bitten: number, seed: number) {
  const sprinkled = new Map<string, string>();
  for (let i = 0; i < sprinkles; i++) {
    const [c, r] = SPRINKLE_AT[i];
    sprinkled.set(`${c},${r}`, SPRINKLES[(i + Math.floor(seed * SPRINKLES.length)) % SPRINKLES.length]);
  }
  const bites = bitesTaken(bitten);
  if (bites > BITES) return;
  for (let r = 0; r < DONUT_H; r++) {
    for (let c = 0; c < DONUT_W; c++) {
      const ch = DONUT[r][c];
      if (ch === '.' || isEaten(c, r, bites)) continue;
      // The bitten edge shows the inside.
      const edge = isEaten(c + 1, r, bites) || isEaten(c, r - 1, bites) || isEaten(c, r + 1, bites);
      const color = edge
        ? ch === 'K'
          ? K
          : CRUMB_IN
        : (sprinkled.get(`${c},${r}`) ?? (ch === 'F' ? frost : ch === 'h' ? shine : DOUGH[ch as 'D' | 's' | 'K']));
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
  previewBox: { x: X0, y: BOX_TOP - LID_H, w: BOX_W, h: GROUND - BOX_TOP + LID_H },
  drawPreview: (pen, skin) => drawBox(pen, 0, 0, skin),
  toolBox: { w: SHAKER_W, h: SHAKER_H },
  drawToolPreview: (pen, skin) =>
    drawRotated(pen, (SHAKER_W - 1) / 2, (SHAKER_H - 1) / 2, SHAKER_W, SHAKER_H, (c, r) => shakerCell(c, r, skin), 0),
};
