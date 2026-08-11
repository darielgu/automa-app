/**
 * Re-sign the packaged app ad-hoc.
 *
 * With `identity: null` electron-builder skips codesign entirely. But by then
 * it has already renamed the binary, injected app.asar and replaced the icon,
 * which invalidates the ad-hoc signature Electron itself shipped with. macOS on
 * Apple Silicon refuses to execute a binary whose signature does not match, so
 * without this step the app dies immediately with "Automa is damaged".
 *
 * This is not real code signing and does not avoid the Gatekeeper prompt. It
 * only makes the binary loadable.
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath], {
    stdio: "inherit"
  });
  execFileSync("codesign", ["--verify", "--deep", "--verbose=2", appPath], { stdio: "inherit" });
  console.log(`ad-hoc signed ${path.basename(appPath)} (${context.arch === 1 ? "x64" : "arm64"})`);
};
