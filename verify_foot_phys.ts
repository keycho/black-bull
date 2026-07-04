// pure-node physics proof for the ON-FOOT controller (no browser, no renderer).
// bundled by esbuild so it can import the real src/rider.ts, then run under node.
// a flat voxel floor + a dom shim let the Rider run headless; we drive it exactly
// as main.ts does (activate -> hold W -> jump onto a bounce pad) and assert the
// dismount hop, on-foot running, and the bull-back bounce all behave.

// --- dom shim: Rider's constructor registers window listeners; capture them ---
const handlers: Record<string, Array<(e: any) => void>> = {};
(globalThis as any).window = {
  addEventListener: (type: string, fn: (e: any) => void) => {
    (handlers[type] ||= []).push(fn);
  },
};
(globalThis as any).document = { pointerLockElement: null, activeElement: null };
const press = (code: string) => handlers["keydown"]?.forEach((fn) => fn({ code, preventDefault() {} }));
const release = (code: string) => handlers["keyup"]?.forEach((fn) => fn({ code }));

import * as THREE from "three";
import { Rider } from "./src/rider";

// flat solid ground with its top surface at y = G (well above sea level so the
// water-shove path never triggers). blocks fill every cell below G.
const G = 20;
const world: any = {
  voxels: {
    surfaceBelow: (_x: number, _z: number, _from: number) => G,
    isSolid: (_cx: number, cy: number, _cz: number) => cy < G,
    solidAtWorld: (_x: number, y: number, _z: number) => y < G,
  },
};

const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 600);
const rider = new Rider(world, camera);
rider.setInputGate(() => true);

const DT = 1 / 60;
const step = (n: number) => { for (let i = 0; i < n; i++) rider.update(DT); };

let ok = true;
const check = (name: string, cond: boolean, detail: string) => {
  console.log((cond ? "  ok   " : "  FAIL ") + name + " - " + detail);
  if (!cond) ok = false;
};

// --- 1. dismount: activate drops us on foot with a little hop ---
rider.activate(0, 0, 0, 0); // (x, z, yaw, camYaw)
check("activate/hop", rider.active && rider.vel.y > 3, `active=${rider.active} vel.y=${rider.vel.y.toFixed(2)}`);

// settle onto the ground
step(45);
check("lands on foot", rider.grounded && Math.abs(rider.pos.y - G) < 0.3, `grounded=${rider.grounded} y=${rider.pos.y.toFixed(2)}`);

// --- 2. run on foot: hold W ~2s, expect real horizontal displacement ---
const p0 = rider.pos.clone();
press("KeyW");
step(120);
release("KeyW");
step(5);
const moved = Math.hypot(rider.pos.x - p0.x, rider.pos.z - p0.z);
check("runs on foot", moved > 5, `movedXZ=${moved.toFixed(2)} (top speed seen=${rider.speed.toFixed(2)})`);

// let it coast to a stop before the jump
step(40);

// --- 3. bounce: with a bull back under us, a jump-then-descend launches higher
//        than any plain jump could reach ---
rider.bounceUnder = () => ({ vy: rider.bounceUp() });
const groundY = rider.pos.y;
press("Space");
step(1); // leaves the ground at JUMP
release("Space");
let sawBounce = false;
let peak = -1e9;
for (let i = 0; i < 180; i++) {
  rider.update(DT);
  if (rider.bouncedThisFrame) sawBounce = true;
  peak = Math.max(peak, rider.pos.y);
}
// a normal jump (JUMP 9.6, gravity 24) peaks ~1.9m up; a bounce (14.5) peaks ~4.4m.
const rise = peak - groundY;
check("bounce fires", sawBounce, `bouncedThisFrame seen=${sawBounce}`);
check("bounce launches high", rise > 3.0, `rise=${rise.toFixed(2)}m (plain jump would be ~1.9m)`);

console.log(ok ? "\nPASS: on-foot physics (dismount, run, bounce) all verified" : "\nFAIL: on-foot physics");
process.exit(ok ? 0 : 1);
