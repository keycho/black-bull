// black bull - real-time pvp DUELS. ride up to another rider and press U to
// challenge them; both warp into a glowing neon ring, face off, and fight LIVE
// with the charge system they already use. every landed ram drains the other's
// stamina - first to break the other wins. a personal win streak + a live
// ladder give it the bragging-rights loop. FRIENDLY ONLY: no money, no wager,
// no token ever changes hands - this is pure skill and status.
//
// netcode (matches net.ts's trust model - each client is authoritative for ONLY
// its own bull + its own stamina):
//   - ram detection stays in main.ts (it already finds my hits on other bulls).
//     when i ram my current duel opponent, main calls dealRam() and the hit is
//     FORWARDED over the duel channel; it is never applied to their bar locally.
//   - the opponent applies the hit to ITS OWN stamina and broadcasts the new
//     value back, so my bar for them is always their own truth.
//   - when MY stamina hits zero i declare my own defeat ("end"); the winner
//     bumps its streak and broadcasts a "ladder" line everyone tallies.
//   - broadcast is room-wide, so nearby riders render a light spectator ring.
//
// self-contained: injects its own scoped <style>, builds its hud imperatively,
// and degrades to a quiet no-op with no supabase (you never meet another rider).

import * as THREE from "three";
import { fx } from "./feedback";
import type { DuelMsg, Net } from "./net";

const STAMINA = 100;
const RAM_MIN = 13; // a tap-charge ram
const RAM_SCALE = 30; // + up to this for a full stampede
const DMG_CAP = 46; // per-hit cap so nothing one-shots
const RING_R = 15; // arena radius (world units) - room to wind up a charge
const SPOT = RING_R * 0.6; // how far each fighter stands from centre at the face-off
const CHALLENGE_RANGE = 12; // how near another rider must be to challenge them
const CHALLENGE_TTL = 12; // s a pending challenge stays open before it lapses
const END_HOLD = 3.0; // s the win/lose banner holds before the ring clears
const STRAY_LIMIT = 6; // s outside the ring before it counts as a forfeit
const STORE_KEY = "blackbull.duel.v1";

const START_RATING = 1000;
const ELO_K = 32;

type Phase = "idle" | "challenging" | "incoming" | "fighting";

interface Rank {
  label: string;
  color: number;
}

interface SpectatorRing {
  group: THREE.Group;
  cx: number;
  cz: number;
  aId: string;
  bId: string;
  aName: string;
  bName: string;
  aHp: number;
  bHp: number;
}

export interface DuelDeps {
  scene: THREE.Scene;
  net: Net;
  // the local bull: read pos/yaw, teleported to/from the arena
  bull: { pos: THREE.Vector3; yaw: number; isLive: boolean; respawn: (x: number, z: number, yaw: number) => void };
  myName: () => string;
  groundAt: (x: number, z: number) => number;
  canUse: () => boolean; // playing && !cinematic && !other menus
  onFightState?: (fighting: boolean) => void; // pause other menus while dueling
}

export class Duel {
  phase: Phase = "idle";
  oppId = "";

  private d: DuelDeps;
  // handshake
  private pendingTo = "";
  private pendingTimer = 0;
  private incoming: DuelMsg | null = null;
  // active fight
  private oppName = "rider";
  private cx = 0;
  private cz = 0;
  private ax = 0;
  private az = 1;
  private myHp = STAMINA;
  private oppHp = STAMINA;
  private ring?: THREE.Group;
  private preDuel = new THREE.Vector3();
  private endingAt = 0;
  private oppMissing = 0;
  private strayT = 0;
  // rank + record
  private rating = START_RATING;
  private wins = 0;
  private losses = 0;
  private streak = 0;
  private oppRating = START_RATING;
  private ladder = new Map<string, { rating: number; wins: number }>();
  // spectated duels (challenger id -> ring)
  private specRings = new Map<string, SpectatorRing>();
  private specArena = new Map<string, { cx: number; cz: number; name: string }>();
  // dom
  private hud!: HTMLElement;
  private meBar!: HTMLElement;
  private oppBar!: HTMLElement;
  private meNameEl!: HTMLElement;
  private oppNameEl!: HTMLElement;
  private banner!: HTMLElement;
  private prompt!: HTMLElement;
  private flash!: HTMLElement;
  private ladderEl!: HTMLElement;
  private ladderBody!: HTMLElement;
  private flashT = 0;

