// black bull - multiplayer networking over supabase realtime. two planes:
//
//  - PRESENCE carries the roster + each rider's name and cosmetics (join/leave,
//    the online list, host election).
//  - BROADCAST carries the high-rate game state: bull positions (~15 hz,
//    client-authoritative for its OWN bull only), rams (hitter -> victim),
//    ko announcements, world events + strikes + meteors (host -> everyone),
//    npc snapshots (host -> everyone), terrain edits (host -> everyone, also
//    persisted so late joiners see the reshaped battlefield), and chat.
//
// authority model: each client owns its own bull. one HOST (lowest id present,
// re-elected on leave) owns everything shared: the event scheduler, npc brains,
// and terrain reshaping. receive-side plausibility clamps (knockback caps, ram
// range checks, position snap limits) keep a hostile client from doing anything
// interesting. a dedicated authoritative server can replace the host seat later
// without changing callers - every message already flows through this class.
//
// graceful fallback: with no VITE_SUPABASE_* env vars, enabled = false and every
// method is a no-op, so solo play (host-of-one) runs exactly the same game.

import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { KB_MAX, POS_HZ } from "./config";
import { type Cosmetics, DEFAULT_COSMETICS } from "./bullmodel";

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const ROOM = "black-bull-main"; // one persistent shared world
const SEND_INTERVAL = 1000 / POS_HZ;
const EDIT_FLUSH = 80; // ms between edit-batch broadcasts (coalesces craters)
const EDITS_PER_MSG = 200; // cap edits per broadcast/upsert chunk
const DB_PAGE = 1000; // rows per page when loading the persisted world delta
const EDITS_TABLE = "block_edits";

// numeric state codes on the wire (mirrors bull.ts BullState)
export const ST = { run: 0, charging: 1, launched: 2, stagger: 3, tumble: 4, winded: 5, ko: 6 } as const;

export interface RemoteState {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  st: number; // state code
  charge: number; // 0..1
  momentum: number;
  name: string;
  cos: Cosmetics;
  inWorld: boolean;
  t: number; // last update (performance.now ms)
}

// one npc snapshot row: [id, type, x, y, z, yaw, state]
export type NpcRow = [number, number, number, number, number, number, number];

export interface EventMsg {
  k: string; // event kind
  x: number; // zone centre (world coords; 0,0 if global)
  z: number;
  dur: number;
  data: string; // king id etc.
  seed: number;
}

export class Net {
  enabled = false;
  readonly id: string;
  readonly remotes = new Map<string, RemoteState>();

  private client: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private subscribed = false;
  private joined = false;
  private joinPending = false;
  private myNameV = "rider";
  private myCos: Cosmetics = { ...DEFAULT_COSMETICS };
  private lastSend = 0;
  private looks = new Map<string, { name: string; cos: Cosmetics }>();

  // terrain edits (events reshape the world): outgoing coalesced, incoming applied
  private pendingEdits: EditMsg[] = [];
  private lastEditFlush = 0;
  onRemoteEdit?: (x: number, y: number, z: number, type: number) => void;

  hostId: string;
  private joinedAt = 0;
  onHostChange?: (hostId: string) => void;

  // gameplay callbacks (receive side)
  onRam?: (from: string, dx: number, dz: number, kb: number, up: number, px: number, py: number, pz: number, npc: boolean) => void;
  onRemoteRamFx?: (px: number, py: number, pz: number, kb: number) => void; // a ram we merely witness
  onKo?: (id: string, by: string, x: number, y: number, z: number) => void;
  onRoar?: (id: string) => void;
  onEvent?: (e: EventMsg) => void;
  onStrike?: (x: number, z: number) => void;
  onMeteor?: (x: number, z: number, r: number, delay: number) => void;
  onNpcs?: (rows: NpcRow[]) => void;
  onNpcHit?: (npcId: number, by: string, power: number) => void; // host arbitrates
  onNpcGone?: (npcId: number, by: string, x: number, y: number, z: number, ty: number) => void;
  onChat?: (id: string, name: string, text: string) => void;

  constructor() {
    this.id = globalThis.crypto?.randomUUID?.() ?? "p" + Math.random().toString(36).slice(2, 10);
    this.hostId = this.id; // host until presence says otherwise
    if (!URL || !KEY) return; // solo fallback
    try {
      this.client = createClient(URL, KEY, { realtime: { params: { eventsPerSecond: 40 } } });
      this.enabled = true;
    } catch {
      this.enabled = false;
    }
  }

