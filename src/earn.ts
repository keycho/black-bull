// world of bullcraft - PLAY TO EARN $ansem. renown is earned by playing (every
// ram, wipeout and world boss), and a connected solana wallet is where a future
// claim would pay out $ansem. ECONOMIC ONLY - renown never changes gameplay (no
// pay to win, no earn to win; the perk rules live in momentum, not here).
//
// CONNECT WALLET is a self-contained address bind, NOT a wallet-adapter modal:
// clicking it does not open phantom/solflare or navigate anywhere - you paste
// your solana receive address and that is your "connected" wallet. a real
// wallet-adapter (window.solana.connect) can be layered on later; the claim rail
// only ever needs the receive address.
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

// a plausible solana address: base58 (no 0 O I l), 32-44 chars. good enough to
// gate the "connected" state client-side; the payout service re-validates.
function isValidSol(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}
function truncAddr(s: string): string {
  return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
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
  // wallet ui refs
  private walletBlock: HTMLElement | null = null;
  private connectBtn: HTMLButtonElement | null = null;
  private walletInput: HTMLInputElement | null = null;
  private claimBtn: HTMLButtonElement | null = null;
  private addrEl: HTMLElement | null = null;

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
    chip.innerHTML = `<span class="ec-ico">◆</span><span class="ec-num">0</span><span class="ec-label">renown · g</span>`;
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
    ov.innerHTML = `
      <div class="ep-card">
        <button class="ep-close" aria-label="close">×</button>
        <div class="ep-head">
          <span class="ep-ico">◆</span>
          <div>
            <div class="ep-title">play to earn $ansem</div>
            <div class="ep-sub">every ram, wipeout and world boss earns renown. connect a wallet to claim $ansem when claims open.</div>
          </div>
        </div>
        <div class="ep-balrow"><span class="ep-balance">0</span><span class="ep-unit">renown</span></div>
        <div class="ep-rates">
          <div class="ep-r"><span>wipe out a rider</span><b>+${EARN.wipeout}</b></div>
          <div class="ep-r"><span>claim a golden bull</span><b>+${EARN.golden}</b></div>
          <div class="ep-r"><span>break a world boss</span><b>+${EARN.whiteBreak}</b></div>
          <div class="ep-r"><span>launch a bear</span><b>+${EARN.bear}</b></div>
          <div class="ep-r"><span>win an event</span><b>+${EARN.eventWin}</b></div>
          <div class="ep-r"><span>land a charge</span><b>+${EARN.ram}</b></div>
          <div class="ep-r"><span>reign as warlord</span><b>+${EARN.alphaTick} / 10s</b></div>
        </div>

        <div class="ep-wallet-block">
          <button class="ep-connect" type="button">
            <span class="ep-w-ico">◈</span><span class="ep-w-txt">connect wallet</span>
          </button>
          <input class="ep-wallet" type="text" maxlength="64" spellcheck="false" autocomplete="off" placeholder="paste your solana address" />
          <div class="ep-connected">
            <span class="ep-dot"></span>
            <span class="ep-addr"></span>
            <button class="ep-disc" type="button" title="disconnect">×</button>
          </div>
          <div class="ep-w-note">binds a solana address for $ansem claims. no popup, no redirect - your address stays on this device.</div>
        </div>

        <button class="ep-claim"></button>
        <div class="ep-foot"></div>
      </div>`;
    ov.addEventListener("pointerdown", (e) => {
      if (e.target === ov) this.close();
    });
    document.body.appendChild(ov);
    this.panel = ov;

    this.walletBlock = ov.querySelector(".ep-wallet-block");
    this.connectBtn = ov.querySelector(".ep-connect");
    this.walletInput = ov.querySelector(".ep-wallet") as HTMLInputElement;
    this.addrEl = ov.querySelector(".ep-addr");
    this.claimBtn = ov.querySelector(".ep-claim");

    // "connect wallet" reveals the address field (no wallet-adapter modal, no
    // navigation). pasting a valid solana address binds it as your wallet.
    this.connectBtn?.addEventListener("click", () => {
      this.walletBlock?.classList.add("connecting");
      this.walletInput?.focus();
    });
    this.walletInput.value = this.p.wallet;
    this.walletInput.addEventListener("input", () => {
      const v = this.walletInput!.value.trim().slice(0, 64);
      if (isValidSol(v)) {
        this.setWallet(v);
        fx.toast("wallet connected - play to earn $ansem", "good");
      }
    });
    this.walletInput.addEventListener("keydown", (e) => e.stopPropagation()); // hotkeys stay quiet
    ov.querySelector(".ep-disc")?.addEventListener("click", () => this.setWallet(""));

    ov.querySelector(".ep-close")?.addEventListener("click", () => this.close());
    this.claimBtn!.addEventListener("click", () => void this.claim(this.claimBtn!));
    window.addEventListener("keydown", (e) => {
      if (e.code === "Escape" && this.open) this.close();
    });
    this.refreshWalletUI();
  }

  // bind / clear the connected wallet and refresh the panel
  private setWallet(addr: string) {
    this.p.wallet = addr;
    this.persistSoon();
    if (this.walletInput) this.walletInput.value = addr;
    this.refreshWalletUI();
  }

  // toggle the connect / connected states + the claim button
  private refreshWalletUI() {
    const connected = isValidSol(this.p.wallet);
    this.walletBlock?.classList.toggle("connected", connected);
    if (!connected) this.walletBlock?.classList.remove("connecting");
    if (connected && this.addrEl) this.addrEl.textContent = truncAddr(this.p.wallet);
    const claimReady = !!CLAIM_URL;
    if (this.claimBtn) {
      if (!connected) {
        this.claimBtn.textContent = "connect a wallet to claim";
        this.claimBtn.disabled = true;
      } else {
        this.claimBtn.textContent = claimReady ? "claim $ansem" : "claims open soon";
        this.claimBtn.disabled = !claimReady;
      }
    }
    const foot = this.panel?.querySelector(".ep-foot");
    if (foot) {
      foot.textContent = !connected
        ? "keep stacking renown - it is saved on this device"
        : claimReady
          ? "claims are validated server-side before any $ansem pays out"
          : "$ansem claims open soon - your renown is safe until then";
    }
  }

  // the live claim path (only reachable when VITE_EARN_CLAIM_URL is set): hand
  // the ledger to the payout service and zero the balance ONLY on its confirm.
  private async claim(btn: HTMLButtonElement) {
    if (!CLAIM_URL || this.balance <= 0 || !isValidSol(this.p.wallet)) {
      fx.toast(!isValidSol(this.p.wallet) ? "connect a wallet first" : this.balance <= 0 ? "no renown to claim yet" : "claims open soon", "info");
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
      this.refreshWalletUI();
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
 background:linear-gradient(180deg,rgba(20,26,34,.9),rgba(8,12,18,.9));border:1px solid var(--wow-gold-deep,#a2803f);
 border-radius:6px;padding:7px 12px;cursor:pointer;font:600 12px/1 var(--serif,serif);color:#f3ead3;pointer-events:auto}
#earn-chip.show{display:flex}
#earn-chip:hover{border-color:var(--wow-gold,#c8aa6e)}
#earn-chip .ec-ico{color:var(--wow-gold-bright,#f4d58a)}
#earn-chip .ec-num{color:var(--wow-gold-bright,#f4d58a);font-size:14px;font-weight:800}
#earn-chip .ec-label{color:#9fb0c4;font-size:9px;letter-spacing:.12em;text-transform:uppercase}
#earn-panel{position:fixed;inset:0;z-index:64;display:none;align-items:center;justify-content:center;
 background:rgba(4,7,12,.8);backdrop-filter:blur(4px);font-family:var(--serif,serif)}
#earn-panel.show{display:flex}
#earn-panel .ep-card{position:relative;width:min(410px,92vw);
 background:linear-gradient(180deg,rgba(14,26,44,.97),rgba(6,12,22,.97));border:2px solid var(--wow-gold-deep,#a2803f);
 border-radius:8px;padding:22px 24px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.55),0 24px 60px -20px rgba(0,0,0,.85)}
#earn-panel .ep-close{position:absolute;top:10px;right:12px;background:none;border:none;color:#8a9ab0;
 font-size:20px;cursor:pointer;line-height:1}
