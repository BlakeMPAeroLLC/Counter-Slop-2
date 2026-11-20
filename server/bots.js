// Server-side bots. A bot is an ordinary player whose commands come from think()
// instead of a network connection, so it obeys exactly the same movement, recoil and
// accuracy rules as a human.
import { BTN, TEAM, WEAPONS, RULES } from '../shared/constants.js'
import { hullBlocked, lineOfSight } from '../shared/physics.js'
import { recoilPattern, eyeHeight, siteAt, bestWeapon } from '../shared/sim.js'

const CELL = 32
const D2R = Math.PI / 180
const rnd = (a, b) => a + Math.random() * (b - a)
const angNorm = (a) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2

export const SKILLS = ['Easy', 'Normal', 'Hard']
export const BOT_NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India']
// react: ms before shooting a newly seen enemy. turn: max aim speed (rad/s). snap: how
// eagerly the aim closes in. err: aim error (degrees). comp: share of recoil compensated.
// head: chance to go for the head.
const SKILL = [
  { react: 560, turn: 3.2, snap: 5, err: 5, comp: 0.25, head: 0 },
  { react: 340, turn: 6, snap: 9, err: 2.4, comp: 0.55, head: 0.12 },
  { react: 210, turn: 10, snap: 15, err: 1.0, comp: 0.85, head: 0.4 },
]
// where a bot holding or guarding a site looks: main entrance first, then the two doors
const WATCH = { A: [[-1050, -380], [-480, -570], [-480, -1075]], B: [[1050, -380], [480, -570], [480, -1075]] }
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

/** Walkable grid for the ground level of the map, with cached distance fields for pathfinding. */
export function buildNav(MAP) {
  const N = Math.ceil((MAP.size * 2) / CELL)
  const w = { boxes: MAP.boxes }
  const free = new Uint8Array(N * N)
  const pos = (i) => -MAP.size + (i + 0.5) * CELL
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) free[j * N + i] = hullBlocked(w, pos(i), 0.05, pos(j), 16, 72) ? 0 : 1
  const fields = new Map()
  const cell = (v) => Math.floor((v + MAP.size) / CELL)

  /** Index of the free cell at or nearest to (x, z); -1 if none is close. */
  function nearest(x, z) {
    const ci = cell(x), cj = cell(z)
    let best = -1, bd = Infinity
    for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) {
      const i = ci + di, j = cj + dj
      if (i < 0 || j < 0 || i >= N || j >= N || !free[j * N + i]) continue
      const d = (pos(i) - x) ** 2 + (pos(j) - z) ** 2
      if (d < bd) { bd = d; best = j * N + i }
    }
    return best
  }

  /** Steps to cell t from every other cell (breadth-first flood). */
  function field(t) {
    let f = fields.get(t)
    if (f) return f
    f = new Int16Array(N * N).fill(-1)
    const q = new Int32Array(N * N)
    let h = 0, n = 0
    f[t] = 0; q[n++] = t
    while (h < n) {
      const c = q[h++], i = c % N, j = (c - i) / N, d = f[c] + 1
      if (i > 0 && free[c - 1] && f[c - 1] < 0) { f[c - 1] = d; q[n++] = c - 1 }
      if (i < N - 1 && free[c + 1] && f[c + 1] < 0) { f[c + 1] = d; q[n++] = c + 1 }
      if (j > 0 && free[c - N] && f[c - N] < 0) { f[c - N] = d; q[n++] = c - N }
      if (j < N - 1 && free[c + N] && f[c + N] < 0) { f[c + N] = d; q[n++] = c + N }
    }
    if (fields.size > 96) fields.delete(fields.keys().next().value)
    fields.set(t, f)
    return f
  }

  /** Can a standing player walk the straight line a -> b? */
  function walk(ax, az, bx, bz) {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 14))
    for (let k = 1; k <= n; k++) {
      const t = k / n
      if (hullBlocked(w, ax + (bx - ax) * t, 0.05, az + (bz - az) * t, 16, 72)) return false
    }
    return true
  }

  /**
   * Which way to walk from (x, z) to get to (tx, tz).
   * Returns { dx, dz, dist } (unit direction, straight-line distance left) or null if unreachable.
   */
  function steer(x, z, tx, tz) {
    const c = nearest(x, z), t = nearest(tx, tz)
    if (c < 0 || t < 0) return null
    let gx = tx, gz = tz
    if (c !== t) {
      const f = field(t)
      if (f[c] < 0) return null
      // follow the field downhill a few cells, then aim at the furthest one in a straight walkable line
      let cur = c
      const chain = []
      for (let k = 0; k < 8 && cur !== t; k++) {
        const i = cur % N, j = (cur - i) / N
        let best = cur, bd = f[cur]
        for (const [di, dj] of DIRS) {
          const a = i + di, b = j + dj
          if (a < 0 || b < 0 || a >= N || b >= N) continue
          const o = b * N + a
          if (!free[o] || f[o] < 0 || f[o] >= bd) continue
          if (di && dj && (!free[j * N + a] || !free[b * N + i])) continue // no cutting corners
          best = o; bd = f[o]
        }
        if (best === cur) break
        cur = best; chain.push(cur)
      }
      if (!chain.length) return null
      let pick = chain[0]
      for (let k = chain.length - 1; k > 0; k--) {
        const o = chain[k]
        if (walk(x, z, pos(o % N), pos(Math.floor(o / N)))) { pick = o; break }
      }
      if (!(pick === t && walk(x, z, tx, tz))) { gx = pos(pick % N); gz = pos(Math.floor(pick / N)) }
    }
    const dx = gx - x, dz = gz - z, d = Math.hypot(dx, dz)
    return { dx: d > 0 ? dx / d : 0, dz: d > 0 ? dz / d : 0, dist: Math.hypot(tx - x, tz - z) }
  }

  /** A random standable point inside a rectangle, or null. */
  function randomIn(x0, z0, x1, z1) {
    for (let k = 0; k < 40; k++) {
      const i = cell(rnd(x0, x1)), j = cell(rnd(z0, z1))
      if (i >= 0 && j >= 0 && i < N && j < N && free[j * N + i]) return { x: pos(i), z: pos(j) }
    }
    return null
  }

  return { steer, walk, randomIn, nearest }
}

