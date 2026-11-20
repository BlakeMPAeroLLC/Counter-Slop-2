// Authoritative game server + static file host. One process, one port.
// Modes: deathmatch (warm-up) and bomb (round-based, two teams, plant / defuse).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { TICK, SNAP_HZ, WEAPONS, GUNS, DMG_MUL, RESPAWN_MS, RULES, SHOP, TEAM, MOVE, SMOKE_MS } from '../shared/constants.js'
import { MAP } from '../shared/map.js'
import { rayWorld, rayPlayer, traceHull, lineOfSight, stepNade } from '../shared/physics.js'
import { createState, spawnState, step, serialize, eyeHeight } from '../shared/sim.js'
import { buildNav, think, createBotState, BOT_NAMES, SKILLS } from './bots.js'

const PORT = Number(process.env.PORT) || 3000
const MAX_PLAYERS = 10
// RULES='{"FREEZE_MS":500}' overrides rule values (used by the automated tests to run fast)
const R = { ...RULES, ...(process.env.RULES ? JSON.parse(process.env.RULES) : {}) }
const RESPAWN = Number(process.env.RESPAWN_MS) || RESPAWN_MS
// SPAWNS='[[x,z],...]' overrides every spawn point, in join order (automated tests)
const FIXED = process.env.SPAWNS ? JSON.parse(process.env.SPAWNS) : null
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.hdr': 'application/octet-stream', '.md': 'text/plain',
}

const httpServer = http.createServer((req, res) => {
  let rel
  try { rel = decodeURIComponent((req.url || '/').split('?')[0]) } catch { res.writeHead(400).end(); return }
  if (rel.includes('\0')) { res.writeHead(400).end(); return }
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
const world = { boxes: MAP.boxes, sites: MAP.sites, bomb: null, dyn: [] }
const staticWorld = { boxes: MAP.boxes }
const nades = []
// bots
const nav = buildNav(MAP)
const intel = [null, null, null] // last enemy sighting per team, shared between that team's bots
const smokes = [] // active smoke clouds (bots cannot see through them)
let botSkill = 1
let botAcc = 0
let nextId = 1
let events = []
let rosterDirty = false

// ---------- match state ----------
// bomb.st: 1 carried, 2 dropped, 3 planted, 4 defused, 5 exploded
const G = { mode: 0, phase: 'live', phaseEnd: 0, liveAt: 0, round: 0, score: [0, 0, 0], streak: [0, 0, 0], bomb: null, plantedThisRound: false, botSite: 0 }

const all = () => [...players.values()]
const team = (t) => all().filter((p) => p.state.team === t)
const aliveOn = (t) => all().filter((p) => p.state.team === t && p.state.alive).length
const send = (p, obj) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)) }
const say = (text, to) => { if (to) send(to, { t: 'm', text }); else events.push({ k: 'msg', text }) }
const clampMoney = (s) => { s.money = Math.max(0, Math.min(R.MAX_MONEY, s.money)) }

function roster() {
  return {
    k: 'roster',
    players: all().map((p) => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths, team: p.state.team, alive: p.state.alive ? 1 : 0, want: p.wantTeam || 0, bot: p.bot ? 1 : 0 })),
  }
}

function floorY(x, y, z) {
  const tr = {}
  traceHull(staticWorld, x, y + 4, z, 0, -4000, 0, 4, 4, tr)
  return y + 4 - 4000 * tr.frac
}

let fixedI = 0
function pickSpawn(p) {
  if (FIXED) { const [x, z, yaw] = FIXED[fixedI++ % FIXED.length]; return { x, y: 0.05, z, yaw: yaw || 0 } }
  if (G.mode === 1) {
    const list = p.state.team === TEAM.ATT ? MAP.spawns.att : MAP.spawns.def
    return list[p.slot % list.length]
  }
  const scored = MAP.spawns.dm.map((s) => {
    let d = Infinity
    for (const o of players.values()) {
      if (o === p || !o.state.alive) continue
      d = Math.min(d, Math.hypot(o.state.x - s.x, o.state.z - s.z))
    }
    return { s, d }
  }).sort((a, b) => b.d - a.d)
  return scored[Math.floor(Math.random() * Math.min(3, scored.length))].s
}

