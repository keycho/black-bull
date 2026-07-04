// black bull - procedural canvas textures + sky. three.js only, no external assets.
// kept deliberately low-res; the goal is material grain and a warm atmospheric
// sky, not photoreal detail.

import * as THREE from "three";

// --- value noise ---
function vhash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const a = vhash(xi, yi);
  const b = vhash(xi + 1, yi);
  const c = vhash(xi, yi + 1);
  const d = vhash(xi + 1, yi + 1);
  const u = smooth(xf);
  const v = smooth(yf);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function fbm(x: number, y: number): number {
  let s = 0;
  let a = 1;
  let f = 1;
  let n = 0;
  for (let o = 0; o < 4; o++) {
    s += vnoise(x * f, y * f) * a;
    n += a;
    a *= 0.5;
    f *= 2.07;
  }
  return s / n;
}

function makeCanvas(s: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = c.height = s;
  return [c, c.getContext("2d")!];
}

// subtle albedo grain that multiplies the per-instance terrain colour
export function makeDetailTexture(): THREE.CanvasTexture {
  const S = 96;
  const [c, ctx] = makeCanvas(S);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const n = fbm(x * 0.13, y * 0.13);
      const m = fbm(x * 0.55 + 40, y * 0.55 + 40);
      const v = Math.floor(206 + n * 40 + m * 9); // ~206..255, low contrast
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.min(255, v);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// micro relief for the blocks
export function makeBumpTexture(): THREE.CanvasTexture {
  const S = 96;
  const [c, ctx] = makeCanvas(S);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const n = fbm(x * 0.22 + 7, y * 0.22 + 7);
      const v = Math.floor(40 + n * 215);
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// light, slightly green blades on transparent; instanceColor tints them
export function makeGrassTexture(): THREE.CanvasTexture {
  const S = 64;
  const [c, ctx] = makeCanvas(S);
  ctx.clearRect(0, 0, S, S);
  const blades = 6;
  for (let k = 0; k < blades; k++) {
    const baseX = 8 + Math.random() * (S - 16);
    const w = 2 + Math.random() * 3;
    const h = 26 + Math.random() * 30;
    const lean = (Math.random() - 0.5) * 16;
    const g = ctx.createLinearGradient(0, S, 0, S - h);
    g.addColorStop(0, "#9fc77f");
    g.addColorStop(1, "#e7f3d6");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(baseX - w, S);
    ctx.lineTo(baseX + w, S);
    ctx.quadraticCurveTo(baseX + lean, S - h * 0.6, baseX + lean, S - h);
    ctx.quadraticCurveTo(baseX + lean, S - h * 0.6, baseX - w, S);
    ctx.closePath();
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// scrolling ripple normals-as-bump for the sea
export function makeWaterBump(): THREE.CanvasTexture {
  const S = 128;
  const [c, ctx] = makeCanvas(S);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const n =
        Math.sin(x * 0.2 + Math.sin(y * 0.13) * 2) * 0.5 +
        Math.sin(y * 0.17 + Math.sin(x * 0.11) * 2) * 0.5;
      const v = Math.floor(128 + n * 60 + fbm(x * 0.1, y * 0.1) * 40);
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, v));
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(8, 8);
  return t;
}

// warm high-plains sky: a golden dawn horizon under a deep blue dome, with a
// hot sun bloom. sunU in [0,1] is the horizontal position of the sun.
export function makeSkyTexture(sunU: number): THREE.CanvasTexture {
  const W = 1024;
  const H = 512;
  const [c, ctx] = makeCanvas(W);
  c.height = H;

  const grd = ctx.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0.0, "#0c1424"); // zenith - deep night blue
  grd.addColorStop(0.3, "#1c2c46"); // upper blue
  grd.addColorStop(0.44, "#4a4a58"); // mid haze
  grd.addColorStop(0.49, "#b06a3a"); // amber horizon
  grd.addColorStop(0.51, "#f5b25c"); // hot gold horizon band
  grd.addColorStop(0.55, "#8a4e30"); // just below horizon
  grd.addColorStop(0.78, "#3a2a24");
  grd.addColorStop(1.0, "#201a18");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);

  // warm glow across the whole horizon - dust hanging in the dawn light
  ctx.globalCompositeOperation = "lighter";
  const band = ctx.createLinearGradient(0, H * 0.4, 0, H * 0.56);
  band.addColorStop(0, "rgba(245,178,92,0)");
  band.addColorStop(0.5, "rgba(245,178,92,0.28)");
  band.addColorStop(1, "rgba(200,110,60,0)");
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, W, H);

  // a faint neon-green aurora above the horizon - the herd's colour in the sky
  const aur = ctx.createLinearGradient(0, H * 0.28, 0, H * 0.46);
  aur.addColorStop(0, "rgba(57,255,100,0)");
  aur.addColorStop(0.6, "rgba(57,255,100,0.09)");
  aur.addColorStop(1, "rgba(57,255,100,0)");
  ctx.fillStyle = aur;
  ctx.fillRect(0, 0, W, H);

  // localised hot sun bloom
  const sx = sunU * W;
  const sy = H * 0.485;
  const sun = ctx.createRadialGradient(sx, sy, 0, sx, sy, W * 0.24);
  sun.addColorStop(0, "rgba(255,244,220,0.95)");
  sun.addColorStop(0.18, "rgba(255,204,120,0.5)");
  sun.addColorStop(1, "rgba(220,140,70,0)");
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, W, H);
  // mirror a faint bloom on the wrap seam so it tiles cleanly
  const sx2 = sx > W / 2 ? sx - W : sx + W;
  const sun2 = ctx.createRadialGradient(sx2, sy, 0, sx2, sy, W * 0.24);
  sun2.addColorStop(0, "rgba(255,244,220,0.55)");
  sun2.addColorStop(1, "rgba(220,140,70,0)");
  ctx.fillStyle = sun2;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = "source-over";

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}
