import type { NormalizedListing } from "@automa/job-feed-core";
import { AUTOMATABLE_PLATFORMS, platformSupport, type AtsPlatform, type PlatformSupport } from "@automa/job-feed-core";
import { jsonParse, plainAll, transaction, type Db } from "./database.js";

export interface JobRecord {
  simplifyId: string;
  sourceRepos: string[];
  company: string;
  companyUrl: string | null;
  title: string;
  url: string;
  applyHost: string | null;
  platform: string;
  automatable: boolean;
  category: string | null;
  locations: string[];
  terms: string[];
  degrees: string[];
  sponsorship: string | null;
  active: boolean;
  datePosted: number | null;
  feedback: "liked" | "hidden" | "saved" | null;
  applied: boolean;
  /** How far this platform's adapter has actually been proven. */
  support: PlatformSupport;
}

export interface JobQuery {
  search?: string;
  platforms?: string[];
  categories?: string[];
  terms?: string[];
  /** Only jobs an adapter can drive end to end. */
  automatableOnly?: boolean;
  includeHidden?: boolean;
  includeApplied?: boolean;
  limit?: number;
  cursorPosted?: number | null;
  cursorId?: string | null;
}

export interface JobPage {
  jobs: JobRecord[];
  nextCursor: { posted: number | null; id: string } | null;
  total: number;
}

interface JobRow {
  simplify_id: string;
  source_repos: string;
  company_name: string;
  company_url: string | null;
  title: string;
  url: string;
  apply_host: string | null;
  ats_platform: string;
  category: string | null;
  locations: string;
  terms: string;
  degrees: string;
  sponsorship: string | null;
  feed_active: number;
  date_posted: number | null;
  verdict: string | null;
  applied_id: string | null;
}

function toRecord(row: JobRow): JobRecord {
  return {
    simplifyId: row.simplify_id,
    sourceRepos: jsonParse<string[]>(row.source_repos, []),
    company: row.company_name,
    companyUrl: row.company_url,
    title: row.title,
    url: row.url,
    applyHost: row.apply_host,
    platform: row.ats_platform,
    automatable: (AUTOMATABLE_PLATFORMS as readonly string[]).includes(row.ats_platform),
    category: row.category,
    locations: jsonParse<string[]>(row.locations, []),
    terms: jsonParse<string[]>(row.terms, []),
    degrees: jsonParse<string[]>(row.degrees, []),
    sponsorship: row.sponsorship,
    active: row.feed_active === 1,
    datePosted: row.date_posted,
    feedback: (row.verdict as JobRecord["feedback"]) ?? null,
    applied: Boolean(row.applied_id),
    support: platformSupport(row.ats_platform as AtsPlatform)
  };
}

/**
 * FTS5 treats several characters as operators. User text is not a query
 * language, so quote every token and let SQLite AND them together.
 */