function record(p) {
  const s = p.state
  p.hist.push({ tick: s.tick, x: s.x, y: s.y, z: s.z, duck: s.duck, tp: s.tp })
  if (p.hist.length > TICK * 2) p.hist.shift()
}

function spawn(p) {
  spawnState(p.state, pickSpawn(p))
  p.respawnAt = 0
  record(p)
}

function loadoutDM(p) {
  const s = p.state
  s.team = 0; s.frz = 0; s.bomb = 0; s.kit = 0; s.armor = 0; s.helmet = 0; s.money = 0
  s.own = 31 | (1 << 5) | (1 << 6)
  s.ammo[5] = 1; s.ammo[6] = 1; s.ammo[7] = 0
}

function loadoutPistol(p) {
  const s = p.state
  s.own = 3; s.armor = 0; s.helmet = 0; s.kit = 0
  for (let i = GUNS; i < WEAPONS.length; i++) s.ammo[i] = 0
}

// ---------- bomb mode ----------
function startMatch(by) {
  if (players.size < 2) { say('Need at least 2 players to start a bomb match.', by); return }
  const mix = (l) => l.sort(() => Math.random() - 0.5)
  // humans are split between the teams first, then bots fill in
  const order = [...mix(all().filter((p) => !p.bot)), ...mix(all().filter((p) => p.bot))]
  // with an odd count the extra player defends: a lone attacker has better odds than a lone defender
  order.forEach((p, i) => { p.state.team = i % 2 === 0 ? TEAM.DEF : TEAM.ATT; p.wantTeam = 0 })
  G.mode = 1; G.round = 0; G.score = [0, 0, 0]; G.streak = [0, 0, 0]
  for (const p of players.values()) {
    p.kills = 0; p.deaths = 0; p.survived = false; p.state.money = R.START_MONEY
    if (p.bot) p.bot.boughtRound = -1
  }
  events.push({ k: 'mode', m: 1 })
  startRound()
}

function startRound() {
  const now = performance.now()
  G.round++
  G.phase = 'freeze'
  G.phaseEnd = now + R.FREEZE_MS
  G.plantedThisRound = false
  world.bomb = null
  nades.length = 0
  smokes.length = 0
  intel[1] = intel[2] = null
  G.botSite = Math.floor(Math.random() * MAP.sites.length)
  const slots = [0, 0, 0]
  for (const p of players.values()) {
    const s = p.state
    if (p.wantTeam) {
      // re-check: other players may have switched or left since this was asked for
      const ok = !switchBlocked(p, p.wantTeam)
      if (ok) { s.team = p.wantTeam; p.survived = false }
      p.wantTeam = 0
    }
    if (!s.team) s.team = team(TEAM.ATT).length <= team(TEAM.DEF).length ? TEAM.ATT : TEAM.DEF
    if (!p.survived) loadoutPistol(p)
    s.bomb = 0; s.frz = 1
    p.slot = slots[s.team]++
    spawn(p)
  }
  const att = team(TEAM.ATT)
  if (att.length) {
    const c = att[Math.floor(Math.random() * att.length)]
    c.state.bomb = 1
    G.bomb = { st: 1, carrier: c.id, x: 0, y: 0, z: 0, explodeAt: 0 }
  } else G.bomb = { st: 0, carrier: 0, x: 0, y: 0, z: 0, explodeAt: 0 }
  let k = Math.floor(Math.random() * 2)
  for (const p of team(TEAM.DEF)) if (p.bot) p.bot.holdSite = k++ % 2 // defending bots split between the sites
  events.push({ k: 'rs', n: G.round })
  rosterDirty = true
}

function endRound(winner, why) {
  if (G.phase !== 'live') return
  const now = performance.now()
  G.phase = 'end'
  G.phaseEnd = now + R.END_MS
  G.score[winner]++
  const loser = 3 - winner
  G.streak[loser]++; G.streak[winner] = 0
  let loss = Math.min(R.LOSS + R.LOSS_STEP * (G.streak[loser] - 1), R.LOSS_MAX)
  if (loser === TEAM.ATT && G.plantedThisRound) loss += R.PLANTED_LOSS_BONUS
  for (const p of players.values()) {
    const s = p.state
    if (!s.team) continue
    s.money += s.team === winner ? R.WIN : loss
    clampMoney(s)
    p.survived = !!s.alive
  }
  events.push({ k: 're', w: winner, why, s: [G.score[1], G.score[2]] })
  rosterDirty = true
}

