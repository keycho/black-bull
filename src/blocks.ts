// black bull - block palette. natural ids 1-5 are used by terrain generation (keep
// their colors). everything else is for building: woods, stone/brick, metals,
// a wide colour range, pastels, neutrals, and bright accent ("glow") blocks.

export const NONE = 0;

export interface Block {
  id: number;
  key: string;
  name: string;
  color: number;
  cat: string;
  drop?: boolean; // obtainable ONLY from enemy drops (kept out of the build palette)
}

export const BLOCKS: Block[] = [
  // natural (1-5 drive terrain gen)
  { id: 1, key: "grass", name: "biomass", color: 0x49c184, cat: "natural" },
  { id: 2, key: "dirt", name: "substrate", color: 0x6e5436, cat: "natural" },
  { id: 3, key: "stone", name: "mineral", color: 0x747a83, cat: "natural" },
  { id: 4, key: "sand", name: "silica", color: 0xcdc08e, cat: "natural" },
  { id: 5, key: "snow", name: "cryo", color: 0xeaf2f8, cat: "natural" },
  { id: 6, key: "gravel", name: "gravel", color: 0x8d8983, cat: "natural" },
  { id: 7, key: "mud", name: "mud", color: 0x6f5436, cat: "natural" },
  { id: 8, key: "moss", name: "moss", color: 0x66a83c, cat: "natural" },
  // wood
  { id: 9, key: "oak", name: "oak wood", color: 0xb27a34, cat: "wood" },
  { id: 10, key: "birch", name: "birch wood", color: 0xdcc182, cat: "wood" },
  { id: 11, key: "darkwood", name: "dark wood", color: 0x6b4a26, cat: "wood" },
  { id: 12, key: "plank", name: "plank", color: 0xc89348, cat: "wood" },
  // stone & brick
  { id: 13, key: "cobble", name: "cobblestone", color: 0x6b6d72, cat: "stone" },
  { id: 14, key: "stonebrick", name: "stone brick", color: 0x82848a, cat: "stone" },
  { id: 15, key: "brick", name: "brick", color: 0xbb4f31, cat: "stone" },
  { id: 16, key: "basalt", name: "basalt", color: 0x3a3b40, cat: "stone" },
  { id: 17, key: "marble", name: "marble", color: 0xeceef0, cat: "stone" },
  { id: 18, key: "slate", name: "slate", color: 0x4a4f57, cat: "stone" },
  // metal
  { id: 19, key: "iron", name: "iron", color: 0xb7bcc2, cat: "metal" },
  { id: 20, key: "copper", name: "copper", color: 0xc6772b, cat: "metal" },
  { id: 21, key: "gold", name: "gold", color: 0xf5c542, cat: "metal" },
  { id: 22, key: "steel", name: "steel", color: 0x7e858d, cat: "metal" },
  // vivid colours
  { id: 23, key: "red", name: "red", color: 0xe23b3b, cat: "color" },
  { id: 24, key: "orange", name: "orange", color: 0xf07b1b, cat: "color" },
  { id: 25, key: "yellow", name: "yellow", color: 0xf5d020, cat: "color" },
  { id: 26, key: "green", name: "green", color: 0x36b34a, cat: "color" },
  { id: 27, key: "teal", name: "teal", color: 0x21c0a0, cat: "color" },
  { id: 28, key: "blue", name: "blue", color: 0x3b82f6, cat: "color" },
  { id: 29, key: "indigo", name: "indigo", color: 0x5b53d6, cat: "color" },
  { id: 30, key: "purple", name: "purple", color: 0x9b51e0, cat: "color" },
  { id: 31, key: "magenta", name: "magenta", color: 0xe23bb0, cat: "color" },
  { id: 32, key: "pink", name: "pink", color: 0xf08bc0, cat: "color" },
  // pastels
  { id: 33, key: "mint", name: "mint", color: 0xa8e6c0, cat: "pastel" },
  { id: 34, key: "sky", name: "sky", color: 0xa9d6f5, cat: "pastel" },
  { id: 35, key: "lilac", name: "lilac", color: 0xcdb6ef, cat: "pastel" },
  { id: 36, key: "peach", name: "peach", color: 0xf5c6a0, cat: "pastel" },
  // neutrals
  { id: 37, key: "white", name: "white", color: 0xf2f4f6, cat: "neutral" },
  { id: 38, key: "grey", name: "grey", color: 0x9aa0a8, cat: "neutral" },
  { id: 39, key: "charcoal", name: "charcoal", color: 0x33363c, cat: "neutral" },
  { id: 40, key: "black", name: "black", color: 0x14161a, cat: "neutral" },
  // bright accent ("glow")
  { id: 41, key: "neongreen", name: "neon green", color: 0x6bff5a, cat: "glow" },
  { id: 42, key: "neoncyan", name: "neon cyan", color: 0x4fe0ff, cat: "glow" },
  { id: 43, key: "neonpink", name: "neon pink", color: 0xff5ad0, cat: "glow" },
  { id: 44, key: "lava", name: "lava", color: 0xff7327, cat: "glow" },
  // warm desert surfaces - high red, low blue so the scene's cool cyan light +
  // teal haze cannot wash them to grey-green (a pale peach does exactly that).
  { id: 45, key: "dunesand", name: "dune sand", color: 0xd9a35c, cat: "natural" },
  { id: 46, key: "terracotta", name: "terracotta", color: 0xb56b43, cat: "natural" },
  // drop-only loot blocks: you can ONLY get these from enemies, never the palette,
  // so combat unlocks building material. by rarity tier (see DROP_BLOCKS).
  { id: 47, key: "cobalt", name: "cobalt", color: 0x3461c4, cat: "loot", drop: true },
  { id: 48, key: "amber", name: "amber", color: 0xe0982f, cat: "loot", drop: true },
  { id: 49, key: "amethyst", name: "amethyst", color: 0x9a5cff, cat: "loot", drop: true },
  { id: 50, key: "aqua", name: "aqua crystal", color: 0x3fe0e0, cat: "loot", drop: true },
  { id: 51, key: "plasma", name: "plasma core", color: 0xff4fae, cat: "loot", drop: true },
  { id: 52, key: "starlight", name: "starlight", color: 0xeaf7ff, cat: "loot", drop: true },
  // legendary - ONLY from the boss (the horde mind). dark teal emissive. kept OUT
  // of the random drop pool so it can never come from a normal enemy.
  { id: 53, key: "hordecore", name: "horde core", color: 0x14d6c2, cat: "loot", drop: true },
  // crafted blocks (made at a crafting station from rare loot; kept OUT of the free
  // palette and unlocked individually when crafted). premium / reinforced / decorative.
  { id: 54, key: "reinforced", name: "reinforced plating", color: 0x5b6573, cat: "craft", drop: true },
  { id: 55, key: "prismatic", name: "prismatic block", color: 0x7fdcff, cat: "craft", drop: true },
  { id: 56, key: "monolith", name: "horde monolith", color: 0x16d6c2, cat: "craft", drop: true },
  // volcanic biome: mineable terrain blocks (obsidian, ash) usable in the build
  // palette like any natural block, plus the magma core (a high-value drop from the
  // magma elemental) and a crafted heat-forged block gated behind it.
  { id: 57, key: "obsidian", name: "obsidian", color: 0x1a1822, cat: "stone" },
  { id: 58, key: "ash", name: "volcanic ash", color: 0x6b6660, cat: "natural" },
  { id: 59, key: "magmacore", name: "magma core", color: 0xff5a1a, cat: "loot", drop: true },
  { id: 60, key: "magmaforged", name: "magma-forged plating", color: 0xc4421a, cat: "craft", drop: true },
];

export const HORDE_CORE = 53; // the boss-only legendary block id
export const MAGMA_CORE = 59; // the volcanic signature drop (high-value resource)

// the loot tables, by drop rarity. only these block ids ever come from enemies.
export const DROP_BLOCKS = {
  common: [47, 48], // cobalt, amber
  uncommon: [49, 50], // amethyst, aqua crystal
  rare: [51, 52], // plasma core, starlight
};
export const RARE_BLOCKS = new Set([...DROP_BLOCKS.rare, HORDE_CORE, MAGMA_CORE]); // legendary visual

const BY_ID = new Map<number, Block>(BLOCKS.map((b) => [b.id, b]));
export function blockColor(id: number): number {
  return BY_ID.get(id)?.color ?? 0x808080;
}
export function blockById(id: number): Block | undefined {
  return BY_ID.get(id);
}

// the building palette = every NON-drop block, in catalogue order. drop-only loot
// blocks join a player's palette individually, as they collect them (see Building).
export const PALETTE = BLOCKS.filter((b) => !b.drop).map((b) => b.id);
