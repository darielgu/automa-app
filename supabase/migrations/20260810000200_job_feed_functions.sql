-- Ingest and query functions for the job feed.
--
-- Every function is `security invoker` on purpose. If the public anon key ever
-- reached one of the writers, RLS would still refuse the write. A
-- `security definer` writer would be a privilege escalation hole in a project
-- whose anon key is published in an open-source binary.

-- Bulk upsert. p_rows is the JSON array produced by @automa/job-feed-core, so
-- the Edge Function and the desktop app write identical rows.
create or replace function public.ingest_job_listings(p_run_id uuid, p_repo text, p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.job_listings as jl (
    simplify_id, source_repos, company_name, company_url, title, url, dedupe_key,
    apply_host, ats_platform, category, locations, terms, degrees, sponsorship,
    source, feed_active, is_visible, date_posted, date_updated, content_hash,
    flags, first_seen_at, last_seen_at, removed_at
  )
  select
    (r ->> 'simplify_id')::uuid,
    array[p_repo],
    r ->> 'company_name',
    nullif(r ->> 'company_url', ''),
    r ->> 'title',
    r ->> 'url',
    r ->> 'dedupe_key',
    nullif(r ->> 'apply_host', ''),
    r ->> 'ats_platform',
    nullif(r ->> 'category', ''),
    coalesce((select array_agg(x) from jsonb_array_elements_text(r -> 'locations') x), '{}'),
    coalesce((select array_agg(x) from jsonb_array_elements_text(r -> 'terms')     x), '{}'),
    coalesce((select array_agg(x) from jsonb_array_elements_text(r -> 'degrees')   x), '{}'),
    nullif(r ->> 'sponsorship', ''),
    nullif(r ->> 'source', ''),
    coalesce((r ->> 'feed_active')::boolean, true),
    coalesce((r ->> 'is_visible')::boolean, true),
    case when r ->> 'date_posted'  ~ '^\d+$' then to_timestamp((r ->> 'date_posted')::bigint)  end,
    case when r ->> 'date_updated' ~ '^\d+$' then to_timestamp((r ->> 'date_updated')::bigint) end,
    r ->> 'content_hash',
    coalesce((select array_agg(x) from jsonb_array_elements_text(r -> 'flags') x), '{}'),
    now(), now(), null
  from jsonb_array_elements(p_rows) as r
  on conflict (simplify_id) do update set
    -- A posting can appear in several feeds; keep the union rather than letting
    -- the last writer win and lose the others.
    source_repos = (select array_agg(distinct e order by e)
                    from unnest(jl.source_repos || excluded.source_repos) e),
    company_name = excluded.company_name,
    company_url  = excluded.company_url,
    title        = excluded.title,
    url          = excluded.url,
    dedupe_key   = excluded.dedupe_key,
    apply_host   = excluded.apply_host,
    ats_platform = excluded.ats_platform,
    category     = excluded.category,
    locations    = excluded.locations,
    terms        = excluded.terms,
    degrees      = excluded.degrees,
    sponsorship  = excluded.sponsorship,
    source       = excluded.source,
    feed_active  = excluded.feed_active,
    is_visible   = excluded.is_visible,
    date_posted  = excluded.date_posted,
    date_updated = excluded.date_updated,
    content_hash = excluded.content_hash,
    flags        = excluded.flags,
    last_seen_at = now(),
    -- Seeing a listing again un-removes it.
    removed_at   = null;

  get diagnostics v_count = row_count;

  update public.scrape_runs
     set rows_upserted = rows_upserted + v_count,
         batches_ok    = batches_ok + 1
   where id = p_run_id;

  return v_count;
end;
$$;

-- 304 Not Modified: the content is confirmed current, so refresh liveness
-- without transferring ten megabytes.
create or replace function public.touch_repo_listings(p_repo text)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.job_listings
     set last_seen_at = now()
   where p_repo = any(source_repos)
     and removed_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Mark listings that vanished from every feed they belonged to.
--
-- Only feeds confirmed fresh inside the grace window count, so one failing
-- fetch can never mass-deactivate the corpus. This mirrors the same rule in
-- the desktop app's local sweep.
create or replace function public.sweep_removed_listings(p_grace interval default interval '6 hours')
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_fresh text[];
  v_count integer;
begin
  select coalesce(array_agg(repo), '{}')
    into v_fresh
    from public.scrape_source_state
   where last_success_at > now() - p_grace;

  if cardinality(v_fresh) = 0 then
    return 0;
  end if;

  update public.job_listings
     set removed_at = now()
   where removed_at is null
     and cardinality(source_repos) > 0
     and source_repos <@ v_fresh
     and last_seen_at < now() - p_grace;

  get diagnostics v_count = row_count;

  insert into public.scrape_runs (status, trigger, repo, rows_deactivated, finished_at)
  values ('succeeded', 'cron', '__sweep__', v_count, now());

  return v_count;
end;
$$;

-- The desktop app's read entry point. Keyset paginated: OFFSET degrades badly
-- at 30k rows and can skip or repeat rows when a scrape writes between pages.
create or replace function public.search_job_listings(
  p_query         text        default null,
  p_terms         text[]      default null,
  p_categories    text[]      default null,
  p_platforms     text[]      default null,
  p_repos         text[]      default null,
  p_only_active   boolean     default true,
  p_posted_after  timestamptz default null,
  p_limit         integer     default 50,
  p_cursor_posted timestamptz default null,
  p_cursor_id     uuid        default null
)
returns setof public.job_listings
language sql
stable
security invoker
set search_path = public
as $$
  select jl.*
    from public.job_listings jl
   where (not p_only_active or (jl.feed_active and jl.is_visible and jl.removed_at is null))
     and (p_terms        is null or jl.terms        && p_terms)
     and (p_repos        is null or jl.source_repos && p_repos)
     and (p_categories   is null or jl.category     = any(p_categories))
     and (p_platforms    is null or jl.ats_platform = any(p_platforms))
     and (p_posted_after is null or jl.date_posted >= p_posted_after)
     and (p_query        is null or jl.search_tsv @@ websearch_to_tsquery('english', p_query))
     and (p_cursor_posted is null
          or (jl.date_posted, jl.simplify_id) < (p_cursor_posted, p_cursor_id))
   order by jl.date_posted desc nulls last, jl.simplify_id desc
   limit least(coalesce(p_limit, 50), 200)
$$;

-- Writers are service-role only. Readers are public.
--
-- Revoking from PUBLIC removes the default EXECUTE that every new function
-- carries, and that revoke reaches service_role too, because service_role is a
-- member of PUBLIC and had no grant of its own. So the grants below are not
-- redundant: without them the scraper gets "permission denied for function
-- ingest_job_listings" on every batch, and the corpus never fills.
revoke execute on function public.ingest_job_listings(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.touch_repo_listings(text)              from public, anon, authenticated;
revoke execute on function public.sweep_removed_listings(interval)       from public, anon, authenticated;
grant execute on function public.ingest_job_listings(uuid, text, jsonb) to service_role;
grant execute on function public.touch_repo_listings(text)              to service_role;
grant execute on function public.sweep_removed_listings(interval)       to service_role;
grant execute on function public.search_job_listings(
  text, text[], text[], text[], text[], boolean, timestamptz, integer, timestamptz, uuid
) to anon, authenticated;