function nextRound() {
  const lead = G.score[1] >= R.WIN_ROUNDS ? 1 : G.score[2] >= R.WIN_ROUNDS ? 2 : 0
  if (lead || G.round >= R.MAX_ROUNDS) {
    const w = G.score[1] === G.score[2] ? 0 : G.score[1] > G.score[2] ? 1 : 2
    G.phase = 'over'
    G.phaseEnd = performance.now() + 8000
    events.push({ k: 'match', w, s: [G.score[1], G.score[2]] })
    return
  }
  if (G.round === R.HALF_ROUNDS) {
    // half time: swap sides, reset money and loadouts
    for (const p of players.values()) {
      const s = p.state
      if (s.team) s.team = 3 - s.team
      if (p.wantTeam) p.wantTeam = 3 - p.wantTeam
      s.money = R.START_MONEY
      p.survived = false
    }
    G.score = [0, G.score[2], G.score[1]]
    G.streak = [0, 0, 0]
    say('Half time - teams swap sides')
  }
  startRound()
}

function toDeathmatch(text) {
  G.mode = 0; G.phase = 'live'; G.bomb = null; world.bomb = null
  nades.length = 0
  smokes.length = 0
  for (const p of players.values()) { loadoutDM(p); p.wantTeam = 0; spawn(p) }
  events.push({ k: 'mode', m: 0 })
  if (text) say(text)
  rosterDirty = true
}

function dropBomb(s) {
  if (!G.bomb || G.bomb.st !== 1) return
  G.bomb.st = 2; G.bomb.carrier = 0
  G.bomb.x = s.x; G.bomb.z = s.z; G.bomb.y = floorY(s.x, s.y, s.z)
  s.bomb = 0
  events.push({ k: 'drop' })
}

function plant(p) {
  const s = p.state
  if (G.phase !== 'live' || !G.bomb || G.bomb.st !== 1 || G.bomb.carrier !== p.id) { s.act = 0; s.actT = 0; return }
  const site = MAP.sites.find((a) => s.x >= a.x0 && s.x <= a.x1 && s.z >= a.z0 && s.z <= a.z1)
  G.bomb = { st: 3, carrier: 0, x: s.x, y: s.y, z: s.z, explodeAt: performance.now() + R.BOMB_MS }
  world.bomb = { x: s.x, y: s.y, z: s.z }
  G.plantedThisRound = true
  s.bomb = 0; s.act = 0; s.actT = 0
  s.money += R.PLANT_BONUS; clampMoney(s)
  events.push({ k: 'planted', id: p.id, site: site ? site.name : '?' })
}

function defuse(p) {
  const s = p.state
  s.act = 0; s.actT = 0
  if (!G.bomb || G.bomb.st !== 3) return
  G.bomb.st = 4
  world.bomb = null
  s.money += R.DEFUSE_BONUS; clampMoney(s)
  events.push({ k: 'defused', id: p.id })
  if (G.phase === 'live') endRound(TEAM.DEF, 'defuse')
}

function explodeBomb() {
  const b = G.bomb
  b.st = 5
  world.bomb = null
  events.push({ k: 'boom', p: [b.x, b.y, b.z] })
  for (const p of all()) {
    const s = p.state
    if (!s.alive) continue
    const d = Math.hypot(s.x - b.x, s.y - b.y, s.z - b.z)
    if (d < R.BOMB_RADIUS) damage(p, R.BOMB_DMG * (1 - d / R.BOMB_RADIUS), null, -1, 'blast')
  }
  if (G.phase === 'live') endRound(TEAM.ATT, 'boom')
}

