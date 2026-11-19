// Sound effects: samples from client/public/sounds/, with synthesised fallbacks if a file is missing.
const FILES = ['rifle_shot', 'smg_shot', 'pistol_shot', 'sniper_shot', 'knife_swing', 'reload', 'draw',
  'step1', 'step2', 'step3', 'step4', 'land', 'hit', 'headshot', 'hurt']
const SHOT_FILE = ['knife_swing', 'pistol_shot', 'smg_shot', 'rifle_shot', 'sniper_shot']
export function createAudio() {
  let ctx = null, noiseBuf = null, master = null
  const listener = { x: 0, y: 0, z: 0, yaw: 0 }
  const buf = {}

  /** Play a loaded sample. Returns false if it is not available (caller falls back to synth). */
  function play(name, pos, vol, rateJitter = 0) {
    const b = buf[name]
    if (!b) return false
    const src = ctx.createBufferSource()
    src.buffer = b
    src.playbackRate.value = 1 + (Math.random() - 0.5) * rateJitter
    src.connect(out(pos, vol))
    src.start()
    return true
  }

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return }
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    ctx = new AC()
    master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination)
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const d = noiseBuf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    for (const f of FILES) {
      fetch(`/sounds/${f}.ogg`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
        .then((a) => ctx.decodeAudioData(a)).then((b) => { buf[f] = b }).catch(() => {})
    }
  }

  /** Returns an output node attenuated + panned for a world position (or centred if pos is null). */
  function out(pos, vol) {
    const g = ctx.createGain()
    let pan = 0
    if (pos) {
      const dx = pos.x - listener.x, dz = pos.z - listener.z, dy = pos.y - listener.y
      const dist = Math.hypot(dx, dy, dz)
      vol *= 1 / (1 + dist / 260)
      const rx = Math.cos(listener.yaw), rz = -Math.sin(listener.yaw)
      pan = dist > 1 ? Math.max(-1, Math.min(1, (dx * rx + dz * rz) / dist)) * 0.85 : 0
    }
    g.gain.value = vol
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner(); p.pan.value = pan
      g.connect(p); p.connect(master)
    } else g.connect(master)
    return g
  }

  function noise(dest, t0, dur, freq, type, gain, q = 0.8) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q
    const g = ctx.createGain()
    g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + dur)
    src.connect(f); f.connect(g); g.connect(dest)
    src.start(t0, Math.random() * 0.5); src.stop(t0 + dur + 0.02)
  }

  function tone(dest, t0, dur, f0, f1, gain, type = 'sine') {
    const o = ctx.createOscillator(); o.type = type
    o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + dur)
    o.connect(g); g.connect(dest)
    o.start(t0); o.stop(t0 + dur + 0.02)
  }

  const SHOT = [
    null,
    { lp: 3800, dur: 0.16, thump: 190, vol: 0.75 },
    { lp: 4600, dur: 0.12, thump: 170, vol: 0.65 },
    { lp: 2600, dur: 0.26, thump: 130, vol: 1.0 },
    { lp: 1700, dur: 0.6, thump: 85, vol: 1.3 },
  ]

  return {
    init,
    setListener(x, y, z, yaw) { listener.x = x; listener.y = y; listener.z = z; listener.yaw = yaw },
    shot(w, pos) {
      if (!ctx) return
      if (play(SHOT_FILE[w], pos, w === 0 ? 0.5 : w === 4 ? 1.1 : 0.8, 0.06)) return
      const t = ctx.currentTime
      if (w === 0) { noise(out(pos, 0.3), t, 0.12, 2500, 'bandpass', 0.6, 1.5); return }
      const S = SHOT[w], o = out(pos, S.vol)
      noise(o, t, S.dur, S.lp, 'lowpass', 1.0)
      noise(o, t, 0.03, 6000, 'highpass', 0.5)
      tone(o, t, S.dur * 0.7, S.thump, S.thump * 0.3, 0.9)
    },
    step(pos, vol = 0.22) {
      if (!ctx) return
      if (play('step' + (1 + Math.floor(Math.random() * 4)), pos, vol * 2.2, 0.12)) return
      noise(out(pos, vol), ctx.currentTime, 0.07, 240 + Math.random() * 160, 'bandpass', 1.0, 1.2)
    },
    land(pos) { if (ctx && !play('land', pos, 0.6)) { const o = out(pos, 0.4); noise(o, ctx.currentTime, 0.12, 180, 'lowpass', 1.0) } },
    reload(pos) {
      if (!ctx || play('reload', pos, 0.6)) return
      const o = out(pos, 0.35), t = ctx.currentTime
      noise(o, t + 0.25, 0.04, 2800, 'bandpass', 0.9, 3)
      noise(o, t + 1.3, 0.05, 2000, 'bandpass', 0.9, 3)
      noise(o, t + 1.85, 0.05, 3400, 'bandpass', 1.0, 3)
    },
    draw() { if (ctx && !play('draw', null, 0.4)) noise(out(null, 0.2), ctx.currentTime, 0.08, 1800, 'bandpass', 0.8, 2) },
    hit(head) {
      if (!ctx || play(head ? 'headshot' : 'hit', null, 0.7)) return
      const o = out(null, 0.5), t = ctx.currentTime
      if (head) { tone(o, t, 0.16, 2300, 1900, 0.5, 'triangle'); tone(o, t, 0.1, 3400, 3000, 0.25) }
      else tone(o, t, 0.06, 1100, 700, 0.4, 'triangle')
    },
    hurt() { if (ctx && !play('hurt', null, 0.7)) { const o = out(null, 0.5); tone(o, ctx.currentTime, 0.14, 160, 70, 0.9); noise(o, ctx.currentTime, 0.08, 900, 'lowpass', 0.5) } },
    kill() { if (ctx) { const o = out(null, 0.4), t = ctx.currentTime; tone(o, t, 0.1, 660, 660, 0.4, 'triangle'); tone(o, t + 0.09, 0.18, 990, 990, 0.4, 'triangle') } },
  }
}
