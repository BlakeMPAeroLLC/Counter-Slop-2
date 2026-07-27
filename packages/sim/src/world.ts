/**
 * World state.
 *
 * Player state is stored struct-of-arrays in typed arrays rather than as an array of
 * objects. Three reasons, in order of importance:
 *
 *  1. Rollback. Snapshotting the world becomes a handful of byte copies into a
 *     preallocated buffer instead of a deep clone — which matters because M1 does this
 *     every time a snapshot arrives.
 *  2. No GC pressure. Nothing in the tick allocates, so there is no collection pause
 *     mid-spray. A 4 ms hitch at the wrong moment is worse than 20 fewer frames.
 *  3. Deterministic iteration. Fixed-length numeric arrays have exactly one traversal
 *     order, so there is no way for key ordering to introduce a client/server divergence.
 */

import { PLAYER, SIM } from './constants.js'
import type { MapData } from './map.js'
import { rngBelow, rngNext } from './math.js'

/** Bit flags packed into `PlayerStore.flags`. Wire-visible — append only. */
export const PFLAG = {
  ON_GROUND: 1 << 0,
  CROUCHING: 1 << 1,
  DEAD: 1 << 2,
  RELOADING: 1 << 3,
} as const

export interface PlayerStore {
  readonly active: Uint8Array
  readonly team: Uint8Array
  readonly flags: Uint8Array

  readonly posX: Float64Array
  readonly posY: Float64Array
  readonly posZ: Float64Array
  readonly velX: Float64Array
  readonly velY: Float64Array
  readonly velZ: Float64Array
  readonly yaw: Float64Array
  readonly pitch: Float64Array

  readonly health: Int16Array
  readonly armor: Int16Array

  readonly weapon: Uint8Array
  readonly ammo: Int16Array
  readonly nextFireTick: Int32Array
  readonly reloadEndTick: Int32Array
  /** Consecutive shots, for the spread ramp. Decays when not firing. */
  readonly shotsFired: Uint16Array
  readonly lastFireTick: Int32Array

  readonly jumpCount: Uint8Array
  readonly respawnTick: Int32Array

  readonly kills: Uint16Array
  readonly deaths: Uint16Array
  /** Highest command sequence consumed for this player, echoed back for reconciliation. */
  readonly lastCmdSeq: Uint32Array
}

function createPlayerStore(n: number): PlayerStore {
  return {
    active: new Uint8Array(n),
    team: new Uint8Array(n),
    flags: new Uint8Array(n),

    posX: new Float64Array(n),
    posY: new Float64Array(n),
    posZ: new Float64Array(n),
    velX: new Float64Array(n),
    velY: new Float64Array(n),
    velZ: new Float64Array(n),
    yaw: new Float64Array(n),
    pitch: new Float64Array(n),

    health: new Int16Array(n),
    armor: new Int16Array(n),

    weapon: new Uint8Array(n),
    ammo: new Int16Array(n),
    nextFireTick: new Int32Array(n),
    reloadEndTick: new Int32Array(n),
    shotsFired: new Uint16Array(n),
    lastFireTick: new Int32Array(n),

    jumpCount: new Uint8Array(n),
    respawnTick: new Int32Array(n),

    kills: new Uint16Array(n),
    deaths: new Uint16Array(n),
    lastCmdSeq: new Uint32Array(n),
  }
}

/**
 * Fixed traversal order for every operation that walks the whole store (hashing,
 * snapshotting, restoring). Adding a field means adding it here too — the
 * `snapshot -> restore` round-trip test in the sim test suite fails loudly if you forget.
 */
function storeArrays(p: PlayerStore): ArrayBufferView[] {
  return [
    p.active,
    p.team,
    p.flags,
    p.posX,
    p.posY,
    p.posZ,
    p.velX,
    p.velY,
    p.velZ,
    p.yaw,
    p.pitch,
    p.health,
    p.armor,
    p.weapon,
    p.ammo,
    p.nextFireTick,
    p.reloadEndTick,
    p.shotsFired,
    p.lastFireTick,
    p.jumpCount,
    p.respawnTick,
    p.kills,
    p.deaths,
    p.lastCmdSeq,
  ]
}

// ── Events ──────────────────────────────────────────────────────────────────
//
// Transient, cleared at the start of every tick. The server forwards them to clients for
// tracers, impact effects and the killfeed; a replaying client regenerates them locally.
//
// These do allocate, but only when something actually happens (a few per second), not
// per-tick-per-player. That is well inside the GC budget.

export interface FireEvent {
  readonly k: 'fire'
  readonly p: number
  readonly ox: number
  readonly oy: number
  readonly oz: number
  /** Endpoint of the trace, so the client can draw a tracer without re-simulating. */
  readonly ex: number
  readonly ey: number
  readonly ez: number
  readonly hitWorld: boolean
}

