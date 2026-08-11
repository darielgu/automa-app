import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { isCommittedSourcePromptState, verifyWorkdayWidgetValue } from "./workday/executor.js";
import { captureWorkdayReviewReceiptIfPresent, extractWorkdayReviewReceipt, extractWorkdayReviewReceiptWithDiagnostics, resolveAcceptedWorkdayDirectStep, resolveInitialWorkdayAuthStrategy, resolveWorkdayFallbackAfterEmailAuth } from "./workday.js";

test("direct step resolution accepts observed next step before probe stepReady settles", () => {
  const accepted = resolveAcceptedWorkdayDirectStep({
    expectedStep: "application_questions",
    observedStep: "application_questions",
    probe: {
      state: "application_loading",
      step: "application_questions",
      stepReady: false
    } as any
  });

  assert.equal(accepted, "application_questions");
});

test("review receipt capture persists after delayed review evidence appears", async () => {
  let onReview = false;
  const result = {
    notes: [] as string[],
    reviewReceipt: undefined as Array<{ question: string; answer: string; section?: string }> | undefined
  };

  const capturedCount = await captureWorkdayReviewReceiptIfPresent({
    page: {
      waitForTimeout: async () => undefined
    } as any,
    result,
    waitForMarkersMs: 500,
    waitForReviewEvidence: async () => {
      onReview = true;
      return "review";
    },
    detectReviewStep: async () => onReview ? "review" : "unknown",
    extractReceipt: async () => [{
      section: "Application Questions 1 of 2",
      question: "Are you lawfully permitted to work in the United States?",
      answer: "Yes"
    }]
  });

  assert.equal(capturedCount, 1);
  assert.equal(result.reviewReceipt?.[0]?.answer, "Yes");
  assert.match(result.notes.join("\n"), /workday_review_receipt_count:1/);
});

test("review receipt extraction strips edit chrome from form fields and preserves section", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div data-automation-id="reviewPage">
        <section>
          <h3>Application Questions</h3>
          <div data-automation-id="formField-workAuth">
            <label>Are you lawfully permitted to work in the United States?</label>
            <div>Yes</div>
            <button>Edit</button>
          </div>
        </section>
      </div>
    `, { waitUntil: "domcontentloaded" });

    const items = await extractWorkdayReviewReceipt(page);
    assert.deepEqual(items, [{
      section: "Application Questions",
      question: "Are you lawfully permitted to work in the United States?",
      answer: "Yes"
    }]);
  } finally {
    await browser.close();
  }
});

test("review receipt extraction supports description lists and table rows", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div data-automation-id="reviewPage">
        <section>
          <h3>Profile</h3>
          <dl>
            <dt>First name</dt>
            <dd>Dariel</dd>
          </dl>
        </section>
        <section>
          <h3>Education</h3>
          <table>
            <tr><th>Graduation Date</th><td>05/2027</td></tr>
          </table>
        </section>
      </div>
    `, { waitUntil: "domcontentloaded" });

    const items = await extractWorkdayReviewReceipt(page);
    assert.deepEqual(items, [
      {
        section: "Profile",
        question: "First name",
        answer: "Dariel"
      },
      {
        section: "Education",
        question: "Graduation Date",
        answer: "05/2027"
      }
    ]);
  } finally {
    await browser.close();
  }
});

