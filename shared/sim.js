// Deterministic per-command player simulation. Runs identically on the client
// (prediction) and the server (authority) - this is what makes movement feel instant.
import { DT, MOVE, BTN, WEAPONS, DEFAULT_WEAPON, RECOIL_HOLD, RECOIL_DECAY } from './constants.js'
import { traceHull, hullBlocked } from './physics.js'

const SCALARS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'ground', 'duck', 'yaw', 'pitch', 'alive', 'hp', 'w',
  'nextFire', 'reloadEnd', 'shots', 'lastFire', 'drawEnd', 'zoom', 'tick', 'prevB', 'tp', 'spawnYaw']

export function createState() {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ground: 0, duck: 0, yaw: 0, pitch: 0, alive: 0, hp: 0,
    w: DEFAULT_WEAPON, nextFire: 0, reloadEnd: 0, shots: 0, lastFire: -9999, drawEnd: 0, zoom: 0,
    tick: 0, prevB: 0, tp: 0, spawnYaw: 0, ammo: WEAPONS.map((w) => w.mag),
  }
}

export function spawnState(p, spawn) {
  p.x = spawn.x; p.y = spawn.y; p.z = spawn.z
  p.vx = p.vy = p.vz = 0
  p.ground = 0; p.duck = 0; p.alive = 1; p.hp = 100
  p.w = DEFAULT_WEAPON; p.nextFire = 0; p.reloadEnd = 0; p.shots = 0; p.zoom = 0
  p.drawEnd = p.tick + WEAPONS[p.w].draw
  p.ammo = WEAPONS.map((w) => w.mag)
  p.yaw = p.spawnYaw = spawn.yaw; p.pitch = 0
  p.tp++
}

export function serialize(p) {
  const a = new Array(SCALARS.length + p.ammo.length)
  for (let i = 0; i < SCALARS.length; i++) a[i] = p[SCALARS[i]]
  for (let i = 0; i < p.ammo.length; i++) a[SCALARS.length + i] = p.ammo[i]
  return a
}

export function deserialize(p, a) {
  for (let i = 0; i < SCALARS.length; i++) p[SCALARS[i]] = a[i]
  for (let i = 0; i < p.ammo.length; i++) p.ammo[i] = a[SCALARS.length + i]
  return p
}

export function maxSpeed(p) {
  const W = WEAPONS[p.w]
  return p.zoom && W.zoomSpeed ? W.zoomSpeed : W.speed
}

export function eyeHeight(p) { return p.duck ? MOVE.EYE_DUCK : MOVE.EYE_STAND }

/** Current bullet cone half-angle in degrees. Standing still is what makes shots land. */
export function inaccuracy(p) {
  const W = WEAPONS[p.w]
  let a = W.zoom && !p.zoom ? W.spreadNoZoom : W.spreadBase
  if (p.duck) a *= 0.8
  if (!p.ground) return a + W.spreadAir
  const sp = Math.hypot(p.vx, p.vz) / maxSpeed(p)
  const k = Math.min(Math.max((sp - 0.34) / 0.66, 0), 1)
  return a + W.spreadMove * k
}

/** Deterministic spray pattern: [up, side] in degrees for the n-th consecutive shot. */
export function recoilPattern(W, n) {
  if (!W.recoilUp) return [0, 0]
  const up = W.recoilUp * (1 - Math.exp(-n / W.recoilRise))
  const side = n > W.swayStart ? W.recoilSide * Math.sin((n - W.swayStart) * 0.55) : 0
  return [up, side]
}

