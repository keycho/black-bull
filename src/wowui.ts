// world of bullcraft - the in-world HUD reskinned to look like world of warcraft:
// a player unit frame (portrait + health + rage), a target frame, a purple XP
// bar with levels, a gold-bordered action bar of the real controls, a bag bar,
// and a gold ring around the minimap. pure dom + one injected <style>; it reads
// game state through update() each frame and never reaches into systems.
//
// the numbers map onto the existing bull game:
//   - level + xp come from lifetime stats (monotonic, persisted)
//   - the health bar is a vitality that drops when you get rammed and regens
//   - the rage bar is the charge meter (winds up as you hold to charge)
//   - the target is the warlord (the alpha to hunt), else the nearest rival

import type { Stats } from "./momentum";

// action bar: the real controls, shown as world-of-warcraft ability slots. each
// slot has a keybind, a glyph, and a spell-school-ish colour so the tray reads
// like a bar of abilities.
interface Slot {
  key: string;
  glyph: string;
  name: string;
  hue: string; // slot background tint
}
const SLOTS: Slot[] = [
  { key: "LMB", glyph: "⚡", name: "charge", hue: "#b6321f" }, // ⚡ fire red
  { key: "F", glyph: "✦", name: "wind-up", hue: "#c46b1f" }, // ✦ ember
  { key: "R", glyph: "✿", name: "roar", hue: "#8a5cc4" }, // ❋ arcane
  { key: "U", glyph: "⚔", name: "duel", hue: "#3f7a3a" }, // ⚔ nature
  { key: "L", glyph: "♛", name: "ladder", hue: "#2f7bb5" }, // ♛ frost
  { key: "C", glyph: "✧", name: "dismount", hue: "#b59429" }, // ✧ holy
  { key: "N", glyph: "⛰", name: "world map", hue: "#5b6b7a" }, // ⛰ stone
  { key: "G", glyph: "◈", name: "renown", hue: "#a37b1e" }, // ◈ coin
  { key: "↵", glyph: "✉", name: "chat", hue: "#4b5566" }, // ✉ chat
  { key: "K", glyph: "⛶", name: "drone cam", hue: "#6a4a8a" }, // ⛶ cam
];

// bag bar (decorative, bottom-right, like wow's backpack + 4 bags)
const BAGS = ["\u{1F392}", "▤", "▤", "▤", "▤"];

export interface TargetInfo {
  name: string;
  classText: string; // "warlord" / "rival" / a level line
  hpFrac: number; // 0..1
  elite: boolean; // draws the skull/dragon look
}

export interface WowState {
  name: string;
  charge: number; // 0..1 -> rage bar
  alive: boolean;
  winded: boolean; // charge on cooldown -> dim the charge slot
  isWarlord: boolean;
  zone: string;
  online: number;
  stats: Stats;
  target: TargetInfo | null;
}

// --- leveling: a monotonic lifetime-xp curve so the bar only ever fills ---
function lifetimeXp(s: Stats): number {
  return Math.floor(
    s.rams * 8 + s.wipeouts * 40 + s.golden * 60 + s.events * 80 + s.bears * 30 + s.whites * 70 + s.alphaS * 2 + s.best,
  );
}
function levelInfo(xp: number): { level: number; into: number; need: number } {
  let level = 1;
  let acc = 0;
  let need = 100;
  while (xp >= acc + need && level < 60) {
    acc += need;
    level++;
    need = 100 + (level - 1) * 60;
  }
  return { level, into: xp - acc, need };
}

export class WowUI {
  private root: HTMLElement;
  private hp = 1; // vitality 0..1, regenerates toward 1 while alive
  private hpFlash = 0;
  private dead = false;

  // cached nodes
  private pName!: HTMLElement;
  private pLevel!: HTMLElement;
  private pHpFill!: HTMLElement;
  private pHpText!: HTMLElement;
  private pRageFill!: HTMLElement;
  private tFrame!: HTMLElement;
  private tName!: HTMLElement;
  private tClass!: HTMLElement;
  private tHpFill!: HTMLElement;
  private tPortrait!: HTMLElement;
  private xpFill!: HTMLElement;
  private xpRested!: HTMLElement;
  private xpText!: HTMLElement;
  private zoneEl!: HTMLElement;
  private onlineEl!: HTMLElement;
  private chargeSlot!: HTMLElement;
  private warlordPip!: HTMLElement;

