/**
 * The wire protocol.
 *
 * M0 encodes messages as JSON. That is a deliberate, temporary choice: it is inspectable in
 * devtools, which is worth a great deal while the netcode is being built, and at 10 players
 * x 32 Hz the bandwidth is irrelevant. M1 replaces the two `encode`/`decode` pairs below
 * with the bit-packed, delta-compressed codec budgeted in docs/PLAN.md §5.4 (~19 bytes per
 * player worst case). Nothing outside this file knows the encoding, so that swap touches
 * only this module.
 *
 * The message *shapes* are already the ones the packed codec will use, so the transition is
 * a codec change rather than a redesign.
 */

import {
  createCommand,
  PFLAG,
  SIM,
  type Command,
  type SimEvent,
  type World,
} from '@cs2/sim'

/**
 * Bumped on ANY change to the message shapes below.
 *
 * The handshake rejects mismatched clients outright. A silent protocol mismatch produces
 * bizarre, hard-to-describe symptoms and is a reliable way to waste an evening — far better
 * to tell the player to refresh.
 */
export const PROTOCOL_VERSION = 1

// ── Client -> Server ────────────────────────────────────────────────────────

export interface HelloMessage {
  readonly t: 'hello'
  readonly protocol: number
  readonly name: string
}

/** A command as it appears on the wire. Same fields as `Command`, shorter keys. */
export interface WireCommand {
  readonly q: number // seq
  readonly k: number // tick
  readonly b: number // buttons
  readonly y: number // yaw
  readonly p: number // pitch
  readonly s: number // subFrac
}

export interface CommandMessage {
  readonly t: 'cmd'
  /**
   * The last few commands, newest last. Resending recent commands makes isolated packet
   * loss free: the next packet carries what the lost one did. Cheaper than any
   * retransmission scheme and it adds no latency.
   */
  readonly c: readonly WireCommand[]
}

export interface PingMessage {
  readonly t: 'ping'
  readonly id: number
  readonly clientTime: number
}

export type ClientMessage = HelloMessage | CommandMessage | PingMessage

// ── Server -> Client ────────────────────────────────────────────────────────

export interface WelcomeMessage {
  readonly t: 'welcome'
  readonly protocol: number
  /** The player slot assigned to this client. */
  readonly you: number
  readonly map: string
  readonly tickRate: number
  readonly snapshotRate: number
  readonly tick: number
  readonly serverTime: number
}

export interface RejectMessage {
  readonly t: 'reject'
  readonly reason: string
}

export interface WirePlayer {
  readonly i: number // slot
  readonly f: number // PFLAG bits
  readonly tm: number // team
  readonly x: number
  readonly y: number
  readonly z: number
  readonly vx: number
  readonly vy: number
  readonly vz: number
  readonly ya: number // yaw
  readonly pi: number // pitch
  readonly hp: number
  readonly ar: number
  readonly wp: number // weapon id
  readonly am: number // ammo
  readonly kl: number // kills
  readonly de: number // deaths
}

export interface SnapshotMessage {
  readonly t: 'snap'
  readonly tick: number
  /** Server wall-clock at send time, for clock sync and interpolation timing. */
  readonly serverTime: number
  /**
   * Highest command sequence the server has consumed from this client.
   *
   * M1 uses this to discard acknowledged predicted commands and replay the rest. M0 sends
   * it so the client can already display input age in the latency HUD.
   */
  readonly ack: number
  readonly players: readonly WirePlayer[]
  readonly events: readonly SimEvent[]
}

export interface PongMessage {
  readonly t: 'pong'
  readonly id: number
  readonly clientTime: number
  readonly serverTime: number
}

export interface PlayerLeftMessage {
  readonly t: 'left'
  readonly slot: number
}

export interface RosterEntry {
  readonly slot: number
  readonly name: string
  readonly team: number
}

/**
 * Slot-to-name mapping, sent on join and leave rather than inside every snapshot.
 *
 * Names change a handful of times per match and snapshots go out 32 times a second, so
 * carrying them per-snapshot would be pure waste.
 */
export interface RosterMessage {
  readonly t: 'roster'
  readonly players: readonly RosterEntry[]
}

export type ServerMessage =
  | WelcomeMessage
  | RejectMessage
  | SnapshotMessage
  | PongMessage
  | PlayerLeftMessage
  | RosterMessage

// ── Codec ───────────────────────────────────────────────────────────────────

export function encodeClient(m: ClientMessage): string {
  return JSON.stringify(m)
}

export function encodeServer(m: ServerMessage): string {
  return JSON.stringify(m)
}

/**
 * Decoders return null rather than throwing on malformed input.
 *
 * A client can send anything at all, so a parse failure is an expected condition to be
 * dropped, not an exception that takes down a room and everyone in it.
 */
