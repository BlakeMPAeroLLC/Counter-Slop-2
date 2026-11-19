// End-to-end: real server process, two WebSocket bots. Checks that client prediction
// matches the server exactly, and that shooting / dying / respawning works.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { TICK, BTN } from '../shared/constants.js'
import { MAP } from '../shared/map.js'
import { createState, deserialize, serialize, step } from '../shared/sim.js'

const PORT = 3219
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function bot(name) {
  const b = { name, ws: new WebSocket(`ws://127.0.0.1:${PORT}`), id: 0, state: createState(), pending: [], seq: 0,
    buttons: 0, yaw: 0, sel: -1, events: [], mismatches: 0, snaps: 0, others: [], ready: false }
  b.ws.on('open', () => b.ws.send(JSON.stringify({ t: 'j', name })))
  b.ws.on('message', (raw) => {
    const m = JSON.parse(raw)
    if (m.t === 'w') { b.id = m.id; return }
    if (m.t !== 's') return
    const before = JSON.stringify(serialize(b.state))
    deserialize(b.state, m.me)
    b.pending = b.pending.filter((c) => c.seq > m.a)
    for (const c of b.pending) step(b.state, c, MAP.boxes, null)
    // hp / alive / respawn are server-driven; only compare when those did not change
    if (b.ready && b.state.alive && JSON.stringify(serialize(b.state)) !== before && !m.e.some((e) => e.v === b.id) && b.state.tp === b.lastTp) b.mismatches++
    b.lastTp = b.state.tp
    b.ready = true; b.snaps++
    b.others = m.p
    b.events.push(...m.e)
  })
  b.timer = setInterval(() => {
    if (!b.ready) return
    const out = []
    for (let i = 0; i < 8; i++) {
      const c = { seq: ++b.seq, b: b.buttons, yaw: b.yaw, pitch: 0, sel: b.sel }
      b.sel = -1
      step(b.state, c, MAP.boxes, null)
      b.pending.push(c)
      out.push([c.seq, c.b, c.yaw, c.pitch, c.sel])
    }
    b.ws.send(JSON.stringify({ t: 'c', v: {}, c: out }))
  }, 8000 / TICK)
  return b
}

test('two players over the network', async () => {
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT, SPAWNS: '[[-300,600],[-300,350]]' }, stdio: 'ignore' })
  try {
    await sleep(700)
    const A = bot('A')
    await sleep(300)
    const B = bot('B')
    await sleep(800)
    assert.ok(A.id && B.id, 'both joined')
    assert.equal(A.others.length, 1, 'A sees B')

    // B runs around; prediction must agree with the server on every snapshot
    for (const [btn, yaw] of [[BTN.R, 0], [BTN.L | BTN.JUMP, 0.5], [BTN.R | BTN.F, 1.2], [BTN.L, 0], [0, 0]]) {
      B.buttons = btn; B.yaw = yaw
      await sleep(400)
    }
    assert.ok(B.snaps > 60, `B got ${B.snaps} snapshots`)
    assert.equal(B.mismatches, 0, 'client prediction matched the server on every snapshot')
    const seen = A.others[0]
    assert.ok(Math.hypot(seen[2] - B.state.x, seen[4] - B.state.z) < 1, 'A sees B where B thinks it is')

    // A faces B and holds fire
    const aim = () => { A.yaw = Math.atan2(-(A.others[0][2] - A.state.x), -(A.others[0][4] - A.state.z)) }
    aim(); A.buttons = BTN.FIRE
    for (let i = 0; i < 20 && !A.events.some((e) => e.k === 'kill'); i++) { aim(); await sleep(100) }
    A.buttons = 0
    assert.ok(A.events.some((e) => e.k === 'hit' && e.a === A.id && e.v === B.id), 'A hit B')
    assert.ok(A.events.some((e) => e.k === 'kill' && e.a === A.id), 'A killed B')
    assert.equal(B.state.alive, 0)
    const roster = A.events.filter((e) => e.k === 'roster').pop().players
    assert.equal(roster.find((p) => p.id === A.id).kills, 1)
    await sleep(3000)
    assert.equal(B.state.alive, 1, 'B respawned')
    assert.equal(B.state.hp, 100)
    clearInterval(A.timer); clearInterval(B.timer); A.ws.close(); B.ws.close()
  } finally { srv.kill() }
})
