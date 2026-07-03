// black bull - cinematic drone/flythrough mode. a scripted camera path that
// flies across the battlefield for clean screen-recording / social clips.
// activate with a key: it hides every hud element, locks player input, and
// flies a smooth (centripetal catmull-rom) path with eased speed and gentle
// banking. press the same key or escape to cancel and return to play
// instantly. zero cost when idle.
//
// it is a pure overlay: it only reads the world (never mutates it), so
// whatever is happening - a stampede, a meteor shower, a brawl - keeps
// running underneath while the camera flies.

import * as THREE from "three";
import { SEA } from "./config";

// the every-hud-element list - force-hidden via body.cinematic so the per-frame
// ".show" toggles in the render loop cannot bring any of them back on screen.
export const HUD_IDS = [
  "net-status", "fx-layer", "toast-stack", "impact-flash", "charge-hud",
  "momentum-hud", "event-banner", "event-chip", "alpha-banner", "ko-overlay",
  "biome-label", "fps-hud", "minimap", "chat", "bigmap", "audio-ctl",
];

// a keyframe: time (seconds), camera position, look-at target, and bank/roll.
interface Key {
  t: number;
  p: [number, number, number];
  l: [number, number, number];
  roll: number;
}

// the arena sits at (0,0); the seven biomes fan out around it. the path opens
// in the colosseum, sweeps the plains + a river bridge, climbs the dark range,
// crosses the storm plateau, and pulls up for the full-continent shot.
const KEYS: Key[] = [
  // opening: inside the arena pit, rising past the seating
  { t: 0, p: [0, 9, 24], l: [0, 8, 0], roll: 0 },
  { t: 4, p: [-30, 18, 38], l: [0, 8, -10], roll: 0.06 },
  // plains sweep: fast and low over the open charging ground
  { t: 8, p: [-90, 14, 30], l: [-190, 8, 90], roll: 0.12 },
  { t: 12, p: [-190, 12, 120], l: [-260, 8, 190], roll: -0.1 },
  // river + bridge: skim the water line past a crossing
  { t: 16, p: [-170, 9, 170], l: [-60, 7, 160], roll: 0.08 },
  // canyon mesas: bank through the red rock
  { t: 20, p: [-40, 22, 230], l: [90, 14, 260], roll: -0.12 },
  // obsidian climb: up the dark range
  { t: 25, p: [120, 30, 200], l: [230, 34, 90], roll: 0.06 },
  { t: 29, p: [220, 44, 100], l: [260, 20, -40], roll: 0 },
  // storm plateau: across the high table + its obelisks
  { t: 33, p: [240, 34, -60], l: [160, 22, -180], roll: -0.08 },
  // high pull-back: the whole continent in frame
  { t: 38, p: [120, 150, -120], l: [0, 8, 0], roll: 0 },
  { t: 44, p: [-30, 210, 60], l: [0, 6, 0], roll: 0 },
];
const TOTAL = KEYS[KEYS.length - 1].t;
const N = KEYS.length;

interface Opts {
  camera: THREE.PerspectiveCamera;
  fog: THREE.Fog;
  groundAt: (x: number, z: number) => number; // top surface y under a world x,z
  onStart?: () => void;
  onStop?: () => void;
}

export class Cinematic {
  active = false;
  private t = 0;
  private cam: THREE.PerspectiveCamera;
  private fog: THREE.Fog;
  private groundAt: (x: number, z: number) => number;
  private onStart?: () => void;
  private onStop?: () => void;
  private fogFarSaved = 0;

  private posCurve: THREE.CatmullRomCurve3;
  private lookCurve: THREE.CatmullRomCurve3;
  private _p = new THREE.Vector3();
  private _l = new THREE.Vector3();

  constructor(o: Opts) {
    this.cam = o.camera;
    this.fog = o.fog;
    this.groundAt = o.groundAt;
    this.onStart = o.onStart;
    this.onStop = o.onStop;
    this.posCurve = new THREE.CatmullRomCurve3(
      KEYS.map((k) => new THREE.Vector3(...k.p)), false, "centripetal", 0.5
    );
    this.lookCurve = new THREE.CatmullRomCurve3(
      KEYS.map((k) => new THREE.Vector3(...k.l)), false, "centripetal", 0.5
    );
    this.injectOverlay();
  }

  toggle() {
    this.active ? this.stop() : this.start();
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.t = 0;
    document.body.classList.add("cinematic");
    // widen the haze so the high-pan reveal can actually see all four islands at
    // once (the render loop clamps the camera far plane to fog.far + 36).
    this.fogFarSaved = this.fog.far;
    this.fog.far = 1400;
    this.onStart?.();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    document.body.classList.remove("cinematic");
    this.fog.far = this.fogFarSaved;
    this.onStop?.();
  }

  // advance + drive the camera. call every frame while active; returns when done.
  update(dt: number) {
    if (!this.active) return;
    this.t += dt;
    if (this.t >= TOTAL) {
      this.stop();
      return;
    }
    const { s, roll } = this.sample(this.t);
    this.posCurve.getPoint(s, this._p);
    this.lookCurve.getPoint(s, this._l);
    // never clip terrain/water: keep the camera a few units above the surface
    const minY = Math.max(SEA + 3, this.groundAt(this._p.x, this._p.z) + 4);
    if (this._p.y < minY) this._p.y = minY;
    this.cam.position.copy(this._p);
    this.cam.up.set(0, 1, 0);
    this.cam.lookAt(this._l);
    if (roll) this.cam.rotateZ(roll); // bank into turns like a real drone
  }

  // map elapsed time -> curve parameter s in [0,1] + the interpolated roll. linear
  // within each segment (segment durations set the speed: short = a fast sweep),
  // with a smooth ease-in on the first beat and ease-out on the last.
  private sample(t: number): { s: number; roll: number } {
    for (let i = 0; i < N - 1; i++) {
      if (t <= KEYS[i + 1].t) {
        const span = KEYS[i + 1].t - KEYS[i].t;
        let u = span > 0 ? (t - KEYS[i].t) / span : 0;
        if (i === 0) u = u * u; // ease in
        else if (i === N - 2) u = 1 - (1 - u) * (1 - u); // ease out
        const e = u * u * (3 - 2 * u); // smoothstep for the roll
        const roll = KEYS[i].roll + (KEYS[i + 1].roll - KEYS[i].roll) * e;
        return { s: (i + u) / (N - 1), roll };
      }
    }
    return { s: 1, roll: 0 };
  }

  // the "● rec" indicator + the body.cinematic hud-hide rules (injected once).
  private injectOverlay() {
    if (document.getElementById("blackbull-cinematic")) return;
    const style = document.createElement("style");
    style.id = "blackbull-cinematic";
    const hide = HUD_IDS.map((id) => `body.cinematic #${id}`).join(",\n");
    style.textContent = `
#cinematic-rec{position:fixed;top:14px;left:16px;z-index:60;display:none;
  align-items:center;gap:7px;font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  letter-spacing:.14em;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.6);pointer-events:none}
#cinematic-rec .cine-dot{width:9px;height:9px;border-radius:50%;background:#ff3b3b;
  box-shadow:0 0 8px #ff3b3b;animation:cine-blink 1.1s steps(1) infinite}
@keyframes cine-blink{0%{opacity:1}50%{opacity:.2}100%{opacity:1}}
body.cinematic #cinematic-rec{display:flex}
${hide}{display:none !important}`;
    document.head.appendChild(style);
    const rec = document.createElement("div");
    rec.id = "cinematic-rec";
    rec.innerHTML = `<span class="cine-dot"></span><span>rec</span>`;
    document.body.appendChild(rec);
  }
}
