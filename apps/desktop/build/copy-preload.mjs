// preload.cjs is plain CommonJS, so tsc does not emit it. Copy it next to the
// compiled main process, which is where main.ts now looks for it.
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "dist-electron", "electron");
mkdirSync(out, { recursive: true });
copyFileSync(path.join(here, "..", "electron", "preload.cjs"), path.join(out, "preload.cjs"));
console.log("copied preload.cjs ->", path.relative(path.join(here, ".."), path.join(out, "preload.cjs")));
