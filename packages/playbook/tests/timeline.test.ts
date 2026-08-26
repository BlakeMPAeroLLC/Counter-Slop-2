import { describe, expect, it } from 'vitest'
import { makeUtility, makeWaypoint, newId } from '../src/play.js'
import {
  detonationTick,
  frameAt,
  playDurationTicks,
  resolveActor,
  resolvePlay,
  sampleTrack,
  sampleUtility,
  trackProgress,
  utilityEndTick,
} from '../src/timeline.js'
import { ROUND, SPEED, TICK_HZ, UTILITY } from '../src/units.js'
import type { Actor, Play, Waypoint } from '../src/types.js'

const v = (x: number, z: number) => ({ x, z })

function actorWith(path: Waypoint[], startTick = 0): Actor {
  return { id: 'a1', team: 'T', name: 'Entry', color: '#fff', startTick, path }
}

function emptyPlay(overrides: Partial<Play> = {}): Play {
  return {
    id: 'p1',
    name: 'test',
    mapId: 'dust2',
    description: '',
    side: 'T',
    durationTicks: ROUND.DEFAULT_DURATION_TICKS,
    actors: [],
    utility: [],
    annotations: [],
    plant: null,
    ...overrides,
  }
}

describe('resolveActor timing', () => {
  it('derives a leg from distance and run speed', () => {
    const track = resolveActor(actorWith([makeWaypoint(v(0, 0)), makeWaypoint(v(SPEED.run, 0))]))
    expect(track.legs).toHaveLength(1)
    expect(track.legs[0]?.toTick).toBe(TICK_HZ)
  })

  it('makes a walked leg take longer than the same leg run', () => {
    const run = resolveActor(actorWith([makeWaypoint(v(0, 0)), makeWaypoint(v(1000, 0), { mode: 'run' })]))
    const walk = resolveActor(actorWith([makeWaypoint(v(0, 0)), makeWaypoint(v(1000, 0), { mode: 'walk' })]))
    expect(walk.endTick).toBeGreaterThan(run.endTick)
    expect(walk.endTick / run.endTick).toBeCloseTo(SPEED.run / SPEED.walk, 1)
  })

  it('offsets the whole path by startTick, for a staggered execute', () => {
    const track = resolveActor(actorWith([makeWaypoint(v(0, 0)), makeWaypoint(v(250, 0))], 5 * TICK_HZ))
    expect(track.legs[0]?.fromTick).toBe(5 * TICK_HZ)
    expect(track.endTick).toBe(6 * TICK_HZ)
  })

  it('inserts a stationary leg for a hold', () => {
    const track = resolveActor(
      actorWith([
        makeWaypoint(v(0, 0)),
        makeWaypoint(v(250, 0), { holdTicks: 2 * TICK_HZ }),
        makeWaypoint(v(500, 0)),
      ]),
    )
    const hold = track.legs.find((l) => l.holding)
    expect(hold).toBeDefined()
    expect(hold?.toTick).toBe(3 * TICK_HZ)
    expect(track.endTick).toBe(4 * TICK_HZ)
  })

  it('treats a hold on the first waypoint as waiting on spawn', () => {
    const track = resolveActor(
      actorWith([makeWaypoint(v(0, 0), { holdTicks: TICK_HZ }), makeWaypoint(v(250, 0))]),
    )
    expect(track.legs[0]?.holding).toBe(true)
    expect(track.endTick).toBe(2 * TICK_HZ)
  })

  it('honours a pinned arrival time over the derived one', () => {
    const track = resolveActor(
      actorWith([makeWaypoint(v(0, 0)), makeWaypoint(v(250, 0), { arriveTick: 10 * TICK_HZ })]),
    )
    expect(track.legs[0]?.toTick).toBe(10 * TICK_HZ)
    // Same distance over ten times the time: a tenth of the speed.
    expect(track.legs[0]?.impliedSpeed).toBeCloseTo(SPEED.run / 10, 1)
  })

  it('flags a pin that demands more speed than a player has', () => {
    const track = resolveActor(
      actorWith([makeWaypoint(v(0, 0)), makeWaypoint(v(5000, 0), { arriveTick: TICK_HZ })]),
    )
    expect(track.overSpeed).toBe(true)
  })

  it('never lets a pin run time backwards', () => {
    const track = resolveActor(
      actorWith([
        makeWaypoint(v(0, 0)),
        makeWaypoint(v(1000, 0), { arriveTick: 10 * TICK_HZ }),
        // A pin earlier than its predecessor must still produce a forward-moving leg.
        makeWaypoint(v(2000, 0), { arriveTick: 2 * TICK_HZ }),
      ]),
    )
    let previous = -1
    for (const leg of track.legs) {
      expect(leg.toTick).toBeGreaterThan(previous)
      previous = leg.toTick
    }
  })

  it('accepts an actor with no path at all', () => {
    const track = resolveActor(actorWith([]))
    expect(track.legs).toHaveLength(0)
    expect(track.endTick).toBe(track.startTick)
  })
})

