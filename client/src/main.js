// Client entry: input, client-side prediction, reconciliation, HUD, rendering.
//
// Why it is smooth:
//  - Mouse look is applied to the camera every frame, never waiting on the network.
//  - Your own movement is simulated locally at 128 Hz with the same code the server runs,
//    then drawn interpolated between the last two ticks, so it is smooth at any refresh rate.
//  - Server corrections are replayed invisibly; any leftover error is blended out, not snapped.
//  - Other players are drawn slightly in the past, interpolated on their own command clock.
import { TICK, DT, BTN, WEAPONS, MOVE, FOV, TEAM, TEAM_NAME, RULES, SHOP } from '../../shared/constants.js'
import { MAP } from '../../shared/map.js'
import { rayWorld } from '../../shared/physics.js'
import { createState, deserialize, step, inaccuracy, recoilPattern, siteAt } from '../../shared/sim.js'
import { createGfx } from './gfx.js'
import { createViewModel } from './viewmodel.js'
import { createActors, createEffects } from './actors.js'
import { createAudio } from './audio.js'

const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)
const AUTO = params.get('auto') // test hook: skip menu + pointer lock
const D2R = Math.PI / 180
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const gfx = createGfx($('game'), MAP)
const { renderer, scene, camera } = gfx
const vm = createViewModel(renderer)
const actors = createActors(scene)
const fx = createEffects(scene, { boxes: MAP.boxes })
const audio = createAudio()
// what the local simulation collides with: map, other players, and the bomb for plant / defuse
const world = { boxes: MAP.boxes, sites: MAP.sites, bomb: null, dyn: [] }

// ---------- settings + menu ----------
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d } catch { return d } }, set: (k, v) => { try { localStorage.setItem(k, v) } catch {} } }
let sens = Number(store.get('sens', '2')) || 2
$('name').value = store.get('name', 'Player' + Math.floor(Math.random() * 90 + 10))
$('sens').value = sens
$('sens').addEventListener('change', () => { sens = Math.min(Math.max(Number($('sens').value) || 2, 0.1), 20); store.set('sens', sens) })

// ---------- state ----------
let ws = null, myId = 0, joined = false
const state = createState()
let game = { m: 0, ph: 'live', r: 0, s: [0, 0], al: [0, 0], t: 0, b: null, buy: 0 }
let pending = []
let batch = []
let seq = 0
let acc = 0
let prevX = 0, prevY = 0, prevZ = 0
let errX = 0, errY = 0, errZ = 0
let stepOff = 0, eyeH = MOVE.EYE_STAND
let lastTp = -1
let yaw = 0, pitch = 0
let punchP = 0, punchY = 0, fovNow = FOV
let roster = []
let respawnIn = 0, killedBy = ''
let ping = 0, corrections = 0
let active = false
let stepDist = 0, lastVy = 0
let hitT = 0, hurtT = 0, flashT = 0, shake = 0, bannerT = 0
let curW = 1, lastW = 0
let buyOpen = false
let spec = 0
let beepT = 0, bombLeft = 0

// ---------- input ----------
const keys = new Set()
let mouseB = 0, wheelJump = 0, selWish = -1
const KEYMAP = { KeyW: BTN.F, KeyS: BTN.B, KeyA: BTN.L, KeyD: BTN.R, Space: BTN.JUMP, ControlLeft: BTN.DUCK, KeyC: BTN.DUCK,
  ShiftLeft: BTN.WALK, KeyR: BTN.RELOAD, KeyE: BTN.USE }

function buttons() {
  let b = 0
  for (const k of keys) b |= KEYMAP[k] || 0
  if (mouseB & 1) b |= BTN.FIRE
  if (mouseB & 2) b |= BTN.ALT
  if (wheelJump > 0) { b |= BTN.JUMP; wheelJump-- }
  return b
}

const owns = (i) => (state.own >> i) & 1
/** 1 primary (cycles if you hold several), 2 pistol, 3 knife, 4 grenades (cycles) */
function selectSlot(n) {
  const cycle = (list) => {
    const have = list.filter(owns)
    if (have.length) selWish = have[(have.indexOf(state.w) + 1) % have.length]
  }
  if (n === 1) cycle([3, 2, 4])
  else if (n === 2) { if (owns(1)) selWish = 1 }
  else if (n === 3) selWish = 0
  else if (n === 4) cycle([5, 6, 7])
}

