/**
 * Bundles the main process and preload into single files.
 *
 * electron-builder's dependency collector handles npm workspace symlinks
 * inconsistently, and the main process imports three workspace packages at
 * runtime. Bundling removes that class of failure entirely: the packaged app
 * resolves nothing at runtime except Electron itself.
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(root, "..");

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: false,
  logLevel: "info",
  // Electron and node: builtins come from the runtime. playwright-core is left
  // external and shipped as-is because it inspects its own package files.
  // pdfjs is imported lazily for resume text and is large; keep it out of the
  // bundle and let it resolve from node_modules at runtime.
  external: ["electron", "playwright-core", "pdfjs-dist"]
};

await build({
  ...shared,
  entryPoints: [path.join(appDir, "electron", "main.ts")],
  outfile: path.join(appDir, "dist-electron", "main.cjs")
});

await build({
  ...shared,
  entryPoints: [path.join(appDir, "electron", "preload.cjs")],
  outfile: path.join(appDir, "dist-electron", "preload.cjs"),
  allowOverwrite: true
});

console.log("bundled main.cjs and preload.cjs");
