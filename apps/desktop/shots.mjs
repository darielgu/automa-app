import fs from "node:fs";
const S = "/private/tmp/claude-501/-Users-darielgutierrez-Desktop/51d72f58-e333-4a89-9d3a-d8d9a92c04cc/scratchpad";
const p = process.env.HOME + "/Library/Application Support/Automa/DevToolsActivePort";
for (let i = 0; i < 90; i++) { if (fs.existsSync(p)) break; await new Promise(r => setTimeout(r, 1000)); }
const { chromium } = await import("playwright-core");
const b = await chromium.connectOverCDP(`http://127.0.0.1:${fs.readFileSync(p,"utf8").split("\n")[0].trim()}`);
const page = b.contexts()[0].pages().find(x => x.url().includes("index.html"));
await page.setViewportSize?.({ width: 1420, height: 940 }).catch(() => {});
await page.screenshot({ path: `${S}/ui-onboarding.png` });
await page.getByRole("button", { name: /demo profile/i }).click();
await page.waitForFunction(() => location.hash.includes("/jobs"), null, { timeout: 60000 });
for (let i = 0; i < 30; i++) {
  const s = await page.evaluate(() => window.automaDesktop.jobsStatus());
  if (s.counts.total > 1000) break;
  await page.waitForTimeout(3000);
}
await page.waitForTimeout(2000);
for (const [hash, name] of [["#/jobs","jobs"],["#/runs","runs"],["#/applied","applied"],["#/settings","settings"]]) {
  await page.evaluate((h) => { window.location.hash = h; }, hash);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${S}/ui-${name}.png` });
}
console.log("captured");
await b.close();
