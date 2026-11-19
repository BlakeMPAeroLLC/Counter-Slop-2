// Bot navigation (pure) and bot behaviour against a real server.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { TICK, BTN, TEAM } from '../shared/constants.js'
import { MAP } from '../shared/map.js'
import { createState, spawnState, step } from '../shared/sim.js'
import { buildNav } from '../server/bots.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms, what) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return; await sleep(25) }
  assert.fail(`timed out waiting for ${what}`)
}

test('navigation walks a player between spawns and sites without getting stuck', () => {
  const nav = buildNav(MAP)
  const world = { boxes: MAP.boxes, dyn: [], sites: MAP.sites, bomb: null }
  const mid = (s) => ({ x: (s.x0 + s.x1) / 2 + 60, z: (s.z0 + s.z1) / 2 + 100 })
  const [A, B] = MAP.sites.map(mid)
  const routes = [
    ['attacker spawn -> A', MAP.spawns.att[0], A, 16],
    ['attacker spawn -> B', MAP.spawns.att[2], B, 16],
    ['defender spawn -> B', MAP.spawns.def[1], B, 8],
    ['A -> B (rotation)', A, B, 12],
  ]
  for (const [name, from, to, limit] of routes) {
    const p = createState()
    p.own = 1 // knife: 250 u/s
    spawnState(p, { x: from.x, y: 0.05, z: from.z, yaw: 0 })
    let ticks = 0, arrived = false
    while (ticks < limit * TICK) {
      const st = nav.steer(p.x, p.z, to.x, to.z)
      assert.ok(st, `${name}: no route from ${p.x.toFixed(0)},${p.z.toFixed(0)}`)
      if (st.dist < 30) { arrived = true; break }
      const yaw = Math.atan2(-st.dx, -st.dz)
      for (let i = 0; i < 2; i++, ticks++) step(p, { b: BTN.F, yaw, pitch: 0, sel: -1 }, world, null)
    }
    assert.ok(arrived, `${name}: not there after ${limit}s (at ${p.x.toFixed(0)},${p.z.toFixed(0)})`)
  }
})

function client(port, name) {
  const c = { ws: new WebSocket(`ws://127.0.0.1:${port}`), id: 0, events: [], roster: [], g: null, others: [], seq: 0, me: null }
  c.say = (o) => c.ws.send(JSON.stringify(o))
  c.ws.on('open', () => c.say({ t: 'j', name }))
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw)
    if (m.t === 'w') c.id = m.id
    if (m.t !== 's') return
    c.g = m.g; c.others = m.p; c.me = m.me
    for (const e of m.e) { c.events.push(e); if (e.k === 'roster') c.roster = e.players }
  })
  // an idle human: keeps sending empty commands so the server sees a live player
  c.timer = setInterval(() => {
    if (!c.id) return
    const out = []
    for (let i = 0; i < 8; i++) out.push([++c.seq, 0, 0, 0, -1])
    c.say({ t: 'c', v: {}, c: out })
  }, 8000 / TICK)
  c.stop = () => { clearInterval(c.timer); c.ws.close() }
  return c
}
const serve = (port, env) => spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, ...env }, stdio: 'ignore' })

test('a bot added in deathmatch finds and kills an idle player', async () => {
  const srv = serve(3231, { SPAWNS: '[[-1000,700],[-1000,400,3.14]]' })
  try {
    await sleep(700)
    const H = client(3231, 'Human')
    await until(() => H.id, 2000, 'join')
    H.say({ t: 'bot', op: 'add' })
    await until(() => H.roster.some((r) => r.bot), 2000, 'bot in roster')
    const bot = H.roster.find((r) => r.bot)
    assert.match(bot.name, /^Bot /)
    await until(() => H.events.some((e) => e.k === 'kill' && e.a === bot.id && e.v === H.id), 12000, 'the bot to kill the idle player')
    H.say({ t: 'bot', op: 'skill', v: 2 })
    await until(() => H.g.bs === 2, 1000, 'difficulty change')
    H.say({ t: 'bot', op: 'remove' })
    await until(() => !H.roster.some((r) => r.bot), 2000, 'bot removal')
    H.stop()
  } finally { srv.kill() }
})

test('one player plus one bot can play a bomb round, and the attacking bot wins it', async () => {
  const srv = serve(3232, { RULES: JSON.stringify({ FREEZE_MS: 300, END_MS: 400, BOMB_MS: 3000 }) })
  try {
    await sleep(700)
    const H = client(3232, 'Human')
    await until(() => H.id, 2000, 'join')
    H.say({ t: 'bot', op: 'add' })
    await until(() => H.roster.some((r) => r.bot), 2000, 'bot in roster')
    H.say({ t: 'mode', m: 1 })
    await until(() => H.g && H.g.m === 1 && H.roster.every((r) => r.team), 3000, 'match start')
    const bot = H.roster.find((r) => r.bot)
    assert.equal(bot.team, TEAM.ATT, 'the human defends, the bot attacks')
    const start = H.others.find((o) => o[0] === bot.id).slice(2, 5)
    // the bot has to cross the map and either plant and hold until detonation, or find the defender
    await until(() => H.events.some((e) => e.k === 're'), 45000, 'the round to end')
    const re = H.events.find((e) => e.k === 're')
    assert.equal(re.w, TEAM.ATT, `attackers should win against an idle defender (ended by ${re.why})`)
    const now = H.others.find((o) => o[0] === bot.id)
    assert.ok(Math.hypot(now[2] - start[0], now[4] - start[2]) > 800 || re.why === 'elim', 'the bot crossed the map')
    H.stop()
  } finally { srv.kill() }
})