export function createBotState(skill) {
  return {
    skill, aimYaw: 0, aimPitch: 0, tp: -1,
    target: 0, reactAt: 0, lastSeen: null, head: false,
    errY: 0, errP: 0, errUntil: 0, burstUntil: 0, pauseUntil: 0, strafe: 1,
    spot: null, spotUntil: 0, spotSite: -1, holdSite: 0, rotateAt: 0, watchK: 0, watchUntil: 0,
    stuckAt: 0, stuckX: 0, stuckZ: 0, unstuckUntil: 0, unDir: 0, jumpNext: false, climbUntil: 0, reachUntil: 0, reachPhase: 1, reachAng: 0,
    alertYaw: 0, alertUntil: 0, blindUntil: 0,
    boughtRound: -1, wantBuy: [],
  }
}

const inBox = (b, x, z, m = 0) => x >= b.x0 - m && x <= b.x1 + m && z >= b.z0 - m && z <= b.z1 + m
const clampIn = (v, a, b) => Math.min(Math.max(v, a), b)

/**
 * How to get up to something at height t.y standing on a crate or ledge. Returns the point to
 * land on and a point to take a run-up from, or null. If the object is too high for one
 * crouch-jump (about 62 units), it uses a lower box beside it as a step.
 */
export function climbPlan(boxes, fromY, t) {
  const support = boxes.find((b) => b.y0 < 1 && Math.abs(b.y1 - t.y) < 3 && inBox(b, t.x, t.z, 1))
  if (!support) return null
  const plan = (b, aim) => {
    // land on box b as close to `aim` as possible; run up from outside, straight across an edge,
    // along a line with room to spare on both sides
    const px = clampIn(aim.x, b.x0 + 18, b.x1 - 18), pz = clampIn(aim.z, b.z0 + 18, b.z1 - 18)
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2
    let best = null, bd = Infinity
    for (const f of [0, 0.5, 1]) {
      const x = px + (cx - px) * f, z = pz + (cz - pz) * f
      for (const [ex, ez, nx, nz] of [[b.x0 - 1, z, -1, 0], [b.x1 + 1, z, 1, 0], [x, b.z0 - 1, 0, -1], [x, b.z1 + 1, 0, 1]]) {
        const rx = ex + nx * 90, rz = ez + nz * 90
        let clear = true
        for (let k = 0; k <= 8 && clear; k++) {
          const qx = rx + (ex - rx) * k / 8, qz = rz + (ez - rz) * k / 8
          if (boxes.some((o) => o !== b && o.y1 > fromY + 18 && o.y0 < fromY + 72 && inBox(o, qx, qz, 22))) clear = false
        }
        if (!clear) continue
        const d = Math.hypot(x - aim.x, z - aim.z) * 2 + Math.hypot(rx - aim.x, rz - aim.z) * 0.1
        if (d < bd) { bd = d; best = { runX: rx, runZ: rz, x, z } }
      }
    }
    return best
  }
  if (support.y1 - fromY <= 60) return plan(support, t)
  // too tall: find a step next to it that is low enough to jump on and high enough to reach from
  for (const b of boxes) {
    if (b === support || b.y0 > 1 || b.y1 - fromY > 60 || b.y1 - fromY < 20 || support.y1 - b.y1 > 44) continue
    const touching = b.x0 <= support.x1 + 4 && b.x1 >= support.x0 - 4 && b.z0 <= support.z1 + 4 && b.z1 >= support.z0 - 4
    if (touching) { const p = plan(b, t); if (p) return p }
  }
  return null
}

