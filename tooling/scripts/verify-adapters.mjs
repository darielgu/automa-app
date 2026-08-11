/**
 * Drives the running app over CDP and reports which adapters actually fill.
 *
 * This is the only check that exercises Electron's embedded WebContentsView
 * surface, where a background view reports every element as invisible. Four of
 * five adapters once passed standalone while filling nothing in the app, so a
 * plain-Chromium harness cannot replace this.
 *
 * Requires the app running with AUTOMA_DEV_PRACTICE=1 and onboarding complete.
 *
 *   AUTOMA_DEV_PRACTICE=1 npm run dev -w @automa/desktop   # or a packaged app
 *   node tooling/scripts/verify-adapters.mjs
 */
import fs from "node:fs";
import path from "node:path";

const PORT_FILE = path.join(
  process.env.HOME ?? "",
  "Library/Application Support/Automa/DevToolsActivePort"
);

/** Per-platform floor. Without one, an adapter that opens the page and fills nothing passes. */
const MINIMUM_FIELDS = {
  greenhouse: 5,
  lever: 8,
  ashby: 5,
  workday: 5,
  workatastartup: 1
};

async function waitForPort() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (fs.existsSync(PORT_FILE)) return fs.readFileSync(PORT_FILE, "utf8").split("\n")[0].trim();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${PORT_FILE}. Is the app running?`);
}

const { chromium } = await import("playwright-core");
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${await waitForPort()}`);
const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes("index.html"));
if (!page) throw new Error("Could not find the app window. Is the renderer loaded?");

const practice = (
  await page.evaluate(() => window.automaDesktop.listJobs({ search: "practice", limit: 20, includeApplied: true }))
).jobs;

if (practice.length < 5) {
  throw new Error(
    `Expected 5 practice applications, found ${practice.length}. ` +
      "Start the app with AUTOMA_DEV_PRACTICE=1 and complete onboarding first."
  );
}

for (const job of practice) {
  await page.evaluate(
    (target) =>
      window.automaDesktop.enqueueRun({
        id: target.simplifyId,
        sourceUrl: target.url,
        title: target.title,
        company: target.company,
        location: "Remote",
        source: target.platform
      }),
    job
  );
}

for (let tick = 0; tick < 90; tick += 1) {
  await page.waitForTimeout(5000);
  const runs = await page.evaluate(() => window.automaDesktop.listRuns());
  if (runs.filter((run) => ["completed", "failed", "cancelled"].includes(run.status)).length >= practice.length) break;
}

const runs = await page.evaluate(() => window.automaDesktop.listRuns());
let failures = 0;

for (const run of runs.sort((a, b) => String(a.provider).localeCompare(String(b.provider)))) {
  const filled = (run.filledFields ?? []).length;
  const floor = MINIMUM_FIELDS[run.provider] ?? 1;
  const ok = filled >= floor;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${String(run.provider).padEnd(15)} ${String(filled).padStart(2)} fields ` +
      `(floor ${floor})  status=${run.status}`
  );
  if (!ok && run.failureDetail) console.log(`      ! ${String(run.failureDetail.reason).split("\n")[0]}`);
}

console.log(`\n${runs.length - failures}/${runs.length} adapters fill`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
