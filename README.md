# black bull

charges forward. no matter what.

the herd's massively multiplayer browser game: every player permanently rides
a powerful black bull. no guns. no swords. only bulls. black + neon green +
amber, glowing horns, crimson eyes - built for the $ansem community. built on
a proven voxel engine (chunked instanced terrain, realtime networking,
interpolation, procedural audio, minimap, chat, cinematic camera).

built with three.js + typescript + vite, multiplayer over supabase realtime.

## the game

- **one persistent battlefield.** a huge voxel continent: a central colosseum
  arena ringed by seven biomes (green plains, ancient ruins, red canyon,
  crystal fields, ash valley, obsidian mountains, storm plateau), cut by two
  rivers with bridges. players join and leave freely - no lobbies, no resets.
- **the charge system.** hold left mouse to wind up, release to launch - a
  quick dash at a tap, a devastating stampede at full charge. hits launch
  riders with knockback scaled by speed; missing a heavy charge leaves you
  briefly winded. knock riders into water, lava or off cliffs to wipe them out.
- **momentum.** landing charges, surviving, claiming objectives and winning
  events build momentum: a little speed, a little knockback (always
  counterable - skill beats progression) and a lot of visual power - horn glow
  tiers, bigger dust, louder charges.
- **the alpha bull.** whoever holds the most momentum wears a floating golden
  crown with a light beam, visible across the map. surviving as alpha builds
  score. the whole server naturally hunts them.
- **white bulls.** the hostile herd: they roam in packs, hunt riders,
  telegraph a wind-up and commit to a straight charge - sidestep the line and
  counter-ram them in the recovery window. three hits breaks one; every hit
  pays momentum, the break pays more, and 25 breaks unlock the toxic trail.
- **world events** every few minutes: stampede, meteor shower (permanently
  reshapes the terrain), bear invasion, king bull, lightning storm, golden
  herd, earthquake (opens fissures + collapses bridges).
- **cosmetics only.** horns, eyes, trails, hooves, armor, crown and roars
  unlock by playing. nothing bought or unlocked changes gameplay odds.
- **the signature rider.** every bull is ridden by the community's signature
  rider - tall curly high-top over faded sides, chin-strap goatee - in one of
  his three outfits (heather crew, sunshine tee, studio grey), selectable in
  the stable. the original helmeted rider remains as "visor classic".

## run locally

```bash
npm install
npm run dev      # http://localhost:5173
```

solo works out of the box (you become a host-of-one; wild herd, events and
physics all run locally).

## multiplayer

create a supabase project, enable nothing special (realtime broadcast +
presence need zero schema), and set in `.env`:

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

optional: create a `block_edits` table (room text, x int, y int, z int, type
int, primary key (room,x,y,z)) so event terrain damage (craters, fissures,
collapsed bridges) persists for late joiners. without it the reshaping still
syncs live and everything else works.

### authority model

each client is authoritative for its OWN bull only (positions ride realtime
broadcast, ~15 hz, interpolated). one host - the lowest id present, re-elected
on leave - owns everything shared: the event scheduler, npc brains (wild herd,
golden bulls, bears) and terrain reshaping, which flows through a synced +
persisted edit pipeline. receive-side plausibility clamps (knockback caps, ram
range checks) bound what a hostile client can do. a dedicated authoritative
server can replace the host seat later without changing callers - every
message already flows through `src/net.ts`.

## build / deploy

```bash
npm run build    # tsc --noEmit + vite build -> dist/
npm run preview
```

static vite app at the repo root - import the repo into vercel and it
auto-detects vite, builds with `npm run build`, and serves `dist/`. no
config needed. for multiplayer, add the two `VITE_SUPABASE_*` env vars
in the vercel project settings.
