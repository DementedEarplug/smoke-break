// Break styles. "smoke" is a cigarette pack and a lighter; "water" is a water
// cooler whose jug drains as the timer, with a cup to fill instead of a lighter,
// for anyone who'd rather not see smoking; "coffee" pours everyone a mug from a
// pot that drains as the timer; "donut" is a bakery box of donuts that get eaten.
// Personal, like skins: teammates can use different styles for the same break.

import { PACK_SKINS, type PackSkin } from './skins.ts';

export type Theme = 'smoke' | 'water' | 'coffee' | 'donut';

export const THEMES: { id: Theme; name: string }[] = [
  { id: 'smoke', name: 'Smoke' },
  { id: 'water', name: 'Water' },
  { id: 'coffee', name: 'Coffee' },
  { id: 'donut', name: 'Donut' },
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
  coffee: {
    title: 'Coffee Break',
    breakName: 'coffee break',
    lightUp: 'Pour one?',
    lastMinute: 'Last sip!',
    leaveLit: 'Click to head back',
    leaveToast: 'Click your mug to head back',
    packLabel: 'Coffee maker',
    lighterLabel: 'Pot',
    myPack: 'My coffee maker',
  },
  donut: {
    title: 'Donut Break',
    breakName: 'donut break',
    lightUp: 'Grab one?',
    lastMinute: 'Last bite!',
    leaveLit: 'Click to brush off the crumbs',
    leaveToast: 'Click your donut to head back',
    packLabel: 'Box',
    lighterLabel: 'Sprinkles',
    myPack: 'My donut box',
  },
};

export const isTheme = (v: unknown): v is Theme => THEMES.some((t) => t.id === v);

const MONOGRAMS: Partial<Record<Theme, string>> = { water: 'H2O', coffee: 'JOE', donut: 'YUM' };

/** Skins offered for a style. */
const offered = (skin: PackSkin, theme: Theme) => !skin.only || skin.only.includes(theme);
export const packSkinsFor = (theme: Theme) => PACK_SKINS.filter((s) => offered(s, theme));

/**
 * Other styles wear the pack skin's colors with their own label. Skins made for
 * one style keep theirs, and fall back to Classic elsewhere.
 */
export function themedPack(skin: PackSkin, theme: Theme): PackSkin {
  if (!offered(skin, theme)) skin = PACK_SKINS[0];
  const monogram = MONOGRAMS[theme];
  return skin.only || !monogram ? skin : { ...skin, monogram };
}