function tickBombMode(now) {
  if (G.phase === 'freeze') {
    if (now >= G.phaseEnd) {
      G.phase = 'live'; G.liveAt = now; G.phaseEnd = now + R.ROUND_MS
      for (const p of players.values()) p.state.frz = 0
      events.push({ k: 'go' })
    }
    return
  }
  const b = G.bomb
  if (b && b.st === 2 && G.phase === 'live') {
    for (const p of team(TEAM.ATT)) {
      const s = p.state
      if (s.alive && Math.hypot(s.x - b.x, s.z - b.z) < 40 && Math.abs(s.y - b.y) < 60) {
        b.st = 1; b.carrier = p.id; s.bomb = 1
        events.push({ k: 'pickup', id: p.id })
        break
      }
    }
  }
  if (b && b.st === 3 && now >= b.explodeAt) explodeBomb()

  if (G.phase === 'live') {
    if (!team(TEAM.ATT).length || !team(TEAM.DEF).length) { toDeathmatch('A team is empty - back to deathmatch'); return }
    const a = aliveOn(TEAM.ATT), d = aliveOn(TEAM.DEF)
    if (b.st === 3) { if (d === 0) endRound(TEAM.ATT, 'elim') }
    else if (b.st !== 4 && b.st !== 5) {
      if (a === 0) endRound(TEAM.DEF, 'elim')
      else if (d === 0) endRound(TEAM.ATT, 'elim')
      else if (now >= G.phaseEnd) endRound(TEAM.DEF, 'time')
    }
  } else if (G.phase === 'end') {
    if (now >= G.phaseEnd) nextRound()
  } else if (G.phase === 'over') {
    if (now >= G.phaseEnd) toDeathmatch('Match over - back to deathmatch')
  }
}

function buy(p, id) {
  const s = p.state
  const now = performance.now()
  if (G.mode !== 1 || !s.alive) return
  if (!(G.phase === 'freeze' || (G.phase === 'live' && now - G.liveAt < R.BUY_MS))) return
  const item = SHOP.find((i) => i.id === id)
  if (!item || (item.team && item.team !== s.team)) return
  let price = item.price
  if (item.w !== undefined) {
    const W = WEAPONS[item.w]
    if (W.nade) {
      if (s.ammo[item.w] >= W.max || s.money < price) return
      s.ammo[item.w]++
      s.own |= 1 << item.w
    } else {
      if ((s.own >> item.w) & 1 || s.money < price) return
      s.own = (s.own & ~0b11100) | (1 << item.w) // one primary at a time
      s.ammo[item.w] = W.mag
      s.w = item.w; s.drawEnd = s.tick + W.draw; s.reloadEnd = 0; s.zoom = 0; s.shots = 0
    }
  } else if (id === 'armor') {
    if (s.armor >= 100 || s.money < price) return
    s.armor = 100
  } else if (id === 'helmet') {
    if (s.armor >= 100 && s.helmet) return
    if (s.armor >= 100) price = 350
    if (s.money < price) return
    s.armor = 100; s.helmet = 1
  } else if (id === 'kit') {
    if (s.kit || s.money < price) return
    s.kit = 1
  } else return
  s.money -= price
  send(p, { t: 'bought', id })
}

// ---------- combat ----------
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

/** Apply damage. attacker may be null (bomb). w is a weapon index or -1 for the bomb. */
function damage(victim, raw, attacker, w, part, at) {
  const s = victim.state
  if (!s.alive || !(raw > 0)) return
  let dmg = raw
  const pen = w >= 0 ? WEAPONS[w].armorPen : 0.5
  if (s.armor > 0 && (part === 'body' || part === 'blast' || (part === 'head' && s.helmet))) {
    const through = dmg * pen
    s.armor = Math.max(0, s.armor - (dmg - through) * 0.5)
    dmg = through
  }
  dmg = Math.max(1, Math.round(dmg))
  s.hp -= dmg
  const head = part === 'head'
  if (attacker && attacker !== victim && part !== 'blast') { s.vx *= MOVE.TAG; s.vz *= MOVE.TAG }
  events.push({ k: 'hit', a: attacker ? attacker.id : 0, v: victim.id, dmg, head, p: at || [s.x, s.y + 40, s.z] })
  if (victim.bot && attacker && attacker !== victim) alertBot(victim, attacker.state, 2500)
  if (s.hp > 0) return
  s.hp = 0; s.alive = 0; s.zoom = 0; s.act = 0; s.actT = 0
  victim.deaths++
  if (attacker && attacker !== victim) {
    attacker.kills++
    if (G.mode === 1) { attacker.state.money += R.KILL; clampMoney(attacker.state) }
  }
  if (s.bomb) dropBomb(s)
  if (G.mode === 0) victim.respawnAt = performance.now() + RESPAWN
  events.push({ k: 'kill', a: attacker ? attacker.id : 0, v: victim.id, w, head })
  rosterDirty = true
}