export interface HitEvent {
  readonly k: 'hit'
  readonly p: number
  readonly target: number
  readonly hitbox: number
  readonly damage: number
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface DeathEvent {
  readonly k: 'death'
  readonly p: number
  readonly by: number
  readonly headshot: boolean
}

export interface SpawnEvent {
  readonly k: 'spawn'
  readonly p: number
}

export type SimEvent = FireEvent | HitEvent | DeathEvent | SpawnEvent

export interface World {
  tick: number
  /** xorshift32 state. The single RNG stream for the whole simulation. */
  rng: number
  readonly map: MapData
  readonly p: PlayerStore
  /** Cleared at the start of each `step`. Not part of the world hash. */
  readonly events: SimEvent[]
}

export function createWorld(map: MapData, seed = 0x2f6e2b1): World {
  return {
    tick: 0,
    rng: seed >>> 0,
    map,
    p: createPlayerStore(SIM.MAX_PLAYERS),
    events: [],
  }
}

/** Claims the lowest free player slot. Returns -1 when the room is full. */
export function addPlayer(world: World, team: number): number {
  const p = world.p
  for (let i = 0; i < SIM.MAX_PLAYERS; i++) {
    if (p.active[i] === 0) {
      p.active[i] = 1
      p.team[i] = team
      p.kills[i] = 0
      p.deaths[i] = 0
      p.lastCmdSeq[i] = 0
      respawnPlayer(world, i)
      return i
    }
  }
  return -1
}

export function removePlayer(world: World, i: number): void {
  const p = world.p
  p.active[i] = 0
  p.flags[i] = 0
  p.health[i] = 0
}

/** Assigns the team with fewer players, tie-breaking toward Wreckers. */
export function pickBalancedTeam(world: World): number {
  const p = world.p
  let a = 0
  let b = 0
  for (let i = 0; i < SIM.MAX_PLAYERS; i++) {
    if (p.active[i] === 0) continue
    if (p.team[i] === 0) a++
    else b++
  }
  return a <= b ? 0 : 1
}

export function respawnPlayer(world: World, i: number): void {
  const p = world.p
  const team = p.team[i]!
  const spawns = world.map.spawns[team] ?? world.map.spawns[0] ?? []

  let sx = 0
  let sy = 0
  let sz = 0
  let syaw = 0
  if (spawns.length > 0) {
    world.rng = rngNext(world.rng)
    const s = spawns[rngBelow(world.rng, spawns.length)]!
    sx = s.x
    sy = s.y
    sz = s.z
    syaw = s.yaw
  }

  p.posX[i] = sx
  p.posY[i] = sy
  p.posZ[i] = sz
  p.velX[i] = 0
  p.velY[i] = 0
  p.velZ[i] = 0
  p.yaw[i] = syaw
  p.pitch[i] = 0

  p.health[i] = PLAYER.START_HEALTH
  p.armor[i] = PLAYER.START_ARMOR
  p.flags[i] = 0
  p.jumpCount[i] = 0

  p.weapon[i] = 0
  p.ammo[i] = 30
  p.nextFireTick[i] = 0
  p.reloadEndTick[i] = 0
  p.shotsFired[i] = 0
  p.lastFireTick[i] = 0
  p.respawnTick[i] = 0

  world.events.push({ k: 'spawn', p: i })
}

// ── Hashing ─────────────────────────────────────────────────────────────────

const f64 = new Float64Array(1)
const f64Bytes = new Uint8Array(f64.buffer)

/**
 * FNV-1a over the entire mutable world state.
 *
 * Used two ways: the CI determinism test asserts two independent runs produce the same
 * hash, and (from M1) the client compares its predicted hash against the server's to
 * detect divergence before it becomes visible rubber-banding.
 *
 * Negative zero is normalised to positive zero. `-0` and `+0` behave identically in every
 * arithmetic operation the simulation performs, so a raw byte comparison would report a
 * divergence that has no behavioural consequence — a false alarm that would send you
 * hunting a bug that isn't there.
 */
export function hashWorld(world: World): number {
  let h = 0x811c9dc5

  h = mixInt(h, world.tick)
  h = mixInt(h, world.rng)

  const arrays = storeArrays(world.p)
  for (let a = 0; a < arrays.length; a++) {
    const arr = arrays[a]!
    if (arr instanceof Float64Array) {
      for (let i = 0; i < arr.length; i++) {
        h = mixFloat(h, arr[i]!)
      }
    } else {
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
      for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i]!
        h = Math.imul(h, 0x01000193)
      }
    }
  }

  return h >>> 0
}

function mixInt(h: number, v: number): number {
  let x = v | 0
  for (let i = 0; i < 4; i++) {
    h ^= x & 0xff
    h = Math.imul(h, 0x01000193)
    x >>>= 8
  }
  return h
}

function mixFloat(h: number, v: number): number {
  f64[0] = v + 0 // (-0) + 0 === +0, and x + 0 === x for every other finite x
  let acc = h
  for (let i = 0; i < 8; i++) {
    acc ^= f64Bytes[i]!
    acc = Math.imul(acc, 0x01000193)
  }
  return acc
}

// ── Snapshot / restore ──────────────────────────────────────────────────────
//
// M0 does not roll back, but this is twenty lines and M1 is built entirely on top of it,
// so it exists now and is covered by tests from the start.

export interface WorldSnapshot {
  tick: number
  rng: number
  readonly bytes: Uint8Array
}

function snapshotByteLength(p: PlayerStore): number {
  let total = 0
  for (const arr of storeArrays(p)) total += arr.byteLength
  return total
}

export function createSnapshot(world: World): WorldSnapshot {
  return { tick: 0, rng: 0, bytes: new Uint8Array(snapshotByteLength(world.p)) }
}

/** Copies world state into a preallocated snapshot. Allocation-free. */
export function saveSnapshot(world: World, snap: WorldSnapshot): WorldSnapshot {
  snap.tick = world.tick
  snap.rng = world.rng

  let offset = 0
  for (const arr of storeArrays(world.p)) {
    snap.bytes.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), offset)
    offset += arr.byteLength
  }
  return snap
}

/** Overwrites world state from a snapshot. The inverse of `saveSnapshot`. */
export function loadSnapshot(world: World, snap: WorldSnapshot): void {
  world.tick = snap.tick
  world.rng = snap.rng

  let offset = 0
  for (const arr of storeArrays(world.p)) {
    const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
    view.set(snap.bytes.subarray(offset, offset + arr.byteLength))
    offset += arr.byteLength
  }
}
