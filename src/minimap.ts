// black bull - minimap. a north-up radar (top-right) showing, around the local
// bull: other riders (trim colour + name), npcs (wild herd, golden bulls,
// bears), the alpha crown marker, the marked king, and the active event zone,
// over a biome-tinted terrain backdrop. press n to expand to the full-world
// map. read-only: every position comes from the live managers each frame.

import { GRID, SEA } from "./config";
import { BIOME_TINTS } from "./voxels";

const SIZE = 184; // small radar diameter (css px)
const RANGE = 130; // world units from centre to the radar rim

export interface MinimapDeps {
  self: () => { x: number; z: number; yaw: number };
  selfColor: () => number;
  eachBull: (cb: (x: number, z: number, color: number, name: string, alpha: boolean, king: boolean) => void) => void;
  eachNpc: (cb: (x: number, z: number, ty: number) => void) => void;
  eventZone: () => { x: number; z: number; r: number } | null;
  canExpand: () => boolean;
  terrain: () => Int16Array | null; // world heightmap; read once
  biomes: () => Int8Array | null; // per-column biome index; read once
}

const hex6 = (n: number): string => (n & 0xffffff).toString(16).padStart(6, "0");
const NPC_COLORS = ["#8a6a44", "#ffd24a", "#b0543a"]; // wild / golden / bear

interface MapOpts {
  size: number;
  cx: number;
  cz: number;
  scale: number;
  names: boolean;
  clampRim: boolean;
  disc: boolean;
}

export class Minimap {
  private el: HTMLElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private big: HTMLElement | null = null;
  private bigCtx: CanvasRenderingContext2D | null = null;
  private bigSize = 0;
  private open = false;
  private terrainCv: HTMLCanvasElement | null = null;
  private terrainTried = false;

  constructor(private d: MinimapDeps) {
    if (typeof document === "undefined") return;
    this.injectStyle();
    this.ctx = this.buildRadar();
    this.buildBig();
    window.addEventListener("keydown", (e) => this.onKey(e));
  }

  private buildRadar(): CanvasRenderingContext2D | null {
    const el = document.createElement("div");
    el.id = "minimap";
    el.innerHTML =
      `<canvas></canvas><span class="mm-n">n</span>` +
      `<div class="mm-legend"><span class="mm-k" style="--c:#e2b13b">riders</span>` +
      `<span class="mm-k" style="--c:#ffd24a">golden</span>` +
      `<span class="mm-k" style="--c:#b0543a">bears</span><span class="mm-x">n · map</span></div>`;
    document.body.appendChild(el);
    this.el = el;
    return this.fitCanvas(el.querySelector("canvas") as HTMLCanvasElement, SIZE);
  }

  private buildBig() {
    const ov = document.createElement("div");
    ov.id = "bigmap";
    ov.innerHTML =
      `<div class="bm-frame"><canvas></canvas></div>` +
      `<div class="bm-bar"><span class="bm-title">the battlefield</span>` +
      `<span class="bm-legend"><span class="mm-k" style="--c:#e2b13b">riders</span>` +
      `<span class="mm-k" style="--c:#ffd24a">golden herd</span><span class="mm-k" style="--c:#b0543a">bears</span>` +
      `<span class="mm-k" style="--c:#ffe27a">alpha</span></span>` +
      `<span class="bm-close">n / esc to close</span></div>`;
    document.body.appendChild(ov);
    ov.addEventListener("pointerdown", (e) => {
      if (e.target === ov) this.closeBig();
    });
    this.big = ov;
  }

  private onKey(e: KeyboardEvent) {
    if (e.repeat) return;
    const a = document.activeElement;
    if (a && /input|textarea|select/i.test(a.tagName)) return;
    if (e.code === "KeyN") {
      if (this.open) {
        e.preventDefault();
        this.closeBig();
      } else if (this.d.canExpand()) {
        e.preventDefault();
        this.openBig();
      }
    } else if (e.code === "Escape" && this.open) {
      this.closeBig();
    }
  }

  private openBig() {
    if (this.open || !this.big) return;
    this.open = true;
    this.bigSize = Math.round(Math.min(window.innerWidth - 40, window.innerHeight - 96));
    this.bigCtx = this.fitCanvas(this.big.querySelector("canvas") as HTMLCanvasElement, this.bigSize);
    this.big.classList.add("show");
    if (document.pointerLockElement) {
      try {
        document.exitPointerLock();
      } catch {
        /* ignore */
      }
    }
  }

  private closeBig() {
    if (!this.open) return;
    this.open = false;
    this.big?.classList.remove("show");
    if (this.d.canExpand()) {
      try {
        document.body.requestPointerLock();
      } catch {
        /* ignore */
      }
    }
  }

  isOpen(): boolean {
    return this.open;
  }

  setVisible(on: boolean) {
    this.el?.classList.toggle("show", on && !this.open);
    if (!on && this.open) this.closeBig();
  }

