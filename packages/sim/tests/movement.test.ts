import { beforeEach, describe, expect, it } from 'vitest'
import { MOVE } from '../src/constants.js'
import { buildFlatMap, buildTestArena, type MapData } from '../src/map.js'
import { dsqrt, HALF_PI, PI } from '../src/math.js'
import { createBody, moveBody, type MoveBody, type MoveInput } from '../src/movement.js'

/**
 * The movement solver is where "does this game feel good" is decided, so these tests pin
 * the properties that make it feel like Counter-Strike rather than like a physics demo.
 *
 * Every geometric case here targets a specific feature of `dm_box`, which was built to
 * exercise exactly these paths (see map.ts).
 *
 * Yaw convention reminder: yaw 0 looks down -Z, and yaw increases counter-clockwise.
 * So -PI/2 faces +X and +PI/2 faces -X.
 */

const YAW_PLUS_X = -HALF_PI
const YAW_MINUS_X = HALF_PI
const YAW_PLUS_Z = PI

let map: MapData

beforeEach(() => {
  map = buildTestArena()
})

/** Switches the active map for kinematics tests that must not touch scenery. */
function useFlatMap(): void {
  map = buildFlatMap()
}

function input(over: Partial<MoveInput> = {}): MoveInput {
  return {
    forwardMove: 0,
    sideMove: 0,
    yaw: 0,
    jump: false,
    crouch: false,
    walk: false,
    ...over,
  }
}

function bodyAt(x: number, y: number, z: number): MoveBody {
  const b = createBody()
  b.pos.x = x
  b.pos.y = y
  b.pos.z = z
  return b
}

function run(b: MoveBody, inp: MoveInput, ticks: number): void {
  for (let i = 0; i < ticks; i++) moveBody(map, b, inp)
}

function speedXZ(b: MoveBody): number {
  return dsqrt(b.vel.x * b.vel.x + b.vel.z * b.vel.z)
}

/** Drops a body onto the floor so tests start from a settled, grounded state. */
function settle(b: MoveBody): MoveBody {
  for (let i = 0; i < 400 && !b.onGround; i++) moveBody(map, b, input())
  // A few more ticks to bleed off any residual vertical motion.
  run(b, input(), 4)
  return b
}

describe('gravity and ground', () => {
  it('falls and comes to rest on the floor', () => {
    const b = settle(bodyAt(0, 200, -400))
    expect(b.onGround).toBe(true)
    expect(b.pos.y).toBeGreaterThan(-0.5)
    expect(b.pos.y).toBeLessThan(0.5)
    expect(b.vel.y).toBe(0)
  })

  it('does not sink through the floor over a long idle', () => {
    const b = settle(bodyAt(0, 10, -400))
    const restY = b.pos.y
    run(b, input(), 600)
    expect(Math.abs(b.pos.y - restY)).toBeLessThan(0.01)
  })
})

describe('ground speed', () => {
  beforeEach(useFlatMap)

  it('reaches exactly the run speed and does not exceed it', () => {
    // This equality is a real design constraint, not a coincidence: ACCEL * RUN * DT must
    // exceed the per-tick friction drop, or the player never reaches RUN. It currently
    // clears it by ~6% (21.5 vs 20.3). Lowering ACCEL or raising FRICTION breaks this test,
    // which is the point.
    const b = settle(bodyAt(0, 1, -400))
    run(b, input({ forwardMove: 1, yaw: YAW_PLUS_Z }), 200)
    expect(speedXZ(b)).toBeGreaterThan(MOVE.RUN - 0.5)
    expect(speedXZ(b)).toBeLessThan(MOVE.RUN + 0.001)
  })

  it('gives no speed bonus for moving diagonally', () => {
    const straight = settle(bodyAt(0, 1, -400))
    run(straight, input({ forwardMove: 1, yaw: YAW_PLUS_Z }), 200)

    const diagonal = settle(bodyAt(200, 1, -400))
    run(diagonal, input({ forwardMove: 1, sideMove: 1, yaw: YAW_PLUS_Z }), 200)

    expect(speedXZ(diagonal)).toBeLessThan(speedXZ(straight) + 0.5)
  })

  it('walking is slower than running, and crouching slower still', () => {
    const runner = settle(bodyAt(0, 1, -400))
    run(runner, input({ forwardMove: 1, yaw: YAW_PLUS_Z }), 200)

    const walker = settle(bodyAt(100, 1, -400))
    run(walker, input({ forwardMove: 1, yaw: YAW_PLUS_Z, walk: true }), 200)

    const croucher = settle(bodyAt(200, 1, -400))
    run(croucher, input({ forwardMove: 1, yaw: YAW_PLUS_Z, crouch: true }), 200)

    expect(speedXZ(walker)).toBeLessThan(speedXZ(runner) - 50)
    expect(speedXZ(croucher)).toBeLessThan(speedXZ(walker) - 20)
  })
})

