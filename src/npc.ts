// black bull - npcs: the ambient wild herd, the golden herd event bulls, the
// invading bears, and the WHITE BULLS - the hostile herd. HOST-AUTHORITATIVE:
// the host (lowest id present) runs every npc brain and broadcasts snapshots;
// everyone else renders + interpolates the same herd. ramming an npc is claimed
// through the host (first come wins), which broadcasts removals + credit.
//
// white bulls are the fight: they roam in packs, aggro on riders, telegraph a
// wind-up (head down, pawing) and then commit to a straight charge - dodge the
// line and counter-ram them in the recovery window. they take several rams to
// break; each hit staggers them back. their shoves are relayed to the victim
// as npc rams (no player credit).

import * as THREE from "three";
import { BullModel, type BullPose } from "./bullmodel";
import {
  BEAR_SWIPE_KB,
  BEAR_SWIPE_R,
  GREET_BEAR_LIFE,
  GREET_BEARS,
  GREET_R,
  GRID,
  KB_UP,
  NPC_SYNC_HZ,
  SEA,
  WHITE_AGGRO_R,
  WHITE_CHARGE_SPEED,
  WHITE_CHARGE_T,
  WHITE_COOLDOWN,
  WHITE_COUNT,
  WHITE_HP,
  WHITE_KB,
  WHITE_WINDUP,
  WILD_HERD,
} from "./config";
import type { Net, NpcRow } from "./net";
import type { Particles } from "./particles";
import { sectorAngle, BIO_PLAINS } from "./voxels";
import type { World } from "./world";

export const NPC_WILD = 0;
export const NPC_GOLDEN = 1;
export const NPC_BEAR = 2;
export const NPC_WHITE = 3;

const SPEED = [3.6, 9.5, 6.8, 7.2]; // run speed per type (white charge speed is its own)
const FLEE_R = [7, 16, 0, 0];

// npc wire states (rides the snapshot rows so every client animates the same)
const ST_AMBLE = 0;
const ST_RUN = 1;
const ST_WINDUP = 2;
const ST_CHARGING = 3;
const ST_STUNNED = 4;

interface Npc {
  id: number;
  ty: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  state: number;
  // host sim
  wanderT: number;
  swipeT: number;
  stateT: number; // windup / charge / stun timer
  cdT: number; // charge cooldown (the counter window)
  life: number; // seconds before despawn (0 = forever); ambush bears expire
  hp: number;
  cdx: number; // committed charge direction
  cdz: number;
  hitThisCharge: boolean;
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
  onLocalShove?: (dx: number, dz: number, kb: number, up: number) => void; // an npc hit the local player
  getPlayers?: () => { id: string; x: number; y: number; z: number; local: boolean }[];

