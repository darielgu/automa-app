-- Automa job feed: a public, read-only mirror of the SimplifyJobs listings.
--
-- The desktop app is open source and ships the anon key in its binary, so the
-- security model has to assume that key is public. Read is open; every write
-- requires the service role. There is deliberately no insert/update/delete
-- policy anywhere in this file.

create extension if not exists pg_trgm;

create table if not exists public.job_listings (
  simplify_id   uuid primary key,
  source_repos  text[]      not null default '{}',
  company_name  text        not null,
  company_url   text,
  title         text        not null,
  -- The real apply URL, stored verbatim. Query params here are load-bearing
  -- for the ATS, so they are never stripped.
  url           text        not null,
  -- Canonicalized form, used only to spot the same posting in several feeds.
  dedupe_key    text        not null,
  apply_host    text,
  ats_platform  text        not null
                check (ats_platform in
                  ('greenhouse','lever','ashby','workday','workatastartup','generic','unknown')),
  category      text,
  locations     text[]      not null default '{}',
  terms         text[]      not null default '{}',
  degrees       text[]      not null default '{}',
  sponsorship   text,
  source        text,
  feed_active   boolean     not null default true,
  is_visible    boolean     not null default true,
  -- Set by the sweep when a listing disappears from every feed it belonged to.
  -- Rows are never deleted, so a bad scrape can be reversed.
  removed_at    timestamptz,
  date_posted   timestamptz,
  date_updated  timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  content_hash  text        not null,
  flags         text[]      not null default '{}',
  search_tsv    tsvector generated always as (
                  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                  setweight(to_tsvector('english', coalesce(company_name, '')), 'B')
                ) stored
);

comment on table public.job_listings is
  'Mirror of the public SimplifyJobs listings.json feeds. Anyone may read; only the service role may write.';

-- The desktop feed query: active, newest first, keyset paginated.
create index if not exists job_listings_feed_idx
  on public.job_listings (date_posted desc nulls last, simplify_id desc)
  where feed_active and is_visible and removed_at is null;

create index if not exists job_listings_search_idx    on public.job_listings using gin (search_tsv);
create index if not exists job_listings_terms_idx     on public.job_listings using gin (terms);
create index if not exists job_listings_locations_idx on public.job_listings using gin (locations);
create index if not exists job_listings_repos_idx     on public.job_listings using gin (source_repos);
create index if not exists job_listings_company_trgm  on public.job_listings using gin (company_name gin_trgm_ops);
create index if not exists job_listings_platform_idx  on public.job_listings (ats_platform) where removed_at is null;
create index if not exists job_listings_category_idx  on public.job_listings (category)     where removed_at is null;
create index if not exists job_listings_last_seen_idx on public.job_listings (last_seen_at) where removed_at is null;

-- Observability. Without this a silently failing scraper looks identical to a
-- feed that simply has no new jobs.
create table if not exists public.scrape_runs (
  id               uuid primary key default gen_random_uuid(),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  status           text not null default 'running'
                   check (status in ('running','succeeded','not_modified','partial','failed')),
  trigger          text not null default 'cron' check (trigger in ('cron','manual','backfill')),
  repo             text,
  http_status      int,
  etag             text,
  rows_seen        int not null default 0,
  rows_skipped     int not null default 0,
  rows_upserted    int not null default 0,
  rows_deactivated int not null default 0,
  batches_ok       int not null default 0,
  batches_failed   int not null default 0,
  duration_ms      int,
  error            text,
  notes            jsonb not null default '{}'::jsonb
);
create index if not exists scrape_runs_started_idx on public.scrape_runs (started_at desc);
create index if not exists scrape_runs_repo_idx    on public.scrape_runs (repo, started_at desc);

-- Per-feed ETag state, so most runs are a conditional GET that transfers nothing.
create table if not exists public.scrape_source_state (
  repo                 text primary key,
  etag                 text,
  last_modified        text,
  last_fetched_at      timestamptz,
  -- A 304 counts as success: it confirms the content is current.
  last_success_at      timestamptz,
  last_http_status     int,
  last_entry_count     int,
  consecutive_failures int not null default 0
);

insert into public.scrape_source_state (repo)
values ('summer2026'), ('newgrad'), ('summer2027')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.job_listings        enable row level security;
alter table public.scrape_runs         enable row level security;
alter table public.scrape_source_state enable row level security;

drop policy if exists job_listings_public_read on public.job_listings;
create policy job_listings_public_read on public.job_listings
  for select to anon, authenticated using (true);

drop policy if exists scrape_runs_public_read on public.scrape_runs;
create policy scrape_runs_public_read on public.scrape_runs
  for select to anon, authenticated using (true);

-- scrape_source_state gets no policy at all, so it is invisible to the public key.
revoke all on public.scrape_source_state from anon, authenticated;

-- Belt and braces: even if someone later adds a write policy by mistake, the
-- grants still refuse writes from the public key.
revoke insert, update, delete, truncate on public.job_listings from anon, authenticated;
revoke insert, update, delete, truncate on public.scrape_runs  from anon, authenticated;
grant select on public.job_listings to anon, authenticated;
grant select on public.scrape_runs  to anon, authenticated;
