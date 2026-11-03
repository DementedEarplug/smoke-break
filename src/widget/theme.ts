// Break styles. "smoke" is a cigarette pack and a lighter; "water" is a water
// cooler whose jug drains as the timer, with a cup to fill instead of a lighter,
// for anyone who'd rather not see smoking.
// Personal, like skins: teammates can use different styles for the same break.

import type { PackSkin } from './skins.ts';

export type Theme = 'smoke' | 'water';

export const THEMES: { id: Theme; name: string }[] = [
  { id: 'smoke', name: 'Smoke' },
  { id: 'water', name: 'Water' },
];

export interface ThemeCopy {
  title: string;
  /** "a 12-min smoke break" */
  breakName: string;
  lightUp: string;
  lastMinute: string;
  /** Hint after the time left when hovering your own lit item. */
  leaveLit: string;
  /** Toast when clicking the pack while you're already in. */
  leaveToast: string;
  packLabel: string;
  lighterLabel: string;
  myPack: string;
}

export const COPY: Record<Theme, ThemeCopy> = {
  smoke: {
    title: 'Smoke Break',
    breakName: 'smoke break',
    lightUp: 'Light up?',
    lastMinute: 'Last drag!',
    leaveLit: 'Click to stub out',
    leaveToast: 'Click your cigarette to stub out',
    packLabel: 'Pack',
    lighterLabel: 'Lighter',
    myPack: 'My pack',
  },
  water: {
    title: 'Water Break',
    breakName: 'water break',
    lightUp: 'Drink up?',
    lastMinute: 'Last sip!',
    leaveLit: 'Click to head back',
    leaveToast: 'Click your cup to head back',
    packLabel: 'Cooler',
    lighterLabel: 'Cup',
    myPack: 'My cooler',
  },
};

export const isTheme = (v: unknown): v is Theme => v === 'smoke' || v === 'water';

/** Water coolers wear the pack skin's colors with an H2O label. */
export function themedPack(skin: PackSkin, theme: Theme): PackSkin {
  return theme === 'water' ? { ...skin, monogram: 'H2O' } : skin;
}