const shopList = () => SHOP.filter((i) => !i.team || i.team === state.team)
function shopOwned(it) {
  if (it.w !== undefined) return WEAPONS[it.w].nade ? state.ammo[it.w] >= WEAPONS[it.w].max : !!owns(it.w)
  if (it.id === 'armor') return state.armor >= 100
  if (it.id === 'helmet') return state.armor >= 100 && !!state.helmet
  return it.id === 'kit' && !!state.kit
}
let buyKey = ''
function renderBuy() {
  const key = [state.money, state.own, state.armor, state.helmet, state.kit, state.ammo.join(), game.buy, state.team].join('|')
  if (key === buyKey) return
  buyKey = key
  const rows = shopList().map((it, i) => {
    const no = state.money < it.price || shopOwned(it)
    return `<div class="row${no ? ' no' : ''}"><span><b>${i + 1}</b>${esc(it.name)}</span><span>$${it.price}</span></div>`
  })
  $('buy').innerHTML = `<h3>BUY <span>$${state.money}</span></h3>` +
    (game.buy ? rows.join('') : '<div class="row no">Buy time is over for this round</div>') +
    '<div class="foot">Press a number to buy. B closes this menu.</div>'
}
function setBuy(open) {
  buyOpen = open && game.m === 1
  $('buy').classList.toggle('hidden', !buyOpen)
  if (buyOpen) { buyKey = ''; renderBuy() }
}

window.addEventListener('keydown', (e) => {
  if (!active) return
  if (e.code === 'Tab') { e.preventDefault(); $('scoreboard').classList.remove('hidden'); return }
  if (e.code === 'KeyB') { setBuy(!buyOpen); return }
  if (e.code.startsWith('Digit')) {
    const n = Number(e.code.slice(5))
    if (buyOpen) {
      const it = shopList()[n - 1]
      if (it && game.buy && ws) ws.send(JSON.stringify({ t: 'buy', id: it.id }))
    } else selectSlot(n)
    return
  }
  if (e.code === 'KeyQ') { if (owns(lastW)) selWish = lastW; return }
  if (KEYMAP[e.code]) { keys.add(e.code); e.preventDefault() }
})
window.addEventListener('keyup', (e) => {
  if (e.code === 'Tab') { e.preventDefault(); $('scoreboard').classList.add('hidden') }
  keys.delete(e.code)
})
window.addEventListener('blur', () => { keys.clear(); mouseB = 0 })
window.addEventListener('mousedown', (e) => {
  if (!active) return
  if (!state.alive && game.m === 1 && e.button === 0) { cycleSpec(); return }
  if (e.button === 0) mouseB |= 1
  if (e.button === 2) mouseB |= 2
})
window.addEventListener('mouseup', (e) => { if (e.button === 0) mouseB &= ~1; if (e.button === 2) mouseB &= ~2 })
window.addEventListener('contextmenu', (e) => e.preventDefault())
window.addEventListener('wheel', (e) => { if (active) { wheelJump = 1; e.preventDefault() } }, { passive: false })
window.addEventListener('mousemove', (e) => {
  if (!active || document.pointerLockElement !== $('game')) return
  const zoomMul = state.zoom ? fovNow / FOV : 1
  const k = 0.022 * sens * D2R * zoomMul
  yaw -= e.movementX * k
  pitch -= e.movementY * k
  const lim = 89 * D2R
  if (pitch > lim) pitch = lim; else if (pitch < -lim) pitch = -lim
  vm.addSway(e.movementX, e.movementY)
})
window.addEventListener('beforeunload', (e) => { if (active) { e.preventDefault(); e.returnValue = '' } })

// Mouse capture. Browsers only allow it as the direct result of a click, so it is requested
// synchronously inside click handlers (never after an await). If it is refused, a
// "click to play" overlay stays up and the next click tries again.
let rawInput = store.get('rawInput', '1') === '1'
function lockPointer() {
  const el = $('game')
  let p
  try { p = el.requestPointerLock(rawInput ? { unadjustedMovement: true } : undefined) } catch (e) { p = Promise.reject(e) }
  if (p && p.catch) {
    p.catch((e) => {
      // raw input unsupported on this machine: fall back to normal input from the next click on
      if (rawInput && e && e.name === 'NotSupportedError') {
        rawInput = false
        store.set('rawInput', '0')
        try { const q = el.requestPointerLock(); if (q && q.catch) q.catch(() => {}) } catch {}
      }
      showClickTo()
    })
  }
}
function showClickTo() {
  if (AUTO || document.pointerLockElement === $('game')) return
  if (joined && $('menu').classList.contains('hidden')) $('clickto').classList.remove('hidden')
}
document.addEventListener('pointerlockchange', () => {
  if (AUTO) return
  const locked = document.pointerLockElement === $('game')
  active = locked
  $('clickto').classList.add('hidden')
  if (locked) $('menu').classList.add('hidden')
  else {
    keys.clear(); mouseB = 0
    setBuy(false)
    $('play').textContent = joined ? 'RESUME' : 'PLAY'
    $('menu').classList.remove('hidden')
  }
})
document.addEventListener('pointerlockerror', showClickTo)

