// black bull - boot + the frame loop + all the wiring. every system is built
// here and connected through callbacks, so the dependency graph is explicit:
//
//   world (voxel continent) -> bull (local controller) -> impacts (this file)
//   net (presence + broadcast) -> remotebulls / npcs / events (shared state)
//   momentum + cosmetics (progression) -> hud / minimap / audio (presentation)
//
// impact resolution lives here: the local client detects its own rams (it is
// authoritative for its own bull), tells the victim over the wire, and the
// victim applies the shove to itself. npc rams are arbitrated by the host.

import * as THREE from "three";
import { audio } from "./audio";
import { Bull } from "./bull";
import { BullModel } from "./bullmodel";
import { Chat } from "./chat";
import { Cinematic } from "./cinematic";
import {
  ALPHA_MIN,
  GALLOP,
  GRID,
  HIT_RADIUS,
  KB_BASE,
  KB_MAX,
  KB_SCALE,
  KB_UP,
  KILL_CREDIT_S,
  M_BEAR,
  M_GOLDEN,
  M_KING_BOUNTY,
  M_RAM_MAX,
  M_RAM_MIN,
  M_WHITE,
  M_WHITE_HIT,
  M_WILD,
  M_WIPEOUT,
  RAM_SPEED_MIN,
  SELF_SLOW,
  STAMPEDE_MULT,
  STAMPEDE_SPEED,
  WORLD,
} from "./config";
import { CATALOG } from "./cosmetics";
import { Duel } from "./duel";
import { Earn, EARN } from "./earn";
import { Events, EVENT_TITLES, type EventKind } from "./events";
import { fx } from "./feedback";
import { Flow, pickSpawn } from "./flow";
import { Hud } from "./hud";
import { Minimap } from "./minimap";
import { Momentum, type Stats } from "./momentum";
import { Net, type RemoteState, ST } from "./net";
import { NPC_BEAR, NPC_GOLDEN, NPC_WHITE, NPC_WILD, NpcManager } from "./npc";
import { Particles, Shake } from "./particles";
import { RemoteBulls } from "./remotebulls";
import { Rider } from "./rider";
import { RiderModel } from "./ridermodel";
import { makeSkyTexture } from "./textures";
import { BIOME_NAMES } from "./voxels";
import { buildWorld, type World } from "./world";
import { WowUI, type TargetInfo } from "./wowui";

// ---------------------------------------------------------------------------
// renderer
// ---------------------------------------------------------------------------
const canvas = document.getElementById("scene") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.04;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();

const BASE_FOV = 72;
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 600);
scene.add(camera);
fx.attach(camera); // toasts + world-anchored floating text project through it

// ---------------------------------------------------------------------------
// sky + atmosphere: a warm high-plains dawn
// ---------------------------------------------------------------------------
const sunDir = new THREE.Vector3(0.5, 0.3, -0.62).normalize();
const sunU = Math.atan2(sunDir.z, sunDir.x) / (Math.PI * 2) + 0.5;

const skyTex = makeSkyTexture(sunU);
scene.background = skyTex;
scene.environment = skyTex;
scene.environmentIntensity = 0.42;

// warm dust haze for depth; far plane kept moderate so the huge battlefield
// stays cheap - only chunks within this radius render, the rest fading out.
const fog = new THREE.Fog(0x9a7350, 50, 330);
scene.fog = fog;

const sun = new THREE.DirectionalLight(0xffeed8, 2.1);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 300;
const SH = 62; // local shadow frustum follows the player -> crisp shadows anywhere
sun.shadow.camera.left = -SH;
sun.shadow.camera.right = SH;
sun.shadow.camera.top = SH;
sun.shadow.camera.bottom = -SH;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 1.0;
scene.add(sun);
scene.add(sun.target);
const SUN_DIST = 140;

scene.add(new THREE.HemisphereLight(0xd8c8a8, 0x2a2018, 0.6));

const rim = new THREE.DirectionalLight(0xd6742c, 0.3);
rim.position.set(-WORLD * 0.4, WORLD * 0.3, WORLD * 0.4);
scene.add(rim);

// ---------------------------------------------------------------------------
// world + core systems
// ---------------------------------------------------------------------------
const world: World = buildWorld();
scene.add(world.group);

const shake = new Shake();
const particles = new Particles(scene);

const spawn0 = pickSpawn(world);
const bull = new Bull(world, camera, spawn0.x, spawn0.z, spawn0.yaw);
const bullModel = new BullModel(scene, true);

// on-foot mode: hop off your bull (c) and run around, bouncing off any bull's
// back for big air. the rider owns its own controller + model + chase camera;
// while on foot the bull is PARKED (riderless, idling) at `parked` and the
// local player IS the rider. `mode` is the master switch main branches on.
const rider = new Rider(world, camera);
const riderModel = new RiderModel(scene);
let mode: "ride" | "foot" = "ride";
const parked = new THREE.Vector3(); // where the bull waits while you are on foot

const momentum = new Momentum();
const hud = new Hud();
// world of warcraft-style hud overlay (player + target frames, xp bar, action
// bar, bags, minimap ring). driven each frame from the same game state.
const wow = new WowUI();
// herd points: the $ansem earn ledger (economic only, never gameplay).
// declared before flow exists, so the gate reads through a late binding.
let earnCanUse: () => boolean = () => false;
const earn = new Earn({ canUse: () => earnCanUse() });

// networking (no-op without supabase env; solo = host-of-one)
const net = new Net();
net.onRemoteEdit = (x, y, z, type) => world.voxels.applyRemoteEdit(x, y, z, type);
net.connect();
const remoteBulls = new RemoteBulls(scene, net, particles);
const npcs = new NpcManager(scene, world, net, particles);
// parked remote bulls sit on the terrain, so remote rendering needs ground height
remoteBulls.groundY = (x, z) => world.voxels.surfaceBelow(x, z, 80);

