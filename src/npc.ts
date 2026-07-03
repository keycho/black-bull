// black bull - npcs: the ambient wild herd, the golden herd event bulls, and
// the invading bears. HOST-AUTHORITATIVE: the host (lowest id present) runs
// every npc brain and broadcasts snapshots; everyone else renders + interpolates
// the same herd. ramming an npc is claimed through the host (first come wins),
// which broadcasts the removal + credit, so a golden bull can never be claimed
// twice. bear swipes are relayed to the victim as npc shoves (no player credit).
//
// brains are deliberately simple steering (wander / flee / chase + water
// avoidance) - npcs exist to be rammed, not to win.

import * as THREE from "three";
import { BullModel } from "./bullmodel";
import {
  BEAR_SWIPE_KB,
  BEAR_SWIPE_R,
  GRID,
  KB_UP,
  NPC_SYNC_HZ,
  SEA,
  WILD_HERD,
} from "./config";
import type { Net, NpcRow } from "./net";
import type { Particles } from "./particles";
import { sectorAngle, BIO_PLAINS } from "./voxels";
import type { World } from "./world";

export const NPC_WILD = 0;
export const NPC_GOLDEN = 1;
export const NPC_BEAR = 2;

const SPEED = [3.6, 9.5, 6.8]; // per type
const FLEE_R = [7, 16, 0];

interface Npc {
  id: number;
  ty: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  state: number; // 0 amble, 1 run
  // host sim
  wanderT: number;
  swipeT: number;
  // render
  model: BullModel | BearModel;
  pos: THREE.Vector3;
  target: THREE.Vector3;
  dustT: number;
}

// a chunky voxel bear: box body, round head, little ears, swinging arms
class BearModel {
  readonly group = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private phase = Math.random() * 6;

  constructor(scene: THREE.Scene | THREE.Group) {
    const fur = new THREE.MeshStandardMaterial({ color: 0x5a4028, roughness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3c2a18, roughness: 0.95 });
    const eye = new THREE.MeshStandardMaterial({ color: 0xff4a3c, emissive: 0xb02818, emissiveIntensity: 1.1, toneMapped: false });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.5, 1.0), fur);
    body.position.y = 1.15;
    const belly = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.2), dark);
    belly.position.set(0, 1.0, -0.46);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.72, 0.74), fur);
    head.position.set(0, 2.2, -0.2);
    const snout = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.28, 0.3), dark);
    snout.position.set(0, 2.06, -0.66);
    const earL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.14), dark);
    earL.position.set(-0.3, 2.62, -0.1);
    const earR = earL.clone();
    earR.position.x = 0.3;
    const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.06), eye);
    eyeL.position.set(-0.2, 2.3, -0.56);
    const eyeR = eyeL.clone();
    eyeR.position.x = 0.2;
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.44), dark);
    legL.position.set(-0.34, 0.25, 0.1);
    const legR = legL.clone();
    legR.position.x = 0.34;
    this.armL.position.set(-0.78, 1.7, 0);
    const armMeshL = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.0, 0.36), fur);
    armMeshL.position.y = -0.4;
    const pawL = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.4), dark);
    pawL.position.y = -0.92;
    this.armL.add(armMeshL, pawL);
    this.armR.position.set(0.78, 1.7, 0);
    const armMeshR = armMeshL.clone();
    const pawR = pawL.clone();
    this.armR.add(armMeshR, pawR);
    body.castShadow = true;
    head.castShadow = true;
    this.group.add(body, belly, head, snout, earL, earR, eyeL, eyeR, legL, legR, this.armL, this.armR);
    this.group.rotation.order = "YXZ";
    this.group.visible = false;
    scene.add(this.group);
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }
  update(dt: number, _now: number, pos: THREE.Vector3, yaw: number, speed: number) {
    this.phase += dt * (2 + Math.min(speed, 10) * 0.9);
    const sw = Math.sin(this.phase);
    this.armL.rotation.x = sw * (speed > 0.5 ? 0.9 : 0.12);
    this.armR.rotation.x = -sw * (speed > 0.5 ? 0.9 : 0.12);
    const bob = Math.abs(Math.cos(this.phase)) * Math.min(0.12, speed * 0.02);
    this.group.position.set(pos.x, pos.y + bob, pos.z);
    this.group.rotation.y = yaw;
    this.group.rotation.z = sw * 0.06;
  }
}

