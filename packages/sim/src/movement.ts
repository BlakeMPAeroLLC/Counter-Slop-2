/**
 * The movement solver.
 *
 * This is a hand-written swept-hull character controller in the Source lineage, not a
 * rigid-body physics controller. That is the single most important engineering choice in
 * the project (docs/PLAN.md §3): a physics-engine character controller is non-deterministic
 * under rollback, feels floaty, and cannot be persuaded to air-strafe. ~350 lines of
 * explicit arithmetic buys exact reproducibility and total control over feel.
 *
 * The pipeline per tick, in order — the order is load-bearing:
 *
 *   1. resolve crouch state (blocked from standing up under an overhang)
 *   2. categorise position (are we on the ground?)
 *   3. jump  — before friction, so a bunnyhop keeps its horizontal speed
 *   4. grounded: friction -> accelerate -> horizontal slide with step-up
 *      airborne: half gravity -> air-accelerate -> slide -> half gravity
 *   5. re-categorise, recording landing speed for fall damage
 *
 * Counter-strafing is not a special case anywhere in here. It emerges from
 * `accelerate()` seeing a large `addSpeed` when the wish direction opposes current
 * velocity. Getting the friction/accel pair right is what makes it feel crisp.
 */

import { clipVelocity, createTrace, depenetrateHull, hullOverlaps, sweepHull } from './collision.js'
import { MOVE, SIM } from './constants.js'
import type { MapData } from './map.js'
import { vec3, vset, yawForward, yawRight, type Vec3 } from './math.js'

export interface MoveInput {
  /** -1 (back) .. +1 (forward). */
  forwardMove: number
  /** -1 (left) .. +1 (right). */
  sideMove: number
  yaw: number
  jump: boolean
  crouch: boolean
  walk: boolean
}

/**
 * The mutable movement state of one player. `tick.ts` loads this out of the SoA world
 * arrays, steps it, and stores it back — keeping the solver independent of storage layout
 * and directly unit-testable.
 */
export interface MoveBody {
  pos: Vec3
  vel: Vec3
  onGround: boolean
  crouching: boolean
  jumpCount: number
  /** Output: downward speed at the moment of landing this tick, else 0. */
  landedSpeed: number
}

export function createBody(): MoveBody {
  return {
    pos: vec3(),
    vel: vec3(),
    onGround: false,
    crouching: false,
    jumpCount: 0,
    landedSpeed: 0,
  }
}

export function hullHeight(crouching: boolean): number {
  return crouching ? MOVE.HULL_HEIGHT_CROUCH : MOVE.HULL_HEIGHT_STAND
}

export function eyeHeight(crouching: boolean): number {
  return crouching ? MOVE.EYE_HEIGHT_CROUCH : MOVE.EYE_HEIGHT_STAND
}

// ── Module-level scratch ────────────────────────────────────────────────────
// `moveBody` is not reentrant, which makes shared scratch safe and keeps the tick
// allocation-free. See the note in math.ts about GC pauses.

const trace = createTrace()
const scratchFwd = vec3()
const scratchRight = vec3()
const wishDir = vec3()
const delta = vec3()
const startPos = vec3()
const startVel = vec3()
const downPos = vec3()
const downVel = vec3()

const planeNx = new Float64Array(MOVE.MAX_CLIP_PLANES + 1)
const planeNy = new Float64Array(MOVE.MAX_CLIP_PLANES + 1)
const planeNz = new Float64Array(MOVE.MAX_CLIP_PLANES + 1)

