// Smoke break: cigarettes in a pack. Joining pops yours up; lighting up pulls it
// out, tips it sideways into the lighter's flame, then stands it beside the pack,
// where it burns down as the timer.

import type { PackSkin } from '../skins.ts';
import * as S from '../sprites.ts';
import {
  type BreakStyle,
  type Item,
  type Rect,
  type SceneView,
  type StyleModule,
  type Tool,
  FLICK_SPARK_MS,
  approach,
  easeInOut,
  easeOutBack,
  flickFlame,
} from './style.ts';

const ASH_CYCLE_S = 40;
/** Lit cigarettes stand in a row on the ground to the right of the pack. */
const STAND_X = S.PACK_X + S.PACK_W + 2;
const GROUND = S.MOUTH_Y + S.BODY_H;
/** Where my cigarette is held sideways, tip to the right, while it's lit. */
const HOLD = { cx: S.PACK_X + S.PACK_W / 2 + 6, cy: S.MOUTH_Y - S.LID_H - 12 };

/** Where a cigarette is this frame; see `geometry`. */
interface Pose {
  paper: number;
  ash: number;
  total: number;
  /** Exact for upright poses. */
  x: number;
  top: number;
  /** Radians clockwise from upright. */
  angle: number;
  cx: number;
  cy: number;
  tipX: number;
  tipY: number;
  inPack: boolean;
}

class Smoke implements BreakStyle {
  readonly top = S.MOUTH_Y - S.LID_H;
  readonly puffColors = S.SMOKE;
  readonly travels = true;
  readonly settled = true;

  layout(n: number) {
    const spacing = n <= 5 ? 4 : 3;
    return { start: Math.round(S.PACK_X + S.PACK_W / 2 - ((n - 1) * spacing + S.CIG_W) / 2), spacing };
  }

  stand(slot: number, count: number): [number, number] {
    const spacing = count <= 6 ? 4 : Math.max(2, Math.floor((S.W - 1 - STAND_X - S.CIG_W) / (count - 1)));
    return [STAND_X + slot * spacing, GROUND];
  }

  // Pull out of the pack, then hop over to stand beside it. Mine first tips
  // sideways and catches in my lighter's flame; teammates' just catch.
  animate(v: Item, mine: boolean, view: SceneView, dt: number) {
    v.appear = approach(v.appear, 1, dt * 5);
    if (v.appear >= 1 && v.out <= 0) v.rise = approach(v.rise, v.wantRise, dt * 2.4);
    if (mine && !v.lit) {
      v.turn = approach(v.turn, v.wantRise && v.rise >= 1 ? 1 : 0, dt * 2.2);
      if (v.turn >= 1 && view.lighterLift >= 0.95) v.ignite = approach(v.ignite, 1, dt * 1.6);
    } else {
      v.out = approach(v.out, v.wantRise && v.rise >= 1 ? 1 : 0, dt * (v.turn > 0 ? 1.8 : 2.2));
      if (!v.lit && v.out >= 1) v.ignite = 1;
    }
  }

  caught(v: Item) {
    return v.ignite >= 1;
  }

  burst(v: Item, view: SceneView) {
    const { tipX, tipY } = this.geometry(v, view);
    for (let i = 0; i < 3; i++) view.puff(tipX + (i - 1), tipY - 1);
  }

  update() {}

  // ── Geometry ──────────────────────────────────────────────────────────────

  private paperLen(v: Item, view: SceneView) {
    const full = view.lengthMin * 2;
    const len = Math.round(full * view.burnFrac);
    if (v.removing === 'stub') return Math.round(len * (1 - v.stub));
    return Math.max(view.burnFrac > 0 ? 1 : 0, len);
  }

  private ashLen(v: Item, paper: number, view: SceneView) {
    if (!v.lit || v.removing || view.litAt === null || paper < 4) return 0;
    const phase = ((view.t + v.seed * ASH_CYCLE_S) % ASH_CYCLE_S) / ASH_CYCLE_S;
    return Math.min(3, Math.floor(phase * 4));
  }

