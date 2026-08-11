// GENERATED FILE — DO NOT EDIT.
// Copied verbatim from packages/job-feed-core/src/index.ts by
// tooling/scripts/sync-edge-shared.mjs. Edit the source, then re-run that script.
/**
 * Shared job-feed normalization.
 *
 * This module is the single source of truth for turning a raw SimplifyJobs
 * `listings.json` row into a stored row. It runs in three places:
 *
 *   1. The Supabase Edge Function (Deno)
 *   2. The Electron main process, when it fetches GitHub directly
 *   3. Unit tests
 *
 * Because of (1) this file must stay dependency-free and must not use relative
 * imports. It is copied verbatim into `supabase/functions/_shared/` and a CI
 * check asserts the two copies are identical bytes. If you add an import here,
 * the Deno copy breaks.
 */

export interface SimplifySource {
  readonly key: SourceKey;
  readonly repo: string;
  readonly url: string;
}

export type SourceKey = "summer2026" | "newgrad" | "summer2027";

export const SIMPLIFY_SOURCES: readonly SimplifySource[] = [
  {
    key: "summer2026",
    repo: "SimplifyJobs/Summer2026-Internships",
    url: "https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json"
  },
  {
    key: "newgrad",
    repo: "SimplifyJobs/New-Grad-Positions",
    url: "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json"
  },
  {
    key: "summer2027",
    repo: "SimplifyJobs/Summer2027-Internships",
    url: "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json"
  }
] as const;

/** Identifies this client to GitHub. Being honest about who we are is the price of polite scraping. */
export const USER_AGENT =
  "AutomaDesktop/0.1 (+https://github.com/darielgu/automa-app; open-source job search client)";

/** GitHub sets cache-control max-age=300. We stay well clear of that at one hour. */
export const MIN_FETCH_INTERVAL_MS = 3_600_000;

/** Even an explicit user-triggered refresh will not beat this. */
export const MIN_FORCED_FETCH_INTERVAL_MS = 300_000;

export type AtsPlatform =
  | "greenhouse"
  | "lever"
  | "workday"
  | "ashby"
  | "workatastartup"
  | "generic"
  | "unknown";

/** Platforms that have a purpose-built adapter, as opposed to the generic one. */
export const AUTOMATABLE_PLATFORMS: readonly AtsPlatform[] = [
  "greenhouse",
  "lever",
  "workday",
  "ashby",
  "workatastartup"
] as const;

/**
 * Platforms proven end to end: the adapter navigates, fills every field it
 * should, and stops where it should. Verified against the bundled practice
 * application for that platform, which uses the platform's real markup.
 */
export const VERIFIED_PLATFORMS: readonly AtsPlatform[] = ["greenhouse"] as const;

/**
 * Platforms whose adapter exists and reaches the form, but which are not yet
 * proven to fill it end to end. Being explicit about this matters more than
 * looking capable: a user who believes an application was filled when it was
 * not is worse off than one who was told to check.
 *
 * Current state, measured against the bundled practice applications:
 *  - lever:          reaches and scans the form; field discovery incomplete
 *  - ashby:          extracts all fields; writing them back does not verify
 *  - workday:        reaches the application step; extraction incomplete
 *  - workatastartup: does not yet open the message dialog
 */
export const EXPERIMENTAL_PLATFORMS: readonly AtsPlatform[] = [
  "lever",
  "ashby",
  "workday",
  "workatastartup"
] as const;

export type PlatformSupport = "verified" | "experimental" | "generic";

export function platformSupport(platform: AtsPlatform): PlatformSupport {
  if (VERIFIED_PLATFORMS.includes(platform)) return "verified";
  if (EXPERIMENTAL_PLATFORMS.includes(platform)) return "experimental";
  return "generic";
}

export function isAutomatable(platform: AtsPlatform): boolean {
  return AUTOMATABLE_PLATFORMS.includes(platform);
}

export interface NormalizedListing {
  simplify_id: string;
  source_repos: string[];
  company_name: string;
  company_url: string | null;
  title: string;
  /** The real apply URL, stored verbatim. Query params here are load-bearing for the ATS. */
  url: string;
  /** Canonicalized form, used only to detect duplicates across feeds. Never navigated to. */
  dedupe_key: string;
  apply_host: string | null;
  ats_platform: AtsPlatform;
  category: string | null;
  locations: string[];
  terms: string[];
  degrees: string[];
  sponsorship: string | null;
  source: string | null;
  feed_active: boolean;
  is_visible: boolean;
  date_posted: number | null;
  date_updated: number | null;
  content_hash: string;
  flags: string[];
}

// ---------------------------------------------------------------------------
// Platform detection
//
// Mirrors packages/engine/src/core/platform-detector.ts exactly, including the
// six-digit gh_jid rule and the try/catch fallback to substring matching. If
// that file changes, change this one in the same commit, or the scraper will
// label a job with a platform the adapter does not agree with.
// ---------------------------------------------------------------------------

export function hasGreenhouseUrlSignals(url: string): boolean {
  const normalized = url.toLowerCase();
  if (normalized.includes("greenhouse.io")) return true;
  // Automa's bundled demo application. It uses Greenhouse markup on purpose so
  // the real adapter drives it; a demo running through a special-case path
  // would prove nothing. Adapter selection goes through canHandle, which calls
  // this function, so the rule has to live here rather than in detectPlatform.
  if (normalized.includes("automa-demo") || normalized.includes("greenhouse-demo.html")) return true;
  try {
    const parsed = new URL(url);
    const ghJid = parsed.searchParams.get("gh_jid");
    const ghSrc = parsed.searchParams.get("gh_src") || "";
    if (ghJid && /^\d{6,}$/.test(ghJid.trim())) return true;
    if (/greenhouse/.test(ghSrc.toLowerCase())) return true;
  } catch {
    return normalized.includes("gh_jid=") || normalized.includes("gh_src=");
  }
  return false;
}

