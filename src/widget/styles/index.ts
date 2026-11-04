// Break styles by id.

import type { Theme } from '../theme.ts';
import { coffee } from './coffee.ts';
import { smoke } from './smoke.ts';
import type { StyleModule } from './style.ts';
import { water } from './water.ts';

export const STYLES: Record<Theme, StyleModule> = { smoke, water, coffee, donut: smoke };