  /**
   * Pose of a cigarette: its middle (cx, cy), how far it's turned from upright,
   * and its tip. `x`/`top` are exact for upright poses.
   */
  private geometry(v: Item, view: SceneView): Pose {
    const paper = this.paperLen(v, view);
    const ash = this.ashLen(v, paper, view);
    const total = S.cigLength(paper, ash);
    const half = (total - 1) / 2;
    // Upright, with its top at `top`.
    const upright = (x: number, top: number) => ({ cx: x + 1, cy: top + half });
    let from: { cx: number; cy: number };
    let angle = 0;
    let k = 0;
    if (v.out <= 0 && v.turn <= 0) {
      // In the pack: pops up when joining, then pulls all the way out to be lit.
      const outH = total + 1;
      const popH = Math.min(6 + (view.lengthMin - 10), outH);
      const visibleH = Math.max(0, easeOutBack(v.appear) * (popH + (outH - popH) * easeInOut(v.rise)));
      const top = S.MOUTH_Y + view.oy - Math.round(visibleH);
      const x = Math.round(v.x);
      return { paper, ash, total, x, top, angle, cx: x + 1, cy: top + half, tipX: x + 1, tipY: top, inPack: true };
    }
    const pulled = upright(v.x, S.MOUTH_Y + view.oy - (total + 1));
    let to = pulled;
    if (v.out <= 0) {
      // Mine, tipping over sideways to be held in the flame.
      k = easeInOut(v.turn);
      from = pulled;
      to = HOLD;
      angle = (Math.PI / 2) * k;
    } else {
      // Hopping over to stand on the ground, leading sideways so it clears the pack.
      // Mine flips back upright from where it was held. Sinks into the ground when stubbed.
      k = v.out;
      from = v.turn > 0 ? HOLD : pulled;
      to = upright(v.standX, v.standY - total);
      angle = v.turn > 0 ? (Math.PI / 2) * (1 - easeInOut(k)) : 0;
    }
    const xk = 1 - (1 - k) ** 2;
    const yk = v.out > 0 ? k * k : k;
    const sink = v.out > 0 ? Math.round((1 - v.appear) * total) : 0;
    const cx = from.cx + (to.cx - from.cx) * xk;
    const cy = from.cy + (to.cy - from.cy) * yk - Math.sin(Math.PI * k) * 6 + sink;
    const tipX = Math.round(cx + Math.sin(angle) * half);
    const tipY = Math.round(cy - Math.cos(angle) * half);
    const x = Math.round(cx - 1);
    return { paper, ash, total, x, top: Math.round(cy - half), angle, cx, cy, tipX, tipY, inPack: false };
  }

  // ── Draw ──────────────────────────────────────────────────────────────────

  draw(view: SceneView, packPen: S.Pen, pen: S.Pen, skin: PackSkin) {
    const { ctx } = pen;
    S.drawPackBack(packPen, view.flap, view.oy, skin);

    // Everything below the mouth is inside the pack; clip it so long cigarettes don't poke out the bottom.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, S.W, S.MOUTH_Y + view.oy + 1);
    ctx.clip();
    // Work out each pose once per frame; both passes and the hit rects use it.
    const poses: [Item, Pose][] = [];
    for (const v of view.items.values()) poses.push([v, this.geometry(v, view)]);
    for (const [v, g] of poses) if (g.inPack) this.drawOne(view, pen, v, g);
    ctx.restore();

    S.drawPackFront(packPen, view.flap, view.oy, skin);

    // Cigarettes out of the pack stand on the ground beside it.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, S.W, GROUND);
    ctx.clip();
    for (const [v, g] of poses) if (!g.inPack) this.drawOne(view, pen, v, g);
    ctx.restore();
  }

