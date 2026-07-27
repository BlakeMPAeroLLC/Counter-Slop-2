/**
 * HUD, killfeed, scoreboard and the net graph.
 *
 * All DOM, deliberately (docs/PLAN.md §3): text layout, animation and iteration are far
 * cheaper in CSS than in a 3D scene, and none of it needs to be depth-tested.
 */

import { HITBOX, PFLAG, SIM, type SimEvent, type World } from '@cs2/sim'
import type { Net } from './net.js'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`missing element #${id}`)
  return node as T
}

const KILLFEED_MAX = 5
const KILLFEED_TTL_MS = 5000

export class Hud {
  private readonly hp = el('hp')
  private readonly ammo = el('ammo')
  private readonly ammoMax = el<HTMLElement>('hud-right').querySelector('.hud-label')
  private readonly hud = el('hud')
  private readonly crosshair = el('crosshair')
  private readonly hitmarker = el('hitmarker')
  private readonly killfeed = el('killfeed')
  private readonly scoreboard = el('scoreboard')

  private readonly netRtt = el('net-rtt')
  private readonly netJitter = el('net-jitter')
  private readonly netInputLag = el('net-inputlag')
  private readonly netSnaps = el('net-snaps')
  private readonly netAck = el('net-ack')
  private readonly netFps = el('net-fps')
  private readonly netCanvas = el<HTMLCanvasElement>('net-canvas')
  private readonly netCtx: CanvasRenderingContext2D | null

  private readonly feedEntries: { node: HTMLElement; born: number }[] = []

  private frameTimes: number[] = []
  private hitmarkerTimer = 0

  constructor() {
    this.netCtx = this.netCanvas.getContext('2d')
  }

  setInGame(inGame: boolean): void {
    this.hud.hidden = !inGame
    this.crosshair.hidden = !inGame
  }

  updatePlayerState(world: World, slot: number): void {
    if (slot < 0) return
    const p = world.p

    const health = p.health[slot] ?? 0
    this.hp.textContent = String(health)
    this.hp.classList.toggle('low', health <= 35)

    const ammo = p.ammo[slot] ?? 0
    this.ammo.textContent = String(ammo)
    if (this.ammoMax !== null) {
      const reloading = ((p.flags[slot] ?? 0) & PFLAG.RELOADING) !== 0
      this.ammoMax.textContent = reloading ? 'RELOADING' : '/ 30'
    }
  }

  /**
   * Turns simulation events into feedback.
   *
   * A mechanic the player cannot perceive does not exist, so every event the server reports
   * gets a visible or audible consequence — hit markers, tracers, killfeed. Audio arrives in
   * M4 and hangs off this same switch.
   */
  handleEvents(events: readonly SimEvent[], localSlot: number, net: Net): void {
    for (const ev of events) {
      switch (ev.k) {
        case 'hit': {
          if (ev.p === localSlot) this.showHitmarker(ev.hitbox === HITBOX.HEAD)
          break
        }
        case 'death': {
          const victim = net.nameOf(ev.p)
          const killer = ev.by >= 0 ? net.nameOf(ev.by) : null
          this.addKillfeed(killer, victim, ev.headshot, ev.by, ev.p)
          break
        }
        case 'fire':
        case 'spawn':
          break
      }
    }
  }

  private showHitmarker(headshot: boolean): void {
    this.hitmarker.hidden = false
    this.hitmarker.classList.toggle('headshot', headshot)
    // Restart the animation by forcing a reflow; otherwise rapid hits show only the first.
    this.hitmarker.classList.remove('show')
    void this.hitmarker.offsetWidth
    this.hitmarker.classList.add('show')

    window.clearTimeout(this.hitmarkerTimer)
    this.hitmarkerTimer = window.setTimeout(() => {
      this.hitmarker.classList.remove('show')
    }, 200)
  }

  private addKillfeed(
    killer: string | null,
    victim: string,
    headshot: boolean,
    killerSlot: number,
    victimSlot: number,
  ): void {
    const node = document.createElement('div')
    node.className = 'kf'

    const kTeam = killerSlot >= 0 ? `t${String(killerSlot % 2)}` : ''
    const vTeam = `t${String(victimSlot % 2)}`

    if (killer === null) {
      node.innerHTML = `<span class="${vTeam}">${escapeHtml(victim)}</span> fell to their death`
    } else {
      const mark = headshot ? ' <span class="hs">HS</span>' : ''
      node.innerHTML =
        `<span class="${kTeam}">${escapeHtml(killer)}</span>` +
        ` → <span class="${vTeam}">${escapeHtml(victim)}</span>${mark}`
    }

    this.killfeed.appendChild(node)
    this.feedEntries.push({ node, born: performance.now() })

    while (this.feedEntries.length > KILLFEED_MAX) {
      const dropped = this.feedEntries.shift()
      dropped?.node.remove()
    }
  }

