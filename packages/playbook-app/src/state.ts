/**
 * App state.
 *
 * One mutable object, mutated through the functions in this file, with a subscriber list that
 * the UI modules use to re-render. Deliberately not a framework: the whole app is one screen
 * with a handful of panels, and a hand-rolled store keeps the render path — which has to hit
 * 60 fps while dragging — free of any diffing machinery.
 *
 * The *play itself* is never mutated in place. Every change goes through `commit`, which is
 * what makes undo work (see `@cs2/playbook/edits`).
 */

import {
  type Camera,
  type History,
  type Layer,
  type MapDef,
  type MoveMode,
  type Play,
  type PlayEdit,
  type ResolvedTrack,
  type UtilityKind,
  type Vec2,
  breakCoalesce,
  canRedo,
  canUndo,
  commit,
  createHistory,
  createClock,
  type Clock,
  mapOrDefault,
  playDurationTicks,
  redo,
  resolvePlay,
  setDuration,
  undo,
} from '@cs2/playbook'

export type ToolId =
  | 'select'
  | 'path'
  | 'smoke'
  | 'flash'
  | 'molotov'
  | 'he'
  | 'decoy'
  | 'arrow'
  | 'text'
  | 'zone'
  | 'measure'
  | 'plant'

/** The utility tools, so the pointer handler can turn a tool id into a grenade kind. */
export const UTILITY_TOOLS: Readonly<Partial<Record<ToolId, UtilityKind>>> = {
  smoke: 'smoke',
  flash: 'flash',
  molotov: 'molotov',
  he: 'he',
  decoy: 'decoy',
}

/** What is currently selected. At most one thing at a time — this is a small tool. */
export type Selection =
  | { readonly kind: 'none' }
  | { readonly kind: 'actor'; readonly actorId: string }
  | { readonly kind: 'waypoint'; readonly actorId: string; readonly waypointId: string }
  | { readonly kind: 'utility'; readonly eventId: string }
  | { readonly kind: 'annotation'; readonly annotationId: string }

export interface DragState {
  readonly kind: 'waypoint' | 'utility-from' | 'utility-to' | 'pan' | 'draw' | 'measure'
  readonly actorId?: string
  readonly waypointId?: string
  readonly eventId?: string
  /** Screen-space anchor of the drag, for pan and for rubber-band drawing. */
  readonly originScreen: { x: number; z: number }
  readonly originWorld: { x: number; z: number }
  readonly currentWorld: { x: number; z: number }
}

export interface AppState {
  map: MapDef
  history: History
  clock: Clock
  camera: Camera
  tool: ToolId
  selection: Selection
  /** Actor the Path tool appends to. Falls back to the selection. */
  pathActorId: string | null
  /** Mode applied to newly drawn waypoints. */
  drawMode: MoveMode
  /** Layer applied to newly drawn waypoints and utility. */
  drawLayer: Layer
  /** Layers to show. Anything not listed renders dimmed rather than hidden. */
  visibleLayers: ReadonlySet<Layer>
  /** Hide one team entirely, for showing a side its own half of a play. */
  hiddenTeams: ReadonlySet<'T' | 'CT'>
  showCallouts: boolean
  showPaths: boolean
  showGrid: boolean
  /** Presentation mode: hides the editing chrome for showing a play to a team. */
  presenting: boolean
  drag: DragState | null
  /** Cached resolved tracks, keyed by the history revision that produced them. */
  tracks: readonly ResolvedTrack[]
  tracksRevision: number
  hint: string
  library: readonly Play[]
  /**
   * Where each actor was drawn on the last rendered frame.
   *
   * Hit testing reads this rather than re-sampling the timeline, so clicking an actor
   * mid-animation grabs the dot you can actually see.
   */
  lastPositions: Map<string, Vec2>
}

const ALL_LAYERS: Layer[] = ['lower', 'ground', 'upper']

