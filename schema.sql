-- (-AHP-) roster schema. Run once in the Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists members (
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

create index if not exists members_tier_idx on members (tier);

-- A promotion to leadership is staged here until a second leader approves it.
create table if not exists pending_changes (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid not null references members(id) on delete cascade,
  proposed_tier text not null check (proposed_tier in ('leadership','management','member','legend')),
  requested_by  text not null,               -- id64 of the proposing leader
  requested_at  timestamptz not null default now(),
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by    text,
  decided_at    timestamptz
);

-- Only one open proposal per member at a time.
create unique index if not exists pending_one_open
  on pending_changes (member_id) where status = 'pending';

create table if not exists audit_log (
  id        bigserial primary key,
  actor     text not null,                   -- id64
  action    text not null,
  target    text,                            -- member name at time of action
  detail    jsonb,
  at        timestamptz not null default now()
);

-- Every read and write goes through the serverless functions using the service
-- role key, so no anon access is granted here.
alter table members         enable row level security;
alter table pending_changes enable row level security;
alter table audit_log       enable row level security;

create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end $$ language plpgsql;

drop trigger if exists members_touch on members;
create trigger members_touch before update on members
  for each row execute function touch_updated_at();
