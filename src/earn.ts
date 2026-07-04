// black bull - the earn ledger: HERD POINTS earned by playing, building toward
// $ansem claims. ECONOMIC ONLY - points never change gameplay (no pay to win,
// no earn to win; the perk rules live in momentum, not here).
//
// the CLAIM rail ships DORMANT: with no VITE_EARN_CLAIM_URL configured nothing
// moves and the button explains that claims open soon. when the payout service
// exists, setting that one env var arms the button - the service receives
// { wallet, points, ledger } and MUST re-validate + rate-limit server-side
// before anything pays out; the client-side hourly/daily caps here only bound
// what an honest client reports, they are not the security boundary.

import { fx } from "./feedback";

const LS_KEY = "blackbull.earn.v1";
const CLAIM_URL = (import.meta.env.VITE_EARN_CLAIM_URL as string | undefined) ?? "";

// what play pays (points). tuned so an active hour lands near the hour cap.
export const EARN = {
  ram: 1, // landing a charge on another rider
  whiteHit: 1, // connecting on a white bull
  whiteBreak: 5, // breaking one
  bear: 4, // launching a bear
  golden: 8, // claiming a golden bull
  wipeout: 10, // wiping a rider out
  eventWin: 15, // king bounty / king survival
  alphaTick: 2, // per 10s reigning as alpha
  tierUp: 5, // momentum tier up
} as const;

const HOUR_CAP = 600;
const DAY_CAP = 3000;

interface Persisted {
  balance: number;
  lifetime: number;
  day: string;
  dayEarned: number;
  hour: string;
  hourEarned: number;
  wallet: string;
}

function hourKey(): string {
  const d = new Date();
  return `${d.toISOString().slice(0, 10)}.${d.getHours()}`;
}
function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function load(): Persisted {
  const fallback: Persisted = { balance: 0, lifetime: 0, day: dayKey(), dayEarned: 0, hour: hourKey(), hourEarned: 0, wallet: "" };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<Persisted>;
    return {
      balance: typeof p.balance === "number" && isFinite(p.balance) ? Math.max(0, p.balance) : 0,
      lifetime: typeof p.lifetime === "number" && isFinite(p.lifetime) ? Math.max(0, p.lifetime) : 0,
      day: typeof p.day === "string" ? p.day : fallback.day,
      dayEarned: typeof p.dayEarned === "number" ? Math.max(0, p.dayEarned) : 0,
      hour: typeof p.hour === "string" ? p.hour : fallback.hour,
      hourEarned: typeof p.hourEarned === "number" ? Math.max(0, p.hourEarned) : 0,
      wallet: typeof p.wallet === "string" ? p.wallet.slice(0, 64) : "",
    };
  } catch {
    return fallback;
  }
}

export class Earn {
  private p: Persisted;
  private saveTimer = 0;
  private chip: HTMLElement | null = null;
  private chipNum: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private open = false;
  private canUse: () => boolean;
  private onOpenChange?: (open: boolean) => void;

  constructor(opts: { canUse: () => boolean; onOpenChange?: (open: boolean) => void }) {
    this.canUse = opts.canUse;
    this.onOpenChange = opts.onOpenChange;
    this.p = load();
    if (typeof document !== "undefined") {
      this.injectStyle();
      this.buildChip();
      this.buildPanel();
      window.addEventListener("keydown", (e) => {
        if (e.repeat || e.code !== "KeyG") return;
        const a = document.activeElement;
        if (a && /input|textarea|select/i.test(a.tagName)) return;
        if (this.open) this.close();
        else if (this.canUse()) this.openPanel();
      });
    }
    this.syncChip();
  }

  get balance(): number {
    return Math.floor(this.p.balance);
  }
  get isOpen(): boolean {
    return this.open;
  }

  // earn n points, bounded by the hourly/daily caps. shows the "+n pts" pop.
  award(n: number) {
    if (n <= 0) return;
    const hk = hourKey();
    const dk = dayKey();
    if (this.p.hour !== hk) {
      this.p.hour = hk;
      this.p.hourEarned = 0;
    }
    if (this.p.day !== dk) {
      this.p.day = dk;
      this.p.dayEarned = 0;
    }
    const allowed = Math.max(0, Math.min(n, HOUR_CAP - this.p.hourEarned, DAY_CAP - this.p.dayEarned));
    if (allowed <= 0) return;
    this.p.hourEarned += allowed;
    this.p.dayEarned += allowed;
    this.p.balance += allowed;
    this.p.lifetime += allowed;
    fx.xp(allowed);
    this.syncChip();
    this.persistSoon();
  }