#earn-panel .ep-close:hover{color:#f3ead3}
#earn-panel .ep-head{display:flex;gap:12px;align-items:flex-start}
#earn-panel .ep-ico{font-size:24px;color:var(--wow-gold-bright,#f4d58a);line-height:1.1}
#earn-panel .ep-title{font:700 18px/1.1 var(--serif,serif);letter-spacing:.05em;text-transform:uppercase;
 color:var(--wow-gold-bright,#f4d58a)}
#earn-panel .ep-sub{margin-top:5px;font-size:11px;line-height:1.5;color:#b9c2cf}
#earn-panel .ep-balrow{display:flex;align-items:baseline;gap:8px;margin:16px 0 4px}
#earn-panel .ep-balance{font:700 40px/1 var(--serif,serif);color:#f3ead3;text-shadow:0 0 24px rgba(200,170,110,.3)}
#earn-panel .ep-unit{font-size:12px;color:var(--wow-gold,#c8aa6e);letter-spacing:.16em;text-transform:uppercase}
#earn-panel .ep-rates{margin:12px 0;display:flex;flex-direction:column;gap:4px}
#earn-panel .ep-r{display:flex;justify-content:space-between;font-size:11.5px;color:#b9c2cf;
 border-bottom:1px dashed rgba(200,170,110,.16);padding:3px 0}
