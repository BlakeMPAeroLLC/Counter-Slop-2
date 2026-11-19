// End-to-end: a real server process and WebSocket bots.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { TICK, BTN, TEAM, RULES } from '../shared/constants.js'
import { MAP } from '../shared/map.js'
import { createState, deserialize, serialize, step } from '../shared/sim.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms, what) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return; await sleep(25) }
  assert.fail(`timed out waiting for ${what}`)
}

function bot(port, name) {
  const world = { boxes: MAP.boxes, dyn: [], sites: MAP.sites, bomb: null }
  const b = { name, ws: new WebSocket(`ws://127.0.0.1:${port}`), id: 0, state: createState(), pending: [], seq: 0,
    buttons: 0, yaw: 0, pitch: 0, sel: -1, events: [], msgs: [], mismatches: 0, snaps: 0, others: [], g: null, ready: false }
  b.say = (o) => b.ws.send(JSON.stringify(o))
  b.ws.on('open', () => b.say({ t: 'j', name }))
  b.ws.on('message', (raw) => {
    const m = JSON.parse(raw)
    if (m.t === 'w') { b.id = m.id; return }
    if (m.t !== 's') { b.msgs.push(m); return }
    const before = JSON.stringify(serialize(b.state))
    deserialize(b.state, m.me)
    b.pending = b.pending.filter((c) => c.seq > m.a)
    for (const c of b.pending) step(b.state, c, world, null)
    // hp / alive / respawn are server-driven; only compare when those did not change
    if (b.ready && b.state.alive && JSON.stringify(serialize(b.state)) !== before && !m.e.some((e) => e.v === b.id) && b.state.tp === b.lastTp) b.mismatches++
    b.lastTp = b.state.tp
    b.ready = true; b.snaps++
    b.others = m.p
    b.g = m.g
    b.events.push(...m.e)
  })
  b.timer = setInterval(() => {
    if (!b.ready) return
    const out = []
    for (let i = 0; i < 8; i++) {
      const c = { seq: ++b.seq, b: b.buttons, yaw: b.yaw, pitch: b.pitch, sel: b.sel }
      b.sel = -1
      step(b.state, c, world, null)
      b.pending.push(c)
      out.push([c.seq, c.b, c.yaw, c.pitch, c.sel])
    }
    b.say({ t: 'c', v: {}, c: out })
  }, 8000 / TICK)
  b.stop = () => { clearInterval(b.timer); b.ws.close() }
  return b
}

const serve = (port, env) => spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, ...env }, stdio: 'ignore' })

