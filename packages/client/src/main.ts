/**
 * Client bootstrap and main loop.
 *
 * WHAT M0 DOES AND DOES NOT DO — read this before judging how it feels.
 *
 * View angles are local and immediate: mouse look never waits for the server. Position,
 * however, comes straight from the authoritative snapshot with NO prediction and NO
 * interpolation. That is the plan's M0 baseline (docs/PLAN.md §11), and it is deliberate:
 *
 *   - your own movement will feel like it lags by roughly the RTT
 *   - other players will step at 32 Hz rather than moving smoothly
 *
 * Both are the exact symptoms M1's prediction and entity interpolation exist to remove, and
 * the net panel in the corner is how you tell whether they worked. Fixing them here, by
 * feel, before the measurement exists, is how projects end up with netcode nobody
 * understands.
 */

import {
  BTN,
  MOVE,
  PFLAG,
  SIM,
  buildTestArena,
  createCommand,
  createWorld,
  type Command,
} from '@cs2/sim'
import { applySnapshot } from '@cs2/protocol'
import { Hud } from './hud.js'
import { Input } from './input.js'
import { Net } from './net.js'
import { Renderer } from './render.js'

const TICK_MS = 1000 / SIM.CMD_HZ
/** How many recent commands to keep for the redundant resend. */
const COMMAND_HISTORY = 8

const canvas = document.getElementById('view') as HTMLCanvasElement
const overlay = document.getElementById('overlay') as HTMLDivElement
const statusEl = document.getElementById('status') as HTMLParagraphElement
const joinButton = document.getElementById('join') as HTMLButtonElement
const nameInput = document.getElementById('name') as HTMLInputElement
const roomInput = document.getElementById('room') as HTMLInputElement

const world = createWorld(buildTestArena())
const renderer = new Renderer(canvas)
const input = new Input(canvas)
const hud = new Hud()
const net = new Net()

renderer.buildMap(world.map)

// ── Connect flow ────────────────────────────────────────────────────────────

nameInput.value = localStorage.getItem('cs2.name') ?? ''
roomInput.value = new URLSearchParams(location.search).get('room') ?? ''

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text
  statusEl.classList.toggle('error', isError)
}

net.onStateChange = (state) => {
  switch (state) {
    case 'connecting':
      setStatus('Connecting…')
      joinButton.disabled = true
      break
    case 'connected':
      setStatus('')
      overlay.classList.add('hidden')
      hud.setInGame(true)
      input.requestLock()
      break
    case 'closed':
      setStatus('Disconnected.', true)
      overlay.classList.remove('hidden')
      hud.setInGame(false)
      joinButton.disabled = false
      break
    case 'error':
      setStatus(net.rejectReason || 'Connection error.', true)
      overlay.classList.remove('hidden')
      hud.setInGame(false)
      joinButton.disabled = false
      break
    case 'idle':
      break
  }
}

net.onSnapshot = (snap) => {
  applySnapshot(world, snap)
  hud.handleEvents(snap.events, net.you, net)

  // Tracers and impacts come from server events, not from local guesses, so what you see is
  // what actually happened.
  for (const ev of snap.events) {
    if (ev.k === 'fire') {
      renderer.addTracer(ev.ox, ev.oy, ev.oz, ev.ex, ev.ey, ev.ez)
      if (ev.hitWorld) renderer.addImpact(ev.ex, ev.ey, ev.ez)
    }
  }
}

function join(): void {
  const name = nameInput.value.trim() || 'player'
  localStorage.setItem('cs2.name', name)
  net.connect(name, roomInput.value.trim().toUpperCase())
}

joinButton.addEventListener('click', join)
for (const el of [nameInput, roomInput]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') join()
  })
}

// Clicking the canvas after Esc re-acquires the mouse without reconnecting.
canvas.addEventListener('click', () => {
  if (net.state === 'connected' && !input.pointerLocked) input.requestLock()
})

// ── Command generation ──────────────────────────────────────────────────────

const commandHistory: Command[] = []
let nextSeq = 1
let clientTick = 0
let tickAccumulator = 0
let lastFrameTime = performance.now()

/**
 * Emits one command for a fixed 64 Hz tick.
 *
 * The accumulator decouples command rate from frame rate. A 60 Hz display emits mostly one
 * command per frame and occasionally two; a 144 Hz display emits one every other frame or so.
 * Either way the server receives a steady 64 per second, which is what keeps movement
 * consistent across machines with different refresh rates.
 */
function emitCommand(nowMs: number): void {
  const cmd = createCommand()
  cmd.seq = nextSeq++
  cmd.tick = clientTick++
  cmd.buttons = input.buttons
  cmd.yaw = input.yaw
  cmd.pitch = input.pitch
  cmd.subFrac = input.consumeSubFrac(nowMs, TICK_MS)

  commandHistory.push(cmd)
  while (commandHistory.length > COMMAND_HISTORY) commandHistory.shift()

  net.sendCommand(cmd, commandHistory)
}

// ── Main loop ───────────────────────────────────────────────────────────────

function frame(now: number): void {
  const frameMs = now - lastFrameTime
  lastFrameTime = now

  if (net.state === 'connected') {
    // Clamp the accumulator so returning from a background tab does not emit a burst of
    // hundreds of stale commands.
    tickAccumulator = Math.min(tickAccumulator + frameMs, TICK_MS * 8)
    while (tickAccumulator >= TICK_MS) {
      tickAccumulator -= TICK_MS
      emitCommand(now - tickAccumulator)
    }
  }

  const slot = net.you
  if (slot >= 0 && world.p.active[slot] === 1) {
    const p = world.p
    const crouching = (p.flags[slot]! & PFLAG.CROUCHING) !== 0
    const eye = crouching ? MOVE.EYE_HEIGHT_CROUCH : MOVE.EYE_HEIGHT_STAND

    // Position is authoritative (no prediction in M0); view angles are local, so aiming is
    // instant even though movement is not.
    renderer.setCameraFromEye(
      p.posX[slot]!,
      p.posY[slot]! + eye,
      p.posZ[slot]!,
      input.yaw,
      input.pitch,
    )

    hud.updatePlayerState(world, slot)
    hud.updateScoreboard(world, input.showScoreboard, net)
  }

  renderer.updatePlayers(world, slot)
  renderer.render(now)
  hud.updateNet(net, now, frameMs)

  requestAnimationFrame(frame)
}

requestAnimationFrame(frame)

// Expose a few internals for console poking during the M0 feel pass. Handy, and harmless —
// the client is not the authority on anything.
Object.assign(window as unknown as Record<string, unknown>, {
  cs2: { world, net, input, renderer, BTN },
})
