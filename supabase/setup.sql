-- Grok Bot Worlds: one events table for live mode.
--
-- Who can do what, once this has run:
--   Anyone with the page:  read events (the anon key is public by design).
--   The grok bot:          add events, by calling post_event with its write key.
--   Nobody else:           no direct insert, update or delete through the API.
--
-- Before running: in post_event below, put the sha256 hex of the write key where the placeholder is.
-- The database keeps only that hash. The write key itself lives in the grok bot's secrets and nowhere else.
-- If the placeholder is left in, every write is refused. The key must be long and random (32 random bytes),
-- since the hash is not a secret from anyone who can read the database catalogue.
--
-- Everything in the table is readable by anyone who has the page. Keep client names and private details out.
--
-- Safe to run again: it updates the policies and the function and leaves existing events alone.

create table if not exists public.events (
  id         bigint generated always as identity primary key,
  bot_id     text        not null check (char_length(bot_id) between 1 and 64),
  type       text        not null check (type in ('idle', 'working', 'found', 'done', 'needs_approval')),
  text       text        not null default '' check (char_length(text) <= 200),
  "timestamp" timestamptz not null default now(),
  value      double precision
);

-- The page asks for the newest rows, and a bot's latest state. These keep both fast as the table grows.
create index if not exists events_timestamp_idx on public.events ("timestamp" desc);
create index if not exists events_bot_timestamp_idx on public.events (bot_id, "timestamp" desc);

-- Row level security on. API roles only get what the policy below allows. The table owner is not subject to it,
-- and post_event runs as the owner, which is how a checked write gets in.
alter table public.events enable row level security;

-- These roles exist on every Supabase project. Created here only so the file also runs on plain Postgres.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

-- Public read, nothing else. There is deliberately no insert, update or delete policy.
drop policy if exists events_public_read on public.events;
create policy events_public_read on public.events for select to anon, authenticated using (true);

revoke all on public.events from public, anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on public.events to anon, authenticated;

-- The only way in. It checks the write key against the hash, then inserts one row as the function owner.
-- The grok bot calls it with the public anon key plus its write key:
--   POST https://YOUR-PROJECT.supabase.co/rest/v1/rpc/post_event
--   {"write_key":"...","bot_id":"research","type":"working","text":"reading new mentions"}
create or replace function public.post_event(
  write_key text,
  bot_id text,
  type text,
  text text default '',
  value double precision default null,
  event_time timestamptz default null
) returns bigint
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  expected constant text := 'REPLACE_WITH_SHA256_OF_WRITE_KEY';
  new_id bigint;
begin
  if expected !~ '^[0-9a-f]{64}$' then
    raise exception 'writes are off: the write key hash was not set in setup.sql' using errcode = '42501';
  end if;
  if write_key is null or encode(sha256(convert_to(write_key, 'UTF8')), 'hex') <> expected then
    raise exception 'wrong write key' using errcode = '42501';
  end if;
  insert into public.events (bot_id, type, text, value, "timestamp")
  values (post_event.bot_id, post_event.type, coalesce(post_event.text, ''), post_event.value, coalesce(post_event.event_time, now()))
  returning id into new_id;
  return new_id;
end;
$fn$;

-- Anyone may call it (it refuses without the key). This keeps the bot from needing the all powerful service key.
revoke all on function public.post_event(text, text, text, text, double precision, timestamptz) from public;
grant execute on function public.post_event(text, text, text, text, double precision, timestamptz) to anon, authenticated;

-- Retention. The page only needs today's counts, the last 6 events, and any approval still waiting, and it
-- looks back 14 days. So 30 days is plenty. Rows do not expire on their own. To keep the table small, either:
--   1. Run this by hand now and then:  select public.prune_events(30);
--   2. Or schedule it, if the pg_cron extension is on in Supabase (Database, Extensions):
--        select cron.schedule('prune-events', '17 3 * * *', 'select public.prune_events(30)');
-- A waiting approval older than the cut is deleted too, so answer approvals inside the window.
create or replace function public.prune_events(keep_days integer default 30) returns bigint
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  removed bigint;
begin
  if keep_days is null or keep_days < 1 then
    raise exception 'keep_days must be at least 1';
  end if;
  delete from public.events where "timestamp" < now() - make_interval(days => keep_days);
  get diagnostics removed = row_count;
  return removed;
end;
$fn$;

-- Pruning is for the project owner only, not the API.
revoke all on function public.prune_events(integer) from public, anon, authenticated;