/** Advances one player's movement by exactly one simulation tick. */
export function moveBody(map: MapData, body: MoveBody, input: MoveInput): void {
  const dt = SIM.DT
  body.landedSpeed = 0

  resolveCrouch(map, body, input)
  categorizePosition(map, body)

  // Jump is evaluated before the ground/air branch on purpose. A successful jump clears
  // `onGround`, which routes us into the air branch and therefore skips friction — that
  // is what lets a chained hop retain its speed.
  if (input.jump) {
    if (body.onGround && body.jumpCount < MOVE.MAX_CONSECUTIVE_JUMPS) {
      body.vel.y = MOVE.JUMP
      body.onGround = false
      body.jumpCount++
    }
  } else {
    // Releasing the key resets the chain, so holding jump cannot hop forever.
    body.jumpCount = 0
  }

  const maxSpeed = input.crouch ? MOVE.CROUCH : input.walk ? MOVE.WALK : MOVE.RUN
  const wishSpeed = computeWish(input, maxSpeed)

  if (body.onGround) {
    applyFriction(body, dt)
    accelerate(body, wishSpeed, MOVE.ACCEL, dt)
    body.vel.y = 0
    stepSlide(map, body, dt)
  } else {
    body.vel.y -= MOVE.GRAVITY * 0.5 * dt
    airAccelerate(body, wishSpeed, MOVE.AIR_ACCEL, dt)
    slideMove(map, body, dt, false)
    body.vel.y -= MOVE.GRAVITY * 0.5 * dt

    if (body.vel.y < -MOVE.MAX_FALL_SPEED) body.vel.y = -MOVE.MAX_FALL_SPEED
  }

  categorizePosition(map, body)

  // Safety net for floating-point grazes at brush seams.
  if (depenetrateHull(map, body.pos, MOVE.HULL_HALF_WIDTH, hullHeight(body.crouching))) {
    categorizePosition(map, body)
  }
}

/**
 * Crouching is instant; standing up requires headroom. Without the overhang check a
 * player can stand up inside geometry and get shoved through a wall by depenetration.
 */
function resolveCrouch(map: MapData, body: MoveBody, input: MoveInput): void {
  if (input.crouch) {
    body.crouching = true
    return
  }
  if (!body.crouching) return

  const canStand = !hullOverlaps(
    map,
    body.pos.x,
    body.pos.y,
    body.pos.z,
    MOVE.HULL_HALF_WIDTH,
    MOVE.HULL_HEIGHT_STAND,
  )
  if (canStand) body.crouching = false
}

/**
 * Determines whether we are standing on something, snapping to the surface if so.
 *
 * Skipped while moving upward faster than the jump impulse could leave us, otherwise a
 * jump would immediately re-detect the floor it just left.
 */
function categorizePosition(map: MapData, body: MoveBody): void {
  if (body.vel.y > MOVE.JUMP * 0.5) {
    body.onGround = false
    return
  }

  const h = hullHeight(body.crouching)
  vset(delta, 0, -MOVE.GROUND_TRACE_DIST, 0)
  sweepHull(map, body.pos, delta, MOVE.HULL_HALF_WIDTH, h, trace)

  if (trace.hit && trace.ny >= MOVE.GROUND_NORMAL_Y) {
    body.onGround = true
    // Rest on the surface rather than hovering a couple of units above it.
    body.pos.y += delta.y * trace.fraction + MOVE.SURFACE_EPSILON
    if (body.vel.y < 0) body.vel.y = 0
  } else {
    body.onGround = false
  }
}

/** Source's friction model: below STOP_SPEED, drag is applied as if moving at STOP_SPEED. */
function applyFriction(body: MoveBody, dt: number): void {
  const vx = body.vel.x
  const vz = body.vel.z
  const speed = Math.sqrt(vx * vx + vz * vz)
  if (speed < 0.1) {
    body.vel.x = 0
    body.vel.z = 0
    return
  }

  const control = speed < MOVE.STOP_SPEED ? MOVE.STOP_SPEED : speed
  const drop = control * MOVE.FRICTION * dt
  let newSpeed = speed - drop
  if (newSpeed < 0) newSpeed = 0

  const scale = newSpeed / speed
  body.vel.x *= scale
  body.vel.z *= scale
}

/** Writes the normalised wish direction into `wishDir`, returns the clamped wish speed. */
function computeWish(input: MoveInput, maxSpeed: number): number {
  yawForward(scratchFwd, input.yaw)
  yawRight(scratchRight, input.yaw)

  const fmove = input.forwardMove * maxSpeed
  const smove = input.sideMove * maxSpeed

  const wx = scratchFwd.x * fmove + scratchRight.x * smove
  const wz = scratchFwd.z * fmove + scratchRight.z * smove

  const len = Math.sqrt(wx * wx + wz * wz)
  if (len < 1e-6) {
    vset(wishDir, 0, 0, 0)
    return 0
  }

  wishDir.x = wx / len
  wishDir.y = 0
  wishDir.z = wz / len

  // Clamping here, after normalising, is what removes the diagonal-movement speed bonus.
  return len > maxSpeed ? maxSpeed : len
}

