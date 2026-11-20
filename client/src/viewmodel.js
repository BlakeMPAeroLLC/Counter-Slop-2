// First-person weapon rendering: its own scene + camera drawn on top of the world, so the
// gun never clips into walls. Models load from client/public/models/; the primitive guns
// below are only shown while loading or if a file is missing.
//
// MODEL_FIT places each model: `dir` is the axis the barrel points along in the file,
// `len` the on-screen length, `rear`/`top` where the back and top of the gun sit relative
// to the grip, `rot` an extra twist.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { WEAPONS } from '../../shared/constants.js'

export const MODEL_URLS = {
  knife: '/models/knife.glb', pistol: '/models/pistol.glb', smg: '/models/smg.glb',
  rifle: '/models/rifle.glb', sniper: '/models/sniper.glb',
}
export const MODEL_FIT = {
  rifle: { dir: 'x-', len: 0.74, rear: 0.26, top: 0.085, muzzleY: 0.24 },
  smg: { dir: 'x-', len: 0.56, rear: 0.2, top: 0.1, muzzleY: 0.3 },
  pistol: { dir: 'x-', len: 0.19, rear: -0.1, top: 0.06, muzzleY: 0.15 },
  sniper: { dir: 'x+', len: 1.05, rear: 0.3, top: 0.14, muzzleY: 0.45 },
  knife: { dir: 'y+', len: 0.3, rear: 0.06, top: 0.03, muzzleY: 0.5, rot: [0.25, 0.35, 0.5] },
}
const DIR_ROT = { 'x-': [0, -Math.PI / 2, 0], 'x+': [0, Math.PI / 2, 0], 'y+': [-Math.PI / 2, 0, 0], 'z-': [0, 0, 0], 'z+': [0, Math.PI, 0] }

/** Orient, scale and place a loaded model. Returns { object, muzzle }. */
export function fitModel(model, fit) {
  const pivot = new THREE.Group()
  pivot.rotation.set(...DIR_ROT[fit.dir])
  pivot.add(model)
  const wrap = new THREE.Group()
  wrap.add(pivot)
  wrap.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(wrap)
  pivot.scale.setScalar(fit.len / (box.max.z - box.min.z))
  wrap.updateMatrixWorld(true)
  box.setFromObject(wrap)
  const cx = (box.min.x + box.max.x) / 2
  pivot.position.set(-cx, fit.top - box.max.y, fit.rear - box.max.z)
  const h = box.max.y - box.min.y
  return { object: wrap, muzzle: [0, fit.top - h * fit.muzzleY, fit.rear - fit.len - 0.02] }
}

const M = {
  metal: new THREE.MeshStandardMaterial({ color: 0x3a3e44, roughness: 0.38, metalness: 0.8 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.55, metalness: 0.45 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x8a5228, roughness: 0.6, metalness: 0.0 }),
  poly: new THREE.MeshStandardMaterial({ color: 0x3a3f36, roughness: 0.8, metalness: 0.1 }),
  steel: new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.25, metalness: 0.95 }),
  sleeve: new THREE.MeshStandardMaterial({ color: 0x46543a, roughness: 0.9 }),
  glove: new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.85 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x1b3550, roughness: 0.1, metalness: 0.9 }),
}

function box(g, mat, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
  m.position.set(x, y, z); m.rotation.set(rx, ry, rz)
  g.add(m); return m
}
function cyl(g, mat, r, len, x, y, z) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 14), mat)
  m.rotation.x = Math.PI / 2; m.position.set(x, y, z)
  g.add(m); return m
}
function arm(g, x, y, z, rx, ry, len = 0.42) {
  const a = new THREE.Group()
  a.position.set(x, y, z); a.rotation.set(rx, ry, 0)
  box(a, M.glove, 0.05, 0.055, 0.085, 0, 0, -0.01)
  box(a, M.sleeve, 0.075, 0.075, len, 0, -0.005, len / 2 + 0.03)
  g.add(a)
}

