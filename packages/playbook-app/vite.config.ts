import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // 5173 belongs to the game client; the playbook sits next to it so both can run at once
    // (`pnpm dev` starts every package in parallel).
    port: 5174,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
})
