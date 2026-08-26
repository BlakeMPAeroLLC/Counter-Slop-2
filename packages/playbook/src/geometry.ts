/**
 * Ground-plane geometry helpers.
 *
 * All of it is plain `number` math on `Vec2` in sim units. Nothing here needs the sim's
 * deterministic trig helpers: the playbook is a single-machine drawing tool, so a last-bit
 * difference between `Math.atan2` on V8 and on SpiderMonkey is invisible. (That is exactly
 * why this lives outside `packages/sim`, where such calls are banned.)
 */

import type { Bounds, Vec2 } from './types.js'

export function vec(x: number, z: number): Vec2 {
  return { x, z }
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, z: a.z + b.z }
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, z: a.z - b.z }
}

export function scale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, z: a.z * k }
}

export function length(a: Vec2): number {
  return Math.sqrt(a.x * a.x + a.z * a.z)
}

export function distance(a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dz = b.z - a.z
  return Math.sqrt(dx * dx + dz * dz)
}

/** Returns a unit vector, or `{0,0}` for a zero-length input rather than NaN. */
export function normalize(a: Vec2): Vec2 {
  const len = length(a)
  if (len === 0) return { x: 0, z: 0 }
  return { x: a.x / len, z: a.z / len }
}

/** Linear interpolation. `t` is not clamped — callers that need clamping do it themselves. */
export function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }
}

/**
 * Heading of `b` as seen from `a`, in radians.
 *
 * 0 points +x (screen right) and increases towards +z (screen down), which matches how the
 * canvas renderer rotates sprites, so a facing angle can be handed straight to `rotate()`.
 */
export function heading(a: Vec2, b: Vec2): number {
  return Math.atan2(b.z - a.z, b.x - a.x)
}

/** Shortest signed difference between two angles, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d <= -Math.PI) d += Math.PI * 2
  return d
}

/** Interpolates between two angles the short way round. */
export function lerpAngle(from: number, to: number, t: number): number {
  return from + angleDelta(from, to) * t
}

// ─────────────────────────────────────────────────────────────────────────────
// Polylines
// ─────────────────────────────────────────────────────────────────────────────

/** Total length of a polyline. Zero for fewer than two points. */
export function polylineLength(points: readonly Vec2[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (a === undefined || b === undefined) continue
    total += distance(a, b)
  }
  return total
}

/**
 * Point at `along` units from the start of a polyline.
 *
 * Clamps at both ends, so an overshoot parks on the last vertex instead of extrapolating off
 * the map.
 */
export function pointAlongPolyline(points: readonly Vec2[], along: number): Vec2 {
  const first = points[0]
  if (first === undefined) return { x: 0, z: 0 }
  if (points.length === 1 || along <= 0) return first

  let remaining = along
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (a === undefined || b === undefined) continue
    const segLen = distance(a, b)
    if (segLen === 0) continue
    if (remaining <= segLen) return lerp(a, b, remaining / segLen)
    remaining -= segLen
  }

  const last = points[points.length - 1]
  return last ?? first
}

// ─────────────────────────────────────────────────────────────────────────────
// Hit testing
// ─────────────────────────────────────────────────────────────────────────────

/** Squared distance from `p` to segment `a`-`b`. Squared to keep hit tests sqrt-free. */
export function distanceToSegmentSq(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x
  const abz = b.z - a.z
  const lenSq = abx * abx + abz * abz
  if (lenSq === 0) {
    const dx = p.x - a.x
    const dz = p.z - a.z
    return dx * dx + dz * dz
  }
  let t = ((p.x - a.x) * abx + (p.z - a.z) * abz) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = a.x + abx * t
  const cz = a.z + abz * t
  const dx = p.x - cx
  const dz = p.z - cz
  return dx * dx + dz * dz
}

export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  return Math.sqrt(distanceToSegmentSq(p, a, b))
}

/**
 * Crossing-number point-in-polygon test.
 *
 * Handles concave rings, which matters because several Dust 2 regions (the A site plateau
 * with its goose cut-out, B site with the back platform) are naturally concave.
 */
export function pointInPolygon(p: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a === undefined || b === undefined) continue
    const straddles = a.z > p.z !== b.z > p.z
    if (!straddles) continue
    const t = (p.z - a.z) / (b.z - a.z)
    if (p.x < a.x + t * (b.x - a.x)) inside = !inside
  }
  return inside
}

export function pointInBounds(p: Vec2, b: Bounds): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ
}

/** Bounding box of a point set. Returns a zero-size box at the origin when empty. */
export function boundsOf(points: readonly Vec2[]): Bounds {
  const first = points[0]
  if (first === undefined) return { minX: 0, minZ: 0, maxX: 0, maxZ: 0 }
  let minX = first.x
  let maxX = first.x
  let minZ = first.z
  let maxZ = first.z
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.z < minZ) minZ = p.z
    if (p.z > maxZ) maxZ = p.z
  }
  return { minX, minZ, maxX, maxZ }
}

export function boundsCenter(b: Bounds): Vec2 {
  return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 }
}

/** Grows bounds by `pad` units on every side. */
export function expandBounds(b: Bounds, pad: number): Bounds {
  return {
    minX: b.minX - pad,
    minZ: b.minZ - pad,
    maxX: b.maxX + pad,
    maxZ: b.maxZ + pad,
  }
}

/** A rectangle as a four-point ring, the workhorse of hand-authored map geometry. */
export function rectRing(minX: number, minZ: number, maxX: number, maxZ: number): Vec2[] {
  return [
    { x: minX, z: minZ },
    { x: maxX, z: minZ },
    { x: maxX, z: maxZ },
    { x: minX, z: maxZ },
  ]
}