test('deathmatch: prediction matches the server, shooting kills, players respawn', async () => {
  const srv = serve(3219, { SPAWNS: '[[-1000,700],[-1000,400]]' })
  try {
    await sleep(700)
    const A = bot(3219, 'A')
    await sleep(300)
    const B = bot(3219, 'B')
    await sleep(800)
    assert.ok(A.id && B.id, 'both joined')
    assert.equal(A.others.length, 1, 'A sees B')
    assert.equal(A.g.m, 0, 'starts in deathmatch')

    // B runs around; prediction must agree with the server on every snapshot
    for (const [btn, yaw] of [[BTN.R, 0], [BTN.L | BTN.JUMP, 0.5], [BTN.R | BTN.F | BTN.DUCK, 1.2], [BTN.L, 0], [0, 0]]) {
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

    // a lone player cannot start a bomb match
    B.stop()
    await sleep(200)
    A.say({ t: 'mode', m: 1 })
    await sleep(300)
    assert.equal(A.g.m, 0)
    assert.ok(A.msgs.some((m) => m.t === 'm'), 'told why it did not start')
    A.stop()
  } finally { srv.kill() }
})

test('bomb mode: buy, plant, explode, then plant and defuse', async () => {
  const rules = { FREEZE_MS: 300, ROUND_MS: 20000, BOMB_MS: 3000, END_MS: 400, PLANT_TICKS: 64, DEFUSE_TICKS: 64 }
  // both spawn points are inside site A, 50 units apart
  const srv = serve(3220, { SPAWNS: '[[-800,-780],[-800,-730]]', RULES: JSON.stringify(rules) })
  try {
    await sleep(700)
    const A = bot(3220, 'A'), B = bot(3220, 'B')
    await sleep(900)
    A.say({ t: 'mode', m: 1 })
    await until(() => A.g && A.g.m === 1 && A.state.team && B.state.team, 2000, 'match start')
    assert.notEqual(A.state.team, B.state.team, 'one player per team')
    const att = A.state.team === TEAM.ATT ? A : B, def = att === A ? B : A
    assert.equal(att.state.money, RULES.START_MONEY)
    assert.equal(att.state.own, 3, 'starts with knife and pistol only')
    await until(() => att.state.bomb === 1, 1000, 'attacker to receive the bomb')
    assert.ok(att.g.b && att.g.b[0] === 1, 'attackers are told where the bomb is')
    assert.equal(def.g.b, null, 'defenders are not')

    // buying
    def.say({ t: 'buy', id: 'armor' })
    att.say({ t: 'buy', id: 'rifle' }) // too expensive
    att.say({ t: 'buy', id: 'kit' }) // defenders only
    await until(() => def.state.armor === 100, 1000, 'armour purchase')
    assert.equal(def.state.money, RULES.START_MONEY - 650)
    assert.equal(att.state.money, RULES.START_MONEY)
    assert.equal(att.state.own, 3)

    // round 1: plant and let it explode
    await until(() => att.g.ph === 'live', 2000, 'round to go live')
    att.buttons = BTN.USE
    await until(() => att.events.some((e) => e.k === 'planted' && e.site === 'A'), 3000, 'plant')
    att.buttons = 0
    assert.equal(att.state.bomb, 0)
    assert.ok(def.g.b && def.g.b[0] === 3, 'everyone sees the planted bomb')
    await until(() => att.events.some((e) => e.k === 'boom'), 5000, 'explosion')
    const r1 = att.events.find((e) => e.k === 're')
    assert.deepEqual([r1.w, r1.why], [TEAM.ATT, 'boom'])
    assert.equal(def.state.alive, 0, 'the blast kills players next to it')

    // round 2: plant again, defender defuses
    await until(() => att.g.r === 2 && att.g.ph === 'live' && att.state.bomb === 1 && def.state.alive, 4000, 'round 2')
    assert.equal(def.state.armor, 0, 'a dead player loses their gear')
    assert.equal(att.state.money, RULES.START_MONEY + RULES.PLANT_BONUS + RULES.WIN)
    att.buttons = BTN.USE
    await until(() => att.events.filter((e) => e.k === 'planted').length === 2, 3000, 'second plant')
    att.buttons = 0
    def.buttons = BTN.USE
    await until(() => def.events.some((e) => e.k === 'defused' && e.id === def.id), 3000, 'defuse')
    def.buttons = 0
    const r2 = def.events.filter((e) => e.k === 're')[1]
    assert.deepEqual([r2.w, r2.why, r2.s], [TEAM.DEF, 'defuse', [1, 1]])
    assert.ok(!def.events.some((e) => e.k === 'boom' && def.events.indexOf(e) > def.events.indexOf(r2)), 'a defused bomb does not explode')

    // ending the match returns everyone to deathmatch with full loadouts
    def.say({ t: 'mode', m: 0 })
    await until(() => def.g.m === 0 && def.state.team === 0 && def.state.own > 31, 2000, 'return to deathmatch')
    A.stop(); B.stop()
  } finally { srv.kill() }
})

test('combat rules: rifles shoot through a crate at half damage, pistols do not, grenades hurt', async () => {
  // A and B stand either side of the 60-unit crate in the west alley
  const srv = serve(3221, { SPAWNS: '[[-650,180],[-420,180]]' })
  try {
    await sleep(700)
    const A = bot(3221, 'A')
    await sleep(300)
    const B = bot(3221, 'B')
    await sleep(800)
    const hits = () => A.events.filter((e) => e.k === 'hit' && e.a === A.id && e.v === B.id)
    A.yaw = -Math.PI / 2 // facing +x, straight at B
    A.buttons = BTN.DUCK // crouched, so the shot has to pass through the crate
    await sleep(900)
    A.sel = 1 // pistol: too weak to get through
    await sleep(700)
    A.buttons = BTN.DUCK | BTN.FIRE
    await sleep(300)
    A.buttons = BTN.DUCK
    await sleep(200)
    assert.equal(hits().length, 0, 'pistol does not penetrate the crate')
    A.sel = 3
    await sleep(900)
    A.buttons = BTN.DUCK | BTN.FIRE
    await until(() => hits().length > 0, 2000, 'a rifle hit through the crate')
    A.buttons = BTN.DUCK
    const first = hits()[0]
    assert.ok(first.dmg >= 14 && first.dmg <= 18, `penetration damage ${first.dmg} (a direct body hit is about 33)`)

    // grenade dropped at own feet
    A.buttons = 0; A.sel = 5; A.pitch = -1.3
    await sleep(700)
    const hp = A.state.hp
    A.buttons = BTN.FIRE
    await sleep(100)
    A.buttons = 0
    await until(() => A.events.some((e) => e.k === 'nade' && e.w === 5), 3000, 'grenade detonation')
    await sleep(100)
    assert.ok(A.state.hp < hp, `own grenade did damage (${hp} -> ${A.state.hp})`)
    assert.ok(A.events.some((e) => e.k === 'throw' && e.id === A.id))
    A.stop(); B.stop()
  } finally { srv.kill() }
})