// bounce: on foot, descending onto ANY bull's back launches you skyward. the
// candidates are your own parked bull, every remote rider's bull (mounted or
// parked), and every npc in the herd - so you can chain hops across a stampede.
const BOUNCE_R = 1.7; // horizontal reach onto a back
const BULL_BACK = 1.6; // a bull's back sits ~this far above its base
rider.bounceUnder = (x, z, feetY) => {
  const onBack = (bx: number, by: number, bz: number) =>
    Math.hypot(x - bx, z - bz) <= BOUNCE_R && feetY >= by + 0.5 && feetY <= by + BULL_BACK + 0.9;
  if (onBack(parked.x, parked.y, parked.z)) return { vy: rider.bounceUp() };
  for (const [id, r] of net.remotes) {
    if (!r.inWorld) continue;
    const p = remoteBulls.posOf(id); // interpolated bull pos (parked pos when they are on foot)
    const bx = p ? p.x : r.foot ? r.bx : r.x;
    const by = p ? p.y : r.y;
    const bz = p ? p.z : r.foot ? r.bz : r.z;
    if (onBack(bx, by, bz)) return { vy: rider.bounceUp() };
  }
  for (const n of npcs.list()) if (onBack(n.pos.x, n.pos.y, n.pos.z)) return { vy: rider.bounceUp() };
  return null;
};
rider.onBounce = (x, y, z, power) => {
  particles.impact(x, y, z, 0.35 + power * 0.4, 0x21c07a);
  shake.add(0.1 + power * 0.18);
  audio.launch(0.35 + power * 0.4);
  riderModel.landPulse();
};
rider.onLand = (impact) => {
  particles.hoofDust(rider.pos.x, rider.pos.y, rider.pos.z, rider.yaw, impact, 1.0);
  shake.add(Math.min(0.22, impact * 0.018));
  riderModel.landPulse();
};

// ---------------------------------------------------------------------------
// spatial audio helper: pan + gain for a world point, relative to the camera
// ---------------------------------------------------------------------------
function panGain(x: number, z: number, range = 130): { pan: number; gain: number } {
  const lx = mode === "foot" ? rider.pos.x : bull.pos.x;
  const lz = mode === "foot" ? rider.pos.z : bull.pos.z;
  const cy = mode === "foot" ? rider.camYaw : bull.camYaw;
  const dx = x - lx;
  const dz = z - lz;
  const dist = Math.hypot(dx, dz);
  const ang = Math.atan2(dx, -dz) - cy; // camera-relative bearing
  return { pan: Math.max(-1, Math.min(1, Math.sin(ang))), gain: Math.max(0, 1 - dist / range) };
}

// ---------------------------------------------------------------------------
// impact resolution
// ---------------------------------------------------------------------------
let lastHitBy = ""; // who last rammed us (wipeout credit)
let lastHitAt = -1e9;
const hitCooldown = new Map<string, number>(); // victim id -> earliest next hit (s)
let clock = 0;

// the local bull rammed someone / something: shared juice
function ramJuice(px: number, py: number, pz: number, power: number) {
  particles.impact(px, py, pz, power);
  shake.add(0.25 + power * 0.45);
  audio.impact(power);
  hud.flash(0.12 + power * 0.25, "255,220,160");
}

function tryLocalRams() {
  if (!bull.ramming) return;
  const speed = bull.speed;
  const power01 = Math.min(1, speed / STAMPEDE_SPEED);

  // vs other riders
  for (const [id, r] of net.remotes) {
    if (!r.inWorld || r.st === ST.ko) continue;
    const rp = remoteBulls.posOf(id);
    const rx = rp ? rp.x : r.x;
    const ry = rp ? rp.y : r.y;
    const rz = rp ? rp.z : r.z;
    const dx = rx - bull.pos.x;
    const dy = ry - bull.pos.y;
    const dz = rz - bull.pos.z;
    if (Math.abs(dy) > 2.4) continue;
    const dist = Math.hypot(dx, dz);
    if (dist > HIT_RADIUS) continue;
    if ((hitCooldown.get(id) ?? 0) > clock) continue;
    // only a hit if we are actually moving INTO them
    const nx = dx / (dist || 1);
    const nz = dz / (dist || 1);
    const closing = bull.vel.x * nx + bull.vel.z * nz;
    if (closing < RAM_SPEED_MIN * 0.55) continue;
    hitCooldown.set(id, clock + 0.8);
    const kb = Math.min(KB_MAX, (KB_BASE + (closing - RAM_SPEED_MIN) * KB_SCALE) * momentum.powerMult);
    const px = bull.pos.x + nx * 1.1;
    const pz2 = bull.pos.z + nz * 1.1;
    net.sendRam(id, nx, nz, kb, KB_UP, px, bull.pos.y + 0.8, pz2);
    bull.confirmedHit(SELF_SLOW);
    ramJuice(px, bull.pos.y + 0.8, pz2, power01);
    momentum.award(M_RAM_MIN + (M_RAM_MAX - M_RAM_MIN) * power01);
    momentum.noteRam();
    earn.award(EARN.ram);
    // in a duel, a ram on the opponent also drains their stamina (the knockback
    // above still fires - the shove IS the fight's texture)
    if (duel.isOpp(id)) duel.dealRam(power01);
    fx.damage(rx, ry + 2.4, rz, Math.round(kb), kb > 30);
  }

  // vs npcs (host arbitrates the kill/claim; whites take several hits)
  for (const n of npcs.list()) {
    const dx = n.pos.x - bull.pos.x;
    const dz = n.pos.z - bull.pos.z;
    if (Math.abs(n.pos.y - bull.pos.y) > 2.4) continue;
    const dist = Math.hypot(dx, dz);
    if (dist > HIT_RADIUS + 0.2) continue;
    const key = "n" + n.id;
    if ((hitCooldown.get(key) ?? 0) > clock) continue;
    const nx = dx / (dist || 1);
    const nz = dz / (dist || 1);
    if (bull.vel.x * nx + bull.vel.z * nz < RAM_SPEED_MIN * 0.55) continue;
    hitCooldown.set(key, clock + 0.8);
    npcs.ramNpc(n.id, power01, nx, nz);
    bull.confirmedHit(0.75); // npcs barely slow a stampede
    ramJuice(n.pos.x, n.pos.y + 0.8, n.pos.z, power01 * 0.8);
    if (n.ty === NPC_WHITE) {
      // landing a charge on the hostile herd pays per hit; the break pays more
      momentum.award(M_WHITE_HIT);
      momentum.noteRam();
      earn.award(EARN.whiteHit);
      fx.damage(n.pos.x, n.pos.y + 2.4, n.pos.z, M_WHITE_HIT, false);
    }
  }

  // vs the wild herd of... nothing else. walls handle themselves.
}

