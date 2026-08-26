/**
 * The playback engine.
 *
 * Why this is not the real simulation
 * ----------------------------------
 * `packages/sim` answers "given these button presses and this brush soup, where does the
 * hull end up". A strat board answers a different question: "where should this player be at
 * 12.4 seconds". Routing a drawn path through the sim would require Dust 2 to exist as real
 * brushes before you could draw a single arrow, and would turn every timing tweak into a
 * collision-solver debugging session.
 *
 * So this is a kinematic animator — straight legs, steady-state speeds — that borrows the
 * sim's units, its XZ frame and its movement speeds (see `units.ts`). That is enough for the
 * thing that actually matters: a Long push takes as long here as it does in game, so
 * "the smoke lands as entry crosses Long Doors" is a claim you can check.
 *
 * Timing model
 * ------------
 * Each leg's duration is *derived* from its length and its `mode`, cascading from the
 * actor's `startTick`. A waypoint with an explicit `arriveTick` pins that moment instead,
 * and the leg into it is stretched or squeezed to hit it. Derived timings keep a hand-drawn
 * path honest; pins let you nail the one beat that has to be exact. `impliedSpeed` on the
 * resolved leg reports what a pin actually demands, so the UI can flag "that is faster than
 * a player can run".
 */

import { distance, heading, lerp, lerpAngle } from './geometry.js'
import { UTILITY, ROUND, SPEED, TICK_HZ, flightTicks, travelTicks } from './units.js'
import type {
  Actor,
  ActorFrame,
  Layer,
  MoveMode,
  Play,
  PlayFrame,
  UtilityEvent,
  UtilityFrame,
  Vec2,
} from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Resolved tracks
// ─────────────────────────────────────────────────────────────────────────────

/** One leg of a resolved path: either a move between two points, or a stationary hold. */
export interface Leg {
  readonly fromTick: number
  readonly toTick: number
  readonly from: Vec2
  readonly to: Vec2
  readonly layer: Layer
  readonly mode: MoveMode
  readonly holding: boolean
  readonly length: number
  /** Units/second this leg actually demands. Exceeds `SPEED.run` only when over-pinned. */
  readonly impliedSpeed: number
  /** Facing at the start and end of the leg, so the actor turns as it walks. */
  readonly fromFacing: number
  readonly toFacing: number
  readonly note?: string
}

export interface ResolvedTrack {
  readonly actorId: string
  readonly startTick: number
  readonly endTick: number
  readonly legs: readonly Leg[]
  /** Position before `startTick` and after `endTick`. */
  readonly spawnAt: Vec2
  readonly spawnFacing: number
  readonly spawnLayer: Layer
  /** True if any leg demands more speed than a player can produce. */
  readonly overSpeed: boolean
}

/**
 * Turns an actor's waypoint list into timed legs.
 *
 * Runs once per actor per edit; the app caches the result against an edit counter rather
 * than recomputing it 60 times a second.
 */
