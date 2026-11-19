// Other players (interpolated on each player's own command timeline) and world effects:
// tracers, impacts, grenades, smoke, explosions and the bomb.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { TICK, SMOKE_MS } from '../../shared/constants.js'
import { stepNade } from '../../shared/physics.js'

const ID_COLORS = [0x3d6ea8, 0xa8553d, 0x4f8f4a, 0x8a5aa8, 0xa89a3d, 0x3d9aa8, 0xa83d6e, 0x777777]
const TEAM_COLORS = [0, 0xd0661f, 0x2b6fd0] // attackers orange, defenders blue
const INTERP_TICKS = TICK * 0.06 // 60 ms behind the newest data

// ---- placeholder body (shown until player.glb has loaded, or if it is missing) ----
function buildBody(color) {
  const cloth = new THREE.MeshStandardMaterial({ color, roughness: 0.85 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.8 })
  const skin = new THREE.MeshStandardMaterial({ color: 0xc79a7b, roughness: 0.7 })
  const gunM = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.45, metalness: 0.7 })
  const root = new THREE.Group()
  const mk = (geo, mat, parent, x, y, z) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m
  }
  const legL = new THREE.Group(), legR = new THREE.Group()
  legL.position.set(-5, 33, 0); legR.position.set(5, 33, 0)
  mk(new THREE.BoxGeometry(7.5, 33, 8.5), dark, legL, 0, -16.5, 0)
  mk(new THREE.BoxGeometry(7.5, 33, 8.5), dark, legR, 0, -16.5, 0)
  const upper = new THREE.Group()
  upper.position.set(0, 33, 0)
  mk(new THREE.BoxGeometry(19, 25, 11), cloth, upper, 0, 13, 0)
  const head = new THREE.Group()
  head.position.set(0, 31.5, 0)
  mk(new THREE.SphereGeometry(6.3, 16, 12), skin, head, 0, 0, 0)
  upper.add(head)
  const arms = new THREE.Group()
  arms.position.set(0, 21, 0)
  mk(new THREE.BoxGeometry(5.5, 5.5, 22), cloth, arms, 8.5, -1, -9)
  mk(new THREE.BoxGeometry(5.5, 5.5, 24), cloth, arms, -7, -1, -11)
  mk(new THREE.BoxGeometry(2.6, 5, 34), gunM, arms, 3, 0.5, -24)
  upper.add(arms)
  root.add(legL, legR, upper)
  return {
    root,
    setColor(c) { cloth.color.set(c) },
    animate(dt, r, speed) {
      root.rotation.set(-r.fall * Math.PI / 2, r.yaw, 0, 'YXZ')
      const amp = r.ground ? Math.min(speed / 250, 1) * 0.75 : 0.25
      const sw = Math.sin(r.walk) * amp
      const crouch = r.duckVis
      legL.rotation.x = sw - crouch * 1.0; legR.rotation.x = -sw - crouch * 0.4
      legL.position.y = legR.position.y = 33 - crouch * 9
      upper.position.y = 33 - crouch * 16
      upper.rotation.x = -crouch * 0.25 + r.pitch * 0.25
      head.rotation.x = r.pitch * 0.5
      arms.rotation.x = r.pitch * 0.6 + crouch * 0.25
    },
  }
}

// ---- animated soldier from client/public/models/player.glb ----
const HAND_NODE = ['Knife_2', 'Pistol', 'SMG', 'AK', 'Sniper'] // attach points on the right hand
const HELD_LEN = [13, 10, 24, 34, 46] // world length of each held weapon
const WEAPON_FILES = ['knife', 'pistol', 'smg', 'rifle', 'sniper']
// The model has an oversized cartoon head. Shrinking it brings it in line with the head hitbox.
const HEAD_SCALE = 0.62
const assets = { player: null, weapons: [], waiting: [] }
{
  const loader = new GLTFLoader()
  loader.load('/models/player.glb', (g) => { assets.player = g; assets.waiting.forEach((f) => f()); assets.waiting = [] },
    undefined, () => console.warn('player.glb missing, using placeholder bodies'))
  WEAPON_FILES.forEach((f, i) => loader.load(`/models/${f}.glb`, (g) => { assets.weapons[i] = g.scene }, undefined, () => {}))
}

