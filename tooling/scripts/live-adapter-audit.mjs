#!/usr/bin/env node
/**
 * Drives the real adapters against real, live job postings and reports how many
 * they actually resolve.
 *
 * The practice fixtures prove an adapter can fill markup we wrote ourselves.
 * They cannot tell us whether it copes with the real thing: a Greenhouse form
 * embedded in a company's own site, a Lever posting behind a redirect, an Ashby
 * board that renders its fields three seconds after load. This does.
 *
 * SAFETY: every run here is dry-run. Automa fills the form and stops. Sending
 * fabricated applications to real employers would waste real people's time, and
 * submission is not needed to measure whether an adapter can resolve a form.
 * The script refuses to run if the app is configured to auto-submit.
 *
 * Usage:
 *   node tooling/scripts/live-adapter-audit.mjs [platform] [count]
 *   node tooling/scripts/live-adapter-audit.mjs greenhouse 8
 *   node tooling/scripts/live-adapter-audit.mjs all 5
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// "generic" is the catch-all adapter, and it carries 1,807 active listings --
// 41% of the corpus, more than every named platform combined. It is included
// because the largest untested surface in the product is the one most likely to
// be quietly failing.
const PLATFORMS = ["greenhouse", "lever", "ashby", "generic", "workday"];

/**
 * Platforms whose application flow creates an account on the employer's own
 * system before a form is reachable.
 *
 * Workday postings sit behind a per-tenant candidate account, and the adapter
 * genuinely creates one: it fills a password and clicks
 * createAccountSubmitButton. Auditing it against live postings would leave real
 * records in real companies' recruiting systems, under a fictional persona,
 * with no intention of applying. Filling a form and walking away costs an
 * employer nothing; registering a fake candidate does not.
 *
 * Set AUDIT_ALLOW_ACCOUNT_CREATION=1 only against a tenant you own.
 */
const CREATES_EMPLOYER_ACCOUNTS = new Set(["workday"]);
const platformArg = (process.argv[2] || "all").toLowerCase();
const perPlatform = Number.parseInt(process.argv[3] || "5", 10);
const targets = platformArg === "all" ? PLATFORMS : [platformArg];

const userData = path.join(os.homedir(), "Library", "Application Support", "Automa");
const statePath = path.join(userData, "automa-state.json");

function readState() {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

const state = readState();
if (state.config?.mode !== "dry-run") {
  console.error(`Refusing to run: config.mode is "${state.config?.mode}", not "dry-run".`);
  console.error("This harness points the automation at real employers. Set dry-run first.");
  process.exit(2);
}

const port = fs.readFileSync(path.join(userData, "DevToolsActivePort"), "utf8").split("\n")[0].trim();
const { chromium } = await import("playwright-core");
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 });
const page = browser.contexts()[0].pages().find((p) => p.url().includes("index.html"));
if (!page) {
  console.error("The Automa window is not open.");
  process.exit(2);
}

/** A run is resolved when the adapter reached the form and filled real fields. */
const TERMINAL = ["completed", "filled", "applied", "failed", "cancelled", "skipped"];

function classify(run) {
  // Values the form arrived with are not work this tool did. Counting them
  // inflated an early measurement to "19 fields" when 13 were country-code
  // selectors the page had already set to +1.
  const fields = (run.filledFields || [])
    .filter((f) => !String(f.id || "").startsWith("__"))
    .filter((f) => f.source !== "prefilled");
  // A run that never finished is not a run that filled nothing. Reporting it as
  // "no_identity_fields" hides the real problem, which is duration.
  if (!TERMINAL.includes(run.status)) {
    return { resolved: false, reason: `still_${run.status}_after_wait`, fields: fields.length };
  }
  const identity = fields.filter((f) => /first|last|name|email|phone/i.test(`${f.label} ${f.id}`));
  // Checked before the failed branch on purpose: a closed posting arrives as a
  // failure with this outcome, and testing status first put it in the
  // denominator, which is how Greenhouse read 4/5 when it was 4/4 on postings
  // that still exist.
  if (run.submitOutcome === "inactive_posting") {
    return { resolved: false, inactive: true, reason: "posting_closed", fields: fields.length };
  }
  if (run.status === "failed") return { resolved: false, reason: run.submitOutcome || "failed", fields: fields.length };
  if (run.status === "skipped") return { resolved: false, reason: run.submitOutcome || "skipped", fields: fields.length };
  // Identity fields are the floor: an adapter that filled nothing a human would
  // recognise has not resolved the form, whatever its status says.
  if (identity.length < 2) return { resolved: false, reason: "no_identity_fields", fields: fields.length };

  // Two different questions, and conflating them would overstate the tool.
  // "resolved" is whether the adapter reached the real form and filled it.
  // "complete" is whether anything is left for a person before it could be
  // submitted -- a form blocked on one unanswered required question is a good
  // outcome, but it is not a finished application.
  const blocked = String(run.submitOutcome || "").startsWith("blocked_pre_submit");
  const leftovers = (run.unresolvedQuestionnaire || []).length;
  return {
    resolved: true,
    complete: !blocked && leftovers === 0,
    leftovers,
    reason: run.submitOutcome || run.status,
    fields: fields.length
  };
}

const results = [];