export function createState(play: Play, library: readonly Play[]): AppState {
  const map = mapOrDefault(play.mapId)
  const history = createHistory(play)
  return {
    map,
    history,
    clock: createClock(playDurationTicks(play)),
    camera: { center: { x: 0, z: 0 }, scale: 0.14 },
    tool: 'select',
    selection: { kind: 'none' },
    pathActorId: play.actors[0]?.id ?? null,
    drawMode: 'run',
    drawLayer: 'ground',
    visibleLayers: new Set(ALL_LAYERS),
    hiddenTeams: new Set(),
    showCallouts: true,
    showPaths: true,
    showGrid: false,
    presenting: false,
    drag: null,
    tracks: resolvePlay(play),
    tracksRevision: history.revision,
    hint: '',
    library,
    lastPositions: new Map(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscriptions
// ─────────────────────────────────────────────────────────────────────────────

type Listener = () => void

const listeners = new Set<Listener>()

/** Panels subscribe; the canvas does not — it redraws every frame anyway. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

let flushQueued = false
let flushing = false

/**
 * Marks the panels dirty. The actual re-render happens once, on the next animation frame.
 *
 * Coalescing is not an optimisation here, it is a correctness fix. Panels rebuild themselves
 * with `replaceChildren`, and a rebuild blurs whatever input had focus — which fires that
 * input's `change` handler, which commits an edit, which calls `notify` again. Rendering
 * synchronously meant re-entering a panel's rebuild while `replaceChildren` was still walking
 * the old children, and the DOM throws outright when that happens.
 *
 * Deferring to a frame boundary makes every re-render happen with the DOM at rest.
 */
export function notify(): void {
  if (flushQueued) return
  flushQueued = true
  requestAnimationFrame(() => {
    flushQueued = false
    if (flushing) return
    flushing = true
    try {
      for (const fn of listeners) fn()
    } finally {
      flushing = false
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutators
// ─────────────────────────────────────────────────────────────────────────────

export function play(state: AppState): Play {
  return state.history.present
}

/** Resolved tracks for the current play, recomputing only when the play has changed. */
export function tracks(state: AppState): readonly ResolvedTrack[] {
  if (state.tracksRevision !== state.history.revision) {
    state.tracks = resolvePlay(state.history.present)
    state.tracksRevision = state.history.revision
  }
  return state.tracks
}

/**
 * Applies an edit and keeps the clock's duration in step.
 *
 * The clock's duration follows the *derived* length of the play, so extending a path
 * automatically extends the scrub bar — you never have to remember to bump a number.
 */
export function apply(state: AppState, edit: PlayEdit, opts: { quiet?: boolean } = {}): void {
  const next = commit(state.history, edit)
  if (next === state.history) return
  state.history = next
  state.clock = setDuration(state.clock, playDurationTicks(next.present))
  if (opts.quiet !== true) notify()
}

/** Ends a drag's coalescing run so the next edit starts a new undo step. */
export function endCoalesce(state: AppState): void {
  state.history = breakCoalesce(state.history)
}

/**
 * Whether a selection still points at something that exists.
 *
 * Undo is where this matters: dropping the selection unconditionally means undoing one
 * waypoint deselects the player you were drawing, and you have to re-pick them before the
 * next click. Keeping a selection that survived the undo is the difference between undo being
 * usable mid-draw and being an interruption.
 */
function selectionSurvives(state: AppState, selection: Selection): boolean {
  const current = state.history.present
  switch (selection.kind) {
    case 'none':
      return true
    case 'actor':
      return current.actors.some((a) => a.id === selection.actorId)
    case 'waypoint': {
      const actor = current.actors.find((a) => a.id === selection.actorId)
      return actor !== undefined && actor.path.some((w) => w.id === selection.waypointId)
    }
    case 'utility':
      return current.utility.some((e) => e.id === selection.eventId)
    case 'annotation':
      return current.annotations.some((a) => a.id === selection.annotationId)
  }
}

/** Narrows a selection to the nearest thing that still exists after a history jump. */
function reconcileSelection(state: AppState): void {
  if (selectionSurvives(state, state.selection)) return
  // A deleted waypoint falls back to its actor, which usually still exists; anything else
  // clears.
  if (state.selection.kind === 'waypoint') {
    const fallback: Selection = { kind: 'actor', actorId: state.selection.actorId }
    state.selection = selectionSurvives(state, fallback) ? fallback : { kind: 'none' }
    return
  }
  state.selection = { kind: 'none' }
}

export function doUndo(state: AppState): boolean {
  if (!canUndo(state.history)) return false
  state.history = undo(state.history)
  state.clock = setDuration(state.clock, playDurationTicks(state.history.present))
  reconcileSelection(state)
  notify()
  return true
}

export function doRedo(state: AppState): boolean {
  if (!canRedo(state.history)) return false
  state.history = redo(state.history)
  state.clock = setDuration(state.clock, playDurationTicks(state.history.present))
  reconcileSelection(state)
  notify()
  return true
}

export function loadPlay(state: AppState, next: Play): void {
  state.map = mapOrDefault(next.mapId)
  state.history = createHistory(next)
  state.clock = createClock(playDurationTicks(next))
  state.selection = { kind: 'none' }
  state.pathActorId = next.actors[0]?.id ?? null
  state.drag = null
  state.tracks = resolvePlay(next)
  state.tracksRevision = state.history.revision
  notify()
}

export function setTool(state: AppState, tool: ToolId): void {
  state.tool = tool
  // Leaving the Path tool ends the run, so re-entering it does not append to a stale actor.
  if (tool !== 'path') state.drag = null
  notify()
}

export function setSelection(state: AppState, selection: Selection): void {
  state.selection = selection
  if (selection.kind === 'actor') state.pathActorId = selection.actorId
  if (selection.kind === 'waypoint') state.pathActorId = selection.actorId
  notify()
}

export function findActor(state: AppState, actorId: string | null) {
  if (actorId === null) return undefined
  return play(state).actors.find((a) => a.id === actorId)
}

export function selectedActor(state: AppState) {
  const sel = state.selection
  if (sel.kind === 'actor' || sel.kind === 'waypoint') return findActor(state, sel.actorId)
  return undefined
}

export function toggleLayer(state: AppState, layer: Layer): void {
  const next = new Set(state.visibleLayers)
  if (next.has(layer)) next.delete(layer)
  else next.add(layer)
  // Never let every layer be off — an empty map with no explanation reads as a crash.
  if (next.size > 0) state.visibleLayers = next
  notify()
}

export function toggleTeam(state: AppState, team: 'T' | 'CT'): void {
  const next = new Set(state.hiddenTeams)
  if (next.has(team)) next.delete(team)
  else next.add(team)
  state.hiddenTeams = next
  notify()
}
