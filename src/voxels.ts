// black bull - chunked voxel terrain in plain three.js. solidity + type per cell
// on global arrays; rendering is split into per-region instanced meshes so the
// renderer frustum-culls off-screen chunks (main and shadow passes), keeping a
// large world smooth. raycast/collision run on the global data, so only the
// render is chunked. the generator builds ONE continent battlefield: a central
// colosseum arena ringed by seven biomes, cut by two rivers with intact bridges
// (which the earthquake event can collapse).
//
// the render/edit core (chunks, instancing, break/place, remote edits, raycast)
// is the proven engine from the previous game - only the generator changed.

import * as THREE from "three";
import { blockColor, NONE } from "./blocks";
import {
  ARENA_FLOOR,
  ARENA_R,
  ARENA_WALL_R,
  BASE_AMP,
  CHUNK,
  GRID,
  MTN_AMP,
  SEA,
} from "./config";

export const MAXY = 56;
const CPS = GRID / CHUNK; // chunks per side

// --- terrain noise ---
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  const u = smooth(xf);
  const v = smooth(yf);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function fractal(x: number, y: number): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < 4; o++) {
    sum += valueNoise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.05;
  }
  return sum / norm;
}
function ridged(x: number, y: number): number {
  return 1 - Math.abs(2 * valueNoise(x, y) - 1);
}
function sstep(e0: number, e1: number, x: number): number {
  let t = (x - e0) / (e1 - e0);
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}

// --- the continent -----------------------------------------------------------
// one landmass centred on the arena. seven biome sectors fan out around it,
// their boundaries wobbled by noise so they read as natural regions, heights
// blended across the seams so every border is a rideable slope.

const C = GRID / 2; // grid centre
const LAND_R = GRID * 0.44; // nominal continent radius (cells)

// biome indices (sector order around the compass)
export const BIO_PLAINS = 0;
export const BIO_RUINS = 1;
export const BIO_CANYON = 2;
export const BIO_CRYSTAL = 3;
export const BIO_ASH = 4;
export const BIO_OBSIDIAN = 5;
export const BIO_STORM = 6;
export const BIOME_NAMES = [
  "green plains",
  "ancient ruins",
  "red canyon",
  "crystal fields",
  "ash valley",
  "obsidian mountains",
  "storm plateau",
];
// map/hud tints per biome (minimap backdrop + hud readout)
export const BIOME_TINTS = [0x3f7a3a, 0x5a6e46, 0xa05a30, 0x2fb5a8, 0x53504c, 0x33303e, 0x5a6d80];

// the centre angle of each sector in world radians (for feature anchors)
export function sectorAngle(s: number): number {
  return ((s + 0.5) / 7) * Math.PI * 2 - Math.PI;
}
// a feature anchor inside sector s at ring radius r (grid coords)
function sectorAnchor(s: number, r: number): { i: number; j: number } {
  const a = sectorAngle(s);
  return { i: Math.round(C + Math.cos(a) * r), j: Math.round(C + Math.sin(a) * r) };
}

// per-biome raw height (before continent mask / blending). all return a height
// in voxels around SEA, tuned so borders meet within a few blocks.
function biomeHeight(s: number, i: number, j: number): number {
  const relief = fractal(i * 0.06 + 11.3, j * 0.06 + 7.1);
  switch (s) {
    case BIO_PLAINS: {
      // rolling green ground with soft hills - the open charging ground
      const hills = sstep(0.55, 0.85, fractal(i * 0.02 + 50, j * 0.02 + 80));
      return SEA + 2.5 + relief * BASE_AMP * 0.8 + hills * 6;
    }
    case BIO_RUINS: {
      // drier meadow, gentle mounds; the structures are baked on top
      const mound = sstep(0.55, 0.8, fractal(i * 0.024 + 400, j * 0.024 + 430));
      return SEA + 2.5 + relief * BASE_AMP * 0.7 + mound * 5;
    }
    case BIO_CANYON: {
      // low dunes, flat-topped mesas, and slot canyons carved through them
      const dune = fractal(i * 0.03 + 80, j * 0.09 + 40);
      let h = SEA + 2 + dune * 6;
      const mesa = sstep(0.56, 0.74, fractal(i * 0.024 + 1500, j * 0.024 + 1540));
      if (mesa > 0) h = h * (1 - mesa) + (SEA + 16) * mesa;
      const slot = sstep(0.62, 0.72, fractal(i * 0.045 + 1800, j * 0.045 + 1820));
      h -= slot * Math.max(0, h - (SEA + 1.5)) * 0.9; // canyons cut nearly to the floor
      return h;
    }
    case BIO_CRYSTAL: {
      // luminous rounded mounds; crystal spike formations are baked on top
      const bulb = sstep(0.5, 0.85, fractal(i * 0.035 + 2400, j * 0.035 + 2430));
      return SEA + 2.5 + relief * BASE_AMP * 0.7 + bulb * (0.4 + ridged(i * 0.05 + 9, j * 0.05 + 9) * 0.6) * 10;
    }
    case BIO_ASH: {
      // grey flats with low cinder cones and glowing lava cracks
      const cone = sstep(0.68, 0.86, fractal(i * 0.03 + 3300, j * 0.03 + 3330));
      return SEA + 2 + relief * BASE_AMP * 0.5 + cone * 9;
    }
    case BIO_OBSIDIAN: {
      // the tall dark range - ridged peaks with rideable passes carved through
      const mm = sstep(0.42, 0.75, fractal(i * 0.016 + 150, j * 0.016 + 180));
      let h = SEA + 3 + relief * BASE_AMP * 0.7;
      h += mm * (0.45 + ridged(i * 0.05 + 15, j * 0.05 + 15) * 0.65) * MTN_AMP;
      const pass = sstep(0.6, 0.68, fractal(i * 0.03 + 800, j * 0.03 + 830));
      h -= pass * Math.max(0, h - (SEA + 6)) * 0.8; // passes drop to rideable valleys
      return h;
    }
    default: {
      // storm plateau: a high flat table with cliff rims and ramp cuts
      const plat = sstep(0.35, 0.6, fractal(i * 0.02 + 2600, j * 0.02 + 2630));
      let h = SEA + 3 + relief * BASE_AMP * 0.5;
      h = h * (1 - plat) + (SEA + 17 + relief * 2.5) * plat;
      const ramp = sstep(0.6, 0.7, fractal(i * 0.05 + 700, j * 0.05 + 740));
      h -= ramp * Math.max(0, h - (SEA + 5)) * 0.55; // ramp cuts through the rim
      return h;
    }
  }
}

