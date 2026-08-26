/**
 * Canvas rendering.
 *
 * Two stacked canvases:
 *
 *   - the **map layer** holds the static geometry, callout labels and grid. Around 150
 *     polygons and 40 text labels; redrawing that 60 times a second is pure waste, so it is
 *     redrawn only when the camera, the layer filter or the map itself changes.
 *   - the **scene layer** holds everything that moves — actors, paths, utility, annotations,
 *     selection handles — and is cleared and redrawn every frame.
 *
 * Splitting them is the single biggest reason scrubbing stays smooth on a laptop.
 */

import {
  type ActorFrame,
  type Camera,
  type Layer,
  type MapDef,
  type Play,
  type PlayFrame,
  type Region,
  type ResolvedTrack,
  type UtilityFrame,
  type Vec2,
  type Viewport,
  UTILITY,
  formatTick,
  visibleBounds,
  worldToScreen,
} from '@cs2/playbook'
import { THEME } from './theme.js'
import type { AppState } from './state.js'

/** Player hull is 32 units across; drawn slightly larger so it reads at map zoom. */
const ACTOR_RADIUS_UNITS = 26
/** Handles and hit targets are sized in screen pixels so zoom never makes them unusable. */
export const HANDLE_PX = 7

export interface Canvases {
  readonly map: HTMLCanvasElement
  readonly scene: HTMLCanvasElement
}

interface MapCacheKey {
  mapId: string
  scale: number
  cx: number
  cz: number
  layers: string
  callouts: boolean
  grid: boolean
  width: number
  height: number
}

let mapCache: MapCacheKey | null = null

export function invalidateMapLayer(): void {
  mapCache = null
}

/** Sets the backing-store size for a canvas, accounting for the device pixel ratio. */
function sizeCanvas(canvas: HTMLCanvasElement, vp: Viewport, dpr: number): CanvasRenderingContext2D | null {
  const w = Math.max(1, Math.round(vp.width * dpr))
  const h = Math.max(1, Math.round(vp.height * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
    mapCache = null
  }
  const ctx = canvas.getContext('2d')
  if (ctx === null) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

function toScreen(cam: Camera, vp: Viewport, p: Vec2): Vec2 {
  return worldToScreen(cam, vp, p)
}

function ringPath(ctx: CanvasRenderingContext2D, cam: Camera, vp: Viewport, points: readonly Vec2[]): void {
  ctx.beginPath()
  let first = true
  for (const p of points) {
    const s = toScreen(cam, vp, p)
    if (first) {
      ctx.moveTo(s.x, s.z)
      first = false
    } else {
      ctx.lineTo(s.x, s.z)
    }
  }
  ctx.closePath()
}

/** How much a region should be dimmed given the current layer filter. */
function layerAlpha(state: AppState, layer: Layer): number {
  return state.visibleLayers.has(layer) ? 1 : THEME.dimAlpha
}

// ─────────────────────────────────────────────────────────────────────────────
// Map layer
// ─────────────────────────────────────────────────────────────────────────────

const FILL: Record<Region['kind'], string> = {
  floor: THEME.floor,
  choke: THEME.choke,
  site: THEME.site,
  spawn: THEME.spawn,
  cover: THEME.cover,
  solid: THEME.coverEdge,
}

export function drawMapLayer(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  vp: Viewport,
  force: boolean,
): void {
  const cam = state.camera
  const key: MapCacheKey = {
    mapId: state.map.id,
    scale: cam.scale,
    cx: cam.center.x,
    cz: cam.center.z,
    layers: [...state.visibleLayers].sort().join(','),
    callouts: state.showCallouts,
    grid: state.showGrid,
    width: vp.width,
    height: vp.height,
  }
  if (!force && mapCache !== null && sameKey(mapCache, key)) return
  mapCache = key

  ctx.fillStyle = THEME.void
  ctx.fillRect(0, 0, vp.width, vp.height)

  if (state.showGrid) drawGrid(ctx, cam, vp)

  const view = visibleBounds(cam, vp)

  // Floors first, then cover on top — a two-pass draw so a crate is never buried under the
  // floor polygon of the room next door.
  for (const pass of ['floor', 'cover'] as const) {
    for (const region of state.map.regions) {
      const isCover = region.kind === 'cover' || region.kind === 'solid'
      if ((pass === 'cover') !== isCover) continue
      if (!intersectsView(region, view)) continue

      ctx.globalAlpha = layerAlpha(state, region.layer)
      ringPath(ctx, cam, vp, region.points)
      ctx.fillStyle = FILL[region.kind]
      ctx.fill()

      ctx.lineWidth = isCover ? 1.5 : 1
      ctx.strokeStyle =
        region.kind === 'site' ? THEME.siteEdge : isCover ? THEME.coverEdge : THEME.floorEdge
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  }

  drawSiteLabels(ctx, state, vp)
  if (state.showCallouts) drawCallouts(ctx, state, vp)
  drawScaleBar(ctx, cam, vp)
}

function sameKey(a: MapCacheKey, b: MapCacheKey): boolean {
  return (
    a.mapId === b.mapId &&
    a.scale === b.scale &&
    a.cx === b.cx &&
    a.cz === b.cz &&
    a.layers === b.layers &&
    a.callouts === b.callouts &&
    a.grid === b.grid &&
    a.width === b.width &&
    a.height === b.height
  )
}

function intersectsView(region: Region, view: { minX: number; minZ: number; maxX: number; maxZ: number }): boolean {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const p of region.points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.z < minZ) minZ = p.z
    if (p.z > maxZ) maxZ = p.z
  }
  return maxX >= view.minX && minX <= view.maxX && maxZ >= view.minZ && minZ <= view.maxZ
}

function drawGrid(ctx: CanvasRenderingContext2D, cam: Camera, vp: Viewport): void {
  const step = 256
  const view = visibleBounds(cam, vp)
  ctx.strokeStyle = THEME.grid
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = Math.floor(view.minX / step) * step; x <= view.maxX; x += step) {
    const s = toScreen(cam, vp, { x, z: view.minZ })
    const e = toScreen(cam, vp, { x, z: view.maxZ })
    ctx.moveTo(s.x, s.z)
    ctx.lineTo(e.x, e.z)
  }
  for (let z = Math.floor(view.minZ / step) * step; z <= view.maxZ; z += step) {
    const s = toScreen(cam, vp, { x: view.minX, z })
    const e = toScreen(cam, vp, { x: view.maxX, z })
    ctx.moveTo(s.x, s.z)
    ctx.lineTo(e.x, e.z)
  }
  ctx.stroke()
}

