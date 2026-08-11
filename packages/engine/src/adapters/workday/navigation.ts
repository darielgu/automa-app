import type { Page } from "playwright-core";
import type { WorkdayStep } from "./schema.js";
import { detectWorkdayStep, STEP_VISIBLE_MARKERS } from "./schema.js";

const WORKDAY_NEXT_BUTTON_SELECTORS = [
  "button[data-automation-id='pageFooterNextButton']",
  "button[data-automation-id='bottom-navigation-next-button']"
];

async function pacedWait(page: Page, minMs = 700, maxMs = 1400): Promise<void> {
  const ms = minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs + 1));
  await page.waitForTimeout(ms);
}

export function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export async function selectorExists(page: Page, selector: string, timeout = 1000): Promise<boolean> {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "attached", timeout }).catch(() => undefined);
  return locator.count().then((n) => n > 0).catch(() => false);
}

export async function withOptSelector(
  page: Page,
  selector: string,
  callback: (locator: import("playwright-core").Locator) => Promise<void>,
  searchTimeout = 2000
): Promise<boolean> {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "attached", timeout: searchTimeout }).catch(() => undefined);
  const exists = await locator.count().then((n) => n > 0).catch(() => false);
  if (!exists) return false;
  await callback(locator).catch(() => undefined);
  return true;
}

export async function safeClick(page: Page, selector: string): Promise<boolean> {
  const locator = page.locator(selector).first();
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) return false;
  await locator.click().catch(() => undefined);
  return true;
}

export async function safeFill(page: Page, selector: string, value: string): Promise<boolean> {
  const locator = page.locator(selector).first();
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) return false;
  await locator.fill(value).catch(() => undefined);
  return true;
}

export async function openJob(page: Page, url: string, timeoutMs: number): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
  await pacedWait(page, 1200, 2200);
}

export async function startApplyFlow(page: Page, notes?: string[]): Promise<void> {
  let applyClickCount = 0;
  const clickApplyButtonOnce = async (): Promise<boolean> => {
    const candidates = [
      "a[data-automation-id='jobPostingApplyButton']",
      "button[data-automation-id='jobPostingApplyButton']",
      "button[data-automation-id='applyButton']",
      "a[data-automation-id='applyButton']",
      "button:has-text('Apply')",
      "a:has-text('Apply')",
      "button:has-text('Start Application')",
      "a[data-automation-id='applyManually']"
    ];

    for (const selector of candidates) {
      if (await safeClick(page, selector)) {
        applyClickCount += 1;
        notes?.push(`workday_apply_click_count:${applyClickCount}`);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
        await pacedWait(page, 1300, 2400);
        return true;
      }
    }
    return false;
  };

  const clicked = await clickApplyButtonOnce();
  if (!clicked) return;
  const hasManual = await selectorExists(page, "a[data-automation-id='applyManually'], button[data-automation-id='applyManually']", 10000);
  const modalOpen = hasManual || await selectorExists(page, "[role='dialog'], [aria-modal='true']", 800).catch(() => false);
  notes?.push(`workday_apply_modal_detected:${modalOpen}`);
  notes?.push(`workday_apply_manually_detected:${hasManual}`);

  if (!hasManual && !modalOpen) {
    notes?.push("workday_entry_retry_reason:modal_never_appeared");
    const retried = await clickApplyButtonOnce();
    if (!retried) return;
  }
}

