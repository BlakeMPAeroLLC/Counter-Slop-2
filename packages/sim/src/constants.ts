/**
 * Single source of truth for every tunable number in the simulation.
 *
 * Rules:
 *  - Nothing in `sim/` may hardcode a gameplay number. It goes here.
 *  - These objects are frozen and version-stamped so a recorded replay can be
 *    played back against the constants it was recorded with (see docs/PLAN.md §A).
 *
 * Units are "source units": 1 unit is roughly one inch. A player is 72 units tall.
 * The renderer scales units to metres; the simulation never sees metres.
 *
 * Coordinate system: Y-up, right-handed (Three.js convention, NOT Source's Z-up).
 * A player's position is the centre of the *bottom* face of their hull (the feet),
 * which is what makes ground traces and step-up cheap to reason about.
 */

/** Bumped whenever a value below changes in a way that invalidates old replays. */
export const TUNING_VERSION = 1

export const SIM = {
  TICK_HZ: 64,
  /** Seconds per tick. Derived once so no caller ever divides by TICK_HZ itself. */
  DT: 1 / 64,
  SNAPSHOT_HZ: 32,
  CMD_HZ: 64,
  CMDS_PER_PACKET: 3,
  INTERP_TICKS: 4,
  MAX_PREDICT_TICKS: 16,
  MAX_REWIND_MS: 200,
  MAX_PLAYERS: 10,
} as const

export const MOVE = {
  RUN: 250,
  WALK: 130,
  CROUCH: 90,

  ACCEL: 5.5,
  FRICTION: 5.2,
  /** Below this speed, friction is applied as if you were moving this fast. */
  STOP_SPEED: 75,

  AIR_ACCEL: 12.0,
  /** The magic number that makes air-strafing work. Wish speed is clamped to this in air. */
  AIR_CAP: 30,

  JUMP: 300,
  GRAVITY: 800,
  MAX_CONSECUTIVE_JUMPS: 2,

  STEP_HEIGHT: 18,
  /** Distance traced downward each tick to decide if we are standing on something. */
  GROUND_TRACE_DIST: 2,
  /** A surface counts as ground if its normal's Y component is at least this. */
  GROUND_NORMAL_Y: 0.7,

  HULL_HALF_WIDTH: 16,
  HULL_HEIGHT_STAND: 72,
  HULL_HEIGHT_CROUCH: 54,
  /** Camera height above the feet, standing and crouched. */
  EYE_HEIGHT_STAND: 64,
  EYE_HEIGHT_CROUCH: 46,

  /** Terminal fall speed, and the speed above which landing hurts. */
  MAX_FALL_SPEED: 3500,
  FALL_DAMAGE_SPEED: 580,
  FALL_DAMAGE_PER_UNIT: 0.055,

  /** Nudge distance used to keep the hull from resting exactly on a surface. */
  SURFACE_EPSILON: 0.03125,
  /** Maximum slide iterations per move. Source uses 4. */
  MAX_CLIP_PLANES: 4,
} as const

export const VIEW = {
  PITCH_MIN: -1.5533430342749532, // -89 degrees
  PITCH_MAX: 1.5533430342749532, //  +89 degrees
  /**
   * Sanity clamp: the largest view change we accept in a single tick.
   * A human cannot exceed this; an aimbot snapping across the map can.
   * At 64Hz this permits ~570 deg/tick, which is far beyond any real flick
   * but still rules out teleporting aim. Tightened with real data in M5.
   */
  MAX_DELTA_PER_TICK: 10.0,
} as const

/** Hitbox groups. Indices are wire-visible, so append only — never reorder. */
export const HITBOX = {
  BODY: 0,
  HEAD: 1,
} as const

export const HITBOX_MULT: readonly number[] = [
  1.0, // BODY
  4.0, // HEAD
]

export const HITBOX_NAME: readonly string[] = ['body', 'head']

export const PLAYER = {
  MAX_HEALTH: 100,
  START_HEALTH: 100,
  START_ARMOR: 0,
  /** Fraction of incoming damage absorbed by armor, and armor lost per hit. */
  ARMOR_ABSORB: 0.5,
  /** Deathmatch respawn delay in ticks (M0 only; defusal has no respawn). */
  RESPAWN_TICKS: 2 * SIM.TICK_HZ,
  /** Head hitbox occupies the top of the hull and is narrower than the body. */
  HEAD_HEIGHT: 13,
  HEAD_HALF_WIDTH: 9,
} as const

export const TEAM = {
  WRECKERS: 0,
  WARDENS: 1,
} as const

/**
 * M0 arsenal: one rifle. The full nine-weapon table lands in M2 once the
 * inaccuracy/recoil split is being tuned against real playtest data.
 */
export interface WeaponDef {
  readonly id: number
  readonly name: string
  readonly damage: number
  /** Rounds per minute, converted to a tick interval at load. */
  readonly rpm: number
  readonly magazine: number
  readonly reloadTicks: number
  /** Inaccuracy in radians, by state. */
  readonly baseSpread: number
  readonly moveSpread: number
  readonly airSpread: number
  readonly shotSpread: number
  readonly crouchBonus: number
  /** Damage is multiplied by falloff^(distance/500). */
  readonly falloff: number
  readonly range: number
  readonly armorPenetration: number
}

export const WEAPONS: readonly WeaponDef[] = [
  {
    id: 0,
    name: 'Vulture AR',
    damage: 36,
    rpm: 600,
    magazine: 30,
    reloadTicks: Math.round(2.4 * SIM.TICK_HZ),
    baseSpread: 0.0006,
    moveSpread: 0.055,
    airSpread: 0.09,
    shotSpread: 0.0035,
    crouchBonus: 0.0002,
    falloff: 0.97,
    range: 8192,
    armorPenetration: 0.775,
  },
]

/** Ticks between shots for a weapon. Integer, so fire rate is tick-exact. */
export function fireIntervalTicks(w: WeaponDef): number {
  return Math.max(1, Math.round((60 / w.rpm) * SIM.TICK_HZ))
}

/** Surface materials, used for footstep audio and (from M2) bullet penetration. */
export const MATERIAL = {
  CONCRETE: 0,
  METAL: 1,
  WOOD: 2,
  DIRT: 3,
} as const

Object.freeze(SIM)
Object.freeze(MOVE)
Object.freeze(VIEW)
Object.freeze(PLAYER)
Object.freeze(HITBOX)
Object.freeze(TEAM)
Object.freeze(MATERIAL)