describe('counter-strafing (pillar P1)', () => {
  beforeEach(useFlatMap)

  /**
   * Measures how long it takes to kill velocity along the ORIGINAL direction of travel.
   *
   * Not total speed: a counter-strafe does not settle at zero, it passes through zero and
   * accelerates the other way, so `|v|` may never sample below a small threshold. The
   * moment that matters for a player is when motion along the peek direction stops, because
   * that is when the shot becomes accurate.
   */
  function ticksToKillForwardVelocity(b: MoveBody, inp: MoveInput, limit: number): number {
    const dirZ = b.vel.z >= 0 ? 1 : -1
    for (let t = 1; t <= limit; t++) {
      moveBody(map, b, inp)
      if (b.vel.z * dirZ <= 0) return t
    }
    return limit + 1
  }

  it('stops almost immediately when the opposite key is tapped', () => {
    const b = settle(bodyAt(0, 1, -400))
    run(b, input({ forwardMove: 1, yaw: YAW_PLUS_Z }), 200)
    expect(speedXZ(b)).toBeGreaterThan(240)

    const ticks = ticksToKillForwardVelocity(b, input({ forwardMove: -1, yaw: YAW_PLUS_Z }), 64)

    // Emerges from the friction/accel pair; no special-case code exists for it.
    // Under ~10 ticks is under 160 ms, which is what makes peeking feel crisp.
    expect(ticks).toBeLessThan(12)
  })

  it('takes far longer to stop by releasing keys than by counter-strafing', () => {
    const b = settle(bodyAt(0, 1, -400))
    run(b, input({ forwardMove: 1, yaw: YAW_PLUS_Z }), 200)

    // Friction alone. This is the comparison that makes counter-strafing a *skill*: if
    // releasing keys stopped you just as fast, there would be nothing to learn.
    let ticks = 0
    while (speedXZ(b) > 5 && ticks < 400) {
      moveBody(map, b, input({ yaw: YAW_PLUS_Z }))
      ticks++
    }
    expect(ticks).toBeGreaterThan(20)
  })
})

describe('jumping', () => {
  beforeEach(useFlatMap)

  it('reaches an apex consistent with the jump impulse and gravity', () => {
    const b = settle(bodyAt(0, 1, -400))
    const startY = b.pos.y

    let apex = startY
    const jump = input({ jump: true })
    moveBody(map, b, jump)
    for (let i = 0; i < 80; i++) {
      moveBody(map, b, input())
      if (b.pos.y > apex) apex = b.pos.y
    }

    // Continuous solution is v^2/2g = 56.25; discrete integration lands near it.
    expect(apex - startY).toBeGreaterThan(50)
    expect(apex - startY).toBeLessThan(62)
  })

  it('returns to the ground', () => {
    const b = settle(bodyAt(0, 1, -400))
    moveBody(map, b, input({ jump: true }))
    run(b, input(), 120)
    expect(b.onGround).toBe(true)
  })

  it('caps a held-jump chain at MAX_CONSECUTIVE_JUMPS', () => {
    const b = settle(bodyAt(0, 1, -400))
    let jumps = 0
    let wasOnGround = b.onGround

    // Hold jump for a long time. Without the cap this hops forever.
    for (let i = 0; i < 400; i++) {
      const before = b.onGround
      moveBody(map, b, input({ jump: true }))
      if (before && !b.onGround && b.vel.y > 0) jumps++
      wasOnGround = b.onGround
    }
    expect(wasOnGround).toBe(true)
    expect(jumps).toBeLessThanOrEqual(MOVE.MAX_CONSECUTIVE_JUMPS)
  })

  it('allows another jump after the key is released', () => {
    const b = settle(bodyAt(0, 1, -400))
    moveBody(map, b, input({ jump: true }))
    run(b, input(), 120) // land with jump released
    expect(b.onGround).toBe(true)

    moveBody(map, b, input({ jump: true }))
    expect(b.vel.y).toBeGreaterThan(0)
  })
})

