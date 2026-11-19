// Client entry: input, client-side prediction, reconciliation, rendering.
//
// Why it is smooth:
//  - Mouse look is applied to the camera every frame, never waiting on the network.
//  - Your own movement is simulated locally at 128 Hz with the same code the server runs,
//    then drawn interpolated between the last two ticks, so it is smooth at any refresh rate.
//  - Server corrections are replayed invisibly; any leftover error is blended out, not snapped.
//  - Other players are drawn slightly in the past, interpolated on their own command clock.
import { TICK, DT, BTN, WEAPONS, MOVE, FOV } from '../../shared/constants.js'
import { MAP } from '../../shared/map.js'
import { rayWorld } from '../../shared/physics.js'
import { createState, deserialize, step, inaccuracy, recoilPattern } from '../../shared/sim.js'
import { createGfx } from './gfx.js'
import { createViewModel } from './viewmodel.js'
import { createActors, createEffects } from './actors.js'
import { createAudio } from './audio.js'

const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)
const AUTO = params.get('auto') // test hook: skip menu + pointer lock
const D2R = Math.PI / 180

const gfx = createGfx($('game'), MAP)
const { renderer, scene, camera } = gfx
const vm = createViewModel(renderer)
const actors = createActors(scene)
const fx = createEffects(scene)
const audio = createAudio()

// ---------- settings + menu ----------
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d } catch { return d } }, set: (k, v) => { try { localStorage.setItem(k, v) } catch {} } }
let sens = Number(store.get('sens', '2')) || 2
$('name').value = store.get('name', 'Player' + Math.floor(Math.random() * 90 + 10))
$('sens').value = sens
$('sens').addEventListener('change', () => { sens = Math.min(Math.max(Number($('sens').value) || 2, 0.1), 20); store.set('sens', sens) })

// ---------- state ----------
let ws = null, myId = 0, joined = false
const state = createState()
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
let stepDist = 0, wasGround = 1, lastVy = 0
let hitT = 0, hurtT = 0

// ---------- input ----------
const keys = new Set()
let mouseB = 0, wheelJump = 0, selWish = -1
const KEYMAP = { KeyW: BTN.F, KeyS: BTN.B, KeyA: BTN.L, KeyD: BTN.R, Space: BTN.JUMP, ControlLeft: BTN.DUCK, KeyC: BTN.DUCK, ShiftLeft: BTN.WALK, KeyR: BTN.RELOAD }

function buttons() {
  let b = 0
  for (const k of keys) b |= KEYMAP[k] || 0
  if (mouseB & 1) b |= BTN.FIRE
  if (mouseB & 2) b |= BTN.ALT
  if (wheelJump > 0) { b |= BTN.JUMP; wheelJump-- }
  return b
}

window.addEventListener('keydown', (e) => {
  if (!active) return
  if (e.code === 'Tab') { e.preventDefault(); $('scoreboard').classList.remove('hidden'); return }
  if (e.code.startsWith('Digit')) { const n = Number(e.code.slice(5)); if (n >= 1 && n <= WEAPONS.length) selWish = n - 1 }
  if (KEYMAP[e.code]) { keys.add(e.code); e.preventDefault() }
})
window.addEventListener('keyup', (e) => {
  if (e.code === 'Tab') { e.preventDefault(); $('scoreboard').classList.add('hidden') }
  keys.delete(e.code)
})
window.addEventListener('blur', () => { keys.clear(); mouseB = 0 })
window.addEventListener('mousedown', (e) => { if (active) { if (e.button === 0) mouseB |= 1; if (e.button === 2) mouseB |= 2 } })
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

async function lockPointer() {
  const el = $('game')
  try {
    // raw input: bypasses OS mouse acceleration where the browser supports it
    const p = el.requestPointerLock({ unadjustedMovement: true })
    if (p && p.catch) await p.catch(() => el.requestPointerLock())
  } catch { try { el.requestPointerLock() } catch {} }
}
document.addEventListener('pointerlockchange', () => {
  if (AUTO) return
  active = document.pointerLockElement === $('game')
  $('menu').classList.toggle('hidden', active)
  if (!active) { keys.clear(); mouseB = 0; $('play').textContent = joined ? 'RESUME' : 'PLAY' }
})

