# Breachline

LAN tactical shooter that runs in the browser. Classic strafe movement (counter-strafing,
air-strafing, crouch-jumping), movement-based accuracy, learnable spray patterns, and an
authoritative server.

Two modes:

- **Deathmatch** - the warm-up everyone joins into. Free-for-all, instant respawn, all weapons.
- **Bomb match** - two teams, rounds, no respawns. Attackers plant the bomb at site A or B;
  defenders stop them or defuse it. Money for kills and round results, a buy menu, armour,
  grenades, half-time side swap, first to 7 rounds. Start it from the Esc menu (2+ players).

**Bots:** open the Esc menu and use ADD BOT / REMOVE BOT, with Easy, Normal or Hard difficulty.
Bots play both modes: they buy, take a site, plant, guard, retake and defuse. One player plus
one bot is enough to start a bomb match. The bot logic is in `server/bots.js`.

## Host a game

Needs [Node.js](https://nodejs.org) 20+ on the host PC only.

```
npm install
npm start
```

The console prints a `Coworkers: http://<ip>:3000` address. Everyone opens that in Chrome or
Edge. The host PC must allow inbound TCP 3000 (Windows will prompt the first time).
Change the port with `PORT=4000 npm start`.

## Controls

| Key | Action | Key | Action |
|---|---|---|---|
| WASD | Move | Space / mouse wheel | Jump |
| Ctrl or C | Crouch (in the air: crouch-jump) | Shift | Walk (silent) |
| Mouse 1 | Fire / throw | Mouse 2 | Scope (sniper) |
| 1 2 3 4 | Primary, pistol, knife, grenades | Q | Last weapon |
| E (hold) | Plant / defuse the bomb | B | Buy menu (then a number) |
| R | Reload | Tab / Esc | Scoreboard / menu |

## Layout

| Path | What |
|---|---|
| `shared/` | Simulation run by both client and server: movement, collision, weapons, map |
| `shared/constants.js` | Every tuning number: movement, weapons, prices, round rules |
| `shared/map.js` | The map (boxes), spawn points and bomb sites |
| `server/index.js` | Game server + static file host |
| `client/src/main.js` | Input, prediction, reconciliation, frame loop |
| `client/src/gfx.js` | Renderer, lighting, world (procedural textures for now) |
| `client/src/viewmodel.js` | First-person weapons. Set `MODEL_URLS` to load `.glb` models from `client/public/models/` |
| `test/` | `npm test` - movement, map and rules tests plus end-to-end matches against a real server |

## Assets

All CC0; sources are listed in `client/public/CREDITS.md`. Each has a generated fallback if the file is missing.

- Weapon models: `client/public/models/*.glb`. Placement per weapon is `MODEL_FIT` in `client/src/viewmodel.js`.
- Player model: `client/public/models/player.glb`, set up in `buildRig` in `client/src/actors.js`.
- World textures and sky: `client/public/textures/`, loaded in `client/src/gfx.js`.
- Sounds: `client/public/sounds/*.ogg`, loaded in `client/src/audio.js`.