export class NpcManager {
  private npcs = new Map<number, Npc>();
  private nextId = 1;
  private syncT = 0;
  private respawnT = 0;
  // main wires these
  onLocalShove?: (dx: number, dz: number, kb: number, up: number) => void; // a bear swiped the local player
  getPlayers?: () => { id: string; x: number; y: number; z: number; local: boolean }[];

  constructor(
    private scene: THREE.Scene,
    private world: World,
    private net: Net,
    private fx: Particles
  ) {
    this.net.onNpcs = (rows) => this.applyRows(rows);
    this.net.onNpcHit = (id, by, pw) => this.resolveHit(id, by, pw);
    this.net.onNpcGone = (id, by, x, y, z, ty) => this.applyGone(id, by, x, y, z, ty);
  }

  count(ty: number): number {
    let n = 0;
    for (const p of this.npcs.values()) if (p.ty === ty) n++;
    return n;
  }
  eachNpc(cb: (x: number, z: number, ty: number) => void) {
    for (const p of this.npcs.values()) cb(p.pos.x, p.pos.z, p.ty);
  }
  // for local ram detection in main
  list(): { id: number; ty: number; pos: THREE.Vector3 }[] {
    const out: { id: number; ty: number; pos: THREE.Vector3 }[] = [];
    for (const p of this.npcs.values()) out.push({ id: p.id, ty: p.ty, pos: p.pos });
    return out;
  }

  // fired on any client when the host confirms a kill/claim; main awards credit
  onGone?: (ty: number, by: string, x: number, y: number, z: number) => void;

  // --- host-side spawning ---
  private spawnAt(ty: number, x: number, z: number): Npc {
    const id = this.nextId++;
    const y = this.world.voxels.surfaceBelow(x, z, 60);
    const npc = this.makeNpc(id, ty, x, y, z, Math.random() * Math.PI * 2);
    this.npcs.set(id, npc);
    return npc;
  }
  private makeNpc(id: number, ty: number, x: number, y: number, z: number, yaw: number): Npc {
    let model: BullModel | BearModel;
    if (ty === NPC_BEAR) {
      model = new BearModel(this.scene);
    } else {
      const bm = new BullModel(this.scene, false);
      if (ty === NPC_GOLDEN) bm.setCoatHex(0xd6a129, 0x8a5c00);
      else bm.setCoatHex(0x4c3a26);
      bm.setName("");
      model = bm;
    }
    model.setVisible(true);
    return {
      id,
      ty,
      x,
      y,
      z,
      yaw,
      state: 0,
      wanderT: 0,
      swipeT: 0,
      model,
      pos: new THREE.Vector3(x, y, z),
      target: new THREE.Vector3(x, y, z),
      dustT: 0,
    };
  }

