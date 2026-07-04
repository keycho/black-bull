// black bull - momentum: the in-match progression. earned by landing charges,
// surviving, claiming objectives and winning events; bled by getting rammed and
// dumped on a wipeout. perks are deliberately small (a little speed, a little
// knockback) so raw progression never beats skill - momentum is mostly a POWER
// READ: horn glow tiers, bigger dust, louder charges, and the alpha crown for
// whoever holds the most.
//
// lifetime stats (rams landed, wipeouts caused, best momentum, alpha seconds,
// golden bulls, event wins) persist in localStorage and drive cosmetic unlocks.

import {
  M_ALPHA_TRICKLE,
  M_HIT_LOSS,
  M_SURVIVE_S,
  M_WIPE_FRAC,
  MOMENTUM_CAP,
  PERK_POWER,
  PERK_SPEED,
  TIERS,
} from "./config";

const LS_KEY = "blackbull.stats.v1";

export interface Stats {
  rams: number; // charges landed on other bulls
  wipeouts: number; // wipeouts caused
  best: number; // best momentum ever held
  alphaS: number; // total seconds spent as the alpha
  golden: number; // golden bulls claimed
  events: number; // event wins (king bounties, king survivals)
  bears: number; // bears rammed out of the world
  whites: number; // white bulls broken
}

const DEFAULT_STATS: Stats = { rams: 0, wipeouts: 0, best: 0, alphaS: 0, golden: 0, events: 0, bears: 0, whites: 0 };

export function loadStats(): Stats {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_STATS };
    const p = JSON.parse(raw) as Partial<Stats>;
    // tolerate missing/mistyped fields - never let a bad save break boot
    const out = { ...DEFAULT_STATS };
    for (const k of Object.keys(out) as (keyof Stats)[]) {
      const v = p[k];
      if (typeof v === "number" && isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return { ...DEFAULT_STATS };
  }
}

export class Momentum {
  value = 0;
  stats: Stats;
  onChange?: (value: number, tier: number) => void;
  onUnlockCheck?: () => void; // stats moved - cosmetics may have unlocked

  private surviveT = 0;
  private saveT = 0;

  constructor() {
    this.stats = loadStats();
  }

  get tier(): number {
    let t = 0;
    for (let i = 0; i < TIERS.length; i++) if (this.value >= TIERS[i]) t = i;
    return t;
  }
  get frac(): number {
    return Math.min(1, this.value / MOMENTUM_CAP);
  }
  // small, counterable perks
  get speedMult(): number {
    return 1 + PERK_SPEED * this.frac;
  }
  get powerMult(): number {
    return 1 + PERK_POWER * this.frac;
  }

  private set(v: number) {
    const nv = Math.max(0, Math.min(MOMENTUM_CAP, Math.round(v * 10) / 10));
    if (nv === this.value) return;
    this.value = nv;
    if (nv > this.stats.best) {
      this.stats.best = Math.round(nv);
      this.persistSoon();
      this.onUnlockCheck?.();
    }
    this.onChange?.(this.value, this.tier);
  }

  award(n: number) {
    this.set(this.value + n);
  }
  // got rammed
  hitTaken() {
    this.set(this.value - M_HIT_LOSS);
  }
  // wiped out: dump a chunk
  wipeout() {
    this.set(this.value * (1 - M_WIPE_FRAC));
  }
  // slow survival trickle while alive in the world
  tickSurvive(dt: number, alive: boolean) {
    if (!alive) {
      this.surviveT = 0;
      return;
    }
    this.surviveT += dt;
    if (this.surviveT >= M_SURVIVE_S) {
      this.surviveT -= M_SURVIVE_S;
      this.set(this.value + 1);
    }
  }
  // reigning as alpha builds score
  tickAlpha(dt: number, isAlpha: boolean) {
    if (!isAlpha) return;
    this.stats.alphaS += dt;
    this.set(this.value + M_ALPHA_TRICKLE * dt);
    this.saveT += dt;
    if (this.saveT > 5) {
      this.saveT = 0;
      this.persistSoon();
      this.onUnlockCheck?.();
    }
  }

  // --- lifetime stat bumps (drive cosmetic unlocks) ---
  noteRam() {
    this.stats.rams++;
    this.persistSoon();
    this.onUnlockCheck?.();
  }
  noteWipeoutCaused() {
    this.stats.wipeouts++;
    this.persistSoon();
    this.onUnlockCheck?.();
  }
  noteGolden() {
    this.stats.golden++;
    this.persistSoon();
    this.onUnlockCheck?.();
  }
  noteEventWin() {
    this.stats.events++;
    this.persistSoon();
    this.onUnlockCheck?.();
  }
  noteBear() {
    this.stats.bears++;
    this.persistSoon();
    this.onUnlockCheck?.();
  }
  noteWhite() {
    this.stats.whites++;
    this.persistSoon();
    this.onUnlockCheck?.();
  }

  private persistTimer = 0;
  private persistSoon() {
    clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(this.stats));
      } catch {
        /* ignore */
      }
    }, 800);
  }
}
