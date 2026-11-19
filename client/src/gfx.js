// Renderer, lighting, sky and the world mesh. All textures are generated in code for now;
// swap `makeMaterials` for real PBR texture sets when assets are available.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js'
import { FOV } from '../../shared/constants.js'

function rng(seed) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
}

function canvasTex(size, draw) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  draw(c.getContext('2d'), size)
  return c
}

function noise(g, n, r, count, alpha, light) {
  for (let i = 0; i < count; i++) {
    const v = light ? 255 : 0
    g.fillStyle = `rgba(${v},${v},${v},${r() * alpha})`
    const s = 1 + r() * 3
    g.fillRect(r() * n, r() * n, s, s)
  }
}

function blotches(g, n, r, count, alpha) {
  for (let i = 0; i < count; i++) {
    const x = r() * n, y = r() * n, rad = 20 + r() * 90
    const gr = g.createRadialGradient(x, y, 0, x, y, rad)
    const dark = r() > 0.5
    gr.addColorStop(0, `rgba(${dark ? '0,0,0' : '255,255,255'},${alpha})`)
    gr.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = gr
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2)
  }
}

const TEX = {
  ground: (g, n) => {
    const r = rng(11)
    g.fillStyle = '#8f8674'; g.fillRect(0, 0, n, n)
    blotches(g, n, r, 40, 0.1)
    noise(g, n, r, 9000, 0.22, false); noise(g, n, r, 5000, 0.16, true)
    g.strokeStyle = 'rgba(40,36,30,.5)'; g.lineWidth = 3
    for (let i = 0; i <= 2; i++) { g.beginPath(); g.moveTo(i * n / 2, 0); g.lineTo(i * n / 2, n); g.moveTo(0, i * n / 2); g.lineTo(n, i * n / 2); g.stroke() }
  },
  concrete: (g, n) => {
    const r = rng(23)
    g.fillStyle = '#a6a8a8'; g.fillRect(0, 0, n, n)
    blotches(g, n, r, 30, 0.09)
    noise(g, n, r, 8000, 0.18, false); noise(g, n, r, 4000, 0.14, true)
    g.strokeStyle = 'rgba(30,30,32,.55)'; g.lineWidth = 4; g.strokeRect(0, 0, n, n)
    g.fillStyle = 'rgba(30,30,32,.6)'
    for (const [x, y] of [[40, 40], [n - 40, 40], [40, n - 40], [n - 40, n - 40]]) { g.beginPath(); g.arc(x, y, 9, 0, 7); g.fill() }
    g.strokeStyle = 'rgba(40,40,40,.35)'; g.lineWidth = 1.5
    for (let i = 0; i < 5; i++) { let x = r() * n, y = r() * n; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 6; k++) { x += (r() - 0.5) * 60; y += r() * 50; g.lineTo(x, y) } g.stroke() }
  },
  brick: (g, n) => {
    const r = rng(37)
    g.fillStyle = '#6a625a'; g.fillRect(0, 0, n, n)
    const rows = 16, bh = n / rows, bw = n / 8
    for (let y = 0; y < rows; y++) for (let x = -1; x < 8; x++) {
      const t = r()
      g.fillStyle = `rgb(${150 + t * 40},${82 + t * 30},${62 + t * 22})`
      g.fillRect(x * bw + (y % 2 ? bw / 2 : 0) + 2, y * bh + 2, bw - 4, bh - 4)
    }
    noise(g, n, r, 9000, 0.2, false); blotches(g, n, r, 25, 0.1)
  },
  crate: (g, n) => {
    const r = rng(41)
    g.fillStyle = '#9a6b38'; g.fillRect(0, 0, n, n)
    for (let i = 0; i < 6; i++) {
      const t = r()
      g.fillStyle = `rgb(${150 + t * 30},${102 + t * 22},${52 + t * 16})`
      g.fillRect(i * n / 6 + 2, 0, n / 6 - 4, n)
    }
    g.strokeStyle = 'rgba(60,35,12,.35)'; g.lineWidth = 1
    for (let i = 0; i < 140; i++) { const x = r() * n; g.beginPath(); g.moveTo(x, r() * n); g.lineTo(x + (r() - 0.5) * 6, r() * n); g.stroke() }
    const f = n * 0.11
    g.fillStyle = '#7d5226'
    g.fillRect(0, 0, n, f); g.fillRect(0, n - f, n, f); g.fillRect(0, 0, f, n); g.fillRect(n - f, 0, f, n)
    g.save(); g.translate(n / 2, n / 2); g.rotate(Math.PI / 4); g.fillRect(-n * 0.62, -f / 2, n * 1.24, f); g.restore()
    g.strokeStyle = 'rgba(30,16,4,.7)'; g.lineWidth = 3; g.strokeRect(f, f, n - 2 * f, n - 2 * f); g.strokeRect(1, 1, n - 2, n - 2)
    noise(g, n, r, 5000, 0.18, false)
  },
  metal: (g, n) => {
    const r = rng(53)
    for (let i = 0; i < 16; i++) {
      const x = i * n / 16
      const gr = g.createLinearGradient(x, 0, x + n / 16, 0)
      gr.addColorStop(0, '#8a8a8a'); gr.addColorStop(0.5, '#f2f2f2'); gr.addColorStop(1, '#7c7c7c')
      g.fillStyle = gr; g.fillRect(x, 0, n / 16 + 1, n)
    }
    blotches(g, n, r, 20, 0.12); noise(g, n, r, 5000, 0.15, false)
    g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, 0, n, 10); g.fillRect(0, n - 10, n, 10)
  },
  building: (g, n) => {
    const r = rng(67)
    g.fillStyle = '#7f8792'; g.fillRect(0, 0, n, n)
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      g.fillStyle = r() > 0.8 ? '#c9d6e2' : '#3c4753'
      g.fillRect(x * n / 8 + 12, y * n / 8 + 14, n / 8 - 24, n / 8 - 26)
    }
  },
}

