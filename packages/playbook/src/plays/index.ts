/** Bundled example plays, copied into the local library the first time the app runs. */

import type { Play } from '../types.js'
import { DUST2_PLAYS } from './dust2.js'

export { DUST2_PLAYS }

export const EXAMPLE_PLAYS: readonly Play[] = [...DUST2_PLAYS]

export function examplesForMap(mapId: string): readonly Play[] {
  return EXAMPLE_PLAYS.filter((p) => p.mapId === mapId)
}
