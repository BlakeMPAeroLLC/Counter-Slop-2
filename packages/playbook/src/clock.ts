/**
 * Playback clock.
 *
 * Deliberately has no idea what time it is. The host passes `dt` from its animation frame
 * loop and the clock advances by that much — which makes stepping, scrubbing and rate
 * changes exactly reproducible in a test, and means a dropped frame slows playback rather
 * than teleporting the playhead.
 */

import { TICK_HZ } from './units.js'
import type { MoveMode } from './types.js'

export interface Clock {
  /** Fractional tick. Fractional so rendering is smooth between the 64 Hz grid points. */
  readonly tick: number
  readonly playing: boolean
  /** Playback rate multiplier. 0.25 is the useful one for picking apart a peek. */
  readonly rate: number
  readonly loop: boolean
  /** Loop / scrub range. `outTick` of -1 means "to the end of the play". */
  readonly inTick: number
  readonly outTick: number
  readonly durationTicks: number
}

export const RATES: readonly number[] = [0.1, 0.25, 0.5, 1, 2, 4]

export function createClock(durationTicks: number): Clock {
  return {
    tick: 0,
    playing: false,
    rate: 1,
    loop: true,
    inTick: 0,
    outTick: -1,
    durationTicks,
  }
}

/** Effective end of the scrub range. */
export function rangeEnd(clock: Clock): number {
  return clock.outTick < 0 ? clock.durationTicks : Math.min(clock.outTick, clock.durationTicks)
}

/** Advances by `dtSeconds` of wall time, honouring rate, range and loop. */
export function advance(clock: Clock, dtSeconds: number): Clock {
  if (!clock.playing) return clock
  const end = rangeEnd(clock)
  const next = clock.tick + dtSeconds * TICK_HZ * clock.rate

  if (next < end) return { ...clock, tick: next }
  if (clock.loop) {
    const span = end - clock.inTick
    // Wrap rather than reset so a 4x loop does not stutter at the seam.
    const wrapped = span > 0 ? clock.inTick + ((next - clock.inTick) % span) : clock.inTick
    return { ...clock, tick: wrapped }
  }
  return { ...clock, tick: end, playing: false }
}

/** Jumps to an absolute tick, clamped to the scrub range. */
export function seek(clock: Clock, tick: number): Clock {
  return { ...clock, tick: Math.max(clock.inTick, Math.min(rangeEnd(clock), tick)) }
}

export function nudge(clock: Clock, deltaTicks: number): Clock {
  // Round to the tick grid first, so repeated single-tick steps from a fractional playhead
  // land on whole ticks instead of drifting.
  return seek(clock, Math.round(clock.tick) + deltaTicks)
}

export function setPlaying(clock: Clock, playing: boolean): Clock {
  // Restarting from the very end should replay, not sit there doing nothing.
  if (playing && clock.tick >= rangeEnd(clock)) return { ...clock, playing, tick: clock.inTick }
  return { ...clock, playing }
}

export function togglePlaying(clock: Clock): Clock {
  return setPlaying(clock, !clock.playing)
}

/** Steps the rate to the next/previous entry in `RATES`. */
export function stepRate(clock: Clock, direction: 1 | -1): Clock {
  const index = RATES.indexOf(clock.rate)
  const from = index === -1 ? RATES.indexOf(1) : index
  const next = Math.max(0, Math.min(RATES.length - 1, from + direction))
  return { ...clock, rate: RATES[next] ?? 1 }
}

export function setDuration(clock: Clock, durationTicks: number): Clock {
  const clamped = Math.max(TICK_HZ, durationTicks)
  return {
    ...clock,
    durationTicks: clamped,
    tick: Math.min(clock.tick, clamped),
    outTick: clock.outTick < 0 ? -1 : Math.min(clock.outTick, clamped),
    inTick: Math.min(clock.inTick, Math.max(0, clamped - 1)),
  }
}

/** Human-readable mode label, used by the HUD readout. */
export const MODE_LABEL: Readonly<Record<MoveMode, string>> = {
  run: 'Running',
  walk: 'Walking',
  crouch: 'Crouching',
  hold: 'Holding',
}
