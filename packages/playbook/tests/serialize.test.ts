import { describe, expect, it } from 'vitest'
import {
  PlayParseError,
  SCHEMA_VERSION,
  parsePlayFile,
  parsePlayJson,
  stringifyPlay,
  toPlayFile,
} from '../src/serialize.js'
import { createPlay } from '../src/play.js'
import { DUST2 } from '../src/maps/dust2.js'
import { DUST2_PLAYS } from '../src/plays/dust2.js'

describe('round trip', () => {
  it('preserves a blank play exactly', () => {
    const play = createPlay(DUST2)
    expect(parsePlayJson(stringifyPlay(play, 'fixed'))).toEqual(play)
  })

  it('preserves every bundled example, which use every feature', () => {
    for (const play of DUST2_PLAYS) {
      const back = parsePlayJson(stringifyPlay(play, 'fixed'))
      expect(back).toEqual(play)
    }
  })

  it('is byte-stable for an unchanged play, so files diff cleanly', () => {
    const play = DUST2_PLAYS[0]
    expect(play).toBeDefined()
    if (play === undefined) return
    const a = stringifyPlay(play, 'fixed')
    const b = stringifyPlay(parsePlayJson(a), 'fixed')
    expect(b).toBe(a)
  })

  it('rounds coordinates so mouse jitter does not show up as a diff', () => {
    const play = createPlay(DUST2)
    const jittered = {
      ...play,
      actors: play.actors.map((a, i) =>
        i !== 0
          ? a
          : {
              ...a,
              path: a.path.map((w) => ({ ...w, at: { x: 12.3456789, z: -9.87654321 } })),
            },
      ),
    }
    const text = stringifyPlay(jittered, 'fixed')
    expect(text).toContain('12.35')
    expect(text).not.toContain('12.3456')
  })
})

describe('rejection', () => {
  it('rejects non-JSON with a useful message', () => {
    expect(() => parsePlayJson('{ not json')).toThrow(PlayParseError)
  })

  it('rejects a newer schema rather than guessing', () => {
    expect(() => parsePlayFile({ schema: SCHEMA_VERSION + 5, play: {} })).toThrow(/newer version/)
  })

  it('names the field that is wrong', () => {
    let message = ''
    try {
      parsePlayFile({
        schema: 1,
        play: {
          id: 'p',
          actors: [{ id: 'a', team: 'T', path: [{ id: 'w', at: { x: 'nope', z: 0 } }] }],
        },
      })
    } catch (err) {
      message = err instanceof Error ? err.message : ''
    }
    expect(message).toContain('play.actors[0].path[0].at.x')
  })

  it('rejects an unknown team rather than silently picking one', () => {
    expect(() =>
      parsePlayFile({
        schema: 1,
        play: { id: 'p', actors: [{ id: 'a', team: 'GIGANTIC', path: [{ id: 'w', at: { x: 0, z: 0 } }] }] },
      }),
    ).toThrow(/expected one of/)
  })

  it('rejects an actor with no waypoints, which has nowhere to stand', () => {
    expect(() =>
      parsePlayFile({ schema: 1, play: { id: 'p', actors: [{ id: 'a', team: 'T', path: [] }] } }),
    ).toThrow(/at least one waypoint/)
  })
})

describe('tolerance', () => {
  it('fills in missing optional sections', () => {
    const play = parsePlayFile({
      schema: 1,
      play: {
        id: 'p',
        actors: [{ id: 'a', team: 'CT', path: [{ id: 'w', at: { x: 0, z: 0 } }] }],
      },
    })
    expect(play.utility).toEqual([])
    expect(play.annotations).toEqual([])
    expect(play.plant).toBeNull()
    expect(play.name).toBe('Untitled play')
    expect(play.actors[0]?.path[0]?.mode).toBe('run')
  })

  it('defaults a bad movement mode instead of throwing', () => {
    const play = parsePlayFile({
      schema: 1,
      play: {
        id: 'p',
        actors: [{ id: 'a', team: 'T', path: [{ id: 'w', at: { x: 0, z: 0 }, mode: 'sprint' }] }],
      },
    })
    expect(play.actors[0]?.path[0]?.mode).toBe('run')
  })

  it('coerces a null actorId on utility to null rather than dropping the event', () => {
    const play = parsePlayFile({
      schema: 1,
      play: {
        id: 'p',
        actors: [{ id: 'a', team: 'T', path: [{ id: 'w', at: { x: 0, z: 0 } }] }],
        utility: [
          { id: 'u', kind: 'smoke', from: { x: 0, z: 0 }, to: { x: 1, z: 1 }, throwTick: 10 },
        ],
      },
    })
    expect(play.utility[0]?.actorId).toBeNull()
  })
})

describe('toPlayFile', () => {
  it('stamps the current schema version', () => {
    const file = toPlayFile(createPlay(DUST2), 'when')
    expect(file['schema']).toBe(SCHEMA_VERSION)
    expect(file['savedAt']).toBe('when')
  })
})
