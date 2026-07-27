# Counter-Slop 2 — Plan of Action

**A stylized, browser-native, 5v5-capable tactical shooter in the Counter-Strike lineage, built so you and your friends can be in a match 20 seconds after someone shares a link.**

Version 1.0 · Owner: Blake Paschal · Target: playable-with-friends build in ~16–20 weeks part-time

---

## 0. Executive Summary

We are not cloning Counter-Strike 2. We are rebuilding the **twenty things that make CS feel good** — precise hitscan, punishing movement, round-based economy, information warfare — and deliberately discarding the twenty things that make it expensive (photoreal art, 100+ weapon skins, global matchmaking, Overwatch anti-cheat, Source 2 tooling).

The single highest-leverage decision in this whole document: **ship in the browser.** Not because WebGL is technically superior, but because the actual product requirement is *"play with my friends online."* Every install step, launcher, firewall prompt, and "wrong version" mismatch kills a game night. A URL does not.

| Dimension | Decision |
|---|---|
| Platform | Browser (desktop Chrome/Edge/Firefox first), WebGL2/WebGPU |
| Renderer | Three.js r170+ with a custom flat-shaded/banded-light pipeline |
| Netcode | Server-authoritative, 64 Hz sim, client prediction + rollback, lag compensation |
| Transport | WebTransport (unreliable datagrams) → WebSocket fallback |
| Server | Node 22 + TypeScript, one process per room, shared sim package with client |
| Art | Low-poly, flat-shaded, high-contrast palette. Readability > fidelity. |
| Scope | 3 maps, 9 weapons, 4 grenades, 3 modes, 2–10 players per room |
| Match format | MR8 (first to 9) ~25 min, plus deathmatch and gun game warmups |
| Hosting | Single container per region on Fly.io / Hetzner. ~$15–30/mo. |

**Non-goals, stated up front so they don't creep in:** ranked ladder, skin economy, mobile, controller support, console, dedicated-server hosting for strangers, kernel anti-cheat, voice chat v1 (use Discord), map editor for players, custom game modes API.

---

## 1. Design Pillars

Every feature request gets tested against these four. If it fails all four, it's cut.

### P1 — The gun is a scalpel, not a hose
Standing still and clicking must feel surgical. Moving and spraying must feel bad. This one relationship is the entire skill curve of CS, and it's cheap to implement: an inaccuracy scalar driven by velocity, airborne state, and consecutive-shot count, plus a fixed, learnable recoil pattern per weapon. Get this right in week 2 and the game is already fun with a grey box map.

### P2 — Death is expensive, so information is valuable
Round-based, no respawn, shared team economy. That's what turns a shooter into a tactical game. Peeking a corner has to feel like a *decision*. This is a rules-layer feature — nearly free in code, enormous in gameplay value.

### P3 — Legible at a glance
Indie style is a production strategy disguised as an aesthetic. Flat-shaded geometry with a locked 12-color palette means: no PBR authoring, no lightmap bake farm, no normal maps, no 4K textures, no material artist. It also means enemies read instantly against walls — which photoreal shooters spend millions fighting for. Aesthetic and budget point the same direction.

### P4 — Zero friction to the first bullet
Land on the page → pick a name → "Host" gives a 5-character room code → friends type it → in-game. No accounts, no downloads, no patch day. Anything that adds a step to that chain needs to justify itself loudly.

### P5 — Lean into the name
It's called Counter-Slop 2. The tone should be dry and self-aware: absurd ragdolls, a taunt wheel, deadpan weapon names, an announcer with too much confidence. This buys enormous goodwill for jank we can't afford to fix, and it's the cheapest differentiator available. A game that's earnestly 80% of CS is disappointing. A game that's 80% of CS and funny is its own thing.

---

## 2. Legal Boundary (read once, then never worry again)

Game *mechanics* are not protected. Specific expression is. So:

- **Never** ship Valve assets: no decompiled `.bsp`/`.vpk` content, no ripped models, sounds, textures, or radio callouts. Don't even put them in the repo as reference.
- **Do not** use "Counter-Strike" in the public title, domain, store page, or marketing. Internal codename is fine; the shipping name is not.
- Original weapon names, original team names, original map names and layouts (inspired-by is fine — nobody owns "three-lane bomb defusal map with a mid").
- Sounds: record your own or use CC0/CC-BY sources (Freesound CC0 filter, sonniss GDC bundles). Log every asset's license in `ASSETS.md` from day one, because retrofitting provenance later is miserable.
- Fonts: use SIL-OFL fonts (Inter, JetBrains Mono, Archivo). Never a system font you didn't license.

Reference gameplay by *playing* CS and writing down numbers you measure yourself. That's research, not derivation.

---

## 3. Stack Decision

