import type { Theme } from './theme.ts';

// Cosmetic skins for your own pack and lighter. Personal: they change how the
// pack looks on your screen only.

export type PackStyle =
  /** Colored top whose lower edge peaks in the middle (the classic look). */
  | 'chevron'
  /** Straight colored band across the top. */
  | 'band'
  /** Fully colored pack with a framed label. */
  | 'solid';

export interface PackSkin {
  id: string;
  name: string;
  style: PackStyle;
  main: string;
  mainLight: string;
  mainDark: string;
  /** Seam between lid and body when closed. */
  crease: string;
  /** Trim line under the colored part (or the label frame for `solid`). */
  trim: string;
  base: string;
  baseShade: string;
  baseBottom: string;
  label: string;
  /** Two letters on the front. */
  monogram: string;
  /** Only offered for these break styles (others fall back to Classic). */
  only?: Theme[];
  /** What's in the cooler, if not plain water. */
  drink?: Drink;
}

export interface Liquid {
  main: string;
  light: string;
  dark: string;
  surface: string;
}

export interface Drink {
  liquid: Liquid;
  /** Bits floating in the jug: [color, highlight]. */
  fruit: [string, string][];
  /** The team's cups: light, body, shade. */
  cup: [string, string, string];
}

export const WATER: Liquid = { main: '#4aa8e8', light: '#9ad8ff', dark: '#2a78c0', surface: '#c8eeff' };

export interface FlamePalette {
  outer: string;
  mid: string;
  core: string;
  base: string;
}

export interface LighterSkin {
  id: string;
  name: string;
  body: string;
  light: string;
  shade: string;
  accent: string;
  cap: string;
  capShade: string;
  /** Horizontal stripes that replace the body color, top to bottom. */
  stripes?: string[];
  flame: FlamePalette;
}

const FIRE: FlamePalette = { outer: '#ff7a20', mid: '#ffd040', core: '#fff6c0', base: '#4a80ff' };
const TORCH: FlamePalette = { outer: '#2a6aff', mid: '#6ab0ff', core: '#e8f6ff', base: '#a0e0ff' };
const WITCH: FlamePalette = { outer: '#3ac06a', mid: '#9af06a', core: '#f0ffd0', base: '#2a8a5a' };
const CHROME = { cap: '#d8d8e0', capShade: '#9a9aa8' };