  constructor() {
    this.injectStyle();
    this.root = document.createElement("div");
    this.root.id = "wow-ui";
    this.root.innerHTML = this.markup();
    document.body.appendChild(this.root);
    this.cache();
  }

  private cache() {
    const q = (s: string) => this.root.querySelector(s) as HTMLElement;
    this.pName = q(".wp-name");
    this.pLevel = q(".wp-portrait .wf-level");
    this.pHpFill = q(".wp-hp .wf-fill");
    this.pHpText = q(".wp-hp .wf-btext");
    this.pRageFill = q(".wp-rage .wf-fill");
    this.warlordPip = q(".wp-warlord");
    this.tFrame = q("#wow-target");
    this.tName = q(".wt-name");
    this.tClass = q(".wt-class");
    this.tHpFill = q(".wt-hp .wf-fill");
    this.tPortrait = q(".wt-portrait .wf-emblem");
    this.xpFill = q("#wow-xp .wx-fill");
    this.xpRested = q("#wow-xp .wx-rested");
    this.xpText = q("#wow-xp .wx-text");
    this.zoneEl = q("#wow-zone");
    this.onlineEl = q("#wow-online");
    this.chargeSlot = q('.wa-slot[data-i="0"]');
  }

  setVisible(on: boolean) {
    this.root.classList.toggle("show", on);
    // the zone banner + minimap ring live outside #wow-ui; toggle a body class
    document.body.classList.toggle("wow-on", on);
  }

  // got hit: bleed the health bar (regens back)
  damage(frac: number) {
    this.hp = Math.max(0, this.hp - frac);
    this.hpFlash = 0.35;
  }
  setDead(dead: boolean) {
    this.dead = dead;
    if (dead) this.hp = 0;
  }
  revive() {
    this.dead = false;
    this.hp = 1;
  }

  update(dt: number, s: WowState) {
    // health: regen toward full while alive
    if (!this.dead) this.hp = Math.min(1, this.hp + dt * 0.14);
    if (this.hpFlash > 0) this.hpFlash -= dt;

    this.pName.textContent = s.name || "champion";
    const xp = lifetimeXp(s.stats);
    const li = levelInfo(xp);
    this.pLevel.textContent = String(li.level);

    const hpPct = Math.round(this.hp * 100);
    this.pHpFill.style.width = hpPct + "%";
    this.pHpText.textContent = hpPct + " / 100";
    this.pHpFill.parentElement?.classList.toggle("flash", this.hpFlash > 0);
    this.pRageFill.style.width = Math.round(s.charge * 100) + "%";
    this.warlordPip.classList.toggle("show", s.isWarlord);

    // xp bar
    const pct = li.need > 0 ? (li.into / li.need) * 100 : 0;
    this.xpFill.style.width = pct.toFixed(1) + "%";
    this.xpRested.style.width = Math.min(100, pct + 8).toFixed(1) + "%";
    this.xpText.textContent = `level ${li.level}  •  ${li.into} / ${li.need} xp`;

    // zone + online
    if (s.zone) this.zoneEl.textContent = s.zone;
    this.onlineEl.textContent = s.online > 1 ? `${s.online} online` : "";

    // charge on cooldown
    this.chargeSlot.classList.toggle("cooldown", s.winded);

    // target frame
    if (s.target) {
      this.tFrame.classList.add("show");
      this.tName.textContent = s.target.name;
      this.tClass.textContent = s.target.classText;
      this.tHpFill.style.width = Math.round(s.target.hpFrac * 100) + "%";
      this.tFrame.classList.toggle("elite", s.target.elite);
      this.tPortrait.textContent = s.target.elite ? "☠" : "⚔"; // ☠ / ⚔
    } else {
      this.tFrame.classList.remove("show");
    }
  }