  private expireKillfeed(now: number): void {
    while (this.feedEntries.length > 0 && now - this.feedEntries[0]!.born > KILLFEED_TTL_MS) {
      const dropped = this.feedEntries.shift()
      dropped?.node.remove()
    }
  }

  updateScoreboard(world: World, visible: boolean, net: Net): void {
    this.scoreboard.hidden = !visible
    if (!visible) return

    const p = world.p
    const rows: { slot: number; name: string; team: number; k: number; d: number }[] = []
    for (let i = 0; i < SIM.MAX_PLAYERS; i++) {
      if (p.active[i] === 0) continue
      rows.push({
        slot: i,
        name: net.nameOf(i),
        team: p.team[i] ?? 0,
        k: p.kills[i] ?? 0,
        d: p.deaths[i] ?? 0,
      })
    }
    rows.sort((a, b) => b.k - a.k || a.d - b.d || a.slot - b.slot)

    const body = rows
      .map(
        (r) =>
          `<tr class="${r.slot === net.you ? 'me' : ''}">` +
          `<td class="t${String(r.team)}">${escapeHtml(r.name)}</td>` +
          `<td class="num">${String(r.k)}</td>` +
          `<td class="num">${String(r.d)}</td>` +
          `</tr>`,
      )
      .join('')

    this.scoreboard.innerHTML =
      `<table><thead><tr><th>Player</th><th style="text-align:right">K</th>` +
      `<th style="text-align:right">D</th></tr></thead><tbody>${body}</tbody></table>`
  }

  /**
   * Updates the latency panel.
   *
   * The colour thresholds are the point: they encode what "acceptable" means so a regression
   * is visible at a glance rather than requiring someone to remember last week's numbers.
   */
  updateNet(net: Net, now: number, frameMs: number): void {
    this.frameTimes.push(frameMs)
    if (this.frameTimes.length > 90) this.frameTimes.shift()

    const s = net.stats
    setMetric(this.netRtt, `${s.rttMs.toFixed(0)}ms`, s.rttMs, 60, 120)
    setMetric(this.netJitter, `${s.jitterMs.toFixed(1)}ms`, s.jitterMs, 8, 20)
    setMetric(this.netInputLag, `${s.inputLagMs.toFixed(0)}ms`, s.inputLagMs, 60, 110)
    setMetric(
      this.netSnaps,
      s.snapshotsPerSecond.toFixed(0),
      Math.abs(s.snapshotsPerSecond - SIM.SNAPSHOT_HZ),
      4,
      10,
    )
    setMetric(this.netAck, `${s.cmdAgeMs.toFixed(0)}ms`, s.cmdAgeMs, 60, 140)

    let sum = 0
    for (const f of this.frameTimes) sum += f
    const fps = sum > 0 ? (this.frameTimes.length / sum) * 1000 : 0
    setMetric(this.netFps, fps.toFixed(0), 200 - fps, 140, 170)

    this.drawNetGraph(net)
    this.expireKillfeed(now)
  }

  private drawNetGraph(net: Net): void {
    const ctx = this.netCtx
    if (ctx === null) return

    const w = this.netCanvas.width
    const h = this.netCanvas.height
    ctx.clearRect(0, 0, w, h)

    const history = net.rttHistory
    if (history.length < 2) return

    let max = 40
    for (const v of history) if (v > max) max = v
    const scale = h / (max * 1.15)

    // Reference line at 60 ms: the boundary between "feels immediate" and "feels remote".
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'
    ctx.beginPath()
    ctx.moveTo(0, h - 60 * scale)
    ctx.lineTo(w, h - 60 * scale)
    ctx.stroke()

    ctx.strokeStyle = '#2fd3c4'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = 0; i < history.length; i++) {
      const x = (i / (history.length - 1)) * w
      const y = h - Math.min(h, history[i]! * scale)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()

    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.font = '9px ui-monospace, monospace'
    ctx.fillText(`${max.toFixed(0)}ms`, 3, 9)
  }
}

function setMetric(node: HTMLElement, text: string, value: number, warn: number, bad: number): void {
  node.textContent = text
  node.classList.toggle('warn', value >= warn && value < bad)
  node.classList.toggle('bad', value >= bad)
}

/**
 * Player names reach us over the network, so they are untrusted input. They are inserted via
 * innerHTML for the team-colour spans, which makes escaping mandatory rather than optional.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
