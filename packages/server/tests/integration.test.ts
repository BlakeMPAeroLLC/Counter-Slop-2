import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import {
  PROTOCOL_VERSION,
  decodeServer,
  encodeClient,
  type ServerMessage,
  type SnapshotMessage,
  type WelcomeMessage,
  type WirePlayer,
} from '@cs2/protocol'
import { BTN, MOVE, PFLAG, SIM, buildFlatMap } from '@cs2/sim'
import { startGameServer, type GameServer } from '../src/server.js'

/**
 * The M0 exit gate, as an automated test.
 *
 * The gate in docs/PLAN.md §11 is "two players on the same LAN can shoot each other and it
 * doesn't feel awful". Feel needs a human, but *everything else* in that sentence is
 * mechanically checkable, and checking it here means a regression surfaces in CI rather than
 * five minutes into a game night.
 *
 * This drives the entire real stack: WebSocket transport, JSON protocol, room lifecycle,
 * the fixed-step 64 Hz loop, server-authoritative hitscan, and snapshot broadcast.
 */

let server: GameServer

beforeEach(async () => {
  // `flat` rather than `dm_box`: the arena has an L-shaped wall through the middle by design,
  // so whether two spawns can see each other there depends on which spawn the RNG chose. A
  // hit-registration test must not be a coin flip on level geometry.
  server = await startGameServer({
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    map: buildFlatMap,
  })
})

afterEach(async () => {
  await server.close()
})

/** A headless client: the seed of the `bots/` package that M1 uses for soak testing. */
class TestClient {
  readonly socket: WebSocket
  welcome: WelcomeMessage | null = null
  readonly snapshots: SnapshotMessage[] = []

  private seq = 0
  private tick = 0
  /**
   * Resolved when the socket opens.
   *
   * Captured in the constructor rather than in `open()` on purpose. Tests construct both
   * clients before awaiting either, so by the time `b.open()` runs, b's socket has usually
   * already fired 'open' — and a `once('open')` attached at that point waits forever.
   * Attaching the listener synchronously with construction makes the event impossible to miss.
   */
  private readonly opened: Promise<void>

  constructor(port: number, room = 'TEST') {
    this.socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws?room=${room}`)

    this.opened = new Promise<void>((done, fail) => {
      this.socket.once('open', () => done())
      this.socket.once('error', fail)
    })

    this.socket.on('message', (raw: Buffer) => {
      const msg: ServerMessage | null = decodeServer(raw.toString())
      if (msg === null) return
      if (msg.t === 'welcome') this.welcome = msg
      else if (msg.t === 'snap') this.snapshots.push(msg)
    })
  }

  async open(name: string): Promise<void> {
    await this.opened
    this.socket.send(encodeClient({ t: 'hello', protocol: PROTOCOL_VERSION, name }))
    await waitFor(() => this.welcome !== null, 3000, 'welcome message')
  }

  get slot(): number {
    return this.welcome?.you ?? -1
  }

  send(buttons: number, yaw: number, pitch: number): void {
    if (this.socket.readyState !== WebSocket.OPEN) return
    this.seq++
    this.tick++
    this.socket.send(
      encodeClient({
        t: 'cmd',
        c: [{ q: this.seq, k: this.tick, b: buttons, y: yaw, p: pitch, s: 0 }],
      }),
    )
  }

  /** Sends the same command for `ticks` ticks at roughly the real command rate. */
  async hold(buttons: number, yaw: number, pitch: number, ticks: number): Promise<void> {
    for (let i = 0; i < ticks; i++) {
      this.send(buttons, yaw, pitch)
      await sleep(1000 / SIM.CMD_HZ)
    }
  }

  latest(): SnapshotMessage | null {
    return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1]! : null
  }

  playerState(slot: number): WirePlayer | null {
    const snap = this.latest()
    if (snap === null) return null
    return snap.players.find((p) => p.i === slot) ?? null
  }

  close(): void {
    this.socket.close()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${what}`)
}

