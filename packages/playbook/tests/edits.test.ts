import { describe, expect, it } from 'vitest'
import {
  applyEdit,
  canRedo,
  canUndo,
  commit,
  createHistory,
  breakCoalesce,
  redo,
  undo,
} from '../src/edits.js'
import { createPlay } from '../src/play.js'
import { DUST2 } from '../src/maps/dust2.js'
import type { Play } from '../src/types.js'

const v = (x: number, z: number) => ({ x, z })

function fresh(): Play {
  return createPlay(DUST2)
}

function firstActorId(play: Play): string {
  const id = play.actors[0]?.id
  if (id === undefined) throw new Error('expected a starting roster')
  return id
}

describe('applyEdit purity', () => {
  it('never mutates its input', () => {
    const play = fresh()
    const before = JSON.stringify(play)
    applyEdit(play, { kind: 'appendWaypoint', actorId: firstActorId(play), at: v(0, 0), mode: 'run', layer: 'ground' })
    expect(JSON.stringify(play)).toBe(before)
  })

  it('returns the same object when nothing changed, so commit can skip', () => {
    const play = fresh()
    const same = applyEdit(play, { kind: 'moveWaypoint', actorId: 'nope', waypointId: 'nope', at: v(0, 0) })
    expect(same).toBe(play)
  })
})

describe('waypoint edits', () => {
  it('appends with the requested mode and layer', () => {
    const play = fresh()
    const actorId = firstActorId(play)
    const next = applyEdit(play, { kind: 'appendWaypoint', actorId, at: v(500, 500), mode: 'walk', layer: 'lower' })
    const path = next.actors.find((a) => a.id === actorId)?.path ?? []
    expect(path).toHaveLength(2)
    expect(path[1]?.mode).toBe('walk')
    expect(path[1]?.layer).toBe('lower')
  })

  it('inserts a bend that inherits the leg it splits', () => {
    const play = fresh()
    const actorId = firstActorId(play)
    let next = applyEdit(play, { kind: 'appendWaypoint', actorId, at: v(500, 0), mode: 'crouch', layer: 'upper' })
    next = applyEdit(next, { kind: 'insertWaypoint', actorId, index: 1, at: v(250, 0) })
    const path = next.actors.find((a) => a.id === actorId)?.path ?? []
    expect(path).toHaveLength(3)
    expect(path[1]?.at).toEqual(v(250, 0))
    expect(path[1]?.mode).toBe('crouch')
  })

  it('refuses to delete the last waypoint, so an actor always has a spawn', () => {
    const play = fresh()
    const actorId = firstActorId(play)
    const wpId = play.actors[0]?.path[0]?.id
    expect(wpId).toBeDefined()
    const next = applyEdit(play, { kind: 'deleteWaypoint', actorId, waypointId: wpId ?? '' })
    expect(next.actors.find((a) => a.id === actorId)?.path).toHaveLength(1)
  })

  it('clears a path back to the spawn point', () => {
    const play = fresh()
    const actorId = firstActorId(play)
    let next = applyEdit(play, { kind: 'appendWaypoint', actorId, at: v(1, 1), mode: 'run', layer: 'ground' })
    next = applyEdit(next, { kind: 'appendWaypoint', actorId, at: v(2, 2), mode: 'run', layer: 'ground' })
    next = applyEdit(next, { kind: 'clearPath', actorId })
    expect(next.actors.find((a) => a.id === actorId)?.path).toHaveLength(1)
  })

  it('pins and unpins an arrival time', () => {
    const play = fresh()
    const actorId = firstActorId(play)
    const added = applyEdit(play, { kind: 'appendWaypoint', actorId, at: v(500, 0), mode: 'run', layer: 'ground' })
    const wpId = added.actors.find((a) => a.id === actorId)?.path[1]?.id ?? ''

    const pinned = applyEdit(added, { kind: 'setWaypoint', actorId, waypointId: wpId, arriveTick: 640 })
    expect(pinned.actors.find((a) => a.id === actorId)?.path[1]?.arriveTick).toBe(640)

    const unpinned = applyEdit(pinned, { kind: 'setWaypoint', actorId, waypointId: wpId, arriveTick: null })
    const wp = unpinned.actors.find((a) => a.id === actorId)?.path[1]
    // `exactOptionalPropertyTypes` means clearing must remove the key, not set it undefined.
    expect(wp !== undefined && 'arriveTick' in wp).toBe(false)
  })
})