// gentle push-apart so idle bulls never interpenetrate (no ram, just shoulder)
function softSeparation(dt: number) {
  if (!bull.isLive) return;
  for (const [id, r] of net.remotes) {
    if (!r.inWorld || r.st === ST.ko) continue;
    const rp = remoteBulls.posOf(id);
    const rx = rp ? rp.x : r.x;
    const rz = rp ? rp.z : r.z;
    const dx = bull.pos.x - rx;
    const dz = bull.pos.z - rz;
    const d = Math.hypot(dx, dz);
    if (d > 0.05 && d < 1.5 && Math.abs((rp ? rp.y : r.y) - bull.pos.y) < 2) {
      bull.pos.x += (dx / d) * 2.4 * dt;
      bull.pos.z += (dz / d) * 2.4 * dt;
    }
  }
}

// someone rammed US: apply the shove locally (we own our bull)
net.onRam = (from, dx, dz, kb, up, px, py, pz, npc) => {
  if (flow.stage !== "playing") return;
  if (mode === "foot") {
    // on foot you get bowled over instead of shoved on your bull
    rider.knock(dx, dz, Math.min(kb, KB_MAX) * 0.5, up * 0.55);
  } else {
    if (!bull.canBeHit) return;
    bull.applyKnockback(dx, dz, kb, up);
    momentum.hitTaken();
  }
  if (!npc) {
    lastHitBy = from;
    lastHitAt = clock;
  }
  wow.damage(0.1 + (Math.min(kb, KB_MAX) / KB_MAX) * 0.28);
  particles.impact(px, py, pz, Math.min(1, kb / KB_MAX));
  shake.add(0.35 + (kb / KB_MAX) * 0.5);
  audio.impact(Math.min(1, kb / KB_MAX));
  hud.flash(0.3, "255,90,60");
};
// a ram we merely witness: play it where it happened
net.onRemoteRamFx = (px, py, pz, kb) => {
  particles.impact(px, py, pz, Math.min(1, kb / KB_MAX) * 0.8);
  const { pan, gain } = panGain(px, pz);
  if (gain > 0.02) audio.impact(Math.min(1, kb / KB_MAX), pan, gain);
};

// someone announced their wipeout: credit + feed + king bounty
net.onKo = (id, by, x, y, z) => {
  const name = net.remotes.get(id)?.name ?? "a rider";
  particles.debris(x, y, z, 8, 0x8a7a5e);
  if (by === net.id) {
    momentum.award(M_WIPEOUT);
    momentum.noteWipeoutCaused();
    earn.award(EARN.wipeout);
    fx.toast(`you wiped out ${name}`, "kill");
    fx.killPop(x, y + 2, z, M_WIPEOUT);
    if (events.kingId && id === events.kingId) {
      momentum.award(M_KING_BOUNTY);
      momentum.noteEventWin();
      earn.award(EARN.eventWin);
      fx.toast(`king down · +${M_KING_BOUNTY} valor`, "wave");
      audio.unlock();
    }
  } else if (id === events.kingId) {
    fx.toast(`the king was brought down`, "wave");
  }
};
net.onRoar = (id) => {
  const r = net.remotes.get(id);
  if (!r) return;
  const { pan, gain } = panGain(r.x, r.z, 170);
  audio.roar(pan, Math.max(0.15, gain), r.cos.crown === 1);
};

// ---------------------------------------------------------------------------
// the local bull's physics callbacks
// ---------------------------------------------------------------------------
bull.onLaunch = (c) => {
  audio.chargeOff();
  audio.launch(c);
  shake.add(0.12 + c * 0.2);
  particles.impact(bull.pos.x, bull.pos.y, bull.pos.z, c * 0.4, 0x8a7a5e);
};
bull.onWhiff = () => {
  audio.snort();
  fx.toast("winded - you missed", "warn");
};
bull.onWallSlam = (speed) => {
  const s01 = Math.min(1, speed / STAMPEDE_SPEED);
  audio.wallThud(s01);
  shake.add(0.2 + s01 * 0.3);
  particles.impact(bull.pos.x, bull.pos.y + 0.5, bull.pos.z, s01 * 0.7, 0x8a8078);
};
bull.onLandHard = (impact) => {
  shake.add(Math.min(0.4, impact * 0.012));
  particles.hoofDust(bull.pos.x, bull.pos.y, bull.pos.z, bull.yaw, impact, 1.6);
};
bull.onHazard = (kind) => wipeoutLocal(kind === "water" ? "you went into the water" : "you were cooked on the lava");

function wipeoutLocal(reason: string) {
  if (!bull.isLive) return;
  audio.chargeOff();
  bull.wipeout();
  momentum.wipeout();
  wow.setDead(true);
  hud.showKo(reason);
  audio.wipeout();
  const by = clock - lastHitAt < KILL_CREDIT_S ? lastHitBy : "";
  net.sendKo(by, bull.pos.x, bull.pos.y, bull.pos.z);
  lastHitBy = "";
  // if the king wipes out while we are the king, the crown bounty is lost
}