/**
 * View angles that point from a shooter's eye at a target's chest.
 *
 * Mirrors the sim's convention exactly (yaw 0 looks down -Z, positive pitch looks up), so if
 * this and `viewDir` ever disagree the aim tests fail — which is the point. `Math.atan2` is
 * fine here: this is test code, not simulation code, so the determinism ban does not apply.
 */
function aimAt(
  from: WirePlayer,
  to: WirePlayer,
): { yaw: number; pitch: number; distance: number } {
  const eyeY = from.y + MOVE.EYE_HEIGHT_STAND
  const targetY = to.y + MOVE.HULL_HEIGHT_STAND * 0.55

  const dx = to.x - from.x
  const dz = to.z - from.z
  const dy = targetY - eyeY

  const horiz = Math.sqrt(dx * dx + dz * dz)
  return {
    // forward = (-sin(yaw), sin(pitch), -cos(yaw)) => yaw = atan2(-dx, -dz)
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.atan2(dy, horiz),
    distance: Math.sqrt(horiz * horiz + dy * dy),
  }
}

describe('server handshake', () => {
  it('assigns slots and balances teams', async () => {
    const a = new TestClient(server.port)
    const b = new TestClient(server.port)
    await a.open('alice')
    await b.open('bob')

    expect(a.slot).toBe(0)
    expect(b.slot).toBe(1)
    expect(a.welcome?.protocol).toBe(PROTOCOL_VERSION)
    expect(a.welcome?.tickRate).toBe(SIM.TICK_HZ)

    await waitFor(() => a.snapshots.length > 2, 2000, 'snapshots')
    const snap = a.latest()!
    const teams = snap.players.map((p) => p.tm).sort()
    expect(teams).toEqual([0, 1])

    a.close()
    b.close()
  })

  it('rejects a protocol mismatch with an actionable message', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(server.port)}/ws`)
    await new Promise<void>((done, fail) => {
      socket.once('open', () => done())
      socket.once('error', fail)
    })

    let reason = ''
    socket.on('message', (raw: Buffer) => {
      const msg = decodeServer(raw.toString())
      if (msg?.t === 'reject') reason = msg.reason
    })

    socket.send(encodeClient({ t: 'hello', protocol: PROTOCOL_VERSION + 999, name: 'stale' }))
    await waitFor(() => reason !== '', 2000, 'rejection')

    expect(reason).toContain('Version mismatch')
    // The message must tell the player what to actually do about it.
    expect(reason.toLowerCase()).toContain('refresh')
    socket.close()
  })

  it('survives garbage input without dropping the room', async () => {
    const a = new TestClient(server.port)
    await a.open('alice')

    a.socket.send('not json at all')
    a.socket.send('{"t":"nonsense"}')
    a.socket.send('{"t":"cmd","c":"not an array"}')
    a.socket.send('{"t":"cmd","c":[{"q":1,"k":1,"b":0,"y":null,"p":"NaN","s":0}]}')

    // The room must still be ticking afterwards.
    const before = a.snapshots.length
    await waitFor(() => a.snapshots.length > before + 3, 2000, 'snapshots after garbage')

    const state = a.playerState(a.slot)
    expect(state).not.toBeNull()
    expect(Number.isFinite(state!.x)).toBe(true)
    expect(Number.isFinite(state!.ya)).toBe(true)

    a.close()
  })
})

describe('simulation over the wire', () => {
  it('advances ticks and emits snapshots at roughly the configured rate', async () => {
    const a = new TestClient(server.port)
    await a.open('alice')

    await sleep(1000)

    // Allow generous slack: timer resolution in CI is not precise.
    expect(a.snapshots.length).toBeGreaterThan(SIM.SNAPSHOT_HZ * 0.5)
    expect(a.snapshots.length).toBeLessThan(SIM.SNAPSHOT_HZ * 1.6)

    const first = a.snapshots[0]!
    const last = a.latest()!
    expect(last.tick).toBeGreaterThan(first.tick)

    a.close()
  })

  it('moves a player when it is sent movement commands, and acknowledges the input', async () => {
    const a = new TestClient(server.port)
    await a.open('alice')
    await waitFor(() => a.playerState(a.slot) !== null, 2000, 'initial state')

    const start = a.playerState(a.slot)!
    // Yaw PI faces +Z. Team 0 spawns at the -Z row, so this walks across open floor.
    await a.hold(BTN.FORWARD, Math.PI, 0, 40)
    await waitFor(
      () => {
        const s = a.playerState(a.slot)
        return s !== null && Math.abs(s.z - start.z) > 50
      },
      2000,
      'player to move',
    )

    const moved = a.playerState(a.slot)!
    expect(moved.z).toBeGreaterThan(start.z + 50)
    expect(a.latest()!.ack).toBeGreaterThan(0)

    a.close()
  })

  it('applies gravity so a player rests on the floor', async () => {
    const a = new TestClient(server.port)
    await a.open('alice')
    await sleep(300)

    const s = a.playerState(a.slot)!
    expect(s.y).toBeLessThan(1)
    expect((s.f & PFLAG.ON_GROUND) !== 0).toBe(true)

    a.close()
  })
})

describe('M0 gate: two players can shoot each other', () => {
  it('registers a server-authoritative body hit and reduces health', async () => {
    const a = new TestClient(server.port)
    const b = new TestClient(server.port)
    await a.open('shooter')
    await b.open('target')

    // Let both settle onto the floor first; spawns are in the air by a hair.
    await waitFor(
      () => a.playerState(a.slot) !== null && a.playerState(b.slot) !== null,
      2000,
      'both players in snapshots',
    )
    await sleep(300)

    const shooter = a.playerState(a.slot)!
    const target = a.playerState(b.slot)!
    const startHealth = target.hp
    expect(startHealth).toBe(100)

    const aim = aimAt(shooter, target)
    // Sanity: the two spawn rows really are facing each other across the floor.
    expect(aim.distance).toBeGreaterThan(400)
    expect(aim.distance).toBeLessThan(1200)

    // Hold fire, aiming at the target. The rifle fires every ~6 ticks.
    await a.hold(BTN.ATTACK, aim.yaw, aim.pitch, 40)

    await waitFor(
      () => {
        const t = a.playerState(b.slot)
        return t !== null && t.hp < startHealth
      },
      3000,
      'target to take damage',
    )

    const after = a.playerState(b.slot)!
    expect(after.hp).toBeLessThan(startHealth)

    // The victim's own client must see the same authoritative health — there is one truth.
    await waitFor(
      () => {
        const own = b.playerState(b.slot)
        return own !== null && own.hp === after.hp
      },
      2000,
      'victim to agree on health',
    )

    a.close()
    b.close()
  })

  it('emits hit events attributed to the shooter, and consumes ammo', async () => {
    const a = new TestClient(server.port)
    const b = new TestClient(server.port)
    await a.open('shooter')
    await b.open('target')
    await waitFor(
      () => a.playerState(a.slot) !== null && a.playerState(b.slot) !== null,
      2000,
      'both players',
    )
    await sleep(300)

    const aim = aimAt(a.playerState(a.slot)!, a.playerState(b.slot)!)
    const ammoBefore = a.playerState(a.slot)!.am

    await a.hold(BTN.ATTACK, aim.yaw, aim.pitch, 40)
    await sleep(150)

    const fireEvents = a.snapshots.flatMap((s) => s.events).filter((e) => e.k === 'fire')
    const hitEvents = a.snapshots.flatMap((s) => s.events).filter((e) => e.k === 'hit')

    expect(fireEvents.length).toBeGreaterThan(0)
    expect(hitEvents.length).toBeGreaterThan(0)
    for (const h of hitEvents) {
      if (h.k !== 'hit') continue
      expect(h.p).toBe(a.slot)
      expect(h.target).toBe(b.slot)
      expect(h.damage).toBeGreaterThan(0)
    }

    expect(a.playerState(a.slot)!.am).toBeLessThan(ammoBefore)

    a.close()
    b.close()
  })

  it('kills the target and credits the kill', async () => {
    const a = new TestClient(server.port)
    const b = new TestClient(server.port)
    await a.open('shooter')
    await b.open('target')
    await waitFor(
      () => a.playerState(a.slot) !== null && a.playerState(b.slot) !== null,
      2000,
      'both players',
    )
    await sleep(300)

    // Re-aim each burst: the target does not move, but re-reading state keeps this honest if
    // spawn selection changes.
    for (let burst = 0; burst < 6; burst++) {
      const shooter = a.playerState(a.slot)
      const target = a.playerState(b.slot)
      if (shooter === null || target === null) break
      if (target.hp <= 0 || (target.f & PFLAG.DEAD) !== 0) break

      const aim = aimAt(shooter, target)
      await a.hold(BTN.ATTACK, aim.yaw, aim.pitch, 30)
      await a.hold(0, aim.yaw, aim.pitch, 4) // release, so the next burst is a fresh press
    }

    const deaths = a.snapshots.flatMap((s) => s.events).filter((e) => e.k === 'death')
    expect(deaths.length).toBeGreaterThan(0)

    const kills = a.playerState(a.slot)!.kl
    expect(kills).toBeGreaterThan(0)

    a.close()
    b.close()
  })

  it('does not let a player damage themselves', async () => {
    const a = new TestClient(server.port)
    await a.open('lonely')
    await sleep(300)

    const before = a.playerState(a.slot)!.hp
    // Aim straight down and unload. `traceBullet` skips the shooter, so nothing should happen.
    await a.hold(BTN.ATTACK, 0, -1.5, 40)
    await sleep(150)

    expect(a.playerState(a.slot)!.hp).toBe(before)

    a.close()
  })
})

describe('room lifecycle', () => {
  it('frees the slot when a client disconnects', async () => {
    const a = new TestClient(server.port)
    const b = new TestClient(server.port)
    await a.open('alice')
    await b.open('bob')
    await waitFor(() => (a.latest()?.players.length ?? 0) === 2, 2000, 'two players')

    b.close()
    await waitFor(() => (a.latest()?.players.length ?? 0) === 1, 3000, 'one player')

    // A new client should be able to take the vacated slot.
    const c = new TestClient(server.port)
    await c.open('carol')
    expect(c.slot).toBe(1)

    a.close()
    c.close()
  })

  it('keeps rooms isolated from each other', async () => {
    const a = new TestClient(server.port, 'ROOMA')
    const b = new TestClient(server.port, 'ROOMB')
    await a.open('alice')
    await b.open('bob')
    await waitFor(
      () => a.snapshots.length > 2 && b.snapshots.length > 2,
      2000,
      'snapshots in both rooms',
    )

    // Each is alone in their own room, so each sees exactly one player.
    expect(a.latest()!.players.length).toBe(1)
    expect(b.latest()!.players.length).toBe(1)
    expect(server.rooms.all().length).toBe(2)

    a.close()
    b.close()
  })

  it('holds tick time far below the 15.625ms budget', async () => {
    const clients: TestClient[] = []
    for (let i = 0; i < 6; i++) {
      const c = new TestClient(server.port)
      await c.open(`bot${String(i)}`)
      clients.push(c)
    }

    // Everyone moving and shooting at once: the realistic worst case for a room this size.
    await Promise.all(
      clients.map((c, i) => c.hold(BTN.FORWARD | BTN.ATTACK, i * 0.7, 0, 64)),
    )

    const room = server.rooms.all()[0]!
    const stats = room.stats()
    expect(stats.players).toBe(6)
    // The plan's soak-test target is p99 under 3ms. This is a much shorter run, so it only
    // asserts the tick is not remotely close to overrunning.
    expect(stats.p99).toBeLessThan(5)

    for (const c of clients) c.close()
  })
})