Four viable paths. Presenting all four because this decision is expensive to reverse at month 3.

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. Browser: Three.js + Node authoritative server** | Zero-install (P4 satisfied perfectly); one language across client/server/sim → shared deterministic sim code, which is *the* hard part of FPS netcode; instant iteration; trivially shareable builds; hosting is cheap | JS perf ceiling (mitigated: our sim is simple math, not a physics engine); no Steam distribution; Safari lags on WebTransport; GC pauses need care | **RECOMMENDED** |
| **B. Godot 4 + GDScript/C#** | Real engine: editor, animation, audio, physics for free; good netcode primitives (`MultiplayerSynchronizer`); can export to web *and* desktop | Not installed here (extra setup); web export is heavyweight (~30MB+ WASM, slow first load) and historically flaky for competitive input latency; rollback netcode requires fighting the engine's node lifecycle | Strong second. Choose if you'd rather buy engine features than write them. |
| **C. Unity 6** | Deepest asset ecosystem, Netcode for GameObjects, best animation tooling | Heaviest iteration loop; web export worse than Godot's; licensing overhead; C# GC in a hot netcode loop needs real discipline | No. Wrong weight class for this scope. |
| **D. Rust (Bevy) + custom UDP** | Best possible perf and determinism; `rustc` is available here; native rollback crates exist (`bevy_ggrs`, `lightyear`) | Bevy's API churns hard between releases; asset pipeline immature; you'd spend the first month on engine plumbing instead of shooting feel; web export via WASM loses the perf advantage anyway | No — unless the real goal is learning Rust, in which case this is a fine but slower road. |

**Locked stack (Option A):**

```
Language      TypeScript 5.7 (strict), Node 22 LTS
Render        Three.js r170+ · WebGL2 baseline · WebGPU opportunistic
Build         Vite 6 (client) · tsup (server/sim) · pnpm workspaces
Collision     Custom swept-capsule vs. static BVH (three-mesh-bvh) — NOT a physics engine
Physics       Rapier3D (WASM) for grenades + cosmetic ragdolls only
Transport     WebTransport datagrams → WebSocket (TCP) fallback
Serialization Hand-rolled bit packer (no JSON, no protobuf on the hot path)
UI            Preact + CSS (HUD/menus as DOM overlay — vastly faster to build than in-engine UI)
Audio         Web Audio API with a PannerNode pool + occlusion raycast
Tests         Vitest (unit + determinism) · headless bot clients for net soak tests
Infra         Docker · Fly.io (multi-region) or single Hetzner CX22 · GitHub Actions CI
```

**Deliberate anti-decision: no full physics engine for player movement.** This is the trap that kills FPS hobby projects. Rigid-body character controllers are non-deterministic under rollback, feel floaty, and fight you forever. Source-engine movement is a hand-written swept-capsule solver, and so is ours: ~400 lines, fully deterministic, total control over air-strafing. Rapier stays confined to things where "roughly right and pretty" beats "exactly right": nade bounces, ragdolls, debris.

---

## 4. Repository Architecture

```
counter-slop-2/
├─ packages/
│  ├─ sim/              # THE CORE. Pure, deterministic, zero-dependency game simulation.
│  │  ├─ movement.ts    #   swept capsule solver, accel/friction/air-control
│  │  ├─ weapons.ts     #   fire logic, inaccuracy, recoil, penetration
│  │  ├─ hitscan.ts     #   ray vs. hitbox sets
│  │  ├─ rules.ts       #   round state machine, economy, bomb, win conditions
│  │  ├─ world.ts       #   entity storage (SoA typed arrays, not objects)
│  │  └─ tick.ts        #   step(world, inputs) -> world'   <-- the only entry point
│  ├─ protocol/         # bit-packed encode/decode, quantization, schema version gate
│  ├─ client/           # renderer, input capture, prediction/reconciliation, HUD, audio
│  ├─ server/           # room host, matchmaker, lag comp ring buffer, PVS culling
│  ├─ bots/             # headless clients: load tests, net soak, movement AI
│  └─ content/          # maps (.glb) + compiled artifacts + audio + palette
├─ tools/
│  ├─ mapc/             # map compiler: .glb -> BVH + spawns + PVS + nav + light bake
│  └─ replay/           # demo record/playback, desync bisector
├─ infra/               # Dockerfile, fly.toml, compose, CI workflows
└─ docs/                # this plan, netcode notes, ASSETS.md, tuning changelog
```

**The load-bearing rule: `packages/sim` must run identically on client and server.** No `window`, no `Date.now()`, no `Math.random()` (use a seeded xorshift passed in via world state), no floating-point-order-dependent iteration (fixed iteration order over typed arrays, always). Enforce with an ESLint rule banning those globals inside `sim/`, plus a CI determinism test (§12).

Everything else in the codebase is replaceable. This package is not. Design it first, review it hardest.

---

## 5. Netcode — The Part That Actually Matters

Shooting feel *is* netcode. A gorgeous game with 120 ms of unhidden input latency feels broken; an ugly game with proper prediction feels great. Budget accordingly: this is 30–35% of total engineering effort and it comes early, not late.

### 5.1 Tick model