  constructor(
    private scene: THREE.Scene,
    private world: World,
    private net: Net,
    private fx: Particles
  ) {
    this.net.onNpcs = (rows) => this.applyRows(rows);
    this.net.onNpcHit = (id, by, pw, dx, dz) => this.resolveHit(id, by, pw, dx, dz);
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
      else if (ty === NPC_WHITE) bm.setCoatHex(0xd8d2c8);
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
      state: ST_AMBLE,
      wanderT: 0,
      swipeT: 0,
      stateT: 0,
      cdT: 1 + Math.random() * 2,
      life: 0,
      hp: ty === NPC_WHITE ? WHITE_HP : 1,
      cdx: 0,
      cdz: 0,
      hitThisCharge: false,
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
  // seed the hostile white packs around the mid-ring (host only; tops up)
  hostSeedWhite() {
    if (!this.net.isHost) return;
    while (this.count(NPC_WHITE) < WHITE_COUNT) {
      const ang = Math.random() * Math.PI * 2;
      const r = 115 + Math.random() * 210;
      const cx = Math.cos(ang) * r;
      const cz = Math.sin(ang) * r;
      for (let i = 0; i < 3 && this.count(NPC_WHITE) < WHITE_COUNT; i++) {
        this.spawnAt(NPC_WHITE, cx + (Math.random() - 0.5) * 12, cz + (Math.random() - 0.5) * 12);
      }
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
  // the entry ambush: a tight ring of bears on a freshly-arrived rider. they
  // aggro immediately (chase range is well past the ring) and wander off if
  // ignored long enough.
  private spawnGreetingBears(x: number, z: number) {
    let placed = 0;
    for (let i = 0; i < GREET_BEARS * 6 && placed < GREET_BEARS; i++) {
      const a = i * 2.39996 + 0.6; // golden-angle scatter: every retry is a new spot
      const r = GREET_R + (i % 3) * 4;
      const bx = x + Math.cos(a) * r;
      const bz = z + Math.sin(a) * r;
      const gi = Math.floor(bx + GRID / 2);
      const gj = Math.floor(bz + GRID / 2);
      if (this.world.voxels.topAt(gi, gj) <= SEA) continue; // never in the water
      const bear = this.spawnAt(NPC_BEAR, bx, bz);
      bear.life = GREET_BEAR_LIFE;
      placed++;
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
  // dx/dz is the push direction (hitter -> npc) so hits stagger whites back.
  ramNpc(id: number, power: number, dx = 0, dz = 0) {
    if (this.net.isHost) this.resolveHit(id, this.net.id, power, dx, dz);
    else this.net.sendNpcHit(id, power, dx, dz);
  }
  private resolveHit(id: number, by: string, _pw: number, dx: number, dz: number) {
    const p = this.npcs.get(id);
    if (!p) return; // already claimed - first come wins
    if (p.ty === NPC_WHITE) {
      p.hp--;
      if (p.hp > 0) {
        // staggered back, briefly stunned - the counter window pays off
        p.state = ST_STUNNED;
        p.stateT = 0.9;
        p.cdT = Math.max(p.cdT, 1.4);
        p.x += dx * 3;
        p.z += dz * 3;
        p.y = this.world.voxels.surfaceBelow(p.x, p.z, p.y + 4);
        return;
      }
    }
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
    // clamp the sim step so a hitching frame never teleports npcs (a bear
    // taking one 3-second step scatters instead of chasing)
    dt = Math.min(dt, 0.08);
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
      if (p.model instanceof BullModel) {
        let pose: BullPose = "idle";
        let speed = 0.3;
        let charge = 0;
        switch (p.state) {
          case ST_RUN:
            pose = "run";
            speed = SPEED[p.ty];
            break;
          case ST_WINDUP:
            pose = "charge";
            charge = 0.85;
            break;
          case ST_CHARGING:
            pose = "launch";
            speed = WHITE_CHARGE_SPEED;
            break;
          case ST_STUNNED:
            pose = "stagger";
            break;
        }
        p.model.update(dt, now, p.pos, p.yaw, speed, pose, charge);
        p.dustT -= dt;
        if ((p.state === ST_RUN || p.state === ST_CHARGING) && p.dustT <= 0) {
          p.dustT = p.state === ST_CHARGING ? 0.06 : 0.12;
          const scale = p.state === ST_CHARGING ? 1.4 : p.ty === NPC_GOLDEN ? 1.1 : 0.7;
          const hex = p.ty === NPC_GOLDEN ? 0xd6a129 : p.ty === NPC_WHITE ? 0xcfc9bd : 0x8a7a5e;
          this.fx.hoofDust(p.pos.x, p.pos.y, p.pos.z, p.yaw, speed, scale, hex);
        }
        if (p.state === ST_WINDUP) this.fx.chargeDust(p.pos.x, p.pos.y, p.pos.z, 0.7);
      } else {
        p.model.update(dt, now, p.pos, p.yaw, p.state === ST_RUN ? SPEED[p.ty] : 0.3);
      }
    }
  }

  private greeted = new Set<string>();
  private wasHost = false;

  private hostSim(dt: number, now: number) {
    const players = this.getPlayers?.() ?? [];

    // on taking the host seat mid-session, adopt everyone already in the
    // world as greeted so a host handoff never re-ambushes the whole room
    if (!this.wasHost) {
      this.wasHost = true;
      for (const pl of players) this.greeted.add(pl.id);
    }
    // every NEW arrival gets the welcome party - bears, immediately
    for (const pl of players) {
      if (this.greeted.has(pl.id)) continue;
      this.greeted.add(pl.id);
      this.spawnGreetingBears(pl.x, pl.z);
    }

    // top up the ambient herds every so often
    this.respawnT -= dt;
    if (this.respawnT <= 0) {
      this.respawnT = 20;
      this.hostSeedWild();
      this.hostSeedWhite();
    }

    for (const p of this.npcs.values()) {
      // ignored ambush bears eventually wander off
      if (p.life > 0) {
        p.life -= dt;
        if (p.life <= 0) {
          this.removeModel(p);
          this.npcs.delete(p.id);
          continue;
        }
      }
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

      if (p.ty === NPC_WHITE) {
        this.simWhite(p, dt, best, bestD, players);
        continue;
      }

      let wantYaw = p.yaw;
      p.state = ST_AMBLE;
      if (p.ty === NPC_BEAR) {
        if (best && bestD < 60) {
          wantYaw = Math.atan2(-(best.x - p.x), -(best.z - p.z));
          p.state = bestD > BEAR_SWIPE_R * 0.8 ? ST_RUN : ST_AMBLE;
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
          p.state = ST_AMBLE;
        }
      } else {
        // wild + golden: graze, flee players
        if (best && bestD < FLEE_R[p.ty]) {
          wantYaw = Math.atan2(-(p.x - best.x), -(p.z - best.z)) + Math.PI; // directly away
          p.state = ST_RUN;
        } else {
          p.wanderT -= dt;
          if (p.wanderT <= 0) {
            p.wanderT = 2 + Math.random() * 4;
            p.yaw = Math.random() * Math.PI * 2;
            p.state = Math.random() < (p.ty === NPC_GOLDEN ? 0.6 : 0.25) ? ST_RUN : ST_AMBLE;
          }
          wantYaw = p.yaw;
          if (p.state === ST_AMBLE && p.ty === NPC_GOLDEN) p.state = ST_RUN; // golden bulls keep moving
        }
      }

      this.turnAndMove(p, wantYaw, p.state === ST_RUN ? SPEED[p.ty] : 1.2, dt);
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

  // the white bull brain: stalk -> windup (telegraph) -> committed charge ->
  // recover. the charge direction locks at commit, so sidestep + counter.
  private simWhite(
    p: Npc,
    dt: number,
    best: { id: string; x: number; y: number; z: number; local: boolean } | null,
    bestD: number,
    players: { id: string; x: number; y: number; z: number; local: boolean }[]
  ) {
    p.cdT -= dt;

    if (p.state === ST_STUNNED) {
      p.stateT -= dt;
      if (p.stateT <= 0) p.state = ST_AMBLE;
      return;
    }

    if (p.state === ST_CHARGING) {
      p.stateT -= dt;
      const step = WHITE_CHARGE_SPEED * dt;
      const nx = p.x + p.cdx * step;
      const nz = p.z + p.cdz * step;
      const gi = Math.floor(nx + GRID / 2);
      const gj = Math.floor(nz + GRID / 2);
      const h = this.world.voxels.topAt(gi, gj);
      if (h <= SEA || Math.abs(h - p.y) > 3.5 || p.stateT <= 0) {
        // ran out, hit a wall, or reached water: recover
        p.state = ST_AMBLE;
        p.cdT = WHITE_COOLDOWN;
        return;
      }
      p.x = nx;
      p.z = nz;
      p.y = this.world.voxels.surfaceBelow(p.x, p.z, p.y + 3);
      p.yaw = Math.atan2(-p.cdx, -p.cdz);
      // connect with any rider on the line
      if (!p.hitThisCharge) {
        for (const pl of players) {
          const d = Math.hypot(pl.x - p.x, pl.z - p.z);
          if (d < 2.3 && Math.abs(pl.y - p.y) < 2.4) {
            p.hitThisCharge = true;
            const dx = (pl.x - p.x) / (d || 1);
            const dz = (pl.z - p.z) / (d || 1);
            this.fx.impact(pl.x, pl.y + 0.8, pl.z, 0.7, 0xcfc9bd);
            if (pl.local) this.onLocalShove?.(dx, dz, WHITE_KB, KB_UP);
            else this.net.sendRam(pl.id, dx, dz, WHITE_KB, KB_UP, pl.x, pl.y + 0.8, pl.z, true);
            p.state = ST_AMBLE;
            p.cdT = WHITE_COOLDOWN;
            break;
          }
        }
      }
      return;
    }

    if (p.state === ST_WINDUP) {
      p.stateT -= dt;
      // track the target while winding up; the direction LOCKS at commit
      if (best) p.yaw = Math.atan2(-(best.x - p.x), -(best.z - p.z));
      if (p.stateT <= 0) {
        if (best && bestD < WHITE_AGGRO_R * 1.4) {
          const d = bestD || 1;
          p.cdx = (best.x - p.x) / d;
          p.cdz = (best.z - p.z) / d;
          p.state = ST_CHARGING;
          p.stateT = WHITE_CHARGE_T;
          p.hitThisCharge = false;
        } else {
          p.state = ST_AMBLE;
          p.cdT = WHITE_COOLDOWN * 0.5;
        }
      }
      return;
    }

    // stalking / roaming
    if (best && bestD < WHITE_AGGRO_R) {
      if (bestD < 16 && p.cdT <= 0) {
        p.state = ST_WINDUP;
        p.stateT = WHITE_WINDUP;
        return;
      }
      // close the distance
      const wantYaw = Math.atan2(-(best.x - p.x), -(best.z - p.z));
      p.state = ST_RUN;
      this.turnAndMove(p, wantYaw, SPEED[NPC_WHITE], dt);
    } else {
      p.wanderT -= dt;
      if (p.wanderT <= 0) {
        p.wanderT = 2 + Math.random() * 4;
        p.yaw = Math.random() * Math.PI * 2;
        p.state = Math.random() < 0.3 ? ST_RUN : ST_AMBLE;
      }
      this.turnAndMove(p, p.yaw, p.state === ST_RUN ? SPEED[NPC_WHITE] * 0.6 : 1.2, dt);
    }
  }

  // shared steering: turn toward wantYaw, walk forward, avoid water/cliffs
  private turnAndMove(p: Npc, wantYaw: number, speed: number, dt: number) {
    const d = ((wantYaw - p.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    p.yaw += Math.max(-3 * dt, Math.min(3 * dt, d));
    const sp = speed * dt;
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