export function sanitizeFtsQuery(input: string): string {
  const tokens = input
    .replace(/["*:^()]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (!tokens.length) return "";
  return tokens.map((token) => `"${token}"`).join(" ");
}

export function upsertJobs(db: Db, listings: NormalizedListing[]): number {
  if (!listings.length) return 0;
  const now = Math.floor(Date.now() / 1000);

  const insert = db.prepare(`
    INSERT INTO jobs (
      simplify_id, source_repos, company_name, company_url, title, url, dedupe_key,
      apply_host, ats_platform, category, locations, terms, degrees, sponsorship,
      source, feed_active, is_visible, removed_at, date_posted, date_updated,
      first_seen_at, last_seen_at, content_hash, flags
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)
    ON CONFLICT(simplify_id) DO UPDATE SET
      source_repos = ?, company_name = ?, company_url = ?, title = ?, url = ?,
      dedupe_key = ?, apply_host = ?, ats_platform = ?, category = ?, locations = ?,
      terms = ?, degrees = ?, sponsorship = ?, source = ?, feed_active = ?,
      is_visible = ?, date_posted = ?, date_updated = ?, last_seen_at = ?,
      content_hash = ?, flags = ?, removed_at = NULL
  `);

  return transaction(db, () => {
    let written = 0;
    for (const row of listings) {
      const repos = JSON.stringify(row.source_repos);
      const locations = JSON.stringify(row.locations);
      const terms = JSON.stringify(row.terms);
      const degrees = JSON.stringify(row.degrees);
      const flags = JSON.stringify(row.flags);
      const active = row.feed_active ? 1 : 0;
      const visible = row.is_visible ? 1 : 0;
      insert.run(
        row.simplify_id, repos, row.company_name, row.company_url, row.title, row.url,
        row.dedupe_key, row.apply_host, row.ats_platform, row.category, locations, terms,
        degrees, row.sponsorship, row.source, active, visible, row.date_posted,
        row.date_updated, now, now, row.content_hash, flags,
        // update arm
        repos, row.company_name, row.company_url, row.title, row.url, row.dedupe_key,
        row.apply_host, row.ats_platform, row.category, locations, terms, degrees,
        row.sponsorship, row.source, active, visible, row.date_posted, row.date_updated,
        now, row.content_hash, flags
      );
      written += 1;
    }
    return written;
  });
}

/**
 * Marks listings that vanished from every feed they belonged to. Only feeds
 * confirmed fresh are considered, so one failing fetch can never mass-delete
 * the user's job list.
 */
export function sweepRemovedJobs(db: Db, freshRepos: string[], graceSeconds = 6 * 3600): number {
  if (!freshRepos.length) return 0;
  const cutoff = Math.floor(Date.now() / 1000) - graceSeconds;
  const rows = db
    .prepare("SELECT simplify_id, source_repos FROM jobs WHERE removed_at IS NULL AND last_seen_at < ?")
    .all(cutoff) as unknown as Array<{ simplify_id: string; source_repos: string }>;

  const fresh = new Set(freshRepos);
  const stale = rows.filter((row) => {
    const repos = jsonParse<string[]>(row.source_repos, []);
    return repos.length > 0 && repos.every((repo) => fresh.has(repo));
  });
  if (!stale.length) return 0;

  return transaction(db, () => {
    const update = db.prepare("UPDATE jobs SET removed_at = ? WHERE simplify_id = ?");
    const now = Math.floor(Date.now() / 1000);
    for (const row of stale) update.run(now, row.simplify_id);
    return stale.length;
  });
}

export function queryJobs(db: Db, query: JobQuery = {}): JobPage {
  const where: string[] = ["j.removed_at IS NULL", "j.is_visible = 1"];
  const params: Array<string | number | null> = [];

  if (!query.includeHidden) where.push("(f.verdict IS NULL OR f.verdict != 'hidden')");
  if (!query.includeApplied) where.push("a.id IS NULL");
  where.push("j.feed_active = 1");

  if (query.automatableOnly) {
    where.push(`j.ats_platform IN (${AUTOMATABLE_PLATFORMS.map(() => "?").join(",")})`);
    params.push(...AUTOMATABLE_PLATFORMS);
  }
  if (query.platforms?.length) {
    where.push(`j.ats_platform IN (${query.platforms.map(() => "?").join(",")})`);
    params.push(...query.platforms);
  }
  if (query.categories?.length) {
    where.push(`j.category IN (${query.categories.map(() => "?").join(",")})`);
    params.push(...query.categories);
  }
  if (query.terms?.length) {
    const clauses = query.terms.map(() => "EXISTS (SELECT 1 FROM json_each(j.terms) WHERE value = ?)");
    where.push(`(${clauses.join(" OR ")})`);
    params.push(...query.terms);
  }

  const search = sanitizeFtsQuery(query.search ?? "");
  if (search) {
    where.push("j.rowid IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?)");
    params.push(search);
  }

  const joins = `
    FROM jobs j
    LEFT JOIN job_feedback f ON f.job_id = j.simplify_id
    LEFT JOIN applied_jobs a ON a.job_id = j.simplify_id
    WHERE ${where.join(" AND ")}
  `;

  const totalRow = db.prepare(`SELECT COUNT(*) AS n ${joins}`).get(...params) as unknown as { n: number };

  // Keyset pagination. OFFSET degrades badly at 30k rows and can skip or repeat
  // rows when a sync writes between pages.
  const pageParams: Array<string | number | null> = [...params];
  let cursorClause = "";
  if (query.cursorId) {
    cursorClause = " AND (COALESCE(j.date_posted, 0), j.simplify_id) < (COALESCE(?, 0), ?)";
    pageParams.push(query.cursorPosted ?? 0, query.cursorId);
  }

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const rows = db
    .prepare(`
      SELECT j.simplify_id, j.source_repos, j.company_name, j.company_url, j.title, j.url,
             j.apply_host, j.ats_platform, j.category, j.locations, j.terms, j.degrees,
             j.sponsorship, j.feed_active, j.date_posted, f.verdict, a.id AS applied_id
      ${joins}${cursorClause}
      ORDER BY j.date_posted DESC, j.simplify_id DESC
      LIMIT ?
    `)
    .all(...pageParams, limit) as unknown as JobRow[];

  const jobs = plainAll(rows).map(toRecord);
  const last = jobs.length === limit ? jobs[jobs.length - 1] : undefined;

  return {
    jobs,
    total: Number(totalRow?.n ?? 0),
    nextCursor: last ? { posted: last.datePosted, id: last.simplifyId } : null
  };
}

export function getJob(db: Db, simplifyId: string): JobRecord | null {
  const row = db
    .prepare(`
      SELECT j.simplify_id, j.source_repos, j.company_name, j.company_url, j.title, j.url,
             j.apply_host, j.ats_platform, j.category, j.locations, j.terms, j.degrees,
             j.sponsorship, j.feed_active, j.date_posted, f.verdict, a.id AS applied_id
      FROM jobs j
      LEFT JOIN job_feedback f ON f.job_id = j.simplify_id
      LEFT JOIN applied_jobs a ON a.job_id = j.simplify_id
      WHERE j.simplify_id = ?
    `)
    .get(simplifyId) as unknown as JobRow | undefined;
  return row ? toRecord({ ...row }) : null;
}

export function setJobFeedback(db: Db, jobId: string, verdict: "liked" | "hidden" | "saved" | null): void {
  if (!verdict) {
    db.prepare("DELETE FROM job_feedback WHERE job_id = ?").run(jobId);
    return;
  }
  db.prepare(`
    INSERT INTO job_feedback (job_id, verdict, created_at) VALUES (?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET verdict = ?, created_at = ?
  `).run(jobId, verdict, new Date().toISOString(), verdict, new Date().toISOString());
}

export function jobFacets(db: Db): { platforms: Array<{ value: string; count: number }>; categories: Array<{ value: string; count: number }>; terms: Array<{ value: string; count: number }> } {
  const base = "FROM jobs WHERE removed_at IS NULL AND feed_active = 1 AND is_visible = 1";
  const platforms = plainAll(
    db.prepare(`SELECT ats_platform AS value, COUNT(*) AS count ${base} GROUP BY 1 ORDER BY 2 DESC`).all() as Array<{ value: string; count: number }>
  );
  const categories = plainAll(
    db.prepare(`SELECT category AS value, COUNT(*) AS count ${base} AND category IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 40`).all() as Array<{ value: string; count: number }>
  );
  const terms = plainAll(
    db.prepare(`SELECT value, COUNT(*) AS count FROM jobs, json_each(jobs.terms) WHERE removed_at IS NULL AND feed_active = 1 GROUP BY 1 ORDER BY 2 DESC LIMIT 20`).all() as Array<{ value: string; count: number }>
  );
  return { platforms, categories, terms };
}

export function countJobs(db: Db): { total: number; active: number; automatable: number } {
  const total = db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number };
  const active = db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE removed_at IS NULL AND feed_active = 1 AND is_visible = 1")
    .get() as { n: number };
  const automatable = db
    .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE removed_at IS NULL AND feed_active = 1 AND is_visible = 1
              AND ats_platform IN (${AUTOMATABLE_PLATFORMS.map(() => "?").join(",")})`)
    .get(...AUTOMATABLE_PLATFORMS) as { n: number };
  return { total: Number(total?.n ?? 0), active: Number(active?.n ?? 0), automatable: Number(automatable?.n ?? 0) };
}

/**
 * Removes every job that came from a given source.
 *
 * Used to clear the practice applications left behind by the retired demo
 * mode, which would otherwise sit in a real user's feed forever.
 */
export function deleteJobsBySource(db: Db, source: string): number {
  const before = countJobs(db).total;
  db.prepare("DELETE FROM jobs WHERE source = ?").run(source);
  return before - countJobs(db).total;
}