const hostile = (a, b) => a !== b && b.state.alive && (!a.state.team || a.state.team !== b.state.team)

/** A bot turns toward something it heard or felt. */
function alertBot(p, src, ms) {
  const now = performance.now()
  p.bot.alertYaw = Math.atan2(-(src.x - p.state.x), -(src.z - p.state.z))
  p.bot.alertUntil = now + ms
}

function handleFire(shooter, e) {
  const W = WEAPONS[e.w]
  if (e.w !== 0) {
    for (const o of players.values()) {
      if (o.bot && hostile(shooter, o) && Math.hypot(o.state.x - e.ox, o.state.z - e.oz) < 1100) alertBot(o, shooter.state, 1500)
    }
  }
  const wall = rayWorld(MAP.boxes, e.ox, e.oy, e.oz, e.dx, e.dy, e.dz, W.range)
  // bullets pass through thin cover at half damage (wood is easier than concrete or steel)
  let penFrom = Infinity, penTo = 0
  if (wall.hit && W.pen > 0) {
    const mat = wall.box.mat || ''
    const limit = W.pen * (mat === 'crate' ? 2 : mat.startsWith('metal') ? 0.5 : 1)
    if (wall.exit - wall.t <= limit) {
      penFrom = wall.exit
      const ex = wall.exit + 0.1
      const next = rayWorld(MAP.boxes, e.ox + e.dx * ex, e.oy + e.dy * ex, e.oz + e.dz * ex, e.dx, e.dy, e.dz, W.range - ex)
      penTo = ex + next.t
    }
  }
  let best = null, victim = null
  for (const o of players.values()) {
    if (!hostile(shooter, o)) continue
    const pos = rewind(o, shooter.view[o.id])
    const r = rayPlayer(e.ox, e.oy, e.oz, e.dx, e.dy, e.dz, pos.x, pos.y, pos.z, pos.duck, W.range)
    if (!r) continue
    const direct = r.t < wall.t
    if (!direct && !(r.t > penFrom && r.t < penTo)) continue
    if (!best || r.t < best.t) { best = r; best.direct = direct; victim = o }
  }
  const tv = best && best.direct ? best.t : wall.t
  const end = [e.ox + e.dx * tv, e.oy + e.dy * tv, e.oz + e.dz * tv]
  if (e.w !== 0 || best) {
    events.push({ k: 'shot', id: shooter.id, w: e.w, o: [e.ox, e.oy, e.oz], h: end, n: (best && best.direct) || !wall.hit ? null : [wall.nx, wall.ny, wall.nz] })
  }
  if (!best) return
  const dmg = W.dmg * DMG_MUL[best.part] * Math.pow(W.falloff, best.t / 500) * (best.direct ? 1 : 0.5)
  damage(victim, dmg, shooter, e.w, best.part, [e.ox + e.dx * best.t, e.oy + e.dy * best.t, e.oz + e.dz * best.t])
}

function throwNade(p, e) {
  nades.push({ w: e.w, owner: p.id, team: p.state.team, x: e.ox, y: e.oy, z: e.oz, vx: e.vx, vy: e.vy, vz: e.vz, at: performance.now(), acc: 0 })
  events.push({ k: 'throw', id: p.id, w: e.w, o: [e.ox, e.oy, e.oz], v: [e.vx, e.vy, e.vz] })
}