  get isHost(): boolean {
    return this.hostId === this.id;
  }
  get myName(): string {
    return this.myNameV;
  }
  get myColor(): number {
    // trim colour keys chat + minimap identity
    return [0xe23b3b, 0xf5c542, 0x3b82f6, 0x21c07a, 0x9b51e0, 0xf07b1b][this.myCos.trim % 6];
  }

  connect() {
    if (!this.client) return;
    const ch = this.client.channel(`room:${ROOM}`, {
      config: { presence: { key: this.id }, broadcast: { self: false } },
    });
    ch.on("broadcast", { event: "pos" }, ({ payload }) => this.onPos(payload as PosMsg))
      .on("broadcast", { event: "edits" }, ({ payload }) => {
        const p = payload as EditsMsg;
        if (!p || p.id === this.id || !p.e) return;
        for (const e of p.e) this.onRemoteEdit?.(e.x, e.y, e.z, e.t);
      })
      .on("broadcast", { event: "ram" }, ({ payload }) => {
        const v = payload as RamMsg;
        if (!v || v.id === this.id) return;
        if (v.to === this.id) {
          // plausibility: clamp the shove; ignore rams from someone nowhere near us
          const me = this.selfPos;
          const far = me && Math.hypot(v.px - me.x, v.pz - me.z) > 10;
          if (!far) this.onRam?.(v.id, v.dx, v.dz, Math.min(KB_MAX, v.kb), Math.min(14, v.up), v.px, v.py, v.pz, v.n === 1);
        } else {
          this.onRemoteRamFx?.(v.px, v.py, v.pz, v.kb); // everyone hears the hit
        }
      })
      .on("broadcast", { event: "ko" }, ({ payload }) => {
        const v = payload as KoMsg;
        if (!v || v.id === this.id) return;
        this.onKo?.(v.id, v.by ?? "", v.x, v.y, v.z);
      })
      .on("broadcast", { event: "roar" }, ({ payload }) => {
        const v = payload as { id?: string };
        if (v?.id && v.id !== this.id) this.onRoar?.(v.id);
      })
      .on("broadcast", { event: "event" }, ({ payload }) => {
        const v = payload as EventMsg & { h: string };
        if (!v || v.h === this.id || v.h !== this.hostId) return; // current host only
        this.onEvent?.(v);
      })
      .on("broadcast", { event: "strike" }, ({ payload }) => {
        const v = payload as { h: string; x: number; z: number };
        if (!v || v.h === this.id || v.h !== this.hostId) return;
        this.onStrike?.(v.x, v.z);
      })
      .on("broadcast", { event: "meteor" }, ({ payload }) => {
        const v = payload as { h: string; x: number; z: number; r: number; d: number };
        if (!v || v.h === this.id || v.h !== this.hostId) return;
        this.onMeteor?.(v.x, v.z, v.r, v.d);
      })
      .on("broadcast", { event: "npcs" }, ({ payload }) => {
        const v = payload as { h: string; e: NpcRow[] };
        if (!v || v.h === this.id || v.h !== this.hostId) return;
        this.onNpcs?.(v.e);
      })
      .on("broadcast", { event: "nhit" }, ({ payload }) => {
        const v = payload as { id: number; by: string; pw: number };
        if (v && this.isHost) this.onNpcHit?.(v.id, v.by, v.pw); // only the host arbitrates
      })
      .on("broadcast", { event: "ngone" }, ({ payload }) => {
        const v = payload as { h: string; id: number; by: string; x: number; y: number; z: number; ty: number };
        if (!v || v.h === this.id || v.h !== this.hostId) return;
        this.onNpcGone?.(v.id, v.by, v.x, v.y, v.z, v.ty);
      })
      .on("broadcast", { event: "chat" }, ({ payload }) => {
        const v = payload as { id?: string; name?: string; text?: string };
        if (!v || v.id === this.id || typeof v.text !== "string") return;
        this.onChat?.(v.id ?? "", v.name ?? "rider", v.text);
      })
      .on("presence", { event: "sync" }, () => this.syncPresence())
      .on("presence", { event: "leave" }, ({ key }) => this.drop(key as string))
      .subscribe((status) => {
        this.subscribed = status === "SUBSCRIBED";
        if (this.subscribed && this.joinPending) this.track();
      });
    this.channel = ch;
    this.loadWorldDelta(); // pull the persisted reshaped terrain (craters, fissures)
  }