// npc kills/claims confirmed by the host: award whoever earned it
npcs.onGone = (ty, by, x, y, z) => {
  particles.impact(x, y, z, 0.6, ty === NPC_GOLDEN ? 0xd6a129 : 0x8a6a44);
  if (ty === NPC_GOLDEN) particles.sparkle(x, y, z, 22);
  if (by !== net.id) return;
  if (ty === NPC_GOLDEN) {
    momentum.award(M_GOLDEN);
    momentum.noteGolden();
    earn.award(EARN.golden);
    audio.golden();
    fx.toast(`golden bull claimed · +${M_GOLDEN} valor`, "good");
    fx.killPop(x, y + 2, z, M_GOLDEN);
  } else if (ty === NPC_BEAR) {
    momentum.award(M_BEAR);
    momentum.noteBear();
    earn.award(EARN.bear);
    fx.toast(`bear launched · +${M_BEAR} valor`, "kill");
    fx.killPop(x, y + 2, z, M_BEAR);
  } else if (ty === NPC_WHITE) {
    momentum.award(M_WHITE);
    momentum.noteWhite();
    earn.award(EARN.whiteBreak);
    audio.impact(1);
    fx.toast(`white bull broken · +${M_WHITE} valor`, "kill");
    fx.killPop(x, y + 2, z, M_WHITE);
  } else if (ty === NPC_WILD) {
    momentum.award(M_WILD);
    fx.killPop(x, y + 2, z, M_WILD);
  }
};
npcs.onLocalShove = (dx, dz, kb, up) => {
  if (flow.stage !== "playing") return;
  if (mode === "foot") {
    rider.knock(dx, dz, kb * 0.5, up * 0.55);
  } else {
    if (!bull.canBeHit) return;
    bull.applyKnockback(dx, dz, kb, up);
    momentum.hitTaken();
  }
  wow.damage(0.14);
  shake.add(0.3);
  audio.impact(0.4);
  hud.flash(0.25, "255,90,60");
};
npcs.getPlayers = () => {
  const list: { id: string; x: number; y: number; z: number; local: boolean }[] = [];
  // on foot the rider IS the local target; the parked bull is not
  if (flow.stage === "playing") {
    if (mode === "foot") list.push({ id: net.id, x: rider.pos.x, y: rider.pos.y, z: rider.pos.z, local: true });
    else if (bull.isLive) list.push({ id: net.id, x: bull.pos.x, y: bull.pos.y, z: bull.pos.z, local: true });
  }
  for (const [id, r] of net.remotes) if (r.inWorld && r.st !== ST.ko) list.push({ id, x: r.x, y: r.y, z: r.z, local: false });
  return list;
};

// ---------------------------------------------------------------------------
// world events
// ---------------------------------------------------------------------------
const events = new Events({
  net,
  world,
  fx: particles,
  shake,
  scene,
  npcs,
  localPos: () => (mode === "foot" ? rider.pos : bull.pos),
  inWorldIds: () => {
    const ids: string[] = [];
    if (flow.stage === "playing") ids.push(net.id);
    for (const [id, r] of net.remotes) if (r.inWorld) ids.push(id);
    return ids;
  },
  knockLocal: (dx, dz, kb, up) => {
    if (flow.stage !== "playing") return;
    if (mode === "foot") {
      rider.knock(dx, dz, kb * 0.5, up * 0.55);
    } else {
      if (!bull.canBeHit) return;
      bull.applyKnockback(dx, dz, kb, up);
    }
    wow.damage(0.12);
    hud.flash(0.3, "255,180,120");
  },
  toast: (t, k) => fx.toast(t, (k as never) ?? "info"),
  onBanner: (title, sub) => {
    hud.showBanner(title, sub);
    audio.blip(true);
  },
  onEventStart: (k) => {
    if (k === "king" && events.kingId === net.id) fx.toast("you are the king bull - survive", "wave");
  },
  onEventEnd: (k, data) => {
    hud.clearBanner();
    if (k === "king" && data && data === net.id && bull.isLive) {
      momentum.award(M_KING_BOUNTY);
      momentum.noteEventWin();
      earn.award(EARN.eventWin);
      fx.toast(`you survived as king · +${M_KING_BOUNTY} valor`, "wave");
      audio.unlock();
    } else {
      fx.toast(`${EVENT_TITLES[k]} over`, "info");
    }
  },
  onKing: (id) => {
    if (id && id !== net.id) {
      const name = net.remotes.get(id)?.name ?? "a rider";
      fx.toast(`${name} is the king bull - hunt them`, "wave");
    }
  },
  sfx: {
    warn: () => audio.eventWarn(),
    thunder: (d) => audio.thunder(d),
    meteor: (d) => audio.meteorBoom(d),
    rumble: (on) => audio.rumble(on),
  },
});

// ---------------------------------------------------------------------------
// front-door flow + presence
// ---------------------------------------------------------------------------
const loaderEl = document.getElementById("loader");
const lockEl = document.getElementById("lock-prompt") as HTMLElement;
const netEl = document.getElementById("net-status");
const fpsEl = document.getElementById("fps-hud");
const fpsNumEl = fpsEl?.querySelector(".fps-num") as HTMLElement | null;

function syncLockUI(stage: string) {
  const locked = !!document.pointerLockElement;
  // in fallback-controls mode (pointer lock unavailable) the prompt stays away
  lockEl?.classList.toggle("hidden", locked || stage !== "playing" || bull.lockBroken);
}
let howtoShown = false;
function syncStageUI(stage: string) {
  document.body.classList.toggle("playing", stage === "playing");
  hud.setVisible(stage === "playing");
  audio.setStage(stage);
  syncLockUI(stage);
  // teach the fight on the first ride
  if (stage === "playing" && !howtoShown) {
    howtoShown = true;
    const el = document.getElementById("howto");
    el?.classList.add("show");
    window.setTimeout(() => el?.classList.remove("show"), 24000);
  }
}

const flow = new Flow({
  camera,
  bull,
  bullModel,
  world,
  fog,
  stats: () => momentum.stats,
  onStageChange: syncStageUI,
  onJoin: (name, cos) => net.join(name, cos),
  onLookChange: (name, cos) => net.updateLook(name, cos),
});

lockEl?.addEventListener("click", () => bull.requestLock());
document.addEventListener("pointerlockchange", () => syncLockUI(flow.stage));