export function resolveActor(actor: Actor): ResolvedTrack {
  const first = actor.path[0]
  if (first === undefined) {
    // An actor with no path at all is still legal — it means "stands on spawn".
    return {
      actorId: actor.id,
      startTick: actor.startTick,
      endTick: actor.startTick,
      legs: [],
      spawnAt: { x: 0, z: 0 },
      spawnFacing: 0,
      spawnLayer: 'ground',
      overSpeed: false,
    }
  }

  const legs: Leg[] = []
  let cursorTick = actor.startTick
  let prev = first
  // Facing before the first leg: the waypoint's own if set, else towards the next point.
  const second = actor.path[1]
  let facing = first.facing ?? (second === undefined ? 0 : heading(first.at, second.at))
  const spawnFacing = facing
  let overSpeed = false

  // A hold on the *first* waypoint means "wait on spawn before setting off".
  if (first.holdTicks > 0) {
    legs.push({
      fromTick: cursorTick,
      toTick: cursorTick + first.holdTicks,
      from: first.at,
      to: first.at,
      layer: first.layer,
      mode: 'hold',
      holding: true,
      length: 0,
      impliedSpeed: 0,
      fromFacing: facing,
      toFacing: facing,
      ...(first.note === undefined ? {} : { note: first.note }),
    })
    cursorTick += first.holdTicks
  }

  for (let i = 1; i < actor.path.length; i++) {
    const wp = actor.path[i]
    if (wp === undefined) continue

    const len = distance(prev.at, wp.at)
    const derived = wp.mode === 'hold' ? 0 : travelTicks(len, wp.mode)

    // A pin wins, but never runs time backwards — a leg is at least one tick long so that
    // `sampleTrack`'s search stays monotonic and there are no zero-width divisions.
    const toTick =
      wp.arriveTick === undefined
        ? cursorTick + Math.max(wp.mode === 'hold' ? 0 : 1, derived)
        : Math.max(cursorTick + 1, wp.arriveTick)

    const ticks = toTick - cursorTick
    const impliedSpeed = ticks > 0 ? (len / ticks) * TICK_HZ : 0
    if (impliedSpeed > SPEED.run + 0.5) overSpeed = true

    const toFacing = wp.facing ?? (len > 0 ? heading(prev.at, wp.at) : facing)

    legs.push({
      fromTick: cursorTick,
      toTick,
      from: prev.at,
      to: wp.at,
      layer: wp.layer,
      mode: wp.mode,
      holding: wp.mode === 'hold' || len === 0,
      length: len,
      impliedSpeed,
      fromFacing: facing,
      toFacing,
      ...(wp.note === undefined ? {} : { note: wp.note }),
    })

    cursorTick = toTick
    facing = toFacing

    if (wp.holdTicks > 0) {
      legs.push({
        fromTick: cursorTick,
        toTick: cursorTick + wp.holdTicks,
        from: wp.at,
        to: wp.at,
        layer: wp.layer,
        mode: 'hold',
        holding: true,
        length: 0,
        impliedSpeed: 0,
        fromFacing: facing,
        toFacing: facing,
        ...(wp.note === undefined ? {} : { note: wp.note }),
      })
      cursorTick += wp.holdTicks
    }

    prev = wp
  }

  return {
    actorId: actor.id,
    startTick: actor.startTick,
    endTick: cursorTick,
    legs,
    spawnAt: first.at,
    spawnFacing,
    spawnLayer: first.layer,
    overSpeed,
  }
}

/**
 * Samples a resolved track at `tick`.
 *
 * `tick` is fractional on purpose: playback interpolates at the monitor's refresh rate
 * rather than stepping at 64 Hz, which is the difference between smooth and strobing.
 */
export function sampleTrack(track: ResolvedTrack, tick: number): ActorFrame {
  const base = {
    actorId: track.actorId,
    layer: track.spawnLayer,
    speed: 0,
  }

  if (track.legs.length === 0 || tick <= track.startTick) {
    return {
      ...base,
      at: track.spawnAt,
      facing: track.spawnFacing,
      mode: 'hold' as const,
      finished: track.legs.length === 0,
      waiting: tick < track.startTick,
    }
  }

  const last = track.legs[track.legs.length - 1]
  if (last !== undefined && tick >= last.toTick) {
    return {
      ...base,
      at: last.to,
      facing: last.toFacing,
      layer: last.layer,
      mode: 'hold' as const,
      finished: true,
      waiting: false,
    }
  }

  const leg = findLeg(track.legs, tick)
  if (leg === undefined) {
    return {
      ...base,
      at: track.spawnAt,
      facing: track.spawnFacing,
      mode: 'hold' as const,
      finished: false,
      waiting: false,
    }
  }

  const span = leg.toTick - leg.fromTick
  const t = span > 0 ? (tick - leg.fromTick) / span : 1

  return {
    actorId: track.actorId,
    at: leg.holding ? leg.to : lerp(leg.from, leg.to, t),
    facing: lerpAngle(leg.fromFacing, leg.toFacing, Math.min(1, t * 2)),
    layer: leg.layer,
    mode: leg.mode,
    finished: false,
    waiting: false,
    speed: leg.impliedSpeed,
    ...(leg.note === undefined ? {} : { note: leg.note }),
  }
}

/** Binary search for the leg containing `tick`. Legs are monotonic by construction. */
function findLeg(legs: readonly Leg[], tick: number): Leg | undefined {
  let lo = 0
  let hi = legs.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const leg = legs[mid]
    if (leg === undefined) break
    if (tick < leg.fromTick) hi = mid - 1
    else if (tick >= leg.toTick) lo = mid + 1
    else return leg
  }
  return undefined
}

