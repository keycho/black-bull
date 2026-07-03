// black bull - assembles the chunked voxel terrain + biome-driven decoration
// (sea, grass, trees, rocks, crystals, embers). everything is instanced - one
// draw call per decoration family - so a whole continent of scatter stays
// cheap. collision reads voxels.top so bull movement is unchanged by any of it.

import * as THREE from "three";
import { CELL, GRID, SEA, WORLD } from "./config";
import {
  makeBumpTexture,
  makeDetailTexture,
  makeGrassTexture,
  makeWaterBump,
} from "./textures";
import {
  BIO_ASH,
  BIO_CANYON,
  BIO_CRYSTAL,
  BIO_OBSIDIAN,
  BIO_PLAINS,
  BIO_RUINS,
  BIO_STORM,
  VoxelTerrain,
} from "./voxels";

export interface World {
  group: THREE.Group;
  voxels: VoxelTerrain;
  heights: Int16Array;
  water: THREE.Mesh;
  waterBump: THREE.Texture;
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeTuftGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const w = 0.5;
  const h = 0.9;
  const pos = new Float32Array([
    -w, 0, 0, w, 0, 0, w, h, 0, -w, h, 0, 0, 0, -w, 0, 0, w, 0, h, w, 0, h, -w,
  ]);
  const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]);
  const nor = new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
  ]);
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return g;
}

interface Tree {
  x: number;
  y: number;
  z: number;
  t: number;
  r: number;
}
interface Scatter {
  x: number;
  y: number;
  z: number;
  s: number;
}

