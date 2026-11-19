# Breachline

LAN free-for-all FPS that runs in the browser. Classic strafe movement (counter-strafing,
air-strafing), movement-based accuracy, learnable spray patterns, authoritative server.

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
| Ctrl or C | Crouch | Shift | Walk (silent) |
| Mouse 1 | Fire | Mouse 2 | Scope (sniper) |
| 1-5 | Knife, pistol, SMG, rifle, sniper | R | Reload |
| Tab | Scoreboard | Esc | Menu / sensitivity |

## Layout

| Path | What |
|---|---|
| `shared/` | Simulation run by both client and server: movement, collision, weapons, map |
| `shared/constants.js` | Every tuning number (speeds, friction, recoil, damage) |
| `server/index.js` | Game server + static file host |
| `client/src/main.js` | Input, prediction, reconciliation, frame loop |
| `client/src/gfx.js` | Renderer, lighting, world (procedural textures for now) |
| `client/src/viewmodel.js` | First-person weapons. Set `MODEL_URLS` to load `.glb` models from `client/public/models/` |
| `test/` | `npm test` - movement physics and an end-to-end two-player network test |

## Assets

All CC0; sources are listed in `client/public/CREDITS.md`. Each has a generated fallback if the file is missing.

- Weapon models: `client/public/models/*.glb`. Placement per weapon is `MODEL_FIT` in `client/src/viewmodel.js`.
- Player model: `client/public/models/player.glb`, set up in `buildRig` in `client/src/actors.js`.
- World textures and sky: `client/public/textures/`, loaded in `client/src/gfx.js`.
- Sounds: `client/public/sounds/*.ogg`, loaded in `client/src/audio.js`.
