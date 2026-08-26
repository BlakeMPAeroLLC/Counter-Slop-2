/**
 * Timing and speed constants.
 *
 * Why these are copied rather than imported
 * -----------------------------------------
 * `@cs2/playbook` is a standalone coaching tool. Importing `@cs2/sim` at runtime would drag
 * the whole deterministic simulation — typed-array world state, collision solver, hitscan —
 * into a bundle that only ever needs six numbers, and would couple a drawing tool to the
 * game's release cadence.
 *
 * The numbers below are therefore mirrored, and `tests/units.test.ts` imports `@cs2/sim` as a
 * dev-only dependency and asserts they still match. If someone retunes movement in the sim,
 * that test fails and this file gets updated — the drift is caught by CI rather than by a
 * coach wondering why their timings stopped lining up.
 */

import type { MoveMode, Team, UtilityKind } from './types.js'

/** Mirrors `SIM.TICK_HZ`. */
export const TICK_HZ = 64

/** Mirrors `SIM.DT`. */
export const DT = 1 / 64

/**
 * Ground speeds in units/second. Mirrors `MOVE.RUN` / `MOVE.WALK` / `MOVE.CROUCH`.
 *
 * These are *steady-state* speeds and ignore the ~0.3 s acceleration ramp out of a standing
 * start. Over the 20-40 unit legs a coach actually draws that error is under a tenth of a
 * second, and pretending a player instantly reaches full speed keeps a hand-drawn path's
 * timing legible instead of subtly wrong in a way nobody can correct for.
 */
export const SPEED: Readonly<Record<MoveMode, number>> = {
  run: 250,
  walk: 130,
  crouch: 90,
  hold: 0,
}

/** Maps the playbook's CS vocabulary onto the sim's team indices (`TEAM` in constants.ts). */
export const TEAM_TO_SIM: Readonly<Record<Team, number>> = {
  /** Attackers -> WRECKERS. */
  T: 0,
  /** Defenders -> WARDENS. */
  CT: 1,
}

/** Default per-team colours. Warm for attackers, cool for defenders. */
export const TEAM_COLOR: Readonly<Record<Team, string>> = {
  T: '#e0a33e',
  CT: '#5aa9e6',
}

/**
 * Nominal grenade release speed in units/second for a standard (full-power) throw.
 *
 * Real grenades follow a ballistic arc whose travel time depends on release pitch, so this
 * is a flat approximation calibrated so a mid-length smoke lands around 1.1 s after release
 * — close enough that "throw on the flash" stays in sync.
 */
export const NADE_SPEED = 750

/** Minimum flight time, so a drop-smoke at your feet still has a beat of travel. */
export const NADE_MIN_FLIGHT_TICKS = 12

/**
 * Utility lifetimes and effect radii.
 *
 * `activeTicks` runs from detonation. `radius` is the sight-blocking or damage radius in sim
 * units — a smoke is a ~144 unit sphere, a molotov spreads wider and flatter, and an HE's
 * ring is the outer edge of where it still does meaningful damage.
 */
export interface UtilitySpec {
  readonly activeTicks: number
  readonly radius: number
  /** Ticks over which the effect ramps up after detonation. */
  readonly bloomTicks: number
  /** Ticks over which it fades out at the end of its life. */
  readonly fadeTicks: number
  readonly color: string
  readonly label: string
}

export const UTILITY: Readonly<Record<UtilityKind, UtilitySpec>> = {
  smoke: {
    activeTicks: 18 * TICK_HZ,
    radius: 144,
    bloomTicks: Math.round(0.9 * TICK_HZ),
    fadeTicks: Math.round(1.5 * TICK_HZ),
    color: '#cfd6dd',
    label: 'Smoke',
  },
  flash: {
    // The bang is instant; this is how long a full flash actually blinds for.
    activeTicks: Math.round(1.9 * TICK_HZ),
    radius: 520,
    bloomTicks: 2,
    fadeTicks: Math.round(1.2 * TICK_HZ),
    color: '#f4f0c0',
    label: 'Flash',
  },
  molotov: {
    activeTicks: 7 * TICK_HZ,
    radius: 190,
    bloomTicks: Math.round(0.5 * TICK_HZ),
    fadeTicks: Math.round(1.0 * TICK_HZ),
    color: '#e8703a',
    label: 'Molotov',
  },
  he: {
    activeTicks: Math.round(0.35 * TICK_HZ),
    radius: 350,
    bloomTicks: 1,
    fadeTicks: Math.round(0.3 * TICK_HZ),
    color: '#8fd15a',
    label: 'HE',
  },
  decoy: {
    activeTicks: 15 * TICK_HZ,
    radius: 120,
    bloomTicks: 2,
    fadeTicks: Math.round(0.5 * TICK_HZ),
    color: '#b58ce8',
    label: 'Decoy',
  },
}

/** Round structure, in ticks. Freeze time is excluded — tick 0 is the gates opening. */
export const ROUND = {
  /** Competitive round length before the bomb is planted: 1:55. */
  LENGTH_TICKS: 115 * TICK_HZ,
  /** Bomb timer: 40 s. */
  BOMB_TICKS: 40 * TICK_HZ,
  /** Default length of a freshly created play: 45 s of execute is plenty to start. */
  DEFAULT_DURATION_TICKS: 45 * TICK_HZ,
  /** Defuse times with and without a kit. */
  DEFUSE_TICKS: 10 * TICK_HZ,
  DEFUSE_KIT_TICKS: 5 * TICK_HZ,
  /** Time to plant. */
  PLANT_TICKS: Math.round(3.2 * TICK_HZ),
} as const

/** Ticks -> seconds. */
export function ticksToSeconds(ticks: number): number {
  return ticks * DT
}

/** Seconds -> whole ticks, rounded to nearest so a typed "1.5s" is exact. */
export function secondsToTicks(seconds: number): number {
  return Math.round(seconds * TICK_HZ)
}

/** Formats a tick as `M:SS.d`, the way a demo clock reads. */
export function formatTick(ticks: number): string {
  const total = ticksToSeconds(ticks)
  const sign = total < 0 ? '-' : ''
  const abs = Math.abs(total)
  const minutes = Math.floor(abs / 60)
  const seconds = abs - minutes * 60
  const padded = seconds < 10 ? `0${seconds.toFixed(1)}` : seconds.toFixed(1)
  return `${sign}${minutes}:${padded}`
}

/** How long it takes to cover `distance` units in `mode`, in whole ticks. */
export function travelTicks(distance: number, mode: MoveMode): number {
  const speed = SPEED[mode]
  if (speed <= 0) return 0
  // Ceil rather than round: a leg must never be reported as faster than it can be walked.
  return Math.max(1, Math.ceil((distance / speed) * TICK_HZ))
}

/** Grenade flight time for a throw of `distance` units. */
export function flightTicks(distance: number): number {
  return Math.max(NADE_MIN_FLIGHT_TICKS, Math.ceil((distance / NADE_SPEED) * TICK_HZ))
}

Object.freeze(SPEED)
Object.freeze(TEAM_TO_SIM)
Object.freeze(TEAM_COLOR)
Object.freeze(UTILITY)
Object.freeze(ROUND)