export const PACK_SKINS: PackSkin[] = [
  {
    id: 'classic',
    name: 'Classic',
    style: 'chevron',
    main: '#d23a3a',
    mainLight: '#ff6a5a',
    mainDark: '#a82a35',
    crease: '#8f1f2e',
    trim: '#e6b34a',
    base: '#f4ecd8',
    baseShade: '#d8ccb4',
    baseBottom: '#e0d4bc',
    label: '#d23a3a',
    monogram: 'SB',
  },
  {
    id: 'menthol',
    name: 'Menthol',
    style: 'band',
    main: '#2f9e63',
    mainLight: '#5fd08e',
    mainDark: '#1f6b45',
    crease: '#185436',
    trim: '#bfe8cf',
    base: '#eef6ef',
    baseShade: '#cfe0d2',
    baseBottom: '#dbe9dc',
    label: '#2f9e63',
    monogram: 'MT',
  },
  {
    id: 'midnight',
    name: 'Midnight',
    style: 'solid',
    main: '#2b2838',
    mainLight: '#4a4560',
    mainDark: '#1f1c2a',
    crease: '#14111c',
    trim: '#e6b34a',
    base: '#2b2838',
    baseShade: '#1f1c2a',
    baseBottom: '#24212f',
    label: '#f0c860',
    monogram: 'SB',
  },
  {
    id: 'ultra',
    name: 'Ultra Blue',
    style: 'chevron',
    main: '#3a6ad2',
    mainLight: '#6a9af2',
    mainDark: '#244a9a',
    crease: '#1c3a7a',
    trim: '#c8d4e8',
    base: '#f2f4f8',
    baseShade: '#cfd6e2',
    baseBottom: '#dde3ec',
    label: '#3a6ad2',
    monogram: 'UB',
  },
  {
    id: 'bubblegum',
    name: 'Bubblegum',
    style: 'band',
    main: '#e85a9a',
    mainLight: '#ff8ac0',
    mainDark: '#b03a72',
    crease: '#8a2a58',
    trim: '#ffe08a',
    base: '#fff0f6',
    baseShade: '#ecd0de',
    baseBottom: '#f6dce8',
    label: '#e85a9a',
    monogram: 'XO',
  },
  {
    id: 'desert',
    name: 'Desert',
    style: 'chevron',
    main: '#e0a848',
    mainLight: '#f4c870',
    mainDark: '#a87628',
    crease: '#80581c',
    trim: '#3a5aa8',
    base: '#f6ead0',
    baseShade: '#dccca8',
    baseBottom: '#e8dab8',
    label: '#3a5aa8',
    monogram: 'DR',
  },
  {
    id: 'toxic',
    name: 'Toxic',
    style: 'solid',
    main: '#7ad83a',
    mainLight: '#b0f070',
    mainDark: '#4a9a20',
    crease: '#3a7a18',
    trim: '#1a1020',
    base: '#f0ff60',
    baseShade: '#c8d840',
    baseBottom: '#e0f050',
    label: '#1a1020',
    monogram: 'TX',
  },
  {
    // Party punch for when the water needs some kick (but isn't Toxic).
    id: 'jungle',
    name: 'Jungle Juice',
    style: 'solid',
    main: '#2f8a3a',
    mainLight: '#5fc05a',
    mainDark: '#1f5a28',
    crease: '#174a20',
    trim: '#ffb040',
    base: '#fff2d8',
    baseShade: '#e8d4b0',
    baseBottom: '#f2e2c0',
    label: '#e8307a',
    monogram: 'JJ',
    only: ['water'],
    drink: {
      liquid: { main: '#e8307a', light: '#ff7aa8', dark: '#a81850', surface: '#ffb0c8' },
      fruit: [
        ['#ffa020', '#ffd070'],
        ['#7ad83a', '#c8f890'],
        ['#c81830', '#ff5a6a'],
      ],
      cup: ['#ff6a6a', '#d23a3a', '#8f1f2e'],
    },
  },
];

export const LIGHTER_SKINS: LighterSkin[] = [
  { id: 'classic', name: 'Teal', body: '#3aa0c8', light: '#7ad8f0', shade: '#246a8a', accent: '#ffd040', ...CHROME, flame: FIRE },
  { id: 'red', name: 'Red', body: '#d23a3a', light: '#ff7a6a', shade: '#8f1f2e', accent: '#ffffff', ...CHROME, flame: FIRE },
  {
    id: 'zippo',
    name: 'Gold',
    body: '#e6b34a',
    light: '#fff0a0',
    shade: '#a87a20',
    accent: '#c89030',
    cap: '#f0c860',
    capShade: '#b88a30',
    flame: FIRE,
  },
  { id: 'onyx', name: 'Onyx', body: '#2b2838', light: '#4a4560', shade: '#16131e', accent: '#ff5a8a', ...CHROME, flame: FIRE },
  { id: 'neon', name: 'Neon', body: '#ff4fd8', light: '#ff9cf0', shade: '#b0209a', accent: '#4ff0ff', ...CHROME, flame: FIRE },
  {
    id: 'rainbow',
    name: 'Rainbow',
    body: '#ffe060',
    light: '#ffffff',
    shade: '#a06aff',
    accent: '#ffffff',
    stripes: ['#ff5a5a', '#ff5a5a', '#ffb040', '#ffe060', '#ffe060', '#5ad070', '#4a9aff', '#4a9aff', '#a06aff', '#a06aff'],
    ...CHROME,
    flame: FIRE,
  },
  {
    id: 'torch',
    name: 'Torch',
    body: '#3a3a48',
    light: '#6a6a7a',
    shade: '#202028',
    accent: '#ff7a20',
    cap: '#8a8a98',
    capShade: '#5a5a68',
    flame: TORCH,
  },
  {
    id: 'witch',
    name: 'Witchy',
    body: '#6a3aa8',
    light: '#9a6ad8',
    shade: '#42206e',
    accent: '#9af06a',
    ...CHROME,
    flame: WITCH,
  },
];

export const packSkin = (id: string) => PACK_SKINS.find((s) => s.id === id) ?? PACK_SKINS[0];
export const lighterSkin = (id: string) => LIGHTER_SKINS.find((s) => s.id === id) ?? LIGHTER_SKINS[0];
