// All tunable gameplay numbers. Units are inches-ish ("source units"): a player is 72 tall.
export const TICK = 128
export const DT = 1 / TICK
export const SNAP_HZ = 64
const s = (sec) => Math.round(sec * TICK)

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
  /** Jumping tires you: for this long after a jump, landings and re-jumps are weaker. */
  STAM_TICKS: s(1.315),
  STAM_LOSS: 0.19,
  /** Speed kept when a bullet hits you ("tagging"). */
  TAG: 0.6,
}

export const BTN = {
  F: 1, B: 2, L: 4, R: 8, JUMP: 16, DUCK: 32, WALK: 64, FIRE: 128, RELOAD: 256, ALT: 512, USE: 1024,
}

export const TEAM = { NONE: 0, ATT: 1, DEF: 2 }
export const TEAM_NAME = ['', 'Attackers', 'Defenders']

// recoilUp/recoilSide in degrees. spread* are cone half-angles in degrees.
// armorPen: share of damage that gets through armour. pen: wall thickness a bullet can pass.
export const WEAPONS = [
  { id: 'knife', name: 'Knife', slot: 'knife', mag: 0, interval: s(0.45), auto: true, dmg: 50, range: 72, speed: 250,
    spreadBase: 0, spreadMove: 0, spreadAir: 0, recoilUp: 0, recoilRise: 1, recoilSide: 0, swayStart: 99,
    reload: 0, draw: s(0.35), falloff: 1, armorPen: 0.85, pen: 0 },
  { id: 'pistol', name: 'P-9 Pistol', slot: 'pistol', mag: 13, interval: s(0.14), auto: false, dmg: 32, range: 4096, speed: 245,
    spreadBase: 0.25, spreadMove: 2.2, spreadAir: 4.5, recoilUp: 2.6, recoilRise: 2, recoilSide: 0.35, swayStart: 3,
    reload: s(2.0), draw: s(0.4), falloff: 0.85, armorPen: 0.52, pen: 10 },
  { id: 'smg', name: 'Vector SMG', slot: 'primary', price: 1250, mag: 30, interval: s(0.075), auto: true, dmg: 24, range: 4096, speed: 240,
    spreadBase: 0.5, spreadMove: 1.6, spreadAir: 4, recoilUp: 5, recoilRise: 6, recoilSide: 1.4, swayStart: 6,
    reload: s(2.3), draw: s(0.5), falloff: 0.8, armorPen: 0.6, pen: 14 },
  { id: 'rifle', name: 'KR-47 Rifle', slot: 'primary', price: 2700, mag: 30, interval: s(0.1), auto: true, dmg: 34, range: 8192, speed: 221,
    spreadBase: 0.2, spreadMove: 4.5, spreadAir: 7, recoilUp: 8, recoilRise: 5, recoilSide: 2.4, swayStart: 7,
    reload: s(2.5), draw: s(0.6), falloff: 0.96, armorPen: 0.775, pen: 34 },
  { id: 'sniper', name: 'LR-50 Sniper', slot: 'primary', price: 4750, mag: 5, interval: s(1.4), auto: false, dmg: 110, range: 8192, speed: 210,
    zoom: true, zoomFov: 20, zoomSpeed: 150, spreadBase: 0.03, spreadNoZoom: 3, spreadMove: 8, spreadAir: 12,
    recoilUp: 0, recoilRise: 1, recoilSide: 0, swayStart: 99, reload: s(3.0), draw: s(0.8), falloff: 0.99, armorPen: 0.975, pen: 60 },
  { id: 'he', name: 'HE Grenade', slot: 'nade', nade: true, price: 300, max: 1, mag: 0, interval: s(0.6), speed: 245, draw: s(0.4),
    fuse: 1600, dmg: 98, radius: 350, armorPen: 0.6 },
  { id: 'flash', name: 'Flashbang', slot: 'nade', nade: true, price: 200, max: 2, mag: 0, interval: s(0.6), speed: 245, draw: s(0.4), fuse: 1500 },
  { id: 'smoke', name: 'Smoke Grenade', slot: 'nade', nade: true, price: 300, max: 1, mag: 0, interval: s(0.6), speed: 245, draw: s(0.4), fuse: 2000 },
]
export const GUNS = 5 // weapons 0..4 are held weapons with magazines; the rest are grenades
export const RECOIL_HOLD = s(0.12) // ticks after the fire interval before recoil starts recovering
export const RECOIL_DECAY = 0.2 // pattern steps recovered per tick
export const DMG_MUL = { head: 4, body: 1, legs: 0.75, blast: 1 }
export const RESPAWN_MS = 2500
export const FOV = 74 // vertical; equals the classic 90 horizontal at 4:3
export const SMOKE_MS = 15000
export const NADE = { SPEED: 720, GRAVITY: 480, BOUNCE: 0.45 }

/** Bomb mode. Times in ms unless they end in _TICKS (those are counted by the simulation). */
export const RULES = {
  FREEZE_MS: 6000,
  ROUND_MS: 100000,
  BOMB_MS: 40000,
  END_MS: 5000,
  BUY_MS: 15000, // buying stays open this long after the round goes live
  PLANT_TICKS: s(3.2),
  DEFUSE_TICKS: s(10),
  DEFUSE_KIT_TICKS: s(5),
  DEFUSE_RANGE: 64,
  WIN_ROUNDS: 7,
  HALF_ROUNDS: 6,
  MAX_ROUNDS: 12,
  START_MONEY: 800,
  MAX_MONEY: 16000,
  KILL: 300,
  WIN: 3250,
  LOSS: 1400,
  LOSS_STEP: 500,
  LOSS_MAX: 3400,
  PLANT_BONUS: 300,
  DEFUSE_BONUS: 300,
  PLANTED_LOSS_BONUS: 800,
  BOMB_RADIUS: 900,
  BOMB_DMG: 500,
}

/** Buy menu, in display order. `w` is a weapon index; `team` restricts an item to one side. */
export const SHOP = [
  { id: 'smg', name: 'Vector SMG', price: 1250, w: 2 },
  { id: 'rifle', name: 'KR-47 Rifle', price: 2700, w: 3 },
  { id: 'sniper', name: 'LR-50 Sniper', price: 4750, w: 4 },
  { id: 'armor', name: 'Body armour', price: 650 },
  { id: 'helmet', name: 'Armour + helmet', price: 1000 },
  { id: 'he', name: 'HE grenade', price: 300, w: 5 },
  { id: 'flash', name: 'Flashbang', price: 200, w: 6 },
  { id: 'smoke', name: 'Smoke grenade', price: 300, w: 7 },
  { id: 'kit', name: 'Defuse kit', price: 400, team: TEAM.DEF },
]
