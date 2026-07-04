// black bull - the bull + rider: a chunky blocky-voxel bull with a small rider
// on a saddle blanket. big silhouette, readable at distance, animated with
// pivot-limb groups (four-beat gallop, idle breathing, a lowered charge pose,
// a stagger tumble and a ko sprawl). cosmetics are visual only: horn sets, eye
// glow, hoof fire, ancient armor plates, a golden crown. momentum drives the
// horn glow tiers. a floating name tag rides above the rider.
//
// the model faces -Z; group.rotation.y = yaw. origin is at the hooves (y = 0).

import * as THREE from "three";

// bull coats - shades of black (it is the black bull community, after all),
// plus a couple of dark off-blacks so herds still read as individuals.
export const COATS: { key: string; name: string; color: number }[] = [
  { key: "jet", name: "jet black", color: 0x16161c },
  { key: "coal", name: "coal", color: 0x232328 },
  { key: "midnight", name: "midnight", color: 0x1a2030 },
  { key: "umber", name: "dark umber", color: 0x2a2018 },
  { key: "storm", name: "storm grey", color: 0x2e3238 },
  { key: "wine", name: "dark wine", color: 0x2c1a20 },
];
// rider + blanket trim colours - bright, so allies read across a battlefield
export const TRIMS: { key: string; name: string; color: number }[] = [
  { key: "crimson", name: "crimson", color: 0xe23b3b },
  { key: "gold", name: "gold", color: 0xf5c542 },
  { key: "cobalt", name: "cobalt", color: 0x3b82f6 },
  { key: "viridian", name: "viridian", color: 0x21c07a },
  { key: "amethyst", name: "amethyst", color: 0x9b51e0 },
  { key: "ember", name: "ember", color: 0xf07b1b },
];

// cosmetic option ids (indices into these lists travel over the wire)
export const HORN_SETS = ["neon", "obsidian", "crystal", "inferno"] as const;
export const EYE_SETS = ["crimson", "void"] as const;
export const TRAIL_SETS = ["dust", "lightning", "fire", "toxic"] as const;
export const HOOF_SETS = ["hoof", "fire"] as const;
export const ARMOR_SETS = ["none", "ancient"] as const;
export const CROWN_SETS = ["none", "golden"] as const;
// rider styles: the signature rider (high-top curls, goatee) in his three
// outfits, plus the original helmeted rider as a throwback.
export const RIDER_SETS = ["heather crew", "sunshine tee", "studio grey", "visor classic"] as const;
export const RIDER_SHIRTS = [0x5a708c, 0xe2c455, 0x9aa0a2]; // heather blue / yellow / grey

export interface Cosmetics {
  coat: number; // COATS index
  trim: number; // TRIMS index
  horns: number; // HORN_SETS index
  eyes: number; // EYE_SETS index
  trail: number; // TRAIL_SETS index
  hooves: number; // HOOF_SETS index
  armor: number; // ARMOR_SETS index
  crown: number; // CROWN_SETS index
  rider: number; // RIDER_SETS index
}
export const DEFAULT_COSMETICS: Cosmetics = { coat: 0, trim: 0, horns: 0, eyes: 0, trail: 0, hooves: 0, armor: 0, crown: 0, rider: 0 };

// animation states the model can express (mirrors the controller's states)
export type BullPose = "idle" | "run" | "charge" | "launch" | "stagger" | "tumble" | "winded" | "ko";

function roundRectPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export class BullModel {
  readonly group = new THREE.Group();
  // materials
  private coatMat: THREE.MeshStandardMaterial;
  private coatDark: THREE.MeshStandardMaterial;
  private trimMat: THREE.MeshStandardMaterial;
  private hornMat: THREE.MeshStandardMaterial;
  private eyeMat: THREE.MeshStandardMaterial;
  private hoofMat: THREE.MeshStandardMaterial;
  private armorMat: THREE.MeshStandardMaterial;
  private crownMat: THREE.MeshStandardMaterial;
  // articulated groups
  private body = new THREE.Group(); // everything above the legs pivots with this
  private headGroup = new THREE.Group();
  private legFL = new THREE.Group();
  private legFR = new THREE.Group();
  private legBL = new THREE.Group();
  private legBR = new THREE.Group();
  private tail = new THREE.Group();
  private rider = new THREE.Group();
  private riderArmL = new THREE.Group();
  private riderArmR = new THREE.Group();
  // the two rider builds share the arm pivots; visibility toggles per style
  private riderChar = new THREE.Group();
  private riderClassic = new THREE.Group();
  private charArms: THREE.Group[] = [];
  private classicArms: THREE.Group[] = [];
  private shirtMat: THREE.MeshStandardMaterial | null = null;
  private hornsL: THREE.Mesh;
  private hornsR: THREE.Mesh;
  private armorParts: THREE.Mesh[] = [];
  private crownGroup = new THREE.Group();
  private alphaCrown = new THREE.Group();
  // name tag
  private nameSprite: THREE.Sprite;
  private nameCanvas = document.createElement("canvas");
  private nameTex: THREE.CanvasTexture;

  private phase = Math.random() * 6;
  private tumbleSpin = Math.random() > 0.5 ? 1 : -1;
  private glowTier = 0;

  constructor(scene: THREE.Scene | THREE.Group, private withRider = true) {
    const coat = COATS[0].color;
    const trim = TRIMS[0].color;
    this.coatMat = new THREE.MeshStandardMaterial({ color: coat, roughness: 0.82, metalness: 0.04 });
    this.coatDark = new THREE.MeshStandardMaterial({ color: coat, roughness: 0.9 });
    this.coatDark.color.multiplyScalar(0.7);
    this.trimMat = new THREE.MeshStandardMaterial({ color: trim, roughness: 0.6 });
    this.hornMat = new THREE.MeshStandardMaterial({ color: 0xe8e0cc, roughness: 0.4, metalness: 0.1, emissive: 0x000000, toneMapped: false });
    this.eyeMat = new THREE.MeshStandardMaterial({ color: 0xff5a3c, emissive: 0xc03418, emissiveIntensity: 0.9, roughness: 0.3, toneMapped: false });
    this.hoofMat = new THREE.MeshStandardMaterial({ color: 0x3a3a40, roughness: 0.5, emissive: 0x000000, toneMapped: false });
    this.armorMat = new THREE.MeshStandardMaterial({ color: 0x8a7a52, roughness: 0.45, metalness: 0.55 });
    this.crownMat = new THREE.MeshStandardMaterial({ color: 0xf5c542, roughness: 0.25, metalness: 0.85, emissive: 0x6a4c00, emissiveIntensity: 0.4, toneMapped: false });

    // --- the bull ---
    // barrel body: low-slung and massive
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.94, 2.1), this.coatMat);
    barrel.position.set(0, 1.12, 0.12);
    // shoulder hump: the black-bull silhouette
    const hump = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.56, 0.92), this.coatMat);
    hump.position.set(0, 1.68, -0.42);
    // hindquarters taper
    const rump = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.78, 0.6), this.coatDark);
    rump.position.set(0, 1.18, 1.06);
    // saddle blanket in the trim colour (the rider's team read)
    const blanket = new THREE.Mesh(new THREE.BoxGeometry(1.34, 0.14, 0.9), this.trimMat);
    blanket.position.set(0, 1.62, 0.28);
    for (const m of [barrel, hump, rump, blanket]) m.castShadow = true;
    this.body.add(barrel, hump, rump, blanket);

    // head: block skull + snout, mounted low and forward
    this.headGroup.position.set(0, 1.62, -1.02);
    const skull = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.62, 0.66), this.coatMat);
    skull.position.set(0, -0.05, -0.2);
    const snout = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.42), this.coatDark);
    snout.position.set(0, -0.22, -0.66);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 0.1), this.trimMat);
    nose.position.set(0, -0.3, -0.88);
    const earL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.24), this.coatDark);
    earL.position.set(-0.44, 0.16, -0.06);
    const earR = earL.clone();
    earR.position.x = 0.44;
    // eyes: small glowing blocks (readable intent at distance)
    const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.06), this.eyeMat);
    eyeL.position.set(-0.26, 0.02, -0.52);
    const eyeR = eyeL.clone();
    eyeR.position.x = 0.26;
    // horns: swept boxes; geometry swaps per horn set are scale/material only
    this.hornsL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.14), this.hornMat);
    this.hornsL.position.set(-0.56, 0.22, -0.14);
    this.hornsL.rotation.z = 0.5;
    const tipL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.3, 0.14), this.hornMat);
    tipL.position.set(-0.22, 0.16, 0);
    this.hornsL.add(tipL);
    this.hornsR = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.14), this.hornMat);
    this.hornsR.position.set(0.56, 0.22, -0.14);
    this.hornsR.rotation.z = -0.5;
    const tipR = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.3, 0.14), this.hornMat);
    tipR.position.set(0.22, 0.16, 0);
    this.hornsR.add(tipR);
    skull.castShadow = true;
    this.hornsL.castShadow = true;
    this.hornsR.castShadow = true;
    this.headGroup.add(skull, snout, nose, earL, earR, eyeL, eyeR, this.hornsL, this.hornsR);
    this.body.add(this.headGroup);

    // legs: pivot at the hip/shoulder, hoof block at the bottom
    const mkLeg = (grp: THREE.Group, px: number, pz: number) => {
      grp.position.set(px, 1.0, pz);
      const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.62, 0.4), this.coatDark);
      thigh.position.y = -0.28;
      const shin = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.42, 0.3), this.coatMat);
      shin.position.y = -0.72;
      const hoof = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.34), this.hoofMat);
      hoof.position.y = -0.94;
      thigh.castShadow = true;
      grp.add(thigh, shin, hoof);
    };
    mkLeg(this.legFL, -0.44, -0.7);
    mkLeg(this.legFR, 0.44, -0.7);
    mkLeg(this.legBL, -0.42, 0.92);
    mkLeg(this.legBR, 0.42, 0.92);

    // tail with a tuft
    this.tail.position.set(0, 1.5, 1.36);
    const tailRope = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.6, 0.12), this.coatDark);
    tailRope.position.y = -0.28;
    const tuft = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.24, 0.18), this.coatDark);
    tuft.position.y = -0.64;
    this.tail.add(tailRope, tuft);
    this.body.add(this.tail);

    // ancient armor plates (cosmetic; hidden by default)
    const plateBrow = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.5, 0.1), this.armorMat);
    plateBrow.position.set(0, 0.08, -0.56);
    this.headGroup.add(plateBrow);
    const plateSide = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 1.5), this.armorMat);
    plateSide.position.set(-0.68, 1.2, 0.05);
    const plateSideR = plateSide.clone();
    plateSideR.position.x = 0.68;
    const plateNeck = new THREE.Mesh(new THREE.BoxGeometry(1.36, 0.2, 0.5), this.armorMat);
    plateNeck.position.set(0, 1.99, -0.42);
    this.body.add(plateSide, plateSideR, plateNeck);
    this.armorParts = [plateBrow, plateSide, plateSideR, plateNeck];

    // golden crown (cosmetic; alpha crown below is a separate, bigger deal)
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.5), this.crownMat);
    band.position.set(0, 0.36, -0.2);
    this.crownGroup.add(band);
    for (let i = 0; i < 4; i++) {
      const spike = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.16, 0.09), this.crownMat);
      spike.position.set([-0.18, -0.06, 0.06, 0.18][i], 0.48, -0.2);
      this.crownGroup.add(spike);
    }
    this.headGroup.add(this.crownGroup);
    this.crownGroup.visible = false;

    // --- the rider (hidden for npc bulls) ---
    // default: the signature rider - a young rider with a tall curly high-top
    // over faded sides, a chin-strap goatee, and a casual crew/tee in one of
    // three outfit colours. "visor classic" swaps in the original helmet rider.
    if (this.withRider) {
      this.rider.position.set(0, 1.7, 0.28);

      // shared materials for the character
      const skin = new THREE.MeshStandardMaterial({ color: 0x8a5a3c, roughness: 0.72 });
      const skinDark = new THREE.MeshStandardMaterial({ color: 0x74482e, roughness: 0.78 });
      const hair = new THREE.MeshStandardMaterial({ color: 0x17120e, roughness: 0.92 });
      const jeans = new THREE.MeshStandardMaterial({ color: 0x2a3240, roughness: 0.85 });
      const white = new THREE.MeshStandardMaterial({ color: 0xe8e6e0, roughness: 0.6 });
      this.shirtMat = new THREE.MeshStandardMaterial({ color: RIDER_SHIRTS[0], roughness: 0.82 });

      // torso + neck
      const torso = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.5, 0.3), this.shirtMat);
      torso.position.y = 0.38;
      const neck = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.14), skin);
      neck.position.y = 0.64;
      // head: skin box, face at -Z
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.34, 0.32), skin);
      head.position.y = 0.84;
      // the high-top: a tall crown of curls (stacked, slightly offset boxes)
      // sitting above short faded sides
      const fadeL = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.2, 0.28), hair);
      fadeL.position.set(-0.17, 0.92, 0.02);
      const fadeR = fadeL.clone();
      fadeR.position.x = 0.17;
      const fadeBack = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.22, 0.05), hair);
      fadeBack.position.set(0, 0.92, 0.165);
      const crown = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.34), hair);
      crown.position.y = 1.09;
      const curlA = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.3), hair);
      curlA.position.set(0.025, 1.24, -0.02);
      curlA.rotation.y = 0.18;
      const curlB = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.26), hair);
      curlB.position.set(-0.03, 1.33, 0.02);
      curlB.rotation.y = -0.22;
      const curlC = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.12), hair);
      curlC.position.set(0.06, 1.4, -0.04);
      // brows + eyes (readable at chip scale)
      const browL = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.03, 0.03), hair);
      browL.position.set(-0.08, 0.92, -0.165);
      const browR = browL.clone();
      browR.position.x = 0.08;
      const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.045, 0.02), new THREE.MeshStandardMaterial({ color: 0x1c1410, roughness: 0.4 }));
      eyeL.position.set(-0.08, 0.86, -0.168);
      const eyeR = eyeL.clone();
      eyeR.position.x = 0.08;
      // chin-strap goatee: chin block + thin jaw lines up both sides
      const chin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.09, 0.04), hair);
      chin.position.set(0, 0.7, -0.155);
      const jawL = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.16), hair);
      jawL.position.set(-0.145, 0.715, -0.07);
      const jawR = jawL.clone();
      jawR.position.x = 0.145;
      const stache = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.025, 0.02), skinDark);
      stache.position.set(0, 0.775, -0.168);
      // legs (jeans) + white sneakers
      const legL = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.44, 0.2), jeans);
      legL.position.set(-0.36, 0.06, 0);
      const legR = legL.clone();
      legR.position.x = 0.36;
      const shoeL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.24), white);
      shoeL.position.set(-0.36, -0.18, -0.03);
      const shoeR = shoeL.clone();
      shoeR.position.x = 0.36;
      torso.castShadow = true;
      head.castShadow = true;
      crown.castShadow = true;
      this.riderChar.add(
        torso, neck, head, fadeL, fadeR, fadeBack, crown, curlA, curlB, curlC,
        browL, browR, eyeL, eyeR, chin, jawL, jawR, stache, legL, legR, shoeL, shoeR
      );

      // character arms: shirt sleeve + skin forearm + hand, on the shared pivots
      const mkCharArm = (side: number): THREE.Group => {
        const g = new THREE.Group();
        const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.2, 0.15), this.shirtMat!);
        sleeve.position.y = -0.08;
        const fore = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.22, 0.13), skin);
        fore.position.y = -0.27;
        const hand = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.13), skinDark);
        hand.position.y = -0.4;
        g.add(sleeve, fore, hand);
        void side;
        return g;
      };
      const charArmL = mkCharArm(-1);
      const charArmR = mkCharArm(1);
      this.charArms = [charArmL, charArmR];

      // --- visor classic: the original helmeted rider, kept as a style ---
      const cTorso = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.5, 0.3), this.trimMat);
      cTorso.position.y = 0.38;
      const cHead = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.32), this.coatMat);
      cHead.position.y = 0.8;
      const cVisor = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.06), this.eyeMat);
      cVisor.position.set(0, 0.82, -0.16);
      const cLegL = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.44, 0.2), this.coatDark);
      cLegL.position.set(-0.36, 0.06, 0);
      const cLegR = cLegL.clone();
      cLegR.position.x = 0.36;
      cTorso.castShadow = true;
      cHead.castShadow = true;
      this.riderClassic.add(cTorso, cHead, cVisor, cLegL, cLegR);
      const cArmL = new THREE.Group();
      const cArmMesh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.4, 0.14), this.coatDark);
      cArmMesh.position.y = -0.16;
      cArmL.add(cArmMesh);
      const cArmR = new THREE.Group();
      cArmR.add(cArmMesh.clone());
      this.classicArms = [cArmL, cArmR];

      this.riderArmL.position.set(-0.28, 0.56, 0);
      this.riderArmL.add(charArmL, cArmL);
      this.riderArmR.position.set(0.28, 0.56, 0);
      this.riderArmR.add(charArmR, cArmR);
      this.riderClassic.visible = false;
      this.rider.add(this.riderChar, this.riderClassic, this.riderArmL, this.riderArmR);
      this.body.add(this.rider);
    }

    // --- alpha crown: a big floating golden crown + light column, granted by
    // being the herd's alpha (visual only, visible across the map) ---
    const abody = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.16, 0.7), this.crownMat);
    this.alphaCrown.add(abody);
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.26, 0.12), this.crownMat);
      s.position.set([-0.26, -0.09, 0.09, 0.26][i], 0.2, 0);
      this.alphaCrown.add(s);
    }
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.5, 26, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.16, toneMapped: false, depthWrite: false, side: THREE.DoubleSide })
    );
    beam.position.y = 13.4;
    this.alphaCrown.add(beam);
    this.alphaCrown.position.set(0, 3.4, 0);
    this.alphaCrown.visible = false;
    this.group.add(this.alphaCrown);

    // floating name tag (faces camera, scales with distance)
    this.nameCanvas.width = 256;
    this.nameCanvas.height = 64;
    this.nameTex = new THREE.CanvasTexture(this.nameCanvas);
    this.nameSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.nameTex, transparent: true, depthTest: false, depthWrite: false })
    );
    this.nameSprite.position.set(0, 3.15, 0);
    this.nameSprite.scale.set(1.9, 0.475, 1);
    this.nameSprite.renderOrder = 20;
    this.group.add(this.nameSprite);
    this.setName("");

    this.group.add(this.body, this.legFL, this.legFR, this.legBL, this.legBR);
    this.group.rotation.order = "YXZ";
    this.group.visible = false;
    scene.add(this.group);
  }

  // --- cosmetics + look ---
  setCosmetics(c: Cosmetics) {
    const coat = COATS[c.coat % COATS.length].color;
    const trim = TRIMS[c.trim % TRIMS.length].color;
    this.coatMat.color.setHex(coat);
    this.coatDark.color.setHex(coat).multiplyScalar(0.7);
    this.trimMat.color.setHex(trim);
    // horn sets: neon (the signature green-gold glow) / obsidian / crystal / inferno
    switch (c.horns % HORN_SETS.length) {
      case 1:
        this.hornMat.color.setHex(0x241f2e);
        this.hornMat.emissive.setHex(0x0e0a18);
        this.hornMat.metalness = 0.5;
        break;
      case 2:
        this.hornMat.color.setHex(0x7fe7ff);
        this.hornMat.emissive.setHex(0x2fb5d6);
        this.hornMat.metalness = 0.2;
        break;
      case 3:
        this.hornMat.color.setHex(0xff8b3c);
        this.hornMat.emissive.setHex(0xd6421a);
        this.hornMat.metalness = 0.1;
        break;
      default:
        // the brand look: green glass horns running hot to gold at the tips
        this.hornMat.color.setHex(0xd6ff6a);
        this.hornMat.emissive.setHex(0x2fd64a);
        this.hornMat.metalness = 0.15;
    }
    // eye sets: crimson (the brand's burning red) / void
    if (c.eyes % EYE_SETS.length === 1) {
      this.eyeMat.color.setHex(0xb44dff);
      this.eyeMat.emissive.setHex(0x7a1fd6);
      this.eyeMat.emissiveIntensity = 1.5;
    } else {
      this.eyeMat.color.setHex(0xff3a28);
      this.eyeMat.emissive.setHex(0xd61e10);
      this.eyeMat.emissiveIntensity = 1.25;
    }
    // hooves: plain / fire
    if (c.hooves % HOOF_SETS.length === 1) {
      this.hoofMat.emissive.setHex(0xff5a1a);
      this.hoofMat.emissiveIntensity = 1.2;
    } else {
      this.hoofMat.emissive.setHex(0x000000);
      this.hoofMat.emissiveIntensity = 0;
    }
    for (const p of this.armorParts) p.visible = c.armor % ARMOR_SETS.length === 1;
    this.crownGroup.visible = c.crown % CROWN_SETS.length === 1;
    // rider style: the signature rider in one of his three outfits, or classic
    if (this.withRider && this.shirtMat) {
      const r = c.rider % RIDER_SETS.length;
      const classic = r === RIDER_SETS.length - 1;
      this.riderChar.visible = !classic;
      this.riderClassic.visible = classic;
      for (const a of this.charArms) a.visible = !classic;
      for (const a of this.classicArms) a.visible = classic;
      if (!classic) this.shirtMat.color.setHex(RIDER_SHIRTS[r] ?? RIDER_SHIRTS[0]);
    }
    this.applyGlow();
  }

  // direct coat override for npc bulls (wild brown, golden herd)
  setCoatHex(hex: number, emissive = 0) {
    this.coatMat.color.setHex(hex);
    this.coatDark.color.setHex(hex).multiplyScalar(0.7);
    if (emissive) {
      this.coatMat.emissive.setHex(emissive);
      this.coatMat.emissiveIntensity = 0.55;
      this.coatMat.toneMapped = false;
    }
  }

  // momentum tier 0..4 -> horn glow strength (visual power read, no gameplay)
  setMomentumTier(t: number) {
    if (t === this.glowTier) return;
    this.glowTier = t;
    this.applyGlow();
  }
  private applyGlow() {
    // tier glow rides ON TOP of the horn set's own emissive
    const boost = [0, 0.35, 0.8, 1.4, 2.2][Math.max(0, Math.min(4, this.glowTier))];
    if (boost > 0 && this.hornMat.emissive.getHex() === 0x000000) this.hornMat.emissive.setHex(0xffb24a);
    this.hornMat.emissiveIntensity = 0.6 + boost;
    if (boost === 0 && this.hornMat.color.getHex() === 0xe8e0cc) {
      this.hornMat.emissive.setHex(0x000000);
      this.hornMat.emissiveIntensity = 0;
    }
  }

  setAlpha(on: boolean) {
    this.alphaCrown.visible = on && this.group.visible;
  }
  get isAlpha(): boolean {
    return this.alphaCrown.visible;
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
    let font = 34;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `bold ${font}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
    while (g.measureText(text).width > 224 && font > 18) {
      font -= 2;
      g.font = `bold ${font}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
    }
    const tw = Math.min(232, g.measureText(text).width + 26);
    g.fillStyle = "rgba(14,17,22,0.74)";
    roundRectPath(g, 128 - tw / 2, 14, tw, 36, 9);
    g.fill();
    g.strokeStyle = "rgba(255,255,255,0.14)";
    g.lineWidth = 1;
    g.stroke();
    g.lineWidth = 4;
    g.strokeStyle = "rgba(0,0,0,0.55)";
    g.strokeText(text, 128, 33);
    g.fillStyle = "#f2ede4";
    g.fillText(text, 128, 33);
    this.nameTex.needsUpdate = true;
  }

  setVisible(v: boolean) {
    this.group.visible = v;
    if (!v) this.alphaCrown.visible = false;
  }

  // drive the whole model for one frame. speed in units/s; pose from the
  // controller (or derived from the network state for remote bulls).
  update(dt: number, now: number, pos: THREE.Vector3, yaw: number, speed: number, pose: BullPose, charge01 = 0) {
    const t = now / 1000;
    const moving = speed > 0.7;

    let bob = 0;
    let pitch = 0;
    let roll = 0;
    let headPitch = 0;

    if (pose === "ko") {
      // sprawled on the side, legs stiff
      this.group.position.set(pos.x, pos.y + 0.55, pos.z);
      this.group.rotation.set(0, yaw, Math.PI / 2 - 0.18);
      this.legFL.rotation.x = 0.5;
      this.legFR.rotation.x = -0.4;
      this.legBL.rotation.x = 0.35;
      this.legBR.rotation.x = -0.5;
      this.headGroup.rotation.x = 0.3;
      return;
    }

    if (pose === "tumble") {
      // full flip - the viral clip pose
      this.phase += dt * 9;
      this.group.position.set(pos.x, pos.y + 0.9, pos.z);
      this.group.rotation.set(this.phase * this.tumbleSpin, yaw, Math.sin(this.phase * 0.7) * 0.5);
      for (const l of [this.legFL, this.legFR, this.legBL, this.legBR]) l.rotation.x = Math.sin(this.phase * 2 + l.position.x) * 0.9;
      return;
    }

    if (moving || pose === "launch") {
      // four-beat gallop; frequency rides with speed
      this.phase += dt * (3 + Math.min(speed, 34) * 0.55);
      const sw = Math.sin(this.phase);
      const cw = Math.cos(this.phase);
      const ease = Math.sign(sw) * Math.pow(Math.abs(sw), 0.7);
      // diagonal pairs, front slightly ahead of back
      this.legFL.rotation.x = ease * 1.0;
      this.legBR.rotation.x = ease * 0.85;
      this.legFR.rotation.x = -ease * 1.0;
      this.legBL.rotation.x = -ease * 0.85;
      const bounce = Math.abs(cw);
      bob = bounce * Math.min(0.16, 0.05 + speed * 0.004);
      pitch = sw * 0.045;
      roll = Math.sin(this.phase * 0.5) * 0.03;
      this.tail.rotation.x = 0.5 + cw * 0.35;
      this.tail.rotation.z = sw * 0.3;
    } else {
      const breath = Math.sin(t * 1.4);
      const k = Math.min(1, dt * 6);
      for (const l of [this.legFL, this.legFR, this.legBL, this.legBR]) l.rotation.x += (0 - l.rotation.x) * k;
      bob = breath * 0.02;
      this.tail.rotation.x += (0.25 + breath * 0.1 - this.tail.rotation.x) * k;
      this.tail.rotation.z = Math.sin(t * 0.7) * 0.25;
      headPitch = Math.sin(t * 1.1) * 0.04; // idle grazing sway
    }

    if (pose === "charge") {
      // wind-up: head drops, weight sinks back, a paw scrape as it fills
      headPitch = 0.55 + charge01 * 0.3;
      pitch = -0.06 - charge01 * 0.05;
      bob *= 0.4;
      const scrape = charge01 > 0.25 ? Math.max(0, Math.sin(t * 14)) * 0.7 : 0;
      this.legFL.rotation.x = scrape;
    } else if (pose === "launch") {
      // horns first
      headPitch = 0.62;
      pitch = 0.1;
    } else if (pose === "stagger") {
      roll += Math.sin(t * 22) * 0.16;
      headPitch = -0.25; // head thrown up
    } else if (pose === "winded") {
      headPitch = 0.5 + Math.sin(t * 10) * 0.1; // heaving, head down
      bob = Math.sin(t * 10) * 0.04;
    }

    this.headGroup.rotation.x = headPitch;
    if (this.withRider) {
      // the rider leans with intent: forward on launch, back on stagger
      const lean = pose === "launch" ? 0.5 : pose === "charge" ? 0.25 : pose === "stagger" ? -0.4 : moving ? 0.12 : 0;
      this.rider.rotation.x = lean;
      this.riderArmL.rotation.x = pose === "charge" || pose === "launch" ? -0.9 : -0.35;
      this.riderArmR.rotation.x = pose === "charge" || pose === "launch" ? -0.9 : -0.35;
    }

    // alpha crown gently spins + bobs
    if (this.alphaCrown.visible) {
      this.alphaCrown.rotation.y = t * 1.2;
      this.alphaCrown.position.y = 3.4 + Math.sin(t * 2.1) * 0.15;
    }

    this.group.position.set(pos.x, pos.y + bob, pos.z);
    this.group.rotation.set(pitch, yaw, roll);
  }
}
