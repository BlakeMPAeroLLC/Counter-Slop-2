/**
 * Every mutation of a play, as data.
 *
 * Why a reducer plus snapshots rather than inverse-command undo
 * -----------------------------------------------------------
 * A `Play` is a few kilobytes. Keeping 120 whole snapshots costs well under a megabyte and
 * makes undo *unconditionally* correct — there is no class of "the inverse of this particular
 * edit was implemented slightly wrong" bug, which is where hand-rolled undo always dies.
 * Consecutive edits with the same coalesce key (a drag) collapse into one entry, so dragging
 * a waypoint across the map is one undo step rather than two hundred.
 *
 * `applyEdit` is pure and never mutates its input, which is also what makes it testable
 * without any UI.
 */

import { newId } from './play.js'
import type {
  Actor,
  Annotation,
  Layer,
  MoveMode,
  Play,
  Team,
  UtilityEvent,
  UtilityKind,
  Vec2,
  Waypoint,
} from './types.js'

export type PlayEdit =
  | { readonly kind: 'setMeta'; readonly name?: string; readonly description?: string; readonly side?: Team }
  | { readonly kind: 'setDuration'; readonly durationTicks: number }
  | { readonly kind: 'setActor'; readonly actorId: string; readonly name?: string; readonly color?: string; readonly startTick?: number }
  | { readonly kind: 'appendWaypoint'; readonly actorId: string; readonly at: Vec2; readonly mode: MoveMode; readonly layer: Layer }
  | { readonly kind: 'insertWaypoint'; readonly actorId: string; readonly index: number; readonly at: Vec2 }
  | { readonly kind: 'moveWaypoint'; readonly actorId: string; readonly waypointId: string; readonly at: Vec2 }
  | { readonly kind: 'deleteWaypoint'; readonly actorId: string; readonly waypointId: string }
  | { readonly kind: 'clearPath'; readonly actorId: string }
  | {
      readonly kind: 'setWaypoint'
      readonly actorId: string
      readonly waypointId: string
      readonly mode?: MoveMode
      readonly layer?: Layer
      readonly holdTicks?: number
      /** `null` clears the pin and returns the waypoint to speed-derived timing. */
      readonly arriveTick?: number | null
      readonly facing?: number | null
      readonly note?: string | null
    }
  | {
      readonly kind: 'addUtility'
      readonly utilKind: UtilityKind
      readonly from: Vec2
      readonly to: Vec2
      readonly layer: Layer
      readonly throwTick: number
      readonly actorId: string | null
    }
  | { readonly kind: 'moveUtility'; readonly eventId: string; readonly from?: Vec2; readonly to?: Vec2 }
  | {
      readonly kind: 'setUtility'
      readonly eventId: string
      readonly throwTick?: number
      readonly detonateTick?: number | null
      readonly layer?: Layer
      readonly note?: string | null
      readonly actorId?: string | null
    }
  | { readonly kind: 'deleteUtility'; readonly eventId: string }
  | { readonly kind: 'addAnnotation'; readonly annotation: Annotation }
  | {
      readonly kind: 'setAnnotation'
      readonly annotationId: string
      readonly points?: readonly Vec2[]
      readonly text?: string
      readonly color?: string
      readonly fromTick?: number
      readonly untilTick?: number
    }
  | { readonly kind: 'deleteAnnotation'; readonly annotationId: string }
  | { readonly kind: 'setPlant'; readonly at: Vec2; readonly tick: number }
  | { readonly kind: 'clearPlant' }
  | { readonly kind: 'replace'; readonly play: Play }

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function mapActor(play: Play, actorId: string, fn: (a: Actor) => Actor): Play {
  let changed = false
  const actors = play.actors.map((a) => {
    if (a.id !== actorId) return a
    changed = true
    return fn(a)
  })
  return changed ? { ...play, actors } : play
}

function mapPath(play: Play, actorId: string, fn: (path: readonly Waypoint[]) => readonly Waypoint[]): Play {
  return mapActor(play, actorId, (a) => ({ ...a, path: fn(a.path) }))
}

/**
 * Applies a patch whose fields may be `null` to mean "clear this optional field".
 *
 * `exactOptionalPropertyTypes` is on, so an optional field must be *absent* rather than set
 * to `undefined`. That is fiddly enough to be worth doing in one place.
 */
