-- Hourly schedule for the scraper.
--
-- Before running this, store three secrets in Vault. They are read at call time
-- rather than inlined into cron.job.command, which is readable by any database
-- owner:
--
--   select vault.create_secret('https://<PROJECT_REF>.supabase.co', 'project_url');
--   select vault.create_secret('<SERVICE_ROLE_KEY>',                'service_role_key');
--   select vault.create_secret('<RANDOM_32_BYTE_HEX>',              'scrape_trigger_secret');
--
-- The same random value must be set as the SCRAPE_TRIGGER_SECRET function
-- secret on scrape-simplify.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.trigger_scrape(p_repo text)
returns bigint
language plpgsql
-- security definer is required here: only this function may read Vault, and it
-- takes no caller input beyond a repo name that the Edge Function validates
-- against its own allow-list.
security definer
set search_path = public, extensions, vault
as $$
declare
  v_request_id bigint;
begin
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/scrape-simplify?repo=' || p_repo,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
      'x-scrape-token', (select decrypted_secret from vault.decrypted_secrets where name = 'scrape_trigger_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke execute on function public.trigger_scrape(text) from public, anon, authenticated;

-- Staggered so only one 10 MB download and one heavy worker runs at a time.
-- Hourly is polite for a public file that changes a few times a day, and the
-- ETag makes most of these runs transfer nothing.
select cron.schedule('scrape-simplify-summer2026', '5 * * * *',  $$select public.trigger_scrape('summer2026')$$);
select cron.schedule('scrape-simplify-newgrad',    '15 * * * *', $$select public.trigger_scrape('newgrad')$$);
select cron.schedule('scrape-simplify-summer2027', '25 * * * *', $$select public.trigger_scrape('summer2027')$$);

-- The sweep runs after all three, so a single failing feed can never license
-- deactivation of the whole corpus.
select cron.schedule('scrape-simplify-sweep', '40 * * * *', $$select public.sweep_removed_listings()$$);

-- Keep the observability table bounded.
select cron.schedule(
  'scrape-runs-prune',
  '0 3 * * *',
  $$delete from public.scrape_runs where started_at < now() - interval '30 days'$$
);
