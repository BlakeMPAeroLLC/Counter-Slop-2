// Authoritative game server + static file host. One process, one port.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { TICK, SNAP_HZ, WEAPONS, DMG_MUL, RESPAWN_MS } from '../shared/constants.js'
import { MAP } from '../shared/map.js'
import { rayWorld, rayPlayer } from '../shared/physics.js'
import { createState, spawnState, step, serialize } from '../shared/sim.js'

const PORT = Number(process.env.PORT) || 3000
const MAX_PLAYERS = 8
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
}

const httpServer = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0])
  if (rel === '/') rel = '/index.html'
  const file = path.join(DIST, path.normalize(rel))
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' })
    res.end(data)
  })
})

const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false })
const players = new Map()
let nextId = 1
let events = []
let rosterDirty = false

// SPAWNS='[[x,z],...]' overrides spawn points (used by the automated network test)
const FIXED = process.env.SPAWNS ? JSON.parse(process.env.SPAWNS) : null
let fixedI = 0

function pickSpawn(self) {
  if (FIXED) { const [x, z] = FIXED[fixedI++ % FIXED.length]; return { x, y: 0.05, z, yaw: 0 } }
  const scored = MAP.spawns.map((s) => {
    let d = Infinity
    for (const o of players.values()) {
      if (o === self || !o.state.alive) continue
      d = Math.min(d, Math.hypot(o.state.x - s.x, o.state.z - s.z))
    }
    return { s, d }
  }).sort((a, b) => b.d - a.d)
  return scored[Math.floor(Math.random() * Math.min(3, scored.length))].s
}

function roster() {
  return { k: 'roster', players: [...players.values()].map((p) => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths })) }
}

/** Where `target` was at the (fractional) command tick the shooter was looking at. */
function rewind(target, viewTick) {
  const h = target.hist
  const s = target.state
  if (typeof viewTick !== 'number' || !h.length || viewTick >= s.tick || viewTick < s.tick - TICK * 0.5) return s
  for (let i = h.length - 1; i > 0; i--) {
    const a = h[i - 1], b = h[i]
    if (a.tick <= viewTick && viewTick <= b.tick) {
      if (a.tp !== b.tp) return b
      const f = b.tick === a.tick ? 0 : (viewTick - a.tick) / (b.tick - a.tick)
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f, duck: b.duck }
    }
  }
  return s
}

function handleFire(shooter, e) {
  const W = WEAPONS[e.w]
  const wall = rayWorld(MAP.boxes, e.ox, e.oy, e.oz, e.dx, e.dy, e.dz, W.range)
  let best = null, victim = null
  for (const o of players.values()) {
    if (o === shooter || !o.state.alive) continue
    const pos = rewind(o, shooter.view[o.id])
    const r = rayPlayer(e.ox, e.oy, e.oz, e.dx, e.dy, e.dz, pos.x, pos.y, pos.z, pos.duck, wall.t)
    if (r && (!best || r.t < best.t)) { best = r; victim = o }
  }
  const t = best ? best.t : wall.t
  const end = [e.ox + e.dx * t, e.oy + e.dy * t, e.oz + e.dz * t]
  if (e.w !== 0 || best) {
    events.push({ k: 'shot', id: shooter.id, w: e.w, o: [e.ox, e.oy, e.oz], h: end, n: best || !wall.hit ? null : [wall.nx, wall.ny, wall.nz] })
  }
  if (!best) return
  const dmg = Math.max(1, Math.round(W.dmg * DMG_MUL[best.part] * Math.pow(W.falloff, best.t / 500)))
  const vs = victim.state
  vs.hp -= dmg
  const head = best.part === 'head'
  events.push({ k: 'hit', a: shooter.id, v: victim.id, dmg, head, p: end })
  if (vs.hp <= 0) {
    vs.hp = 0; vs.alive = 0; vs.zoom = 0
    victim.deaths++; shooter.kills++
    victim.respawnAt = performance.now() + RESPAWN_MS
    events.push({ k: 'kill', a: shooter.id, v: victim.id, w: e.w, head })
    rosterDirty = true
  }
}

