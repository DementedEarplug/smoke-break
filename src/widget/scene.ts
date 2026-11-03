// The pack scene. Each frame it reconciles the server's break state into
// per-cigarette animation values, then draws them. Server state says *what*
// is true; this file decides *how* it gets there (pops, slides, stub-outs).

import type { Break } from '../../shared/protocol.ts';
import type { LighterSkin, PackSkin } from './skins.ts';
import * as S from './sprites.ts';
import { type Theme, themedPack } from './theme.ts';

export interface SceneInput {
  brk: Break | null;
  me: string;
  dnd: boolean;
  /** Server-synced clock (ms). */
  now: number;
  /** performance.now() of the last lighter flick, if any. */
  flickAt: number | null;
  packSkin: PackSkin;
  lighterSkin: LighterSkin;
  theme: Theme;
}

export type HitTarget = 'lighter' | 'myCig' | 'pack';
export interface Hit {
  target: HitTarget;
  cigId?: string;
}

interface CigVis {
  id: string;
  name: string;
  x: number;
  targetX: number;
  appear: number;
  rise: number;
  wantRise: number;
  lit: boolean;
  /** 0 in the pack, 1 standing beside it (lit cigarettes leave the pack). */
  out: number;
  /** Where it stands once out. */
  standX: number;
  /** My cigarette only: 0 upright out of the pack, 1 held sideways over it for lighting. */
  turn: number;
  /** Time spent in the lighter's flame before catching. */
  ignite: number;
  stub: number;
  removing: null | 'stub' | 'sink';
  seed: number;
  lastAsh: number;
  nextPuff: number;
}

interface Particle {
  kind: 'smoke' | 'ash';
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  seed: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const inRect = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
const approach = (v: number, target: number, step: number) =>
  v < target ? Math.min(target, v + step) : Math.max(target, v - step);
const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

const FLICK_SPARK_MS = 160;
const FLICK_MS = 900;
const ASH_CYCLE_S = 40;
/** Lit cigarettes stand in a row on the ground to the right of the pack. */
const STAND_X = S.PACK_X + S.PACK_W + 2;
const GROUND = S.MOUTH_Y + S.BODY_H;
/** Where my cigarette is held sideways, tip to the right, while it's lit. */
const HOLD = { cx: S.PACK_X + S.PACK_W / 2 + 6, cy: S.MOUTH_Y - S.LID_H - 12 };

export class Scene {
  private cigs = new Map<string, CigVis>();
  private particles: Particle[] = [];
  private flap = 0;
  private lighterShow = 0;
  /** 0 resting by the pack, 1 raised to the tip of my cigarette. */
  private lighterLift = 0;
  private t = 0;
  private synced = false;
  /** Remembered so cigarettes can finish animating after the break disappears. */
  private lengthMin = 12;
  private burnFrac = 1;
  private litAt: number | null = null;
  private remainingMs = Infinity;
  private minuteMs = 60_000;
  private theme: Theme = 'smoke';
  /** Water left in the cooler's jug; refills once a break is over. */
  private jugLevel = 1;

  private oy = 0;
  private cigRects: (Rect & { id: string })[] = [];
  private lighterRect: Rect | null = null;
  /** Highest drawn row of the pack and cigarettes, for anchoring the bubble. */
  contentTop: number = S.H;

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  get idle() {
    return this.cigs.size === 0 && this.flap === 0;
  }

  /** Nothing is moving except the idle bob, so frames can come slowly. */
  get settled() {
    return this.idle && this.particles.length === 0 && this.lighterShow === 0 && this.jugLevel === 1;
  }

  nameOf(id: string) {
    return this.cigs.get(id)?.name ?? '';
  }

  /** True once this person's cigarette (or cup) has caught, after its animation. */
  isLit(id: string) {
    const v = this.cigs.get(id);
    return !!v && v.lit && !v.removing;
  }