interface Col {
  biome: number; // dominant biome at this cell (-1 open water)
  land: number; // 0..1 continent mask
  H: number; // integer surface height
  arena: number; // 0..1 how deep inside the arena override we are
}

// the two rivers: winding channels that cut the continent and merge into the
// sea. deterministic curves so bridges + the earthquake agree with the carve.
function riverEWz(i: number): number {
  return C + 150 + Math.sin((i - C) * 0.008) * 90;
}
function riverNSx(j: number): number {
  return C - 160 + Math.sin((j - C) * 0.007 + 2) * 80;
}
const RIVER_W = 5; // half-width of the carved channel

function angDiff(a: number, b: number): number {
  return ((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

function colAt(i: number, j: number): Col {
  const dx = i - C;
  const dz = j - C;
  const r = Math.hypot(dx, dz);

  // continent mask with a noisy coast
  const coast = fractal(i * 0.008 + 9, j * 0.008 + 5);
  const d = r / (LAND_R + (coast - 0.5) * 110);
  const land = sstep(1.0, 0.88, d);
  if (land <= 0) return { biome: -1, land: 0, H: 1, arena: 0 };

  // biome sector with wobbled boundaries, heights blended across the seams
  const wob = (fractal(i * 0.012 + 77, j * 0.012 + 31) - 0.5) * 0.55;
  const theta = Math.atan2(dz, dx) + wob;
  let a = (theta + Math.PI) / (Math.PI * 2);
  a -= Math.floor(a);
  const s7 = a * 7;
  const sec = Math.floor(s7) % 7;
  const frac = s7 - Math.floor(s7);
  const B = 0.14; // blend half-width in sector units
  let h: number;
  let biome = sec;
  if (frac < B) {
    const prev = (sec + 6) % 7;
    const t = 0.5 + frac / (2 * B);
    h = biomeHeight(prev, i, j) * (1 - t) + biomeHeight(sec, i, j) * t;
    if (t < 0.5) biome = prev;
  } else if (frac > 1 - B) {
    const next = (sec + 1) % 7;
    const t = 0.5 + (1 - frac) / (2 * B);
    h = biomeHeight(next, i, j) * (1 - t) + biomeHeight(sec, i, j) * t;
    if (t < 0.5) biome = next;
  } else {
    h = biomeHeight(sec, i, j);
  }

  // coast taper to a beach
  h = (SEA - 5) * (1 - land) + h * land;

  // the approach ground near the arena stays gentle so every biome funnels in
  const approach = sstep(150, 90, r);
  if (approach > 0) h = h * (1 - approach) + (ARENA_FLOOR + fractal(i * 0.05, j * 0.05) * 2) * approach;

  // rivers: carve two winding channels below sea level (outside the arena ring)
  if (r > ARENA_WALL_R + 14) {
    const dEW = Math.abs(j - riverEWz(i));
    if (dEW < RIVER_W + 3) {
      const cut = sstep(RIVER_W + 3, RIVER_W - 2, dEW);
      h = h * (1 - cut) + (SEA - 2.5) * cut;
    }
    const dNS = Math.abs(i - riverNSx(j));
    if (dNS < RIVER_W + 3) {
      const cut = sstep(RIVER_W + 3, RIVER_W - 2, dNS);
      h = h * (1 - cut) + (SEA - 2.5) * cut;
    }
  }

  // the colosseum arena: a flat fighting pit with stepped amphitheater walls
  // and four gates. overrides everything inside its ring.
  let arena = 0;
  if (r < ARENA_WALL_R + 10) {
    arena = sstep(ARENA_WALL_R + 10, ARENA_WALL_R + 2, r);
    let ah: number;
    if (r < ARENA_R) {
      ah = ARENA_FLOOR; // the pit
    } else if (r < ARENA_WALL_R) {
      // stepped seating rising outward, cut by four gates
      const t = (r - ARENA_R) / (ARENA_WALL_R - ARENA_R);
      const step = Math.floor(t * 4) + 1;
      const ang = Math.atan2(dz, dx);
      const gate =
        Math.min(
          Math.abs(angDiff(ang, 0)),
          Math.abs(angDiff(ang, Math.PI / 2)),
          Math.abs(angDiff(ang, Math.PI)),
          Math.abs(angDiff(ang, -Math.PI / 2))
        ) < 0.1;
      ah = gate ? ARENA_FLOOR : ARENA_FLOOR + step * 2.2;
    } else {
      ah = ARENA_FLOOR + 9 - (r - ARENA_WALL_R) * 0.9; // outer skirt back down
    }
    h = h * (1 - arena) + ah * arena;
  }

  return { biome, land, H: Math.max(1, Math.min(MAXY - 2, Math.round(h))), arena };
}

export function heightAtCell(i: number, j: number): number {
  return colAt(i, j).H;
}
// dominant biome index at a cell (-1 open water) - drives decoration + the map
export function biomeIndexAt(i: number, j: number): number {
  return colAt(i, j).biome;
}

// surface block per biome (top voxel), with per-cell variety
function surfaceFor(c: Col, i: number, j: number): number {
  if (c.arena > 0.55 && c.H <= ARENA_FLOOR + 1) return 4; // sand fighting pit
  if (c.arena > 0.55) return hash2(i, j) < 0.3 ? 39 : 14; // stone-brick seating
  if (c.H <= SEA + 1) return 4; // beach / river banks
  const v = fractal(i * 0.07 + 500, j * 0.07 + 530);
  switch (c.biome) {
    case BIO_PLAINS:
      return v < 0.3 ? 8 : 1; // grass with moss patches
    case BIO_RUINS:
      return v < 0.25 ? 2 : v > 0.72 ? 8 : 1; // worn grass, dirt, moss
    case BIO_CANYON:
      if (c.H >= 15) return 20; // copper mesa caps
      if (c.H >= 11) return 15; // brick rock bands
      return v > 0.6 ? 46 : 45; // terracotta streaks over dune sand
    case BIO_CRYSTAL:
      if (v > 0.68) return 42; // glowing crystal veins
      if (v < 0.35) return 27; // deep teal
      return c.H >= 10 ? 33 : 1; // mint highlands over green
    case BIO_ASH:
      if (v > 0.76) return 44; // lava cracks (danger)
      if (v < 0.38) return 16; // basalt
      return 58; // ash flats
    case BIO_OBSIDIAN:
      if (c.H >= 26) return 57; // obsidian caps
      if (v > 0.62) return 57;
      return v < 0.3 ? 39 : 16; // charcoal / basalt
    default:
      if (v > 0.7) return 17; // marble streaks
      return v < 0.34 ? 38 : 18; // grey / slate table
  }
}
// body block under the surface, per biome
function bodyFor(biome: number, arena: number, y: number, H: number): number {
  if (arena > 0.55) return 14; // stone-brick bowl
  switch (biome) {
    case BIO_CANYON:
      return y >= H - 3 ? 46 : 15;
    case BIO_CRYSTAL:
      return y >= H - 3 ? 27 : 18;
    case BIO_ASH:
      return y >= H - 3 ? 16 : 40;
    case BIO_OBSIDIAN:
      return y >= H - 3 ? 16 : 57;
    case BIO_STORM:
      return y >= H - 3 ? 18 : 3;
    default:
      return y >= H - 4 ? 2 : 3; // dirt over stone
  }
}

export interface RayHit {
  hx: number;
  hy: number;
  hz: number;
  px: number;
  py: number;
  pz: number;
  hasPlace: boolean;
}

interface Chunk {
  mesh: THREE.InstancedMesh;
  slotOfVoxel: Map<number, number>;
  free: number[];
  dirty: boolean;
}

// there is no player building in black bull - headroom only covers event terrain
// edits (meteor craters, fissures expose new faces). growChunk covers overflow.
const HEADROOM = 220;
const HEADROOM_SEA = 48;

// a bridge: its deck cells (for the earthquake collapse) + its midpoint
export interface Bridge {
  x: number; // world coords of the middle of the span
  z: number;
  cells: { x: number; y: number; z: number }[]; // deck voxels (grid coords)
}

export class VoxelTerrain {
  readonly group = new THREE.Group();
  readonly top: Int16Array;
  readonly bridges: Bridge[] = [];
  // biome index per column (-1 water), cached at gen so decoration + the map
  // never have to re-run the generator.
  readonly biome: Int8Array;
  private solid: Uint8Array;
  private btype: Uint8Array;
  private chunks: Chunk[] = [];
  private dummy = new THREE.Object3D();
  private col = new THREE.Color();

  constructor(detail: THREE.Texture, bump: THREE.Texture) {
    this.solid = new Uint8Array(GRID * GRID * MAXY);
    this.btype = new Uint8Array(GRID * GRID * MAXY);
    this.top = new Int16Array(GRID * GRID);
    this.biome = new Int8Array(GRID * GRID);

    for (let x = 0; x < GRID; x++) {
      for (let z = 0; z < GRID; z++) {
        const col = colAt(x, z);
        const H = col.H;
        this.top[x * GRID + z] = H;
        this.biome[x * GRID + z] = col.biome;
        const surf = surfaceFor(col, x, z);
        for (let y = 0; y < H; y++) {
          const i = this.idx(x, y, z);
          this.solid[i] = 1;
          this.btype[i] = y === H - 1 ? surf : bodyFor(col.biome, col.arena, y, H);
        }
      }
    }

    this.placeFeatures();

    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({
      map: detail,
      bumpMap: bump,
      bumpScale: 0.3,
      flatShading: true,
      roughness: 0.95,
      metalness: 0,
    });
    // voxel "look" injected into the standard shader (no extra geometry, ~zero cost,
    // compiled once for the shared chunk material):
    //  - per-face brightness so every block reads as a real 3D cube (top brightest,
    //    bottom darkest, the two side pairs in between) - baked into the albedo so
    //    it holds regardless of the dynamic light direction.
    //  - a subtle per-cube edge darkening (cheap AO / contact-shadow seams) so packed
    //    blocks read crisply instead of blurring together.
    //  - a small saturation lift so blocks pop for readable, bright fights.
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\n varying float vFaceShade;\n varying vec2 vVoxUv;"
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
           vVoxUv = uv;
           vFaceShade = normal.y > 0.5 ? 1.0
             : (normal.y < -0.5 ? 0.55
             : (abs(normal.z) > 0.5 ? 0.80 : 0.70));`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\n varying float vFaceShade;\n varying vec2 vVoxUv;"
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
           vec2 vEdge = abs(vVoxUv - 0.5) * 2.0;
           float vAO = 1.0 - smoothstep(0.86, 1.0, max(vEdge.x, vEdge.y)) * 0.17;
           diffuseColor.rgb *= vFaceShade * vAO;
           float vLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
           diffuseColor.rgb = max(vec3(0.0), mix(vec3(vLum), diffuseColor.rgb, 1.12));`
        );
    };

    for (let cx = 0; cx < CPS; cx++) {
      for (let cz = 0; cz < CPS; cz++) {
        this.buildChunk(cx, cz, geo, mat);
      }
    }
  }

  private idx(x: number, y: number, z: number): number {
    return (x * GRID + z) * MAXY + y;
  }
  private inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && x < GRID && z >= 0 && z < GRID && y >= 0 && y < MAXY;
  }
  isSolid(x: number, y: number, z: number): boolean {
    if (!this.inBounds(x, y, z)) return false;
    return this.solid[this.idx(x, y, z)] === 1;
  }
  // solidity at a world-space point (true 3D)
  solidAtWorld(wx: number, wy: number, wz: number): boolean {
    return this.isSolid(Math.floor(wx + GRID / 2), Math.floor(wy), Math.floor(wz + GRID / 2));
  }
  // top surface of the highest solid voxel at/below fromY in this column (ignores
  // anything floating above) - ground-following for bulls, npcs and meteors.
  surfaceBelow(wx: number, wz: number, fromY: number): number {
    const vx = Math.floor(wx + GRID / 2);
    const vz = Math.floor(wz + GRID / 2);
    if (vx < 0 || vx >= GRID || vz < 0 || vz >= GRID) return 0;
    let vy = Math.min(MAXY - 1, Math.floor(fromY));
    for (; vy >= 0; vy--) if (this.solid[this.idx(vx, vy, vz)] === 1) return vy + 1;
    return 0;
  }
  private emptyAt(x: number, y: number, z: number): boolean {
    if (y < 0) return false;
    if (x < 0 || x >= GRID || z < 0 || z >= GRID || y >= MAXY) return true;
    return this.solid[this.idx(x, y, z)] === 0;
  }
  private isExposed(x: number, y: number, z: number): boolean {
    if (!this.isSolid(x, y, z)) return false;
    return (
      this.emptyAt(x + 1, y, z) ||
      this.emptyAt(x - 1, y, z) ||
      this.emptyAt(x, y + 1, z) ||
      this.emptyAt(x, y - 1, z) ||
      this.emptyAt(x, y, z + 1) ||
      this.emptyAt(x, y, z - 1)
    );
  }
  private wx(x: number): number {
    return x - GRID / 2 + 0.5;
  }
  private wz(z: number): number {
    return z - GRID / 2 + 0.5;
  }
  private chunkOf(x: number, z: number): number {
    return Math.floor(x / CHUNK) * CPS + Math.floor(z / CHUNK);
  }

  // set a solid voxel at world-gen time (raises the column top)
  private setVoxel(x: number, y: number, z: number, type: number) {
    if (!this.inBounds(x, y, z)) return;
    this.solid[this.idx(x, y, z)] = 1;
    this.btype[this.idx(x, y, z)] = type;
    const col = x * GRID + z;
    if (y + 1 > this.top[col]) this.top[col] = y + 1;
  }
  // like setVoxel but NEVER overwrites an existing solid cell, so features can be
  // baked onto terrain without altering it.
  private setVoxelIfAir(x: number, y: number, z: number, type: number) {
    if (!this.inBounds(x, y, z) || this.solid[this.idx(x, y, z)] === 1) return;
    this.solid[this.idx(x, y, z)] = 1;
    this.btype[this.idx(x, y, z)] = type;
    const col = x * GRID + z;
    if (y + 1 > this.top[col]) this.top[col] = y + 1;
  }
  private colGround(gx: number, gz: number): number {
    if (gx < 1 || gx >= GRID - 1 || gz < 1 || gz >= GRID - 1) return 0;
    return this.top[gx * GRID + gz];
  }

  // ============================ features ============================

  // a tall narrow pillar (obelisk / standing stone), optionally tapered
  private pillar(gx: number, gz: number, h: number, w: number, body: number, cap: number, taper = false) {
    const base = this.colGround(gx, gz);
    if (base <= SEA) return;
    for (let y = 0; y < h; y++) {
      const ww = taper ? Math.max(1, w - Math.round((y / h) * (w - 1))) : w;
      const off = (w - ww) >> 1;
      const t = y >= h - 2 ? cap : body;
      for (let ox = 0; ox < ww; ox++) for (let oz = 0; oz < ww; oz++) this.setVoxelIfAir(gx + off + ox, base + y, gz + off + oz, t);
    }
  }
  // a ruined rectangular structure: broken perimeter walls (gaps + uneven height),
  // a floor, accent caps, corner posts. bury>0 sinks it (ruins poking out of ground).
  private ruinBlock(gx: number, gz: number, w: number, d: number, h: number, body: number, accent: number, bury: number) {
    const g = this.colGround(gx, gz);
    if (g <= SEA) return;
    const base = Math.max(1, g - bury);
    for (let ox = 0; ox < w; ox++)
      for (let oz = 0; oz < d; oz++) {
        if (ox === 0 || ox === w - 1 || oz === 0 || oz === d - 1) {
          if (hash2(gx + ox * 1.7, gz + oz * 1.3) > 0.82) continue; // a collapsed gap
          const wallH = bury + Math.max(1, Math.round(h * (0.45 + hash2(ox + 0.5, oz + 0.5) * 0.7)));
          for (let y = 0; y < wallH; y++) this.setVoxelIfAir(gx + ox, base + y, gz + oz, y === wallH - 1 ? accent : body);
        } else {
          this.setVoxelIfAir(gx + ox, base, gz + oz, body); // floor
        }
      }
    for (const [cx, cz] of [[0, 0], [w - 1, 0], [0, d - 1], [w - 1, d - 1]])
      for (let y = 0; y < bury + h; y++) this.setVoxelIfAir(gx + cx, base + y, gz + cz, body);
  }
  // a ring of standing stones
  private stoneRing(gx: number, gz: number, radius: number, count: number, h: number, body: number, cap: number) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      this.pillar(gx + Math.round(Math.cos(a) * radius), gz + Math.round(Math.sin(a) * radius), h - (i % 3), 2, body, cap, false);
    }
  }
  // jagged crystal spikes scattered around an anchor - glowing prisms the fights
  // weave between. golden-angle scatter for an even spread.
  private crystalSpikes(cx: number, cz: number, count: number, spread: number) {
    for (let n = 0; n < count; n++) {
      const ang = n * 2.39996;
      const rad = 14 + ((n * 17) % spread);
      const sx = Math.round(cx + Math.cos(ang) * rad);
      const sz = Math.round(cz + Math.sin(ang) * rad);
      if (sx < 1 || sx >= GRID - 1 || sz < 1 || sz >= GRID - 1) continue;
      const g = this.top[sx * GRID + sz];
      if (g <= SEA + 1) continue;
      const hgt = 5 + ((n * 5) % 11);
      const wide = n % 4 === 0;
      for (let y = g; y < g + hgt; y++) {
        const t = y >= g + hgt - 3 ? 42 : 27; // glowing tip over teal body
        this.setVoxel(sx, y, sz, t);
        if (wide && y < g + hgt - 2) {
          this.setVoxel(sx + 1, y, sz, 27);
          this.setVoxel(sx, y, sz + 1, 27);
        }
      }
    }
  }

  // an INTACT bridge crossing a river: a plank deck with rails and support
  // pillars. deck cells are recorded so the earthquake event can drop the span.
  private buildBridge(alongX: boolean, gi: number, gj: number, halfSpan: number) {
    const deckY = Math.round(SEA) + 3;
    const bridge: Bridge = { x: this.wx(gi), z: this.wz(gj), cells: [] };
    for (let s = -halfSpan; s <= halfSpan; s++) {
      const x = alongX ? gi + s : gi;
      const z = alongX ? gj : gj + s;
      for (let w = -1; w <= 1; w++) {
        const bx = alongX ? x : x + w;
        const bz = alongX ? z + w : z;
        this.setVoxelIfAir(bx, deckY, bz, 12); // plank deck
        bridge.cells.push({ x: bx, y: deckY, z: bz });
      }
      // low rails on the edges
      if (Math.abs(s) % 3 === 0 && Math.abs(s) < halfSpan - 1) {
        this.setVoxelIfAir(alongX ? x : x - 2, deckY + 1, alongX ? z - 2 : z, 11);
        this.setVoxelIfAir(alongX ? x : x + 2, deckY + 1, alongX ? z + 2 : z, 11);
      }
      // support pillars down to the riverbed
      if ((s + halfSpan) % 5 === 0) {
        for (let y = 1; y < deckY; y++) this.setVoxelIfAir(x, y, z, 13);
      }
    }
    // end ramps so bulls run straight on
    for (let e = 1; e <= 3; e++) {
      for (const dir of [-1, 1]) {
        const s = dir * (halfSpan + e);
        const x = alongX ? gi + s : gi;
        const z = alongX ? gj : gj + s;
        const g = this.colGround(x, z);
        for (let y = g; y < deckY && y < g + 4 - e; y++) {
          for (let w = -1; w <= 1; w++) this.setVoxelIfAir(alongX ? x : x + w, y, alongX ? z + w : z, 13);
        }
      }
    }
    this.bridges.push(bridge);
  }

  private placeFeatures() {
    // ancient ruins: a broken temple, standing-stone rings, fallen obelisks
    const ru = sectorAnchor(BIO_RUINS, 250);
    this.ruinBlock(ru.i - 8, ru.j - 6, 15, 12, 9, 14, 8, 0);
    this.stoneRing(ru.i + 40, ru.j - 20, 10, 9, 7, 3, 8);
    this.stoneRing(ru.i - 45, ru.j + 30, 8, 7, 6, 3, 8);
    this.pillar(ru.i + 12, ru.j + 38, 14, 2, 14, 8);
    this.pillar(ru.i - 24, ru.j - 34, 11, 2, 14, 8);
    this.ruinBlock(ru.i + 55, ru.j + 24, 9, 7, 6, 3, 8, 3);
    const ru2 = sectorAnchor(BIO_RUINS, 340);
    this.ruinBlock(ru2.i, ru2.j, 11, 9, 8, 14, 8, 1);

    // crystal fields: spike formations at two rings
    const cr = sectorAnchor(BIO_CRYSTAL, 240);
    this.crystalSpikes(cr.i, cr.j, 22, 90);
    const cr2 = sectorAnchor(BIO_CRYSTAL, 350);
    this.crystalSpikes(cr2.i, cr2.j, 14, 70);

    // storm plateau: sky-touched obelisks along the rim
    const st = sectorAnchor(BIO_STORM, 260);
    this.pillar(st.i, st.j, 18, 3, 18, 34, true);
    this.pillar(st.i + 34, st.j - 18, 14, 2, 18, 34, true);
    this.pillar(st.i - 28, st.j + 26, 16, 2, 18, 34, true);

    // canyon: a copper watch spire on a mesa
    const ca = sectorAnchor(BIO_CANYON, 280);
    this.pillar(ca.i, ca.j, 12, 2, 15, 20);

    // bridges over the two rivers (the earthquake can collapse these)
    for (const bi of [C - 150, C + 110, C + 320]) {
      const bj = Math.round(riverEWz(bi));
      this.buildBridge(false, bi, bj, RIVER_W + 4); // span runs north-south over the EW river
    }
    for (const bj of [C - 130, C + 60]) {
      const bi = Math.round(riverNSx(bj));
      this.buildBridge(true, bi, bj, RIVER_W + 4); // span runs east-west over the NS river
    }
  }

  private buildChunk(cx: number, cz: number, geo: THREE.BufferGeometry, mat: THREE.Material) {
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    const exposed: number[] = [];
    let landCells = 0;
    for (let x = x0; x < x0 + CHUNK; x++) {
      for (let z = z0; z < z0 + CHUNK; z++) {
        const H = this.top[x * GRID + z];
        if (H > SEA) landCells++;
        for (let y = 0; y < H; y++) {
          if (this.isExposed(x, y, z)) exposed.push(this.idx(x, y, z));
        }
      }
    }
    // modest headroom on land chunks (event edits only); minimal over open water
    const capacity = exposed.length + (landCells > 8 ? HEADROOM : HEADROOM_SEA);
    const mesh = new THREE.InstancedMesh(geo, mat, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // manual bounds so frustum culling (main + shadow) works correctly
    const cxw = x0 + CHUNK / 2 - GRID / 2;
    const czw = z0 + CHUNK / 2 - GRID / 2;
    mesh.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(cxw, MAXY / 2, czw),
      Math.sqrt(2 * (CHUNK / 2) ** 2 + (MAXY / 2) ** 2) + 2
    );

    const chunk: Chunk = { mesh, slotOfVoxel: new Map(), free: [], dirty: false };
    for (let k = 0; k < exposed.length; k++) this.fillSlot(chunk, k, exposed[k]);
    this.dummy.position.set(0, -9999, 0);
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();
    // free slots in DESCENDING order so pop() hands out the LOWEST first - keeps
    // mesh.count (the rendered range) tight as event edits expose new faces.
    for (let k = capacity - 1; k >= exposed.length; k--) {
      mesh.setMatrixAt(k, this.dummy.matrix);
      chunk.free.push(k);
    }
    mesh.count = exposed.length; // render only the real instances
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.chunks[cx * CPS + cz] = chunk;
    this.group.add(mesh);
  }

  private fillSlot(chunk: Chunk, slot: number, vi: number) {
    const y = vi % MAXY;
    const xz = (vi - y) / MAXY;
    const z = xz % GRID;
    const x = (xz - z) / GRID;
    this.dummy.position.set(this.wx(x), y + 0.5, this.wz(z));
    this.dummy.scale.set(1, 1, 1);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.updateMatrix();
    chunk.mesh.setMatrixAt(slot, this.dummy.matrix);
    this.col
      .setHex(blockColor(this.btype[vi]))
      .multiplyScalar(0.9 + hash2(x * 3.7 + y, z * 1.9) * 0.2);
    chunk.mesh.setColorAt(slot, this.col);
    chunk.slotOfVoxel.set(vi, slot);
  }

  private addInstance(x: number, y: number, z: number) {
    const ci = this.chunkOf(x, z);
    const chunk = this.chunks[ci];
    const vi = this.idx(x, y, z);
    if (chunk.slotOfVoxel.has(vi)) return;
    let slot = chunk.free.pop();
    if (slot === undefined) { this.growChunk(ci); slot = chunk.free.pop(); } // out of room -> enlarge, never drop the block
    if (slot === undefined) return; // grow failed (defensive) - placeAt rolls back the data
    this.fillSlot(chunk, slot, vi);
    if (slot >= chunk.mesh.count) chunk.mesh.count = slot + 1; // grow the rendered range
    chunk.dirty = true;
  }

  // enlarge a chunk's instanced mesh when it runs out of placement slots, so event
  // terrain edits never silently fail to render. on-demand: only chunks that get
  // reshaped pay the extra memory. preserves every instance.
  private growChunk(ci: number) {
    const chunk = this.chunks[ci];
    if (!chunk) return;
    const old = chunk.mesh;
    const cap = old.instanceMatrix.count;
    const newCap = cap + HEADROOM;
    const mesh = new THREE.InstancedMesh(old.geometry, old.material as THREE.Material, newCap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.boundingSphere = old.boundingSphere;
    (mesh.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(newCap * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    if (old.instanceColor) (mesh.instanceColor.array as Float32Array).set(old.instanceColor.array as Float32Array);
    this.dummy.position.set(0, -9999, 0);
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();
    for (let k = newCap - 1; k >= cap; k--) { mesh.setMatrixAt(k, this.dummy.matrix); chunk.free.push(k); }
    mesh.count = old.count;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    this.group.remove(old);
    this.group.add(mesh);
    old.dispose();
    chunk.mesh = mesh;
  }
  private removeInstance(x: number, y: number, z: number) {
    const chunk = this.chunks[this.chunkOf(x, z)];
    const vi = this.idx(x, y, z);
    const slot = chunk.slotOfVoxel.get(vi);
    if (slot === undefined) return;
    this.dummy.position.set(0, -9999, 0);
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();
    chunk.mesh.setMatrixAt(slot, this.dummy.matrix);
    chunk.slotOfVoxel.delete(vi);
    chunk.free.push(slot);
    chunk.dirty = true;
  }

  private flush() {
    for (const c of this.chunks) {
      if (c && c.dirty) {
        c.mesh.instanceMatrix.needsUpdate = true;
        if (c.mesh.instanceColor) c.mesh.instanceColor.needsUpdate = true;
        c.dirty = false;
      }
    }
  }

  topAt(x: number, z: number): number {
    if (x < 0 || x >= GRID || z < 0 || z >= GRID) return 0;
    return this.top[x * GRID + z];
  }

  // block type at a cell (NONE if empty / out of bounds) - lava checks etc.
  typeAt(x: number, y: number, z: number): number {
    if (!this.inBounds(x, y, z) || this.solid[this.idx(x, y, z)] === 0) return NONE;
    return this.btype[this.idx(x, y, z)];
  }

  breakAt(x: number, y: number, z: number): boolean {
    if (!this.isSolid(x, y, z)) return false;
    this.solid[this.idx(x, y, z)] = 0;
    this.btype[this.idx(x, y, z)] = NONE;
    this.removeInstance(x, y, z);
    if (this.isSolid(x + 1, y, z)) this.addInstance(x + 1, y, z);
    if (this.isSolid(x - 1, y, z)) this.addInstance(x - 1, y, z);
    if (this.isSolid(x, y + 1, z)) this.addInstance(x, y + 1, z);
    if (this.isSolid(x, y - 1, z)) this.addInstance(x, y - 1, z);
    if (this.isSolid(x, y, z + 1)) this.addInstance(x, y, z + 1);
    if (this.isSolid(x, y, z - 1)) this.addInstance(x, y, z - 1);
    const col = x * GRID + z;
    if (this.top[col] === y + 1) {
      let ny = y - 1;
      while (ny >= 0 && this.solid[this.idx(x, ny, z)] === 0) ny--;
      this.top[col] = ny + 1;
    }
    this.flush();
    return true;
  }

  placeAt(x: number, y: number, z: number, type: number): boolean {
    if (!this.inBounds(x, y, z) || this.isSolid(x, y, z)) return false;
    const i = this.idx(x, y, z);
    this.solid[i] = 1;
    this.btype[i] = type;
    this.addInstance(x, y, z);
    // safety net: if the instance could not be added (grow failed), roll back so
    // we never leave an invisible-but-solid block.
    if (!this.chunks[this.chunkOf(x, z)].slotOfVoxel.has(i)) {
      this.solid[i] = 0;
      this.btype[i] = NONE;
      return false;
    }
    const col = x * GRID + z;
    if (y + 1 > this.top[col]) this.top[col] = y + 1;
    this.flush();
    return true;
  }

  // force a cell to an authoritative state (type 0 = air). used for terrain
  // edits made by the event authority (live broadcast) and the persisted world
  // delta loaded on join, so the shared world - and collision - stays
  // consistent for everyone.
  applyRemoteEdit(x: number, y: number, z: number, type: number) {
    if (!this.inBounds(x, y, z)) return;
    if (this.isSolid(x, y, z)) this.breakAt(x, y, z);
    if (type !== NONE) this.placeAt(x, y, z, type);
  }

  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    reach: number
  ): RayHit | null {
    const px = ox + GRID / 2;
    const py = oy;
    const pz = oz + GRID / 2;
    let vx = Math.floor(px);
    let vy = Math.floor(py);
    let vz = Math.floor(pz);
    const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    const adz = Math.abs(dz);
    const tDeltaX = adx > 1e-8 ? 1 / adx : Infinity;
    const tDeltaY = ady > 1e-8 ? 1 / ady : Infinity;
    const tDeltaZ = adz > 1e-8 ? 1 / adz : Infinity;
    let tMaxX = adx > 1e-8 ? (sx > 0 ? vx + 1 - px : px - vx) / adx : Infinity;
    let tMaxY = ady > 1e-8 ? (sy > 0 ? vy + 1 - py : py - vy) / ady : Infinity;
    let tMaxZ = adz > 1e-8 ? (sz > 0 ? vz + 1 - pz : pz - vz) / adz : Infinity;
    let prevX = vx;
    let prevY = vy;
    let prevZ = vz;
    let hasPrev = false;
    let t = 0;
    const maxIter = Math.ceil(reach) * 3 + 6;
    for (let it = 0; it < maxIter; it++) {
      if (vy >= 0 && vy < MAXY && vx >= 0 && vx < GRID && vz >= 0 && vz < GRID) {
        if (this.solid[this.idx(vx, vy, vz)] === 1) {
          return { hx: vx, hy: vy, hz: vz, px: prevX, py: prevY, pz: prevZ, hasPlace: hasPrev };
        }
      }
      prevX = vx;
      prevY = vy;
      prevZ = vz;
      hasPrev = true;
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
        vx += sx;
        t = tMaxX;
        tMaxX += tDeltaX;
      } else if (tMaxY <= tMaxZ) {
        vy += sy;
        t = tMaxY;
        tMaxY += tDeltaY;
      } else {
        vz += sz;
        t = tMaxZ;
        tMaxZ += tDeltaZ;
      }
      if (t > reach) return null;
    }
    return null;
  }

  worldCenter(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.wx(x), y + 0.5, this.wz(z));
  }
}
