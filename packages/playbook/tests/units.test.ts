import { describe, expect, it } from 'vitest'
import { MOVE, SIM, TEAM } from '@cs2/sim'
import { SPEED, TEAM_TO_SIM, TICK_HZ, DT, travelTicks, flightTicks, formatTick } from '../src/units.js'

/**
 * The drift guard.
 *
 * `packages/playbook` mirrors a handful of the simulation's numbers rather than importing
 * them, so that a coaching tool does not pull the whole deterministic sim into its bundle
 * (see the docblock in `src/units.ts`). This suite is the price of that decision: if someone
 * retunes movement in the sim, this fails and the mirror gets updated, instead of a coach
 * quietly getting timings that no longer match the game.
 */
describe('sim constant mirror', () => {
  it('mirrors the tick rate', () => {
    expect(TICK_HZ).toBe(SIM.TICK_HZ)
    expect(DT).toBe(SIM.DT)
  })

  it('mirrors the ground movement speeds', () => {
    expect(SPEED.run).toBe(MOVE.RUN)
    expect(SPEED.walk).toBe(MOVE.WALK)
    expect(SPEED.crouch).toBe(MOVE.CROUCH)
  })

  it('maps playbook sides onto the sim team indices', () => {
    expect(TEAM_TO_SIM.T).toBe(TEAM.WRECKERS)
    expect(TEAM_TO_SIM.CT).toBe(TEAM.WARDENS)
  })
})

describe('travelTicks', () => {
  it('reports one second to run 250 units', () => {
    expect(travelTicks(250, 'run')).toBe(64)
  })

  it('scales with the movement mode', () => {
    expect(travelTicks(260, 'walk')).toBe(travelTicks(500, 'run'))
  })

  it('never rounds a leg down to faster than it can be walked', () => {
    // 251 units at 250 u/s is a hair over a second, so it must be at least 65 ticks.
    expect(travelTicks(251, 'run')).toBeGreaterThanOrEqual(65)
  })

  it('costs at least one tick, even for a zero-length leg', () => {
    expect(travelTicks(0, 'run')).toBe(1)
  })

  it('is zero for a hold, which has no distance to cover', () => {
    expect(travelTicks(500, 'hold')).toBe(0)
  })
})

describe('flightTicks', () => {
  it('grows with throw distance', () => {
    expect(flightTicks(2000)).toBeGreaterThan(flightTicks(500))
  })

  it('has a floor so a drop-nade still has a beat of travel', () => {
    expect(flightTicks(0)).toBeGreaterThan(0)
    expect(flightTicks(1)).toBe(flightTicks(0))
  })
})

describe('formatTick', () => {
  it('reads like a demo clock', () => {
    expect(formatTick(0)).toBe('0:00.0')
    expect(formatTick(64)).toBe('0:01.0')
    expect(formatTick(64 * 75)).toBe('1:15.0')
  })
})
