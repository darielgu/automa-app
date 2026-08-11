import type { Page } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import type { AppLogger } from "../../core/logger.js";
import type {
  CandidateProfile,
  QuestionnaireResolutionRecord,
  ResolvedAnswer,
  UnresolvedQuestionnaireRecord
} from "../../core/types.js";
import type { WorkdayJobContext } from "./resolver.js";
import {
  mergeLockedFirst,
  mergeLockedWidgetAnswers,
  planWorkdayUnresolvedFields,
  planWorkdayUnresolvedWidgets,
  resolveQuestionnaireField,
  resolveWorkdayDeterministic,
  resolveWorkdayWidgetAlias,
  resolveWorkdayWidgetDeterministic,
  toQuestionnaireResolutionRecord,
  validateResolvedWorkdayWidgetAnswer,
  type WorkdayQuestionnaireField
} from "./resolver.js";
import type { WorkdayFieldSchema, WorkdayStep, WorkdayWidgetSchema } from "./schema.js";
import { detectWorkdayStep, extractWorkdayStepSchema, extractWorkdayStepWidgets, resolveActiveWorkdayContainerSelector, type WorkdayStep as StepType } from "./schema.js";
import { classifyFooterButton, clickFooterNext, clickNext, nextStepMarkersFor, safeClick, safeFill, waitForExpectedTransitionMarker, waitForPageStep } from "./navigation.js";
import { executeWorkdayFillPlan, executeWorkdayWidgetPlan, extractVisibleOptions, fillPriorCompanyQuestion, fillSelfIdentificationDateField, fillSourceQuestion, findFieldNearLabel, fillWorkdayDropdown, fillWorkdayDropdownAndCommit, fillWorkdayPhoneCodeRadioPicker, fillWorkdaySourcePrompt } from "./executor.js";

export interface RecoveryResult {
  advanced: boolean;
  validationErrors: string[];
  recoveryAttempts: number;
  unchangedSignature: boolean;
  currentStep: WorkdayStep;
  transitionFailureClass?:
    | "missing_required_field"
    | "click_noop"
    | "transition_marker_mismatch"
    | "network_rejected"
    | "unknown_no_transition"
    | "continue_button_not_found"
    | "continue_button_disabled"
    | "continue_click_no_transition"
    | "continue_click_failed"
    | "continue_click_no_request"
    | "continue_request_no_transition"
    | "continue_request_network_error"
    | "continue_click_no_request_sms_retry_no_transition"
    | "continue_click_no_request_sms_retry_network_error"
    | "self_identification_continue_no_request"
    | "self_identification_request_no_transition"
    | "self_identification_request_error";
  unresolvedQuestionnaire?: UnresolvedQuestionnaireRecord[];
}

