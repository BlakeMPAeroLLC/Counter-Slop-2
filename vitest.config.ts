import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],

    /**
     * Timing-sensitive tests need room to breathe.
     *
     * The server integration tests drive a real 64 Hz loop over real sockets, so they are
     * wall-clock bound rather than CPU bound. 5 seconds (the default) is not enough for a
     * multi-burst firefight.
     */
    testTimeout: 30_000,
    hookTimeout: 20_000,

    /**
     * Run test FILES one at a time.
     *
     * The determinism suite runs 10,000 ticks several times over and will happily saturate
     * every core. In parallel with the server tests it starves their `setTimeout`-driven tick
     * loop, and the failures look exactly like netcode bugs rather than like CPU contention —
     * which is a genuinely expensive kind of false alarm.
     */
    fileParallelism: false,
  },
})
