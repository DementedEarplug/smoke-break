// Coffee break: a drip coffee maker with everyone's mug lined up beside it.
// Lighting up lifts the pot over your mug and pours; full mugs steam, and the
// pot drains as the timer, then brews itself full again.

import type { LighterSkin, PackSkin } from '../skins.ts';
import { ADVANCE } from '../font.ts';
import { BODY_H, K, MOUTH_Y, PACK_W, PACK_X, Pen, W, drawGlyphs, drawRotated } from '../sprites.ts';
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
/** Top row of the machine's hood. */
const HOOD_TOP = GROUND - 34;
const HOOD_BOTTOM = HOOD_TOP + 9;
/** The back column holding up the hood. */
const COLUMN_W = 6;
const BASE_TOP = GROUND - 4;

// The pot: 11×14, handle on the left, spout at the top right.
const POT_W = 11;
const POT_H = 14;
const POT_REST = { cx: X0 + COLUMN_W + 1 + (POT_W - 1) / 2, cy: BASE_TOP - (POT_H + 1) / 2 };
const SPOUT = { c: POT_W - 1, r: 3 };
/** How far the pot tips to pour. */
const POUR_ANGLE = 1.1;
const FULL_POT = 0.85;

// Mugs: 7×6 with a handle on the right, standing on the ground beside the machine.
const MUG_W = 7;
const MUG_H = 6;
const MUGS_X = X1 + 3;
const MUGS: [string, string, string][] = [
  ['#ff6a5a', '#d23a3a', '#8f1f2e'],
  ['#6a9af2', '#3a6ad2', '#244a9a'],
  ['#fff6e0', '#e8dcc4', '#b8a888'],
  ['#7ad88a', '#3a9a5a', '#1f6b45'],
  ['#ffd060', '#e0a838', '#a87628'],
  ['#c08af0', '#8a5ac8', '#5a3a90'],
];

/** Same color for the same person on everyone's screen. */
function mugColors(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return MUGS[Math.abs(h) % MUGS.length];
}

const COFFEE = { main: '#5a3418', light: '#8a5a30', dark: '#3a200c', surface: '#a06a3a' };
const GLASS = { main: '#d8eef4', light: '#ffffff', dark: '#a8c8d4' };
export const STEAM = ['#ffffff', '#f0f2f8', '#dfe2ec', '#c8ccd8'];

class Coffee implements BreakStyle {
  readonly top = HOOD_TOP;
  readonly puffColors = STEAM;
  readonly travels = true;
  private potLevel = FULL_POT;

  get settled() {
    return this.potLevel === FULL_POT;
  }

  layout(n: number) {
    const spacing = n <= 3 ? MUG_W + 1 : Math.max(3, Math.floor((W - 1 - MUGS_X - MUG_W) / (n - 1)));
    return { start: MUGS_X, spacing };
  }

  stand(): [number, number] {
    return [0, 0];
  }

  animate(v: Item, mine: boolean, view: SceneView, dt: number) {
    v.appear = approach(v.appear, 1, dt * 5);
    if (mine && !v.lit) {
      // Filled from the pot once it's over my mug.
      if (v.wantRise && view.lighterLift >= 0.95) v.ignite = approach(v.ignite, 1, dt * 1.2);
    } else {
      v.rise = approach(v.rise, v.wantRise, dt * 1.6);
      if (!v.lit && v.rise >= 1) v.ignite = 1;
    }
  }

  caught(v: Item) {
    return v.ignite >= 1;
  }

  burst(v: Item, view: SceneView) {
    if (v.removing) return;
    const x = Math.round(v.x) + 1;
    for (let i = 0; i < 2; i++) view.puff(x + i, GROUND - MUG_H - 1);
  }

  update(view: SceneView, breakOn: boolean, dt: number) {
    // Pours out over the break, then brews back up.
    const want = breakOn && view.phase !== 'pending' && view.litAt !== null ? view.burnFrac * FULL_POT : FULL_POT;
    this.potLevel = approach(this.potLevel, want, dt * (want > this.potLevel ? 0.3 : 0.8));
  }

