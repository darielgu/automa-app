/**
 * Copies the shared normalizer into the Edge Function's _shared directory.
 *
 * The Edge Function runs under Deno, which cannot resolve this repo's NodeNext
 * ".js" import specifiers back to ".ts" sources. Keeping job-feed-core as a
 * single file with no relative imports means it can be copied verbatim, and
 * this check proves the two copies never drift: if they did, the cloud mirror
 * and the on-device fallback would start producing different rows.
 *
 *   node tooling/scripts/sync-edge-shared.mjs           # copy
 *   node tooling/scripts/sync-edge-shared.mjs --check   # fail if out of date
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = path.join(root, "packages", "job-feed-core", "src", "index.ts");
const target = path.join(root, "supabase", "functions", "_shared", "job-feed-core.ts");

const banner = `// GENERATED FILE — DO NOT EDIT.
// Copied verbatim from packages/job-feed-core/src/index.ts by
// tooling/scripts/sync-edge-shared.mjs. Edit the source, then re-run that script.
`;

const expected = banner + readFileSync(source, "utf8");

if (process.argv.includes("--check")) {
  let actual = "";
  try {
    actual = readFileSync(target, "utf8");
  } catch {
    console.error("Edge Function copy of job-feed-core is missing.");
    process.exit(1);
  }
  if (actual !== expected) {
    console.error(
      "Edge Function copy of job-feed-core is out of date.\n" +
        "Run: node tooling/scripts/sync-edge-shared.mjs"
    );
    process.exit(1);
  }
  console.log("job-feed-core copies are identical.");
} else {
  writeFileSync(target, expected);
  console.log("synced supabase/functions/_shared/job-feed-core.ts");
}
