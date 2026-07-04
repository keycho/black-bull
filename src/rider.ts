// black bull - the ON-FOOT controller. hop off your bull (press c) and run
// around: nimble, snappy, a big jump, and - the fun part - landing on ANY
// bull's back BOUNCES you skyward, so you can chain hops across a herd for
// huge air. reuses the engine's true-3d voxel collision (an AABB vs per-voxel
// solidity), so you can run up terrain, through canyons, over bridges. owns its
// own chase camera; main hands control between this and the bull controller.

import * as THREE from "three";
import { GRID, SEA, WORLD } from "./config";
import type { World } from "./world";

const R = 0.32; // half-width of the rider box
const H = 1.7; // feet to head
const RUN = 9.2; // top run speed (nimbler than a bull)
const ACCEL = 46; // ground accel toward the wish dir (snappy)
const AIR_ACCEL = 14;
const GRAVITY = 24;
const JUMP = 9.6;
const BOUNCE_UP = 14.5; // launch off a bull's back (well above a normal jump)
const STEP = 1.05;
const SENS = 0.0024;
const PITCH_MIN = -0.9;
const PITCH_MAX = 0.6;
const BOUND = WORLD / 2 - 1.5;
const CAM_DIST = 5.2;
const CAM_UP = 1.7;
const WATER_Y = SEA + 0.18;

export type FootPose = "idle" | "run" | "air" | "land" | "tumble";

// a bull back the rider can bounce off: world x,z + the y of its back (top)
export interface BounceHit {
  vy: number;
}

export class Rider {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  camYaw = 0;
  camPitch = -0.14;
  grounded = true;
  speed = 0;
  active = false;
  landedThisFrame = false;
  bouncedThisFrame = false;
  state: "run" | "tumble" = "run";

  // main wires these
  onBounce?: (x: number, y: number, z: number, power: number) => void;
  onLand?: (impact: number) => void;
  // returns a bounce if the rider is descending onto a bull back near (x,z,feetY)
  bounceUnder?: (x: number, z: number, feetY: number) => BounceHit | null;
  private stateT = 0;

  private keys = new Set<string>();
  private world: World;
  private camera: THREE.PerspectiveCamera;
  private camPos = new THREE.Vector3();
  private camInit = false;
  private inputOn = () => true;

  constructor(world: World, camera: THREE.PerspectiveCamera) {
    this.world = world;
    this.camera = camera;
    window.addEventListener("keydown", (e) => {
      if (!this.active) return;
      this.keys.add(e.code);
      if (e.code === "Space") e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("mousemove", (e) => {
      if (!this.active || !document.pointerLockElement) return;
      this.camYaw -= e.movementX * SENS;
      this.camPitch -= e.movementY * SENS;
      this.camPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.camPitch));
    });
  }

  setInputGate(fn: () => boolean) {
    this.inputOn = fn;
  }

  // main calls this to hand control over (on dismount); syncs the camera line
  activate(x: number, z: number, yaw: number, camYaw: number) {
    this.active = true;
    this.pos.set(x, this.world.voxels.surfaceBelow(x, z, 60) + 0.1, z);
    this.vel.set(0, 6, 0); // a little hop as you leap off
    this.yaw = yaw;
    this.camYaw = camYaw;
    this.state = "run";
    this.stateT = 0;
    this.camInit = false;
    this.keys.clear();
  }
  deactivate() {
    this.active = false;
    this.keys.clear();
  }

  pose(): FootPose {
    if (this.state === "tumble") return "tumble";
    if (!this.grounded) return "air";
    return this.speed > 0.6 ? "run" : "idle";
  }

  // got rammed on foot: a tumble + knockback
  knock(dx: number, dz: number, kb: number, up: number) {
    this.vel.x = dx * kb;
    this.vel.z = dz * kb;
    this.vel.y = Math.max(this.vel.y, up);
    this.grounded = false;
    this.state = "tumble";
    this.stateT = 1.1;
  }