describe('sampleTrack', () => {
  const track = resolveActor(
    actorWith([makeWaypoint(v(0, 0)), makeWaypoint(v(SPEED.run * 2, 0))], TICK_HZ),
  )

  it('parks on spawn and reports waiting before startTick', () => {
    const f = sampleTrack(track, 0)
    expect(f.at).toEqual(v(0, 0))
    expect(f.waiting).toBe(true)
  })

  it('interpolates mid-leg', () => {
    const f = sampleTrack(track, TICK_HZ + TICK_HZ) // one second into a two-second leg
    expect(f.at.x).toBeCloseTo(SPEED.run, 0)
    expect(f.waiting).toBe(false)
    expect(f.finished).toBe(false)
  })

  it('lands exactly on the endpoint at the end of the path', () => {
    const f = sampleTrack(track, track.endTick)
    expect(f.at.x).toBeCloseTo(SPEED.run * 2)
    expect(f.finished).toBe(true)
  })

  it('stays put after the path ends rather than drifting', () => {
    const a = sampleTrack(track, track.endTick + 1)
    const b = sampleTrack(track, track.endTick + 10_000)
    expect(a.at).toEqual(b.at)
  })

  it('samples at a fractional tick, so rendering can be smoother than 64 Hz', () => {
    const a = sampleTrack(track, TICK_HZ + 10.25)
    const b = sampleTrack(track, TICK_HZ + 10.75)
    expect(b.at.x).toBeGreaterThan(a.at.x)
  })

  it('reports the leg note while that leg is being walked', () => {
    const noted = resolveActor(
      actorWith([makeWaypoint(v(0, 0)), makeWaypoint(v(250, 0), { note: 'quietly' })]),
    )
    expect(sampleTrack(noted, 32).note).toBe('quietly')
  })
})

describe('trackProgress', () => {
  it('runs 0 to 1 across the path', () => {
    const track = resolveActor(actorWith([makeWaypoint(v(0, 0)), makeWaypoint(v(250, 0))]))
    expect(trackProgress(track, 0)).toBe(0)
    expect(trackProgress(track, TICK_HZ / 2)).toBeCloseTo(0.5)
    expect(trackProgress(track, TICK_HZ * 5)).toBe(1)
  })
})

