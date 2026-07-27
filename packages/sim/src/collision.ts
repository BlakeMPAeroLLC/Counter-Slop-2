/**
 * Collision primitives.
 *
 * Everything here is one idea applied twice: sweeping an axis-aligned hull against an
 * axis-aligned brush is identical to casting a *ray* against that brush expanded by the
 * hull's extents (a Minkowski sum). So there is a single slab test, and a ray is just a
 * hull with zero extents. That keeps the exact-arithmetic surface small, which is what
 * makes determinism auditable.
 *
 * A player's origin is the centre of the bottom face of their hull, so the hull occupies
 *   [x-hw, x+hw] x [y, y+height] x [z-hw, z+hw]
 * and overlaps a brush exactly when the origin lies inside that brush expanded to
 *   [bx0-hw, by0-height, bz0-hw] .. [bx1+hw, by1, bz1+hw]
 */

import type { MapData } from './map.js'
import type { Vec3 } from './math.js'

/** Below this, a motion component counts as parallel to the slab. */
const PARALLEL_EPSILON = 1e-9

export interface TraceResult {
  /** Fraction of the requested motion completed before impact, in [0, 1]. */
  fraction: number
  hit: boolean
  /** Surface normal at the impact, axis-aligned. Zero when `hit` is false. */
  nx: number
  ny: number
  nz: number
  /** Index of the brush struck, or -1. */
  brush: number
  /** True when the sweep began already inside solid geometry. */
  startSolid: boolean
}

export function createTrace(): TraceResult {
  return { fraction: 1, hit: false, nx: 0, ny: 0, nz: 0, brush: -1, startSolid: false }
}

function resetTrace(t: TraceResult): void {
  t.fraction = 1
  t.hit = false
  t.nx = 0
  t.ny = 0
  t.nz = 0
  t.brush = -1
  t.startSolid = false
}

/**
 * Sweeps a hull of half-width `hw` and height `h` from `pos` along `delta`, against every
 * brush in the map. Writes the earliest impact into `out`.
 *
 * Pass `hw = 0, h = 0` to cast a ray; `delta` then carries both direction and length, and
 * `out.fraction * |delta|` is the hit distance.
 *
 * Brushes are visited in index order and ties break toward the lower index, so the result
 * does not depend on iteration accidents.
 */
export function sweepHull(
  map: MapData,
  pos: Vec3,
  delta: Vec3,
  hw: number,
  h: number,
  out: TraceResult,
): TraceResult {
  resetTrace(out)

  const brushes = map.brushes
  const px = pos.x
  const py = pos.y
  const pz = pos.z
  const dx = delta.x
  const dy = delta.y
  const dz = delta.z

  let bestT = 1
  let bestAxis = -1
  let bestSign = 0
  let bestBrush = -1

  for (let i = 0; i < map.brushCount; i++) {
    const o = i * 6
    // Minkowski-expanded slab bounds for this brush.
    const eMinX = brushes[o]! - hw
    const eMinY = brushes[o + 1]! - h
    const eMinZ = brushes[o + 2]! - hw
    const eMaxX = brushes[o + 3]! + hw
    const eMaxY = brushes[o + 4]!
    const eMaxZ = brushes[o + 5]! + hw

    let tEnter = -Infinity
    let tExit = Infinity
    let axis = -1
    let sign = 0
    let miss = false

    // ── X slab ──
    if (dx > -PARALLEL_EPSILON && dx < PARALLEL_EPSILON) {
      if (px <= eMinX || px >= eMaxX) miss = true
    } else {
      const inv = 1 / dx
      let t1 = (eMinX - px) * inv
      let t2 = (eMaxX - px) * inv
      if (t1 > t2) {
        const tmp = t1
        t1 = t2
        t2 = tmp
      }
      if (t1 > tEnter) {
        tEnter = t1
        axis = 0
        sign = dx > 0 ? -1 : 1
      }
      if (t2 < tExit) tExit = t2
      if (tEnter > tExit) miss = true
    }

    // ── Y slab ──
    if (!miss) {
      if (dy > -PARALLEL_EPSILON && dy < PARALLEL_EPSILON) {
        if (py <= eMinY || py >= eMaxY) miss = true
      } else {
        const inv = 1 / dy
        let t1 = (eMinY - py) * inv
        let t2 = (eMaxY - py) * inv
        if (t1 > t2) {
          const tmp = t1
          t1 = t2
          t2 = tmp
        }
        if (t1 > tEnter) {
          tEnter = t1
          axis = 1
          sign = dy > 0 ? -1 : 1
        }
        if (t2 < tExit) tExit = t2
        if (tEnter > tExit) miss = true
      }
    }

    // ── Z slab ──
    if (!miss) {
      if (dz > -PARALLEL_EPSILON && dz < PARALLEL_EPSILON) {
        if (pz <= eMinZ || pz >= eMaxZ) miss = true
      } else {
        const inv = 1 / dz
        let t1 = (eMinZ - pz) * inv
        let t2 = (eMaxZ - pz) * inv
        if (t1 > t2) {
          const tmp = t1
          t1 = t2
          t2 = tmp
        }
        if (t1 > tEnter) {
          tEnter = t1
          axis = 2
          sign = dz > 0 ? -1 : 1
        }
        if (t2 < tExit) tExit = t2
        if (tEnter > tExit) miss = true
      }
    }

    if (miss) continue

    // Origin already inside the expanded box: we are penetrating this brush. Report it so
    // the caller can depenetrate, but do not treat it as an impact — that is how solvers
    // get stuck permanently.
    if (tEnter < 0) {
      if (tExit > 0) out.startSolid = true
      continue
    }

    if (tEnter < bestT) {
      bestT = tEnter
      bestAxis = axis
      bestSign = sign
      bestBrush = i
    }
  }

  if (bestBrush >= 0) {
    out.hit = true
    out.fraction = bestT
    out.brush = bestBrush
    if (bestAxis === 0) out.nx = bestSign
    else if (bestAxis === 1) out.ny = bestSign
    else out.nz = bestSign
  }

  return out
}

