// Small static renders of skins for the settings screen.

import { type LighterSkin, type PackSkin, PACK_SKINS } from './skins.ts';
import * as S from './sprites.ts';
import { STYLES } from './styles/index.ts';
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

/** A closed pack (or the style's stand-in), cropped to its outline. */
export function packPreview(skin: PackSkin, scale = 2, theme: Theme = 'smoke'): HTMLCanvasElement {
  const style = STYLES[theme];
  const box = style.previewBox;
  const c = pixelCanvas(box.w, box.h, scale);
  const ctx = c.getContext('2d')!;
  ctx.translate(-box.x, -box.y);
  style.drawPreview(new S.Pen(ctx), themedPack(skin, theme));
  return c;
}

/** A lit lighter (or the style's stand-in, mid-action). `pack` colors what it pours. */
export function lighterPreview(skin: LighterSkin, scale = 2, theme: Theme = 'smoke', pack?: PackSkin): HTMLCanvasElement {
  const style = STYLES[theme];
  const c = pixelCanvas(style.toolBox.w, style.toolBox.h, scale);
  style.drawToolPreview(new S.Pen(c.getContext('2d')!), skin, themedPack(pack ?? PACK_SKINS[0], theme));
  return c;
}
