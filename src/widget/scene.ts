// The pack scene. Each frame it reconciles the server's break state into
// per-person animation values, then draws them. Server state says *what* is
// true; this file decides *how* it gets there (pops, slides, stub-outs), and the
// break style (styles/) decides what it looks like.

import type { Break, Phase } from '../../shared/protocol.ts';
import type { LighterSkin, PackSkin } from './skins.ts';
import * as S from './sprites.ts';
import { STYLES } from './styles/index.ts';
import { type BreakStyle, type Item, type Rect, type SceneView, FLICK_MS, approach } from './styles/style.ts';
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

interface Particle {
  kind: 'puff' | 'bit';
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  seed: number;
  color: string;
}

const inRect = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
const GROUND = S.MOUTH_Y + S.BODY_H;

export class Scene implements SceneView {
  readonly items = new Map<string, Item>();
  private particles: Particle[] = [];
  flap = 0;
  lighterShow = 0;
  /** 0 resting by the pack, 1 raised to my item. */
  lighterLift = 0;
  t = 0;
  private synced = false;
  /** Remembered so items can finish animating after the break disappears. */
  lengthMin = 12;
  burnFrac = 1;
  litAt: number | null = null;
  remainingMs = Infinity;
  minuteMs = 60_000;
  phase: Phase | null = null;
  private theme: Theme = 'smoke';
  private style: BreakStyle = STYLES.smoke.create();

  oy = 0;
  private itemRects: (Rect & { id: string })[] = [];
  private lighterRect: Rect | null = null;
  /** Highest drawn row of the pack and items, for anchoring the bubble. */
  contentTop: number = S.H;

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  get idle() {
    return this.items.size === 0 && this.flap === 0;
  }

  /** Nothing is moving except the idle bob, so frames can come slowly. */
  get settled() {
    return this.idle && this.particles.length === 0 && this.lighterShow === 0 && this.style.settled;
  }

  nameOf(id: string) {
    return this.items.get(id)?.name ?? '';
  }

  /** True once this person's item has caught, after its animation. */
  isLit(id: string) {
    const v = this.items.get(id);
    return !!v && v.lit && !v.removing;
  }

  update(input: SceneInput, dt: number) {
    this.t += dt;
    if (input.theme !== this.theme) {
      this.theme = input.theme;
      this.style = STYLES[input.theme].create();
    }
    const style = this.style;
    const { brk, me } = input;
    this.phase = brk?.phase ?? null;
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

    // Reconcile items with participants.
    const desired = visible && brk!.phase !== 'out' ? brk!.participants : [];
    const { start, spacing } = style.layout(desired.length);
    const standing = desired.filter((p) => p.litAt);
    const seen = new Set<string>();
    desired.forEach((p, i) => {
      seen.add(p.id);
      let v = this.items.get(p.id);
      const targetX = start + i * spacing;
      if (!v) {
        // On first sync, snap to the current state instead of replaying animations.
        const snap = !this.synced;
        const [standX, standY] = style.stand(0, 1);
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
          standX,
          standY,
          turn: 0,
          ignite: snap && p.litAt ? 1 : 0,
          stub: 0,
          removing: null,
          seed: Math.random(),
          lastAsh: 0,
          nextPuff: this.t + Math.random(),
        };
        this.items.set(p.id, v);
      }
      v.targetX = targetX;
      v.wantRise = p.litAt ? 1 : 0;
      const slot = standing.indexOf(p);
      if (slot >= 0) [v.standX, v.standY] = style.stand(slot, standing.length);
      v.removing = null;
    });
    for (const v of this.items.values()) {
      if (seen.has(v.id) || v.removing) continue;
      v.removing = v.lit ? 'stub' : 'sink';
      if (v.lit) style.burst(v, this);
    }
    this.synced = true;

