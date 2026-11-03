// Renders the app and tray icons from the real pack sprites.
// Usage: node scripts/make-icons.ts && npx tauri icon src-tauri/icons/source.png

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import * as S from '../src/widget/sprites.ts';

type RGBA = [number, number, number, number];

/** Just enough of CanvasRenderingContext2D for the sprite functions: fillStyle + fillRect. */
class PixelCtx {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array;
  private color: RGBA = [0, 0, 0, 255];

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 4);
  }

  set fillStyle(c: string) {
    this.color = parseColor(c);
  }

  fillRect(x: number, y: number, w: number, h: number) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
        const i = (yy * this.w + xx) * 4;
        this.px.set(this.color, i);
      }
    }
  }
}

function parseColor(c: string): RGBA {
  if (c.startsWith('#')) {
    const n = parseInt(c.slice(1), 16);
    return [n >> 16, (n >> 8) & 255, n & 255, 255];
  }
  const [r, g, b, a = 1] = c.match(/[\d.]+/g)!.map(Number);
  return [r, g, b, Math.round(a * 255)];
}

/** Crop a region and scale it up with nearest-neighbour, padding to a square. */
function crop(ctx: PixelCtx, x0: number, y0: number, size: number, scale: number): { w: number; px: Uint8Array } {
  const w = size * scale;
  const out = new Uint8Array(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x0 + Math.floor(x / scale);
      const sy = y0 + Math.floor(y / scale);
      if (sx < 0 || sy < 0 || sx >= ctx.w || sy >= ctx.h) continue;
      out.set(ctx.px.subarray((sy * ctx.w + sx) * 4, (sy * ctx.w + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return { w, px: out };
}

function png(w: number, px: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(w * (w * 4 + 1));
  for (let y = 0; y < w; y++) {
    raw[y * (w * 4 + 1)] = 0; // no filter
    Buffer.from(px.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = resolve(import.meta.dirname, '../src-tauri/icons');
mkdirSync(outDir, { recursive: true });

// App icon: open pack, one lit cigarette with a wisp of smoke, one waiting.
{
  const ctx = new PixelCtx(S.W, S.H);
  const pen = new S.Pen(ctx as unknown as CanvasRenderingContext2D);
  S.drawPackBack(pen, 1, 0);
  S.drawCig(pen, 21, S.MOUTH_Y - 7, 8, 'unlit', 0);
  S.drawCig(pen, 26, S.MOUTH_Y - 12, 13, 'lit', 1);
  S.drawPackFront(pen, 1, 0);
  S.drawPuff(pen, 28, S.MOUTH_Y - 15, 2, S.SMOKE[1]);
  S.drawPuff(pen, 26, S.MOUTH_Y - 13, 1, S.SMOKE[0]);
  const size = 32;
  const x0 = S.PACK_X + S.PACK_W / 2 - size / 2;
  const y0 = S.MOUTH_Y + S.BODY_H - size;
  const icon = crop(ctx, x0, y0, size, 32);
  writeFileSync(resolve(outDir, 'source.png'), png(icon.w, icon.px));
}

// Tray icon: the closed pack.
{
  const ctx = new PixelCtx(S.W, S.H);
  const pen = new S.Pen(ctx as unknown as CanvasRenderingContext2D);
  S.drawPackFront(pen, 0, 0);
  const tray = crop(ctx, S.PACK_X - 1, S.MOUTH_Y - S.LID_H, 24, 2);
  writeFileSync(resolve(outDir, 'tray.png'), png(tray.w, tray.px));
}

console.log(`Wrote ${outDir}/source.png and tray.png`);