function detonate(n) {
  const W = WEAPONS[n.w]
  events.push({ k: 'nade', w: n.w, id: n.owner, p: [n.x, n.y, n.z] })
  if (W.id === 'smoke') smokes.push({ x: n.x, z: n.z, until: performance.now() + SMOKE_MS })
  const owner = players.get(n.owner)
  if (W.id === 'he') {
    for (const p of all()) {
      const s = p.state
      if (!s.alive) continue
      if (p !== owner && n.team && p.state.team === n.team) continue // no team damage
      const d = Math.hypot(s.x - n.x, s.y + 36 - n.y, s.z - n.z)
      if (d >= W.radius) continue
      const open = lineOfSight(MAP.boxes, n.x, n.y + 4, n.z, s.x, s.y + 40, s.z)
      damage(p, W.dmg * (1 - d / W.radius) * (open ? 1 : 0.25), owner || null, n.w, 'blast')
    }
  } else if (W.id === 'flash') {
    for (const p of all()) {
      const s = p.state
      if (!s.alive) continue
      const ex = s.x, ey = s.y + eyeHeight(s), ez = s.z
      const dx = n.x - ex, dy = n.y + 4 - ey, dz = n.z - ez
      const d = Math.hypot(dx, dy, dz)
      if (d > 1500 || !lineOfSight(MAP.boxes, n.x, n.y + 4, n.z, ex, ey, ez)) continue
      const cp = Math.cos(s.pitch)
      const facing = d < 1 ? 1 : (-Math.sin(s.yaw) * cp * dx + Math.sin(s.pitch) * dy - Math.cos(s.yaw) * cp * dz) / d
      const dur = 4.5 * (1 - d / 1500) * (facing > 0.5 ? 1 : facing > 0 ? 0.55 : 0.25)
      if (dur > 0.3) { if (p.bot) p.bot.blindUntil = performance.now() + dur * 1000; else send(p, { t: 'flash', d: dur }) }
    }
  }
}

function tickNades(now, dtMs) {
  for (let i = nades.length - 1; i >= 0; i--) {
    const n = nades[i]
    n.acc += dtMs
    while (n.acc >= 1000 / TICK) { n.acc -= 1000 / TICK; stepNade(n, staticWorld, 1 / TICK) }
    if (now - n.at >= WEAPONS[n.w].fuse) { detonate(n); nades.splice(i, 1) }
  }
}

// ---------- connections ----------
function setDyn(self) {
  world.dyn.length = 0
  for (const o of players.values()) {
    const s = o.state
    if (o === self || !s.alive) continue
    world.dyn.push({ x0: s.x - 16, x1: s.x + 16, y0: s.y, y1: s.y + (s.duck ? 54 : 72), z0: s.z - 16, z1: s.z + 16 })
  }
}

/** Simulate one command for a player and act on what it produced. Used for humans and bots alike. */
function runCmd(p, cmd) {
  const s = p.state
  const ev = []
  setDyn(p)
  step(s, cmd, world, ev)
  record(p)
  for (const e of ev) {
    if (e.k === 'fire') handleFire(p, e)
    else if (e.k === 'reload') events.push({ k: 'reload', id: p.id })
    else if (e.k === 'throw') throwNade(p, e)
    else if (e.k === 'act') events.push({ k: 'act', id: p.id, a: e.a })
  }
  if (G.mode === 1) {
    if (s.act === 1 && s.actT >= R.PLANT_TICKS) plant(p)
    else if (s.act === 2 && s.actT >= (s.kit ? R.DEFUSE_KIT_TICKS : R.DEFUSE_TICKS)) defuse(p)
  }
}

function newPlayer(ws, name, bot) {
  const p = {
    id: nextId++, ws, name, kills: 0, deaths: 0, state: createState(), lastSeq: 0, hist: [], view: {},
    credit: 16, creditT: performance.now(), respawnAt: 0, wantTeam: 0, survived: false, slot: 0, bot,
  }
  players.set(p.id, p)
  if (G.mode === 0) { loadoutDM(p); spawn(p) }
  else {
    // joining mid-match: go to the smaller team and wait for the next round
    p.state.team = team(TEAM.ATT).length <= team(TEAM.DEF).length ? TEAM.ATT : TEAM.DEF
    p.state.money = R.START_MONEY
    loadoutPistol(p)
    if (G.phase === 'freeze') {
      // still buy time: join this round
      p.slot = team(p.state.team).length - 1
      spawn(p)
      p.state.frz = 1
    } else record(p)
  }
  rosterDirty = true
  return p
}