function buildRig(color) {
  const model = SkeletonUtils.clone(assets.player.scene)
  const root = new THREE.Group()
  const headB = model.getObjectByName('Head')
  const headBase = headB ? headB.scale.clone() : null
  if (headB) headB.scale.multiplyScalar(HEAD_SCALE)
  // scale so the posed mesh is exactly one player hull (72 units) tall, feet on the ground
  model.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(model, true)
  const k = 72 / Math.max(box.max.y - box.min.y, 1e-6)
  model.scale.multiplyScalar(k)
  model.position.y = -box.min.y * k
  root.add(model)
  const tinted = []
  model.traverse((o) => {
    if (!o.isMesh) return
    o.castShadow = true
    o.frustumCulled = false
    if (o.material.name === 'Character_Main') { o.material = o.material.clone(); tinted.push(o.material) }
  })
  const setColor = (c) => { for (const m of tinted) m.color.set(c).multiplyScalar(0.6) }
  setColor(color)
  const mixer = new THREE.AnimationMixer(model)
  const act = {}
  for (const clip of assets.player.animations) {
    const name = clip.name.split('|').pop()
    act[name] = mixer.clipAction(clip)
    act[name].play()
    act[name].weight = 0
  }
  if (act.Death) { act.Death.setLoop(THREE.LoopOnce); act.Death.clampWhenFinished = true }
  if (act.Idle_Shoot) { act.Idle_Shoot.time = 0.1; act.Idle_Shoot.paused = true } // frozen = aiming stance
  const pick = (...names) => names.find((n) => act[n])
  const held = []
  let heldW = -1, state = ''

  function hold(w) {
    if (!held[w] && assets.weapons[w]) {
      const node = model.getObjectByName(HAND_NODE[w])
      if (node) {
        const g = new THREE.Group()
        assets.weapons[w].traverse((o) => {
          if (!o.isMesh) return
          const m = new THREE.Mesh(o.geometry, o.material)
          m.castShadow = true
          g.add(m)
        })
        if (w === 4) g.rotation.z = Math.PI // this file's barrel points the other way
        node.add(g)
        root.updateMatrixWorld(true)
        const size = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3())
        g.scale.multiplyScalar(HELD_LEN[w] / Math.max(size.x, size.y, size.z))
        held[w] = g
      }
    }
    held.forEach((g, i) => { if (g) g.visible = i === w })
    heldW = held[w] || w >= HAND_NODE.length ? w : -1
  }

  return {
    root, setColor,
    animate(dt, r, speed) {
      root.rotation.set(0, r.yaw, 0)
      if (heldW !== r.w) hold(r.w)
      let want
      if (!r.alive) want = pick('Death')
      else if (!r.ground) want = pick('Jump_Idle', 'Run_Gun')
      else if (r.duck) want = pick('Duck', 'Idle_Shoot')
      else if (speed > 40) want = pick('Run_Gun', 'Run')
      else want = pick('Idle_Shoot', 'Idle')
      if (want !== state) {
        state = want
        if (want === 'Death') { act.Death.reset(); act.Death.play() }
      }
      const kf = Math.min(1, dt * 12)
      for (const n in act) act[n].weight += ((n === state ? 1 : 0) - act[n].weight) * (n === 'Death' && state === 'Death' ? 1 : kf)
      if (act.Run_Gun) act.Run_Gun.timeScale = Math.max(0.4, speed / 230)
      mixer.update(dt)
      if (headB) headB.scale.copy(headBase).multiplyScalar(HEAD_SCALE)
    },
  }
}