  constructor(d: DuelDeps) {
    this.d = d;
    this.load();
    this.injectStyle();
    this.buildDom();
    this.renderLadder();
    d.net.onDuel = (m) => this.onMsg(m);
    window.addEventListener("keydown", (e) => this.onKey(e));
  }

  get fighting(): boolean {
    return this.phase === "fighting";
  }
  isOpp(id: string): boolean {
    return this.phase === "fighting" && !this.endingAt && id === this.oppId;
  }

  // ---------------------------------------------------------------------------
  // input
  // ---------------------------------------------------------------------------
  private onKey(e: KeyboardEvent) {
    if (e.repeat) return;
    const a = document.activeElement;
    if (a && /input|textarea/i.test(a.tagName)) return;
    if (e.code === "KeyL") {
      // the ladder toggles anytime in-world
      if (this.d.canUse() || this.phase === "fighting") this.ladderEl.classList.toggle("show");
      return;
    }
    if (e.code !== "KeyU") return;
    if (!this.d.canUse() && this.phase !== "incoming") return;
    if (this.phase === "incoming" && this.incoming) this.accept(this.incoming);
    else if (this.phase === "idle") this.challengeNearest();
  }

  private challengeNearest() {
    let best: { id: string; x: number; z: number; name: string } | null = null;
    let bestD = CHALLENGE_RANGE * CHALLENGE_RANGE;
    for (const [id, r] of this.d.net.remotes) {
      if (!r.inWorld) continue;
      const dx = r.x - this.d.bull.pos.x;
      const dz = r.z - this.d.bull.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = { id, x: r.x, z: r.z, name: r.name || "rider" };
      }
    }
    if (!best) {
      fx.toast("no rider close enough to duel", "info");
      return;
    }
    this.cx = (this.d.bull.pos.x + best.x) / 2;
    this.cz = (this.d.bull.pos.z + best.z) / 2;
    const dx = best.x - this.d.bull.pos.x;
    const dz = best.z - this.d.bull.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    this.ax = dx / len;
    this.az = dz / len;
    this.pendingTo = best.id;
    this.pendingTimer = CHALLENGE_TTL;
    this.phase = "challenging";
    this.d.net.sendDuel({
      t: "challenge", to: best.id, name: this.d.myName(), cx: this.cx, cz: this.cz, ax: this.ax, az: this.az, rating: this.rating,
    });
    fx.toast(`challenged ${best.name} to a duel`, "info");
    this.showPrompt(`waiting for ${best.name} to accept...`);
  }

  // ---------------------------------------------------------------------------
  // protocol
  // ---------------------------------------------------------------------------
  private onMsg(m: DuelMsg) {
    const me = this.d.net.id;
    switch (m.t) {
      case "challenge": {
        if (m.to !== me) {
          this.noteSpectatorChallenge(m);
          break;
        }
        if (this.phase !== "idle" || !this.d.bull.isLive) {
          this.d.net.sendDuel({ t: "decline", to: m.from, reason: this.phase !== "idle" ? "in another duel" : "down" });
          break;
        }
        this.incoming = m;
        this.pendingTimer = CHALLENGE_TTL;
        this.phase = "incoming";
        this.showPrompt(`${m.name || "a rider"} challenges you - press u to duel`);
        break;
      }
      case "accept": {
        if (m.to === me && this.phase === "challenging" && m.from === this.pendingTo) {
          this.startFight("from", m.from, m.name || "rider", m.rating ?? START_RATING);
        } else if (m.to !== me) {
          this.noteSpectatorAccept(m);
        }
        break;
      }
      case "decline": {
        if (m.to === me && this.phase === "challenging") {
          const who = this.d.net.remotes.get(this.pendingTo)?.name || "that rider";
          fx.toast(m.reason ? `${who} can't duel - ${m.reason}` : "challenge declined", "info");
          this.resetHandshake();
        }
        break;
      }
      case "cancel": {
        if (this.phase === "incoming" && this.incoming && m.from === this.incoming.from) this.resetHandshake();
        this.clearSpectatorByChallenger(m.from);
        break;
      }
      case "hit": {
        if (this.phase === "fighting" && !this.endingAt && m.from === this.oppId && m.to === me) this.takeHit(m.dmg ?? 0);
        break;
      }
      case "hp": {
        if (this.phase === "fighting" && m.from === this.oppId) {
          this.oppHp = Math.max(0, Math.min(STAMINA, (m.hp ?? 1) * STAMINA));
          this.updateHud();
        } else {
          this.updateSpectatorHp(m.from, m.hp ?? 1);
        }
        break;
      }
      case "end": {
        if (m.to === me && this.phase === "fighting" && m.from === this.oppId && !this.endingAt) this.winFight();
        this.clearSpectatorByPair(m.from, m.to ?? "");
        break;
      }
      case "ladder": {
        if (m.winner) {
          this.ladder.set(m.winner, { rating: m.rating ?? START_RATING, wins: (m.streak ?? 0) });
          this.renderLadder();
          if (m.winner !== this.d.myName())
            fx.toast(`${m.winner} won a duel${m.streak && m.streak > 1 ? ` - ${m.streak} streak` : ""}`, "info");
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // fight lifecycle
  // ---------------------------------------------------------------------------
  private accept(m: DuelMsg) {
    if (!this.d.bull.isLive) {
      fx.toast("recover before you duel", "info");
      return;
    }
    this.cx = m.cx ?? this.d.bull.pos.x;
    this.cz = m.cz ?? this.d.bull.pos.z;
    this.ax = m.ax ?? 0;
    this.az = m.az ?? 1;
    this.d.net.sendDuel({ t: "accept", to: m.from, name: this.d.myName(), rating: this.rating });
    this.startFight("to", m.from, m.name || "rider", m.rating ?? START_RATING);
  }

  private startFight(role: "from" | "to", oppId: string, oppName: string, oppRating: number) {
    this.clearSpectatorByPair(oppId, this.d.net.id);
    this.phase = "fighting";
    this.endingAt = 0;
    this.oppMissing = 0;
    this.strayT = 0;
    this.oppId = oppId;
    this.oppName = oppName;
    this.oppRating = oppRating;
    this.myHp = STAMINA;
    this.oppHp = STAMINA;
    this.incoming = null;
    this.pendingTo = "";

    // remember where to drop the rider back afterward, then place them on their
    // side of the ring facing centre (challenger on -axis, accepter on +axis)
    this.preDuel.copy(this.d.bull.pos);
    const side = role === "from" ? -1 : 1;
    const sx = this.cx + this.ax * SPOT * side;
    const sz = this.cz + this.az * SPOT * side;
    const faceYaw = Math.atan2(this.cx - sx, this.cz - sz); // look toward centre (model faces -z)
    this.d.bull.respawn(sx, sz, faceYaw);

    this.ring = this.buildRing(this.cx, this.cz, 0x39ff64);
    this.d.scene.add(this.ring);
    this.showHud();
    this.updateHud();
    this.d.onFightState?.(true);
    this.bannerShow("duel", `${this.d.myName()} vs ${oppName}`, "info");
  }

  // main calls this when the LOCAL bull lands a ram on the current opponent
  dealRam(power01: number) {
    if (this.phase !== "fighting" || this.endingAt || !this.oppId) return;
    const dmg = Math.min(DMG_CAP, RAM_MIN + power01 * RAM_SCALE);
    this.d.net.sendDuel({ t: "hit", to: this.oppId, dmg });
  }

  private takeHit(rawDmg: number) {
    const dmg = Math.min(rawDmg, DMG_CAP);
    this.myHp = Math.max(0, this.myHp - dmg);
    this.flashT = 0.5;
    fx.damage(this.d.bull.pos.x, this.d.bull.pos.y + 1.4, this.d.bull.pos.z, Math.round(dmg), this.myHp <= 0);
    this.d.net.sendDuel({ t: "hp", to: this.oppId, hp: this.myHp / STAMINA });
    this.updateHud();
    if (this.myHp <= 0) this.loseFight();
  }

  private loseFight() {
    if (this.endingAt) return;
    this.d.net.sendDuel({ t: "end", to: this.oppId, winner: this.oppName, loser: this.d.myName() });
    const delta = this.eloDelta(0);
    this.rating = Math.max(0, this.rating + delta);
    this.losses += 1;
    this.streak = 0;
    this.persist();
    this.ladder.set(this.d.myName(), { rating: this.rating, wins: this.wins });
    this.renderLadder();
    const rk = this.rankOf(this.rating);
    this.bannerShow("defeated", `${delta} -> ${rk.label}`, "bad");
    this.endingAt = performance.now() + END_HOLD * 1000;
  }

  private winFight() {
    if (this.endingAt) return;
    const delta = this.eloDelta(1);
    this.rating += delta;
    this.wins += 1;
    this.streak += 1;
    this.persist();
    this.ladder.set(this.d.myName(), { rating: this.rating, wins: this.wins });
    this.renderLadder();
    this.d.net.sendDuel({ t: "ladder", winner: this.d.myName(), streak: this.streak, rating: this.rating });
    const rk = this.rankOf(this.rating);
    const streakTag = this.streak > 1 ? `  ${this.streak} streak` : "";
    this.bannerShow("you win", `+${delta} -> ${rk.label}${streakTag}`, "good");
    this.flashT = 0.7;
    this.endingAt = performance.now() + END_HOLD * 1000;
  }

  private eloDelta(score: number): number {
    const expected = 1 / (1 + Math.pow(10, (this.oppRating - this.rating) / 400));
    return Math.round(ELO_K * (score - expected));
  }

  // opponent vanished mid-fight: end quietly, no streak change (a pulled cable
  // cannot farm wins or losses)
  private forfeitEnd(reason: string) {
    this.bannerShow("duel ended", reason, "info");
    this.endingAt = performance.now() + 1200;
  }

  private endFight() {
    if (this.ring) {
      this.d.scene.remove(this.ring);
      this.ring = undefined;
    }
    // set the rider back down near where they were before the bell
    const gy = this.d.groundAt(this.preDuel.x, this.preDuel.z);
    this.d.bull.respawn(this.preDuel.x, this.preDuel.z, this.d.bull.yaw);
    void gy;
    this.hideHud();
    this.endingAt = 0;
    this.phase = "idle";
    this.oppId = "";
    this.d.onFightState?.(false);
  }

  private resetHandshake() {
    this.phase = "idle";
    this.incoming = null;
    this.pendingTo = "";
    this.pendingTimer = 0;
    this.hidePrompt();
  }

  // ---------------------------------------------------------------------------
  // per-frame
  // ---------------------------------------------------------------------------
  update(dt: number, now: number) {
    // handshake ttl
    if ((this.phase === "challenging" || this.phase === "incoming") && this.pendingTimer > 0) {
      this.pendingTimer -= dt;
      if (this.pendingTimer <= 0) {
        if (this.phase === "challenging") this.d.net.sendDuel({ t: "cancel", to: this.pendingTo });
        this.resetHandshake();
      }
    }

    if (this.phase === "fighting") {
      // opponent presence + stray-from-ring forfeit guards
      const opp = this.d.net.remotes.get(this.oppId);
      if (!opp || !opp.inWorld) {
        this.oppMissing += dt;
        if (this.oppMissing > 2.5 && !this.endingAt) this.forfeitEnd(`${this.oppName} left`);
      } else {
        this.oppMissing = 0;
      }
      const dcx = this.d.bull.pos.x - this.cx;
      const dcz = this.d.bull.pos.z - this.cz;
      if (!this.endingAt && Math.hypot(dcx, dcz) > RING_R + 8) {
        this.strayT += dt;
        this.showPrompt("get back to the ring");
        if (this.strayT > STRAY_LIMIT) {
          fx.toast("you fled the ring", "warn");
          this.loseFight();
        }
      } else if (this.strayT > 0) {
        this.strayT = 0;
        this.hidePrompt();
      }
      // ring pulse
      if (this.ring) {
        const m = (this.ring.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
        m.opacity = 0.4 + 0.25 * (0.5 + 0.5 * Math.sin(now * 0.005));
      }
      if (this.endingAt && now >= this.endingAt) this.endFight();
    }

    // hit flash decay
    if (this.flashT > 0) {
      this.flashT = Math.max(0, this.flashT - dt);
      this.flash.style.opacity = String(this.flashT);
    }

    // spectator rings pulse
    for (const s of this.specRings.values()) {
      const mm = (s.group.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mm.opacity = 0.28 + 0.16 * (0.5 + 0.5 * Math.sin(now * 0.004));
    }
  }

  // ---------------------------------------------------------------------------
  // spectator rings (a duel between two OTHER riders)
  // ---------------------------------------------------------------------------
  private noteSpectatorChallenge(m: DuelMsg) {
    if (m.cx == null || m.cz == null) return;
    this.specArena.set(m.from, { cx: m.cx, cz: m.cz, name: m.name || "rider" });
  }
  private noteSpectatorAccept(m: DuelMsg) {
    const arena = this.specArena.get(m.to ?? "");
    if (!arena) return;
    const key = m.to ?? "";
    if (this.specRings.has(key)) return;
    const group = this.buildRing(arena.cx, arena.cz, 0x8a7a5e);
    this.d.scene.add(group);
    this.specRings.set(key, {
      group, cx: arena.cx, cz: arena.cz, aId: m.to ?? "", bId: m.from,
      aName: arena.name, bName: m.name || "rider", aHp: 1, bHp: 1,
    });
  }
  private updateSpectatorHp(fromId: string, hp: number) {
    for (const s of this.specRings.values()) {
      if (s.aId === fromId) s.aHp = hp;
      else if (s.bId === fromId) s.bHp = hp;
    }
  }
  private clearSpectatorByChallenger(id: string) {
    this.specArena.delete(id);
    const s = this.specRings.get(id);
    if (s) {
      this.d.scene.remove(s.group);
      this.specRings.delete(id);
    }
  }
  private clearSpectatorByPair(a: string, b: string) {
    for (const [k, s] of this.specRings) {
      if ((s.aId === a && s.bId === b) || (s.aId === b && s.bId === a)) {
        this.d.scene.remove(s.group);
        this.specRings.delete(k);
      }
    }
    this.specArena.delete(a);
    this.specArena.delete(b);
  }

  // ---------------------------------------------------------------------------
  // arena ring
  // ---------------------------------------------------------------------------
  private buildRing(cx: number, cz: number, hex: number): THREE.Group {
    const g = new THREE.Group();
    const y = this.d.groundAt(cx, cz) + 0.12;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(RING_R - 0.6, RING_R, 48),
      new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.5, toneMapped: false, depthWrite: false, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(cx, y, cz);
    g.add(ring);
    // a ring of short glowing posts
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 2.4, 0.3),
        new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 1.2, toneMapped: false })
      );
      post.position.set(cx + Math.cos(a) * RING_R, this.d.groundAt(cx + Math.cos(a) * RING_R, cz + Math.sin(a) * RING_R) + 1.2, cz + Math.sin(a) * RING_R);
      g.add(post);
    }
    return g;
  }

  // ---------------------------------------------------------------------------
  // rank
  // ---------------------------------------------------------------------------
  private rankOf(r: number): Rank {
    if (r >= 1600) return { label: "apex bull", color: 0xffd24a };
    if (r >= 1400) return { label: "diamond", color: 0x7fd9ff };
    if (r >= 1250) return { label: "platinum", color: 0x39ff64 };
    if (r >= 1100) return { label: "gold", color: 0xf5a623 };
    if (r >= 950) return { label: "silver", color: 0xc7cdd6 };
    return { label: "bronze", color: 0xb87333 };
  }

  private load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as Partial<{ rating: number; wins: number; losses: number; streak: number }>;
      if (typeof p.rating === "number" && isFinite(p.rating)) this.rating = Math.max(0, p.rating);
      if (typeof p.wins === "number") this.wins = Math.max(0, p.wins);
      if (typeof p.losses === "number") this.losses = Math.max(0, p.losses);
      if (typeof p.streak === "number") this.streak = Math.max(0, p.streak);
    } catch {
      /* defaults */
    }
  }
  private persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ rating: this.rating, wins: this.wins, losses: this.losses, streak: this.streak }));
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // dom
  // ---------------------------------------------------------------------------
  private buildDom() {
    this.flash = document.createElement("div");
    this.flash.id = "duel-flash";
    document.body.appendChild(this.flash);

    this.prompt = document.createElement("div");
    this.prompt.id = "duel-prompt";
    document.body.appendChild(this.prompt);

    this.banner = document.createElement("div");
    this.banner.id = "duel-banner";
    this.banner.innerHTML = `<div class="db-title"></div><div class="db-sub"></div>`;
    document.body.appendChild(this.banner);

    this.hud = document.createElement("div");
    this.hud.id = "duel-hud";
    this.hud.innerHTML =
      `<div class="dh-side dh-me"><span class="dh-name"></span><div class="dh-track"><div class="dh-bar"></div></div></div>` +
      `<div class="dh-vs">vs</div>` +
      `<div class="dh-side dh-opp"><span class="dh-name"></span><div class="dh-track"><div class="dh-bar"></div></div></div>`;
    document.body.appendChild(this.hud);
    this.meNameEl = this.hud.querySelector(".dh-me .dh-name")!;
    this.oppNameEl = this.hud.querySelector(".dh-opp .dh-name")!;
    this.meBar = this.hud.querySelector(".dh-me .dh-bar")!;
    this.oppBar = this.hud.querySelector(".dh-opp .dh-bar")!;

    this.ladderEl = document.createElement("div");
    this.ladderEl.id = "duel-ladder";
    this.ladderEl.innerHTML = `<div class="dl-head">duelists · l</div><div class="dl-body"></div>`;
    document.body.appendChild(this.ladderEl);
    this.ladderBody = this.ladderEl.querySelector(".dl-body")!;
  }

  private showHud() {
    this.meNameEl.textContent = this.d.myName();
    this.oppNameEl.textContent = this.oppName;
    this.hud.classList.add("show");
  }
  private hideHud() {
    this.hud.classList.remove("show");
    this.banner.classList.remove("show");
  }
  private updateHud() {
    this.meBar.style.width = Math.round((this.myHp / STAMINA) * 100) + "%";
    this.oppBar.style.width = Math.round((this.oppHp / STAMINA) * 100) + "%";
  }
  private bannerShow(title: string, sub: string, kind: "info" | "good" | "bad") {
    (this.banner.querySelector(".db-title") as HTMLElement).textContent = title;
    (this.banner.querySelector(".db-sub") as HTMLElement).textContent = sub;
    this.banner.dataset.kind = kind;
    this.banner.classList.add("show");
    if (kind === "info") window.setTimeout(() => this.banner.classList.remove("show"), 2200);
  }
  private showPrompt(text: string) {
    this.prompt.textContent = text;
    this.prompt.classList.add("show");
  }
  private hidePrompt() {
    this.prompt.classList.remove("show");
  }

  // proximity hint: called from main each frame in-world to flash "press u"
  updateProximity() {
    if (this.phase !== "idle" || !this.d.canUse()) {
      if (this.phase === "idle") this.hidePrompt();
      return;
    }
    let near = false;
    for (const r of this.d.net.remotes.values()) {
      if (!r.inWorld) continue;
      const dx = r.x - this.d.bull.pos.x;
      const dz = r.z - this.d.bull.pos.z;
      if (dx * dx + dz * dz < CHALLENGE_RANGE * CHALLENGE_RANGE) {
        near = true;
        break;
      }
    }
    if (near) this.showPrompt("press u to duel");
    else this.hidePrompt();
  }

  private renderLadder() {
    // fold my own current rating in, then sort by rating
    this.ladder.set(this.d.myName(), { rating: this.rating, wins: this.wins });
    const rows = [...this.ladder.entries()].map(([name, v]) => ({ name, ...v }));
    rows.sort((a, b) => b.rating - a.rating);
    this.ladderBody.innerHTML =
      `<div class="dl-me">you · ${this.rankOf(this.rating).label} · ${this.rating} · ${this.wins}w ${this.losses}l${this.streak > 1 ? ` · ${this.streak} streak` : ""}</div>` +
      rows.slice(0, 10).map((r, i) => {
        const rk = this.rankOf(r.rating);
        const c = "#" + (rk.color & 0xffffff).toString(16).padStart(6, "0");
        const meTag = r.name === this.d.myName() ? " dl-you" : "";
        return `<div class="dl-row${meTag}"><span class="dl-i">${i + 1}</span><span class="dl-n">${escapeHtml(r.name)}</span><span class="dl-r" style="color:${c}">${r.rating}</span></div>`;
      }).join("");
  }

  private injectStyle() {
    if (document.getElementById("blackbull-duel-style")) return;
    const st = document.createElement("style");
    st.id = "blackbull-duel-style";
    st.textContent = `
#duel-flash{position:fixed;inset:0;z-index:45;pointer-events:none;opacity:0;
 background:radial-gradient(ellipse at center,transparent 45%,rgba(255,58,46,.4));}
#duel-prompt{position:fixed;bottom:120px;left:50%;transform:translateX(-50%);z-index:38;display:none;
 font:600 13px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.06em;color:#eaffef;
 background:rgba(6,12,7,.82);border:1px solid #1e3020;border-radius:20px;padding:9px 16px;pointer-events:none}
#duel-prompt.show{display:block}
#duel-hud{position:fixed;top:88px;left:50%;transform:translateX(-50%);z-index:40;display:none;
 align-items:center;gap:16px;font-family:ui-monospace,Menlo,Consolas,monospace;pointer-events:none;
 background:rgba(6,12,7,.7);border:1px solid #1e3020;border-radius:12px;padding:10px 16px}
#duel-hud.show{display:flex}
#duel-hud .dh-side{width:230px}
#duel-hud .dh-opp{text-align:right}
#duel-hud .dh-name{font-size:12px;font-weight:700;color:#f2f5ee;letter-spacing:.04em}
#duel-hud .dh-track{margin-top:5px;height:9px;border-radius:5px;background:rgba(4,8,5,.8);overflow:hidden}
#duel-hud .dh-me .dh-bar{height:100%;width:100%;background:linear-gradient(90deg,#1a7a34,#39ff64);transition:width .12s}
#duel-hud .dh-opp .dh-track{transform:scaleX(-1)}
#duel-hud .dh-opp .dh-bar{height:100%;width:100%;background:linear-gradient(90deg,#7a1a1a,#ff3a2e);transition:width .12s}
#duel-hud .dh-vs{font-size:11px;color:#6e8266;letter-spacing:.16em;text-transform:uppercase}
#duel-banner{position:fixed;top:20vh;left:50%;transform:translate(-50%,-10px);z-index:41;text-align:center;
 opacity:0;pointer-events:none;transition:opacity .25s,transform .25s}
#duel-banner.show{opacity:1;transform:translate(-50%,0)}
#duel-banner .db-title{font:800 40px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.12em;text-transform:lowercase;color:#39ff64;
 text-shadow:0 2px 20px rgba(57,255,100,.5),0 1px 3px rgba(0,0,0,.8)}
#duel-banner[data-kind=bad] .db-title{color:#ff3a2e;text-shadow:0 2px 20px rgba(255,58,46,.5)}
#duel-banner[data-kind=good] .db-title{color:#ffd24a;text-shadow:0 2px 20px rgba(255,210,74,.5)}
#duel-banner .db-sub{margin-top:6px;font:600 14px/1.4 ui-monospace,Menlo,monospace;color:#eaffef;text-shadow:0 1px 3px rgba(0,0,0,.8)}
#duel-ladder{position:fixed;top:150px;right:12px;z-index:37;display:none;width:210px;
 font-family:ui-monospace,Menlo,Consolas,monospace;background:rgba(6,12,7,.82);border:1px solid #1e3020;border-radius:10px;
 padding:9px 11px;pointer-events:none}
#duel-ladder.show{display:block}
#duel-ladder .dl-head{font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:#6e8266;margin-bottom:6px}
#duel-ladder .dl-me{font-size:10.5px;color:#39ff64;border-bottom:1px solid #16241a;padding-bottom:5px;margin-bottom:5px}
#duel-ladder .dl-row{display:flex;gap:7px;align-items:baseline;font-size:11px;padding:2px 0;color:#9aab92}
#duel-ladder .dl-row.dl-you{color:#f2f5ee}
#duel-ladder .dl-i{width:14px;color:#54685a}
#duel-ladder .dl-n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#duel-ladder .dl-r{font-weight:700}
`;
    document.head.appendChild(st);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)).slice(0, 16);
}
