import test from 'node:test'
import assert from 'node:assert/strict'
import { TICK, BTN, MOVE, WEAPONS } from '../shared/constants.js'
import { MAP } from '../shared/map.js'
import { hullBlocked } from '../shared/physics.js'
import { createState, spawnState, step, serialize, deserialize, inaccuracy } from '../shared/sim.js'

const fresh = (x = 0, z = 620, yaw = 0, w = 0) => {
  const p = createState()
  spawnState(p, { x, y: 0.05, z, yaw })
  p.w = w
  return p
}
const run = (p, b, ticks, yaw = p.yaw) => { for (let i = 0; i < ticks; i++) step(p, { b, yaw, pitch: 0, sel: -1 }, MAP.boxes, null) }
const speed = (p) => Math.hypot(p.vx, p.vz)

test('spawns are clear of geometry', () => {
  for (const s of MAP.spawns) assert.equal(hullBlocked(MAP.boxes, s.x, s.y, s.z, MOVE.HW, MOVE.H_STAND), false)
})

test('reaches and holds max run speed', () => {
  const p = fresh(-500, 0, Math.PI) // facing +z down the west lane
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

test('jump apex is about 45 units', () => {
  const p = fresh()
  run(p, 0, 10)
  const y0 = p.y
  let top = 0
  run(p, BTN.JUMP, 1)
  for (let i = 0; i < TICK; i++) { run(p, BTN.JUMP, 1); top = Math.max(top, p.y - y0) }
  assert.ok(top > 43 && top < 47, `apex ${top}`)
  assert.ok(p.ground, 'landed, and holding jump does not auto-hop')
})

test('air strafing gains speed', () => {
  const p = fresh(-500, -400, Math.PI)
  run(p, BTN.F, TICK)
  let yaw = Math.PI
  step(p, { b: BTN.JUMP, yaw, pitch: 0, sel: -1 }, MAP.boxes, null)
  const before = speed(p)
  while (!p.ground) { yaw += 0.006; step(p, { b: BTN.L, yaw, pitch: 0, sel: -1 }, MAP.boxes, null) }
  assert.ok(speed(p) > before + 5, `${before} -> ${speed(p)}`)
})

test('walks up stairs onto the centre platform', () => {
  const p = fresh(0, 400, 0) // facing -z toward the north stairs
  run(p, BTN.F, TICK * 2)
  assert.ok(Math.abs(p.y - 64) < 0.2, `y ${p.y}`)
  assert.ok(p.ground)
})

test('walls stop the player without tunnelling or sticking', () => {
  const p = fresh(-700, 0, Math.PI / 2) // facing -x into the west wall
  run(p, BTN.F, TICK * 2)
  assert.ok(p.x > -800 + MOVE.HW - 0.01 && p.x < -800 + MOVE.HW + 0.2, `x ${p.x}`)
  const z0 = p.z
  run(p, BTN.F | BTN.R, TICK) // slide along it
  assert.ok(Math.abs(p.z - z0) > 100, 'slides along wall')
})

test('crouch lowers speed and cannot stand under nothing weird', () => {
  const p = fresh(-500, 0, Math.PI)
  run(p, BTN.F | BTN.DUCK, TICK * 4)
  assert.ok(Math.abs(speed(p) - 250 * MOVE.DUCK_MUL) < 1)
  run(p, 0, 5)
  assert.equal(p.duck, 0)
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
  p.drawEnd = 0
  const ev = []
  for (let i = 0; i < TICK; i++) step(p, { b: BTN.FIRE, yaw: 0, pitch: 0, sel: -1 }, MAP.boxes, ev)
  const shots = ev.filter((e) => e.k === 'fire').length
  assert.ok(shots === 10 || shots === 11, `shots ${shots}`)
  for (let i = 0; i < TICK * 6; i++) step(p, { b: BTN.FIRE, yaw: 0, pitch: 0, sel: -1 }, MAP.boxes, ev)
  assert.ok(ev.some((e) => e.k === 'reload'))
  assert.ok(ev.filter((e) => e.k === 'fire').length > WEAPONS[3].mag)
})

test('simulation is deterministic through serialisation', () => {
  const a = fresh(100, 620, 0.3, 3), b = createState()
  let seed = 7
  for (let i = 0; i < 4000; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0
    const cmd = { b: (seed >>> 8) & 1023 & ~BTN.DUCK, yaw: (seed % 628) / 100, pitch: 0, sel: i % 400 === 0 ? (seed >>> 4) % 5 : -1 }
    if (i === 2000) deserialize(b, JSON.parse(JSON.stringify(serialize(a))))
    step(a, cmd, MAP.boxes, null)
    if (i >= 2000) step(b, cmd, MAP.boxes, null)
    assert.ok(a.x > -801 && a.x < 801 && a.z > -801 && a.z < 801 && a.y > -1, `escaped map at ${i}`)
  }
  assert.deepEqual(serialize(a), serialize(b))
})