describe('air control', () => {
  beforeEach(useFlatMap)

  it('lets a player gain speed by air-strafing', () => {
    // The signature Source movement tech: hold one strafe key while turning smoothly in
    // the same direction. Falls out of AIR_CAP limiting *added* speed but not total speed.
    const b = settle(bodyAt(0, 1, -600))
    run(b, input({ forwardMove: 1, yaw: YAW_PLUS_Z }), 200)
    const launchSpeed = speedXZ(b)

    moveBody(map, b, input({ forwardMove: 1, yaw: YAW_PLUS_Z, jump: true }))

    let yaw = YAW_PLUS_Z
    for (let i = 0; i < 40; i++) {
      yaw += 0.02
      moveBody(map, b, input({ sideMove: -1, yaw }))
      if (b.onGround) break
    }

    expect(speedXZ(b)).toBeGreaterThan(launchSpeed)
  })

  it('does not let a player accelerate freely in a straight line while airborne', () => {
    const b = settle(bodyAt(0, 1, -600))
    moveBody(map, b, input({ jump: true }))
    const startSpeed = speedXZ(b)
    run(b, input({ forwardMove: 1, yaw: YAW_PLUS_Z }), 30)
    // AIR_CAP means holding forward in the air adds at most ~30 u/s of wish speed.
    expect(speedXZ(b)).toBeLessThan(startSpeed + MOVE.AIR_CAP + 5)
  })
})

describe('walls and corners', () => {
  it('slides along a wall instead of stopping dead', () => {
    // Run at the -X perimeter wall at a shallow angle; we should keep most of our speed
    // along the wall rather than losing all of it.
    const b = settle(bodyAt(-700, 1, -400))
    run(b, input({ forwardMove: 1, sideMove: -1, yaw: YAW_PLUS_Z }), 120)
    expect(speedXZ(b)).toBeGreaterThan(100)
  })

  it('does not get stuck in the L-wall inside corner', () => {
    // The inside corner of the L-shaped wall is at (-224, -64). Drive into it and then
    // try to leave; a solver without crease handling wedges here permanently.
    const b = settle(bodyAt(-180, 1, -20))
    run(b, input({ forwardMove: 1, sideMove: -1, yaw: YAW_PLUS_Z }), 60)

    const stuckX = b.pos.x
    const stuckZ = b.pos.z
    run(b, input({ forwardMove: -1, yaw: YAW_PLUS_Z }), 40)

    const moved = Math.abs(b.pos.x - stuckX) + Math.abs(b.pos.z - stuckZ)
    expect(moved).toBeGreaterThan(20)
  })

  it('never escapes the arena, however hard it is pushed into a corner', () => {
    const b = settle(bodyAt(-700, 1, -700))
    for (let i = 0; i < 400; i++) {
      moveBody(map, b, input({ forwardMove: 1, sideMove: -1, yaw: YAW_PLUS_Z, jump: i % 7 === 0 }))
      expect(b.pos.x).toBeGreaterThan(map.bounds.minX - 1)
      expect(b.pos.z).toBeGreaterThan(map.bounds.minZ - 1)
      expect(b.pos.y).toBeGreaterThan(-1)
    }
  })
})