function rand01(seed) {
  let t = (seed + 0x6d2b79f5) | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const tr = { frac: 1, hit: false, nx: 0, ny: 0, nz: 0 }

function slide(p, boxes, dt, h) {
  let tl = dt, blocked = false
  for (let i = 0; i < 4 && tl > 0; i++) {
    const dx = p.vx * tl, dy = p.vy * tl, dz = p.vz * tl
    if (dx === 0 && dy === 0 && dz === 0) break
    traceHull(boxes, p.x, p.y, p.z, dx, dy, dz, MOVE.HW, h, tr)
    p.x += dx * tr.frac; p.y += dy * tr.frac; p.z += dz * tr.frac
    if (!tr.hit) break
    tl *= 1 - tr.frac
    if (tr.nx !== 0) { p.vx = 0; blocked = true }
    if (tr.ny !== 0) p.vy = 0
    if (tr.nz !== 0) { p.vz = 0; blocked = true }
  }
  return blocked
}

function stepMove(p, boxes, dt, h) {
  const sx = p.x, sy = p.y, sz = p.z, svx = p.vx, svy = p.vy, svz = p.vz
  if (!slide(p, boxes, dt, h)) return
  const ax = p.x, ay = p.y, az = p.z, avx = p.vx, avy = p.vy, avz = p.vz
  // retry: lift by a step, move, drop back down
  p.x = sx; p.y = sy; p.z = sz; p.vx = svx; p.vy = svy; p.vz = svz
  traceHull(boxes, p.x, p.y, p.z, 0, MOVE.STEP, 0, MOVE.HW, h, tr)
  const up = MOVE.STEP * tr.frac
  p.y += up
  slide(p, boxes, dt, h)
  const down = up + 0.1
  traceHull(boxes, p.x, p.y, p.z, 0, -down, 0, MOVE.HW, h, tr)
  p.y -= down * tr.frac
  const landed = tr.hit && tr.ny > 0
  const dA = (ax - sx) * (ax - sx) + (az - sz) * (az - sz)
  const dB = (p.x - sx) * (p.x - sx) + (p.z - sz) * (p.z - sz)
  if (!landed || dB <= dA + 1e-9) {
    p.x = ax; p.y = ay; p.z = az; p.vx = avx; p.vy = avy; p.vz = avz
  } else {
    p.vy = 0
  }
}

function accelerate(p, wx, wz, wishSpeed, accel, dt, cap) {
  const ws = cap < wishSpeed ? cap : wishSpeed
  const cur = p.vx * wx + p.vz * wz
  const add = ws - cur
  if (add <= 0) return
  let as = accel * dt * wishSpeed
  if (as > add) as = add
  p.vx += as * wx; p.vz += as * wz
}

function move(p, cmd, boxes) {
  const b = cmd.b, dt = DT
  // crouch
  if (b & BTN.DUCK) p.duck = 1
  else if (p.duck && !hullBlocked(boxes, p.x, p.y, p.z, MOVE.HW, MOVE.H_STAND)) p.duck = 0
  const h = p.duck ? MOVE.H_DUCK : MOVE.H_STAND

  // wish direction
  const f = ((b & BTN.F) ? 1 : 0) - ((b & BTN.B) ? 1 : 0)
  const r = ((b & BTN.R) ? 1 : 0) - ((b & BTN.L) ? 1 : 0)
  const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw)
  let wx = -sy * f + cy * r, wz = -cy * f - sy * r
  const wl = Math.hypot(wx, wz)
  let wish = 0
  if (wl > 0) {
    wx /= wl; wz /= wl
    wish = maxSpeed(p)
    if (p.duck) wish *= MOVE.DUCK_MUL
    else if (b & BTN.WALK) wish *= MOVE.WALK_MUL
  }

  const wasGround = p.ground
  let jumped = false
  if (p.ground && (b & BTN.JUMP) && !(p.prevB & BTN.JUMP)) {
    p.vy = MOVE.JUMP; p.ground = 0; jumped = true
  }

  if (p.ground) {
    const sp = Math.hypot(p.vx, p.vz)
    if (sp > 0) {
      const control = sp < MOVE.STOP_SPEED ? MOVE.STOP_SPEED : sp
      let ns = sp - control * MOVE.FRICTION * dt
      if (ns < 0) ns = 0
      ns /= sp
      p.vx *= ns; p.vz *= ns
    }
    if (wish > 0) accelerate(p, wx, wz, wish, MOVE.ACCEL, dt, Infinity)
    p.vy = 0
    stepMove(p, boxes, dt, h)
  } else {
    p.vy -= MOVE.GRAVITY * dt * 0.5
    if (wish > 0) accelerate(p, wx, wz, wish, MOVE.AIR_ACCEL, dt, MOVE.AIR_CAP)
    stepMove(p, boxes, dt, h)
    p.vy -= MOVE.GRAVITY * dt * 0.5
  }

  // ground check (sticks to stairs when walking down)
  if (p.vy > 140) { p.ground = 0; return }
  const dist = wasGround && !jumped ? MOVE.STEP : 2
  traceHull(boxes, p.x, p.y, p.z, 0, -dist, 0, MOVE.HW, h, tr)
  if (tr.hit) {
    p.y -= dist * tr.frac
    p.ground = 1
    if (p.vy < 0) p.vy = 0
  } else p.ground = 0
  if (p.y < -500) { p.y = 10; p.x = 0; p.z = 300; p.vx = p.vy = p.vz = 0 } // safety net
}

