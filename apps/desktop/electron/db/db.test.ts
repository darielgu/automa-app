import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeListing, type NormalizedListing } from "@automa/job-feed-core";
import { openDatabase, runMigrations, transaction, type Db } from "./database.js";
import { buildAnyPhraseQuery, countJobs, getJob, jobFacets, queryJobs, sanitizeFtsQuery, setJobFeedback, sweepRemovedJobs, upsertJobs } from "./jobs-repo.js";
import {
  addResume, appendRunEvent, createRun, getActiveResume, getFeedMeta, getProfile, getSetting,
  listApplied, listRunEvents, listResumes, listRuns, moveAppliedStage, saveFeedMeta, saveProfile,
  setActiveResume, setSetting, updateRun, upsertAppliedJob
} from "./app-repo.js";

function tempDb(): { db: Db; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automa-db-"));
  return { db: openDatabase(path.join(dir, "automa.db")), dir };
}

function listing(overrides: Record<string, unknown> = {}): NormalizedListing {
  return normalizeListing(
    {
      id: "9ee25c43-14d2-48c6-9657-2f9919fc5cbe",
      company_name: "Capella",
      title: "Flight Software Intern",
      url: "https://boards.greenhouse.io/capella/jobs/5735295004",
      locations: ["San Francisco, CA"],
      terms: ["Summer 2026"],
      degrees: ["Bachelor's"],
      category: "Software Engineering",
      active: true,
      is_visible: true,
      date_posted: 1765785265,
      date_updated: 1765785265,
      ...overrides
    },
    "summer2026"
  )!;
}

