// Small static renders of skins for the settings screen.

import type { LighterSkin, Liquid, PackSkin } from './skins.ts';
import * as S from './sprites.ts';
import { type Theme, themedPack } from './theme.ts';

function pixelCanvas(w: number, h: number, scale: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.style.width = `${w * scale}px`;
  c.style.height = `${h * scale}px`;
  c.style.imageRendering = 'pixelated';
  return c;
}

/** A closed pack (or a full water cooler), cropped to its outline. */
export function packPreview(skin: PackSkin, scale = 2, theme: Theme = 'smoke'): HTMLCanvasElement {
  if (theme === 'water') {
    const bottom = S.MOUTH_Y + S.BODY_H;
    const c = pixelCanvas(S.COOLER_W, bottom - S.JUG_TOP, scale);
    const ctx = c.getContext('2d')!;
    ctx.translate(-S.COOLER_X, -S.JUG_TOP);
    S.drawCooler(new S.Pen(ctx), 0, themedPack(skin, theme), 1, 0, false);
    return c;
  }
  const c = pixelCanvas(S.PACK_W, S.LID_H + S.BODY_H, scale);
  const ctx = c.getContext('2d')!;
  ctx.translate(-S.PACK_X, -(S.MOUTH_Y - S.LID_H));
  S.drawPackFront(new S.Pen(ctx), 0, 0, themedPack(skin, theme));
  return c;
}

/** A lit lighter (or a cup being filled, for water breaks). */
export function lighterPreview(skin: LighterSkin, scale = 2, theme: Theme = 'smoke', liquid?: Liquid): HTMLCanvasElement {
  const c = pixelCanvas(8, 21, scale);
  S.drawLighter(new S.Pen(c.getContext('2d')!), 0, 20, 'flame', 0, skin, theme, liquid);
  return c;
}
