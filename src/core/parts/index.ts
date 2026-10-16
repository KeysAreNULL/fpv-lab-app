/**
 * Parts registry. The single lookup surface for the whole app: index every
 * part, map slots to categories, and expose search.
 *
 * `PartId` comes from `./ids` (derived from the catalog data), so adding a part
 * to a catalog file automatically widens the union — no manual type edit.
 */

import type { Part, PartCategory, PartSlot } from './spec';
import type { PartId } from './ids';
import { frames } from './catalog/frames';
import { motors } from './catalog/motors';
import { props } from './catalog/props';
import { stacks, fcs, escs } from './catalog/electronics';
import { vtxs, cameras, lenses, antennas } from './catalog/video';
import { receivers, txRadios } from './catalog/control';
import { batteries, gpsModules } from './catalog/power';

export * from './spec';
export type { PartId } from './ids';
export { defaultBuilds, emptyBuild, findBuild, DEFAULT_BUILD_ID } from './presets';
export type { BuildSpec } from './presets';

/** Which part categories are valid for each build slot. */
export const SLOT_CATEGORY: Readonly<Record<PartSlot, PartCategory>> = {
  frame: 'frame',
  motor: 'motor',
  fc: 'fc',
  esc: 'esc',
  stack: 'stack',
  vtx: 'vtx',
  camera: 'camera',
  lens: 'lens',
  rx: 'rx',
  tx: 'tx',
  antenna: 'antenna',
  gps: 'gps',
  propA: 'prop',
  propB: 'prop',
  battery1: 'battery',
  battery2: 'battery',
};

export const ALL_PARTS: readonly Part[] = [
  ...frames,
  ...motors,
  ...props,
  ...stacks,
  ...fcs,
  ...escs,
  ...vtxs,
  ...cameras,
  ...lenses,
  ...antennas,
  ...receivers,
  ...txRadios,
  ...batteries,
  ...gpsModules,
];

/** id → part. Built once; never mutated after module init. */
export const PART_INDEX: ReadonlyMap<string, Part> = new Map(ALL_PARTS.map((p) => [p.id, p]));

const byCategory = new Map<PartCategory, Part[]>();
for (const part of ALL_PARTS) {
  const list = byCategory.get(part.category);
  if (list) list.push(part);
  else byCategory.set(part.category, [part]);
}

export const partsOfCategory = (category: PartCategory): readonly Part[] =>
  byCategory.get(category) ?? [];

export const findPart = (id: PartId | null | undefined): Part | null =>
  id ? (PART_INDEX.get(id) ?? null) : null;

/** Human-readable label: "GEPRC Mark5 HD". */
export const partLabel = (id: PartId | null | undefined): string => {
  const part = findPart(id);
  return part ? `${part.brand} ${part.name}` : '—';
};

/** Free-text search across brand, name and spec numbers. */
export function searchParts(query: string, category?: PartCategory): Part[] {
  const q = query.trim().toLowerCase();
  const pool = category ? partsOfCategory(category) : ALL_PARTS;
  if (!q) return [...pool];
  return pool.filter((p) => {
    if (`${p.brand} ${p.name} ${p.id}`.toLowerCase().includes(q)) return true;
    // Also match bare numbers so typing "2020" finds the 2020KV motor.
    const numeric = `${p.id} ${p.name}`.match(/\d+(\.\d+)?/g);
    return numeric ? numeric.some((n) => n.startsWith(q)) : false;
  });
}

/** Slot options are every part of the slot's category, cheapest first. */
export const partsForSlot = (slot: PartSlot): readonly Part[] =>
  [...partsOfCategory(SLOT_CATEGORY[slot])].sort((a, b) => a.priceUsd - b.priceUsd);
