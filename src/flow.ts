// black bull - the front-door flow: landing -> the stable (name + bull
// cosmetics) -> deploy fly-in -> playing. the flow owns the camera and the
// local bull preview for every stage EXCEPT playing, where the bull controller
// drives them. cosmetic unlocks come from the lifetime stats; locked options
// show their requirement and cannot be equipped. the chosen look persists in
// localStorage and is announced over presence on join.

import * as THREE from "three";
import type { Bull } from "./bull";
import { BullModel, COATS, type Cosmetics, TRIMS } from "./bullmodel";
import { ARENA_WALL_R } from "./config";
import { CATALOG, loadLook, type Look, sanitizeLook, saveLook } from "./cosmetics";
import type { Stats } from "./momentum";
import type { World } from "./world";

const FLY_DUR = 2.6;
const SPAWN_R = ARENA_WALL_R + 26; // deploy ring just outside the arena walls

export type Stage = "landing" | "stable" | "flyin" | "playing";

interface FlowDeps {
  camera: THREE.PerspectiveCamera;
  bull: Bull;
  bullModel: BullModel; // the local player's model (preview + in-world)
  world: World;
  fog: THREE.Fog;
  stats: () => Stats;
  onStageChange: (stage: Stage) => void;
  onJoin: (name: string, cos: Cosmetics) => void;
  onLookChange: (name: string, cos: Cosmetics) => void;
}

// a spawn point on the deploy ring around the arena (also used for respawns)
export function pickSpawn(world: World): { x: number; z: number; yaw: number } {
  for (let tries = 0; tries < 24; tries++) {
    const a = Math.random() * Math.PI * 2;
    const r = SPAWN_R + Math.random() * 30;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = world.voxels.surfaceBelow(x, z, 60);
    if (y > 3) return { x, z, yaw: Math.atan2(x, z) + Math.PI }; // face the arena
  }
  return { x: 0, z: SPAWN_R, yaw: Math.PI };
}

export class Flow {
  stage: Stage = "landing";
  private look: Look;
  private landT = 0;
  private flyT = 0;
  private sp = { x: 0, z: SPAWN_R, yaw: Math.PI };
  private flyFrom = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private look3 = new THREE.Vector3();
  private playFar: number;

  private elLanding = document.getElementById("landing") as HTMLElement;
  private elStable = document.getElementById("stable") as HTMLElement;
  private elName = document.getElementById("st-name") as HTMLInputElement;

