import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    // Dev flow: Vite serves the client and forwards the WebSocket to the game server, so
    // the browser only ever talks to one origin and there is no CORS or mixed-content
    // fiddling to do.
    proxy: {
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
      '/health': 'http://localhost:8080',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
})