  private cell(w: number): number {
    return Math.floor(w + GRID / 2);
  }
  private clamp(v: number): number {
    return Math.max(-BOUND, Math.min(BOUND, v));
  }
  private collides(x: number, feet: number, z: number): boolean {
    const vox = this.world.voxels;
    const x0 = this.cell(x - R), x1 = this.cell(x + R);
    const z0 = this.cell(z - R), z1 = this.cell(z + R);
    const y0 = Math.floor(feet + 0.02), y1 = Math.floor(feet + H - 0.02);
    for (let cy = y0; cy <= y1; cy++)
      for (let cx = x0; cx <= x1; cx++)
        for (let cz = z0; cz <= z1; cz++) if (vox.isSolid(cx, cy, cz)) return true;
    return false;
  }
  private footOn(x: number, feet: number, z: number): boolean {
    const vox = this.world.voxels;
    const x0 = this.cell(x - R), x1 = this.cell(x + R);
    const z0 = this.cell(z - R), z1 = this.cell(z + R);
    const cy = Math.floor(feet - 0.08);
    for (let cx = x0; cx <= x1; cx++)
      for (let cz = z0; cz <= z1; cz++) if (vox.isSolid(cx, cy, cz)) return true;
    return false;
  }
  private floorUnder(x: number, z: number, fromY: number): number {
    const vox = this.world.voxels;
    const x0 = this.cell(x - R), x1 = this.cell(x + R);
    const z0 = this.cell(z - R), z1 = this.cell(z + R);
    for (let cy = Math.floor(fromY + 0.02); cy >= 0; cy--)
      for (let cx = x0; cx <= x1; cx++)
        for (let cz = z0; cz <= z1; cz++) if (vox.isSolid(cx, cy, cz)) return cy + 1;
    return 0;
  }
  private moveAxis(amount: number, isX: boolean) {
    if (amount === 0) return;
    const tx = this.clamp(isX ? this.pos.x + amount : this.pos.x);
    const tz = this.clamp(isX ? this.pos.z : this.pos.z + amount);
    if (!this.collides(tx, this.pos.y, tz)) {
      this.pos.x = tx;
      this.pos.z = tz;
      return;
    }
    const up = this.pos.y + STEP;
    if (!this.collides(tx, up, tz) && !this.collides(this.pos.x, up, this.pos.z)) {
      this.pos.x = tx;
      this.pos.z = tz;
      this.pos.y = this.floorUnder(this.pos.x, this.pos.z, up + 0.5);
    }
  }