/** True when a hull placed at (x, y, z) intersects any brush. */
export function hullOverlaps(
  map: MapData,
  x: number,
  y: number,
  z: number,
  hw: number,
  h: number,
): boolean {
  const brushes = map.brushes
  for (let i = 0; i < map.brushCount; i++) {
    const o = i * 6
    if (
      x > brushes[o]! - hw &&
      x < brushes[o + 3]! + hw &&
      y > brushes[o + 1]! - h &&
      y < brushes[o + 4]! &&
      z > brushes[o + 2]! - hw &&
      z < brushes[o + 5]! + hw
    ) {
      return true
    }
  }
  return false
}

/**
 * Pushes a penetrating hull back out along the axis of least penetration.
 *
 * This is a safety net, not the main path: the solver backs off by an epsilon after every
 * impact specifically so this rarely fires. But floating-point grazes at brush seams do
 * happen, and a player stuck inside geometry is the single most rage-inducing bug in a
 * shooter, so it is worth the handful of lines.
 *
 * Mutates `pos`. Returns true if a correction was applied.
 */
export function depenetrateHull(map: MapData, pos: Vec3, hw: number, h: number): boolean {
  const brushes = map.brushes
  let corrected = false

  for (let i = 0; i < map.brushCount; i++) {
    const o = i * 6
    const eMinX = brushes[o]! - hw
    const eMinY = brushes[o + 1]! - h
    const eMinZ = brushes[o + 2]! - hw
    const eMaxX = brushes[o + 3]! + hw
    const eMaxY = brushes[o + 4]!
    const eMaxZ = brushes[o + 5]! + hw

    if (
      pos.x <= eMinX ||
      pos.x >= eMaxX ||
      pos.y <= eMinY ||
      pos.y >= eMaxY ||
      pos.z <= eMinZ ||
      pos.z >= eMaxZ
    ) {
      continue
    }

    // Distance to each face; pick the cheapest escape.
    const dxMin = pos.x - eMinX
    const dxMax = eMaxX - pos.x
    const dyMin = pos.y - eMinY
    const dyMax = eMaxY - pos.y
    const dzMin = pos.z - eMinZ
    const dzMax = eMaxZ - pos.z

    let best = dxMin
    let axis = 0
    let dir = -1
    if (dxMax < best) {
      best = dxMax
      axis = 0
      dir = 1
    }
    if (dyMin < best) {
      best = dyMin
      axis = 1
      dir = -1
    }
    if (dyMax < best) {
      best = dyMax
      axis = 1
      dir = 1
    }
    if (dzMin < best) {
      best = dzMin
      axis = 2
      dir = -1
    }
    if (dzMax < best) {
      best = dzMax
      axis = 2
      dir = 1
    }

    const push = best + 1e-4
    if (axis === 0) pos.x += push * dir
    else if (axis === 1) pos.y += push * dir
    else pos.z += push * dir

    corrected = true
  }

  return corrected
}

/**
 * Removes the component of `vel` that points into a surface, so the remaining motion
 * slides along it. `overbounce` of 1 is a pure projection; Source uses slightly above 1
 * to keep the hull from creeping into the plane over many ticks.
 */
export function clipVelocity(
  vel: Vec3,
  nx: number,
  ny: number,
  nz: number,
  overbounce = 1.0,
): void {
  const backoff = (vel.x * nx + vel.y * ny + vel.z * nz) * overbounce
  vel.x -= nx * backoff
  vel.y -= ny * backoff
  vel.z -= nz * backoff
}
