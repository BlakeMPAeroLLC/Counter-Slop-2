// "Depot" - an original two-site bomb map. Everything is axis-aligned boxes.
//
//   north (-z)   [ SITE A ] [ defender spawn ] [ SITE B ]
//                ---A main--------mid door--------B main---   <- front wall
//                 west lane |  block  | mid |  block  | east lane
//                           +--alley--+     +--alley--+
//   south (+z)   [            attacker spawn                 ]
//
// Three routes: west lane -> A, east lane -> B, mid -> connector -> either site.
const boxes = []
const decor = []
const B = (x0, y0, z0, x1, y1, z1, mat) => boxes.push({ x0, y0, z0, x1, y1, z1, mat })
const D = (x0, y0, z0, x1, y1, z1, mat) => decor.push({ x0, y0, z0, x1, y1, z1, mat })
const W = 1280

// floor + perimeter
B(-W, -16, -W, W, 0, W, 'ground')
B(-W - 32, 0, -W - 32, W + 32, 320, -W, 'brick')
B(-W - 32, 0, W, W + 32, 320, W + 32, 'brick')
B(-W - 32, 0, -W, -W, 320, W, 'brick')
B(W, 0, -W, W + 32, 320, W, 'brick')

// the four building blocks between the lanes (an alley splits each pair)
B(-820, 0, -380, -260, 300, 140, 'brick')
B(-820, 0, 300, -260, 260, 820, 'concrete')
B(260, 0, -380, 820, 260, 140, 'concrete')
B(260, 0, 300, 820, 300, 820, 'brick')
B(-560, 0, 150, -500, 60, 210, 'crate')
B(520, 0, 230, 580, 60, 290, 'crate')

// front wall with A main, mid door and B main
B(-W, 0, -420, -1150, 200, -380, 'concrete')
B(-950, 0, -420, -70, 200, -380, 'concrete')
B(70, 0, -420, 950, 200, -380, 'concrete')
B(1150, 0, -420, W, 200, -380, 'concrete')

// walls between the sites and the connector, each with a back door and a front door
for (const x of [-500, 460]) {
  B(x, 0, -W, x + 40, 200, -1150, 'concrete')
  B(x, 0, -1000, x + 40, 200, -640, 'concrete')
  B(x, 0, -500, x + 40, 200, -420, 'concrete')
}

// connector / defender spawn
B(-150, 0, -760, 150, 128, -720, 'concrete')
B(-330, 0, -900, -270, 60, -840, 'crate')
B(250, 0, -980, 310, 60, -920, 'crate')

// site A: ledge with stairs along the north wall, crates on site, container by A main
B(-W, 0, -W, -940, 64, -1140, 'concrete')
for (let k = 1; k <= 3; k++) B(-940 + (3 - k) * 24, 0, -W, -940 + (4 - k) * 24, 16 * k, -1140, 'concrete')
B(-930, 0, -900, -866, 64, -836, 'crate')
B(-866, 0, -900, -818, 44, -852, 'crate')
B(-1010, 0, -760, -950, 60, -700, 'crate')
B(-760, 0, -560, -640, 96, -520, 'concrete')
B(-W, 0, -760, -1160, 120, -500, 'metalBlue')

// site B: containers on site, raised corner with a crate step
B(760, 0, -940, 1040, 120, -820, 'metalRed')
B(1160, 0, -1100, W, 120, -820, 'metalBlue')
B(1000, 0, -W, W, 80, -1140, 'concrete')
B(940, 0, -1240, 1000, 44, -1180, 'crate')
B(600, 0, -640, 660, 60, -580, 'crate')
B(880, 0, -600, 940, 60, -540, 'crate')
B(940, 0, -600, 988, 44, -552, 'crate')

// west lane
B(-W, 0, 200, -1160, 120, 480, 'metalBlue')
B(-900, 0, -60, -840, 60, 0, 'crate')
B(-960, 0, -60, -900, 44, -12, 'crate')
B(-1050, 0, -200, -820, 44, -170, 'concrete')
B(-1100, 0, 620, -1040, 60, 680, 'crate')

// mid
B(-260, 0, -60, -60, 120, -30, 'concrete')
B(120, 0, 180, 260, 44, 210, 'concrete')
B(-40, 0, 420, 24, 60, 484, 'crate')
B(24, 0, 440, 72, 44, 488, 'crate')
B(140, 0, 600, 260, 120, 800, 'metalRed')

// east lane
B(1160, 0, -100, W, 120, 180, 'metalRed')
B(840, 0, 300, 900, 60, 360, 'crate')
B(900, 0, 312, 948, 44, 360, 'crate')
B(820, 0, -200, 1050, 44, -170, 'concrete')
B(1040, 0, 640, 1100, 60, 700, 'crate')

// attacker spawn
B(-140, 0, 880, 140, 128, 920, 'concrete')
B(-600, 0, 1000, -540, 60, 1060, 'crate')
B(520, 0, 940, 580, 60, 1000, 'crate')
B(-1000, 0, 1160, -720, 120, W, 'metalBlue')

const sites = [
  { name: 'A', x0: -1080, x1: -700, z0: -1060, z1: -700 },
  { name: 'B', x0: 700, x1: 1080, z0: -1060, z1: -700 },
]
// painted site outlines (render only)
D(sites[0].x0, 0, sites[0].z0, sites[0].x1, 0.5, sites[0].z1, 'siteA')
D(sites[1].x0, 0, sites[1].z0, sites[1].x1, 0.5, sites[1].z1, 'siteB')

// render-only skyline outside the walls (gives parallax / depth)
D(-2300, 0, -2100, -1700, 720, -1500, 'building')
D(-1400, 0, -2300, -800, 560, -1700, 'building')
D(-300, 0, -2500, 400, 860, -1800, 'building')
D(900, 0, -2200, 1500, 640, -1600, 'building')
D(1700, 0, -1400, 2300, 780, -700, 'building')
D(1650, 0, 100, 2200, 520, 800, 'building')
D(1600, 0, 1400, 2300, 820, 2100, 'building')
D(300, 0, 1700, 1000, 600, 2300, 'building')
D(-900, 0, 1650, -200, 740, 2300, 'building')
D(-2300, 0, 900, -1650, 580, 1700, 'building')
D(-2250, 0, -500, -1650, 660, 400, 'building')
D(-4500, -20, -4500, 4500, -16, 4500, 'ground')

const pt = (x, z, yaw) => ({ x, y: 0.05, z, yaw: yaw === undefined ? Math.atan2(x, z) : yaw })
const spawns = {
  att: [pt(-160, 1160, 0), pt(0, 1190, 0), pt(160, 1160, 0), pt(-80, 1060, 0), pt(80, 1060, 0), pt(-260, 1080, 0), pt(260, 1080, 0)],
  def: [pt(-160, -1160, Math.PI), pt(0, -1190, Math.PI), pt(160, -1160, Math.PI), pt(-80, -1080, Math.PI), pt(80, -1080, Math.PI),
    pt(-260, -1100, Math.PI), pt(260, -1100, Math.PI)],
  dm: [pt(-1100, 760), pt(1100, 760), pt(0, 620), pt(-1050, -260), pt(1080, -280), pt(100, -200), pt(-1100, -900), pt(700, -620),
    pt(0, -1000), pt(-640, 220), pt(640, 180), pt(0, 1100), pt(1100, -1000), pt(-640, -1100)],
}

export const MAP = { name: 'Depot', size: W, boxes, decor, spawns, sites }