describe('step-up', () => {
  it('walks up the 16-unit staircase onto the platform', () => {
    const b = settle(bodyAt(280, 1, -200))
    expect(b.pos.y).toBeLessThan(1)

    // 100 ticks covers ~390 units, landing mid-platform. Running longer walks off the
    // far edge at x=700 and falls back to the floor, which is correct behaviour but not
    // what this test is measuring.
    run(b, input({ forwardMove: 1, yaw: YAW_PLUS_X }), 100)

    // Should have climbed all four steps and be standing on the 64-high platform.
    expect(b.pos.x).toBeGreaterThan(500)
    expect(b.pos.y).toBeGreaterThan(63)
    expect(b.pos.y).toBeLessThan(65)
    expect(b.onGround).toBe(true)
  })

  it('does not climb the 24-unit ledge, which is above STEP_HEIGHT', () => {
    // If this passes accidentally, STEP_HEIGHT is too permissive and level design loses
    // the ability to gate movement with a knee-high ledge.
    const b = settle(bodyAt(-340, 1, 400))
    run(b, input({ forwardMove: 1, yaw: YAW_MINUS_X }), 200)

    expect(b.pos.y).toBeLessThan(1)
    // Blocked at the ledge face (-384) plus the hull half-width.
    expect(b.pos.x).toBeGreaterThan(-372)
  })

  it('climbing stairs does not inject upward velocity', () => {
    // Stepping up must not launch the player; vertical velocity comes from the un-stepped
    // attempt precisely so a staircase does not act like a ramp-jump.
    const b = settle(bodyAt(280, 1, -200))
    for (let i = 0; i < 100; i++) {
      moveBody(map, b, input({ forwardMove: 1, yaw: YAW_PLUS_X }))
      expect(b.vel.y).toBeLessThan(1)
    }
  })
})

describe('crouching', () => {
  it('cannot stand up under a low overhang', () => {
    // The overhang leaves a 60-unit gap: crouched (54) fits, standing (72) does not.
    const b = bodyAt(0, 1, 460)
    b.crouching = true
    run(b, input({ crouch: true }), 20)
    expect(b.crouching).toBe(true)

    // Release crouch: the ceiling check must keep us down.
    run(b, input(), 20)
    expect(b.crouching).toBe(true)
    expect(b.pos.y).toBeLessThan(1)
  })

  it('stands back up once clear of the overhang', () => {
    const b = bodyAt(0, 1, 460)
    b.crouching = true
    run(b, input({ crouch: true }), 10)
    expect(b.crouching).toBe(true)

    // Crouch-walk out from under it (toward -Z), then release.
    run(b, input({ forwardMove: 1, yaw: 0, crouch: true }), 120)
    run(b, input({ forwardMove: 1, yaw: 0 }), 20)
    expect(b.crouching).toBe(false)
  })

  it('can pass under the overhang crouched but is blocked standing', () => {
    const crouched = bodyAt(0, 1, 600)
    crouched.crouching = true
    run(crouched, input({ forwardMove: 1, yaw: 0, crouch: true }), 200)

    const standing = settle(bodyAt(64, 1, 600))
    run(standing, input({ forwardMove: 1, yaw: 0 }), 200)

    // The crouched body should get much further toward -Z than the standing one.
    expect(crouched.pos.z).toBeLessThan(standing.pos.z - 100)
  })
})

describe('fall damage signal', () => {
  it('reports landing speed only on the tick of impact', () => {
    const b = bodyAt(0, 700, -400)
    let reports = 0
    let peak = 0
    for (let i = 0; i < 200; i++) {
      moveBody(map, b, input())
      if (b.landedSpeed > 0) {
        reports++
        peak = b.landedSpeed
      }
    }
    expect(reports).toBe(1)
    expect(peak).toBeGreaterThan(MOVE.FALL_DAMAGE_SPEED)
  })
})