describe('utility and annotation edits', () => {
  it('adds, moves and deletes utility', () => {
    const play = fresh()
    const added = applyEdit(play, {
      kind: 'addUtility',
      utilKind: 'smoke',
      from: v(0, 0),
      to: v(100, 0),
      layer: 'ground',
      throwTick: 64,
      actorId: null,
    })
    const id = added.utility[0]?.id ?? ''
    expect(added.utility).toHaveLength(1)

    const moved = applyEdit(added, { kind: 'moveUtility', eventId: id, to: v(400, 0) })
    expect(moved.utility[0]?.to).toEqual(v(400, 0))
    expect(moved.utility[0]?.from).toEqual(v(0, 0))

    const deleted = applyEdit(moved, { kind: 'deleteUtility', eventId: id })
    expect(deleted.utility).toHaveLength(0)
  })

  it('sets and clears the plant', () => {
    const play = fresh()
    const planted = applyEdit(play, { kind: 'setPlant', at: v(1840, -1490), tick: 640 })
    expect(planted.plant).toEqual({ at: v(1840, -1490), tick: 640 })
    expect(applyEdit(planted, { kind: 'clearPlant' }).plant).toBeNull()
  })
})

describe('history', () => {
  const actorId = (play: Play): string => firstActorId(play)

  it('undoes and redoes an edit', () => {
    const play = fresh()
    let history = createHistory(play)
    expect(canUndo(history)).toBe(false)

    history = commit(history, {
      kind: 'appendWaypoint',
      actorId: actorId(play),
      at: v(500, 0),
      mode: 'run',
      layer: 'ground',
    })
    expect(history.present.actors[0]?.path).toHaveLength(2)
    expect(canUndo(history)).toBe(true)

    history = undo(history)
    expect(history.present.actors[0]?.path).toHaveLength(1)
    expect(canRedo(history)).toBe(true)

    history = redo(history)
    expect(history.present.actors[0]?.path).toHaveLength(2)
  })

  it('collapses a drag into a single undo step', () => {
    const play = fresh()
    const wpId = play.actors[0]?.path[0]?.id ?? ''
    let history = createHistory(play)

    // A move must first exist as a discrete edit for there to be something to coalesce onto.
    history = commit(history, { kind: 'moveWaypoint', actorId: actorId(play), waypointId: wpId, at: v(1, 1) })
    const depthAfterFirst = history.past.length
    for (let i = 2; i < 40; i++) {
      history = commit(history, { kind: 'moveWaypoint', actorId: actorId(play), waypointId: wpId, at: v(i, i) })
    }
    expect(history.past.length).toBe(depthAfterFirst)

    history = undo(history)
    expect(history.present.actors[0]?.path[0]?.at).toEqual(play.actors[0]?.path[0]?.at)
  })

  it('starts a new undo step for a different waypoint', () => {
    const play = fresh()
    const a = play.actors[0]?.path[0]?.id ?? ''
    const b = play.actors[1]?.path[0]?.id ?? ''
    let history = createHistory(play)
    history = commit(history, { kind: 'moveWaypoint', actorId: play.actors[0]?.id ?? '', waypointId: a, at: v(1, 1) })
    const depth = history.past.length
    history = commit(history, { kind: 'moveWaypoint', actorId: play.actors[1]?.id ?? '', waypointId: b, at: v(2, 2) })
    expect(history.past.length).toBe(depth + 1)
  })

  it('breakCoalesce ends a drag run', () => {
    const play = fresh()
    const wpId = play.actors[0]?.path[0]?.id ?? ''
    let history = createHistory(play)
    history = commit(history, { kind: 'moveWaypoint', actorId: actorId(play), waypointId: wpId, at: v(1, 1) })
    history = breakCoalesce(history)
    const depth = history.past.length
    history = commit(history, { kind: 'moveWaypoint', actorId: actorId(play), waypointId: wpId, at: v(2, 2) })
    expect(history.past.length).toBe(depth + 1)
  })

  it('drops the redo stack once a new edit lands', () => {
    const play = fresh()
    let history = createHistory(play)
    history = commit(history, {
      kind: 'appendWaypoint',
      actorId: actorId(play),
      at: v(500, 0),
      mode: 'run',
      layer: 'ground',
    })
    history = undo(history)
    expect(canRedo(history)).toBe(true)
    history = commit(history, { kind: 'setMeta', name: 'something else' })
    expect(canRedo(history)).toBe(false)
  })

  it('bumps the revision so caches can invalidate cheaply', () => {
    const play = fresh()
    const history = createHistory(play)
    const next = commit(history, { kind: 'setMeta', name: 'renamed' })
    expect(next.revision).toBeGreaterThan(history.revision)
  })

  it('bounds the snapshot stack', () => {
    let history = createHistory(fresh())
    for (let i = 0; i < 400; i++) {
      history = commit(history, { kind: 'setDuration', durationTicks: 1000 + i })
    }
    expect(history.past.length).toBeLessThanOrEqual(120)
  })
})
