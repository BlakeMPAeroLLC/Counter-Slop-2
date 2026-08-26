# Asset provenance

Every asset in this repository is original. No Valve asset — map, model, texture, sound,
radar image, `.bsp`, decompiled `.vmf`, or trademark — is used, and none may be added. This
file records where each piece of content came from so that claim stays checkable rather than
aspirational.

If you add content, add a row. If you cannot say where something came from, it does not go in.

## Geometry

| Asset | Provenance | Notes |
|---|---|---|
| `packages/sim/src/map.ts` — `dm_box` test arena | Authored in this repo | Axis-aligned brushes written by hand for movement and hitscan tests. |
| `packages/sim/src/map.ts` — `flat` | Authored in this repo | Empty plane for kinematics and network tests. |
| `packages/playbook/src/maps/dust2.ts` — Dust 2 layout | Authored in this repo | See below. |

### On the Dust 2 layout in the playbook

`packages/playbook/src/maps/dust2.ts` is a hand-authored set of polygons. Every polygon was
typed by hand. No Valve map file, radar image, `.bsp`, decompiled `.vmf` or nav mesh was
consulted, extracted, traced, or committed.

#### What was taken, precisely

A short list of published **factual constants**, from the `resource/overviews/de_dust2.txt`
config that ships with the game and is widely republished:

| Constant | Value |
|---|---|
| `pos_x` (world X of the radar's upper-left corner) | -2476 |
| `pos_y` (world Y of the same corner) | 3239 |
| `scale` (world units per radar pixel) | 4.4 |
| CT spawn marker (normalised) | 0.62, 0.21 |
| T spawn marker | 0.39, 0.91 |
| Bombsite A marker | 0.80, 0.16 |
| Bombsite B marker | 0.21, 0.12 |

These are measurements, not artwork: they say how big the map is and where four points on it
are. They are recorded on the `MapDef` as `radar` and used to derive the map's bounds and to
anchor the geometry, which is why a position in the playbook is the same number `getpos` prints
in game. `packages/playbook/tests/world.test.ts` asserts the shipped geometry still agrees with
them.

Nothing else came from the game. The radar image itself — the actual artwork those constants
describe — is not used, is not in the repository, and must not be added.

#### What is reproduced

The **layout relationships and the community callout vocabulary**: that Long Doors opens onto a
long corridor, that Catwalk drops into A Cross, that Xbox sits just short of Mid Doors. That is
what makes the tool useful — a coach transcribing a real play needs to be talking about the same
map their players are.

#### Accuracy

The extent, the four anchors, and therefore the overall scale are right. Everything between them
is hand-placed, so connectivity and proportion are right while individual corridor widths and
corner positions are approximate. A Long push takes about as long here as in game; a specific
40-unit smoke lineup does not transfer. Correct a coordinate by walking it in a local server and
reading `getpos`; the inspector shows a `setpos` for any selected position to make the round trip
easy.

#### Trademark

**"Dust II" and "Counter-Strike" are Valve trademarks.** Using the name internally for a private
practice tool is a different posture from shipping it publicly under that name. If the playbook is
ever published alongside the game, the shipped map should be renamed — the plan's own original
`de_foundry` slot (`docs/PLAN.md` §7) is the natural home — and the Dust 2 definition kept as a
local practice file. Get that checked by someone qualified rather than relying on this paragraph.

#### Sources considered and rejected

- **boltobserv** — has callout polygons, but is GPL-3. Importing that data would impose GPL-3 on
  this repository. Not used.
- **Radar images** (SimpleRadar, extracted game radars, community re-renders) — all derived from
  Valve artwork. Not used, and tracing one is not a loophole.
- **Nav-mesh dumps** (awpy and similar) — MIT-licensed *tooling*, but the map data itself is
  generated from Valve's `.nav` files. Not used.

## Fonts, audio, images

None. The UI uses the viewer's `system-ui` stack. The playbook's favicon is an inline SVG
authored in `packages/playbook-app/index.html`. There are no bundled images, audio files, or
web fonts anywhere in the repository.

Any reference image used while authoring geometry is a scratch file that must stay out of git
(see `.gitignore`), and must be something you have the right to use.
