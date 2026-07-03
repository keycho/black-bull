// black bull - the local bull controller. heavy, fast, satisfying: velocity is
// king. thrust is applied along the bull's FACING while lateral grip falls off
// with speed, so hard turns become slides and drifts. holding left mouse winds
// up a charge (slower, head down, dust building); releasing launches the bull
// forward - dash at a tap, devastating stampede at full wind-up. missing a
// heavy charge leaves you briefly winded (vulnerable). walls bounce you at ram
// speed. water and lava are wipeouts. collision is the engine's true-3d voxel
// test (an AABB vs per-voxel solidity), so canyons, bridges and arena walls
// all play exactly as they read.
//
// the controller owns the chase camera (orbit + speed pull-back + terrain
// clamp). impact resolution against other bulls lives in main.ts - this class
// exposes applyKnockback / wipeout / respawn for it.

import * as THREE from "three";
import {
  ACCEL,
  BOUNCE,
  BOUNCE_MIN_SPEED,
  BULL_H,
  BULL_R,
  CHARGE_COOLDOWN,
  CHARGE_SLOW,
  CHARGE_TIME,
  DASH_SPEED,
  DRAG_GROUND,
  GALLOP,
  GRAVITY,
  GRID,
  JUMP,
  KB_MAX,
  LAT_GRIP_HIGH,
  LAT_GRIP_LOW,
  LAUNCH_DRAG,
  LAUNCH_STEER,
  LAVA_TIME,
  RAM_SPEED_MIN,
  SEA,
  STAGGER_TIME,
  STAMPEDE_SPEED,
  STEP,
  TUMBLE_KB,
  TUMBLE_TIME,
  TURN_RATE,
  TURN_RATE_FAST,
  WINDED_MIN_CHARGE,
  WINDED_SLOW,
  WINDED_TIME,
  WIPEOUT_TIME,
  WORLD,
} from "./config";
import type { BullPose } from "./bullmodel";
import type { World } from "./world";

const SENS = 0.0022;
const PITCH_MIN = -0.9;
const PITCH_MAX = 0.55;
const BOUND = WORLD / 2 - 1.5;
const CAM_DIST = 7.4; // base chase distance
const CAM_DIST_SPEED = 0.14; // + per unit of speed
const CAM_UP = 2.5; // focus height above the hooves
const WATER_Y = SEA + 0.18;