export async function startApplyFlowDeterministic(page: Page, notes?: string[]): Promise<{
  ok: boolean;
  manualClicked: boolean;
  reason?: "workday_apply_manually_not_found" | "workday_apply_button_not_found";
}> {
  const initialStep = await detectWorkdayStep(page).catch(() => "unknown" as WorkdayStep);
  if (!["unknown", "start", "sign_in", "create_account"].includes(initialStep)) {
    notes?.push(`workday_entry_existing_application_step:${initialStep}`);
    return { ok: true, manualClicked: false };
  }
  if (page.url().includes("/apply/applyManually") || await selectorExists(page, "div[data-automation-id='applyFlowPage']", 1500)) {
    notes?.push("workday_entry_existing_application_flow");
    return { ok: true, manualClicked: false };
  }

  const applySurfaceSelectors = [
    "a[data-automation-id='jobPostingApplyButton']",
    "button[data-automation-id='jobPostingApplyButton']",
    "button[data-automation-id='applyButton']",
    "a[data-automation-id='applyButton']",
    "button:has-text('Apply')",
    "a:has-text('Apply')",
    "button:has-text('Start Application')",
    "div[data-automation-id='applyFlowPage']",
    "input[data-automation-id='email']",
    "button[data-automation-id='signInSubmitButton']"
  ];
  const applySurfaceDeadline = Date.now() + 10000;
  while (Date.now() < applySurfaceDeadline) {
    const step = await detectWorkdayStep(page).catch(() => "unknown" as WorkdayStep);
    if (!["unknown", "start", "sign_in", "create_account"].includes(step)) {
      notes?.push(`workday_entry_existing_application_step:${step}`);
      return { ok: true, manualClicked: false };
    }
    for (const selector of applySurfaceSelectors) {
      if (await selectorExists(page, selector, 250).catch(() => false)) {
        notes?.push(`workday_entry_surface_detected:${selector}`);
        if (selector === "div[data-automation-id='applyFlowPage']" || selector === "input[data-automation-id='email']" || selector === "button[data-automation-id='signInSubmitButton']") {
          return { ok: true, manualClicked: false };
        }
        await pacedWait(page, 250, 600);
        break;
      }
    }
    await page.waitForTimeout(300);
  }

  let applyClickCount = 0;
  const clickApply = async (): Promise<boolean> => {
    const candidates = [
      "a[data-automation-id='jobPostingApplyButton']",
      "button[data-automation-id='jobPostingApplyButton']",
      "button[data-automation-id='applyButton']",
      "a[data-automation-id='applyButton']",
      "button:has-text('Apply')",
      "a:has-text('Apply')",
      "button:has-text('Start Application')"
    ];
    for (const selector of candidates) {
      if (await safeClick(page, selector)) {
        applyClickCount += 1;
        notes?.push(`workday_apply_click_count:${applyClickCount}`);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
        await pacedWait(page, 1000, 1800);
        return true;
      }
    }
    return false;
  };

  const clickedFirst = await clickApply();
  if (!clickedFirst) {
    notes?.push("workday_entry_retry_reason:apply_button_not_found");
    return { ok: false, manualClicked: false, reason: "workday_apply_button_not_found" };
  }

  const manualSelector = "a[data-automation-id='applyManually'], button[data-automation-id='applyManually'], a:has-text('Apply Manually'), button:has-text('Apply Manually')";
  let manualVisible = await selectorExists(page, manualSelector, 10000);
  let modalOpen = manualVisible || await selectorExists(page, "[role='dialog'], [aria-modal='true']", 900).catch(() => false);
  notes?.push(`workday_apply_modal_detected:${modalOpen}`);
  notes?.push(`workday_apply_manually_detected:${manualVisible}`);

  if (!manualVisible && !modalOpen) {
    notes?.push("workday_entry_retry_reason:modal_never_appeared");
    const clickedRetry = await clickApply();
    if (!clickedRetry) return { ok: false, manualClicked: false, reason: "workday_apply_button_not_found" };
    manualVisible = await selectorExists(page, manualSelector, 10000);
    modalOpen = manualVisible || await selectorExists(page, "[role='dialog'], [aria-modal='true']", 900).catch(() => false);
    notes?.push(`workday_apply_modal_detected:${modalOpen}`);
    notes?.push(`workday_apply_manually_detected:${manualVisible}`);
  }

  if (modalOpen && !manualVisible) {
    notes?.push("workday_entry_retry_reason:modal_open_manual_not_found");
    return { ok: false, manualClicked: false, reason: "workday_apply_manually_not_found" };
  }

  if (!manualVisible) return { ok: true, manualClicked: false };
  const clickedManual = await safeClick(page, "a[data-automation-id='applyManually']") ||
    await safeClick(page, "button[data-automation-id='applyManually']") ||
    await safeClick(page, "a:has-text('Apply Manually')") ||
    await safeClick(page, "button:has-text('Apply Manually')");
  notes?.push(`workday_apply_manually_clicked:${clickedManual}`);
  if (!clickedManual) return { ok: false, manualClicked: false, reason: "workday_apply_manually_not_found" };
  await page.waitForLoadState("networkidle", { timeout: 7000 }).catch(() => undefined);
  await selectorExists(page, "input[data-automation-id='email'], div[data-automation-id='applyFlowPage'], button[data-automation-id='signInSubmitButton']", 7000).catch(() => undefined);
  await pacedWait(page, 1500, 2600);
  return { ok: true, manualClicked: true };
}

