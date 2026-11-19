// "Yard" - an original compact arena for ~3 players. Everything is axis-aligned boxes.
const boxes = []
const decor = []
const B = (x0, y0, z0, x1, y1, z1, mat) => boxes.push({ x0, y0, z0, x1, y1, z1, mat })
const D = (x0, y0, z0, x1, y1, z1, mat) => decor.push({ x0, y0, z0, x1, y1, z1, mat })

// floor + perimeter
B(-800, -16, -800, 800, 0, 800, 'ground')
B(-832, 0, -832, 832, 288, -800, 'brick')
B(-832, 0, 800, 832, 288, 832, 'brick')
B(-832, 0, -800, -800, 288, 800, 'brick')
B(800, 0, -800, 832, 288, 800, 'brick')

// centre platform with stairs north + south, a pillar and two low walls
B(-144, 0, -144, 144, 64, 144, 'concrete')
for (let k = 1; k <= 3; k++) {
  B(-72, 0, 144 + (3 - k) * 24, 72, 16 * k, 144 + (4 - k) * 24, 'concrete')
  B(-72, 0, -(144 + (4 - k) * 24), 72, 16 * k, -(144 + (3 - k) * 24), 'concrete')
}
B(-28, 64, -28, 28, 176, 28, 'concrete')
B(-144, 64, -144, -128, 104, 144, 'concrete')
B(128, 64, -144, 144, 104, 144, 'concrete')

// lane walls (doorway gap in the middle of each)
B(-440, 0, -520, -408, 144, -110, 'brick')
B(-440, 0, 110, -408, 144, 520, 'brick')
B(408, 0, -520, 440, 144, -110, 'brick')
B(408, 0, 110, 440, 144, 520, 'brick')
// cross walls
B(-200, 0, -470, 200, 112, -440, 'concrete')
B(-200, 0, 440, 200, 112, 470, 'concrete')

// NE tower + stairs + parapet
B(520, 0, 520, 800, 128, 800, 'concrete')
for (let k = 1; k <= 7; k++) B(520 - (8 - k) * 24, 0, 620, 520 - (7 - k) * 24, 16 * k, 740, 'concrete')
B(520, 128, 520, 800, 160, 536, 'concrete')
B(520, 128, 536, 536, 160, 620, 'concrete')
B(520, 128, 740, 536, 160, 800, 'concrete')
// SW tower (mirrored)
B(-800, 0, -800, -520, 128, -520, 'concrete')
for (let k = 1; k <= 7; k++) B(-520 + (7 - k) * 24, 0, -740, -520 + (8 - k) * 24, 16 * k, -620, 'concrete')
B(-800, 128, -536, -520, 160, -520, 'concrete')
B(-536, 128, -620, -520, 160, -536, 'concrete')
B(-536, 128, -800, -520, 160, -740, 'concrete')

// containers with crate steps
B(-700, 0, 420, -580, 120, 700, 'metalBlue')
B(-580, 0, 560, -532, 48, 608, 'crate')
B(-580, 0, 608, -532, 96, 656, 'crate')
B(580, 0, -700, 700, 120, -420, 'metalRed')
B(532, 0, -608, 580, 48, -560, 'crate')
B(532, 0, -656, 580, 96, -608, 'crate')

// loose crates
B(-300, 0, -300, -236, 64, -236, 'crate')
B(-236, 0, -300, -188, 48, -252, 'crate')
B(236, 0, 236, 300, 64, 300, 'crate')
B(188, 0, 252, 236, 48, 300, 'crate')
B(280, 0, -80, 328, 48, -32, 'crate')
B(-328, 0, 32, -280, 48, 80, 'crate')
B(-640, 0, -40, -576, 64, 24, 'crate')
B(576, 0, -24, 640, 64, 40, 'crate')

// render-only skyline outside the walls (gives parallax / depth)
D(-1500, 0, -1400, -1100, 620, -1000, 'building')
D(-900, 0, -1500, -500, 480, -1050, 'building')
D(-200, 0, -1700, 300, 760, -1200, 'building')
D(600, 0, -1450, 1000, 540, -1000, 'building')
D(1100, 0, -900, 1500, 680, -400, 'building')
D(1050, 0, 100, 1400, 460, 600, 'building')
D(1000, 0, 900, 1500, 720, 1400, 'building')
D(200, 0, 1100, 700, 520, 1500, 'building')
D(-600, 0, 1050, -100, 640, 1500, 'building')
D(-1500, 0, 600, -1050, 500, 1200, 'building')
D(-1450, 0, -300, -1050, 580, 300, 'building')
D(-3000, -20, -3000, 3000, -16, 3000, 'ground')

const spawnXZ = [
  [-700, -200], [700, 200], [-200, 700], [200, -700],
  [-640, 250], [640, -250], [0, -620], [0, 620],
]
const spawns = spawnXZ.map(([x, z]) => ({ x, y: 0.05, z, yaw: Math.atan2(x, z) }))

export const MAP = { name: 'Yard', boxes, decor, spawns }
