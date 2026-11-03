// Personal look of the pack: size, style and skins. Saved on this device only and
// never sent to the hub, so teammates never see it. Shared between this device's
// windows (desktop) or tabs (browser) so changes apply immediately.

import { isDesktop } from './platform.ts';
import { LIGHTER_SKINS, PACK_SKINS } from './widget/skins.ts';
import { type Theme, isTheme } from './widget/theme.ts';

/** Whole-number scales keep the pixel art crisp. */
export const SIZES = [
  { scale: 2, label: 'S' },
  { scale: 3, label: 'M' },
  { scale: 4, label: 'L' },
  { scale: 5, label: 'XL' },
  { scale: 6, label: 'XXL' },
];
const MIN_SCALE = SIZES[0].scale;
const MAX_SCALE = SIZES[SIZES.length - 1].scale;

export interface Appearance {
  scale: number;
  pack: string;
  lighter: string;
  /** Smoke break or water break. */
  theme: Theme;
}

const KEY = 'sb:appearance';
const EVENT = 'appearance-changed';
const DEFAULTS: Appearance = { scale: 3, pack: PACK_SKINS[0].id, lighter: LIGHTER_SKINS[0].id, theme: 'smoke' };

export function clampScale(scale: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(scale)));
}

export function loadAppearance(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Appearance>;
    return {
      ...DEFAULTS,
      ...saved,
      scale: clampScale(saved.scale ?? DEFAULTS.scale),
      theme: isTheme(saved.theme) ? saved.theme : DEFAULTS.theme,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

const listeners = new Set<(a: Appearance) => void>();

export function onAppearanceChange(fn: (a: Appearance) => void) {
  listeners.add(fn);
}

function notify(a: Appearance) {
  for (const fn of listeners) fn(a);
}

export function saveAppearance(patch: Partial<Appearance>) {
  const next = { ...loadAppearance(), ...patch };
  next.scale = clampScale(next.scale);
  localStorage.setItem(KEY, JSON.stringify(next));
  notify(next);
  if (isDesktop) void import('@tauri-apps/api/event').then((m) => m.emit(EVENT, next));
}

// Changes made in other tabs (browser) or other windows (desktop).
window.addEventListener('storage', (e) => {
  if (e.key === KEY) notify(loadAppearance());
});
if (isDesktop) {
  void import('@tauri-apps/api/event').then((m) => m.listen<Appearance>(EVENT, (e) => notify(e.payload)));
}
