/**
 * Pointer and keyboard interaction.
 *
 * All of the "what does clicking here do" logic lives here, expressed as edits against the
 * play. Nothing in this file draws; nothing in `render.ts` mutates. That split is what keeps
 * a 60 fps render loop from having to reason about drag state machines.
 */

import {
  type Layer,
  type MoveMode,
  type Vec2,
  type Viewport,
  UTILITY,
  distance,
  fitBounds,
  newId,
  nudge,
  panBy,
  screenToWorld,
  seek,
  stepRate,
  togglePlaying,
  zoomAt,
} from '@cs2/playbook'
import { pickAt, pickToSelection } from './hit.js'
import { invalidateMapLayer } from './render.js'
import {
  type AppState,
  UTILITY_TOOLS,
  apply,
  doRedo,
  doUndo,
  endCoalesce,
  notify,
  play,
  setSelection,
  setTool,
  toggleLayer,
} from './state.js'

export interface InteractionHost {
  readonly canvas: HTMLCanvasElement
  viewport(): Viewport
  toast(message: string): void
  /** Opens the inline text editor for an annotation, resolving to null on cancel. */
  promptText(initial: string): Promise<string | null>
}

function eventWorld(state: AppState, host: InteractionHost, ev: PointerEvent | WheelEvent): Vec2 {
  const rect = host.canvas.getBoundingClientRect()
  return screenToWorld(state.camera, host.viewport(), {
    x: ev.clientX - rect.left,
    z: ev.clientY - rect.top,
  })
}

