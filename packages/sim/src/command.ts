/**
 * The client's contribution to the simulation.
 *
 * A command carries *intent* only — buttons and view angles — never outcomes. The client
 * never tells the server where it is, whether it hit anything, or how much damage it did.
 * That single rule is what makes the server authoritative and removes the entire category
 * of trivial cheats (see docs/PLAN.md §10).
 */

import { VIEW } from './constants.js'
import { clamp } from './math.js'
import type { MoveInput } from './movement.js'

/** Button bits. Wire-visible — append only, never reorder. */
export const BTN = {
  FORWARD: 1 << 0,
  BACK: 1 << 1,
  LEFT: 1 << 2,
  RIGHT: 1 << 3,
  JUMP: 1 << 4,
  CROUCH: 1 << 5,
  WALK: 1 << 6,
  ATTACK: 1 << 7,
  RELOAD: 1 << 8,
} as const

export interface Command {
  /** Monotonic per-client sequence number. Echoed back by the server to ack input. */
  seq: number
  /** The client tick this command was generated for. */
  tick: number
  buttons: number
  yaw: number
  pitch: number
  /**
   * Where inside the tick the fire/jump edge actually happened, in [0, 1).
   *
   * A 64 Hz tick quantises a trigger pull to a 15.6 ms grid; carrying the fraction is
   * what lets M4 resolve the shot at the moment the player clicked instead of snapping it
   * to a tick boundary. Captured from M0 so no plumbing is needed later — it is simply
   * not consumed yet.
   */
  subFrac: number
}

export function createCommand(): Command {
  return { seq: 0, tick: 0, buttons: 0, yaw: 0, pitch: 0, subFrac: 0 }
}

export function copyCommand(dst: Command, src: Command): Command {
  dst.seq = src.seq
  dst.tick = src.tick
  dst.buttons = src.buttons
  dst.yaw = src.yaw
  dst.pitch = src.pitch
  dst.subFrac = src.subFrac
  return dst
}

/** Translates button bits into the axis form the movement solver wants. */
export function toMoveInput(out: MoveInput, cmd: Command): MoveInput {
  const b = cmd.buttons
  let forward = 0
  let side = 0
  if ((b & BTN.FORWARD) !== 0) forward += 1
  if ((b & BTN.BACK) !== 0) forward -= 1
  if ((b & BTN.RIGHT) !== 0) side += 1
  if ((b & BTN.LEFT) !== 0) side -= 1

  out.forwardMove = forward
  out.sideMove = side
  out.yaw = cmd.yaw
  out.jump = (b & BTN.JUMP) !== 0
  out.crouch = (b & BTN.CROUCH) !== 0
  out.walk = (b & BTN.WALK) !== 0
  return out
}

/**
 * Clamps a command's view angles into the legal range, given the player's previous angles.
 *
 * Pitch is hard-limited so a client cannot look through its own body. The per-tick delta
 * limit is a cheap sanity check, not real anti-cheat: it rules out aim that teleports
 * across the map while leaving every physically achievable flick alone. Tightened against
 * measured human data in M5 (docs/PLAN.md §10).
 */
export function sanitizeView(
  cmd: Command,
  prevYaw: number,
  prevPitch: number,
): { yaw: number; pitch: number } {
  let yaw = cmd.yaw
  let pitch = cmd.pitch

  if (!Number.isFinite(yaw)) yaw = prevYaw
  if (!Number.isFinite(pitch)) pitch = prevPitch

  pitch = clamp(pitch, VIEW.PITCH_MIN, VIEW.PITCH_MAX)

  const dPitch = pitch - prevPitch
  if (dPitch > VIEW.MAX_DELTA_PER_TICK) pitch = prevPitch + VIEW.MAX_DELTA_PER_TICK
  else if (dPitch < -VIEW.MAX_DELTA_PER_TICK) pitch = prevPitch - VIEW.MAX_DELTA_PER_TICK

  return { yaw, pitch }
}
