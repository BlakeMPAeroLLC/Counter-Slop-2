/**
 * The game server, as a createable unit.
 *
 * Exported as a factory rather than executed at import time so integration tests can boot it
 * on an ephemeral port and tear it down cleanly. `index.ts` is the thin CLI wrapper.
 *
 * M0 uses WebSocket (TCP). M1 adds WebTransport with unreliable datagrams and keeps this as
 * the fallback — see docs/PLAN.md §5.5. Snapshots over TCP suffer head-of-line blocking under
 * packet loss, which is exactly the problem datagrams solve, but WebSocket is perfectly
 * playable on a good connection and it lets M0 focus on the simulation.
 */

import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { PROTOCOL_VERSION, decodeClient, encodeServer } from '@cs2/protocol'
import { SIM } from '@cs2/sim'
import { RoomManager, type MapFactory, type Transport } from './room.js'

/**
 * Where the built client lives. Serving it is a production concern — in development Vite
 * serves the client and proxies /ws here.
 *
 * Resolved from this module's own location rather than `process.cwd()`, because the working
 * directory depends on how the server was launched (`pnpm start` from the repo root and
 * `pnpm --filter @cs2/server start` have different cwds) and getting it wrong turns into a
 * confusing 404 instead of an obvious error.
 */
const CLIENT_DIST =
  process.env['CLIENT_DIST'] !== undefined
    ? resolve(process.env['CLIENT_DIST'])
    : fileURLToPath(new URL('../../client/dist', import.meta.url))

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

export interface GameServer {
  readonly rooms: RoomManager
  /** The actually-bound port, which matters when the caller asked for port 0. */
  readonly port: number
  close(): Promise<void>
}

export interface GameServerOptions {
  port?: number
  host?: string
  /** Suppress per-connection logging. Integration tests do not need the noise. */
  quiet?: boolean
  /** Override the map every room is built with. Tests use a map with known sightlines. */
  map?: MapFactory
}

export async function startGameServer(options: GameServerOptions = {}): Promise<GameServer> {
  const rooms = new RoomManager(options.map)
  const log = options.quiet === true ? (): void => undefined : console.log.bind(console)

  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          protocol: PROTOCOL_VERSION,
          tickRate: SIM.TICK_HZ,
          rooms: rooms.all().map((r) => r.stats()),
        }),
      )
      return
    }

    void serveStatic(url.pathname)
      .then(({ status, body, type }) => {
        res.writeHead(status, { 'content-type': type })
        res.end(body)
      })
      .catch(() => {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('internal error')
      })
  })

  const wss = new WebSocketServer({ server: http, path: '/ws' })

  wss.on('connection', (socket: WebSocket, req) => {
    const url = new URL(req.url ?? '/ws', 'http://localhost')
    const room = rooms.getOrCreate(url.searchParams.get('room') ?? 'DEFAULT')

    const transport: Transport = {
      send(data: string) {
        if (socket.readyState === socket.OPEN) socket.send(data)
      },
      close() {
        socket.close()
      },
    }

    let slot = -1
    let cleanedUp = false

    socket.on('message', (raw: unknown, isBinary: boolean) => {
      if (isBinary) return
      const msg = decodeClient(String(raw))
      if (msg === null) return

      switch (msg.t) {
        case 'hello': {
          if (slot >= 0) return
          if (msg.protocol !== PROTOCOL_VERSION) {
            // Say so explicitly. A silent version mismatch produces symptoms nobody can
            // describe, and reliably wastes an evening.
            transport.send(
              encodeServer({
                t: 'reject',
                reason:
                  `Version mismatch: server speaks protocol ${String(PROTOCOL_VERSION)}, ` +
                  `you sent ${String(msg.protocol)}. Refresh the page.`,
              }),
            )
            socket.close()
            return
          }

          const name = sanitizeName(msg.name)
          slot = room.join(transport, name)
          if (slot < 0) {
            transport.send(encodeServer({ t: 'reject', reason: 'Room is full.' }))
            socket.close()
            return
          }

          transport.send(
            encodeServer({
              t: 'welcome',
              protocol: PROTOCOL_VERSION,
              you: slot,
              map: room.world.map.name,
              tickRate: SIM.TICK_HZ,
              snapshotRate: SIM.SNAPSHOT_HZ,
              tick: room.world.tick,
              serverTime: Date.now(),
            }),
          )
          room.broadcastRoster()
          log(
            `[${room.code}] + ${name} joined as slot ${String(slot)} ` +
              `(${String(room.playerCount)} in room)`,
          )
          return
        }

        case 'cmd': {
          if (slot < 0) return
          if (!Array.isArray(msg.c)) return
          room.receiveCommands(slot, msg.c)
          return
        }

        case 'ping': {
          // Echoed straight back, so the client measures RTT without needing the two clocks
          // to agree on anything.
          transport.send(
            encodeServer({
              t: 'pong',
              id: msg.id,
              clientTime: msg.clientTime,
              serverTime: Date.now(),
            }),
          )
          return
        }
      }
    })

    const cleanup = (): void => {
      if (cleanedUp) return
      cleanedUp = true
      if (slot >= 0) {
        log(`[${room.code}] - ${room.clientName(slot)} left slot ${String(slot)}`)
        room.leave(slot)
      }
      rooms.release(room)
    }

    socket.on('close', cleanup)
    socket.on('error', cleanup)
  })

  const port = await listen(http, options.port ?? 8080, options.host ?? '0.0.0.0')

  return {
    rooms,
    port,
    async close() {
      // Rooms hold pending timers; stopping them first is what lets the process actually exit.
      for (const room of rooms.all()) room.shutdown()

      // `wss.close()` waits for its clients to finish closing, and a graceful close needs a
      // round trip the peer may never complete. Terminate them so shutdown cannot hang.
      for (const client of wss.clients) client.terminate()

      await new Promise<void>((done) => {
        wss.close(() => done())
      })
      await new Promise<void>((done) => {
        http.close(() => done())
      })
    },
  }
}

function listen(http: Server, port: number, host: string): Promise<number> {
  return new Promise((resolvePort, reject) => {
    http.once('error', reject)
    http.listen(port, host, () => {
      http.removeListener('error', reject)
      const addr = http.address()
      resolvePort(addr !== null && typeof addr === 'object' ? (addr as AddressInfo).port : port)
    })
  })
}

async function serveStatic(
  pathname: string,
): Promise<{ status: number; body: string | Buffer; type: string }> {
  const rel = pathname === '/' ? '/index.html' : pathname
  // Contain the path inside CLIENT_DIST: `normalize` collapses `..` segments, and the prefix
  // check rejects anything that still escapes.
  const target = join(CLIENT_DIST, normalize(rel))
  if (!target.startsWith(CLIENT_DIST)) {
    return { status: 403, body: 'forbidden', type: 'text/plain' }
  }

  try {
    const body = await readFile(target)
    return { status: 200, body, type: MIME[extname(target)] ?? 'application/octet-stream' }
  } catch {
    return {
      status: 404,
      body: 'Not found. In development the client is served by Vite on :5173.',
      type: 'text/plain',
    }
  }
}

function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return 'player'
  // Strip control characters so a name cannot smuggle escape sequences into a terminal log
  // line or the killfeed.
  const clean = raw
    .replace(/\p{C}/gu, '')
    .trim()
    .slice(0, 16)
  return clean.length > 0 ? clean : 'player'
}
