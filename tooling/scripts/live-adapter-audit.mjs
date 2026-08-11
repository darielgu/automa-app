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

const PLATFORMS = ["greenhouse", "lever", "ashby", "workday"];
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
const TERMINAL = ["completed", "failed", "cancelled", "skipped"];

function classify(run) {
  const fields = (run.filledFields || []).filter((f) => !String(f.id || "").startsWith("__"));
  // A run that never finished is not a run that filled nothing. Reporting it as
  // "no_identity_fields" hides the real problem, which is duration.
  if (!TERMINAL.includes(run.status)) {
    return { resolved: false, reason: `still_${run.status}_after_wait`, fields: fields.length };
  }
  const identity = fields.filter((f) => /first|last|name|email|phone/i.test(`${f.label} ${f.id}`));
  if (run.status === "failed") return { resolved: false, reason: run.submitOutcome || "failed", fields: fields.length };
  if (run.status === "skipped") return { resolved: false, reason: run.submitOutcome || "skipped", fields: fields.length };
  // Identity fields are the floor: an adapter that filled nothing a human would
  // recognise has not resolved the form, whatever its status says.
  if (identity.length < 2) return { resolved: false, reason: "no_identity_fields", fields: fields.length };
  return { resolved: true, reason: run.submitOutcome || run.status, fields: fields.length };
}

const results = [];

for (const platform of targets) {
  process.stdout.write(`\n=== ${platform} ===\n`);
  const jobs = await page.evaluate(
    async ({ platform, limit }) => {
      const page = await window.automaDesktop.listJobs({ platforms: [platform], limit, automatableOnly: false });
      return page.jobs.map((j) => ({ id: j.simplifyId, url: j.url, title: j.title, company: j.company }));
    },
    { platform, limit: perPlatform }
  );

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
      `  ${verdict.resolved ? "PASS" : "FAIL"}  ${String(verdict.fields).padStart(2)} fields  ` +
        `${String(verdict.reason).padEnd(26)} ${Math.round((Date.now() - before) / 1000)}s  ${job.company} — ${job.title}`.slice(0, 150)
    );
  }
}

console.log("\n=== resolution by platform ===");
let allPass = true;
for (const platform of targets) {
  const rows = results.filter((r) => r.platform === platform);
  if (!rows.length) continue;
  const passed = rows.filter((r) => r.verdict.resolved).length;
  const pct = Math.round((passed / rows.length) * 100);
  if (pct < 100) allPass = false;
  console.log(`  ${platform.padEnd(16)} ${passed}/${rows.length}  ${String(pct).padStart(3)}%`);
  for (const row of rows.filter((r) => !r.verdict.resolved)) {
    console.log(`      failed: ${row.verdict.reason}  ${row.job.url}`);
  }
}

const out = path.join(process.env.AUDIT_OUT || ".", "live-audit.json");
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`\nfull detail: ${out}`);
await browser.close();
process.exit(allPass ? 0 : 1);
