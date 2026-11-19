import test from 'node:test'
import assert from 'node:assert/strict'
import { TICK, BTN, MOVE, WEAPONS, TEAM } from '../shared/constants.js'
import { MAP } from '../shared/map.js'
import { hullBlocked, stepNade } from '../shared/physics.js'
import { createState, spawnState, step, serialize, deserialize, inaccuracy } from '../shared/sim.js'

// A small purpose-built world so these tests do not depend on the playable map's layout.
const boxes = [
  { x0: -2000, y0: -16, z0: -2000, x1: 2000, y1: 0, z1: 2000 }, // floor
  { x0: -832, y0: 0, z0: -2000, x1: -800, y1: 288, z1: 2000 }, // west wall
  { x0: -144, y0: 0, z0: -144, x1: 144, y1: 64, z1: 144 }, // platform
  { x0: 500, y0: 0, z0: 300, x1: 560, y1: 60, z1: 360 }, // 60-high crate
]
for (let k = 1; k <= 3; k++) boxes.push({ x0: -72, y0: 0, z0: 144 + (3 - k) * 24, x1: 72, y1: 16 * k, z1: 144 + (4 - k) * 24 })
const site = { name: 'A', x0: 900, x1: 1200, z0: 900, z1: 1200 }
const mkWorld = () => ({ boxes, dyn: [], sites: [site], bomb: null })
const world = mkWorld()

const fresh = (x = 0, z = 620, yaw = 0, w = 0) => {
  const p = createState()
  p.own = 31
  spawnState(p, { x, y: 0.05, z, yaw })
  p.w = w
  p.drawEnd = 0
  return p
}
const cmd = (b, yaw = 0, sel = -1) => ({ b, yaw, pitch: 0, sel })
const run = (p, b, ticks, wd = world) => { for (let i = 0; i < ticks; i++) step(p, cmd(b, p.yaw), wd, null) }
const speed = (p) => Math.hypot(p.vx, p.vz)

test('map: every spawn is clear and both sites are reachable from both spawns', () => {
  const mw = { boxes: MAP.boxes }
  for (const list of Object.values(MAP.spawns)) {
    for (const s of list) assert.equal(hullBlocked(mw, s.x, s.y, s.z, MOVE.HW, MOVE.H_STAND), false, `spawn ${s.x},${s.z}`)
  }
  const G = 16, N = Math.floor(MAP.size / G)
  const key = (i, j) => (i + N) * 4096 + (j + N)
  const free = (i, j) => Math.abs(i) < N && Math.abs(j) < N && !hullBlocked(mw, i * G, 0.05, j * G, MOVE.HW, MOVE.H_STAND)
  const seen = new Set()
  const start = MAP.spawns.att[0]
  const q = [[Math.round(start.x / G), Math.round(start.z / G)]]
  seen.add(key(...q[0]))
  while (q.length) {
    const [i, j] = q.pop()
    for (const [a, b] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
      if (seen.has(key(a, b)) || !free(a, b)) continue
      seen.add(key(a, b)); q.push([a, b])
    }
  }
  const reach = (x, z) => seen.has(key(Math.round(x / G), Math.round(z / G)))
  for (const s of [...MAP.spawns.def, ...MAP.spawns.dm]) assert.ok(reach(s.x, s.z), `unreachable spawn ${s.x},${s.z}`)
  for (const s of MAP.sites) {
    let cells = 0
    for (let x = s.x0 + 16; x < s.x1; x += G) for (let z = s.z0 + 16; z < s.z1; z += G) if (reach(x, z)) cells++
    assert.ok(cells > 150, `site ${s.name} has only ${cells} plantable cells`)
  }
})

test('reaches and holds max run speed', () => {
  const p = fresh(-500, 0, Math.PI)
  run(p, BTN.F, TICK)
  assert.ok(p.ground)
  assert.ok(Math.abs(speed(p) - 250) < 1, `speed ${speed(p)}`)
})

test('counter-strafe stops much faster than letting go', () => {
  const a = fresh(0, 620, 0), b = fresh(0, 620, 0)
  run(a, BTN.R, TICK); run(b, BTN.R, TICK)
  let coast = 0, counter = 0
  while (speed(a) > 250 * 0.34 && coast < 500) { run(a, 0, 1); coast++ }
  while (speed(b) > 250 * 0.34 && counter < 500) { run(b, BTN.L, 1); counter++ }
  assert.ok(counter < coast * 0.6, `counter ${counter} coast ${coast}`)
  assert.ok(counter / TICK < 0.11, `counter-strafe took ${counter / TICK}s`)
})