  draw(view: SceneView, packPen: Pen, pen: Pen, skin: PackSkin) {
    const { ctx } = pen;
    const brewing = this.potLevel < FULL_POT && !view.items.size;
    drawMachine(packPen, view.oy, skin, view.lighterShow > 0 && Math.floor(view.t * 2) % 2 === 0, brewing, view.t);
    if (view.lighterShow === 0) drawPot(packPen, POT_REST.cx, POT_REST.cy + view.oy, 0, this.potLevel, null);

    // Mugs pop up out of the ground, and sink back into it when the break's over.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, GROUND);
    ctx.clip();
    for (const v of view.items.values()) {
      const x = Math.round(v.x);
      const gone = v.removing === 'stub' ? v.stub : 0;
      const drop = Math.round((1 - easeOutBack(v.appear)) * (MUG_H + 1) + gone * 2);
      const top = GROUND - MUG_H + drop;
      const fill = v.removing ? 0 : v.lit ? 1 : Math.max(v.rise, v.ignite);
      drawMug(pen, x, top, mugColors(v.id), fill);
      if (v.lit && !v.removing && view.t >= v.nextPuff) {
        view.puff(x + 1 + Math.round(v.seed * 2), top - 1);
        v.nextPuff = view.t + 0.8 + Math.random() * 0.9;
      }
      view.hitItem({ x: x - 1, y: top - 1, w: MUG_W + 1, h: MUG_H + 2 }, v.id);
    }
    ctx.restore();
  }

  drawTool(view: SceneView, pen: Pen, tool: Tool): Rect {
    const { mine } = tool;
    const lift = easeInOut(view.lighterLift);
    let cx = POT_REST.cx;
    let cy = POT_REST.cy;
    let angle = 0;
    if (mine && lift > 0) {
      // Over my mug, tipped so the spout is just above it.
      const target = this.pourCenter(Math.round(mine.x));
      cx += (target.cx - cx) * lift;
      cy += (target.cy - cy) * lift - Math.sin(Math.PI * lift) * 6;
      angle = POUR_ANGLE * lift;
    } else if (!tool.lighting && Math.floor(view.t * 2) % 2 === 0) {
      // Jiggles on the hot plate while it's waiting to be picked up.
      cy -= 1;
    }
    drawPot(pen, cx, cy, angle, this.potLevel, tool.skin);
    if (mine && tool.lighting && mine.ignite > 0) {
      // Coffee streaming from the spout into my mug.
      const spout = this.spoutAt(cx, cy, angle);
      for (let y = spout.y + 1; y < GROUND - MUG_H; y++) pen.px(spout.x, y, (y + Math.floor(view.t * 12)) % 3 ? COFFEE.main : COFFEE.surface);
    }
    return { x: Math.round(cx - POT_W / 2) - 1, y: Math.round(cy - POT_H / 2) - 1, w: POT_W + 2, h: POT_H + 2 };
  }

  private spoutAt(cx: number, cy: number, angle: number) {
    const dx = SPOUT.c - (POT_W - 1) / 2;
    const dy = SPOUT.r - (POT_H - 1) / 2;
    return {
      x: Math.round(cx + dx * Math.cos(angle) - dy * Math.sin(angle)),
      y: Math.round(cy + dx * Math.sin(angle) + dy * Math.cos(angle)),
    };
  }

  /** Where the pot's middle goes so its spout pours into a mug at `mugX`. */
  private pourCenter(mugX: number) {
    const s = this.spoutAt(0, 0, POUR_ANGLE);
    return { cx: mugX + 2 - s.x, cy: GROUND - MUG_H - 6 - s.y };
  }

  body(oy: number): Rect {
    return { x: X0, y: HOOD_TOP + oy, w: PACK_W, h: GROUND - HOOD_TOP };
  }
}

// ── Art ─────────────────────────────────────────────────────────────────────