export function shouldSkipWorkdayValidationRepass(step: WorkdayStep): boolean {
  return step === "application_questions";
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeRetryLabel(value: string): string {
  return normalizeText(value)
    .replace(/^error\s+-\s+/, "")
    .replace(/[*:]/g, " ")
    .replace(/[()[\]{}]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isOptionBackedRetryWidget(widget: WorkdayWidgetSchema): boolean {
  return widget.widgetType === "button_select" ||
    widget.widgetType === "prompt_input_select" ||
    widget.widgetType === "radio_group" ||
    widget.widgetType === "checkbox_group";
}

function isSourceContactErrorLabel(label: string): boolean {
  return /how did you hear about us|application source|\bsource\b/.test(normalizeText(label));
}

function isPriorCompanyContactErrorLabel(label: string): boolean {
  return /currently or have you ever worked|have you ever worked for|have you previously worked at|previously worked (?:at|for)|former employee|current employee|employee or contractor|previous worker|candidateispreviousworker|current or former employee/.test(normalizeText(label));
}

function deriveCompanyNameFromErrorLabel(label: string): string | null {
  const match = label.match(/worked at\s+([^?*]+)/i) || label.match(/worked for\s+([^?*]+)/i);
  return match?.[1]?.trim() || null;
}

function escapeSelectorId(value: string): string {
  return value.replace(/([.#:[\],= ])/g, "\\$1");
}

function normalizeMonthSectionValue(value: string): string {
  const text = normalizeText(value);
  if (!text) return "";
  if (/^\d{1,2}$/.test(text)) return text.padStart(2, "0");
  const months = new Map<string, string>([
    ["january", "01"],
    ["jan", "01"],
    ["february", "02"],
    ["feb", "02"],
    ["march", "03"],
    ["mar", "03"],
    ["april", "04"],
    ["apr", "04"],
    ["may", "05"],
    ["june", "06"],
    ["jun", "06"],
    ["july", "07"],
    ["jul", "07"],
    ["august", "08"],
    ["aug", "08"],
    ["september", "09"],
    ["sep", "09"],
    ["sept", "09"],
    ["october", "10"],
    ["oct", "10"],
    ["november", "11"],
    ["nov", "11"],
    ["december", "12"],
    ["dec", "12"]
  ]);
  return months.get(text) || "";
}

function sameExperienceRow(
  lhs: { jobTitle: string; company: string },
  rhs: { jobTitle: string; company: string }
): boolean {
  const leftTitle = normalizeText(lhs.jobTitle);
  const rightTitle = normalizeText(rhs.jobTitle);
  const leftCompany = normalizeText(lhs.company);
  const rightCompany = normalizeText(rhs.company);
  if (!leftTitle || !rightTitle || !leftCompany || !rightCompany) return false;
  return leftTitle === rightTitle && leftCompany === rightCompany;
}

async function fillDateSectionInputs(
  page: Page,
  monthSelector: string,
  yearSelector: string,
  monthValue?: string,
  yearValue?: string
): Promise<boolean> {
  const month = normalizeMonthSectionValue(monthValue || "");
  const year = normalizeText(yearValue || "");
  if (!month && !year) return false;

  const monthInput = page.locator(monthSelector).first();
  const yearInput = page.locator(yearSelector).first();
  if (month) {
    const visible = await monthInput.isVisible().catch(() => false);
    if (!visible) return false;
    await monthInput.click().catch(() => undefined);
    await monthInput.fill(month).catch(() => undefined);
    await monthInput.press("Tab").catch(() => undefined);
  }
  if (year) {
    const visible = await yearInput.isVisible().catch(() => false);
    if (!visible) return false;
    await yearInput.click().catch(() => undefined);
    await yearInput.fill(year).catch(() => undefined);
    await yearInput.press("Tab").catch(() => undefined);
  }
  return true;
}

async function collectValidationErrors(page: Page): Promise<string[]> {
  const messages = await page
    .locator("[data-automation-id*='error'], [role='alert'], [aria-invalid='true'], .error")
    .allInnerTexts()
    .catch(() => [] as string[]);
  return [...new Set(messages.map((m) => normalizeText(m)).filter(Boolean))].slice(0, 10);
}

export async function hydrateRetryWidgetsWithLiveOptions(
  page: Page,
  widgets: WorkdayWidgetSchema[],
  notes?: string[]
): Promise<WorkdayWidgetSchema[]> {
  const hydrated: WorkdayWidgetSchema[] = [];
  for (const widget of widgets) {
    if (!isOptionBackedRetryWidget(widget)) {
      hydrated.push(widget);
      continue;
    }
    const selector = widget.selectorHints.controlSelector || "";
    const liveOptions = (widget.widgetType === "button_select" || widget.widgetType === "prompt_input_select") && selector
      ? await extractOptionsForField(page, selector).catch(() => [] as string[])
      : widget.options;
    if (liveOptions.length) {
      notes?.push(`workday_recovery_live_options:${normalizeText(widget.label)}:${liveOptions.map((option) => normalizeText(option)).join(" | ")}`);
      hydrated.push({
        ...widget,
        options: liveOptions
      });
      continue;
    }
    hydrated.push(widget);
  }
  return hydrated;
}

interface TransitionSnapshot {
  step: WorkdayStep;
  url: string;
  footerText: string;
  requiredVisibleCount: number;
  invalidVisibleCount: number;
  inputAlertCount: number;
  selectOneButtons: string[];
  uncheckedRequiredChoiceCount: number;
  heading: string;
  footerDisabled: boolean;
}

function transitionSnapshotChangedMeaningfully(before: TransitionSnapshot, after: TransitionSnapshot): boolean {
  if (before.url !== after.url) return true;
  if (normalizeText(before.heading) !== normalizeText(after.heading)) return true;
  if (before.requiredVisibleCount !== after.requiredVisibleCount) return true;
  if (before.uncheckedRequiredChoiceCount !== after.uncheckedRequiredChoiceCount) return true;
  if (before.footerText !== after.footerText) return true;
  const beforeSelect = before.selectOneButtons.map((value) => normalizeText(value)).join("|");
  const afterSelect = after.selectOneButtons.map((value) => normalizeText(value)).join("|");
  if (beforeSelect !== afterSelect) return true;
  return false;
}

function logRecoveryEvent(logger: AppLogger | undefined, event: string, data: Record<string, unknown>): void {
  logger?.info(event, data);
}

async function collectTransitionSnapshot(page: Page, step: WorkdayStep): Promise<TransitionSnapshot> {
  const url = page.url();
  const footerText = await page.locator("button[data-automation-id='pageFooterNextButton'], button[data-automation-id='bottom-navigation-next-button']").first().innerText().catch(() => "");
  const requiredVisibleCount = await page
    .locator("[required], [aria-required='true'], .requiredAsterisk")
    .evaluateAll((nodes) => nodes.filter((n) => {
      const el = n as HTMLElement;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).length)
    .catch(() => 0);
  const invalidVisibleCount = await page.locator("[aria-invalid='true']").count().catch(() => 0);
  const inputAlertCount = await page.locator("p[data-automation-id='inputAlert']").count().catch(() => 0);
  const selectOneButtons = await page
    .locator("button[aria-haspopup='listbox']")
    .allInnerTexts()
    .catch(() => [] as string[]);
  const uncheckedRequiredChoiceCount = await page
    .locator("fieldset")
    .evaluateAll((fieldsets) => {
      let count = 0;
      for (const node of fieldsets) {
        const fs = node as HTMLElement;
        const required = fs.querySelector(".requiredAsterisk, [aria-required='true'], [required]");
        if (!required) continue;
        const checked = fs.querySelector("input[type='checkbox']:checked, input[type='radio']:checked");
        if (!checked) count += 1;
      }
      return count;
    })
    .catch(() => 0);
  const heading = await page.locator("h1, h2, h3").first().innerText().catch(() => "");
  const footerDisabled = await page.locator("button[data-automation-id='pageFooterNextButton'], button[data-automation-id='bottom-navigation-next-button']").first().evaluate((el) => {
    const btn = el as HTMLButtonElement;
    const cs = window.getComputedStyle(btn);
    const ariaDisabled = btn.getAttribute("aria-disabled") === "true";
    return Boolean(btn.disabled || ariaDisabled || cs.pointerEvents === "none");
  }).catch(() => false);
  return {
    step,
    url,
    footerText: normalizeText(footerText),
    requiredVisibleCount,
    invalidVisibleCount,
    inputAlertCount,
    selectOneButtons: selectOneButtons.map((v) => normalizeText(v)).filter(Boolean),
    uncheckedRequiredChoiceCount,
    heading: normalizeText(heading),
    footerDisabled
  };
}

function classifyFailure(
  before: TransitionSnapshot,
  after: TransitionSnapshot,
  errors: string[],
  unresolvedRequiredCount = 0
): RecoveryResult["transitionFailureClass"] {
  if (/net::|failed|abort|timed out|network/i.test(errors.join(" | "))) return "network_rejected";
  if (unresolvedRequiredCount > 0) return "missing_required_field";
  if (errors.length > 0 || after.invalidVisibleCount > before.invalidVisibleCount || after.inputAlertCount > before.inputAlertCount) {
    return "missing_required_field";
  }
  if (before.url === after.url && before.footerText === after.footerText) return "click_noop";
  if (after.step === before.step && before.url === after.url) return "transition_marker_mismatch";
  return "unknown_no_transition";
}

async function appendNoAdvanceDiagnostics(page: Page, notes: string[] | undefined, before: TransitionSnapshot, after: TransitionSnapshot): Promise<void> {
  if (!notes) return;
  const errors = await collectValidationErrors(page);
  const diagStep = (await detectWorkdayStep(page).catch(() => "unknown")) as StepType;
  const activeSelector = await resolveActiveWorkdayContainerSelector(page, diagStep);
  const selectOne = await page.locator(activeSelector).locator("button[aria-haspopup='listbox']").allInnerTexts().catch(() => [] as string[]);
  const invalidLabels = await page
    .locator("[aria-invalid='true']")
    .evaluateAll((nodes) => nodes.map((n) => {
      const el = n as HTMLElement;
      const fieldset = el.closest("fieldset");
      const label = fieldset?.querySelector("legend")?.textContent || el.getAttribute("aria-label") || "";
      return label.replace(/\s+/g, " ").trim().toLowerCase();
    }).filter(Boolean))
    .catch(() => [] as string[]);
  const activeElement = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "";
    return `${el.tagName.toLowerCase()}:${(el.getAttribute("id") || el.getAttribute("name") || el.getAttribute("data-automation-id") || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim()}`;
  }).catch(() => "");
  const committedRequired = await page.evaluate((containerSelector) => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const root = document.querySelector(containerSelector) || document.body;
    const containers = Array.from(root.querySelectorAll<HTMLElement>("fieldset, [data-automation-id^='formField-'], [role='group']"));
    return containers.slice(0, 40).map((container) => {
      if (!visible(container)) return "";
      const label = normalize(
        container.querySelector("legend, label, [data-automation-id='formLabel'], [data-automation-id*='richText']")?.textContent || ""
      );
      const required = Boolean(container.querySelector(".requiredAsterisk, [aria-required='true'], [required]"));
      if (!required) return "";
      const invalid = container.getAttribute("aria-invalid") === "true" || Boolean(container.querySelector("[aria-invalid='true']"));
      const checked = Array.from(container.querySelectorAll<HTMLInputElement>("input[type='checkbox'], input[type='radio']"))
        .filter((input) => input.checked)
        .map((input) => normalize(input.value || input.getAttribute("aria-label") || input.parentElement?.textContent || ""));
      const textInput = Array.from(container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input:not([type='hidden']):not([type='checkbox']):not([type='radio']), textarea"))
        .map((input) => normalize(input.value || ""))
        .filter(Boolean);
      const buttonValue = Array.from(container.querySelectorAll<HTMLElement>("button[aria-haspopup='listbox'], [role='combobox']"))
        .map((node) => normalize(node.textContent || ""))
        .filter(Boolean);
      const value = checked.join(" | ") || textInput.join(" | ") || buttonValue.join(" | ");
      return `${label}:invalid=${invalid}:value=${value || "empty"}`;
    }).filter(Boolean);
  }, activeSelector).catch(() => [] as string[]);
  const diagnosticsDir = path.resolve(process.cwd(), "output", "screenshots");
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  const diagPath = path.join(diagnosticsDir, `workday-transition-diag-${Date.now()}.png`);
  await page.screenshot({ path: diagPath, fullPage: true }).catch(() => undefined);

  notes.push(`workday_transition_before:step=${before.step}:url=${before.url}:footer=${before.footerText}:alerts=${before.inputAlertCount}`);
  notes.push(`workday_transition_after:step=${after.step}:url=${after.url}:footer=${after.footerText}:alerts=${after.inputAlertCount}`);
  notes.push(`workday_footer_disabled_state:before=${before.footerDisabled}:after=${after.footerDisabled}`);
  if (errors.length) notes.push(`workday_transition_errors:${errors.slice(0, 8).join(" | ")}`);
  if (selectOne.length) notes.push(`workday_transition_select_one:${selectOne.map((v) => normalizeText(v)).filter(Boolean).join(" | ")}`);
  if (invalidLabels.length) notes.push(`workday_transition_invalid_labels:${invalidLabels.slice(0, 8).join(" | ")}`);
  if (activeElement) notes.push(`workday_transition_active_element:${normalizeText(activeElement)}`);
  if (committedRequired.length) notes.push(`workday_transition_required_values:${committedRequired.slice(0, 12).join(" || ")}`);
  notes.push(`workday_transition_heading:${after.heading}`);
  notes.push(`workday_transition_diag_screenshot:${diagPath}`);
}

interface FooterCandidate {
  text: string;
  automationId: string;
  ariaDisabled: string;
  disabled: boolean;
  visible: boolean;
  enabled: boolean;
  bbox: string;
  parentText: string;
  selector: string;
}

interface ContinueNetworkEvent {
  url: string;
  method: string;
  status?: number;
  responseSnippet?: string;
}

interface ContactContinueAttemptResult {
  clicked: boolean;
  requestFired: boolean;
  requestUrl?: string;
  requestStatus?: number;
  requestErrorSnippet?: string;
  networkError: boolean;
  advanced: boolean;
  currentStep: WorkdayStep;
  visibleValidation: boolean;
  smsRetryAttempted: boolean;
}

interface SelfIdentificationContinueAttemptResult {
  clicked: boolean;
  requestFired: boolean;
  requestUrl?: string;
  requestStatus?: number;
  requestErrorSnippet?: string;
  networkError: boolean;
  advanced: boolean;
  currentStep: WorkdayStep;
  visibleValidation: boolean;
  footerTextAfter: string;
}

async function collectFooterCandidates(page: Page): Promise<FooterCandidate[]> {
  return page.evaluate(() => {
    const norm = (v: string) => v.replace(/\s+/g, " ").trim().toLowerCase();
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(
      "button[data-automation-id='pageFooterNextButton'], button[data-automation-id='bottom-navigation-next-button'], button"
    )).filter((n) => /save and continue|continue|next/i.test(n.textContent || "") || /^(pageFooterNextButton|bottom-navigation-next-button)$/.test(n.getAttribute("data-automation-id") || ""));
    return nodes.map((n) => {
      const rect = n.getBoundingClientRect();
      const cs = window.getComputedStyle(n);
      const id = n.getAttribute("id") || "";
      const aid = n.getAttribute("data-automation-id") || "";
      const text = norm(n.textContent || "");
      return {
        text,
        automationId: aid,
        ariaDisabled: n.getAttribute("aria-disabled") || "",
        disabled: (n as HTMLButtonElement).disabled === true,
        visible: rect.width > 0 && rect.height > 0 && cs.visibility !== "hidden" && cs.display !== "none",
        enabled: !((n as HTMLButtonElement).disabled || n.getAttribute("aria-disabled") === "true" || cs.pointerEvents === "none"),
        bbox: `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`,
        parentText: norm((n.parentElement?.textContent || "").slice(0, 160)),
        selector: id
          ? `button#${id.replace(/([.#:[\],= ])/g, "\\$1")}`
          : aid
            ? `button[data-automation-id="${aid.replace(/"/g, '\\"')}"]`
            : `button:has-text("${(text || "next").replace(/"/g, '\\"')}")`
      };
    });
  });
}

async function attemptFooterClick(page: Page, selector: string, method: "normal" | "force" | "js" | "enter" | "space"): Promise<{ ok: boolean; error?: string }> {
  const loc = page.locator(selector).first();
  try {
    await loc.scrollIntoViewIfNeeded().catch(() => undefined);
    await page.waitForTimeout(500);
    if (method === "normal") {
      await loc.click({ timeout: 3000 });
    } else if (method === "force") {
      await loc.click({ force: true, timeout: 3000 });
    } else if (method === "js") {
      await loc.evaluate((el) => (el as HTMLElement).click());
    } else if (method === "enter") {
      await loc.focus().catch(() => undefined);
      await page.keyboard.press("Enter");
    } else {
      await loc.focus().catch(() => undefined);
      await page.keyboard.press("Space");
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isWorkdayContinueNetworkRequest(url: string): boolean {
  return /workday/i.test(url) && /(save|next|validate|validation|apply|candidate|jobapp|submit)/i.test(url);
}

async function commitAndBlurContactFields(page: Page, step: WorkdayStep): Promise<void> {
  const activeSelector = await resolveActiveWorkdayContainerSelector(page, step);
  await page.evaluate((containerSelector) => {
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const root = document.querySelector(containerSelector) || document.body;
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.dispatchEvent(new Event("change", { bubbles: true }));
      active.blur();
    }
    const controls = Array.from(root.querySelectorAll<HTMLElement>("input, textarea, select, button[aria-haspopup='listbox'], [role='combobox']"))
      .filter((node) => visible(node));
    for (const control of controls) {
      if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) {
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
      }
      control.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    }
  }, activeSelector).catch(() => undefined);
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(150).catch(() => undefined);
}

async function detectSmsConsentCheckbox(page: Page, step: WorkdayStep): Promise<{ selector: string; visible: boolean; checked: boolean }> {
  const activeSelector = await resolveActiveWorkdayContainerSelector(page, step);
  const result = await page.evaluate((containerSelector) => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const root = document.querySelector(containerSelector) || document.body;
    const containers = Array.from(root.querySelectorAll<HTMLElement>("fieldset, [data-automation-id^='formField-'], [role='group'], div"));
    for (const container of containers) {
      if (!visible(container)) continue;
      const text = normalize(container.textContent || "");
      if (!/text messages|sms|mms/.test(text) || !/consent|receive/.test(text)) continue;
      const input = container.querySelector<HTMLInputElement>("input[type='checkbox']");
      if (!input || !visible(input)) continue;
      const id = String(input.getAttribute("id") || "").trim();
      const name = String(input.getAttribute("name") || "").trim();
      const selector = id
        ? `input#${id.replace(/([.#:[\\],= ])/g, "\\$1")}`
        : name
          ? `input[name="${name.replace(/"/g, '\\"')}"]`
          : "";
      if (!selector) continue;
      return { selector, visible: true, checked: Boolean(input.checked) };
    }
    return { selector: "", visible: false, checked: false };
  }, activeSelector).catch(() => ({ selector: "", visible: false, checked: false }));
  return result;
}

async function setSmsConsentCheckbox(page: Page, selector: string): Promise<boolean> {
  const input = page.locator(selector).first();
  if (!await input.isVisible().catch(() => false)) return false;
  const checked = await input.isChecked().catch(() => false);
  if (checked) return true;
  return input.check({ force: true }).then(() => true).catch(async () => {
    return input.click({ force: true }).then(() => true).catch(() => false);
  });
}

async function clickFooterWithRealMouse(page: Page, selector: string): Promise<{ ok: boolean; error?: string }> {
  const loc = page.locator(selector).first();
  try {
    await loc.scrollIntoViewIfNeeded().catch(() => undefined);
    await page.waitForTimeout(250);
    const box = await loc.boundingBox();
    if (!box) return { ok: false, error: "footer_button_no_bounding_box" };
    const x = box.x + (box.width / 2);
    const y = box.y + (box.height / 2);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.up();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

interface SelfIdentificationRequiredControlState {
  label: string;
  value: string;
  invalid: boolean;
}

async function withContinueNetworkTracking<T>(
  page: Page,
  fn: () => Promise<T>
): Promise<{ result: T; events: ContinueNetworkEvent[] }> {
  const events: ContinueNetworkEvent[] = [];
  const requestListener = (request: import("playwright-core").Request): void => {
    if (!isWorkdayContinueNetworkRequest(request.url())) return;
    events.push({
      url: request.url(),
      method: request.method()
    });
  };
  const responseListener = (response: import("playwright-core").Response): void => {
    const url = response.url();
    if (!isWorkdayContinueNetworkRequest(url)) return;
    const status = response.status();
    let event = events.find((item) => item.url === url && item.status === undefined);
    if (!event) {
      event = { url, method: response.request().method() };
      events.push(event);
    }
    event.status = status;
    if (status >= 400) {
      response.text()
        .then((body) => {
          event.responseSnippet = body.replace(/\s+/g, " ").trim().slice(0, 240);
        })
        .catch(() => undefined);
    }
  };
  page.on("request", requestListener);
  page.on("response", responseListener);
  try {
    const result = await fn();
    await page.waitForTimeout(1200);
    return { result, events };
  } finally {
    page.off("request", requestListener);
    page.off("response", responseListener);
  }
}

async function collectSelfIdentificationRequiredControlStates(page: Page): Promise<SelfIdentificationRequiredControlState[]> {
  const activeSelector = await resolveActiveWorkdayContainerSelector(page, "self_identification");
  return page.evaluate((containerSelector) => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const root = document.querySelector(containerSelector) || document.body;
    const containers = Array.from(root.querySelectorAll<HTMLElement>("fieldset, [data-automation-id^='formField-'], [role='group'], div"))
      .filter((node) => visible(node));
    const states: SelfIdentificationRequiredControlState[] = [];
    for (const container of containers) {
      const required = Boolean(container.querySelector(".requiredAsterisk, [aria-required='true'], [required]")) || /\*/.test(container.textContent || "");
      if (!required) continue;
      const label = normalize(
        container.querySelector("legend, label, [data-automation-id='formLabel'], [data-automation-id*='richText'], h3, h4")?.textContent ||
        ""
      );
      if (!label) continue;
      const invalid = container.getAttribute("aria-invalid") === "true" ||
        Boolean(container.querySelector("[aria-invalid='true'], p[data-automation-id='inputAlert'], [role='alert']"));
      const textValues = Array.from(container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input:not([type='hidden']):not([type='checkbox']):not([type='radio']), textarea"))
        .filter((input) => visible(input))
        .map((input) => normalize(input.value || ""))
        .filter(Boolean);
      const choiceValues = Array.from(container.querySelectorAll<HTMLInputElement>("input[type='checkbox'], input[type='radio']"))
        .filter((input) => input.checked)
        .map((input) => normalize(input.value || input.getAttribute("aria-label") || input.parentElement?.textContent || ""))
        .filter(Boolean);
      const buttonValues = Array.from(container.querySelectorAll<HTMLElement>("button[aria-haspopup='listbox'], [role='combobox']"))
        .filter((node) => visible(node))
        .map((node) => normalize(node.textContent || ""))
        .filter(Boolean);
      const value = textValues.join(" | ") || choiceValues.join(" | ") || buttonValues.join(" | ");
      states.push({ label, value: value || "empty", invalid });
    }
    return states;
  }, activeSelector).catch(() => [] as SelfIdentificationRequiredControlState[]);
}

async function commitAndBlurSelfIdentificationFields(page: Page, notes?: string[]): Promise<void> {
  const activeSelector = await resolveActiveWorkdayContainerSelector(page, "self_identification");
  await page.evaluate((containerSelector) => {
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const root = document.querySelector(containerSelector) || document.body;
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.dispatchEvent(new Event("input", { bubbles: true }));
      active.dispatchEvent(new Event("change", { bubbles: true }));
      active.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      active.blur();
    }
    const controls = Array.from(root.querySelectorAll<HTMLElement>("input, textarea, select, button[aria-haspopup='listbox'], [role='combobox']"))
      .filter((node) => visible(node));
    for (const control of controls) {
      if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) {
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
      }
      control.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    }
  }, activeSelector).catch(() => undefined);
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(300).catch(() => undefined);

  const states = await collectSelfIdentificationRequiredControlStates(page);
  const invalidCount = states.filter((state) => state.invalid).length;
  notes?.push("workday_self_identification_commit_sweep_done");
  notes?.push(`workday_self_identification_required_count:${states.length}`);
  notes?.push(`workday_self_identification_invalid_count:${invalidCount}`);
  if (states.length) {
    notes?.push(`workday_self_identification_required_controls:${states.slice(0, 12).map((state) => `${state.label}:invalid=${state.invalid}:value=${state.value}`).join(" || ")}`);
  }
}

async function detectReviewOrSubmitAfterSelfIdentification(page: Page, timeoutMs = 10000): Promise<WorkdayStep | null> {
  const reviewSelectors = [
    "div[data-automation-id='reviewPage']",
    "div[data-automation-id*='reviewPage']",
    "div[data-automation-id*='applicationReview']",
    "button[data-automation-id='pageFooterNextButton']:has-text('Submit')",
    "button[data-automation-id='bottom-navigation-next-button']:has-text('Submit')",
    "button:has-text('Submit')",
    "h1:has-text('Review')",
    "h2:has-text('Review')",
    "h3:has-text('Review')",
    "h1:has-text('Summary')",
    "h2:has-text('Summary')",
    "h3:has-text('Summary')"
  ];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const step = await detectWorkdayStep(page).catch(() => "unknown" as WorkdayStep);
    if (step === "review" || step === "submit") return step;

    const footerInfo = await classifyFooterButton(page).catch(() => ({ kind: "none", text: "" }));
    if (footerInfo.kind === "submit") return "submit";

    for (const selector of reviewSelectors) {
      if (await page.locator(selector).first().isVisible().catch(() => false)) {
        if (/submit/i.test(selector)) return "submit";
        return "review";
      }
    }
    await page.waitForTimeout(350);
  }
  return null;
}

async function attemptSelfIdentificationContinue(input: {
  page: Page;
  currentStep: WorkdayStep;
  notes?: string[];
}): Promise<SelfIdentificationContinueAttemptResult> {
  const { page, currentStep, notes } = input;
  const candidates = await collectFooterCandidates(page);
  const selected = candidates.find((candidate) =>
    candidate.visible &&
    candidate.enabled &&
    (candidate.automationId === "pageFooterNextButton" || /save and continue|continue|next/.test(candidate.text))
  ) ?? candidates.find((candidate) => candidate.visible && candidate.enabled);
  if (!selected) {
    return {
      clicked: false,
      requestFired: false,
      networkError: false,
      advanced: false,
      currentStep,
      visibleValidation: false,
      footerTextAfter: ""
    };
  }

  await commitAndBlurSelfIdentificationFields(page, notes);
  const tracked = await withContinueNetworkTracking(page, async () => {
    notes?.push("workday_continue_click_method:real_user_mouse");
    return clickFooterWithRealMouse(page, selected.selector);
  });
  const clickResult = tracked.result;
  const requestWithStatus = tracked.events.find((event) => typeof event.status === "number");
  const footerInfoAfter = await classifyFooterButton(page).catch(() => ({ kind: "none", text: "" }));
  notes?.push(`workday_footer_button_text_after_self_identification:${footerInfoAfter.text}`);
  notes?.push(`workday_self_identification_continue_request_fired:${tracked.events.length > 0}`);
  if (typeof requestWithStatus?.status === "number") {
    notes?.push(`workday_self_identification_continue_request_status:${requestWithStatus.status}`);
  }

  if (!clickResult.ok) {
    return {
      clicked: false,
      requestFired: tracked.events.length > 0,
      requestUrl: tracked.events[0]?.url,
      requestStatus: requestWithStatus?.status,
      requestErrorSnippet: tracked.events.find((event) => event.responseSnippet)?.responseSnippet,
      networkError: tracked.events.some((event) => (event.status || 0) >= 400),
      advanced: false,
      currentStep,
      visibleValidation: false,
      footerTextAfter: footerInfoAfter.text
    };
  }

  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
  const markerAdvanced = await waitForExpectedTransitionMarker(page, currentStep, 5000).catch(() => false);
  if (markerAdvanced) {
    const nextStep = await waitForPageStep(page, currentStep, 3000);
    if (nextStep !== currentStep && nextStep !== "unknown") {
      return {
        clicked: true,
        requestFired: tracked.events.length > 0,
        requestUrl: tracked.events[0]?.url,
        requestStatus: requestWithStatus?.status,
        requestErrorSnippet: tracked.events.find((event) => event.responseSnippet)?.responseSnippet,
        networkError: tracked.events.some((event) => (event.status || 0) >= 400),
        advanced: true,
        currentStep: nextStep,
        visibleValidation: false,
        footerTextAfter: footerInfoAfter.text
      };
    }
  }

  const maybeNext = await waitForPageStep(page, currentStep, 3500);
  if (maybeNext !== currentStep && maybeNext !== "unknown") {
    return {
      clicked: true,
      requestFired: tracked.events.length > 0,
      requestUrl: tracked.events[0]?.url,
      requestStatus: requestWithStatus?.status,
      requestErrorSnippet: tracked.events.find((event) => event.responseSnippet)?.responseSnippet,
      networkError: tracked.events.some((event) => (event.status || 0) >= 400),
      advanced: true,
      currentStep: maybeNext,
      visibleValidation: false,
      footerTextAfter: footerInfoAfter.text
    };
  }

  const visibleValidation = await hasVisibleWorkdayValidation(page, currentStep);
  if (!visibleValidation && tracked.events.length > 0) {
    const reviewStep = await detectReviewOrSubmitAfterSelfIdentification(page, 10000);
    if (reviewStep) {
      notes?.push(`workday_review_detected_after_self_identification:${reviewStep}`);
      return {
        clicked: true,
        requestFired: true,
        requestUrl: tracked.events[0]?.url,
        requestStatus: requestWithStatus?.status,
        requestErrorSnippet: tracked.events.find((event) => event.responseSnippet)?.responseSnippet,
        networkError: tracked.events.some((event) => (event.status || 0) >= 400),
        advanced: true,
        currentStep: reviewStep,
        visibleValidation: false,
        footerTextAfter: footerInfoAfter.text
      };
    }
  }

  return {
    clicked: true,
    requestFired: tracked.events.length > 0,
    requestUrl: tracked.events[0]?.url,
    requestStatus: requestWithStatus?.status,
    requestErrorSnippet: tracked.events.find((event) => event.responseSnippet)?.responseSnippet,
    networkError: tracked.events.some((event) => (event.status || 0) >= 400),
    advanced: false,
    currentStep,
    visibleValidation,
    footerTextAfter: footerInfoAfter.text
  };
}

async function attemptContactInformationContinue(input: {
  page: Page;
  currentStep: WorkdayStep;
  notes?: string[];
  allowSmsRetry: boolean;
}): Promise<ContactContinueAttemptResult> {
  const { page, currentStep, notes, allowSmsRetry } = input;
  const hasDeterministicTransition = nextStepMarkersFor(currentStep).length > 0;
  const candidates = await collectFooterCandidates(page);
  const preferred = candidates.find((c) => c.visible && c.enabled && (c.automationId === "pageFooterNextButton" || /save and continue|continue|next/.test(c.text)));
  const selected = preferred ?? candidates.find((c) => c.visible && c.enabled);
  if (!selected) {
      return {
        clicked: false,
        requestFired: false,
        networkError: false,
        advanced: false,
        currentStep,
        visibleValidation: false,
        smsRetryAttempted: false
      };
  }

  const smsState = await detectSmsConsentCheckbox(page, currentStep);
  notes?.push(`workday_sms_consent_visible:${smsState.visible}`);
  notes?.push(`workday_sms_consent_checked_initially:${smsState.checked}`);

  const runAttempt = async (): Promise<ContactContinueAttemptResult> => {
    await commitAndBlurContactFields(page, currentStep);
    let tracked = await withContinueNetworkTracking(page, async () => {
      notes?.push("workday_continue_click_method:real_user_mouse");
      return clickFooterWithRealMouse(page, selected.selector);
    });
    let clickResult = tracked.result;
    if (clickResult.ok && tracked.events.length === 0) {
      tracked = await withContinueNetworkTracking(page, async () => {
        notes?.push("workday_continue_click_method:direct_locator_retry");
        const button = page.locator(selected.selector).first();
        const visible = await button.isVisible().catch(() => false);
        if (!visible) return { ok: false, clickedSelector: selected.selector };
        await button.scrollIntoViewIfNeeded().catch(() => undefined);
        await button.click({ force: true }).catch(() => undefined);
        return { ok: true, clickedSelector: selected.selector };
      });
      clickResult = tracked.result;
    }
    if (!clickResult.ok) {
      return {
        clicked: false,
        requestFired: tracked.events.length > 0,
        requestUrl: tracked.events[0]?.url,
        requestStatus: tracked.events.find((event) => typeof event.status === "number")?.status,
        requestErrorSnippet: tracked.events.find((event) => event.responseSnippet)?.responseSnippet,
        networkError: tracked.events.some((event) => (event.status || 0) >= 400),
        advanced: false,
        currentStep,
        visibleValidation: false,
        smsRetryAttempted: false
      };
    }

    await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
    const markerAdvanced = hasDeterministicTransition ? await waitForExpectedTransitionMarker(page, currentStep, 5000) : false;
    const maybeNext = markerAdvanced ? await waitForPageStep(page, currentStep, 2500) : await waitForPageStep(page, currentStep, 3500);
    const advanced = markerAdvanced || (maybeNext !== currentStep && maybeNext !== "unknown");
    const visibleValidation = advanced ? false : await hasVisibleWorkdayValidation(page, currentStep);
    const requestWithStatus = tracked.events.find((event) => typeof event.status === "number");
    return {
      clicked: true,
      requestFired: tracked.events.length > 0,
      requestUrl: tracked.events[0]?.url,
      requestStatus: requestWithStatus?.status,
      requestErrorSnippet: tracked.events.find((event) => event.responseSnippet)?.responseSnippet,
      networkError: tracked.events.some((event) => (event.status || 0) >= 400),
      advanced,
      currentStep: advanced ? maybeNext : currentStep,
      visibleValidation,
      smsRetryAttempted: false
    };
  };

  let firstAttempt = await runAttempt();
  notes?.push(`workday_continue_request_fired:${firstAttempt.requestFired}`);
  if (firstAttempt.requestUrl) notes?.push(`workday_continue_request_url:${firstAttempt.requestUrl}`);
  if (typeof firstAttempt.requestStatus === "number") notes?.push(`workday_continue_request_status:${firstAttempt.requestStatus}`);
  if (firstAttempt.requestErrorSnippet) notes?.push(`workday_continue_request_error_snippet:${firstAttempt.requestErrorSnippet}`);
  if (firstAttempt.advanced) return firstAttempt;

  if (!firstAttempt.requestFired && allowSmsRetry && smsState.visible && !smsState.checked) {
    notes?.push("workday_continue_no_request_before_sms_retry:true");
    const checked = await setSmsConsentCheckbox(page, smsState.selector);
    notes?.push(`workday_sms_consent_checked_on_retry:${checked}`);
    if (checked) {
      await commitAndBlurContactFields(page, currentStep);
      const retryResult = await runAttempt();
      let retryLabel = "no_transition";
      if (retryResult.advanced) retryLabel = "success";
      else if (retryResult.networkError) retryLabel = "network_error";
      notes?.push(`workday_continue_request_fired:${retryResult.requestFired}`);
      if (retryResult.requestUrl) notes?.push(`workday_continue_request_url:${retryResult.requestUrl}`);
      if (typeof retryResult.requestStatus === "number") notes?.push(`workday_continue_request_status:${retryResult.requestStatus}`);
      if (retryResult.requestErrorSnippet) notes?.push(`workday_continue_request_error_snippet:${retryResult.requestErrorSnippet}`);
      notes?.push(`workday_continue_after_sms_retry_result:${retryLabel}`);
      return retryResult.advanced
        ? { ...retryResult, smsRetryAttempted: true }
        : {
            ...retryResult,
            requestFired: retryResult.requestFired || firstAttempt.requestFired,
            smsRetryAttempted: true
          };
    }
  } else {
    notes?.push("workday_sms_consent_checked_on_retry:false");
  }

  return firstAttempt;
}

async function extractOptionsForField(page: Page, selector: string): Promise<string[]> {
  const trigger = page.locator(selector).first();
  const visible = await trigger.isVisible().catch(() => false);
  if (!visible) return [];
  await trigger.click().catch(() => undefined);
  await page.waitForTimeout(220);
  const options = await page
    .locator("[role='option'], [role='listbox'] [role='option'], [data-automation-id='promptOption']")
    .allInnerTexts()
    .catch(() => [] as string[]);
  await page.keyboard.press("Escape").catch(() => undefined);
  return [...new Set(options.map((v) => normalizeText(v)).filter(Boolean))];
}

interface RequiredScanItem {
  label: string;
  selector: string;
  inputKind: WorkdayQuestionnaireField["inputKind"];
  currentValue: string;
}

type UnresolvedFieldType =
  | "text"
  | "textarea"
  | "native_select"
  | "workday_button_dropdown"
  | "combobox"
  | "radio"
  | "checkbox"
  | "checkbox_group"
  | "date"
  | "file"
  | "unknown";

interface WorkdayUnresolvedRequiredField {
  fieldId: string;
  label: string;
  required: boolean;
  fieldType: UnresolvedFieldType;
  currentValue: string;
  possibleAnswers: string[];
  expectedDomAction: "fill_text" | "choose_option" | "toggle" | "upload_file" | "unknown";
  selector: string;
  selectorHints: { id?: string; name?: string; dataAutomationId?: string };
  htmlSummary: string;
}

interface AliasResolution {
  answer: string | boolean | null;
  selectedOptions: string[];
  reason: string;
  confidence: "high" | "medium" | "low";
}

function normalizeOption(value: string): string {
  return normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function matchesAny(label: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(label));
}

function pickOptionByBoolean(options: string[], wantYes: boolean): string | null {
  const normalized = options.map((o) => ({ raw: o, v: normalizeText(o) }));
  if (wantYes) {
    return normalized.find((o) => /^(yes|i agree|agree|accept|consent|authorized|eligible|true)/.test(o.v))?.raw ?? null;
  }
  return normalized.find((o) => /^(no|decline|false|not)/.test(o.v))?.raw ?? null;
}

function pickDeclineOption(options: string[]): string | null {
  const normalized = options.map((o) => ({ raw: o, v: normalizeText(o) }));
  return normalized.find((o) => /decline|do not wish|prefer not|i don't wish|self-identify later/.test(o.v))?.raw ?? null;
}

function currentDateParts(): { month: string; day: string; year: string; formatted: string } {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const year = String(now.getFullYear());
  return { month, day, year, formatted: `${month}/${day}/${year}` };
}

function resolveAliasField(field: WorkdayUnresolvedRequiredField, profile: import("./resolver.js").NormalizedWorkdayProfile): AliasResolution | null {
  const label = normalizeText(field.label);
  const fieldKey = normalizeText(`${field.fieldId} ${field.selectorHints.id || ""} ${field.selectorHints.dataAutomationId || ""}`);
  const hasOptions = field.possibleAnswers.length > 0;
  const choose = (val: string): AliasResolution => ({ answer: val, selectedOptions: hasOptions ? [val] : [], reason: "alias_match", confidence: "high" });
  const chooseBool = (v: boolean): AliasResolution => {
    const option = pickOptionByBoolean(field.possibleAnswers, v);
    if (option) return { answer: option, selectedOptions: [option], reason: "alias_bool_option", confidence: "high" };
    return { answer: v ? "Yes" : "No", selectedOptions: [], reason: "alias_bool_text", confidence: "medium" };
  };

  if (matchesAny(label, [/father'?s family name/, /\bfamily name\b/, /\bsurname\b/, /legal last name/, /^last name\b/])) return choose(profile.identity.lastName);
  if (matchesAny(label, [/\bgiven name\b/, /legal first name/, /^first name\b/])) return choose(profile.identity.firstName);
  if (matchesAny(label, [/middle name/])) return profile.identity.middleName ? choose(profile.identity.middleName) : null;
  if (matchesAny(label, [/preferred name/])) return choose(profile.identity.preferredName || profile.identity.firstName);
  if (matchesAny(label, [/\bphone\b/])) return choose(profile.contact.phone);
  if (matchesAny(label, [/\bemail\b/])) return choose(profile.contact.email || profile.account.email);
  if (matchesAny(label, [/address line 1/, /^address$/])) return choose(profile.contact.address.line1);
  if (matchesAny(label, [/\bcity\b/])) return choose(profile.contact.address.city);
  if (matchesAny(label, [/postal code/, /\bzip\b/])) return choose(profile.contact.address.postalCode);
  if (matchesAny(label, [/state|province|region/])) return choose(profile.contact.address.state);
  if (matchesAny(label, [/country\/region phone code|country phone code|phone code/])) return choose("United States of America (+1)");
  if (/datesignedon/.test(fieldKey)) {
    const today = currentDateParts();
    if (/datesectionmonth/.test(fieldKey) || label === "month") return choose(today.month);
    if (/datesectionday/.test(fieldKey) || label === "day") return choose(today.day);
    if (/datesectionyear/.test(fieldKey) || label === "year") return choose(today.year);
    if (matchesAny(label, [/\bdate\b/])) return choose(today.formatted);
  }

  if (matchesAny(label, [/legally authorized|eligible to work|without visa sponsorship/])) {
    return chooseBool(profile.workAuthorization.authorizedInUS && !profile.workAuthorization.requiresSponsorship);
  }
  if (matchesAny(label, [/require sponsorship|visa sponsorship/])) return chooseBool(profile.workAuthorization.requiresSponsorship);
  if (matchesAny(label, [/agree to comply|terms and conditions|read and consent|privacy|tobacco|drug|alcohol/])) return chooseBool(true);

  if (matchesAny(label, [/\bgender\b/])) {
    if (profile.demographics.gender) return choose(profile.demographics.gender);
    const decline = pickDeclineOption(field.possibleAnswers);
    return decline ? { answer: decline, selectedOptions: [decline], reason: "alias_decline", confidence: "medium" } : null;
  }
  if (matchesAny(label, [/\bethnicity\b/, /\brace\b/])) {
    if (profile.demographics.ethnicity) return choose(profile.demographics.ethnicity);
    const decline = pickDeclineOption(field.possibleAnswers);
    return decline ? { answer: decline, selectedOptions: [decline], reason: "alias_decline", confidence: "medium" } : null;
  }
  if (matchesAny(label, [/\bveteran\b/])) {
    if (profile.demographics.veteranStatus) return choose(profile.demographics.veteranStatus);
    const decline = pickDeclineOption(field.possibleAnswers);
    return decline ? { answer: decline, selectedOptions: [decline], reason: "alias_decline", confidence: "medium" } : null;
  }
  if (/^yes, i have a disability/.test(label)) {
    return { answer: profile.demographics.disabilityStatus === "yes", selectedOptions: [], reason: "alias_disability_yes_option", confidence: "high" };
  }
  if (/^no, i do not have a disability/.test(label)) {
    return { answer: profile.demographics.disabilityStatus !== "yes" && profile.demographics.disabilityStatus !== "decline", selectedOptions: [], reason: "alias_disability_no_option", confidence: "high" };
  }
  if (/do not want to answer|don't wish to answer|decline/.test(label)) {
    return { answer: profile.demographics.disabilityStatus === "decline", selectedOptions: [], reason: "alias_disability_decline_option", confidence: "high" };
  }
  if (matchesAny(label, [/\bdisability\b/])) {
    if (profile.demographics.disabilityStatus) {
      const target = profile.demographics.disabilityStatus === "yes"
        ? field.possibleAnswers.find((option) => /^yes, i have a disability/i.test(option))
        : profile.demographics.disabilityStatus === "no"
          ? field.possibleAnswers.find((option) => /^no, i do not have a disability/i.test(option))
          : field.possibleAnswers.find((option) => /do not want to answer|don't wish to answer|decline/i.test(option));
      if (target) return choose(target);
      return choose(profile.demographics.disabilityStatus === "yes" ? "Yes" : profile.demographics.disabilityStatus === "no" ? "No" : "Decline");
    }
    const decline = pickDeclineOption(field.possibleAnswers);
    return decline ? { answer: decline, selectedOptions: [decline], reason: "alias_decline", confidence: "medium" } : null;
  }

  if (matchesAny(label, [/\bschool\b/, /\buniversity\b/])) return profile.education[0]?.school ? choose(profile.education[0].school) : null;
  if (matchesAny(label, [/\bdegree\b/])) return profile.education[0]?.degree ? choose(profile.education[0].degree) : null;
  if (matchesAny(label, [/field of study|major|discipline/])) return profile.education[0]?.fieldOfStudy ? choose(profile.education[0].fieldOfStudy) : null;
  if (matchesAny(label, [/\bgpa\b/])) return profile.education[0]?.gpa ? choose(profile.education[0].gpa) : null;

  return null;
}

async function extractScopedOptionsForControl(page: Page, selector: string): Promise<string[]> {
  const trigger = page.locator(selector).first();
  const visible = await trigger.isVisible().catch(() => false);
  if (!visible) return [];
  const before = await page.locator("[role='listbox']:visible").evaluateAll((els) => els.map((el) => el.id || "")).catch(() => [] as string[]);
  await trigger.click().catch(() => undefined);
  await page.waitForTimeout(250);
  const ariaControls = String((await trigger.getAttribute("aria-controls").catch(() => "")) ?? "").trim();
  const ariaOwns = String((await trigger.getAttribute("aria-owns").catch(() => "")) ?? "").trim();

  let scope = page.locator("__never__");
  if (ariaControls) scope = page.locator(`#${ariaControls.replace(/([.#:[\\],= ])/g, "\\$1")}`);
  else if (ariaOwns) scope = page.locator(`#${ariaOwns.replace(/([.#:[\\],= ])/g, "\\$1")}`);
  else {
    const afterVisible = page.locator("[role='listbox']:visible");
    const afterIds = await afterVisible.evaluateAll((els) => els.map((el) => el.id || "")).catch(() => [] as string[]);
    const newId = afterIds.find((id) => id && !before.includes(id));
    if (newId) scope = page.locator(`#${newId.replace(/([.#:[\\],= ])/g, "\\$1")}`);
    else scope = afterVisible.last();
  }

  const options = await scope.locator("[role='option'], [data-automation-id='promptOption'], li, button, div").allInnerTexts().catch(() => [] as string[]);
  await page.keyboard.press("Escape").catch(() => undefined);
  const filtered = options
    .map((o) => o.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((o) => !/^(select|select one|choose)$/i.test(o));
  return Array.from(new Set(filtered));
}

function classifyUnresolvedFieldType(inputKind: WorkdayQuestionnaireField["inputKind"], selector: string): UnresolvedFieldType {
  if (inputKind === "text") return "text";
  if (inputKind === "textarea") return "textarea";
  if (inputKind === "radio") return "radio";
  if (inputKind === "checkbox") return "checkbox";
  if (inputKind === "dropdown" && selector.startsWith("button")) return "workday_button_dropdown";
  if (inputKind === "dropdown") return "combobox";
  return "unknown";
}

async function remediateKnownContactRequired(
  page: Page,
  step: WorkdayStep,
  items: RequiredScanItem[],
  profile: import("./resolver.js").NormalizedWorkdayProfile
): Promise<void> {
  if (items.length === 0) return;
  if (step === "my_experience") {
    const rows = await page.evaluate(() => {
      return Array.from(document.querySelectorAll<HTMLInputElement>("input[id$='--jobTitle']")).map((input) => {
        const id = input.id || "";
        const prefix = id.replace(/--jobTitle$/, "");
        const companyInput = document.getElementById(`${prefix}--companyName`) as HTMLInputElement | null
          || document.getElementById(`${prefix}--company`) as HTMLInputElement | null;
        return {
          prefix,
          jobTitle: String(input.value || ""),
          company: String(companyInput?.value || "")
        };
      }).filter((row) => row.prefix);
    }).catch(() => [] as Array<{ prefix: string; jobTitle: string; company: string }>);

    for (const row of rows) {
      const matched = profile.experience.find((exp) => sameExperienceRow(row, exp));
      if (!matched) continue;
      await fillDateSectionInputs(
        page,
        `#${escapeSelectorId(`${row.prefix}--startDate-dateSectionMonth-input`)}`,
        `#${escapeSelectorId(`${row.prefix}--startDate-dateSectionYear-input`)}`,
        matched.startDateMonth,
        matched.startDateYear
      ).catch(() => false);
      if (matched.endDateMonth || matched.endDateYear) {
        await fillDateSectionInputs(
          page,
          `#${escapeSelectorId(`${row.prefix}--endDate-dateSectionMonth-input`)}`,
          `#${escapeSelectorId(`${row.prefix}--endDate-dateSectionYear-input`)}`,
          matched.endDateMonth,
          matched.endDateYear
        ).catch(() => false);
      }
      if (!matched.endDateYear) {
        const currentRole = page.locator(`#${escapeSelectorId(`${row.prefix}--currentlyWorkHere`)}`).first();
        const visible = await currentRole.isVisible().catch(() => false);
        if (visible) {
          const checked = await currentRole.isChecked().catch(() => false);
          if (!checked) await currentRole.check().catch(() => undefined);
        }
      }
    }
    return;
  }

  if (step !== "contact_information") return;
  for (const item of items) {
    const label = normalizeText(item.label);
    if (/father'?s family name|second last name|maternal surname|paternal surname/.test(label)) {
      await safeFill(page, item.selector, profile.identity.lastName).catch(() => undefined);
      continue;
    }
    if (/country\/region phone code|country phone code|phone code/.test(label)) {
      await fillWorkdayPhoneCodeRadioPicker(page, item.selector, "United States of America (+1)").catch(() => undefined);
    }
  }
}

async function remediateKnownQuestionnaireRequired(
  page: Page,
  step: WorkdayStep,
  items: RequiredScanItem[],
  profile: import("./resolver.js").NormalizedWorkdayProfile,
  notes?: string[]
): Promise<void> {
  if (items.length === 0) return;
  if (step !== "application_questions") return;

  const salaryFallback = String(
    profile.customAnswers["salary expectations"] ||
    profile.customAnswers["salary expectation"] ||
    profile.customAnswers["expected salary"] ||
    "USD 120000"
  ).trim() || "USD 120000";

  for (const item of items) {
    const label = normalizeText(item.label);
    if (item.inputKind !== "text" && item.inputKind !== "textarea") continue;

    if (/salary expectation|salary expectations|expected salary|compensation expectation|desired compensation|pay expectation/.test(label)) {
      const filled = await safeFill(page, item.selector, salaryFallback).catch(() => false);
      if (filled) notes?.push(`workday_questionnaire_required_filled:${label}:${normalizeText(salaryFallback)}`);
    }
  }
}

async function recoverFromDiagnosticRequiredFields(
  page: Page,
  step: WorkdayStep,
  items: RequiredScanItem[],
  profile: import("./resolver.js").NormalizedWorkdayProfile,
  notes?: string[]
): Promise<number> {
  let filled = 0;
  for (const item of items) {
    const label = normalizeText(item.label);
    if (/country\/region phone code|country phone code|phone code/.test(label)) {
      const ok = await fillWorkdayPhoneCodeRadioPicker(page, item.selector, "United States of America (+1)").catch(() => false);
      if (ok) {
        filled += 1;
        notes?.push("workday_no_transition_recovery_filled:country phone code:united states of america (+1)");
      }
      continue;
    }
    let value: string | null = null;
    if (/father'?s family name|mother'?s family name|family name|surname|last name/.test(label)) value = profile.identity.lastName;
    else if (/given name|first name/.test(label)) value = profile.identity.firstName;
    else if (item.inputKind === "text" && /phone/.test(label)) value = profile.contact.phone;
    else if (item.inputKind === "text" && /email/.test(label)) value = profile.contact.email || profile.account.email;
    if (!value) continue;
    const ok = await safeFill(page, item.selector, value);
    if (ok) {
      filled += 1;
      notes?.push(`workday_no_transition_recovery_filled:${label}:${normalizeText(value)}`);
    }
  }
  return filled;
}

async function scanUnresolvedRequiredControls(page: Page, step: WorkdayStep): Promise<RequiredScanItem[]> {
  const activeSelector = await resolveActiveWorkdayContainerSelector(page, step);
  return page.evaluate((containerSelector) => {
    const norm = (v: string) => v.replace(/\s+/g, " ").trim().toLowerCase();
    const activeContainer =
      document.querySelector(containerSelector) ||
      document.querySelector("div[data-automation-id='contactInformationPage'], div[data-automation-id='myExperiencePage'], div[data-automation-id='applyFlowPrimaryQuestionsPage'], div[data-automation-id='voluntaryDisclosuresPage'], div[data-automation-id='selfIdentificationPage']") ||
      document.body;
    const out: RequiredScanItem[] = [];
    const controls = Array.from(activeContainer.querySelectorAll<HTMLElement>("button[aria-haspopup='listbox'], input, textarea, [role='combobox']"));
    for (const c of controls) {
      const rect = c.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const required = c.hasAttribute("required") || c.getAttribute("aria-required") === "true" || Boolean(c.closest("fieldset")?.querySelector(".requiredAsterisk"));
      if (!required) continue;
      const txt = norm((c.textContent || "") + " " + ((c as HTMLInputElement).value || ""));
      const invalid = c.getAttribute("aria-invalid") === "true";
      const fs = c.closest("fieldset");
      const label = norm(
        fs?.querySelector("legend")?.textContent ||
        c.getAttribute("aria-label") ||
        c.closest("[data-automation-id^='formField-']")?.querySelector("label, [data-automation-id*='richText']")?.textContent ||
        ""
      );
      let unresolved = false;
      let inputKind: RequiredScanItem["inputKind"] = "unknown";
      if (c.matches("button[aria-haspopup='listbox']")) {
        inputKind = "dropdown";
        unresolved = !txt || txt.includes("select one") || txt.includes("select...");
      } else if (c.matches("input[type='radio'], input[type='checkbox']")) {
        inputKind = c.matches("input[type='radio']") ? "radio" : "checkbox";
        const checked = Boolean(fs?.querySelector("input[type='radio']:checked, input[type='checkbox']:checked"));
        unresolved = !checked;
      } else if (c.matches("textarea")) {
        inputKind = "textarea";
        unresolved = !txt;
      } else {
        inputKind = "text";
        unresolved = !txt;
      }
      const container = c.closest("[data-automation-id^='formField-'], fieldset, div");
      const containerText = norm(container?.textContent || "");
      const hasTokenSelection =
        /how did you hear about us/.test(label) &&
        /linkedin/.test(containerText);
      if (hasTokenSelection) unresolved = false;
      unresolved = unresolved || invalid;
      if (!unresolved) continue;
      const id = c.getAttribute("id");
      const name = c.getAttribute("name");
      let selector = "";
      if (id) selector = `${c.tagName.toLowerCase()}#${id.replace(/([.#:[\],= ])/g, "\\$1")}`;
      else if (name) selector = `${c.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`;
      if (!selector) continue;
      out.push({ label: label || "required field", selector, inputKind, currentValue: txt });
    }
    return out;
  }, activeSelector);
}

function isLikelyQuestionnaireControl(step: WorkdayStep, label: string, isInvalid: boolean): boolean {
  if (step === "application_questions" || step === "voluntary_disclosures" || step === "self_identification") return true;
  if (step === "contact_information") return isInvalid;
  return /authorization|sponsorship|clearance|military|government|experience|start date|relocat|consent|agree|employed by|veteran|disability|ethnicity|gender/.test(label);
}

async function collectRequiredUnresolvedQuestionnaireFields(page: Page, schema: WorkdayFieldSchema[], step: WorkdayStep): Promise<WorkdayUnresolvedRequiredField[]> {
  const out: WorkdayUnresolvedRequiredField[] = [];
  const seen = new Set<string>();
  const activeSelector = await resolveActiveWorkdayContainerSelector(page, step);
  const stepScope = page.locator(activeSelector).first();
  for (const field of schema) {
    if (!field.required) continue;
    const selector = field.selectorHints.selector || "";
    if (!selector) continue;

    const control = page.locator(selector).first();
    const visible = await control.isVisible().catch(() => false);
    if (!visible) continue;

    const inputKind: WorkdayQuestionnaireField["inputKind"] =
      field.fieldType === "dropdown" || field.fieldType === "search_combobox" ? "dropdown" :
      field.fieldType === "radio" ? "radio" :
      field.fieldType === "checkbox" ? "checkbox" :
      field.fieldType === "textarea" ? "textarea" :
      field.fieldType === "text" ? "text" :
      "unknown";

    const mergedText = normalizeText(
      `${await control.innerText().catch(() => "")} ${await control.inputValue().catch(() => "")} ${await control.getAttribute("value").catch(() => "")}`
    );
    const ariaInvalid = (await control.getAttribute("aria-invalid").catch(() => "")) === "true";
    const labelNorm = normalizeText(field.label);
    if (!isLikelyQuestionnaireControl(step, labelNorm, ariaInvalid)) continue;
    let unresolved = false;
    if (inputKind === "dropdown" || selector.startsWith("button")) unresolved = !mergedText || mergedText.includes("select one");
    else if (inputKind === "text" || inputKind === "textarea") unresolved = !mergedText;
    else if (inputKind === "radio" || inputKind === "checkbox") {
      unresolved = await control.evaluate((el) => {
        const fieldset = (el as HTMLElement).closest("fieldset");
        if (!fieldset) return false;
        const checked = fieldset.querySelector("input[type='radio']:checked, input[type='checkbox']:checked");
        return !checked;
      }).catch(() => false);
    } else {
      unresolved = !mergedText || ariaInvalid;
    }
    unresolved = unresolved || ariaInvalid;
    if (!unresolved) continue;

    let options: string[] = [];
    if (inputKind === "dropdown" || selector.startsWith("button")) {
      const extractedOptions = await extractScopedOptionsForControl(page, selector);
      options = extractedOptions.length ? extractedOptions : field.possibleAnswers;
    }
    const dedupeKey = `${field.fieldId}|${selector}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const fieldType = classifyUnresolvedFieldType(inputKind, selector);
    out.push({
      fieldId: field.fieldId,
      label: field.label,
      required: field.required,
      fieldType,
      currentValue: mergedText,
      possibleAnswers: options,
      expectedDomAction: fieldType === "text" || fieldType === "textarea" ? "fill_text" : "choose_option",
      selector,
      selectorHints: {
        dataAutomationId: field.selectorHints.dataAutomationId,
        name: field.selectorHints.inputName
      },
      htmlSummary: JSON.stringify(field.htmlSummary || {})
    });
  }

  const fieldsetRows = await stepScope.locator("fieldset").evaluateAll((nodes) => {
    const rows: Array<{ label: string; selector: string }> = [];
    for (const node of nodes) {
      const fieldset = node as HTMLElement;
      const required = fieldset.querySelector(".requiredAsterisk, [aria-required='true'], [required]");
      if (!required) continue;
      const legend = (fieldset.querySelector("legend")?.textContent || "").replace(/\s+/g, " ").trim();
      const button = fieldset.querySelector("button[aria-haspopup='listbox']") as HTMLButtonElement | null;
      if (!button) continue;
      const text = (button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const invalid = button.getAttribute("aria-invalid") === "true";
      if (!invalid && text !== "select one") continue;
      const id = button.getAttribute("id");
      const name = button.getAttribute("name");
      const selector = id
        ? `button[id="${id.replace(/"/g, '\\"')}"]`
        : (name ? `button[name="${name.replace(/"/g, '\\"')}"]` : "");
      if (!selector) continue;
      rows.push({ label: legend || button.getAttribute("aria-label") || "required question", selector });
    }
    return rows;
  }).catch(() => [] as Array<{ label: string; selector: string }>);

  for (const row of fieldsetRows) {
    const key = `fieldset|${row.selector}`;
    if (seen.has(key)) continue;
    const options = await extractScopedOptionsForControl(page, row.selector);
    out.push({
      fieldId: `fieldset_${normalizeText(row.label).replace(/[^a-z0-9]+/g, "_")}`,
      label: row.label,
      required: true,
      fieldType: "workday_button_dropdown",
      currentValue: "select one",
      possibleAnswers: options,
      expectedDomAction: "choose_option",
      selector: row.selector,
      selectorHints: {},
      htmlSummary: "fieldset_dropdown"
    });
    seen.add(key);
  }
  return out;
}

async function applyDropdownViaComboboxType(page: Page, field: { selector: string }, value: string): Promise<boolean> {
  const typed = await page.locator(field.selector).first().fill(value).then(() => true).catch(() => false);
  if (!typed) return false;
  await page.keyboard.press("Enter").catch(() => undefined);
  return true;
}

async function applyDropdownViaFieldsetOption(page: Page, field: { label: string; selector: string }, value: string): Promise<boolean> {
  const escaped = field.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.locator("fieldset").filter({ hasText: new RegExp(escaped, "i") })
    .locator(`[role='option']:has-text("${value}"), li:has-text("${value}"), button:has-text("${value}")`)
    .first()
    .click()
    .then(() => true)
    .catch(() => false);
}

async function applyDropdownViaAriaControls(page: Page, field: { selector: string }, value: string): Promise<boolean> {
  const trigger = page.locator(field.selector).first();
  await trigger.click().catch(() => undefined);
  const listboxId = String((await trigger.getAttribute("aria-controls").catch(() => "")) ?? "").trim();
  if (!listboxId) return false;
  return page.locator(`#${listboxId.replace(/([.#:[\],= ])/g, "\\$1")} [role='option']`).filter({ hasText: value }).first()
    .click()
    .then(() => true)
    .catch(() => false);
}

async function applyResolvedQuestionWithStrategies(page: Page, field: WorkdayUnresolvedRequiredField, value: string): Promise<{ applied: boolean; attemptedStrategies: string[] }> {
  const attemptedStrategies: string[] = [];

  if (/how did you hear|application source|\bsource\b/.test(normalizeText(field.label))) {
    attemptedStrategies.push("source_prompt_commit");
    return {
      applied: await fillWorkdaySourcePrompt(page, field.selector, value).catch(() => false),
      attemptedStrategies
    };
  }

  if (/country\/region phone code|country phone code|phone code/.test(normalizeText(field.label))) {
    attemptedStrategies.push("country_phone_code_radio_picker");
    return {
      applied: await fillWorkdayPhoneCodeRadioPicker(page, field.selector, value).catch(() => false),
      attemptedStrategies
    };
  }

  if (field.fieldType === "workday_button_dropdown" || field.fieldType === "combobox" || field.selector.startsWith("button")) {
    attemptedStrategies.push("listbox_button_click");
    if (field.selector.startsWith("button")) {
      const trigger = page.locator(field.selector).first();
      try {
        await fillWorkdayDropdownAndCommit(page, trigger, value, field.label);
        return { applied: true, attemptedStrategies };
      } catch {
        // continue fallback chain
      }
    }
    if (await fillWorkdayDropdown(page, field.selector, value)) return { applied: true, attemptedStrategies };

    attemptedStrategies.push("combobox_type_enter");
    if (await applyDropdownViaComboboxType(page, field, value)) return { applied: true, attemptedStrategies };

    attemptedStrategies.push("fieldset_scoped_option_click");
    if (await applyDropdownViaFieldsetOption(page, field, value)) return { applied: true, attemptedStrategies };

    attemptedStrategies.push("aria_controls_targeted_option_click");
    if (await applyDropdownViaAriaControls(page, field, value)) return { applied: true, attemptedStrategies };

    return { applied: false, attemptedStrategies };
  }
  if (field.fieldType === "radio") {
    attemptedStrategies.push("fieldset_scoped_option_click");
    const byText = await page.locator("fieldset").filter({ hasText: new RegExp(field.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") })
      .locator(`label:has-text("${value}"), [role='radio']:has-text("${value}"), button:has-text("${value}")`)
      .first()
      .click()
      .then(() => true)
      .catch(() => false);
    if (byText) return { applied: true, attemptedStrategies };
    attemptedStrategies.push("selector_click");
    return { applied: await safeClick(page, field.selector), attemptedStrategies };
  }
  if (field.fieldType === "checkbox" || field.fieldType === "checkbox_group") {
    attemptedStrategies.push("selector_click");
    return { applied: await safeClick(page, field.selector), attemptedStrategies };
  }
  attemptedStrategies.push("text_fill_enter");
  const filled = await safeFill(page, field.selector, value);
  if (filled) await page.keyboard.press("Enter").catch(() => undefined);
  return { applied: filled, attemptedStrategies };
}

async function verifyResolvedQuestion(page: Page, field: WorkdayUnresolvedRequiredField, expected: string): Promise<boolean> {
  const control = page.locator(field.selector).first();
  const mergedText = normalizeText(
    `${await control.innerText().catch(() => "")} ${await control.inputValue().catch(() => "")} ${await control.getAttribute("value").catch(() => "")}`
  );
  const expectedNorm = normalizeText(expected);
  if (field.fieldType === "workday_button_dropdown" || field.fieldType === "combobox" || field.selector.startsWith("button")) return !!mergedText && !mergedText.includes("select one") && mergedText.includes(expectedNorm);
  if (field.fieldType === "radio" || field.fieldType === "checkbox" || field.fieldType === "checkbox_group") {
    return control.evaluate((el, expectedValue) => {
      const fieldset = (el as HTMLElement).closest("fieldset");
      if (!fieldset) return false;
      const checked = fieldset.querySelector("input[type='radio']:checked, input[type='checkbox']:checked");
      if (!checked) return false;
      const id = checked.getAttribute("id");
      const label = id ? fieldset.querySelector(`label[for="${id}"]`)?.textContent || "" : "";
      return `${checked.getAttribute("value") || ""} ${label}`.toLowerCase().includes(String(expectedValue).toLowerCase());
    }, expectedNorm).catch(() => false);
  }
  return mergedText.includes(expectedNorm);
}

async function hasVisibleWorkdayValidation(page: Page, step: WorkdayStep): Promise<boolean> {
  const activeSelector = await resolveActiveWorkdayContainerSelector(page, step);
  const scope = page.locator(activeSelector).first();
  const inputAlerts = await scope.locator("p[data-automation-id='inputAlert']").count().catch(() => 0);
  const ariaInvalid = await scope.locator("[aria-invalid='true']").count().catch(() => 0);
  const errorSummary = await page
    .locator("[data-automation-id*='error'], [role='alert'], button:has-text('error'), a:has-text('error')")
    .count()
    .catch(() => 0);
  return inputAlerts > 0 || ariaInvalid > 0 || errorSummary > 0;
}

async function recoverAnchoredContactFields(
  page: Page,
  profile: import("./resolver.js").NormalizedWorkdayProfile,
  notes?: string[]
): Promise<number> {
  const errors = await collectValidationErrors(page);
  const labels = Array.from(new Set(errors.flatMap((error) => {
    const matches = error.match(/how did you hear about us\??|have you previously worked at [^?.|]+/gi);
    return matches || [];
  })));

  let applied = 0;
  for (const label of labels) {
    if (!isSourceContactErrorLabel(label) && !isPriorCompanyContactErrorLabel(label)) continue;
    const field = await findFieldNearLabel(page, label);
    if (!field) {
      notes?.push(`workday_contact_anchor_missing:${normalizeText(label)}`);
      continue;
    }

    notes?.push(`workday_contact_anchor_label:${field.label}`);
    notes?.push(`workday_contact_anchor_kind:${field.controlKind}`);
    const options = await extractVisibleOptions(page, field);
    if (options.length) notes?.push(`workday_contact_anchor_options:${options.join(" | ")}`);

    const ok = isSourceContactErrorLabel(label)
      ? await fillSourceQuestion(page, field)
      : await fillPriorCompanyQuestion(page, field, deriveCompanyNameFromErrorLabel(label), profile);
    if (ok) {
      applied += 1;
      notes?.push(`workday_contact_anchor_filled:${normalizeText(label)}`);
    } else {
      notes?.push(`workday_contact_anchor_failed:${normalizeText(label)}`);
    }
  }

  return applied;
}

export function planTargetedWidgetRetry(widgets: Array<{ widgetId: string }>, invalidWidgetIds: string[]): string[] {
  const existingIds = new Set(widgets.map((widget) => widget.widgetId));
  return Array.from(new Set(invalidWidgetIds.filter((widgetId) => existingIds.has(widgetId))));
}

export function matchWorkdayInvalidWidgetIdsByErrorLabels(
  widgets: Array<{ widgetId: string; label: string }>,
  errorLabels: string[]
): string[] {
  const normalizedErrorLabels = errorLabels
    .map((label) => normalizeRetryLabel(label))
    .filter(Boolean);
  const invalidIds = widgets
    .filter((widget) => {
      const normalizedLabel = normalizeRetryLabel(widget.label || "");
      if (!normalizedLabel) return false;
      return normalizedErrorLabels.some((label) => normalizedLabel === label);
    })
    .map((widget) => widget.widgetId);
  return planTargetedWidgetRetry(widgets, invalidIds);
}

interface InvalidWorkdayWidgetRetryTargets {
  domInvalidWidgetIds: string[];
  errorLabelMatchedWidgetIds: string[];
}

export function planWorkdayRetryWidgetIds(input: {
  widgets: Array<{ widgetId: string }>;
  domInvalidWidgetIds: string[];
  errorLabelMatchedWidgetIds: string[];
  currentStep: WorkdayStep;
  lockedWidgetIds?: string[];
}): string[] {
  const domInvalidIds = planTargetedWidgetRetry(input.widgets, input.domInvalidWidgetIds);
  if (domInvalidIds.length > 0) return domInvalidIds;

  const lockedWidgetIds = new Set(input.lockedWidgetIds || []);
  const errorLabelMatchedIds = input.currentStep === "application_questions"
    ? input.errorLabelMatchedWidgetIds.filter((widgetId) => !lockedWidgetIds.has(widgetId))
    : input.errorLabelMatchedWidgetIds;
  return planTargetedWidgetRetry(input.widgets, errorLabelMatchedIds);
}

async function collectInvalidWorkdayWidgetRetryTargets(page: Page, widgets: WorkdayWidgetSchema[]): Promise<InvalidWorkdayWidgetRetryTargets> {
  const serializable = widgets.map((widget) => ({
    widgetId: widget.widgetId,
    label: widget.label,
    widgetType: widget.widgetType,
    containerSelector: widget.selectorHints.containerSelector || "",
    controlSelector: widget.selectorHints.controlSelector || "",
    optionSelectors: widget.selectorHints.optionSelectors || {},
    monthSelector: widget.selectorHints.monthSelector || "",
    daySelector: widget.selectorHints.daySelector || "",
    yearSelector: widget.selectorHints.yearSelector || ""
  }));

  const invalidIds = await page.evaluate((items) => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const hasVisibleError = (root: Element | null): boolean => {
      if (!root) return false;
      if ((root as HTMLElement).getAttribute?.("aria-invalid") === "true") return true;
      return Array.from(root.querySelectorAll("[aria-invalid='true'], [role='alert'], [data-automation-id='inputAlert'], [data-automation-id*='error'], .error"))
        .some((node) => visible(node));
    };
    const errorLabels = Array.from(document.querySelectorAll<HTMLElement>("a, button, [role='link'], [role='button'], li, p, div"))
      .filter((node) => visible(node))
      .map((node) => normalize(node.textContent || ""))
      .filter((text) => /^error\s*-\s*/.test(text))
      .map((text) => text.replace(/^error\s*-\s*/, "").trim());

    return items.filter((item) => {
      const root = (item.containerSelector && document.querySelector(item.containerSelector)) ||
        (item.controlSelector && document.querySelector(item.controlSelector));
      if (!root) return false;
      if (hasVisibleError(root)) return true;

      if (item.widgetType === "radio_group" || item.widgetType === "checkbox_group") {
        const selectors = Object.values(item.optionSelectors || {});
        return selectors.length > 0 && !selectors.some((selector) => {
          const input = document.querySelector(selector) as HTMLInputElement | null;
          return Boolean(input?.checked);
        });
      }

      if (item.widgetType === "date_mm_yyyy" || item.widgetType === "date_mm_dd_yyyy") {
        const selectors = [item.monthSelector, item.daySelector, item.yearSelector].filter(Boolean);
        return selectors.some((selector) => {
          const input = document.querySelector(selector) as HTMLInputElement | null;
          return !String(input?.value || "").trim();
        });
      }

      return false;
    }).map((item) => item.widgetId);
  }, serializable).catch(() => [] as string[]);

  const errorLabels = await page.evaluate(() => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    return Array.from(document.querySelectorAll<HTMLElement>("a, button, [role='link'], [role='button'], li, p, div"))
      .filter((node) => visible(node))
      .map((node) => normalize(node.textContent || ""))
      .filter((text) => /^error\s*-\s*/i.test(text))
      .map((text) => text.replace(/^error\s*-\s*/i, "").trim());
  }).catch(() => [] as string[]);

  return {
    domInvalidWidgetIds: planTargetedWidgetRetry(widgets, invalidIds),
    errorLabelMatchedWidgetIds: matchWorkdayInvalidWidgetIdsByErrorLabels(widgets, errorLabels)
  };
}

async function clickNextAndRecoverValidationByWidgets(input: {
  page: Page;
  currentStep: WorkdayStep;
  widgets: WorkdayWidgetSchema[];
  profile: import("./resolver.js").NormalizedWorkdayProfile;
  profileRaw: CandidateProfile;
  aiEngine: import("../../ai/engine.js").AnswerEngine;
  resumeText: string;
  jobContext: WorkdayJobContext;
  filledFields: import("../../core/types.js").FilledFieldRecord[];
  verifiedWidgetIds?: string[];
  notes?: string[];
}): Promise<RecoveryResult> {
  const { page, currentStep, widgets, profile, profileRaw, aiEngine, resumeText, jobContext, filledFields, verifiedWidgetIds, notes } = input;
  const beforeClick = await collectTransitionSnapshot(page, currentStep);
  const hasDeterministicTransition = nextStepMarkersFor(currentStep).length > 0;
  if (currentStep === "contact_information") {
    const contactAttempt = await attemptContactInformationContinue({
      page,
      currentStep,
      notes,
      allowSmsRetry: true
    });
    if (!contactAttempt.clicked) {
      return {
        advanced: false,
        validationErrors: ["continue_button_not_found"],
        recoveryAttempts: 0,
        unchangedSignature: false,
        currentStep,
        transitionFailureClass: "continue_button_not_found"
      };
    }
    if (contactAttempt.advanced) {
      return {
        advanced: true,
        validationErrors: [],
        recoveryAttempts: 0,
        unchangedSignature: false,
        currentStep: contactAttempt.currentStep
      };
    }
    const afterClick = await collectTransitionSnapshot(page, currentStep);
    await appendNoAdvanceDiagnostics(page, notes, beforeClick, afterClick);
    if (contactAttempt.networkError) {
      const failure = contactAttempt.smsRetryAttempted
        ? "continue_click_no_request_sms_retry_network_error"
        : "continue_request_network_error";
      return {
        advanced: false,
        validationErrors: [failure],
        recoveryAttempts: 0,
        unchangedSignature: false,
        currentStep,
        transitionFailureClass: failure
      };
    }
    if (!contactAttempt.requestFired) {
      return {
        advanced: false,
        validationErrors: [contactAttempt.smsRetryAttempted ? "continue_click_no_request_sms_retry_no_transition" : "continue_click_no_request"],
        recoveryAttempts: 0,
        unchangedSignature: false,
        currentStep,
        transitionFailureClass: contactAttempt.smsRetryAttempted ? "continue_click_no_request_sms_retry_no_transition" : "continue_click_no_request"
      };
    }
    if (contactAttempt.smsRetryAttempted) {
      return {
        advanced: false,
        validationErrors: ["continue_click_no_request_sms_retry_no_transition"],
        recoveryAttempts: 0,
        unchangedSignature: false,
        currentStep,
        transitionFailureClass: "continue_click_no_request_sms_retry_no_transition"
      };
    }
    if (!contactAttempt.visibleValidation) {
      return {
        advanced: false,
        validationErrors: ["continue_request_no_transition"],
        recoveryAttempts: 0,
        unchangedSignature: false,
        currentStep,
        transitionFailureClass: "continue_request_no_transition"
      };
    }
  } else if (currentStep === "self_identification") {
    const selfIdentAttempt = await attemptSelfIdentificationContinue({
      page,
      currentStep,
      notes
    });
    if (!selfIdentAttempt.clicked) {
      return {
        advanced: false,
        validationErrors: ["continue_button_not_found"],
        recoveryAttempts: 0,
        unchangedSignature: false,
        currentStep,
        transitionFailureClass: "continue_button_not_found"
      };
    }
    if (selfIdentAttempt.advanced) {
      return {
        advanced: true,
        validationErrors: [],
        recoveryAttempts: 0,
        unchangedSignature: false,
        currentStep: selfIdentAttempt.currentStep
      };
    }
    const afterClick = await collectTransitionSnapshot(page, currentStep);
    await appendNoAdvanceDiagnostics(page, notes, beforeClick, afterClick);
    if (selfIdentAttempt.networkError) {
      return {
        advanced: false,
        validationErrors: ["self_identification_request_error"],
        recoveryAttempts: 0,
        unchangedSignature: false,
        currentStep,
        transitionFailureClass: "self_identification_request_error"
      };
    }
    if (!selfIdentAttempt.requestFired) {
      return {
        advanced: false,
        validationErrors: ["self_identification_continue_no_request"],
        recoveryAttempts: 0,
        unchangedSignature: false,
        currentStep,
        transitionFailureClass: "self_identification_continue_no_request"
      };
    }
    if (!selfIdentAttempt.visibleValidation) {
      return {
        advanced: false,
        validationErrors: ["self_identification_request_no_transition"],
        recoveryAttempts: 0,
        unchangedSignature: false,
        currentStep,
        transitionFailureClass: "self_identification_request_no_transition"
      };
    }
  } else {
    notes?.push("workday_continue_click_method:bottom_navigation_next_button");
    const clicked = await clickNext(page);
    if (!clicked) {
      return {
        advanced: false,
        validationErrors: ["continue_button_not_found"],
        recoveryAttempts: 0,
        unchangedSignature: false,
        currentStep,
        transitionFailureClass: "continue_button_not_found"
      };
    }

    await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
    const markerAdvanced = hasDeterministicTransition ? await waitForExpectedTransitionMarker(page, currentStep, 5000) : false;
    if (markerAdvanced) {
      const nextStep = await waitForPageStep(page, currentStep, 2500);
      return {
        advanced: true,
        validationErrors: [],
        recoveryAttempts: 0,
        unchangedSignature: false,
        currentStep: nextStep
      };
    }

    const maybeNext = await waitForPageStep(page, currentStep, 3000);
    if (maybeNext !== currentStep && maybeNext !== "unknown") {
      return {
        advanced: true,
        validationErrors: [],
        recoveryAttempts: 0,
        unchangedSignature: false,
        currentStep: maybeNext
      };
    }

    if (!await hasVisibleWorkdayValidation(page, currentStep)) {
      const afterClick = await collectTransitionSnapshot(page, currentStep);
      await appendNoAdvanceDiagnostics(page, notes, beforeClick, afterClick);
      if (transitionSnapshotChangedMeaningfully(beforeClick, afterClick)) {
        notes?.push("workday_same_step_subpage_advanced:true");
        return {
          advanced: true,
          validationErrors: [],
          recoveryAttempts: 0,
          unchangedSignature: false,
          currentStep
        };
      }
      return {
        advanced: false,
        validationErrors: ["continue_click_no_transition"],
        recoveryAttempts: 0,
        unchangedSignature: false,
        currentStep,
        transitionFailureClass: "continue_click_no_transition"
      };
    }
  }

  if (currentStep === "contact_information") {
    const anchoredApplied = await recoverAnchoredContactFields(page, profile, notes);
    if (anchoredApplied > 0) {
      notes?.push("workday_continue_retry_click_method:bottom_navigation_next_button");
      const clickedAgain = await clickNext(page);
      if (!clickedAgain) {
        return {
          advanced: false,
          validationErrors: ["continue_button_not_found"],
          recoveryAttempts: 1,
          unchangedSignature: false,
          currentStep,
          transitionFailureClass: "continue_button_not_found"
        };
      }

      await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
      const retryAdvanced = hasDeterministicTransition ? await waitForExpectedTransitionMarker(page, currentStep, 5000) : false;
      if (retryAdvanced) {
        const nextStep = await waitForPageStep(page, currentStep, 2500);
        return {
          advanced: true,
          validationErrors: [],
          recoveryAttempts: 1,
          unchangedSignature: false,
          currentStep: nextStep
        };
      }

      const finalStep = await waitForPageStep(page, currentStep, 3000);
      if (finalStep !== currentStep && finalStep !== "unknown") {
        return {
          advanced: true,
          validationErrors: [],
          recoveryAttempts: 1,
          unchangedSignature: false,
          currentStep: finalStep
        };
      }

      const finalErrors = await collectValidationErrors(page);
      const afterClick = await collectTransitionSnapshot(page, currentStep);
      await appendNoAdvanceDiagnostics(page, notes, beforeClick, afterClick);
      return {
        advanced: false,
        validationErrors: finalErrors.length ? finalErrors : ["workday_visible_validation_failed"],
        recoveryAttempts: 1,
        unchangedSignature: false,
        currentStep,
        transitionFailureClass: "missing_required_field"
      };
    }
  }

  if (currentStep === "self_identification") {
    const validationErrors = await collectValidationErrors(page);
    if (validationErrors.some((error) => /\bdate\b/.test(normalizeText(error)))) {
      const dateRecovered = await fillSelfIdentificationDateField(page, notes).catch(() => false);
      if (dateRecovered) {
        notes?.push("workday_continue_retry_click_method:bottom_navigation_next_button");
        const clickedAgain = await clickNext(page);
        if (!clickedAgain) {
          return {
            advanced: false,
            validationErrors: ["continue_button_not_found"],
            recoveryAttempts: 1,
            unchangedSignature: false,
            currentStep,
            transitionFailureClass: "continue_button_not_found"
          };
        }

        await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
        const retryAdvanced = hasDeterministicTransition ? await waitForExpectedTransitionMarker(page, currentStep, 5000) : false;
        if (retryAdvanced) {
          const nextStep = await waitForPageStep(page, currentStep, 2500);
          return {
            advanced: true,
            validationErrors: [],
            recoveryAttempts: 1,
            unchangedSignature: false,
            currentStep: nextStep
          };
        }

        const finalStep = await waitForPageStep(page, currentStep, 3000);
        if (finalStep !== currentStep && finalStep !== "unknown") {
          return {
            advanced: true,
            validationErrors: [],
            recoveryAttempts: 1,
            unchangedSignature: false,
            currentStep: finalStep
          };
        }
      }
    }
  }

  if (shouldSkipWorkdayValidationRepass(currentStep)) {
    notes?.push(`workday_validation_repass_skipped:${currentStep}`);
    return {
      advanced: false,
      validationErrors: await collectValidationErrors(page),
      recoveryAttempts: 0,
      unchangedSignature: false,
      currentStep,
      transitionFailureClass: "missing_required_field"
    };
  }

  const latestWidgets = await extractWorkdayStepWidgets(page, currentStep);
  const invalidTargets = await collectInvalidWorkdayWidgetRetryTargets(page, latestWidgets);
  const invalidWidgetIds = planWorkdayRetryWidgetIds({
    widgets: latestWidgets,
    domInvalidWidgetIds: invalidTargets.domInvalidWidgetIds,
    errorLabelMatchedWidgetIds: invalidTargets.errorLabelMatchedWidgetIds,
    currentStep,
    lockedWidgetIds: verifiedWidgetIds
  });
  notes?.push(`workday_targeted_retry_dom_invalid_widget_ids:${invalidTargets.domInvalidWidgetIds.join(" | ")}`);
  notes?.push(`workday_targeted_retry_error_label_widget_ids:${invalidTargets.errorLabelMatchedWidgetIds.join(" | ")}`);
  notes?.push(`workday_targeted_retry_widget_ids:${invalidWidgetIds.join(" | ")}`);
  const retryWidgets = await hydrateRetryWidgetsWithLiveOptions(
    page,
    latestWidgets.filter((widget) => invalidWidgetIds.includes(widget.widgetId)),
    notes
  );
  if (!retryWidgets.length) {
    return {
      advanced: false,
      validationErrors: await collectValidationErrors(page),
      recoveryAttempts: 0,
      unchangedSignature: false,
      currentStep,
      transitionFailureClass: "missing_required_field"
    };
  }

  const deterministic = resolveWorkdayWidgetDeterministic(retryWidgets, profile, currentStep, {
    contextWidgets: latestWidgets,
    jobContext
  });
  const alias = resolveWorkdayWidgetAlias(
    retryWidgets.filter((widget) => !deterministic.has(widget.widgetId)),
    profile,
    currentStep,
    profileRaw,
    {
      contextWidgets: latestWidgets,
      jobContext
    }
  );
  const lockedWidgetPlan = new Map(deterministic);
  for (const [widgetId, answer] of alias.entries()) {
    if (!lockedWidgetPlan.has(widgetId)) lockedWidgetPlan.set(widgetId, answer);
  }
  const unresolved = retryWidgets.filter((widget) => !lockedWidgetPlan.has(widget.widgetId));
  const llmPlan = currentStep === "my_experience"
    ? []
    : await planWorkdayUnresolvedWidgets({
        unresolved: currentStep === "contact_information" ? unresolved.filter((widget) => widget.required) : unresolved,
        contextWidgets: latestWidgets,
        aiEngine,
        profile: profileRaw,
        resumeText,
        notes,
        jobContext
      });
  const retryPlan = mergeLockedWidgetAnswers(lockedWidgetPlan, llmPlan);
  const retryWidgetsById = new Map(retryWidgets.map((widget) => [widget.widgetId, widget]));
  const validatedRetryPlan = retryPlan.filter((answer) => {
    const widget = retryWidgetsById.get(answer.widgetId);
    if (!widget) return false;
    const validation = validateResolvedWorkdayWidgetAnswer(widget, answer);
    if (!validation.accepted) {
      notes?.push(`workday_widget_resolution_rejected:${JSON.stringify({
        widgetId: widget.widgetId,
        label: widget.label,
        widgetType: widget.widgetType,
        resolvedAnswer: Array.isArray(answer.value) ? answer.value.join(" / ") : String(answer.value ?? ""),
        possibleAnswers: widget.options,
        reason: validation.reason || "answer_not_in_options"
      })}`);
      return false;
    }
    answer.value = validation.value;
    return true;
  });
  for (const widget of retryWidgets) {
    notes?.push(`workday_validation_error_recovered:${normalizeText(widget.label)}`);
  }
  await executeWorkdayWidgetPlan({
    page,
    plan: validatedRetryPlan,
    widgets: retryWidgets,
    profile,
    currentStep,
    filledFields,
    notes,
    recoveryMode: true
  });

  notes?.push("workday_continue_retry_click_method:bottom_navigation_next_button");
  const clickedAgain = await clickNext(page);
  if (!clickedAgain) {
    return {
      advanced: false,
      validationErrors: ["continue_button_not_found"],
      recoveryAttempts: 1,
      unchangedSignature: false,
      currentStep,
      transitionFailureClass: "continue_button_not_found"
    };
  }

  await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
  const retryAdvanced = hasDeterministicTransition ? await waitForExpectedTransitionMarker(page, currentStep, 5000) : false;
  if (retryAdvanced) {
    const nextStep = await waitForPageStep(page, currentStep, 2500);
    return {
      advanced: true,
      validationErrors: [],
      recoveryAttempts: 1,
      unchangedSignature: false,
      currentStep: nextStep
    };
  }

  const finalStep = await waitForPageStep(page, currentStep, 3000);
  if (finalStep !== currentStep && finalStep !== "unknown") {
    return {
      advanced: true,
      validationErrors: [],
      recoveryAttempts: 1,
      unchangedSignature: false,
      currentStep: finalStep
    };
  }

  const finalErrors = await collectValidationErrors(page);
  const afterClick = await collectTransitionSnapshot(page, currentStep);
  await appendNoAdvanceDiagnostics(page, notes, beforeClick, afterClick);
  return {
    advanced: false,
    validationErrors: finalErrors.length ? finalErrors : ["workday_visible_validation_failed"],
    recoveryAttempts: 1,
    unchangedSignature: false,
    currentStep,
    transitionFailureClass: "missing_required_field"
  };
}

interface ErrorAnchorResolution {
  alertText: string;
  alertId: string;
  controlSelector: string;
  controlId: string;
  controlLabel: string;
  strategy: "aria_link" | "container_single_input" | "container_exact_label";
}

async function collectErrorAnchors(page: Page, step: WorkdayStep): Promise<ErrorAnchorResolution[]> {
  const activeSelector = await resolveActiveWorkdayContainerSelector(page, step);
  return page.evaluate((containerSelector) => {
    const norm = (v: string) => v.replace(/\s+/g, " ").trim().toLowerCase();
    const root = document.querySelector(containerSelector) || document.body;
    const alerts = Array.from(root.querySelectorAll<HTMLElement>("p[data-automation-id='inputAlert']"));
    const out: ErrorAnchorResolution[] = [];
    for (const alert of alerts) {
      const alertText = norm(alert.textContent || "");
      const alertId = alert.getAttribute("id") || "";
      let control: HTMLElement | null = null;
      let strategy: ErrorAnchorResolution["strategy"] | null = null;
      if (alertId) {
        control = root.querySelector<HTMLElement>(`[aria-describedby~="${alertId}"], [aria-errormessage~="${alertId}"]`);
        if (control) strategy = "aria_link";
      }
      const container = alert.closest("[data-automation-id^='formField-'], fieldset, div") || alert.parentElement;
      if (!control && container) {
        const fillables = Array.from(container.querySelectorAll<HTMLElement>("input:not([type='hidden']):not([type='checkbox']):not([type='radio']), textarea, [role='combobox']"));
        if (fillables.length === 1) {
          control = fillables[0]!;
          strategy = "container_single_input";
        } else if (fillables.length > 1 && alertText) {
          const exact = fillables.find((el) => {
            const id = el.getAttribute("id") || "";
            const label = id ? (container.querySelector(`label[for="${id}"]`)?.textContent || "") : (el.getAttribute("aria-label") || "");
            return norm(label) === alertText;
          });
          if (exact) {
            control = exact;
            strategy = "container_exact_label";
          }
        }
      }
      if (!control || !strategy) continue;
      const id = control.getAttribute("id") || "";
      const name = control.getAttribute("name") || "";
      const selector = id
        ? `${control.tagName.toLowerCase()}#${id.replace(/([.#:[\],= ])/g, "\\$1")}`
        : (name ? `${control.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]` : "");
      if (!selector) continue;
      const controlLabel = id
        ? norm((root.querySelector(`label[for="${id.replace(/"/g, '\\"')}"]`)?.textContent || ""))
        : norm(control.getAttribute("aria-label") || "");
      out.push({ alertText, alertId, controlSelector: selector, controlId: id, controlLabel, strategy });
    }
    return out;
  }, activeSelector);
}

async function recoverFromAnchoredWorkdayErrors(
  page: Page,
  step: WorkdayStep,
  profile: import("./resolver.js").NormalizedWorkdayProfile,
  notes?: string[]
): Promise<number> {
  const anchors = await collectErrorAnchors(page, step);
  let filled = 0;
  for (const a of anchors) {
    notes?.push(`workday_error_anchor_alert_text:${a.alertText}`);
    notes?.push(`workday_error_anchor_alert_id:${a.alertId}`);
    notes?.push(`workday_error_anchor_control_id:${a.controlId}`);
    notes?.push(`workday_error_anchor_label:${a.controlLabel}`);
    notes?.push(`workday_error_anchor_strategy:${a.strategy}`);

    let value: string | null = null;
    if (/father'?s family name/.test(a.alertText)) value = profile.identity.lastName;
    else if (/given name|first name/.test(a.alertText)) value = profile.identity.firstName;
    else if (/last name|family name|surname/.test(a.alertText)) value = profile.identity.lastName;
    if (!value) continue;
    const ok = await safeFill(page, a.controlSelector, value);
    if (ok) {
      filled += 1;
      notes?.push(`workday_error_anchor_filled_value:${normalizeText(value)}`);
    }
  }
  return filled;
}

function validateSelectedOptions(selected: string[], possible: string[]): { ok: boolean; picked: string[] } {
  if (!possible.length) return { ok: true, picked: selected };
  const exact: string[] = [];
  for (const s of selected) {
    const e = possible.find((p) => p === s);
    if (e) {
      exact.push(e);
      continue;
    }
    const n = possible.find((p) => normalizeOption(p) === normalizeOption(s));
    if (n) {
      exact.push(n);
      continue;
    }
    const f = possible.find((p) => normalizeOption(p).includes(normalizeOption(s)) || normalizeOption(s).includes(normalizeOption(p)));
    if (f) {
      exact.push(f);
      continue;
    }
    return { ok: false, picked: [] };
  }
  return { ok: true, picked: exact };
}

async function runRequiredQuestionnaireResolutionPass(input: {
  page: Page;
  schema: WorkdayFieldSchema[];
  profile: import("./resolver.js").NormalizedWorkdayProfile;
  profileRaw: CandidateProfile;
  aiEngine: import("../../ai/engine.js").AnswerEngine;
  resumeText: string;
  jobContext: WorkdayJobContext;
  currentStep: WorkdayStep;
  notes?: string[];
  questionnaireResolution?: QuestionnaireResolutionRecord[];
}): Promise<UnresolvedQuestionnaireRecord[]> {
  const unresolvedPayload: UnresolvedQuestionnaireRecord[] = [];
  const unresolvedFields = await collectRequiredUnresolvedQuestionnaireFields(input.page, input.schema, input.currentStep);
  for (const field of unresolvedFields) {
    input.notes?.push(`workday_unresolved_required_detected:${normalizeText(field.label)}`);
    input.notes?.push(`workday_unresolved_required_field_type:${field.fieldType}`);
    if (field.possibleAnswers.length) input.notes?.push(`workday_unresolved_required_possible_answers:${field.possibleAnswers.map((o) => normalizeText(o)).join(" | ")}`);

    const alias = resolveAliasField(field, input.profile);
    if (alias && alias.confidence !== "low" && alias.answer !== null) {
      const aliasValue = String(alias.answer);
      input.notes?.push(`workday_alias_resolved:${normalizeText(field.label)}:${normalizeText(aliasValue)}`);
      input.notes?.push(`workday_alias_confidence:${alias.confidence}`);
      const applyAlias = await applyResolvedQuestionWithStrategies(input.page, field, aliasValue);
      const verifyAlias = await verifyResolvedQuestion(input.page, field, aliasValue);
      if (applyAlias.applied && verifyAlias) {
        input.notes?.push(`workday_unresolved_required_filled:${normalizeText(field.label)}`);
        continue;
      }
    }

    input.notes?.push(`workday_llm_fallback_used:${normalizeText(field.label)}`);
    const legacyField: WorkdayQuestionnaireField = {
      fieldId: field.fieldId,
      labelText: field.label,
      inputKind: field.fieldType === "textarea" ? "textarea" : field.fieldType === "radio" ? "radio" : field.fieldType === "checkbox" || field.fieldType === "checkbox_group" ? "checkbox" : field.fieldType === "text" ? "text" : "dropdown",
      options: field.possibleAnswers,
      selector: field.selector,
      currentValue: field.currentValue,
      required: field.required
    };
    let resolution = await resolveQuestionnaireField({
      field: legacyField,
      profile: input.profile,
      profileRaw: input.profileRaw,
      aiEngine: input.aiEngine,
      resumeText: input.resumeText,
      jobContext: input.jobContext
    });
    if (!resolution.value || resolution.manualReview) {
      input.questionnaireResolution?.push(toQuestionnaireResolutionRecord(legacyField, resolution, {
        attemptedStrategies: [],
        applied: false,
        verified: false,
        failureReason: resolution.reason || "manual_review"
      }));
      unresolvedPayload.push({
        label: field.label,
        inputKind: legacyField.inputKind,
        options: field.possibleAnswers,
        currentValue: field.currentValue,
        attemptedStrategies: [],
        failureReason: resolution.reason || "manual_review"
      });
      continue;
    }

    const llmSelectedRaw = [String(resolution.value)];
    const validated = validateSelectedOptions(llmSelectedRaw, field.possibleAnswers);
    if (field.possibleAnswers.length && !validated.ok) {
      resolution = await resolveQuestionnaireField({
        field: legacyField,
        profile: input.profile,
        profileRaw: input.profileRaw,
        aiEngine: input.aiEngine,
        resumeText: input.resumeText,
        jobContext: input.jobContext
      });
      const retried = validateSelectedOptions([String(resolution.value || "")], field.possibleAnswers);
      if (!retried.ok) {
        input.notes?.push("workday_llm_answer_validated:false");
        unresolvedPayload.push({
          label: field.label,
          inputKind: legacyField.inputKind,
          options: field.possibleAnswers,
          currentValue: field.currentValue,
          attemptedStrategies: [],
          failureReason: "invalid_option_not_in_dom"
        });
        continue;
      }
      input.notes?.push(`workday_llm_selected_options:${retried.picked.map((o) => normalizeText(o)).join(" | ")}`);
      input.notes?.push("workday_llm_answer_validated:true");
      resolution.value = retried.picked[0] || String(resolution.value);
    } else {
      if (validated.picked.length) input.notes?.push(`workday_llm_selected_options:${validated.picked.map((o) => normalizeText(o)).join(" | ")}`);
      input.notes?.push("workday_llm_answer_validated:true");
      if (validated.picked[0]) resolution.value = validated.picked[0];
    }

    const applyResult = await applyResolvedQuestionWithStrategies(input.page, field, String(resolution.value));
    const applied = applyResult.applied;
    if (!applied) {
      input.questionnaireResolution?.push(toQuestionnaireResolutionRecord(legacyField, resolution, {
        attemptedStrategies: applyResult.attemptedStrategies,
        applied: false,
        verified: false,
        failureReason: "apply_failed"
      }));
      input.notes?.push(`workday_questionnaire_unresolved:${normalizeText(field.label)}:apply_failed`);
      continue;
    }
    const verified = await verifyResolvedQuestion(input.page, field, String(resolution.value));
    input.questionnaireResolution?.push(toQuestionnaireResolutionRecord(legacyField, resolution, {
      attemptedStrategies: applyResult.attemptedStrategies,
      applied: true,
      verified,
      failureReason: verified ? undefined : "verify_failed"
    }));
    if (!verified) {
      input.notes?.push(`workday_questionnaire_unresolved:${normalizeText(field.label)}:verify_failed`);
      unresolvedPayload.push({
        label: field.label,
        inputKind: legacyField.inputKind,
        options: field.possibleAnswers,
        currentValue: field.currentValue,
        attemptedStrategies: applyResult.attemptedStrategies,
        failureReason: "verify_failed"
      });
    } else {
      input.notes?.push(`workday_unresolved_required_filled:${normalizeText(field.label)}`);
    }
  }
  const rescan = await collectRequiredUnresolvedQuestionnaireFields(input.page, input.schema, input.currentStep);
  input.notes?.push(`workday_required_scan_after_fallback_count:${rescan.length}`);
  for (const field of rescan) {
    if (unresolvedPayload.some((u) => normalizeText(u.label) === normalizeText(field.label))) continue;
    const inputKind: WorkdayQuestionnaireField["inputKind"] =
      field.fieldType === "textarea" ? "textarea" :
      field.fieldType === "radio" ? "radio" :
      field.fieldType === "checkbox" || field.fieldType === "checkbox_group" ? "checkbox" :
      field.fieldType === "text" ? "text" : "dropdown";
    unresolvedPayload.push({
      label: field.label,
      inputKind,
      options: field.possibleAnswers,
      currentValue: field.currentValue,
      attemptedStrategies: [],
      failureReason: "still_unresolved_after_rescan"
    });
  }
  return unresolvedPayload;
}

export async function clickNextAndRecoverValidation(input: {
  page: Page;
  currentStep: WorkdayStep;
  schema?: WorkdayFieldSchema[];
  widgets?: WorkdayWidgetSchema[];
  profile: import("./resolver.js").NormalizedWorkdayProfile;
  profileRaw: CandidateProfile;
  aiEngine: import("../../ai/engine.js").AnswerEngine;
  resumeText: string;
  jobContext: WorkdayJobContext;
  filledFields: import("../../core/types.js").FilledFieldRecord[];
  verifiedWidgetIds?: string[];
  notes?: string[];
  logger?: AppLogger;
  questionnaireResolution?: QuestionnaireResolutionRecord[];
  unresolvedQuestionnaire?: UnresolvedQuestionnaireRecord[];
}): Promise<RecoveryResult> {
  const { page, currentStep, schema = [], widgets, profile, profileRaw, aiEngine, resumeText, jobContext, filledFields, verifiedWidgetIds, notes, logger, questionnaireResolution, unresolvedQuestionnaire } = input;
  if (widgets?.length) {
    return clickNextAndRecoverValidationByWidgets({
      page,
      currentStep,
      widgets,
      profile,
      profileRaw,
      aiEngine,
      resumeText,
      jobContext,
      filledFields,
      verifiedWidgetIds,
      notes
    });
  }
  const deferPreClickRecovery = currentStep === "contact_information";
  let unresolvedRequired: UnresolvedQuestionnaireRecord[] = [];
  let preNextScan: RequiredScanItem[] = [];

  if (!deferPreClickRecovery) {
    unresolvedRequired = await runRequiredQuestionnaireResolutionPass({
      page, schema, profile, profileRaw, aiEngine, resumeText, jobContext, currentStep, notes, questionnaireResolution
    });
    if (unresolvedRequired.length) {
      unresolvedQuestionnaire?.push(...unresolvedRequired);
    }
    preNextScan = await scanUnresolvedRequiredControls(page, currentStep);
    await remediateKnownContactRequired(page, currentStep, preNextScan, profile);
    await remediateKnownQuestionnaireRequired(page, currentStep, preNextScan, profile, notes);
    preNextScan = await scanUnresolvedRequiredControls(page, currentStep);
  }

  notes?.push(`workday_required_scan_count:${preNextScan.length}`);
  notes?.push(`workday_pre_next_unresolved_required_count:${preNextScan.length}`);
  if (preNextScan.length) notes?.push(`workday_pre_next_unresolved_required_labels:${preNextScan.map((x) => normalizeText(x.label)).join(" | ")}`);
  const activeInputAlertCount = await page.locator("p[data-automation-id='inputAlert']").count().catch(() => 0);
  notes?.push(`workday_active_input_alert_count:${activeInputAlertCount}`);
  const beforeClick = await collectTransitionSnapshot(page, currentStep);
  logRecoveryEvent(logger, "workday_transition_snapshot_before", { step: currentStep, snapshot: beforeClick });
  notes?.push(`workday_url_before:${page.url()}`);
  notes?.push(`workday_step_before:${currentStep}`);

  const hasDeterministicTransition = nextStepMarkersFor(currentStep).length > 0;
  const candidates = await collectFooterCandidates(page);
  notes?.push(`workday_footer_candidate_count:${candidates.length}`);
  for (const c of candidates.slice(0, 6)) {
    notes?.push(`workday_footer_candidate:${c.text}:aid=${c.automationId}:ariaDisabled=${c.ariaDisabled}:disabled=${c.disabled}:visible=${c.visible}:enabled=${c.enabled}:bbox=${c.bbox}:parent=${c.parentText}`);
  }
  const preferred = candidates.find((c) => c.visible && c.enabled && (c.automationId === "pageFooterNextButton" || /save and continue|continue|next/.test(c.text)));
  if (preferred) notes?.push(`workday_footer_selected_candidate:${preferred.text}:aid=${preferred.automationId}`);
  const visibleCandidates = candidates.filter((c) => c.visible);
  const enabledCandidates = visibleCandidates.filter((c) => c.enabled);
  if (visibleCandidates.length === 0) {
    notes?.push("workday_continue_failure_reason:continue_button_not_found");
    const afterClick = await collectTransitionSnapshot(page, currentStep);
    logRecoveryEvent(logger, "workday_transition_snapshot_after", { step: currentStep, snapshot: afterClick });
    return {
      advanced: false,
      validationErrors: ["continue_button_not_found"],
      recoveryAttempts: 0,
      unchangedSignature: false,
      currentStep,
      transitionFailureClass: "continue_button_not_found"
    };
  }
  if (enabledCandidates.length === 0) {
    notes?.push("workday_continue_failure_reason:continue_button_disabled");
    const afterClick = await collectTransitionSnapshot(page, currentStep);
    logRecoveryEvent(logger, "workday_transition_snapshot_after", { step: currentStep, snapshot: afterClick });
    return {
      advanced: false,
      validationErrors: ["continue_button_disabled"],
      recoveryAttempts: 0,
      unchangedSignature: false,
      currentStep,
      transitionFailureClass: "continue_button_disabled"
    };
  }
  const selected = preferred ?? enabledCandidates[0]!;
  const methods: Array<"normal" | "force" | "js" | "enter" | "space"> = ["normal", "force", "js", "enter", "space"];
  let nextClicked = false;
  let clickedAtLeastOnce = false;
  let clickFailedError = "";
  for (const method of methods) {
    notes?.push(`workday_continue_click_method:${method}`);
    const attempt = await attemptFooterClick(page, selected.selector, method);
    if (attempt.ok) clickedAtLeastOnce = true;
    if (!attempt.ok && attempt.error) {
      notes?.push(`workday_continue_click_error:${attempt.error}`);
      clickFailedError = attempt.error;
    }
    await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
    const deterministicAfterAttempt = hasDeterministicTransition
      ? await waitForExpectedTransitionMarker(page, currentStep, 3000)
      : false;
    const stepAfterAttempt = await waitForPageStep(page, currentStep, 1800);
    if (deterministicAfterAttempt || (stepAfterAttempt !== currentStep && stepAfterAttempt !== "unknown")) {
      nextClicked = true;
      break;
    }
    if (attempt.ok) {
      // We already clicked successfully; stop method escalation and let visible-validation recovery decide next steps.
      break;
    }
    notes?.push("workday_continue_clicked_but_no_transition");
  }
  logRecoveryEvent(logger, "workday_continue_click_plan", {
    step: currentStep,
    selectedFooter: selected,
    clickedAtLeastOnce,
    nextClicked,
    clickFailedError
  });
  if (!nextClicked && !clickedAtLeastOnce) {
    notes?.push("workday_continue_failure_reason:continue_click_failed");
    const afterClick = await collectTransitionSnapshot(page, currentStep);
    logRecoveryEvent(logger, "workday_transition_snapshot_after", { step: currentStep, snapshot: afterClick });
    notes?.push(`workday_url_after:${page.url()}`);
    notes?.push(`workday_step_after:${await detectWorkdayStep(page)}`);
    await appendNoAdvanceDiagnostics(page, notes, beforeClick, afterClick);
    return {
      advanced: false,
      validationErrors: ["continue_click_failed"],
      recoveryAttempts: 0,
      unchangedSignature: false,
      currentStep,
      transitionFailureClass: "continue_click_failed"
    };
  }

  await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
  const deterministicAdvanced = hasDeterministicTransition
    ? await waitForExpectedTransitionMarker(page, currentStep, 6000)
    : false;
  if (deterministicAdvanced) {
    const maybeNext = await waitForPageStep(page, currentStep, 2500);
    notes?.push(`workday_url_after:${page.url()}`);
    notes?.push(`workday_step_after:${maybeNext}`);
    return {
      advanced: true,
      validationErrors: [],
      recoveryAttempts: 0,
      unchangedSignature: false,
      currentStep: maybeNext
    };
  }

  const maybeNext = await waitForPageStep(page, currentStep, 3500);
  if (maybeNext !== currentStep && maybeNext !== "unknown") {
    notes?.push(`workday_url_after:${page.url()}`);
    notes?.push(`workday_step_after:${maybeNext}`);
    return {
      advanced: true,
      validationErrors: [],
      recoveryAttempts: 0,
      unchangedSignature: false,
      currentStep: maybeNext
    };
  }

  const visibleValidationAfterFirstClick = await hasVisibleWorkdayValidation(page, currentStep);
  if (deferPreClickRecovery) {
    unresolvedRequired = await runRequiredQuestionnaireResolutionPass({
      page, schema, profile, profileRaw, aiEngine, resumeText, jobContext, currentStep, notes, questionnaireResolution
    });
    if (unresolvedRequired.length) {
      unresolvedQuestionnaire?.push(...unresolvedRequired);
    }
    preNextScan = await scanUnresolvedRequiredControls(page, currentStep);
    await remediateKnownContactRequired(page, currentStep, preNextScan, profile);
    preNextScan = await scanUnresolvedRequiredControls(page, currentStep);
    notes?.push(`workday_required_scan_count_post_click:${preNextScan.length}`);
    if (preNextScan.length) notes?.push(`workday_post_click_unresolved_required_labels:${preNextScan.map((x) => normalizeText(x.label)).join(" | ")}`);
  }
  if (!visibleValidationAfterFirstClick) {
    if (preNextScan.length > 0) {
      notes?.push("workday_no_transition_with_unresolved_diagnostics=true");
      notes?.push(`workday_no_transition_recovery_labels:${preNextScan.map((x) => normalizeText(x.label)).join(" | ")}`);
      const recovered = await recoverFromDiagnosticRequiredFields(page, currentStep, preNextScan, profile, notes);
      notes?.push(`workday_no_transition_recovery_attempted:${recovered > 0}`);
      const clickedAgain = hasDeterministicTransition ? await clickFooterNext(page) : await clickNext(page);
      notes?.push(`workday_no_transition_recovery_clicked_again:${clickedAgain}`);
      if (clickedAgain) {
        const deterministicAfterDiagRetry = hasDeterministicTransition
          ? await waitForExpectedTransitionMarker(page, currentStep, 5000)
          : false;
        if (deterministicAfterDiagRetry) {
          const progressed = await waitForPageStep(page, currentStep, 2500);
          return {
            advanced: true,
            validationErrors: [],
            recoveryAttempts: 1,
            unchangedSignature: false,
            currentStep: progressed
          };
        }
        const maybeAfterRetry = await waitForPageStep(page, currentStep, 3500);
        if (maybeAfterRetry !== currentStep && maybeAfterRetry !== "unknown") {
          return {
            advanced: true,
            validationErrors: [],
            recoveryAttempts: 1,
            unchangedSignature: false,
            currentStep: maybeAfterRetry
          };
        }
      }
    }
    const afterClick = await collectTransitionSnapshot(page, currentStep);
    logRecoveryEvent(logger, "workday_transition_snapshot_after", { step: currentStep, snapshot: afterClick });
    await appendNoAdvanceDiagnostics(page, notes, beforeClick, afterClick);
    if (transitionSnapshotChangedMeaningfully(beforeClick, afterClick)) {
      notes?.push("workday_same_step_subpage_advanced:true");
      return {
        advanced: true,
        validationErrors: [],
        recoveryAttempts: 0,
        unchangedSignature: false,
        currentStep
      };
    }
    return {
      advanced: false,
      validationErrors: ["continue_click_no_transition"],
      recoveryAttempts: 0,
      unchangedSignature: false,
      currentStep,
      transitionFailureClass: "continue_click_no_transition"
    };
  }

  const refreshedStep = await detectWorkdayStep(page);
  if (refreshedStep !== currentStep && refreshedStep !== "unknown") {
    return {
      advanced: true,
      validationErrors: [],
      recoveryAttempts: 0,
      unchangedSignature: false,
      currentStep: refreshedStep
    };
  }
  if (shouldSkipWorkdayValidationRepass(refreshedStep)) {
    notes?.push(`workday_validation_repass_skipped:${refreshedStep}`);
    return {
      advanced: false,
      validationErrors: await collectValidationErrors(page),
      recoveryAttempts: 0,
      unchangedSignature: false,
      currentStep: refreshedStep,
      transitionFailureClass: "missing_required_field",
      unresolvedQuestionnaire: unresolvedRequired
    };
  }
  await recoverFromAnchoredWorkdayErrors(page, refreshedStep, profile, notes);
  const refreshedSchema = await extractWorkdayStepSchema(page, refreshedStep);
  unresolvedRequired = await runRequiredQuestionnaireResolutionPass({
    page,
    schema: refreshedSchema,
    profile,
    profileRaw,
    aiEngine,
    resumeText,
    jobContext,
    currentStep: refreshedStep,
    notes,
    questionnaireResolution
  });
  if (unresolvedRequired.length) unresolvedQuestionnaire?.push(...unresolvedRequired);
  const postQuestionnaireSchema = await extractWorkdayStepSchema(page, refreshedStep);
  const deterministic = resolveWorkdayDeterministic(postQuestionnaireSchema, profile, refreshedStep);
  const unresolved = postQuestionnaireSchema.filter((field) => !deterministic.has(field.fieldId));
  const llm = await planWorkdayUnresolvedFields({
    unresolved,
    aiEngine,
    profile: profileRaw,
    resumeText,
    jobContext
  });
  const plan: ResolvedAnswer[] = mergeLockedFirst(deterministic, llm);

  await executeWorkdayFillPlan({
    page,
    plan,
    schema: postQuestionnaireSchema,
    profile,
    currentStep: refreshedStep,
    filledFields,
    notes,
    recoveryMode: true
  });

  const clickedAgain = hasDeterministicTransition ? await clickFooterNext(page) : await clickNext(page);
  if (!clickedAgain) {
    const afterClick = await collectTransitionSnapshot(page, refreshedStep);
    logRecoveryEvent(logger, "workday_transition_snapshot_after", { step: refreshedStep, snapshot: afterClick });
    await appendNoAdvanceDiagnostics(page, notes, beforeClick, afterClick);
    return {
      advanced: false,
      validationErrors: ["continue_click_failed"],
      recoveryAttempts: 1,
      unchangedSignature: false,
      currentStep: refreshedStep,
      transitionFailureClass: "continue_click_failed",
      unresolvedQuestionnaire: unresolvedRequired
    };
  }

  const deterministicAfterRetry = nextStepMarkersFor(refreshedStep).length > 0
    ? await waitForExpectedTransitionMarker(page, refreshedStep, 5000)
    : false;
  if (deterministicAfterRetry) {
    const progressed = await waitForPageStep(page, refreshedStep, 2500);
    return {
      advanced: true,
      validationErrors: [],
      recoveryAttempts: 1,
      unchangedSignature: false,
      currentStep: progressed
    };
  }

  const afterRetry = await waitForPageStep(page, refreshedStep, 3500);
  if (afterRetry !== refreshedStep && afterRetry !== "unknown") {
    return {
      advanced: true,
      validationErrors: [],
      recoveryAttempts: 1,
      unchangedSignature: false,
      currentStep: afterRetry
    };
  }

  const visibleValidationAfterRetry = await hasVisibleWorkdayValidation(page, refreshedStep);
  const finalErrors = await collectValidationErrors(page);
  const afterClick = await collectTransitionSnapshot(page, refreshedStep);
  logRecoveryEvent(logger, "workday_transition_snapshot_after", { step: refreshedStep, snapshot: afterClick });
  await appendNoAdvanceDiagnostics(page, notes, beforeClick, afterClick);
  if (!visibleValidationAfterRetry) {
    if (transitionSnapshotChangedMeaningfully(beforeClick, afterClick)) {
      notes?.push("workday_same_step_subpage_advanced:true");
      return {
        advanced: true,
        validationErrors: [],
        recoveryAttempts: 1,
        unchangedSignature: false,
        currentStep: refreshedStep
      };
    }
    return {
      advanced: false,
      validationErrors: ["continue_click_no_transition"],
      recoveryAttempts: 1,
      unchangedSignature: false,
      currentStep: refreshedStep,
      transitionFailureClass: "continue_click_no_transition",
      unresolvedQuestionnaire: unresolvedRequired
    };
  }
  return {
    advanced: false,
    validationErrors: finalErrors.length ? finalErrors : ["workday_visible_validation_failed"],
    recoveryAttempts: 1,
    unchangedSignature: false,
    currentStep: refreshedStep,
    transitionFailureClass: "missing_required_field",
    unresolvedQuestionnaire: unresolvedRequired
  };
}
