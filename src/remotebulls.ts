// black bull - renders every other rider as a bull, driven by the networked
// state. positions are interpolated (exponential smoothing toward the latest
// packet) so ~15 hz updates read as smooth galloping, poses map straight off
// the wire state code, and hoof dust + cosmetic trails are emitted locally so
// a distant stampede kicks up the same storm you do. models are created and
// removed as riders join and leave.

import * as THREE from "three";
import { BullModel, type BullPose } from "./bullmodel";
import { MOMENTUM_CAP, RAM_SPEED_MIN, TIERS } from "./config";
import type { Net, RemoteState } from "./net";
import type { Particles } from "./particles";

function lerpAngle(a: number, b: number, t: number): number {
  const d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + d * t;
}

const POSE_OF: BullPose[] = ["run", "charge", "launch", "stagger", "tumble", "winded", "ko"];

interface RB {
  model: BullModel;
  pos: THREE.Vector3;
  target: THREE.Vector3;
  yaw: number;
  targetYaw: number;
  name: string;
  cosKey: string;
  dustT: number;
}

export class RemoteBulls {
  private bulls = new Map<string, RB>();
  alphaId = ""; // set by main each frame (highest momentum in the herd)

  constructor(private scene: THREE.Scene, private net: Net, private fx: Particles) {}

  // world position of a remote bull (impact checks); null if unknown
  posOf(id: string): THREE.Vector3 | null {
    return this.bulls.get(id)?.pos ?? null;
  }

  update(dt: number, now: number) {
    const remotes = this.net.remotes;

    // spawn models for new riders + refresh targets/looks
    for (const [id, r] of remotes) {
      let b = this.bulls.get(id);
      if (!b) {
        const model = new BullModel(this.scene, true);
        model.setCosmetics(r.cos);
        model.setName(r.name);
        model.setVisible(r.inWorld);
        b = {
          model,
          pos: new THREE.Vector3(r.x, r.y, r.z),
          target: new THREE.Vector3(r.x, r.y, r.z),
          yaw: r.yaw,
          targetYaw: r.yaw,
          name: r.name,
          cosKey: cosKey(r),
          dustT: 0,
        };
        this.bulls.set(id, b);
      }
      b.target.set(r.x, r.y, r.z);
      b.targetYaw = r.yaw;
      b.model.setVisible(r.inWorld);
      const ck = cosKey(r);
      if (ck !== b.cosKey) {
        b.model.setCosmetics(r.cos);
        b.cosKey = ck;
      }
      if (r.name !== b.name) {
        b.model.setName(r.name);
        b.name = r.name;
      }
      // momentum tier -> horn glow; the alpha wears the floating crown
      b.model.setMomentumTier(tierOf(r.momentum));
      b.model.setAlpha(id === this.alphaId && r.inWorld);
    }

    // remove models for riders who left
    for (const [id, b] of this.bulls) {
      if (!remotes.has(id)) {
        this.scene.remove(b.model.group);
        this.bulls.delete(id);
      }
    }

    // interpolate position/yaw, derive speed, drive the animation + local fx
    const a = 1 - Math.exp(-dt / 0.08);
    for (const [id, b] of this.bulls) {
      const r = remotes.get(id);
      if (!r || !r.inWorld) continue;
      const px = b.pos.x;
      const pz = b.pos.z;
      if (b.pos.distanceToSquared(b.target) > 100) b.pos.copy(b.target); // snap teleports (respawns)
      else b.pos.lerp(b.target, a);
      b.yaw = lerpAngle(b.yaw, b.targetYaw, a);
      const speed = Math.hypot(b.pos.x - px, b.pos.z - pz) / Math.max(dt, 1e-4);
      const pose = POSE_OF[r.st] ?? "run";
      b.model.update(dt, now, b.pos, b.yaw, speed, pose === "run" && speed < 0.7 ? "idle" : pose, r.charge);

      // local fx for remote bulls: hoof dust at speed, trails, charge dust
      b.dustT -= dt;
      if (speed > 7 && b.dustT <= 0) {
        b.dustT = 0.07;
        const scale = 0.8 + (r.momentum / MOMENTUM_CAP) * 1.2;
        this.fx.hoofDust(b.pos.x, b.pos.y, b.pos.z, b.yaw, speed, scale);
        if (r.cos.trail > 0 && speed > RAM_SPEED_MIN) this.fx.trail(b.pos.x, b.pos.y, b.pos.z, r.cos.trail);
      }
      if (r.st === 1) this.fx.chargeDust(b.pos.x, b.pos.y, b.pos.z, r.charge);
    }
  }
}

function tierOf(m: number): number {
  let t = 0;
  for (let i = 0; i < TIERS.length; i++) if (m >= TIERS[i]) t = i;
  return t;
}

function cosKey(r: RemoteState): string {
  const c = r.cos;
  return `${c.coat}.${c.trim}.${c.horns}.${c.eyes}.${c.trail}.${c.hooves}.${c.armor}.${c.crown}.${c.rider}`;
}
