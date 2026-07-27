import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    environment: 'node',
    // Determinism tests spawn fresh module graphs; keep output readable.
    reporters: ['default'],
  },
})