/** Team sizes once everyone's pending switch has happened. */
function plannedSizes() {
  const n = [0, 0, 0]
  for (const o of players.values()) n[o.wantTeam || o.state.team]++
  return n
}
/** Reason a switch to team `to` would break the match, or '' if it is fine. */
function switchBlocked(p, to) {
  const n = plannedSizes()
  const from = p.wantTeam || p.state.team
  n[from]--; n[to]++
  if (n[from] === 0) return 'You are the last one on your team, so you cannot switch.'
  if (n[to] - n[from] > 1) return 'That would make the teams uneven.'
  return ''
}

const botList = () => all().filter((p) => p.bot)
function removeBotAny() {
  const p = botList().pop()
  if (!p) return
  if (p.state.bomb) dropBomb(p.state)
  players.delete(p.id)
  rosterDirty = true
  say(`${p.name} left to make room`)
}
function addBot(by) {
  if (players.size >= MAX_PLAYERS) { say('The server is full.', by); return }
  const used = new Set(all().map((p) => p.name))
  const name = 'Bot ' + (BOT_NAMES.find((n) => !used.has('Bot ' + n)) || nextId)
  newPlayer({ readyState: 0, send() {} }, name, createBotState(botSkill))
  say(`${name} joined (${SKILLS[botSkill]})`)
}
function removeBot() {
  const bots = botList()
  let p = bots[bots.length - 1]
  if (G.mode === 1) {
    // take from the bigger team, and never empty a team
    const n = [0, team(1).length, team(2).length]
    p = bots.filter((b) => n[b.state.team] > 1).sort((a, b) => n[b.state.team] - n[a.state.team])[0]
  }
  if (!p) return
  if (p.state.bomb) dropBomb(p.state)
  players.delete(p.id)
  rosterDirty = true
  say(`${p.name} left`)
}

wss.on('connection', (ws) => {
  ws._socket?.setNoDelay(true)
  let p = null
  ws.on('message', (raw) => {
    let m
    try { m = JSON.parse(raw) } catch { return }
    if (!m || typeof m !== 'object') return
    if (m.t === 'j' && !p) {
      if (players.size >= MAX_PLAYERS) {
        // a bot gives up its slot for a person
        if (botList().length) removeBotAny()
        else { ws.send(JSON.stringify({ t: 'full' })); ws.close(); return }
      }
      const name = String(m.name || 'Player').replace(/[^\w \-]/g, '').slice(0, 16) || 'Player'
      p = newPlayer(ws, name, null)
      ws.send(JSON.stringify({ t: 'w', id: p.id, map: MAP.name }))
      console.log(`+ ${name} joined (${players.size} online)`)
    } else if (!p) {
      return
    } else if (m.t === 'c' && Array.isArray(m.c)) {
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
        const yaw = Number.isFinite(+c[2]) ? +c[2] % (Math.PI * 2) : 0
        const pitch = Number.isFinite(+c[3]) ? Math.min(Math.max(+c[3], -1.56), 1.56) : 0
        runCmd(p, { b: c[1] | 0, yaw, pitch, sel: c[4] | 0 })
      }
    } else if (m.t === 'buy') {
      buy(p, String(m.id))
    } else if (m.t === 'mode') {
      if (m.m === 1 && G.mode === 0) startMatch(p)
      else if (m.m === 0 && G.mode === 1) toDeathmatch(`${p.name} ended the match`)
    } else if (m.t === 'team') {
      if (G.mode !== 1) return
      if (p.wantTeam) { p.wantTeam = 0; say('Team switch cancelled.', p); rosterDirty = true; return }
      const why = switchBlocked(p, 3 - p.state.team)
      if (why) { say(why, p); return }
      p.wantTeam = 3 - p.state.team
      say('You will switch teams next round.', p)
      rosterDirty = true
    } else if (m.t === 'bot') {
      if (m.op === 'add') addBot(p)
      else if (m.op === 'remove') removeBot()
      else if (m.op === 'skill') {
        botSkill = Math.max(0, Math.min(2, m.v | 0))
        for (const b of botList()) b.bot.skill = botSkill
        say(`Bot difficulty: ${SKILLS[botSkill]}`)
      }
    } else if (m.t === 'p') {
      ws.send(JSON.stringify({ t: 'p', c: m.c }))
    }
  })
  ws.on('close', () => {
    if (!p) return
    if (p.state.bomb) dropBomb(p.state)
    players.delete(p.id)
    rosterDirty = true
    console.log(`- ${p.name} left (${players.size} online)`)
    // nobody left to play with: bots go back to idling in deathmatch
    if (G.mode === 1 && !all().some((o) => !o.bot)) toDeathmatch()
  })
  ws.on('error', () => {})
})

