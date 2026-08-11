-- Fix keyset pagination over rows with no post date, and lift the page cap.
--
-- Two defects in search_job_listings, both of which only appear on the second
-- page and so survived every single-page test:
--
-- 1. NULL date_posted silently ends pagination. The predicate was
--    `(date_posted, simplify_id) < (p_cursor_posted, p_cursor_id)`. A row tuple
--    comparison against NULL is NULL, not false, so every row with no post date
--    was dropped from every page after the first. Worse, once the cursor itself
--    landed on such a row the client passed p_cursor_posted => null, the whole
--    predicate went NULL, and the query returned zero rows -- which a caller
--    reads as "end of feed". Roughly a tenth of Simplify listings carry no
--    date, so the feed truncated at whatever page first reached one.
--
-- 2. The cap was `least(p_limit, 200)`. The desktop app pages at 1000, so it
--    silently received 200 and, if it terminated on a short page, stopped after
--    one. A cap is still wanted -- an unbounded limit lets one anon request pull
--    the whole corpus in a single statement -- so it rises to 1000 rather than
--    being removed.
--
-- The fix for (1) is to sort and compare on a key that is never NULL.
-- '-infinity' sorts below every real timestamp, so `coalesce(...) desc` is
-- ordered identically to `desc nulls last` while staying comparable.

-- The old index no longer matches the ORDER BY, so the planner would fall back
-- to a sort over the whole table. This one indexes the same expression the
-- query now orders by.
create index if not exists job_listings_feed_keyset_idx
  on public.job_listings ((coalesce(date_posted, '-infinity'::timestamptz)) desc, simplify_id desc)
  where feed_active and is_visible and removed_at is null;

drop index if exists public.job_listings_feed_idx;

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
     -- The id decides whether a cursor was supplied at all. A real row always
     -- has one, so it can carry that meaning where the timestamp cannot.
     and (p_cursor_id is null
          or (coalesce(jl.date_posted, '-infinity'::timestamptz), jl.simplify_id)
             < (coalesce(p_cursor_posted, '-infinity'::timestamptz), p_cursor_id))
   order by coalesce(jl.date_posted, '-infinity'::timestamptz) desc, jl.simplify_id desc
   limit least(coalesce(p_limit, 50), 1000)
$$;

-- create or replace keeps the old ACL, but a signature typo would create a
-- second function with no grant and a confusing "permission denied" at runtime.
grant execute on function public.search_job_listings(
  text, text[], text[], text[], text[], boolean, timestamptz, integer, timestamptz, uuid
) to anon, authenticated;