// the controls panel inside the lock prompt swallows its own clicks
const lockInnerEl = document.getElementById("lock-inner");
const lockToggleEl = document.getElementById("lock-controls-toggle");
const lockPanelEl = document.querySelector(".lock-ctrls-panel");
lockToggleEl?.addEventListener("click", (e) => {
  e.stopPropagation();
  lockInnerEl?.classList.toggle("controls-open");
});
lockPanelEl?.addEventListener("click", (e) => e.stopPropagation());

// unlock celebration: when a stat change opens a new cosmetic, say so
function countUnlocked(stats: Stats): number {
  let n = 0;
  for (const o of CATALOG) if (o.unlocked(stats)) n++;
  return n;
}
let unlockedCount = -1;
momentum.onUnlockCheck = () => {
  const now = countUnlocked(momentum.stats);
  if (unlockedCount >= 0 && now > unlockedCount) {
    fx.toast("new cosmetic unlocked - check the stable", "good");
    audio.unlock();
    flow.rebuildSlots();
  }
  unlockedCount = now;
};
momentum.onUnlockCheck();

// momentum tier celebrations
let lastTier = 0;
momentum.onChange = (_v, tier) => {
  if (tier > lastTier) {
    audio.tierUp();
    earn.award(EARN.tierUp);
    fx.toast(`valor rank up`, "good");
  }
  lastTier = tier;
};

// the earn panel opens in-world (g or the chip); bull input pauses while open
earnCanUse = () => flow.stage === "playing" && !inCinematic();

// cinematic flythrough for clips: k toggles, escape cancels
const cine = new Cinematic({
  camera,
  fog,
  groundAt: (x, z) => world.voxels.surfaceBelow(x, z, 80),
});
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  const a = document.activeElement;
  if (a && /input|textarea|select/i.test(a.tagName)) return;
  if (e.code === "KeyK") {
    if (cine.active || flow.stage === "playing") cine.toggle();
  } else if (e.code === "Escape" && cine.active) {
    cine.stop();
  } else if (e.code === "KeyC" && flow.stage === "playing" && !cine.active && !earn.isOpen) {
    toggleFoot();
  } else if (e.code === "KeyR" && flow.stage === "playing" && mode === "ride" && bull.isLive) {
    audio.roar(0, 1, flow.getLook().cos.crown === 1);
    net.sendRoar();
    shake.add(0.08);
  }
});
const inCinematic = () => cine.active;
bull.setInputGate(() => !cine.active && !earn.isOpen && mode === "ride");
rider.setInputGate(() => !cine.active && !earn.isOpen && mode === "foot");

// hop off / climb back on. dismount parks the bull where it stands and drops
// you on foot; remount whistles it back to your feet. blocked while ko'd.
function toggleFoot() {
  if (mode === "ride") {
    if (!bull.isLive) return;
    parked.set(bull.pos.x, world.voxels.surfaceBelow(bull.pos.x, bull.pos.z, 60), bull.pos.z);
    riderModel.setCosmetics(flow.getLook().cos);
    riderModel.setName(net.myName);
    rider.activate(bull.pos.x, bull.pos.z, bull.yaw, bull.camYaw);
    mode = "foot";
    audio.snort();
    fx.toast("on foot - wasd to run, space to jump, land on a bull to bounce, c to remount", "info");
  } else {
    rider.deactivate();
    bull.respawn(rider.pos.x, rider.pos.z, rider.yaw);
    mode = "ride";
    audio.blip(false);
    fx.toast("back in the saddle", "info");
  }
}

// pvp duels: challenge a nearby rider (u), fight with rams, climb the ladder (l).
// friendly only - no money, no wager. you keep riding your bull during the duel,
// so input is NOT gated; the ram just also drains the opponent's stamina.
const duel = new Duel({
  scene,
  net,
  bull,
  myName: () => net.myName,
  groundAt: (x, z) => world.voxels.surfaceBelow(x, z, 80),
  canUse: () => flow.stage === "playing" && !inCinematic() && !earn.isOpen,
});

// chat: enter to type, rides the public broadcast plane. in-world only, so
// enter in the stable deploys instead of fighting the chat for the key.
const chat = new Chat({
  canUse: () => flow.stage === "playing",
  inWorld: () => flow.stage === "playing",
  self: () => ({ name: net.myName, color: net.myColor }),
  send: (t) => net.sendChat(t),
});
net.onChat = (id, name, text) => {
  const r = net.remotes.get(id);
  chat.add(name, text, r ? [0xe23b3b, 0xf5c542, 0x3b82f6, 0x21c07a, 0x9b51e0, 0xf07b1b][r.cos.trim % 6] : 0xf0dcb4);
};

// read-only debug handle for automated playtests (?bbdebug in the url).
// exposes nothing a client does not already own - purely observational.
if (location.search.includes("bbdebug")) {
  (window as unknown as Record<string, unknown>).__bb = {
    state: () => ({
      id: net.id,
      stage: flow.stage,
      st: bull.state,
      locked: bull.locked,
      broken: bull.lockBroken,
      pos: [Math.round(bull.pos.x), Math.round(bull.pos.y), Math.round(bull.pos.z)],
      speed: Math.round(bull.speed * 10) / 10,
      charge: bull.charge01,
      m: momentum.value,
      mode,
      foot: [
        Math.round(rider.pos.x * 10) / 10,
        Math.round(rider.pos.y * 10) / 10,
        Math.round(rider.pos.z * 10) / 10,
        Math.round(rider.speed * 10) / 10,
      ],
      grounded: rider.grounded,
      bounced: rider.bouncedThisFrame,
      bearsNear: npcs.list().filter((n) => n.ty === NPC_BEAR && Math.hypot(n.pos.x - bull.pos.x, n.pos.z - bull.pos.z) < 60).length,
      bears: npcs
        .list()
        .filter((n) => n.ty === NPC_BEAR)
        .map((n) => [Math.round(n.pos.x), Math.round(n.pos.y), Math.round(n.pos.z)]),
      duel: { phase: duel.phase, oppId: duel.oppId },
    }),
    // test-only (debug-gated): simulate a second rider + the duel messages a
    // client would receive over realtime, so the full handshake can be driven
    // headlessly. injects nothing an honest client could not already receive.
    injectRemote: (id: string, x: number, z: number, name: string) => {
      net.remotes.set(id, {
        id, x, y: bull.pos.y, z, yaw: 0, st: 0, charge: 0, momentum: 0,
        name, cos: { coat: 0, trim: 0, horns: 0, eyes: 0, trail: 0, hooves: 0, armor: 0, crown: 0, rider: 0 },
        inWorld: true, foot: false, bx: x, bz: z, t: performance.now(),
      });
    },
    injectDuel: (m: Record<string, unknown>) => net.onDuel?.(m as never),
    // toggle on-foot mode (same as pressing c) - drives the headless foot proof
    dismount: () => toggleFoot(),
  };
}