  // announce ourselves (name + cosmetics) once the rider enters the world
  join(name: string, cos: Cosmetics) {
    this.myNameV = name;
    this.myCos = { ...cos };
    this.joinPending = true;
    this.joinedAt = Date.now();
    if (this.subscribed) this.track();
  }
  updateLook(name: string, cos: Cosmetics) {
    this.myNameV = name;
    this.myCos = { ...cos };
    if (this.subscribed && this.joined) this.track();
  }
  private track() {
    const c = this.myCos;
    this.channel?.track({
      id: this.id,
      name: this.myNameV,
      co: c.coat, tr: c.trim, ho: c.horns, ey: c.eyes, ta: c.trail, hf: c.hooves, ar: c.armor, cr: c.crown, ri: c.rider,
    });
    this.joined = true;
  }

  // the last state we broadcast (for receive-side range checks)
  private selfPos: { x: number; z: number } | null = null;

  // call every frame with the local bull state; self-throttled to POS_HZ.
  setLocal(x: number, y: number, z: number, yaw: number, st: number, charge: number, momentum: number, inWorld: boolean, now: number) {
    this.selfPos = { x, z };
    if (!this.joined || !this.channel) return;
    if (now - this.lastSend < SEND_INTERVAL) return;
    this.lastSend = now;
    this.channel.send({
      type: "broadcast",
      event: "pos",
      payload: {
        id: this.id,
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        z: Math.round(z * 100) / 100,
        yaw: Math.round(yaw * 1000) / 1000,
        s: st,
        c: Math.round(charge * 100) / 100,
        m: Math.round(momentum),
        w: inWorld ? 1 : 0,
      },
    });
  }

  // hitter -> victim: you got rammed (+ everyone else plays the impact fx).
  // npc=true marks a bear/npc shove relayed by the host - no player credit.
  sendRam(to: string, dx: number, dz: number, kb: number, up: number, px: number, py: number, pz: number, npc = false) {
    this.channel?.send({
      type: "broadcast",
      event: "ram",
      payload: { id: this.id, to, dx, dz, kb, up, px, py, pz, n: npc ? 1 : 0 },
    });
  }
  // i wiped out (by = who gets the credit, "" for hazards)
  sendKo(by: string, x: number, y: number, z: number) {
    this.channel?.send({ type: "broadcast", event: "ko", payload: { id: this.id, by, x, y, z } });
  }
  sendRoar() {
    this.channel?.send({ type: "broadcast", event: "roar", payload: { id: this.id } });
  }

  // --- host -> everyone: world events + their moving parts ---
  sendEvent(e: EventMsg) {
    this.channel?.send({ type: "broadcast", event: "event", payload: { h: this.id, ...e } });
  }
  sendStrike(x: number, z: number) {
    this.channel?.send({ type: "broadcast", event: "strike", payload: { h: this.id, x, z } });
  }
  sendMeteor(x: number, z: number, r: number, delay: number) {
    this.channel?.send({ type: "broadcast", event: "meteor", payload: { h: this.id, x, z, r, d: delay } });
  }
  sendNpcs(rows: NpcRow[]) {
    this.channel?.send({ type: "broadcast", event: "npcs", payload: { h: this.id, e: rows } });
  }
  // non-host -> host: i rammed npc `id` this hard
  sendNpcHit(id: number, power: number) {
    this.channel?.send({ type: "broadcast", event: "nhit", payload: { id, by: this.id, pw: power } });
  }
  // host -> everyone: npc `id` is out (rammed away / claimed), credit `by`
  sendNpcGone(id: number, by: string, x: number, y: number, z: number, ty: number) {
    this.channel?.send({ type: "broadcast", event: "ngone", payload: { h: this.id, id, by, x, y, z, ty } });
  }

  // --- terrain edits (event reshaping) ---
  sendEdit(x: number, y: number, z: number, type: number) {
    if (!this.enabled) return;
    this.pendingEdits.push({ x, y, z, t: type });
  }
  tick(now: number) {
    if (!this.channel || !this.pendingEdits.length) return;
    if (now - this.lastEditFlush < EDIT_FLUSH) return;
    this.lastEditFlush = now;
    const chunk = this.pendingEdits.splice(0, EDITS_PER_MSG);
    this.channel.send({ type: "broadcast", event: "edits", payload: { id: this.id, e: chunk } });
    this.persistEdits(chunk);
  }
  // persist so a late joiner sees every crater; last-write-wins on (room,x,y,z).
  // degrades silently if the table is missing - the live broadcast still works.
  private persistEdits(chunk: EditMsg[]) {
    if (!this.client) return;
    const rows = chunk.map((e) => ({ room: ROOM, x: e.x, y: e.y, z: e.z, type: e.t }));
    this.client
      .from(EDITS_TABLE)
      .upsert(rows, { onConflict: "room,x,y,z" })
      .then(({ error }) => {
        if (error) console.warn("[net] persist edits failed:", error.message);
      });
  }
  private async loadWorldDelta() {
    if (!this.client) return;
    try {
      for (let from = 0; ; from += DB_PAGE) {
        const { data, error } = await this.client
          .from(EDITS_TABLE)
          .select("x,y,z,type")
          .eq("room", ROOM)
          .range(from, from + DB_PAGE - 1);
        if (error) {
          console.warn("[net] load world delta failed:", error.message);
          return;
        }
        if (!data || data.length === 0) return;
        for (const r of data) this.onRemoteEdit?.(r.x, r.y, r.z, r.type);
        if (data.length < DB_PAGE) return;
      }
    } catch (e) {
      console.warn("[net] load world delta error:", e);
    }
  }

