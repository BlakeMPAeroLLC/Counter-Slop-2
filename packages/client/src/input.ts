/**
 * Input capture.
 *
 * Two things matter here and nothing else does:
 *
 *  1. View angles are applied to the camera LOCALLY and IMMEDIATELY. Mouse look must never
 *     wait for a round trip, in M0 or ever. The server receives the angles and validates
 *     them, but the camera does not wait to hear back. This is why aiming feels instant even
 *     before prediction exists.
 *
 *  2. Fire events are timestamped with their position inside the tick (`subFrac`). A 64 Hz
 *     tick quantises a click to a 15.6 ms grid; carrying the fraction is what lets M4 resolve
 *     the shot at the moment the player actually clicked. Captured now so no plumbing is
 *     needed later.
 */

import { BTN, VIEW, clamp, TWO_PI } from '@cs2/sim'

export interface InputConfig {
  /** Radians of view change per pixel of mouse movement. */
  sensitivity: number
  invertY: boolean
}

const KEY_TO_BUTTON: Record<string, number> = {
  KeyW: BTN.FORWARD,
  KeyS: BTN.BACK,
  KeyA: BTN.LEFT,
  KeyD: BTN.RIGHT,
  Space: BTN.JUMP,
  ControlLeft: BTN.CROUCH,
  ControlRight: BTN.CROUCH,
  KeyC: BTN.CROUCH,
  ShiftLeft: BTN.WALK,
  ShiftRight: BTN.WALK,
  KeyR: BTN.RELOAD,
}

export class Input {
  buttons = 0
  yaw = 0
  pitch = 0

  readonly config: InputConfig = { sensitivity: 0.0022, invertY: false }

  private locked = false
  private scoreboardHeld = false
  /** Timestamp of the most recent attack press, for sub-tick resolution. */
  private lastAttackEdge = -1

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.attach()
  }

  get pointerLocked(): boolean {
    return this.locked
  }

  get showScoreboard(): boolean {
    return this.scoreboardHeld
  }

  requestLock(): void {
    void this.canvas.requestPointerLock()
  }

  private attach(): void {
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas
      if (!this.locked) {
        // Releasing the mouse must drop every held key. Otherwise alt-tabbing mid-strafe
        // leaves the player running into a wall until they come back.
        this.buttons = 0
        this.scoreboardHeld = false
      }
    })

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) {
        this.requestLock()
        return
      }
      if (e.button === 0) {
        if ((this.buttons & BTN.ATTACK) === 0) this.lastAttackEdge = performance.now()
        this.buttons |= BTN.ATTACK
      }
    })

    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.buttons &= ~BTN.ATTACK
    })

    this.canvas.addEventListener('mousemove', (e) => {
      if (!this.locked) return

      this.yaw -= e.movementX * this.config.sensitivity
      // Keep yaw bounded. Unbounded accumulation is harmless for the trig (the range
      // reduction handles it) but it degrades float precision over a long session.
      if (this.yaw > Math.PI) this.yaw -= TWO_PI
      else if (this.yaw < -Math.PI) this.yaw += TWO_PI

      const dy = e.movementY * this.config.sensitivity * (this.config.invertY ? 1 : -1)
      this.pitch = clamp(this.pitch + dy, VIEW.PITCH_MIN, VIEW.PITCH_MAX)
    })

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab') {
        e.preventDefault()
        this.scoreboardHeld = true
        return
      }
      const bit = KEY_TO_BUTTON[e.code]
      if (bit !== undefined) {
        e.preventDefault()
        this.buttons |= bit
      }
    })

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') {
        this.scoreboardHeld = false
        return
      }
      const bit = KEY_TO_BUTTON[e.code]
      if (bit !== undefined) this.buttons &= ~bit
    })

    // Losing focus must also drop held keys, for the same reason as losing pointer lock.
    window.addEventListener('blur', () => {
      this.buttons = 0
      this.scoreboardHeld = false
    })
  }

  /**
   * Where inside the tick ending at `tickEndTime` the attack press landed, as a fraction in
   * [0, 1). Returns 0 when no press occurred in this tick's window.
   */
  consumeSubFrac(tickEndTime: number, tickMs: number): number {
    if (this.lastAttackEdge < 0) return 0
    const start = tickEndTime - tickMs
    if (this.lastAttackEdge < start || this.lastAttackEdge > tickEndTime) return 0

    const frac = (this.lastAttackEdge - start) / tickMs
    this.lastAttackEdge = -1
    return clamp(frac, 0, 0.999999)
  }
}