  update(input: SceneInput, dt: number) {
    this.t += dt;
    this.theme = input.theme;
    const { brk, me } = input;
    const meIn = !!brk?.participants.some((p) => p.id === me);
    const visible = !!brk && (!input.dnd || meIn);

    if (brk) {
      this.lengthMin = brk.lengthMin;
      this.litAt = brk.litAt;
      this.minuteMs = brk.minuteMs;
      const total = brk.lengthMin * brk.minuteMs;
      if (brk.phase === 'lit' && brk.endsAt !== null) {
        this.remainingMs = Math.max(0, brk.endsAt - input.now);
        this.burnFrac = Math.min(1, this.remainingMs / total);
      } else if (brk.phase === 'out' && brk.outReason === 'burned') {
        this.burnFrac = 0;
        this.remainingMs = 0;
      } else if (brk.phase !== 'out') {
        this.burnFrac = 1;
        this.remainingMs = Infinity;
      }
    }

    // Reconcile cigarettes with participants.
    const desired = visible && brk!.phase !== 'out' ? brk!.participants : [];
    const n = desired.length;
    // Cups have to fit the water cooler's nook, which is narrower than the pack.
    const spacing = n <= (this.theme === 'water' ? 4 : 5) ? 4 : 3;
    const startX = Math.round(S.PACK_X + S.PACK_W / 2 - ((n - 1) * spacing + S.CIG_W) / 2);
    const standing = desired.filter((p) => p.litAt);
    const m = standing.length;
    const standSpacing = m <= 6 ? 4 : Math.max(2, Math.floor((S.W - 1 - STAND_X - S.CIG_W) / (m - 1)));
    const seen = new Set<string>();
    desired.forEach((p, i) => {
      seen.add(p.id);
      let v = this.cigs.get(p.id);
      const targetX = startX + i * spacing;
      if (!v) {
        // On first sync, snap to the current state instead of replaying animations.
        const snap = !this.synced;
        v = {
          id: p.id,
          name: p.name,
          x: targetX,
          targetX,
          appear: snap ? 1 : 0,
          rise: snap && p.litAt ? 1 : 0,
          wantRise: 0,
          lit: snap && !!p.litAt,
          out: snap && p.litAt ? 1 : 0,
          standX: STAND_X,
          turn: 0,
          ignite: snap && p.litAt ? 1 : 0,
          stub: 0,
          removing: null,
          seed: Math.random(),
          lastAsh: 0,
          nextPuff: this.t + Math.random(),
        };
        this.cigs.set(p.id, v);
      }
      v.targetX = targetX;
      v.wantRise = p.litAt ? 1 : 0;
      const slot = standing.indexOf(p);
      if (slot >= 0) v.standX = STAND_X + slot * standSpacing;
      v.removing = null;
    });
    for (const v of this.cigs.values()) {
      if (seen.has(v.id) || v.removing) continue;
      v.removing = v.lit ? 'stub' : 'sink';
      if (v.lit) this.puffBurst(v);
    }
    this.synced = true;

    // Animate. Smoke: pull out of the pack, then hop over to stand beside it. Mine
    // first tips sideways and catches in my lighter's flame; teammates' just catch.
    // Water: the cup in the nook fills.
    const smoke = this.theme === 'smoke';
    for (const v of [...this.cigs.values()]) {
      v.x += (v.targetX - v.x) * Math.min(1, dt * 10);
      if (!v.removing) {
        v.appear = approach(v.appear, 1, dt * 5);
        if (v.appear >= 1 && v.out <= 0) v.rise = approach(v.rise, v.wantRise, dt * (smoke ? 2.4 : 1.6));
        if (smoke && v.id === me && !v.lit) {
          v.turn = approach(v.turn, v.wantRise && v.rise >= 1 ? 1 : 0, dt * 2.2);
          if (v.turn >= 1 && this.lighterLift >= 0.95) v.ignite = approach(v.ignite, 1, dt * 1.6);
        } else if (smoke) {
          v.out = approach(v.out, v.wantRise && v.rise >= 1 ? 1 : 0, dt * (v.turn > 0 ? 1.8 : 2.2));
          if (!v.lit && v.out >= 1) v.ignite = 1;
        }
        if (!v.lit && v.wantRise === 1 && (smoke ? v.ignite >= 1 : v.rise >= 1)) {
          v.lit = true;
          this.puffBurst(v);
        }
      } else if (v.removing === 'stub') {
        v.stub = approach(v.stub, 1, dt * 2.5);
        if (v.stub >= 1) v.appear = approach(v.appear, 0, dt * 3);
      } else if (v.out > 0) {
        v.out = approach(v.out, 0, dt * 3);
      } else if (v.turn > 0) {
        v.turn = approach(v.turn, 0, dt * 3);
      } else {
        v.rise = approach(v.rise, 0, dt * 3);
        if (v.rise <= 0) v.appear = approach(v.appear, 0, dt * 4);
      }
      if (v.removing && v.appear <= 0) this.cigs.delete(v.id);
    }

    const wantOpen = this.cigs.size > 0 || (visible && brk!.phase !== 'out');
    this.flap = approach(this.flap, wantOpen ? 1 : 0, dt * 6);

    const myP = brk?.participants.find((p) => p.id === me);
    const needLighter = !!myP && myP.litAt === null && (brk!.phase === 'lighter' || brk!.phase === 'lit');
    const flicking = input.flickAt !== null && performance.now() - input.flickAt < FLICK_MS;
    const lighting = this.lightingMine(me);
    this.lighterShow = approach(this.lighterShow, needLighter || flicking || lighting ? 1 : 0, dt * 5);
    this.lighterLift = approach(this.lighterLift, lighting ? 1 : 0, dt * 3);

    const breakOn = (!!brk && brk.phase !== 'out') || this.cigs.size > 0;
    this.jugLevel = approach(this.jugLevel, breakOn ? this.burnFrac : 1, dt * 0.8);

    this.updateParticles(dt);
  }

