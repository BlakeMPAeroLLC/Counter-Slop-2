/**
 * A room: one authoritative simulation, up to SIM.MAX_PLAYERS clients.
 *
 * The server owns the truth. Clients send button presses and view angles; everything else —
 * positions, hits, damage, deaths, ammo — is decided here and broadcast. A client that lies
 * about where it is or what it hit is simply not asked (docs/PLAN.md §10).
 */

import {
  addPlayer,
  buildTestArena,
  createCommand,
  createWorld,
  pickBalancedTeam,
  removePlayer,
  SIM,
  step,
  type Command,
  type MapData,
  type SimEvent,
  type World,
} from '@cs2/sim'
import {
  encodeServer,
  fromWireCommand,
  writeSnapshot,
  type RosterEntry,
  type ServerMessage,
  type WireCommand,
} from '@cs2/protocol'

const TICK_MS = 1000 / SIM.TICK_HZ
const SNAPSHOT_EVERY = Math.max(1, Math.round(SIM.TICK_HZ / SIM.SNAPSHOT_HZ))

/**
 * How many ticks the server will keep repeating a client's last command when nothing new
 * has arrived.
 *
 * Repeating matters: a dropped packet must not read as the player releasing W, or every
 * hiccup becomes a stutter-step. But repeating forever means a client that vanished
 * mid-strafe runs into a wall for eternity, so it is capped at ~250 ms.
 */
const MAX_COMMAND_REPEATS = 16

/** Upper bound on queued commands per client, to contain a flooding or bursting client. */
const MAX_QUEUED_COMMANDS = 12

/** Ticks the loop may process in one wake-up before it gives up and resynchronises. */
const MAX_CATCHUP_TICKS = 8

/** Upper bound on events buffered between snapshots. */
const MAX_PENDING_EVENTS = 256

export interface Transport {
  send(data: string): void
  close(): void
}

/** Supplies a room's geometry. Injectable so tests can choose a map with known sightlines. */
export type MapFactory = () => MapData

interface RoomClient {
  slot: number
  name: string
  transport: Transport
  queue: Command[]
  last: Command
  repeats: number
  /** Highest sequence accepted, used to ignore the redundant resends. */
  highestSeq: number
}

export class Room {
  readonly code: string
  readonly world: World

  private readonly clients = new Map<number, RoomClient>()
  private readonly cmdSlots: (Command | null)[] = new Array<Command | null>(
    SIM.MAX_PLAYERS,
  ).fill(null)

  private timer: NodeJS.Timeout | null = null
  private nextTickTime = 0
  private tickCounter = 0

  // Metrics. `tick time p99` is one of the numbers docs/PLAN.md §12 asks the soak test to
  // assert, so it is measured from the start rather than bolted on later.
  private readonly tickDurations = new Float64Array(512)
  private tickDurationIndex = 0
  private totalTicks = 0

  /**
   * Events that happened since the last snapshot went out.
   *
   * The world clears its own event list every tick, but snapshots are sent every SNAPSHOT_EVERY
   * ticks. Without accumulating here, every event landing on a non-snapshot tick is destroyed
   * before any client sees it — which silently swallowed half of all shots.
   */
  private pendingEvents: SimEvent[] = []

  constructor(code: string, map: MapFactory = buildTestArena) {
    this.code = code
    this.world = createWorld(map())
  }

  get playerCount(): number {
    return this.clients.size
  }

  get isEmpty(): boolean {
    return this.clients.size === 0
  }

  /** Returns the assigned slot, or -1 if the room is full. */
  join(transport: Transport, name: string): number {
    const team = pickBalancedTeam(this.world)
    const slot = addPlayer(this.world, team)
    if (slot < 0) return -1

    this.clients.set(slot, {
      slot,
      name,
      transport,
      queue: [],
      last: createCommand(),
      repeats: 0,
      highestSeq: 0,
    })

    if (this.timer === null) this.start()
    return slot
  }

  leave(slot: number): void {
    if (!this.clients.has(slot)) return
    this.clients.delete(slot)
    removePlayer(this.world, slot)
    this.broadcast({ t: 'left', slot })
    this.broadcastRoster()
    if (this.clients.size === 0) this.stop()
  }

  clientName(slot: number): string {
    return this.clients.get(slot)?.name ?? `player${String(slot)}`
  }

  /** Slot-to-name mapping, so clients can render a readable killfeed and scoreboard. */
  roster(): RosterEntry[] {
    const out: RosterEntry[] = []
    for (const c of this.clients.values()) {
      out.push({ slot: c.slot, name: c.name, team: this.world.p.team[c.slot] ?? 0 })
    }
    return out
  }

  broadcastRoster(): void {
    this.broadcast({ t: 'roster', players: this.roster() })
  }

  /**
   * Accepts a batch of commands from one client.
   *
   * Sequence numbers are how the redundant resends get deduplicated: anything at or below
   * what we have already accepted is dropped silently, so the same command arriving three
   * times is applied once.
   */
  receiveCommands(slot: number, wire: readonly WireCommand[]): void {
    const client = this.clients.get(slot)
    if (client === undefined) return

    for (const w of wire) {
      if (typeof w !== 'object' || w === null) continue
      const seq = w.q >>> 0
      if (seq <= client.highestSeq) continue

      const cmd = fromWireCommand(w, createCommand())
      if (cmd === null) continue

      client.highestSeq = seq
      client.queue.push(cmd)
    }

    // Trim from the front: if we are behind, the freshest input is the useful one.
    while (client.queue.length > MAX_QUEUED_COMMANDS) client.queue.shift()
  }

