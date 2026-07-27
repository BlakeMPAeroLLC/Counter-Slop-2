/**
 * Rendering.
 *
 * The visual system is the flat-shaded, palette-locked one from docs/PLAN.md §8, established
 * now rather than retrofitted: one material family, no PBR, no textures, team identity
 * carried by hue. That is a production strategy as much as an aesthetic — it means no
 * material authoring, no lightmap bake, and enemies that read instantly against walls.
 *
 * Simulation units are used directly (1 unit ~ 1 inch, player 72 tall). No scaling, so
 * nothing has to be converted between the sim and the scene.
 */

import * as THREE from 'three'
import { MATERIAL, MOVE, PFLAG, PLAYER, SIM, type MapData, type World } from '@cs2/sim'

/** The beginnings of the locked 12-colour palette. */
const PALETTE = {
  sky: 0x1a1e27,
  fog: 0x1a1e27,
  concrete: 0x6e7385,
  metal: 0x8b93a8,
  wood: 0xb9834f,
  dirt: 0x7a6a52,
  wreckers: 0xff8b3d,
  wardens: 0x2fd3c4,
  head: 0xf2f4f8,
  tracer: 0xffe9a8,
  impact: 0xffd166,
} as const

const MATERIAL_COLOR: Record<number, number> = {
  [MATERIAL.CONCRETE]: PALETTE.concrete,
  [MATERIAL.METAL]: PALETTE.metal,
  [MATERIAL.WOOD]: PALETTE.wood,
  [MATERIAL.DIRT]: PALETTE.dirt,
}

interface PlayerVisual {
  group: THREE.Group
  body: THREE.Mesh
  head: THREE.Mesh
}

interface Tracer {
  line: THREE.Line
  born: number
}

const TRACER_LIFETIME_MS = 90
const IMPACT_LIFETIME_MS = 400

export class Renderer {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  private readonly renderer: THREE.WebGLRenderer

  private readonly players: (PlayerVisual | null)[] = new Array<PlayerVisual | null>(
    SIM.MAX_PLAYERS,
  ).fill(null)

  private readonly tracers: Tracer[] = []
  private readonly impacts: { mesh: THREE.Mesh; born: number }[] = []

  private readonly teamMaterials: THREE.MeshLambertMaterial[]
  private readonly headMaterial: THREE.MeshLambertMaterial
  private readonly deadMaterial: THREE.MeshLambertMaterial
  private readonly tracerMaterial: THREE.LineBasicMaterial
  private readonly impactMaterial: THREE.MeshBasicMaterial
  private readonly impactGeometry = new THREE.SphereGeometry(2.5, 6, 4)

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

    this.scene.background = new THREE.Color(PALETTE.sky)
    this.scene.fog = new THREE.Fog(PALETTE.fog, 1200, 3400)

    this.camera = new THREE.PerspectiveCamera(
      90, // Wide FOV. Competitive shooters live at 90+; 75 feels claustrophobic.
      1,
      1,
      8000,
    )