/** Ground acceleration. Large `addSpeed` against current velocity is what makes counter-strafing snap. */
function accelerate(body: MoveBody, wishSpeed: number, accel: number, dt: number): void {
  if (wishSpeed <= 0) return

  const current = body.vel.x * wishDir.x + body.vel.z * wishDir.z
  const addSpeed = wishSpeed - current
  if (addSpeed <= 0) return

  let accelSpeed = accel * wishSpeed * dt
  if (accelSpeed > addSpeed) accelSpeed = addSpeed

  body.vel.x += wishDir.x * accelSpeed
  body.vel.z += wishDir.z * accelSpeed
}

/**
 * Air acceleration. The clamp of wish speed to AIR_CAP (30 u/s) is the whole trick: it
 * limits how much speed you can *add* per tick but not the total, so steering the wish
 * direction slightly off your velocity vector accrues speed. Air-strafing falls out of
 * these six lines.
 */
function airAccelerate(body: MoveBody, wishSpeed: number, accel: number, dt: number): void {
  if (wishSpeed <= 0) return

  const capped = wishSpeed > MOVE.AIR_CAP ? MOVE.AIR_CAP : wishSpeed
  const current = body.vel.x * wishDir.x + body.vel.z * wishDir.z
  const addSpeed = capped - current
  if (addSpeed <= 0) return

  // Note: scaled by the *uncapped* wish speed, matching Source. This is intentional.
  let accelSpeed = accel * wishSpeed * dt
  if (accelSpeed > addSpeed) accelSpeed = addSpeed

  body.vel.x += wishDir.x * accelSpeed
  body.vel.z += wishDir.z * accelSpeed
}

/**
 * Sweeps along the velocity vector, sliding along whatever it hits, for up to
 * MAX_CLIP_PLANES impacts.
 *
 * The two-plane crease handling matters more than it looks: clipping velocity against
 * each plane independently makes a player stop dead in an inside corner. Moving along the
 * cross product of the two normals is what lets you slide out of it.
 *
 * Returns true if anything was hit.
 */
function slideMove(map: MapData, body: MoveBody, dt: number, horizontalOnly: boolean): boolean {
  const hw = MOVE.HULL_HALF_WIDTH
  const h = hullHeight(body.crouching)

  let remaining = 1
  let numPlanes = 0
  let blocked = false

  for (let bump = 0; bump < MOVE.MAX_CLIP_PLANES; bump++) {
    const vy = horizontalOnly ? 0 : body.vel.y
    if (body.vel.x === 0 && vy === 0 && body.vel.z === 0) break

    vset(delta, body.vel.x * dt * remaining, vy * dt * remaining, body.vel.z * dt * remaining)

    sweepHull(map, body.pos, delta, hw, h, trace)

    // Advance to the impact point.
    body.pos.x += delta.x * trace.fraction
    body.pos.y += delta.y * trace.fraction
    body.pos.z += delta.z * trace.fraction

    if (!trace.hit) break

    blocked = true

    // Record impact speed against floor-like surfaces BEFORE clipping.
    //
    // This has to happen here and not in `categorizePosition`: `clipVelocity` below
    // removes the velocity component into the plane, so by the time the ground check runs,
    // vertical speed is already ~0. Reading it there reports the speed *after* the
    // collision, which is always near zero — fall damage would silently never trigger.
    if (trace.ny >= MOVE.GROUND_NORMAL_Y && body.vel.y < 0) {
      const impact = -body.vel.y
      if (impact > body.landedSpeed) body.landedSpeed = impact
    }

    // Back off along the normal so we never rest exactly on the surface.
    body.pos.x += trace.nx * MOVE.SURFACE_EPSILON
    body.pos.y += trace.ny * MOVE.SURFACE_EPSILON
    body.pos.z += trace.nz * MOVE.SURFACE_EPSILON

    remaining *= 1 - trace.fraction
    if (remaining <= 0) {
      body.vel.x = 0
      body.vel.y = 0
      body.vel.z = 0
      break
    }

    if (numPlanes >= MOVE.MAX_CLIP_PLANES) {
      body.vel.x = 0
      body.vel.y = 0
      body.vel.z = 0
      break
    }
    planeNx[numPlanes] = trace.nx
    planeNy[numPlanes] = trace.ny
    planeNz[numPlanes] = trace.nz
    numPlanes++

    // Try clipping against each known plane; accept the first result that does not
    // immediately drive us into one of the others.
    let resolved = false
    for (let i = 0; i < numPlanes; i++) {
      clipVelocity(body.vel, planeNx[i]!, planeNy[i]!, planeNz[i]!)

      let valid = true
      for (let j = 0; j < numPlanes; j++) {
        if (j === i) continue
        if (body.vel.x * planeNx[j]! + body.vel.y * planeNy[j]! + body.vel.z * planeNz[j]! < 0) {
          valid = false
          break
        }
      }
      if (valid) {
        resolved = true
        break
      }
    }

    if (!resolved) {
      if (numPlanes === 2) {
        // Slide along the crease between the two surfaces.
        const cx = planeNy[0]! * planeNz[1]! - planeNz[0]! * planeNy[1]!
        const cy = planeNz[0]! * planeNx[1]! - planeNx[0]! * planeNz[1]!
        const cz = planeNx[0]! * planeNy[1]! - planeNy[0]! * planeNx[1]!
        const cl = Math.sqrt(cx * cx + cy * cy + cz * cz)
        if (cl > 1e-9) {
          const nx = cx / cl
          const ny = cy / cl
          const nz = cz / cl
          const d = body.vel.x * nx + body.vel.y * ny + body.vel.z * nz
          body.vel.x = nx * d
          body.vel.y = ny * d
          body.vel.z = nz * d
        } else {
          body.vel.x = 0
          body.vel.y = 0
          body.vel.z = 0
          break
        }
      } else {
        // Wedged between three or more planes: stop rather than squeeze through.
        body.vel.x = 0
        body.vel.y = 0
        body.vel.z = 0
        break
      }
    }
  }

  return blocked
}

