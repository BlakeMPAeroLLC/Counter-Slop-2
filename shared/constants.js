// All tunable gameplay numbers. Units are inches-ish ("source units"): a player is 72 tall.
export const TICK = 128
export const DT = 1 / TICK
export const SNAP_HZ = 64

export const MOVE = {
  ACCEL: 5.5,
  FRICTION: 5.2,
  STOP_SPEED: 80,
  AIR_ACCEL: 12,
  AIR_CAP: 30,
  JUMP: 268.3,
  GRAVITY: 800,
  STEP: 18,
  HW: 16,
  H_STAND: 72,
  H_DUCK: 54,
  EYE_STAND: 64,
  EYE_DUCK: 46,
  WALK_MUL: 0.52,
  DUCK_MUL: 0.34,
}

export const BTN = {
  F: 1, B: 2, L: 4, R: 8, JUMP: 16, DUCK: 32, WALK: 64, FIRE: 128, RELOAD: 256, ALT: 512,
}

const s = (sec) => Math.round(sec * TICK)

// recoilUp/recoilSide in degrees. spread* are cone half-angles in degrees.
export const WEAPONS = [
  { id: 'knife', name: 'Knife', mag: 0, interval: s(0.45), auto: true, dmg: 50, range: 72, speed: 250,
    spreadBase: 0, spreadMove: 0, spreadAir: 0, recoilUp: 0, recoilRise: 1, recoilSide: 0, swayStart: 99,
    reload: 0, draw: s(0.35), falloff: 1 },
  { id: 'pistol', name: 'P-9 Pistol', mag: 13, interval: s(0.14), auto: false, dmg: 32, range: 4096, speed: 245,
    spreadBase: 0.25, spreadMove: 2.2, spreadAir: 4.5, recoilUp: 2.6, recoilRise: 2, recoilSide: 0.35, swayStart: 3,
    reload: s(2.0), draw: s(0.4), falloff: 0.85 },
  { id: 'smg', name: 'Vector SMG', mag: 30, interval: s(0.075), auto: true, dmg: 24, range: 4096, speed: 240,
    spreadBase: 0.5, spreadMove: 1.6, spreadAir: 4, recoilUp: 5, recoilRise: 6, recoilSide: 1.4, swayStart: 6,
    reload: s(2.3), draw: s(0.5), falloff: 0.8 },
  { id: 'rifle', name: 'KR-47 Rifle', mag: 30, interval: s(0.1), auto: true, dmg: 34, range: 8192, speed: 221,
    spreadBase: 0.2, spreadMove: 4.5, spreadAir: 7, recoilUp: 8, recoilRise: 5, recoilSide: 2.4, swayStart: 7,
    reload: s(2.5), draw: s(0.6), falloff: 0.96 },
  { id: 'sniper', name: 'LR-50 Sniper', mag: 5, interval: s(1.4), auto: false, dmg: 110, range: 8192, speed: 210,
    zoom: true, zoomFov: 20, zoomSpeed: 150, spreadBase: 0.03, spreadNoZoom: 3, spreadMove: 8, spreadAir: 12,
    recoilUp: 0, recoilRise: 1, recoilSide: 0, swayStart: 99, reload: s(3.0), draw: s(0.8), falloff: 0.99 },
]
export const DEFAULT_WEAPON = 3
export const RECOIL_HOLD = s(0.12) // ticks after the fire interval before recoil starts recovering
export const RECOIL_DECAY = 0.2 // pattern steps recovered per tick
export const DMG_MUL = { head: 4, body: 1, legs: 0.75 }
export const RESPAWN_MS = 2500
export const FOV = 74 // vertical; equals the classic 90 horizontal at 4:3
