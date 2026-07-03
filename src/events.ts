// black bull - world events. every few minutes the HOST rolls a global event
// and broadcasts it; every client (host included) runs the same local show:
// banner + countdown, effects, danger zones. the host additionally drives the
// authoritative moving parts - meteor impact points, lightning strike targets,
// bear/golden spawns, quake fissures - and every terrain change flows through
// the synced (and persisted) edit pipeline, so the battlefield stays identical
// on every screen and late joiners load the same craters.
//
// events: stampede, meteor shower, bear invasion, king bull, lightning storm,
// golden herd, earthquake.

import * as THREE from "three";
import {
  BEARS_COUNT,
  BEARS_DUR,
  EVENT_EVERY,
  EVENT_WARN,
  GOLD_COUNT,
  GOLD_DUR,
  GRID,
  KB_UP,
  KING_DUR,
  METEOR_COUNT,
  METEOR_DUR,
  METEOR_ZONE_R,
  QUAKE_DUR,
  SEA,
  STAMPEDE_DUR,
  STORM_DUR,
  STORM_STRIKE_EVERY,
} from "./config";
import type { EventMsg, Net } from "./net";
import { NPC_BEAR, NPC_GOLDEN, type NpcManager } from "./npc";
import type { Particles, Shake } from "./particles";
import type { World } from "./world";

export type EventKind = "stampede" | "meteor" | "bears" | "king" | "storm" | "golden" | "quake";

const KINDS: EventKind[] = ["stampede", "meteor", "bears", "king", "storm", "golden", "quake"];
export const EVENT_TITLES: Record<EventKind, string> = {
  stampede: "stampede",
  meteor: "meteor shower",
  bears: "bear invasion",
  king: "king bull",
  storm: "lightning storm",
  golden: "golden herd",
  quake: "earthquake",
};
export const EVENT_SUBS: Record<EventKind, string> = {
  stampede: "everyone runs hot - charge everything",
  meteor: "falling rocks are reshaping the battlefield",
  bears: "bears are loose - ram them out",
  king: "one bull is marked - bring them down",
  storm: "strikes incoming - watch the rings",
  golden: "rare golden bulls are out - claim them",
  quake: "the ground is splitting - bridges are falling",
};

interface Meteor {
  x: number;
  z: number;
  r: number;
  t: number; // time until impact
  mesh: THREE.Mesh;
  groundY: number;
}
interface Strike {
  x: number;
  z: number;
  t: number;
  groundY: number;
}

interface Deps {
  net: Net;
  world: World;
  fx: Particles;
  shake: Shake;
  scene: THREE.Scene;
  npcs: NpcManager;
  localPos: () => THREE.Vector3;
  inWorldIds: () => string[]; // everyone currently playing (incl. local id)
  // local gameplay reactions
  knockLocal: (dx: number, dz: number, kb: number, up: number) => void;
  toast: (text: string, kind?: string) => void;
  onBanner: (title: string, sub: string, warnS: number) => void;
  onEventStart?: (k: EventKind) => void;
  onEventEnd?: (k: EventKind, data: string) => void;
  onKing?: (id: string) => void; // marked player changed ("" = none)
  sfx: {
    warn: () => void;
    thunder: (dist: number) => void;
    meteor: (dist: number) => void;
    rumble: (on: boolean) => void;
  };
}

export class Events {
  current: EventKind | null = null;
  timeLeft = 0;
  warnLeft = 0;
  kingId = "";
  zone: { x: number; z: number; r: number } | null = null;

  private nextRollT = 45; // first event lands quickly so the world feels alive
  private meteors: Meteor[] = [];
  private strikes: Strike[] = [];
  private strikeT = 0;
  private meteorSchedule: number[] = [];
  private quakeT = 0;
  private quakeLines: { x: number; z: number; dx: number; dz: number; done: number }[] = [];
  private quakeBridge = -1;
  private quakeCellIdx = 0;
  private rng = Math.random;
  private lastKind: EventKind | null = null;
  private rockGeo = new THREE.DodecahedronGeometry(1);
  private rockMat = new THREE.MeshStandardMaterial({
    color: 0x4a3428,
    emissive: 0xff4a12,
    emissiveIntensity: 0.8,
    roughness: 0.8,
    toneMapped: false,
  });

  constructor(private d: Deps) {
    d.net.onEvent = (e) => this.begin(e);
    d.net.onStrike = (x, z) => this.addStrike(x, z);
    d.net.onMeteor = (x, z, r, delay) => this.addMeteor(x, z, r, delay);
  }