  private start(): void {
    this.nextTickTime = performance.now()
    this.scheduleNext()
  }

  private stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /**
   * Stops the tick loop and drops every client.
   *
   * Needed for clean shutdown: a pending `setTimeout` keeps the Node event loop alive, so
   * without this a test run or a SIGTERM hangs instead of exiting.
   */
  shutdown(): void {
    this.stop()
    for (const client of this.clients.values()) client.transport.close()
    this.clients.clear()
  }

  private scheduleNext(): void {
    const delay = Math.max(0, this.nextTickTime - performance.now())
    this.timer = setTimeout(() => this.pump(), delay)
  }

  /**
   * Advances the simulation by however many fixed ticks are due.
   *
   * The accumulator is what keeps the simulation rate independent of timer jitter — a
   * `setInterval` at 15.625 ms drifts, and a drifting tick rate makes movement feel
   * inconsistent in a way players notice but cannot describe.
   */
  private pump(): void {
    if (this.clients.size === 0) {
      this.stop()
      return
    }

    const now = performance.now()
    let processed = 0

    while (now >= this.nextTickTime && processed < MAX_CATCHUP_TICKS) {
      const t0 = performance.now()
      this.doTick()
      this.recordTickDuration(performance.now() - t0)

      this.nextTickTime += TICK_MS
      processed++
    }

    if (processed >= MAX_CATCHUP_TICKS) {
      // Too far behind to catch up honestly. Resynchronise rather than spiral: trying to
      // run 200 ticks in one wake-up would stall the event loop and drop every connection.
      this.nextTickTime = performance.now() + TICK_MS
    }

    this.scheduleNext()
  }

  private doTick(): void {
    for (let i = 0; i < SIM.MAX_PLAYERS; i++) this.cmdSlots[i] = null

    for (const client of this.clients.values()) {
      const next = client.queue.shift()
      if (next !== undefined) {
        client.last = next
        client.repeats = 0
        this.cmdSlots[client.slot] = next
      } else if (client.repeats < MAX_COMMAND_REPEATS) {
        client.repeats++
        this.cmdSlots[client.slot] = client.last
      } else {
        this.cmdSlots[client.slot] = null
      }
    }

    step(this.world, this.cmdSlots)
    this.totalTicks++
    this.tickCounter++

    for (const ev of this.world.events) this.pendingEvents.push(ev)
    // Bound the buffer. If snapshots somehow stall, drop the oldest rather than grow forever.
    if (this.pendingEvents.length > MAX_PENDING_EVENTS) {
      this.pendingEvents = this.pendingEvents.slice(-MAX_PENDING_EVENTS)
    }

    if (this.tickCounter >= SNAPSHOT_EVERY) {
      this.tickCounter = 0
      this.sendSnapshots()
    }
  }

  /**
   * Sends each client a snapshot carrying that client's own command ack.
   *
   * The ack is per-client, so snapshots cannot be built once and shared — that changes in
   * M1, where the packed encoder builds the shared player payload once and appends the
   * per-client ack, rather than re-serialising the world N times.
   */
  private sendSnapshots(): void {
    const serverTime = Date.now()
    const events = this.pendingEvents
    this.pendingEvents = []

    for (const client of this.clients.values()) {
      const snap = writeSnapshot(this.world, client.highestSeq, serverTime, events)
      client.transport.send(encodeServer(snap))
    }
  }

  broadcast(m: ServerMessage): void {
    const data = encodeServer(m)
    for (const client of this.clients.values()) client.transport.send(data)
  }

  sendTo(slot: number, m: ServerMessage): void {
    this.clients.get(slot)?.transport.send(encodeServer(m))
  }

  private recordTickDuration(ms: number): void {
    this.tickDurations[this.tickDurationIndex] = ms
    this.tickDurationIndex = (this.tickDurationIndex + 1) % this.tickDurations.length
  }

  /** Tick-time percentile in milliseconds. The budget is well under 15.625. */
  tickTimePercentile(p: number): number {
    const n = Math.min(this.totalTicks, this.tickDurations.length)
    if (n === 0) return 0
    const sorted = Array.from(this.tickDurations.subarray(0, n)).sort((a, b) => a - b)
    const idx = Math.min(n - 1, Math.max(0, Math.floor(p * n)))
    return sorted[idx]!
  }

  stats(): { code: string; players: number; tick: number; p50: number; p99: number } {
    return {
      code: this.code,
      players: this.clients.size,
      tick: this.world.tick,
      p50: this.tickTimePercentile(0.5),
      p99: this.tickTimePercentile(0.99),
    }
  }
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>()

  constructor(private readonly map: MapFactory = buildTestArena) {}

  getOrCreate(code: string): Room {
    const key = code.toUpperCase().slice(0, 8) || 'DEFAULT'
    let room = this.rooms.get(key)
    if (room === undefined) {
      room = new Room(key, this.map)
      this.rooms.set(key, room)
    }
    return room
  }

  release(room: Room): void {
    if (room.isEmpty) this.rooms.delete(room.code)
  }

  all(): Room[] {
    return Array.from(this.rooms.values())
  }
}
