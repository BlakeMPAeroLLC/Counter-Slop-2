/**
 * CLI entry point. All the server logic lives in `server.ts`; this just boots it and wires up
 * signal handling and the periodic health line.
 */

import { PROTOCOL_VERSION } from '@cs2/protocol'
import { SIM } from '@cs2/sim'
import { startGameServer } from './server.js'

const PORT = Number(process.env['PORT'] ?? 8080)
const HOST = process.env['HOST'] ?? '0.0.0.0'

const server = await startGameServer({ port: PORT, host: HOST })

console.log(`counter-slop-2 server on http://${HOST}:${String(server.port)}  (ws path /ws)`)
console.log(
  `  tick ${String(SIM.TICK_HZ)}Hz, snapshots ${String(SIM.SNAPSHOT_HZ)}Hz, ` +
    `protocol v${String(PROTOCOL_VERSION)}`,
)

// Periodic health line. Tick-time p99 is the number that tells you whether the box is coping;
// it should stay far below the 15.625 ms tick budget.
const health = setInterval(() => {
  for (const room of server.rooms.all()) {
    if (room.isEmpty) continue
    const s = room.stats()
    console.log(
      `[${s.code}] players=${String(s.players)} tick=${String(s.tick)} ` +
        `tickTime p50=${s.p50.toFixed(3)}ms p99=${s.p99.toFixed(3)}ms`,
    )
  }
}, 15_000)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n${sig} received, shutting down`)
    clearInterval(health)
    void server.close().then(() => process.exit(0))
  })
}
