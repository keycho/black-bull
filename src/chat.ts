// black bull - player chat. a proper bordered box (bottom-left): a header, a scrollable
// message log, and an always-visible input row. press enter to focus + type, enter to
// send, esc to cancel. messages ride the public realtime broadcast plane (net.sendChat);
// incoming ones arrive via net.onChat, own messages echo locally (broadcast is
// self:false). every name + body is html-escaped before it touches the dom, length-
// capped, and sends are rate-limited. focusing the box releases pointer lock so typing
// works (and movement halts) + stops key propagation so hotkeys do not fire while typing.

interface ChatDeps {
  canUse: () => boolean; // chat allowed (lobby or playing)
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
      `<div class="chat-head">room chat</div>` +
      `<div class="chat-log"></div>` +
      `<input class="chat-input" type="text" maxlength="160" autocomplete="off" spellcheck="false" placeholder="press enter to chat" />`;
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
    if (document.pointerLockElement) { try { document.exitPointerLock(); } catch { /* ignore */ } }
    this.inputEl.focus();
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
#chat{position:fixed;left:12px;bottom:50px;width:min(340px,46vw);z-index:39;display:none;flex-direction:column;
 background:rgba(6,12,15,.66);border:1px solid #15363a;border-radius:9px;box-shadow:0 10px 30px -12px rgba(0,0,0,.8);
 font-family:ui-monospace,Menlo,Consolas,monospace;overflow:hidden;pointer-events:auto}
#chat.show{display:flex}
#chat.typing{background:rgba(7,14,17,.92);border-color:#2fe6c2}
#chat .chat-head{color:#3a8f86;font-size:9px;letter-spacing:.2em;text-transform:uppercase;padding:7px 11px 5px}
#chat .chat-log{display:flex;flex-direction:column;gap:2px;height:122px;overflow-y:auto;padding:0 11px 7px;
 scrollbar-width:thin;scrollbar-color:#1c4a44 transparent}
#chat .chat-log::-webkit-scrollbar{width:6px}
#chat .chat-log::-webkit-scrollbar-thumb{background:#1c4a44;border-radius:3px}
#chat .chat-line{font-size:12.5px;line-height:1.4;text-shadow:0 1px 2px rgba(0,0,0,.6);word-break:break-word}
#chat .chat-name{font-weight:700;margin-right:6px}
#chat .chat-name::after{content:":"}
#chat .chat-text{color:#e6f0f2}
#chat .chat-input{pointer-events:auto;background:#0a161a;border:none;border-top:1px solid #15363a;color:#eafff8;
 font:inherit;font-size:13px;padding:9px 11px;outline:none}
#chat .chat-input::placeholder{color:#54767c}
#chat.typing .chat-input{background:#0c1c21}
`;
    document.head.appendChild(st);
  }
}