test("review receipt extraction supports grouped wrappers and dedupes overlapping rows", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div data-automation-id="reviewPage">
        <section>
          <h3>Preferences</h3>
          <div class="summary-item" data-automation-id="summaryItem-preference">
            <strong>Preferred schedule</strong>
            <div data-automation-id="fieldValue">Full-time</div>
          </div>
          <div class="summary-item" data-automation-id="summaryItem-preference-duplicate">
            <strong>Preferred schedule</strong>
            <div data-automation-id="fieldValue">Full-time</div>
          </div>
        </section>
      </div>
    `, { waitUntil: "domcontentloaded" });

    const items = await extractWorkdayReviewReceipt(page);
    assert.deepEqual(items, [{
      section: "Preferences",
      question: "Preferred schedule",
      answer: "Full-time"
    }]);
  } finally {
    await browser.close();
  }
});

test("review receipt extraction supports plain question answer html blocks", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main>
        <section>
          <h3>Application Questions</h3>
          <div class="plain-review-row">
            <div>Are you legally eligible to work in the country to which you are applying?</div>
            <div>Yes</div>
          </div>
        </section>
      </main>
    `, { waitUntil: "domcontentloaded" });

    const items = await extractWorkdayReviewReceipt(page);
    assert.deepEqual(items, [{
      section: "Application Questions",
      question: "Are you legally eligible to work in the country to which you are applying?",
      answer: "Yes"
    }]);
  } finally {
    await browser.close();
  }
});

test("application question select verification fails when committed value stays No", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div data-automation-id="formField-auth">
        <button id="primaryQuestionnaire--auth" aria-haspopup="listbox">No 112b5250c25d1000a6ee15c67e030003</button>
      </div>
    `, { waitUntil: "domcontentloaded" });

    const widget = {
      step: "application_questions",
      widgetType: "button_select",
      label: "Are you legally eligible to work in the country to which you are applying?*",
      currentValue: "",
      options: ["Yes", "No"],
      selectorHints: {
        controlSelector: "#primaryQuestionnaire--auth",
        containerSelector: "div[data-automation-id='formField-auth']"
      }
    } as any;

    const verified = await verifyWorkdayWidgetValue(page, widget, "Yes");
    assert.equal(verified, false);
  } finally {
    await browser.close();
  }
});

test("application question select verification passes when committed selection matches expected value", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div data-automation-id="formField-sms">
        <div>
          <span data-automation-id="promptSelectionLabel">Yes</span>
          <button id="primaryQuestionnaire--sms" aria-haspopup="listbox">Yes</button>
        </div>
      </div>
    `, { waitUntil: "domcontentloaded" });

    const widget = {
      step: "application_questions",
      widgetType: "button_select",
      label: "Do you consent to receiving text messages from us as a form of communication during the recruiting process?*",
      currentValue: "",
      options: ["Yes", "No"],
      selectorHints: {
        controlSelector: "#primaryQuestionnaire--sms",
        containerSelector: "div[data-automation-id='formField-sms']"
      }
    } as any;

    const verified = await verifyWorkdayWidgetValue(page, widget, "Yes");
    assert.equal(verified, true);
  } finally {
    await browser.close();
  }
});

test("review receipt capture retries once and logs diagnostics on zero-row failure", async () => {
  let attempts = 0;
  const result = {
    notes: [] as string[],
    reviewReceipt: undefined as Array<{ question: string; answer: string; section?: string }> | undefined
  };

  const capturedCount = await captureWorkdayReviewReceiptIfPresent({
    page: {
      waitForTimeout: async () => undefined
    } as any,
    result,
    waitForMarkersMs: 500,
    waitForReviewEvidence: async () => "review",
    detectReviewStep: async () => "unknown",
    extractReceiptWithDiagnostics: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          items: [],
          diagnostics: {
            rootSelector: "div[data-automation-id='reviewPage']",
            strategyCounts: {
              formField: 0,
              descriptionList: 0,
              tableRow: 0,
              groupedField: 0,
              pairedBlock: 0
            },
            finalCount: 0
          }
        };
      }
      return {
        items: [{
          section: "Application Questions",
          question: "Are you lawfully permitted to work in the United States?",
          answer: "Yes"
        }],
        diagnostics: {
          rootSelector: "div[data-automation-id='reviewPage']",
          strategyCounts: {
            formField: 1,
            descriptionList: 0,
            tableRow: 0,
            groupedField: 0,
            pairedBlock: 0
          },
          finalCount: 1
        }
      };
    }
  });

  assert.equal(attempts, 2);
  assert.equal(capturedCount, 1);
  assert.equal(result.reviewReceipt?.[0]?.answer, "Yes");
  assert.ok(!result.notes.some((note) => note.startsWith("workday_review_receipt_diagnostics:")));
});