export async function chooseApplyManually(page: Page, notes?: string[]): Promise<void> {
  const manualSelector = "a[data-automation-id='applyManually'], button[data-automation-id='applyManually'], a:has-text('Apply Manually'), button:has-text('Apply Manually')";
  const manualVisible = await selectorExists(page, manualSelector, 10000);
  notes?.push(`workday_apply_manually_detected:${manualVisible}`);
  if (!manualVisible) {
    const modalOpen = await selectorExists(page, "[role='dialog'], [aria-modal='true']", 1000).catch(() => false);
    if (modalOpen) notes?.push("workday_entry_retry_reason:modal_open_manual_not_found");
    return;
  }
  const clicked = await safeClick(page, "a[data-automation-id='applyManually']") ||
    await safeClick(page, "button[data-automation-id='applyManually']") ||
    await safeClick(page, "a:has-text('Apply Manually')") ||
    await safeClick(page, "button:has-text('Apply Manually')");
  notes?.push(`workday_apply_manually_clicked:${clicked}`);
  if (clicked) {
    await page.waitForLoadState("networkidle", { timeout: 7000 }).catch(() => undefined);
    await selectorExists(page, "input[data-automation-id='email'], div[data-automation-id='applyFlowPage'], button[data-automation-id='signInSubmitButton']", 7000).catch(() => undefined);
    await pacedWait(page, 2000, 3400);
  }
}

export async function waitForPageStep(page: Page, previous: WorkdayStep, timeoutMs = 7000): Promise<WorkdayStep> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const next = await detectWorkdayStep(page);
    if (next !== previous && next !== "unknown") return next;
    await page.waitForTimeout(350);
  }
  return detectWorkdayStep(page);
}

export async function clickNext(page: Page): Promise<boolean> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(120);
  for (const selector of WORKDAY_NEXT_BUTTON_SELECTORS) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    const clicked = await locator.click().then(() => true).catch(() => false);
    if (clicked) return true;
  }
  return false;
}

export type WorkdayFooterButtonKind = "continue" | "submit" | "none";

export interface WorkdayFooterButtonInfo {
  kind: WorkdayFooterButtonKind;
  text: string;
}

const NEXT_STEP_MARKERS: Partial<Record<WorkdayStep, string[]>> = {
  contact_information: STEP_VISIBLE_MARKERS.my_experience,
  my_experience: STEP_VISIBLE_MARKERS.application_questions,
  application_questions: STEP_VISIBLE_MARKERS.voluntary_disclosures,
  voluntary_disclosures: STEP_VISIBLE_MARKERS.self_identification,
  self_identification: [
    ...(STEP_VISIBLE_MARKERS.take_assessment ?? []),
    ...(STEP_VISIBLE_MARKERS.review ?? []),
    "button[data-automation-id='pageFooterNextButton']:has-text('Submit')",
    ...(STEP_VISIBLE_MARKERS.submit ?? [])
  ]
};

export function nextStepMarkersFor(currentStep: WorkdayStep): string[] {
  return NEXT_STEP_MARKERS[currentStep] ?? [];
}

export async function classifyFooterButton(page: Page): Promise<WorkdayFooterButtonInfo> {
  for (const selector of [...WORKDAY_NEXT_BUTTON_SELECTORS, "[data-automation-id='click_filter'][aria-label]"]) {
    const footerButton = page.locator(selector).first();
    const visible = await footerButton.isVisible().catch(() => false);
    if (!visible) continue;
    const text = normalizeText(
      (await footerButton.innerText().catch(() => "")) ||
      (await footerButton.getAttribute("aria-label").catch(() => "")) ||
      ""
    );
    if (!text) continue;
    if (/\bsubmit\b/.test(text)) return { kind: "submit", text };
    if (/(save and continue|continue|next)/.test(text)) return { kind: "continue", text };
  }
  return { kind: "none", text: "" };
}

export async function clickFooterNext(page: Page): Promise<boolean> {
  return clickNext(page) ||
    safeClick(page, "button[data-automation-id='pageFooterNextButton']") ||
    safeClick(page, "button[data-automation-id='bottom-navigation-next-button']") ||
    safeClick(page, "[data-automation-id='click_filter'][aria-label='Save and Continue']") ||
    safeClick(page, "[data-automation-id='click_filter'][aria-label='Continue']") ||
    safeClick(page, "[data-automation-id='click_filter'][aria-label='Next']");
}

export async function waitForExpectedTransitionMarker(
  page: Page,
  currentStep: WorkdayStep,
  timeoutMs = 5000
): Promise<boolean> {
  const markers = nextStepMarkersFor(currentStep);
  if (!markers.length) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of markers) {
      if (await selectorExists(page, selector, 450)) return true;
    }
    await page.waitForTimeout(250);
  }
  return false;
}

export async function clickSubmit(page: Page): Promise<boolean> {
  const submitCandidates = [
    "button[data-automation-id*='submit']",
    "button:has-text('Submit')",
    "button:has-text('Review and Submit')"
  ];
  for (const selector of submitCandidates) {
    if (await safeClick(page, selector)) return true;
  }
  return false;
}

export async function extractOptionsFromOpenDropdown(page: Page): Promise<string[]> {
  const options = await page
    .locator("[role='option'], [data-automation-id='promptOption']")
    .allInnerTexts()
    .catch(() => [] as string[]);
  return Array.from(new Set(options.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean)));
}