// minimap: riders, npcs, alpha, king, event zone over the biome backdrop
let alphaId = "";
const minimap = new Minimap({
  self: () => (mode === "foot" ? { x: rider.pos.x, z: rider.pos.z, yaw: rider.camYaw } : { x: bull.pos.x, z: bull.pos.z, yaw: bull.camYaw }),
  selfColor: () => net.myColor,
  eachBull: (cb) => {
    for (const [id, r] of net.remotes) {
      if (!r.inWorld) continue;
      const color = [0xe23b3b, 0xf5c542, 0x3b82f6, 0x21c07a, 0x9b51e0, 0xf07b1b][r.cos.trim % 6];
      cb(r.x, r.z, color, r.name, id === alphaId, id === events.kingId);
    }
  },
  eachNpc: (cb) => npcs.eachNpc(cb),
  eventZone: () => events.zone,
  canExpand: () => flow.stage === "playing" && !inCinematic(),
  terrain: () => world.heights,
  biomes: () => world.voxels.biome,
});
let mmAccum = 0;

// ---------------------------------------------------------------------------
// render loop
// ---------------------------------------------------------------------------
let last = performance.now();
let landingFrames = 0;
let lockNoticeShown = false;
let bearAmbushToast = false;
let alphaEarnT = 0;
let fpsShown = true;
let fpsAccum = 0;
let fpsFrames = 0;
let fpsAvg = 60;
let lowPerfAudio = false;
const CAM_FAR_MAX = camera.far;
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyP" && !e.repeat) {
    fpsShown = !fpsShown;
    fpsEl?.classList.toggle("show", fpsShown);
  }
});

const shakeOff = new THREE.Vector3();
let gallopDist = 0;
let gallopHeavy = false;
let dustT = 0;
let wasCharging = false;

