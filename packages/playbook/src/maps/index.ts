/**
 * Map registry.
 *
 * Adding a map means writing one data module and adding it to `MAPS`. Nothing in the
 * renderer, the editor or the playback engine knows a map by name.
 */

import type { MapDef } from '../types.js'
import { DUST2 } from './dust2.js'

export { DUST2 }

export const MAPS: readonly MapDef[] = [DUST2]

export const DEFAULT_MAP_ID = DUST2.id

export function findMap(id: string): MapDef | undefined {
  return MAPS.find((m) => m.id === id)
}

/** Looks up a map, falling back to the default rather than throwing on a stale play file. */
export function mapOrDefault(id: string): MapDef {
  return findMap(id) ?? DUST2
}
