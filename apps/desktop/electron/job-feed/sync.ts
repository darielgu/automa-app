import {
  MIN_FETCH_INTERVAL_MS,
  MIN_FORCED_FETCH_INTERVAL_MS,
  SIMPLIFY_SOURCES,
  USER_AGENT,
  mergeById,
  normalizeListings,
  type NormalizedListing,
  type SourceKey
} from "@automa/job-feed-core";
import { getFeedMeta, listFeedMeta, saveFeedMeta, getSetting } from "../db/app-repo.js";
import { countJobs, sweepRemovedJobs, upsertJobs } from "../db/jobs-repo.js";
import type { Db } from "../db/database.js";

export interface FeedSyncResult {
  provider: "github" | "supabase";
  repos: Array<{
    repo: SourceKey;
    status: number | "skipped" | "error";
    fetched: number;
    skippedRows: number;
    error?: string;
  }>;
  upserted: number;
  removed: number;
  counts: { total: number; active: number; automatable: number };
  ranAt: string;
}

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

/**
 * Reads the optional Supabase mirror settings. When absent — the default for a
 * plain download — the app fetches GitHub directly and works entirely offline
 * after the first sync. Supabase is a convenience, never a requirement.
 */
export function readSupabaseConfig(db: Db): SupabaseConfig | null {
  const url = (getSetting(db, "supabase_url") ?? process.env.SUPABASE_URL ?? "").trim();
  const anonKey = (getSetting(db, "supabase_anon_key") ?? process.env.SUPABASE_ANON_KEY ?? "").trim();
  if (!url || !anonKey) return null;
  return { url: url.replace(/\/$/, ""), anonKey };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * True when we fetched this feed recently enough that asking again would be
 * rude. GitHub serves these files with cache-control max-age=300, so even a
 * user-triggered refresh is floored at five minutes.
 */
function shouldSkip(db: Db, repo: SourceKey, force: boolean): boolean {
  const meta = getFeedMeta(db, repo);
  if (!meta?.lastFetchedAt) return false;
  const ageMs = Date.now() - meta.lastFetchedAt * 1000;
  return ageMs < (force ? MIN_FORCED_FETCH_INTERVAL_MS : MIN_FETCH_INTERVAL_MS);
}

async function fetchRepo(
  db: Db,
  source: (typeof SIMPLIFY_SOURCES)[number],
  force: boolean,
  signal?: AbortSignal
): Promise<{ status: number | "skipped" | "error"; rows: NormalizedListing[]; skippedRows: number; error?: string }> {
  if (shouldSkip(db, source.key, force)) {
    return { status: "skipped", rows: [], skippedRows: 0 };
  }

  const meta = getFeedMeta(db, source.key);
  const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json" };
  if (meta?.etag) headers["If-None-Match"] = meta.etag;

  try {
    const response = await fetch(source.url, { headers, signal });
    saveFeedMeta(db, { repo: source.key, lastFetchedAt: nowSeconds(), lastHttpStatus: response.status });

    // Unchanged since last time. The content is confirmed current, so this
    // counts as a success for the removal sweep, and costs no transfer.
    if (response.status === 304) {
      saveFeedMeta(db, { repo: source.key, lastSuccessAt: nowSeconds(), lastError: null });
      return { status: 304, rows: [], skippedRows: 0 };
    }

    if (!response.ok) {
      const error = `HTTP ${response.status}`;
      saveFeedMeta(db, { repo: source.key, lastError: error });
      return { status: response.status, rows: [], skippedRows: 0, error };
    }

    const raw = (await response.json()) as unknown;
    const { rows, skipped } = normalizeListings(raw, source.key);
    saveFeedMeta(db, {
      repo: source.key,
      etag: response.headers.get("etag"),
      lastSuccessAt: nowSeconds(),
      lastEntryCount: rows.length,
      lastError: null
    });
    return { status: response.status, rows, skippedRows: skipped };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    saveFeedMeta(db, { repo: source.key, lastError: message });
    return { status: "error", rows: [], skippedRows: 0, error: message };
  }
}

/**
 * Pulls from the optional Supabase mirror. Rows there were written by the same
 * normalizer, so they land in exactly the same shape as the GitHub path.
 */
async function fetchFromSupabase(
  config: SupabaseConfig,
  signal?: AbortSignal
): Promise<NormalizedListing[]> {
  const pageSize = 1000;
  const collected: NormalizedListing[] = [];

  for (let offset = 0; offset < 60_000; offset += pageSize) {
    const url =
      `${config.url}/rest/v1/job_listings` +
      `?select=*&removed_at=is.null&order=date_posted.desc.nullslast,simplify_id.desc` +
      `&limit=${pageSize}&offset=${offset}`;
    const response = await fetch(url, {
      headers: { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}`, Accept: "application/json" },
      signal
    });
    if (!response.ok) throw new Error(`Supabase mirror returned HTTP ${response.status}`);

    const batch = (await response.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const row of batch) {
      collected.push({
        simplify_id: String(row.simplify_id),
        source_repos: Array.isArray(row.source_repos) ? (row.source_repos as string[]) : [],
        company_name: String(row.company_name ?? ""),
        company_url: (row.company_url as string) ?? null,
        title: String(row.title ?? ""),
        url: String(row.url ?? ""),
        dedupe_key: String(row.dedupe_key ?? ""),
        apply_host: (row.apply_host as string) ?? null,
        ats_platform: String(row.ats_platform ?? "unknown") as NormalizedListing["ats_platform"],
        category: (row.category as string) ?? null,
        locations: Array.isArray(row.locations) ? (row.locations as string[]) : [],
        terms: Array.isArray(row.terms) ? (row.terms as string[]) : [],
        degrees: Array.isArray(row.degrees) ? (row.degrees as string[]) : [],
        sponsorship: (row.sponsorship as string) ?? null,
        source: (row.source as string) ?? null,
        feed_active: row.feed_active !== false,
        is_visible: row.is_visible !== false,
        date_posted: row.date_posted ? Math.floor(new Date(String(row.date_posted)).getTime() / 1000) : null,
        date_updated: row.date_updated ? Math.floor(new Date(String(row.date_updated)).getTime() / 1000) : null,
        content_hash: String(row.content_hash ?? ""),
        flags: Array.isArray(row.flags) ? (row.flags as string[]) : []
      });
    }

    if (batch.length < pageSize) break;
  }

  return collected;
}

/**
 * Refreshes the local job corpus.
 *
 * Local SQLite is always the source of truth for the UI. Both remote paths just
 * fill that cache, which is why the app keeps working with no network and with
 * no Supabase project configured.
 */
export async function syncJobFeed(
  db: Db,
  options: { force?: boolean; signal?: AbortSignal } = {}
): Promise<FeedSyncResult> {
  const force = options.force ?? false;
  const supabase = readSupabaseConfig(db);
  const repos: FeedSyncResult["repos"] = [];
  let upserted = 0;

  if (supabase) {
    try {
      const rows = await fetchFromSupabase(supabase, options.signal);
      upserted = upsertJobs(db, rows);
      for (const source of SIMPLIFY_SOURCES) {
        saveFeedMeta(db, { repo: source.key, lastFetchedAt: nowSeconds(), lastSuccessAt: nowSeconds(), lastHttpStatus: 200, lastError: null });
        repos.push({ repo: source.key, status: 200, fetched: 0, skippedRows: 0 });
      }
      return {
        provider: "supabase",
        repos,
        upserted,
        removed: 0,
        counts: countJobs(db),
        ranAt: new Date().toISOString()
      };
    } catch (error) {
      // The mirror is a convenience. If it is down, fall through to GitHub
      // rather than leaving the user with no jobs.
      repos.push({
        repo: "summer2026",
        status: "error",
        fetched: 0,
        skippedRows: 0,
        error: `Supabase mirror unavailable, used GitHub instead: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  const batches: NormalizedListing[][] = [];
  for (const source of SIMPLIFY_SOURCES) {
    const result = await fetchRepo(db, source, force, options.signal);
    repos.push({
      repo: source.key,
      status: result.status,
      fetched: result.rows.length,
      skippedRows: result.skippedRows,
      ...(result.error ? { error: result.error } : {})
    });
    if (result.rows.length) batches.push(result.rows);
  }

  // Merge before writing: Summer2027 currently serves a byte copy of
  // Summer2026, and hundreds of postings appear in two feeds.
  if (batches.length) upserted = upsertJobs(db, mergeById(batches));

  const freshRepos = listFeedMeta(db)
    .filter((meta) => meta.lastSuccessAt && Date.now() / 1000 - meta.lastSuccessAt < 6 * 3600)
    .map((meta) => meta.repo);
  const removed = sweepRemovedJobs(db, freshRepos);

  return {
    provider: "github",
    repos,
    upserted,
    removed,
    counts: countJobs(db),
    ranAt: new Date().toISOString()
  };
}

export interface FeedStatus {
  provider: "github" | "supabase";
  counts: { total: number; active: number; automatable: number };
  feeds: Array<{ repo: string; lastSuccessAt: number | null; lastHttpStatus: number | null; entryCount: number | null; error: string | null }>;
}

export function feedStatus(db: Db): FeedStatus {
  return {
    provider: readSupabaseConfig(db) ? "supabase" : "github",
    counts: countJobs(db),
    feeds: listFeedMeta(db).map((meta) => ({
      repo: meta.repo,
      lastSuccessAt: meta.lastSuccessAt,
      lastHttpStatus: meta.lastHttpStatus,
      entryCount: meta.lastEntryCount,
      error: meta.lastError
    }))
  };
}