  private drawOne(view: SceneView, pen: S.Pen, v: Item, g: Pose) {
    const { paper, ash, top, x, total, inPack, angle, cx, cy, tipX, tipY } = g;
    // Emit smoke and drop ash from lit cigarettes.
    if (v.lit && !v.removing) {
      if (view.t >= v.nextPuff) {
        view.puff(tipX, tipY - 1);
        v.nextPuff = view.t + 0.6 + Math.random() * 0.9;
      }
      if (ash < v.lastAsh) {
        for (let i = 0; i < 2; i++) view.bit(tipX - 1 + i * 2, tipY, (Math.random() - 0.5) * 6, '#a8a8b0');
      }
      v.lastAsh = ash;
    }
    const tip = v.removing === 'stub' ? 'dead' : v.lit ? this.emberState(v, view) : 'unlit';
    if (angle === 0) {
      S.drawCig(pen, x, top, paper, tip, ash);
      const h = inPack ? S.MOUTH_Y + view.oy - top : Math.min(total, GROUND - top);
      view.hitItem({ x: x - 1, y: top, w: S.CIG_W + 2, h }, v.id);
      view.contentTop = Math.min(view.contentTop, top);
    } else {
      S.drawCigTurned(pen, cx, cy, paper, tip, ash, angle);
      // Bounding box of the turned cigarette.
      const hw = Math.abs(Math.sin(angle)) * (total / 2) + 2;
      const hh = Math.abs(Math.cos(angle)) * (total / 2) + 2;
      const r = { x: Math.round(cx - hw), y: Math.round(cy - hh), w: Math.round(hw * 2), h: Math.round(hh * 2) };
      view.hitItem(r, v.id);
      view.contentTop = Math.min(view.contentTop, r.y);
    }
  }

  private emberState(v: Item, view: SceneView): S.TipState {
    if (view.remainingMs < view.minuteMs) return Math.floor(view.t * 2.5) % 2 ? 'lit' : 'dim';
    return Math.sin(view.t * 7 + v.seed * 20) > 0.85 ? 'dim' : 'lit';
  }

  drawTool(view: SceneView, pen: S.Pen, tool: Tool): Rect {
    let x: number = S.LIGHTER_X;
    let base = S.LIGHTER_BASE_Y;
    let flame = flickFlame(tool.since);
    const { mine } = tool;
    if (mine) {
      // Raise the lighter so its flame licks the tip of my cigarette, held sideways.
      const lift = easeInOut(view.lighterLift);
      const tipX = Math.round(HOLD.cx + (S.cigLength(this.paperLen(mine, view), 0) - 1) / 2);
      const tipY = Math.round(HOLD.cy);
      x = Math.round(S.LIGHTER_X + (tipX - 4 - S.LIGHTER_X) * lift);
      base = Math.round(S.LIGHTER_BASE_Y + (tipY + 18 - S.LIGHTER_BASE_Y) * lift);
      if (tool.lighting) {
        const spark = tool.since < FLICK_SPARK_MS ? 'spark' : 'none';
        flame = mine.ignite <= 0 ? spark : mine.ignite < 0.2 ? 'spark' : 'flame';
      }
    }
    base += Math.round((1 - easeOutBack(view.lighterShow)) * 22);
    // The striker wheel wiggles while the lighter is waiting to be clicked.
    const frame = flame === 'none' ? Math.floor(view.t * 2) : Math.floor(view.t * 12);
    S.drawLighter(pen, x, base, flame, frame, tool.skin);
    return { x: x - 1, y: base - 20, w: 10, h: 21 };
  }

  body(oy: number): Rect {
    return { x: S.PACK_X, y: S.MOUTH_Y - S.LID_H - 1 + oy, w: S.PACK_W, h: S.LID_H + S.BODY_H + 1 };
  }
}

export const smoke: StyleModule = {
  create: () => new Smoke(),
  previewBox: { x: S.PACK_X, y: S.MOUTH_Y - S.LID_H, w: S.PACK_W, h: S.LID_H + S.BODY_H },
  drawPreview: (pen, skin) => S.drawPackFront(pen, 0, 0, skin),
  drawToolPreview: (pen, skin) => S.drawLighter(pen, 0, 20, 'flame', 0, skin),
};
