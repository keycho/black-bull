// black bull - the on-foot RIDER: the same signature rider (tall curly high-top,
// chin-strap goatee) built standalone so you can hop off your bull and run
// around. articulated legs + arms drive a run/idle/jump/land/tumble animation.
// reflects the player's chosen rider style (outfit colour) + trim. a floating
// name tag rides above the head.
//
// the model faces -Z; group.rotation.y = yaw. origin is at the feet (y = 0).

import * as THREE from "three";
import { type Cosmetics, RIDER_SETS, RIDER_SHIRTS, TRIMS } from "./bullmodel";

export type FootPose = "idle" | "run" | "air" | "land" | "tumble";

function roundRectPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export class RiderModel {
  readonly group = new THREE.Group();
  private shirtMat: THREE.MeshStandardMaterial;
  private trimMat: THREE.MeshStandardMaterial;
  private visorMat: THREE.MeshStandardMaterial;
  private helmetMat: THREE.MeshStandardMaterial;
  private body = new THREE.Group(); // torso+head+arms pivot for lean/bob
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private headGroup = new THREE.Group();
  private charParts: THREE.Object3D[] = [];
  private classicParts: THREE.Object3D[] = [];
  private nameSprite: THREE.Sprite;
  private nameCanvas = document.createElement("canvas");
  private nameTex: THREE.CanvasTexture;
  private phase = Math.random() * 6;
  private tumbleSpin = Math.random() > 0.5 ? 1 : -1;
  private squash = 0;

  constructor(scene: THREE.Scene) {
    const skin = new THREE.MeshStandardMaterial({ color: 0x8a5a3c, roughness: 0.72 });
    const skinDark = new THREE.MeshStandardMaterial({ color: 0x74482e, roughness: 0.78 });
    const hair = new THREE.MeshStandardMaterial({ color: 0x17120e, roughness: 0.92 });
    const jeans = new THREE.MeshStandardMaterial({ color: 0x2a3240, roughness: 0.85 });
    const white = new THREE.MeshStandardMaterial({ color: 0xe8e6e0, roughness: 0.6 });
    const eyeDark = new THREE.MeshStandardMaterial({ color: 0x1c1410, roughness: 0.4 });
    this.shirtMat = new THREE.MeshStandardMaterial({ color: RIDER_SHIRTS[0], roughness: 0.82 });
    this.trimMat = new THREE.MeshStandardMaterial({ color: TRIMS[0].color, roughness: 0.6 });
    this.visorMat = new THREE.MeshStandardMaterial({ color: 0xff3a28, emissive: 0xd61e10, emissiveIntensity: 1.2, toneMapped: false });
    this.helmetMat = new THREE.MeshStandardMaterial({ color: 0x363b44, roughness: 0.45, metalness: 0.5 });

    // --- signature rider (character) ---
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.56, 0.32), this.shirtMat);
    torso.position.y = 1.28;
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.16), skin);
    neck.position.y = 1.58;
    this.headGroup.position.set(0, 1.72, 0);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.36, 0.34), skin);
    // high-top hair
    const crown = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.26, 0.36), hair);
    crown.position.y = 0.28;
    const curlA = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.15, 0.32), hair);
    curlA.position.set(0.025, 0.44, -0.02);
    curlA.rotation.y = 0.18;
    const curlB = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.28), hair);
    curlB.position.set(-0.03, 0.54, 0.02);
    const fadeBack = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.05), hair);
    fadeBack.position.set(0, 0.1, 0.175);
    const browL = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.03, 0.03), hair);
    browL.position.set(-0.08, 0.06, -0.175);
    const browR = browL.clone();
    browR.position.x = 0.08;
    const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.02), eyeDark);
    eyeL.position.set(-0.08, 0.0, -0.178);
    const eyeR = eyeL.clone();
    eyeR.position.x = 0.08;
    const chin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.09, 0.04), hair);
    chin.position.set(0, -0.16, -0.165);
    const jawL = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.16), hair);
    jawL.position.set(-0.155, -0.14, -0.08);
    const jawR = jawL.clone();
    jawR.position.x = 0.155;
    head.castShadow = true;
    crown.castShadow = true;
    this.headGroup.add(head, crown, curlA, curlB, fadeBack, browL, browR, eyeL, eyeR, chin, jawL, jawR);

    // legs (jeans + sneakers) - pivot at the hip
    const mkLeg = (grp: THREE.Group, px: number) => {
      grp.position.set(px, 0.92, 0);
      const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.5, 0.22), jeans);
      thigh.position.y = -0.26;
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.28), white);
      shoe.position.set(0, -0.56, -0.04);
      thigh.castShadow = true;
      grp.add(thigh, shoe);
    };
    mkLeg(this.legL, -0.15);
    mkLeg(this.legR, 0.15);

    // arms (sleeve + skin forearm + hand) - pivot at the shoulder
    const mkArm = (grp: THREE.Group, px: number) => {
      grp.position.set(px, 1.5, 0);
      const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.24, 0.16), this.shirtMat);
      sleeve.position.y = -0.12;
      const fore = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.24, 0.13), skin);
      fore.position.y = -0.36;
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.1, 0.14), skinDark);
      hand.position.y = -0.5;
      grp.add(sleeve, fore, hand);
    };
    mkArm(this.armL, -0.33);
    mkArm(this.armR, 0.33);

    this.charParts = [torso, neck, this.headGroup, this.legL, this.legR, this.armL, this.armR];

    // --- visor classic (helmet rider) as an alternate style ---
    const cHead = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.36, 0.36), this.helmetMat);
    cHead.position.y = 1.74;
    const cVisor = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.09, 0.06), this.visorMat);
    cVisor.position.set(0, 1.76, -0.18);
    cHead.castShadow = true;
    this.classicParts = [cHead, cVisor];

    this.body.add(torso, neck, this.headGroup, this.armL, this.armR, cHead, cVisor);
    this.group.add(this.body, this.legL, this.legR);

    // name tag
    this.nameCanvas.width = 256;
    this.nameCanvas.height = 64;
    this.nameTex = new THREE.CanvasTexture(this.nameCanvas);
    this.nameSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.nameTex, transparent: true, depthTest: false, depthWrite: false }));
    this.nameSprite.position.set(0, 2.35, 0);
    this.nameSprite.scale.set(1.6, 0.4, 1);
    this.nameSprite.renderOrder = 20;
    this.group.add(this.nameSprite);
    this.setName("");

    this.group.rotation.order = "YXZ";
    this.group.visible = false;
    scene.add(this.group);
  }

  setCosmetics(c: Cosmetics) {
    const r = c.rider % RIDER_SETS.length;
    const classic = r === RIDER_SETS.length - 1;
    for (const p of this.charParts) p.visible = !classic;
    for (const p of this.classicParts) p.visible = classic;
    if (!classic) this.shirtMat.color.setHex(RIDER_SHIRTS[r] ?? RIDER_SHIRTS[0]);
    this.trimMat.color.setHex(TRIMS[c.trim % TRIMS.length].color);
    this.helmetMat.color.setHex(c.crown % 2 === 1 ? 0xf5c542 : 0x363b44);
  }

  setName(name: string) {
    const g = this.nameCanvas.getContext("2d")!;
    g.clearRect(0, 0, 256, 64);
    const text = (name || "").slice(0, 16);
    if (!text) {
      this.nameSprite.visible = false;
      this.nameTex.needsUpdate = true;
      return;
    }
    this.nameSprite.visible = true;
    g.font = "bold 30px ui-sans-serif, system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    const tw = Math.min(232, g.measureText(text).width + 24);
    g.fillStyle = "rgba(6,12,7,0.78)";
    roundRectPath(g, 128 - tw / 2, 16, tw, 32, 8);
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = "rgba(0,0,0,0.55)";
    g.strokeText(text, 128, 33);
    g.fillStyle = "#eaffef";
    g.fillText(text, 128, 33);
    this.nameTex.needsUpdate = true;
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }

  // land squash pulse (call on touchdown for a springy landing)
  landPulse() {
    this.squash = 1;
  }

  update(dt: number, now: number, pos: THREE.Vector3, yaw: number, speed: number, pose: FootPose) {
    const t = now / 1000;
    if (this.squash > 0) this.squash = Math.max(0, this.squash - dt * 6);

    if (pose === "tumble") {
      this.phase += dt * 10;
      this.group.position.set(pos.x, pos.y + 0.5, pos.z);
      this.group.rotation.set(this.phase * this.tumbleSpin, yaw, Math.sin(this.phase) * 0.5);
      for (const l of [this.legL, this.legR]) l.rotation.x = Math.sin(this.phase * 2) * 0.9;
      return;
    }

    let bob = 0;
    let lean = 0;
    if (pose === "run") {
      this.phase += dt * (5 + Math.min(speed, 12) * 1.1);
      const sw = Math.sin(this.phase);
      this.legL.rotation.x = sw * 1.0;
      this.legR.rotation.x = -sw * 1.0;
      this.armL.rotation.x = -sw * 0.85;
      this.armR.rotation.x = sw * 0.85;
      bob = Math.abs(Math.cos(this.phase)) * 0.08;
      lean = 0.14; // forward run lean
    } else if (pose === "air") {
      const k = Math.min(1, dt * 8);
      this.legL.rotation.x += (0.5 - this.legL.rotation.x) * k; // tuck
      this.legR.rotation.x += (0.7 - this.legR.rotation.x) * k;
      this.armL.rotation.x += (-1.4 - this.armL.rotation.x) * k; // arms up
      this.armR.rotation.x += (-1.4 - this.armR.rotation.x) * k;
      lean = -0.05;
    } else {
      // idle / land
      const breath = Math.sin(t * 1.7);
      const k = Math.min(1, dt * 7);
      this.legL.rotation.x += (0 - this.legL.rotation.x) * k;
      this.legR.rotation.x += (0 - this.legR.rotation.x) * k;
      this.armL.rotation.x += (breath * 0.08 - this.armL.rotation.x) * k;
      this.armR.rotation.x += (-breath * 0.08 - this.armR.rotation.x) * k;
      bob = breath * 0.02;
    }
    this.armL.rotation.z = -0.08;
    this.armR.rotation.z = 0.08;
    this.headGroup.rotation.x = pose === "run" ? -0.08 : Math.sin(t * 1.3) * 0.03;

    const sq = 1 - this.squash * 0.28;
    this.group.scale.set(1 + this.squash * 0.18, sq, 1 + this.squash * 0.18);
    this.group.position.set(pos.x, pos.y + bob, pos.z);
    this.group.rotation.set(0, yaw, 0);
    this.body.rotation.x = lean;
  }
}
