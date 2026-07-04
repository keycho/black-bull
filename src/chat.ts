// black bull - player chat. a SLIM bottom-left overlay: a few recent lines
// over the world and a tiny "enter · chat" hint. press enter to open the
// input, enter to send, esc to cancel; the box only grows while typing.
// messages ride the public realtime broadcast plane (net.sendChat); incoming
// ones arrive via net.onChat, own messages echo locally (broadcast is
// self:false, and solo play echoes too). every name + body is html-escaped,
// length-capped, and sends are rate-limited. focusing the box releases
// pointer lock so typing works + stops key propagation so hotkeys stay quiet.

interface ChatDeps {
  canUse: () => boolean; // chat allowed (in the world)
  inWorld: () => boolean; // playing (re-lock the pointer when you finish typing)
  self: () => { name: string; color: number };
  send: (text: string) => string; // net.sendChat; returns the trimmed text sent, or ""
}

interface Msg { name: string; text: string; color: number; }

const HISTORY = 40;
const SEND_COOLDOWN = 700;

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));

export class Chat {
  private root: HTMLElement | null = null;
  private logEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private msgs: Msg[] = [];
  private lastSendAt = 0;

  constructor(private d: ChatDeps) {
    if (typeof document === "undefined") return;
    this.injectStyle();
    this.build();
    // capture phase so enter reliably focuses chat before other game keydown handlers
    window.addEventListener("keydown", (e) => this.onKey(e), true);
  }

  private build() {
    const root = document.createElement("div");
    root.id = "chat";
    root.innerHTML =
      `<div class="chat-log"></div>` +
      `<input class="chat-input" type="text" maxlength="160" autocomplete="off" spellcheck="false" placeholder="say something" />` +
      `<div class="chat-hint">enter · chat</div>`;
    document.body.appendChild(root);
    this.root = root;
    this.logEl = root.querySelector(".chat-log");
    this.inputEl = root.querySelector(".chat-input");
    this.inputEl?.addEventListener("keydown", (e) => this.onInputKey(e));
    this.inputEl?.addEventListener("focus", () => this.root?.classList.add("typing"));
    this.inputEl?.addEventListener("blur", () => this.root?.classList.remove("typing"));
  }

  // window keydown (capture). focuses the input on enter; while typing the input owns keys.
  private onKey(e: KeyboardEvent) {
    if (e.repeat || (e.code !== "Enter" && e.code !== "NumpadEnter")) return;
    const a = document.activeElement;
    if (a === this.inputEl) return; // already typing -> the input's handler submits
    if (a && /input|textarea|select/i.test(a.tagName)) return; // typing elsewhere
    if (!this.d.canUse()) return;
    e.preventDefault();
    this.focusInput();
  }

  private focusInput() {
    if (!this.inputEl) return;
    // reveal the box BEFORE focusing - anything display:none cannot take focus
    this.root?.classList.add("show");
    this.root?.classList.add("typing");
    const doFocus = () => {
      if (this.root?.classList.contains("typing")) this.inputEl?.focus();
    };
    if (document.pointerLockElement) {
      // releasing pointer lock is async in some browsers; focus can be refused
      // until it actually lets go, so retry on the change event + a timer
      try { document.exitPointerLock(); } catch { /* ignore */ }
      const once = () => {
        document.removeEventListener("pointerlockchange", once);
        doFocus();
      };
      document.addEventListener("pointerlockchange", once);
      window.setTimeout(doFocus, 90);
    }
    doFocus();
  }

  private onInputKey(e: KeyboardEvent) {
    if (e.code === "Enter" || e.code === "NumpadEnter") { e.preventDefault(); e.stopPropagation(); this.submit(); }
    else if (e.code === "Escape") { e.preventDefault(); e.stopPropagation(); this.dismiss(); }
    else e.stopPropagation(); // keep game hotkeys from firing while typing
  }

  private submit() {
    const raw = this.inputEl?.value ?? "";
    if (raw.trim()) {
      const now = performance.now();
      if (now - this.lastSendAt >= SEND_COOLDOWN) {
        const t = this.d.send(raw);
        if (t) {
          this.lastSendAt = now;
          const me = this.d.self();
          this.add(me.name, t, me.color); // echo our own (broadcast is self:false)
        }
      }
    }
    if (this.inputEl) this.inputEl.value = "";
    this.dismiss();
  }

  private dismiss() {
    this.root?.classList.remove("typing");
    this.inputEl?.blur();
    if (this.d.inWorld()) { try { document.body.requestPointerLock(); } catch { /* ignore */ } }
  }

  // an incoming message (or our own echo). name + text are escaped here.
  add(name: string, text: string, color: number) {
    this.msgs.push({ name: esc(name).slice(0, 80), text: esc(text).slice(0, 320), color: color & 0xffffff });
    if (this.msgs.length > HISTORY) this.msgs.shift();
    this.render();
  }

  setVisible(on: boolean) {
    this.root?.classList.toggle("show", on);
    if (!on && document.activeElement === this.inputEl) this.inputEl?.blur();
  }

  private render() {
    if (!this.logEl) return;
    this.logEl.innerHTML = this.msgs
      .map((m) => `<div class="chat-line"><span class="chat-name" style="color:#${m.color.toString(16).padStart(6, "0")}">${m.name}</span><span class="chat-text">${m.text}</span></div>`)
      .join("");
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private injectStyle() {
    if (document.getElementById("blackbull-chat-style")) return;
    const st = document.createElement("style");
    st.id = "blackbull-chat-style";
    st.textContent = `
#chat{position:fixed;left:12px;bottom:14px;width:min(240px,42vw);z-index:39;display:none;flex-direction:column;
 font-family:ui-monospace,Menlo,Consolas,monospace;pointer-events:none}
#chat.show{display:flex}
#chat .chat-log{display:flex;flex-direction:column;gap:1px;max-height:58px;overflow-y:auto;padding:2px 0;
 scrollbar-width:none;mask-image:linear-gradient(180deg,transparent 0,#000 18%)}
#chat .chat-log::-webkit-scrollbar{display:none}
#chat.typing .chat-log{max-height:110px;background:rgba(5,10,6,.82);border:1px solid #1e3020;border-radius:8px 8px 0 0;padding:6px 9px}
#chat .chat-line{font-size:11px;line-height:1.35;text-shadow:0 1px 2px rgba(0,0,0,.85);word-break:break-word}
#chat .chat-name{font-weight:700;margin-right:5px}
#chat .chat-name::after{content:":"}
#chat .chat-text{color:#e9f2e9}
#chat .chat-input{display:none;pointer-events:auto;background:rgba(5,10,6,.92);border:1px solid #1e3020;border-top:none;
 border-radius:0 0 8px 8px;color:#eaffef;font:inherit;font-size:12px;padding:7px 9px;outline:none}
#chat.typing .chat-input{display:block;border-color:#39ff64}
#chat.typing .chat-log{border-color:#39ff64;border-bottom:none}
#chat .chat-input::placeholder{color:#547c5e}
#chat .chat-hint{margin-top:3px;font-size:9px;letter-spacing:.12em;color:#54685a;text-shadow:0 1px 2px rgba(0,0,0,.8)}
#chat.typing .chat-hint{display:none}
`;
    document.head.appendChild(st);
  }
}