function nade(g, color, r) {
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, r * 2.6, 14), new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.3 }))
  body.position.set(0, 0.03, -0.06)
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.45, r * 0.45, r * 0.9, 10), M.steel)
  cap.position.set(0, 0.03 + r * 1.7, -0.06)
  g.add(body, cap)
  box(g, M.glove, 0.06, 0.06, 0.09, 0, 0, -0.03)
  box(g, M.sleeve, 0.075, 0.075, 0.42, 0.03, -0.05, 0.2, 0.25, 0.2)
  return [0, 0.03, -0.1]
}

const BUILD = {
  rifle(g) {
    box(g, M.metal, 0.042, 0.062, 0.3, 0, 0.03, -0.1)
    box(g, M.dark, 0.036, 0.016, 0.26, 0, 0.068, -0.1)
    box(g, M.wood, 0.05, 0.05, 0.2, 0, 0.022, -0.34)
    cyl(g, M.metal, 0.011, 0.26, 0, 0.036, -0.56)
    cyl(g, M.metal, 0.008, 0.2, 0, 0.062, -0.42)
    cyl(g, M.dark, 0.016, 0.05, 0, 0.036, -0.69)
    box(g, M.dark, 0.008, 0.045, 0.012, 0, 0.075, -0.6)
    box(g, M.dark, 0.03, 0.02, 0.02, 0, 0.082, -0.02)
    box(g, M.metal, 0.034, 0.17, 0.062, 0, -0.07, -0.16, 0.38)
    box(g, M.wood, 0.036, 0.1, 0.044, 0, -0.045, 0.02, -0.35)
    box(g, M.wood, 0.04, 0.085, 0.24, 0, 0.0, 0.17, -0.1)
    box(g, M.dark, 0.042, 0.1, 0.02, 0, -0.015, 0.295, -0.1)
    arm(g, 0.0, -0.06, 0.03, 0.35, 0.4)
    arm(g, -0.01, -0.02, -0.34, 0.30000000000000004, -0.68, 0.5)
    return [0, 0.036, -0.72]
  },
  smg(g) {
    box(g, M.poly, 0.046, 0.075, 0.3, 0, 0.03, -0.12)
    box(g, M.dark, 0.03, 0.012, 0.24, 0, 0.074, -0.12)
    cyl(g, M.metal, 0.013, 0.1, 0, 0.038, -0.32)
    cyl(g, M.dark, 0.02, 0.12, 0, 0.038, -0.4)
    box(g, M.dark, 0.03, 0.19, 0.04, 0, -0.1, -0.15, 0.08)
    box(g, M.poly, 0.036, 0.1, 0.045, 0, -0.045, 0.0, -0.3)
    box(g, M.dark, 0.016, 0.02, 0.2, 0, 0.05, 0.12)
    box(g, M.dark, 0.04, 0.09, 0.02, 0, 0.02, 0.22)
    box(g, M.poly, 0.03, 0.06, 0.03, 0, -0.03, -0.27)
    arm(g, 0.0, -0.06, 0.02, 0.35, 0.4)
    arm(g, -0.01, -0.07, -0.27, 0.25, -0.72, 0.5)
    return [0, 0.038, -0.47]
  },
  pistol(g) {
    box(g, M.steel, 0.032, 0.04, 0.2, 0, 0.05, -0.09)
    box(g, M.dark, 0.03, 0.028, 0.17, 0, 0.018, -0.075)
    box(g, M.dark, 0.032, 0.11, 0.05, 0, -0.04, 0.0, -0.22)
    cyl(g, M.metal, 0.008, 0.02, 0, 0.05, -0.195)
    box(g, M.dark, 0.006, 0.012, 0.01, 0, 0.076, -0.18)
    box(g, M.dark, 0.02, 0.012, 0.01, 0, 0.076, 0.0)
    arm(g, 0.0, -0.045, 0.02, 0.22, 0.26)
    arm(g, -0.03, -0.06, 0.01, 0.22, -0.6, 0.46)
    return [0, 0.05, -0.21]
  },
  sniper(g) {
    box(g, M.poly, 0.046, 0.07, 0.38, 0, 0.03, -0.12)
    cyl(g, M.metal, 0.012, 0.5, 0, 0.045, -0.56)
    cyl(g, M.dark, 0.02, 0.09, 0, 0.045, -0.84)
    cyl(g, M.dark, 0.027, 0.3, 0, 0.115, -0.12)
    cyl(g, M.dark, 0.034, 0.06, 0, 0.115, -0.29)
    cyl(g, M.dark, 0.032, 0.05, 0, 0.115, 0.05)
    cyl(g, M.glass, 0.03, 0.004, 0, 0.115, 0.077)
    box(g, M.dark, 0.016, 0.03, 0.03, 0, 0.085, -0.2)
    box(g, M.dark, 0.016, 0.03, 0.03, 0, 0.085, -0.04)
    box(g, M.dark, 0.034, 0.09, 0.07, 0, -0.045, -0.14)
    box(g, M.poly, 0.036, 0.1, 0.045, 0, -0.045, 0.04, -0.3)
    box(g, M.poly, 0.044, 0.1, 0.28, 0, 0.005, 0.21, -0.06)
    cyl(g, M.steel, 0.007, 0.05, 0.04, 0.05, 0.0).rotation.set(0, 0, Math.PI / 2)
    arm(g, 0.0, -0.06, 0.05, 0.35, 0.4)
    arm(g, -0.01, -0.03, -0.3, 0.30000000000000004, -0.68, 0.5)
    return [0, 0.045, -0.89]
  },
  he(g) { return nade(g, 0x3a4a2a, 0.034) },
  flash(g) { return nade(g, 0xb9bdc2, 0.028) },
  smoke(g) { return nade(g, 0x5e6a72, 0.03) },
  knife(g) {
    box(g, M.dark, 0.026, 0.034, 0.11, 0, 0, 0.0)
    box(g, M.metal, 0.012, 0.06, 0.016, 0, 0, -0.06)
    box(g, M.steel, 0.005, 0.042, 0.2, 0, 0.004, -0.17)
    box(g, M.steel, 0.005, 0.03, 0.05, 0, -0.004, -0.285, 0.32)
    arm(g, 0.0, -0.01, 0.03, 0.2, 0.2)
    g.rotation.set(0.25, 0.35, 0.5)
    return [0, 0, -0.3]
  },
}

function flashTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128
  const g = c.getContext('2d')
  g.translate(64, 64)
  for (let i = 0; i < 7; i++) {
    g.rotate(Math.PI * 2 / 7 + (i % 2) * 0.3)
    const gr = g.createLinearGradient(0, 0, 60, 0)
    gr.addColorStop(0, 'rgba(255,240,190,1)'); gr.addColorStop(1, 'rgba(255,150,40,0)')
    g.fillStyle = gr
    g.beginPath(); g.moveTo(0, -7); g.lineTo(56 - (i % 3) * 12, 0); g.lineTo(0, 7); g.fill()
  }
  const core = g.createRadialGradient(0, 0, 0, 0, 0, 30)
  core.addColorStop(0, 'rgba(255,255,235,1)'); core.addColorStop(1, 'rgba(255,200,90,0)')
  g.fillStyle = core; g.fillRect(-64, -64, 128, 128)
  return new THREE.CanvasTexture(c)
}

export function createViewModel(renderer) {
  const scene = new THREE.Scene()
  // soft studio reflections so metal reads as metal
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environmentIntensity = 0.7
  pmrem.dispose()
  const camera = new THREE.PerspectiveCamera(54, 1, 0.01, 10)
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x6b5d4a, 0.9))
  const key = new THREE.DirectionalLight(0xfff0d6, 2.6)
  key.position.set(0.6, 1, 0.5)
  scene.add(key)
  const flashLight = new THREE.PointLight(0xffc070, 0, 3)
  scene.add(flashLight)

  const root = new THREE.Group()
  scene.add(root)
  const guns = WEAPONS.map((W) => {
    const g = new THREE.Group()
    const inner = new THREE.Group()
    g.add(inner)
    const muzzle = new THREE.Vector3(...BUILD[W.id](inner))
    g.visible = false
    root.add(g)
    const url = MODEL_URLS[W.id], fit = MODEL_FIT[W.id]
    if (url && fit) {
      new GLTFLoader().load(url, (gltf) => {
        const f = fitModel(gltf.scene, fit)
        inner.clear()
        inner.rotation.set(...(fit.rot || [0, 0, 0]))
        inner.add(f.object)
        muzzle.set(...f.muzzle)
      }, undefined, (e) => console.warn('weapon model failed to load, using placeholder', url, e))
    }
    return { g, muzzle }
  })

  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTexture(), blending: THREE.AdditiveBlending, depthTest: false, transparent: true }))
  flash.visible = false
  root.add(flash)

  const BASE = new THREE.Vector3(0.15, -0.165, -0.46)
  let cur = -1, flashT = 0, kick = 0, kickRot = 0, swayX = 0, swayY = 0, bobPhase = 0, bobAmp = 0, landY = 0, knifeSwing = 0

  return {
    scene, camera,
    resize(aspect) { camera.aspect = aspect; camera.updateProjectionMatrix() },
    fire(w) {
      if (w === 0 || w > 4) { knifeSwing = 1; return }
      kick = Math.min(kick + (w === 4 ? 0.09 : 0.035), 0.12)
      kickRot = Math.min(kickRot + (w === 4 ? 0.16 : 0.05), 0.2)
      flashT = 0.045
      flash.material.rotation = Math.random() * 6.28
      flash.scale.setScalar(w === 4 ? 0.34 : 0.2 + Math.random() * 0.06)
    },
    addSway(dx, dy) { swayX += dx; swayY += dy },
    land(v) { landY = Math.min(landY + v, 0.05) },
    /** s: predicted player state, tickAlpha: fractional tick, speed: ground speed (u/s) */
    update(dt, s, tickAlpha, speed) {
      if (s.w !== cur) { if (cur >= 0) guns[cur].g.visible = false; cur = s.w; guns[cur].g.visible = true }
      const W = WEAPONS[cur]
      const gun = guns[cur].g
      const tick = s.tick + tickAlpha
      root.visible = !!s.alive && !s.zoom

      // springs
      kick *= Math.exp(-dt * 16); kickRot *= Math.exp(-dt * 13); landY *= Math.exp(-dt * 9)
      const k = Math.exp(-dt * 11)
      swayX *= k; swayY *= k
      const sx = Math.max(-1, Math.min(1, swayX * 0.004)), sy = Math.max(-1, Math.min(1, swayY * 0.004))

      // bob
      const target = s.ground ? Math.min(speed / 250, 1) : 0
      bobAmp += (target - bobAmp) * Math.min(1, dt * 9)
      bobPhase += dt * (5.5 + speed * 0.022)
      const bx = Math.sin(bobPhase) * 0.0055 * bobAmp
      const by = -Math.abs(Math.cos(bobPhase)) * 0.005 * bobAmp + 0.0025 * bobAmp

      // draw + reload
      let lower = 0, tilt = 0
      const drawLeft = s.drawEnd - tick
      if (drawLeft > 0) { const f = drawLeft / W.draw; lower = f * f }
      if (s.reloadEnd) {
        const f = 1 - (s.reloadEnd - tick) / W.reload
        const e = Math.sin(Math.min(Math.max(f, 0), 1) * Math.PI)
        lower = Math.max(lower, Math.pow(e, 0.6) * 0.55); tilt = Math.pow(e, 0.6) * 0.5
      }
      knifeSwing *= Math.exp(-dt * 9)

      gun.position.set(
        BASE.x + bx - sx * 0.012 - knifeSwing * 0.09,
        BASE.y + by + sy * 0.01 - lower * 0.22 - landY - s.vy * 0.00003,
        BASE.z + kick - bobAmp * 0.008 - knifeSwing * 0.1,
      )
      gun.rotation.set(
        kickRot * 0.9 - lower * 0.9 + sy * 0.03 + knifeSwing * -0.5,
        0.035 - sx * 0.05 + knifeSwing * 0.9,
        tilt - sx * 0.06 + bx * 2,
      )

      if (flashT > 0) {
        flashT -= dt
        flash.visible = true
        gun.updateMatrix()
        flash.position.copy(guns[cur].muzzle).applyMatrix4(gun.matrix)
        flashLight.position.copy(flash.position)
        flashLight.intensity = 1.2
      } else { flash.visible = false; flashLight.intensity = 0 }
    },
  }
}
