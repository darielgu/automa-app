#!/usr/bin/env node
/**
 * Post-deploy acceptance for the job-feed mirror.
 *
 * Everything here runs with the anon key, which is meant to be public, so this
 * is safe to run from anywhere and safe to paste output from. It answers the
 * two questions a deploy leaves open:
 *
 *   1. Did the scraper actually fill the corpus?
 *   2. Is the public key really read-only?
 *
 * The second matters more than it looks. The whole design rests on the anon key
 * being harmless in an open-source binary, and that claim is only worth
 * anything if someone checks it against the deployed project rather than
 * against the migration that was supposed to produce it.
 *
 * Usage:
 *   node tooling/scripts/verify-scrape-deploy.mjs <project-url> <anon-key>
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... node tooling/scripts/verify-scrape-deploy.mjs
 */

const url = (process.argv[2] || process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
const anonKey = (process.argv[3] || process.env.SUPABASE_ANON_KEY || "").trim();

if (!url || !anonKey) {
  console.error("Usage: node tooling/scripts/verify-scrape-deploy.mjs <project-url> <anon-key>");
  process.exit(2);
}

// Refuse a service_role key outright. It would pass every check below by
// bypassing row level security, reporting a locked-down project that is not.
const payload = anonKey.split(".")[1];
if (payload) {
  try {
    const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    if (decoded.role === "service_role") {
      console.error("That is a service_role key. It bypasses RLS, so these checks would pass regardless. Use the anon key.");
      process.exit(2);
    }
  } catch {
    // Not a JWT we can read. The checks below still tell the truth.
  }
}

const headers = {
  apikey: anonKey,
  Authorization: `Bearer ${anonKey}`,
  "Content-Type": "application/json"
};

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(34)} ${detail}`);
}

async function readCount() {
  const response = await fetch(`${url}/rest/v1/job_listings?select=simplify_id&limit=1`, {
    headers: { ...headers, Prefer: "count=exact" }
  });
  if (!response.ok) return { ok: false, count: 0, detail: `HTTP ${response.status}` };
  // PostgREST reports the total in Content-Range as "0-0/32385".
  const total = Number((response.headers.get("content-range") || "").split("/")[1]);
  return { ok: Number.isFinite(total), count: total, detail: `${total} listings` };
}

async function pageByKeyset() {
  let cursorPosted = null;
  let cursorId = null;
  let rows = 0;
  const seen = new Set();

  for (let page = 0; page < 60; page += 1) {
    const response = await fetch(`${url}/rest/v1/rpc/search_job_listings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_only_active: true, p_limit: 1000, p_cursor_posted: cursorPosted, p_cursor_id: cursorId })
    });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status} ${await response.text()}` };

    const batch = await response.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows += batch.length;
    for (const row of batch) seen.add(row.simplify_id);

    const last = batch[batch.length - 1];
    if (!last?.simplify_id || last.simplify_id === cursorId) break;
    cursorPosted = last.date_posted ?? null;
    cursorId = last.simplify_id;
  }

  // Duplicates mean the cursor is not strictly ordered; a NULL-handling bug in
  // the keyset predicate shows up here and nowhere else.
  return { ok: rows > 0 && rows === seen.size, detail: `${rows} rows, ${rows - seen.size} duplicates` };
}

async function expectRefused(name, path, body) {
  const response = await fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  record(name, response.status === 401 || response.status === 403, `HTTP ${response.status}`);
}

const count = await readCount();
record("corpus is populated", count.ok && count.count > 1000, count.detail);

const paging = await pageByKeyset();
record("keyset paging is complete", paging.ok, paging.detail);

await expectRefused("anon cannot insert a listing", "/rest/v1/job_listings", {
  simplify_id: "00000000-0000-0000-0000-000000000001",
  company_name: "x",
  title: "x",
  url: "x",
  dedupe_key: "x",
  ats_platform: "greenhouse",
  content_hash: "x"
});
await expectRefused("anon cannot call the ingest rpc", "/rest/v1/rpc/ingest_job_listings", {
  p_run_id: "00000000-0000-0000-0000-000000000001",
  p_repo: "x",
  p_rows: []
});
await expectRefused("anon cannot call the sweep rpc", "/rest/v1/rpc/sweep_removed_listings", {});

const stateResponse = await fetch(`${url}/rest/v1/scrape_source_state?select=repo`, { headers });
record(
  "scrape_source_state stays private",
  stateResponse.status === 401 || stateResponse.status === 403 || (await stateResponse.json().catch(() => []))?.length === 0,
  `HTTP ${stateResponse.status}`
);

// A scrape that 401s writes no run row at all, so an empty table is the exact
// signature of the Vault secret and the function secret disagreeing.
const runsResponse = await fetch(`${url}/rest/v1/scrape_runs?select=repo,status,rows_upserted&order=started_at.desc&limit=3`, { headers });
const runs = runsResponse.ok ? await runsResponse.json().catch(() => []) : [];
record(
  "a scrape run was recorded",
  Array.isArray(runs) && runs.length > 0,
  runs.length ? runs.map((run) => `${run.repo}:${run.status}:${run.rows_upserted}`).join(" ") : "no runs -- check that SCRAPE_TRIGGER_SECRET matches the Vault secret"
);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