  draw() {
    if (this.open && this.bigCtx) {
      const s = this.bigSize;
      this.renderMap(this.bigCtx, { size: s, cx: 0, cz: 0, scale: s / GRID, names: true, clampRim: false, disc: false });
    } else if (this.ctx && this.el?.classList.contains("show")) {
      const me = this.d.self();
      this.renderMap(this.ctx, { size: SIZE, cx: me.x, cz: me.z, scale: SIZE / 2 / RANGE, names: true, clampRim: true, disc: true });
    }
  }

  private renderMap(ctx: CanvasRenderingContext2D, o: MapOpts) {
    const { size, cx, cz, scale } = o;
    const half = size / 2;
    const me = this.d.self();
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 240);
    const wx = (x: number) => half + (x - cx) * scale;
    const wy = (z: number) => half + (z - cz) * scale;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    if (o.disc) ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    else roundRect(ctx, 1, 1, size - 2, size - 2, 10);
    ctx.clip();

    ctx.fillStyle = "#100e0c";
    ctx.fillRect(0, 0, size, size);

    this.paintTerrain(ctx, o);

    // active event zone
    const zone = this.d.eventZone();
    if (zone) {
      ctx.strokeStyle = `rgba(255,115,39,${0.5 + pulse * 0.4})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(wx(zone.x), wy(zone.z), zone.r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    // world edge
    ctx.strokeStyle = "#3a3026";
    ctx.lineWidth = 2;
    ctx.strokeRect(wx(-GRID / 2), wy(-GRID / 2), GRID * scale, GRID * scale);

    // npcs
    this.d.eachNpc((x, z, ty) => {
      let mx = wx(x),
        my = wy(z);
      if (o.disc) {
        const dx = mx - half,
          dy = my - half;
        if (dx * dx + dy * dy > (half - 3) * (half - 3)) {
          if (ty !== 1) return; // only golden bulls clamp to the rim (worth chasing)
          const p = clampToRim(dx, dy, half - 4);
          mx = half + p.x;
          my = half + p.y;
        }
      } else if (mx < 2 || my < 2 || mx > size - 2 || my > size - 2) return;
      ctx.fillStyle = NPC_COLORS[ty] ?? "#999";
      if (ty === 1) {
        const r = 3 + pulse * 1.5;
        ctx.beginPath();
        ctx.arc(mx, my, r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(mx - 2, my - 2, 4, 4);
      }
    });

    // other riders - clamp to rim (radar) or show in place (big map)
    this.d.eachBull((x, z, color, name, alpha, king) => {
      let mx = wx(x),
        my = wy(z);
      if (o.clampRim) {
        const p = clampToRim(mx - half, my - half, half - 5);
        mx = half + p.x;
        my = half + p.y;
      } else if (mx < 0 || my < 0 || mx > size || my > size) return;
      ctx.fillStyle = `#${hex6(color)}`;
      ctx.beginPath();
      ctx.arc(mx, my, o.disc ? 3.2 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(12,8,4,.7)";
      ctx.lineWidth = 1;
      ctx.stroke();
      if (alpha) {
        // the crown: a gold ring everyone can track
        ctx.strokeStyle = `rgba(255,226,122,${0.7 + pulse * 0.3})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(mx, my, 6 + pulse * 2, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (king) {
        ctx.strokeStyle = `rgba(255,90,60,${0.7 + pulse * 0.3})`;
        ctx.lineWidth = 2;
        ctx.strokeRect(mx - 6, my - 6, 12, 12);
      }
      if (o.names && name) label(ctx, name.slice(0, 14), mx, my - (o.disc ? 7 : 9), `#${hex6(color)}`, o.disc ? 8 : 11);
    });

    // self - heading triangle
    const sx = wx(me.x),
      sy = wy(me.z);
    const fx = -Math.sin(me.yaw),
      fz = -Math.cos(me.yaw),
      px = -fz,
      pz = fx;
    const r = o.disc ? 7 : 9;
    ctx.fillStyle = `#${hex6(this.d.selfColor())}`;
    ctx.strokeStyle = "#fff4e0";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx + fx * r, sy + fz * r);
    ctx.lineTo(sx - fx * (r * 0.7) + px * (r * 0.6), sy - fz * (r * 0.7) + pz * (r * 0.6));
    ctx.lineTo(sx - fx * (r * 0.7) - px * (r * 0.6), sy - fz * (r * 0.7) - pz * (r * 0.6));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.restore();

