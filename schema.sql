-- (-AHP-) roster schema. Run once in the Supabase SQL editor.
--
-- Every object is prefixed ahp_ so this can share a Supabase project with
-- another app without colliding. Do not drop the prefix: `create table if
-- not exists members` against a database that already owns a `members`
-- table silently does nothing, and the seed then writes into that table.

create extension if not exists pgcrypto;

create table if not exists ahp_members (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  steam_id    text not null unique,          -- STEAM_X:Y:Z as the clan records it
  id64        text not null unique,          -- 17-digit SteamID64, what Steam login returns
  tier        text not null check (tier in ('leadership','management','member','legend')),
  twitch      text,                          -- channel name only, no URL
  is_super    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists ahp_members_tier_idx on ahp_members (tier);

-- A promotion to leadership is staged here until a second leader approves it.
create table if not exists ahp_pending_changes (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid not null references ahp_members(id) on delete cascade,
  proposed_tier text not null check (proposed_tier in ('leadership','management','member','legend')),
  requested_by  text not null,               -- id64 of the proposing leader
  requested_at  timestamptz not null default now(),
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by    text,
  decided_at    timestamptz
);

-- Only one open proposal per member at a time.
create unique index if not exists ahp_pending_one_open
  on ahp_pending_changes (member_id) where status = 'pending';

create table if not exists ahp_audit_log (
  id        bigserial primary key,
  actor     text not null,                   -- id64
  action    text not null,
  target    text,                            -- member name at time of action
  detail    jsonb,
  at        timestamptz not null default now()
);

-- Every read and write goes through the serverless functions using the service
-- role key, so no anon access is granted here.
alter table ahp_members         enable row level security;
alter table ahp_pending_changes enable row level security;
alter table ahp_audit_log       enable row level security;

create or replace function ahp_touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end $$ language plpgsql;

drop trigger if exists ahp_members_touch on ahp_members;
create trigger ahp_members_touch before update on ahp_members
  for each row execute function ahp_touch_updated_at();
