/**
 * The simulation's single entry point.
 *
 * `step()` is the whole contract between the client and the server. Both call it with the
 * same world and the same commands and must arrive at the same state — that is what makes
 * client-side prediction possible, and it is why nothing else in this package is allowed
 * to touch wall-clock time, `Math.random`, or the DOM.
 *
 * It mutates the world in place rather than returning a new one. Purity was only ever a
 * proxy for determinism, and determinism is what actually matters here; allocating a fresh
 * world per tick would hand the GC ~64 objects/second/player for no benefit. Rollback is
 * served by `saveSnapshot`/`loadSnapshot` instead.
 *
 * TWO PASSES, and the split is deliberate:
 *
 *   Pass 1 — every player's input and movement is applied.
 *   Pass 2 — every player's weapon is resolved against the post-movement world.
 *
 * A single fused pass would let player 0 shoot at player 1's *new* position while player 1
 * shoots at player 0's *old* position. That asymmetry is invisible in testing and gives
 * lower player slots a real advantage.
 */

import { BTN, sanitizeView, toMoveInput, type Command } from './command.js'
import { MOVE, PLAYER, SIM } from './constants.js'
import { createBody, moveBody, type MoveBody, type MoveInput } from './movement.js'
import { PFLAG, respawnPlayer, type World } from './world.js'
import { startReload, tryFire, updateReload } from './weapons.js'

const body: MoveBody = createBody()
const moveInput: MoveInput = {
  forwardMove: 0,
  sideMove: 0,
  yaw: 0,
  jump: false,
  crouch: false,
  walk: false,
}

/**
 * Advances the world by exactly one tick.
 *
 * `cmds` is indexed by player slot. A null entry means that client's input did not arrive
 * in time; the server repeats the previous command rather than treating it as "no keys
 * pressed", because a dropped packet should not read as the player letting go of W.
 */
export function step(world: World, cmds: readonly (Command | null)[]): void {
  world.events.length = 0
  const p = world.p

  // ── Pass 1: input, movement, respawns ────────────────────────────────────
  for (let i = 0; i < SIM.MAX_PLAYERS; i++) {
    if (p.active[i] === 0) continue

    if ((p.flags[i]! & PFLAG.DEAD) !== 0) {
      if (world.tick >= p.respawnTick[i]!) respawnPlayer(world, i)
      continue
    }

    updateReload(world, i)

    const cmd = cmds[i] ?? null
    if (cmd !== null) {
      const view = sanitizeView(cmd, p.yaw[i]!, p.pitch[i]!)
      p.yaw[i] = view.yaw
      p.pitch[i] = view.pitch
      p.lastCmdSeq[i] = cmd.seq

      if ((cmd.buttons & BTN.RELOAD) !== 0) startReload(world, i)
    }

    // Load SoA state into the solver's struct, step it, store it back.
    body.pos.x = p.posX[i]!
    body.pos.y = p.posY[i]!
    body.pos.z = p.posZ[i]!
    body.vel.x = p.velX[i]!
    body.vel.y = p.velY[i]!
    body.vel.z = p.velZ[i]!
    body.onGround = (p.flags[i]! & PFLAG.ON_GROUND) !== 0
    body.crouching = (p.flags[i]! & PFLAG.CROUCHING) !== 0
    body.jumpCount = p.jumpCount[i]!

    if (cmd !== null) {
      toMoveInput(moveInput, cmd)
    } else {
      moveInput.forwardMove = 0
      moveInput.sideMove = 0
      moveInput.jump = false
      moveInput.crouch = body.crouching
      moveInput.walk = false
    }
    moveInput.yaw = p.yaw[i]!

    moveBody(world.map, body, moveInput)

    p.posX[i] = body.pos.x
    p.posY[i] = body.pos.y
    p.posZ[i] = body.pos.z
    p.velX[i] = body.vel.x
    p.velY[i] = body.vel.y
    p.velZ[i] = body.vel.z
    p.jumpCount[i] = body.jumpCount

    let flags = p.flags[i]!
    flags = body.onGround ? flags | PFLAG.ON_GROUND : flags & ~PFLAG.ON_GROUND
    flags = body.crouching ? flags | PFLAG.CROUCHING : flags & ~PFLAG.CROUCHING
    p.flags[i] = flags

    if (body.landedSpeed > MOVE.FALL_DAMAGE_SPEED) {
      applyFallDamage(world, i, body.landedSpeed)
    }
  }

  // ── Pass 2: weapons, resolved against the settled world ──────────────────
  for (let i = 0; i < SIM.MAX_PLAYERS; i++) {
    if (p.active[i] === 0) continue
    if ((p.flags[i]! & PFLAG.DEAD) !== 0) continue

    const cmd = cmds[i] ?? null
    if (cmd === null) continue
    if ((cmd.buttons & BTN.ATTACK) === 0) continue

    tryFire(world, i)
  }

  world.tick++
}

function applyFallDamage(world: World, i: number, speed: number): void {
  const p = world.p
  const excess = speed - MOVE.FALL_DAMAGE_SPEED
  const damage = Math.round(excess * MOVE.FALL_DAMAGE_PER_UNIT)
  if (damage <= 0) return

  const health = p.health[i]! - damage
  p.health[i] = health > 0 ? health : 0

  if (p.health[i]! <= 0) {
    p.flags[i] = p.flags[i]! | PFLAG.DEAD
    p.deaths[i] = p.deaths[i]! + 1
    p.respawnTick[i] = world.tick + PLAYER.RESPAWN_TICKS
    world.events.push({ k: 'death', p: i, by: -1, headshot: false })
  }
}
