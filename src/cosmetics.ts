// black bull - cosmetics: VISUAL ONLY unlocks, earned by playing. nothing here
// changes speed, knockback or any gameplay number - that is a hard rule. the
// catalog maps each option to an unlock requirement over the lifetime stats;
// the chosen look persists in localStorage and rides presence so everyone sees
// your bull the way you built it.

import { type Cosmetics, DEFAULT_COSMETICS } from "./bullmodel";
import type { Stats } from "./momentum";

const LS_KEY = "blackbull.look.v1";

export interface Option {
  cat: keyof Cosmetics; // which cosmetic slot
  idx: number; // option index within the slot
  name: string;
  req: string; // human-readable requirement ("" = always unlocked)
  unlocked: (s: Stats) => boolean;
}

export const CATALOG: Option[] = [
  // rider styles: the signature rider's three outfits (all free), plus the
  // original helmeted rider as a throwback
  { cat: "rider", idx: 0, name: "heather crew", req: "", unlocked: () => true },
  { cat: "rider", idx: 1, name: "sunshine tee", req: "", unlocked: () => true },
  { cat: "rider", idx: 2, name: "studio grey", req: "", unlocked: () => true },
  { cat: "rider", idx: 3, name: "visor classic", req: "", unlocked: () => true },
  // horns - the neon green-gold glow is the signature look, free for the herd
  { cat: "horns", idx: 0, name: "neon horns", req: "", unlocked: () => true },
  { cat: "horns", idx: 1, name: "obsidian horns", req: "land 25 charges", unlocked: (s) => s.rams >= 25 },
  { cat: "horns", idx: 2, name: "crystal horns", req: "reach 600 momentum", unlocked: (s) => s.best >= 600 },
  { cat: "horns", idx: 3, name: "inferno horns", req: "cause 10 wipeouts", unlocked: (s) => s.wipeouts >= 10 },
  // eyes
  { cat: "eyes", idx: 0, name: "crimson eyes", req: "", unlocked: () => true },
  { cat: "eyes", idx: 1, name: "void eyes", req: "hold alpha for 120s total", unlocked: (s) => s.alphaS >= 120 },
  // trails
  { cat: "trail", idx: 0, name: "dust trail", req: "", unlocked: () => true },
  { cat: "trail", idx: 1, name: "lightning trail", req: "win 3 events", unlocked: (s) => s.events >= 3 },
  { cat: "trail", idx: 2, name: "fire trail", req: "land 50 charges", unlocked: (s) => s.rams >= 50 },
  { cat: "trail", idx: 3, name: "toxic trail", req: "break 25 white bulls", unlocked: (s) => s.whites >= 25 },
  // hooves
  { cat: "hooves", idx: 0, name: "iron hooves", req: "", unlocked: () => true },
  { cat: "hooves", idx: 1, name: "fire hooves", req: "claim 5 golden bulls", unlocked: (s) => s.golden >= 5 },
  // armor
  { cat: "armor", idx: 0, name: "no armor", req: "", unlocked: () => true },
  { cat: "armor", idx: 1, name: "ancient bull armor", req: "reach 1000 momentum", unlocked: (s) => s.best >= 1000 },
  // crown
  { cat: "crown", idx: 0, name: "no crown", req: "", unlocked: () => true },
  { cat: "crown", idx: 1, name: "golden crown", req: "hold alpha for 600s total", unlocked: (s) => s.alphaS >= 600 },
];

export interface Look {
  name: string;
  cos: Cosmetics;
}

export function loadLook(): Look {
  const fallback: Look = { name: "", cos: { ...DEFAULT_COSMETICS } };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<Look> & { cos?: Partial<Cosmetics> };
    const cos = { ...DEFAULT_COSMETICS };
    if (p.cos) {
      for (const k of Object.keys(cos) as (keyof Cosmetics)[]) {
        const v = p.cos[k];
        if (typeof v === "number" && isFinite(v)) cos[k] = v;
      }
    }
    return { name: typeof p.name === "string" ? p.name.slice(0, 16) : "", cos };
  } catch {
    return fallback;
  }
}

export function saveLook(look: Look) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(look));
  } catch {
    /* ignore */
  }
}

// clamp a saved look so nothing locked leaks in (e.g. stats cleared)
export function sanitizeLook(look: Look, stats: Stats): Look {
  const cos = { ...look.cos };
  for (const opt of CATALOG) {
    if (cos[opt.cat] === opt.idx && !opt.unlocked(stats)) cos[opt.cat] = 0;
  }
  return { name: look.name, cos };
}
