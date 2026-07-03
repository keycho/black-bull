// black bull - juice. a small, self-contained feedback layer: stacked event TOASTS
// (land claimed, wave cleared, weapon switched...) and world-anchored FLOATING
// text (damage numbers, "+points" kill pops) that rise + fade. styled to the
// desci/terminal hud (teal, mono). a singleton like `audio`, so any system can
// import it and fire feedback without wiring.
//
// graceful: with no DOM (headless) or before attach(), every call is a no-op.

import * as THREE from "three";

const FLOATS = 56; // pooled world-anchored text elements
const DMG_LIFE = 0.85; // s a damage number lives
const PTS_LIFE = 1.15; // s a "+points" pop lives
const RISE = 1.7; // world units a float drifts up over its life

type ToastKind = "info" | "good" | "kill" | "wave" | "warn" | "land" | "bad";

interface Float {
  el: HTMLElement;
  x: number;
  y: number;
  z: number;
  t: number;
  life: number;
  active: boolean;
}

class Feedback {
  private camera: THREE.PerspectiveCamera | null = null;
  private stack: HTMLElement | null = null;
  private layer: HTMLElement | null = null;
  private floats: Float[] = [];
  private next = 0;
  private proj = new THREE.Vector3();
  // a single accumulating "+N xp" popup near the mission hud (rapid gains tick up
  // one number instead of spamming many toasts).
  private xpEl: HTMLElement | null = null;
  private xpTotal = 0;
  private xpUntil = 0;

  // wire the camera (for projection) + build the float pool. call once at boot.
  attach(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    if (typeof document === "undefined") return;
    this.stack = document.getElementById("toast-stack");
    this.layer = document.getElementById("fx-layer");
    if (this.layer) {
      for (let i = 0; i < FLOATS; i++) {
        const el = document.createElement("div");
        el.className = "fx-float";
        el.style.display = "none";
        this.layer.appendChild(el);
        this.floats.push({ el, x: 0, y: 0, z: 0, t: 0, life: 1, active: false });
      }
    }
  }

  // --- stacked event toasts ---
  toast(text: string, kind: ToastKind = "info") {
    if (!this.stack) return;
    const el = document.createElement("div");
    el.className = "toast toast-" + kind;
    el.textContent = text;
    this.stack.appendChild(el);
    while (this.stack.children.length > 5) this.stack.firstElementChild?.remove();
    void el.offsetWidth; // reflow so the entrance transition plays
    el.classList.add("show");
    const hold = kind === "wave" ? 2200 : 1500;
    window.setTimeout(() => {
      el.classList.remove("show");
      el.classList.add("hide");
      window.setTimeout(() => el.remove(), 460);
    }, hold);
  }

  // --- a small floating "+N xp" near the mission hud (per-action xp feedback) ---
  xp(amount: number) {
    if (typeof document === "undefined" || amount <= 0) return;
    const now = performance.now();
    if (!this.xpEl) {
      this.xpEl = document.createElement("div");
      this.xpEl.id = "xp-pop";
      document.body.appendChild(this.xpEl);
    }
    if (now > this.xpUntil) this.xpTotal = 0; // a fresh burst
    this.xpTotal += amount;
    this.xpEl.textContent = `+${this.xpTotal} xp`;
    this.xpEl.classList.remove("show");
    void this.xpEl.offsetWidth; // restart the rise/fade animation on each tick
    this.xpEl.classList.add("show");
    this.xpUntil = now + 1100;
  }

  // --- world-anchored floating text ---
  private spawn(x: number, y: number, z: number, text: string, cls: string, life: number) {
    if (!this.floats.length) return;
    // take a free float, else recycle the oldest (round-robin)
    let f = this.floats.find((q) => !q.active);
    if (!f) {
      f = this.floats[this.next];
      this.next = (this.next + 1) % this.floats.length;
    }
    f.x = x;
    f.y = y;
    f.z = z;
    f.t = 0;
    f.life = life;
    f.active = true;
    f.el.className = "fx-float " + cls;
    f.el.textContent = text;
    f.el.style.display = "block";
  }

  // a damage number at a world point (kill = punchier styling)
  damage(x: number, y: number, z: number, amount: number, kill: boolean) {
    this.spawn(x, y, z, String(amount), kill ? "fx-dmg fx-kill" : amount >= 40 ? "fx-dmg fx-big" : "fx-dmg", DMG_LIFE);
  }
  // a "+points" pop on a kill
  killPop(x: number, y: number, z: number, points: number) {
    this.spawn(x, y, z, "+" + points, "fx-pts", PTS_LIFE);
  }

  // animate floats every frame: rise, project to screen, pop-in then fade.
  update(_dt: number) {
    const cam = this.camera;
    if (!cam || !this.floats.length) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    for (const f of this.floats) {
      if (!f.active) continue;
      f.t += _dt;
      const p = f.t / f.life;
      if (p >= 1) {
        f.active = false;
        f.el.style.display = "none";
        continue;
      }
      this.proj.set(f.x, f.y + p * RISE, f.z).project(cam);
      if (this.proj.z > 1) {
        f.el.style.opacity = "0"; // behind the camera
        continue;
      }
      const sx = (this.proj.x * 0.5 + 0.5) * W;
      const sy = (-this.proj.y * 0.5 + 0.5) * H;
      const op = p < 0.12 ? p / 0.12 : 1 - (p - 0.12) / 0.88; // fast in, slow out
      const sc = p < 0.12 ? 1.4 - (p / 0.12) * 0.4 : 1; // pop in
      f.el.style.left = sx + "px";
      f.el.style.top = sy + "px";
      f.el.style.opacity = String(Math.max(0, op));
      f.el.style.transform = `translate(-50%,-50%) scale(${sc.toFixed(3)})`;
    }
  }
}

export const fx = new Feedback();