export function decodeClient(data: string): ClientMessage | null {
  try {
    const v = JSON.parse(data) as unknown
    if (typeof v !== 'object' || v === null) return null
    const t = (v as { t?: unknown }).t
    if (t !== 'hello' && t !== 'cmd' && t !== 'ping') return null
    return v as ClientMessage
  } catch {
    return null
  }
}

export function decodeServer(data: string): ServerMessage | null {
  try {
    const v = JSON.parse(data) as unknown
    if (typeof v !== 'object' || v === null) return null
    const t = (v as { t?: unknown }).t
    if (
      t !== 'welcome' &&
      t !== 'reject' &&
      t !== 'snap' &&
      t !== 'pong' &&
      t !== 'left' &&
      t !== 'roster'
    ) {
      return null
    }
    return v as ServerMessage
  } catch {
    return null
  }
}

// ── Command conversion ──────────────────────────────────────────────────────

export function toWireCommand(c: Command): WireCommand {
  return { q: c.seq, k: c.tick, b: c.buttons, y: c.yaw, p: c.pitch, s: c.subFrac }
}

/**
 * Converts a wire command into a sim command, rejecting anything non-finite.
 *
 * A client controls every byte here, so `NaN` in a yaw would otherwise propagate into the
 * world state and poison the simulation for everyone in the room.
 */
export function fromWireCommand(w: WireCommand, out: Command = createCommand()): Command | null {
  if (
    !Number.isFinite(w.q) ||
    !Number.isFinite(w.k) ||
    !Number.isFinite(w.b) ||
    !Number.isFinite(w.y) ||
    !Number.isFinite(w.p) ||
    !Number.isFinite(w.s)
  ) {
    return null
  }
  out.seq = w.q >>> 0
  out.tick = w.k | 0
  out.buttons = w.b | 0
  out.yaw = w.y
  out.pitch = w.p
  out.subFrac = w.s >= 0 && w.s < 1 ? w.s : 0
  return out
}

// ── Snapshot conversion ─────────────────────────────────────────────────────

/**
 * Serialises the full world state.
 *
 * M0 sends everything to everyone every snapshot. M1 delta-compresses against the last
 * acknowledged snapshot, and M5 adds PVS culling so players you cannot see are never
 * transmitted at all — which is both a bandwidth win and the structural defence against
 * wallhacks described in docs/PLAN.md §10.
 */
export function writeSnapshot(
  world: World,
  ackForClient: number,
  serverTime: number,
  events: readonly SimEvent[],
): SnapshotMessage {
  const p = world.p
  const players: WirePlayer[] = []

  for (let i = 0; i < SIM.MAX_PLAYERS; i++) {
    if (p.active[i] === 0) continue
    players.push({
      i,
      f: p.flags[i]!,
      tm: p.team[i]!,
      x: p.posX[i]!,
      y: p.posY[i]!,
      z: p.posZ[i]!,
      vx: p.velX[i]!,
      vy: p.velY[i]!,
      vz: p.velZ[i]!,
      ya: p.yaw[i]!,
      pi: p.pitch[i]!,
      hp: p.health[i]!,
      ar: p.armor[i]!,
      wp: p.weapon[i]!,
      am: p.ammo[i]!,
      kl: p.kills[i]!,
      de: p.deaths[i]!,
    })
  }

  return {
    t: 'snap',
    tick: world.tick,
    serverTime,
    ack: ackForClient,
    players,
    // Events are passed in rather than read from `world.events`: the world clears its event
    // list every tick, but snapshots go out less often than the tick rate, so the caller has
    // to accumulate them across the gap. Reading `world.events` here would silently drop
    // every event that happened on a non-snapshot tick.
    events,
  }
}

/**
 * Writes an authoritative snapshot into a local world.
 *
 * Slots absent from the snapshot are deactivated, so a player who left stops being
 * rendered without needing a separate teardown message to arrive first.
 */
export function applySnapshot(world: World, snap: SnapshotMessage): void {
  const p = world.p
  const seen = new Uint8Array(SIM.MAX_PLAYERS)

  for (const w of snap.players) {
    const i = w.i
    if (i < 0 || i >= SIM.MAX_PLAYERS) continue
    seen[i] = 1

    p.active[i] = 1
    p.flags[i] = w.f
    p.team[i] = w.tm
    p.posX[i] = w.x
    p.posY[i] = w.y
    p.posZ[i] = w.z
    p.velX[i] = w.vx
    p.velY[i] = w.vy
    p.velZ[i] = w.vz
    p.yaw[i] = w.ya
    p.pitch[i] = w.pi
    p.health[i] = w.hp
    p.armor[i] = w.ar
    p.weapon[i] = w.wp
    p.ammo[i] = w.am
    p.kills[i] = w.kl
    p.deaths[i] = w.de
  }

  for (let i = 0; i < SIM.MAX_PLAYERS; i++) {
    if (seen[i] === 0) {
      p.active[i] = 0
      p.flags[i] = PFLAG.DEAD
    }
  }

  world.tick = snap.tick
}
