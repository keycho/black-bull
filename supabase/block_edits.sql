-- black bull: persisted terrain reshaping (meteor craters, quake fissures,
-- collapsed bridges). the ONLY table the game uses; realtime broadcast +
-- presence need zero schema. apply in the supabase sql editor.
-- last-write-wins per cell via the primary key; the anon (publishable) key
-- may read and write it - terrain damage is public world state.

create table if not exists public.block_edits (
  room text not null,
  x int not null,
  y int not null,
  z int not null,
  type int not null,
  updated_at timestamptz not null default now(),
  primary key (room, x, y, z)
);

alter table public.block_edits enable row level security;

create policy "read world delta" on public.block_edits
  for select to anon, authenticated using (true);
create policy "write world delta" on public.block_edits
  for insert to anon, authenticated with check (true);
create policy "update world delta" on public.block_edits
  for update to anon, authenticated using (true) with check (true);