function startReload(p, W, ev) {
  p.reloadEnd = p.tick + W.reload
  p.zoom = 0
  if (ev) ev.push({ k: 'reload', w: p.w })
}

function weapon(p, cmd, ev) {
  const b = cmd.b
  if (cmd.sel >= 0 && cmd.sel < WEAPONS.length && cmd.sel !== p.w) {
    p.w = cmd.sel
    p.drawEnd = p.tick + WEAPONS[p.w].draw
    p.reloadEnd = 0; p.zoom = 0; p.shots = 0
    if (ev) ev.push({ k: 'draw', w: p.w })
  }
  const W = WEAPONS[p.w]
  if (p.reloadEnd && p.tick >= p.reloadEnd) { p.ammo[p.w] = W.mag; p.reloadEnd = 0 }
  if (p.shots > 0 && p.tick - p.lastFire > W.interval + RECOIL_HOLD) {
    p.shots -= RECOIL_DECAY
    if (p.shots < 0) p.shots = 0
  }
  const drawn = p.tick >= p.drawEnd
  const firePressed = (b & BTN.FIRE) && !(p.prevB & BTN.FIRE)
  if ((b & BTN.RELOAD) && !(p.prevB & BTN.RELOAD) && drawn && !p.reloadEnd && W.mag > 0 && p.ammo[p.w] < W.mag) {
    startReload(p, W, ev)
  }
  if ((b & BTN.ALT) && !(p.prevB & BTN.ALT) && W.zoom && drawn && !p.reloadEnd) p.zoom = p.zoom ? 0 : 1

  if (!drawn || p.reloadEnd || p.tick < p.nextFire || !(b & BTN.FIRE)) return
  if (!W.auto && !firePressed) return
  if (W.mag > 0 && p.ammo[p.w] <= 0) { startReload(p, W, ev); return }

  // fire
  const inacc = inaccuracy(p)
  const pat = recoilPattern(W, p.shots)
  const rr = inacc * Math.sqrt(rand01(p.tick * 2 + 1))
  const th = 6.283185307179586 * rand01(p.tick * 2 + 2)
  const D2R = 0.017453292519943295
  const pitch = p.pitch + (pat[0] + rr * Math.cos(th)) * D2R
  const yaw = p.yaw + (pat[1] + rr * Math.sin(th)) * D2R
  const cp = Math.cos(pitch)
  if (ev) {
    ev.push({
      k: 'fire', w: p.w, ox: p.x, oy: p.y + eyeHeight(p), oz: p.z,
      dx: -Math.sin(yaw) * cp, dy: Math.sin(pitch), dz: -Math.cos(yaw) * cp,
    })
  }
  p.shots += 1
  p.lastFire = p.tick
  p.nextFire = p.tick + W.interval
  if (W.mag > 0) p.ammo[p.w]--
  if (W.zoom) p.zoom = 0
}

/** Advance one player by one command. cmd = {b, yaw, pitch, sel}. ev (optional) collects events. */
export function step(p, cmd, boxes, ev) {
  p.tick++
  if (p.alive) {
    p.yaw = cmd.yaw; p.pitch = cmd.pitch
    move(p, cmd, boxes)
    weapon(p, cmd, ev)
  }
  p.prevB = cmd.b
}