$('play').addEventListener('click', async () => {
  audio.init()
  store.set('name', $('name').value)
  if (!joined) connect($('name').value)
  // fullscreen + keyboard lock stops Ctrl+W from closing the tab mid-crouch (Chrome / Edge)
  try { await document.documentElement.requestFullscreen(); await navigator.keyboard?.lock?.() } catch {}
  lockPointer()
})
$('game').addEventListener('click', () => { if (joined && !active && $('menu').classList.contains('hidden')) lockPointer() })

// ---------- networking ----------
function connect(name) {
  $('status').textContent = 'Connecting...'
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`)
  ws.onopen = () => { ws.send(JSON.stringify({ t: 'j', name })); $('status').textContent = '' }
  ws.onclose = () => {
    joined = false
    $('status').textContent = 'Disconnected from server. Reload the page to rejoin.'
    $('hud').classList.add('hidden')
    if (document.pointerLockElement) document.exitPointerLock()
    $('menu').classList.remove('hidden')
  }
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.t === 's') onSnapshot(m)
    else if (m.t === 'w') { myId = m.id; joined = true; $('hud').classList.remove('hidden') }
    else if (m.t === 'p') ping = ping ? ping * 0.8 + (performance.now() - m.c) * 0.2 : performance.now() - m.c
    else if (m.t === 'full') $('status').textContent = 'Server is full.'
  }
}
setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'p', c: performance.now() })) }, 500)

const nameOf = (id) => roster.find((r) => r.id === id)?.name || '?'

function onSnapshot(m) {
  if (!joined) return
  const now = performance.now()
  // --- reconcile own player: rewind to the server's state, replay unacknowledged commands
  const oX = state.x, oY = state.y, oZ = state.z
  deserialize(state, m.me)
  let i = 0
  while (i < pending.length && pending[i].seq <= m.a) i++
  if (i) pending.splice(0, i)
  let pX = state.x, pY = state.y, pZ = state.z
  for (const c of pending) { pX = state.x; pY = state.y; pZ = state.z; step(state, c, MAP.boxes, null) }
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
      }
    } else if (e.k === 'hit') {
      fx.blood(e.p[0], e.p[1], e.p[2])
      if (e.a === myId) { hitT = 0.22; $('hitmarker').classList.toggle('head', e.head); audio.hit(e.head) }
      if (e.v === myId) { hurtT = Math.min(1, hurtT + 0.25 + e.dmg / 100); audio.hurt() }
    } else if (e.k === 'kill') {
      const d = document.createElement('div')
      if (e.a === myId || e.v === myId) d.className = 'me'
      d.innerHTML = `${esc(nameOf(e.a))}<em>${WEAPONS[e.w].name}${e.head ? ' (headshot)' : ''}</em>${esc(nameOf(e.v))}`
      $('killfeed').prepend(d)
      setTimeout(() => d.remove(), 6000)
      if (e.a === myId) audio.kill()
      if (e.v === myId) killedBy = nameOf(e.a)
    } else if (e.k === 'reload' && e.id !== myId) {
      const r = actors.remotes.get(e.id)
      if (r) audio.reload(r)
    }
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
function drawScores() {
  $('scores').innerHTML = [...roster].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
    .map((r) => `<tr class="${r.id === myId ? 'me' : ''}"><td>${esc(r.name)}</td><td>${r.kills}</td><td>${r.deaths}</td></tr>`).join('')
}

// ---------- simulation tick (prediction) ----------
const ev = []
function tickOnce() {
  const cmd = { seq: ++seq, b: active ? buttons() : 0, yaw, pitch, sel: selWish }
  selWish = -1
  prevX = state.x; prevY = state.y; prevZ = state.z
  const g0 = state.ground, y0 = state.y
  lastVy = state.vy
  ev.length = 0
  step(state, cmd, MAP.boxes, ev)
  pending.push(cmd)
  if (pending.length > TICK * 2) pending.shift()
  batch.push([cmd.seq, cmd.b, cmd.yaw, cmd.pitch, cmd.sel])

  if (!state.alive) return
  // stairs: the hull snaps up/down a step; hide that from the camera and ease it out
  const dy = state.y - y0
  if (g0 && state.ground && Math.abs(dy) > 0.5 && Math.abs(dy) <= MOVE.STEP + 1) stepOff -= dy
  if (!g0 && state.ground && lastVy < -200) { vm.land(-lastVy * 0.00006); audio.land(null); stepOff += Math.min(-lastVy * 0.012, 7) * -1 }
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
    } else if (e.k === 'reload') audio.reload(null)
    else if (e.k === 'draw') audio.draw()
  }
}

// ---------- HUD ----------
const hudCache = {}
function setText(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v } }
$('slots').innerHTML = WEAPONS.map((w, i) => `<div data-i="${i}">${i + 1}  ${w.name}</div>`).join('')
let fps = 0, fpsAcc = 0, fpsN = 0, worst = 0

function updateHud(dt) {
  const W = WEAPONS[state.w]
  setText('hp', String(Math.max(0, Math.ceil(state.hp))))
  $('health').classList.toggle('low', state.hp <= 30)
  setText('wname', W.name.toUpperCase() + (state.reloadEnd ? '  -  RELOADING' : ''))
  setText('clip', W.mag ? String(state.ammo[state.w]) : '-')
  if (hudCache.slot !== state.w) {
    hudCache.slot = state.w
    for (const d of $('slots').children) d.classList.toggle('on', Number(d.dataset.i) === state.w)
  }
  const gap = 4 + inaccuracy(state) * 7 + state.shots * 0.6
  $('crosshair').style.setProperty('--gap', gap.toFixed(1) + 'px')
  $('crosshair').style.display = state.alive && !state.zoom && state.w !== 4 ? '' : 'none'
  $('scope').classList.toggle('hidden', !(state.zoom && state.alive))
  hitT = Math.max(0, hitT - dt); $('hitmarker').style.opacity = hitT > 0 ? Math.min(1, hitT * 8) : 0
  hurtT = Math.max(0, hurtT - dt * 1.4); $('vignette').style.opacity = hurtT
  $('dead').classList.toggle('hidden', !!state.alive)
  if (!state.alive) {
    setText('deadmsg', killedBy ? `Killed by ${killedBy}` : 'You died')
    setText('deadsub', `Respawning in ${(respawnIn / 1000).toFixed(1)}s`)
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

  const alive = !!state.alive
  camera.position.set(px, py + (alive ? eyeH + stepOff : 14), pz)
  camera.rotation.set(pitch + punchP, yaw + punchY, alive ? 0 : 0.5)
  const fovT = state.zoom && W.zoomFov ? W.zoomFov : FOV
  if (Math.abs(fovT - fovNow) > 0.01) {
    fovNow += (fovT - fovNow) * (1 - Math.exp(-dt * 22))
    camera.fov = fovNow; camera.updateProjectionMatrix()
  }

  audio.setListener(px, py + eyeH, pz, yaw)
  actors.update(dt, now, (r) => audio.step(r, 0.5))
  fx.update(dt)
  vm.update(dt, state, a, Math.hypot(state.vx, state.vz))
  if (joined) updateHud(dt)

  renderer.clear()
  renderer.render(scene, camera)
  if (joined) { renderer.clearDepth(); renderer.render(vm.scene, vm.camera) }
}

function onResize() { vm.resize(window.innerWidth / window.innerHeight) }
window.addEventListener('resize', onResize)
onResize()

// idle menu camera
camera.position.set(-520, 260, 640)
camera.rotation.set(-0.3, -0.75, 0)
yaw = -0.75; pitch = -0.3
prevX = state.x = -520; prevY = state.y = 196; prevZ = state.z = 640

if (AUTO) {
  $('menu').classList.add('hidden')
  active = true
  connect(AUTO)
  // test hooks for automated checks
  window.__game = {
    state, keys, actors,
    look: (y, p) => { yaw = y; pitch = p },
    mouse: (b) => { mouseB = b },
    select: (i) => { selWish = i },
    stats: () => ({ corrections, ping, fps, pending: pending.length, err: Math.hypot(errX, errY, errZ) }),
    cam: () => camera.position.toArray(),
  }
}
requestAnimationFrame(frame)
