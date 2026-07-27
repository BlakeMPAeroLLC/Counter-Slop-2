/**
 * Weapon firing, inaccuracy and recoil.
 *
 * The design pillar this file exists to serve (docs/PLAN.md §P1): standing still and
 * clicking is surgical, moving and spraying is bad. Two separate mechanisms produce that,
 * and conflating them is the classic mistake:
 *
 *   inaccuracy  — a random cone around the aim direction. AVOIDABLE: stop moving, tap fire.
 *   recoil      — a deterministic view-kick following a fixed per-weapon pattern.
 *                 LEARNABLE: spray control is the skill ceiling.
 *
 * M0 implements inaccuracy only. Recoil patterns need a visual authoring tool to tune
 * against (M2), and a wrong pattern is worse than no pattern.
 */

import { fireIntervalTicks, MOVE, PLAYER, SIM, WEAPONS, type WeaponDef } from './constants.js'
import { computeDamage, createBulletHit, eyePosition, traceBullet } from './hitscan.js'
import { clamp, dpow, dsqrt, spreadDir, vec3, viewDir } from './math.js'
import { PFLAG, type World } from './world.js'

/** Ticks of not firing after which the consecutive-shot spread penalty resets. */
const SPREAD_RECOVERY_TICKS = 16

const eyePos = vec3()
const aimDir = vec3()
const shotDir = vec3()
const hit = createBulletHit()

export function weaponDef(id: number): WeaponDef {
  return WEAPONS[id] ?? WEAPONS[0]!
}

/**
 * Current inaccuracy in radians for a player, given their movement state.
 *
 * The velocity term uses an exponent above 1 so that *slow* movement is only mildly
 * punished while running is heavily punished — that curve is what makes shoulder-peeking
 * and slow-walking viable without making run-and-gun viable.
 */
export function computeSpread(world: World, i: number): number {
  const p = world.p
  const w = weaponDef(p.weapon[i]!)

  const vx = p.velX[i]!
  const vz = p.velZ[i]!
  const speed = dsqrt(vx * vx + vz * vz)
  const speedRatio = clamp(speed / MOVE.RUN, 0, 1)

  const onGround = (p.flags[i]! & PFLAG.ON_GROUND) !== 0
  const crouching = (p.flags[i]! & PFLAG.CROUCHING) !== 0

  let spread = w.baseSpread
  spread += w.moveSpread * dpow(speedRatio, 1.35)
  if (!onGround) spread += w.airSpread
  spread += w.shotSpread * p.shotsFired[i]!
  if (crouching) spread -= w.crouchBonus

  return spread < 0 ? 0 : spread
}

/**
 * Attempts to fire one round. Returns true if a shot was actually taken.
 *
 * Called from the second pass of `step`, after every player has moved, so that all
 * shooters resolve against the same post-movement world. Firing during the movement pass
 * would give lower player indices a systematic advantage.
 */
export function tryFire(world: World, i: number): boolean {
  const p = world.p
  const w = weaponDef(p.weapon[i]!)

  if ((p.flags[i]! & PFLAG.DEAD) !== 0) return false
  if (world.tick < p.nextFireTick[i]!) return false
  if ((p.flags[i]! & PFLAG.RELOADING) !== 0) return false
  if (p.ammo[i]! <= 0) {
    startReload(world, i)
    return false
  }

  // Recover accuracy if the player stopped shooting for a moment.
  if (world.tick - p.lastFireTick[i]! > SPREAD_RECOVERY_TICKS) {
    p.shotsFired[i] = 0
  }

  const spread = computeSpread(world, i)

  eyePosition(world, i, eyePos)
  viewDir(aimDir, p.yaw[i]!, p.pitch[i]!)
  // spreadDir advances the RNG; storing the state back is what keeps client and server
  // drawing the same numbers.
  world.rng = spreadDir(shotDir, aimDir, spread, world.rng)

  traceBullet(world, i, eyePos, shotDir, w.range, hit)

  p.ammo[i] = p.ammo[i]! - 1
  p.shotsFired[i] = p.shotsFired[i]! + 1
  p.lastFireTick[i] = world.tick
  p.nextFireTick[i] = world.tick + fireIntervalTicks(w)

  world.events.push({
    k: 'fire',
    p: i,
    ox: eyePos.x,
    oy: eyePos.y,
    oz: eyePos.z,
    ex: hit.x,
    ey: hit.y,
    ez: hit.z,
    hitWorld: hit.world,
  })

  if (hit.player >= 0) {
    const damage = computeDamage(w.damage, hit.hitbox, hit.distance, w.falloff)
    applyDamage(world, hit.player, i, damage, hit.hitbox, hit.x, hit.y, hit.z)
  }

  return true
}

export function startReload(world: World, i: number): void {
  const p = world.p
  const w = weaponDef(p.weapon[i]!)
  if ((p.flags[i]! & PFLAG.RELOADING) !== 0) return
  if (p.ammo[i]! >= w.magazine) return

  p.flags[i] = p.flags[i]! | PFLAG.RELOADING
  p.reloadEndTick[i] = world.tick + w.reloadTicks
}

export function updateReload(world: World, i: number): void {
  const p = world.p
  if ((p.flags[i]! & PFLAG.RELOADING) === 0) return
  if (world.tick < p.reloadEndTick[i]!) return

  const w = weaponDef(p.weapon[i]!)
  p.ammo[i] = w.magazine
  p.shotsFired[i] = 0
  p.flags[i] = p.flags[i]! & ~PFLAG.RELOADING
}

/**
 * Applies damage, armour absorption and death.
 *
 * Rounded to an integer at the end so the health number a player sees always matches what
 * the server holds — a fractional 87.3 health that renders as 87 makes damage reports look
 * inconsistent and generates bug reports that are really rounding.
 */
export function applyDamage(
  world: World,
  target: number,
  attacker: number,
  rawDamage: number,
  hitbox: number,
  x: number,
  y: number,
  z: number,
): void {
  const p = world.p
  if (p.active[target] === 0) return
  if ((p.flags[target]! & PFLAG.DEAD) !== 0) return

  let damage = rawDamage

  const armor = p.armor[target]!
  if (armor > 0) {
    const absorbed = damage * PLAYER.ARMOR_ABSORB
    damage -= absorbed
    const armorLoss = Math.round(absorbed * 0.5)
    p.armor[target] = armor > armorLoss ? armor - armorLoss : 0
  }

  const dmg = Math.round(damage)
  const health = p.health[target]! - dmg
  p.health[target] = health > 0 ? health : 0

  world.events.push({
    k: 'hit',
    p: attacker,
    target,
    hitbox,
    damage: dmg,
    x,
    y,
    z,
  })

  if (p.health[target]! <= 0) {
    killPlayer(world, target, attacker, hitbox)
  }
}

function killPlayer(world: World, target: number, attacker: number, hitbox: number): void {
  const p = world.p
  p.flags[target] = p.flags[target]! | PFLAG.DEAD
  p.health[target] = 0
  p.velX[target] = 0
  p.velY[target] = 0
  p.velZ[target] = 0
  p.deaths[target] = p.deaths[target]! + 1
  p.respawnTick[target] = world.tick + PLAYER.RESPAWN_TICKS

  if (attacker >= 0 && attacker !== target && attacker < SIM.MAX_PLAYERS) {
    p.kills[attacker] = p.kills[attacker]! + 1
  }

  world.events.push({ k: 'death', p: target, by: attacker, headshot: hitbox === 1 })
}