  // chat rides the public broadcast plane; own messages echo locally.
  sendChat(text: string): string {
    const t = text.replace(/\s+/g, " ").trim().slice(0, 160);
    if (!t || !this.channel) return "";
    this.channel.send({ type: "broadcast", event: "chat", payload: { id: this.id, name: this.myName, text: t } });
    return t;
  }

  private onPos(p: PosMsg) {
    if (!p || p.id === this.id) return; // ignore our own echo / id spoof
    const r = this.remotes.get(p.id);
    if (r) {
      r.x = p.x;
      r.y = p.y;
      r.z = p.z;
      r.yaw = p.yaw;
      r.st = p.s ?? 0;
      r.charge = p.c ?? 0;
      r.momentum = p.m ?? 0;
      r.inWorld = p.w === 1;
      r.t = performance.now();
    } else {
      const look = this.looks.get(p.id);
      this.remotes.set(p.id, {
        id: p.id,
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
        st: p.s ?? 0,
        charge: p.c ?? 0,
        momentum: p.m ?? 0,
        name: look?.name ?? "rider",
        cos: look?.cos ?? { ...DEFAULT_COSMETICS },
        inWorld: p.w === 1,
        t: performance.now(),
      });
    }
  }

  private syncPresence() {
    if (!this.channel) return;
    const state = this.channel.presenceState() as Record<
      string,
      Array<{ id?: string; name?: string; co?: number; tr?: number; ho?: number; ey?: number; ta?: number; hf?: number; ar?: number; cr?: number; ri?: number }>
    >;
    const present = new Set<string>();
    this.looks.clear();
    let host = "";
    for (const key in state) {
      const m = state[key][0];
      const id = m?.id ?? key;
      present.add(id);
      this.looks.set(id, {
        name: typeof m?.name === "string" ? m.name : "rider",
        cos: {
          coat: m?.co ?? 0, trim: m?.tr ?? 0, horns: m?.ho ?? 0, eyes: m?.ey ?? 0,
          trail: m?.ta ?? 0, hooves: m?.hf ?? 0, armor: m?.ar ?? 0, crown: m?.cr ?? 0, rider: m?.ri ?? 0,
        },
      });
      if (!host || id < host) host = id; // host = lowest id present
    }
    // apply looks + prune anyone no longer present (missed leaves)
    for (const [id, r] of this.remotes) {
      const look = this.looks.get(id);
      if (look) {
        r.name = look.name;
        r.cos = look.cos;
      }
      if (id !== this.id && !present.has(id)) this.remotes.delete(id);
    }
    // a single agreed-upon authority; changes on host join/leave -> handoff
    const newHost = host || this.id;
    if (newHost !== this.hostId) {
      this.hostId = newHost;
      this.onHostChange?.(newHost);
    }
  }

  private drop(key: string) {
    this.remotes.delete(key);
    this.looks.delete(key);
  }

  get onlineCount(): number {
    return (this.joined ? 1 : 0) + this.remotes.size;
  }
  get joinedRoomAt(): number {
    return this.joinedAt;
  }
}

interface PosMsg {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  s?: number; // state code
  c?: number; // charge 0..1
  m?: number; // momentum
  w?: number; // 1 = in world
}
interface RamMsg {
  id: string; // hitter
  to: string; // victim
  dx: number;
  dz: number;
  kb: number;
  up: number;
  px: number;
  py: number;
  pz: number;
  n?: number; // 1 = an npc shove relayed by the host (no player credit)
}
interface KoMsg {
  id: string;
  by?: string;
  x: number;
  y: number;
  z: number;
}
interface EditMsg {
  x: number;
  y: number;
  z: number;
  t: number; // block type, 0 = broken
}
interface EditsMsg {
  id: string;
  e: EditMsg[];
}