  /** My cigarette is on its way out of the pack to be lit. */
  private lightingMine(me: string) {
    const v = this.cigs.get(me);
    return this.theme === 'smoke' && !!v && v.wantRise === 1 && !v.lit && !v.removing;
  }

  private puffBurst(v: CigVis) {
    if (this.theme === 'water') return;
    const { tipX, tipY } = this.geometry(v);
    for (let i = 0; i < 3; i++) this.spawnSmoke(tipX + (i - 1), tipY - 1);
  }

  private spawnSmoke(x: number, y: number) {
    this.particles.push({
      kind: 'smoke',
      x,
      y,
      vx: (Math.random() - 0.5) * 2,
      vy: -5 - Math.random() * 3,
      age: 0,
      life: 2.5 + Math.random() * 1.5,
      seed: Math.random() * 10,
    });
  }

  private updateParticles(dt: number) {
    for (const p of this.particles) {
      p.age += dt;
      if (p.kind === 'smoke') {
        p.x += (p.vx + Math.sin(p.age * 2.2 + p.seed) * 2.5) * dt;
        p.y += p.vy * dt;
      } else {
        p.vy += 40 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
    }
    this.particles = this.particles.filter(
      (p) => p.age < p.life && p.y > -4 && !(p.kind === 'ash' && p.y >= S.MOUTH_Y + S.BODY_H),
    );
  }

  // ── Cigarette geometry ────────────────────────────────────────────────────

  private paperLen(v: CigVis) {
    const full = this.lengthMin * 2;
    const len = Math.round(full * this.burnFrac);
    if (v.removing === 'stub') return Math.round(len * (1 - v.stub));
    return Math.max(this.burnFrac > 0 ? 1 : 0, len);
  }

  private ashLen(v: CigVis, paper: number) {
    if (!v.lit || v.removing || this.litAt === null || paper < 4) return 0;
    const phase = ((this.t + v.seed * ASH_CYCLE_S) % ASH_CYCLE_S) / ASH_CYCLE_S;
    return Math.min(3, Math.floor(phase * 4));
  }

  /**
   * Pose of a cigarette: its middle (cx, cy), how far it's turned from upright,
   * and its tip. `x`/`top` are exact for upright poses.
   */
  private geometry(v: CigVis) {
    const paper = this.paperLen(v);
    const ash = this.ashLen(v, paper);
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
      const popH = Math.min(6 + (this.lengthMin - 10), outH);
      const visibleH = Math.max(0, easeOutBack(v.appear) * (popH + (outH - popH) * easeInOut(v.rise)));
      const top = S.MOUTH_Y + this.oy - Math.round(visibleH);
      const x = Math.round(v.x);
      return { paper, ash, total, x, top, angle, cx: x + 1, cy: top + half, tipX: x + 1, tipY: top, inPack: true };
    }
    const pulled = upright(v.x, S.MOUTH_Y + this.oy - (total + 1));
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
      to = upright(v.standX, GROUND - total);
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

  draw(input: SceneInput) {
    const { ctx } = this;
    ctx.clearRect(0, 0, S.W, S.H);
    const meIn = !!input.brk?.participants.some((p) => p.id === input.me);
    const packPen = new S.Pen(ctx, input.dnd && !meIn ? S.greyTint : null);
    const packSkin = themedPack(input.packSkin, input.theme);
    const pen = new S.Pen(ctx);

    this.oy = this.idle ? Math.round(Math.sin(this.t * 2.2)) : 0;
    S.drawShadow(pen, -this.oy);
    if (input.theme === 'water') this.drawCooler(input, packPen, pen, packSkin);
    else this.drawPack(packPen, pen, packSkin);
    if (input.dnd) {
      const rise = Math.floor((this.t * 3) % 6);
      const top = input.theme === 'water' ? S.JUG_TOP : S.MOUTH_Y - S.LID_H;
      S.drawGlyphs(pen, 'Z', S.PACK_X + S.PACK_W - 1, top - 6 - rise, '#9aa0c0');
    }
    this.drawLighter(input, pen);
    this.drawParticles(pen);
  }

  private drawPack(packPen: S.Pen, pen: S.Pen, packSkin: PackSkin) {
    const { ctx } = this;
    S.drawPackBack(packPen, this.flap, this.oy, packSkin);

    this.cigRects = [];
    this.contentTop = S.MOUTH_Y - S.LID_H + this.oy;
    // Everything below the mouth is inside the pack; clip it so long cigarettes don't poke out the bottom.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, S.W, S.MOUTH_Y + this.oy + 1);
    ctx.clip();
    for (const v of this.cigs.values()) if (this.geometry(v).inPack) this.drawOneCig(pen, v);
    ctx.restore();

    S.drawPackFront(packPen, this.flap, this.oy, packSkin);

    // Cigarettes out of the pack stand on the ground beside it.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, S.W, GROUND);
    ctx.clip();
    for (const v of this.cigs.values()) if (!this.geometry(v).inPack) this.drawOneCig(pen, v);
    ctx.restore();
  }

  private drawOneCig(pen: S.Pen, v: CigVis) {
    const { paper, ash, top, x, total, inPack, angle, cx, cy, tipX, tipY } = this.geometry(v);
    // Emit smoke and drop ash from lit cigarettes.
    if (v.lit && !v.removing) {
      if (this.t >= v.nextPuff) {
        this.spawnSmoke(tipX, tipY - 1);
        v.nextPuff = this.t + 0.6 + Math.random() * 0.9;
      }
      if (ash < v.lastAsh) {
        for (let i = 0; i < 2; i++) {
          this.particles.push({
            kind: 'ash',
            x: tipX - 1 + i * 2,
            y: tipY,
            vx: (Math.random() - 0.5) * 6,
            vy: 0,
            age: 0,
            life: 1.5,
            seed: 0,
          });
        }
      }
      v.lastAsh = ash;
    }
    const tip = v.removing === 'stub' ? 'dead' : v.lit ? this.emberState(v) : 'unlit';
    if (angle === 0) {
      S.drawCig(pen, x, top, paper, tip, ash);
      const h = inPack ? S.MOUTH_Y + this.oy - top : Math.min(total, GROUND - top);
      this.cigRects.push({ id: v.id, x: x - 1, y: top, w: S.CIG_W + 2, h });
      this.contentTop = Math.min(this.contentTop, top);
    } else {
      S.drawCigTurned(pen, cx, cy, paper, tip, ash, angle);
      // Bounding box of the turned cigarette.
      const hw = Math.abs(Math.sin(angle)) * (total / 2) + 2;
      const hh = Math.abs(Math.cos(angle)) * (total / 2) + 2;
      const r = { id: v.id, x: Math.round(cx - hw), y: Math.round(cy - hh), w: Math.round(hw * 2), h: Math.round(hh * 2) };
      this.cigRects.push(r);
      this.contentTop = Math.min(this.contentTop, r.y);
    }
  }

  /** Water break: the jug drains as the timer and each person's cup sits in the nook. */
  private drawCooler(input: SceneInput, packPen: S.Pen, pen: S.Pen, packSkin: PackSkin) {
    const { ctx } = this;
    const lit = input.brk?.phase === 'lit' && this.cigs.size > 0;
    S.drawCooler(packPen, this.oy, packSkin, this.jugLevel, this.t, lit);
    this.contentTop = S.JUG_TOP + this.oy;
    this.cigRects = [];
    const { NOOK } = S;
    const bottom = NOOK.tray - 1 + this.oy;
    ctx.save();
    ctx.beginPath();
    ctx.rect(NOOK.x, NOOK.top + 2 + this.oy, NOOK.w, NOOK.tray - NOOK.top - 2);
    ctx.clip();
    for (const v of this.cigs.values()) {
      // Cups slide up onto the tray when someone joins and drop away when they leave.
      const gone = v.removing === 'stub' ? v.stub : 0;
      const drop = Math.round((1 - easeOutBack(v.appear)) * 5 + gone * 5);
      const x = Math.round(v.x);
      S.drawPaperCup(pen, x, bottom + drop, v.lit && !v.removing ? 1 : v.rise);
      this.cigRects.push({ id: v.id, x: x - 1, y: bottom - 4, w: S.CIG_W + 2, h: 6 });
    }
    ctx.restore();
  }

  private drawLighter(input: SceneInput, pen: S.Pen) {
    this.lighterRect = null;
    if (this.lighterShow > 0) {
      let x: number = S.LIGHTER_X;
      let base = S.LIGHTER_BASE_Y;
      const since = input.flickAt === null ? Infinity : performance.now() - input.flickAt;
      let flame: S.FlameState = since < FLICK_SPARK_MS ? 'spark' : since < FLICK_MS ? 'flame' : 'none';
      const mine = this.cigs.get(input.me);
      if (input.theme === 'smoke' && mine) {
        // Raise the lighter so its flame licks the tip of my cigarette, held sideways.
        const lift = easeInOut(this.lighterLift);
        const tipX = Math.round(HOLD.cx + (S.cigLength(this.paperLen(mine), 0) - 1) / 2);
        const tipY = Math.round(HOLD.cy);
        x = Math.round(S.LIGHTER_X + (tipX - 4 - S.LIGHTER_X) * lift);
        base = Math.round(S.LIGHTER_BASE_Y + (tipY + 18 - S.LIGHTER_BASE_Y) * lift);
        if (this.lightingMine(input.me)) {
          flame = mine.ignite <= 0 ? (since < FLICK_SPARK_MS ? 'spark' : 'none') : mine.ignite < 0.2 ? 'spark' : 'flame';
        }
      }
      base += Math.round((1 - easeOutBack(this.lighterShow)) * 22);
      // The striker wheel wiggles while the lighter is waiting to be clicked.
      const frame = flame === 'none' ? Math.floor(this.t * 2) : Math.floor(this.t * 12);
      S.drawLighter(pen, x, base, flame, frame, input.lighterSkin, input.theme);
      this.lighterRect = { x: x - 1, y: base - 20, w: 10, h: 21 };
    }
  }

  private drawParticles(pen: S.Pen) {
    for (const p of this.particles) {
      const k = p.age / p.life;
      if (p.kind === 'ash') {
        pen.px(p.x, p.y, '#a8a8b0');
      } else {
        const size = k < 0.25 ? 1 : k < 0.6 ? 2 : 3;
        const color = S.SMOKE[Math.min(S.SMOKE.length - 1, Math.floor(k * S.SMOKE.length))];
        // Dither out over the last stretch of life.
        if (k > 0.8 && Math.floor(this.t * 20 + p.seed) % 2 === 0) continue;
        S.drawPuff(pen, p.x, p.y, size, color);
      }
    }
  }

  private emberState(v: CigVis): S.TipState {
    if (this.remainingMs < this.minuteMs) return Math.floor(this.t * 2.5) % 2 ? 'lit' : 'dim';
    return Math.sin(this.t * 7 + v.seed * 20) > 0.85 ? 'dim' : 'lit';
  }

  hit(x: number, y: number, me: string): Hit | null {
    if (this.lighterRect && inRect(this.lighterRect, x, y)) return { target: 'lighter' };
    for (let i = this.cigRects.length - 1; i >= 0; i--) {
      const r = this.cigRects[i];
      if (inRect(r, x, y)) return { target: r.id === me ? 'myCig' : 'pack', cigId: r.id };
    }
    const bottom = S.MOUTH_Y + S.BODY_H + this.oy;
    const pack: Rect =
      this.theme === 'water'
        ? { x: S.COOLER_X, y: S.JUG_TOP + this.oy, w: S.COOLER_W, h: bottom - S.JUG_TOP - this.oy }
        : { x: S.PACK_X, y: S.MOUTH_Y - S.LID_H - 1 + this.oy, w: S.PACK_W, h: S.LID_H + S.BODY_H + 1 };
    return inRect(pack, x, y) ? { target: 'pack' } : null;
  }
}
