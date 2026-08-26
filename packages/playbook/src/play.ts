/**
 * Play construction.
 *
 * IDs are generated with `crypto.randomUUID` when available and a counter+random fallback
 * otherwise. Non-determinism is fine here — this is a drawing tool, not the simulation — but
 * it is confined to this one function so a test can stub it if it ever needs stable output.
 */

import { boundsCenter } from './geometry.js'
import { ROUND, TEAM_COLOR, TICK_HZ } from './units.js'
import type { Actor, Layer, MapDef, MoveMode, Play, Team, UtilityKind, Vec2, Waypoint } from './types.js'

let idCounter = 0

export function newId(prefix: string): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  const uuid = g.crypto?.randomUUID?.()
  if (uuid !== undefined) return `${prefix}_${uuid.slice(0, 8)}`
  idCounter += 1
  return `${prefix}_${idCounter.toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`
}

/** Default roles, in the order a coach usually fills a side. */
const T_ROLES: readonly string[] = ['Entry', 'Support', 'IGL', 'AWP', 'Lurk']
const CT_ROLES: readonly string[] = ['A Anchor', 'A Support', 'AWP', 'B Anchor', 'Rotator']

/**
 * Per-actor colours.
 *
 * Each side gets five distinguishable shades of its team colour rather than five arbitrary
 * hues: at a glance you need to read *which side* first and *which player* second, and a
 * rainbow gets that backwards.
 */
const T_SHADES: readonly string[] = ['#f0b64a', '#e59a2e', '#d4801c', '#f5cf7a', '#c26a15']
const CT_SHADES: readonly string[] = ['#6fb6ee', '#4a9bdb', '#3080c4', '#9ad0f5', '#2569a8']

function shade(team: Team, index: number): string {
  const table = team === 'T' ? T_SHADES : CT_SHADES
  return table[index % table.length] ?? TEAM_COLOR[team]
}

export function makeWaypoint(
  at: Vec2,
  opts: {
    mode?: MoveMode
    layer?: Layer
    holdTicks?: number
    arriveTick?: number
    facing?: number
    note?: string
  } = {},
): Waypoint {
  return {
    id: newId('wp'),
    at,
    mode: opts.mode ?? 'run',
    layer: opts.layer ?? 'ground',
    holdTicks: opts.holdTicks ?? 0,
    ...(opts.arriveTick === undefined ? {} : { arriveTick: opts.arriveTick }),
    ...(opts.facing === undefined ? {} : { facing: opts.facing }),
    ...(opts.note === undefined ? {} : { note: opts.note }),
  }
}

/** Builds one side's five actors, parked on the map's spawn points. */
export function makeSide(map: MapDef, team: Team): Actor[] {
  const spawns = map.spawns.filter((s) => s.team === team)
  const roles = team === 'T' ? T_ROLES : CT_ROLES
  const fallback = boundsCenter(map.bounds)

  return roles.map((role, i) => {
    const spawn = spawns[i % Math.max(1, spawns.length)]
    const at = spawn?.at ?? fallback
    const facing = spawn?.facing ?? 0
    return {
      id: newId('actor'),
      team,
      name: role,
      color: shade(team, i),
      startTick: 0,
      path: [makeWaypoint(at, { mode: 'run', layer: 'ground', facing })],
    }
  })
}

/** A blank play: ten actors on spawn, nothing drawn. */
export function createPlay(map: MapDef, opts: { name?: string; side?: Team } = {}): Play {
  const side = opts.side ?? 'T'
  return {
    id: newId('play'),
    name: opts.name ?? 'Untitled play',
    mapId: map.id,
    description: '',
    side,
    durationTicks: ROUND.DEFAULT_DURATION_TICKS,
    actors: [...makeSide(map, 'T'), ...makeSide(map, 'CT')],
    utility: [],
    annotations: [],
    plant: null,
  }
}

/** Convenience used by the bundled example plays and by the utility tool. */
export function makeUtility(
  kind: UtilityKind,
  from: Vec2,
  to: Vec2,
  throwTick: number,
  opts: { actorId?: string; layer?: Layer; detonateTick?: number; note?: string } = {},
) {
  return {
    id: newId('util'),
    kind,
    actorId: opts.actorId ?? null,
    from,
    to,
    layer: opts.layer ?? ('ground' as Layer),
    throwTick,
    ...(opts.detonateTick === undefined ? {} : { detonateTick: opts.detonateTick }),
    ...(opts.note === undefined ? {} : { note: opts.note }),
  }
}

/** Seconds -> ticks, for readable example-play authoring. */
export function s(seconds: number): number {
  return Math.round(seconds * TICK_HZ)
}