    // Deleting from a Map while iterating it is safe.
    for (const v of this.items.values()) {
      v.x += (v.targetX - v.x) * Math.min(1, dt * 10);
      if (!v.removing) {
        style.animate(v, v.id === me, this, dt);
        if (!v.lit && v.wantRise === 1 && style.caught(v)) {
          v.lit = true;
          style.burst(v, this);
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
      if (v.removing && v.appear <= 0) this.items.delete(v.id);
    }

    const wantOpen = this.items.size > 0 || (visible && brk!.phase !== 'out');
    this.flap = approach(this.flap, wantOpen ? 1 : 0, dt * 6);

    const myP = brk?.participants.find((p) => p.id === me);
    const needLighter = !!myP && myP.litAt === null && (brk!.phase === 'lighter' || brk!.phase === 'lit');
    const flicking = input.flickAt !== null && performance.now() - input.flickAt < FLICK_MS;
    const lighting = this.lightingMine(me);
    this.lighterShow = approach(this.lighterShow, needLighter || flicking || lighting ? 1 : 0, dt * 5);
    this.lighterLift = approach(this.lighterLift, lighting ? 1 : 0, dt * 3);

    const breakOn = (!!brk && brk.phase !== 'out') || this.items.size > 0;
    style.update(this, breakOn, dt);

    this.updateParticles(dt);
  }

  /** My item is on its way to being lit by a tool that comes to it. */
  private lightingMine(me: string) {
    const v = this.items.get(me);
    return this.style.travels && !!v && v.wantRise === 1 && !v.lit && !v.removing;
  }

  // ── For styles ────────────────────────────────────────────────────────────

  puff(x: number, y: number) {
    this.particles.push({
      kind: 'puff',
      x,
      y,
      vx: (Math.random() - 0.5) * 2,
      vy: -5 - Math.random() * 3,
      age: 0,
      life: 2.5 + Math.random() * 1.5,
      seed: Math.random() * 10,
      color: '',
    });
  }

  bit(x: number, y: number, vx: number, color: string) {
    this.particles.push({ kind: 'bit', x, y, vx, vy: 0, age: 0, life: 1.5, seed: 0, color });
  }

  hitItem(r: Rect, id: string) {
    this.itemRects.push({ ...r, id });
  }

  private updateParticles(dt: number) {
    for (const p of this.particles) {
      p.age += dt;
      if (p.kind === 'puff') {
        p.x += (p.vx + Math.sin(p.age * 2.2 + p.seed) * 2.5) * dt;
        p.y += p.vy * dt;
      } else {
        p.vy += 40 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
    }
    this.particles = this.particles.filter((p) => p.age < p.life && p.y > -4 && !(p.kind === 'bit' && p.y >= GROUND));
  }

  // ── Draw ──────────────────────────────────────────────────────────────────

  draw(input: SceneInput) {
    const { ctx, style } = this;
    ctx.clearRect(0, 0, S.W, S.H);
    const meIn = !!input.brk?.participants.some((p) => p.id === input.me);
    const packPen = new S.Pen(ctx, input.dnd && !meIn ? S.greyTint : null);
    const packSkin = themedPack(input.packSkin, input.theme);
    const pen = new S.Pen(ctx);

    this.oy = this.idle ? Math.round(Math.sin(this.t * 2.2)) : 0;
    S.drawShadow(pen, -this.oy);
    this.itemRects = [];
    this.contentTop = style.top + this.oy;
    style.draw(this, packPen, pen, packSkin);
    if (input.dnd) {
      const rise = Math.floor((this.t * 3) % 6);
      S.drawGlyphs(pen, 'Z', S.PACK_X + S.PACK_W - 1, style.top - 6 - rise, '#9aa0c0');
    }
    this.lighterRect = null;
    if (this.lighterShow > 0) {
      this.lighterRect = style.drawTool(this, pen, {
        since: input.flickAt === null ? Infinity : performance.now() - input.flickAt,
        mine: this.items.get(input.me),
        lighting: this.lightingMine(input.me),
        skin: input.lighterSkin,
        pack: packSkin,
      });
    }
    this.drawParticles(pen);
  }

  private drawParticles(pen: S.Pen) {
    const colors = this.style.puffColors;
    for (const p of this.particles) {
      const k = p.age / p.life;
      if (p.kind === 'bit') {
        pen.px(p.x, p.y, p.color);
      } else {
        const size = k < 0.25 ? 1 : k < 0.6 ? 2 : 3;
        const color = colors[Math.min(colors.length - 1, Math.floor(k * colors.length))] ?? S.SMOKE[0];
        // Dither out over the last stretch of life.
        if (k > 0.8 && Math.floor(this.t * 20 + p.seed) % 2 === 0) continue;
        S.drawPuff(pen, p.x, p.y, size, color);
      }
    }
  }

  hit(x: number, y: number, me: string): Hit | null {
    if (this.lighterRect && inRect(this.lighterRect, x, y)) return { target: 'lighter' };
    for (let i = this.itemRects.length - 1; i >= 0; i--) {
      const r = this.itemRects[i];
      if (inRect(r, x, y)) return { target: r.id === me ? 'myCig' : 'pack', cigId: r.id };
    }
    return inRect(this.style.body(this.oy), x, y) ? { target: 'pack' } : null;
  }
}