#earn-panel .ep-r b{color:var(--wow-gold-bright,#f4d58a)}
#earn-panel .ep-wallet-block{margin-top:14px}
#earn-panel .ep-connect{width:100%;display:flex;align-items:center;justify-content:center;gap:9px;
 border:1px solid #6f5321;border-radius:6px;padding:13px;cursor:pointer;
 font:700 14px/1 var(--serif,serif);letter-spacing:.14em;text-transform:uppercase;color:#2a1c07;
 background:linear-gradient(180deg,#f6e2ad,var(--wow-gold,#c8aa6e) 46%,var(--wow-gold-deep,#a2803f));
 box-shadow:inset 0 1px 0 rgba(255,248,220,.7),0 0 22px -6px rgba(200,170,110,.6)}
#earn-panel .ep-connect:hover{filter:brightness(1.07)}
#earn-panel .ep-w-ico{font-size:16px}
#earn-panel .ep-wallet{display:none;width:100%;background:rgba(4,8,14,.85);border:1px solid var(--wow-gold-deep,#a2803f);
 border-radius:6px;color:#f3ead3;font:500 12px/1 ui-monospace,Menlo,monospace;padding:11px 12px;outline:none;box-sizing:border-box}
#earn-panel .ep-wallet:focus{border-color:var(--wow-gold-bright,#f4d58a)}
#earn-panel .ep-connected{display:none;align-items:center;gap:8px;padding:10px 12px;border-radius:6px;
 background:rgba(4,8,14,.7);border:1px solid rgba(74,210,90,.5)}
#earn-panel .ep-dot{width:9px;height:9px;border-radius:50%;background:#4ad25a;box-shadow:0 0 8px #4ad25a;flex:0 0 auto}
#earn-panel .ep-addr{flex:1;font:600 13px/1 ui-monospace,Menlo,monospace;color:#eafce9;letter-spacing:.04em}
#earn-panel .ep-disc{background:none;border:none;color:#8a9ab0;font-size:17px;cursor:pointer;line-height:1;padding:0 2px}
#earn-panel .ep-disc:hover{color:#ff6a5a}
#earn-panel .ep-wallet-block.connecting .ep-connect{display:none}
#earn-panel .ep-wallet-block.connecting .ep-wallet{display:block}
#earn-panel .ep-wallet-block.connected .ep-connect,
#earn-panel .ep-wallet-block.connected .ep-wallet{display:none}
#earn-panel .ep-wallet-block.connected .ep-connected{display:flex}
#earn-panel .ep-w-note{margin-top:7px;font-size:9.5px;line-height:1.5;color:#7d8ba0;letter-spacing:.02em}
#earn-panel .ep-claim{width:100%;margin-top:12px;border:1px solid #6f5321;border-radius:6px;padding:12px;cursor:pointer;
 font:700 14px/1 var(--serif,serif);letter-spacing:.12em;text-transform:uppercase;
 background:linear-gradient(180deg,#f6e2ad,var(--wow-gold,#c8aa6e) 46%,var(--wow-gold-deep,#a2803f));color:#2a1c07}
#earn-panel .ep-claim:disabled{background:linear-gradient(180deg,#2a2f3a,#1a1e26);color:#5b6675;border-color:#2a2f3a;cursor:default}
#earn-panel .ep-foot{margin-top:11px;text-align:center;font-size:9.5px;color:#7d8ba0;letter-spacing:.04em;line-height:1.5}
`;
    document.head.appendChild(st);
  }
}