test("migrations run once and are idempotent", () => {
  const { db, dir } = tempDb();
  try {
    const version = runMigrations(db);
    assert.ok(version >= 1);
    assert.equal(runMigrations(db), version, "re-running must not change the version");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the database file is not world readable", () => {
  const { db, dir } = tempDb();
  try {
    const mode = fs.statSync(path.join(dir, "automa.db")).mode & 0o777;
    assert.equal(mode, 0o600, "the profile holds a home address and phone number");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("jobs upsert, then update in place rather than duplicating", () => {
  const { db, dir } = tempDb();
  try {
    assert.equal(upsertJobs(db, [listing()]), 1);
    assert.equal(countJobs(db).total, 1);

    upsertJobs(db, [listing({ title: "Renamed Intern" })]);
    assert.equal(countJobs(db).total, 1, "same simplify_id must not create a second row");
    assert.equal(getJob(db, "9ee25c43-14d2-48c6-9657-2f9919fc5cbe")?.title, "Renamed Intern");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("full text search finds jobs by title and company", () => {
  const { db, dir } = tempDb();
  try {
    upsertJobs(db, [
      listing(),
      listing({ id: "11111111-1111-4111-8111-111111111111", title: "Data Analyst", company_name: "Northwind" })
    ]);
    assert.equal(queryJobs(db, { search: "flight" }).jobs.length, 1);
    assert.equal(queryJobs(db, { search: "northwind" }).jobs.length, 1);
    assert.equal(queryJobs(db, { search: "nonexistent" }).jobs.length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("search input is treated as text, not as an FTS query language", () => {
  // A raw quote or asterisk would otherwise raise an FTS5 syntax error and
  // break the jobs screen for anyone who types naturally.
  assert.equal(sanitizeFtsQuery('software "engineer"*'), '"software" "engineer"');
  assert.equal(sanitizeFtsQuery("   "), "");

  const { db, dir } = tempDb();
  try {
    upsertJobs(db, [listing()]);
    assert.doesNotThrow(() => queryJobs(db, { search: 'flight" OR ()*:' }));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("automatable filter excludes company career sites", () => {
  const { db, dir } = tempDb();
  try {
    upsertJobs(db, [
      listing(),
      listing({ id: "22222222-2222-4222-8222-222222222222", url: "https://careers.acme.com/job/9" })
    ]);
    assert.equal(queryJobs(db, {}).jobs.length, 2);
    const auto = queryJobs(db, { automatableOnly: true });
    assert.equal(auto.jobs.length, 1);
    assert.equal(auto.jobs[0]?.platform, "greenhouse");
    assert.equal(countJobs(db).automatable, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hidden jobs drop out of the feed but liked jobs stay", () => {
  const { db, dir } = tempDb();
  try {
    upsertJobs(db, [listing()]);
    setJobFeedback(db, "9ee25c43-14d2-48c6-9657-2f9919fc5cbe", "hidden");
    assert.equal(queryJobs(db, {}).jobs.length, 0);
    assert.equal(queryJobs(db, { includeHidden: true }).jobs.length, 1);

    setJobFeedback(db, "9ee25c43-14d2-48c6-9657-2f9919fc5cbe", "liked");
    assert.equal(queryJobs(db, {}).jobs.length, 1);
    assert.equal(queryJobs(db, {}).jobs[0]?.feedback, "liked");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("keyset pagination walks every job exactly once", () => {
  const { db, dir } = tempDb();
  try {
    const rows = Array.from({ length: 25 }, (_, i) => {
      const n = i.toString(16).padStart(2, "0");
      return listing({
        id: `333333${n}-3333-4333-8333-333333333333`,
        title: `Job ${i}`,
        date_posted: 1765785265 - i
      });
    });
    upsertJobs(db, rows);

    const seen = new Set<string>();
    let cursor: { posted: number | null; id: string } | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result = queryJobs(db, { limit: 10, cursorPosted: cursor?.posted ?? null, cursorId: cursor?.id ?? null });
      for (const job of result.jobs) {
        assert.equal(seen.has(job.simplifyId), false, "a job must not appear on two pages");
        seen.add(job.simplifyId);
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    assert.equal(seen.size, countJobs(db).total);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a single failing feed can never mass-remove jobs", () => {
  const { db, dir } = tempDb();
  try {
    upsertJobs(db, [listing()]);
    db.prepare("UPDATE jobs SET last_seen_at = 0").run();

    // No feed confirmed fresh: nothing may be removed.
    assert.equal(sweepRemovedJobs(db, []), 0);
    assert.equal(queryJobs(db, {}).jobs.length, 1);

    // A different feed is fresh, but this job did not come from it.
    assert.equal(sweepRemovedJobs(db, ["newgrad"]), 0);
    assert.equal(queryJobs(db, {}).jobs.length, 1);

    // Its own feed is fresh and the job is gone from it, so it may be removed.
    assert.equal(sweepRemovedJobs(db, ["summer2026"]), 1);
    assert.equal(queryJobs(db, {}).jobs.length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a job that reappears in the feed is un-removed", () => {
  const { db, dir } = tempDb();
  try {
    upsertJobs(db, [listing()]);
    db.prepare("UPDATE jobs SET last_seen_at = 0").run();
    sweepRemovedJobs(db, ["summer2026"]);
    assert.equal(queryJobs(db, {}).jobs.length, 0);

    upsertJobs(db, [listing()]);
    assert.equal(queryJobs(db, {}).jobs.length, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("facets summarize what is actually in the feed", () => {
  const { db, dir } = tempDb();
  try {
    upsertJobs(db, [
      listing(),
      listing({ id: "44444444-4444-4444-8444-444444444444", url: "https://jobs.lever.co/acme/x" })
    ]);
    const facets = jobFacets(db);
    assert.deepEqual(
      facets.platforms.map((p) => p.value).sort(),
      ["greenhouse", "lever"]
    );
    assert.equal(facets.terms.find((t) => t.value === "Summer 2026")?.count, 2);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("profile round trips, including nested json", () => {
  const { db, dir } = tempDb();
  try {
    assert.equal(getProfile(db), null);
    saveProfile(db, {
      fullName: "Alex Rivera",
      email: "alex.rivera@example.com",
      workAuthorization: { authorizedToWork: true, requiresSponsorship: false },
      previousEmployers: ["Example Labs"]
    });
    const profile = getProfile(db);
    assert.equal(profile?.fullName, "Alex Rivera");
    assert.deepEqual(profile?.workAuthorization, { authorizedToWork: true, requiresSponsorship: false });
    assert.deepEqual(profile?.previousEmployers, ["Example Labs"]);

    // A partial save must not wipe fields it did not mention.
    saveProfile(db, { phone: "+1 (555) 0100" });
    assert.equal(getProfile(db)?.fullName, "Alex Rivera");
    assert.equal(getProfile(db)?.phone, "+1 (555) 0100");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only one resume is active at a time", () => {
  const { db, dir } = tempDb();
  try {
    const first = addResume(db, { fileName: "a.pdf", filePath: "/tmp/a.pdf" });
    const second = addResume(db, { fileName: "b.pdf", filePath: "/tmp/b.pdf" });
    assert.equal(getActiveResume(db)?.id, second.id);

    setActiveResume(db, first.id);
    assert.equal(getActiveResume(db)?.id, first.id);
    assert.equal(listResumes(db).filter((r) => r.isActive).length, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a run records its lifecycle and its event stream", () => {
  const { db, dir } = tempDb();
  try {
    const run = createRun(db, { jobId: "job-1", sourceUrl: "https://example.com/apply", mode: "dry-run" });
    assert.equal(run.status, "queued");

    updateRun(db, run.id, { status: "running", phase: "filling_application", startedAt: new Date().toISOString() });
    appendRunEvent(db, run.id, { event: "navigating", data: { url: "https://example.com/apply" } });
    appendRunEvent(db, run.id, { event: "field_filled", data: { label: "First name" } });

    const events = listRunEvents(db, run.id);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.event, "navigating");

    // Incremental tailing is what drives the live run view.
    assert.equal(listRunEvents(db, run.id, events[0]!.id).length, 1);

    updateRun(db, run.id, {
      status: "completed", submitted: true, submissionConfirmed: false,
      submitOutcome: "pending_confirmation", notes: ["stopped before submit"]
    });
    const done = listRuns(db)[0];
    assert.equal(done?.status, "completed");
    assert.equal(done?.submitted, true);
    assert.equal(done?.submissionConfirmed, false);
    assert.deepEqual(done?.notes, ["stopped before submit"]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("finishing a run puts a card on the tracker, and repeats do not duplicate it", () => {
  const { db, dir } = tempDb();
  try {
    upsertAppliedJob(db, { jobId: "job-1", runId: "run-1", title: "Intern", company: "Capella" });
    upsertAppliedJob(db, { jobId: "job-1", runId: "run-2" });
    const applied = listApplied(db);
    assert.equal(applied.length, 1, "one card per job");
    assert.equal(applied[0]?.stage, "applied");

    const moved = moveAppliedStage(db, applied[0]!.id, "interviewing", "recruiter call");
    assert.equal(moved?.stage, "interviewing");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applied jobs drop out of the jobs feed", () => {
  const { db, dir } = tempDb();
  try {
    upsertJobs(db, [listing()]);
    assert.equal(queryJobs(db, {}).jobs.length, 1);
    upsertAppliedJob(db, { jobId: "9ee25c43-14d2-48c6-9657-2f9919fc5cbe" });
    assert.equal(queryJobs(db, {}).jobs.length, 0);
    assert.equal(queryJobs(db, { includeApplied: true }).jobs[0]?.applied, true);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("settings and feed metadata persist", () => {
  const { db, dir } = tempDb();
  try {
    setSetting(db, "mode", "dry-run");
    assert.equal(getSetting(db, "mode"), "dry-run");
    setSetting(db, "mode", "auto-submit");
    assert.equal(getSetting(db, "mode"), "auto-submit");
    assert.equal(getSetting(db, "missing"), null);

    saveFeedMeta(db, { repo: "summer2026", etag: 'W/"abc"', lastHttpStatus: 200, lastEntryCount: 14421 });
    assert.equal(getFeedMeta(db, "summer2026")?.etag, 'W/"abc"');

    // A later partial save must not clear the stored etag.
    saveFeedMeta(db, { repo: "summer2026", lastHttpStatus: 304 });
    assert.equal(getFeedMeta(db, "summer2026")?.etag, 'W/"abc"');
    assert.equal(getFeedMeta(db, "summer2026")?.lastHttpStatus, 304);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed transaction leaves no partial write", () => {
  const { db, dir } = tempDb();
  try {
    assert.throws(() =>
      transaction(db, () => {
        upsertJobs(db, [listing()]);
        throw new Error("boom");
      })
    );
    assert.equal(countJobs(db).total, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saved preferences match any role, not all of them", () => {
  const { db, dir } = tempDb();
  try {
    upsertJobs(db, [
      listing({ id: "44444444-4444-4444-8444-444444444444", title: "Software Engineer Intern" }),
      listing({ id: "55555555-5555-4555-8555-555555555555", title: "Data Scientist Intern" }),
      listing({ id: "66666666-6666-4666-8666-666666666666", title: "Mechanical Technician" })
    ]);

    // The whole point: ANDing these two phrases matches nothing, because no
    // posting is both. A person who saved both wants either.
    const both = queryJobs(db, { matchAny: ["Software Engineer", "Data Scientist"] });
    assert.equal(both.total, 2);

    const one = queryJobs(db, { matchAny: ["Software Engineer"] });
    assert.equal(one.total, 1);

    // No preferences must mean no filter, never "match nothing".
    assert.equal(buildAnyPhraseQuery([]), "");
    assert.equal(queryJobs(db, { matchAny: [] }).total, 3);

    // Typing narrows within the preferences rather than replacing them.
    const narrowed = queryJobs(db, { matchAny: ["Software Engineer", "Data Scientist"], search: "Data" });
    assert.equal(narrowed.total, 1);
    assert.equal(narrowed.jobs[0]?.title, "Data Scientist Intern");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hidden jobs come back when asked for", () => {
  const { db, dir } = tempDb();
  try {
    upsertJobs(db, [listing()]);
    const id = queryJobs(db, {}).jobs[0]!.simplifyId;
    setJobFeedback(db, id, "hidden");

    // Thumbs-down was irreversible from the UI because nothing ever passed
    // this flag; the row still has to be reachable for that to be fixable.
    assert.equal(queryJobs(db, {}).total, 0);
    assert.equal(queryJobs(db, { includeHidden: true }).total, 1);
    assert.equal(queryJobs(db, { includeHidden: true }).jobs[0]?.feedback, "hidden");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