function record(p) {
  const s = p.state
  p.hist.push({ tick: s.tick, x: s.x, y: s.y, z: s.z, duck: s.duck, tp: s.tp })
  if (p.hist.length > TICK * 2) p.hist.shift()
}

wss.on('connection', (ws) => {
  ws._socket?.setNoDelay(true)
  let p = null
  ws.on('message', (raw) => {
    let m
    try { m = JSON.parse(raw) } catch { return }
    if (m.t === 'j' && !p) {
      if (players.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'full' })); ws.close(); return }
      const name = String(m.name || 'Player').replace(/[^\w \-]/g, '').slice(0, 16) || 'Player'
      p = {
        id: nextId++, ws, name, kills: 0, deaths: 0, state: createState(), lastSeq: 0, hist: [], view: {},
        credit: 16, creditT: performance.now(), respawnAt: 0,
      }
      players.set(p.id, p)
      spawnState(p.state, pickSpawn(p))
      record(p)
      ws.send(JSON.stringify({ t: 'w', id: p.id, map: MAP.name }))
      rosterDirty = true
      console.log(`+ ${name} joined (${players.size} online)`)
    } else if (m.t === 'c' && p && Array.isArray(m.c)) {
      if (m.v && typeof m.v === 'object') p.view = m.v
      // commands are budgeted against real time so nobody can run faster than the clock
      const now = performance.now()
      p.credit = Math.min(p.credit + (now - p.creditT) * TICK / 1000, 48)
      p.creditT = now
      for (const c of m.c) {
        if (!Array.isArray(c) || !(c[0] > p.lastSeq)) continue
        if (p.credit < 1) break
        p.credit -= 1
        p.lastSeq = c[0]
        const yaw = Number(c[2]) || 0
        const pitch = Math.min(Math.max(Number(c[3]) || 0, -1.56), 1.56)
        const ev = []
        step(p.state, { b: c[1] | 0, yaw, pitch, sel: c[4] | 0 }, MAP.boxes, ev)
        record(p)
        for (const e of ev) {
          if (e.k === 'fire') handleFire(p, e)
          else if (e.k === 'reload') events.push({ k: 'reload', id: p.id })
        }
      }
    } else if (m.t === 'p') {
      ws.send(JSON.stringify({ t: 'p', c: m.c }))
    }
  })
  ws.on('close', () => {
    if (!p) return
    players.delete(p.id)
    rosterDirty = true
    console.log(`- ${p.name} left (${players.size} online)`)
  })
  ws.on('error', () => {})
})

const r2 = (v) => Math.round(v * 100) / 100
const r4 = (v) => Math.round(v * 10000) / 10000

setInterval(() => {
  const now = performance.now()
  for (const p of players.values()) {
    if (!p.state.alive && p.respawnAt && now >= p.respawnAt) {
      p.respawnAt = 0
      spawnState(p.state, pickSpawn(p))
      record(p)
    }
  }
  if (rosterDirty) { events.push(roster()); rosterDirty = false }
  const all = [...players.values()]
  const pub = all.map((p) => {
    const s = p.state
    return [p.id, s.tick, r2(s.x), r2(s.y), r2(s.z), r4(s.yaw), r4(s.pitch),
      (s.alive ? 1 : 0) | (s.duck ? 2 : 0) | (s.ground ? 4 : 0), s.w, s.tp]
  })
  for (const p of all) {
    if (p.ws.readyState !== 1) continue
    p.ws.send(JSON.stringify({
      t: 's', a: p.lastSeq, me: serialize(p.state), p: pub.filter((x) => x[0] !== p.id), e: events,
      r: p.state.alive ? 0 : Math.max(0, p.respawnAt - now),
    }))
  }
  events = []
}, 1000 / SNAP_HZ)

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Breachline server running. Map: ${MAP.name}\n`)
  console.log(`  This PC:    http://localhost:${PORT}`)
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  Coworkers:  http://${i.address}:${PORT}`)
  }
  console.log('')
})
