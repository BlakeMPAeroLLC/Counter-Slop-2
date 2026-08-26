/**
 * Map and play validation.
 *
 * Hand-authored geometry is exactly the kind of data that rots quietly: a mistyped
 * coordinate puts a wall through a bombsite and nothing complains until someone draws a play
 * through it. `validateMapDef` runs in CI (see `tests/mapdef.test.ts`), so a malformed
 * polygon is a red build rather than a confusing afternoon.
 */

import { pointInBounds, polylineLength } from './geometry.js'
import type { MapDef, Play } from './types.js'

export interface Issue {
  readonly severity: 'error' | 'warning'
  readonly where: string
  readonly message: string
}

/** Callouts the tool considers non-negotiable for Dust 2 to be usable for real plays. */
export const REQUIRED_DUST2_CALLOUTS: readonly string[] = [
  'T Spawn',
  'CT Spawn',
  'A Site',
  'B Site',
  'Mid',
  'Mid Doors',
  'Top Mid',
  'Catwalk',
  'Short Stairs',
  'Xbox',
  'Long A',
  'Long Doors',
  'Deep Pit',
  'Outside Long',
  'A Cross',
  'A Ramp',
  'CT Mid',
  'Upper Tunnels',
  'Lower Tunnels',
  'B Tunnels',
  'Outside Tunnels',
  'B Doors',
  'B Window',
  'CT Tunnel',
  'Goose',
]

export function validateMapDef(map: MapDef): Issue[] {
  const issues: Issue[] = []
  const seen = new Set<string>()

  if (map.bounds.maxX <= map.bounds.minX || map.bounds.maxZ <= map.bounds.minZ) {
    issues.push({ severity: 'error', where: `${map.id}.bounds`, message: 'bounds are empty or inverted' })
  }

  for (const region of map.regions) {
    const where = `${map.id}.regions.${region.id}`
    if (seen.has(region.id)) {
      issues.push({ severity: 'error', where, message: 'duplicate region id' })
    }
    seen.add(region.id)

    if (region.points.length < 3) {
      issues.push({ severity: 'error', where, message: `a polygon needs 3+ points, has ${region.points.length}` })
      continue
    }
    // A ring whose perimeter is near zero is almost always a copy-paste with one coordinate
    // left unedited, and it renders as an invisible speck rather than an obvious mistake.
    if (polylineLength([...region.points, region.points[0]!]) < 8) {
      issues.push({ severity: 'error', where, message: 'polygon is degenerate (perimeter under 8 units)' })
    }
    for (const p of region.points) {
      if (!pointInBounds(p, map.bounds)) {
        issues.push({
          severity: 'error',
          where,
          message: `vertex (${p.x}, ${p.z}) is outside the map bounds`,
        })
        break
      }
    }
    if (region.kind === 'cover' && region.height <= 0) {
      issues.push({ severity: 'warning', where, message: 'cover with zero height blocks nothing' })
    }
  }

  const calloutNames = new Set<string>()
  for (const c of map.callouts) {
    const where = `${map.id}.callouts.${c.id}`
    if (seen.has(c.id)) issues.push({ severity: 'error', where, message: 'id collides with another element' })
    seen.add(c.id)
    if (calloutNames.has(c.name)) {
      issues.push({ severity: 'error', where, message: `duplicate callout name "${c.name}"` })
    }
    calloutNames.add(c.name)
    if (!pointInBounds(c.at, map.bounds)) {
      issues.push({ severity: 'error', where, message: 'callout label sits outside the map bounds' })
    }
  }

  for (const team of ['T', 'CT'] as const) {
    const count = map.spawns.filter((sp) => sp.team === team).length
    if (count !== 5) {
      issues.push({
        severity: 'error',
        where: `${map.id}.spawns`,
        message: `${team} has ${count} spawn points, expected 5`,
      })
    }
  }

  if (map.bombsites.length === 0) {
    issues.push({ severity: 'warning', where: `${map.id}.bombsites`, message: 'no bombsites defined' })
  }

  return issues
}

/** Checks that a loaded play refers to things that exist. */
export function validatePlay(play: Play, map: MapDef): Issue[] {
  const issues: Issue[] = []

  if (play.mapId !== map.id) {
    issues.push({
      severity: 'warning',
      where: 'play.mapId',
      message: `play was drawn on "${play.mapId}" but is being shown on "${map.id}"`,
    })
  }

  const actorIds = new Set(play.actors.map((a) => a.id))
  for (const ev of play.utility) {
    if (ev.actorId !== null && !actorIds.has(ev.actorId)) {
      issues.push({
        severity: 'warning',
        where: `play.utility.${ev.id}`,
        message: 'attributed to an actor that is not in this play',
      })
    }
  }

  for (const actor of play.actors) {
    for (const wp of actor.path) {
      if (!pointInBounds(wp.at, map.bounds)) {
        issues.push({
          severity: 'warning',
          where: `play.actors.${actor.id}`,
          message: 'a waypoint is outside the map bounds',
        })
        break
      }
    }
  }

  return issues
}

export function errorsOnly(issues: readonly Issue[]): Issue[] {
  return issues.filter((i) => i.severity === 'error')
}

/** Formats issues for a console or a toast. */
export function formatIssues(issues: readonly Issue[]): string {
  return issues.map((i) => `${i.severity === 'error' ? 'ERROR' : 'warn '} ${i.where}: ${i.message}`).join('\n')
}