export function detectAtsPlatform(url: string): AtsPlatform {
  const normalized = url.toLowerCase();

  if (hasGreenhouseUrlSignals(url)) return "greenhouse";
  if (normalized.includes("lever.co")) return "lever";
  if (normalized.includes("myworkdayjobs.com") || normalized.includes("workday")) return "workday";
  if (normalized.includes("ashbyhq.com")) return "ashby";
  if (normalized.includes("workatastartup.com")) return "workatastartup";
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) return "generic";

  return "unknown";
}

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "ref"
]);

/**
 * Produces a stable key for spotting the same posting listed in more than one
 * feed. Only tracking parameters are dropped; everything else is preserved and
 * sorted so two orderings of the same query compare equal.
 */
export function canonicalizeApplyUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    let out = parsed.toString();
    if (out.endsWith("/")) out = out.slice(0, -1);
    return out.toLowerCase();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

// ---------------------------------------------------------------------------
// Hashing
//
// FNV-1a 64-bit, implemented with BigInt. Deliberately synchronous and
// dependency-free: Web Crypto is async and node:crypto is not guaranteed to
// behave identically under Deno's compatibility layer. We only need change
// detection, not cryptographic strength.
// ---------------------------------------------------------------------------

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;

export function fnv1a64(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * FNV_PRIME) & U64;
  }
  return hash.toString(16).padStart(16, "0");
}

export function contentHash(
  row: Omit<NormalizedListing, "content_hash" | "source_repos" | "flags">
): string {
  return fnv1a64(
    [
      row.title,
      row.company_name,
      row.url,
      row.category ?? "",
      String(row.feed_active),
      String(row.is_visible),
      String(row.date_updated ?? ""),
      row.locations.join(","),
      row.terms.join(","),
      row.degrees.join(","),
      row.sponsorship ?? ""
    ].join("|")
  );
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = str(item);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function epoch(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Returns null when a row cannot be trusted. Callers count those rather than
 * failing the whole batch: one malformed listing must never block a sync.
 */
export function normalizeListing(raw: unknown, sourceKey: SourceKey): NormalizedListing | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;

  const simplifyId = str(row.id).toLowerCase();
  if (!UUID_RE.test(simplifyId)) return null;

  const url = str(row.url);
  if (!url || !/^https?:\/\//i.test(url)) return null;

  const title = str(row.title);
  const companyName = str(row.company_name);
  if (!title || !companyName) return null;

  const flags: string[] = [];
  let atsPlatform = detectAtsPlatform(url);
  let applyHost: string | null = null;
  try {
    const parsed = new URL(url);
    applyHost = parsed.hostname.toLowerCase();
    // A Simplify redirect wrapper hides the real ATS, so no adapter can be
    // trusted for it. Keep the row, but do not claim we can automate it.
    if (applyHost === "simplify.jobs" && parsed.pathname.startsWith("/p/")) {
      atsPlatform = "generic";
      flags.push("simplify_wrapper");
    }
  } catch {
    applyHost = null;
  }

  const base = {
    simplify_id: simplifyId,
    company_name: companyName,
    company_url: str(row.company_url) || null,
    title,
    url,
    dedupe_key: canonicalizeApplyUrl(url),
    apply_host: applyHost,
    ats_platform: atsPlatform,
    category: str(row.category) || null,
    locations: strList(row.locations),
    terms: strList(row.terms),
    degrees: strList(row.degrees),
    sponsorship: str(row.sponsorship) || null,
    source: str(row.source) || null,
    feed_active: bool(row.active, true),
    is_visible: bool(row.is_visible, true),
    date_posted: epoch(row.date_posted),
    date_updated: epoch(row.date_updated)
  };

  return { ...base, source_repos: [sourceKey], content_hash: contentHash(base), flags };
}

export interface NormalizeResult {
  rows: NormalizedListing[];
  skipped: number;
}

export function normalizeListings(raw: unknown, sourceKey: SourceKey): NormalizeResult {
  if (!Array.isArray(raw)) return { rows: [], skipped: 0 };
  const rows: NormalizedListing[] = [];
  let skipped = 0;
  for (const item of raw) {
    const row = normalizeListing(item, sourceKey);
    if (row) rows.push(row);
    else skipped += 1;
  }
  return { rows, skipped };
}

/**
 * Collapses the same posting appearing in several feeds into one row with a
 * merged `source_repos`. This matters: Summer2027 currently serves a byte copy
 * of Summer2026, and ~212 ids appear in both Summer2026 and New-Grad. Without
 * this we would store thousands of redundant rows.
 */
export function mergeById(batches: NormalizedListing[][]): NormalizedListing[] {
  const merged = new Map<string, NormalizedListing>();
  for (const batch of batches) {
    for (const row of batch) {
      const existing = merged.get(row.simplify_id);
      if (!existing) {
        merged.set(row.simplify_id, { ...row, source_repos: [...row.source_repos] });
        continue;
      }
      const repos = new Set([...existing.source_repos, ...row.source_repos]);
      merged.set(row.simplify_id, {
        ...row,
        source_repos: [...repos].sort(),
        flags: [...new Set([...existing.flags, ...row.flags])]
      });
    }
  }
  return [...merged.values()];
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