test("review receipt extraction diagnostics record zero-row failures", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div data-automation-id="reviewPage">
        <section>
          <h3>Review</h3>
          <p>No extracted rows here yet.</p>
        </section>
      </div>
    `, { waitUntil: "domcontentloaded" });

    const result = {
      notes: [] as string[],
      reviewReceipt: undefined as Array<{ question: string; answer: string; section?: string }> | undefined
    };

    const direct = await extractWorkdayReviewReceiptWithDiagnostics(page);
    assert.equal(direct.items.length, 0);
    assert.equal(direct.diagnostics.rootSelector, "div[data-automation-id='reviewPage']");

    const capturedCount = await captureWorkdayReviewReceiptIfPresent({
      page,
      result,
      waitForMarkersMs: 0,
      detectReviewStep: async () => "review",
      extractReceiptWithDiagnostics: async () => direct
    });

    assert.equal(capturedCount, 0);
    assert.match(result.notes.join("\n"), /workday_review_receipt_count:0/);
    assert.match(result.notes.join("\n"), /workday_review_receipt_diagnostics:review:root=div\[data-automation-id='reviewPage'\]/);
  } finally {
    await browser.close();
  }
});

test("source prompt committed state rejects label-only empty selection", () => {
  assert.equal(isCommittedSourcePromptState({
    ownText: "",
    inputValue: "",
    selectionLabel: "",
    promptInfo: "0 items selected",
    containerText: "How Did You Hear About Us?*",
    merged: "How Did You Hear About Us?*"
  }), false);
});

test("source prompt committed state accepts real selected option", () => {
  assert.equal(isCommittedSourcePromptState({
    ownText: "",
    inputValue: "",
    selectionLabel: "LinkedIn",
    promptInfo: "1 item selected",
    containerText: "How Did You Hear About Us?*",
    merged: "LinkedIn 1 item selected"
  }), true);
});

test("initial workday auth strategy bypasses long wait when fallback surface is visible", () => {
  const strategy = resolveInitialWorkdayAuthStrategy({
    probe: {
      state: "unknown",
      hasVerificationGate: false
    } as any,
    hasVisibleFallbackSurface: true
  });

  assert.equal(strategy, "fallback_now");
});

test("initial workday auth strategy uses immediate auth probe when sign-in is already classified", () => {
  const strategy = resolveInitialWorkdayAuthStrategy({
    probe: {
      state: "sign_in",
      hasVerificationGate: false
    } as any,
    hasVisibleFallbackSurface: false
  });

  assert.equal(strategy, "use_probe");
});

test("initial workday auth strategy waits only when neither auth probe nor fallback surface is visible", () => {
  const strategy = resolveInitialWorkdayAuthStrategy({
    probe: {
      state: "unknown",
      hasVerificationGate: false
    } as any,
    hasVisibleFallbackSurface: false
  });

  assert.equal(strategy, "wait");
});

test("workday fallback allows create account path after email auth surface opens", async () => {
  let createAttempted = false;

  const resolved = await resolveWorkdayFallbackAfterEmailAuth({
    page: {} as any,
    account: {
      email: "test@example.com",
      password: "secret"
    },
    triggerEmailFallback: async () => true,
    triggerCreateAccountFallback: async () => {
      createAttempted = true;
      return true;
    },
    waitForProbe: async () => ({
      state: "create_account",
      step: "create_account",
      stepReady: true,
      hasVerificationGate: false,
      hasApplicationShell: false,
      hasLoadingIndicator: false
    } as any)
  });

  assert.equal(createAttempted, true);
  assert.equal(resolved.createAccountClicked, true);
});