  setVisible(on: boolean) {
    this.chip?.classList.toggle("show", on);
    if (!on && this.open) this.close();
  }

  private persistSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(this.p));
      } catch {
        /* ignore */
      }
    }, 600);
  }

  private syncChip() {
    if (this.chipNum) this.chipNum.textContent = String(this.balance);
    const bal = this.panel?.querySelector(".ep-balance");
    if (bal) bal.textContent = String(this.balance);
  }

  private buildChip() {
    const chip = document.createElement("button");
    chip.id = "earn-chip";
    chip.innerHTML = `<span class="ec-ico">◆</span><span class="ec-num">0</span><span class="ec-label">pts · g</span>`;
    chip.addEventListener("click", () => {
      if (this.canUse()) this.openPanel();
    });
    document.body.appendChild(chip);
    this.chip = chip;
    this.chipNum = chip.querySelector(".ec-num");
  }

  private buildPanel() {
    const ov = document.createElement("div");
    ov.id = "earn-panel";
    const claimReady = !!CLAIM_URL;
    ov.innerHTML = `
      <div class="ep-card">
        <button class="ep-close" aria-label="close">×</button>
        <div class="ep-head">
          <span class="ep-ico">◆</span>
          <div>
            <div class="ep-title">herd points</div>
            <div class="ep-sub">earned by riding. points never change gameplay.</div>
          </div>
        </div>
        <div class="ep-balrow"><span class="ep-balance">0</span><span class="ep-unit">pts</span></div>
        <div class="ep-rates">
          <div class="ep-r"><span>wipe out a rider</span><b>+${EARN.wipeout}</b></div>
          <div class="ep-r"><span>claim a golden bull</span><b>+${EARN.golden}</b></div>
          <div class="ep-r"><span>break a white bull</span><b>+${EARN.whiteBreak}</b></div>
          <div class="ep-r"><span>launch a bear</span><b>+${EARN.bear}</b></div>
          <div class="ep-r"><span>win an event</span><b>+${EARN.eventWin}</b></div>
          <div class="ep-r"><span>land a charge</span><b>+${EARN.ram}</b></div>
          <div class="ep-r"><span>reign as alpha</span><b>+${EARN.alphaTick} / 10s</b></div>
        </div>
        <div class="ep-label">solana wallet for claims</div>
        <input class="ep-wallet" type="text" maxlength="64" spellcheck="false" autocomplete="off" placeholder="paste your solana address" />
        <button class="ep-claim"></button>
        <div class="ep-foot">${
          claimReady
            ? "claims are validated server-side before anything pays out"
            : "$ansem claims open soon - keep stacking, your points are saved"
        }</div>
      </div>`;
    ov.addEventListener("pointerdown", (e) => {
      if (e.target === ov) this.close();
    });
    document.body.appendChild(ov);
    this.panel = ov;
    const wallet = ov.querySelector(".ep-wallet") as HTMLInputElement;
    wallet.value = this.p.wallet;
    wallet.addEventListener("input", () => {
      this.p.wallet = wallet.value.trim().slice(0, 64);
      this.persistSoon();
    });
    wallet.addEventListener("keydown", (e) => e.stopPropagation()); // hotkeys stay quiet
    ov.querySelector(".ep-close")?.addEventListener("click", () => this.close());
    const claim = ov.querySelector(".ep-claim") as HTMLButtonElement;
    claim.textContent = claimReady ? "claim $ansem" : "claims open soon";
    claim.disabled = !claimReady;
    if (claimReady) claim.addEventListener("click", () => void this.claim(claim));
    window.addEventListener("keydown", (e) => {
      if (e.code === "Escape" && this.open) this.close();
    });
  }

  // the live claim path (only reachable when VITE_EARN_CLAIM_URL is set): hand
  // the ledger to the payout service and zero the balance ONLY on its confirm.
  private async claim(btn: HTMLButtonElement) {
    if (!CLAIM_URL || this.balance <= 0 || !this.p.wallet) {
      fx.toast(this.balance <= 0 ? "no points to claim yet" : "add a wallet address first", "info");
      return;
    }
    btn.disabled = true;
    btn.textContent = "claiming...";
    try {
      const res = await fetch(CLAIM_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: this.p.wallet, points: this.balance, lifetime: this.p.lifetime }),
      });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (res.ok && out.ok) {
        this.p.balance = 0;
        this.syncChip();
        this.persistSoon();
        fx.toast(out.message ?? "claim submitted - $ansem is on the way", "good");
      } else {
        fx.toast(out.message ?? "claim failed - try again later", "warn");
      }
    } catch {
      fx.toast("claim failed - network error", "warn");
    } finally {
      btn.disabled = false;
      btn.textContent = "claim $ansem";
    }
  }

  private openPanel() {
    if (!this.panel || this.open) return;
    this.open = true;
    this.panel.classList.add("show");
    this.syncChip();
    if (document.pointerLockElement) {
      try {
        document.exitPointerLock();
      } catch {
        /* ignore */
      }
    }
    this.onOpenChange?.(true);
  }
  private close() {
    if (!this.open) return;
    this.open = false;
    this.panel?.classList.remove("show");
    this.onOpenChange?.(false);
    if (this.canUse()) {
      try {
        document.body.requestPointerLock();
      } catch {
        /* ignore */
      }
    }
  }

  private injectStyle() {
    if (document.getElementById("blackbull-earn-style")) return;
    const st = document.createElement("style");
    st.id = "blackbull-earn-style";
    st.textContent = `
#earn-chip{position:fixed;top:150px;left:16px;z-index:36;display:none;align-items:center;gap:7px;
 background:rgba(6,12,7,.78);border:1px solid #1e3020;border-radius:18px;padding:7px 12px;cursor:pointer;
 font:600 12px/1 ui-monospace,Menlo,Consolas,monospace;color:#f2f5ee;pointer-events:auto}
#earn-chip.show{display:flex}
#earn-chip:hover{border-color:#39ff64}
#earn-chip .ec-ico{color:#ffd24a}
#earn-chip .ec-num{color:#39ff64;font-size:14px;font-weight:800}
#earn-chip .ec-label{color:#6e8266;font-size:9px;letter-spacing:.12em;text-transform:uppercase}
#earn-panel{position:fixed;inset:0;z-index:64;display:none;align-items:center;justify-content:center;
 background:rgba(4,8,5,.78);backdrop-filter:blur(4px);font-family:ui-monospace,Menlo,Consolas,monospace}
#earn-panel.show{display:flex}
#earn-panel .ep-card{position:relative;width:min(400px,92vw);background:rgba(8,14,9,.96);border:1px solid #1e3020;
 border-radius:14px;padding:20px 22px}
#earn-panel .ep-close{position:absolute;top:10px;right:12px;background:none;border:none;color:#6e8266;
 font-size:20px;cursor:pointer}
#earn-panel .ep-close:hover{color:#f2f5ee}
#earn-panel .ep-head{display:flex;gap:12px;align-items:center}
#earn-panel .ep-ico{font-size:24px;color:#ffd24a}
#earn-panel .ep-title{font:800 18px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.08em;color:#39ff64}
#earn-panel .ep-sub{margin-top:4px;font-size:10px;color:#9aab92}
#earn-panel .ep-balrow{display:flex;align-items:baseline;gap:8px;margin:16px 0 4px}
#earn-panel .ep-balance{font:800 40px/1 ui-sans-serif,system-ui,sans-serif;color:#f2f5ee}
#earn-panel .ep-unit{font-size:12px;color:#6e8266;letter-spacing:.14em;text-transform:uppercase}
#earn-panel .ep-rates{margin:12px 0;display:flex;flex-direction:column;gap:4px}
#earn-panel .ep-r{display:flex;justify-content:space-between;font-size:11px;color:#9aab92;
 border-bottom:1px dashed #16241a;padding:3px 0}
#earn-panel .ep-r b{color:#ffd24a}
#earn-panel .ep-label{font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:#6e8266;margin:12px 0 6px}
#earn-panel .ep-wallet{width:100%;background:rgba(4,8,5,.8);border:1px solid #1e3020;border-radius:8px;
 color:#eaffef;font:500 12px/1 ui-monospace,Menlo,monospace;padding:9px 10px;outline:none;box-sizing:border-box}
#earn-panel .ep-wallet:focus{border-color:#39ff64}
#earn-panel .ep-claim{width:100%;margin-top:12px;border:none;border-radius:10px;padding:12px;cursor:pointer;
 font:800 14px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.08em;text-transform:lowercase;
 background:linear-gradient(180deg,#7dff5a,#23c246);color:#04140a}
#earn-panel .ep-claim:disabled{background:#1b2a1e;color:#54685a;cursor:default}
#earn-panel .ep-foot{margin-top:10px;text-align:center;font-size:9.5px;color:#6e8266;letter-spacing:.04em}
`;
    document.head.appendChild(st);
  }
}