    // Two lights, no shadow maps. With flat shading a hemisphere fill plus one directional
    // is enough to read every surface orientation, and baked vertex light replaces this
    // entirely from M5.
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a2f3a, 1.15))
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.25)
    sun.position.set(0.5, 1, 0.35)
    this.scene.add(sun)

    this.teamMaterials = [
      new THREE.MeshLambertMaterial({ color: PALETTE.wreckers, flatShading: true }),
      new THREE.MeshLambertMaterial({ color: PALETTE.wardens, flatShading: true }),
    ]
    this.headMaterial = new THREE.MeshLambertMaterial({ color: PALETTE.head, flatShading: true })
    this.deadMaterial = new THREE.MeshLambertMaterial({
      color: 0x3a3f4c,
      flatShading: true,
      transparent: true,
      opacity: 0.35,
    })
    this.tracerMaterial = new THREE.LineBasicMaterial({
      color: PALETTE.tracer,
      transparent: true,
      opacity: 0.9,
    })
    this.impactMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.impact })

    this.resize()
    window.addEventListener('resize', () => this.resize())
  }

  private resize(): void {
    const w = window.innerWidth
    const h = window.innerHeight
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /**
   * Builds the level geometry from the map's brushes.
   *
   * One mesh per brush is fine at this scale (a couple of dozen). `mapc` produces merged,
   * vertex-lit geometry from M2, at which point this becomes a single draw call per material.
   */
  buildMap(map: MapData): void {
    const group = new THREE.Group()
    group.name = 'map'

    const byMaterial = new Map<number, THREE.BufferGeometry[]>()

    for (let i = 0; i < map.brushCount; i++) {
      const o = i * 6
      const minX = map.brushes[o]!
      const minY = map.brushes[o + 1]!
      const minZ = map.brushes[o + 2]!
      const maxX = map.brushes[o + 3]!
      const maxY = map.brushes[o + 4]!
      const maxZ = map.brushes[o + 5]!

      const geo = new THREE.BoxGeometry(maxX - minX, maxY - minY, maxZ - minZ)
      geo.translate((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2)

      const mat = map.materials[i] ?? MATERIAL.CONCRETE
      const list = byMaterial.get(mat)
      if (list === undefined) byMaterial.set(mat, [geo])
      else list.push(geo)
    }

    for (const [matId, geos] of byMaterial) {
      const material = new THREE.MeshLambertMaterial({
        color: MATERIAL_COLOR[matId] ?? PALETTE.concrete,
        flatShading: true,
      })
      for (const geo of geos) {
        group.add(new THREE.Mesh(geo, material))
      }
    }

    // A subtle grid on the floor plane gives distance cues that flat shading alone does not,
    // which matters for judging how far away an enemy is.
    const grid = new THREE.GridHelper(
      map.bounds.maxX - map.bounds.minX,
      Math.round((map.bounds.maxX - map.bounds.minX) / 64),
      0x2b303c,
      0x22262f,
    )
    grid.position.y = 0.6
    group.add(grid)

    const existing = this.scene.getObjectByName('map')
    if (existing !== undefined) this.scene.remove(existing)
    this.scene.add(group)
  }

  private ensurePlayer(slot: number, team: number): PlayerVisual {
    const existing = this.players[slot]
    if (existing !== null && existing !== undefined) return existing

    const group = new THREE.Group()

    // Hull-shaped body. Chunky and readable; the rigged low-poly character lands in M5.
    const bodyGeo = new THREE.BoxGeometry(
      MOVE.HULL_HALF_WIDTH * 2,
      MOVE.HULL_HEIGHT_STAND - PLAYER.HEAD_HEIGHT,
      MOVE.HULL_HALF_WIDTH * 2,
    )
    const body = new THREE.Mesh(bodyGeo, this.teamMaterials[team] ?? this.teamMaterials[0]!)
    group.add(body)

    // Head box matching the hitbox exactly. Rendering a head that does not line up with the
    // hitbox is how "I definitely hit that" bug reports are manufactured.
    const headGeo = new THREE.BoxGeometry(
      PLAYER.HEAD_HALF_WIDTH * 2,
      PLAYER.HEAD_HEIGHT,
      PLAYER.HEAD_HALF_WIDTH * 2,
    )
    const head = new THREE.Mesh(headGeo, this.headMaterial)
    group.add(head)

    this.scene.add(group)
    const visual: PlayerVisual = { group, body, head }
    this.players[slot] = visual
    return visual
  }

  /** Positions every remote player from world state. The local player is not drawn. */
  updatePlayers(world: World, localSlot: number): void {
    const p = world.p

    for (let i = 0; i < SIM.MAX_PLAYERS; i++) {
      const visual = this.players[i]

      const hidden = p.active[i] === 0 || i === localSlot
      if (hidden) {
        if (visual !== null && visual !== undefined) visual.group.visible = false
        continue
      }

      const v = this.ensurePlayer(i, p.team[i]!)
      v.group.visible = true

      const crouching = (p.flags[i]! & PFLAG.CROUCHING) !== 0
      const dead = (p.flags[i]! & PFLAG.DEAD) !== 0
      const h = crouching ? MOVE.HULL_HEIGHT_CROUCH : MOVE.HULL_HEIGHT_STAND
      const bodyHeight = h - PLAYER.HEAD_HEIGHT

      v.body.scale.y = bodyHeight / (MOVE.HULL_HEIGHT_STAND - PLAYER.HEAD_HEIGHT)
      v.body.position.set(0, bodyHeight / 2, 0)
      v.head.position.set(0, h - PLAYER.HEAD_HEIGHT / 2, 0)

      v.group.position.set(p.posX[i]!, p.posY[i]!, p.posZ[i]!)
      v.group.rotation.y = p.yaw[i]!

      const teamMat = this.teamMaterials[p.team[i]!] ?? this.teamMaterials[0]!
      v.body.material = dead ? this.deadMaterial : teamMat
      v.head.visible = !dead
    }
  }

  /** Places the camera at a player's eye, using locally-held view angles. */
  setCameraFromEye(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.camera.position.set(x, y, z)
    // YXZ order: yaw about world up first, then pitch about the local right axis. Any other
    // order introduces roll as you look around.
    this.camera.rotation.order = 'YXZ'
    this.camera.rotation.y = yaw
    this.camera.rotation.x = pitch
    this.camera.rotation.z = 0
  }

  addTracer(ox: number, oy: number, oz: number, ex: number, ey: number, ez: number): void {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(ox, oy, oz),
      new THREE.Vector3(ex, ey, ez),
    ])
    const line = new THREE.Line(geo, this.tracerMaterial.clone())
    this.scene.add(line)
    this.tracers.push({ line, born: performance.now() })
  }

  addImpact(x: number, y: number, z: number): void {
    const mesh = new THREE.Mesh(this.impactGeometry, this.impactMaterial)
    mesh.position.set(x, y, z)
    this.scene.add(mesh)
    this.impacts.push({ mesh, born: performance.now() })
  }

  /** Ages out transient effects. Geometry is disposed, not just detached. */
  private updateEffects(now: number): void {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i]!
      const age = (now - t.born) / TRACER_LIFETIME_MS
      if (age >= 1) {
        this.scene.remove(t.line)
        t.line.geometry.dispose()
        ;(t.line.material as THREE.Material).dispose()
        this.tracers.splice(i, 1)
      } else {
        ;(t.line.material as THREE.LineBasicMaterial).opacity = 0.9 * (1 - age)
      }
    }

    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const im = this.impacts[i]!
      const age = (now - im.born) / IMPACT_LIFETIME_MS
      if (age >= 1) {
        this.scene.remove(im.mesh)
        this.impacts.splice(i, 1)
      } else {
        const s = 1 - age * 0.7
        im.mesh.scale.set(s, s, s)
      }
    }
  }

  render(now: number): void {
    this.updateEffects(now)
    this.renderer.render(this.scene, this.camera)
  }
}
