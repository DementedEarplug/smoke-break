// What a break style (smoke, water, ...) plugs into the scene. The scene keeps
// track of who's in the break, the timer, the lighter and particles; a style
// decides what each person's item looks like, how it gets lit, and draws it.

import type { Phase } from '../../../shared/protocol.ts';
import type { LighterSkin, PackSkin } from '../skins.ts';
import type { FlameState, Pen } from '../sprites.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One person's item: a cigarette, a cup, ... */
export interface Item {
  id: string;
  name: string;
  x: number;
  targetX: number;
  /** 0–1 popping in when they join. */
  appear: number;
  /** 0–1 toward being taken (pulled out, filled, ...); follows `wantRise`. */
  rise: number;
  /** 1 once they've lit up. */
  wantRise: number;
  lit: boolean;
  /** 0 in the container, 1 standing beside it. */
  out: number;
  /** Where it stands once out. */
  standX: number;
  standY: number;
  /** My item only: 0–1 moving into place for the tool. */
  turn: number;
  /** 0–1 time spent being lit by the tool. */
  ignite: number;
  /** 0–1 stubbing out at the end. */
  stub: number;
  removing: null | 'stub' | 'sink';
  seed: number;
  /** Style bookkeeping, e.g. the last ash length seen. */
  lastAsh: number;
  nextPuff: number;
}

/** What the scene exposes to styles. */
export interface SceneView {
  readonly t: number;
  /** The break's phase, if there is one. */
  readonly phase: Phase | null;
  /** Idle bob offset this frame. */
  readonly oy: number;
  /** Lid: 0 closed, 1 open. */
  readonly flap: number;
  readonly lighterShow: number;
  /** 0 resting, 1 raised to my item. */
  readonly lighterLift: number;
  readonly lengthMin: number;
  /** 1 at the start of a break, 0 when it's burned down. */
  readonly burnFrac: number;
  readonly remainingMs: number;
  readonly minuteMs: number;
  readonly litAt: number | null;
  readonly items: ReadonlyMap<string, Item>;
  /** Highest drawn row, for anchoring the bubble. */
  contentTop: number;
  /** A rising puff (smoke, steam). */
  puff(x: number, y: number): void;
  /** A falling bit (ash, crumbs). */
  bit(x: number, y: number, vx: number, color: string): void;
  /** Register where an item was drawn, for clicks. */
  hitItem(r: Rect, id: string): void;
}

export interface Tool {
  /** performance.now() since the last flick. */
  since: number;
  /** My item, if I'm in the break. */
  mine: Item | undefined;
  /** My item is on its way to being lit. */
  lighting: boolean;
  skin: LighterSkin;
  pack: PackSkin;
}

export interface BreakStyle {
  /** Top row of the container art, for the do-not-disturb Z and the bubble. */
  readonly top: number;
  /** Puff colors, young to old. */
  readonly puffColors: string[];
  /** My item goes to the tool, so it stays up while my item is being lit. */
  readonly travels: boolean;
  /** Nothing of the style's own is still animating. */
  readonly settled: boolean;
  /** Span of the ground shadow, if it isn't the pack's. */
  readonly shadow?: { x: number; w: number };
  /** Where `n` items sit in the container. */
  layout(n: number): { start: number; spacing: number };
  /** Where the `slot`th of `count` lit items stands. */
  stand(slot: number, count: number): [x: number, y: number];
  /** Advance an item that's still in the break. */
  animate(v: Item, mine: boolean, view: SceneView, dt: number): void;
  /** The item has finished getting lit. */
  caught(v: Item): boolean;
  /** Puffs when an item catches or is stubbed out. */
  burst(v: Item, view: SceneView): void;
  /** Style-wide animation, e.g. the jug draining. */
  update(view: SceneView, breakOn: boolean, dt: number): void;
  /** The container and everyone's items. */
  draw(view: SceneView, packPen: Pen, pen: Pen, skin: PackSkin): void;
  /** The lighter or its stand-in; returns where it was drawn, for clicks. */
  drawTool(view: SceneView, pen: Pen, tool: Tool): Rect;
  /** The container, for clicks. */
  body(oy: number): Rect;
}

export interface StyleModule {
  create(): BreakStyle;
  /** Crop for skin previews, in scene pixels. */
  previewBox: Rect;
  /** A resting container, for skin previews. */
  drawPreview(pen: Pen, skin: PackSkin): void;
  /** Canvas size for tool previews. */
  toolBox: { w: number; h: number };
  /** The tool mid-action, for skin previews. */
  drawToolPreview(pen: Pen, skin: LighterSkin, pack: PackSkin): void;
}

export const FLICK_SPARK_MS = 160;
export const FLICK_MS = 900;

/** Spark, then flame, then nothing after a flick. */
export const flickFlame = (since: number): FlameState => (since < FLICK_SPARK_MS ? 'spark' : since < FLICK_MS ? 'flame' : 'none');

export const approach = (v: number, target: number, step: number) =>
  v < target ? Math.min(target, v + step) : Math.max(target, v - step);
export const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
export const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
