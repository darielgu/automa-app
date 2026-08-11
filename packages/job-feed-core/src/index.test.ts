import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeApplyUrl,
  contentHash,
  detectAtsPlatform,
  fnv1a64,
  isAutomatable,
  mergeById,
  normalizeListing,
  normalizeListings,
  SIMPLIFY_SOURCES,
  type NormalizedListing
} from "./index.js";

function rawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "9ee25c43-14d2-48c6-9657-2f9919fc5cbe",
    company_name: "Capella",
    company_url: "",
    title: "Flight Software Engineering Intern",
    url: "https://boards.greenhouse.io/example/jobs/5735295004",
    locations: ["San Francisco, CA"],
    terms: ["Summer 2026"],
    degrees: ["Bachelor's"],
    category: "Hardware Engineering",
    sponsorship: "U.S. Citizenship is Required",
    source: "AlmondCroffle",
    active: true,
    is_visible: true,
    date_posted: 1765785265,
    date_updated: 1765785265,
    ...overrides
  };
}

test("platform detection matches the engine's rules", () => {
  assert.equal(detectAtsPlatform("https://boards.greenhouse.io/acme/jobs/123"), "greenhouse");
  assert.equal(detectAtsPlatform("https://acme.com/apply?gh_jid=5735295004"), "greenhouse");
  assert.equal(detectAtsPlatform("https://jobs.lever.co/acme/abc"), "lever");
  assert.equal(detectAtsPlatform("https://acme.wd1.myworkdayjobs.com/en-US/careers/job/x"), "workday");
  assert.equal(detectAtsPlatform("https://jobs.ashbyhq.com/acme/xyz"), "ashby");
  assert.equal(detectAtsPlatform("https://www.workatastartup.com/jobs/12345"), "workatastartup");
  assert.equal(detectAtsPlatform("https://careers.acme.com/job/9"), "generic");
  assert.equal(detectAtsPlatform("not-a-url"), "unknown");
});

test("a short gh_jid is not treated as greenhouse", () => {
  // The engine requires six or more digits. A short numeric id is some other
  // system's job id and must not be routed to the Greenhouse adapter.
  assert.equal(detectAtsPlatform("https://acme.com/apply?gh_jid=42"), "generic");
});

test("automatable platforms exclude generic and unknown", () => {
  assert.equal(isAutomatable("greenhouse"), true);
  assert.equal(isAutomatable("workday"), true);
  assert.equal(isAutomatable("generic"), false);
  assert.equal(isAutomatable("unknown"), false);
});

test("normalizes a well formed row", () => {
  const row = normalizeListing(rawRow(), "summer2026");
  assert.ok(row);
  assert.equal(row.simplify_id, "9ee25c43-14d2-48c6-9657-2f9919fc5cbe");
  assert.equal(row.ats_platform, "greenhouse");
  assert.equal(row.apply_host, "boards.greenhouse.io");
  assert.deepEqual(row.source_repos, ["summer2026"]);
  assert.equal(row.company_url, null, "empty strings become null");
  assert.equal(row.feed_active, true);
  assert.equal(row.content_hash.length, 16);
});

test("the apply url is stored verbatim so ATS query params survive", () => {
  const url = "https://acme.com/apply?gh_jid=5735295004&token=abc";
  const row = normalizeListing(rawRow({ url }), "summer2026");
  assert.equal(row?.url, url);
});

test("rejects rows that cannot be trusted", () => {
  assert.equal(normalizeListing(rawRow({ id: "not-a-uuid" }), "summer2026"), null);
  assert.equal(normalizeListing(rawRow({ url: "" }), "summer2026"), null);
  assert.equal(normalizeListing(rawRow({ url: "ftp://acme.com/x" }), "summer2026"), null);
  assert.equal(normalizeListing(rawRow({ title: "  " }), "summer2026"), null);
  assert.equal(normalizeListing(rawRow({ company_name: "" }), "summer2026"), null);
  assert.equal(normalizeListing(null, "summer2026"), null);
});

test("a simplify redirect wrapper is kept but never claimed as automatable", () => {
  const row = normalizeListing(rawRow({ url: "https://simplify.jobs/p/abc123" }), "newgrad");
  assert.ok(row);
  assert.equal(row.ats_platform, "generic");
  assert.ok(row.flags.includes("simplify_wrapper"));
  assert.equal(isAutomatable(row.ats_platform), false);
});

test("counts skipped rows instead of throwing", () => {
  const result = normalizeListings([rawRow(), { id: "bad" }, rawRow({ url: "" })], "summer2026");
  assert.equal(result.rows.length, 1);
  assert.equal(result.skipped, 2);
});

test("normalizeListings tolerates a non-array payload", () => {
  assert.deepEqual(normalizeListings({ nope: true }, "summer2026"), { rows: [], skipped: 0 });
});

test("dedupe key ignores tracking params and query order", () => {
  const a = canonicalizeApplyUrl("https://Acme.com/job?b=2&a=1&utm_source=x");
  const b = canonicalizeApplyUrl("https://acme.com/job?a=1&b=2&ref=y");
  assert.equal(a, b);
});

test("dedupe key keeps params the ATS needs", () => {
  assert.ok(canonicalizeApplyUrl("https://acme.com/a?gh_jid=5735295004").includes("gh_jid"));
});

test("merging unions the feeds a posting appeared in", () => {
  const s26 = normalizeListing(rawRow(), "summer2026")!;
  const ng = normalizeListing(rawRow(), "newgrad")!;
  const merged = mergeById([[s26], [ng]]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]?.source_repos, ["newgrad", "summer2026"]);
});

test("content hash changes when a meaningful field changes, and only then", () => {
  const base = normalizeListing(rawRow(), "summer2026")!;
  const sameAgain = normalizeListing(rawRow(), "summer2026")!;
  assert.equal(base.content_hash, sameAgain.content_hash);

  const retitled = normalizeListing(rawRow({ title: "Different Title" }), "summer2026")!;
  assert.notEqual(base.content_hash, retitled.content_hash);

  const closed = normalizeListing(rawRow({ active: false }), "summer2026")!;
  assert.notEqual(base.content_hash, closed.content_hash);

  // The feed it came from is not part of the row's content.
  const otherFeed = normalizeListing(rawRow(), "newgrad")!;
  assert.equal(base.content_hash, otherFeed.content_hash);
});

test("fnv1a64 is stable and fixed width", () => {
  assert.equal(fnv1a64(""), "cbf29ce484222325");
  assert.equal(fnv1a64("a").length, 16);
  assert.notEqual(fnv1a64("a"), fnv1a64("b"));
});

test("contentHash does not depend on source_repos or flags", () => {
  const row = normalizeListing(rawRow(), "summer2026")!;
  const { content_hash, source_repos, flags, ...rest } = row as NormalizedListing & Record<string, unknown>;
  void source_repos;
  void flags;
  assert.equal(contentHash(rest as never), content_hash);
});

test("all three Simplify sources are declared with a raw githubusercontent url", () => {
  assert.equal(SIMPLIFY_SOURCES.length, 3);
  for (const source of SIMPLIFY_SOURCES) {
    assert.match(source.url, /^https:\/\/raw\.githubusercontent\.com\/SimplifyJobs\//);
    assert.match(source.url, /listings\.json$/);
  }
});