| Constant | Value | Notes |
|---|---|---|
| `SIM_HZ` | 64 | 15.625 ms per tick. Matches CS2. Fixed step, always. |
| `SNAPSHOT_HZ` | 32 | Server → client state, every 2nd tick. Halves bandwidth, invisible after interpolation. |
| `CMD_HZ` | 64 | Client → server, one command per tick |
| `CMDS_PER_PACKET` | 3 | Redundant resend of last 3 commands — makes single packet loss free |
| `INTERP_DELAY` | 62.5 ms | 2 snapshots of buffer for remote-entity interpolation |
| `MAX_PREDICT_TICKS` | 16 | 250 ms; beyond this, hard-snap rather than predict garbage |
| `MAX_REWIND_MS` | 200 | Lag comp clamp. Above this, high-ping players eat the disadvantage. |

### 5.2 The three techniques, in dependency order

**1. Client-side prediction + rollback reconciliation** (do this first, it's non-negotiable)

The local player must respond to input on the very next rendered frame — never after a round trip.

```
each client tick:
  cmd = sampleInput()                      // buttons, view angles, sub-tick timestamps
  cmd.seq = ++lastSeq
  pendingCmds.push(cmd)
  predictedState = sim.step(predictedState, cmd)   // apply immediately, render this
  send(cmd, plus previous 2 for redundancy)

on snapshot(authoritativeState, ackedSeq):
  discard pendingCmds where seq <= ackedSeq
  if (divergence(authoritativeState, historyAt(ackedSeq)) > EPSILON) {
     predictedState = authoritativeState              // rewind
     for (c of pendingCmds) predictedState = sim.step(predictedState, c)   // replay
  }
```

Because client and server run the *same* `sim.step`, divergence is normally zero and the rollback never visibly fires. This is exactly why the shared-sim-package constraint in §4 is load-bearing.

**2. Entity interpolation for remote players**

Never render a remote player at their last received position — that's a jitter machine. Buffer two snapshots and render everyone else at `now - INTERP_DELAY`, interpolating position and angles between the bracketing snapshots. Remote players are therefore always ~60 ms in the past. That's correct and intentional, and it's what technique 3 exists to reconcile.

**3. Lag compensation (server-side rewind)**

When a client fires, they were aiming at where they *saw* the target — which is 60 ms of interpolation plus half their RTT in the past.

- Server keeps a 64-tick (1 s) ring buffer of every player's hitbox transforms.
- Fire command arrives carrying the client's tick + sub-tick fraction.
- Server computes `rewindMs = clamp(RTT/2 + INTERP_DELAY, 0, MAX_REWIND_MS)`.
- Rewind all *other* players' hitboxes to that time (lerp between ring-buffer entries).
- Run the hitscan against rewound hitboxes. Apply damage at present time.

This is what makes shots land where the crosshair was. It also creates "peeker's advantage" — an inherent, unfixable property of every lag-compensated shooter including CS2. Mitigate, don't eliminate: cap rewind at 200 ms, and don't allow absurd `INTERP_DELAY` values from a modified client.

### 5.3 Sub-tick inputs (CS2's headline feature, simplified)

A 64 Hz tick quantizes your trigger pull to a 15.6 ms grid. CS2 solves this by timestamping inputs with fractional tick times. Our simplified version:

- Client stamps each fire/jump event with a fraction `f ∈ [0,1)` inside the tick in which it occurred.
- Movement still integrates on whole ticks (keeps determinism simple).
- Fire events resolve at rewind time `tick + f`, and the shooter's own position/velocity is lerped to `f` for the shot origin.

Cost: ~a day of work plus one extra byte per fire event. Benefit: shots feel like they happen when you click. Worth it — but schedule it as an M4 polish item, not an M1 requirement.

### 5.4 Bandwidth budget

Per-player delta-encoded snapshot entry, bit-packed:

| Field | Bits | Encoding |
|---|---|---|
| entity id | 5 | ≤32 slots per room |
| changed-fields bitmask | 8 | delta: only send what moved |
| position | 48 | 3 × 16-bit quantized to map bounds (~2 mm precision) |
| yaw / pitch | 28 | 16 + 12 bits |
| velocity (for extrapolation) | 30 | 3 × 10-bit, coarse |
| anim state + flags | 8 | crouch, air, reload, plant, defuse, flash |
| health / armor | 12 | 7 + 5 bits |
| weapon + ammo | 10 | |
| **Total worst case** | **~150 bits ≈ 19 B** | typical delta far smaller (~6 B) |

10 players × 19 B = 190 B, plus ~30 B header/events ≈ **220 B per snapshot × 32 Hz ≈ 7 KB/s ≈ 56 kbps down**, ~15 kbps up. Comfortable on any connection, and it fits a single 1200-byte datagram with room to spare — no fragmentation logic needed.

**PVS culling is both a bandwidth win and our best anti-cheat.** The map compiler precomputes visibility between convex sectors. The server only transmits players in sectors visible from yours. Result: a modified client physically cannot draw a wallhack for a player behind a wall, because that data was never sent. Do this in M5; it's high value per line of code.

### 5.5 Transport

```
WebTransport (HTTP/3 + QUIC unreliable datagrams)   ← primary; real UDP semantics in a browser
   ↓ unsupported / blocked / handshake fail
WebSocket (TCP)                                     ← fallback; playable, head-of-line blocking hurts on loss
```

Reliable channel (WebTransport bidi stream or the same WS) carries: join/leave, buy orders, chat, round transitions, map load. Unreliable datagrams carry: input commands, snapshots — the things where a fresher packet always obsoletes a lost one. Never put snapshots on a reliable channel; that's how you get rubber-banding under packet loss.

---

## 6. Gameplay Systems Specification

### 6.1 Movement (the feel)

Source-lineage, tuned by measurement not vibes:

| Parameter | Start value | Purpose |
|---|---|---|
| Run speed | 250 u/s | baseline |
| Walk (shift) | 130 u/s | silent movement |
| Crouch | 90 u/s | |
| Ground accel | 5.5 | how fast you reach top speed |
| Ground friction | 5.2 | how fast you stop — governs counter-strafe crispness |
| Air accel | 12.0, capped at 30 u/s per tick | enables air-strafing and skill expression |
| Jump impulse | 300 u/s | ~52 u apex |
| Step height | 18 u | auto-climb without jumping |
| Gravity | 800 u/s² | |
| Player capsule | 32 u wide × 72 standing / 54 crouched | |

Ship with: **counter-strafing** (instant stop by tapping opposite direction — the single most important movement tech in CS), air-strafing, silent walk. Cap consecutive bunnyhops at 2 — full bhop chains are fun but wreck round pacing and map balance. Movement inaccuracy applies immediately on landing and decays over ~250 ms, so jump-shooting is punished.

### 6.2 Shooting (P1 made concrete)

```
inaccuracy = base
           + speedFactor  * (|velocity| / runSpeed) ^ 1.35
           + airFactor    * (onGround ? 0 : 1)
           + spreadFactor * consecutiveShots
           - crouchBonus  * (crouching ? 1 : 0)

pellet direction = aimDir rotated by (gaussian2D() * inaccuracy)
recoilOffset += pattern[shotIndex % patternLength]   // fixed, learnable, per-weapon
recoilOffset decays toward 0 at recoveryRate when not firing
```

Two separate concepts, and conflating them is a classic mistake:
- **Recoil** = deterministic view-kick following a fixed pattern → *learnable* (spray control is the skill).
- **Inaccuracy** = random cone around the (recoiled) aim direction → *avoidable* (stop moving; tap fire).

Damage: per-hitbox multipliers (head 4.0, chest/arm 1.0, stomach 1.25, legs 0.75), armor absorption per weapon, and **distance falloff** (`dmg * falloff^(dist/500)`). Wall penetration via a per-material `penetrationModifier` and a max of 3 surfaces traversed.

Hitboxes: 8 capsules per player (head, chest, stomach, 2 arms, 2 thighs, pelvis) driven by the animation skeleton, sampled into the lag-comp ring buffer every tick. Do NOT use the render mesh for hit detection — too slow, too jittery, and non-deterministic across LODs.

### 6.3 Arsenal (9 weapons — every one earns its slot)

| Slot | Archetype | Name | Price | Body dmg | RPM | Role |
|---|---|---|---|---|---|---|
| Pistol | starter A | **Coyote** | $0 | 30 | 400 | free, 1-tap headshot close |
| Pistol | starter B | **Sidewinder P9** | $0 | 28 | 450 | free, faster fire |
| Pistol | deagle-class | **Hand Cannon** | $700 | 58 | 267 | eco 1-tap threat |
| SMG | eco | **Whisper-9** | $1,050 | 27 | 750 | high kill-reward, armor-poor |
| Shotgun | breach | **Breacher** | $1,100 | 8×22 | 90 | anti-eco / close angles |
| Rifle | T primary | **Vulture AR** | $2,700 | 36 (143 hs) | 600 | one-tap headshot at range |
| Rifle | CT primary | **Marshal M4** | $3,100 | 33 | 666 | tighter spray, no one-tap through helmet |
| Sniper | scoped | **Longshot .50** | $4,750 | 115 | 41 | one-shot body kill, hard mobility penalty |
| Utility | — | Knife / Bomb / Defuser | — | — | — | |

Grenades (max 3 carried, 1 of each type): **Popper** (flash, $200) · **Fogger** (smoke, $300) · **Pineapple** (HE, $300) · **Sizzler** (incendiary, $400/$600).

Smokes are the expensive one: they need volumetric-ish rendering *and* they must actually block the PVS/vision system, or they're decorative. Budget a full week. A billboarded particle cluster with depth-aware soft blending plus a sim-side "vision blocker" sphere is the achievable version — skip CS2's fully dynamic voxel smoke.

### 6.4 Round & economy rules

```
Freeze time         15 s (buy menu open, movement locked)
Round time          1:55
Bomb timer          40 s
Plant / defuse      3.0 s / 10 s (5 s with defuser kit)
Match format        MR8 — first to 9 rounds, side swap at 8, draw allowed
Overtime            off (friends want to eat dinner)

Kill reward         $300 rifle · $600 SMG · $900 shotgun · $100 sniper
Round win           $3,250 · bomb detonation +$400 team · plant +$300 planter
Loss bonus          $1,400 → 1,900 → 2,400 → 2,900 → 3,400 (consecutive losses)
Max money           $16,000
```

Add one small original mechanic so this isn't purely derivative: **Salvage** — picking up a dead enemy's primary refunds 20% of its value to your team at round end. It rewards aggressive repositioning, adds a real decision at every corpse, and costs about forty lines of code.

### 6.5 Modes

| Mode | Players | Purpose |
|---|---|---|
| **Defusal** (flagship) | 2v2 – 5v5 | the real game |
| **Deathmatch** | 2–10 FFA | warmup, aim practice, fills the pre-game lobby |
| **Gun Game** | 2–10 FFA | pure fun, ladder through all 9 weapons, sells the tone (P5) |

Cut from v1: hostage rescue, arms race variants, wingman-specific maps, retakes (add retakes in v1.1 — it reuses 100% of defusal and is beloved).

---

## 7. Maps & Level Pipeline

**Three maps, and the layout theory matters more than the geometry.**

| Map | Layout | Notes |
|---|---|---|
| `de_foundry` | Classic 3-lane: A site, mid, B site | The Dust2/Mirage archetype. Build this first, iterate it forever. |
| `de_lockup` | Compact 2-lane, verticality | Faster rounds, good for 2v2/3v3 game nights |
| `dm_sandlot` | Small arena, no bomb | Deathmatch/gun game only. Cheapest to build — do it in M1 as the test map. |

### Pipeline (Blender → `mapc` → runtime)

1. **Blockout in Blender** on a strict grid (16 u), using named collections as semantic layers: `COLLISION_*`, `RENDER_*`, `SPAWN_T/CT`, `SITE_A/B`, `SECTOR_*`, `CLIP_*`, `NAV_*`.
2. **Export one `.glb`** per map.
3. **`tools/mapc` compiles** it into runtime artifacts:
   - static collision BVH (serialized typed arrays, memory-mapped at load)
   - spawn points, bomb sites, buy zones as plain JSON
   - **PVS**: sector-to-sector visibility bitset (sample-based: cast N rays between sector pairs, mark visible above threshold)
   - baked vertex-color ambient occlusion + a directional light pass — with flat shading, per-vertex baked light is *sufficient* and costs zero texture memory
   - nav mesh for bots (recast-style voxelize → region → contour, or hand-authored nav polys for v1; hand-authoring 3 maps is genuinely faster)
4. **Hot reload** in the client dev server so a Blender save is in-game in under 5 seconds. Build this in M2. It compounds: level iteration speed determines whether the maps end up fun.

**Level design rules to enforce:** every angle has a counter-angle; no sightline longer than 2,500 u (snipers dominate otherwise); T and CT rotation times to each site within 15% of each other; every site has ≥3 entrances and ≥2 defensible positions; cover geometry at 44 u (crouch-peek) and 72 u (stand-peek) heights.

---

## 8. Art & Audio Direction

### Visual system (P3)

- **One shader family.** Flat/faceted shading, hard 3-band light quantization, a rim-light term for silhouette separation, no PBR. One `MeshFlatMaterial` variant covers walls, props, and characters.
- **Locked 12-color palette** in `content/palette.ts`. Every asset samples from it. Team identity is a *hue*, not a texture: Wreckers = warm orange, Wardens = cool teal — instantly readable at 100 m and in peripheral vision.
- **Character budget:** ≤1,200 tris, 2 rigs total (one per team), 4 skin variants each via palette swap. Faceless, chunky, exaggerated silhouettes — this hides animation crudeness that realistic proportions expose.
- **Weapons:** ≤800 tris, viewmodel only needs idle/fire/reload/inspect. Third-person weapons can be a single low-poly prop each.
- **Post:** cheap FXAA, subtle vignette, mild bloom on tracers/muzzle flash, per-team outline on teammates through walls. Skip SSAO (baked AO covers it), skip motion blur (competitive shooters ban it anyway), skip screen-space reflections.

### Animation

8 clips per character: idle, walk, run, crouch-idle, crouch-walk, jump, plant/defuse, death. Blend via a 2D locomotion blend tree on velocity. **Skip full IK.** Do add a simple upper-body aim offset (pitch-based spine rotation) so aiming reads correctly to other players — that's a hit-registration *fairness* feature, not a polish one, since hitboxes follow the skeleton.

Ragdolls: pure client-side cosmetics via Rapier, no netsync, deliberately over-springy. This is the single highest laugh-per-hour feature in the game (P5) and it's free because nothing depends on it.

### Audio (do not under-budget this)

Audio is 40% of perceived tactical depth in CS and maybe 8% of the effort. Priorities in order:
1. **Footsteps** — per-material, distinct T/CT, accurate 3D panning + distance rolloff. This is the information layer the whole game leans on.
2. **Weapon fire** — layered: transient crack + body + tail. Distance-dependent tail (close = dry snap, far = reverb slap) sells map scale for free.
3. **Hit feedback** — separate armor/flesh/headshot/wall-hit sounds. The headshot "ping" is the game's dopamine delivery mechanism. Get it right.
4. **Occlusion** — one raycast per active source per 100 ms; if blocked, apply a lowpass + gain reduction. Cheap, and it makes walls feel solid.
5. **Announcer + taunt wheel** — tone vehicle (P5). Record it yourself; deadpan delivery beats a professional read here.

Use a `PannerNode` pool (~32) with priority-based voice stealing. Never allocate an audio node per shot; that's a GC-stutter generator.

---

## 9. Multiplayer Infrastructure

### Session flow (P4)

```
Landing page → nickname (localStorage) → [Host] or [Join]
  Host  → POST /rooms → server allocates room, returns 5-char code (e.g. "K4M2Q")
  Join  → enter code → WebTransport connect → team assign → warmup DM → ready-up → match
```

No accounts, no login, no email. Nickname + room code. Optionally a signed cookie later to persist stats.

### Server topology

**One authoritative Node process, one room per worker.** Not P2P.

Rejecting P2P deliberately: NAT traversal needs TURN relays anyway (so you're paying for servers regardless), the host gets 0 ms latency while everyone else eats the RTT (unfair), and the host can trivially cheat since they hold authority. A single $15/mo box in a datacenter near your friend group beats P2P on every axis that matters.

```
┌─────────────┐   HTTPS      ┌──────────────────┐
│  Browser    │─────────────▶│  Matchmaker      │  room registry, code→worker map
│  client     │              │  (Node, tiny)    │  health, region pick
└──────┬──────┘              └────────┬─────────┘
       │ WebTransport                 │ spawn/route
       │ datagrams                    ▼
       │                     ┌──────────────────┐
       └────────────────────▶│  Room worker     │  64 Hz sim, lag comp, PVS
                             │  (1 per match)   │  10 players max
                             └──────────────────┘
```

Each room worker is a separate process — a crash kills one match, not the server. Sim cost is ~0.4 ms/tick for 10 players, so one CX22 (2 vCPU) hosts 8–12 concurrent matches comfortably.

### Deployment

- Single multi-stage `Dockerfile`; client static assets to a CDN (Cloudflare Pages, free), server to Fly.io (`fly.toml` with a machine per region) or one Hetzner box + Caddy for TLS.
- **WebTransport requires valid TLS** (HTTP/3 + a real certificate) — use Caddy or Fly's built-in TLS. Don't fight self-signed certs; use a real domain from day one.
- GitHub Actions: typecheck → unit tests → determinism test → build → deploy `main` to staging, tags to prod.
- Ship version hashes in the handshake and refuse mismatched clients with a clear "refresh the page" message. Nothing wastes a game night like a silent protocol mismatch.

---

## 10. Trust Model & Anti-Cheat

Be honest about the threat model: **the client is a browser, so the client is fully readable.** Obfuscation is theater. For a friends-scale game the realistic goal is "nobody can cheat *casually*," and that's very achievable:

| Layer | Implementation |
|---|---|
| Server authority | Client never reports hits, kills, positions, or money. It sends *intent* (buttons + view angles) only. Server simulates and decides everything. |
| Information denial | PVS culling (§5.4) — invisible players are never transmitted. Kills wallhacks structurally, not detectably. |
| Audio gating | Server also gates footstep/fire *events* by PVS + distance, so an event-log sniffer learns nothing beyond what you could hear. |
| Input sanity | Clamp view-angle delta per tick (rules out impossible flicks), reject out-of-order/future timestamps, validate command rate, clamp claimed interp delay. |
| Statistical flagging | Track headshot %, time-to-target, snap-angle histograms per session; surface to the host as a soft signal. No auto-bans. |
| Social layer | Private rooms with codes, host can kick. For a friends game this is 95% of enforcement, and it's the cheapest 95% you'll ever buy. |

Explicitly out of scope: kernel drivers, VAC-equivalent, WASM obfuscation, replay-based review. If this ever goes public, revisit — but don't pay for it now.

---

## 11. Milestone Roadmap

Estimates assume **one developer at ~15–20 hrs/week**. Each milestone has a hard exit gate: a thing you can *do*, not a percentage. If a gate isn't met, the milestone isn't done — don't roll debt forward.

### M0 — Spike: "two capsules and a gun" (2 weeks)
The riskiest thing in the project is netcode feel, so prove it in week one, on purpose, before any art exists.

- pnpm monorepo, TS strict, Vite + Node servers, CI green
- `sim/` skeleton: fixed-step tick, swept-capsule movement, one box map, hardcoded BVH
- WebSocket transport (defer WebTransport), naive full-state snapshots, no prediction yet
- Two browser tabs, two capsules, hitscan, a health number
- **Gate:** two players on the same LAN can shoot each other and it doesn't feel awful. Instrument and log measured input→pixel latency.

### M1 — Netcode spine (3 weeks)
- Client prediction + rollback reconciliation, entity interpolation, lag comp ring buffer + server rewind
- Bit-packed protocol with delta compression; WebTransport with WS fallback
- Debug HUD: RTT, jitter, packet loss, predicted-vs-authoritative divergence graph, rewind visualizer (draw the rewound hitboxes)
- `bots/` headless clients + a network-condition simulator (add 80 ms RTT, 3% loss, 20 ms jitter)
- **Gate:** at a simulated 100 ms RTT with 3% loss, shots land where the crosshair was and local movement has zero perceptible input delay. Divergence graph reads flat.

### M2 — Feel pass: movement & shooting (3 weeks)
- Full movement param set, counter-strafing, air-strafe, step-up, crouch, silent walk
- Inaccuracy + recoil model, all 9 weapons stubbed with real numbers, hitbox capsules on the skeleton, damage falloff, armor, wall penetration
- `mapc` v1 (glb → BVH + spawns) with hot reload; `dm_sandlot` blockout
- Recoil-pattern authoring tool (draw the pattern, see the tracers)
- **Gate:** a deathmatch on a grey-box map is *fun for 20 minutes straight* with no HUD, no art, no sound. If it isn't, stay here. Everything downstream multiplies this number.

### M3 — The game becomes a game (3 weeks)
- Round state machine, freeze time, buy menu, full economy, Salvage
- Bomb plant/defuse, sites, win conditions, MR8 match flow, team assignment/swap
- HUD: health, armor, money, ammo, round counter, timer, killfeed, scoreboard, minimap
- `de_foundry` blockout playable end-to-end
- **Gate:** a complete 5v5 defusal match runs start to finish with no crashes and no manual intervention.

### M4 — Feedback & polish that changes outcomes (3 weeks)
- Full audio system (footsteps → occlusion, §8)
- Hit markers, damage numbers, tracers, muzzle flash, impact decals + particles, screen shake, flash blindness effect
- Grenades: all four, with `Fogger` blocking sim-side vision
- Sub-tick input timing (§5.3)
- Death cam, kill cam-lite, round-end summary
- **Gate:** blind playtest — a friend who has never seen the build understands what's happening without being told. Audio alone lets them locate an enemy.

### M5 — Content, bots, hardening (3 weeks)
- `de_lockup`, art pass on all three maps (palette, baked light, props)
- Character models + rigs + 8-clip animation set, weapon viewmodels
- Bots with nav-mesh pathing and rudimentary combat (fills uneven teams — critical for a friend group where 7 people show up)
- PVS culling shipped, input sanity checks, room lifecycle, reconnect-to-match
- Gun Game mode, taunt wheel, ragdolls
- **Gate:** 8 real friends play three consecutive matches with no restarts, no confusion, no rage-quits over hitreg.

### M6 — Ship to the group chat (2 weeks)
- Prod deploy, real domain, TLS, CDN, multi-region if the friend group is spread out
- Landing page, room codes, nickname persistence, invite links (`/j/K4M2Q`)
- Crash reporting (Sentry), server metrics (tick time p99, bandwidth, rewind distribution), replay recording
- Onboarding: 60-second interactive tutorial, keybind menu, sensitivity + FOV + audio settings
- **Gate:** you send one link to the group chat and a match happens without you explaining anything.

### M7+ — Live iteration (ongoing)
Retakes mode, a 4th map, spectator mode, demo playback UI, cosmetic unlocks, seasonal weapon tuning, community feedback loop. Balance changes only from recorded match data, never from vibes.

**Total to M6: ~19 weeks (~5 months) part-time.** Full-time, ~9–10 weeks. Add 25% buffer for the unknowns you can't schedule; call it 6 months to a build you're proud to share.

---

## 12. Testing Strategy

Multiplayer bugs are timing bugs, and timing bugs don't reproduce by hand. Automate or suffer.

| Layer | Approach |
|---|---|
| **Determinism (highest value)** | CI test: record 10,000 random input commands, run `sim.step` twice in fresh processes, assert bit-identical world hashes. Also cross-check the client build vs. server build. Any divergence = a rollback bug waiting to ruin someone's night. |
| **Unit** | Movement solver edge cases (stairs, wedges, corner-clipping, ceiling), inaccuracy math, damage/armor/penetration tables, economy state machine, bomb timing. Vitest. |
| **Net soak** | 10 headless bots + traffic shaping (100/200/500 ms RTT, 1/5/15% loss, jitter, burst loss) for 30 minutes. Assert no desync, no memory growth, tick time p99 under 3 ms. Run nightly. |
| **Replay/regression** | Record every dev match. Replay against new builds and diff outcomes — catches "the AK feels different now" before players do. `tools/replay` includes a desync bisector that finds the first divergent tick. |
| **Load** | 12 concurrent rooms of 10 bots on target hardware. Establishes the real per-box capacity number. |
| **Playtest (the only real test)** | Weekly session with 4+ humans from M2 onward. Non-negotiable. Structured note-taking: what confused you, what felt unfair, when were you bored. Feel bugs only surface with humans; nothing else in this table finds them. |

---

## 13. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **Shooting doesn't feel good and you can't say why** | High | Fatal | M0/M2 exist purely to de-risk this. Instrument input→photon latency numerically. Tune against *measured* values, not memory of CS. If M2's gate fails, stop and fix — do not proceed to content. |
| 2 | **Art scope explodes** | High | Severe | The palette + flat-shader + poly-budget constraints are a hard contract, not a style suggestion. One shader family. No PBR. Grey-box until M5. |
| 3 | **Determinism drift breaks prediction subtly** | Medium | Severe | Shared sim package, ESLint bans on nondeterministic globals, CI hash test, replay bisector. Catch it in CI or spend a weekend hunting it. |
| 4 | **Browser perf ceiling (GC stutter, not raw FPS)** | Medium | Moderate | Zero allocations in the hot loop: SoA typed arrays, object pools, pre-allocated snapshot buffers. Profile from M1, not M6. A 4 ms GC pause during a spray transfer is worse than 20 fewer fps. |
| 5 | **WebTransport support gaps (esp. Safari)** | Medium | Moderate | WebSocket fallback works and is playable. Detect at handshake, tell the user honestly ("fallback mode, expect worse performance under packet loss"). Recommend Chrome/Firefox. |
| 6 | **Smoke grenades cost 3× the estimate** | Medium | Moderate | Timebox to one week. Fallback: opaque billboard cluster + sim-side vision blocker. Ugly-but-functional beats missing. |
| 7 | **Friend group can't field 10 players** | High | Moderate | Bots from M5, and design the maps so 2v2/3v3 is genuinely good (`de_lockup` exists for exactly this). Wingman-scale play is the realistic default, not the fallback. |
| 8 | **Motivation collapse at month 3** | High | Fatal | Milestone gates are all *playable* states — every 3 weeks there's something new to play with friends. Never let the build sit un-fun for more than a sprint. Public dev log for accountability. |
| 9 | **Someone cheats and poisons the group** | Low | Moderate | PVS culling + server authority + host kick. Social enforcement is sufficient at this scale. |
| 10 | **Legal notice** | Very low | Severe | §2 discipline: original assets, original names, no "Counter-Strike" in the public title, `ASSETS.md` provenance log from commit one. |

---

## 14. Budget

| Item | Cost | Notes |
|---|---|---|
| Server (Hetzner CX22 or Fly.io) | $15–30/mo | 8–12 concurrent matches |
| Domain | $12/yr | needed for TLS/WebTransport |
| CDN (Cloudflare Pages) | $0 | static client |
| Blender, VS Code, Godot-if-pivoting | $0 | |
| Audio: sonniss GDC bundles / Freesound CC0 | $0–200 | or record it yourself |
| Fonts (SIL-OFL) | $0 | |
| Sentry / metrics free tiers | $0 | |
| **Total year one** | **≈ $400** | + $100 one-time if you ever want a Steam page |

The real cost is time. Roughly 300–400 hours to M6.

---

## 15. Immediate Next Actions

1. Scaffold the pnpm monorepo per §4, TS strict everywhere, CI running typecheck + tests on push.
2. Write `packages/sim/tick.ts` as a pure `step(world, inputs) → world` function with the determinism lint rules in place from the first commit. This interface shape is the highest-leverage decision in the codebase.
3. Implement the swept-capsule movement solver against a hardcoded box map. No renderer yet — validate it with unit tests.
4. Stand up the Node room server and a Three.js client that draws two capsules and echoes positions over WebSocket.
5. Add the latency HUD **before** adding prediction, so you can see what prediction actually buys you.
6. Hit the M0 gate: two tabs, two capsules, hitscan, and an honest verdict on whether it feels alright.

Then re-read §11 and start M1.

---

## Appendix A — Tuning Constants (single source of truth)

Keep these in `packages/sim/constants.ts`, exported as a frozen object, hot-reloadable in dev, and version-stamped into replays so an old demo replays correctly against new numbers.

```ts
export const SIM = {
  TICK_HZ: 64, SNAPSHOT_HZ: 32, CMD_HZ: 64, CMDS_PER_PACKET: 3,
  INTERP_TICKS: 4, MAX_PREDICT_TICKS: 16, MAX_REWIND_MS: 200,
} as const

export const MOVE = {
  RUN: 250, WALK: 130, CROUCH: 90,
  ACCEL: 5.5, FRICTION: 5.2, AIR_ACCEL: 12.0, AIR_CAP: 30,
  JUMP: 300, GRAVITY: 800, STEP_HEIGHT: 18,
  HULL_W: 32, HULL_H_STAND: 72, HULL_H_CROUCH: 54,
  MAX_CONSECUTIVE_JUMPS: 2,
} as const

export const HITBOX_MULT = {
  head: 4.0, chest: 1.0, stomach: 1.25, arm: 1.0, thigh: 0.75, pelvis: 1.0,
} as const

export const ECON = {
  START: 800, MAX: 16_000, ROUND_WIN: 3_250, PLANT_BONUS: 300, DETONATE_BONUS: 400,
  LOSS_LADDER: [1_400, 1_900, 2_400, 2_900, 3_400],
  SALVAGE_PCT: 0.20,
} as const
```

## Appendix B — Definition of "Done" for a Feature

1. Sim logic lives in `packages/sim`, is deterministic, and has unit tests.
2. Server-authoritative — the client sends intent, never outcomes.
3. Wire format is bit-packed, delta-compressed, and version-gated.
4. Predicted client-side where latency would otherwise be felt.
5. Has audio and visual feedback (a mechanic the player can't perceive doesn't exist).
6. Survives the net soak test at 200 ms RTT / 5% loss.
7. Playtested with at least two humans.
8. Tuning constants live in `constants.ts`, not scattered as literals.