/** True if a smoke cloud sits on the sight line a -> b (top-down test). */
function smoked(smokes, ax, az, bx, bz) {
  for (const s of smokes) {
    const dx = bx - ax, dz = bz - az
    const L2 = dx * dx + dz * dz
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((s.x - ax) * dx + (s.z - az) * dz) / L2)) : 0
    if (Math.hypot(ax + dx * t - s.x, az + dz * t - s.z) < 115) return true
  }
  return false
}

function watchPoint(bot, now, name) {
  const w = WATCH[name]
  if (!w) return null
  if (now > bot.watchUntil) {
    bot.watchK = Math.random() < 0.6 ? 0 : 1 + Math.floor(Math.random() * 2)
    bot.watchUntil = now + rnd(3500, 7000)
  }
  return w[bot.watchK]
}

/** Decide what to buy this round; the server carries the purchases out. */
function buyPlan(bot, s, round) {
  if (bot.boughtRound === round) return
  bot.boughtRound = round
  let m = s.money
  const spend = (id, price) => { if (m < price) return false; m -= price; bot.wantBuy.push(id); return true }
  if (!(s.own & 0b11100)) {
    if (m >= 2700 + (s.armor >= 100 ? 0 : 650)) spend('rifle', 2700)
    else if (m >= 1900) spend('smg', 1250)
  }
  if (s.armor < 100) { if (!spend('helmet', 1000)) spend('armor', 650) }
  if (s.team === TEAM.DEF && !s.kit) spend('kit', 400)
}

/**
 * One decision for one bot. Returns the command { b, yaw, pitch, sel } to simulate.
 * ctx: { now, dt, players, byId, G, boxes, sites, nav, intel, smokes }
 */