export function createActors(scene) {
  const remotes = new Map()

  function get(id) {
    let r = remotes.get(id)
    if (!r) {
      const body = assets.player ? buildRig(0x777777) : buildBody(0x777777)
      scene.add(body.root)
      r = { id, body, buf: [], offset: null, viewTick: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, alive: false, duck: 0, ground: 1, w: 3,
        team: 0, colorKey: -1, hidden: false, walk: 0, duckVis: 0, fall: 0, lastX: 0, lastZ: 0, stepDist: 0, rigged: !!assets.player }
      remotes.set(id, r)
      if (!assets.player) {
        // swap the placeholder for the real model once it has loaded
        assets.waiting.push(() => {
          const cur = remotes.get(id)
          if (!cur || !assets.player || cur.rigged) return
          scene.remove(cur.body.root)
          cur.body = buildRig(0x777777)
          cur.rigged = true; cur.colorKey = -1
          scene.add(cur.body.root)
        })
      }
    }
    return r
  }

  return {
    remotes,
    /** rows from the server snapshot: [id, tick, x, y, z, yaw, pitch, flags, w, tp, team] */
    onSnapshot(rows, now) {
      const live = new Set()
      for (const a of rows) {
        live.add(a[0])
        const r = get(a[0])
        r.team = a[10] || 0
        const last = r.buf[r.buf.length - 1]
        if (last && a[1] <= last.tick) continue
        r.buf.push({ tick: a[1], x: a[2], y: a[3], z: a[4], yaw: a[5], pitch: a[6], flags: a[7], w: a[8], tp: a[9] })
        if (r.buf.length > 64) r.buf.shift()
        // map this player's command clock onto our clock; follow the least-delayed packets
        const sample = a[1] * 1000 / TICK - now
        if (r.offset === null || sample > r.offset || sample < r.offset - 500) r.offset = sample
        else r.offset += (sample - r.offset) * 0.02
      }
      for (const [id, r] of remotes) if (!live.has(id)) { scene.remove(r.body.root); remotes.delete(id) }
    },
    update(dt, now, onStep) {
      for (const r of remotes.values()) {
        const b = r.buf
        if (!b.length) { r.body.root.visible = false; continue }
        let t = (now + r.offset) * TICK / 1000 - INTERP_TICKS
        const newest = b[b.length - 1]
        if (t > newest.tick) t = newest.tick
        if (t < b[0].tick) t = b[0].tick
        r.viewTick = t
        let i = b.length - 1
        while (i > 0 && b[i - 1].tick > t) i--
        const p1 = b[i], p0 = i > 0 ? b[i - 1] : p1
        let f = p1.tick === p0.tick ? 1 : (t - p0.tick) / (p1.tick - p0.tick)
        if (p0.tp !== p1.tp) f = 1
        f = Math.min(Math.max(f, 0), 1)
        r.x = p0.x + (p1.x - p0.x) * f; r.y = p0.y + (p1.y - p0.y) * f; r.z = p0.z + (p1.z - p0.z) * f
        let dy = p1.yaw - p0.yaw
        dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2
        r.yaw = p0.yaw + dy * f
        r.pitch = p0.pitch + (p1.pitch - p0.pitch) * f
        const flags = f < 0.5 ? p0.flags : p1.flags
        r.alive = !!(flags & 1); r.duck = (flags & 2) ? 1 : 0; r.ground = (flags & 4) ? 1 : 0; r.w = p1.w

        const key = r.team ? TEAM_COLORS[r.team] : ID_COLORS[r.id % ID_COLORS.length]
        if (r.colorKey !== key) { r.body.setColor(key); r.colorKey = key }
        const moved = Math.hypot(r.x - r.lastX, r.z - r.lastZ)
        const speed = dt > 0 ? moved / dt : 0
        r.lastX = r.x; r.lastZ = r.z
        if (r.alive && r.ground && moved < 40) {
          r.walk += moved * 0.07
          if (speed > 150) { r.stepDist += moved; if (r.stepDist > 85) { r.stepDist = 0; onStep(r) } }
        }
        r.duckVis += (r.duck - r.duckVis) * Math.min(1, dt * 14)
        r.fall += ((r.alive ? 0 : 1) - r.fall) * Math.min(1, dt * (r.alive ? 30 : 7))
        r.body.root.visible = !r.hidden
        r.body.root.position.set(r.x, r.y, r.z)
        r.body.animate(dt, r, speed)
      }
    },
    viewTicks() {
      const v = {}
      for (const r of remotes.values()) v[r.id] = Math.round(r.viewTick * 100) / 100
      return v
    },
  }
}