function frame(now: number) {
  const dt = (now - last) / 1000;
  last = now;
  clock += Math.min(dt, 0.1);

  const stage = flow.stage;
  const playing = stage === "playing";

  // perks + event multipliers feed the controller each frame
  bull.perkSpeed = momentum.speedMult;
  bull.eventSpeed = events.stampedeOn ? STAMPEDE_MULT : 1;

  if (playing && !inCinematic()) {
    if (mode === "foot") rider.update(dt);
    else bull.update(dt);
  }
  flow.update(dt, now);
  if (cine.active) cine.update(dt);

  // the "player" the world revolves around: your bull, or you on foot
  const focus = mode === "foot" ? rider.pos : bull.pos;
  const curSpeed = mode === "foot" ? rider.speed : bull.speed;

  // sun shadow follows the player
  sun.position.set(focus.x + sunDir.x * SUN_DIST, sunDir.y * SUN_DIST, focus.z + sunDir.z * SUN_DIST);
  sun.target.position.set(focus.x, 0, focus.z);
  sun.target.updateMatrixWorld();

  if (playing) {
    if (mode === "ride") {
      softSeparation(dt);
      tryLocalRams();
    }

    // the entry ambush announces itself the first time bears close in
    if (!bearAmbushToast) {
      for (const n of npcs.list()) {
        if (n.ty === NPC_BEAR && Math.hypot(n.pos.x - focus.x, n.pos.z - focus.z) < 45) {
          bearAmbushToast = true;
          fx.toast("bear ambush - ram them off", "warn");
          audio.eventWarn();
          break;
        }
      }
    }

    // respawn after the ko screen
    if (bull.state === "ko" && bull.koTimeLeft <= 0) {
      const sp = pickSpawn(world);
      bull.respawn(sp.x, sp.z, sp.yaw);
      wow.revive();
      hud.hideKo();
      fx.toast("back on your hooves", "info");
    }

    // survival trickle + alpha reign (the crown also pays herd points)
    momentum.tickSurvive(dt, bull.isLive);
    momentum.tickAlpha(dt, alphaId === net.id);
    if (alphaId === net.id) {
      alphaEarnT += dt;
      if (alphaEarnT >= 10) {
        alphaEarnT -= 10;
        earn.award(EARN.alphaTick);
      }
    } else {
      alphaEarnT = 0;
    }

    if (mode === "ride") {
      // local juice: gallop steps, dust, trails, charge fx
      const speed = bull.speed;
      if (bull.grounded && speed > 3) {
        gallopDist += speed * dt;
        const stride = 2.4 + speed * 0.08;
        if (gallopDist > stride) {
          gallopDist = 0;
          gallopHeavy = !gallopHeavy;
          audio.gallopStep(Math.min(1, 0.35 + speed / 30 + momentum.frac * 0.2), gallopHeavy);
        }
      }
      dustT -= dt;
      if (speed > 7 && bull.grounded && dustT <= 0) {
        dustT = 0.06;
        particles.hoofDust(bull.pos.x, bull.pos.y, bull.pos.z, bull.yaw, speed, 0.9 + momentum.frac * 1.3);
        const trail = flow.getLook().cos.trail;
        if (trail > 0 && speed > RAM_SPEED_MIN) particles.trail(bull.pos.x, bull.pos.y, bull.pos.z, trail);
      }
      const charging = bull.state === "charging";
      if (charging) {
        audio.chargeSet(bull.charge01);
        particles.chargeDust(bull.pos.x, bull.pos.y, bull.pos.z, bull.charge01);
        if (bull.charge01 >= 1) shake.floor(0.08); // trembling at full power
      } else if (wasCharging) {
        audio.chargeOff();
      }
      wasCharging = charging;
    } else {
      // on foot: light kicked-up dust while sprinting on the ground
      dustT -= dt;
      if (rider.grounded && rider.speed > 5 && dustT <= 0) {
        dustT = 0.09;
        particles.hoofDust(rider.pos.x, rider.pos.y, rider.pos.z, rider.yaw, rider.speed, 0.5);
      }
    }
  }

  // the local bull model mirrors the controller (always third person). on foot
  // it shows the bull PARKED + riderless where you left it, and the rider model
  // runs at your feet instead.
  if (stage === "playing") {
    bullModel.setVisible(true);
    if (mode === "foot") {
      bullModel.setRiderVisible(false);
      bullModel.update(dt, now, parked, bull.yaw, 0, "idle", 0);
      riderModel.setVisible(true);
      riderModel.update(dt, now, rider.pos, rider.yaw, rider.speed, rider.pose());
    } else {
      bullModel.setRiderVisible(true);
      riderModel.setVisible(false);
      bullModel.update(dt, now, bull.pos, bull.yaw, bull.speed, bull.pose(), bull.charge01);
    }
  } else {
    riderModel.setVisible(false);
  }
  bullModel.setMomentumTier(momentum.tier);

  // alpha election: highest momentum in the herd (min floor), crown for all
  let bestM = momentum.value;
  let bestId = flow.stage === "playing" ? net.id : "";
  for (const [id, r] of net.remotes) {
    if (r.inWorld && r.momentum > bestM) {
      bestM = r.momentum;
      bestId = id;
    }
  }
  const newAlpha = bestM >= ALPHA_MIN ? bestId : "";
  if (newAlpha !== alphaId) {
    alphaId = newAlpha;
    if (alphaId === net.id) fx.toast("you are the warlord - the world hunts you", "wave");
    else if (alphaId) fx.toast(`${net.remotes.get(alphaId)?.name ?? "a rider"} is the warlord`, "info");
  }
  remoteBulls.alphaId = alphaId;
  bullModel.setAlpha(playing && mode === "ride" && alphaId === net.id);

  // shared systems tick every frame
  npcs.update(dt, now);
  events.update(dt, now);
  duel.update(dt, now);
  if (playing && !inCinematic()) duel.updateProximity();
  particles.update(dt);
  fx.update(dt);
  hud.update(dt);

  // hud readouts
  let zoneName = "";
  if (playing) {
    hud.setCharge(bull.charge01, bull.state === "charging", bull.state === "winded");
    hud.setMomentum(momentum.value, momentum.tier, alphaId === net.id);
    const gi = Math.floor(focus.x + GRID / 2);
    const gj = Math.floor(focus.z + GRID / 2);
    if (gi >= 0 && gi < GRID && gj >= 0 && gj < GRID) {
      const b = world.voxels.biome[gi * GRID + gj];
      zoneName = b >= 0 ? BIOME_NAMES[b] : "open water";
      hud.setBiome(zoneName);
    }
  }
  if (events.current) hud.updateBanner(events.warnLeft, events.timeLeft, EVENT_TITLES[events.current as EventKind]);

  // world of warcraft hud: player + target frames, xp/level, action bar, minimap
  if (playing) {
    // the target is the warlord to hunt, else the nearest rival champion
    let target: TargetInfo | null = null;
    if (alphaId && alphaId !== net.id) {
      const r = net.remotes.get(alphaId);
      if (r && r.inWorld) target = { name: r.name || "a champion", classText: "warlord", hpFrac: 1, elite: true };
    }
    if (!target) {
      let bestD = 55 * 55;
      let br: RemoteState | null = null;
      for (const [, r] of net.remotes) {
        if (!r.inWorld || r.st === ST.ko) continue;
        const d = (r.x - focus.x) ** 2 + (r.z - focus.z) ** 2;
        if (d < bestD) { bestD = d; br = r; }
      }
      if (br) target = { name: br.name || "rival", classText: "rival champion", hpFrac: 1, elite: false };
    }
    wow.update(dt, {
      name: net.myName,
      charge: mode === "ride" ? bull.charge01 : 0,
      alive: bull.isLive,
      winded: bull.state === "winded",
      isWarlord: alphaId === net.id,
      zone: zoneName,
      online: net.onlineCount,
      stats: momentum.stats,
      target,
    });
  }

  // broadcast our bull (state code from the controller state)
  const stCode =
    bull.state === "charging" ? ST.charging
    : bull.state === "launched" ? ST.launched
    : bull.state === "stagger" ? ST.stagger
    : bull.state === "tumble" ? ST.tumble
    : bull.state === "winded" ? ST.winded
    : bull.state === "ko" ? ST.ko
    : ST.run;
  if (mode === "foot") {
    // on the wire: (x,y,z) is the rider, (bx,bz) is the parked bull
    net.setLocal(rider.pos.x, rider.pos.y, rider.pos.z, rider.yaw, ST.run, 0, momentum.value, playing, now, true, parked.x, parked.z);
  } else {
    net.setLocal(bull.pos.x, bull.pos.y, bull.pos.z, bull.yaw, stCode, bull.charge01, momentum.value, playing, now);
  }
  net.tick(now);
  remoteBulls.update(dt, now);

  // minimap + chat + status
  const mmShow = playing && !inCinematic();
  minimap.setVisible(mmShow);
  earn.setVisible(mmShow);
  wow.setVisible(mmShow);
  if (mmShow) {
    if (minimap.isOpen()) minimap.draw();
    else {
      mmAccum += dt;
      if (mmAccum >= 0.06) {
        mmAccum = 0;
        minimap.draw();
      }
    }
  }
  chat.setVisible(playing && !inCinematic());
  // pointer lock gave up somewhere along the way: tell the player once that
  // keyboard mode is on so the game never reads as "mouse does nothing"
  if (bull.lockBroken && !lockNoticeShown && playing) {
    lockNoticeShown = true;
    fx.toast("mouse lock unavailable - keyboard mode: a/d steer, hold f to charge", "warn");
    syncLockUI(stage);
  }
  if (netEl) {
    // always show the connection state in-world so "i'm alone" is never a
    // mystery: connected shows the live head-count, unconfigured shows solo.
    const showNet = stage === "stable" || playing;
    netEl.classList.toggle("show", showNet);
    netEl.classList.toggle("solo", !net.enabled);
    if (showNet) {
      netEl.textContent = net.enabled
        ? `herd · ${net.onlineCount} online${net.isHost ? " · host" : ""}`
        : "solo · no server configured";
    }
  }

  // adaptive music: events raise the floor; nearby bulls read as a brewing fight
  audio.setEventMood(events.active);
  let near = 0;
  for (const r of net.remotes.values()) {
    if (!r.inWorld) continue;
    const d = Math.hypot(r.x - bull.pos.x, r.z - bull.pos.z);
    if (d < 40) near += 1 - d / 40;
  }
  audio.setThreat(Math.min(1, near * 0.4 + (bull.state === "launched" ? 0.3 : 0)));

  // camera: fov kick with speed + shake offset
  const wantFov = BASE_FOV + (playing ? Math.min(14, Math.max(0, curSpeed - GALLOP) * 0.55) : 0);
  if (Math.abs(camera.fov - wantFov) > 0.1) {
    camera.fov += (wantFov - camera.fov) * Math.min(1, dt * 8);
    camera.updateProjectionMatrix();
  }
  camera.position.add(shake.offset(dt, shakeOff));

  // water shimmer
  world.waterBump.offset.x += dt * 0.03;
  world.waterBump.offset.y += dt * 0.018;

  // clamp the camera far plane to just past the fog wall
  const wantFar = Math.min(CAM_FAR_MAX, fog.far + 36);
  if (Math.abs(camera.far - wantFar) > 0.5) {
    camera.far = wantFar;
    camera.updateProjectionMatrix();
  }

  // fps meter + adaptive audio perf
  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    const fps = fpsFrames / fpsAccum;
    fpsAvg = fpsAvg * 0.5 + fps * 0.5;
    if (fpsShown && fpsNumEl) {
      fpsNumEl.textContent = String(Math.round(fps));
      if (fpsEl) fpsEl.dataset.lvl = fps >= 55 ? "good" : fps >= 38 ? "ok" : "bad";
    }
    if (!lowPerfAudio && fpsAvg < 45) {
      lowPerfAudio = true;
      audio.setPerfMode(true);
    } else if (lowPerfAudio && fpsAvg > 56) {
      lowPerfAudio = false;
      audio.setPerfMode(false);
    }
    fpsAccum = 0;
    fpsFrames = 0;
  }

  // the landing backdrop freezes after a few settled frames (gpu relief)
  if (stage === "landing") landingFrames++;
  else landingFrames = 0;
  if (stage !== "landing" || landingFrames <= 8) renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  landingFrames = 0;
});