describe('utility phases', () => {
  const smoke = makeUtility('smoke', v(0, 0), v(750, 0), 100)

  it('derives detonation from throw distance', () => {
    expect(detonationTick(smoke)).toBeGreaterThan(smoke.throwTick)
    const near = makeUtility('smoke', v(0, 0), v(10, 0), 100)
    expect(detonationTick(near)).toBeLessThan(detonationTick(smoke))
  })

  it('honours an explicit detonation tick', () => {
    const pinned = makeUtility('smoke', v(0, 0), v(750, 0), 100, { detonateTick: 500 })
    expect(detonationTick(pinned)).toBe(500)
  })

  it('is absent before the throw and after the fade', () => {
    expect(sampleUtility(smoke, smoke.throwTick - 1)).toBeUndefined()
    expect(sampleUtility(smoke, utilityEndTick(smoke))).toBeUndefined()
  })

  it('walks flight -> active -> fading', () => {
    const pop = detonationTick(smoke)
    const spec = UTILITY.smoke
    expect(sampleUtility(smoke, smoke.throwTick)?.phase).toBe('flight')
    expect(sampleUtility(smoke, pop - 1)?.phase).toBe('flight')
    expect(sampleUtility(smoke, pop)?.phase).toBe('active')
    expect(sampleUtility(smoke, pop + spec.activeTicks - 1)?.phase).toBe('active')
    expect(sampleUtility(smoke, pop + spec.activeTicks)?.phase).toBe('fading')
  })

  it('has no radius in flight and full radius once bloomed', () => {
    const pop = detonationTick(smoke)
    expect(sampleUtility(smoke, smoke.throwTick)?.radius).toBe(0)
    const bloomed = sampleUtility(smoke, pop + UTILITY.smoke.bloomTicks)
    expect(bloomed?.radius).toBeCloseTo(UTILITY.smoke.radius)
  })

  it('blooms rather than snapping to full cover', () => {
    const pop = detonationTick(smoke)
    const early = sampleUtility(smoke, pop + 1)?.radius ?? 0
    const later = sampleUtility(smoke, pop + UTILITY.smoke.bloomTicks / 2)?.radius ?? 0
    expect(early).toBeLessThan(later)
    expect(later).toBeLessThan(UTILITY.smoke.radius)
  })

  it('lands the flight arc on the target', () => {
    const pop = detonationTick(smoke)
    const landed = sampleUtility(smoke, pop)
    expect(landed?.at).toEqual(smoke.to)
  })
})

describe('playDurationTicks', () => {
  it('has a sensible floor for an empty play', () => {
    expect(playDurationTicks(emptyPlay())).toBe(ROUND.DEFAULT_DURATION_TICKS)
  })

  it('covers the longest actor plus a watchable tail', () => {
    const long = actorWith([makeWaypoint(v(0, 0)), makeWaypoint(v(250 * 90, 0))])
    const duration = playDurationTicks(emptyPlay({ actors: [long] }))
    expect(duration).toBeGreaterThan(resolveActor(long).endTick)
  })

  it('covers a piece of utility that outlasts every path', () => {
    const late = makeUtility('smoke', v(0, 0), v(100, 0), 80 * TICK_HZ)
    const duration = playDurationTicks(emptyPlay({ utility: [late] }))
    expect(duration).toBeGreaterThanOrEqual(utilityEndTick(late))
  })
})

describe('frameAt', () => {
  const actor = actorWith([makeWaypoint(v(0, 0)), makeWaypoint(v(1000, 0))])
  const play = emptyPlay({
    actors: [actor],
    utility: [makeUtility('flash', v(0, 0), v(500, 0), 5 * TICK_HZ)],
    annotations: [
      {
        id: newId('note'),
        kind: 'text',
        points: [v(0, 0)],
        layer: 'ground',
        text: 'window',
        color: '#fff',
        fromTick: 2 * TICK_HZ,
        untilTick: 4 * TICK_HZ,
      },
      {
        id: newId('note'),
        kind: 'text',
        points: [v(0, 0)],
        layer: 'ground',
        text: 'forever',
        color: '#fff',
        fromTick: 0,
        untilTick: -1,
      },
    ],
    plant: { at: v(1000, 0), tick: 10 * TICK_HZ },
  })

  it('samples every actor', () => {
    expect(frameAt(play, resolvePlay(play), 32).actors).toHaveLength(1)
  })

  it('omits utility that is not in play at that tick', () => {
    expect(frameAt(play, resolvePlay(play), 0).utility).toHaveLength(0)
    expect(frameAt(play, resolvePlay(play), 5 * TICK_HZ).utility).toHaveLength(1)
  })

  it('respects annotation visibility windows', () => {
    const early = frameAt(play, resolvePlay(play), TICK_HZ).annotations
    expect(early.map((a) => a.text)).toEqual(['forever'])

    const mid = frameAt(play, resolvePlay(play), 3 * TICK_HZ).annotations
    expect(mid.map((a) => a.text).sort()).toEqual(['forever', 'window'])
  })

  it('reports the bomb as planted only after the plant animation finishes', () => {
    expect(frameAt(play, resolvePlay(play), 10 * TICK_HZ).planted).toBe(false)
    expect(frameAt(play, resolvePlay(play), 10 * TICK_HZ + ROUND.PLANT_TICKS).planted).toBe(true)
  })
})