/** The machine: hood on a back column over a hot plate. The pot is drawn separately. */
function drawMachine(pen: Pen, oy: number, skin: PackSkin, ready: boolean, brewing: boolean, t: number) {
  // Hood.
  for (let y = HOOD_TOP; y <= HOOD_BOTTOM; y++) {
    for (let x = X0; x <= X1; x++) {
      const edge = y === HOOD_TOP || y === HOOD_BOTTOM || x === X0 || x === X1;
      const corner = (y === HOOD_TOP || y === HOOD_BOTTOM) && (x === X0 || x === X1);
      if (corner) continue;
      pen.px(x, y + oy, edge ? K : x === X0 + 1 ? skin.mainLight : x === X1 - 1 ? skin.mainDark : y === HOOD_BOTTOM - 1 ? skin.mainDark : skin.main);
    }
  }
  const textW = skin.monogram.length * ADVANCE - 1;
  // Light lettering on the colored hood; solid skins already pick a contrasting label.
  const ink = skin.style === 'solid' ? skin.label : skin.base;
  drawGlyphs(pen, skin.monogram, X0 + Math.floor((PACK_W - textW) / 2), HOOD_TOP + 2 + oy, ink);
  // Drip head under the hood, right over the pot.
  const dripX = Math.round(POT_REST.cx) + 1;
  pen.rect(dripX - 1, HOOD_BOTTOM + 1 + oy, 3, 1, K);
  pen.px(dripX, HOOD_BOTTOM + 2 + oy, '#5a5a68');
  if (brewing) {
    const y = HOOD_BOTTOM + 3 + (Math.floor(t * 6) % 3);
    pen.px(dripX, y + oy, COFFEE.light);
  }

  // Back column.
  for (let y = HOOD_BOTTOM + 1; y < BASE_TOP; y++) {
    pen.px(X0, y + oy, K);
    pen.px(X0 + COLUMN_W - 1, y + oy, K);
    for (let x = X0 + 1; x < X0 + COLUMN_W - 1; x++) pen.px(x, y + oy, x === X0 + 1 ? skin.mainLight : skin.mainDark);
  }
  // Power light: blinks while the pot's waiting to be poured.
  pen.rect(X0 + 2, BASE_TOP - 4 + oy, 2, 1, ready ? '#ff5a3a' : '#5a2a2a');

  // Base and hot plate.
  for (let y = BASE_TOP; y < GROUND; y++) {
    for (let x = X0; x <= X1; x++) {
      const edge = y === BASE_TOP || y === GROUND - 1 || x === X0 || x === X1;
      pen.px(x, y + oy, edge ? K : y === GROUND - 2 ? skin.baseBottom : x === X1 - 1 ? skin.baseShade : skin.trim);
    }
  }
}

function potCell(c: number, r: number, level: number, skin: LighterSkin | null): string | null {
  const lid = skin?.body ?? '#3a3848';
  const lidShade = skin?.shade ?? '#24222e';
  // Handle.
  if (c <= 1) {
    if (r === 4 || r === 11) return K;
    if (r > 4 && r < 11) return c === 0 ? K : lid;
    return null;
  }
  if (r === 0) return c >= 4 && c <= 8 ? K : null;
  if (r <= 2) {
    if (c === 3 || c === 9) return K;
    if (c > 3 && c < 9) return c === 8 ? lidShade : lid;
    return null;
  }
  if (r === 3) return K;
  if (r === POT_H - 1) return c >= 3 && c <= 9 ? K : null;
  if (c === 2 || c === 10) return K;
  // Glass, with coffee up to `level`.
  const rows = POT_H - 5;
  const wet = r > POT_H - 2 - Math.round(level * rows);
  const surface = wet && r === POT_H - 1 - Math.round(level * rows);
  if (wet) return surface ? COFFEE.surface : c === 3 ? COFFEE.light : c === 9 ? COFFEE.dark : COFFEE.main;
  return c === 3 ? GLASS.light : c === 9 ? GLASS.dark : GLASS.main;
}

function drawPot(pen: Pen, cx: number, cy: number, angle: number, level: number, skin: LighterSkin | null) {
  drawRotated(pen, cx, cy, POT_W, POT_H, (c, r) => potCell(c, r, level, skin), angle);
}

function drawMug(pen: Pen, x: number, top: number, [light, main, shade]: [string, string, string], fill: number) {
  // Rim: coffee shows from above once it's poured.
  pen.px(x, top, light);
  pen.px(x + 4, top, shade);
  for (let c = 1; c <= 3; c++) pen.px(x + c, top, fill >= 1 ? (c === 1 ? COFFEE.surface : COFFEE.main) : fill > 0 ? COFFEE.dark : '#2a1a1a');
  for (let r = 1; r < MUG_H - 1; r++) {
    pen.px(x, top + r, light);
    pen.rect(x + 1, top + r, 3, 1, main);
    pen.px(x + 4, top + r, shade);
  }
  pen.rect(x, top + MUG_H - 1, 5, 1, shade);
  // Handle.
  pen.rect(x + 5, top + 1, 2, 1, main);
  pen.rect(x + 6, top + 2, 1, 2, main);
  pen.rect(x + 5, top + 4, 2, 1, main);
}

export const coffee: StyleModule = {
  create: () => new Coffee(),
  previewBox: { x: X0, y: HOOD_TOP, w: PACK_W, h: GROUND - HOOD_TOP },
  drawPreview: (pen, skin) => {
    drawMachine(pen, 0, skin, false, false, 0);
    drawPot(pen, POT_REST.cx, POT_REST.cy, 0, FULL_POT, null);
  },
  toolBox: { w: POT_W, h: POT_H },
  drawToolPreview: (pen, skin) => drawPot(pen, (POT_W - 1) / 2, (POT_H - 1) / 2, 0, FULL_POT, skin),
};
