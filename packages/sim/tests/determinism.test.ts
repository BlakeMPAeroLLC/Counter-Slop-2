import { describe, expect, it } from 'vitest'
import { BTN, createCommand, type Command } from '../src/command.js'
import { SIM } from '../src/constants.js'
import { buildTestArena } from '../src/map.js'
import { rngNext, rngUnit } from '../src/math.js'
import { step } from '../src/tick.js'
import {
  addPlayer,
  createSnapshot,
  createWorld,
  hashWorld,
  loadSnapshot,
  saveSnapshot,
} from '../src/world.js'

/**
 * The highest-value tests in the repository.
 *
 * Client-side prediction (M1) works by running this simulation on both ends and comparing
 * results. If `step` is not perfectly reproducible, prediction produces phantom divergence
 * that presents as rubber-banding and is extremely painful to diagnose from the symptom.
 * Catching it here, in CI, is worth far more than catching it in a playtest.
 */

const TICKS = 10_000
const PLAYERS = 6

/** Generates a deterministic pseudo-random but *plausible* command stream. */
function makeCommandStream(seed: number, ticks: number): Command[][] {
  let s = seed >>> 0
  const rand = (): number => {
    s = rngNext(s)
    return rngUnit(s)
  }

  const out: Command[][] = []
  // Hold buttons for a few ticks at a time rather than rerolling every tick — random
  // per-tick input never exercises sustained acceleration, air-strafing or spray.
  const held = new Array<number>(PLAYERS).fill(0)
  const holdFor = new Array<number>(PLAYERS).fill(0)
  const yaws = new Array<number>(PLAYERS).fill(0)
  const pitches = new Array<number>(PLAYERS).fill(0)

  for (let t = 0; t < ticks; t++) {
    const frame: Command[] = []
    for (let i = 0; i < PLAYERS; i++) {
      if (holdFor[i]! <= 0) {
        holdFor[i] = 1 + Math.floor(rand() * 24)
        let b = 0
        if (rand() < 0.7) b |= BTN.FORWARD
        if (rand() < 0.2) b |= BTN.BACK
        if (rand() < 0.35) b |= BTN.LEFT
        if (rand() < 0.35) b |= BTN.RIGHT
        if (rand() < 0.15) b |= BTN.JUMP
        if (rand() < 0.12) b |= BTN.CROUCH
        if (rand() < 0.1) b |= BTN.WALK
        if (rand() < 0.4) b |= BTN.ATTACK
        if (rand() < 0.05) b |= BTN.RELOAD
        held[i] = b
      }
      holdFor[i] = holdFor[i]! - 1

      // Smooth view movement, like a real mouse.
      yaws[i] = yaws[i]! + (rand() - 0.5) * 0.25
      pitches[i] = Math.max(-1.5, Math.min(1.5, pitches[i]! + (rand() - 0.5) * 0.12))

      const cmd = createCommand()
      cmd.seq = t + 1
      cmd.tick = t
      cmd.buttons = held[i]!
      cmd.yaw = yaws[i]!
      cmd.pitch = pitches[i]!
      cmd.subFrac = rand()
      frame.push(cmd)
    }
    out.push(frame)
  }
  return out
}

function runStream(stream: readonly Command[][], seed = 0x2f6e2b1): number {
  const world = createWorld(buildTestArena(), seed)
  for (let i = 0; i < PLAYERS; i++) {
    addPlayer(world, i % 2)
  }

  const slots: (Command | null)[] = new Array<Command | null>(SIM.MAX_PLAYERS).fill(null)
  for (const frame of stream) {
    for (let i = 0; i < SIM.MAX_PLAYERS; i++) slots[i] = frame[i] ?? null
    step(world, slots)
  }
  return hashWorld(world)
}

