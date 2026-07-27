/**
 * Network client and latency instrumentation.
 *
 * The measurement half of this file is the point of M0. The exit gate is not "it works", it
 * is "here is the measured input-to-pixel latency" — and you cannot tell whether M1's
 * prediction helped unless the number was already on screen beforehand.
 *
 * `input→pixel` here is measured honestly: each outgoing command records the local time it
 * was created, and when a snapshot arrives acknowledging that command, the elapsed time is
 * the full loop the player actually feels — sample, send, simulate, snapshot, receive.
 * (It excludes the final compositor present, so add roughly one frame.)
 */

import {
  PROTOCOL_VERSION,
  decodeServer,
  encodeClient,
  toWireCommand,
  type RosterEntry,
  type ServerMessage,
  type SnapshotMessage,
  type WireCommand,
} from '@cs2/protocol'
import { SIM, type Command } from '@cs2/sim'

export interface NetStats {
  rttMs: number
  jitterMs: number
  /** Full sample-to-acknowledged-snapshot latency for local input. */
  inputLagMs: number
  snapshotsPerSecond: number
  /** Age of the newest command the server has acknowledged. */
  cmdAgeMs: number
  packetLossPct: number
}

export type NetState = 'idle' | 'connecting' | 'connected' | 'closed' | 'error'

const PING_INTERVAL_MS = 250
const RTT_WINDOW = 24
const PENDING_LIMIT = 256

export class Net {
  state: NetState = 'idle'
  /** Player slot assigned by the server, or -1 before the welcome arrives. */
  you = -1
  rejectReason = ''

  readonly roster = new Map<number, RosterEntry>()
  readonly stats: NetStats = {
    rttMs: 0,
    jitterMs: 0,
    inputLagMs: 0,
    snapshotsPerSecond: 0,
    cmdAgeMs: 0,
    packetLossPct: 0,
  }

  /** History for the net graph, newest last. */
  readonly rttHistory: number[] = []

  onSnapshot: ((snap: SnapshotMessage) => void) | null = null
  onWelcome: (() => void) | null = null
  onStateChange: ((state: NetState) => void) | null = null

  private socket: WebSocket | null = null
  private pingTimer: number | null = null
  private nextPingId = 1

  private readonly rttSamples: number[] = []
  /** seq -> local time the command was created, for the input-lag measurement. */
  private readonly pending = new Map<number, number>()
  private pingsSent = 0
  private pongsReceived = 0

  private snapshotTimes: number[] = []
  private lastAck = 0