function eventScreen(host: InteractionHost, ev: PointerEvent | WheelEvent): Vec2 {
  const rect = host.canvas.getBoundingClientRect()
  return { x: ev.clientX - rect.left, z: ev.clientY - rect.top }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pointer
// ─────────────────────────────────────────────────────────────────────────────

export function attachPointer(state: AppState, host: InteractionHost): void {
  const canvas = host.canvas

  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault())

  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId)
    const world = eventWorld(state, host, ev)
    const screen = eventScreen(host, ev)

    // Middle button, space-drag and right button all pan. Three ways because muscle memory
    // differs and none of them costs anything.
    const wantsPan = ev.button === 1 || ev.button === 2 || spaceDown
    if (wantsPan) {
      state.drag = { kind: 'pan', originScreen: screen, originWorld: world, currentWorld: world }
      return
    }

    if (ev.button !== 0) return

    const utilKind = UTILITY_TOOLS[state.tool]
    if (utilKind !== undefined) {
      state.drag = { kind: 'draw', originScreen: screen, originWorld: world, currentWorld: world }
      return
    }

    switch (state.tool) {
      case 'measure':
        state.drag = { kind: 'measure', originScreen: screen, originWorld: world, currentWorld: world }
        return

      case 'arrow':
      case 'zone':
        state.drag = { kind: 'draw', originScreen: screen, originWorld: world, currentWorld: world }
        return

      case 'text': {
        void host.promptText('').then((text) => {
          if (text === null || text.trim() === '') return
          apply(state, {
            kind: 'addAnnotation',
            annotation: {
              id: newId('note'),
              kind: 'text',
              points: [world],
              layer: state.drawLayer,
              text,
              color: '#f2f2f2',
              fromTick: Math.round(state.clock.tick),
              untilTick: -1,
            },
          })
        })
        return
      }

      case 'plant':
        apply(state, { kind: 'setPlant', at: world, tick: Math.round(state.clock.tick) })
        host.toast('Plant position set at the playhead')
        return

      case 'path': {
        const actorId = state.pathActorId
        if (actorId === null) {
          host.toast('Pick a player in the roster first')
          return
        }
        // Alt-click on an existing leg inserts a bend instead of appending to the end.
        const pick = pickAt(state, world, host.viewport())
        if (ev.altKey && pick.kind === 'leg') {
          apply(state, { kind: 'insertWaypoint', actorId: pick.hit.actorId, index: pick.hit.insertIndex, at: world })
          return
        }
        apply(state, {
          kind: 'appendWaypoint',
          actorId,
          at: world,
          mode: state.drawMode,
          layer: state.drawLayer,
        })
        return
      }

      case 'select': {
        const pick = pickAt(state, world, host.viewport())

        if (ev.altKey && pick.kind === 'leg') {
          apply(state, { kind: 'insertWaypoint', actorId: pick.hit.actorId, index: pick.hit.insertIndex, at: world })
          return
        }

        setSelection(state, pickToSelection(pick))

        if (pick.kind === 'waypoint') {
          state.drag = {
            kind: 'waypoint',
            actorId: pick.hit.actorId,
            waypointId: pick.hit.waypointId,
            originScreen: screen,
            originWorld: world,
            currentWorld: world,
          }
        } else if (pick.kind === 'utility-to' || pick.kind === 'utility-from') {
          state.drag = {
            kind: pick.kind,
            eventId: pick.eventId,
            originScreen: screen,
            originWorld: world,
            currentWorld: world,
          }
        } else if (pick.kind === 'none') {
          // Clicking empty map pans, which makes the select tool usable without chording.
          state.drag = { kind: 'pan', originScreen: screen, originWorld: world, currentWorld: world }
        }
        return
      }

      default:
        return
    }
  })

  canvas.addEventListener('pointermove', (ev) => {
    const drag = state.drag
    const world = eventWorld(state, host, ev)

    if (drag === null) {
      updateHoverHint(state, host, world)
      return
    }

    switch (drag.kind) {
      case 'pan': {
        const screen = eventScreen(host, ev)
        state.camera = panBy(state.camera, screen.x - drag.originScreen.x, screen.z - drag.originScreen.z)
        state.drag = { ...drag, originScreen: screen, currentWorld: world }
        invalidateMapLayer()
        return
      }
      case 'waypoint': {
        if (drag.actorId === undefined || drag.waypointId === undefined) return
        apply(
          state,
          { kind: 'moveWaypoint', actorId: drag.actorId, waypointId: drag.waypointId, at: world },
          { quiet: true },
        )
        state.drag = { ...drag, currentWorld: world }
        return
      }
      case 'utility-to':
      case 'utility-from': {
        if (drag.eventId === undefined) return
        apply(
          state,
          drag.kind === 'utility-to'
            ? { kind: 'moveUtility', eventId: drag.eventId, to: world }
            : { kind: 'moveUtility', eventId: drag.eventId, from: world },
          { quiet: true },
        )
        state.drag = { ...drag, currentWorld: world }
        return
      }
      case 'draw':
      case 'measure':
        state.drag = { ...drag, currentWorld: world }
        return
    }
  })

  const finish = (ev: PointerEvent): void => {
    const drag = state.drag
    state.drag = null
    if (drag === null) return
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId)

    const world = eventWorld(state, host, ev)

    if (drag.kind === 'waypoint' || drag.kind === 'utility-to' || drag.kind === 'utility-from') {
      endCoalesce(state)
      notify()
      return
    }

    if (drag.kind === 'measure') {
      const d = distance(drag.originWorld, world)
      host.toast(
        `${Math.round(d)} units — run ${(d / 250).toFixed(2)}s · walk ${(d / 130).toFixed(2)}s · crouch ${(d / 90).toFixed(2)}s`,
      )
      return
    }

    if (drag.kind !== 'draw') return

    const utilKind = UTILITY_TOOLS[state.tool]
    if (utilKind !== undefined) {
      // A click with no drag means "landed here, thrown from whoever is selected" — the common
      // case when transcribing a demo where you only know where the smoke ended up.
      const dragged = distance(drag.originWorld, world) > 40
      const thrower = throwerAt(state)
      const from = dragged ? drag.originWorld : (thrower?.at ?? drag.originWorld)
      const to = dragged ? world : drag.originWorld
      apply(state, {
        kind: 'addUtility',
        utilKind,
        from,
        to,
        layer: state.drawLayer,
        throwTick: Math.round(state.clock.tick),
        actorId: thrower?.actorId ?? null,
      })
      host.toast(
        `${UTILITY[utilKind].label} added at ${(state.clock.tick / 64).toFixed(1)}s — drag its ends to adjust`,
      )
      return
    }

    if (state.tool === 'arrow') {
      apply(state, {
        kind: 'addAnnotation',
        annotation: {
          id: newId('note'),
          kind: 'arrow',
          points: [drag.originWorld, world],
          layer: state.drawLayer,
          text: '',
          color: '#f2f2f2',
          fromTick: Math.round(state.clock.tick),
          untilTick: -1,
        },
      })
      return
    }

    if (state.tool === 'zone') {
      const a = drag.originWorld
      const b = world
      apply(state, {
        kind: 'addAnnotation',
        annotation: {
          id: newId('note'),
          kind: 'zone',
          points: [
            { x: a.x, z: a.z },
            { x: b.x, z: a.z },
            { x: b.x, z: b.z },
            { x: a.x, z: b.z },
          ],
          layer: state.drawLayer,
          text: '',
          color: '#61d6c4',
          fromTick: Math.round(state.clock.tick),
          untilTick: -1,
        },
      })
    }
  }

  canvas.addEventListener('pointerup', finish)
  canvas.addEventListener('pointercancel', (ev) => {
    state.drag = null
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId)
  })

  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault()
      const factor = Math.pow(0.9985, ev.deltaY)
      state.camera = zoomAt(state.camera, host.viewport(), eventScreen(host, ev), factor)
      invalidateMapLayer()
    },
    { passive: false },
  )
}

