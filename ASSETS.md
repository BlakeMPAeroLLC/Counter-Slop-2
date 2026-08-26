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

`packages/playbook/src/maps/dust2.ts` is a hand-authored set of polygons. Every coordinate was
typed by hand. No Valve file of any kind was consulted, extracted, decompiled, or traced —
not the `.bsp`, not the radar `.dds`, not a community re-render of either.

What it does reproduce is the **layout relationships and the community callout vocabulary**:
that Long Doors opens onto a long corridor, that Catwalk drops into A Cross, that Xbox sits
just short of Mid Doors. That is what makes the tool useful — a coach transcribing a real play
needs to be talking about the same map their players are.

Two consequences worth being explicit about:

- **Distances are approximate.** Proportions and connectivity are right, so timings are in the
  right ballpark, but this is not a metric tracing and must not be treated as one. Measure
  in-game (`getpos` on a local server) if a specific timing matters, and correct the file.
- **"Dust II" and "Counter-Strike" are Valve trademarks.** Using the name internally for a
  private practice tool is a different posture from shipping it publicly under that name. If
  the playbook is ever published alongside the game, the shipped map should be renamed — the
  plan's own original `de_foundry` slot (`docs/PLAN.md` §7) is the natural home — and the
  Dust 2 definition kept as a local practice file. Get that checked by someone qualified
  rather than relying on this paragraph.

## Fonts, audio, images

None. The UI uses the viewer's `system-ui` stack. The playbook's favicon is an inline SVG
authored in `packages/playbook-app/index.html`. There are no bundled images, audio files, or
web fonts anywhere in the repository.

Any reference image used while authoring geometry is a scratch file that must stay out of git
(see `.gitignore`), and must be something you have the right to use.
