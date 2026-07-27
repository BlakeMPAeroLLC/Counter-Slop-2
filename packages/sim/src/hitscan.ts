/**
 * Bullet tracing.
 *
 * M0 uses a two-box hitbox model per player: a narrow head box on top of a body box.
 * The full eight-capsule skeleton-driven set arrives in M2. Two boxes is enough to make
 * headshots work on day one, which is the part that carries the feel.
 *
 * Hit detection deliberately never uses the render mesh — it is too slow, varies with LOD,
 * and would make hit registration depend on graphics settings.
 */

import { createTrace, sweepHull, type TraceResult } from './collision.js'
import { HITBOX, HITBOX_MULT, MOVE, PLAYER, SIM } from './constants.js'
import { dpow, vec3, vset, type Vec3 } from './math.js'
import { hullHeight } from './movement.js'
import { PFLAG, type World } from './world.js'

export interface BulletHit {
  /** Distance travelled before impact. Equals `maxDist` when nothing was struck. */
  distance: number
  /** Index of the player struck, or -1. */
  player: number
  /** One of `HITBOX.*`. Meaningless when `player` is -1. */
  hitbox: number
  /** True if world geometry stopped the bullet. */
  world: boolean
  /** Impact point. */
  x: number
  y: number
  z: number
}

export function createBulletHit(): BulletHit {
  return { distance: 0, player: -1, hitbox: HITBOX.BODY, world: false, x: 0, y: 0, z: 0 }
}

const worldTrace: TraceResult = createTrace()
const rayDelta = vec3()

/** Eye position for a player index — the bullet origin and the camera position. */
export function eyePosition(world: World, i: number, out: Vec3): Vec3 {
  const p = world.p
  const crouching = (p.flags[i]! & PFLAG.CROUCHING) !== 0
  return vset(
    out,
    p.posX[i]!,
    p.posY[i]! + (crouching ? MOVE.EYE_HEIGHT_CROUCH : MOVE.EYE_HEIGHT_STAND),
    p.posZ[i]!,
  )
}

/**
 * Ray against an axis-aligned box. Returns the entry distance along `dir`, or -1 for a
 * miss. `dir` must be unit length.
 */
function rayAabb(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  maxDist: number,
): number {
  let tEnter = 0
  let tExit = maxDist

  // X
  if (dx > -1e-9 && dx < 1e-9) {
    if (ox <= minX || ox >= maxX) return -1
  } else {
    const inv = 1 / dx
    let t1 = (minX - ox) * inv
    let t2 = (maxX - ox) * inv
    if (t1 > t2) {
      const tmp = t1
      t1 = t2
      t2 = tmp
    }
    if (t1 > tEnter) tEnter = t1
    if (t2 < tExit) tExit = t2
    if (tEnter > tExit) return -1
  }

  // Y
  if (dy > -1e-9 && dy < 1e-9) {
    if (oy <= minY || oy >= maxY) return -1
  } else {
    const inv = 1 / dy
    let t1 = (minY - oy) * inv
    let t2 = (maxY - oy) * inv
    if (t1 > t2) {
      const tmp = t1
      t1 = t2
      t2 = tmp
    }
    if (t1 > tEnter) tEnter = t1
    if (t2 < tExit) tExit = t2
    if (tEnter > tExit) return -1
  }

  // Z
  if (dz > -1e-9 && dz < 1e-9) {
    if (oz <= minZ || oz >= maxZ) return -1
  } else {
    const inv = 1 / dz
    let t1 = (minZ - oz) * inv
    let t2 = (maxZ - oz) * inv
    if (t1 > t2) {
      const tmp = t1
      t1 = t2
      t2 = tmp
    }
    if (t1 > tEnter) tEnter = t1
    if (t2 < tExit) tExit = t2
    if (tEnter > tExit) return -1
  }

  return tEnter
}

/**
 * Traces a bullet through the world and every living player except the shooter.
 *
 * World geometry is tested first so a bullet cannot register a hit on someone standing
 * behind a wall. Players are then only accepted if they are nearer than the wall.
 *
 * Head is tested before body per player, and players are visited in index order with ties
 * breaking toward the lower index, so the outcome is order-independent.
 */
export function traceBullet(
  world: World,
  shooter: number,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  out: BulletHit,
): BulletHit {
  out.player = -1
  out.hitbox = HITBOX.BODY
  out.world = false
  out.distance = maxDist

  // World geometry: a ray is a hull with zero extents.
  vset(rayDelta, dir.x * maxDist, dir.y * maxDist, dir.z * maxDist)
  sweepHull(world.map, origin, rayDelta, 0, 0, worldTrace)
  if (worldTrace.hit) {
    out.distance = worldTrace.fraction * maxDist
    out.world = true
  }

  const p = world.p
  for (let i = 0; i < SIM.MAX_PLAYERS; i++) {
    if (i === shooter) continue
    if (p.active[i] === 0) continue
    if ((p.flags[i]! & PFLAG.DEAD) !== 0) continue

    const crouching = (p.flags[i]! & PFLAG.CROUCHING) !== 0
    const h = hullHeight(crouching)
    const px = p.posX[i]!
    const py = p.posY[i]!
    const pz = p.posZ[i]!
    const hw = MOVE.HULL_HALF_WIDTH
    const headBase = py + h - PLAYER.HEAD_HEIGHT
    const hhw = PLAYER.HEAD_HALF_WIDTH

    // Head first: it overlaps the top of the body box, and it is the hit we prefer.
    const tHead = rayAabb(
      origin.x,
      origin.y,
      origin.z,
      dir.x,
      dir.y,
      dir.z,
      px - hhw,
      headBase,
      pz - hhw,
      px + hhw,
      py + h,
      pz + hhw,
      out.distance,
    )
    if (tHead >= 0 && tHead < out.distance) {
      out.distance = tHead
      out.player = i
      out.hitbox = HITBOX.HEAD
      out.world = false
      continue
    }

    const tBody = rayAabb(
      origin.x,
      origin.y,
      origin.z,
      dir.x,
      dir.y,
      dir.z,
      px - hw,
      py,
      pz - hw,
      px + hw,
      headBase,
      pz + hw,
      out.distance,
    )
    if (tBody >= 0 && tBody < out.distance) {
      out.distance = tBody
      out.player = i
      out.hitbox = HITBOX.BODY
      out.world = false
    }
  }

  out.x = origin.x + dir.x * out.distance
  out.y = origin.y + dir.y * out.distance
  out.z = origin.z + dir.z * out.distance
  return out
}

/**
 * Final damage for a hit: base damage, scaled by the hitbox multiplier, then attenuated
 * with distance. Falloff is expressed per 500 units so the constant reads as
 * "fraction of damage retained every 500 units".
 */
export function computeDamage(
  base: number,
  hitbox: number,
  distance: number,
  falloff: number,
): number {
  const mult = HITBOX_MULT[hitbox] ?? 1
  return base * mult * dpow(falloff, distance / 500)
}