/** The selected actor and where they are at the playhead, for attributing utility. */
function throwerAt(state: AppState): { actorId: string; at: Vec2 } | undefined {
  const sel = state.selection
  const actorId =
    sel.kind === 'actor' || sel.kind === 'waypoint' ? sel.actorId : (state.pathActorId ?? null)
  if (actorId === null) return undefined
  const at = state.lastPositions.get(actorId)
  if (at === undefined) return undefined
  return { actorId, at }
}

function updateHoverHint(state: AppState, host: InteractionHost, world: Vec2): void {
  const callout = nearestCallout(state, world)
  const next = callout === null ? '' : callout
  if (next !== state.hint) {
    state.hint = next
    notify()
  }
  void host
}

function nearestCallout(state: AppState, world: Vec2): string | null {
  let best: string | null = null
  let bestDist = 420
  for (const c of state.map.callouts) {
    const d = distance(c.at, world)
    if (d < bestDist) {
      bestDist = d
      best = c.name
    }
  }
  return best
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard
// ─────────────────────────────────────────────────────────────────────────────

let spaceDown = false

const TOOL_KEYS: Readonly<Record<string, AppState['tool']>> = {
  v: 'select',
  p: 'path',
  s: 'smoke',
  f: 'flash',
  m: 'molotov',
  h: 'he',
  d: 'decoy',
  a: 'arrow',
  t: 'text',
  o: 'zone',
  k: 'measure',
  b: 'plant',
}

const MODE_KEYS: Readonly<Record<string, MoveMode>> = { '7': 'run', '8': 'walk', '9': 'crouch' }
const LAYER_KEYS: Readonly<Record<string, Layer>> = { z: 'lower', x: 'ground', c: 'upper' }

/** True when the event came from a text field, where shortcuts must not fire. */
function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

export function attachKeyboard(state: AppState, host: InteractionHost, onFit: () => void): void {
  globalThis.addEventListener('keyup', (ev) => {
    if (ev.code === 'Space') spaceDown = false
  })

  globalThis.addEventListener('keydown', (ev) => {
    if (inTextField(ev.target)) return

    const mod = ev.metaKey || ev.ctrlKey

    if (mod && ev.key.toLowerCase() === 'z') {
      ev.preventDefault()
      const ok = ev.shiftKey ? doRedo(state) : doUndo(state)
      if (!ok) host.toast(ev.shiftKey ? 'Nothing to redo' : 'Nothing to undo')
      return
    }

    if (mod) return

    switch (ev.code) {
      case 'Space':
        // Space plays; space *held* over the canvas pans. The distinction is settled by
        // whether a pointerdown arrives while it is held.
        ev.preventDefault()
        spaceDown = true
        state.clock = togglePlaying(state.clock)
        notify()
        return
      case 'ArrowLeft':
        ev.preventDefault()
        state.clock = nudge(state.clock, ev.shiftKey ? -64 : -1)
        notify()
        return
      case 'ArrowRight':
        ev.preventDefault()
        state.clock = nudge(state.clock, ev.shiftKey ? 64 : 1)
        notify()
        return
      case 'Home':
        state.clock = seek(state.clock, 0)
        notify()
        return
      case 'End':
        state.clock = seek(state.clock, state.clock.durationTicks)
        notify()
        return
      case 'BracketLeft':
        state.clock = stepRate(state.clock, -1)
        notify()
        return
      case 'BracketRight':
        state.clock = stepRate(state.clock, 1)
        notify()
        return
      case 'Delete':
      case 'Backspace':
        ev.preventDefault()
        deleteSelection(state, host)
        return
      default:
        break
    }

    const key = ev.key.toLowerCase()

    const tool = TOOL_KEYS[key]
    if (tool !== undefined) {
      setTool(state, tool)
      return
    }

    const mode = MODE_KEYS[key]
    if (mode !== undefined) {
      state.drawMode = mode
      applyModeToSelection(state, mode)
      notify()
      return
    }

    const layer = LAYER_KEYS[key]
    if (layer !== undefined) {
      if (ev.shiftKey) {
        toggleLayer(state, layer)
      } else {
        state.drawLayer = layer
        applyLayerToSelection(state, layer)
        notify()
      }
      invalidateMapLayer()
      return
    }

    if (key >= '1' && key <= '5') {
      const index = Number(key) - 1
      const side = state.presenting ? play(state).side : play(state).side
      const list = play(state).actors.filter((a) => a.team === side)
      const actor = list[index]
      if (actor !== undefined) setSelection(state, { kind: 'actor', actorId: actor.id })
      return
    }

    switch (key) {
      case '0':
        onFit()
        return
      case 'g':
        state.showGrid = !state.showGrid
        invalidateMapLayer()
        notify()
        return
      case 'l':
        state.showCallouts = !state.showCallouts
        invalidateMapLayer()
        notify()
        return
      case 'r':
        state.showPaths = !state.showPaths
        notify()
        return
      case 'e':
        state.presenting = !state.presenting
        document.body.classList.toggle('presenting', state.presenting)
        invalidateMapLayer()
        notify()
        return
      default:
        return
    }
  })
}

/** Applies the newly chosen movement mode to whatever is selected, so the key does something. */
function applyModeToSelection(state: AppState, mode: MoveMode): void {
  const sel = state.selection
  if (sel.kind !== 'waypoint') return
  apply(state, { kind: 'setWaypoint', actorId: sel.actorId, waypointId: sel.waypointId, mode })
}

function applyLayerToSelection(state: AppState, layer: Layer): void {
  const sel = state.selection
  if (sel.kind === 'waypoint') {
    apply(state, { kind: 'setWaypoint', actorId: sel.actorId, waypointId: sel.waypointId, layer })
  } else if (sel.kind === 'utility') {
    apply(state, { kind: 'setUtility', eventId: sel.eventId, layer })
  }
}

export function deleteSelection(state: AppState, host: InteractionHost): void {
  const sel = state.selection
  switch (sel.kind) {
    case 'waypoint':
      apply(state, { kind: 'deleteWaypoint', actorId: sel.actorId, waypointId: sel.waypointId })
      setSelection(state, { kind: 'actor', actorId: sel.actorId })
      return
    case 'utility':
      apply(state, { kind: 'deleteUtility', eventId: sel.eventId })
      setSelection(state, { kind: 'none' })
      return
    case 'annotation':
      apply(state, { kind: 'deleteAnnotation', annotationId: sel.annotationId })
      setSelection(state, { kind: 'none' })
      return
    case 'actor':
      apply(state, { kind: 'clearPath', actorId: sel.actorId })
      host.toast('Path cleared — the player stays on spawn')
      return
    case 'none':
      return
  }
}

/** Fits the whole map into the viewport. Exposed so the toolbar and `0` share one path. */
export function fitToMap(state: AppState, vp: Viewport): void {
  state.camera = fitBounds(state.map.bounds, vp, 40)
  invalidateMapLayer()
  notify()
}