  // seed the ambient wild herd on the plains (host only; safe to call again)
  hostSeedWild() {
    if (!this.net.isHost) return;
    const a = sectorAngle(BIO_PLAINS);
    for (let i = this.count(NPC_WILD); i < WILD_HERD; i++) {
      const r = 90 + Math.random() * 240;
      const ang = a + (Math.random() - 0.5) * 0.9;
      this.spawnAt(NPC_WILD, Math.cos(ang) * r, Math.sin(ang) * r);
    }
  }
  // bear invasion: spawn n bears around the zone edge (host only)
  hostSpawnBears(n: number, cx: number, cz: number, r: number) {
    if (!this.net.isHost) return;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      this.spawnAt(NPC_BEAR, cx + Math.cos(a) * r, cz + Math.sin(a) * r);
    }
  }
  // golden herd: rare fast bulls scattered mid-ring (host only)
  hostSpawnGolden(n: number) {
    if (!this.net.isHost) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 120 + Math.random() * 200;
      this.spawnAt(NPC_GOLDEN, Math.cos(a) * r, Math.sin(a) * r);
    }
  }
  // end-of-event cleanup (host only): remove all of a type
  hostClearType(ty: number) {
    if (!this.net.isHost) return;
    for (const [id, p] of this.npcs) {
      if (p.ty === ty) {
        this.removeModel(p);
        this.npcs.delete(id);
      }
    }
  }

  // a local (or relayed) ram on an npc. host resolves; non-host asks the host.
  ramNpc(id: number, power: number) {
    if (this.net.isHost) this.resolveHit(id, this.net.id, power);
    else this.net.sendNpcHit(id, power);
  }
  private resolveHit(id: number, by: string, _pw: number) {
    const p = this.npcs.get(id);
    if (!p) return; // already claimed - first come wins
    this.net.sendNpcGone(id, by, p.pos.x, p.pos.y, p.pos.z, p.ty);
    this.applyGone(id, by, p.pos.x, p.pos.y, p.pos.z, p.ty);
  }
  private applyGone(id: number, by: string, x: number, y: number, z: number, ty: number) {
    const p = this.npcs.get(id);
    if (p) {
      this.removeModel(p);
      this.npcs.delete(id);
    }
    this.onGone?.(ty, by, x, y, z);
  }
  private removeModel(p: Npc) {
    this.scene.remove(p.model.group);
  }

  // --- non-host: apply a full host snapshot ---
  private applyRows(rows: NpcRow[]) {
    if (this.net.isHost) return;
    const seen = new Set<number>();
    for (const [id, ty, x, y, z, yaw, st] of rows) {
      seen.add(id);
      let p = this.npcs.get(id);
      if (!p) {
        p = this.makeNpc(id, ty, x, y, z, yaw);
        this.npcs.set(id, p);
      }
      p.target.set(x, y, z);
      p.yaw = yaw;
      p.state = st;
      if (id >= this.nextId) this.nextId = id + 1; // stay unique across a host handoff
    }
    for (const [id, p] of this.npcs) {
      if (!seen.has(id)) {
        this.removeModel(p);
        this.npcs.delete(id);
      }
    }
  }

  update(dt: number, now: number) {
    if (this.net.isHost) this.hostSim(dt, now);

    // render every npc (host renders its sim, others interpolate rows)
    const k = 1 - Math.exp(-dt / 0.1);
    for (const p of this.npcs.values()) {
      if (this.net.isHost) {
        p.pos.set(p.x, p.y, p.z);
      } else {
        if (p.pos.distanceToSquared(p.target) > 144) p.pos.copy(p.target);
        else p.pos.lerp(p.target, k);
      }
      const speed = p.state === 1 ? SPEED[p.ty] : 0.3;
      if (p.model instanceof BullModel) p.model.update(dt, now, p.pos, p.yaw, speed, p.state === 1 ? "run" : "idle", 0);
      else p.model.update(dt, now, p.pos, p.yaw, speed);
      p.dustT -= dt;
      if (p.state === 1 && p.dustT <= 0) {
        p.dustT = 0.12;
        this.fx.hoofDust(p.pos.x, p.pos.y, p.pos.z, p.yaw, speed, p.ty === NPC_GOLDEN ? 1.1 : 0.7, p.ty === NPC_GOLDEN ? 0xd6a129 : 0x8a7a5e);
      }
    }
  }

  private hostSim(dt: number, now: number) {
    const players = this.getPlayers?.() ?? [];

    // top up the ambient herd every so often
    this.respawnT -= dt;
    if (this.respawnT <= 0) {
      this.respawnT = 20;
      this.hostSeedWild();
    }

    for (const p of this.npcs.values()) {
      // nearest player
      let best: { id: string; x: number; y: number; z: number; local: boolean } | null = null;
      let bestD = Infinity;
      for (const pl of players) {
        const d = Math.hypot(pl.x - p.x, pl.z - p.z);
        if (d < bestD) {
          bestD = d;
          best = pl;
        }
      }

      let wantYaw = p.yaw;
      p.state = 0;
      if (p.ty === NPC_BEAR) {
        if (best && bestD < 60) {
          // chase; face the prey
          wantYaw = Math.atan2(-(best.x - p.x), -(best.z - p.z));
          p.state = bestD > BEAR_SWIPE_R * 0.8 ? 1 : 0;
          // swipe when in range
          p.swipeT -= dt;
          if (bestD < BEAR_SWIPE_R && p.swipeT <= 0) {
            p.swipeT = 1.2;
            const dx = (best.x - p.x) / (bestD || 1);
            const dz = (best.z - p.z) / (bestD || 1);
            this.fx.impact(best.x, best.y, best.z, 0.3);
            if (best.local) this.onLocalShove?.(dx, dz, BEAR_SWIPE_KB, KB_UP * 0.7);
            else this.net.sendRam(best.id, dx, dz, BEAR_SWIPE_KB, KB_UP * 0.7, best.x, best.y, best.z, true);
          }
        } else {
          p.wanderT -= dt;
          if (p.wanderT <= 0) {
            p.wanderT = 2 + Math.random() * 3;
            wantYaw = Math.random() * Math.PI * 2;
          }
          p.state = 0;
        }
      } else {
        // wild + golden: graze, flee players
        if (best && bestD < FLEE_R[p.ty]) {
          wantYaw = Math.atan2(-(p.x - best.x), -(p.z - best.z)) + Math.PI; // directly away
          p.state = 1;
        } else {
          p.wanderT -= dt;
          if (p.wanderT <= 0) {
            p.wanderT = 2 + Math.random() * 4;
            p.yaw = Math.random() * Math.PI * 2;
            p.state = Math.random() < (p.ty === NPC_GOLDEN ? 0.6 : 0.25) ? 1 : 0;
          }
          wantYaw = p.yaw;
          if (p.state === 0 && p.ty === NPC_GOLDEN) p.state = 1; // golden bulls keep moving
        }
      }

      // turn + move with water avoidance
      const d = ((wantYaw - p.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      p.yaw += Math.max(-3 * dt, Math.min(3 * dt, d));
      if (p.state === 1 || p.ty !== NPC_BEAR) {
        const sp = (p.state === 1 ? SPEED[p.ty] : 1.2) * dt;
        const nx = p.x - Math.sin(p.yaw) * sp;
        const nz = p.z - Math.cos(p.yaw) * sp;
        const gi = Math.floor(nx + GRID / 2);
        const gj = Math.floor(nz + GRID / 2);
        const h = this.world.voxels.topAt(gi, gj);
        if (h > SEA && Math.abs(h - p.y) < 3.5) {
          p.x = nx;
          p.z = nz;
          p.y = this.world.voxels.surfaceBelow(p.x, p.z, p.y + 3);
        } else {
          p.yaw += Math.PI / 2 + Math.random(); // blocked/water: turn away
        }
      }
    }

    // broadcast snapshots
    this.syncT += dt;
    if (this.syncT >= 1 / NPC_SYNC_HZ) {
      this.syncT = 0;
      const rows: NpcRow[] = [];
      for (const p of this.npcs.values())
        rows.push([p.id, p.ty, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, Math.round(p.z * 10) / 10, Math.round(p.yaw * 100) / 100, p.state]);
      if (rows.length) this.net.sendNpcs(rows);
    }
    void now;
  }
}