for (const platform of targets) {
  process.stdout.write(`\n=== ${platform} ===\n`);
  if (CREATES_EMPLOYER_ACCOUNTS.has(platform) && process.env.AUDIT_ALLOW_ACCOUNT_CREATION !== "1") {
    console.log("  skipped: applying here creates a candidate account on the employer's own system.");
    console.log("  Set AUDIT_ALLOW_ACCOUNT_CREATION=1 to override, and only against a tenant you own.");
    continue;
  }
  // The feed re-sorts as new listings arrive, so "the newest five" is a
  // different five an hour later. AUDIT_PIN=<file> freezes the sample, which is
  // the only way a before-and-after number means anything.
  const pinPath = process.env.AUDIT_PIN;
  const pinned = pinPath && fs.existsSync(pinPath) ? JSON.parse(fs.readFileSync(pinPath, "utf8")) : null;

  // Automa's own practice fixtures are seeded into the corpus under
  // AUTOMA_DEV_PRACTICE and look like ordinary Greenhouse, Lever and Ashby
  // listings. One reached a sample built from the database and passed, which
  // proves only that the adapter can fill markup we wrote ourselves -- the
  // exact thing this harness exists to stop counting.
  const isPractice = (job) => /practice|automa-practice|^file:/i.test(`${job.url} ${job.company ?? ""}`);

  let jobs;
  if (pinned?.[platform]?.length) {
    jobs = pinned[platform].filter((job) => !isPractice(job)).slice(0, perPlatform);
    console.log(`  (pinned sample of ${jobs.length})`);
  } else {
    jobs = await page.evaluate(
      async ({ platform, limit }) => {
        const page = await window.automaDesktop.listJobs({ platforms: [platform], limit, automatableOnly: false });
        return page.jobs.map((j) => ({ id: j.simplifyId, url: j.url, title: j.title, company: j.company }));
      },
      { platform, limit: perPlatform }
    );
    jobs = jobs.filter((job) => !isPractice(job));
    if (pinPath) {
      const store = pinned ?? {};
      store[platform] = jobs;
      fs.writeFileSync(pinPath, JSON.stringify(store, null, 2));
      console.log(`  (pinned ${jobs.length} for future runs)`);
    }
  }

  if (!jobs.length) {
    console.log("  no live listings for this platform");
    continue;
  }

  for (const job of jobs) {
    const before = Date.now();
    const runId = await page.evaluate(async (job) => {
      const run = await window.automaDesktop.enqueueRun({
        id: job.id,
        sourceUrl: job.url,
        title: job.title,
        company: job.company,
        source: "live-audit"
      });
      return run.id;
    }, job);

    // Runs are executed by the main process; poll its state file rather than
    // the renderer, which only mirrors what it has been told.
    // Real application forms take minutes, not seconds: a Greenhouse posting
    // with a dozen custom questions and two comboboxes is normal. Too short a
    // wait reports "timeout" for runs that were about to succeed.
    let run = null;
    for (let i = 0; i < 360; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      run = readState().runs.find((entry) => entry.id === runId);
      if (run && TERMINAL.includes(run.status)) break;
    }
    const verdict = run ? classify(run) : { resolved: false, reason: "timeout", fields: 0 };
    results.push({ platform, job, verdict, run });
    console.log(
      `  ${verdict.inactive ? "CLOSED" : verdict.resolved ? "PASS" : "FAIL"}  ${String(verdict.fields).padStart(2)} fields  ` +
        `${String(verdict.reason).padEnd(26)} ${Math.round((Date.now() - before) / 1000)}s  ${job.company} — ${job.title}`.slice(0, 150)
    );
  }
}

console.log("\n=== resolution by platform ===");
let allPass = true;
for (const platform of targets) {
  const rows = results.filter((r) => r.platform === platform);
  if (!rows.length) continue;
  const inactive = rows.filter((r) => r.verdict.inactive);
  const live = rows.filter((r) => !r.verdict.inactive);
  const passed = live.filter((r) => r.verdict.resolved).length;
  const pct = live.length ? Math.round((passed / live.length) * 100) : 0;
  if (pct < 100 || !live.length) allPass = false;
  const complete = live.filter((r) => r.verdict.complete).length;
  const completePct = live.length ? Math.round((complete / live.length) * 100) : 0;
  console.log(
    `  ${platform.padEnd(16)} reached+filled ${passed}/${live.length} (${String(pct).padStart(3)}%)   ` +
      `submittable unaided ${complete}/${live.length} (${String(completePct).padStart(3)}%)` +
      (inactive.length ? `   +${inactive.length} closed` : "")
  );
  for (const row of live.filter((r) => r.verdict.resolved && !r.verdict.complete)) {
    console.log(`      needs a person: ${row.verdict.reason}  ${row.job.title?.slice(0, 44) ?? ""}`);
  }
  for (const row of live.filter((r) => !r.verdict.resolved)) {
    console.log(`      failed: ${row.verdict.reason}  ${row.job.url}`);
  }
  for (const row of inactive) {
    console.log(`      closed: ${row.job.url}`);
  }
}

const out = path.join(process.env.AUDIT_OUT || ".", "live-audit.json");
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`\nfull detail: ${out}`);
await browser.close();
process.exit(allPass ? 0 : 1);