  connect(name: string, room: string): void {
    this.disconnect()

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${location.host}/ws?room=${encodeURIComponent(room || 'DEFAULT')}`

    this.setState('connecting')
    const socket = new WebSocket(url)
    this.socket = socket

    socket.addEventListener('open', () => {
      socket.send(encodeClient({ t: 'hello', protocol: PROTOCOL_VERSION, name }))
      this.startPinging()
    })

    socket.addEventListener('message', (e: MessageEvent<string>) => {
      const msg = decodeServer(e.data)
      if (msg !== null) this.handle(msg)
    })

    socket.addEventListener('close', () => {
      this.stopPinging()
      // Preserve an explicit rejection: 'error' is more useful to show than 'closed' when
      // the server told us why.
      if (this.state !== 'error') this.setState('closed')
    })

    socket.addEventListener('error', () => {
      if (this.rejectReason === '') this.rejectReason = 'Connection failed.'
      this.setState('error')
    })
  }

  disconnect(): void {
    this.stopPinging()
    if (this.socket !== null) {
      this.socket.onclose = null
      this.socket.close()
      this.socket = null
    }
    this.you = -1
    this.roster.clear()
    this.pending.clear()
  }

  private setState(s: NetState): void {
    this.state = s
    this.onStateChange?.(s)
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome': {
        this.you = msg.you
        this.setState('connected')
        this.onWelcome?.()
        return
      }

      case 'reject': {
        this.rejectReason = msg.reason
        this.setState('error')
        return
      }

      case 'roster': {
        this.roster.clear()
        for (const e of msg.players) this.roster.set(e.slot, e)
        return
      }

      case 'left': {
        this.roster.delete(msg.slot)
        return
      }

      case 'snap': {
        this.recordSnapshot(msg)
        this.onSnapshot?.(msg)
        return
      }

      case 'pong': {
        this.pongsReceived++
        const rtt = performance.now() - msg.clientTime
        this.recordRtt(rtt)
        return
      }
    }
  }

  private recordSnapshot(snap: SnapshotMessage): void {
    const now = performance.now()

    this.snapshotTimes.push(now)
    const cutoff = now - 1000
    while (this.snapshotTimes.length > 0 && this.snapshotTimes[0]! < cutoff) {
      this.snapshotTimes.shift()
    }
    this.stats.snapshotsPerSecond = this.snapshotTimes.length

    // Resolve input latency for the newest acknowledged command.
    if (snap.ack > this.lastAck) {
      const sentAt = this.pending.get(snap.ack)
      if (sentAt !== undefined) {
        this.stats.inputLagMs = now - sentAt
        this.stats.cmdAgeMs = now - sentAt
      }
      // Everything at or below the ack is resolved; drop it.
      for (const seq of this.pending.keys()) {
        if (seq <= snap.ack) this.pending.delete(seq)
      }
      this.lastAck = snap.ack
    } else if (this.pending.size > 0) {
      // Nothing new acknowledged: report how stale our oldest unacknowledged input is.
      let oldest = Infinity
      for (const t of this.pending.values()) if (t < oldest) oldest = t
      if (oldest !== Infinity) this.stats.cmdAgeMs = now - oldest
    }
  }

  private recordRtt(rtt: number): void {
    this.rttSamples.push(rtt)
    if (this.rttSamples.length > RTT_WINDOW) this.rttSamples.shift()

    let sum = 0
    for (const r of this.rttSamples) sum += r
    const mean = sum / this.rttSamples.length

    // Mean absolute deviation. Cheaper than a standard deviation and easier to read on a
    // HUD, since it is in the same units as the RTT beside it.
    let dev = 0
    for (const r of this.rttSamples) dev += Math.abs(r - mean)

    this.stats.rttMs = mean
    this.stats.jitterMs = dev / this.rttSamples.length
    this.stats.packetLossPct =
      this.pingsSent > 0 ? Math.max(0, (1 - this.pongsReceived / this.pingsSent) * 100) : 0

    this.rttHistory.push(rtt)
    if (this.rttHistory.length > 220) this.rttHistory.shift()
  }

  private startPinging(): void {
    this.stopPinging()
    this.pingsSent = 0
    this.pongsReceived = 0
    this.pingTimer = window.setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return
      this.pingsSent++
      this.socket.send(
        encodeClient({ t: 'ping', id: this.nextPingId++, clientTime: performance.now() }),
      )
    }, PING_INTERVAL_MS)
  }

  private stopPinging(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  /**
   * Sends a command plus the previous few.
   *
   * The redundancy is what makes isolated packet loss free — the next packet carries what
   * the lost one did, at zero added latency and a few bytes of cost. Far simpler than any
   * retransmission scheme, and better suited to input that goes stale anyway.
   */
  sendCommand(cmd: Command, recent: readonly Command[]): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return

    this.pending.set(cmd.seq, performance.now())
    // Bound the map: a client that never gets acked should not leak memory forever.
    if (this.pending.size > PENDING_LIMIT) {
      const oldest = this.pending.keys().next()
      if (!oldest.done) this.pending.delete(oldest.value)
    }

    const batch: WireCommand[] = []
    const start = Math.max(0, recent.length - SIM.CMDS_PER_PACKET)
    for (let i = start; i < recent.length; i++) batch.push(toWireCommand(recent[i]!))

    this.socket.send(encodeClient({ t: 'cmd', c: batch }))
  }

  nameOf(slot: number): string {
    return this.roster.get(slot)?.name ?? `slot ${String(slot)}`
  }
}
