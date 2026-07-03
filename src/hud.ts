// black bull - hud. the in-world readouts: the charge meter (bottom centre,
// fills while you hold the mouse), the momentum panel (value, tier, alpha
// crown), the world-event banner with warning countdown, the wipeout overlay,
// a biome label that fades in when you cross a border, and the impact flash.
// pure dom - reads game state through setters, never reaches into systems.

import { MOMENTUM_CAP, TIERS } from "./config";

export const TIER_NAMES = ["yearling", "charger", "brawler", "warlord", "apex bull"];

export class Hud {
  private chargeEl = document.getElementById("charge-hud");
  private chargeFill = document.getElementById("charge-fill");
  private chargeLabel = document.getElementById("charge-label");
  private momEl = document.getElementById("momentum-hud");
  private momNum = document.getElementById("mom-num");
  private momFill = document.getElementById("mom-fill");
  private momTier = document.getElementById("mom-tier");
  private momAlpha = document.getElementById("mom-alpha");
  private banner = document.getElementById("event-banner");
  private bannerTitle = this.banner?.querySelector(".eb-title") as HTMLElement | null;
  private bannerSub = this.banner?.querySelector(".eb-sub") as HTMLElement | null;
  private bannerTime = this.banner?.querySelector(".eb-time") as HTMLElement | null;
  private eventChip = document.getElementById("event-chip");
  private koEl = document.getElementById("ko-overlay");
  private koSub = this.koEl?.querySelector(".ko-sub") as HTMLElement | null;
  private biomeEl = document.getElementById("biome-label");
  private flashEl = document.getElementById("impact-flash");
  private alphaBanner = document.getElementById("alpha-banner");

  private lastBiome = "";
  private biomeT = 0;
  private flashT = 0;

  setVisible(on: boolean) {
    document.body.classList.toggle("in-world", on);
  }

  // charge meter: v 0..1 while winding, cooldown fraction while recovering
  setCharge(v: number, charging: boolean, winded: boolean) {
    if (!this.chargeEl || !this.chargeFill || !this.chargeLabel) return;
    this.chargeEl.classList.toggle("charging", charging);
    this.chargeEl.classList.toggle("winded", winded);
    this.chargeEl.classList.toggle("full", charging && v >= 1);
    this.chargeFill.style.width = Math.round(v * 100) + "%";
    this.chargeLabel.textContent = winded ? "winded" : charging ? (v >= 1 ? "stampede ready" : "charging") : "hold to charge";
  }

  setMomentum(value: number, tier: number, isAlpha: boolean) {
    if (this.momNum) this.momNum.textContent = String(Math.floor(value));
    if (this.momFill) this.momFill.style.width = Math.round((value / MOMENTUM_CAP) * 100) + "%";
    if (this.momTier) this.momTier.textContent = TIER_NAMES[tier] ?? TIER_NAMES[0];
    this.momEl?.setAttribute("data-tier", String(tier));
    this.momAlpha?.classList.toggle("show", isAlpha);
    this.alphaBanner?.classList.toggle("show", isAlpha);
  }
  // next tier threshold for the small readout (unused thresholds return cap)
  static nextTier(value: number): number {
    for (const t of TIERS) if (value < t) return t;
    return MOMENTUM_CAP;
  }

  showBanner(title: string, sub: string) {
    if (!this.banner) return;
    if (this.bannerTitle) this.bannerTitle.textContent = title;
    if (this.bannerSub) this.bannerSub.textContent = sub;
    this.banner.classList.add("show");
  }
  updateBanner(warnLeft: number, timeLeft: number, title: string) {
    if (!this.banner) return;
    if (warnLeft > 0) {
      if (this.bannerTime) this.bannerTime.textContent = Math.ceil(warnLeft) + "";
    } else {
      this.banner.classList.remove("show");
      // collapse into the corner chip while the event runs
      if (this.eventChip) {
        this.eventChip.classList.add("show");
        this.eventChip.textContent = `${title} · ${Math.max(0, Math.ceil(timeLeft))}s`;
      }
    }
  }
  clearBanner() {
    this.banner?.classList.remove("show");
    this.eventChip?.classList.remove("show");
  }

  showKo(reason: string) {
    if (this.koSub) this.koSub.textContent = reason;
    this.koEl?.classList.add("show");
  }
  hideKo() {
    this.koEl?.classList.remove("show");
  }

  setBiome(name: string) {
    if (name === this.lastBiome || !name) return;
    this.lastBiome = name;
    if (!this.biomeEl) return;
    this.biomeEl.textContent = name;
    this.biomeEl.classList.remove("show");
    void this.biomeEl.offsetWidth;
    this.biomeEl.classList.add("show");
    this.biomeT = 2.6;
  }

  // a quick fullscreen tint pulse (impacts, lightning)
  flash(strength = 0.5, color = "255,255,255") {
    if (!this.flashEl) return;
    this.flashEl.style.background = `rgba(${color},${Math.min(0.55, strength)})`;
    this.flashEl.classList.add("show");
    this.flashT = 0.12;
  }

  update(dt: number) {
    if (this.biomeT > 0) {
      this.biomeT -= dt;
      if (this.biomeT <= 0) this.biomeEl?.classList.remove("show");
    }
    if (this.flashT > 0) {
      this.flashT -= dt;
      if (this.flashT <= 0) this.flashEl?.classList.remove("show");
    }
  }
}
