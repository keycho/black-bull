// black bull - the juice layer. one pooled instanced particle system for dust
// clouds, hoof kicks, impact bursts, debris, fire, sparks and lightning, plus
// telegraph rings (meteor/lightning warnings) and a trauma-based camera shake.
// two draw calls total for every particle in the game (matte + glow), fixed
// pools, zero allocation per frame.

import * as THREE from "three";

const MATTE_CAP = 1400;
const GLOW_CAP = 900;
const RING_CAP = 10;

interface P {
  active: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; t: number;
  size: number;
  grav: number; // gravity factor (dust floats, debris drops)
  drag: number;
}

class Pool {
  mesh: THREE.InstancedMesh;
  parts: P[] = [];
  private next = 0;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();

  constructor(scene: THREE.Scene, cap: number, glow: boolean) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = glow
      ? new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.9, depthWrite: false })
      : new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.dummy.position.set(0, -9999, 0);
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();
    for (let i = 0; i < cap; i++) {
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.parts.push({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, t: 0, size: 1, grav: 0, drag: 1 });
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh);
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, hex: number, grav: number, drag: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.parts.length;
    const p = this.parts[i];
    p.active = true;
    p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.life = life; p.t = 0;
    p.size = size;
    p.grav = grav;
    p.drag = drag;
    this.color.setHex(hex);
    this.mesh.setColorAt(i, this.color);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number) {
    let any = false;
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (!p.active) continue;
      any = true;
      p.t += dt;
      if (p.t >= p.life) {
        p.active = false;
        this.dummy.position.set(0, -9999, 0);
        this.dummy.scale.set(0, 0, 0);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        continue;
      }
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vz *= k;
      p.vy = p.vy * k - p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const u = p.t / p.life;
      const s = p.size * (u < 0.15 ? u / 0.15 : 1 - (u - 0.15) / 0.85); // pop in, shrink out
      this.dummy.position.set(p.x, p.y, p.z);
      this.dummy.rotation.set(p.t * 3 + i, p.t * 2, 0);
      this.dummy.scale.set(s, s, s);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// telegraph rings (meteor / lightning warnings) - a small mesh pool
interface Ring {
  mesh: THREE.Mesh;
  t: number;
  life: number;
  active: boolean;
}

export class Particles {
  private matte: Pool;
  private glow: Pool;
  private rings: Ring[] = [];

  constructor(scene: THREE.Scene) {
    this.matte = new Pool(scene, MATTE_CAP, false);
    this.glow = new Pool(scene, GLOW_CAP, true);
    for (let i = 0; i < RING_CAP; i++) {
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(0.82, 1, 28),
        new THREE.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.7, toneMapped: false, depthWrite: false, side: THREE.DoubleSide })
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      scene.add(mesh);
      this.rings.push({ mesh, t: 0, life: 1, active: false });
    }
  }

  // rolling dust kicked up behind hooves; scale rides with speed + momentum
  hoofDust(x: number, y: number, z: number, yaw: number, speed: number, scale = 1, hex = 0x8a7a5e) {
    const back = 1.2;
    const bx = x + Math.sin(yaw) * back;
    const bz = z + Math.cos(yaw) * back;
    const n = speed > 24 ? 3 : speed > 16 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      this.matte.spawn(
        bx + (Math.random() - 0.5) * 1.2,
        y + 0.15 + Math.random() * 0.3,
        bz + (Math.random() - 0.5) * 1.2,
        (Math.random() - 0.5) * 2 + Math.sin(yaw) * speed * 0.12,
        0.8 + Math.random() * 1.4,
        (Math.random() - 0.5) * 2 + Math.cos(yaw) * speed * 0.12,
        0.5 + Math.random() * 0.45,
        (0.28 + Math.random() * 0.3) * scale,
        hex,
        -1.2, // dust floats up a touch
        2.2
      );
    }
  }

  // charge wind-up dust building around the hooves
  chargeDust(x: number, y: number, z: number, charge01: number) {
    if (Math.random() > charge01 * 0.9 + 0.1) return;
    const a = Math.random() * Math.PI * 2;
    const r = 0.8 + Math.random() * 0.8;
    this.matte.spawn(
      x + Math.cos(a) * r, y + 0.1, z + Math.sin(a) * r,
      Math.cos(a) * 1.5, 0.6 + charge01 * 2, Math.sin(a) * 1.5,
      0.4 + charge01 * 0.4, 0.22 + charge01 * 0.3, 0x8a7a5e, -1.5, 2.5
    );
  }

  // the big one: an impact at a point - a dust donut + debris + sparks.
  // power 0..1 scales count, size and speed.
  impact(x: number, y: number, z: number, power: number, hex = 0x8a7a5e) {
    const n = Math.round(10 + power * 26);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const sp = 4 + power * 10 + Math.random() * 4;
      this.matte.spawn(
        x, y + 0.3, z,
        Math.cos(a) * sp, 1.5 + Math.random() * 3.5 * power, Math.sin(a) * sp,
        0.55 + Math.random() * 0.5, 0.3 + power * 0.5, hex, 2, 3.2
      );
    }
    const sparks = Math.round(4 + power * 10);
    for (let i = 0; i < sparks; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 6 + power * 14;
      this.glow.spawn(
        x, y + 0.6, z,
        Math.cos(a) * sp * Math.random(), 3 + Math.random() * 6, Math.sin(a) * sp * Math.random(),
        0.3 + Math.random() * 0.3, 0.12 + power * 0.16, 0xffd24a, 14, 2
      );
    }
  }

  // voxel debris (meteor craters, quake fissures, bridge collapse)
  debris(x: number, y: number, z: number, n: number, hex: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 3 + Math.random() * 9;
      this.matte.spawn(
        x + (Math.random() - 0.5), y + Math.random() * 1.2, z + (Math.random() - 0.5),
        Math.cos(a) * sp, 5 + Math.random() * 8, Math.sin(a) * sp,
        0.8 + Math.random() * 0.7, 0.3 + Math.random() * 0.35, hex, 16, 0.6
      );
    }
  }

  // a cosmetic trail puff behind a fast bull (trail id: 1 lightning, 2 fire)
  trail(x: number, y: number, z: number, kind: number) {
    const hex = kind === 1 ? 0x7fd9ff : 0xff7327;
    this.glow.spawn(
      x + (Math.random() - 0.5) * 0.8, y + 0.6 + Math.random() * 0.8, z + (Math.random() - 0.5) * 0.8,
      (Math.random() - 0.5) * 1.5, 0.5 + Math.random() * 1.5, (Math.random() - 0.5) * 1.5,
      0.35 + Math.random() * 0.25, 0.14 + Math.random() * 0.12, hex, kind === 2 ? -3 : 0, 2
    );
  }

  // meteor fire trail while a rock falls
  meteorTrail(x: number, y: number, z: number) {
    this.glow.spawn(
      x + (Math.random() - 0.5) * 1.2, y + Math.random() * 1.5, z + (Math.random() - 0.5) * 1.2,
      (Math.random() - 0.5) * 2, 1 + Math.random() * 2, (Math.random() - 0.5) * 2,
      0.4 + Math.random() * 0.3, 0.3 + Math.random() * 0.3, Math.random() < 0.5 ? 0xff7327 : 0xffb24a, -2, 1.5
    );
  }

  // a lightning bolt: a jagged column of glow blocks from the sky + ground sparks
  bolt(x: number, groundY: number, z: number) {
    let bx = x;
    let bz = z;
    for (let y = groundY + 32; y > groundY; y -= 1.6) {
      bx += (Math.random() - 0.5) * 1.1;
      bz += (Math.random() - 0.5) * 1.1;
      this.glow.spawn(bx, y, bz, 0, 0, 0, 0.22 + Math.random() * 0.12, 0.3 + Math.random() * 0.25, 0xcfe8ff, 0, 1);
    }
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 5 + Math.random() * 10;
      this.glow.spawn(x, groundY + 0.4, z, Math.cos(a) * sp, 2 + Math.random() * 7, Math.sin(a) * sp, 0.3, 0.14, 0x9fdcff, 12, 2);
    }
  }

  // golden sparkle burst (golden bull claims, unlocks)
  sparkle(x: number, y: number, z: number, n = 16) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 5;
      this.glow.spawn(x, y + 0.8, z, Math.cos(a) * sp, 2 + Math.random() * 5, Math.sin(a) * sp, 0.5 + Math.random() * 0.4, 0.14, 0xffd24a, 4, 1.6);
    }
  }

  // a telegraph ring on the ground that tightens as the strike approaches
  ring(x: number, y: number, z: number, radius: number, life: number, hex: number) {
    const r = this.rings.find((q) => !q.active) ?? this.rings[0];
    r.active = true;
    r.t = 0;
    r.life = life;
    r.mesh.visible = true;
    r.mesh.position.set(x, y + 0.15, z);
    r.mesh.scale.set(radius, radius, 1);
    (r.mesh.material as THREE.MeshBasicMaterial).color.setHex(hex);
  }

  update(dt: number) {
    this.matte.update(dt);
    this.glow.update(dt);
    for (const r of this.rings) {
      if (!r.active) continue;
      r.t += dt;
      if (r.t >= r.life) {
        r.active = false;
        r.mesh.visible = false;
        continue;
      }
      const u = r.t / r.life;
      const m = r.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = 0.75 * (1 - u * 0.4);
      const s = r.mesh.scale.x;
      r.mesh.scale.set(s * (1 - dt * 0.5), s * (1 - dt * 0.5), 1); // tighten toward the strike
      r.mesh.rotation.z += dt * 2;
    }
  }
}

// trauma-based camera shake: impacts add trauma, offset decays smoothly.
// applied as a post-offset to the camera each frame (never touches the rig).
export class Shake {
  private trauma = 0;
  private t = 0;

  add(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }
  // continuous rumble (earthquake) - call every frame with a floor level
  floor(level: number) {
    this.trauma = Math.max(this.trauma, Math.min(1, level));
  }

  // returns the world-space camera offset for this frame
  offset(dt: number, out: THREE.Vector3): THREE.Vector3 {
    this.t += dt * 34;
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const s = this.trauma * this.trauma; // square for a punchy-but-settling feel
    out.set(
      (Math.sin(this.t * 1.1) + Math.sin(this.t * 2.7) * 0.5) * 0.22 * s,
      (Math.sin(this.t * 1.7) + Math.sin(this.t * 3.1) * 0.5) * 0.18 * s,
      (Math.cos(this.t * 1.3) + Math.cos(this.t * 2.3) * 0.5) * 0.22 * s
    );
    return out;
  }
  get level(): number {
    return this.trauma;
  }
}