/**
 * Grounded move: performs the plain slide, then re-attempts it as step-up-move-step-down,
 * and keeps whichever covered more horizontal ground.
 *
 * This is how stairs work without ramps, and why a 16-unit rise is walkable while the
 * 24-unit ledge in the test arena is not.
 */
function stepSlide(map: MapData, body: MoveBody, dt: number): void {
  const hw = MOVE.HULL_HALF_WIDTH
  const h = hullHeight(body.crouching)

  startPos.x = body.pos.x
  startPos.y = body.pos.y
  startPos.z = body.pos.z
  startVel.x = body.vel.x
  startVel.y = body.vel.y
  startVel.z = body.vel.z

  // Attempt A: plain horizontal slide.
  const blocked = slideMove(map, body, dt, true)
  downPos.x = body.pos.x
  downPos.y = body.pos.y
  downPos.z = body.pos.z
  downVel.x = body.vel.x
  downVel.y = body.vel.y
  downVel.z = body.vel.z

  if (!blocked) return

  // Attempt B: step up, slide, then settle back down.
  body.pos.x = startPos.x
  body.pos.y = startPos.y
  body.pos.z = startPos.z
  body.vel.x = startVel.x
  body.vel.y = startVel.y
  body.vel.z = startVel.z

  vset(delta, 0, MOVE.STEP_HEIGHT, 0)
  sweepHull(map, body.pos, delta, hw, h, trace)
  body.pos.y += delta.y * trace.fraction
  if (trace.hit) body.pos.y -= MOVE.SURFACE_EPSILON

  slideMove(map, body, dt, true)

  vset(delta, 0, -MOVE.STEP_HEIGHT, 0)
  sweepHull(map, body.pos, delta, hw, h, trace)
  body.pos.y += delta.y * trace.fraction
  if (trace.hit) body.pos.y += MOVE.SURFACE_EPSILON

  // Whichever attempt travelled farther horizontally wins.
  const dxDown = downPos.x - startPos.x
  const dzDown = downPos.z - startPos.z
  const dxUp = body.pos.x - startPos.x
  const dzUp = body.pos.z - startPos.z
  const distDown = dxDown * dxDown + dzDown * dzDown
  const distUp = dxUp * dxUp + dzUp * dzUp

  if (distDown > distUp) {
    body.pos.x = downPos.x
    body.pos.y = downPos.y
    body.pos.z = downPos.z
    body.vel.x = downVel.x
    body.vel.y = downVel.y
    body.vel.z = downVel.z
  } else {
    // Keep the stepped position, but take vertical velocity from the un-stepped attempt so
    // climbing a stair does not inject upward momentum.
    body.vel.y = downVel.y
  }
}