    // frame
    ctx.strokeStyle = "#4a3a26";
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (o.disc) ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    else roundRect(ctx, 1, 1, size - 2, size - 2, 10);
    ctx.stroke();
  }

  private paintTerrain(ctx: CanvasRenderingContext2D, o: MapOpts) {
    if (!this.terrainCv && !this.terrainTried) {
      this.terrainTried = true;
      const h = this.d.terrain();
      const b = this.d.biomes();
      if (h) this.buildTerrain(h, b);
    }
    if (!this.terrainCv) return;
    const { size, cx, cz, scale } = o;
    const half = size / 2;
    const T = this.terrainCv.width;
    const t = T / GRID;
    const sx = (cx - half / scale + GRID / 2) * t;
    const sy = (cz - half / scale + GRID / 2) * t;
    const sw = (size / scale) * t;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.terrainCv, sx, sy, sw, sw, 0, 0, size, size);
  }

  // render the heightmap once: land tinted by biome + shaded by elevation,
  // rivers/ocean dark. indexed [i*GRID + j] with i=x-cell, j=z-cell.
  private buildTerrain(heights: Int16Array, biomes: Int8Array | null) {
    const T = 256,
      step = GRID / T;
    const cv = document.createElement("canvas");
    cv.width = T;
    cv.height = T;
    const tctx = cv.getContext("2d");
    if (!tctx) return;
    const img = tctx.createImageData(T, T);
    const dat = img.data;
    for (let ty = 0; ty < T; ty++) {
      const j = Math.min(GRID - 1, (ty * step) | 0);
      for (let tx = 0; tx < T; tx++) {
        const i = Math.min(GRID - 1, (tx * step) | 0);
        const h = heights[i * GRID + j];
        const p = (ty * T + tx) * 4;
        if (h > SEA) {
          const b = biomes ? biomes[i * GRID + j] : -1;
          const tint = b >= 0 ? BIOME_TINTS[b] : 0x4a5a40;
          const k = (0.45 + Math.max(0, Math.min(1, (h - SEA) / 22)) * 0.55) * 0.62;
          dat[p] = ((tint >> 16) & 0xff) * k;
          dat[p + 1] = ((tint >> 8) & 0xff) * k;
          dat[p + 2] = (tint & 0xff) * k;
          dat[p + 3] = 255;
        } else {
          const d = Math.max(0, Math.min(1, (SEA - h) / 6));
          dat[p] = 10 + (1 - d) * 8;
          dat[p + 1] = 16 + (1 - d) * 10;
          dat[p + 2] = 24 + (1 - d) * 10;
          dat[p + 3] = 255;
        }
      }
    }
    tctx.putImageData(img, 0, 0);
    this.terrainCv = cv;
  }

  private fitCanvas(cv: HTMLCanvasElement, size: number): CanvasRenderingContext2D | null {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = size * dpr;
    cv.height = size * dpr;
    cv.style.width = size + "px";
    cv.style.height = size + "px";
    const ctx = cv.getContext("2d");
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  private injectStyle() {
    if (document.getElementById("blackbull-mm-style")) return;
    const st = document.createElement("style");
    st.id = "blackbull-mm-style";
    st.textContent = `
#minimap{position:fixed;top:56px;right:12px;z-index:36;display:none;flex-direction:column;align-items:center;
 font-family:ui-monospace,Menlo,Consolas,monospace;pointer-events:none}
#minimap.show{display:flex}
#minimap canvas{display:block;border-radius:50%;box-shadow:0 8px 26px -8px rgba(0,0,0,.75)}
#minimap .mm-n{position:absolute;top:3px;left:50%;transform:translateX(-50%);color:#f0dcb4;font-size:9px;letter-spacing:.12em;text-transform:uppercase}
#minimap .mm-legend{display:flex;gap:9px;margin-top:6px;background:rgba(20,14,8,.74);border:1px solid #3a2e1e;border-radius:6px;padding:3px 9px;align-items:center}
.mm-k{color:#ab9a80;font-size:9px;letter-spacing:.04em;display:flex;align-items:center;gap:4px}
.mm-k::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--c)}
#minimap .mm-x{color:#8a7a5e;font-size:9px;letter-spacing:.06em;border-left:1px solid #3a2e1e;padding-left:8px}
#bigmap{position:fixed;inset:0;z-index:62;display:none;flex-direction:column;align-items:center;justify-content:center;gap:12px;
 background:rgba(10,7,4,.82);backdrop-filter:blur(3px);font-family:ui-monospace,Menlo,Consolas,monospace}
#bigmap.show{display:flex}
#bigmap .bm-frame{border:1px solid #4a3a26;box-shadow:0 0 0 1px #1c140c,0 18px 60px rgba(0,0,0,.6);line-height:0}
#bigmap canvas{display:block;border-radius:10px}
#bigmap .bm-bar{display:flex;align-items:center;gap:16px;background:#141008;border:1px solid #3a2e1e;border-radius:8px;padding:8px 14px}
#bigmap .bm-title{color:#e2b13b;font-size:14px;letter-spacing:.16em;text-transform:lowercase}
#bigmap .bm-legend{display:flex;gap:11px}
#bigmap .bm-close{color:#8a7a5e;font-size:11px;letter-spacing:.08em;border-left:1px solid #3a2e1e;padding-left:14px}
`;
    document.head.appendChild(st);
  }
}

function clampToRim(dx: number, dz: number, rim: number): { x: number; y: number } {
  const d = Math.hypot(dx, dz);
  if (d <= rim) return { x: dx, y: dz };
  const k = rim / (d || 1);
  return { x: dx * k, y: dz * k };
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, px: number) {
  ctx.font = `${px}px ui-monospace,Menlo,Consolas,monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(10,6,3,.9)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
