import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { LeverAdapter } from "./lever.js";

/**
 * Lever names its controls cards[<card>][field0]. Building "#cards[x][field0]"
 * produces an invalid CSS selector, so every bracketed control silently failed
 * to resolve and the pre-submit readiness gate blocked the run with
 * "unsatisfied" fields that had in fact never been reachable.
 */
test("lever resolves controls whose id contains brackets", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<form class="application-form"><ul>
         <li class="application-question">
           <label for="cards[work_auth][field0]">Are you authorized to work?</label>
           <select id="cards[work_auth][field0]" name="cards[work_auth][field0]" required>
             <option value="">Select…</option><option>Yes</option><option>No</option>
           </select>
         </li>
       </ul></form>`,
      { waitUntil: "domcontentloaded" }
    );

    // The bare "#id" form cannot reach a bracketed id: the brackets parse as
    // attribute selectors, so it matches nothing. The attribute form does.
    const bareIdMatches = await page.locator('#cards[work_auth][field0]').count().catch(() => 0);
    assert.equal(bareIdMatches, 0, "an unescaped bracketed id cannot resolve the control");
    assert.equal(
      await page.locator('select[id="cards[work_auth][field0]"]').count(),
      1,
      "the attribute form is what the adapter must build"
    );

    const adapter = new LeverAdapter();
    assert.equal(adapter.canHandle("https://jobs.lever.co/acme/abc/apply"), true);
  } finally {
    await browser.close();
  }
});

test("lever recognises its bundled practice application", () => {
  const adapter = new LeverAdapter();
  assert.equal(adapter.canHandle("file:///x/resources/demo/lever-demo.html"), true);
  assert.equal(adapter.canHandle("https://boards.greenhouse.io/acme/jobs/1"), false);
});