// ---------- main loop ----------
const r2 = (v) => Math.round(v * 100) / 100
const r4 = (v) => Math.round(v * 10000) / 10000
let lastLoop = performance.now()

setInterval(() => {
  const now = performance.now()
  const dtMs = Math.min(now - lastLoop, 100)
  lastLoop = now
  if (G.mode === 0) {
    for (const p of players.values()) if (!p.state.alive && p.respawnAt && now >= p.respawnAt) { loadoutDM(p); spawn(p) }
  } else tickBombMode(now)
  tickNades(now, dtMs)
  for (let i = smokes.length - 1; i >= 0; i--) if (now >= smokes[i].until) smokes.splice(i, 1)

  // bots think once per loop, then run as many simulation ticks as real time has advanced
  const everyone = all()
  if (everyone.some((p) => p.bot) && everyone.some((p) => !p.bot)) {
    botAcc += dtMs
    let n = Math.floor(botAcc / (1000 / TICK))
    botAcc -= n * (1000 / TICK)
    if (n > 8) n = 8
    if (n > 0) {
      const ctx = { now, dt: dtMs / 1000, players: everyone, byId: players, G, boxes: MAP.boxes, sites: MAP.sites, nav, intel, smokes, roam: MAP.spawns.dm }
      for (const p of everyone) {
        if (!p.bot) continue
        const c = think(p.bot, p, ctx)
        if (p.bot.wantBuy.length) { for (const id of p.bot.wantBuy) buy(p, id); p.bot.wantBuy.length = 0 }
        for (let i = 0; i < n; i++) { runCmd(p, c); c.sel = -1 }
      }
    }
  } else botAcc = 0

  if (rosterDirty) { events.push(roster()); rosterDirty = false }
  const list = all()
  const pub = list.map((p) => {
    const s = p.state
    return [p.id, s.tick, r2(s.x), r2(s.y), r2(s.z), r4(s.yaw), r4(s.pitch),
      (s.alive ? 1 : 0) | (s.duck ? 2 : 0) | (s.ground ? 4 : 0), s.w, s.tp, s.team]
  })
  const b = G.bomb
  const canBuyPhase = G.mode === 1 && (G.phase === 'freeze' || (G.phase === 'live' && now - G.liveAt < R.BUY_MS))
  const g = {
    m: G.mode, ph: G.phase, r: G.round, bs: botSkill, s: [G.score[1], G.score[2]], al: [aliveOn(TEAM.ATT), aliveOn(TEAM.DEF)],
    t: G.mode === 1 && (G.phase === 'freeze' || G.phase === 'live') ? Math.max(0, G.phaseEnd - now) : 0,
  }
  for (const p of list) {
    if (p.ws.readyState !== 1) continue
    const s = p.state
    let bomb = null
    if (b && b.st >= 3) bomb = [b.st, r2(b.x), r2(b.y), r2(b.z), 0, b.st === 3 ? Math.max(0, b.explodeAt - now) : 0]
    else if (b && b.st && s.team === TEAM.ATT) {
      const c = players.get(b.carrier)
      bomb = b.st === 1 && c ? [1, r2(c.state.x), r2(c.state.y), r2(c.state.z), b.carrier, 0] : [b.st, r2(b.x), r2(b.y), r2(b.z), 0, 0]
    }
    p.ws.send(JSON.stringify({
      t: 's', a: p.lastSeq, me: serialize(s), p: pub.filter((x) => x[0] !== p.id), e: events,
      r: s.alive ? 0 : Math.max(0, p.respawnAt - now),
      g: { ...g, b: bomb, buy: canBuyPhase && s.alive ? 1 : 0 },
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
