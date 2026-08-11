/**
 * Prepares a clean install for the adapter harness.
 *
 * Onboarding needs a résumé file, and a file picker cannot be driven over CDP,
 * so the harness writes the app's state directly before launch. This is a test
 * fixture path only — the app itself has no way to do this.
 *
 *   node tooling/scripts/seed-practice-profile.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const userData = path.join(process.env.HOME ?? "", "Library/Application Support/Automa");
fs.mkdirSync(path.join(userData, "resumes"), { recursive: true });

const resumePath = path.join(userData, "resumes", "practice-resume.pdf");
// A minimal but structurally valid PDF. The adapters only need a file to
// upload; text extraction is exercised by the unit tests.
fs.writeFileSync(
  resumePath,
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
    "trailer<</Root 1 0 R>>\n%%EOF\n"
);

const profile = JSON.parse(
  fs.readFileSync(path.join(root, "packages/engine/examples/profile.example.json"), "utf8")
);
// The example profile carries files.resumePath: "./examples/resume.txt", a
// relative path that does not resolve from the app's working directory. Left
// in, it beats the real resume record and every upload fails verification --
// so the harness would be exercising a configuration no user ever has.
profile.files = { ...(profile.files ?? {}), resumePath };

profile.preferences ??= {
  desiredRoles: ["Software Engineer"],
  desiredLocations: ["Remote"],
  employmentTypes: ["full-time"],
  remoteOnly: false
};

const statePath = path.join(userData, "automa-state.json");
const existing = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};

fs.writeFileSync(
  statePath,
  JSON.stringify(
    {
      ...existing,
      onboarding: profile,
      resume: {
        fileName: "practice-resume.pdf",
        filePath: resumePath,
        mimeType: "application/pdf",
        selectedAt: new Date().toISOString(),
        extractedText: "Alex Rivera. Software engineer. TypeScript, React, Node."
      },
      // Practice runs must never submit, even against a local file.
      config: { ...(existing.config ?? {}), mode: "dry-run" },
      runs: []
    },
    null,
    2
  )
);

console.log("seeded practice profile and resume at", statePath);