function softDot(inner, outer) {
  const c = document.createElement('canvas'); c.width = c.height = 64
  const g = c.getContext('2d')
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  gr.addColorStop(0, inner); gr.addColorStop(1, outer)
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

export function createEffects(scene, world) {
  // tracers
  const tracers = []
  const tracerGeo = new THREE.CylinderGeometry(0.35, 0.35, 1, 5, 1, true)
  tracerGeo.rotateX(Math.PI / 2)
  const up = new THREE.Vector3(0, 0, 1)
  // bullet holes
  const holeTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64
    const g = c.getContext('2d')
    const gr = g.createRadialGradient(32, 32, 2, 32, 32, 30)
    gr.addColorStop(0, 'rgba(0,0,0,.95)'); gr.addColorStop(0.3, 'rgba(15,12,10,.8)'); gr.addColorStop(0.6, 'rgba(40,35,30,.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64)
    return new THREE.CanvasTexture(c)
  })()
  const holeMat = new THREE.MeshBasicMaterial({ map: holeTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 })
  const holeGeo = new THREE.PlaneGeometry(5, 5)
  const holes = []
  let holeI = 0
  // particles: small soft dots (round, not squares)
  const MAXP = 1000
  const pPos = new Float32Array(MAXP * 3), pCol = new Float32Array(MAXP * 3)
  const pVel = new Float32Array(MAXP * 3), pLife = new Float32Array(MAXP)
  const pGeo = new THREE.BufferGeometry()
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3))
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3))
  const points = new THREE.Points(pGeo, new THREE.PointsMaterial({
    size: 2.4, map: softDot('rgba(255,255,255,1)', 'rgba(255,255,255,0)'), vertexColors: true, transparent: true, alphaTest: 0.08, depthWrite: false,
  }))
  points.frustumCulled = false
  scene.add(points)
  let pI = 0
  for (let i = 0; i < MAXP; i++) pPos[i * 3 + 1] = -9999

  function burst(x, y, z, nx, ny, nz, n, r, g, b, spd, life = 1) {
    for (let k = 0; k < n; k++) {
      const i = pI; pI = (pI + 1) % MAXP
      pPos[i * 3] = x; pPos[i * 3 + 1] = y; pPos[i * 3 + 2] = z
      pVel[i * 3] = (nx + (Math.random() - 0.5) * 1.3) * spd * Math.random()
      pVel[i * 3 + 1] = (ny + (Math.random() - 0.3) * 1.3) * spd * Math.random()
      pVel[i * 3 + 2] = (nz + (Math.random() - 0.5) * 1.3) * spd * Math.random()
      const s = 0.7 + Math.random() * 0.3
      pCol[i * 3] = r * s; pCol[i * 3 + 1] = g * s; pCol[i * 3 + 2] = b * s
      pLife[i] = (0.35 + Math.random() * 0.3) * life
    }
  }

  // fireballs / flashes
  const glowTex = softDot('rgba(255,235,190,1)', 'rgba(255,120,20,0)')
  const glows = []
  function glow(x, y, z, from, to, time, color) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }))
    s.position.set(x, y, z)
    scene.add(s)
    const light = new THREE.PointLight(color, to * 6, to * 5, 1)
    light.position.set(x, y + 20, z)
    scene.add(light)
    glows.push({ s, light, from, to, time, age: 0, peak: to * 6 })
  }

  // grenades in flight
  const nades = []
  const nadeGeo = new THREE.SphereGeometry(3, 10, 8)
  const nadeMat = { 5: 0x3a4a2a, 6: 0xb9bdc2, 7: 0x5e6a72 }
  // smoke clouds
  const smokeTex = softDot('rgba(255,255,255,0.9)', 'rgba(255,255,255,0)')
  const smokes = []

  // the bomb (dropped or planted)
  const bomb = new THREE.Group()
  {
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.6, metalness: 0.3 })
    const body = new THREE.Mesh(new THREE.BoxGeometry(16, 5, 22), dark)
    body.position.y = 2.5; body.castShadow = true
    const pad = new THREE.Mesh(new THREE.BoxGeometry(9, 1.2, 9), new THREE.MeshStandardMaterial({ color: 0x8c8f93, roughness: 0.4 }))
    pad.position.set(-1, 5.4, 3)
    const sticks = new THREE.Mesh(new THREE.BoxGeometry(14, 3.4, 8), new THREE.MeshStandardMaterial({ color: 0x9a3524, roughness: 0.8 }))
    sticks.position.set(0, 6.2, -6)
    bomb.add(body, pad, sticks)
  }
  const bombLamp = new THREE.Mesh(new THREE.SphereGeometry(1.6, 10, 8), new THREE.MeshBasicMaterial({ color: 0x551111 }))
  bombLamp.position.set(5, 6.4, 5)
  bomb.add(bombLamp)
  const bombGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot('rgba(255,60,40,1)', 'rgba(255,0,0,0)'), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }))
  bombGlow.scale.set(26, 26, 1)
  bombGlow.position.copy(bombLamp.position)
  bomb.add(bombGlow)
  bomb.visible = false
  scene.add(bomb)
  let blinkT = 0, bombDefused = false

  return {
    tracer(ox, oy, oz, hx, hy, hz) {
      const d = new THREE.Vector3(hx - ox, hy - oy, hz - oz)
      const len = d.length()
      if (len < 60) return
      const m = new THREE.Mesh(tracerGeo, new THREE.MeshBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }))
      m.position.set((ox + hx) / 2, (oy + hy) / 2, (oz + hz) / 2)
      m.quaternion.setFromUnitVectors(up, d.normalize())
      m.scale.set(1, 1, len)
      scene.add(m)
      tracers.push({ m, life: 0.07 })
    },
    impact(x, y, z, nx, ny, nz) {
      let h = holes[holeI]
      if (!h) { h = new THREE.Mesh(holeGeo, holeMat); scene.add(h); holes[holeI] = h }
      holeI = (holeI + 1) % 160
      h.position.set(x + nx * 0.15, y + ny * 0.15, z + nz * 0.15)
      h.lookAt(x + nx * 10, y + ny * 10, z + nz * 10)
      h.rotateZ(Math.random() * 6.28)
      burst(x, y, z, nx, ny, nz, 9, 0.75, 0.7, 0.62, 130)
    },
    blood(x, y, z) { burst(x, y, z, 0, 0.4, 0, 14, 0.65, 0.03, 0.03, 110) },
    explosion(x, y, z, big) {
      burst(x, y + 12, z, 0, 0.8, 0, big ? 220 : 70, 1.0, 0.55, 0.12, big ? 900 : 420, big ? 2.2 : 1.3)
      burst(x, y + 12, z, 0, 1, 0, big ? 160 : 50, 0.22, 0.2, 0.18, big ? 650 : 320, big ? 3 : 1.8)
      glow(x, y + 30, z, big ? 200 : 80, big ? 1300 : 420, big ? 0.7 : 0.35, 0xffb060)
    },
    flashPop(x, y, z) { glow(x, y + 8, z, 60, 380, 0.22, 0xffffff) },
    smoke(x, y, z) {
      const g = new THREE.Group()
      g.position.set(x, y, z)
      const puffs = []
      for (let i = 0; i < 26; i++) {
        const m = new THREE.SpriteMaterial({ map: smokeTex, color: 0xb4b8bb, transparent: true, opacity: 0, depthWrite: false, rotation: Math.random() * 6.28 })
        const s = new THREE.Sprite(m)
        const a = Math.random() * 6.28, r = Math.sqrt(Math.random()) * 95
        s.position.set(Math.cos(a) * r, 20 + Math.random() * 110, Math.sin(a) * r)
        const sc = 150 + Math.random() * 90
        s.scale.set(sc, sc, 1)
        g.add(s)
        puffs.push({ m, spin: (Math.random() - 0.5) * 0.3 })
      }
      scene.add(g)
      smokes.push({ g, puffs, age: 0 })
    },
    nadeAdd(owner, w, o, v) {
      const mesh = new THREE.Mesh(nadeGeo, new THREE.MeshStandardMaterial({ color: nadeMat[w] || 0x444444, roughness: 0.6 }))
      mesh.castShadow = true
      scene.add(mesh)
      nades.push({ owner, w, mesh, age: 0, acc: 0, seen: 0, n: { x: o[0], y: o[1], z: o[2], vx: v[0], vy: v[1], vz: v[2] } })
    },
    nadeRemove(owner, w) {
      const i = nades.findIndex((n) => n.owner === owner && n.w === w)
      if (i >= 0) { scene.remove(nades[i].mesh); nades.splice(i, 1) }
    },
    clearRound() {
      for (const n of nades) scene.remove(n.mesh)
      nades.length = 0
      for (const s of smokes) { scene.remove(s.g); for (const p of s.puffs) p.m.dispose() }
      smokes.length = 0
      for (const h of holes) if (h) h.position.y = -9999
    },
    /** b = server bomb tuple [state, x, y, z, ...] or null */
    setBomb(b) {
      const show = !!b && (b[0] === 2 || b[0] === 3 || b[0] === 4)
      bomb.visible = show
      if (show) bomb.position.set(b[1], b[2], b[3])
      bombDefused = !!b && b[0] === 4
      if (bombDefused) bombLamp.material.color.set(0x25c040)
    },
    bombBlink() { blinkT = 0.12 },
    update(dt, onBounce) {
      for (let i = tracers.length - 1; i >= 0; i--) {
        const t = tracers[i]
        t.life -= dt
        t.m.material.opacity = Math.max(0, t.life / 0.07) * 0.55
        if (t.life <= 0) { scene.remove(t.m); t.m.material.dispose(); tracers.splice(i, 1) }
      }
      for (let i = 0; i < MAXP; i++) {
        if (pLife[i] <= 0) continue
        pLife[i] -= dt
        if (pLife[i] <= 0) { pPos[i * 3 + 1] = -9999; continue }
        pVel[i * 3 + 1] -= 500 * dt
        pPos[i * 3] += pVel[i * 3] * dt; pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt; pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt
      }
      pGeo.attributes.position.needsUpdate = true
      pGeo.attributes.color.needsUpdate = true

      for (let i = glows.length - 1; i >= 0; i--) {
        const g = glows[i]
        g.age += dt
        const k = Math.min(g.age / g.time, 1)
        const sc = g.from + (g.to - g.from) * Math.sqrt(k)
        g.s.scale.set(sc, sc, 1)
        g.s.material.opacity = 1 - k
        g.light.intensity = g.peak * (1 - k)
        if (k >= 1) { scene.remove(g.s); scene.remove(g.light); g.s.material.dispose(); glows.splice(i, 1) }
      }

      for (let i = nades.length - 1; i >= 0; i--) {
        const e = nades[i]
        e.age += dt
        e.acc += dt
        let steps = 0
        while (e.acc >= 1 / TICK && steps++ < 40) { e.acc -= 1 / TICK; stepNade(e.n, world, 1 / TICK) }
        if ((e.n.bounces || 0) > e.seen) { e.seen = e.n.bounces; onBounce(e.n) }
        e.mesh.position.set(e.n.x, e.n.y + 3, e.n.z)
        e.mesh.rotation.x += dt * 9
        if (e.age > 4) { scene.remove(e.mesh); nades.splice(i, 1) }
      }

      const life = SMOKE_MS / 1000
      for (let i = smokes.length - 1; i >= 0; i--) {
        const s = smokes[i]
        s.age += dt
        const k = Math.max(0, Math.min(1, s.age / 1.2) * Math.min(1, (life - s.age) / 2.5))
        for (const p of s.puffs) { p.m.opacity = 0.62 * k; p.m.rotation += p.spin * dt }
        if (s.age > life) { scene.remove(s.g); for (const p of s.puffs) p.m.dispose(); smokes.splice(i, 1) }
      }

      if (blinkT > 0) blinkT -= dt
      const lit = blinkT > 0
      bombGlow.material.opacity = lit ? 1 : 0
      if (!bombDefused) bombLamp.material.color.set(lit ? 0xff3020 : 0x551111)
    },
  }
}