  // --- host: roll + drive ---
  private roll(now: number): EventMsg {
    void now;
    let k: EventKind;
    do {
      k = KINDS[Math.floor(this.rng() * KINDS.length)];
    } while (k === this.lastKind);
    // events with a zone pick one away from the world edge
    const a = this.rng() * Math.PI * 2;
    const r = this.rng() * 220;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const dur =
      k === "stampede" ? STAMPEDE_DUR
      : k === "meteor" ? METEOR_DUR
      : k === "bears" ? BEARS_DUR
      : k === "king" ? KING_DUR
      : k === "storm" ? STORM_DUR
      : k === "golden" ? GOLD_DUR
      : QUAKE_DUR;
    let data = "";
    if (k === "king") {
      const ids = this.d.inWorldIds();
      data = ids.length ? ids[Math.floor(this.rng() * ids.length)] : "";
      if (!data) return this.roll(now); // nobody to crown - reroll
    }
    return { k, x, z, dur, data, seed: Math.floor(this.rng() * 1e9) };
  }

  // start an event locally (both the host's own roll and a received broadcast)
  private begin(e: EventMsg) {
    const k = e.k as EventKind;
    if (!KINDS.includes(k)) return;
    this.current = k;
    this.lastKind = k;
    this.timeLeft = e.dur + EVENT_WARN;
    this.warnLeft = EVENT_WARN;
    this.zone = k === "meteor" ? { x: e.x, z: e.z, r: METEOR_ZONE_R } : null;
    this.kingId = k === "king" ? e.data : "";
    if (k === "king") this.d.onKing?.(this.kingId);
    this.d.onBanner(EVENT_TITLES[k], EVENT_SUBS[k], EVENT_WARN);
    this.d.sfx.warn();

    // host pre-plans the moving parts
    if (this.d.net.isHost) {
      if (k === "meteor") {
        this.meteorSchedule = [];
        for (let i = 0; i < METEOR_COUNT; i++) this.meteorSchedule.push(EVENT_WARN + this.rng() * (e.dur - 4));
        this.meteorSchedule.sort((a, b) => a - b);
      } else if (k === "quake") {
        this.quakeLines = [];
        for (let i = 0; i < 2; i++) {
          const a = this.rng() * Math.PI * 2;
          this.quakeLines.push({
            x: e.x + (this.rng() - 0.5) * 120,
            z: e.z + (this.rng() - 0.5) * 120,
            dx: Math.cos(a),
            dz: Math.sin(a),
            done: 0,
          });
        }
        this.quakeBridge = this.d.world.voxels.bridges.length
          ? Math.floor(this.rng() * this.d.world.voxels.bridges.length)
          : -1;
        this.quakeCellIdx = 0;
        this.quakeT = 0;
      }
    }
  }

  private endCurrent() {
    const k = this.current;
    if (!k) return;
    this.current = null;
    this.zone = null;
    if (k === "king") {
      this.d.onEventEnd?.(k, this.kingId);
      this.kingId = "";
      this.d.onKing?.("");
    } else {
      this.d.onEventEnd?.(k, "");
    }
    if (this.d.net.isHost) {
      if (k === "bears") this.d.npcs.hostClearType(NPC_BEAR);
      if (k === "golden") this.d.npcs.hostClearType(NPC_GOLDEN);
    }
    this.d.sfx.rumble(false);
  }

  get active(): boolean {
    return this.current !== null && this.warnLeft <= 0;
  }
  get stampedeOn(): boolean {
    return this.active && this.current === "stampede";
  }

  update(dt: number, now: number) {
    // host: roll the next event on schedule
    if (this.d.net.isHost && !this.current) {
      this.nextRollT -= dt;
      if (this.nextRollT <= 0 && this.d.inWorldIds().length > 0) {
        this.nextRollT = EVENT_EVERY;
        const e = this.roll(now);
        this.d.net.sendEvent(e);
        this.begin(e);
      }
    }

    // current event lifecycle
    if (this.current) {
      const wasWarn = this.warnLeft > 0;
      this.warnLeft = Math.max(0, this.warnLeft - dt);
      if (wasWarn && this.warnLeft <= 0) this.d.onEventStart?.(this.current);
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) {
        this.endCurrent();
      } else if (this.warnLeft <= 0) {
        this.driveActive(dt);
      }
    }