export function buildWorld(): World {
  const detail = makeDetailTexture();
  const bump = makeBumpTexture();
  const voxels = new VoxelTerrain(detail, bump);
  const top = voxels.top;

  const group = new THREE.Group();
  group.add(voxels.group);

  const base = new THREE.Mesh(
    new THREE.BoxGeometry(WORLD + 6, 1, WORLD + 6),
    new THREE.MeshStandardMaterial({ color: 0x0b0e13, roughness: 1 })
  );
  base.position.y = -0.5;
  group.add(base);

  const waterBump = makeWaterBump();
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD + 6, WORLD + 6, 1, 1),
    new THREE.MeshStandardMaterial({
      color: 0x22666e,
      transparent: true,
      opacity: 0.78,
      roughness: 0.14,
      metalness: 0.2,
      bumpMap: waterBump,
      bumpScale: 0.5,
    })
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = SEA + 0.18;
  group.add(water);

  // --- collect decoration by biome ---
  const rng = makeRng(0xb011b011);
  const dummy = new THREE.Object3D();
  const grassPos: Scatter[] = []; // plains + ruins grass tufts
  const rockPos: Scatter[] = []; // plains/ruins/storm grey rocks
  const oakTrees: Tree[] = []; // plains oaks
  const deadTrees: Tree[] = []; // ruins gnarled trees
  const redRocks: Scatter[] = []; // canyon boulders
  const crystals: Scatter[] = []; // crystal-field glow shards
  const embers: Scatter[] = []; // ash valley lava embers
  const ashRocks: Scatter[] = []; // ash + obsidian basalt boulders
  const stormTufts: Scatter[] = []; // storm plateau pale sedge

  const GRASS_CAP = 15000;
  const ROCK_CAP = 1400;
  const OAK_CAP = 1100;
  const DEAD_CAP = 520;
  const REDROCK_CAP = 1300;
  const CRYSTAL_CAP = 2600;
  const EMBER_CAP = 2200;
  const ASHROCK_CAP = 1500;
  const STORMTUFT_CAP = 2400;

  for (let i = 0; i < GRID; i += 1) {
    for (let j = 0; j < GRID; j += 1) {
      const h = top[i * GRID + j];
      if (h <= SEA + 1) continue;
      const x = (i - GRID / 2 + 0.5) * CELL;
      const z = (j - GRID / 2 + 0.5) * CELL;
      const b = voxels.biome[i * GRID + j];

      switch (b) {
        case BIO_PLAINS: {
          if (h <= 16 && rng() < 0.4 && grassPos.length < GRASS_CAP)
            grassPos.push({ x: x + (rng() - 0.5) * 0.85, y: h, z: z + (rng() - 0.5) * 0.85, s: 1 });
          if (h >= 4 && h <= 16 && rng() < 0.02 && oakTrees.length < OAK_CAP)
            oakTrees.push({ x: x + (rng() - 0.5) * 0.6, y: h, z: z + (rng() - 0.5) * 0.6, t: 3.2 + rng() * 2.4, r: 2 + rng() * 1.2 });
          if (rng() < 0.006 && rockPos.length < ROCK_CAP) rockPos.push({ x, y: h, z, s: 0.5 + rng() * 1.2 });
          break;
        }
        case BIO_RUINS: {
          if (h <= 14 && rng() < 0.22 && grassPos.length < GRASS_CAP)
            grassPos.push({ x: x + (rng() - 0.5) * 0.85, y: h, z: z + (rng() - 0.5) * 0.85, s: 1 });
          if (h >= 4 && h <= 14 && rng() < 0.008 && deadTrees.length < DEAD_CAP)
            deadTrees.push({ x, y: h, z, t: 2.6 + rng() * 2.4, r: 1.2 + rng() * 0.8 });
          if (rng() < 0.012 && rockPos.length < ROCK_CAP) rockPos.push({ x, y: h, z, s: 0.6 + rng() * 1.6 });
          break;
        }
        case BIO_CANYON: {
          if (rng() < 0.016 && redRocks.length < REDROCK_CAP) redRocks.push({ x, y: h, z, s: 0.7 + rng() * 2.1 });
          break;
        }
        case BIO_CRYSTAL: {
          if (rng() < 0.05 && crystals.length < CRYSTAL_CAP)
            crystals.push({ x: x + (rng() - 0.5) * 0.8, y: h, z: z + (rng() - 0.5) * 0.8, s: 0.4 + rng() * 1.1 });
          if (h <= 12 && rng() < 0.08 && grassPos.length < GRASS_CAP)
            grassPos.push({ x, y: h, z, s: 1 });
          break;
        }
        case BIO_ASH: {
          if (h <= 12 && rng() < 0.045 && embers.length < EMBER_CAP)
            embers.push({ x: x + (rng() - 0.5) * 0.8, y: h, z: z + (rng() - 0.5) * 0.8, s: 0.4 + rng() * 0.9 });
          if (rng() < 0.02 && ashRocks.length < ASHROCK_CAP) ashRocks.push({ x, y: h, z, s: 0.6 + rng() * 1.7 });
          break;
        }
        case BIO_OBSIDIAN: {
          if (rng() < 0.02 && ashRocks.length < ASHROCK_CAP) ashRocks.push({ x, y: h, z, s: 0.7 + rng() * 2.2 });
          break;
        }
        case BIO_STORM: {
          if (h >= SEA + 10 && rng() < 0.1 && stormTufts.length < STORMTUFT_CAP)
            stormTufts.push({ x, y: h, z, s: 0.8 + rng() * 0.8 });
          if (rng() < 0.012 && rockPos.length < ROCK_CAP) rockPos.push({ x, y: h, z, s: 0.7 + rng() * 1.9 });
          break;
        }
      }
    }
  }

  // grass tufts (plains / ruins / crystal floor) - one instanced draw
  if (grassPos.length) {
    const m = new THREE.InstancedMesh(
      makeTuftGeometry(),
      new THREE.MeshStandardMaterial({ map: makeGrassTexture(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1 }),
      grassPos.length
    );
    const c = new THREE.Color();
    for (let k = 0; k < grassPos.length; k++) {
      const p = grassPos[k];
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, rng() * Math.PI, 0);
      const sc = 0.7 + rng() * 0.8;
      dummy.scale.set(sc, 0.8 + rng() * 0.7, sc);
      dummy.updateMatrix();
      m.setMatrixAt(k, dummy.matrix);
      c.setHex(0x5cb35c).multiplyScalar(0.78 + rng() * 0.48);
      m.setColorAt(k, c);
    }
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    m.instanceMatrix.needsUpdate = true;
    group.add(m);
  }

  // pale storm-plateau sedge (wind-worn, silvery)
  if (stormTufts.length) {
    const m = new THREE.InstancedMesh(
      makeTuftGeometry(),
      new THREE.MeshStandardMaterial({ map: makeGrassTexture(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1 }),
      stormTufts.length
    );
    const c = new THREE.Color();
    for (let k = 0; k < stormTufts.length; k++) {
      const p = stormTufts[k];
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, rng() * Math.PI, 0);
      dummy.scale.set(p.s, p.s * (0.7 + rng() * 0.5), p.s);
      dummy.updateMatrix();
      m.setMatrixAt(k, dummy.matrix);
      c.setHex(0x9fb4b0).multiplyScalar(0.75 + rng() * 0.4);
      m.setColorAt(k, c);
    }
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    m.instanceMatrix.needsUpdate = true;
    group.add(m);
  }

  // grey rocks (plains / ruins / storm)
  buildRocks(group, dummy, rng, rockPos, 0x5b626a, 0x6f8a96);
  // canyon red boulders
  buildRocks(group, dummy, rng, redRocks, 0x9a5236, 0xb87333);
  // ash + obsidian basalt boulders
  buildRocks(group, dummy, rng, ashRocks, 0x2a262e, 0x3a2230);

  // glowing crystal shards (crystal fields)
  if (crystals.length) {
    const m = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.22, 1.1, 5),
      new THREE.MeshStandardMaterial({
        color: 0x4fe0ff,
        emissive: 0x32d6e6,
        emissiveIntensity: 1.5,
        flatShading: true,
        roughness: 0.4,
        toneMapped: false,
      }),
      crystals.length
    );
    const c = new THREE.Color();
    for (let k = 0; k < crystals.length; k++) {
      const p = crystals[k];
      dummy.position.set(p.x, p.y + p.s * 0.5, p.z);
      dummy.rotation.set((rng() - 0.5) * 0.5, rng() * Math.PI, (rng() - 0.5) * 0.5);
      dummy.scale.set(p.s, p.s * (1.1 + rng()), p.s);
      dummy.updateMatrix();
      m.setMatrixAt(k, dummy.matrix);
      c.setHex(rng() < 0.3 ? 0x6bff9a : 0x4fe0ff).multiplyScalar(0.85 + rng() * 0.4);
      m.setColorAt(k, c);
    }
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    m.instanceMatrix.needsUpdate = true;
    group.add(m);
  }

  // lava embers (ash valley) - flat glowing puddles + sparks
  if (embers.length) {
    const m = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.26, 0),
      new THREE.MeshStandardMaterial({
        color: 0xff7327,
        emissive: 0xff4a12,
        emissiveIntensity: 1.8,
        flatShading: true,
        roughness: 0.5,
        toneMapped: false,
      }),
      embers.length
    );
    const c = new THREE.Color();
    for (let k = 0; k < embers.length; k++) {
      const p = embers[k];
      dummy.position.set(p.x, p.y + 0.08, p.z);
      dummy.rotation.set(0, rng() * Math.PI, 0);
      dummy.scale.set(p.s * 1.4, p.s * (0.22 + rng() * 0.3), p.s * 1.4);
      dummy.updateMatrix();
      m.setMatrixAt(k, dummy.matrix);
      c.setHex(rng() < 0.4 ? 0xffb24a : 0xff5a1a).multiplyScalar(0.9 + rng() * 0.4);
      m.setColorAt(k, c);
    }
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    m.instanceMatrix.needsUpdate = true;
    group.add(m);
  }

  // plains oaks (broad rounded canopies)
  buildTrees(group, dummy, rng, oakTrees, 0x3f9a3f, true);
  // ruins dead trees (bare dark canopies, half size)
  buildTrees(group, dummy, rng, deadTrees, 0x4a4438, false);

  return { group, voxels, heights: top, water, waterBump };
}

