# Supabase job feed mirror (optional)

Automa does not need Supabase. The desktop app fetches the same public
SimplifyJobs feeds directly from GitHub and stores them in local SQLite, which
is the default and works offline after the first sync.

This directory is for running a shared mirror: one machine scrapes on a
schedule, and every copy of the app pulls pre-normalized rows instead of each
one downloading ~33 MB of JSON.

## What is here

| File | Purpose |
|---|---|
| `migrations/20260810000100_job_feed_schema.sql` | `job_listings`, `scrape_runs`, `scrape_source_state`, indexes, and RLS |
| `migrations/20260810000200_job_feed_functions.sql` | Bulk upsert, ETag touch, removal sweep, and the public search function |
| `migrations/20260810000300_job_feed_cron.sql` | Hourly `pg_cron` schedule, staggered per feed |
| `functions/scrape-simplify/index.ts` | The Edge Function, one feed per invocation |
| `functions/_shared/job-feed-core.ts` | Generated copy of the shared normalizer — do not edit |

## The security model

The desktop app is open source and ships the anon key in its binary, so treat
that key as public.

- Anonymous role: `SELECT` on `job_listings` and `scrape_runs` only.
- All writes require the service role, which never leaves Supabase.
- There is deliberately **no** insert, update or delete policy in any migration.
- `scrape_source_state` has no policy at all, so the public key cannot see it.
- Every function is `security invoker`, so RLS still applies if one is ever
  reached by the anon key.

## Deploying

1. Create a fresh Supabase project. Do not reuse an older one whose credentials
   may have been exposed.
2. Apply the migrations in order: `0001`, then `0002`.
3. Store three secrets in Vault:
   ```sql
   select vault.create_secret('https://<PROJECT_REF>.supabase.co', 'project_url');
   select vault.create_secret('<SERVICE_ROLE_KEY>',                'service_role_key');
   select vault.create_secret('<RANDOM_32_BYTE_HEX>',              'scrape_trigger_secret');
   ```
4. Deploy the Edge Function and set `SCRAPE_TRIGGER_SECRET` to the same random
   value used above. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected
   automatically.
5. Apply `0003` to install the cron schedule.
6. Trigger one run by hand and check it: `select public.trigger_scrape('newgrad');`

Keep the shared normalizer in sync before deploying:

```bash
node tooling/scripts/sync-edge-shared.mjs          # copy
node tooling/scripts/sync-edge-shared.mjs --check  # CI gate
```

## Verifying it actually wrote rows

```sql
select count(*) as total,
       count(*) filter (where feed_active and is_visible and removed_at is null) as active,
       count(*) filter (where cardinality(source_repos) > 1) as in_multiple_feeds,
       max(last_seen_at) as freshest
  from public.job_listings;

select ats_platform, count(*) from public.job_listings group by 1 order by 2 desc;

select repo, status, http_status, rows_seen, rows_upserted, batches_failed, duration_ms, error
  from public.scrape_runs order by started_at desc limit 10;
```

Expect roughly 32,000 rows across the three feeds after a full pass. Summer2027
currently serves a byte-identical copy of Summer2026, so the shared normalizer
merges them rather than storing ~14,000 duplicates. A second run should report
`not_modified`, which is also a pass: it proves the ETag path works.

## Proving the public key cannot write

Run these with the real anon key before pointing any app at the project:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$URL/rest/v1/job_listings?select=title&limit=1" -H "apikey: $ANON"   # 200
curl -s -X DELETE "$URL/rest/v1/job_listings?simplify_id=eq.<id>" -H "apikey: $ANON"                            # refused
curl -s -o /dev/null -w '%{http_code}\n' "$URL/rest/v1/scrape_source_state?select=*" -H "apikey: $ANON"         # 401/403
curl -s -X POST "$URL/functions/v1/scrape-simplify?repo=newgrad" -H "Authorization: Bearer $ANON"               # 401
```

## Pointing the app at the mirror

In the app's settings, set the Supabase URL and anon key. The app falls back to
GitHub automatically if the mirror is unreachable, so a mirror outage degrades
to the default behaviour rather than an empty job list.

## Being a good citizen

The feeds are public files on `raw.githubusercontent.com`. The scraper sends a
descriptive `User-Agent` that links back to this repository, uses
`If-None-Match` so unchanged content transfers nothing, and never polls faster
than hourly. Please keep it that way.
