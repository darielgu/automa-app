/**
 * Runs one adapter against one bundled practice application, outside Electron.
 *
 * The in-app path needs a packaged build and an embedded CDP surface, which is
 * far too slow to iterate on. This launches a plain Chromium instead, so a
 * single adapter attempt takes seconds.
 *
 *   node tooling/scripts/try-adapter.mjs ashby [--headed]
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { runAutomation } from "../../packages/engine/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const platform = process.argv[2];
const headed = process.argv.includes("--headed");
const files = {
  greenhouse: "greenhouse-demo.html",
  lever: "lever-demo.html",
  ashby: "ashby-demo.html",
  workday: "workday-demo.html",
  workatastartup: "workatastartup-demo.html"
};
if (!files[platform]) {
  console.error("usage: try-adapter.mjs <" + Object.keys(files).join("|") + "> [--headed]");
  process.exit(1);
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "automa-try-"));
const resumePath = path.join(outDir, "resume.pdf");
fs.writeFileSync(resumePath, "%PDF-1.4\n%demo resume\n");

// Use the app's real guest persona when it is available, so the harness
// exercises exactly what a demo run uses rather than a richer sample profile.
const guestPath = process.env.AUTOMA_TRY_PROFILE;
const profileSource = guestPath && fs.existsSync(guestPath)
  ? guestPath
  : path.join(root, "packages/engine/examples/profile.example.json");
console.log("profile:", path.basename(profileSource));
const raw = JSON.parse(fs.readFileSync(profileSource, "utf8"));
const { preferences: _ignored, ...profile } = raw;

const result = await runAutomation({
  config: {
    mode: "dry-run",
    headless: !headed,
    timeoutMs: 30000,
    outputDir: outDir,
    screenshotsDir: outDir,
    resumePath,
    ai: { provider: "none" }
  },
  profile,
  resumeText: "Alex Rivera. Software engineer. TypeScript, React, Node.",
  targets: [{ url: `file://${path.join(root, "apps/desktop/resources/demo", files[platform])}`, jobTitle: "Demo", company: "Automa Demo Co" }]
});

const run = Array.isArray(result) ? result[0] : result?.results?.[0] ?? result;
console.log(`\n=== ${platform} ===`);
console.log("status        :", run?.status);
console.log("platform      :", run?.platform);
console.log("fields filled :", (run?.filledFields || []).length);
for (const f of (run?.filledFields || [])) {
  console.log("   ✓", String(f.label || f.questionId).slice(0, 46).padEnd(46), "=", String(f.value).slice(0, 30));
}
if (run?.error) console.log("error         :", String(run.error).split("\n")[0]);
const notes = (run?.notes || []).filter((n) => !/timing_profile|resume_path_resolved/.test(n));
console.log("notes         :", notes.slice(-8).join("\n                "));
fs.rmSync(outDir, { recursive: true, force: true });
