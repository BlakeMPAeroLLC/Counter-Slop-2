/**
 * Hit testing.
 *
 * Pick order matters more than the geometry does: a waypoint handle sitting on top of an
 * actor must win, or you can never grab the handle. Everything is measured in *screen*
 * pixels, converted to world units through the camera, so a 7-pixel grab radius stays
 * 7 pixels at every zoom level.
 */

import {
  type Vec2,
  type Viewport,
  distanceToSegment,
  distance,
  pointInPolygon,
  screenToWorldSize,
} from '@cs2/playbook'
import { HANDLE_PX } from './render.js'
import type { AppState, Selection } from './state.js'
import { play } from './state.js'

export interface WaypointHit {
  readonly actorId: string
  readonly waypointId: string
  readonly index: number
}

export interface LegHit {
  readonly actorId: string
  /** Index in `actor.path` at which a new waypoint would be inserted. */
  readonly insertIndex: number
}

/** Any pickable thing under the cursor, in priority order. */
export type Pick =
  | { readonly kind: 'waypoint'; readonly hit: WaypointHit }
  | { readonly kind: 'actor'; readonly actorId: string }
  | { readonly kind: 'utility-from'; readonly eventId: string }
  | { readonly kind: 'utility-to'; readonly eventId: string }
  | { readonly kind: 'annotation'; readonly annotationId: string }
  | { readonly kind: 'leg'; readonly hit: LegHit }
  | { readonly kind: 'none' }

export function pickAt(state: AppState, world: Vec2, vp: Viewport): Pick {
  void vp
  const grab = screenToWorldSize(state.camera, HANDLE_PX + 3)
  const current = play(state)

  // 1. Waypoint handles, but only on the selected actor — otherwise ten overlapping paths
  //    make it impossible to click anything else.
  const focusId = focusedActorId(state)
  if (focusId !== null) {
    const actor = current.actors.find((a) => a.id === focusId)
    if (actor !== undefined) {
      for (let i = actor.path.length - 1; i >= 0; i--) {
        const wp = actor.path[i]
        if (wp === undefined) continue
        if (distance(wp.at, world) <= grab) {
          return { kind: 'waypoint', hit: { actorId: actor.id, waypointId: wp.id, index: i } }
        }
      }
    }
  }

  // 2. Endpoints of the selected utility event. Both ends are grabbable: the landing spot is
  //    the one you usually adjust, but the origin is the lineup position and matters too.
  const sel = state.selection
  if (sel.kind === 'utility') {
    const ev = current.utility.find((e) => e.id === sel.eventId)
    if (ev !== undefined) {
      if (distance(ev.to, world) <= grab) return { kind: 'utility-to', eventId: ev.id }
      if (distance(ev.from, world) <= grab) return { kind: 'utility-from', eventId: ev.id }
    }
  }

  // 3. Actors at the current playhead position.
  const actorGrab = screenToWorldSize(state.camera, 12)
  for (const track of state.tracks) {
    const actor = current.actors.find((a) => a.id === track.actorId)
    if (actor === undefined || state.hiddenTeams.has(actor.team)) continue
    const spawn = actor.path[0]
    if (spawn === undefined) continue
    // Test against the positions the renderer actually drew last frame, so a click hits what
    // you see even mid-animation. Falling back to spawn covers the very first frame.
    const pos = currentPosition(state, actor.id) ?? spawn.at
    if (distance(pos, world) <= Math.max(actorGrab, screenToWorldSize(state.camera, 10))) {
      return { kind: 'actor', actorId: actor.id }
    }
  }

  // 4. Utility landing circles (any event, not just the selected one).
  for (const ev of current.utility) {
    if (distance(ev.to, world) <= grab * 1.6) return { kind: 'utility-to', eventId: ev.id }
  }

  // 5. Annotations.
  for (const a of current.annotations) {
    if (a.kind === 'zone' && a.points.length >= 3 && pointInPolygon(world, a.points)) {
      return { kind: 'annotation', annotationId: a.id }
    }
    const first = a.points[0]
    if (first !== undefined && distance(first, world) <= grab * 2) {
      return { kind: 'annotation', annotationId: a.id }
    }
  }

  // 6. Path legs, so Alt-clicking a line inserts a bend.
  const legGrab = screenToWorldSize(state.camera, 6)
  for (const actor of current.actors) {
    if (state.hiddenTeams.has(actor.team)) continue
    for (let i = 1; i < actor.path.length; i++) {
      const a = actor.path[i - 1]
      const b = actor.path[i]
      if (a === undefined || b === undefined) continue
      if (distanceToSegment(world, a.at, b.at) <= legGrab) {
        return { kind: 'leg', hit: { actorId: actor.id, insertIndex: i } }
      }
    }
  }

  return { kind: 'none' }
}

function focusedActorId(state: AppState): string | null {
  const sel = state.selection
  if (sel.kind === 'actor' || sel.kind === 'waypoint') return sel.actorId
  return state.pathActorId
}

/**
 * The actor's position at the current playhead.
 *
 * Stored on the state by the render loop each frame rather than recomputed here, so a click
 * hits exactly what was drawn — including mid-animation, which is when you most want to grab
 * someone.
 */
export function currentPosition(state: AppState, actorId: string): Vec2 | undefined {
  return state.lastPositions.get(actorId)
}

/** Turns a pick into a selection. */
export function pickToSelection(pick: Pick): Selection {
  switch (pick.kind) {
    case 'waypoint':
      return { kind: 'waypoint', actorId: pick.hit.actorId, waypointId: pick.hit.waypointId }
    case 'actor':
      return { kind: 'actor', actorId: pick.actorId }
    case 'utility-from':
    case 'utility-to':
      return { kind: 'utility', eventId: pick.eventId }
    case 'annotation':
      return { kind: 'annotation', annotationId: pick.annotationId }
    case 'leg':
      return { kind: 'actor', actorId: pick.hit.actorId }
    case 'none':
      return { kind: 'none' }
  }
}