    this.updateMeteors(dt);
    this.updateStrikes(dt);
  }

  private driveActive(dt: number) {
    const k = this.current!;
    const host = this.d.net.isHost;

    if (k === "quake") {
      // everyone rumbles; the host carves
      this.d.shake.floor(0.35);
      this.d.sfx.rumble(true);
      if (host) {
        this.quakeT += dt;
        while (this.quakeT > 0.1) {
          this.quakeT -= 0.1;
          this.carveQuakeStep();
        }
      }
    }

    if (host) {
      if (k === "storm") {
        this.strikeT -= dt;
        if (this.strikeT <= 0) {
          this.strikeT = STORM_STRIKE_EVERY;
          // strike near a random live rider (or anywhere if nobody)
          const ids = this.d.inWorldIds();
          let x = (this.rng() - 0.5) * 500;
          let z = (this.rng() - 0.5) * 500;
          if (ids.length && this.rng() < 0.75) {
            const me = this.d.localPos();
            // the host only knows its own exact position + remote snapshots; aim
            // near itself or a random remote via the net roster
            const remotes = [...this.d.net.remotes.values()].filter((r) => r.inWorld);
            if (remotes.length && this.rng() < 0.6) {
              const r = remotes[Math.floor(this.rng() * remotes.length)];
              x = r.x + (this.rng() - 0.5) * 16;
              z = r.z + (this.rng() - 0.5) * 16;
            } else {
              x = me.x + (this.rng() - 0.5) * 20;
              z = me.z + (this.rng() - 0.5) * 20;
            }
          }
          this.d.net.sendStrike(x, z);
          this.addStrike(x, z);
        }
      } else if (k === "meteor" && this.meteorSchedule.length) {
        const sinceStart = METEOR_DUR + EVENT_WARN - this.timeLeft;
        while (this.meteorSchedule.length && this.meteorSchedule[0] <= sinceStart) {
          this.meteorSchedule.shift();
          const zone = this.zone!;
          const a = this.rng() * Math.PI * 2;
          const rr = Math.sqrt(this.rng()) * zone.r;
          const x = zone.x + Math.cos(a) * rr;
          const z = zone.z + Math.sin(a) * rr;
          const r = 2 + Math.floor(this.rng() * 2.2); // crater radius
          this.d.net.sendMeteor(x, z, r, 1.7);
          this.addMeteor(x, z, r, 1.7);
        }
      } else if (k === "bears" && this.d.npcs.count(NPC_BEAR) === 0 && this.timeLeft > BEARS_DUR * 0.5) {
        this.d.npcs.hostSpawnBears(BEARS_COUNT, this.zoneX(), this.zoneZ(), 60);
      } else if (k === "golden" && this.d.npcs.count(NPC_GOLDEN) === 0 && this.timeLeft > GOLD_DUR * 0.5) {
        this.d.npcs.hostSpawnGolden(GOLD_COUNT);
      }
    }
  }
  private zoneX(): number {
    return this.zone?.x ?? 0;
  }
  private zoneZ(): number {
    return this.zone?.z ?? 0;
  }

  // one carve step of the earthquake: extend each fissure + drop bridge cells
  private carveQuakeStep() {
    const vox = this.d.world.voxels;
    for (const line of this.quakeLines) {
      if (line.done > 46) continue;
      line.done += 1;
      const cx = Math.floor(line.x + line.dx * line.done * 2 + GRID / 2);
      const cz = Math.floor(line.z + line.dz * line.done * 2 + GRID / 2);
      const topY = vox.topAt(cx, cz);
      if (topY <= SEA + 1) continue; // fissures stop at water
      // break a 2-wide, 3-deep notch (a rideable trench with rough walls)
      for (let ox = -1; ox <= 1; ox++)
        for (let oz = -1; oz <= 1; oz++) {
          if (Math.abs(ox) + Math.abs(oz) > 1) continue;
          for (let dy = 0; dy < 3; dy++) {
            const y = topY - 1 - dy;
            if (y <= 1) break;
            if (vox.breakAt(cx + ox, y, cz + oz)) this.d.net.sendEdit(cx + ox, y, cz + oz, 0);
          }
        }
      const wx = cx - GRID / 2 + 0.5;
      const wz = cz - GRID / 2 + 0.5;
      this.d.fx.debris(wx, topY, wz, 5, 0x6e5436);
    }
    // collapse the chosen bridge, a few planks per step
    if (this.quakeBridge >= 0) {
      const bridge = vox.bridges[this.quakeBridge];
      for (let n = 0; n < 4 && this.quakeCellIdx < bridge.cells.length; n++, this.quakeCellIdx++) {
        const c = bridge.cells[this.quakeCellIdx];
        if (vox.breakAt(c.x, c.y, c.z)) {
          this.d.net.sendEdit(c.x, c.y, c.z, 0);
          const wx = c.x - GRID / 2 + 0.5;
          const wz = c.z - GRID / 2 + 0.5;
          this.d.fx.debris(wx, c.y + 0.5, wz, 3, 0xc89348);
        }
      }
    }
  }

  // --- meteors (all clients render; host also carves the crater) ---
  private addMeteor(x: number, z: number, r: number, delay: number) {
    const groundY = this.d.world.voxels.surfaceBelow(x, z, 55);
    const mesh = new THREE.Mesh(this.rockGeo, this.rockMat);
    const s = r * 0.7;
    mesh.scale.set(s, s, s);
    mesh.position.set(x + delay * 14, groundY + delay * 42, z + delay * 8);
    this.d.scene.add(mesh);
    this.meteors.push({ x, z, r, t: delay, mesh, groundY });
    this.d.fx.ring(x, groundY, z, r * 3, delay, 0xff7327);
  }

  private updateMeteors(dt: number) {
    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.t -= dt;
      if (m.t <= 0) {
        this.impactMeteor(m);
        this.d.scene.remove(m.mesh);
        this.meteors.splice(i, 1);
        continue;
      }
      // fall along a shallow arc toward the impact point
      m.mesh.position.set(m.x + m.t * 14, m.groundY + m.t * 42, m.z + m.t * 8);
      m.mesh.rotation.x += dt * 5;
      m.mesh.rotation.z += dt * 3;
      this.d.fx.meteorTrail(m.mesh.position.x, m.mesh.position.y, m.mesh.position.z);
    }
  }

  private impactMeteor(m: Meteor) {
    const me = this.d.localPos();
    const dist = Math.hypot(me.x - m.x, me.z - m.z);
    this.d.fx.impact(m.x, m.groundY, m.z, 1, 0x8a6a4a);
    this.d.fx.debris(m.x, m.groundY, m.z, 18, 0x6e5436);
    this.d.shake.add(Math.max(0, 0.7 - dist * 0.01));
    this.d.sfx.meteor(dist);
    // shove anyone close (each client applies its own)
    if (dist < m.r * 3.2) {
      const dx = (me.x - m.x) / (dist || 1);
      const dz = (me.z - m.z) / (dist || 1);
      const kb = Math.max(8, 30 - dist * 2.4);
      this.d.knockLocal(dx, dz, kb, KB_UP);
    }
    // the HOST carves the crater; the edit pipeline syncs + persists it
    if (this.d.net.isHost) {
      const vox = this.d.world.voxels;
      const gx = Math.floor(m.x + GRID / 2);
      const gz = Math.floor(m.z + GRID / 2);
      const gy = m.groundY;
      const R = m.r;
      for (let ox = -R; ox <= R; ox++)
        for (let oz = -R; oz <= R; oz++)
          for (let oy = -Math.ceil(R * 0.7); oy <= Math.ceil(R * 0.4); oy++) {
            if (ox * ox + oz * oz + oy * oy * 2 > R * R + 1) continue;
            const y = Math.round(gy - 1 + oy);
            if (y <= 1) continue;
            if (vox.breakAt(gx + ox, y, gz + oz)) this.d.net.sendEdit(gx + ox, y, gz + oz, 0);
          }
    }
  }

  // --- lightning strikes (all clients render; each applies its own shove) ---
  private addStrike(x: number, z: number) {
    const groundY = this.d.world.voxels.surfaceBelow(x, z, 55);
    this.strikes.push({ x, z, t: 1.15, groundY });
    this.d.fx.ring(x, groundY, z, 5, 1.15, 0x9fdcff);
  }

  private updateStrikes(dt: number) {
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      s.t -= dt;
      if (s.t > 0) continue;
      this.strikes.splice(i, 1);
      this.d.fx.bolt(s.x, s.groundY, s.z);
      const me = this.d.localPos();
      const dist = Math.hypot(me.x - s.x, me.z - s.z);
      this.d.shake.add(Math.max(0, 0.5 - dist * 0.012));
      this.d.sfx.thunder(dist);
      if (dist < 5.5) {
        const dx = (me.x - s.x) / (dist || 1);
        const dz = (me.z - s.z) / (dist || 1);
        this.d.knockLocal(dx, dz, 22, KB_UP);
        this.d.toast("struck by lightning", "warn");
      }
    }
  }
}
