/**
 * Play file format.
 *
 * A `.play.json` file is the durable artefact — the thing you commit next to your team's
 * notes, diff when someone tweaks a timing, and hand to a player. So two properties matter
 * more than compactness:
 *
 *   1. **Stable key order.** Keys are written in a fixed order so re-saving an unchanged play
 *      produces a byte-identical file and a real change produces a small, readable diff.
 *   2. **Loud, specific rejection.** `parsePlay` validates shape and says which field is
 *      wrong, rather than handing the renderer a half-play that crashes three frames later.
 */

import { ROUND } from './units.js'
import type {
  Actor,
  Annotation,
  AnnotationKind,
  Layer,
  MoveMode,
  Play,
  Team,
  UtilityEvent,
  UtilityKind,
  Vec2,
  Waypoint,
} from './types.js'

/** Bumped only for a change that older readers cannot handle. */
export const SCHEMA_VERSION = 1

export interface PlayFile {
  readonly schema: number
  readonly play: Play
  /** ISO timestamp, informational only. */
  readonly savedAt: string
}

export class PlayParseError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (at ${path})`)
    this.name = 'PlayParseError'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing
// ─────────────────────────────────────────────────────────────────────────────

function vecOut(v: Vec2): Record<string, number> {
  return { x: round2(v.x), z: round2(v.z) }
}

/**
 * Rounds a *position* to two decimals on the way out.
 *
 * Drag positions are floats and nobody cares about the 14th decimal place of a crate corner.
 * Truncating keeps files small and, more importantly, stops a mouse jitter of 1e-13 units
 * from showing up as a diff.
 */
function round2(n: number): number {
  // `|| 0` collapses -0 to 0. Without it a coordinate dragged to exactly zero from the
  // negative side serialises as `0` and reloads unequal to what was saved.
  return Math.round(n * 100) / 100 || 0
}


function waypointOut(w: Waypoint): Record<string, unknown> {
  return {
    id: w.id,
    at: vecOut(w.at),
    mode: w.mode,
    layer: w.layer,
    holdTicks: w.holdTicks,
    ...(w.arriveTick === undefined ? {} : { arriveTick: w.arriveTick }),
    // Angles are written verbatim, not rounded like positions are. They are radians, so
    // even five decimals of quantisation would perturb a facing of exactly -PI/2 and break
    // an exact save/load round trip — and a handful of full-precision floats per play is not
    // a file size worth defending.
    ...(w.facing === undefined ? {} : { facing: w.facing }),
    ...(w.note === undefined ? {} : { note: w.note }),
  }
}

function actorOut(a: Actor): Record<string, unknown> {
  return {
    id: a.id,
    team: a.team,
    name: a.name,
    color: a.color,
    startTick: a.startTick,
    path: a.path.map(waypointOut),
  }
}

function utilityOut(u: UtilityEvent): Record<string, unknown> {
  return {
    id: u.id,
    kind: u.kind,
    actorId: u.actorId,
    from: vecOut(u.from),
    to: vecOut(u.to),
    layer: u.layer,
    throwTick: u.throwTick,
    ...(u.detonateTick === undefined ? {} : { detonateTick: u.detonateTick }),
    ...(u.note === undefined ? {} : { note: u.note }),
  }
}

function annotationOut(a: Annotation): Record<string, unknown> {
  return {
    id: a.id,
    kind: a.kind,
    points: a.points.map(vecOut),
    layer: a.layer,
    text: a.text,
    color: a.color,
    fromTick: a.fromTick,
    untilTick: a.untilTick,
  }
}

/** Serialises to a plain object with deterministic key order. */
export function toPlayFile(play: Play, savedAt: string): Record<string, unknown> {
  return {
    schema: SCHEMA_VERSION,
    savedAt,
    play: {
      id: play.id,
      name: play.name,
      mapId: play.mapId,
      description: play.description,
      side: play.side,
      durationTicks: play.durationTicks,
      actors: play.actors.map(actorOut),
      utility: play.utility.map(utilityOut),
      annotations: play.annotations.map(annotationOut),
      plant: play.plant === null ? null : { at: vecOut(play.plant.at), tick: play.plant.tick },
    },
  }
}

/** Pretty-printed JSON, ready to write to disk. */
export function stringifyPlay(play: Play, savedAt = new Date().toISOString()): string {
  return `${JSON.stringify(toPlayFile(play, savedAt), null, 2)}\n`
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

const MOVE_MODES: readonly string[] = ['run', 'walk', 'crouch', 'hold']
const LAYERS: readonly string[] = ['lower', 'ground', 'upper']
const UTILITY_KINDS: readonly string[] = ['smoke', 'flash', 'molotov', 'he', 'decoy']
const ANNOTATION_KINDS: readonly string[] = ['arrow', 'text', 'zone']
const TEAMS: readonly string[] = ['T', 'CT']

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PlayParseError('expected an object', path)
  }
  return value as Record<string, unknown>
}

function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new PlayParseError('expected an array', path)
  return value
}

function str(value: unknown, path: string, fallback?: string): string {
  if (typeof value === 'string') return value
  if (fallback !== undefined) return fallback
  throw new PlayParseError('expected a string', path)
}

function num(value: unknown, path: string, fallback?: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (fallback !== undefined) return fallback
  throw new PlayParseError('expected a finite number', path)
}

function oneOf<T extends string>(value: unknown, allowed: readonly string[], path: string, fallback?: T): T {
  if (typeof value === 'string' && allowed.includes(value)) return value as T
  if (fallback !== undefined) return fallback
  throw new PlayParseError(`expected one of ${allowed.join(', ')}`, path)
}

function vecIn(value: unknown, path: string): Vec2 {
  const o = obj(value, path)
  return { x: num(o['x'], `${path}.x`), z: num(o['z'], `${path}.z`) }
}

function optNum(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined
  return num(value, path)
}

function optStr(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return str(value, path)
}

function waypointIn(value: unknown, path: string): Waypoint {
  const o = obj(value, path)
  const arriveTick = optNum(o['arriveTick'], `${path}.arriveTick`)
  const facing = optNum(o['facing'], `${path}.facing`)
  const note = optStr(o['note'], `${path}.note`)
  return {
    id: str(o['id'], `${path}.id`),
    at: vecIn(o['at'], `${path}.at`),
    mode: oneOf<MoveMode>(o['mode'], MOVE_MODES, `${path}.mode`, 'run'),
    layer: oneOf<Layer>(o['layer'], LAYERS, `${path}.layer`, 'ground'),
    holdTicks: Math.max(0, Math.round(num(o['holdTicks'], `${path}.holdTicks`, 0))),
    ...(arriveTick === undefined ? {} : { arriveTick: Math.round(arriveTick) }),
    ...(facing === undefined ? {} : { facing }),
    ...(note === undefined ? {} : { note }),
  }
}

function actorIn(value: unknown, path: string): Actor {
  const o = obj(value, path)
  const rawPath = arr(o['path'], `${path}.path`)
  if (rawPath.length === 0) throw new PlayParseError('an actor needs at least one waypoint', `${path}.path`)
  return {
    id: str(o['id'], `${path}.id`),
    team: oneOf<Team>(o['team'], TEAMS, `${path}.team`),
    name: str(o['name'], `${path}.name`, 'Player'),
    color: str(o['color'], `${path}.color`, '#cccccc'),
    startTick: Math.max(0, Math.round(num(o['startTick'], `${path}.startTick`, 0))),
    path: rawPath.map((w, i) => waypointIn(w, `${path}.path[${i}]`)),
  }
}

function utilityIn(value: unknown, path: string): UtilityEvent {
  const o = obj(value, path)
  const detonateTick = optNum(o['detonateTick'], `${path}.detonateTick`)
  const note = optStr(o['note'], `${path}.note`)
  const actorId = o['actorId']
  return {
    id: str(o['id'], `${path}.id`),
    kind: oneOf<UtilityKind>(o['kind'], UTILITY_KINDS, `${path}.kind`),
    actorId: typeof actorId === 'string' ? actorId : null,
    from: vecIn(o['from'], `${path}.from`),
    to: vecIn(o['to'], `${path}.to`),
    layer: oneOf<Layer>(o['layer'], LAYERS, `${path}.layer`, 'ground'),
    throwTick: Math.max(0, Math.round(num(o['throwTick'], `${path}.throwTick`, 0))),
    ...(detonateTick === undefined ? {} : { detonateTick: Math.round(detonateTick) }),
    ...(note === undefined ? {} : { note }),
  }
}

function annotationIn(value: unknown, path: string): Annotation {
  const o = obj(value, path)
  return {
    id: str(o['id'], `${path}.id`),
    kind: oneOf<AnnotationKind>(o['kind'], ANNOTATION_KINDS, `${path}.kind`, 'text'),
    points: arr(o['points'], `${path}.points`).map((p, i) => vecIn(p, `${path}.points[${i}]`)),
    layer: oneOf<Layer>(o['layer'], LAYERS, `${path}.layer`, 'ground'),
    text: str(o['text'], `${path}.text`, ''),
    color: str(o['color'], `${path}.color`, '#e8e8e8'),
    fromTick: Math.round(num(o['fromTick'], `${path}.fromTick`, 0)),
    untilTick: Math.round(num(o['untilTick'], `${path}.untilTick`, -1)),
  }
}

/**
 * Parses a play file.
 *
 * Tolerant about *missing* optional fields (they get sane defaults) and strict about
 * *malformed* required ones. A play someone hand-edited should either load or tell them
 * exactly which line they broke.
 */
export function parsePlayFile(value: unknown): Play {
  const root = obj(value, 'root')
  const schema = num(root['schema'], 'schema', 1)
  if (schema > SCHEMA_VERSION) {
    throw new PlayParseError(
      `this play was saved by a newer version of the playbook (schema ${schema}, this build reads ${SCHEMA_VERSION})`,
      'schema',
    )
  }

  const p = obj(root['play'], 'play')
  const plantRaw = p['plant']

  return {
    id: str(p['id'], 'play.id'),
    name: str(p['name'], 'play.name', 'Untitled play'),
    mapId: str(p['mapId'], 'play.mapId', 'dust2'),
    description: str(p['description'], 'play.description', ''),
    side: oneOf<Team>(p['side'], TEAMS, 'play.side', 'T'),
    durationTicks: Math.max(
      64,
      Math.round(num(p['durationTicks'], 'play.durationTicks', ROUND.DEFAULT_DURATION_TICKS)),
    ),
    actors: arr(p['actors'], 'play.actors').map((a, i) => actorIn(a, `play.actors[${i}]`)),
    utility: arr(p['utility'] ?? [], 'play.utility').map((u, i) => utilityIn(u, `play.utility[${i}]`)),
    annotations: arr(p['annotations'] ?? [], 'play.annotations').map((a, i) =>
      annotationIn(a, `play.annotations[${i}]`),
    ),
    plant:
      plantRaw === undefined || plantRaw === null
        ? null
        : {
            at: vecIn(obj(plantRaw, 'play.plant')['at'], 'play.plant.at'),
            tick: Math.max(0, Math.round(num(obj(plantRaw, 'play.plant')['tick'], 'play.plant.tick', 0))),
          },
  }
}

/** Convenience: parse from a JSON string, converting a syntax error into a `PlayParseError`. */
export function parsePlayJson(text: string): Play {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unparseable'
    throw new PlayParseError(`not valid JSON: ${message}`, 'root')
  }
  return parsePlayFile(value)
}