test('jump apex is about 45 units and holding jump does not auto-hop', () => {
  const p = fresh()
  run(p, 0, 10)
  const y0 = p.y
  let top = 0
  run(p, BTN.JUMP, 1)
  for (let i = 0; i < TICK; i++) { run(p, BTN.JUMP, 1); top = Math.max(top, p.y - y0) }
  assert.ok(top > 43 && top < 47, `apex ${top}`)
  assert.ok(p.ground)
})

test('air strafing gains speed, landing tired loses some', () => {
  const p = fresh(-500, -400, Math.PI)
  run(p, BTN.F, TICK)
  let yaw = Math.PI
  step(p, cmd(BTN.JUMP, yaw), world, null)
  const before = speed(p)
  let inAir = before
  while (!p.ground) { inAir = speed(p); yaw += 0.006; step(p, cmd(BTN.L, yaw), world, null) }
  assert.ok(inAir > before + 5, `${before} -> ${inAir}`)
  assert.ok(speed(p) < inAir * 0.95, `landing kept ${speed(p)} of ${inAir}`)
})

test('walks up stairs onto the platform', () => {
  const p = fresh(0, 400, 0)
  run(p, BTN.F, TICK * 2)
  assert.ok(Math.abs(p.y - 64) < 0.2, `y ${p.y}`)
  assert.ok(p.ground)
})

test('walls stop the player without tunnelling or sticking', () => {
  const p = fresh(-700, 0, Math.PI / 2)
  run(p, BTN.F, TICK * 2)
  assert.ok(p.x > -800 + MOVE.HW - 0.01 && p.x < -800 + MOVE.HW + 0.2, `x ${p.x}`)
  const z0 = p.z
  run(p, BTN.F | BTN.R, TICK)
  assert.ok(Math.abs(p.z - z0) > 100, 'slides along wall')
})

test('crouching is slow and standing back up works', () => {
  const p = fresh(-500, 0, Math.PI)
  run(p, BTN.F | BTN.DUCK, TICK * 4)
  assert.ok(Math.abs(speed(p) - 250 * MOVE.DUCK_MUL) < 1)
  run(p, 0, 5)
  assert.equal(p.duck, 0)
})

test('a 60-unit crate needs a crouch-jump', () => {
  const attempt = (duck) => {
    const p = fresh(530, 800, 0)
    while (p.z > 460) run(p, BTN.F, 1)
    run(p, BTN.F | BTN.JUMP, 1)
    run(p, BTN.F | (duck ? BTN.DUCK : 0), 100)
    return p
  }
  const plain = attempt(false)
  assert.ok(plain.y < 1 && plain.z > 375, `plain jump got to y ${plain.y} z ${plain.z}`)
  const cj = attempt(true)
  assert.ok(Math.abs(cj.y - 60) < 0.2 && cj.ground, `crouch-jump ended at y ${cj.y}`)
})

test('players block each other and can be stood on', () => {
  const wd = mkWorld()
  wd.dyn = [{ x0: -516, x1: -484, y0: 0, y1: 72, z0: 184, z1: 216 }] // someone standing at (-500, 200)
  const p = fresh(-500, 0, Math.PI)
  run(p, BTN.F, TICK * 2, wd)
  assert.ok(p.z < 184 - MOVE.HW + 0.2 && p.z > 150, `stopped at z ${p.z}`)
  const q = fresh(-500, 200, 0)
  q.y = 120
  run(q, 0, TICK, wd)
  assert.ok(Math.abs(q.y - 72) < 0.2 && q.ground, `landed on head at y ${q.y}`)
})

test('moving is inaccurate, standing is accurate', () => {
  const p = fresh(-500, 0, Math.PI, 3)
  run(p, 0, 20)
  const still = inaccuracy(p)
  run(p, BTN.F, TICK)
  assert.ok(inaccuracy(p) > still * 10)
})