function patchOptional<T extends object, V>(target: T, key: string, value: V | null | undefined): T {
  if (value === undefined) return target
  const next = { ...target } as Record<string, unknown>
  if (value === null) delete next[key]
  else next[key] = value
  return next as T
}

// ─────────────────────────────────────────────────────────────────────────────
// The reducer
// ─────────────────────────────────────────────────────────────────────────────

export function applyEdit(play: Play, edit: PlayEdit): Play {
  switch (edit.kind) {
    case 'replace':
      return edit.play

    case 'setMeta':
      return {
        ...play,
        ...(edit.name === undefined ? {} : { name: edit.name }),
        ...(edit.description === undefined ? {} : { description: edit.description }),
        ...(edit.side === undefined ? {} : { side: edit.side }),
      }

    case 'setDuration':
      return { ...play, durationTicks: Math.max(64, Math.round(edit.durationTicks)) }

    case 'setActor':
      return mapActor(play, edit.actorId, (a) => ({
        ...a,
        ...(edit.name === undefined ? {} : { name: edit.name }),
        ...(edit.color === undefined ? {} : { color: edit.color }),
        ...(edit.startTick === undefined ? {} : { startTick: Math.max(0, Math.round(edit.startTick)) }),
      }))

    case 'appendWaypoint':
      return mapPath(play, edit.actorId, (path) => [
        ...path,
        {
          id: newId('wp'),
          at: edit.at,
          mode: edit.mode,
          layer: edit.layer,
          holdTicks: 0,
        },
      ])

    case 'insertWaypoint': {
      return mapPath(play, edit.actorId, (path) => {
        // A new waypoint inherits the leg it splits, so inserting a bend in a walk stays a walk.
        const clamped = Math.max(1, Math.min(path.length, edit.index))
        const donor = path[clamped] ?? path[clamped - 1]
        const inserted: Waypoint = {
          id: newId('wp'),
          at: edit.at,
          mode: donor?.mode ?? 'run',
          layer: donor?.layer ?? 'ground',
          holdTicks: 0,
        }
        return [...path.slice(0, clamped), inserted, ...path.slice(clamped)]
      })
    }

    case 'moveWaypoint':
      return mapPath(play, edit.actorId, (path) =>
        path.map((w) => (w.id === edit.waypointId ? { ...w, at: edit.at } : w)),
      )

    case 'deleteWaypoint':
      return mapPath(play, edit.actorId, (path) => {
        // Never delete the last waypoint: an actor must always have a start position, or it
        // has nowhere to stand during freeze time.
        if (path.length <= 1) return path
        return path.filter((w) => w.id !== edit.waypointId)
      })

    case 'clearPath':
      return mapPath(play, edit.actorId, (path) => (path[0] === undefined ? path : [path[0]]))

    case 'setWaypoint':
      return mapPath(play, edit.actorId, (path) =>
        path.map((w) => {
          if (w.id !== edit.waypointId) return w
          let next: Waypoint = {
            ...w,
            ...(edit.mode === undefined ? {} : { mode: edit.mode }),
            ...(edit.layer === undefined ? {} : { layer: edit.layer }),
            ...(edit.holdTicks === undefined ? {} : { holdTicks: Math.max(0, Math.round(edit.holdTicks)) }),
          }
          next = patchOptional(next, 'arriveTick', edit.arriveTick === null ? null : edit.arriveTick)
          next = patchOptional(next, 'facing', edit.facing === null ? null : edit.facing)
          next = patchOptional(next, 'note', edit.note === null ? null : edit.note)
          return next
        }),
      )

    case 'addUtility': {
      const ev: UtilityEvent = {
        id: newId('util'),
        kind: edit.utilKind,
        actorId: edit.actorId,
        from: edit.from,
        to: edit.to,
        layer: edit.layer,
        throwTick: Math.max(0, Math.round(edit.throwTick)),
      }
      return { ...play, utility: [...play.utility, ev] }
    }

    case 'moveUtility':
      return {
        ...play,
        utility: play.utility.map((ev) =>
          ev.id === edit.eventId
            ? {
                ...ev,
                ...(edit.from === undefined ? {} : { from: edit.from }),
                ...(edit.to === undefined ? {} : { to: edit.to }),
              }
            : ev,
        ),
      }

    case 'setUtility':
      return {
        ...play,
        utility: play.utility.map((ev) => {
          if (ev.id !== edit.eventId) return ev
          let next: UtilityEvent = {
            ...ev,
            ...(edit.throwTick === undefined ? {} : { throwTick: Math.max(0, Math.round(edit.throwTick)) }),
            ...(edit.layer === undefined ? {} : { layer: edit.layer }),
            ...(edit.actorId === undefined ? {} : { actorId: edit.actorId }),
          }
          next = patchOptional(next, 'detonateTick', edit.detonateTick)
          next = patchOptional(next, 'note', edit.note)
          return next
        }),
      }

    case 'deleteUtility':
      return { ...play, utility: play.utility.filter((ev) => ev.id !== edit.eventId) }

    case 'addAnnotation':
      return { ...play, annotations: [...play.annotations, edit.annotation] }

    case 'setAnnotation':
      return {
        ...play,
        annotations: play.annotations.map((a) =>
          a.id === edit.annotationId
            ? {
                ...a,
                ...(edit.points === undefined ? {} : { points: edit.points }),
                ...(edit.text === undefined ? {} : { text: edit.text }),
                ...(edit.color === undefined ? {} : { color: edit.color }),
                ...(edit.fromTick === undefined ? {} : { fromTick: Math.round(edit.fromTick) }),
                ...(edit.untilTick === undefined ? {} : { untilTick: Math.round(edit.untilTick) }),
              }
            : a,
        ),
      }

    case 'deleteAnnotation':
      return { ...play, annotations: play.annotations.filter((a) => a.id !== edit.annotationId) }

    case 'setPlant':
      return { ...play, plant: { at: edit.at, tick: Math.max(0, Math.round(edit.tick)) } }

    case 'clearPlant':
      return { ...play, plant: null }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// History
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Edits that should collapse together while a drag is in flight.
 *
 * Keyed by the *specific thing* being dragged, so dragging waypoint A then waypoint B is two
 * undo steps even though both are `moveWaypoint`.
 */
export function coalesceKey(edit: PlayEdit): string | null {
  switch (edit.kind) {
    case 'moveWaypoint':
      return `moveWaypoint:${edit.actorId}:${edit.waypointId}`
    case 'moveUtility':
      return `moveUtility:${edit.eventId}`
    case 'setAnnotation':
      return `setAnnotation:${edit.annotationId}`
    case 'setMeta':
      return 'setMeta'
    default:
      return null
  }
}

/** Snapshots kept before the oldest is dropped. */
export const HISTORY_LIMIT = 120

export interface History {
  readonly past: readonly Play[]
  readonly present: Play
  readonly future: readonly Play[]
  /** Coalesce key of the most recent commit, or null. */
  readonly lastKey: string | null
  /** Bumped on every change, so caches (resolved tracks) can be invalidated cheaply. */
  readonly revision: number
}

export function createHistory(play: Play): History {
  return { past: [], present: play, future: [], lastKey: null, revision: 0 }
}

export function commit(history: History, edit: PlayEdit): History {
  const next = applyEdit(history.present, edit)
  if (next === history.present) return history

  const key = coalesceKey(edit)
  // Same drag continuing: overwrite the present without pushing another snapshot.
  const coalescing = key !== null && key === history.lastKey && history.past.length > 0

  const past = coalescing ? history.past : [...history.past, history.present].slice(-HISTORY_LIMIT)

  return { past, present: next, future: [], lastKey: key, revision: history.revision + 1 }
}

/** Ends any in-flight coalescing run, so the next edit starts a fresh undo step. */
export function breakCoalesce(history: History): History {
  return history.lastKey === null ? history : { ...history, lastKey: null }
}

export function canUndo(history: History): boolean {
  return history.past.length > 0
}

export function canRedo(history: History): boolean {
  return history.future.length > 0
}

export function undo(history: History): History {
  const previous = history.past[history.past.length - 1]
  if (previous === undefined) return history
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future].slice(0, HISTORY_LIMIT),
    lastKey: null,
    revision: history.revision + 1,
  }
}

export function redo(history: History): History {
  const next = history.future[0]
  if (next === undefined) return history
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: next,
    future: history.future.slice(1),
    lastKey: null,
    revision: history.revision + 1,
  }
}