export function think(bot, me, ctx) {
  const s = me.state, now = ctx.now, K = SKILL[bot.skill], nav = ctx.nav, G = ctx.G
  const cmd = { b: 0, yaw: bot.aimYaw, pitch: bot.aimPitch, sel: -1 }
  if (!s.alive) return cmd
  if (bot.tp !== s.tp) {
    // just (re)spawned
    bot.tp = s.tp; bot.aimYaw = s.spawnYaw; bot.aimPitch = 0
    bot.target = 0; bot.lastSeen = null; bot.spot = null; bot.spotSite = -1
    bot.stuckAt = now; bot.stuckX = s.x; bot.stuckZ = s.z
  }
  const ex = s.x, ey = s.y + eyeHeight(s), ez = s.z

  // ---- perception: nearest visible enemy, limited to roughly what a player could see
  let tgt = null, td = Infinity
  if (now >= bot.blindUntil) {
    const cp = Math.cos(bot.aimPitch)
    const fx = -Math.sin(bot.aimYaw) * cp, fy = Math.sin(bot.aimPitch), fz = -Math.cos(bot.aimYaw) * cp
    for (const o of ctx.players) {
      const t = o.state
      if (o === me || !t.alive || (s.team && s.team === t.team)) continue
      const dx = t.x - ex, dy = t.y + 46 - ey, dz = t.z - ez
      const d = Math.hypot(dx, dy, dz)
      if (d > 3200 || d >= td) continue
      const facing = (dx * fx + dy * fy + dz * fz) / (d || 1)
      if (facing < 0.1 && d > 260 && o.id !== bot.target && now > bot.alertUntil) continue
      if (smoked(ctx.smokes, ex, ez, t.x, t.z)) continue
      if (!lineOfSight(ctx.boxes, ex, ey, ez, t.x, t.y + (t.duck ? 34 : 46), t.z) &&
          !lineOfSight(ctx.boxes, ex, ey, ez, t.x, t.y + (t.duck ? 48 : 66), t.z)) continue
      tgt = o; td = d
    }
  }
  if (tgt) {
    if (bot.target !== tgt.id) {
      bot.target = tgt.id
      bot.reactAt = now + K.react * rnd(0.8, 1.25) * (now < bot.alertUntil ? 0.6 : 1)
    }
    bot.lastSeen = { x: tgt.state.x, z: tgt.state.z, t: now }
    ctx.intel[s.team] = bot.lastSeen
  } else bot.target = 0

  // ---- objective: where to go, whether to hold E, where to look when idle
  let goal = null, use = false, face = null, reach = null, direct = null
  if (G.mode === 1 && G.bomb && (G.phase === 'live' || G.phase === 'freeze')) {
    const b = G.bomb
    if (G.phase === 'freeze') buyPlan(bot, s, G.round)
    if (s.team === TEAM.ATT) {
      if (b.st === 3) {
        // planted: guard it from somewhere nearby
        if (!bot.spot || now > bot.spotUntil) {
          bot.spot = nav.randomIn(b.x - 300, b.z - 300, b.x + 300, b.z + 300)
          bot.spotUntil = now + rnd(7000, 13000)
        }
        goal = bot.spot
        face = watchPoint(bot, now, b.x < 0 ? 'A' : 'B')
      } else if (s.bomb) {
        const site = ctx.sites[G.botSite]
        if (!bot.spot || bot.spotSite !== G.botSite) {
          bot.spot = nav.randomIn(site.x0 + 40, site.z0 + 40, site.x1 - 40, site.z1 - 40)
          bot.spotSite = G.botSite
        }
        goal = bot.spot
        const there = bot.spot && siteAt(ctx.sites, s.x, s.z) >= 0 && Math.hypot(bot.spot.x - s.x, bot.spot.z - s.z) < 60
        if (there && (!tgt || s.actT > RULES.PLANT_TICKS * 0.5)) use = true
      } else if (b.st === 2) {
        goal = { x: b.x, z: b.z }
        const hd = Math.hypot(b.x - s.x, b.z - s.z)
        if (b.y - s.y > 30 && hd < 300) reach = b
        else if (b.y > 20 && Math.abs(b.y - s.y) < 30 && hd < 160) direct = b
      } else {
        const c = ctx.byId.get(b.carrier)
        if (c && !c.bot) {
          // a human has the bomb: stay close and let them choose the site
          if (Math.hypot(c.state.x - s.x, c.state.z - s.z) > 170) goal = { x: c.state.x, z: c.state.z }
        } else {
          const site = ctx.sites[G.botSite]
          if (!bot.spot || bot.spotSite !== G.botSite) {
            bot.spot = nav.randomIn(site.x0 - 100, site.z0 - 100, site.x1 + 100, site.z1 + 100)
            bot.spotSite = G.botSite
          }
          goal = bot.spot
          face = watchPoint(bot, now, site.name)
        }
      }
    } else if (s.team === TEAM.DEF) {
      if (b.st === 3) {
        goal = { x: b.x, z: b.z }
        const total = s.kit ? RULES.DEFUSE_KIT_TICKS : RULES.DEFUSE_TICKS
        const need = (total - s.actT) / total * (s.kit ? 5000 : 10000)
        const hd = Math.hypot(b.x - s.x, b.z - s.z)
        const inRange = s.ground && hd < RULES.DEFUSE_RANGE - 10 && Math.abs(b.y - s.y) < 44
        // fight first unless the clock says there is no time for that
        if (inRange) { if (!tgt || b.explodeAt - now < need + 3500) use = true }
        else if (b.y - s.y > 30 && hd < 300) reach = b // it is up on something: climb first
        else if (b.y > 20 && Math.abs(b.y - s.y) < 30 && hd < 160) direct = b // up there with it: walk over carefully
      } else {
        const intel = ctx.intel[TEAM.DEF]
        if (intel && now - intel.t < 4000 && now > bot.rotateAt) {
          const k = intel.x < 0 ? 0 : 1
          if (k !== bot.holdSite && Math.abs(intel.x) > 450 && intel.z < -300 && Math.random() < 0.6) { bot.holdSite = k; bot.spot = null }
          bot.rotateAt = now + 6000
        }
        const site = ctx.sites[bot.holdSite % ctx.sites.length]
        if (!bot.spot || now > bot.spotUntil) {
          bot.spot = nav.randomIn(site.x0 - 100, site.z0 - 100, site.x1 + 100, site.z1 + 100)
          bot.spotUntil = now + rnd(9000, 16000)
        }
        goal = bot.spot
        face = watchPoint(bot, now, site.name)
      }
    }
  } else {
    // deathmatch / between rounds: roam, or chase the last place an enemy was seen
    if (bot.lastSeen && now - bot.lastSeen.t < 5000) goal = bot.lastSeen
    else {
      if (!bot.spot || now > bot.spotUntil || Math.hypot(bot.spot.x - s.x, bot.spot.z - s.z) < 60) {
        const list = ctx.roam
        bot.spot = list[Math.floor(Math.random() * list.length)]
        bot.spotUntil = now + 25000
      }
      goal = bot.spot
    }
  }

  // ---- aim + fire
  const W = WEAPONS[s.w]
  let wantYaw = bot.aimYaw, wantPitch = 0, fire = false
  let mx = 0, mz = 0, moving = false
  if (tgt) {
    const t = tgt.state
    if (now > bot.errUntil) {
      const sp = Math.hypot(t.vx, t.vz) + Math.hypot(s.vx, s.vz) * 0.5
      const e = K.err * (1 + sp / 300) * D2R
      bot.errY = (Math.random() + Math.random() - 1) * e
      bot.errP = (Math.random() + Math.random() - 1) * e * 0.7
      bot.errUntil = now + rnd(250, 600)
      bot.head = Math.random() < K.head
    }
    const ay = t.y + (bot.head ? (t.duck ? 47 : 65) : (t.duck ? 32 : 46))
    const dx = t.x - ex, dz = t.z - ez, dh = Math.hypot(dx, dz)
    const trueYaw = Math.atan2(-dx, -dz)
    const pat = W.nade ? [0, 0] : recoilPattern(W, s.shots)
    wantYaw = trueYaw + bot.errY - pat[1] * D2R * K.comp
    wantPitch = Math.atan2(ay - ey, dh) + bot.errP - pat[0] * D2R * K.comp
    const off = Math.hypot(angNorm(wantYaw - bot.aimYaw), wantPitch - bot.aimPitch)
    const cone = Math.min(12 * D2R, Math.max(1.2 * D2R, Math.atan(16 / Math.max(dh, 1))))
    if (now >= bot.pauseUntil) {
      bot.burstUntil = now + rnd(260, 460)
      bot.pauseUntil = bot.burstUntil + rnd(220, 400)
      bot.strafe = Math.random() < 0.5 ? -1 : 1
    }
    const inBurst = now < bot.burstUntil
    const close = td < 260
    fire = !use && now >= bot.reactAt && off < cone && (close || inBurst)
    if (fire && !W.auto) fire = Math.floor(now / 120) % 2 === 0 // semi-auto: tap, don't hold
    if (!use && td > 110 && (close || !inBurst)) {
      // strafe between bursts (and while spraying up close) so the bot is not a standing target
      mx = Math.cos(trueYaw) * bot.strafe; mz = -Math.sin(trueYaw) * bot.strafe
      if (nav.walk(s.x, s.z, s.x + mx * 40, s.z + mz * 40)) moving = true
      else bot.strafe = -bot.strafe
    }
  } else {
    if (direct) {
      // on a crate or ledge (off the ground grid): walk straight at it, slowly, to not overshoot
      const dx = direct.x - s.x, dz = direct.z - s.z, d = Math.hypot(dx, dz) || 1
      if (d > 8) { mx = dx / d; mz = dz / d; moving = true }
    } else if (reach) {
      // The ground grid cannot route onto boxes, so climb by hand: go to a run-up point,
      // then run at the landing spot and crouch-jump as the edge comes up.
      const p = climbPlan(ctx.boxes, s.y, reach)
      let tx = reach.x, tz = reach.z
      if (p) {
        // phase 1: get to the run-up point. phase 0: run from there and jump. Retry if it fails.
        const key = p.x + ',' + p.z
        if (bot.reachKey !== key) { bot.reachKey = key; bot.reachPhase = 1 }
        const atRun = Math.hypot(p.runX - s.x, p.runZ - s.z) < 36
        if (bot.reachPhase === 1 && atRun && s.ground) { bot.reachPhase = 0; bot.reachUntil = now + 1800 }
        else if (bot.reachPhase === 0 && now > bot.reachUntil && s.ground) bot.reachPhase = 1
        if (bot.reachPhase === 1) {
          const st = nav.steer(s.x, s.z, p.runX, p.runZ)
          if (st) { tx = s.x + st.dx * 100; tz = s.z + st.dz * 100 } else { tx = p.runX; tz = p.runZ }
        } else { tx = p.x; tz = p.z }
      }
      const dx = tx - s.x, dz = tz - s.z, d = Math.hypot(dx, dz) || 1
      mx = dx / d; mz = dz / d; moving = true
      // jump with a run-up as an edge comes up, not standing against it (air control is weak)
      if (bot.reachPhase === 0 && s.ground && now > bot.climbUntil && Math.hypot(s.vx, s.vz) > 120 &&
          hullBlocked({ boxes: ctx.boxes }, s.x + mx * 34, s.y + 0.05, s.z + mz * 34, 16, 72)) {
        bot.climbUntil = now + 650; bot.jumpNext = true
      }
    } else if (!use && goal) {
      const st = nav.steer(s.x, s.z, goal.x, goal.z)
      if (st && st.dist > 30) { mx = st.dx; mz = st.dz; moving = true }
    }
    if (now < bot.alertUntil) wantYaw = bot.alertYaw
    else if (moving) wantYaw = Math.atan2(-mx, -mz)
    else if (face) wantYaw = Math.atan2(-(face[0] - s.x), -(face[1] - s.z))
  }
  const turn = (d) => {
    const m = d * (1 - Math.exp(-K.snap * ctx.dt)), cap = K.turn * ctx.dt
    return m > cap ? cap : m < -cap ? -cap : m
  }
  bot.aimYaw = angNorm(bot.aimYaw + turn(angNorm(wantYaw - bot.aimYaw)))
  bot.aimPitch += turn(wantPitch - bot.aimPitch)
  cmd.yaw = bot.aimYaw; cmd.pitch = bot.aimPitch

  // ---- buttons
  let b = 0
  if (moving) {
    const sy = Math.sin(bot.aimYaw), cy = Math.cos(bot.aimYaw)
    const fd = -mx * sy - mz * cy, rd = mx * cy - mz * sy
    if (fd > 0.38) b |= BTN.F; else if (fd < -0.38) b |= BTN.B
    if (rd > 0.38) b |= BTN.R; else if (rd < -0.38) b |= BTN.L
    // not getting anywhere? sidestep and hop (not while lining up a climb: hops kill the run-up)
    if (!reach && now - bot.stuckAt > 900) {
      if (Math.hypot(s.x - bot.stuckX, s.z - bot.stuckZ) < 14) {
        bot.unstuckUntil = now + 450
        bot.unDir = Math.random() < 0.5 ? BTN.L : BTN.R
        bot.jumpNext = true
      }
      bot.stuckAt = now; bot.stuckX = s.x; bot.stuckZ = s.z
    }
  } else { bot.stuckAt = now; bot.stuckX = s.x; bot.stuckZ = s.z }
  if (now < bot.unstuckUntil) b |= bot.unDir
  if (bot.jumpNext && s.ground) { b |= BTN.JUMP; bot.jumpNext = false }
  else if (now < bot.climbUntil && !s.ground) b |= BTN.DUCK // crouch in the air to clear the edge
  if (direct && moving) b |= BTN.WALK
  if (fire) b |= BTN.FIRE
  if (use) b |= BTN.USE
  if (!tgt && W.mag > 0 && s.ammo[s.w] < W.mag * 0.4 && !s.reloadEnd) b |= BTN.RELOAD
  cmd.b = b
  const want = bestWeapon(s)
  if (s.w !== want) cmd.sel = want
  return cmd
}