  constructor(private d: FlowDeps) {
    this.playFar = d.fog.far;
    this.look = sanitizeLook(loadLook(), d.stats());
    document.getElementById("play-btn")?.addEventListener("click", (e) => {
      (e.currentTarget as HTMLElement).blur();
      this.goStable();
    });
    document.getElementById("st-deploy")?.addEventListener("click", (e) => {
      (e.currentTarget as HTMLElement).blur();
      if (this.stage === "stable") this.goFlyin();
    });
    this.buildUI();
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      if (this.stage === "stable" && e.code === "Enter" && document.activeElement !== this.elName) {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur();
        this.goFlyin();
      } else if (this.stage === "flyin" && (e.code === "Space" || e.code === "Enter" || e.code === "Escape")) {
        this.flyT = 99;
      }
    });
    window.addEventListener("pointerdown", () => {
      if (this.stage === "flyin") this.flyT = 99; // click to skip the fly-in
    });
    this.applyLook();
    this.goLanding();
  }

  getLook(): Look {
    return { name: this.look.name, cos: { ...this.look.cos } };
  }

  // --- the stable: name + swatches + cosmetic slots -------------------------
  private buildUI() {
    if (this.elName) {
      this.elName.value = this.look.name;
      this.elName.addEventListener("input", () => {
        this.look.name = this.elName.value.slice(0, 16);
        this.changed();
      });
    }
    this.buildSwatches("st-coats", COATS, () => this.look.cos.coat, (i) => (this.look.cos.coat = i));
    this.buildSwatches("st-trims", TRIMS, () => this.look.cos.trim, (i) => (this.look.cos.trim = i));
    this.buildSlots();
  }

  private buildSwatches(
    id: string,
    list: { name: string; color: number }[],
    get: () => number,
    set: (i: number) => void
  ) {
    const row = document.getElementById(id);
    if (!row) return;
    row.innerHTML = "";
    list.forEach((f, i) => {
      const b = document.createElement("button");
      b.className = "st-swatch";
      b.style.background = "#" + f.color.toString(16).padStart(6, "0");
      b.title = f.name;
      if (i === get()) b.classList.add("active");
      b.addEventListener("click", () => {
        set(i);
        for (const el of Array.from(row.children)) el.classList.remove("active");
        b.classList.add("active");
        this.changed();
      });
      row.appendChild(b);
    });
  }

  // one row per cosmetic slot, options from the catalog with lock states
  rebuildSlots() {
    this.buildSlots();
  }
  private buildSlots() {
    const wrap = document.getElementById("st-slots");
    if (!wrap) return;
    const stats = this.d.stats();
    wrap.innerHTML = "";
    const slots: { cat: keyof Cosmetics; label: string }[] = [
      { cat: "rider", label: "rider" },
      { cat: "horns", label: "horns" },
      { cat: "eyes", label: "eyes" },
      { cat: "trail", label: "trail" },
      { cat: "hooves", label: "hooves" },
      { cat: "armor", label: "armor" },
      { cat: "crown", label: "crown" },
    ];
    for (const slot of slots) {
      const label = document.createElement("div");
      label.className = "st-label";
      label.textContent = slot.label;
      wrap.appendChild(label);
      const row = document.createElement("div");
      row.className = "st-optrow";
      for (const opt of CATALOG.filter((o) => o.cat === slot.cat)) {
        const b = document.createElement("button");
        b.className = "st-opt";
        const open = opt.unlocked(stats);
        b.textContent = open ? opt.name : `${opt.name} · ${opt.req}`;
        if (!open) b.classList.add("locked");
        if (this.look.cos[slot.cat] === opt.idx && open) b.classList.add("active");
        b.addEventListener("click", () => {
          if (!opt.unlocked(this.d.stats())) return;
          this.look.cos[slot.cat] = opt.idx;
          for (const el of Array.from(row.children)) el.classList.remove("active");
          b.classList.add("active");
          this.changed();
        });
        row.appendChild(b);
      }
      wrap.appendChild(row);
    }
  }

  private applyLook() {
    this.d.bullModel.setCosmetics(this.look.cos);
    this.d.bullModel.setName(this.look.name || "rider");
  }
  private changed() {
    this.applyLook();
    saveLook(this.look);
    this.d.onLookChange(this.look.name || "rider", { ...this.look.cos });
  }

  private show(el: HTMLElement | null, on: boolean) {
    el?.classList.toggle("hidden", !on);
  }

  // --- stage transitions ---
  private goLanding() {
    this.stage = "landing";
    this.landT = 0;
    this.show(this.elLanding, true);
    this.show(this.elStable, false);
    this.d.bullModel.setVisible(false);
    this.d.fog.far = 620; // pull the haze back for the aerial establishing shot
    this.d.onStageChange(this.stage);
  }
  private goStable() {
    this.stage = "stable";
    this.d.fog.far = this.playFar;
    this.show(this.elLanding, false);
    this.show(this.elStable, true);
    this.sp = pickSpawn(this.d.world);
    // park the bull on its deploy spot for the showcase
    const y = this.d.world.voxels.surfaceBelow(this.sp.x, this.sp.z, 60);
    this.d.bull.pos.set(this.sp.x, y, this.sp.z);
    this.d.bullModel.setVisible(true);
    this.buildSlots(); // refresh locks (stats may have moved last session)
    this.d.onStageChange(this.stage);
  }
  private goFlyin() {
    this.stage = "flyin";
    this.show(this.elStable, false);
    this.look.name = (this.elName?.value ?? this.look.name).trim().slice(0, 16);
    saveLook(this.look);
    this.d.bull.requestLock(); // acquire pointer lock inside the deploy gesture
    this.flyT = 0;
    const y = this.d.world.voxels.surfaceBelow(this.sp.x, this.sp.z, 60);
    this.d.bull.respawn(this.sp.x, this.sp.z, this.sp.yaw);
    this.flyFrom.set(this.sp.x - Math.sin(this.sp.yaw) * 30, y + 60, this.sp.z - Math.cos(this.sp.yaw) * 30);
    this.d.onJoin(this.look.name || "rider", { ...this.look.cos });
    this.d.onStageChange(this.stage);
  }
  private enterPlaying() {
    this.stage = "playing";
    this.show(this.elLanding, false);
    this.show(this.elStable, false);
    this.d.onStageChange(this.stage);
  }

  update(dt: number, now: number) {
    const cam = this.d.camera;
    if (this.stage === "landing") {
      // a slow aerial orbit of the colosseum with the seven biomes fanned out
      this.landT += dt;
      const ang = this.landT * 0.045;
      cam.position.set(Math.sin(ang) * 200, 130, Math.cos(ang) * 200);
      cam.lookAt(0, 8, 0);
    } else if (this.stage === "stable") {
      // a close 3/4 showcase of the bull, slowly swaying across its front.
      // the look target is pushed left of the bull so the subject frames on
      // the RIGHT half of the screen, clear of the customization panel.
      const b = this.d.bull.pos;
      this.d.bullModel.setVisible(true);
      this.d.bullModel.update(dt, now, this.tmp.set(b.x, b.y, b.z), this.sp.yaw, 0, "idle");
      const az = this.sp.yaw + Math.PI + Math.sin(now * 0.00022) * 0.35;
      const dist = 6.4;
      cam.position.set(b.x + Math.sin(az) * dist, b.y + 2.9 + Math.sin(now * 0.0003) * 0.15, b.z + Math.cos(az) * dist);
      const fdx = b.x - cam.position.x;
      const fdz = b.z - cam.position.z;
      const fl = Math.hypot(fdx, fdz) || 1;
      const off = 2.4; // world units left of the bull along the screen axis
      cam.lookAt(b.x + (fdz / fl) * off, b.y + 1.6, b.z - (fdx / fl) * off);
    } else if (this.stage === "flyin") {
      this.flyT += dt;
      const s = Math.min(1, this.flyT / FLY_DUR);
      const e = s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2;
      const b = this.d.bull.pos;
      const yaw = this.sp.yaw;
      // land right on the chase-cam line so the handoff to gameplay is seamless
      this.tmp.set(b.x + Math.sin(yaw) * 7.4, b.y + 3.4, b.z + Math.cos(yaw) * 7.4);
      cam.position.lerpVectors(this.flyFrom, this.tmp, e);
      this.look3.set(b.x, b.y + 1.6, b.z);
      cam.lookAt(this.look3);
      this.d.bullModel.setVisible(true);
      this.d.bullModel.update(dt, now, this.tmp.set(b.x, b.y, b.z), yaw, 0, "idle");
      if (s >= 1) this.enterPlaying();
    }
  }
}