function drawSiteLabels(ctx: CanvasRenderingContext2D, state: AppState, vp: Viewport): void {
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const site of state.map.bombsites) {
    const c = toScreen(state.camera, vp, {
      x: (site.bounds.minX + site.bounds.maxX) / 2,
      z: (site.bounds.minZ + site.bounds.maxZ) / 2,
    })
    const size = Math.max(18, Math.min(90, 700 * state.camera.scale))
    ctx.font = `700 ${size}px system-ui, sans-serif`
    ctx.fillStyle = 'rgba(180, 120, 100, 0.16)'
    ctx.fillText(site.id, c.x, c.z)
  }
}

/**
 * Callout labels, with a crude declutterer.
 *
 * Labels are drawn in order and any label whose box overlaps one already drawn is skipped.
 * Combined with `minScale` on the fussier callouts, that keeps a zoomed-out view legible
 * without needing real label placement. A missing label at low zoom is fine; overlapping
 * mush is not.
 */
function drawCallouts(ctx: CanvasRenderingContext2D, state: AppState, vp: Viewport): void {
  const cam = state.camera
  const placed: { x: number; z: number; w: number; h: number }[] = []
  const size = Math.max(9, Math.min(14, 90 * cam.scale))
  ctx.font = `500 ${size}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  for (const c of state.map.callouts) {
    if (c.minScale !== undefined && cam.scale < c.minScale) continue
    const s = toScreen(cam, vp, c.at)
    if (s.x < -80 || s.x > vp.width + 80 || s.z < -20 || s.z > vp.height + 20) continue

    // Use the short form when zoomed out enough that the long one would collide.
    const text = cam.scale < 0.1 ? (c.short ?? c.name) : c.name
    const w = ctx.measureText(text).width + 6
    const h = size + 4
    const boxA = { x: s.x - w / 2, z: s.z - h / 2, w, h }
    if (placed.some((b) => overlaps(boxA, b))) continue
    placed.push(boxA)

    ctx.globalAlpha = layerAlpha(state, c.layer)
    ctx.fillStyle = c.minScale === undefined ? THEME.calloutMajor : THEME.callout
    ctx.fillText(text, s.x, s.z)
    ctx.globalAlpha = 1
  }
}

function overlaps(a: { x: number; z: number; w: number; h: number }, b: { x: number; z: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.z < b.z + b.h && a.z + a.h > b.z
}

/** A scale bar in sim units, plus the run time to cover it. Makes timings intuitive. */
function drawScaleBar(ctx: CanvasRenderingContext2D, cam: Camera, vp: Viewport): void {
  const units = 512
  const px = units * cam.scale
  if (px < 30 || px > vp.width * 0.6) return
  const x = 16
  const y = vp.height - 18
  ctx.strokeStyle = THEME.inkDim
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x + px, y)
  ctx.moveTo(x, y - 4)
  ctx.lineTo(x, y + 4)
  ctx.moveTo(x + px, y - 4)
  ctx.lineTo(x + px, y + 4)
  ctx.stroke()
  ctx.font = '11px system-ui, sans-serif'
  ctx.fillStyle = THEME.inkDim
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  ctx.fillText(`${units}u · ${(units / 250).toFixed(1)}s run`, x, y - 5)
}

// ─────────────────────────────────────────────────────────────────────────────
// Scene layer
// ─────────────────────────────────────────────────────────────────────────────

export function drawSceneLayer(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  vp: Viewport,
  frame: PlayFrame,
  tracksList: readonly ResolvedTrack[],
): void {
  ctx.clearRect(0, 0, vp.width, vp.height)
  const cam = state.camera
  const current = state.history.present

  if (state.showPaths) drawPaths(ctx, state, vp, tracksList, frame.tick)
  drawAnnotations(ctx, state, vp, frame)
  drawUtility(ctx, state, vp, frame)
  drawPlant(ctx, state, vp, current, frame)
  drawActors(ctx, state, vp, frame, current)
  drawDragPreview(ctx, state, vp)
  drawSelection(ctx, state, vp, frame)
  void cam
}

function actorById(current: Play, id: string) {
  return current.actors.find((a) => a.id === id)
}

function drawPaths(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  vp: Viewport,
  tracksList: readonly ResolvedTrack[],
  tick: number,
): void {
  const current = state.history.present
  for (const track of tracksList) {
    const actor = actorById(current, track.actorId)
    if (actor === undefined) continue
    if (state.hiddenTeams.has(actor.team)) continue

    const selected =
      (state.selection.kind === 'actor' || state.selection.kind === 'waypoint') &&
      state.selection.actorId === actor.id

    for (const leg of track.legs) {
      if (leg.holding || leg.length === 0) continue
      const a = toScreen(state.camera, vp, leg.from)
      const b = toScreen(state.camera, vp, leg.to)
      const walked = tick >= leg.toTick
      const active = tick >= leg.fromTick && tick < leg.toTick

      ctx.globalAlpha = layerAlpha(state, leg.layer) * (selected ? 1 : walked ? 0.5 : 0.32)
      ctx.strokeStyle = leg.impliedSpeed > 260 ? THEME.warn : actor.color
      ctx.lineWidth = (selected ? 2.6 : 1.8) * (active ? 1.5 : 1)
      // Quiet movement is dashed, so you can see at a glance where a play is silent.
      ctx.setLineDash(leg.mode === 'run' ? [] : leg.mode === 'walk' ? [7, 5] : [3, 4])
      ctx.beginPath()
      ctx.moveTo(a.x, a.z)
      ctx.lineTo(b.x, b.z)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }

    if (selected) drawWaypointHandles(ctx, state, vp, track.actorId)
  }
}

function drawWaypointHandles(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  vp: Viewport,
  actorId: string,
): void {
  const actor = actorById(state.history.present, actorId)
  if (actor === undefined) return
  actor.path.forEach((wp, index) => {
    const s = toScreen(state.camera, vp, wp.at)
    const isSel = state.selection.kind === 'waypoint' && state.selection.waypointId === wp.id
    ctx.beginPath()
    ctx.arc(s.x, s.z, isSel ? HANDLE_PX + 2 : HANDLE_PX - 1, 0, Math.PI * 2)
    ctx.fillStyle = isSel ? THEME.accent : THEME.void
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = actor.color
    ctx.stroke()
    // A pinned waypoint gets a ring, because "why is this leg slow" is otherwise invisible.
    if (wp.arriveTick !== undefined) {
      ctx.beginPath()
      ctx.arc(s.x, s.z, HANDLE_PX + 4, 0, Math.PI * 2)
      ctx.strokeStyle = THEME.accent
      ctx.lineWidth = 1
      ctx.stroke()
    }
    if (wp.holdTicks > 0) {
      ctx.fillStyle = THEME.ink
      ctx.font = '9px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('H', s.x, s.z)
    }
    void index
  })
}

function drawActors(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  vp: Viewport,
  frame: PlayFrame,
  current: Play,
): void {
  const radius = Math.max(4.5, ACTOR_RADIUS_UNITS * state.camera.scale)

  for (const af of frame.actors) {
    const actor = actorById(current, af.actorId)
    if (actor === undefined) continue
    if (state.hiddenTeams.has(actor.team)) continue

    const s = toScreen(state.camera, vp, af.at)
    ctx.globalAlpha = layerAlpha(state, af.layer)

    drawViewCone(ctx, s, af, radius)

    ctx.beginPath()
    ctx.arc(s.x, s.z, radius, 0, Math.PI * 2)
    ctx.fillStyle = actor.color
    ctx.fill()
    // CTs get a ring, Ts a solid disc — readable even in greyscale or for colour-blind users.
    ctx.lineWidth = 2
    ctx.strokeStyle = actor.team === 'CT' ? '#0d1014' : '#1b1206'
    ctx.stroke()

    if (af.waiting) {
      ctx.globalAlpha = layerAlpha(state, af.layer) * 0.45
      ctx.beginPath()
      ctx.arc(s.x, s.z, radius + 3, 0, Math.PI * 2)
      ctx.strokeStyle = THEME.inkDim
      ctx.lineWidth = 1
      ctx.stroke()
    }

    if (radius > 8) {
      ctx.globalAlpha = layerAlpha(state, af.layer)
      ctx.fillStyle = '#0d1014'
      ctx.font = `700 ${Math.round(radius * 0.95)}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(initials(actor.name), s.x, s.z + 0.5)
    }

    // Crouching and walking are the whole reason a play works or does not; label them.
    if (af.mode === 'crouch' || af.mode === 'walk') {
      ctx.fillStyle = THEME.inkDim
      ctx.font = '9px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText(af.mode === 'walk' ? 'walk' : 'crouch', s.x, s.z + radius + 3)
    }

    ctx.globalAlpha = 1
  }
}