// loading screen: the world is already generated by the time this runs. the
// lines read as an epic "world of warcraft" zone-in, and a rotating lore tip
// cycles beneath the progress bar.
const bootLog = document.getElementById("boot-log");
const bootBar = document.getElementById("boot-bar-fill");
const bootPct = document.getElementById("boot-pct");
const bootTip = document.getElementById("boot-tip");
const BOOT_LINES = [
  "waking the world",
  "raising the realms",
  "carving rivers and canyons",
  "building the arena",
  "gathering the wild herd",
  "loosing the world bosses",
  "opening the gates",
];
const LORE_TIPS = [
  "tip: hold to charge, release to ram. the longer the wind-up, the harder the hit.",
  "tip: knock foes into water, lava, or off a cliff for a swift end.",
  "tip: press u to challenge a nearby champion to a 1v1 duel.",
  "tip: world bosses telegraph before they charge. sidestep, then counter.",
  "tip: press c to dismount and run on foot. land on a mount's back to bounce sky-high.",
  "tip: the champion with the most valor becomes warlord - the whole world hunts them.",
  "tip: press r to roar, n for the world map, g for your renown.",
];
(function runBoot() {
  let i = 0;
  const total = BOOT_LINES.length + 1;
  const progress = (n: number) => {
    const pct = Math.round((n / total) * 100);
    if (bootBar) bootBar.style.width = pct + "%";
    if (bootPct) bootPct.textContent = pct + "%";
  };
  // rotate the lore tip while the world loads
  let tipI = Math.floor((performance.now() / 997) % LORE_TIPS.length);
  if (bootTip) bootTip.textContent = LORE_TIPS[tipI];
  const tipTimer = window.setInterval(() => {
    tipI = (tipI + 1) % LORE_TIPS.length;
    if (bootTip) {
      bootTip.style.opacity = "0";
      window.setTimeout(() => {
        bootTip.textContent = LORE_TIPS[tipI];
        bootTip.style.opacity = "0.82";
      }, 220);
    }
  }, 2600);
  const step = () => {
    if (i < BOOT_LINES.length) {
      const el = document.createElement("div");
      el.className = "boot-line";
      el.innerHTML = `<span><span class="b-arrow">›</span> ${BOOT_LINES[i]}</span><span class="b-ok">✦</span>`;
      bootLog?.appendChild(el);
      progress(++i);
      window.setTimeout(step, 130 + Math.random() * 110);
    } else {
      const el = document.createElement("div");
      el.className = "boot-line boot-done";
      el.innerHTML = `<span><span class="b-ok2">✦</span> the world awaits</span><span class="b-cursor"></span>`;
      bootLog?.appendChild(el);
      progress(total);
      window.clearInterval(tipTimer);
      window.setTimeout(() => {
        loaderEl?.classList.add("hidden");
        window.setTimeout(() => loaderEl?.remove(), 700);
      }, 420);
    }
  };
  step();
})();
