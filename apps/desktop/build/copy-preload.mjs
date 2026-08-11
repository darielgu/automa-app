// preload.cjs is plain CommonJS, so tsc does not emit it. Copy it next to the
// compiled main process, which is where main.ts now looks for it.
//
// Both candidate paths get a copy. main.ts checks dist-electron/preload.cjs
// first and dist-electron/electron/preload.cjs second, because the dev and
// bundled layouts differ. Writing only the second leaves any older copy at the
// first path in place, shadowing every later build -- which is how the bridge
// silently lost a method that the source had already added.
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "..", "electron", "preload.cjs");
const targets = [
  path.join(here, "..", "dist-electron", "preload.cjs"),
  path.join(here, "..", "dist-electron", "electron", "preload.cjs")
];

for (const target of targets) {
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log("copied preload.cjs ->", path.relative(path.join(here, ".."), target));
}