/** A short facing wedge. Not a real LOS cone — it just shows which way someone is looking. */
function drawViewCone(ctx: CanvasRenderingContext2D, s: Vec2, af: ActorFrame, radius: number): void {
  const spread = 0.5
  const len = radius * 4.5
  ctx.beginPath()
  ctx.moveTo(s.x, s.z)
  ctx.arc(s.x, s.z, len, af.facing - spread, af.facing + spread)
  ctx.closePath()
  const grad = ctx.createRadialGradient(s.x, s.z, radius * 0.8, s.x, s.z, len)
  grad.addColorStop(0, 'rgba(255,255,255,0.16)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.fill()
}

/**
 * Two-character badge for an actor.
 *
 * Roles are routinely written with a parenthetical — "Entry (Long)", "AWP (Short)" — so the
 * words are filtered to those that actually start with a letter or digit first. Taking the
 * naive first character of each word turns "Entry (Long)" into "E(".
 */
function initials(name: string): string {
  const words = name
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== '')
  const first = words[0]
  if (first === undefined) return '?'
  const second = words[1]
  if (second === undefined) return first.slice(0, 2).toUpperCase()
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase()
}

function drawUtility(ctx: CanvasRenderingContext2D, state: AppState, vp: Viewport, frame: PlayFrame): void {
  for (const uf of frame.utility) {
    const spec = UTILITY[uf.kind]
    const s = toScreen(state.camera, vp, uf.at)
    const alpha = layerAlpha(state, uf.layer)

    if (uf.phase === 'flight') {
      ctx.globalAlpha = alpha * 0.9
      ctx.beginPath()
      ctx.arc(s.x, s.z, 3.5, 0, Math.PI * 2)
      ctx.fillStyle = spec.color
      ctx.fill()
      // Dotted line to the landing spot, so you can see where a nade in the air is going.
      const target = toScreen(state.camera, vp, findLanding(state, uf))
      ctx.setLineDash([2, 4])
      ctx.strokeStyle = spec.color
      ctx.globalAlpha = alpha * 0.35
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(s.x, s.z)
      ctx.lineTo(target.x, target.z)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
      continue
    }

    const r = Math.max(3, uf.radius * state.camera.scale)
    ctx.globalAlpha = alpha * (uf.kind === 'smoke' ? 0.72 : 0.42) * uf.intensity
    ctx.beginPath()
    ctx.arc(s.x, s.z, r, 0, Math.PI * 2)
    ctx.fillStyle = spec.color
    ctx.fill()
    ctx.globalAlpha = alpha * uf.intensity
    ctx.lineWidth = 1.5
    ctx.strokeStyle = spec.color
    ctx.stroke()

    if (r > 14) {
      ctx.fillStyle = '#11161c'
      ctx.font = `600 ${Math.min(12, Math.round(r * 0.45))}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(spec.label.charAt(0), s.x, s.z)
    }
    ctx.globalAlpha = 1
  }
}

function findLanding(state: AppState, uf: UtilityFrame): Vec2 {
  const ev = state.history.present.utility.find((e) => e.id === uf.eventId)
  return ev?.to ?? uf.at
}

function drawAnnotations(ctx: CanvasRenderingContext2D, state: AppState, vp: Viewport, frame: PlayFrame): void {
  for (const a of frame.annotations) {
    ctx.globalAlpha = layerAlpha(state, a.layer)
    const pts = a.points.map((p) => toScreen(state.camera, vp, p))
    const first = pts[0]
    if (first === undefined) continue

    if (a.kind === 'text') {
      ctx.font = '600 13px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const w = ctx.measureText(a.text).width
      ctx.fillStyle = 'rgba(13,16,20,0.78)'
      ctx.fillRect(first.x - w / 2 - 6, first.z - 10, w + 12, 20)
      ctx.fillStyle = a.color
      ctx.fillText(a.text, first.x, first.z)
    } else if (a.kind === 'arrow') {
      const last = pts[pts.length - 1] ?? first
      ctx.strokeStyle = a.color
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(first.x, first.z)
      ctx.lineTo(last.x, last.z)
      ctx.stroke()
      const angle = Math.atan2(last.z - first.z, last.x - first.x)
      ctx.beginPath()
      ctx.moveTo(last.x, last.z)
      ctx.lineTo(last.x - 12 * Math.cos(angle - 0.4), last.z - 12 * Math.sin(angle - 0.4))
      ctx.lineTo(last.x - 12 * Math.cos(angle + 0.4), last.z - 12 * Math.sin(angle + 0.4))
      ctx.closePath()
      ctx.fillStyle = a.color
      ctx.fill()
    } else {
      ctx.beginPath()
      ctx.moveTo(first.x, first.z)
      for (const p of pts.slice(1)) ctx.lineTo(p.x, p.z)
      ctx.closePath()
      ctx.fillStyle = a.color
      ctx.globalAlpha = layerAlpha(state, a.layer) * 0.16
      ctx.fill()
      ctx.globalAlpha = layerAlpha(state, a.layer) * 0.8
      ctx.strokeStyle = a.color
      ctx.lineWidth = 1.5
      ctx.setLineDash([6, 4])
      ctx.stroke()
      ctx.setLineDash([])
      if (a.text !== '') {
        ctx.fillStyle = a.color
        ctx.font = '600 11px system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText(a.text, first.x, first.z - 6)
      }
    }
    ctx.globalAlpha = 1
  }
}

function drawPlant(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  vp: Viewport,
  current: Play,
  frame: PlayFrame,
): void {
  if (current.plant === null) return
  if (frame.tick < current.plant.tick) return
  const s = toScreen(state.camera, vp, current.plant.at)
  const planting = !frame.planted
  ctx.globalAlpha = planting ? 0.5 + 0.5 * Math.sin(frame.tick * 0.4) : 1
  ctx.beginPath()
  ctx.arc(s.x, s.z, 7, 0, Math.PI * 2)
  ctx.fillStyle = THEME.bomb
  ctx.fill()
  ctx.strokeStyle = '#0d1014'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.fillStyle = THEME.bomb
  ctx.font = '600 10px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.fillText(planting ? 'planting' : 'planted', s.x, s.z - 10)
}

/** Rubber-band feedback while a utility throw or an annotation is being dragged out. */
function drawDragPreview(ctx: CanvasRenderingContext2D, state: AppState, vp: Viewport): void {
  const drag = state.drag
  if (drag === null) return
  if (drag.kind !== 'draw' && drag.kind !== 'measure') return

  const a = toScreen(state.camera, vp, drag.originWorld)
  const b = toScreen(state.camera, vp, drag.currentWorld)

  ctx.strokeStyle = drag.kind === 'measure' ? THEME.accent : THEME.ink
  ctx.lineWidth = 1.5
  ctx.setLineDash([5, 4])
  ctx.beginPath()
  ctx.moveTo(a.x, a.z)
  ctx.lineTo(b.x, b.z)
  ctx.stroke()
  ctx.setLineDash([])

  const dx = drag.currentWorld.x - drag.originWorld.x
  const dz = drag.currentWorld.z - drag.originWorld.z
  const dist = Math.sqrt(dx * dx + dz * dz)
  const label =
    drag.kind === 'measure'
      ? `${Math.round(dist)}u · run ${formatTick((dist / 250) * 64)} · walk ${formatTick((dist / 130) * 64)}`
      : `${Math.round(dist)}u`

  ctx.font = '600 12px system-ui, sans-serif'
  const w = ctx.measureText(label).width
  ctx.fillStyle = 'rgba(13,16,20,0.85)'
  ctx.fillRect(b.x + 10, b.z - 20, w + 12, 20)
  ctx.fillStyle = THEME.ink
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, b.x + 16, b.z - 10)
}

function drawSelection(ctx: CanvasRenderingContext2D, state: AppState, vp: Viewport, frame: PlayFrame): void {
  const sel = state.selection
  if (sel.kind === 'utility') {
    const ev = state.history.present.utility.find((e) => e.id === sel.eventId)
    if (ev === undefined) return
    const from = toScreen(state.camera, vp, ev.from)
    const to = toScreen(state.camera, vp, ev.to)
    ctx.strokeStyle = THEME.accent
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(from.x, from.z)
    ctx.lineTo(to.x, to.z)
    ctx.stroke()
    ctx.setLineDash([])
    for (const p of [from, to]) {
      ctx.beginPath()
      ctx.arc(p.x, p.z, HANDLE_PX, 0, Math.PI * 2)
      ctx.fillStyle = THEME.void
      ctx.fill()
      ctx.strokeStyle = THEME.accent
      ctx.lineWidth = 2
      ctx.stroke()
    }
  }
  void frame
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame entry point
// ─────────────────────────────────────────────────────────────────────────────

export function render(
  canvases: Canvases,
  state: AppState,
  frame: PlayFrame,
  tracksList: readonly ResolvedTrack[],
): Viewport {
  const dpr = Math.min(2.5, globalThis.devicePixelRatio || 1)
  const rect = canvases.scene.getBoundingClientRect()
  const vp: Viewport = { width: Math.max(1, rect.width), height: Math.max(1, rect.height) }

  const mapCtx = sizeCanvas(canvases.map, vp, dpr)
  const sceneCtx = sizeCanvas(canvases.scene, vp, dpr)
  if (mapCtx === null || sceneCtx === null) return vp

  drawMapLayer(mapCtx, state, vp, false)
  drawSceneLayer(sceneCtx, state, vp, frame, tracksList)
  return vp
}

/** Re-exported so panel modules can type a map without a second import path. */
export type { MapDef }
