/**
 * Part id union, derived from the catalog data.
 *
 * Kept separate from `index.ts` so `presets.ts` can reference `PartId` without
 * creating an import cycle (index re-exports presets).
 */

import type { frames } from './catalog/frames';
import type { motors } from './catalog/motors';
import type { props } from './catalog/props';
import type { escs, fcs, stacks } from './catalog/electronics';
import type { antennas, cameras, lenses, vtxs } from './catalog/video';
import type { receivers, txRadios } from './catalog/control';
import type { batteries, gpsModules } from './catalog/power';

/** Every part id in the catalog, as a literal union. */
export type PartId =
  | (typeof frames)[number]['id']
  | (typeof motors)[number]['id']
  | (typeof props)[number]['id']
  | (typeof stacks)[number]['id']
  | (typeof fcs)[number]['id']
  | (typeof escs)[number]['id']
  | (typeof vtxs)[number]['id']
  | (typeof cameras)[number]['id']
  | (typeof lenses)[number]['id']
  | (typeof antennas)[number]['id']
  | (typeof receivers)[number]['id']
  | (typeof txRadios)[number]['id']
  | (typeof batteries)[number]['id']
  | (typeof gpsModules)[number]['id'];