  update(dt: number) {
    if (!this.active) return;
    dt = Math.min(dt, 0.05);
    this.landedThisFrame = false;
    this.bouncedThisFrame = false;
    // movement works with or without pointer lock (mirrors the bull's fallback);
    // mouse-look is the only thing that needs the lock, gated in the mousemove
    // handler. so a denied lock leaves you keyboard-mobile, never frozen.
    const allow = this.inputOn();

    if (this.stateT > 0) {
      this.stateT -= dt;
      if (this.stateT <= 0) this.state = "run";
    }
    const controllable = this.state === "run";

    // wish direction (camera-relative)
    const fwd = allow && controllable ? (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0) : 0;
    const str = allow && controllable ? (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0) : 0;
    let wishX = -Math.sin(this.camYaw) * fwd + Math.cos(this.camYaw) * str;
    let wishZ = -Math.cos(this.camYaw) * fwd - Math.sin(this.camYaw) * str;
    const wl = Math.hypot(wishX, wishZ);
    if (wl > 0) {
      wishX /= wl;
      wishZ /= wl;
      this.yaw = Math.atan2(-wishX, -wishZ); // face the run direction
    }
    // accelerate horizontal velocity toward wish*RUN
    const accel = (this.grounded ? ACCEL : AIR_ACCEL) * dt;
    const tgtX = wishX * RUN;
    const tgtZ = wishZ * RUN;
    this.vel.x += Math.max(-accel, Math.min(accel, tgtX - this.vel.x));
    this.vel.z += Math.max(-accel, Math.min(accel, tgtZ - this.vel.z));
    if (wl === 0 && this.grounded) {
      // friction to a stop
      const f = Math.exp(-12 * dt);
      this.vel.x *= f;
      this.vel.z *= f;
    }

    this.moveAxis(this.vel.x * dt, true);
    this.moveAxis(this.vel.z * dt, false);

    // vertical: gravity, bounce off bull backs, ground, jump
    const onGround = this.vel.y <= 0 && this.footOn(this.pos.x, this.pos.y, this.pos.z);
    if (onGround) {
      const impact = -this.vel.y;
      this.pos.y = this.floorUnder(this.pos.x, this.pos.z, this.pos.y + 0.1);
      this.vel.y = 0;
      this.grounded = true;
      if (impact > 4) {
        this.landedThisFrame = true;
        this.onLand?.(impact);
      }
      if (allow && controllable && this.keys.has("Space")) {
        this.vel.y = JUMP;
        this.grounded = false;
      }
    } else {
      this.grounded = false;
      this.vel.y -= GRAVITY * dt;
      const ny = this.pos.y + this.vel.y * dt;
      // bounce: descending onto a bull's back near our feet -> launch up
      if (this.vel.y <= 0) {
        const b = this.bounceUnder?.(this.pos.x, this.pos.z, this.pos.y);
        if (b) {
          this.vel.y = b.vy;
          this.grounded = false;
          this.bouncedThisFrame = true;
          this.onBounce?.(this.pos.x, this.pos.y, this.pos.z, b.vy / BOUNCE_UP);
        } else {
          const fl = this.floorUnder(this.pos.x, this.pos.z, this.pos.y + 0.1);
          if (ny <= fl) {
            this.landedThisFrame = -this.vel.y > 4;
            this.pos.y = fl;
            this.vel.y = 0;
            this.grounded = true;
            if (-this.vel.y > 4) this.onLand?.(-this.vel.y);
          } else {
            this.pos.y = ny;
          }
        }
      } else if (this.collides(this.pos.x, ny, this.pos.z)) {
        this.vel.y = 0; // head-block
      } else {
        this.pos.y = ny;
      }
    }

    // water underfoot: shove you out (no swimming on foot either)
    if (this.pos.y < WATER_Y - 0.3) {
      const under = this.world.voxels.surfaceBelow(this.pos.x, this.pos.z, this.pos.y + 0.5);
      if (under <= SEA) {
        // gentle respawn onto the nearest shore height
        this.pos.y = Math.max(this.pos.y, WATER_Y);
        this.vel.y = 4;
      }
    }

    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.syncCamera(dt);
  }

  bounceUp(): number {
    return BOUNCE_UP;
  }

  private camClampDist(fx: number, fy: number, fz: number, dx: number, dy: number, dz: number, want: number): number {
    const vox = this.world.voxels;
    for (let d = 0.4; d <= want; d += 0.3) {
      if (vox.solidAtWorld(fx + dx * d, fy + dy * d, fz + dz * d)) return Math.max(1.0, d - 0.35);
    }
    return want;
  }
  private syncCamera(dt: number) {
    const fx = this.pos.x;
    const fy = this.pos.y + CAM_UP;
    const fz = this.pos.z;
    const cp = Math.cos(this.camPitch);
    const bx = Math.sin(this.camYaw) * cp;
    const by = -Math.sin(this.camPitch);
    const bz = Math.cos(this.camYaw) * cp;
    const dist = this.camClampDist(fx, fy, fz, bx, by, bz, CAM_DIST);
    const tx = fx + bx * dist;
    const ty = Math.max(fy + by * dist, this.world.voxels.surfaceBelow(fx + bx * dist, fz + bz * dist, 60) + 0.5);
    const tz = fz + bz * dist;
    if (this.camInit && dt > 0) this.camPos.lerp(new THREE.Vector3(tx, ty, tz), 1 - Math.exp(-dt / 0.05));
    else {
      this.camPos.set(tx, ty, tz);
      this.camInit = true;
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(fx, fy + 0.1, fz);
  }
}