$('play').addEventListener('click', () => {
  audio.init()
  store.set('name', $('name').value)
  if (!joined) connect($('name').value)
  $('menu').classList.add('hidden')
  // both requests happen right here, inside the click
  lockPointer()
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
    // keyboard lock (fullscreen only) stops Ctrl+W from closing the tab mid-crouch in Chrome / Edge
    document.documentElement.requestFullscreen().then(() => navigator.keyboard?.lock?.()).catch(() => {})
  }
  setTimeout(showClickTo, 400)
})
const relock = () => { if (joined && !active && $('menu').classList.contains('hidden')) lockPointer() }
$('game').addEventListener('click', relock)
$('clickto').addEventListener('click', relock)
$('modebtn').addEventListener('click', () => { if (ws) ws.send(JSON.stringify({ t: 'mode', m: game.m ? 0 : 1 })) })
$('teambtn').addEventListener('click', () => { if (ws) ws.send(JSON.stringify({ t: 'team' })) })

// ---------- networking ----------
function connect(name) {
  $('status').textContent = 'Connecting...'
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`)
  ws.onopen = () => { ws.send(JSON.stringify({ t: 'j', name })); $('status').textContent = '' }
  ws.onerror = () => { $('status').textContent = 'Could not reach the game server. Is the black server window still running?' }
  ws.onclose = () => {
    joined = false
    $('status').textContent = 'Disconnected from server. Reload the page to rejoin.'
    $('hud').classList.add('hidden')
    $('clickto').classList.add('hidden')
    $('modebox').classList.add('hidden')
    if (document.pointerLockElement) document.exitPointerLock()
    $('menu').classList.remove('hidden')
  }
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.t === 's') onSnapshot(m)
    else if (m.t === 'w') { myId = m.id; joined = true; $('hud').classList.remove('hidden'); $('modebox').classList.remove('hidden'); showClickTo() }
    else if (m.t === 'p') ping = ping ? ping * 0.8 + (performance.now() - m.c) * 0.2 : performance.now() - m.c
    else if (m.t === 'm') { banner(m.text, '', 3); $('status').textContent = m.text }
    else if (m.t === 'bought') audio.sfx('buy', null, 0.5)
    else if (m.t === 'flash') { flashT = Math.max(flashT, m.d); audio.ring(m.d) }
    else if (m.t === 'full') $('status').textContent = 'Server is full.'
  }
}
setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'p', c: performance.now() })) }, 500)

const nameOf = (id) => roster.find((r) => r.id === id)?.name || 'World'
const WHY = { elim: 'Enemy team eliminated', time: 'Time ran out', boom: 'The bomb went off', defuse: 'The bomb was defused' }

function banner(text, sub = '', secs = 3) {
  $('banner').innerHTML = esc(text) + (sub ? `<small>${esc(sub)}</small>` : '')
  $('banner').style.opacity = 1
  bannerT = secs
}

function onSnapshot(m) {
  if (!joined) return
  const now = performance.now()
  const g = m.g
  // --- world the prediction collides with: other players + planted bomb
  world.dyn.length = 0
  for (const a of m.p) {
    if (a[7] & 1) world.dyn.push({ x0: a[2] - 16, x1: a[2] + 16, y0: a[3], y1: a[3] + ((a[7] & 2) ? 54 : 72), z0: a[4] - 16, z1: a[4] + 16 })
  }
  world.bomb = g.b && g.b[0] === 3 ? { x: g.b[1], y: g.b[2], z: g.b[3] } : null

  // --- reconcile own player: rewind to the server's state, replay unacknowledged commands
  const oX = state.x, oY = state.y, oZ = state.z
  deserialize(state, m.me)
  let i = 0
  while (i < pending.length && pending[i].seq <= m.a) i++
  if (i) pending.splice(0, i)
  let pX = state.x, pY = state.y, pZ = state.z
  for (const c of pending) { pX = state.x; pY = state.y; pZ = state.z; step(state, c, world, null) }
  if (state.tp !== lastTp) {
    lastTp = state.tp
    yaw = state.spawnYaw; pitch = 0
    errX = errY = errZ = 0; stepOff = 0
    prevX = state.x; prevY = state.y; prevZ = state.z
    eyeH = MOVE.EYE_STAND
  } else {
    const dx = oX - state.x, dy = oY - state.y, dz = oZ - state.z
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 > 1e-6) {
      corrections++
      if (d2 < 96 * 96) { errX += dx; errY += dy; errZ += dz } else { errX = errY = errZ = 0 }
    }
    prevX = pX; prevY = pY; prevZ = pZ
  }
  respawnIn = m.r
  if (g.b && g.b[0] === 3) bombLeft = g.b[5]
  if (game.buy && !g.buy && buyOpen) setBuy(false)
  game = g
  fx.setBomb(g.b)

  actors.onSnapshot(m.p, now)

  for (const e of m.e) {
    if (e.k === 'roster') { roster = e.players; drawScores() }
    else if (e.k === 'shot') {
      if (e.id === myId) continue // already shown by prediction
      const r = actors.remotes.get(e.id)
      const pos = { x: e.o[0], y: e.o[1], z: e.o[2] }
      audio.shot(e.w, pos)
      if (e.w !== 0) {
        const ry = r ? r.yaw : 0
        fx.tracer(e.o[0] - Math.sin(ry) * 30, e.o[1] - 8, e.o[2] - Math.cos(ry) * 30, e.h[0], e.h[1], e.h[2])
        if (e.n) fx.impact(e.h[0], e.h[1], e.h[2], e.n[0], e.n[1], e.n[2])
        // a bullet that passes close by makes itself heard
        const dx = e.h[0] - e.o[0], dy = e.h[1] - e.o[1], dz = e.h[2] - e.o[2]
        const L2 = dx * dx + dy * dy + dz * dz
        if (L2 > 1) {
          const cx = camera.position.x - e.o[0], cy = camera.position.y - e.o[1], cz = camera.position.z - e.o[2]
          const t = Math.max(0, Math.min(1, (cx * dx + cy * dy + cz * dz) / L2))
          const miss = Math.hypot(cx - dx * t, cy - dy * t, cz - dz * t)
          if (t > 0.05 && miss < 70 && Math.sqrt(L2) * t > 150) audio.sfx('whiz', null, 0.5, { rate: 0.9 + Math.random() * 0.3 })
        }
      }
    } else if (e.k === 'hit') {
      fx.blood(e.p[0], e.p[1], e.p[2])
      if (e.a === myId && e.v !== myId) { hitT = 0.22; $('hitmarker').classList.toggle('head', e.head); audio.hit(e.head) }
      if (e.v === myId) { hurtT = Math.min(1, hurtT + 0.25 + e.dmg / 100); audio.hurt() }
    } else if (e.k === 'kill') {
      const d = document.createElement('div')
      if (e.a === myId || e.v === myId) d.className = 'me'
      const how = e.w < 0 ? 'Bomb' : WEAPONS[e.w].name
      d.innerHTML = `${esc(e.a ? nameOf(e.a) : '')}<em>${how}${e.head ? ' (headshot)' : ''}</em>${esc(nameOf(e.v))}`
      $('killfeed').prepend(d)
      setTimeout(() => d.remove(), 6000)
      if (e.a === myId && e.v !== myId) audio.kill()
      if (e.v === myId) killedBy = e.a && e.a !== myId ? nameOf(e.a) : ''
    } else if (e.k === 'reload' && e.id !== myId) {
      const r = actors.remotes.get(e.id)
      if (r) audio.reload(r)
    } else if (e.k === 'throw') {
      if (e.id === myId) continue
      fx.nadeAdd(e.id, e.w, e.o, e.v)
      audio.sfx('nade_throw', { x: e.o[0], y: e.o[1], z: e.o[2] }, 0.4)
    } else if (e.k === 'nade') {
      fx.nadeRemove(e.id, e.w)
      const pos = { x: e.p[0], y: e.p[1], z: e.p[2] }
      const dist = Math.hypot(pos.x - camera.position.x, pos.y - camera.position.y, pos.z - camera.position.z)
      if (e.w === 5) { fx.explosion(pos.x, pos.y, pos.z, false); audio.sfx('explosion', pos, 1.3, { rate: 1.5, reach: 700 }); shake = Math.max(shake, 9 * Math.max(0, 1 - dist / 700)) }
      else if (e.w === 6) { fx.flashPop(pos.x, pos.y, pos.z); audio.sfx('flashbang', pos, 1.0, { reach: 600 }) }
      else { fx.smoke(pos.x, pos.y, pos.z); audio.sfx('smoke', pos, 0.8, { reach: 400 }) }
    } else if (e.k === 'rs') {
      fx.clearRound()
      setBuy(false)
      spec = 0; killedBy = ''
      banner(`Round ${e.n}`, `You are ${TEAM_NAME[state.team] || 'spectating'}${state.bomb ? ' - you have the bomb' : ''}. Press B to buy.`, 4)
      audio.sfx('round_start', null, 0.5)
    } else if (e.k === 'go') {
      banner('GO', '', 1)
    } else if (e.k === 're') {
      banner(`${TEAM_NAME[e.w]} win the round`, WHY[e.why] || '', 4.5)
      audio.sfx(e.w === state.team ? 'round_win' : 'round_lose', null, 0.6)
    } else if (e.k === 'planted') {
      banner(`Bomb planted at ${e.site}`, '', 2.5)
      audio.sfx('bomb_plant', null, 0.6)
      beepT = 0.6
    } else if (e.k === 'defused') {
      banner('Bomb defused', `by ${nameOf(e.id)}`, 3)
      audio.sfx('bomb_defuse', null, 0.7)
    } else if (e.k === 'boom') {
      const pos = { x: e.p[0], y: e.p[1], z: e.p[2] }
      fx.explosion(pos.x, pos.y, pos.z, true)
      audio.sfx('explosion', pos, 2.2, { reach: 1600 })
      const dist = Math.hypot(pos.x - camera.position.x, pos.z - camera.position.z)
      shake = Math.max(shake, 26 * Math.max(0.15, 1 - dist / 2200))
    } else if (e.k === 'match') {
      banner(e.w ? `${TEAM_NAME[e.w]} win the match` : 'Match drawn', `${e.s[0]} - ${e.s[1]}`, 7.5)
    } else if (e.k === 'mode') {
      fx.clearRound()
      setBuy(false)
      banner(e.m ? 'Bomb match' : 'Deathmatch', e.m ? 'Attackers plant the bomb at A or B. Defenders stop them.' : 'Warm-up. Start a bomb match from the Esc menu.', 5)
    } else if (e.k === 'msg') {
      banner(e.text, '', 3.5)
    } else if (e.k === 'drop') {
      if (state.team === TEAM.ATT) banner('Bomb dropped', '', 2)
    } else if (e.k === 'pickup') {
      if (state.team === TEAM.ATT) banner(e.id === myId ? 'You picked up the bomb' : `${nameOf(e.id)} picked up the bomb`, '', 2)
    } else if (e.k === 'act' && e.id !== myId) {
      const r = actors.remotes.get(e.id)
      if (r) audio.sfx('buy', r, 0.9, { rate: e.a === 1 ? 0.7 : 0.55, reach: 300 })
    }
  }
}

function drawScores() {
  const order = [...roster].sort((a, b) => a.team - b.team || b.kills - a.kills || a.deaths - b.deaths)
  $('scores').innerHTML = order.map((r) => {
    const cls = [r.id === myId ? 'me' : '', game.m === 1 && !r.alive ? 'deadrow' : ''].join(' ')
    const t = r.team ? `<td class="${r.team === TEAM.ATT ? 'att' : 'def'}">${TEAM_NAME[r.team]}${r.want ? ' (switching)' : ''}</td>` : '<td>-</td>'
    return `<tr class="${cls}"><td>${esc(r.name)}</td>${t}<td>${r.kills}</td><td>${r.deaths}</td></tr>`
  }).join('')
}

// ---------- spectating (bomb mode, while dead) ----------
const specList = () => [...actors.remotes.values()].filter((r) => r.alive && r.team === state.team && r.buf.length)
function specTarget() {
  const c = specList()
  if (!c.length) return null
  let t = c.find((r) => r.id === spec)
  if (!t) { t = c[0]; spec = t.id }
  return t
}
function cycleSpec() {
  const c = specList()
  if (c.length) spec = c[(c.findIndex((r) => r.id === spec) + 1) % c.length].id
}

// ---------- simulation tick (prediction) ----------
const ev = []
function tickOnce() {
  let b = active ? buttons() : 0
  if (buyOpen) b &= ~BTN.FIRE
  const cmd = { seq: ++seq, b, yaw, pitch, sel: selWish }
  selWish = -1
  prevX = state.x; prevY = state.y; prevZ = state.z
  const g0 = state.ground, y0 = state.y
  lastVy = state.vy
  ev.length = 0
  step(state, cmd, world, ev)
  pending.push(cmd)
  if (pending.length > TICK * 2) pending.shift()
  batch.push([cmd.seq, cmd.b, cmd.yaw, cmd.pitch, cmd.sel])
  if (state.w !== curW) { lastW = curW; curW = state.w }

  if (!state.alive) return
  let lifted = 0
  for (const e of ev) if (e.k === 'lift') lifted += e.d
  // crouch-jump moves the feet, not the eyes: keep the camera where it was
  if (lifted) eyeH -= lifted
  // stairs: the hull snaps up/down a step; hide that from the camera and ease it out
  const dy = state.y - y0 - lifted
  if (g0 && state.ground && Math.abs(dy) > 0.5 && Math.abs(dy) <= MOVE.STEP + 1) stepOff -= dy
  if (!g0 && state.ground && lastVy < -200) { vm.land(-lastVy * 0.00006); audio.land(null); stepOff -= Math.min(-lastVy * 0.012, 7) }
  // footsteps (walking with Shift is silent)
  if (state.ground) {
    const sp = Math.hypot(state.vx, state.vz)
    if (sp > 150) { stepDist += sp * DT; if (stepDist > 85) { stepDist = 0; audio.step(null, 0.16) } }
  }
  for (const e of ev) {
    if (e.k === 'fire') {
      vm.fire(e.w); audio.shot(e.w, null)
      if (e.w !== 0) {
        const hit = rayWorld(MAP.boxes, e.ox, e.oy, e.oz, e.dx, e.dy, e.dz, WEAPONS[e.w].range)
        const hx = e.ox + e.dx * hit.t, hy = e.oy + e.dy * hit.t, hz = e.oz + e.dz * hit.t
        // start the tracer near the gun barrel rather than the eye
        const rx = Math.cos(yaw), rz = -Math.sin(yaw)
        fx.tracer(e.ox + rx * 5 + e.dx * 34, e.oy - 5 + e.dy * 34, e.oz + rz * 5 + e.dz * 34, hx, hy, hz)
        if (hit.hit) fx.impact(hx, hy, hz, hit.nx, hit.ny, hit.nz)
      }
    } else if (e.k === 'throw') {
      vm.fire(e.w)
      fx.nadeAdd(myId, e.w, [e.ox, e.oy, e.oz], [e.vx, e.vy, e.vz])
      audio.sfx('nade_throw', null, 0.4)
    } else if (e.k === 'reload') audio.reload(null)
    else if (e.k === 'draw') audio.draw()
    else if (e.k === 'act') audio.sfx('buy', null, 0.6, { rate: e.a === 1 ? 0.7 : 0.55 })
  }
}

// ---------- radar ----------
const radar = $('radar'), rctx = radar.getContext('2d')
const RS = 200 / (MAP.size * 2 + 80)
const rpx = (v) => 100 + v * RS
const radarBg = document.createElement('canvas')
radarBg.width = radarBg.height = 200
{
  const g = radarBg.getContext('2d')
  g.fillStyle = 'rgba(120,130,140,0.18)'
  g.fillRect(rpx(-MAP.size), rpx(-MAP.size), MAP.size * 2 * RS, MAP.size * 2 * RS)
  for (const s of MAP.sites) {
    g.fillStyle = 'rgba(232,184,0,0.3)'
    g.fillRect(rpx(s.x0), rpx(s.z0), (s.x1 - s.x0) * RS, (s.z1 - s.z0) * RS)
    g.fillStyle = 'rgba(255,255,255,0.75)'; g.font = 'bold 15px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'
    g.fillText(s.name, rpx((s.x0 + s.x1) / 2), rpx((s.z0 + s.z1) / 2))
  }
  for (const b of MAP.boxes) {
    if (b.y1 < 44 || b.y0 > 10 || b.mat === 'ground') continue
    g.fillStyle = b.y1 >= 190 ? '#20252c' : '#4a515b'
    g.fillRect(rpx(b.x0), rpx(b.z0), Math.max(1, (b.x1 - b.x0) * RS), Math.max(1, (b.z1 - b.z0) * RS))
  }
}
function drawRadar(cx, cz, cyaw) {
  rctx.clearRect(0, 0, 200, 200)
  rctx.drawImage(radarBg, 0, 0)
  if (state.team) {
    for (const r of actors.remotes.values()) {
      if (!r.alive || r.team !== state.team) continue
      rctx.fillStyle = r.team === TEAM.ATT ? '#ff8a3c' : '#5aa2ff'
      rctx.beginPath(); rctx.arc(rpx(r.x), rpx(r.z), 3.2, 0, 7); rctx.fill()
    }
  }
  const b = game.b
  if (b && b[0] >= 1 && b[0] <= 3 && !(b[0] === 1 && b[4] === myId)) {
    rctx.fillStyle = '#ff3b30'
    rctx.fillRect(rpx(b[1]) - 3, rpx(b[3]) - 3, 6, 6)
  }
  rctx.save()
  rctx.translate(rpx(cx), rpx(cz))
  rctx.rotate(-cyaw)
  rctx.fillStyle = '#fff'
  rctx.beginPath(); rctx.moveTo(0, -6); rctx.lineTo(4, 5); rctx.lineTo(-4, 5); rctx.fill()
  rctx.restore()
}

// ---------- HUD ----------
const hudCache = {}
function setText(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v } }
function setClass(id, cls, on) { const k = id + '.' + cls; if (hudCache[k] !== on) { hudCache[k] = on; $(id).classList.toggle(cls, on) } }
let fps = 0, fpsAcc = 0, fpsN = 0, worst = 0
const mmss = (ms) => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

function updateHud(dt, specName) {
  const W = WEAPONS[state.w]
  const bombMode = game.m === 1
  const alive = !!state.alive
  setText('hp', String(Math.max(0, Math.ceil(state.hp))))
  setClass('health', 'low', state.hp <= 30)
  setText('armor', state.armor > 0 ? `ARMOUR ${Math.ceil(state.armor)}${state.helmet ? ' + HELMET' : ''}` : '')
  setText('money', bombMode ? `$${state.money}` : '')
  setText('wname', W.name.toUpperCase() + (state.reloadEnd ? '  -  RELOADING' : ''))
  setText('clip', W.nade ? 'x' + state.ammo[state.w] : W.mag ? String(state.ammo[state.w]) : '-')
  const slotKey = state.own + '|' + state.w + '|' + state.ammo[5] + state.ammo[6] + state.ammo[7] + '|' + state.bomb + state.kit
  if (hudCache.slots !== slotKey) {
    hudCache.slots = slotKey
    const row = (key, i, extra = '') => owns(i) ? `<div class="${state.w === i ? 'on' : ''}">${key}  ${WEAPONS[i].name}${extra}</div>` : ''
    $('slots').innerHTML = [3, 2, 4].map((i) => row(1, i)).join('') + row(2, 1) + row(3, 0) +
      [5, 6, 7].map((i) => row(4, i, state.ammo[i] > 1 ? ' x' + state.ammo[i] : '')).join('') +
      (state.bomb ? '<div class="on">E  BOMB (plant at A or B)</div>' : '') + (state.kit ? '<div>Defuse kit</div>' : '')
  }
  const gap = 4 + inaccuracy(state) * 7 + state.shots * 0.6
  $('crosshair').style.setProperty('--gap', gap.toFixed(1) + 'px')
  $('crosshair').style.display = alive && !state.zoom && state.w !== 4 ? '' : 'none'
  setClass('scope', 'hidden', !(state.zoom && alive))
  hitT = Math.max(0, hitT - dt); $('hitmarker').style.opacity = hitT > 0 ? Math.min(1, hitT * 8) : 0
  hurtT = Math.max(0, hurtT - dt * 1.4); $('vignette').style.opacity = hurtT
  flashT = Math.max(0, flashT - dt); $('flashfx').style.opacity = Math.min(1, flashT / 1.2)
  if (bannerT > 0) { bannerT -= dt; if (bannerT <= 0) $('banner').style.opacity = 0 }

  // top bar
  setClass('top', 'hidden', !bombMode)
  setText('modetag', bombMode ? '' : 'DEATHMATCH  -  WARM-UP')
  if (bombMode) {
    setText('sa', String(game.s[0])); setText('sd', String(game.s[1]))
    setText('alive', `${game.al[0]} v ${game.al[1]}  -  ROUND ${game.r}`)
    const planted = game.b && game.b[0] === 3
    setText('timer', planted ? 'BOMB' : game.ph === 'freeze' || game.ph === 'live' ? mmss(game.t) : '-:--')
    setClass('timer', 'bomb', !!planted)
    setClass('timer', 'freeze', game.ph === 'freeze')
  }

  // context hint + plant / defuse progress
  let hint = ''
  if (alive && bombMode) {
    if (state.frz) hint = 'Buy time - press B'
    else if (state.bomb && !world.bomb) hint = siteAt(MAP.sites, state.x, state.z) >= 0 ? 'Hold E to plant the bomb' : ''
    else if (state.team === TEAM.DEF && world.bomb && Math.hypot(world.bomb.x - state.x, world.bomb.z - state.z) < RULES.DEFUSE_RANGE) hint = 'Hold E to defuse'
  }
  if (state.act) hint = ''
  setText('hint', hint)
  setClass('progress', 'hidden', !state.act)
  if (state.act) {
    const total = state.act === 1 ? RULES.PLANT_TICKS : state.kit ? RULES.DEFUSE_KIT_TICKS : RULES.DEFUSE_TICKS
    $('progfill').style.width = Math.min(100, (state.actT / total) * 100).toFixed(1) + '%'
    setText('proglbl', state.act === 1 ? 'PLANTING' : 'DEFUSING')
  }

  setClass('dead', 'hidden', alive)
  if (!alive) {
    if (bombMode) {
      setText('deadmsg', killedBy ? `Killed by ${killedBy}` : state.team ? 'You are out this round' : 'Waiting for the next round')
      setText('deadsub', specName ? `Spectating ${specName} - click to switch` : 'You will be back next round')
    } else {
      setText('deadmsg', killedBy ? `Killed by ${killedBy}` : 'You died')
      setText('deadsub', `Respawning in ${(respawnIn / 1000).toFixed(1)}s`)
    }
  }
  if (buyOpen) renderBuy()

  // menu mode controls
  if (hudCache.mode !== game.m) {
    hudCache.mode = game.m
    $('modelbl').textContent = game.m ? 'A bomb match is running.' : 'Deathmatch warm-up. A bomb match needs at least 2 players.'
    $('modebtn').textContent = game.m ? 'END MATCH' : 'START BOMB MATCH'
    $('teambtn').classList.toggle('hidden', !game.m)
    $('sbtitle').textContent = game.m ? 'Bomb match' : 'Deathmatch'
    drawScores()
  }

  fpsAcc += dt; fpsN++; worst = Math.max(worst, dt)
  if (fpsAcc >= 0.5) {
    fps = Math.round(fpsN / fpsAcc)
    setText('net', `${fps} fps  worst ${(worst * 1000).toFixed(1)} ms\nping ${ping.toFixed(0)} ms  tick ${TICK}\nspeed ${Math.hypot(state.vx, state.vz).toFixed(0)}  corrections ${corrections}`)
    fpsAcc = 0; fpsN = 0; worst = 0
  }
}

// ---------- frame loop ----------
let last = performance.now()
function frame(now) {
  requestAnimationFrame(frame)
  const dt = Math.min((now - last) / 1000, 0.25)
  last = now

  if (joined) {
    acc += dt
    let n = 0
    while (acc >= DT) {
      acc -= DT
      if (++n > 40) { acc = 0; break }
      tickOnce()
    }
    if (batch.length && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: 'c', v: actors.viewTicks(), c: batch }))
      batch = []
    }
  }
  const a = acc / DT

  // decay visual-only offsets
  const ek = Math.exp(-dt * 18)
  errX *= ek; errY *= ek; errZ *= ek
  stepOff *= Math.exp(-dt * 13)
  eyeH += ((state.duck ? MOVE.EYE_DUCK : MOVE.EYE_STAND) - eyeH) * (1 - Math.exp(-dt * 16))

  const px = prevX + (state.x - prevX) * a + errX
  const py = prevY + (state.y - prevY) * a + errY
  const pz = prevZ + (state.z - prevZ) * a + errZ

  // recoil: the view climbs with the spray and settles back
  const W = WEAPONS[state.w]
  const pat = recoilPattern(W, state.shots)
  const pk = 1 - Math.exp(-dt * 24)
  punchP += (pat[0] * 0.5 * D2R - punchP) * pk
  punchY += (pat[1] * 0.5 * D2R - punchY) * pk

  actors.update(dt, now, (r) => audio.step(r, 0.5))

  const alive = !!state.alive
  const target = !alive && game.m === 1 ? specTarget() : null
  let cx = px, cz = pz, cyaw = yaw
  for (const r of actors.remotes.values()) r.hidden = r === target
  if (target) {
    cx = target.x; cz = target.z; cyaw = target.yaw
    camera.position.set(target.x, target.y + MOVE.EYE_STAND - 18 * target.duckVis, target.z)
    camera.rotation.set(target.pitch, target.yaw, 0)
    target.body.root.visible = false
  } else {
    camera.position.set(px, py + (alive ? eyeH + stepOff : 14), pz)
    camera.rotation.set(pitch + punchP, yaw + punchY, alive ? 0 : 0.5)
  }
  if (shake > 0.05) {
    camera.position.x += (Math.random() - 0.5) * shake
    camera.position.y += (Math.random() - 0.5) * shake
    camera.position.z += (Math.random() - 0.5) * shake
    shake *= Math.exp(-dt * 5)
  }
  const fovT = alive && state.zoom && W.zoomFov ? W.zoomFov : FOV
  if (Math.abs(fovT - fovNow) > 0.01) {
    fovNow += (fovT - fovNow) * (1 - Math.exp(-dt * 22))
    camera.fov = fovNow; camera.updateProjectionMatrix()
  }

  // planted bomb: beeps speed up as the timer runs down
  if (game.b && game.b[0] === 3) {
    bombLeft -= dt * 1000
    beepT -= dt
    if (beepT <= 0) {
      beepT = 0.12 + 0.9 * Math.max(0, Math.min(1, bombLeft / RULES.BOMB_MS))
      audio.sfx('bomb_beep', world.bomb, 1.0, { reach: 700 })
      fx.bombBlink()
    }
  }

  audio.setListener(camera.position.x, camera.position.y, camera.position.z, cyaw)
  fx.update(dt, (n) => audio.sfx('nade_bounce', n, 0.5, { reach: 300 }))
  vm.update(dt, state, a, Math.hypot(state.vx, state.vz))
  if (joined) { updateHud(dt, target ? nameOf(target.id) : ''); drawRadar(cx, cz, cyaw) }

  renderer.clear()
  renderer.render(scene, camera)
  if (joined) { renderer.clearDepth(); renderer.render(vm.scene, vm.camera) }
}

function onResize() { vm.resize(window.innerWidth / window.innerHeight) }
window.addEventListener('resize', onResize)
onResize()

// idle menu camera: overlooking site A
camera.position.set(-420, 420, -260)
camera.rotation.set(-0.5, 0.75, 0)
yaw = 0.75; pitch = -0.5
prevX = state.x = -420; prevY = state.y = 356; prevZ = state.z = -260

if (AUTO) {
  $('menu').classList.add('hidden')
  active = true
  connect(AUTO)
  // test hooks for automated checks
  window.__game = {
    state, keys, actors, world, fx,
    game: () => game,
    send: (o) => ws.send(JSON.stringify(o)),
    look: (y, p) => { yaw = y; pitch = p },
    mouse: (b) => { mouseB = b },
    select: (i) => { selWish = i },
    stats: () => ({ corrections, ping, fps, pending: pending.length, err: Math.hypot(errX, errY, errZ) }),
    cam: () => camera.position.toArray(),
  }
}
requestAnimationFrame(frame)