function buildRocks(
  group: THREE.Group,
  dummy: THREE.Object3D,
  rng: () => number,
  rocks: Scatter[],
  hexA: number,
  hexB: number
) {
  if (!rocks.length) return;
  const m = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.5, 0),
    new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 1 }),
    rocks.length
  );
  const c = new THREE.Color();
  for (let k = 0; k < rocks.length; k++) {
    const p = rocks[k];
    dummy.position.set(p.x, p.y + p.s * 0.25, p.z);
    dummy.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
    dummy.scale.set(p.s, p.s * (0.7 + rng() * 0.6), p.s);
    dummy.updateMatrix();
    m.setMatrixAt(k, dummy.matrix);
    c.setHex(rng() < 0.25 ? hexB : hexA).multiplyScalar(0.78 + rng() * 0.4);
    m.setColorAt(k, c);
  }
  dummy.rotation.set(0, 0, 0);
  dummy.scale.set(1, 1, 1);
  m.instanceMatrix.needsUpdate = true;
  m.castShadow = true;
  m.receiveShadow = true;
  group.add(m);
}

// conical or rounded canopy trees
function buildTrees(
  group: THREE.Group,
  dummy: THREE.Object3D,
  rng: () => number,
  trees: Tree[],
  canopyHex: number,
  rounded: boolean
) {
  if (!trees.length) return;
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.28, 0.42, 1, 6),
    new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 }),
    trees.length
  );
  const canopyGeo = rounded
    ? new THREE.IcosahedronGeometry(1, 0)
    : new THREE.ConeGeometry(1, 2.4, 7);
  const canopyMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85 });
  const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, trees.length);
  const c = new THREE.Color();
  for (let k = 0; k < trees.length; k++) {
    const p = trees[k];
    dummy.position.set(p.x, p.y + p.t / 2, p.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, p.t, 1);
    dummy.updateMatrix();
    trunks.setMatrixAt(k, dummy.matrix);

    if (rounded) {
      dummy.position.set(p.x, p.y + p.t + p.r * 0.5, p.z);
      dummy.rotation.set(rng() * 0.5, rng() * Math.PI, rng() * 0.5);
      dummy.scale.set(p.r, p.r * 0.85, p.r);
    } else {
      dummy.position.set(p.x, p.y + p.t + p.r * 0.9, p.z);
      dummy.rotation.set(0, rng() * Math.PI, 0);
      dummy.scale.set(p.r, p.r * 1.5, p.r);
    }
    dummy.updateMatrix();
    canopies.setMatrixAt(k, dummy.matrix);
    c.setHex(canopyHex).multiplyScalar(0.82 + rng() * 0.32);
    canopies.setColorAt(k, c);
  }
  dummy.rotation.set(0, 0, 0);
  dummy.scale.set(1, 1, 1);
  trunks.instanceMatrix.needsUpdate = true;
  canopies.instanceMatrix.needsUpdate = true;
  trunks.castShadow = true;
  canopies.castShadow = true;
  canopies.receiveShadow = true;
  group.add(trunks);
  group.add(canopies);
}

export function groundHeightAt(world: World, x: number, z: number): number {
  const i = Math.floor(x / CELL + GRID / 2);
  const j = Math.floor(z / CELL + GRID / 2);
  if (i < 0 || j < 0 || i >= GRID || j >= GRID) return 0;
  return world.heights[i * GRID + j];
}
