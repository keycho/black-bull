// black bull - shared world + gameplay constants (no deps, importable anywhere).
// every feel number lives here: world shape, bull movement, the charge system,
// momentum, world events. never hardcode these elsewhere.

// --- world ---------------------------------------------------------------
export const GRID = 1024; // terrain cells per side (one continent battlefield)
export const CHUNK = 32; // voxel render chunk size (must divide GRID)
export const CELL = 1.0; // world units per cell
export const WORLD = GRID * CELL;
export const SEA = 2.1; // sea level in voxel heights

// heightmap shaping
export const BASE_AMP = 7; // rolling base relief
export const MTN_AMP = 26; // added mountain height

// the central colosseum arena
export const ARENA_R = 40; // flat fighting pit radius (cells)
export const ARENA_WALL_R = 47; // outer wall radius
export const ARENA_FLOOR = 6; // pit floor height (voxels)

// --- bull movement (units/sec unless noted) ------------------------------
export const BULL_R = 0.62; // half-width of the bull collision box
export const BULL_H = 1.9; // hoof to shoulder hump
export const GALLOP = 10.5; // base top speed
export const ACCEL = 24; // ground acceleration toward input
export const TURN_RATE = 3.1; // rad/s the body can swing at walking pace
export const TURN_RATE_FAST = 1.7; // rad/s at full gallop (wide, drifty arcs)
export const LAT_GRIP_LOW = 9; // lateral friction at low speed (planted)
export const LAT_GRIP_HIGH = 2.2; // lateral friction at speed (slides + drifts)
export const DRAG_GROUND = 3.4; // forward drag with no input
export const GRAVITY = 26;
export const JUMP = 9.2; // bulls jump; ramps become launch pads
export const STEP = 1.05; // auto step-up height (climbs single blocks)
export const BOUNCE = 0.42; // wall restitution at ram speed
export const BOUNCE_MIN_SPEED = 12; // below this a wall just stops you

// --- charge system --------------------------------------------------------
export const CHARGE_TIME = 1.15; // s of holding lmb for a full stampede
export const CHARGE_SLOW = 0.55; // move-speed factor while winding up
export const DASH_SPEED = 16; // release at 0 charge
export const STAMPEDE_SPEED = 34; // release at full charge (before momentum)
export const LAUNCH_STEER = 0.35; // steering authority while launched
export const LAUNCH_DRAG = 5.2; // decel while launched (sets ram range)
export const CHARGE_COOLDOWN = 0.9; // s after a launch ends before recharging
export const WINDED_TIME = 1.25; // s vulnerable after a missed heavy charge
export const WINDED_SLOW = 0.5; // speed factor while winded
export const WINDED_MIN_CHARGE = 0.55; // only heavy charges leave you winded

// --- impacts ---------------------------------------------------------------
export const RAM_SPEED_MIN = 12.5; // moving faster than this = a live ram
export const HIT_RADIUS = 2.3; // centre distance that counts as contact
export const KB_BASE = 9; // knockback at minimum ram speed
export const KB_SCALE = 0.85; // + this per unit of speed over the minimum
export const KB_UP = 6.8; // upward pop on every launch hit
export const KB_MAX = 46; // hard cap (also the receive-side sanity clamp)
export const STAGGER_TIME = 0.8; // s of lost control after being rammed
export const TUMBLE_KB = 26; // knockback at/above this = full tumble
export const TUMBLE_TIME = 1.5; // s of ragdoll tumble
export const SELF_SLOW = 0.35; // your speed keeps this fraction on a landed hit
export const WIPEOUT_TIME = 2.4; // s on the ko screen before respawn
export const KILL_CREDIT_S = 3.5; // a wipeout within this of a ram credits the rammer
export const LAVA_TIME = 0.45; // s standing on lava before it wipes you out

// --- momentum ---------------------------------------------------------------
export const MOMENTUM_CAP = 1200;
export const M_RAM_MIN = 8; // landing a dash
export const M_RAM_MAX = 22; // landing a full stampede
export const M_WIPEOUT = 30; // causing a wipeout
export const M_SURVIVE_S = 8; // +1 momentum per this many seconds alive
export const M_GOLDEN = 30; // claiming a golden bull
export const M_BEAR = 18; // ramming a bear out of the world
export const M_WILD = 6; // ramming a wild bull
export const M_KING_BOUNTY = 80; // wiping out the king / surviving as king
export const M_HIT_LOSS = 6; // taken when rammed
export const M_WIPE_FRAC = 0.35; // fraction of momentum lost on a wipeout
export const M_ALPHA_TRICKLE = 0.5; // momentum/s while you are the alpha
// perks scale with momentum/cap - deliberately small so skill always wins
export const PERK_SPEED = 0.1; // up to +10% top speed
export const PERK_POWER = 0.18; // up to +18% knockback
export const ALPHA_MIN = 200; // floor to be crowned alpha at all
export const TIERS = [0, 150, 400, 800, 1200] as const; // horn-glow tiers

// --- world events -----------------------------------------------------------
export const EVENT_EVERY = 170; // s between global events (host rolls)
export const EVENT_WARN = 5; // s of banner warning before it starts
export const STAMPEDE_DUR = 40; // everyone fast
export const STAMPEDE_MULT = 1.45;
export const METEOR_DUR = 42; // falling rocks reshape the battlefield
export const METEOR_COUNT = 22;
export const METEOR_ZONE_R = 130;
export const BEARS_DUR = 75; // ai bears invade
export const BEARS_COUNT = 8;
export const KING_DUR = 60; // one player marked, everyone hunts
export const STORM_DUR = 45; // lightning strikes create danger zones
export const STORM_STRIKE_EVERY = 1.6;
export const GOLD_DUR = 55; // rare collectible bulls spawn
export const GOLD_COUNT = 5;
export const QUAKE_DUR = 18; // terrain shifts, fissures open, a bridge falls

// --- npcs --------------------------------------------------------------------
export const WILD_HERD = 14; // ambient wild bulls roaming the plains
export const NPC_SYNC_HZ = 8; // host -> everyone npc snapshot rate
export const BEAR_SWIPE_KB = 15;
export const BEAR_SWIPE_R = 2.6;

// white bulls: the hostile herd - they hunt riders in packs, telegraph a
// wind-up, then charge. dodge the line, counter-ram them while they recover.
export const WHITE_COUNT = 12; // roaming white bulls (packs of ~3)
export const WHITE_HP = 3; // rams to break one
export const WHITE_KB = 19; // knockback when one connects with you
export const WHITE_CHARGE_SPEED = 23;
export const WHITE_AGGRO_R = 30; // they notice you inside this
export const WHITE_WINDUP = 0.9; // s of telegraph before the charge commits
export const WHITE_CHARGE_T = 1.5; // max s a charge runs
export const WHITE_COOLDOWN = 2.6; // s between charges (the counter window)
export const M_WHITE = 20; // breaking a white bull
export const M_WHITE_HIT = 4; // each ram that connects on one

// --- networking ----------------------------------------------------------------
export const POS_HZ = 15; // local bull state broadcast rate
export const MAX_REMOTE_SPEED = 60; // receive-side clamp: drop impossible teleports