  private markup(): string {
    const slots = SLOTS.map(
      (sl, i) =>
        `<div class="wa-slot" data-i="${i}" style="--hue:${sl.hue}" title="${sl.name} (${sl.key})">` +
        `<span class="wa-glyph">${sl.glyph}</span><span class="wa-key">${sl.key}</span>` +
        `<span class="wa-cd"></span></div>`,
    ).join("");
    const bags = BAGS.map((b) => `<div class="wb-slot">${b}</div>`).join("");
    return `
      <div id="wow-player" class="wf-frame">
        <div class="wf-portrait wp-portrait">
          <span class="wf-emblem">♉</span>
          <span class="wf-level">1</span>
          <span class="wp-warlord" title="warlord">♛</span>
        </div>
        <div class="wf-body">
          <div class="wp-name wf-uname">champion</div>
          <div class="wf-bar wp-hp"><div class="wf-fill"></div><span class="wf-btext">100 / 100</span></div>
          <div class="wf-bar wp-rage"><div class="wf-fill"></div></div>
        </div>
      </div>

      <div id="wow-target" class="wf-frame">
        <div class="wf-portrait wt-portrait"><span class="wf-emblem">⚔</span></div>
        <div class="wf-body">
          <div class="wt-name wf-uname">rival</div>
          <div class="wf-bar wt-hp"><div class="wf-fill"></div></div>
          <div class="wt-class">rival</div>
        </div>
      </div>

      <div id="wow-castbar-anchor"></div>

      <div id="wow-actionbar">
        <div class="wa-tray">${slots}</div>
      </div>

      <div id="wow-bags">${bags}</div>

      <div id="wow-xp">
        <div class="wx-rested"></div>
        <div class="wx-fill"></div>
        <div class="wx-text">level 1</div>
      </div>

      <div id="wow-zonebar">
        <span id="wow-zone">the emerald wilds</span>
        <span id="wow-online"></span>
      </div>`;
  }

  private injectStyle() {
    if (document.getElementById("wow-ui-style")) return;
    const st = document.createElement("style");
    st.id = "wow-ui-style";
    st.textContent = CSS;
    document.head.appendChild(st);
  }
}