function makeMaterials(aniso) {
  const mk = (kind, tint, rough, metal, scale, bump) => {
    const c = canvasTex(512, TEX[kind])
    const map = new THREE.CanvasTexture(c)
    map.colorSpace = THREE.SRGBColorSpace
    const bm = new THREE.CanvasTexture(c)
    for (const t of [map, bm]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso }
    const m = new THREE.MeshStandardMaterial({ map, bumpMap: bm, bumpScale: bump, color: tint, roughness: rough, metalness: metal })
    m.userData.scale = scale
    return m
  }
  const mats = {
    ground: mk('ground', 0xffffff, 0.95, 0, 170, 1.5),
    concrete: mk('concrete', 0xffffff, 0.9, 0, 180, 1.5),
    brick: mk('brick', 0xffffff, 0.88, 0, 150, 3),
    crate: mk('crate', 0xffffff, 0.8, 0, 0, 2),
    metalBlue: mk('metal', 0x2f5f9e, 0.55, 0.5, 120, 3),
    metalRed: mk('metal', 0xa43a2c, 0.55, 0.5, 120, 3),
    building: mk('building', 0xffffff, 0.9, 0, 400, 0),
  }
  // Photo textures from client/public/textures/<set>/ replace the generated ones as they load.
  const SETS = { ground: ['ground', [2.1, 1.95, 1.85]], concrete: ['concrete', 0xffffff], brick: ['brick', 0xffffff],
    crate: ['wood', 0xffffff], metalBlue: ['metal', 0x6f9fe0], metalRed: ['metal', 0xe07a66] }
  const loader = new THREE.TextureLoader()
  const cache = {}
  const load = (set, file, srgb) => new Promise((res, rej) => {
    const key = set + '/' + file
    if (cache[key]) return res(cache[key])
    loader.load(`/textures/${key}.jpg`, (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso
      if (srgb) t.colorSpace = THREE.SRGBColorSpace
      cache[key] = t; res(t)
    }, undefined, rej)
  })
  for (const [name, [set, tint]] of Object.entries(SETS)) {
    Promise.all([load(set, 'color', true), load(set, 'normal', false), load(set, 'roughness', false)]).then(([c, n, r]) => {
      const m = mats[name]
      m.map = c; m.normalMap = n; m.roughnessMap = r; m.bumpMap = null
      m.roughness = 1; m.metalness = set === 'metal' ? 0.35 : 0
      if (Array.isArray(tint)) m.color.setRGB(...tint); else m.color.set(tint)
      m.needsUpdate = true
    }).catch(() => console.warn('texture set missing, keeping generated one:', set))
  }
  return mats
}

function boxGeo(b, scale) {
  const w = b.x1 - b.x0, h = b.y1 - b.y0, d = b.z1 - b.z0
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2)
  if (scale > 0) {
    const uv = g.attributes.uv
    // face order: +x, -x, +y, -y, +z, -z (4 verts each)
    const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]]
    for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) {
      const k = f * 4 + i
      uv.setXY(k, uv.getX(k) * dims[f][0] / scale, uv.getY(k) * dims[f][1] / scale)
    }
  }
  return g
}