function lerpAngle(a: number, b: number, t: number): number {
  const d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + d * t;
}
function angDiff(a: number, b: number): number {
  return ((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

export type BullState = "run" | "charging" | "launched" | "stagger" | "tumble" | "winded" | "ko";

export class Bull {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3(); // full 3d velocity
  yaw = 0; // body facing
  camYaw = 0;
  camPitch = -0.16;
  state: BullState = "run";
  charge01 = 0;
  grounded = true;
  locked = false;
  // outside systems read these
  speed = 0; // horizontal units/s
  launchCharge = 0; // the charge the current launch was released at
  hitSomething = false; // set by main when the current launch lands
  landImpact = 0;
  // move-speed multipliers pushed in from outside (momentum perk, stampede event)
  perkSpeed = 1;
  eventSpeed = 1;
  // fired by the physics; main wires fx + net to these
  onLaunch?: (charge: number) => void;
  onWhiff?: () => void;
  onWallSlam?: (speed: number) => void;
  onLandHard?: (impact: number) => void;
  onHazard?: (kind: "water" | "lava") => void;

  private keys = new Set<string>();
  private mouseDown = false;
  private stateT = 0; // time left in a timed state (stagger/tumble/winded/ko)
  private cooldownT = 0;
  private lavaT = 0;
  private world: World;
  private camera: THREE.PerspectiveCamera;
  private camPos = new THREE.Vector3();
  private tpTarget = new THREE.Vector3();
  private camInit = false;
  private inputOn = () => true; // gate (chat open, cinematic, menus)

  constructor(world: World, camera: THREE.PerspectiveCamera, spawnX: number, spawnZ: number, yaw = 0) {
    this.world = world;
    this.camera = camera;
    this.yaw = yaw;
    this.camYaw = yaw;
    this.pos.set(spawnX, world.voxels.surfaceBelow(spawnX, spawnZ, 60), spawnZ);
    this.syncCamera(0);

    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.code === "Space") e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    document.addEventListener("pointerlockchange", () => {
      this.locked = !!document.pointerLockElement;
      if (!this.locked) {
        this.keys.clear();
        this.mouseDown = false;
      }
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.camYaw -= e.movementX * SENS;
      this.camPitch -= e.movementY * SENS;
      this.camPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.camPitch));
    });
    window.addEventListener("mousedown", (e) => {
      if (e.button === 0 && this.locked) this.mouseDown = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseDown = false;
    });
  }

  requestLock() {
    document.body.requestPointerLock();
  }
  setInputGate(fn: () => boolean) {
    this.inputOn = fn;
  }

  // the pose the model should show this frame
  pose(): BullPose {
    switch (this.state) {
      case "charging":
        return "charge";
      case "launched":
        return "launch";
      case "stagger":
        return "stagger";
      case "tumble":
        return "tumble";
      case "winded":
        return "winded";
      case "ko":
        return "ko";
      default:
        return this.speed > 0.7 ? "run" : "idle";
    }
  }

  get canBeHit(): boolean {
    return this.state !== "ko";
  }
  get isLive(): boolean {
    return this.state !== "ko";
  }
  // a live ram right now? (launched or simply moving over ram speed)
  get ramming(): boolean {
    return this.state !== "ko" && this.speed >= RAM_SPEED_MIN;
  }

  // --- collision helpers (bull AABB vs per-voxel solidity) ---
  private clamp(v: number): number {
    return Math.max(-BOUND, Math.min(BOUND, v));
  }
  private cell(w: number): number {
    return Math.floor(w + GRID / 2);
  }
  private collides(x: number, feet: number, z: number): boolean {
    const vox = this.world.voxels;
    const x0 = this.cell(x - BULL_R);
    const x1 = this.cell(x + BULL_R);
    const z0 = this.cell(z - BULL_R);
    const z1 = this.cell(z + BULL_R);
    const y0 = Math.floor(feet + 0.02);
    const y1 = Math.floor(feet + BULL_H - 0.02);
    for (let cy = y0; cy <= y1; cy++)
      for (let cx = x0; cx <= x1; cx++)
        for (let cz = z0; cz <= z1; cz++) if (vox.isSolid(cx, cy, cz)) return true;
    return false;
  }
  private footOn(x: number, feet: number, z: number): boolean {
    const vox = this.world.voxels;
    const x0 = this.cell(x - BULL_R);
    const x1 = this.cell(x + BULL_R);
    const z0 = this.cell(z - BULL_R);
    const z1 = this.cell(z + BULL_R);
    const cy = Math.floor(feet - 0.08);
    for (let cx = x0; cx <= x1; cx++)
      for (let cz = z0; cz <= z1; cz++) if (vox.isSolid(cx, cy, cz)) return true;
    return false;
  }
  private floorUnder(x: number, z: number, fromY: number): number {
    const vox = this.world.voxels;
    const x0 = this.cell(x - BULL_R);
    const x1 = this.cell(x + BULL_R);
    const z0 = this.cell(z - BULL_R);
    const z1 = this.cell(z + BULL_R);
    for (let cy = Math.floor(fromY + 0.02); cy >= 0; cy--)
      for (let cx = x0; cx <= x1; cx++)
        for (let cz = z0; cz <= z1; cz++) if (vox.isSolid(cx, cy, cz)) return cy + 1;
    return 0;
  }

  // move along one axis with auto step-up; returns true if blocked (no step possible)
  private moveAxis(amount: number, isX: boolean): boolean {
    if (amount === 0) return false;
    const tx = this.clamp(isX ? this.pos.x + amount : this.pos.x);
    const tz = this.clamp(isX ? this.pos.z : this.pos.z + amount);
    if (!this.collides(tx, this.pos.y, tz)) {
      this.pos.x = tx;
      this.pos.z = tz;
      return false;
    }
    // auto step-up over a low ledge
    const up = this.pos.y + STEP;
    if (!this.collides(tx, up, tz) && !this.collides(this.pos.x, up, this.pos.z)) {
      this.pos.x = tx;
      this.pos.z = tz;
      this.pos.y = this.floorUnder(this.pos.x, this.pos.z, up + 0.5);
      return false;
    }
    return true;
  }

  // --- reactions (called by main's impact resolution) ---

  // shove this bull: dir (dx,dz) normalized, kb horizontal speed, up vertical pop
  applyKnockback(dx: number, dz: number, kb: number, up: number) {
    if (this.state === "ko") return;
    kb = Math.min(KB_MAX, kb);
    this.vel.x = dx * kb;
    this.vel.z = dz * kb;
    this.vel.y = Math.max(this.vel.y, up);
    this.grounded = false;
    this.charge01 = 0;
    this.mouseDown = false;
    if (kb >= TUMBLE_KB) {
      this.state = "tumble";
      this.stateT = TUMBLE_TIME;
    } else {
      this.state = "stagger";
      this.stateT = STAGGER_TIME;
    }
  }

  // you got wiped out (water, lava, or a finishing hit); main handles the rest
  wipeout() {
    if (this.state === "ko") return;
    this.state = "ko";
    this.stateT = WIPEOUT_TIME;
    this.vel.set(0, 0, 0);
    this.charge01 = 0;
    this.lavaT = 0;
  }
  get koTimeLeft(): number {
    return this.state === "ko" ? this.stateT : 0;
  }

  respawn(x: number, z: number, yaw = 0) {
    this.pos.set(x, this.world.voxels.surfaceBelow(x, z, 60), z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.camYaw = yaw;
    this.state = "run";
    this.stateT = 0;
    this.charge01 = 0;
    this.lavaT = 0;
    this.camInit = false;
  }

  // the current launch landed: keep a chunk of speed, exit the launch cleanly
  confirmedHit(selfSlow: number) {
    this.hitSomething = true;
    this.vel.x *= selfSlow;
    this.vel.z *= selfSlow;
  }

  update(dt: number) {
    dt = Math.min(dt, 0.05);
    this.landImpact = 0;
    const allow = this.inputOn() && this.locked;

    // timed states tick down
    if (this.stateT > 0) {
      this.stateT -= dt;
      if (this.stateT <= 0) {
        if (this.state === "ko") {
          // main respawns us on ko end (watching koTimeLeft); hold at 0
          this.stateT = 0;
        } else {
          this.state = "run";
          this.stateT = 0;
        }
      }
    }
    if (this.cooldownT > 0) this.cooldownT -= dt;

    const controllable = this.state === "run" || this.state === "charging" || this.state === "winded";

    // --- charge wind-up / release ---
    if (allow && controllable && this.state !== "winded" && this.mouseDown && this.cooldownT <= 0) {
      if (this.state !== "charging") {
        this.state = "charging";
        this.charge01 = 0;
      }
      this.charge01 = Math.min(1, this.charge01 + dt / CHARGE_TIME);
    } else if (this.state === "charging") {
      // released (or lost lock): LAUNCH
      const c = this.charge01;
      const sp = (DASH_SPEED + (STAMPEDE_SPEED - DASH_SPEED) * Math.pow(c, 1.15)) * this.perkSpeed * this.eventSpeed;
      const fx = -Math.sin(this.yaw);
      const fz = -Math.cos(this.yaw);
      this.vel.x = fx * sp;
      this.vel.z = fz * sp;
      this.state = "launched";
      this.launchCharge = c;
      this.hitSomething = false;
      this.charge01 = 0;
      this.cooldownT = CHARGE_COOLDOWN;
      this.onLaunch?.(c);
    }

    // --- steering + thrust ---
    const fwdKey = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
    const strKey = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
    const hasInput = allow && controllable && (fwdKey !== 0 || strKey !== 0);

    this.speed = Math.hypot(this.vel.x, this.vel.z);
    const speedFrac = Math.min(1, this.speed / (GALLOP * 1.4));

    if (this.state === "charging") {
      // aiming: the body swings to the camera line while the wind-up builds
      this.yaw = lerpAngle(this.yaw, this.camYaw, 1 - Math.exp(-dt * 7));
    } else if (this.state === "launched") {
      // limited steering authority mid-launch (drift the stampede)
      if (allow && strKey !== 0) this.yaw -= strKey * TURN_RATE_FAST * LAUNCH_STEER * dt;
      // velocity follows the nose slightly so drifts carve
      const va = Math.atan2(-this.vel.x, -this.vel.z);
      const na = lerpAngle(va, this.yaw, 1 - Math.exp(-dt * 2.4));
      this.vel.x = -Math.sin(na) * this.speed;
      this.vel.z = -Math.cos(na) * this.speed;
    } else if (hasInput) {
      // build the wish direction in world space (camera-relative), take its angle
      const dirX = -Math.sin(this.camYaw) * fwdKey + Math.cos(this.camYaw) * strKey;
      const dirZ = -Math.cos(this.camYaw) * fwdKey - Math.sin(this.camYaw) * strKey;
      const wish = Math.atan2(-dirX, -dirZ);
      const rate = TURN_RATE + (TURN_RATE_FAST - TURN_RATE) * speedFrac;
      const d = angDiff(wish, this.yaw);
      this.yaw += Math.max(-rate * dt, Math.min(rate * dt, d));
    }

    // thrust along the facing (heavy: you push the bull, the bull pushes the world)
    const maxSp =
      GALLOP *
      this.perkSpeed *
      this.eventSpeed *
      (this.state === "charging" ? CHARGE_SLOW : 1) *
      (this.state === "winded" ? WINDED_SLOW : 1);
    if (hasInput && this.state !== "launched") {
      const fx = -Math.sin(this.yaw);
      const fz = -Math.cos(this.yaw);
      const fwdSpeed = this.vel.x * fx + this.vel.z * fz;
      if (fwdSpeed < maxSp) {
        const boost = Math.min(ACCEL * dt, maxSp - fwdSpeed);
        this.vel.x += fx * boost;
        this.vel.z += fz * boost;
      }
    }

    // split velocity into forward/lateral around the body; grip bleeds lateral
    // slip slowly at speed (slides + drifts), quickly when slow (planted).
    {
      const fx = -Math.sin(this.yaw);
      const fz = -Math.cos(this.yaw);
      const rx = -fz;
      const rz = fx;
      let f = this.vel.x * fx + this.vel.z * fz;
      let l = this.vel.x * rx + this.vel.z * rz;
      const grip = this.state === "launched" ? LAT_GRIP_HIGH : LAT_GRIP_LOW + (LAT_GRIP_HIGH - LAT_GRIP_LOW) * speedFrac;
      l *= Math.exp(-grip * dt);
      const drag = this.state === "launched" ? LAUNCH_DRAG : hasInput ? 0.4 : DRAG_GROUND;
      f *= Math.exp(-drag * dt * (this.grounded ? 1 : 0.35));
      this.vel.x = fx * f + rx * l;
      this.vel.z = fz * f + rz * l;
    }

    // --- integrate horizontal with wall bounce ---
    const preX = this.vel.x;
    const preZ = this.vel.z;
    const blockedX = this.moveAxis(this.vel.x * dt, true);
    const blockedZ = this.moveAxis(this.vel.z * dt, false);
    if (blockedX || blockedZ) {
      const impactSpeed = Math.hypot(preX, preZ);
      if (impactSpeed >= BOUNCE_MIN_SPEED) {
        if (blockedX) this.vel.x = -preX * BOUNCE;
        if (blockedZ) this.vel.z = -preZ * BOUNCE;
        this.onWallSlam?.(impactSpeed);
        if (this.state === "launched") this.endLaunch(true); // a wall counts as "hit something"
      } else {
        if (blockedX) this.vel.x = 0;
        if (blockedZ) this.vel.z = 0;
      }
    }

    // --- vertical: gravity, ground, jump ---
    const onGround = this.vel.y <= 0 && this.footOn(this.pos.x, this.pos.y, this.pos.z);
    if (onGround) {
      this.pos.y = this.floorUnder(this.pos.x, this.pos.z, this.pos.y + 0.1);
      this.vel.y = 0;
      this.grounded = true;
      if (allow && controllable && this.keys.has("Space")) {
        this.vel.y = JUMP;
        this.grounded = false;
      }
    } else {
      this.grounded = false;
      this.vel.y -= GRAVITY * dt;
      const ny = this.pos.y + this.vel.y * dt;
      if (this.vel.y <= 0) {
        const fl = this.floorUnder(this.pos.x, this.pos.z, this.pos.y + 0.1);
        if (ny <= fl) {
          this.landImpact = -this.vel.y;
          this.pos.y = fl;
          this.vel.y = 0;
          this.grounded = true;
          if (this.landImpact > 16) this.onLandHard?.(this.landImpact);
        } else {
          this.pos.y = ny;
        }
      } else if (this.collides(this.pos.x, ny, this.pos.z)) {
        this.vel.y = 0; // head-block
      } else {
        this.pos.y = ny;
      }
    }

    // --- launch end / whiff ---
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    if (this.state === "launched" && this.speed < RAM_SPEED_MIN) this.endLaunch(this.hitSomething);

    // --- hazards ---
    if (this.state !== "ko") {
      // water: bulls do not swim
      const under = this.world.voxels.surfaceBelow(this.pos.x, this.pos.z, this.pos.y + 0.5);
      if (this.pos.y < WATER_Y - 0.25 && under <= SEA) {
        this.onHazard?.("water");
      } else {
        // lava: standing on a lava block cooks quickly
        const vx = this.cell(this.pos.x);
        const vz = this.cell(this.pos.z);
        const ty = Math.floor(this.pos.y - 0.5);
        if (this.grounded && this.world.voxels.typeAt(vx, ty, vz) === 44) {
          this.lavaT += dt;
          if (this.lavaT > LAVA_TIME) this.onHazard?.("lava");
        } else {
          this.lavaT = Math.max(0, this.lavaT - dt * 2);
        }
      }
    }

    this.syncCamera(dt);
  }

  private endLaunch(hit: boolean) {
    if (this.state !== "launched") return;
    this.state = "run";
    if (!hit && this.launchCharge >= WINDED_MIN_CHARGE) {
      this.state = "winded";
      this.stateT = WINDED_TIME;
      this.onWhiff?.();
    }
  }

  // --- chase camera: orbit + speed pull-back + terrain clamp ---
  private camClampDist(fx: number, fy: number, fz: number, dx: number, dy: number, dz: number, want: number): number {
    const vox = this.world.voxels;
    for (let d = 0.4; d <= want; d += 0.3) {
      if (vox.solidAtWorld(fx + dx * d, fy + dy * d, fz + dz * d)) return Math.max(1.2, d - 0.4);
    }
    return want;
  }

  private syncCamera(dt: number) {
    const fx = this.pos.x;
    const fy = this.pos.y + CAM_UP;
    const fz = this.pos.z;
    // camera sits behind the orbit direction, slightly above
    const cp = Math.cos(this.camPitch);
    const bx = Math.sin(this.camYaw) * cp;
    const by = -Math.sin(this.camPitch);
    const bz = Math.cos(this.camYaw) * cp;
    const want = CAM_DIST + Math.min(4, this.speed * CAM_DIST_SPEED) + this.charge01 * -1.2;
    const dist = this.camClampDist(fx, fy, fz, bx, by, bz, want);
    this.tpTarget.set(fx + bx * dist, Math.max(fy + by * dist, this.world.voxels.surfaceBelow(fx + bx * dist, fz + bz * dist, 60) + 0.6), fz + bz * dist);
    if (this.camInit && dt > 0) {
      const k = 1 - Math.exp(-dt / 0.06);
      this.camPos.lerp(this.tpTarget, k);
    } else {
      this.camPos.copy(this.tpTarget);
      this.camInit = true;
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(fx, fy + 0.2, fz);
  }
}