/** Where along its path the actor is, 0..1. Drives the "walked so far" path trail. */
export function trackProgress(track: ResolvedTrack, tick: number): number {
  const total = track.endTick - track.startTick
  if (total <= 0) return 1
  return Math.max(0, Math.min(1, (tick - track.startTick) / total))
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

/** Detonation tick for an event: explicit if pinned, else derived from throw distance. */
export function detonationTick(ev: UtilityEvent): number {
  if (ev.detonateTick !== undefined) return Math.max(ev.throwTick, ev.detonateTick)
  return ev.throwTick + flightTicks(distance(ev.from, ev.to))
}

/** The tick at which an event has completely finished doing anything. */
export function utilityEndTick(ev: UtilityEvent): number {
  const spec = UTILITY[ev.kind]
  return detonationTick(ev) + spec.activeTicks + spec.fadeTicks
}

/**
 * State of one piece of utility at `tick`, or undefined if it is not in play yet / any more.
 *
 * The bloom and fade ramps are not cosmetic. A smoke that snaps to full opacity the frame it
 * lands reads as instant cover, and people then write plays that depend on cover they will
 * not actually have for another second.
 */
export function sampleUtility(ev: UtilityEvent, tick: number): UtilityFrame | undefined {
  const spec = UTILITY[ev.kind]
  const pop = detonationTick(ev)
  const activeEnd = pop + spec.activeTicks
  const end = activeEnd + spec.fadeTicks

  if (tick < ev.throwTick || tick >= end) return undefined

  const common = {
    eventId: ev.id,
    kind: ev.kind,
    layer: ev.layer,
    ...(ev.note === undefined ? {} : { note: ev.note }),
  }

  if (tick < pop) {
    const span = pop - ev.throwTick
    const t = span > 0 ? (tick - ev.throwTick) / span : 1
    return {
      ...common,
      phase: 'flight',
      at: throwArcPoint(ev.from, ev.to, t),
      radius: 0,
      intensity: 1,
    }
  }

  if (tick < activeEnd) {
    const bloom = spec.bloomTicks > 0 ? Math.min(1, (tick - pop) / spec.bloomTicks) : 1
    return {
      ...common,
      phase: 'active',
      at: ev.to,
      radius: spec.radius * bloom,
      intensity: bloom,
    }
  }

  const fade = spec.fadeTicks > 0 ? 1 - (tick - activeEnd) / spec.fadeTicks : 0
  return {
    ...common,
    phase: 'fading',
    at: ev.to,
    radius: spec.radius,
    intensity: Math.max(0, fade),
  }
}

/**
 * Position of a grenade in flight.
 *
 * Straight line in plan view — which is what a top-down drawing shows anyway — with a small
 * lateral bow so a throw reads as an arc rather than a laser. Purely a legibility choice;
 * the timing comes from `flightTicks`.
 */
function throwArcPoint(from: Vec2, to: Vec2, t: number): Vec2 {
  const straight = lerp(from, to, t)
  const dx = to.x - from.x
  const dz = to.z - from.z
  const len = Math.sqrt(dx * dx + dz * dz)
  if (len === 0) return straight
  // Perpendicular offset, peaking at the midpoint, capped so long throws do not banana.
  const bow = Math.min(60, len * 0.06) * Math.sin(t * Math.PI)
  return { x: straight.x + (-dz / len) * bow, z: straight.z + (dx / len) * bow }
}

// ─────────────────────────────────────────────────────────────────────────────
// Whole-play sampling
// ─────────────────────────────────────────────────────────────────────────────

/** Resolves every actor once. Cache this; do not call it per frame. */
export function resolvePlay(play: Play): readonly ResolvedTrack[] {
  return play.actors.map(resolveActor)
}

/**
 * Natural length of a play: the last thing that happens, plus a two-second tail so the end
 * of the animation is watchable rather than a hard cut.
 */
export function playDurationTicks(play: Play): number {
  let end = 0
  for (const track of resolvePlay(play)) end = Math.max(end, track.endTick)
  for (const ev of play.utility) end = Math.max(end, utilityEndTick(ev))
  for (const a of play.annotations) if (a.untilTick >= 0) end = Math.max(end, a.untilTick)
  if (play.plant !== null) end = Math.max(end, play.plant.tick + ROUND.PLANT_TICKS)
  return Math.max(ROUND.DEFAULT_DURATION_TICKS, end + 2 * TICK_HZ)
}

/**
 * Everything the renderer needs for one tick. The single entry point into the engine.
 *
 * Takes pre-resolved tracks so the caller controls when the (comparatively expensive)
 * resolution happens.
 */
export function frameAt(play: Play, tracks: readonly ResolvedTrack[], tick: number): PlayFrame {
  const actors: ActorFrame[] = []
  for (const track of tracks) actors.push(sampleTrack(track, tick))

  const utility: UtilityFrame[] = []
  for (const ev of play.utility) {
    const frame = sampleUtility(ev, tick)
    if (frame !== undefined) utility.push(frame)
  }

  const annotations = play.annotations.filter(
    (a) => tick >= a.fromTick && (a.untilTick < 0 || tick < a.untilTick),
  )

  return {
    tick,
    actors,
    utility,
    annotations,
    planted: play.plant !== null && tick >= play.plant.tick + ROUND.PLANT_TICKS,
  }
}
