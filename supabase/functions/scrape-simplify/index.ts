/**
 * Scrapes one SimplifyJobs feed into `job_listings`.
 *
 * One repo per invocation, on purpose. Supabase Edge Functions get roughly two
 * seconds of CPU and 256 MB. A single feed is ~10.8 MB of JSON that parses into
 * ~90 MB of objects and costs ~0.5s to normalize; three in one call would be
 * killed. The cron schedule staggers the three repos instead.
 *
 * Normalization is not implemented here. It is imported from the same module
 * the desktop app uses, so a row written by this function is byte-identical to
 * one the app produces when it fetches GitHub directly.
 */
import {
  SIMPLIFY_SOURCES,
  USER_AGENT,
  chunk,
  normalizeListings,
  type SourceKey
} from "../_shared/job-feed-core.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TRIGGER_SECRET = Deno.env.get("SCRAPE_TRIGGER_SECRET") ?? "";

const BATCH_SIZE = 1000;
const FETCH_TIMEOUT_MS = 60_000;

function db(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}${pathname}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const response = await db(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
  if (!response.ok) {
    throw new Error(`rpc ${name} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function startRun(repo: string, trigger: string): Promise<string> {
  const response = await db("/rest/v1/scrape_runs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ repo, trigger, status: "running" })
  });
  const [row] = (await response.json()) as Array<{ id: string }>;
  return row.id;
}

function finishRun(runId: string, patch: Record<string, unknown>): Promise<Response> {
  return db(`/rest/v1/scrape_runs?id=eq.${runId}`, { method: "PATCH", body: JSON.stringify(patch) });
}

function saveSourceState(repo: string, patch: Record<string, unknown>): Promise<Response> {
  return db(`/rest/v1/scrape_source_state?repo=eq.${repo}`, {
    method: "PATCH",
    body: JSON.stringify(patch)
  });
}

Deno.serve(async (req: Request) => {
  const startedAt = Date.now();

  // verify_jwt stays on, but the anon key is also a valid JWT and it is public
  // in the desktop binary. This shared secret is what actually gates writes.
  if (!TRIGGER_SECRET || req.headers.get("x-scrape-token") !== TRIGGER_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const url = new URL(req.url);
  const repoKey = (url.searchParams.get("repo") ?? "") as SourceKey;
  const source = SIMPLIFY_SOURCES.find((entry) => entry.key === repoKey);
  if (!source) {
    return new Response(
      JSON.stringify({ error: "unknown repo", allowed: SIMPLIFY_SOURCES.map((s) => s.key) }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const trigger = url.searchParams.get("trigger") ?? "cron";
  const runId = await startRun(source.key, trigger === "manual" ? "manual" : "cron");

  try {
    const stateResponse = await db(
      `/rest/v1/scrape_source_state?repo=eq.${source.key}&select=etag`
    );
    const [state] = (await stateResponse.json()) as Array<{ etag: string | null }>;

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      "Accept-Encoding": "gzip"
    };
    if (state?.etag) headers["If-None-Match"] = state.etag;

    const response = await fetch(source.url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });

    // Unchanged. The common case at hourly cadence, and it costs nothing.
    if (response.status === 304) {
      const touched = await rpc<number>("touch_repo_listings", { p_repo: source.key });
      await saveSourceState(source.key, {
        last_fetched_at: new Date().toISOString(),
        last_success_at: new Date().toISOString(),
        last_http_status: 304,
        consecutive_failures: 0
      });
      await finishRun(runId, {
        status: "not_modified",
        http_status: 304,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        notes: { touched }
      });
      return Response.json({ repo: source.key, status: "not_modified", touched });
    }

    if (!response.ok) {
      await saveSourceState(source.key, {
        last_fetched_at: new Date().toISOString(),
        last_http_status: response.status
      });
      await finishRun(runId, {
        status: "failed",
        http_status: response.status,
        error: `upstream returned ${response.status}`,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt
      });
      // 200 so pg_cron does not treat this as a retryable failure and storm.
      return Response.json({ repo: source.key, status: "failed", http: response.status });
    }

    const etag = response.headers.get("etag");
    let raw: unknown = await response.json();
    const { rows, skipped } = normalizeListings(raw, source.key);
    // Free the parsed source before batching; peak memory is the constraint here.
    raw = null;

    let batchesFailed = 0;
    let upserted = 0;
    const batches = chunk(rows, BATCH_SIZE);

    for (const [index, batch] of batches.entries()) {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          upserted += await rpc<number>("ingest_job_listings", {
            p_run_id: runId,
            p_repo: source.key,
            p_rows: batch
          });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 500 : 1500));
        }
      }
      if (lastError) {
        // Keep going. One bad batch must not discard the other 14.
        batchesFailed += 1;
        console.error(`batch ${index} failed`, lastError);
        await db(`/rest/v1/scrape_runs?id=eq.${runId}`, {
          method: "PATCH",
          body: JSON.stringify({ batches_failed: batchesFailed })
        });
      }
    }

    // last_success_at is what the removal sweep trusts, so only set it when
    // every batch landed. A partial write must not license deactivation.
    await saveSourceState(source.key, {
      etag,
      last_fetched_at: new Date().toISOString(),
      ...(batchesFailed === 0 ? { last_success_at: new Date().toISOString() } : {}),
      last_http_status: 200,
      last_entry_count: rows.length,
      consecutive_failures: batchesFailed === 0 ? 0 : 1
    });

    await finishRun(runId, {
      status: batchesFailed > 0 ? "partial" : "succeeded",
      http_status: 200,
      etag,
      rows_seen: rows.length,
      rows_skipped: skipped,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt
    });

    return Response.json({
      repo: source.key,
      status: batchesFailed > 0 ? "partial" : "succeeded",
      seen: rows.length,
      skipped,
      upserted,
      batchesFailed,
      durationMs: Date.now() - startedAt
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishRun(runId, {
      status: "failed",
      error: message,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt
    });
    console.error("scrape failed", message);
    return Response.json({ repo: source.key, status: "failed", error: message });
  }
});