export function createGfx(canvas, MAP) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.autoClear = false

  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0xc4d2e0, 2000, 7500)
  const camera = new THREE.PerspectiveCamera(FOV, 1, 2, 9000)
  camera.rotation.order = 'YXZ'
  scene.add(camera)

  // sky dome
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(8000, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { sun: { value: new THREE.Vector3(0.48, 0.74, 0.47).normalize() } },
      vertexShader: 'varying vec3 d; void main(){ d = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec3 d; uniform vec3 sun;
        void main(){
          float h = clamp(d.y, 0.0, 1.0);
          vec3 c = mix(vec3(0.80,0.87,0.93), vec3(0.20,0.42,0.78), pow(h, 0.55));
          float s = max(dot(normalize(d), sun), 0.0);
          c += vec3(1.0,0.85,0.6) * (pow(s, 600.0) * 3.0 + pow(s, 12.0) * 0.25);
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  )
  sky.frustumCulled = false
  scene.add(sky)

  const hemi = new THREE.HemisphereLight(0xbcd3ff, 0x7a6a55, 1.15)
  scene.add(hemi)
  const sun = new THREE.DirectionalLight(0xfff0d6, 3.2)
  sun.position.set(980, 1500, 950)
  sun.castShadow = true
  sun.shadow.mapSize.set(4096, 4096)
  const sc = sun.shadow.camera
  sc.left = -2000; sc.right = 2000; sc.top = 2000; sc.bottom = -2000; sc.near = 200; sc.far = 7000
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 1.2
  scene.add(sun)

  // HDR sky: becomes the backdrop and the ambient light; the sun is aimed where the sky's sun is.
  new RGBELoader().setDataType(THREE.FloatType).load('/textures/sky.hdr', (tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping
    const { data, width, height } = tex.image
    let best = -1, bi = 0
    for (let i = 0; i < width * height; i += 3) {
      const l = data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]
      if (l > best) { best = l; bi = i }
    }
    const u = ((bi % width) + 0.5) / width, v = 1 - (Math.floor(bi / width) + 0.5) / height
    let lat = (v - 0.5) * Math.PI
    const lon = (u - 0.5) * Math.PI * 2
    lat = Math.min(Math.max(lat, 0.5), 1.2)
    sun.position.set(Math.cos(lon) * Math.cos(lat), Math.sin(lat), Math.sin(lon) * Math.cos(lat)).multiplyScalar(3200)
    scene.background = tex
    scene.environment = tex
    scene.environmentIntensity = 1.15
    scene.remove(sky)
    hemi.intensity = 0.45
    sun.intensity = 3.0
  }, undefined, () => console.warn('sky.hdr missing, keeping generated sky'))

  const mats = makeMaterials(renderer.capabilities.getMaxAnisotropy())
  // painted bomb-site outlines
  for (const letter of ['A', 'B']) {
    const c = canvasTex(512, (g, n) => {
      g.clearRect(0, 0, n, n)
      const w = 26
      g.save()
      g.beginPath(); g.rect(0, 0, n, n); g.rect(w, w, n - 2 * w, n - 2 * w); g.clip('evenodd')
      g.fillStyle = '#e8b800'; g.fillRect(0, 0, n, n)
      g.fillStyle = '#1a1a1a'
      for (let i = -n; i < n * 2; i += 56) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 28, 0); g.lineTo(i + 28 - n, n); g.lineTo(i - n, n); g.fill() }
      g.restore()
      g.fillStyle = 'rgba(255,255,255,0.5)'
      g.font = 'bold 300px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'
      g.fillText(letter, n / 2, n / 2 + 16)
    })
    const map = new THREE.CanvasTexture(c)
    map.colorSpace = THREE.SRGBColorSpace
    map.anisotropy = renderer.capabilities.getMaxAnisotropy()
    const m = new THREE.MeshStandardMaterial({ map, transparent: true, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2 })
    m.userData.scale = 0
    mats['site' + letter] = m
  }
  const groups = {}
  for (const b of MAP.boxes) (groups[b.mat] ||= []).push(boxGeo(b, mats[b.mat].userData.scale))
  for (const k in groups) {
    const mesh = new THREE.Mesh(mergeGeometries(groups[k]), mats[k])
    mesh.castShadow = mesh.receiveShadow = true
    scene.add(mesh)
  }
  const dg = {}
  for (const b of MAP.decor) (dg[b.mat] ||= []).push(boxGeo(b, mats[b.mat].userData.scale))
  for (const k in dg) {
    const mesh = new THREE.Mesh(mergeGeometries(dg[k]), mats[k])
    mesh.receiveShadow = k === 'ground' || k.startsWith('site')
    if (k.startsWith('site')) mesh.renderOrder = 1
    scene.add(mesh)
  }

  function resize() {
    const w = window.innerWidth, h = window.innerHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  window.addEventListener('resize', resize)
  resize()

  return { renderer, scene, camera, THREE }
}