test('rifle fires at its cadence and reloads', () => {
  const p = fresh(0, 620, 0, 3)
  const ev = []
  for (let i = 0; i < TICK; i++) step(p, cmd(BTN.FIRE), world, ev)
  const shots = ev.filter((e) => e.k === 'fire').length
  assert.ok(shots === 10 || shots === 11, `shots ${shots}`)
  for (let i = 0; i < TICK * 6; i++) step(p, cmd(BTN.FIRE), world, ev)
  assert.ok(ev.some((e) => e.k === 'reload'))
  assert.ok(ev.filter((e) => e.k === 'fire').length > WEAPONS[3].mag)
})

test('only owned weapons can be selected; grenades are thrown and used up', () => {
  const p = fresh(0, 620, 0, 1)
  p.own = 3 // knife + pistol
  step(p, cmd(0, 0, 3), world, null)
  assert.equal(p.w, 1, 'cannot select a rifle that is not owned')
  p.own |= 1 << 5; p.ammo[5] = 1
  const ev = []
  step(p, cmd(0, 0, 5), world, ev)
  assert.equal(p.w, 5)
  for (let i = 0; i < TICK; i++) step(p, cmd(0), world, ev)
  step(p, cmd(BTN.FIRE), world, ev)
  const t = ev.find((e) => e.k === 'throw')
  assert.ok(t && t.w === 5 && t.vz < -400, 'thrown forward')
  assert.equal(p.w, 1, 'switches back after the last grenade')
  assert.equal((p.own >> 5) & 1, 0)

  const n = { x: t.ox, y: t.oy, z: t.oz, vx: t.vx, vy: t.vy, vz: t.vz }
  for (let i = 0; i < TICK * 6; i++) stepNade(n, world, 1 / TICK)
  assert.ok(n.rest && n.y < 70 && n.y > -1, `grenade came to rest at y ${n.y}`)
})

test('planting, defusing and freeze time lock movement', () => {
  const wd = mkWorld()
  const p = fresh(1000, 1000, 0, 3)
  run(p, 0, 10, wd)
  p.bomb = 1
  const x0 = p.x, z0 = p.z
  run(p, BTN.USE | BTN.F | BTN.FIRE, 50, wd)
  assert.equal(p.act, 1)
  assert.equal(p.actT, 49)
  assert.ok(Math.hypot(p.x - x0, p.z - z0) < 0.01, 'cannot move while planting')
  assert.equal(p.ammo[3], WEAPONS[3].mag, 'cannot shoot while planting')
  run(p, 0, 1, wd)
  assert.equal(p.act, 0, 'letting go cancels')

  const outside = fresh(0, 620, 0)
  outside.bomb = 1
  run(outside, BTN.USE, 20, wd)
  assert.equal(outside.act, 0, 'no planting outside a site')

  wd.bomb = { x: 1000, y: 0, z: 1000 }
  const d = fresh(1030, 1000, 0)
  d.team = TEAM.DEF
  run(d, BTN.USE, 30, wd)
  assert.equal(d.act, 2)
  const a = fresh(1030, 1040, 0)
  a.team = TEAM.ATT
  run(a, BTN.USE, 30, wd)
  assert.equal(a.act, 0, 'attackers cannot defuse')

  const f = fresh(0, 620, 0, 3)
  f.frz = 1
  run(f, BTN.F | BTN.FIRE | BTN.JUMP, 60, wd)
  assert.ok(speed(f) === 0 && f.ammo[3] === WEAPONS[3].mag && f.y < 1, 'frozen players cannot move, jump or shoot')
})

test('simulation is deterministic through serialisation', () => {
  const a = fresh(100, 620, 0.3, 3), b = createState()
  let seed = 7
  for (let i = 0; i < 6000; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0
    const c = { b: (seed >>> 8) & 2047, yaw: (seed % 628) / 100, pitch: 0, sel: i % 400 === 0 ? (seed >>> 4) % 5 : -1 }
    if (i === 2000) deserialize(b, JSON.parse(JSON.stringify(serialize(a))))
    step(a, c, world, null)
    if (i >= 2000) step(b, c, world, null)
    assert.ok(a.x > -801 && Math.abs(a.x) < 2000 && Math.abs(a.z) < 2000 && a.y > -1, `escaped the world at ${i}`)
  }
  assert.deepEqual(serialize(a), serialize(b))
})