// stone + gold world-of-warcraft chrome. reuses the --wow-* vars from style.css.
const CSS = `
#wow-ui{position:fixed;inset:0;z-index:34;pointer-events:none;display:none;font-family:var(--serif);}
#wow-ui.show{display:block;}

/* --- unit frames (player + target) --- */
.wf-frame{position:absolute;display:flex;align-items:center;gap:9px;
  background:linear-gradient(180deg,rgba(20,26,34,.94),rgba(8,12,18,.94));
  border:2px solid var(--wow-gold-deep);border-radius:8px;padding:7px 12px 7px 8px;
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.6),0 6px 18px -6px rgba(0,0,0,.8);}
#wow-player{top:14px;left:16px;width:246px;}
#wow-target{top:14px;left:280px;width:220px;opacity:0;transform:translateX(-6px);
  transition:opacity .15s,transform .15s;}
#wow-target.show{opacity:1;transform:none;}
.wf-portrait{position:relative;width:54px;height:54px;border-radius:50%;flex:0 0 auto;
  background:radial-gradient(circle at 38% 32%,#243244,#0c121c 72%);
  border:2px solid var(--wow-gold);box-shadow:inset 0 0 10px rgba(0,0,0,.7),0 0 0 2px #000;
  display:flex;align-items:center;justify-content:center;}
.wf-emblem{font-size:30px;color:var(--wow-gold-bright);text-shadow:0 0 8px rgba(0,0,0,.8);line-height:1;}
#wow-target.elite .wt-portrait{border-color:#e0453a;box-shadow:inset 0 0 10px rgba(0,0,0,.7),0 0 10px rgba(224,69,58,.6),0 0 0 2px #000;}
#wow-target.elite .wf-emblem{color:#ff5a48;}
.wf-level{position:absolute;right:-6px;bottom:-6px;min-width:20px;height:20px;padding:0 4px;
  border-radius:11px;background:linear-gradient(180deg,#2a2a2a,#111);border:1px solid var(--wow-gold);
  color:var(--wow-gold-bright);font:700 12px/20px var(--serif);text-align:center;}
.wp-warlord{position:absolute;left:-7px;top:-8px;color:#f5c542;font-size:17px;display:none;
  text-shadow:0 0 8px rgba(245,197,66,.9);}
.wp-warlord.show{display:block;animation:wowpip 1.4s ease-in-out infinite;}
@keyframes wowpip{50%{transform:translateY(-2px)}}
.wf-body{flex:1;min-width:0;}
.wf-uname{font:600 15px/1.2 var(--serif);color:#f3ead3;letter-spacing:.02em;
  text-shadow:0 1px 3px rgba(0,0,0,.9);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.wf-bar{position:relative;height:15px;margin-top:4px;border:1px solid #000;border-radius:3px;
  background:#0a0d12;overflow:hidden;box-shadow:inset 0 1px 2px rgba(0,0,0,.8);}
.wf-fill{height:100%;width:100%;transition:width .18s;}
.wp-hp .wf-fill{background:linear-gradient(180deg,#4ad25a,#1f8b34);}
.wp-hp.flash .wf-fill{background:linear-gradient(180deg,#ff6a5a,#c0271b);}
.wt-hp .wf-fill{background:linear-gradient(180deg,#e5564a,#a51d12);}
.wp-rage{height:11px;}
.wp-rage .wf-fill{background:linear-gradient(180deg,#ffb454,#e06a15);width:0%;}
.wf-btext{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font:600 10px/1 var(--serif);color:#eafce9;text-shadow:0 1px 2px rgba(0,0,0,.95);letter-spacing:.03em;}
.wt-class{font:italic 500 11px/1.3 var(--serif);color:var(--wow-gold);margin-top:3px;}
#wow-target.elite .wt-class{color:#ff8a6a;}

/* --- xp bar (bottom, purple) --- */
#wow-xp{position:absolute;left:0;right:0;bottom:0;height:16px;
  background:linear-gradient(180deg,#161018,#0c090f);border-top:1px solid #000;}
#wow-xp .wx-rested{position:absolute;left:0;top:0;bottom:0;width:0%;
  background:linear-gradient(180deg,#5a3f8f,#3a2960);opacity:.55;transition:width .2s;}
#wow-xp .wx-fill{position:absolute;left:0;top:0;bottom:0;width:0%;
  background:linear-gradient(180deg,#c86bff,#7a2fd0);box-shadow:0 0 10px rgba(160,80,230,.6);
  border-right:1px solid rgba(255,255,255,.35);transition:width .2s;}
#wow-xp .wx-text{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font:600 10px/1 var(--serif);letter-spacing:.06em;color:#e9dcf5;text-shadow:0 1px 2px rgba(0,0,0,.95);}

/* --- action bar (bottom centre, above the xp bar) --- */
#wow-actionbar{position:absolute;left:50%;bottom:24px;transform:translateX(-50%);
  padding:6px 8px;background:linear-gradient(180deg,rgba(18,18,20,.92),rgba(6,6,8,.92));
  border:2px solid var(--wow-gold-deep);border-radius:8px;
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.6),0 8px 24px -8px rgba(0,0,0,.85);}
.wa-tray{display:flex;gap:5px;}
.wa-slot{position:relative;width:44px;height:44px;border-radius:5px;border:1px solid #000;
  background:linear-gradient(180deg,color-mix(in srgb,var(--hue) 78%,#000),color-mix(in srgb,var(--hue) 42%,#000));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.18),inset 0 0 0 1px rgba(200,170,110,.35);
  display:flex;align-items:center;justify-content:center;}
.wa-glyph{font-size:23px;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.85),0 0 6px rgba(0,0,0,.5);}
.wa-key{position:absolute;top:1px;right:3px;font:700 9px/1 var(--serif);color:#ffe9b0;
  text-shadow:0 1px 2px #000;letter-spacing:.02em;}
.wa-cd{position:absolute;inset:0;border-radius:5px;background:rgba(0,0,0,.6);opacity:0;
  transition:opacity .15s;}
.wa-slot.cooldown .wa-cd{opacity:1;}
.wa-slot.cooldown .wa-glyph{opacity:.4;}

/* --- bags (bottom-right) --- */
#wow-bags{position:absolute;right:12px;bottom:24px;display:flex;gap:4px;
  padding:5px 6px;background:linear-gradient(180deg,rgba(18,18,20,.9),rgba(6,6,8,.9));
  border:2px solid var(--wow-gold-deep);border-radius:7px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.6);}
.wb-slot{width:30px;height:30px;border-radius:4px;border:1px solid #000;
  background:linear-gradient(180deg,#3a2f22,#1c150e);box-shadow:inset 0 0 0 1px rgba(200,170,110,.3);
  display:flex;align-items:center;justify-content:center;font-size:16px;color:var(--wow-gold-bright);}

/* --- zone name over the minimap (top-right) --- */
#wow-zonebar{position:absolute;top:14px;right:20px;width:196px;text-align:center;
  display:flex;flex-direction:column;align-items:center;gap:1px;}
#wow-zone{font:700 14px/1.2 var(--serif);color:var(--wow-gold-bright);letter-spacing:.03em;
  text-shadow:0 1px 4px rgba(0,0,0,.95);text-transform:capitalize;}
#wow-online{font:italic 500 10px/1.2 var(--serif);color:#9fb0c4;text-shadow:0 1px 2px rgba(0,0,0,.9);}

/* --- reskin the existing bits when wow chrome is on --- */
body.wow-on #wordmark,
body.wow-on #momentum-hud,
body.wow-on #net-status,
body.wow-on #earn-chip{display:none !important;}

/* minimap -> circular gold ring, pushed below the zone label */
body.wow-on #minimap{border-radius:50% !important;border:none !important;
  box-shadow:0 0 0 3px #0a0a0a,0 0 0 6px var(--wow-gold-deep),0 0 0 8px #0a0a0a,0 8px 22px -6px rgba(0,0,0,.8) !important;
  overflow:hidden !important;margin-top:22px;}
body.wow-on #minimap canvas{border-radius:50%;}

/* the audio control moves clear of the minimap + zone label, gold-skinned */
body.wow-on #audio-ctl{top:auto !important;bottom:64px !important;right:14px !important;
  background:linear-gradient(180deg,rgba(18,18,20,.92),rgba(6,6,8,.92)) !important;
  border:1px solid var(--wow-gold-deep) !important;border-radius:6px !important;}
body.wow-on #audio-ctl button{color:var(--wow-gold-bright) !important;}
body.wow-on #audio-vol::-webkit-slider-thumb{background:var(--wow-gold-bright) !important;box-shadow:0 0 7px rgba(200,170,110,.7) !important;}

/* the charge meter becomes a world-of-warcraft cast bar, centred above the tray */
body.wow-on #charge-hud{left:50% !important;transform:translateX(-50%) !important;
  bottom:80px !important;width:260px !important;}
body.wow-on #charge-hud .charge-track{height:18px !important;border:2px solid var(--wow-gold-deep) !important;
  border-radius:4px !important;background:#0a0d12 !important;box-shadow:inset 0 1px 3px rgba(0,0,0,.8) !important;}
body.wow-on #charge-fill{background:linear-gradient(180deg,#ffe08a,var(--wow-gold),#a2803f) !important;}
body.wow-on #charge-label{font-family:var(--serif) !important;color:var(--wow-parch) !important;
  letter-spacing:.06em !important;text-transform:uppercase !important;font-size:10px !important;}

@media (max-width:820px){
  #wow-target{display:none;}
  #wow-player{width:210px;}
  .wa-slot{width:38px;height:38px;}
  .wa-glyph{font-size:20px;}
  #wow-bags{display:none;}
}
`;