describe('simulation determinism', () => {
  const stream = makeCommandStream(0xc0ffee, TICKS)

  it(`produces an identical world hash across two independent ${TICKS}-tick runs`, () => {
    const a = runStream(stream)
    const b = runStream(stream)
    expect(b).toBe(a)
  })

  it('produces a different hash for a different input stream (the test can actually fail)', () => {
    // Guards against the hash being constant, which would make the test above vacuous.
    const other = makeCommandStream(0xbadbeef, TICKS)
    expect(runStream(other)).not.toBe(runStream(stream))
  })

  it('produces a different hash for a different RNG seed', () => {
    expect(runStream(stream, 12345)).not.toBe(runStream(stream, 999))
  })

  it('never produces NaN or non-finite state', () => {
    const world = createWorld(buildTestArena())
    for (let i = 0; i < PLAYERS; i++) addPlayer(world, i % 2)

    const slots: (Command | null)[] = new Array<Command | null>(SIM.MAX_PLAYERS).fill(null)
    for (const frame of stream) {
      for (let i = 0; i < SIM.MAX_PLAYERS; i++) slots[i] = frame[i] ?? null
      step(world, slots)
    }

    const p = world.p
    for (let i = 0; i < SIM.MAX_PLAYERS; i++) {
      for (const v of [
        p.posX[i]!,
        p.posY[i]!,
        p.posZ[i]!,
        p.velX[i]!,
        p.velY[i]!,
        p.velZ[i]!,
        p.yaw[i]!,
        p.pitch[i]!,
      ]) {
        expect(Number.isFinite(v)).toBe(true)
      }
    }
  })

  it('keeps every player inside the map bounds', () => {
    // Escaping the arena is the classic collision-solver failure, and it is silent until
    // someone falls out of the world in a playtest.
    const world = createWorld(buildTestArena())
    for (let i = 0; i < PLAYERS; i++) addPlayer(world, i % 2)

    const bounds = world.map.bounds
    const slots: (Command | null)[] = new Array<Command | null>(SIM.MAX_PLAYERS).fill(null)

    for (const frame of stream) {
      for (let i = 0; i < SIM.MAX_PLAYERS; i++) slots[i] = frame[i] ?? null
      step(world, slots)

      const p = world.p
      for (let i = 0; i < SIM.MAX_PLAYERS; i++) {
        if (p.active[i] === 0) continue
        expect(p.posX[i]!).toBeGreaterThan(bounds.minX - 1)
        expect(p.posX[i]!).toBeLessThan(bounds.maxX + 1)
        expect(p.posZ[i]!).toBeGreaterThan(bounds.minZ - 1)
        expect(p.posZ[i]!).toBeLessThan(bounds.maxZ + 1)
        expect(p.posY[i]!).toBeGreaterThan(bounds.minY - 1)
      }
    }
  })
})

describe('snapshot / restore (the foundation M1 rollback is built on)', () => {
  it('round-trips world state exactly', () => {
    const stream = makeCommandStream(0x51ee7, 400)
    const world = createWorld(buildTestArena())
    for (let i = 0; i < PLAYERS; i++) addPlayer(world, i % 2)

    const slots: (Command | null)[] = new Array<Command | null>(SIM.MAX_PLAYERS).fill(null)
    const runFrom = (from: number, to: number): void => {
      for (let t = from; t < to; t++) {
        const frame = stream[t]!
        for (let i = 0; i < SIM.MAX_PLAYERS; i++) slots[i] = frame[i] ?? null
        step(world, slots)
      }
    }

    runFrom(0, 200)

    const snap = saveSnapshot(world, createSnapshot(world))
    const hashAtSave = hashWorld(world)

    // Advance, then rewind and replay the identical commands. This is exactly the
    // operation the client performs on every server snapshot in M1.
    runFrom(200, 400)
    const hashAfterFirstReplay = hashWorld(world)

    loadSnapshot(world, snap)
    expect(hashWorld(world)).toBe(hashAtSave)

    runFrom(200, 400)
    expect(hashWorld(world)).toBe(hashAfterFirstReplay)
  })

  it('detects a field that was added to the store but forgotten in the snapshot order', () => {
    // saveSnapshot/loadSnapshot walk the same fixed array list that hashWorld does, so a
    // field missing from that list fails the round-trip above rather than silently
    // dropping out of rollback. This test documents that coupling on purpose.
    const world = createWorld(buildTestArena())
    addPlayer(world, 0)

    const snap = saveSnapshot(world, createSnapshot(world))
    world.p.kills[0] = 7
    world.p.pitch[0] = 0.42
    world.p.ammo[0] = 3

    loadSnapshot(world, snap)
    expect(world.p.kills[0]).toBe(0)
    expect(world.p.pitch[0]).toBe(0)
    expect(world.p.ammo[0]).toBe(30)
  })
})
