// Other players (interpolated on each player's own command timeline) and world effects.
import * as THREE from 'three'
import { TICK } from '../../shared/constants.js'

const COLORS = [0x3d6ea8, 0xa8553d, 0x4f8f4a, 0x8a5aa8, 0xa89a3d, 0x3d9aa8, 0xa83d6e, 0x777777]
const INTERP_TICKS = TICK * 0.06 // 60 ms behind the newest data

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
  mk(new THREE.BoxGeometry(8, 4, 12), dark, legL, 0, -31, -2)
  mk(new THREE.BoxGeometry(8, 4, 12), dark, legR, 0, -31, -2)
  const upper = new THREE.Group()
  upper.position.set(0, 33, 0)
  mk(new THREE.BoxGeometry(19, 25, 11), cloth, upper, 0, 13, 0)
  mk(new THREE.BoxGeometry(20, 12, 12), dark, upper, 0, 16, -0.5) // vest
  const head = new THREE.Group()
  head.position.set(0, 31.5, 0)
  mk(new THREE.SphereGeometry(6.3, 16, 12), skin, head, 0, 0, 0)
  mk(new THREE.SphereGeometry(6.8, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), dark, head, 0, 0.6, 0) // helmet
  upper.add(head)
  const arms = new THREE.Group()
  arms.position.set(0, 21, 0)
  const aR = mk(new THREE.BoxGeometry(5.5, 5.5, 22), cloth, arms, 8.5, -1, -9); aR.rotation.y = 0.2
  const aL = mk(new THREE.BoxGeometry(5.5, 5.5, 24), cloth, arms, -7, -1, -11); aL.rotation.y = -0.45
  mk(new THREE.BoxGeometry(2.6, 5, 34), gunM, arms, 3, 0.5, -24)
  mk(new THREE.BoxGeometry(2.4, 8, 3.5), gunM, arms, 3, -5, -20)
  upper.add(arms)
  root.add(legL, legR, upper)
  return { root, legL, legR, upper, head, arms }
}

export function createActors(scene) {
  const remotes = new Map()

  function get(id) {
    let r = remotes.get(id)
    if (!r) {
      const body = buildBody(COLORS[id % COLORS.length])
      scene.add(body.root)
      r = { id, body, buf: [], offset: null, viewTick: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, alive: false, duck: 0, ground: 1, w: 3,
        walk: 0, duckVis: 0, fall: 0, lastX: 0, lastZ: 0, stepDist: 0, seen: 0 }
      remotes.set(id, r)
    }
    return r
  }

  return {
    remotes,
    /** rows from the server snapshot: [id, tick, x, y, z, yaw, pitch, flags, w, tp] */
    onSnapshot(rows, now) {
      const live = new Set()
      for (const a of rows) {
        live.add(a[0])
        const r = get(a[0])
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

        const body = r.body
        const moved = Math.hypot(r.x - r.lastX, r.z - r.lastZ)
        const speed = dt > 0 ? moved / dt : 0
        r.lastX = r.x; r.lastZ = r.z
        if (r.alive && r.ground && moved < 40) {
          r.walk += moved * 0.07
          if (speed > 150) { r.stepDist += moved; if (r.stepDist > 85) { r.stepDist = 0; onStep(r) } }
        }
        r.duckVis += (r.duck - r.duckVis) * Math.min(1, dt * 14)
        r.fall += ((r.alive ? 0 : 1) - r.fall) * Math.min(1, dt * (r.alive ? 30 : 7))
        body.root.visible = r.alive || r.fall < 0.97
        body.root.position.set(r.x, r.y, r.z)
        body.root.rotation.set(-r.fall * Math.PI / 2, r.yaw, 0, 'YXZ')
        const amp = r.ground ? Math.min(speed / 250, 1) * 0.75 : 0.25
        const sw = Math.sin(r.walk) * amp
        const crouch = r.duckVis
        body.legL.rotation.x = sw - crouch * 1.0; body.legR.rotation.x = -sw - crouch * 0.4
        body.legL.position.y = body.legR.position.y = 33 - crouch * 9
        body.upper.position.y = 33 - crouch * 16
        body.upper.rotation.x = -crouch * 0.25 + r.pitch * 0.25
        body.head.rotation.x = r.pitch * 0.5
        body.arms.rotation.x = r.pitch * 0.6 + crouch * 0.25
      }
    },
    viewTicks() {
      const v = {}
      for (const r of remotes.values()) v[r.id] = Math.round(r.viewTick * 100) / 100
      return v
    },
  }
}

export function createEffects(scene) {
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
  // particles
  const MAXP = 400
  const pPos = new Float32Array(MAXP * 3), pCol = new Float32Array(MAXP * 3)
  const pVel = new Float32Array(MAXP * 3), pLife = new Float32Array(MAXP)
  const pGeo = new THREE.BufferGeometry()
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3))
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3))
  const points = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 3.2, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }))
  points.frustumCulled = false
  scene.add(points)
  let pI = 0
  for (let i = 0; i < MAXP; i++) pPos[i * 3 + 1] = -9999

  function burst(x, y, z, nx, ny, nz, n, r, g, b, spd) {
    for (let k = 0; k < n; k++) {
      const i = pI; pI = (pI + 1) % MAXP
      pPos[i * 3] = x; pPos[i * 3 + 1] = y; pPos[i * 3 + 2] = z
      pVel[i * 3] = (nx + (Math.random() - 0.5) * 1.3) * spd * Math.random()
      pVel[i * 3 + 1] = (ny + (Math.random() - 0.3) * 1.3) * spd * Math.random()
      pVel[i * 3 + 2] = (nz + (Math.random() - 0.5) * 1.3) * spd * Math.random()
      const s = 0.7 + Math.random() * 0.3
      pCol[i * 3] = r * s; pCol[i * 3 + 1] = g * s; pCol[i * 3 + 2] = b * s
      pLife[i] = 0.35 + Math.random() * 0.3
    }
  }

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
      holeI = (holeI + 1) % 120
      h.position.set(x + nx * 0.15, y + ny * 0.15, z + nz * 0.15)
      h.lookAt(x + nx * 10, y + ny * 10, z + nz * 10)
      h.rotateZ(Math.random() * 6.28)
      burst(x, y, z, nx, ny, nz, 10, 0.75, 0.7, 0.62, 130)
    },
    blood(x, y, z) { burst(x, y, z, 0, 0.4, 0, 14, 0.65, 0.03, 0.03, 110) },
    update(dt) {
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
    },
  }
}
