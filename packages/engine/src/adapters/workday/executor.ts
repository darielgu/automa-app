import type { Locator, Page } from "playwright-core";
import type { AppLogger } from "../../core/logger.js";
import type { FilledFieldRecord, ResolvedAnswer } from "../../core/types.js";
import type { NormalizedWorkdayProfile, WorkdayWidgetAnswer } from "./resolver.js";
import { resolveWorkdayVoluntaryDisclosureOption } from "./resolver.js";
import { resolveActiveWorkdayContainerSelector, type WorkdayFieldSchema, type WorkdayWidgetSchema,
  detectWorkdayStep,
  hasVisibleWorkdayContainer
} from "./schema.js";
import { extractOptionsFromOpenDropdown, normalizeText, safeClick, safeFill } from "./navigation.js";

const WORKDAY_LANGUAGE_LABEL_PATTERNS: RegExp[] = [
  /\benglish\b/i,
  /\blanguage\b/i,
  /\bproficiency\b/i,
  /\bspeak\b.*\bread\b.*\bwrite\b/i
];

const WORKDAY_LANGUAGE_OPTION_PRIORITY = ["fluent", "native", "professional", "yes", "advanced", "english"];
const WORKDAY_STRONG_PROFICIENCY_PRIORITY = [
  "native",
  "fluent",
  "full professional",
  "professional",
  "highly proficient",
  "advanced",
  "expert",
  "yes",
  "english"
];

interface WorkdayExecutorRuntimeContext {
  step?: string;
  label?: string;
  selector?: string;
  lastAction?: string;
  notes?: string[];
}

const workdayExecutorRuntimeContext: WorkdayExecutorRuntimeContext = {};

export class WorkdayExecutorRuntimeError extends Error {
  readonly submitOutcome = "browser_context_closed" as const;
  readonly stage = "executor" as const;
  /** Why execution stopped. The two have completely different remedies. */
  readonly reason: "page_closed" | "step_container_gone";
  readonly step: string;
  readonly label: string;
  readonly lastAction: string;
  readonly selector: string;
  readonly url: string;

  constructor(input: {
    reason?: "page_closed" | "step_container_gone";
    step?: string;
    label?: string;
    lastAction?: string;
    selector?: string;
    url?: string;
  }) {
    super(input.reason === "step_container_gone" ? "workday_step_container_gone" : "workday_browser_context_closed");
    this.name = "WorkdayExecutorRuntimeError";
    this.reason = input.reason ?? "page_closed";
    this.step = input.step || "unknown";
    this.label = input.label || "";
    this.lastAction = input.lastAction || "";
    this.selector = input.selector || "";
    this.url = input.url || "";
  }
}

export function isWorkdayExecutorRuntimeError(error: unknown): error is WorkdayExecutorRuntimeError {
  return error instanceof WorkdayExecutorRuntimeError;
}

function setWorkdayExecutorRuntimeContext(patch: Partial<WorkdayExecutorRuntimeContext>): void {
  Object.assign(workdayExecutorRuntimeContext, patch);
}

function isPageClosedLikeError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message}\n${error.stack || ""}` : String(error || "");
  return /target page, context or browser has been closed|page\.waitfor|browser has been closed|context.*closed/i.test(message);
}

/**
 * @param reason What actually went wrong. This used to be assumed: every abort
 * reported "page closed", including the common case where the page was open and
 * only the step container had gone invisible. The URL was recorded in the same
 * breath, which contradicted the note it sat beside and sent anyone reading a
 * failed run looking for a crashed browser that never crashed.
 */
async function throwWorkdayExecutorRuntimeError(
  page: Page,
  reason: "page_closed" | "step_container_gone" = "page_closed"
): Promise<never> {
  const notes = workdayExecutorRuntimeContext.notes;
  const url = page.isClosed() ? "" : page.url();
  if (notes) {
    notes.push(reason === "page_closed" ? "workday_executor_page_closed" : "workday_executor_step_container_gone");
    if (workdayExecutorRuntimeContext.lastAction) notes.push(`workday_executor_last_action:${workdayExecutorRuntimeContext.lastAction}`);
    if (workdayExecutorRuntimeContext.label) notes.push(`workday_executor_last_widget_label:${workdayExecutorRuntimeContext.label}`);
    if (workdayExecutorRuntimeContext.selector) notes.push(`workday_executor_last_selector:${workdayExecutorRuntimeContext.selector}`);
    if (url) notes.push(`workday_runtime_url_before_failure:${url}`);
  }
  throw new WorkdayExecutorRuntimeError({
    reason,
    step: workdayExecutorRuntimeContext.step,
    label: workdayExecutorRuntimeContext.label,
    lastAction: workdayExecutorRuntimeContext.lastAction,
    selector: workdayExecutorRuntimeContext.selector,
    url
  });
}

async function ensureWorkdayExecutorReady(page: Page, action: string, selector?: string): Promise<void> {
  setWorkdayExecutorRuntimeContext({ lastAction: action, selector: selector || workdayExecutorRuntimeContext.selector });
  if (page.isClosed()) {
    await throwWorkdayExecutorRuntimeError(page);
  }
  const step = workdayExecutorRuntimeContext.step;
  if (!step) return;
  const activeSelector = await resolveActiveWorkdayContainerSelector(page, step as never).catch(() => "");
  if (!activeSelector) return;

  // Workday re-renders its step container on almost every interaction, so a
  // single instantaneous check catches it mid-swap and calls a healthy page
  // dead. Give it a moment to come back before concluding anything.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await hasVisibleWorkdayContainer(page.locator(activeSelector)).catch(() => false)) return;
    if (page.isClosed()) await throwWorkdayExecutorRuntimeError(page, "page_closed");
    await page.waitForTimeout(250);
  }

  // The container is gone for good. Before calling that a failure, ask why:
  // the usual reason is that the form was accepted and Workday moved to the
  // next step, which is the flow working, not breaking. Treating it as a fatal
  // error made every successful advance look like a crashed browser -- and the
  // remaining widgets of a step that no longer exists are moot either way.
  const currentStep = await detectWorkdayStep(page).catch(() => null);
  workdayExecutorRuntimeContext.notes?.push(
    `workday_step_recheck:${workdayExecutorRuntimeContext.step || "none"}->${currentStep || "none"}`
  );
  if (currentStep && currentStep !== workdayExecutorRuntimeContext.step) {
    workdayExecutorRuntimeContext.notes?.push(
      `workday_step_advanced_during_execution:${workdayExecutorRuntimeContext.step}->${currentStep}`
    );
    return;
  }

  await throwWorkdayExecutorRuntimeError(page, "step_container_gone");
}

async function withWorkdayExecutorGuard<T>(
  page: Page,
  action: string,
  selector: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  await ensureWorkdayExecutorReady(page, action, selector);
  try {
    return await fn();
  } catch (error) {
    if (isPageClosedLikeError(error) || page.isClosed()) {
      await throwWorkdayExecutorRuntimeError(page);
    }
    throw error;
  }
}

async function humanPause(page: Page, minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs + 1));
  await page.waitForTimeout(ms);
}

export function isLanguageQuestionnaireLegend(label: string): boolean {
  return WORKDAY_LANGUAGE_LABEL_PATTERNS.some((pattern) => pattern.test(label));
}

export function pickLanguageQuestionnaireOption(options: string[]): string | null {
  const normalized = options
    .map((option) => ({ raw: option, normalized: normalizeText(option) }))
    .filter((entry) => entry.normalized && entry.normalized !== "select one");

  for (const token of WORKDAY_LANGUAGE_OPTION_PRIORITY) {
    const matched = normalized.find((entry) => entry.normalized.includes(token));
    if (matched) return matched.raw;
  }

  return normalized[0]?.raw ?? null;
}

function pickLanguageIdentityOption(options: string[]): string | null {
  const normalized = options
    .map((option) => ({ raw: option, normalized: normalizeText(option) }))
    .filter((entry) => entry.normalized && entry.normalized !== "select one");
  const english = normalized.find((entry) => /\benglish\b/.test(entry.normalized));
  if (english) return english.raw;
  return normalized[0]?.raw ?? null;
}

function exactNormalizedOptionMatch(target: string, options: string[]): string | null {
  const wanted = normalizeText(target);
  const exact = options.find((option) => normalizeText(option) === wanted);
  return exact ?? null;
}

function normalizeLooseOptionText(value: string): string {
  return normalizeText(value)
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:or|and)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function optionTextLooselyMatches(current: string, expected: string): boolean {
  const normalizedCurrent = normalizeText(current);
  const normalizedExpected = normalizeText(expected);
  if (!normalizedCurrent || !normalizedExpected) return false;
  if (
    normalizedCurrent === normalizedExpected ||
    normalizedCurrent.includes(normalizedExpected) ||
    normalizedExpected.includes(normalizedCurrent)
  ) {
    return true;
  }

  const looseCurrent = normalizeLooseOptionText(current);
  const looseExpected = normalizeLooseOptionText(expected);
  if (!looseCurrent || !looseExpected) return false;
  return (
    looseCurrent === looseExpected ||
    looseCurrent.includes(looseExpected) ||
    looseExpected.includes(looseCurrent)
  );
}

function fuzzyOptionMatch(target: string, options: string[]): string | null {
  const wanted = normalizeText(target);
  const contains = options.find((option) => normalizeText(option).includes(wanted));
  if (contains) return contains;
  const reverse = options.find((option) => wanted.includes(normalizeText(option)));
  if (reverse) return reverse;
  return options.find((option) => optionTextLooselyMatches(option, target)) ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeSelectorId(value: string): string {
  return value.replace(/([.#:[\],= ])/g, "\\$1");
}

function exactIdSelector(value: string): string {
  return `[id="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}

function currentDateParts(): { month: string; day: string; year: string; formatted: string } {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const year = String(now.getFullYear());
  return { month, day, year, formatted: `${month}/${day}/${year}` };
}

export type ResolvedWorkdayFieldControlKind =
  | "native_select"
  | "prompt_input_select"
  | "radio_group"
  | "button_group"
  | "text_input"
  | "unknown";

export interface ResolvedWorkdayField {
  label: string;
  containerSelector: string;
  controlSelector: string;
  controlKind: ResolvedWorkdayFieldControlKind;
  optionSelectors?: Record<string, string>;
  dataAutomationId?: string;
}

interface SelfIdentificationDateTarget {
  containerSelector: string;
  inputSelector?: string;
  monthSelector?: string;
  daySelector?: string;
  yearSelector?: string;
  dateIconSelector?: string;
  alertSelector?: string;
}

function isPlaceholderOption(value: string): boolean {
  return /^(select one|choose one|please select|all|partial list \(first 500 entries\)|0 items selected|no items selected|no items\.?)$/i.test(normalizeText(value));
}

function isPhoneCodeOption(value: string): boolean {
  return /\(\+\d+\)/.test(value);
}

function isCompositeEnumeratedOption(value: string): boolean {
  return (value.match(/\b\d+\.\s/g) || []).length > 1;
}

function splitCompositeEnumeratedOptions(value: string): string[] {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (!isCompositeEnumeratedOption(normalized)) return [normalized];

  const parts = normalized
    .split(/\s+(?=\d+\.\s)/)
    .map((part) => part.replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean);
  return parts.length ? parts : [normalized];
}

function flattenSourceOptions(options: string[]): string[] {
  const flattened: string[] = [];
  for (const option of options) {
    for (const part of splitCompositeEnumeratedOptions(option)) {
      const value = part.replace(/\s+/g, " ").trim();
      if (!value) continue;
      if (flattened.some((existing) => normalizeText(existing) === normalizeText(value))) continue;
      flattened.push(value);
    }
  }
  return flattened;
}

function pickFirstUsableSourceOption(options: string[]): string | null {
  for (const raw of flattenSourceOptions(options)) {
    const value = raw.replace(/\s+/g, " ").trim();
    if (!value) continue;
    if (isPlaceholderOption(value)) continue;
    if (isPhoneCodeOption(value)) continue;
    if (/^how did you hear about us\??\*?$/i.test(value)) continue;
    return value;
  }
  return null;
}

function isUsableSourceOptionValue(option: string): boolean {
  return pickFirstUsableSourceOption([option]) !== null;
}

function isWorkdaySourceQuestionKey(label: string, automationId = ""): boolean {
  const key = normalizeText(`${label} ${automationId}`);
  return /how did you hear about us|how did you hear about this job|how did you learn about this opportunity|application source|referral source|job source|^source$/.test(key);
}

function isSourceOtherOption(option: string): boolean {
  return /(^|\b)other(\b|$)/.test(normalizeText(option));
}

function pickExactSourceOption(options: string[], preferredValue: string): string | null {
  const visible = Array.from(new Set(options.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean)));
  const exact = exactNormalizedOptionMatch(preferredValue, visible);
  if (exact) return exact;
  const token = normalizeText(preferredValue);
  return visible.find((option) => normalizeText(option).includes(token) || token.includes(normalizeText(option))) || null;
}

export function pickBestRuntimeSourceOption(options: string[], preferredValue: string): string | null {
  const visible = Array.from(new Set(options.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean)));
  if (!visible.length) return null;

  const exact = pickExactSourceOption(visible, preferredValue);
  if (exact) return exact;
  return pickFirstUsableSourceOption(visible);
}

async function maybeFillSourceOtherDetails(
  page: Page,
  containerSelector: string | undefined,
  controlSelector: string | undefined,
  text: string
): Promise<boolean> {
  if (!containerSelector || !text) return false;
  const container = page.locator(containerSelector).first();
  if (!await container.isVisible().catch(() => false)) return false;
  const fields = container.locator("input:not([type='hidden']):not([type='radio']):not([type='checkbox']), textarea");
  const count = await fields.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const field = fields.nth(i);
    const selector = await field.evaluate((element) => {
      const id = String(element.getAttribute("id") || "").trim();
      if (id) return `[id="${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
      return "";
    }).catch(() => "");
    if (controlSelector && selector && selector === controlSelector) continue;
    if (!await field.isVisible().catch(() => false)) continue;
    const value = await field.inputValue().catch(() => "");
    if (value.trim()) continue;
    const filled = await field.fill(text).then(() => true).catch(() => false);
    if (!filled) continue;
    await page.keyboard.press("Tab").catch(() => undefined);
    await page.waitForTimeout(150);
    const verified = await field.inputValue().then((current) => normalizeText(current).includes(normalizeText(text))).catch(() => false);
    if (verified) return true;
  }
  return false;
}

async function commitSourceOption(page: Page, field: ResolvedWorkdayField, choice: string): Promise<boolean> {
  const control = page.locator(field.controlSelector).first();
  const tag = await control.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
  return (tag === "input" || tag === "textarea")
    ? fillWorkdaySourcePrompt(page, field.controlSelector, choice)
    : applyResolvedFieldChoice(page, field, choice, true);
}

function isSourceContactQuestion(label: string, automationId = ""): boolean {
  const key = normalizeText(`${label} ${automationId}`);
  return /how did you hear|application source|\bsource\b/.test(key);
}

function isPriorCompanyContactQuestion(label: string, automationId = ""): boolean {
  const key = normalizeText(`${label} ${automationId}`);
  return /candidateispreviousworker|currently or have you ever worked|have you ever worked for|previous worker|previously employed|previously worked (?:at|for)|former employee|current employee|employee or contractor|current or former employee/.test(key);
}

function exactOptionMatch(target: string, options: string[]): string | null {
  const wanted = normalizeText(target);
  return options.find((option) => normalizeText(option) === wanted) || null;
}

function fuzzyOptionMatchInList(target: string, options: string[]): string | null {
  const wanted = normalizeText(target);
  const direct = options.find((option) => normalizeText(option).includes(wanted) || wanted.includes(normalizeText(option)));
  if (direct) return direct;
  return options.find((option) => optionTextLooselyMatches(option, target)) || null;
}

export function pickPreferredOption(options: string[], preferred: string[]): string | null {
  const visible = Array.from(new Set(options.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean)))
    .filter((value) => !/^(select one|all|partial list \(first 500 entries\)|no items\.?)$/i.test(normalizeText(value)));
  if (!visible.length) return null;

  for (const candidate of preferred) {
    const exact = exactOptionMatch(candidate, visible);
    if (exact) return exact;
    const fuzzy = fuzzyOptionMatchInList(candidate, visible);
    if (fuzzy) return fuzzy;
  }

  return null;
}

function deriveCompanyNameFromLabel(label: string): string | null {
  const candidate = label.match(/worked at\s+([^?*]+)/i)?.[1] ||
    label.match(/worked for\s+([^?*]+)/i)?.[1] ||
    label.match(/current employee of\s+([^?*]+)/i)?.[1] ||
    "";
  if (candidate) {
    const simplified = candidate
      .replace(/\s+as\s+an?\s+employee.*$/i, "")
      .replace(/\s+as\s+an?\s+contractor.*$/i, "")
      .replace(/\s+as\s+.*$/i, "")
      .replace(/\s+or\s+any\s+of\s+their.*$/i, "")
      .replace(/\s+or\s+its.*$/i, "")
      .replace(/\s+or\s+any\s+affiliate.*$/i, "")
      .split(/,|\/|\(|\)/)[0]
      ?.trim();
    if (simplified) return simplified;
  }
  return null;
}

function profileShowsPriorCompany(profile: NormalizedWorkdayProfile, companyName: string | null): boolean {
  const target = normalizeText(companyName || "");
  if (!target) return false;
  return profile.experience.some((entry) => {
    const company = normalizeText(entry.company || "");
    return company === target || company.includes(target) || target.includes(company);
  });
}

function chooseContainerFieldSelector(root: Element, selectorFor: (element: HTMLElement, preferInput?: boolean) => string): string {
  if (root instanceof HTMLElement) {
    const own = selectorFor(root);
    if (own) return own;
  }
  const fallback = root.querySelector<HTMLElement>("select, input, textarea, button, [role='combobox'], [role='radio']");
  return fallback ? selectorFor(fallback, fallback.tagName.toLowerCase() === "input") : "";
}

async function buildResolvedFieldFromContainer(container: Locator, labelHint?: string): Promise<ResolvedWorkdayField | null> {
  return container.evaluate((root, expectedLabel) => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const selectorFor = (control: HTMLElement, preferInput = false): string => {
      const id = normalize(control.getAttribute("id") || "");
      if (id) return `${control.tagName.toLowerCase()}#${id.replace(/([.#:[\],= ])/g, "\\$1")}`;
      const dataAutomationId = normalize(control.getAttribute("data-automation-id") || "");
      if (dataAutomationId) return `${control.tagName.toLowerCase()}[data-automation-id="${dataAutomationId.replace(/"/g, '\\"')}"]`;
      const name = normalize(control.getAttribute("name") || "");
      if (name) return `${preferInput ? "input" : control.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`;
      return "";
    };
    const chooseContainerSelector = (node: HTMLElement): string => {
      const own = selectorFor(node);
      if (own) return own;
      const fallback = node.querySelector<HTMLElement>("select, input, textarea, button, [role='combobox'], [role='radio']");
      return fallback ? selectorFor(fallback, fallback.tagName.toLowerCase() === "input") : "";
    };
    const optionSelectors: Record<string, string> = {};
    const rootEl = root as HTMLElement;
    const label = normalize(
      expectedLabel ||
      rootEl.querySelector("legend, [data-automation-id='formLabel'], [data-automation-id*='richText'], label, h1, h2, h3, h4, h5")?.textContent ||
      rootEl.textContent ||
      ""
    );
    const containerSelector = chooseContainerSelector(rootEl);
    if (!containerSelector) return null;

    const select = rootEl.querySelector<HTMLSelectElement>("select");
    if (visible(select)) {
      return {
        label,
        containerSelector,
        controlSelector: selectorFor(select),
        controlKind: "native_select" as const,
        dataAutomationId: normalize(select.getAttribute("data-automation-id") || undefined)
      };
    }

    const radios = Array.from(rootEl.querySelectorAll<HTMLInputElement>("input[type='radio']")).filter((node) => visible(node));
    if (radios.length) {
      for (const radio of radios) {
        const id = radio.getAttribute("id") || "";
        const optionLabel = normalize(
          (id ? rootEl.querySelector(`label[for="${id.replace(/"/g, '\\"')}"]`)?.textContent : "") ||
          radio.closest("label")?.textContent ||
          radio.getAttribute("aria-label") ||
          radio.value
        );
        const selector = selectorFor(radio, true);
        if (optionLabel && selector) optionSelectors[optionLabel] = selector;
      }
      return {
        label,
        containerSelector,
        controlSelector: selectorFor(radios[0]!, true),
        controlKind: "radio_group" as const,
        optionSelectors,
        dataAutomationId: normalize(radios[0]!.getAttribute("data-automation-id") || undefined)
      };
    }

    const buttonOptions = Array.from(rootEl.querySelectorAll<HTMLElement>("button, [role='radio'], [role='button']")).filter((node) => {
      const key = normalize(node.textContent || node.getAttribute("aria-label") || "");
      return visible(node) && key && !/^(next|continue|submit|save and continue)$/.test(key.toLowerCase());
    });
    if (buttonOptions.length > 1) {
      for (const button of buttonOptions) {
        const optionLabel = normalize(button.textContent || button.getAttribute("aria-label") || "");
        const selector = selectorFor(button);
        if (optionLabel && selector) optionSelectors[optionLabel] = selector;
      }
      return {
        label,
        containerSelector,
        controlSelector: selectorFor(buttonOptions[0]!),
        controlKind: "button_group" as const,
        optionSelectors,
        dataAutomationId: normalize(buttonOptions[0]!.getAttribute("data-automation-id") || undefined)
      };
    }

    const prompt = rootEl.querySelector<HTMLElement>("[role='combobox'], input, textarea, button[aria-haspopup='listbox'], button[data-automation-id]");
    if (visible(prompt)) {
      const tag = prompt.tagName.toLowerCase();
      const role = normalize(prompt.getAttribute("role") || "");
      const isPrompt = role === "combobox" || tag === "button" || Boolean(prompt.getAttribute("aria-haspopup"));
      return {
        label,
        containerSelector,
        controlSelector: selectorFor(prompt, tag === "input"),
        controlKind: isPrompt ? ("prompt_input_select" as const) : ("text_input" as const),
        dataAutomationId: normalize(prompt.getAttribute("data-automation-id") || undefined)
      };
    }

    return {
      label,
      containerSelector,
      controlSelector: containerSelector,
      controlKind: "unknown" as const
    };
  }, labelHint).catch(() => null);
}

function fieldOptionSelector(field: ResolvedWorkdayField, value: string): string | null {
  const options = Object.entries(field.optionSelectors || {});
  const exact = options.find(([label]) => normalizeText(label) === normalizeText(value));
  if (exact) return exact[1];
  const fuzzy = options.find(([label]) => normalizeText(label).includes(normalizeText(value)) || normalizeText(value).includes(normalizeText(label)));
  return fuzzy?.[1] || null;
}

async function clickFieldOptionByText(page: Page, field: ResolvedWorkdayField, value: string): Promise<boolean> {
  const scope = page.locator(field.containerSelector).first();
  const escaped = new RegExp(`^${escapeRegExp(value)}$`, "i");

  const labelClick = await withWorkdayExecutorGuard(page, "click_field_option_exact", field.containerSelector, async () =>
    scope.locator("label, button, [role='radio'], [role='button'], option").filter({ hasText: escaped }).first()
      .click({ force: true, timeout: 1500 })
      .then(() => true)
      .catch(() => false)
  );
  if (labelClick) return true;

  return withWorkdayExecutorGuard(page, "click_field_option_fuzzy", field.containerSelector, async () =>
    scope.locator("label, button, [role='radio'], [role='button'], option").filter({ hasText: new RegExp(escapeRegExp(value), "i") }).first()
      .click({ force: true, timeout: 1500 })
      .then(() => true)
      .catch(() => false)
  );
}

async function detectResolvedFieldKind(page: Page, field: ResolvedWorkdayField): Promise<ResolvedWorkdayFieldControlKind> {
  if (field.controlKind !== "unknown") return field.controlKind;
  if (!field.controlSelector) return "unknown";
  return page.locator(field.controlSelector).first().evaluate((element) => {
    const tag = element.tagName.toLowerCase();
    const role = (element.getAttribute("role") || "").toLowerCase();
    if (tag === "select") return "native_select";
    if (role === "combobox" || tag === "button" || element.getAttribute("aria-haspopup")) return "prompt_input_select";
    if (tag === "input" || tag === "textarea") return "text_input";
    return "unknown";
  }).catch(() => "unknown" as ResolvedWorkdayFieldControlKind);
}

async function verifyFieldSelection(page: Page, field: ResolvedWorkdayField, chosen: string): Promise<boolean> {
  const scope = page.locator(field.containerSelector).first();
  const normalizedChosen = normalizeText(chosen);
  const kind = await detectResolvedFieldKind(page, field);

  if (kind === "native_select") {
    return scope.locator("select").first().evaluate((element, expected) => {
      const select = element as HTMLSelectElement;
      const label = select.selectedOptions?.[0]?.textContent || select.value || "";
      return label.replace(/\s+/g, " ").trim().toLowerCase().includes(String(expected).toLowerCase());
    }, normalizedChosen).catch(() => false);
  }

  if (kind === "radio_group") {
    const selector = fieldOptionSelector(field, chosen);
    if (!selector) return false;
    return page.locator(selector).first().isChecked().catch(() => false);
  }

  if (kind === "button_group") {
    return scope.evaluate((root, expected) => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
      const nodes = Array.from(root.querySelectorAll<HTMLElement>("button, [role='radio'], [role='button']"));
      return nodes.some((node) => {
        const text = normalize(node.textContent || node.getAttribute("aria-label") || "");
        if (!text.includes(String(expected))) return false;
        return node.getAttribute("aria-checked") === "true" || node.getAttribute("aria-pressed") === "true" || node.classList.contains("selected");
      });
    }, normalizedChosen).catch(() => false);
  }

  if (field.controlSelector) {
    const control = page.locator(field.controlSelector).first();
    const state = await control.evaluate((element) => {
      const ownText = (element.textContent || "").replace(/\s+/g, " ").trim();
      const inputValue = "value" in element ? String((element as HTMLInputElement).value || "") : "";
      const parent = element.parentElement;
      const selectionLabel = parent?.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent?.replace(/\s+/g, " ").trim() || "";
      return `${ownText} ${inputValue} ${selectionLabel}`.replace(/\s+/g, " ").trim().toLowerCase();
    }).catch(() => "");
    if (state.includes(normalizedChosen)) return true;
  }

  return scope.innerText().then((text) => normalizeText(text).includes(normalizedChosen)).catch(() => false);
}

async function verifyAnyCommittedFieldSelection(page: Page, field: ResolvedWorkdayField): Promise<boolean> {
  const scope = page.locator(field.containerSelector).first();
  const kind = await detectResolvedFieldKind(page, field);

  if (kind === "native_select") {
    return scope.locator("select").first().evaluate((element) => {
      const select = element as HTMLSelectElement;
      const label = (select.selectedOptions?.[0]?.textContent || select.value || "").replace(/\s+/g, " ").trim().toLowerCase();
      return Boolean(label) && !/^(select one|choose one|please select|search|add|upload)$/.test(label);
    }).catch(() => false);
  }

  if (field.controlSelector) {
    const promptState = await readPromptCommittedState(page, field.controlSelector);
    if (kind === "prompt_input_select") {
      if (isSourceContactQuestion(field.label, field.dataAutomationId || "")) {
        return isCommittedSourcePromptState(promptState);
      }
      if (committedPromptStateParts(promptState).some((part) => isCommittedPromptSelectionText(part))) return true;
    } else {
      const state = `${promptState.ownText} ${promptState.inputValue} ${promptState.selectionLabel}`.replace(/\s+/g, " ").trim().toLowerCase();
      if (state && !/^(select one|choose one|please select|search|add|upload)$/.test(state)) return true;
    }
  }

  if (isSourceContactQuestion(field.label, field.dataAutomationId || "")) return false;

  const text = await scope.innerText().then((value) => normalizeText(value).toLowerCase()).catch(() => "");
  return Boolean(text) && !/select one|choose one|please select/.test(text);
}

async function applyResolvedFieldChoice(page: Page, field: ResolvedWorkdayField, chosen: string, sourcePrompt = false): Promise<boolean> {
  const kind = await detectResolvedFieldKind(page, field);
  switch (kind) {
    case "native_select": {
      const select = page.locator(field.controlSelector).first();
      const applied = await select.selectOption({ label: chosen }).then(() => true).catch(() => false) ||
        await select.selectOption({ value: chosen }).then(() => true).catch(() => false);
      return applied && await verifyFieldSelection(page, field, chosen);
    }
    case "prompt_input_select": {
      if (!field.controlSelector) return false;
      const control = page.locator(field.controlSelector).first();
      const tag = await control.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
      const applied = tag === "button"
        ? await fillWorkdayDropdown(page, field.controlSelector, chosen)
        : sourcePrompt
          ? await fillWorkdaySourcePrompt(page, field.controlSelector, chosen)
          : await fillWorkdayDropdown(page, field.controlSelector, chosen);
      return applied && await verifyFieldSelection(page, field, chosen);
    }
    case "radio_group": {
      const selector = fieldOptionSelector(field, chosen);
      const clicked = selector ? await clickOptionSelector(page, selector) : await clickFieldOptionByText(page, field, chosen);
      return clicked && await verifyFieldSelection(page, field, chosen);
    }
    case "button_group": {
      const selector = fieldOptionSelector(field, chosen);
      const clicked = selector ? await safeClick(page, selector) : await clickFieldOptionByText(page, field, chosen);
      return clicked && await verifyFieldSelection(page, field, chosen);
    }
    case "text_input": {
      const filled = await safeFill(page, field.controlSelector, chosen);
      if (filled) await page.keyboard.press("Tab").catch(() => undefined);
      return filled && await verifyFieldSelection(page, field, chosen);
    }
    default:
      return false;
  }
}

async function openResolvedFieldPrompt(page: Page, field: ResolvedWorkdayField): Promise<void> {
  if (!field.controlSelector) return;
  const control = page.locator(field.controlSelector).first();
  await withWorkdayExecutorGuard(page, "open_resolved_field_prompt", field.controlSelector, async () => {
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(100);
    await control.click().catch(() => undefined);
    await control.press("ArrowDown").catch(() => undefined);
    await page.waitForTimeout(220);
  });
}

async function extractPromptOptionsForField(page: Page, field: ResolvedWorkdayField): Promise<string[]> {
  if (!field.controlSelector) return [];
  const control = page.locator(field.controlSelector).first();
  if (!await control.isVisible().catch(() => false)) return [];

  await withWorkdayExecutorGuard(page, "extract_prompt_options_open", field.controlSelector, async () => {
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(100);
    await control.scrollIntoViewIfNeeded().catch(() => undefined);
    await control.click().catch(() => undefined);
    await page.waitForTimeout(120);
    await control.press("ArrowDown").catch(() => undefined);
    await page.waitForTimeout(220);
  });

  const options = await withWorkdayExecutorGuard(page, "extract_prompt_options_scoped", field.controlSelector, async () =>
    extractScopedDropdownOptions(page, control).catch(() => [] as string[])
  );
  const visible = Array.from(new Set(options.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean)));
  if (visible.length) return visible;

  return withWorkdayExecutorGuard(page, "extract_prompt_options_open_dropdown", field.controlSelector, async () =>
    extractOptionsFromOpenDropdown(page).catch(() => [] as string[])
  );
}

async function chooseFirstVisibleFieldOption(page: Page, field: ResolvedWorkdayField): Promise<string | null> {
  const kind = await detectResolvedFieldKind(page, field);
  if (kind === "native_select") {
    const options = await extractVisibleOptions(page, field);
    const picked = options.find((value) => !isPlaceholderOption(value)) || null;
    if (!picked) return null;
    const select = page.locator(field.controlSelector).first();
    const applied = await select.selectOption({ label: picked }).then(() => true).catch(() => false) ||
      await select.selectOption({ value: picked }).then(() => true).catch(() => false);
    return applied ? picked : null;
  }

  if (kind === "radio_group" || kind === "button_group") {
    const options = await extractVisibleOptions(page, field);
    const picked = options.find((value) => !isPlaceholderOption(value)) || null;
    if (!picked) return null;
    const applied = await applyResolvedFieldChoice(page, field, picked);
    return applied ? picked : null;
  }

  const options = await extractPromptOptionsForField(page, field);
  const picked = options.find((value) => !isPlaceholderOption(value)) || null;
  if (!picked) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return null;
  }

  const chosen = await chooseExactOpenWorkdayOption(page, picked).catch(() => false) ||
    await chooseOpenWorkdayOption(page, picked).catch(() => false);
  if (!chosen) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return null;
  }
  await page.waitForTimeout(180);
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(150);
  return await verifyFieldSelection(page, field, picked) ? picked : null;
}

export async function extractVisibleOptions(page: Page, fieldOrContainer: ResolvedWorkdayField | string): Promise<string[]> {
  const field = typeof fieldOrContainer === "string" ? await findFieldNearLabel(page, fieldOrContainer) : fieldOrContainer;
  if (!field) return [];

  const kind = await detectResolvedFieldKind(page, field);
  if (kind === "native_select") {
    // textContent, not innerText. An <option> inside a closed <select> is not
    // rendered, so innerText is "" for every one of them -- which read as "this
    // field has no options" and left the answer engine nothing to choose from.
    return withWorkdayExecutorGuard(page, "extract_visible_options_native_select", field.controlSelector, async () =>
      page.locator(field.controlSelector).first().evaluate((element) => {
        const select = element as HTMLSelectElement;
        return Array.from(select.options)
          // The leading placeholder is not an answer. Workday writes it as an
          // empty value, whatever the label happens to say.
          .filter((option) => option.value !== "")
          .map((option) => (option.textContent || option.value || "").replace(/\s+/g, " ").trim())
          .filter(Boolean);
      })
        .then((values) => Array.from(new Set(values)))
        .catch(() => [] as string[])
    );
  }

  if (kind === "radio_group" || kind === "button_group") {
    return Array.from(new Set(Object.keys(field.optionSelectors || {}).map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean)));
  }

  if (kind === "prompt_input_select") {
    const options = await extractPromptOptionsForField(page, field);
    if (options.length) return options;
  }

  return withWorkdayExecutorGuard(page, "extract_visible_options_container", field.containerSelector, async () => page.locator(field.containerSelector).first().evaluate((root) => {
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const values = Array.from(root.querySelectorAll<HTMLElement>("option, label, button, [role='option'], [role='radio'], [role='button']"))
      .filter((node) => visible(node))
      .map((node) => (node.textContent || node.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    return Array.from(new Set(values));
  }).catch(() => [] as string[]));
}

export async function fillSourceQuestion(
  page: Page,
  field: ResolvedWorkdayField,
  preferredValue = "LinkedIn",
  preloadedOptions?: string[]
): Promise<boolean> {
  const trySourceField = async (candidateField: ResolvedWorkdayField, optionsHint?: string[]): Promise<boolean> => {
    if (await verifyAnyCommittedFieldSelection(page, candidateField).catch(() => false)) return true;
    const seededOptions = flattenSourceOptions(optionsHint || []).filter((option) => isUsableSourceOptionValue(option));
    const options = seededOptions.length
      ? seededOptions
      : flattenSourceOptions(await extractVisibleOptions(page, candidateField)).filter((option) => isUsableSourceOptionValue(option));
    const preferredChoice = pickExactSourceOption(options, preferredValue) || pickBestRuntimeSourceOption(options, preferredValue);
    if (!preferredChoice) {
      const arbitraryChoice = await chooseFirstVisibleFieldOption(page, candidateField);
      return Boolean(arbitraryChoice);
    }
    if (await verifyAnyCommittedFieldSelection(page, candidateField).catch(() => false)) return true;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const committed = await commitSourceOption(page, candidateField, preferredChoice);
      if (!committed) continue;
      await page.waitForTimeout(220);
      if (await verifyAnyCommittedFieldSelection(page, candidateField)) return true;
    }

    const arbitraryChoice = await chooseFirstVisibleFieldOption(page, candidateField);
    if (arbitraryChoice && await verifyAnyCommittedFieldSelection(page, candidateField).catch(() => false)) return true;

    return false;
  };

  if (await trySourceField(field, preloadedOptions)) return true;

  const anchored = isSourceContactQuestion(field.label, field.dataAutomationId || "")
    ? await findFieldNearLabel(page, "How Did You Hear About Us?")
    : null;
  if (!anchored || anchored.controlSelector === field.controlSelector) return false;
  return trySourceField(anchored);
}

export async function fillPriorCompanyQuestion(
  page: Page,
  field: ResolvedWorkdayField,
  companyName: string | null,
  profile: NormalizedWorkdayProfile,
  preloadedOptions?: string[]
): Promise<boolean> {
  const workedThere = profileShowsPriorCompany(profile, companyName);
  const preferred = workedThere
    ? ["Yes", "Yes, I have", "Previously worked"]
    : ["No", "No, I have not", "Never"];
  const options = preloadedOptions?.length ? preloadedOptions : await extractVisibleOptions(page, field);
  const chosen = pickPreferredOption(options, preferred) || preferred[0]!;
  return applyResolvedFieldChoice(page, field, chosen);
}

export async function findFieldNearLabel(page: Page, label: string): Promise<ResolvedWorkdayField | null> {
  const activeSelector = await resolveActiveWorkdayContainerSelector(page, "contact_information");
  const normalizedLabel = normalizeText(label).replace(/^error[:\s-]*/i, "").replace(/\*+$/, "").trim();
  const labelPattern = new RegExp(`^\\s*${escapeRegExp(normalizedLabel)}\\s*\\*?\\s*$`, "i");

  const directLabel = page.locator(activeSelector).locator("label, legend, [data-automation-id='formLabel'], [data-automation-id*='richText'], h1, h2, h3, h4, h5")
    .filter({ hasText: labelPattern })
    .first();
  if (await directLabel.isVisible().catch(() => false)) {
    const containerSelector = await directLabel.evaluate((node) => {
      const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
      const selectorFor = (control: HTMLElement, preferInput = false): string => {
        const id = normalize(control.getAttribute("id") || "");
        if (id) return `${control.tagName.toLowerCase()}#${id.replace(/([.#:[\],= ])/g, "\\$1")}`;
        const dataAutomationId = normalize(control.getAttribute("data-automation-id") || "");
        if (dataAutomationId) return `${control.tagName.toLowerCase()}[data-automation-id="${dataAutomationId.replace(/"/g, '\\"')}"]`;
        const name = normalize(control.getAttribute("name") || "");
        if (name) return `${preferInput ? "input" : control.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`;
        return "";
      };
      const container = (node as HTMLElement).closest("fieldset, [data-automation-id^='formField-'], [data-automation-id$='Section'], [data-automation-id*='PanelSet'], [role='group']") as HTMLElement | null;
      if (!container) return "";
      return selectorFor(container);
    }).catch(() => "");
    if (containerSelector) {
      const resolved = await buildResolvedFieldFromContainer(page.locator(containerSelector).first(), normalizedLabel);
      if (resolved) return resolved;
    }
  }

  const candidates = page.locator(activeSelector).locator("fieldset, [data-automation-id^='formField-'], [data-automation-id$='Section'], [data-automation-id*='PanelSet'], [role='group']");
  const count = await candidates.count().catch(() => 0);
  let bestIndex = -1;
  let bestLength = Number.POSITIVE_INFINITY;

  for (let i = 0; i < count; i += 1) {
    const candidate = candidates.nth(i);
    const text = await candidate.innerText().catch(() => "");
    const normalizedText = normalizeText(text);
    if (!normalizedText.includes(normalizedLabel)) continue;
    if (normalizedText.length < bestLength) {
      bestIndex = i;
      bestLength = normalizedText.length;
    }
  }

  if (bestIndex >= 0) {
    return buildResolvedFieldFromContainer(candidates.nth(bestIndex), normalizedLabel);
  }

  return null;
}

function normalizeMonthSectionValue(value: string): string {
  const text = normalizeText(value).toLowerCase();
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

async function verifyDropdownSelected(trigger: import("playwright-core").Locator, queryOrOption: string): Promise<boolean> {
  const state = await trigger.evaluate((el) => {
    const inputValue = "value" in el ? String((el as HTMLInputElement).value || "") : "";
    const ownText = (el.textContent || "").replace(/\s+/g, " ").trim();
    const parent = el.parentElement;
    const selectionLabel = parent?.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent?.replace(/\s+/g, " ").trim() || "";
    const promptInfo = parent?.querySelector("[data-automation-id='promptAriaInstruction']")?.textContent?.replace(/\s+/g, " ").trim() || "";
    return {
      ownText,
      inputValue,
      selectionLabel,
      promptInfo
    };
  }).catch(() => ({ ownText: "", inputValue: "", selectionLabel: "", promptInfo: "" }));
  const target = normalizeText(queryOrOption);
  if (state.promptInfo && /0 items selected|no items|expanded/i.test(state.promptInfo)) return false;
  return [state.selectionLabel, state.inputValue, state.ownText]
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .some((value) => optionTextLooselyMatches(value, target));
}

async function readVisibleDropdownState(trigger: import("playwright-core").Locator): Promise<string> {
  const state = await trigger.evaluate((el) => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
    const control = el as HTMLElement;
    const ownText = normalize(control.textContent || "");
    const ariaLabel = normalize(control.getAttribute("aria-label") || "");
    const selectedAttr = normalize(control.getAttribute("value") || "");
    return normalize(`${ownText} ${ariaLabel} ${selectedAttr}`);
  }).catch(() => "");
  return normalizeText(state);
}

function committedPromptStateParts(state: {
  ownText: string;
  inputValue: string;
  selectionLabel: string;
  promptInfo: string;
  containerText: string;
  merged: string;
}): string[] {
  return [
    normalizeText(state.selectionLabel),
    normalizeText(state.inputValue),
    normalizeText(state.ownText),
    normalizeText(state.merged)
  ].filter(Boolean);
}

function committedSelectValuesMatchExpected(committedValues: string[], expectedValues: string[]): boolean {
  if (!committedValues.length || !expectedValues.length) return false;
  return expectedValues.some((expected) =>
    committedValues.some((current) =>
      optionTextLooselyMatches(current, expected)
    )
  );
}

function isCommittedPromptSelectionText(value: string): boolean {
  const normalized = normalizeText(value);
  if (!normalized) return false;
  if (isPlaceholderOption(normalized)) return false;
  if (/^(search|add|upload)$/.test(normalized)) return false;
  return true;
}

export function isCommittedSourcePromptState(state: {
  ownText: string;
  inputValue: string;
  selectionLabel: string;
  promptInfo: string;
  containerText?: string;
  merged?: string;
}): boolean {
  const promptInfo = normalizeText(state.promptInfo || "");
  if (/\b[1-9]\d*\s+items?\s+selected\b/.test(promptInfo)) return true;
  if (/0 items selected|no items selected|no items|select one|choose one|please select/.test(promptInfo)) return false;

  return [state.selectionLabel, state.inputValue, state.ownText]
    .map((value) => normalizeText(value || ""))
    .some((value) => isCommittedPromptSelectionText(value));
}

function committedPromptStateMatchesExpected(
  widget: WorkdayWidgetSchema,
  expectedValues: string[],
  currentParts: string[]
): boolean {
  if (!currentParts.length) return false;
  const exactExpectedMatch = expectedValues.some((value) =>
    currentParts.some((current) => optionTextLooselyMatches(current, value))
  );
  if (exactExpectedMatch) return true;
  if (isFieldOfStudyEducationLabel(widget.label)) {
    return expectedValues.some((value) =>
      currentParts.some((current) => matchesFieldOfStudyValue(current, value) || matchesFieldOfStudyValue(value, current))
    );
  }
  return false;
}

function isApplicationQuestionCommittedSelectWidget(widget: WorkdayWidgetSchema): boolean {
  return widget.step === "application_questions" &&
    (widget.widgetType === "button_select" || widget.widgetType === "prompt_input_select");
}

async function readApplicationQuestionCommittedSelectValues(
  page: Page,
  widget: WorkdayWidgetSchema
): Promise<string[]> {
  const selector = widget.selectorHints.controlSelector || widget.selectorHints.containerSelector;
  if (!selector) return [];

  const committedState = await readPromptCommittedState(page, selector);
  const promptValues = [committedState.selectionLabel, committedState.inputValue, committedState.ownText]
    .map((value) => normalizeText(value))
    .filter((value) => Boolean(value) && !isPlaceholderOption(value));
  if (promptValues.length) return promptValues;

  const currentValue = await readWidgetCurrentValue(page, widget);
  const currentValues = (Array.isArray(currentValue) ? currentValue : [currentValue])
    .map((value) => normalizeText(String(value || "")))
    .filter((value) => Boolean(value) && !isPlaceholderOption(value));
  return currentValues;
}

export function shouldAllowPreexistingWidgetShortCircuit(currentStep: string, widgetType: WorkdayWidgetSchema["widgetType"]): boolean {
  if (currentStep !== "application_questions") return true;
  return widgetType !== "button_select" && widgetType !== "prompt_input_select";
}

async function verifySourcePromptCommitted(
  trigger: import("playwright-core").Locator,
  expectedValue?: string
): Promise<boolean> {
  const state = await trigger.evaluate((el) => {
    const inputValue = "value" in el ? String((el as HTMLInputElement).value || "") : "";
    const ownText = (el.textContent || "").replace(/\s+/g, " ").trim();
    const parent = el.parentElement;
    const selectionLabel = parent?.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent?.replace(/\s+/g, " ").trim() || "";
    const promptInfo = parent?.querySelector("[data-automation-id='promptAriaInstruction']")?.textContent?.replace(/\s+/g, " ").trim() || "";
    return {
      ownText,
      inputValue,
      merged: `${ownText} ${inputValue} ${selectionLabel} ${promptInfo}`.trim(),
      selectionLabel,
      promptInfo
    };
  }).catch(() => ({ ownText: "", inputValue: "", merged: "", selectionLabel: "", promptInfo: "" }));

  const selectionLabel = normalizeText(state.selectionLabel);
  const expected = normalizeText(expectedValue || "");

  if (!isCommittedSourcePromptState(state)) return false;
  if (!expected) return true;
  return selectionLabel.includes(expected) || expected.includes(selectionLabel);
}

async function commitExpandedSourceSelection(
  page: Page,
  input: import("playwright-core").Locator,
  expectedValue?: string
): Promise<boolean> {
  const promptInfo = await input.evaluate((el) => {
    const parent = el.parentElement;
    return (parent?.querySelector("[data-automation-id='promptAriaInstruction']")?.textContent || "").replace(/\s+/g, " ").trim();
  }).catch(() => "");
  if (!/expanded/i.test(promptInfo)) return false;

  await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForTimeout(220);
  if (await verifySourcePromptCommitted(input, expectedValue)) return true;

  const selectedChild = page.locator("[data-automation-id='activeListContainer'] [data-automation-id='menuItem'][aria-selected='true']").first();
  if (await selectedChild.isVisible().catch(() => false)) {
    const clicked = await selectedChild.click({ force: true, timeout: 1500 }).then(() => true).catch(() => false);
    if (clicked) {
      await page.waitForTimeout(220);
      if (await verifySourcePromptCommitted(input, expectedValue)) return true;
    }
  }

  const firstChild = page.locator("[data-automation-id='activeListContainer'] [data-automation-id='menuItem']").first();
  if (await firstChild.isVisible().catch(() => false)) {
    const clicked = await firstChild.click({ force: true, timeout: 1500 }).then(() => true).catch(() => false);
    if (clicked) {
      await page.waitForTimeout(220);
      if (await verifySourcePromptCommitted(input, expectedValue)) return true;
    }
  }

  return false;
}

async function chooseScopedOpenWorkdayOption(
  page: Page,
  trigger: import("playwright-core").Locator,
  queryOrOption: string
): Promise<boolean> {
  const multiselectId = String((await trigger.getAttribute("data-uxi-multiselect-id").catch(() => "")) ?? "").trim();
  if (!multiselectId) {
    return await chooseExactOpenWorkdayOption(page, queryOrOption).catch(() => false) ||
      await chooseOpenWorkdayOption(page, queryOrOption).catch(() => false);
  }

  const selector = await page.evaluate(({ wanted, id }) => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const selectorFor = (node: HTMLElement): string => {
      const idAttr = String(node.getAttribute("id") || "").trim();
      if (idAttr) return `[id="${idAttr.replace(/"/g, '\\"')}"]`;
      const automationId = String(node.getAttribute("data-automation-id") || "").trim();
      if (automationId) return `${node.tagName.toLowerCase()}[data-automation-id="${automationId.replace(/"/g, '\\"')}"]`;
      return "";
    };
    const matches = (text: string): boolean => {
      const normalizedText = normalize(text);
      return normalizedText === wanted || normalizedText.includes(wanted) || wanted.includes(normalizedText);
    };

    const leaves = Array.from(document.querySelectorAll<HTMLElement>(`[data-automation-id='promptLeafNode'][data-uxi-multiselect-id='${id}']`))
      .filter((node) => visible(node));
    for (const leaf of leaves) {
      const label = leaf.querySelector<HTMLElement>("[data-automation-id='promptOption']");
      const text = label?.textContent || leaf.textContent || "";
      if (!matches(text)) continue;
      return selectorFor(leaf) || (label ? selectorFor(label) : "");
    }

    const options = Array.from(document.querySelectorAll<HTMLElement>("[data-automation-id='promptOption']"))
      .filter((node) => visible(node) && node.closest(`[data-automation-id='promptLeafNode'][data-uxi-multiselect-id='${id}']`));
    for (const option of options) {
      if (!matches(option.textContent || "")) continue;
      return selectorFor(option);
    }

    return "";
  }, { wanted: normalizeText(queryOrOption), id: multiselectId }).catch(() => "");

  if (!selector) {
    return await chooseExactOpenWorkdayOption(page, queryOrOption).catch(() => false) ||
      await chooseOpenWorkdayOption(page, queryOrOption).catch(() => false);
  }

  return page.locator(selector).first().click({ force: true, timeout: 1800 }).then(() => true).catch(() => false);
}

async function chooseOpenWorkdayOption(page: Page, queryOrOption: string): Promise<boolean> {
  const options = await extractOptionsFromOpenDropdown(page);
  const choice = exactNormalizedOptionMatch(queryOrOption, options) || fuzzyOptionMatch(queryOrOption, options);
  if (!choice) return false;
  return page
    .locator("[role='option'], [data-automation-id='promptOption']")
    .filter({ hasText: new RegExp(escapeRegExp(choice), "i") })
    .first()
    .click({ timeout: 1800 })
    .then(() => true)
    .catch(() => false);
}

async function chooseExactOpenWorkdayOption(page: Page, value: string): Promise<boolean> {
  const exactText = new RegExp(`^${escapeRegExp(value)}$`, "i");
  const row = page
    .locator("[data-automation-id='activeListContainer'] [data-automation-id='menuItem'], [role='listbox'] [data-automation-id='menuItem'], [role='listbox'] [role='option']")
    .filter({ hasText: exactText })
    .first();

  if (await row.isVisible().catch(() => false)) {
    const radio = row.locator("[data-automation-id='radioBtn']").first();
    if (await radio.isVisible().catch(() => false)) {
      const clicked = await radio.click({ force: true, timeout: 1500 }).then(() => true).catch(() => false);
      if (clicked) return true;
    }

    const promptLeaf = row.locator("[data-automation-id='promptLeafNode']").first();
    if (await promptLeaf.isVisible().catch(() => false)) {
      const clicked = await promptLeaf.click({ timeout: 1500 }).then(() => true).catch(() => false);
      if (clicked) return true;
    }

    const promptOption = row.locator("[data-automation-id='promptOption']").first();
    if (await promptOption.isVisible().catch(() => false)) {
      const clicked = await promptOption.click({ timeout: 1500 }).then(() => true).catch(() => false);
      if (clicked) return true;
    }

    return row.click({ timeout: 1500 }).then(() => true).catch(() => false);
  }

  const wanted = normalizeText(value);
  return page.evaluate((expected) => {
    const norm = (input: string): string => input.replace(/\s+/g, " ").trim().toLowerCase();
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("[role='option'], [data-automation-id='promptOption'], [role='radio']"));
    const target = nodes.find((node) => {
      const text = norm(node.textContent || "");
      if (text !== expected) return false;
      if (node.closest("[data-automation-id='selectedItemList']")) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!target) return false;

    const row = target.closest<HTMLElement>("[data-automation-id='menuItem']") ??
      target.closest<HTMLElement>("[data-automation-id='promptLeafNode']") ??
      target;
    const radio = row.querySelector<HTMLElement>("[data-automation-id='radioBtn']");
    const clickable = radio ?? row.querySelector<HTMLElement>("[data-automation-id='promptLeafNode'], [data-automation-id='promptOption'], div, span") ?? row;
    clickable.scrollIntoView({ block: "center" });
    clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    clickable.click();
    return true;
  }, wanted).catch(() => false);
}

async function chooseOpenWorkdayOptionFromCandidates(page: Page, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const picked = await chooseExactOpenWorkdayOption(page, candidate);
    if (picked) return candidate;
  }
  return null;
}

async function clearWorkdaySelectedItems(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((inputSelector) => {
    const input = document.querySelector(inputSelector);
    if (!input) return false;
    const field = input.closest("[data-automation-id='formField-countryPhoneCode'], [data-automation-id^='formField-']") ?? input.parentElement;
    if (!field) return false;

    const deleteTargets = Array.from(field.querySelectorAll<HTMLElement>([
      "[data-automation-id='DELETE_charm'] button",
      "button[data-automation-id='DELETE_charm']",
      "[data-automation-id='DELETE_charm']",
      "[data-automation-id='selectedItemList'] button[aria-label*='Remove']",
      "[data-automation-id='selectedItemList'] button[aria-label*='Delete']",
      "[data-automation-id='selectedItemList'] button"
    ].join(", ")));

    const clickable = deleteTargets.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!clickable) return false;

    clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    clickable.click();
    return true;
  }, selector).catch(() => false);
}

async function waitForWorkdayPhoneCodeOptions(page: Page, selector: string): Promise<boolean> {
  return page.waitForFunction((inputSelector) => {
    const input = document.querySelector(inputSelector);
    if (!input) return false;
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("[role='option'], [data-automation-id='promptOption'], [role='radio']"));
    return nodes.some((node) => {
      if (node.closest("[data-automation-id='selectedItemList']")) return false;
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!/\(\+\d+\)/.test(text)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }, selector, { timeout: 4000 }).then(() => true).catch(() => false);
}

async function waitForActiveWorkdayListbox(page: Page): Promise<boolean> {
  return page.waitForFunction(() => {
    const list = document.querySelector<HTMLElement>("[data-automation-id='activeListContainer'][role='listbox'], [role='listbox'][data-automation-id='activeListContainer'], [role='listbox']");
    if (!list) return false;
    const rect = list.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }, { timeout: 2500 }).then(() => true).catch(() => false);
}

async function waitForExactOpenWorkdayOption(page: Page, value: string): Promise<boolean> {
  const wanted = normalizeText(value);
  return page.waitForFunction((expected) => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("[role='option'], [data-automation-id='promptOption'], [role='radio']"));
    return nodes.some((node) => {
      if (node.closest("[data-automation-id='selectedItemList']")) return false;
      const text = (node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (text !== expected) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }, wanted, { timeout: 4000 }).then(() => true).catch(() => false);
}

async function expandWorkdayPartialListIfPresent(page: Page): Promise<boolean> {
  const optionLocator = page.locator("[role='option'], [data-automation-id='promptOption'], [role='radio']");
  const texts = (await optionLocator.allInnerTexts().catch(() => [] as string[]))
    .map((text) => normalizeText(text))
    .filter(Boolean);
  const hasExpandAll = texts.includes("partial list (first 500 entries)") && texts.includes("all");
  if (!hasExpandAll) return false;

  const allOption = optionLocator.filter({ hasText: /^All$/i }).first();
  if (!await allOption.isVisible().catch(() => false)) return false;
  await allOption.click().catch(() => undefined);
  await page.waitForTimeout(600);
  return true;
}

async function fillWorkdaySearchPicker(page: Page, selector: string, value: string, input?: {
  expandAll?: boolean;
  pressEnterBeforeExactWait?: boolean;
  keyboardCommit?: boolean;
}): Promise<boolean> {
  const { expandAll = false, pressEnterBeforeExactWait = false, keyboardCommit = false } = input || {};
  const control = page.locator(selector).first();
  if (!await control.isVisible().catch(() => false)) return false;
  await control.scrollIntoViewIfNeeded().catch(() => undefined);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await withWorkdayExecutorGuard(page, "search_picker_prepare", selector, async () => {
      await clearWorkdaySelectedItems(page, selector).catch(() => false);
      await page.waitForTimeout(200);
      await control.click().catch(() => undefined);
      await page.waitForTimeout(200);
    });

    if (expandAll) {
      await withWorkdayExecutorGuard(page, "search_picker_expand_all", selector, async () => {
        await expandWorkdayPartialListIfPresent(page).catch(() => false);
        await control.click().catch(() => undefined);
      });
    }

    await withWorkdayExecutorGuard(page, "search_picker_type_query", selector, async () => {
      await control.press("ControlOrMeta+A").catch(() => undefined);
      await control.press("Backspace").catch(() => undefined);
      await control.type(value, { delay: 40 }).catch(() => undefined);
    });

    if (pressEnterBeforeExactWait) {
      await withWorkdayExecutorGuard(page, "search_picker_press_enter", selector, async () => {
        await control.press("Enter").catch(() => undefined);
        await page.waitForTimeout(250);
      });
    }

    const exactVisible = await waitForExactOpenWorkdayOption(page, value);
    if (exactVisible) {
      const picked = await chooseExactOpenWorkdayOption(page, value);
      if (picked) {
        await page.waitForTimeout(350);
        await page.keyboard.press("Tab").catch(() => undefined);
        await page.waitForTimeout(200);
        if (await verifyDropdownSelected(control, value)) return true;
      }
    }

    if (keyboardCommit) {
      await withWorkdayExecutorGuard(page, "search_picker_keyboard_commit", selector, async () => {
        await control.press("ArrowDown").catch(() => undefined);
        await page.waitForTimeout(200);
        await control.press("Enter").catch(() => undefined);
        await page.waitForTimeout(300);
        await page.keyboard.press("Tab").catch(() => undefined);
        await page.waitForTimeout(200);
      });
      if (await verifyDropdownSelected(control, value)) return true;
    }

    await withWorkdayExecutorGuard(page, "search_picker_escape", selector, async () => {
      await page.keyboard.press("Escape").catch(() => undefined);
    });
  }

  return false;
}

async function selectDropdownBackedInputOption(
  page: Page,
  input: import("playwright-core").Locator,
  value: string
): Promise<boolean> {
  const optionLocator = page.locator("[role='option'], [data-automation-id='promptOption'], [role='radio']");
  const typeQuery = async (): Promise<void> => {
    const selector = await input.evaluate((el) => {
      const id = (el.getAttribute("id") || "").trim();
      if (id) return `[id="${id.replace(/"/g, '\\"')}"]`;
      const name = (el.getAttribute("name") || "").trim();
      if (name) return `input[name="${name.replace(/"/g, '\\"')}"]`;
      return "";
    }).catch(() => "");
    await withWorkdayExecutorGuard(page, "combobox_type_query", selector, async () => {
      await input.click().catch(() => undefined);
      await input.fill("").catch(() => undefined);
      await input.type(value, { delay: 35 }).catch(() => undefined);
    });
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await typeQuery();
    const deadline = Date.now() + 5000;
    let expandedAll = false;
    while (Date.now() < deadline) {
      const texts = (await optionLocator.allInnerTexts().catch(() => [] as string[]))
        .map((text) => normalizeText(text))
        .filter(Boolean);
      if (texts.length) {
        const hasExpandAll = texts.includes("partial list (first 500 entries)") && texts.includes("all");
        if (hasExpandAll && !expandedAll) {
          const allOption = optionLocator.filter({ hasText: /^All$/i }).first();
          if (await allOption.isVisible().catch(() => false)) {
            await allOption.click().catch(() => undefined);
            expandedAll = true;
            await page.waitForTimeout(500);
            await typeQuery();
            continue;
          }
        }

        const picked = await chooseOpenWorkdayOption(page, value);
        if (picked) {
          await page.waitForTimeout(250);
          await page.keyboard.press("Tab").catch(() => undefined);
          await page.waitForTimeout(150);
          return verifyDropdownSelected(input, value);
        }

        if (texts.includes("no items.")) {
          break;
        }
      }
      await page.waitForTimeout(250);
    }
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  return false;
}

export async function fillWorkdayDropdown(page: Page, triggerSelector: string, queryOrOption: string): Promise<boolean> {
  const trigger = page.locator(triggerSelector).first();
  const visible = await trigger.isVisible().catch(() => false);
  if (!visible) return false;

  await withWorkdayExecutorGuard(page, "dropdown_open_and_type", triggerSelector, async () => {
    await trigger.click().catch(() => undefined);
    const isTextInput = await trigger.evaluate((el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement).catch(() => false);
    if (isTextInput) {
      await trigger.fill("").catch(() => undefined);
    }
    await page.keyboard.type(queryOrOption, { delay: 50 }).catch(() => undefined);
  });

  const optionsLocator = page.locator("[role='option'], [data-automation-id='promptOption']");
  const optionsVisible = await optionsLocator.first().isVisible({ timeout: 3000 }).catch(() => false);
  if (optionsVisible) {
    const picked = await chooseOpenWorkdayOption(page, queryOrOption);
    if (!picked) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return verifyDropdownSelected(trigger, queryOrOption);
    }
  }

  return verifyDropdownSelected(trigger, queryOrOption);
}

export async function fillWorkdaySourcePrompt(page: Page, selector: string, preferredValue: string): Promise<boolean> {
  const input = page.locator(selector).first();
  if (!await input.isVisible().catch(() => false)) return false;

  if (await verifySourcePromptCommitted(input, preferredValue).catch(() => false)) return true;

  await withWorkdayExecutorGuard(page, "source_prompt_open", selector, async () => {
    await input.click().catch(() => undefined);
    await input.fill("").catch(() => undefined);
    await page.waitForTimeout(220);
    await input.press("ArrowDown").catch(() => undefined);
    await page.waitForTimeout(180);
  });

  let liveOption = pickExactSourceOption(
    await withWorkdayExecutorGuard(page, "source_prompt_extract_options", selector, async () =>
      extractScopedDropdownOptions(page, input).catch(() => [] as string[])
    ),
    preferredValue
  );
  if (!liveOption) {
    liveOption = pickBestRuntimeSourceOption(
      await withWorkdayExecutorGuard(page, "source_prompt_extract_options_fallback", selector, async () =>
        extractScopedDropdownOptions(page, input).catch(() => [] as string[])
      ),
      preferredValue
    );
  }
  if (!liveOption) {
    await withWorkdayExecutorGuard(page, "source_prompt_type_query", selector, async () => {
      await input.click().catch(() => undefined);
      await input.fill("").catch(() => undefined);
      await input.type(preferredValue, { delay: 35 }).catch(() => undefined);
      await page.waitForTimeout(220);
    });
    liveOption = pickExactSourceOption(
      await withWorkdayExecutorGuard(page, "source_prompt_extract_query_options", selector, async () =>
        extractScopedDropdownOptions(page, input).catch(() => [] as string[])
      ),
      preferredValue
    );
    if (!liveOption) {
      liveOption = pickBestRuntimeSourceOption(
        await withWorkdayExecutorGuard(page, "source_prompt_extract_query_options_fallback", selector, async () =>
          extractScopedDropdownOptions(page, input).catch(() => [] as string[])
        ),
        preferredValue
      );
    }
  }
  if (!liveOption) {
    const fallbackPicked = await commitExpandedSourceSelection(page, input).catch(() => false);
    if (fallbackPicked) {
      await page.keyboard.press("Tab").catch(() => undefined);
      await page.waitForTimeout(150);
      return verifySourcePromptCommitted(input).catch(() => false);
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }

  const picked = await chooseScopedOpenWorkdayOption(page, input, liveOption).catch(() => false);
  if (!picked) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }
  await page.waitForTimeout(180);
  if (!await verifySourcePromptCommitted(input, liveOption)) {
    await commitExpandedSourceSelection(page, input, liveOption).catch(() => false);
  }
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(150);
  if (await verifySourcePromptCommitted(input, liveOption)) return true;
  if (await verifySourcePromptCommitted(input).catch(() => false)) return true;

  const fallbackPicked = await commitExpandedSourceSelection(page, input).catch(() => false);
  if (fallbackPicked) {
    await page.keyboard.press("Tab").catch(() => undefined);
    await page.waitForTimeout(150);
    return verifySourcePromptCommitted(input).catch(() => false);
  }

  return false;
}

async function fillSkills(page: Page, skills: string[], filledFields: FilledFieldRecord[]): Promise<void> {
  const anchoredSelector = await page.evaluate(() => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const selectorFor = (control: HTMLElement): string => {
      const id = String(control.getAttribute("id") || "").trim();
      if (id) return `${control.tagName.toLowerCase()}#${id.replace(/([.#:[\],= ])/g, "\\$1")}`;
      const automationId = String(control.getAttribute("data-automation-id") || "").trim();
      if (automationId) return `${control.tagName.toLowerCase()}[data-automation-id="${automationId.replace(/"/g, '\\"')}"]`;
      const name = String(control.getAttribute("name") || "").trim();
      if (name) return `${control.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`;
      return "";
    };

    const directCandidates = [
      "#skills--skills",
      "input#skills--skills",
      "div[data-automation-id='formField-skillsPrompt'] input[data-automation-id='searchBox']",
      "div[data-automation-id='formField-skillsPrompt'] input[data-uxi-widget-type='selectinput']",
      "div[data-automation-id='skillsSection'] input[data-automation-id='searchBox']",
      "[data-automation-id='skillsPrompt'] input[data-automation-id='searchBox']",
      "[data-automation-id='skillsSection'] [data-automation-id='skillsPrompt'] input[data-automation-id='searchBox']",
      "[data-automation-id='skillsSection'] input[data-uxi-widget-type='selectinput'][data-automation-id='searchBox']"
    ];
    for (const candidate of directCandidates) {
      const control = document.querySelector(candidate);
      if (visible(control)) return candidate;
    }

    const containers = Array.from(document.querySelectorAll("section, fieldset, div[data-automation-id], div"));
    for (const container of containers) {
      const headings = Array.from(container.querySelectorAll("h1, h2, h3, h4, legend, label"))
        .map((node) => normalize(node.textContent || ""))
        .filter(Boolean);
      if (!headings.includes("skills")) continue;
      const input = Array.from(
        container.querySelectorAll<HTMLElement>(
          "input[data-automation-id='searchBox'], input[data-uxi-widget-type='selectinput'], input#skills--skills"
        )
      )
        .find((node) => visible(node));
      if (!input) continue;
      const labelText = normalize(container.textContent || "");
      if (!/type to add skills|skills/.test(labelText)) continue;
      const selector = selectorFor(input);
      if (selector) return selector;
    }

    return "";
  }).catch(() => "");

  const input = page.locator([
    anchoredSelector,
    "#skills--skills",
    "div[data-automation-id='formField-skillsPrompt'] input[data-automation-id='searchBox']",
    "div[data-automation-id='formField-skillsPrompt'] input[data-uxi-widget-type='selectinput']",
    "div[data-automation-id='skillsSection'] input[data-automation-id='searchBox']",
    "[data-automation-id='skillsPrompt'] input[data-automation-id='searchBox']"
  ].filter(Boolean).join(", ")).first();
  if (!await input.isVisible().catch(() => false)) return;

  for (const skill of skills) {
    await input.click().catch(() => undefined);
    await input.fill("").catch(() => undefined);
    await input.fill(skill).catch(async () => {
      await input.type(skill, { delay: 40 }).catch(() => undefined);
    });
    await page.waitForTimeout(250);

    let committed = false;
    const optionTexts = Array.from(new Set((await extractOptionsFromOpenDropdown(page).catch(() => [] as string[])).map((option) => normalizeText(option)).filter(Boolean)));
    const meaningfulOptions = optionTexts.filter((option) => !/^(select one|all|partial list \(first 500 entries\)|no items\.?)$/i.test(normalizeText(option)));
    if (meaningfulOptions.length) {
      const picked = await chooseExactOpenWorkdayOption(page, skill).catch(() => false) ||
        await chooseOpenWorkdayOption(page, skill).catch(() => false);
      if (picked) {
        await page.keyboard.press("Enter").catch(() => undefined);
        await page.keyboard.press("Enter", { delay: 5000 }).catch(() => undefined);
        await page.waitForTimeout(300);
        committed = await verifySourcePromptCommitted(input, skill).catch(() => false) ||
          await verifySourcePromptCommitted(input).catch(() => false);
      }
    }

    if (!committed) {
      await page.keyboard.press("Enter").catch(() => undefined);
      await page.keyboard.press("Enter", { delay: 5000 }).catch(() => undefined);
      await page.waitForTimeout(350);
      committed = await verifySourcePromptCommitted(input, skill).catch(() => false) ||
        await verifySourcePromptCommitted(input).catch(() => false);
    }

    if (!committed) {
      await input.press("Tab").catch(() => undefined);
      await page.waitForTimeout(220);
      committed = await verifySourcePromptCommitted(input, skill).catch(() => false) ||
        await verifySourcePromptCommitted(input).catch(() => false);
    }

    if (committed) {
      filledFields.push({ id: `skill:${skill}`, label: "Skill", value: skill, source: "profile", inputKind: "search_combobox" });
    } else {
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  }
}

async function fillResume(page: Page, resumePath: string, filledFields: FilledFieldRecord[], notes?: string[]): Promise<void> {
  if (!resumePath) return;
  const fileName = resumePath.split("/").pop() || "";
  const priorAttemptCount = readFilledFieldCount(filledFields, "__resume_upload_attempt_count__");
  if (fileName && await detectResumeAlreadyPresent(page, fileName)) {
    upsertFilledFieldRecord(filledFields, { id: "resume_upload", label: "Resume Upload", value: resumePath, source: "profile", inputKind: "file" });
    upsertFilledFieldRecord(filledFields, { id: "__resume_upload_attempt_count__", label: "workday_resume_upload_attempt_count", value: String(priorAttemptCount), source: "manual", inputKind: "file" });
    notes?.push("workday_resume_upload_skipped_already_present");
    notes?.push(`workday_resume_upload_attempt_count:${priorAttemptCount}`);
    return;
  }
  if (filledFields.some((field) => field.id === "resume_upload" && String(field.value || "") === resumePath)) {
    notes?.push("workday_resume_upload_skipped_already_present");
    notes?.push(`workday_resume_upload_attempt_count:${priorAttemptCount}`);
    return;
  }
  if (priorAttemptCount >= 1) {
    notes?.push("workday_resume_upload_skipped_already_present");
    notes?.push(`workday_resume_upload_attempt_count:${priorAttemptCount}`);
    return;
  }
  const nextAttemptCount = priorAttemptCount + 1;
  upsertFilledFieldRecord(filledFields, { id: "__resume_upload_attempt_count__", label: "workday_resume_upload_attempt_count", value: String(nextAttemptCount), source: "manual", inputKind: "file" });
  notes?.push(`workday_resume_upload_attempt_count:${nextAttemptCount}`);

  const upload = page.locator("input[data-automation-id='file-upload-input-ref'], input[type='file']").first();
  let hasUploadInput = await upload.count().then((n) => n > 0).catch(() => false);
  if (!hasUploadInput) {
    await page.locator("button[data-automation-id='select-files'], button:has-text('Select files'), a:has-text('Select files'), text=Select files").first()
      .click()
      .catch(() => undefined);
    await page.waitForTimeout(300);
    hasUploadInput = await upload.count().then((n) => n > 0).catch(() => false);
  }
  if (!hasUploadInput) return;

  let uploadOk = await upload.setInputFiles(resumePath).then(() => true).catch(() => false);
  if (!uploadOk) {
    await safeClick(page, "button[data-automation-id='select-files']");
    await page.locator("button:has-text('Select files'), a:has-text('Select files'), text=Select files").first()
      .click()
      .catch(() => undefined);
    uploadOk = await upload.setInputFiles(resumePath).then(() => true).catch(() => false);
  }
  if (!uploadOk) return;

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const inputHasFile = await upload.evaluate((el) => {
      const input = el as HTMLInputElement;
      return Boolean(input.files && input.files.length > 0);
    }).catch(() => false);
    const hasFileName = fileName ? await page.locator(`text=${fileName}`).first().isVisible().catch(() => false) : false;
    const progressVisible = await page.locator("[data-automation-id*='progress'], .progress").first().isVisible().catch(() => false);
    const hasError = await page.locator("[data-automation-id*='error'], .error").first().isVisible().catch(() => false);
    if (hasError) break;
    if ((inputHasFile || hasFileName) && !progressVisible) {
      upsertFilledFieldRecord(filledFields, { id: "resume_upload", label: "Resume Upload", value: resumePath, source: "profile", inputKind: "file" });
      return;
    }
    await page.waitForTimeout(300);
  }
}

async function fillComboboxInput(page: Page, input: import("playwright-core").Locator, value: string): Promise<boolean> {
  if (!await input.isVisible().catch(() => false)) return false;
  await input.scrollIntoViewIfNeeded().catch(() => undefined);
  return selectDropdownBackedInputOption(page, input, value);
}

async function fillQuestionnaireCheckboxGroupByLabel(page: Page, questionPattern: RegExp, choiceText: string): Promise<boolean> {
  const container = page.locator("fieldset, div[data-automation-id^='formField-'], div").filter({ hasText: questionPattern }).first();
  if (!await container.isVisible().catch(() => false)) return false;

  const choice = container.getByText(new RegExp(`^${escapeRegExp(choiceText)}$`, "i")).first();
  if (await choice.isVisible().catch(() => false)) {
    await choice.click().catch(() => undefined);
  }

  const checkboxes = container.locator("input[type='checkbox']");
  const count = await checkboxes.count().catch(() => 0);
  if (count === 0) return false;

  let target = checkboxes.last();
  const neitherNode = container.getByText(/^Neither$/i).first();
  const neitherVisible = await neitherNode.isVisible().catch(() => false);
  if (!neitherVisible && /neither/i.test(choiceText) && count >= 1) {
    target = checkboxes.nth(Math.max(0, count - 1));
  }

  const alreadyChecked = await target.isChecked().catch(() => false);
  if (!alreadyChecked) {
    await target.check({ force: true }).catch(async () => {
      await target.click({ force: true }).catch(() => undefined);
    });
  }
  return await target.isChecked().catch(() => false);
}

async function fillQuestionnaireCheckboxGroupBySelector(page: Page, selector: string, choiceText: string): Promise<boolean> {
  const container = page.locator(selector).first();
  if (!await container.isVisible().catch(() => false)) return false;

  const label = container.locator("label").filter({ hasText: new RegExp(`^${escapeRegExp(choiceText)}$`, "i") }).first();
  if (!await label.isVisible().catch(() => false)) return false;

  const forId = await label.getAttribute("for").catch(() => null);
  if (forId) {
    const input = page.locator(`#${escapeSelectorId(forId)}`).first();
    const checked = await input.isChecked().catch(() => false);
    if (!checked) {
      await input.check({ force: true }).catch(async () => {
        await label.click({ force: true }).catch(() => undefined);
      });
    }
    return input.isChecked().catch(() => false);
  }

  await label.click({ force: true }).catch(() => undefined);
  return true;
}

async function clickAssociatedLabel(page: Page, selector: string): Promise<boolean> {
  const input = page.locator(selector).first();
  const id = await input.getAttribute("id").catch(() => null);
  if (!id) return false;
  const label = page.locator(`label[for="${id.replace(/"/g, '\\"')}"]`).first();
  if (!await label.isVisible().catch(() => false)) return false;
  return label.click({ force: true }).then(() => true).catch(() => false);
}

async function fillSelectByLegendText(
  page: Page,
  legendPattern: RegExp,
  choice: string,
  recordId: string,
  recordLabel: string,
  filledFields: FilledFieldRecord[]
): Promise<boolean> {
  const fieldset = page.locator("fieldset").filter({ hasText: legendPattern }).first();
  const visible = await fieldset.isVisible().catch(() => false);
  if (!visible) return false;

  const trigger = fieldset.locator("button[aria-haspopup='listbox']").first();
  const triggerVisible = await trigger.isVisible().catch(() => false);
  if (!triggerVisible) return false;

  await trigger.click().catch(() => undefined);
  await page.waitForTimeout(200);
  const options = page.locator("[role='option'], [data-automation-id='promptOption']");
  const choiceRegex = new RegExp(choice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const picked = await options.filter({ hasText: choiceRegex }).first().click().then(() => true).catch(() => false);
  if (!picked) {
    await page.keyboard.type(choice, { delay: 40 }).catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
  }

  filledFields.push({
    id: recordId,
    label: recordLabel,
    value: choice,
    source: "profile",
    inputKind: "dropdown"
  });
  return true;
}

function isAffirmativeOption(value: string): boolean {
  const t = normalizeText(value);
  return /^(yes|i agree|agree|true|accept|accepted)/.test(t) || /comply/.test(t);
}

function isNegativeOption(value: string): boolean {
  const t = normalizeText(value);
  return /^(no|false|decline|do not agree)/.test(t);
}

function pickFromOptions(target: string, options: string[]): string | null {
  const exact = exactNormalizedOptionMatch(target, options);
  if (exact) return exact;
  const fuzzy = fuzzyOptionMatch(target, options);
  if (fuzzy) return fuzzy;
  if (normalizeText(target) === "yes") return options.find((o) => isAffirmativeOption(o)) ?? null;
  if (normalizeText(target) === "no") return options.find((o) => isNegativeOption(o)) ?? null;
  return null;
}

function isSourcePrompt(label: string, automationId: string): boolean {
  const key = `${label} ${automationId}`.toLowerCase();
  return /how did you hear|application source|\bsource\b/.test(key);
}

async function extractDropdownOptions(page: Page): Promise<string[]> {
  const candidates = await page
    .locator("[role='option'], [role='listbox'] [role='option'], [role='listbox'] li, [role='listbox'] button, [role='listbox'] div")
    .allInnerTexts()
    .catch(() => [] as string[]);
  return Array.from(new Set(candidates.map((v) => normalizeText(v)).filter((v) => v && v !== "select one")));
}

async function extractScopedDropdownOptions(page: Page, trigger: import("playwright-core").Locator): Promise<string[]> {
  const listboxId = String((await trigger.getAttribute("aria-controls").catch(() => "")) ?? "").trim();
  if (listboxId) {
    const scoped = await page.locator(`#${listboxId.replace(/([.#:[\],= ])/g, "\\$1")} [role='option']`).allInnerTexts().catch(() => [] as string[]);
    const opts = Array.from(new Set(scoped.map((v) => normalizeText(v)).filter((v) => v && v !== "select one")));
    if (opts.length) return opts;
  }
  const multiselectId = String((await trigger.getAttribute("data-uxi-multiselect-id").catch(() => "")) ?? "").trim();
  if (multiselectId) {
    const scoped = await page.evaluate((id) => {
      const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const visible = (node: Element | null): node is HTMLElement => {
        if (!(node instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const values = Array.from(document.querySelectorAll<HTMLElement>(`[data-automation-id='promptLeafNode'][data-uxi-multiselect-id='${id}'] [data-automation-id='promptOption']`))
        .filter((node) => visible(node))
        .map((node) => normalize(node.textContent || ""))
        .filter(Boolean);
      return Array.from(new Set(values));
    }, multiselectId).catch(() => [] as string[]);
    if (scoped.length) return scoped;
  }
  return extractDropdownOptions(page);
}

function pickStrongLanguageOption(options: string[], label: string): string | null {
  const norm = options.map((o) => ({ raw: o, v: normalizeText(o) })).filter((x) => x.v && x.v !== "select one");
  if (!norm.length) return null;
  const englishPatterns = [
    /^english$/i,
    /^english \(united states\)$/i,
    /^english - united states$/i,
    /^american english$/i,
    /\benglish\b.*\bunited states\b/i
  ];
  const englishExact = norm.find((o) => englishPatterns.some((pattern) => pattern.test(o.v)));
  if (englishExact) return englishExact.raw;
  const englishLoose = norm.find((o) => /\benglish\b/i.test(o.v));
  if (englishLoose) return englishLoose.raw;
  if (/speak|read|write|proficiency|level/.test(normalizeText(label))) {
    for (const token of WORKDAY_STRONG_PROFICIENCY_PRIORITY) {
      const found = norm.find((o) => o.v.includes(token));
      if (found) return found.raw;
    }
  }
  if (norm.some((o) => /^(yes|y)$/.test(o.v))) return norm.find((o) => /^(yes|y)$/.test(o.v))!.raw;
  return norm[0]?.raw ?? null;
}

export async function fillWorkdayDropdownAndCommit(
  page: Page,
  trigger: import("playwright-core").Locator,
  optionText: string,
  label: string
): Promise<string> {
  await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
  await humanPause(page, 300, 700);
  await trigger.click().catch(() => undefined);
  await humanPause(page, 300, 700);

  const isTextInput = await trigger.evaluate((el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement).catch(() => false);
  if (isTextInput) {
    await trigger.fill("").catch(() => undefined);
    await trigger.type(optionText, { delay: 80 }).catch(() => undefined);
    await humanPause(page, 250, 500);
  }

  const listboxId = String((await trigger.getAttribute("aria-controls").catch(() => "")) ?? "").trim();
  const optionsVisible = (listboxId
    ? page.locator(`#${listboxId.replace(/([.#:[\],= ])/g, "\\$1")} [role='option']`)
    : page.locator("[role='option'], [data-automation-id='promptOption']"))
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  if (await optionsVisible) {
    const clicked = await chooseOpenWorkdayOption(page, optionText);
    if (!clicked) {
      await page.keyboard.press("Escape").catch(() => undefined);
      throw new Error(`Dropdown did not offer ${optionText} for ${label}`);
    }
  } else if (!isTextInput) {
    await page.keyboard.type(optionText, { delay: 80 }).catch(() => undefined);
    await humanPause(page, 300, 700);
    await page.keyboard.press("Enter").catch(() => undefined);
  }

  await humanPause(page, 500, 1000);
  await page.keyboard.press("Tab").catch(() => undefined);
  await humanPause(page, 300, 700);

  const text = normalizeText([
    await trigger.innerText().catch(() => ""),
    await trigger.inputValue().catch(() => "")
  ].join(" "));
  const target = normalizeText(optionText);
  if (!text || text.includes("select one") || text.includes("select...") || (!text.includes(target) && !target.includes(text))) {
    throw new Error(`Dropdown did not commit for ${label}: still ${text}`);
  }
  return text;
}

async function resolveSectionAddButtonSelector(page: Page, headingPattern: RegExp): Promise<string | null> {
  return page.evaluate(({ source }) => {
    const headingRe = new RegExp(source, "i");
    const toSelector = (button: Element): string | null => {
      document.querySelectorAll("[data-automa-workday-add-target='true']").forEach((node) => node.removeAttribute("data-automa-workday-add-target"));
      if (!(button instanceof HTMLElement)) return null;
      button.setAttribute("data-automa-workday-add-target", "true");
      return "button[data-automa-workday-add-target='true']";
    };

    const buttons = Array.from(document.querySelectorAll("button[data-automation-id='add-button']"));
    for (const button of buttons) {
      let node: Element | null = button.parentElement;
      for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
        const headings = Array.from(node.querySelectorAll("h1, h2, h3, h4, legend"));
        const matchedHeading = headings.find((heading) => headingRe.test((heading.textContent || "").replace(/\s+/g, " ").trim()));
        if (matchedHeading) return toSelector(button);
      }
    }
    return null;
  }, { source: headingPattern.source }).catch(() => null);
}

async function clickSectionAddButton(page: Page, headingPattern: RegExp): Promise<boolean> {
  const selector = await resolveSectionAddButtonSelector(page, headingPattern);
  if (!selector) return false;
  const clicked = await safeClick(page, selector);
  await page.locator(selector).evaluate((button) => button.removeAttribute("data-automa-workday-add-target")).catch(() => undefined);
  if (clicked) await page.waitForTimeout(450);
  return clicked;
}

async function clickEducationSectionAddButton(page: Page): Promise<boolean> {
  const explicitSelectors = [
    "div[data-automation-id='educationSection'] button[data-automation-id='Add']",
    "[data-automation-id='educationSection'] button[data-automation-id='Add']",
    "section[data-automation-id='educationSection'] button[data-automation-id='Add']"
  ];
  for (const selector of explicitSelectors) {
    const clicked = await safeClick(page, selector);
    if (clicked) {
      await page.waitForTimeout(450);
      return true;
    }
  }
  return clickSectionAddButton(page, /education/i);
}

async function clickWorkExperienceSectionAddButton(page: Page): Promise<boolean> {
  const explicitSelectors = [
    "div[data-automation-id='workExperienceSection'] button[data-automation-id='Add']",
    "[data-automation-id='workExperienceSection'] button[data-automation-id='Add']",
    "section[data-automation-id='workExperienceSection'] button[data-automation-id='Add']",
    "div[data-automation-id='workExperienceSection'] button[data-automation-id='add-button']",
    "[data-automation-id='workExperienceSection'] button[data-automation-id='add-button']",
    "section[data-automation-id='workExperienceSection'] button[data-automation-id='add-button']",
    "div[data-automation-id='workExperienceSection'] button[data-automation-id*='add']",
    "[data-automation-id='workExperienceSection'] button[data-automation-id*='add']",
    "section[data-automation-id='workExperienceSection'] button[data-automation-id*='add']"
  ];
  for (const selector of explicitSelectors) {
    const clicked = await safeClick(page, selector);
    if (clicked) {
      await page.waitForTimeout(450);
      return true;
    }
  }
  return clickSectionAddButton(page, /work experience/i);
}

async function waitForPanelPrefixShrink(
  page: Page,
  fieldIdSuffix: string,
  previousCount: number,
  timeoutMs = 3500
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let latestCount = previousCount;
  while (Date.now() < deadline) {
    const prefixes = await collectWorkdayPanelPrefixes(page, fieldIdSuffix);
    latestCount = prefixes.length;
    if (latestCount < previousCount) return latestCount;
    await page.waitForTimeout(150);
  }
  return latestCount;
}

async function removeBlankExperienceRows(page: Page, desiredCount: number): Promise<number> {
  let removed = 0;
  while (true) {
    const prefixes = await settlePanelPrefixes(page, "--jobTitle");
    if (prefixes.length <= desiredCount) break;

    const extraPrefixes = prefixes.slice(desiredCount).reverse();
    let removedOne = false;
    for (const prefix of extraPrefixes) {
      const jobTitle = await page.locator(`#${escapeSelectorId(`${prefix}--jobTitle`)}`).first().inputValue().catch(() => "");
      const company = await page.locator(`#${escapeSelectorId(`${prefix}--companyName`)}, #${escapeSelectorId(`${prefix}--company`)}`).first().inputValue().catch(() => "");
      const startMonth = await page.locator(`#${escapeSelectorId(`${prefix}--startDate-dateSectionMonth-input`)}`).first().inputValue().catch(() => "");
      const startYear = await page.locator(`#${escapeSelectorId(`${prefix}--startDate-dateSectionYear-input`)}`).first().inputValue().catch(() => "");
      const endMonth = await page.locator(`#${escapeSelectorId(`${prefix}--endDate-dateSectionMonth-input`)}`).first().inputValue().catch(() => "");
      const endYear = await page.locator(`#${escapeSelectorId(`${prefix}--endDate-dateSectionYear-input`)}`).first().inputValue().catch(() => "");
      const currentRole = await page.locator(`#${escapeSelectorId(`${prefix}--currentlyWorkHere`)}`).first().isChecked().catch(() => false);
      const blank = !normalizeText(jobTitle) && !normalizeText(company) && !normalizeText(startMonth) && !normalizeText(startYear) && !normalizeText(endMonth) && !normalizeText(endYear) && !currentRole;
      if (!blank) continue;

      const clicked = await page.evaluate((currentPrefix) => {
        const jobInput = document.querySelector(`#${CSS.escape(`${currentPrefix}--jobTitle`)}`) as HTMLElement | null;
        if (!jobInput) return false;
        let node: HTMLElement | null = jobInput.parentElement;
        while (node) {
          const deleteButton = Array.from(node.querySelectorAll<HTMLElement>("button")).find((button) =>
            /delete/i.test((button.textContent || "").replace(/\s+/g, " ").trim()) ||
            /delete/i.test(button.getAttribute("aria-label") || "") ||
            /delete/i.test(button.getAttribute("data-automation-id") || "")
          );
          if (deleteButton) {
            deleteButton.click();
            return true;
          }
          node = node.parentElement;
        }
        return false;
      }, prefix).catch(() => false);
      if (!clicked) continue;
      const nextCount = await waitForPanelPrefixShrink(page, "--jobTitle", prefixes.length);
      if (nextCount < prefixes.length) {
        removed += 1;
        removedOne = true;
        break;
      }
    }

    if (!removedOne) break;
  }

  return removed;
}

async function collectWorkdayPanelPrefixes(page: Page, fieldIdSuffix: string): Promise<string[]> {
  return page.evaluate((suffix) => {
    const prefixes = new Set<string>();
    for (const node of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(`input[id$="${suffix}"], textarea[id$="${suffix}"]`))) {
      const id = (node.getAttribute("id") || "").trim();
      const prefix = id.slice(0, Math.max(0, id.length - suffix.length));
      if (prefix) prefixes.add(prefix);
    }
    return Array.from(prefixes);
  }, fieldIdSuffix).catch(() => [] as string[]);
}

async function waitForPanelPrefixGrowth(
  page: Page,
  fieldIdSuffix: string,
  previousCount: number,
  timeoutMs = 3500
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let latestCount = previousCount;
  while (Date.now() < deadline) {
    const prefixes = await collectWorkdayPanelPrefixes(page, fieldIdSuffix);
    latestCount = prefixes.length;
    if (latestCount > previousCount) return latestCount;
    await page.waitForTimeout(150);
  }
  return latestCount;
}

async function settlePanelPrefixes(
  page: Page,
  fieldIdSuffix: string,
  timeoutMs = 2500
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let prefixes = await collectWorkdayPanelPrefixes(page, fieldIdSuffix);
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(150);
    const next = await collectWorkdayPanelPrefixes(page, fieldIdSuffix);
    if (next.length !== prefixes.length) {
      prefixes = next;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince >= 450) break;
  }
  return prefixes;
}

async function fillWorkdayLabeledControl(page: Page, labelPattern: RegExp, value: string, label: string): Promise<boolean> {
  const selector = await page.evaluate(({ source }) => {
    const pattern = new RegExp(source, "i");
    const labels = Array.from(document.querySelectorAll("label")).filter((node) => pattern.test((node.textContent || "").replace(/\s+/g, " ").trim()));
    for (const labelNode of labels) {
      const forId = (labelNode.getAttribute("for") || "").trim();
      if (forId) return `#${forId.replace(/([.#:[\\],= ])/g, "\\$1")}`;
    }

    const containers = Array.from(document.querySelectorAll("fieldset, div, section"))
      .filter((node) => {
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (!pattern.test(text)) return false;
        const rect = (node as HTMLElement).getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && text.length < 250;
      })
      .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);

    for (const container of containers) {
      const control = container.querySelector("button[aria-haspopup='listbox'], input[placeholder='Search'], input:not([type='hidden']):not([type='file'])");
      if (!control) continue;
      const id = (control.getAttribute("id") || "").trim();
      if (id) return `#${id.replace(/([.#:[\\],= ])/g, "\\$1")}`;
      const name = (control.getAttribute("name") || "").trim();
      if (name) return `${control.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`;
    }

    return null;
  }, { source: labelPattern.source }).catch(() => null);

  if (!selector) return false;
  const control = page.locator(selector).first();
  if (!await control.isVisible().catch(() => false)) return false;
  const isButton = await control.evaluate((el) => el.tagName.toLowerCase() === "button").catch(() => false);
  if (isButton) {
    await fillWorkdayDropdownAndCommit(page, control, value, label);
    return true;
  }
  return fillComboboxInput(page, control, value);
}

async function fillWorkdayCountryButton(page: Page, selector: string, values: string[]): Promise<boolean> {
  const trigger = page.locator(selector).first();
  if (!await trigger.isVisible().catch(() => false)) return false;
  await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
  await trigger.click().catch(() => undefined);
  await page.waitForTimeout(350);
  const picked = await chooseOpenWorkdayOptionFromCandidates(page, values);
  if (!picked) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }
  await page.waitForTimeout(250);
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(150);
  return verifyDropdownSelected(trigger, picked);
}

export async function fillWorkdayPhoneCodeRadioPicker(page: Page, selector: string, value: string): Promise<boolean> {
  const input = page.locator(selector).first();
  if (!await input.isVisible().catch(() => false)) return false;
  await input.scrollIntoViewIfNeeded().catch(() => undefined);
  await clearWorkdaySelectedItems(page, selector).catch(() => false);
  await page.waitForTimeout(200);
  await input.click().catch(() => undefined);

  let loaded = await waitForActiveWorkdayListbox(page);
  if (!loaded) {
    await input.press("ArrowDown").catch(() => undefined);
    loaded = await waitForActiveWorkdayListbox(page);
  }
  if (!loaded) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }

  await input.click().catch(() => undefined);
  await input.press("ControlOrMeta+A").catch(() => undefined);
  await input.press("Backspace").catch(() => undefined);
  await input.type(value, { delay: 35 }).catch(() => undefined);
  await input.press("Enter").catch(() => undefined);
  await page.waitForTimeout(250);

  const targetVisible = await waitForExactOpenWorkdayOption(page, value).catch(() => false);
  if (targetVisible) {
    await chooseExactOpenWorkdayOption(page, value).catch(() => false);
    await page.waitForTimeout(200);
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(100);
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(150);
  return verifyDropdownSelected(input, value);
}

async function fillWorkdayDateSection(
  page: Page,
  monthSelector: string,
  yearSelector: string,
  monthValue?: string,
  yearValue?: string
): Promise<boolean> {
  const month = normalizeMonthSectionValue(monthValue || "");
  const year = normalizeText(yearValue || "");
  const monthInput = page.locator(monthSelector).first();
  const yearInput = page.locator(yearSelector).first();
  const monthVisible = month ? await monthInput.isVisible().catch(() => false) : true;
  const yearVisible = year ? await yearInput.isVisible().catch(() => false) : true;
  if (!monthVisible || !yearVisible) return false;

  const setValue = async (locator: Locator, value: string): Promise<void> => {
    await locator.evaluate((element, nextValue) => {
      const input = element as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, nextValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    }, value).catch(() => undefined);
  };

  if (month) {
    await monthInput.click().catch(() => undefined);
    await monthInput.fill(month).catch(() => undefined);
  }

  if (year) {
    await yearInput.click().catch(() => undefined);
    await yearInput.fill(year).catch(() => undefined);
  }

  let monthOk = month ? await monthInput.inputValue().then((v) => {
    const actual = normalizeText(v);
    const expected = normalizeText(month);
    const altExpected = normalizeText(String(Number.parseInt(month, 10)));
    return actual === expected || (!!altExpected && actual === altExpected);
  }).catch(() => false) : true;
  let yearOk = year ? await yearInput.inputValue().then((v) => normalizeText(v) === normalizeText(year)).catch(() => false) : true;

  if (month && !monthOk) {
    await setValue(monthInput, String(Number.parseInt(month, 10) || month));
    monthOk = await monthInput.inputValue().then((v) => {
      const actual = normalizeText(v);
      const expected = normalizeText(month);
      const altExpected = normalizeText(String(Number.parseInt(month, 10)));
      return actual === expected || (!!altExpected && actual === altExpected);
    }).catch(() => false);
  }

  if (year && !yearOk) {
    await setValue(yearInput, year);
    yearOk = await yearInput.inputValue().then((v) => normalizeText(v) === normalizeText(year)).catch(() => false);
  }

  await yearInput.press("Tab").catch(() => undefined);
  return monthOk && yearOk;
}

async function fillWorkdayMonthYearComposite(
  page: Page,
  wrapperSelector: string,
  monthSelector: string,
  yearSelector: string,
  monthValue?: string,
  yearValue?: string
): Promise<boolean> {
  const month = normalizeMonthSectionValue(monthValue || "");
  const year = normalizeText(yearValue || "");
  if (!month || !year) return false;

  const monthInput = page.locator(monthSelector).first();
  const yearInput = page.locator(yearSelector).first();
  const monthVisible = await monthInput.isVisible().catch(() => false);
  const yearVisible = await yearInput.isVisible().catch(() => false);
  if (!monthVisible || !yearVisible) return false;

  const wrapper = page.locator(wrapperSelector).first();
  const composite = `${month}/${year}`;
  await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: "center" });
      el.focus();
    }
  }, monthSelector).catch(() => undefined);
  await page.keyboard.type(composite, { delay: 100 }).catch(() => undefined);
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForTimeout(250);

  const monthOk = await monthInput.inputValue().then((value) => {
    const actual = normalizeText(value);
    const expected = normalizeText(month);
    const altExpected = normalizeText(String(Number.parseInt(month, 10)));
    return actual === expected || (!!altExpected && actual === altExpected);
  }).catch(() => false);
  const yearOk = await yearInput.inputValue().then((value) => normalizeText(value) === normalizeText(year)).catch(() => false);
  if (monthOk && yearOk) {
    await yearInput.press("Tab").catch(() => undefined);
    return true;
  }

  const wrapperOk = await wrapper.innerText()
    .then((text) => normalizeText(text).includes(normalizeText(composite)))
    .catch(() => false);
  if (wrapperOk) {
    await yearInput.press("Tab").catch(() => undefined);
    return true;
  }

  return false;
}

async function fillWorkdayCountryInput(page: Page, selector: string, values: string[]): Promise<boolean> {
  const input = page.locator(selector).first();
  if (!await input.isVisible().catch(() => false)) return false;
  for (const value of values) {
    await input.click().catch(() => undefined);
    await input.fill("").catch(() => undefined);
    await input.type(value, { delay: 35 }).catch(() => undefined);
    const deadline = Date.now() + 4000;
    let ok = false;
    while (Date.now() < deadline) {
      ok = await chooseExactOpenWorkdayOption(page, value);
      if (ok) break;
      await page.waitForTimeout(200);
    }
    if (!ok) {
      await page.keyboard.press("Escape").catch(() => undefined);
      continue;
    }
    await page.waitForTimeout(250);
    await page.keyboard.press("Tab").catch(() => undefined);
    await page.waitForTimeout(150);
    if (await verifyDropdownSelected(input, value)) return true;
  }
  return false;
}

async function fillWorkdayButtonDropdown(input: {
  page: Page;
  triggerSelector: string;
  selectedOption: string;
  notes?: string[];
  label?: string;
  recovered?: boolean;
  allowKeyboardFallback?: boolean;
}): Promise<boolean> {
  const { page, triggerSelector, selectedOption, notes, label, recovered, allowKeyboardFallback = true } = input;
  const trigger = page.locator(triggerSelector).first();
  const visible = await trigger.isVisible().catch(() => false);
  if (!visible) return false;
  await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
  await trigger.click().catch(() => undefined);
  await page.waitForTimeout(250);

  const options = await extractScopedDropdownOptions(page, trigger);
  if (options.length) {
    notes?.push("workday_questionnaire_dropdown_detected");
    if (label) notes?.push(`workday_questionnaire_label:${normalizeText(label)}`);
    notes?.push(`workday_questionnaire_possible_answers:${options.join(" | ")}`);
  }

  const picked = pickFromOptions(selectedOption, options) || selectedOption;
  const clicked = await chooseScopedOpenWorkdayOption(page, trigger, picked).catch(() => false);

  if (!clicked && allowKeyboardFallback) {
    await page.keyboard.type(picked, { delay: 40 }).catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
  }

  const afterText = normalizeText((await trigger.innerText().catch(() => "")) || "");
  const accepted = Boolean(afterText && afterText !== "select one");
  if (accepted) {
    notes?.push(`workday_questionnaire_selected_answer:${afterText}`);
    if (recovered) notes?.push("workday_questionnaire_recovered=true");
  }
  return accepted;
}

async function fillQuestionnaireChoiceByLabel(input: {
  page: Page;
  questionPattern: RegExp;
  selectedOption: string;
  notes?: string[];
  recovered?: boolean;
}): Promise<boolean> {
  const { page, questionPattern, selectedOption, notes, recovered } = input;
  const container = page.locator("div[data-automation-id^='formField-'], fieldset").filter({ hasText: questionPattern }).first();
  if (!await container.isVisible().catch(() => false)) return false;

  const trigger = container.locator("button[aria-haspopup='listbox'], button[id^='primaryQuestionnaire--']").first();
  if (await trigger.isVisible().catch(() => false)) {
    const triggerSelector = await trigger.evaluate((el) => {
      const id = el.getAttribute("id");
      const name = el.getAttribute("name");
      if (id) return `button#${CSS.escape(id)}`;
      if (name) return `button[name="${name.replace(/"/g, '\\"')}"]`;
      return "";
    }).catch(() => "");
    if (triggerSelector) {
      return fillWorkdayButtonDropdown({
        page,
        triggerSelector,
        selectedOption,
        notes,
        label: questionPattern.source,
        recovered
      });
    }
  }

  const exactButton = container.getByText(new RegExp(`^${escapeRegExp(selectedOption)}$`, "i")).first();
  if (await exactButton.isVisible().catch(() => false)) {
    const clicked = await exactButton.click().then(() => true).catch(() => false);
    if (clicked) return true;
  }

  const checkbox = container.locator("label").filter({ hasText: new RegExp(`^${escapeRegExp(selectedOption)}$`, "i") }).first();
  if (await checkbox.isVisible().catch(() => false)) {
    const clicked = await checkbox.click().then(() => true).catch(() => false);
    if (clicked) return true;
  }

  return false;
}

async function fillQuestionnaireDateByLabel(page: Page, questionPattern: RegExp, month: string, day: string, year: string): Promise<boolean> {
  const container = page.locator("div[data-automation-id^='formField-'], fieldset").filter({ hasText: questionPattern }).first();
  if (!await container.isVisible().catch(() => false)) return false;
  const monthInput = container.locator("input[data-automation-id='dateSectionMonth-input']").first();
  const dayInput = container.locator("input[data-automation-id='dateSectionDay-input']").first();
  const yearInput = container.locator("input[data-automation-id='dateSectionYear-input']").first();
  if (!await monthInput.isVisible().catch(() => false) || !await dayInput.isVisible().catch(() => false) || !await yearInput.isVisible().catch(() => false)) return false;

  const setValue = async (locator: Locator, value: string): Promise<void> => {
    await locator.evaluate((element, nextValue) => {
      const input = element as HTMLInputElement;
      input.scrollIntoView({ block: "center", inline: "nearest" });
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, nextValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    }, value).catch(() => undefined);
  };

  const normalizePart = (value: string): string => normalizeText(value).replace(/^0+(?=\d)/, "");
  const partMatches = async (locator: Locator, value: string): Promise<boolean> => {
    return locator.inputValue().then((current) => normalizePart(current) === normalizePart(value)).catch(() => false);
  };

  await setValue(monthInput, month);
  await setValue(dayInput, day);
  await setValue(yearInput, year);

  let monthOk = await partMatches(monthInput, month);
  let dayOk = await partMatches(dayInput, day);
  let yearOk = await partMatches(yearInput, year);

  if (!monthOk) {
    await monthInput.click({ force: true }).catch(() => undefined);
    await page.keyboard.press("ControlOrMeta+A").catch(() => undefined);
    await page.keyboard.type(month, { delay: 35 }).catch(() => undefined);
    monthOk = await partMatches(monthInput, month);
  }
  if (!dayOk) {
    await dayInput.click({ force: true }).catch(() => undefined);
    await page.keyboard.press("ControlOrMeta+A").catch(() => undefined);
    await page.keyboard.type(day, { delay: 35 }).catch(() => undefined);
    dayOk = await partMatches(dayInput, day);
  }
  if (!yearOk) {
    await yearInput.click({ force: true }).catch(() => undefined);
    await page.keyboard.press("ControlOrMeta+A").catch(() => undefined);
    await page.keyboard.type(year, { delay: 35 }).catch(() => undefined);
    yearOk = await partMatches(yearInput, year);
  }

  await yearInput.press("Tab").catch(() => undefined);
  return monthOk && dayOk && yearOk;
}

async function resolveSelfIdentificationDateTarget(page: Page): Promise<SelfIdentificationDateTarget | null> {
  return page.evaluate(() => {
    const root = document.querySelector("div[data-automation-id='selfIdentificationPage'], main, form") || document.body;
    const attrs = {
      container: "data-automa-workday-self-ident-date-container",
      input: "data-automa-workday-self-ident-date-input",
      month: "data-automa-workday-self-ident-date-month",
      day: "data-automa-workday-self-ident-date-day",
      year: "data-automa-workday-self-ident-date-year",
      icon: "data-automa-workday-self-ident-date-icon",
      alert: "data-automa-workday-self-ident-date-alert"
    } as const;

    Object.values(attrs).forEach((attr) => {
      document.querySelectorAll(`[${attr}]`).forEach((node) => node.removeAttribute(attr));
    });

    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const closestFieldContainer = (node: Element | null): HTMLElement | null => {
      if (!(node instanceof HTMLElement)) return null;
      return node.closest<HTMLElement>("[data-automation-id^='formField-'], [data-automation-id='dateInputWrapper'], fieldset, div");
    };
    const mark = (node: HTMLElement | null, attr: string): string | undefined => {
      if (!node) return undefined;
      node.setAttribute(attr, "true");
      return `${node.tagName.toLowerCase()}[${attr}='true']`;
    };

    const findLabelContainer = (): HTMLElement | null => {
      const labels = Array.from(root.querySelectorAll<HTMLElement>("label, [data-automation-id='formLabel'], legend, h3, h4, p, span"));
      for (const label of labels) {
        if (!visible(label)) continue;
        const text = normalize(label.textContent || "");
        if (!/^date\b/.test(text)) continue;
        const linkedId = label.getAttribute("for") || "";
        const linked = linkedId ? root.querySelector(`#${CSS.escape(linkedId)}`) : null;
        const container = closestFieldContainer(linked) || closestFieldContainer(label);
        if (container && visible(container)) return container;
      }
      return null;
    };

    const findAlertContainer = (): HTMLElement | null => {
      const alerts = Array.from(root.querySelectorAll<HTMLElement>("p[data-automation-id='inputAlert'], [role='alert']"));
      for (const alert of alerts) {
        if (!visible(alert)) continue;
        const text = normalize(alert.textContent || "");
        if (!/date/.test(text) && !/required and must have a value/.test(text)) continue;
        const alertId = alert.getAttribute("id") || "";
        if (alertId) {
          const linked = root.querySelector<HTMLElement>(`[aria-describedby~="${alertId}"], [aria-errormessage~="${alertId}"]`);
          const linkedContainer = closestFieldContainer(linked);
          if (linkedContainer && visible(linkedContainer)) return linkedContainer;
        }
        const container = closestFieldContainer(alert);
        if (container && visible(container)) return container;
      }
      return null;
    };

    const findErrorAnchorContainer = (): HTMLElement | null => {
      const nodes = Array.from(root.querySelectorAll<HTMLElement>("a, button, [role='link'], [role='button'], li, p, div"));
      for (const node of nodes) {
        if (!visible(node)) continue;
        if (!/^error\s*-\s*date\b/.test(normalize(node.textContent || ""))) continue;
        return findLabelContainer();
      }
      return null;
    };

    const container = findAlertContainer() || findErrorAnchorContainer() || findLabelContainer();
    if (!container || !visible(container)) return null;

    const visibleTextInputs = Array.from(container.querySelectorAll<HTMLInputElement>("input:not([type='hidden']):not([type='checkbox']):not([type='radio'])"))
      .filter((node) => visible(node));
    const input = visibleTextInputs.find((node) => {
      const key = normalize(`${node.id} ${node.name} ${node.getAttribute("data-automation-id") || ""} ${node.getAttribute("placeholder") || ""} ${node.getAttribute("aria-label") || ""}`);
      return /date|signedon|mm\/dd\/yyyy/.test(key);
    }) || (visibleTextInputs.length === 1 ? (visibleTextInputs[0] || null) : null);
    const monthInput = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find((node) =>
      visible(node) && /month/i.test(`${node.id} ${node.name} ${node.getAttribute("data-automation-id") || ""}`)
    ) || null;
    const dayInput = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find((node) =>
      visible(node) && /day/i.test(`${node.id} ${node.name} ${node.getAttribute("data-automation-id") || ""}`)
    ) || null;
    const yearInput = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find((node) =>
      visible(node) && /year/i.test(`${node.id} ${node.name} ${node.getAttribute("data-automation-id") || ""}`)
    ) || null;
    const dateIcon = Array.from(container.querySelectorAll<HTMLElement>("div[data-automation-id='dateIcon'], button[data-automation-id='dateIcon'], button[aria-label*='Calendar' i], button[aria-label*='date' i]"))
      .find((node) => visible(node)) || null;
    const alert = Array.from(container.querySelectorAll<HTMLElement>("p[data-automation-id='inputAlert'], [role='alert']"))
      .find((node) => visible(node) && /date|required and must have a value/i.test(node.textContent || "")) || null;

    const resolved = {
      containerSelector: mark(container, attrs.container) || "",
      inputSelector: mark(input, attrs.input),
      monthSelector: mark(monthInput, attrs.month),
      daySelector: mark(dayInput, attrs.day),
      yearSelector: mark(yearInput, attrs.year),
      dateIconSelector: mark(dateIcon, attrs.icon),
      alertSelector: mark(alert, attrs.alert)
    };
    if (resolved.monthSelector && resolved.yearSelector) {
      resolved.inputSelector = undefined;
    }
    if (!resolved.containerSelector || (!resolved.inputSelector && !(resolved.monthSelector && resolved.yearSelector))) return null;
    return resolved;
  }).catch(() => null);
}

async function selfIdentificationDateAlertVisible(page: Page, target: SelfIdentificationDateTarget): Promise<boolean> {
  if (target.alertSelector) {
    const visible = await page.locator(target.alertSelector).first().isVisible().catch(() => false);
    if (visible) return true;
  }
  if (target.inputSelector) {
    const invalid = await page.locator(target.inputSelector).first()
      .evaluate((element) => (element.getAttribute("aria-invalid") || "").toLowerCase() === "true")
      .catch(() => false);
    if (invalid) return true;
  }
  return page.locator(`${target.containerSelector} p[data-automation-id='inputAlert'], ${target.containerSelector} [role='alert']`).first()
    .isVisible()
    .catch(() => false);
}

async function verifySelfIdentificationDateTarget(
  page: Page,
  target: SelfIdentificationDateTarget,
  expectedFormatted: string,
  month: string,
  day: string,
  year: string
): Promise<boolean> {
  if (target.monthSelector && target.yearSelector) {
    const [currentMonth, currentDay, currentYear] = await Promise.all([
      page.locator(target.monthSelector).first().inputValue().catch(() => ""),
      target.daySelector ? page.locator(target.daySelector).first().inputValue().catch(() => "") : Promise.resolve(""),
      page.locator(target.yearSelector).first().inputValue().catch(() => "")
    ]);
    const normalizePart = (value: string): string => normalizeText(value).replace(/^0+(?=\d)/, "");
    if (normalizePart(currentMonth) !== normalizePart(month)) return false;
    if (target.daySelector && normalizePart(currentDay) !== normalizePart(day)) return false;
    if (normalizePart(currentYear) !== normalizePart(year)) return false;
  } else if (target.inputSelector) {
    const inputValue = await page.locator(target.inputSelector).first().inputValue().catch(() => "");
    const normalized = normalizeText(inputValue);
    const digitsOnly = normalized.replace(/\D/g, "");
    const expectedDigits = `${month}${day}${year}`;
    if (!normalized || (normalized !== normalizeText(expectedFormatted) && !digitsOnly.includes(expectedDigits))) return false;
  } else {
    return false;
  }

  return !await selfIdentificationDateAlertVisible(page, target);
}

async function resolvePreferredWorkdayDateValues(page: Page, month: string, day: string, year: string): Promise<string[]> {
  const locale = await page.evaluate(() => {
    const htmlLang = document.documentElement.lang || "";
    const languageText = Array.from(document.querySelectorAll<HTMLElement>("button, div, span, a"))
      .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
      .find((text) => /english|español|français|deutsch|português/i.test(text)) || "";
    return `${htmlLang} ${languageText}`.trim().toLowerCase();
  }).catch(() => "");

  const mmddyyyy = `${month}/${day}/${year}`;
  const ddmmyyyy = `${day}/${month}/${year}`;
  if (/^(en-gb|en-au|en-nz)\b/.test(locale) || /\bfr\b|\bde\b|\bes\b|\bit\b|\bpt\b|\bnl\b|\bsv\b|\bfi\b|\bda\b/.test(locale)) {
    return Array.from(new Set([ddmmyyyy, mmddyyyy]));
  }
  return [mmddyyyy];
}

async function typeSelfIdentificationDateValue(
  page: Page,
  target: SelfIdentificationDateTarget,
  value: string,
  month: string,
  day: string,
  year: string
): Promise<boolean> {
  if (!target.inputSelector) return false;
  const input = page.locator(target.inputSelector).first();
  if (!await input.isVisible().catch(() => false)) return false;

  await input.scrollIntoViewIfNeeded().catch(() => undefined);
  await input.click({ force: true }).catch(() => undefined);
  await page.keyboard.press("ControlOrMeta+A").catch(() => undefined);
  await page.keyboard.type(value, { delay: 45 }).catch(() => undefined);
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(450);
  if (await verifySelfIdentificationDateTarget(page, target, value, month, day, year)) return true;

  await input.fill("").catch(() => undefined);
  await input.fill(value).catch(() => undefined);
  await input.evaluate((element, nextValue) => {
    const inputNode = element as HTMLInputElement;
    inputNode.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(inputNode, nextValue);
    inputNode.dispatchEvent(new Event("input", { bubbles: true }));
    inputNode.dispatchEvent(new Event("change", { bubbles: true }));
    inputNode.dispatchEvent(new Event("blur", { bubbles: true }));
  }, value).catch(() => undefined);
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(650);
  return verifySelfIdentificationDateTarget(page, target, value, month, day, year);
}

async function typeSelfIdentificationDateSections(
  page: Page,
  target: SelfIdentificationDateTarget,
  expectedFormatted: string,
  month: string,
  day: string,
  year: string
): Promise<boolean> {
  if (!target.monthSelector || !target.yearSelector) return false;
  const monthInput = page.locator(target.monthSelector).first();
  const dayInput = target.daySelector ? page.locator(target.daySelector).first() : null;
  const yearInput = page.locator(target.yearSelector).first();
  if (!await monthInput.isVisible().catch(() => false) || !await yearInput.isVisible().catch(() => false)) return false;
  if (dayInput && !await dayInput.isVisible().catch(() => false)) return false;

  const setPart = async (locator: Locator, value: string): Promise<void> => {
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await locator.click({ force: true }).catch(() => undefined);
    await page.keyboard.press("ControlOrMeta+A").catch(() => undefined);
    await page.keyboard.press("Backspace").catch(() => undefined);
    await locator.fill("").catch(() => undefined);
    await page.keyboard.type(value, { delay: 40 }).catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
    await locator.fill(value).catch(() => undefined);
    await locator.evaluate((element, nextValue) => {
      const inputNode = element as HTMLInputElement;
      inputNode.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(inputNode, nextValue);
      inputNode.dispatchEvent(new Event("input", { bubbles: true }));
      inputNode.dispatchEvent(new Event("change", { bubbles: true }));
      inputNode.dispatchEvent(new Event("blur", { bubbles: true }));
    }, value).catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
    await locator.press("Tab").catch(() => undefined);
  };

  await monthInput.fill("").catch(() => undefined);
  if (dayInput) await dayInput.fill("").catch(() => undefined);
  await yearInput.fill("").catch(() => undefined);
  await page.waitForTimeout(80);
  await setPart(monthInput, month);
  if (dayInput) await setPart(dayInput, day);
  await setPart(yearInput, year);
  await yearInput.press("Tab").catch(() => undefined);
  await page.waitForTimeout(650);
  return verifySelfIdentificationDateTarget(page, target, expectedFormatted, month, day, year);
}

async function selectSelfIdentificationDateToday(
  page: Page,
  target: SelfIdentificationDateTarget,
  expectedValues: string[],
  month: string,
  day: string,
  year: string
): Promise<boolean> {
  if (!target.dateIconSelector) return false;
  const clicked = await safeClick(page, target.dateIconSelector);
  if (!clicked) return false;

  const todayButton = page.locator("button").filter({ hasText: /today/i }).first();
  const typedTodayButton = await todayButton.isVisible({ timeout: 1200 }).catch(() => false)
    ? todayButton
    : page.locator("button[data-automation-id='datePickerSelectedToday'], button[data-automation-id='datePickerCurrentDate']").first();
  if (!await typedTodayButton.isVisible({ timeout: 1500 }).catch(() => false)) return false;
  await typedTodayButton.click({ force: true }).catch(() => undefined);

  if (target.inputSelector) {
    await page.locator(target.inputSelector).first().press("Tab").catch(() => undefined);
  } else if (target.yearSelector) {
    await page.locator(target.yearSelector).first().press("Tab").catch(() => undefined);
  }
  await page.waitForTimeout(650);

  for (const expected of expectedValues) {
    if (await verifySelfIdentificationDateTarget(page, target, expected, month, day, year)) return true;
  }
  return false;
}

async function verifySelfIdentificationDateAfterSettle(
  page: Page,
  target: SelfIdentificationDateTarget,
  expectedValues: string[],
  month: string,
  day: string,
  year: string,
  settleMs = 1200
): Promise<boolean> {
  await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    active?.blur?.();
  }).catch(() => undefined);
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(settleMs);
  for (const expected of expectedValues) {
    if (await verifySelfIdentificationDateTarget(page, target, expected, month, day, year)) return true;
  }
  return false;
}

async function setSelfIdentificationDateSectionsDirect(
  page: Page,
  target: SelfIdentificationDateTarget,
  expectedFormatted: string,
  month: string,
  day: string,
  year: string
): Promise<boolean> {
  if (!target.monthSelector || !target.yearSelector) return false;
  const setValue = async (selector: string | undefined, value: string): Promise<void> => {
    if (!selector) return;
    const locator = page.locator(selector).first();
    await locator.evaluate((element, nextValue) => {
      const input = element as HTMLInputElement;
      input.scrollIntoView({ block: "center", inline: "nearest" });
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, nextValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    }, value).catch(() => undefined);
  };

  await setValue(target.monthSelector, month);
  if (target.daySelector) await setValue(target.daySelector, day);
  await setValue(target.yearSelector, year);
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(450);
  return verifySelfIdentificationDateTarget(page, target, expectedFormatted, month, day, year);
}

export async function fillSelfIdentificationDateField(page: Page, notes?: string[]): Promise<boolean> {
  const today = currentDateParts();
  const target = await resolveSelfIdentificationDateTarget(page);
  if (!target) return false;
  notes?.push("workday_self_identification_date_detected");

  const preferredValues = await resolvePreferredWorkdayDateValues(page, today.month, today.day, today.year);
  if (await verifySelfIdentificationDateAfterSettle(page, target, preferredValues, today.month, today.day, today.year, 100)) {
    notes?.push("workday_self_identification_date_strategy:preexisting");
    notes?.push(`workday_self_identification_date_value:${preferredValues[0] || today.formatted}`);
    notes?.push("workday_self_identification_date_verified");
    return true;
  }
  if (await setSelfIdentificationDateSectionsDirect(page, target, preferredValues[0] || today.formatted, today.month, today.day, today.year)) {
    notes?.push("workday_self_identification_date_strategy:direct_sections");
    notes?.push(`workday_self_identification_date_value:${preferredValues[0] || today.formatted}`);
    notes?.push("workday_self_identification_date_verified");
    return true;
  }
  if (await selectSelfIdentificationDateToday(page, target, preferredValues, today.month, today.day, today.year)) {
    notes?.push("workday_self_identification_date_strategy:date_picker_today");
    notes?.push(`workday_self_identification_date_value:${preferredValues[0] || today.formatted}`);
    notes?.push("workday_self_identification_date_verified");
    return true;
  }
  if (target.monthSelector && target.yearSelector &&
    await typeSelfIdentificationDateSections(page, target, preferredValues[0] || today.formatted, today.month, today.day, today.year)) {
    notes?.push("workday_self_identification_date_strategy:typed");
    notes?.push(`workday_self_identification_date_value:${preferredValues[0] || today.formatted}`);
    notes?.push("workday_self_identification_date_verified");
    return true;
  }
  if (await verifySelfIdentificationDateAfterSettle(page, target, preferredValues, today.month, today.day, today.year)) {
    notes?.push("workday_self_identification_date_strategy:typed");
    notes?.push(`workday_self_identification_date_value:${preferredValues[0] || today.formatted}`);
    notes?.push("workday_self_identification_date_verified");
    return true;
  }

  for (const value of preferredValues) {
    if (!await typeSelfIdentificationDateValue(page, target, value, today.month, today.day, today.year)) continue;
    notes?.push("workday_self_identification_date_strategy:typed");
    notes?.push(`workday_self_identification_date_value:${value}`);
    notes?.push("workday_self_identification_date_verified");
    return true;
  }
  if (await verifySelfIdentificationDateAfterSettle(page, target, preferredValues, today.month, today.day, today.year)) {
    notes?.push("workday_self_identification_date_strategy:typed");
    notes?.push(`workday_self_identification_date_value:${preferredValues[0] || today.formatted}`);
    notes?.push("workday_self_identification_date_verified");
    return true;
  }

  if (await selectSelfIdentificationDateToday(page, target, preferredValues, today.month, today.day, today.year)) {
    notes?.push("workday_self_identification_date_strategy:date_picker_today");
    notes?.push(`workday_self_identification_date_value:${preferredValues[0] || today.formatted}`);
    notes?.push("workday_self_identification_date_verified");
    return true;
  }
  if (await verifySelfIdentificationDateAfterSettle(page, target, preferredValues, today.month, today.day, today.year)) {
    notes?.push("workday_self_identification_date_strategy:date_picker_today");
    notes?.push(`workday_self_identification_date_value:${preferredValues[0] || today.formatted}`);
    notes?.push("workday_self_identification_date_verified");
    return true;
  }

  return false;
}

async function fillPrimaryQuestionnaireKnownAnswers(
  page: Page,
  profile: NormalizedWorkdayProfile,
  filledFields: FilledFieldRecord[],
  notes?: string[],
  recovered?: boolean,
  enableLanguage = true
): Promise<void> {
  const eligibleChoice = profile.workAuthorization.authorizedInUS && !profile.workAuthorization.requiresSponsorship ? "Yes" : "No";
  const eligibleFieldset = page.locator("fieldset").filter({ hasText: /eligible to work.*without visa sponsorship/i }).first();
  if (await eligibleFieldset.isVisible().catch(() => false)) {
    const trigger = eligibleFieldset.locator("button[aria-haspopup='listbox']").first();
    const triggerSelector = await trigger.evaluate((el) => {
      const id = el.getAttribute("id");
      const name = el.getAttribute("name");
      if (id) return `button#${CSS.escape(id)}`;
      if (name) return `button[name="${name.replace(/"/g, '\\"')}"]`;
      return "";
    }).catch(() => "");
    if (triggerSelector) {
      const ok = await fillWorkdayButtonDropdown({
        page,
        triggerSelector,
        selectedOption: eligibleChoice,
        notes,
        label: "eligible to work without visa sponsorship",
        recovered
      });
      if (ok) {
        filledFields.push({
          id: "workday_primary_eligible_without_sponsorship",
          label: "Eligible to Work Without Sponsorship",
          value: eligibleChoice,
          source: "profile",
          inputKind: "dropdown"
        });
      }
    }
  }

  const policyFieldset = page.locator("fieldset").filter({ hasText: /tobacco.*drug.*alcohol.*polic/i }).first();
  if (await policyFieldset.isVisible().catch(() => false)) {
    const trigger = policyFieldset.locator("button[aria-haspopup='listbox']").first();
    const triggerSelector = await trigger.evaluate((el) => {
      const id = el.getAttribute("id");
      const name = el.getAttribute("name");
      if (id) return `button#${CSS.escape(id)}`;
      if (name) return `button[name="${name.replace(/"/g, '\\"')}"]`;
      return "";
    }).catch(() => "");
    if (triggerSelector) {
      const ok = await fillWorkdayButtonDropdown({
        page,
        triggerSelector,
        selectedOption: "Yes",
        notes,
        label: "tobacco drug alcohol policy",
        recovered
      });
      if (ok) {
        filledFields.push({
          id: "workday_primary_policy_ack",
          label: "Tobacco Drug Alcohol Policy",
          value: "Yes",
          source: "profile",
          inputKind: "dropdown"
        });
      }
    }
  }

  const veteranFieldset = page.locator("fieldset").filter({ hasText: /self-identify as a veteran|\bveteran\b/i }).first();
  if (await veteranFieldset.isVisible().catch(() => false)) {
    const trigger = veteranFieldset.locator("button[aria-haspopup='listbox']").first();
    const triggerSelector = await trigger.evaluate((el) => {
      const id = el.getAttribute("id");
      const name = el.getAttribute("name");
      if (id) return `button#${CSS.escape(id)}`;
      if (name) return `button[name="${name.replace(/"/g, '\\"')}"]`;
      return "";
    }).catch(() => "");
    if (triggerSelector) {
      const desired = profile.demographics.veteranStatus || "I am not a veteran";
      const ok = await fillWorkdayButtonDropdown({
        page,
        triggerSelector,
        selectedOption: desired,
        notes,
        label: "veteran status",
        recovered
      });
      if (ok) {
        filledFields.push({
          id: "workday_primary_veteran_status",
          label: "Veteran Status",
          value: desired,
          source: "profile",
          inputKind: "dropdown"
        });
      }
    }
  }

  const neitherSelected = await fillQuestionnaireCheckboxGroupByLabel(page, /if hired, do you intend to/i, "Neither").catch(() => false);
  if (neitherSelected) notes?.push("workday_questionnaire_intent_neither_checked=true");

  const relocateOk = await fillQuestionnaireChoiceByLabel({
    page,
    questionPattern: /willing to relocate|open to relocation/i,
    selectedOption: "Yes",
    notes,
    recovered
  }).catch(() => false);
  if (relocateOk) notes?.push("workday_questionnaire_relocation_filled=true");

  const date = currentDateParts();
  const availabilityOk = await fillQuestionnaireDateByLabel(page, /date of availability|availability date|date availability/i, date.month, date.day, date.year).catch(() => false);
  if (availabilityOk) notes?.push(`workday_questionnaire_availability_filled:${date.formatted}`);

  const travelOk = await fillQuestionnaireChoiceByLabel({
    page,
    questionPattern: /percentage.*travel|able to travel|willing to travel/i,
    selectedOption: "0%",
    notes,
    recovered
  }).catch(() => false);
  if (travelOk) notes?.push("workday_questionnaire_travel_filled=0%");

  const authOk = await fillQuestionnaireChoiceByLabel({
    page,
    questionPattern: /authorized to work lawfully|authorized to work.*flex|eligible to work/i,
    selectedOption: "Yes",
    notes,
    recovered
  }).catch(() => false);
  if (authOk) notes?.push("workday_questionnaire_auth_filled=yes");

  const sponsorshipOk = await fillQuestionnaireChoiceByLabel({
    page,
    questionPattern: /sponsor.*immigration case|sponsorship|visa status/i,
    selectedOption: "No",
    notes,
    recovered
  }).catch(() => false);
  if (sponsorshipOk) notes?.push("workday_questionnaire_sponsorship_filled=no");

  const ageOk = await fillQuestionnaireChoiceByLabel({
    page,
    questionPattern: /at least age 18|18 years of age|over the age of 18/i,
    selectedOption: "Yes",
    notes,
    recovered
  }).catch(() => false);
  if (ageOk) notes?.push("workday_questionnaire_age_filled=yes");

  const nonCompeteOk = await fillQuestionnaireChoiceByLabel({
    page,
    questionPattern: /non-compete|non-solicit|non-disclosure obligations/i,
    selectedOption: "No",
    notes,
    recovered
  }).catch(() => false);
  if (nonCompeteOk) {
    notes?.push("workday_questionnaire_non_compete_filled=no");
  } else {
    const nonCompeteTextarea = page
      .locator("div[data-automation-id^='formField-'], fieldset")
      .filter({ hasText: /non-compete|non-solicit|non-disclosure obligations/i })
      .locator("textarea")
      .first();
    if (await nonCompeteTextarea.isVisible().catch(() => false)) {
      await nonCompeteTextarea.fill("No").catch(() => undefined);
      const committed = await nonCompeteTextarea.inputValue().then((value) => normalizeText(value) === "no").catch(() => false);
      if (committed) notes?.push("workday_questionnaire_non_compete_filled=no");
    }
  }

  if (enableLanguage) {
    const languageFieldsets = await page.locator("fieldset").all();
    const languageContainers = page
    .locator("div[data-automation-id*='language' i], div[data-automation-id^='formField-'], fieldset")
    .filter({ hasText: /language|english|proficiency|speak|read|write/i });
    const languageContainerCount = await languageContainers.count().catch(() => 0);
    if (languageContainerCount > 0) notes?.push(`workday_language_fieldset_detected:${languageContainerCount}`);

    for (let c = 0; c < languageContainerCount; c += 1) {
    const container = languageContainers.nth(c);
    const label = normalizeText(await container.locator("legend, [data-automation-id*='richText'], label, h3, h4").first().innerText().catch(() => ""));
    const triggers = container.locator("button[aria-haspopup='listbox'], button:has-text('Select One')");
    const triggerCount = await triggers.count().catch(() => 0);
    if (triggerCount === 0) continue;
    notes?.push(`workday_language_dropdown_count:${triggerCount}`);
    for (let i = 0; i < triggerCount; i += 1) {
      const trigger = triggers.nth(i);
      const visible = await trigger.isVisible().catch(() => false);
      if (!visible) continue;
      notes?.push(`workday_language_dropdown_label:${label || "language"}`);
      await trigger.click().catch(() => undefined);
      await humanPause(page, 220, 420);
      const options = await extractScopedDropdownOptions(page, trigger);
      await page.keyboard.press("Escape").catch(() => undefined);
      notes?.push(`workday_language_dropdown_options:${options.join(" | ")}`);
      const selected = pickStrongLanguageOption(options, label || "language") || "English";
      try {
        const committed = await fillWorkdayDropdownAndCommit(page, trigger, selected, label || "language");
        notes?.push(`workday_language_dropdown_selected:${committed}`);
      } catch {
        // best-effort; recovery required sweep handles remaining unresolved controls
      }
      await humanPause(page, 220, 420);
    }
    }

    for (const fieldset of languageFieldsets) {
    const visible = await fieldset.isVisible().catch(() => false);
    if (!visible) continue;
    const legendText = normalizeText(await fieldset.locator("legend").first().innerText().catch(() => ""));
    if (!legendText || !isLanguageQuestionnaireLegend(legendText)) continue;

    const triggers = await fieldset.locator("button[aria-haspopup='listbox']").all();
    for (let i = 0; i < triggers.length; i += 1) {
      const trigger = triggers[i]!;
      const triggerSelector = await trigger.evaluate((el) => {
        const id = el.getAttribute("id");
        const name = el.getAttribute("name");
        if (id) return `button#${CSS.escape(id)}`;
        if (name) return `button[name="${name.replace(/"/g, '\\"')}"]`;
        return "";
      }).catch(() => "");
      if (!triggerSelector) continue;

      await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
      await trigger.click().catch(() => undefined);
      await page.waitForTimeout(250);
      const options = await extractDropdownOptions(page);
      await page.keyboard.press("Escape").catch(() => undefined);

      const selectedOption = i === 0
        ? (pickLanguageIdentityOption(options) || pickStrongLanguageOption(options, legendText) || "English")
        : (pickStrongLanguageOption(options, legendText) || pickLanguageQuestionnaireOption(options) || "Fluent");
      let ok = false;
      try {
        const committed = await fillWorkdayDropdownAndCommit(page, trigger, selectedOption, `${legendText}:${i + 1}`);
        notes?.push(`workday_language_dropdown_selected:${committed}`);
        ok = true;
      } catch {
        ok = await fillWorkdayButtonDropdown({
          page,
          triggerSelector,
          selectedOption,
          notes,
          label: `${legendText}:${i + 1}`,
          recovered,
          allowKeyboardFallback: false
        });
      }
      if (ok) {
        filledFields.push({
          id: `workday_primary_language_${filledFields.length + 1}`,
          label: `${legendText}:${i + 1}`,
          value: selectedOption,
          source: "profile",
          inputKind: "dropdown"
        });
      }
      await page.waitForTimeout(220);
    }
    }
  }
}

async function fillSelfIdentificationKnownAnswers(
  page: Page,
  profile: NormalizedWorkdayProfile,
  filledFields: FilledFieldRecord[],
  notes?: string[],
  recovered?: boolean
): Promise<void> {
  const container = page.locator("div[data-automation-id='selfIdentificationPage'], main, form").first();
  if (!await container.isVisible().catch(() => false)) return;

  const focusForKeyboard = async (locator: Locator): Promise<boolean> => {
    const exists = await locator.count().then((count) => count > 0).catch(() => false);
    if (!exists) return false;
    await locator.evaluate((element) => {
      const target = element as HTMLElement;
      target.scrollIntoView({ block: "center", inline: "nearest" });
      target.focus();
    }).catch(() => undefined);
    await page.waitForTimeout(120);
    return locator.evaluate((element) => document.activeElement === element).catch(() => false);
  };

  const verifyTextValue = async (locator: Locator, value: string): Promise<boolean> => {
    return locator.inputValue().then((current) => normalizeText(current) === normalizeText(value)).catch(() => false);
  };

  const verifyChoiceChecked = async (choiceLabel: string): Promise<boolean> => {
    return page.evaluate((wanted) => {
      const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const wantedText = normalize(wanted);
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input[type='checkbox'], input[type='radio']"));
      return inputs.some((input) => {
        const label =
          (input.id ? document.querySelector(`label[for="${input.id.replace(/"/g, '\\"')}"]`) : null)?.textContent ||
          input.closest("label")?.textContent ||
          input.parentElement?.textContent ||
          input.closest("li, div, fieldset")?.textContent ||
          "";
        const normalizedLabel = normalize(label);
        return input.checked && (normalizedLabel === wantedText || normalizedLabel.startsWith(wantedText));
      });
    }, choiceLabel).catch(() => false);
  };

  const setInputValue = async (locator: Locator, value: string): Promise<boolean> => {
    if (await focusForKeyboard(locator)) {
      await page.keyboard.press("ControlOrMeta+A").catch(() => undefined);
      await page.keyboard.type(value, { delay: 40 }).catch(() => undefined);
      await page.keyboard.press("Tab").catch(() => undefined);
      await page.waitForTimeout(180);
    }

    await locator.fill(value).catch(() => undefined);
    let ok = await verifyTextValue(locator, value);
    if (ok) return true;
    await locator.evaluate((element, nextValue) => {
      const input = element as HTMLInputElement | HTMLTextAreaElement;
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      setter?.call(input, nextValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    }, value).catch(() => undefined);
    await locator.press("Tab").catch(() => undefined);
    return verifyTextValue(locator, value);
  };

  const clickSelfIdentificationChoice = async (choiceLabel: string): Promise<boolean> => {
    const selection = await page.evaluate((wanted) => {
      const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const clickInput = (input: HTMLInputElement | null): string => {
        if (!input) return "";
        input.scrollIntoView({ block: "center", inline: "nearest" });
        input.click();
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return input.id || "";
      };

      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input[type='checkbox'], input[type='radio']"));
      const matchedInput = inputs.find((input) => {
        const label = input.id ? document.querySelector(`label[for="${input.id.replace(/"/g, '\\"')}"]`) : null;
        const nearby = label?.textContent || input.closest("label")?.textContent || input.parentElement?.textContent || input.closest("li, div, fieldset")?.textContent || "";
        const normalizedNearby = normalize(nearby);
        const normalizedWanted = normalize(wanted);
        return normalizedNearby === normalizedWanted || normalizedNearby.startsWith(normalizedWanted);
      });
      return clickInput(matchedInput || null);
    }, choiceLabel).catch(() => "");

    if (selection) {
      const input = page.locator(exactIdSelector(selection)).first();
      const alreadyChecked = await input.isChecked().catch(() => false);
      if (!alreadyChecked) {
        await input.evaluate((element) => {
          const target = element as HTMLInputElement;
          target.scrollIntoView({ block: "center", inline: "nearest" });
          target.click();
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
        }).catch(() => undefined);
      }
      if (await input.isChecked().catch(() => false) && await verifyChoiceChecked(choiceLabel)) return true;
    }

    const label = page.locator("label").filter({ hasText: new RegExp(`^${escapeRegExp(choiceLabel)}`, "i") }).first();
    if (await label.isVisible().catch(() => false)) {
      await label.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(180);
      return verifyChoiceChecked(choiceLabel);
    }

    return false;
  };

  const nameInput = page.locator("#selfIdentifiedDisabilityData--name").first();
  if (await nameInput.isVisible().catch(() => false)) {
    const committed = await setInputValue(nameInput, profile.identity.fullName);
    if (committed) {
      notes?.push("workday_self_ident_name_filled");
      filledFields.push({
        id: "workday_self_ident_name",
        label: "Self Identify Name",
        value: profile.identity.fullName,
        source: "profile",
        inputKind: "text"
      });
    }
  }

  const today = currentDateParts();
  const dateOk = await fillSelfIdentificationDateField(page, notes).catch(() => false);
  if (dateOk) notes?.push(`workday_self_ident_date_filled:${today.formatted}`);

  const disabilityChoice = profile.demographics.disabilityStatus === "yes"
    ? "Yes"
    : profile.demographics.disabilityStatus === "decline"
      ? "I don't wish to answer"
      : "No";
  const exactChoice = disabilityChoice === "No"
    ? "No, I do not have a disability and have not had one in the past"
    : disabilityChoice === "Yes"
      ? "Yes, I have a disability, or have had one in the past"
      : "I do not want to answer";
  let disabilityOk = await clickSelfIdentificationChoice(exactChoice);
  if (!disabilityOk) {
    disabilityOk = await fillQuestionnaireChoiceByLabel({
      page,
      questionPattern: /disability/i,
      selectedOption: disabilityChoice,
      notes,
      recovered
    }).catch(() => false);
  }
  disabilityOk = disabilityOk && await verifyChoiceChecked(exactChoice);
  if (disabilityOk) {
    notes?.push(`workday_self_ident_disability_filled:${normalizeText(disabilityChoice)}`);
  } else {
    notes?.push("workday_self_ident_disability_unverified");
  }
}

async function fillVoluntaryDisclosureKnownAnswers(
  page: Page,
  profile: NormalizedWorkdayProfile,
  filledFields: FilledFieldRecord[],
  notes?: string[],
  recovered?: boolean
): Promise<void> {
  const normalizeLabel = (value: string): string => value.replace(/\s+/g, " ").trim();
  const findVoluntaryDisclosureContainer = async (pattern: RegExp): Promise<Locator | null> => {
    const candidates = page.locator("div[data-automation-id^='formField-'], fieldset");
    const count = await candidates.count().catch(() => 0);
    let bestIndex = -1;
    let bestLength = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i += 1) {
      const candidate = candidates.nth(i);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const hasDropdown = await candidate.locator("button[aria-haspopup='listbox']").first().isVisible().catch(() => false);
      if (!hasDropdown) continue;
      const label = await readVoluntaryDisclosureLabel(candidate);
      const bodyText = normalizeLabel(await candidate.innerText().catch(() => ""));
      if (!pattern.test(label) && !pattern.test(bodyText)) continue;
      const score = `${label} ${bodyText}`.length;
      if (score < bestLength) {
        bestLength = score;
        bestIndex = i;
      }
    }
    return bestIndex >= 0 ? candidates.nth(bestIndex) : null;
  };
  const readVoluntaryDisclosureLabel = async (container: Locator): Promise<string> => {
    const directLabel = await container.locator("legend, label, [data-automation-id='formLabel'], [data-automation-id*='richText']").first().innerText().catch(() => "");
    if (normalizeLabel(directLabel)) return normalizeLabel(directLabel);
    const buttonAria = await container.locator("button[aria-haspopup='listbox']").first().getAttribute("aria-label").catch(() => "");
    if (normalizeLabel(String(buttonAria || ""))) {
      return normalizeLabel(String(buttonAria || "").replace(/\bselect one\b/ig, "").replace(/\brequired\b/ig, ""));
    }
    return "";
  };
  const collectVisibleErrorAnchorLabels = async (): Promise<string[]> => {
    return page.evaluate(() => {
      const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
      const visible = (node: Element | null): node is HTMLElement => {
        if (!(node instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const nodes = Array.from(document.querySelectorAll<HTMLElement>("a, button, [role='link'], [role='button'], li, p, div"))
        .filter((node) => visible(node))
        .map((node) => normalize(node.textContent || ""))
        .filter((text) => /^error\s*-\s*/i.test(text) || /^what is your race\/ethnicity\??/i.test(text));
      return Array.from(new Set(nodes.map((text) => text.replace(/^error\s*-\s*/i, "").replace(/\s+/g, " ").trim())));
    }).catch(() => [] as string[]);
  };
  const fillVoluntaryDisclosureDropdown = async (container: Locator | null): Promise<boolean> => {
    if (!container) return false;
    if (!await container.isVisible().catch(() => false)) return false;
    const label = await readVoluntaryDisclosureLabel(container);
    if (!label) return false;
    notes?.push(`workday_voluntary_disclosure_field_detected:${label}`);

    const trigger = container.locator("button[aria-haspopup='listbox']").first();
    if (!await trigger.isVisible().catch(() => false)) return false;
    await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
    await trigger.click().catch(() => undefined);
    await page.waitForTimeout(220);
    const options = await extractScopedDropdownOptions(page, trigger);
    await page.keyboard.press("Escape").catch(() => undefined);
    notes?.push(`workday_voluntary_disclosure_options:${label}:${options.join(" | ")}`);

    const selectedOption = resolveWorkdayVoluntaryDisclosureOption(label, options, profile);
    if (!selectedOption) return false;
    notes?.push(`workday_voluntary_disclosure_selected:${label}:${selectedOption}`);

    try {
      await fillWorkdayDropdownAndCommit(page, trigger, selectedOption, label);
    } catch {
      return false;
    }

    const verified = await verifyDropdownSelected(trigger, selectedOption);
    if (verified) {
      notes?.push(`workday_voluntary_disclosure_verified:${label}`);
      filledFields.push({
        id: `workday_voluntary_disclosure:${normalizeText(label).replace(/[^a-z0-9]+/g, "_")}`,
        label,
        value: selectedOption,
        source: "profile",
        inputKind: "dropdown"
      });
    }
    return verified;
  };

  const anchoredLabels = recovered ? await collectVisibleErrorAnchorLabels() : [];
  for (const anchoredLabel of anchoredLabels) {
    const anchoredContainer = await findVoluntaryDisclosureContainer(new RegExp(`^\\s*${escapeRegExp(anchoredLabel)}\\s*\\*?\\s*$`, "i"));
    if (await fillVoluntaryDisclosureDropdown(anchoredContainer)) {
      break;
    }
  }

  await fillVoluntaryDisclosureDropdown(await findVoluntaryDisclosureContainer(/best defines your gender|gender/i)).catch(() => false);
  await fillVoluntaryDisclosureDropdown(await findVoluntaryDisclosureContainer(/race\/ethnicity|ethnicity|race/i)).catch(() => false);
  await fillVoluntaryDisclosureDropdown(await findVoluntaryDisclosureContainer(/hispanic|latino/i)).catch(() => false);
  await fillVoluntaryDisclosureDropdown(await findVoluntaryDisclosureContainer(/veteran status|\bveteran\b/i)).catch(() => false);
  await fillVoluntaryDisclosureDropdown(await findVoluntaryDisclosureContainer(/disability/i)).catch(() => false);

  const termsSelector = "#termsAndConditions--acceptTermsAndAgreements";
  const termsCheckbox = page.locator(termsSelector).first();
  const termsVisible = await termsCheckbox.isVisible().catch(() => false);
  const termsAttached = await termsCheckbox.count().then((count) => count > 0).catch(() => false);
  if (termsVisible || termsAttached) {
    let checked = await termsCheckbox.isChecked().catch(() => false);
    if (!checked) {
      await termsCheckbox.check({ force: true }).catch(async () => {
        const clicked = await safeClick(page, termsSelector);
        if (!clicked) {
          await clickAssociatedLabel(page, termsSelector);
        }
      });
      checked = await termsCheckbox.isChecked().catch(() => false);
    }
    if (!checked) {
      const labelClicked = await page
        .locator("div[data-automation-id^='formField-'], fieldset, div")
        .filter({ hasText: /yes,\s*i have read and consented to the terms and conditions/i })
        .locator("label, span, div")
        .first()
        .click({ force: true })
        .then(() => true)
        .catch(() => false);
      if (labelClicked) {
        checked = await termsCheckbox.isChecked().catch(() => false);
      }
    }
    if (checked) {
      notes?.push("workday_terms_consent_checked");
      filledFields.push({
        id: "workday_terms_consent",
        label: "Terms And Conditions Consent",
        value: "true",
        source: "profile",
        inputKind: "checkbox"
      });
    }
  }
}

async function fillWebsiteLinks(page: Page, profile: NormalizedWorkdayProfile, filledFields: FilledFieldRecord[]): Promise<void> {
  let linkedinHandledByDedicatedField = false;
  const directLinkedin = page.locator("input[data-automation-id='linkedinQuestion']").first();
  if (profile.links.linkedin && await directLinkedin.isVisible().catch(() => false)) {
    const currentDirectLinkedin = normalizeText(await directLinkedin.inputValue().catch(() => ""));
    if (!currentDirectLinkedin) {
      await directLinkedin.fill(profile.links.linkedin).catch(() => undefined);
      filledFields.push({ id: "linkedinQuestion", label: "LinkedIn", value: profile.links.linkedin, source: "profile", inputKind: "text" });
    } else {
      filledFields.push({ id: "linkedinQuestion", label: "LinkedIn", value: currentDirectLinkedin, source: "manual", inputKind: "text" });
    }
    linkedinHandledByDedicatedField = true;
    if (!profile.links.github && !profile.links.portfolio && !(profile.links.other || []).length) return;
  }

  const anchoredSocialInputSelector = await page.evaluate(() => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const selectorFor = (control: HTMLElement): string => {
      const id = String(control.getAttribute("id") || "").trim();
      if (id) return `${control.tagName.toLowerCase()}#${id.replace(/([.#:[\],= ])/g, "\\$1")}`;
      const automationId = String(control.getAttribute("data-automation-id") || "").trim();
      if (automationId) return `${control.tagName.toLowerCase()}[data-automation-id="${automationId.replace(/"/g, '\\"')}"]`;
      const name = String(control.getAttribute("name") || "").trim();
      if (name) return `${control.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`;
      return "";
    };

    const containers = Array.from(document.querySelectorAll("section, fieldset, div[data-automation-id], div"));
    for (const container of containers) {
      const headings = Array.from(container.querySelectorAll("h1, h2, h3, h4, legend, label"))
        .map((node) => normalize(node.textContent || ""))
        .filter(Boolean);
      if (!headings.some((heading) => heading === "social network urls" || heading === "linkedin profile url")) continue;
      const input = Array.from(container.querySelectorAll<HTMLElement>("input:not([type='hidden']):not([type='file'])"))
        .find((node) => visible(node));
      if (!input) continue;
      const selector = selectorFor(input);
      if (selector) return selector;
    }

    return "";
  }).catch(() => "");

  const socialNetworkInput = page.locator([
    anchoredSocialInputSelector,
    "input[data-automation-id='linkedinQuestion']"
  ].filter(Boolean).join(", ")).first();
  if (profile.links.linkedin && await socialNetworkInput.isVisible().catch(() => false)) {
    const currentSocialValue = normalizeText(await socialNetworkInput.inputValue().catch(() => ""));
    if (!currentSocialValue) {
      await socialNetworkInput.fill(profile.links.linkedin).catch(() => undefined);
      filledFields.push({ id: "socialNetworkUrls", label: "Social Network URLs", value: profile.links.linkedin, source: "profile", inputKind: "text" });
    } else {
      filledFields.push({ id: "socialNetworkUrls", label: "Social Network URLs", value: currentSocialValue, source: "manual", inputKind: "text" });
    }
    linkedinHandledByDedicatedField = true;
    if (!profile.links.github && !profile.links.portfolio && !(profile.links.other || []).length) return;
  }

  const ordered = [
    linkedinHandledByDedicatedField ? null : profile.links.linkedin,
    profile.links.github,
    profile.links.portfolio,
    ...(profile.links.other || [])
  ].filter(Boolean) as string[];
  if (!ordered.length) return;

  const addWebsitePanel = async (): Promise<boolean> => {
    const addSelectors = [
      "div[data-automation-id='websiteSection'] button[data-automation-id='Add']",
      "div[data-automation-id='websiteSection'] button[data-automation-id*='Add']",
      "div[data-automation-id='websiteSection'] button[data-automation-id*='add']"
    ];
    for (const selector of addSelectors) {
      const clicked = await safeClick(page, selector);
      if (clicked) {
        await page.waitForTimeout(450);
        return true;
      }
    }
    return false;
  };

  const collectVisibleWebsiteInputs = async () => {
    const selectors = [
      "div[data-automation-id='websiteSection'] div[data-automation-id^='websitePanelSet-'] input:not([type='hidden'])",
      "div[data-automation-id='websiteSection'] input:not([type='hidden'])"
    ];
    const inputs = page.locator(selectors.join(", "));
    const count = await inputs.count().catch(() => 0);
    const visible: Array<{ index: number; value: string }> = [];
    for (let index = 0; index < count; index += 1) {
      const input = inputs.nth(index);
      if (!await input.isVisible().catch(() => false)) continue;
      visible.push({
        index,
        value: normalizeText(await input.inputValue().catch(() => ""))
      });
    }
    return { inputs, visible };
  };

  let websiteInputs = await collectVisibleWebsiteInputs();
  const filledGenericValues = websiteInputs.visible.map((entry) => entry.value).filter(Boolean);
  if (filledGenericValues.length >= ordered.length) {
    filledGenericValues.slice(0, ordered.length).forEach((value, index) => {
      filledFields.push({ id: `website:${index + 1}`, label: "Website", value, source: "manual", inputKind: "text" });
    });
    return;
  }

  while (websiteInputs.visible.length < ordered.length) {
    const added = await addWebsitePanel();
    if (!added) break;
    websiteInputs = await collectVisibleWebsiteInputs();
  }

  let inputCursor = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    const desired = ordered[i]!;
    while (inputCursor < websiteInputs.visible.length) {
      const slot = websiteInputs.visible[inputCursor]!;
      const input = websiteInputs.inputs.nth(slot.index);
      if (slot.value) {
        filledFields.push({ id: `website:${i + 1}`, label: "Website", value: slot.value, source: "manual", inputKind: "text" });
        inputCursor += 1;
        continue;
      }
      await input.fill(desired).catch(() => undefined);
      filledFields.push({ id: `website:${i + 1}`, label: "Website", value: desired, source: "profile", inputKind: "text" });
      inputCursor += 1;
      break;
    }
  }
}

function upsertFilledFieldRecord(filledFields: FilledFieldRecord[], next: FilledFieldRecord): void {
  const index = filledFields.findIndex((field) => field.id === next.id || field.label === next.label);
  if (index >= 0) filledFields[index] = next;
  else filledFields.push(next);
}

function readFilledFieldValue(filledFields: FilledFieldRecord[], id: string): string {
  return String(filledFields.find((field) => field.id === id)?.value || "");
}

function readFilledFieldCount(filledFields: FilledFieldRecord[], id: string): number {
  const parsed = Number.parseInt(readFilledFieldValue(filledFields, id), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function detectResumeAlreadyPresent(page: Page, fileName: string): Promise<boolean> {
  if (!fileName) return false;
  const visibleFile = await page.locator(`text=${fileName}`).first().isVisible().catch(() => false);
  if (visibleFile) return true;
  return page
    .locator(`text=Successfully Uploaded!, text=successfully uploaded`)
    .first()
    .isVisible()
    .catch(() => false);
}

async function ensureEducationPanels(
  page: Page,
  profile: NormalizedWorkdayProfile,
  filledFields: FilledFieldRecord[],
  notes?: string[]
): Promise<void> {
  const desiredRows = profile.education.map((edu) => ({ primary: edu.school, secondary: edu.degree }));
  let addClicked = 0;
  let filledCount = 0;
  let prefixes = await settlePanelPrefixes(page, "--school");
  const baseline = await inspectWorkdaySectionRowBaseline(page, "[data-automation-id='educationSection']", "--school");
  notes?.push(`workday_education_baseline:estimated=${baseline.estimatedExistingCount}:prefixes=${baseline.prefixCount}:deleteButtons=${baseline.deleteButtonCount}:visibleFields=${baseline.hasVisibleFields ? "true" : "false"}`);
  let visibleRows = await collectVisibleEducationRows(page, prefixes);
  let plan = planPanelRowAssignments(visibleRows, desiredRows);
  const addClicksBudget = Math.min(
    plan.addCount,
    computePanelCollectionAddClicks(desiredRows.length, baseline.estimatedExistingCount)
  );
  for (let addAttempt = 0; addAttempt < addClicksBudget && plan.addCount > 0; addAttempt += 1) {
    const previousBaseline = await inspectWorkdaySectionRowBaseline(page, "[data-automation-id='educationSection']", "--school");
    const clicked = await clickEducationSectionAddButton(page);
    if (!clicked) break;
    addClicked += 1;
    await waitForPanelPrefixGrowth(page, "--school", previousBaseline.prefixCount);
    prefixes = await settlePanelPrefixes(page, "--school");
    const nextBaseline = await inspectWorkdaySectionRowBaseline(page, "[data-automation-id='educationSection']", "--school");
    if (nextBaseline.estimatedExistingCount <= previousBaseline.estimatedExistingCount) {
      notes?.push(`workday_education_add_stalled:before=${previousBaseline.estimatedExistingCount}:after=${nextBaseline.estimatedExistingCount}`);
      break;
    }
    visibleRows = await collectVisibleEducationRows(page, prefixes);
    plan = planPanelRowAssignments(visibleRows, desiredRows);
  }

  for (const assignment of plan.assignments) {
    const prefix = prefixes[assignment.visibleIndex];
    const edu = profile.education[assignment.desiredIndex];
    if (!prefix || !edu) continue;
    await fillEducationRow(page, prefix, edu);
    filledFields.push({
      id: `education:${assignment.desiredIndex + 1}`,
      label: "Education",
      value: `${edu.school} - ${edu.degree}`,
      source: "profile",
      inputKind: "panel_collection"
    });
    filledCount += 1;
  }

  upsertFilledFieldRecord(filledFields, {
    id: "__edu_add_clicked__",
    label: "workday_education_add_clicked",
    value: String(addClicked),
    source: "manual",
    inputKind: "panel_collection"
  });
  upsertFilledFieldRecord(filledFields, {
    id: "__edu_filled_count__",
    label: "workday_education_filled_count",
    value: String(filledCount),
    source: "manual",
    inputKind: "panel_collection"
  });
}

export async function prepareMyExperienceStep(
  page: Page,
  profile: NormalizedWorkdayProfile,
  filledFields: FilledFieldRecord[],
  notes?: string[]
): Promise<void> {
  notes?.push("workday_experience_section_detected=true");
  const experienceAlreadyPresent = await hasSatisfiedExperiencePanelRows(page, profile);
  if (experienceAlreadyPresent) {
    notes?.push("workday_my_experience_prepare_skipped:work_experience");
  } else {
    const removedRowsBeforeFill = await removeBlankExperienceRows(page, profile.experience.length);
    if (removedRowsBeforeFill) notes?.push(`workday_blank_experience_rows_removed_before_fill:${removedRowsBeforeFill}`);
    await fillWorkExperiencePanels(page, profile, filledFields, notes);
    const removedRowsAfterFill = await removeBlankExperienceRows(page, profile.experience.length);
    if (removedRowsAfterFill) notes?.push(`workday_blank_experience_rows_removed_after_fill:${removedRowsAfterFill}`);
  }

  const educationAlreadyPresent = await hasSatisfiedEducationPanelRows(page, profile);
  if (educationAlreadyPresent) {
    notes?.push("workday_my_experience_prepare_skipped:education");
  } else {
    await ensureEducationPanels(page, profile, filledFields, notes);
  }

  const skillsAlreadyPresent = await hasCommittedSkills(page, profile.skills);
  if (skillsAlreadyPresent) {
    notes?.push("workday_my_experience_prepare_skipped:skills");
  } else {
    await fillSkills(page, profile.skills, filledFields);
  }

  const resumeState = profile.files.resumePath ? await inspectMyExperienceResumeState(page) : { handled: false, duplicateCount: 0 };
  if (profile.files.resumePath && resumeState.handled) {
    upsertFilledFieldRecord(filledFields, {
      id: "resume_upload",
      label: "Resume Upload",
      value: profile.files.resumePath,
      source: "manual",
      inputKind: "file"
    });
    notes?.push("workday_my_experience_prepare_skipped:resume");
  } else {
    await fillResume(page, profile.files.resumePath, filledFields, notes);
  }

  await fillWebsiteLinks(page, profile, filledFields);
  const removedRowsBeforeContinue = await removeBlankExperienceRows(page, profile.experience.length);
  if (removedRowsBeforeContinue) notes?.push(`workday_blank_experience_rows_removed_before_continue:${removedRowsBeforeContinue}`);
  notes?.push(`workday_work_experience_add_clicked:${filledFields.find((f) => f.label === "workday_work_experience_add_clicked")?.value || "0"}`);
  notes?.push(`workday_work_experience_filled_count:${filledFields.find((f) => f.label === "workday_work_experience_filled_count")?.value || "0"}`);
  notes?.push(`workday_education_add_clicked:${filledFields.find((f) => f.label === "workday_education_add_clicked")?.value || "0"}`);
  const skillFillCount = filledFields.filter((field) => field.id.startsWith("skill:")).length;
  notes?.push(`workday_skills_filled_count:${skillFillCount}`);
  notes?.push(`workday_links_filled_count:${[profile.links.linkedin, profile.links.github, profile.links.portfolio, ...(profile.links.other || [])].filter(Boolean).length}`);
  if (filledFields.some((field) => field.id === "resume_upload")) notes?.push("workday_resume_uploaded");
}

async function fillWorkExperiencePanels(
  page: Page,
  profile: NormalizedWorkdayProfile,
  filledFields: FilledFieldRecord[],
  notes?: string[]
): Promise<void> {
  const desiredRows = profile.experience.map((exp) => ({ primary: exp.jobTitle, secondary: exp.company }));
  let addClicked = 0;
  let filledCount = 0;
  let prefixes = await settlePanelPrefixes(page, "--jobTitle");
  const baseline = await inspectWorkdaySectionRowBaseline(page, "[data-automation-id='workExperienceSection']", "--jobTitle");
  notes?.push(`workday_work_experience_baseline:estimated=${baseline.estimatedExistingCount}:prefixes=${baseline.prefixCount}:deleteButtons=${baseline.deleteButtonCount}:visibleFields=${baseline.hasVisibleFields ? "true" : "false"}`);
  const addClicksNeeded = computePanelCollectionAddClicks(profile.experience.length, baseline.estimatedExistingCount);
  for (let addAttempt = 0; addAttempt < addClicksNeeded; addAttempt += 1) {
    const previousBaseline = await inspectWorkdaySectionRowBaseline(page, "[data-automation-id='workExperienceSection']", "--jobTitle");
    const clicked = await clickWorkExperienceSectionAddButton(page);
    if (!clicked) break;
    addClicked += 1;
    await waitForPanelPrefixGrowth(page, "--jobTitle", previousBaseline.prefixCount);
    prefixes = await settlePanelPrefixes(page, "--jobTitle");
    const nextBaseline = await inspectWorkdaySectionRowBaseline(page, "[data-automation-id='workExperienceSection']", "--jobTitle");
    if (nextBaseline.estimatedExistingCount <= previousBaseline.estimatedExistingCount) {
      notes?.push(`workday_work_experience_add_stalled:before=${previousBaseline.estimatedExistingCount}:after=${nextBaseline.estimatedExistingCount}`);
      break;
    }
  }
  const visibleRows = await collectVisibleExperienceRows(page, prefixes);
  const plan = planPanelRowAssignments(visibleRows, desiredRows);

  for (const assignment of plan.assignments) {
    const prefix = prefixes[assignment.visibleIndex];
    const exp = profile.experience[assignment.desiredIndex];
    if (!prefix || !exp) continue;

    await fillExperienceRow(page, prefix, exp);
    filledFields.push({
      id: `experience:${assignment.desiredIndex + 1}`,
      label: "Work Experience",
      value: `${exp.jobTitle} @ ${exp.company}`,
      source: "profile",
      inputKind: "panel_collection"
    });
    filledCount += 1;
  }
  upsertFilledFieldRecord(filledFields, { id: "__work_exp_add_clicked__", label: "workday_work_experience_add_clicked", value: String(addClicked), source: "manual", inputKind: "panel_collection" });
  upsertFilledFieldRecord(filledFields, { id: "__work_exp_filled_count__", label: "workday_work_experience_filled_count", value: String(filledCount), source: "manual", inputKind: "panel_collection" });
}

export async function executeWorkdayFillPlan(input: {
  page: Page;
  plan: ResolvedAnswer[];
  schema: WorkdayFieldSchema[];
  profile: NormalizedWorkdayProfile;
  currentStep: string;
  filledFields: FilledFieldRecord[];
  notes?: string[];
  recoveryMode?: boolean;
  deterministicMode?: boolean;
}): Promise<void> {
  const { page, plan, schema, profile, currentStep, filledFields, notes, recoveryMode } = input;
  const betweenFieldDelayMs = recoveryMode ? 320 : 520;

  if (currentStep === "my_experience" && !recoveryMode) {
    await prepareMyExperienceStep(page, profile, filledFields, notes);
  }

  if (currentStep === "contact_information") {
    await fillResume(page, profile.files.resumePath, filledFields, notes);
  }

  if (currentStep === "application_questions" || currentStep === "unknown") {
    const salaryDefault = "120000";
    const salaryTextarea = page
      .locator("div[data-automation-id='applyFlowPrimaryQuestionsPage'] textarea[required], div[data-automation-id='applyFlowPrimaryQuestionsPage'] textarea[aria-required='true']")
      .first();
    const salaryVisible = await salaryTextarea.isVisible().catch(() => false);
    if (salaryVisible) {
      const empty = await salaryTextarea.inputValue().then((v) => !String(v || "").trim()).catch(() => true);
      if (empty) {
        await salaryTextarea.fill(salaryDefault).catch(() => undefined);
        notes?.push("workday_salary_textarea_filled");
      }
    }
  }

  if (currentStep === "voluntary_disclosures" || currentStep === "self_identification") {
    if (currentStep === "voluntary_disclosures") {
      await fillVoluntaryDisclosureKnownAnswers(page, profile, filledFields, notes, recoveryMode);
    } else {
      await fillSelfIdentificationKnownAnswers(page, profile, filledFields, notes, recoveryMode);
    }
  }

  if (currentStep === "voluntary_disclosures") {
    const consentCheckbox = page
      .locator("div[data-automation-id='voluntaryDisclosuresPage'] input[type='checkbox']")
      .first();
    if (await consentCheckbox.isVisible().catch(() => false)) {
      const checked = await consentCheckbox.isChecked().catch(() => false);
      if (!checked) {
        await consentCheckbox.click().catch(() => undefined);
        notes?.push("workday_consent_checkbox_checked");
      }
    }
  }

  const schemaById = new Map(schema.map((f) => [f.fieldId, f]));
  for (const answer of plan) {
    if (answer.value === null || answer.value === undefined) continue;
    const field = schemaById.get(answer.questionId);
    if (!field) continue;

    const selector = field.selectorHints.selector;
    if (!selector) continue;
    const automationId = (field.selectorHints.dataAutomationId || "").trim();
    const choiceValue = String(Array.isArray(answer.value) ? answer.value[0] : answer.value);
    const labelKey = field.label.toLowerCase();
    const currentValue = Array.isArray(field.currentValue) ? field.currentValue.join(" ") : String(field.currentValue || "");
    if (currentValue && normalizeText(currentValue).includes(normalizeText(choiceValue))) {
      continue;
    }

    let applied = false;
    if (field.step === "contact_information" && /country\/region phone code|country phone code/.test(labelKey)) {
      applied = await fillWorkdayPhoneCodeRadioPicker(page, selector, "United States of America (+1)");
    } else if (field.step === "contact_information" && /^country\/region/.test(labelKey) && !/phone code/.test(labelKey)) {
      applied = await fillWorkdayCountryButton(page, selector, ["United States of America"]);
    } else
    if (isSourcePrompt(field.label, automationId) && (field.fieldType === "text" || field.fieldType === "unknown")) {
      applied = await fillWorkdaySourcePrompt(page, selector, choiceValue);
      if (!applied) {
        applied = await safeFill(page, selector, choiceValue);
        if (applied) await page.keyboard.press("Enter").catch(() => undefined);
      }
    } else
    if (field.fieldType === "dropdown" || field.fieldType === "search_combobox") {
      if (selector.startsWith("button#primaryQuestionnaire--") || selector.includes("primaryQuestionnaire--")) {
        applied = await fillWorkdayButtonDropdown({
          page,
          triggerSelector: selector,
          selectedOption: choiceValue,
          notes,
          label: field.label,
          recovered: recoveryMode
        });
      } else {
        applied = await fillWorkdayDropdown(page, selector, choiceValue);
      }
    } else if (
      field.fieldType === "unknown" &&
      (
        selector.startsWith("button") ||
        /how did you hear|phone device type|country phone code|state|region|country/.test(labelKey) ||
        /source|phone(type|[-_ ]device)|country(region|phonecode)?|primaryquestionnaire/.test(automationId)
      )
    ) {
      applied = await fillWorkdayDropdown(page, selector, choiceValue);
      if (!applied && automationId) {
        applied = await fillWorkdayDropdown(page, `button[data-automation-id='${automationId}']`, choiceValue);
      }
      if (!applied && automationId) {
        applied = await fillWorkdayDropdown(page, `[data-automation-id='${automationId}'][role='combobox']`, choiceValue);
      }
      if (!applied) {
        applied = await safeFill(page, selector, choiceValue);
      }
    } else if (field.fieldType === "checkbox") {
      if (typeof answer.value === "string" && !["true", "false", "yes", "no", "1", "0"].includes(String(answer.value).toLowerCase())) {
        applied = await fillQuestionnaireCheckboxGroupBySelector(page, selector, String(answer.value));
        if (!applied) {
          applied = await fillQuestionnaireCheckboxGroupByLabel(page, new RegExp(escapeRegExp(field.label), "i"), String(answer.value));
        }
      } else {
        const checkbox = page.locator(selector).first();
        const boolValue = typeof answer.value === "boolean"
          ? answer.value
          : ["true", "yes", "1"].includes(String(answer.value).toLowerCase());
        const checked = await checkbox.isChecked().catch(() => false);
        if (boolValue) {
          if (!checked) {
            await checkbox.check({ force: true }).catch(async () => {
              const clicked = await safeClick(page, selector);
              if (!clicked) {
                await clickAssociatedLabel(page, selector);
              }
            });
            const stillUnchecked = !(await checkbox.isChecked().catch(() => false));
            if (stillUnchecked) {
              await clickAssociatedLabel(page, selector);
            }
          }
          applied = await checkbox.isChecked().catch(() => false);
        } else {
          applied = !checked;
        }
      }
    } else if (field.fieldType === "radio") {
      const choice = choiceValue;
      if (/^(yes|no)$/i.test(labelKey) && /^(yes|no)$/i.test(choice)) {
        applied = choice.toLowerCase() === "no" ? await safeClick(page, selector) : false;
      } else {
        const ok = await safeClick(page, `${selector}:has-text('${choice}')`);
        applied = ok || await safeClick(page, selector);
      }
    } else if (field.fieldType === "file") {
      await fillResume(page, String(answer.value), filledFields, notes);
      applied = true;
    } else {
      applied = await safeFill(page, selector, choiceValue);
    }

    if (applied) {
      filledFields.push({
        id: field.fieldId,
        label: field.label,
        value: Array.isArray(answer.value) ? answer.value.join(", ") : String(answer.value),
        source: answer.source === "llm" ? "llm" : "profile",
        inputKind: field.fieldType
      });
    }
    await page.waitForTimeout(betweenFieldDelayMs);
  }
}

export function serializeWorkdayWidgetAnswer(answer: WorkdayWidgetAnswer): ResolvedAnswer {
  return {
    questionId: answer.widgetId,
    value: Array.isArray(answer.value) ? answer.value.join("/") : answer.value,
    source: answer.source === "llm" ? "llm" : answer.source === "rule" ? "rule" : "profile",
    reason: answer.reason
  };
}

export interface WorkdayWidgetExecutionResult {
  widgetId: string;
  executed: boolean;
  verified: boolean;
  failureReason?: string;
}

function normalizePanelValue(primary: string, secondary: string): string {
  return normalizeText(`${primary} ${secondary}`).toLowerCase();
}

export function pickWorkdayPromptOption(preferredValue: string, options: string[]): string | null {
  const normalized = options
    .map((option) => ({ raw: option, normalized: normalizeText(option) }))
    .filter((option) => option.normalized && !/^(select one|all|partial list \(first 500 entries\)|no items\.?)$/i.test(option.normalized));
  if (!normalized.length) return null;
  const preferred = normalizeText(preferredValue);
  const exact = normalized.find((option) => option.normalized.toLowerCase() === preferred.toLowerCase());
  if (exact) return exact.raw;
  const fuzzy = normalized.find((option) => option.normalized.toLowerCase().includes(preferred.toLowerCase()) || preferred.toLowerCase().includes(option.normalized.toLowerCase()));
  if (fuzzy) return fuzzy.raw;
  return normalized[0]?.raw || null;
}

export function normalizeDateWidgetValue(widgetType: "date_mm_yyyy" | "date_mm_dd_yyyy", raw: string | string[]): string[] {
  if (Array.isArray(raw)) {
    return raw.map((part) => normalizeText(part)).filter(Boolean).slice(0, widgetType === "date_mm_yyyy" ? 2 : 3);
  }

  const normalized = normalizeText(raw);
  if (!normalized) return [];

  const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return widgetType === "date_mm_yyyy" ? [month!, year!] : [month!, day!, year!];
  }

  const slashMatch = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    let first = slashMatch[1]!.padStart(2, "0");
    let second = slashMatch[2]!.padStart(2, "0");
    const year = slashMatch[3]!;
    if (Number.parseInt(first, 10) > 12) {
      [first, second] = [second, first];
    }
    return widgetType === "date_mm_yyyy" ? [first, year] : [first, second, year];
  }

  const values = normalized.split(/[\/\-\s]+/).map((part) => normalizeText(part)).filter(Boolean);
  return values.slice(0, widgetType === "date_mm_yyyy" ? 2 : 3);
}

export function shouldClearDateWidgetBeforeRefill(
  widgetType: "date_mm_yyyy" | "date_mm_dd_yyyy",
  currentParts: string[],
  nextParts: string[]
): boolean {
  const current = currentParts.map((part) => normalizeText(part ?? ""));
  const next = nextParts.map((part) => normalizeText(part));
  if (!current.length || !next.length) return false;
  if (current.every((part) => !part)) return false;

  if (widgetType === "date_mm_dd_yyyy") {
    const [currentMonth = "", currentDay = "", currentYear = ""] = current;
    const [nextMonth = "", nextDay = "", nextYear = ""] = next;
    if (currentMonth && (!currentDay || !currentYear)) return true;
    if (currentYear && nextYear && currentYear !== nextYear) return true;
    if (currentMonth && nextMonth && currentMonth !== nextMonth && (!currentDay || !currentYear)) return true;
  }

  if (widgetType === "date_mm_yyyy") {
    const [currentMonth = "", currentYear = ""] = current;
    const [nextMonth = "", nextYear = ""] = next;
    if (currentMonth && !currentYear) return true;
    if (currentYear && nextYear && currentYear !== nextYear) return true;
    if (currentMonth && nextMonth && currentMonth !== nextMonth && !currentYear) return true;
  }

  return false;
}

interface PanelRowMatchInput {
  primary: string;
  secondary: string;
}

export function planPanelRowAssignments(visibleRows: PanelRowMatchInput[], desiredRows: PanelRowMatchInput[]): {
  assignments: Array<{ visibleIndex: number; desiredIndex: number }>;
  addCount: number;
} {
  const assignments: Array<{ visibleIndex: number; desiredIndex: number }> = [];
  const usedVisible = new Set<number>();
  const usedDesired = new Set<number>();

  for (let desiredIndex = 0; desiredIndex < desiredRows.length; desiredIndex += 1) {
    const desired = desiredRows[desiredIndex]!;
    const desiredKey = normalizePanelValue(desired.primary, desired.secondary);
    if (!desiredKey) continue;
    const visibleIndex = visibleRows.findIndex((row, index) => !usedVisible.has(index) && normalizePanelValue(row.primary, row.secondary) === desiredKey);
    if (visibleIndex >= 0) {
      usedVisible.add(visibleIndex);
      usedDesired.add(desiredIndex);
      assignments.push({ visibleIndex, desiredIndex });
    }
  }

  const remainingVisible = visibleRows.map((_, index) => index).filter((index) => !usedVisible.has(index));
  const remainingDesired = desiredRows.map((_, index) => index).filter((index) => !usedDesired.has(index));
  const pairCount = Math.min(remainingVisible.length, remainingDesired.length);
  for (let i = 0; i < pairCount; i += 1) {
    assignments.push({ visibleIndex: remainingVisible[i]!, desiredIndex: remainingDesired[i]! });
  }

  return {
    assignments,
    addCount: Math.max(0, desiredRows.length - visibleRows.length)
  };
}

export function computePanelCollectionAddClicks(desiredCount: number, estimatedExistingCount: number): number {
  if (desiredCount <= 0) return 0;
  return Math.max(0, desiredCount - Math.max(0, estimatedExistingCount));
}

export function computeWorkExperienceAddClicks(profileExperienceCount: number, hasPrerenderedRow: boolean): number {
  return computePanelCollectionAddClicks(profileExperienceCount, hasPrerenderedRow ? 1 : 0);
}

type WorkdaySectionRowBaseline = {
  prefixCount: number;
  deleteButtonCount: number;
  hasVisibleFields: boolean;
  estimatedExistingCount: number;
};

async function inspectWorkdaySectionRowBaseline(
  page: Page,
  sectionSelector: string,
  fieldIdSuffix: string
): Promise<WorkdaySectionRowBaseline> {
  const prefixes = await collectWorkdayPanelPrefixes(page, fieldIdSuffix);
  const structure = await page.evaluate((selector) => {
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const section = document.querySelector(selector);
    if (!visible(section)) {
      return {
        deleteButtonCount: 0,
        hasVisibleFields: false
      };
    }
    const visibleControls = Array.from(section.querySelectorAll("input, textarea, [role='combobox'], button[aria-haspopup='listbox']"))
      .filter((node) => visible(node) && normalize(node.getAttribute("data-automation-id") || "") !== "add");
    const deleteButtons = Array.from(section.querySelectorAll("button"))
      .filter((button) => visible(button))
      .filter((button) => {
        const key = normalize(`${button.textContent || ""} ${button.getAttribute("aria-label") || ""} ${button.getAttribute("data-automation-id") || ""}`);
        return /delete|remove/.test(key);
      });
    return {
      deleteButtonCount: deleteButtons.length,
      hasVisibleFields: visibleControls.length > 0
    };
  }, sectionSelector).catch(() => ({
    deleteButtonCount: 0,
    hasVisibleFields: false
  }));

  const estimatedExistingCount = Math.max(
    prefixes.length,
    structure.deleteButtonCount,
    structure.hasVisibleFields ? 1 : 0
  );
  return {
    prefixCount: prefixes.length,
    deleteButtonCount: structure.deleteButtonCount,
    hasVisibleFields: structure.hasVisibleFields,
    estimatedExistingCount
  };
}

async function clickOptionSelector(page: Page, selector: string): Promise<boolean> {
  const input = page.locator(selector).first();
  const id = await input.getAttribute("id").catch(() => null);
  if (id) {
    const label = page.locator(`label[for="${id.replace(/"/g, '\\"')}"]`).first();
    if (await label.isVisible().catch(() => false)) {
      const clicked = await label.click({ force: true }).then(() => true).catch(() => false);
      if (clicked) return true;
    }
  }
  const closestLabelClicked = await input.evaluate((element) => {
    const inputNode = element as HTMLInputElement;
    const label = inputNode.closest("label");
    if (!(label instanceof HTMLElement)) return false;
    label.click();
    return inputNode.checked;
  }).catch(() => false);
  if (closestLabelClicked) return true;
  const parentClicked = await input.evaluate((element) => {
    const inputNode = element as HTMLInputElement;
    const container = inputNode.closest("div, li, fieldset");
    if (!(container instanceof HTMLElement)) return false;
    container.click();
    inputNode.dispatchEvent(new Event("input", { bubbles: true }));
    inputNode.dispatchEvent(new Event("change", { bubbles: true }));
    return inputNode.checked;
  }).catch(() => false);
  if (parentClicked) return true;
  if (!await input.isVisible().catch(() => false)) {
    return input.evaluate((element) => {
      const inputNode = element as HTMLInputElement;
      inputNode.click();
      inputNode.dispatchEvent(new Event("input", { bubbles: true }));
      inputNode.dispatchEvent(new Event("change", { bubbles: true }));
      return inputNode.checked;
    }).catch(() => false);
  }
  return input.click({ force: true }).then(() => true).catch(() => false);
}

async function verifyRadioOption(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).first().isChecked().catch(() => false);
}

function workdayWidgetDebugFieldType(widget: WorkdayWidgetSchema): string {
  switch (widget.widgetType) {
    case "textarea":
      return "textarea";
    case "button_select":
      return "dropdown";
    case "prompt_input_select":
      return "combobox";
    case "radio_group":
      return "radio";
    case "checkbox_group":
      return widget.options.length > 1 ? "checkbox_group" : "checkbox";
    case "date_mm_yyyy":
    case "date_mm_dd_yyyy":
      return "date";
    case "text_input": {
      const inputType = String(widget.htmlSummary.inputType || "").toLowerCase();
      return inputType === "number" ? "number" : "text";
    }
    case "file_upload":
      return "file";
    case "panel_collection":
      return "panel_collection";
    default:
      return "unknown";
  }
}

async function readWidgetInputLikeValue(page: Page, selector?: string): Promise<string> {
  if (!selector) return "";
  const locator = page.locator(selector).first();
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) return "";
  return locator.inputValue().catch(async () => (
    locator.evaluate((el) => {
      const ownText = (el.textContent || "").replace(/\s+/g, " ").trim();
      const inputValue = "value" in el ? String((el as HTMLInputElement).value || "") : "";
      return `${ownText} ${inputValue}`.replace(/\s+/g, " ").trim();
    }).catch(() => "")
  ));
}

async function readWidgetCurrentValue(page: Page, widget: WorkdayWidgetSchema): Promise<string | string[]> {
  if (widget.widgetType === "date_mm_yyyy") {
    const month = await readWidgetInputLikeValue(page, widget.selectorHints.monthSelector);
    const year = await readWidgetInputLikeValue(page, widget.selectorHints.yearSelector);
    return [month, year];
  }
  if (widget.widgetType === "date_mm_dd_yyyy") {
    const month = await readWidgetInputLikeValue(page, widget.selectorHints.monthSelector);
    const day = await readWidgetInputLikeValue(page, widget.selectorHints.daySelector);
    const year = await readWidgetInputLikeValue(page, widget.selectorHints.yearSelector);
    return [month, day, year];
  }
  if (widget.widgetType === "radio_group") {
    for (const [option, selector] of Object.entries(widget.selectorHints.optionSelectors || {})) {
      const checked = await page.locator(selector).first().isChecked().catch(() => false);
      if (checked) return option;
    }
    return "";
  }
  if (widget.widgetType === "checkbox_group") {
    const selected: string[] = [];
    for (const [option, selector] of Object.entries(widget.selectorHints.optionSelectors || {})) {
      const checked = await page.locator(selector).first().isChecked().catch(() => false);
      if (checked) selected.push(option);
    }
    return selected;
  }
  if (widget.widgetType === "file_upload") {
    const selector = widget.selectorHints.containerSelector || widget.selectorHints.controlSelector || widget.selectorHints.fileInputSelector;
    if (!selector) return "";
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) return "";
    return locator.evaluate((el) => {
      const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
      const control = el as HTMLElement;
      const container = control.closest("[data-automation-id^='formField-'], [data-automation-id*='formField'], fieldset, [role='group'], section, div") as HTMLElement | null;
      return normalize(container?.innerText || control.innerText || "");
    }).catch(() => "");
  }
  if (widget.widgetType === "button_select" || widget.widgetType === "prompt_input_select") {
    const selector = widget.selectorHints.controlSelector || widget.selectorHints.containerSelector;
    if (!selector) return "";
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) return "";
    return locator.evaluate((el) => {
      const ownText = (el.textContent || "").replace(/\s+/g, " ").trim();
      const inputValue = "value" in el ? String((el as HTMLInputElement).value || "") : "";
      const parent = el.parentElement;
      const selectionLabel = parent?.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent?.replace(/\s+/g, " ").trim() || "";
      return `${ownText} ${inputValue} ${selectionLabel}`.replace(/\s+/g, " ").trim();
    }).catch(() => "");
  }
  return readWidgetInputLikeValue(page, widget.selectorHints.controlSelector || widget.selectorHints.containerSelector);
}

function isFileUploadCommittedState(value: string): boolean {
  const normalized = normalizeText(value);
  if (!normalized) return false;
  const hasUploadSignal = /successfully uploaded|uploaded|drop files here|select files/i.test(normalized);
  const hasFilename = /\.[a-z0-9]{2,6}\b/i.test(normalized);
  return (hasUploadSignal && hasFilename) || hasUploadSignal || hasFilename;
}

async function readPromptCommittedState(
  page: Page,
  selector: string
): Promise<{
  ownText: string;
  inputValue: string;
  selectionLabel: string;
  promptInfo: string;
  containerText: string;
  merged: string;
}> {
  const locator = page.locator(selector).first();
  return locator.evaluate((el) => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
    const control = el as HTMLElement;
    const parent = control.parentElement;
    const container = control.closest("[data-automation-id^='formField-'], [data-automation-id*='formField'], fieldset, [role='group']") as HTMLElement | null;
    const ownText = normalize(control.textContent || "");
    const inputValue = "value" in control ? normalize((control as HTMLInputElement).value || "") : "";
    const selectionLabel = normalize(parent?.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent || "");
    const promptInfo = normalize(parent?.querySelector("[data-automation-id='promptAriaInstruction']")?.textContent || "");
    const containerText = normalize(container?.innerText || parent?.innerText || "");
    const merged = normalize(`${ownText} ${inputValue} ${selectionLabel} ${promptInfo} ${containerText}`);
    return { ownText, inputValue, selectionLabel, promptInfo, containerText, merged };
  }).catch(() => ({
    ownText: "",
    inputValue: "",
    selectionLabel: "",
    promptInfo: "",
    containerText: "",
    merged: ""
  }));
}

function isPromptCommittedStateEmpty(state: {
  ownText: string;
  inputValue: string;
  selectionLabel: string;
  promptInfo: string;
  containerText: string;
  merged: string;
}): boolean {
  const promptInfo = normalizeText(state.promptInfo);
  const merged = normalizeText(state.merged);
  if (!merged) return true;
  if (/0 items selected|no items selected|no items|select one|choose one|please select/.test(promptInfo)) return true;
  return isPlaceholderOption(merged);
}

async function verifyPromptInputSelectValue(
  page: Page,
  widget: WorkdayWidgetSchema,
  expectedValues: string[]
): Promise<boolean> {
  const selector = widget.selectorHints.controlSelector || widget.selectorHints.containerSelector;
  if (!selector) return false;
  const state = await readPromptCommittedState(page, selector);
  if (isPromptCommittedStateEmpty(state)) return false;

  const currentParts = committedPromptStateParts(state);
  if (committedPromptStateMatchesExpected(widget, expectedValues, currentParts)) return true;

  const promptKey = normalizeText(`${widget.label} ${widget.selectorHints.dataAutomationId || ""}`);
  if (isWorkdaySourceQuestionKey(widget.label, widget.selectorHints.dataAutomationId || "")) {
    return isCommittedSourcePromptState(state);
  }
  if (/country\/region phone code|country phone code|phone code/.test(promptKey)) {
    return currentParts.some((current) => current && !isPlaceholderOption(current));
  }

  return false;
}

export async function verifyWorkdayWidgetValue(
  page: Page,
  widget: WorkdayWidgetSchema,
  rawValue: string | string[]
): Promise<boolean> {
  if (widget.widgetType === "file_upload") {
    const current = normalizeText(String(await readWidgetCurrentValue(page, widget) || ""));
    if (isFileUploadCommittedState(current)) return true;
    const extracted = Array.isArray(widget.currentValue) ? widget.currentValue.join(" / ") : String(widget.currentValue || "");
    return isFileUploadCommittedState(extracted);
  }

  if (widget.widgetType === "date_mm_yyyy" || widget.widgetType === "date_mm_dd_yyyy") {
    const current = await readWidgetCurrentValue(page, widget);
    const currentParts = Array.isArray(current) ? current.map((value) => normalizeText(value)).filter(Boolean) : [normalizeText(String(current || ""))].filter(Boolean);
    const expectedParts = normalizeDateWidgetValue(widget.widgetType, rawValue);
    const normalizePart = (value: string): string => normalizeText(value).replace(/^0+(?=\d)/, "");
    return currentParts.length === expectedParts.length &&
      currentParts.every((value, index) => normalizePart(value) === normalizePart(expectedParts[index] || ""));
  }

  if (isWorkdaySourceQuestionKey(widget.label, widget.selectorHints.dataAutomationId || "")) {
    const committedRaw = await readWidgetCurrentValue(page, widget);
    const committedValues = Array.isArray(committedRaw)
      ? committedRaw.map((value) => normalizeText(value)).filter(Boolean)
      : [normalizeText(committedRaw)].filter(Boolean);
    if (committedValues.some((current) => current && !isPlaceholderOption(current))) return true;
  }

  const expectedValues = Array.isArray(rawValue) ? rawValue.map((value) => normalizeText(value)).filter(Boolean) : [normalizeText(rawValue)].filter(Boolean);
  if (!expectedValues.length) return false;

  if (isApplicationQuestionCommittedSelectWidget(widget)) {
    const committedValues = await readApplicationQuestionCommittedSelectValues(page, widget);
    return committedSelectValuesMatchExpected(committedValues, expectedValues);
  }

  if (widget.widgetType === "prompt_input_select") {
    const liveVerified = await verifyPromptInputSelectValue(page, widget, expectedValues);
    if (liveVerified) return true;
  }

  if (widget.widgetType === "button_select") {
    const selector = widget.selectorHints.controlSelector || widget.selectorHints.containerSelector;
    if (!selector) return false;
    const committedState = await readPromptCommittedState(page, selector);
    if (!isPromptCommittedStateEmpty(committedState)) {
      const committedParts = committedPromptStateParts(committedState);
      if (committedPromptStateMatchesExpected(widget, expectedValues, committedParts)) return true;
    }
    const trigger = page.locator(selector).first();
    if (!await trigger.isVisible().catch(() => false)) return false;
    for (const value of expectedValues) {
      if (await verifyDropdownSelected(trigger, value).catch(() => false)) return true;
    }
    const current = await readVisibleDropdownState(trigger);
    if (!current || isPlaceholderOption(current)) return false;
    const liveMatched = expectedValues.some((value) => current.includes(value) || value.includes(current));
    if (liveMatched) return true;
  }

  const extractedCurrent = Array.isArray(widget.currentValue)
    ? widget.currentValue.map((value) => normalizeText(value)).filter(Boolean)
    : [normalizeText(widget.currentValue)].filter(Boolean);
  if (extractedCurrent.length) {
    const extractedMatches = expectedValues.every((value) => extractedCurrent.some((current) => (
      current === value ||
      current.includes(value) ||
      value.includes(current) ||
      (isFieldOfStudyEducationLabel(widget.label) && (matchesFieldOfStudyValue(current, value) || matchesFieldOfStudyValue(value, current)))
    )));
    if (extractedMatches) return true;
  }

  if (widget.widgetType === "radio_group") {
    const current = normalizeText(String(await readWidgetCurrentValue(page, widget) || ""));
    return expectedValues.some((value) => current === value || current.includes(value) || value.includes(current));
  }

  if (widget.widgetType === "checkbox_group") {
    const current = await readWidgetCurrentValue(page, widget);
    const selected = Array.isArray(current) ? current.map((value) => normalizeText(value)).filter(Boolean) : [normalizeText(String(current || ""))].filter(Boolean);
    return expectedValues.every((value) => selected.some((selectedValue) => selectedValue === value || selectedValue.includes(value) || value.includes(selectedValue)));
  }

  const currentRaw = await readWidgetCurrentValue(page, widget);
  const current = normalizeText(Array.isArray(currentRaw) ? currentRaw.join(" ") : currentRaw);
  if (isFieldOfStudyEducationLabel(widget.label)) {
    return expectedValues.some((value) => (
      current === value ||
      current.includes(value) ||
      value.includes(current) ||
      matchesFieldOfStudyValue(current, value)
    ));
  }
  return expectedValues.some((value) => current === value || current.includes(value) || value.includes(current));
}

export async function collectWorkdayWidgetDebugPayload(input: {
  page: Page;
  widgets: WorkdayWidgetSchema[];
  plan: WorkdayWidgetAnswer[];
  executionResults?: WorkdayWidgetExecutionResult[];
}): Promise<Array<Record<string, unknown>>> {
  const planById = new Map(input.plan.map((answer) => [answer.widgetId, answer]));
  const executionById = new Map((input.executionResults || []).map((result) => [result.widgetId, result]));
  const payload: Array<Record<string, unknown>> = [];

  for (const widget of input.widgets) {
    const answer = planById.get(widget.widgetId);
    const execution = executionById.get(widget.widgetId);
    const currentValue = await readWidgetCurrentValue(input.page, widget);
    const liveVerified = answer ? await verifyWorkdayWidgetValue(input.page, widget, answer.value as string | string[]) : false;
    const verified = execution ? (execution.verified || liveVerified) : liveVerified;
    payload.push({
      widgetId: widget.widgetId,
      label: widget.label,
      fieldType: workdayWidgetDebugFieldType(widget),
      required: widget.required,
      currentValue: Array.isArray(currentValue) ? currentValue.join(" / ") : currentValue,
      possibleAnswers: widget.options,
      resolvedAnswer: answer ? (Array.isArray(answer.value) ? answer.value.join(" / ") : String(answer.value ?? "")) : "",
      executed: execution?.executed ?? false,
      verified,
      selector: widget.selectorHints.controlSelector || widget.selectorHints.containerSelector || "",
      failureReason: execution?.failureReason
    });
  }

  return payload;
}

export async function runWorkdayCommitSweep(page: Page, waitMs = 450): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    active?.blur?.();
  }).catch(() => undefined);
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(waitMs);
}

async function fillWorkdayFieldOfStudyPromptWidget(
  page: Page,
  widget: WorkdayWidgetSchema,
  value: string,
  notes?: string[]
): Promise<boolean> {
  const selector = widget.selectorHints.controlSelector;
  if (!selector) return false;
  const input = page.locator(selector).first();
  if (!await input.isVisible().catch(() => false)) return false;

  const readCommittedText = async (): Promise<string> => {
    const state = await readPromptCommittedState(page, selector);
    return normalizeText([state.selectionLabel, state.promptInfo, state.containerText, state.ownText].filter(Boolean).join(" "));
  };

  const currentCommitted = await readCommittedText();
  if (currentCommitted && fieldOfStudyPromptCandidates(value).some((candidate) => matchesFieldOfStudyValue(currentCommitted, candidate) || matchesFieldOfStudyValue(candidate, currentCommitted))) {
    notes?.push(`workday_prompt_commit_verified:label=${widget.label}:typedCandidate=preexisting:optionTexts=:selectedText=:committedText=${currentCommitted}`);
    return true;
  }

  const promptButtonSelector = widget.selectorHints.containerSelector
    ? `${widget.selectorHints.containerSelector} [data-automation-id='promptSearchButton']`
    : "";

  for (const candidate of fieldOfStudyPromptCandidates(value)) {
    await input.scrollIntoViewIfNeeded().catch(() => undefined);
    const hadCommitted = Boolean((await readCommittedText()) || "");
    if (hadCommitted) {
      await clearWorkdaySelectedItems(page, selector).catch(() => false);
      await page.waitForTimeout(180);
    }
    await input.click().catch(() => undefined);
    if (promptButtonSelector) {
      await page.locator(promptButtonSelector).first().click().catch(() => undefined);
      await page.waitForTimeout(180);
    }
    await input.press("ControlOrMeta+A").catch(() => undefined);
    await input.press("Backspace").catch(() => undefined);
    await input.type(candidate, { delay: 35 }).catch(() => undefined);
    await page.waitForTimeout(350);

    let optionTexts = Array.from(new Set((await extractOptionsFromOpenDropdown(page).catch(() => [] as string[])).map((option) => normalizeText(option)).filter(Boolean)));
    notes?.push(`workday_prompt_options_hydrated:label=${widget.label}:typedCandidate=${candidate}:optionTexts=${optionTexts.join(" | ")}`);
    let selectedText = pickFieldOfStudyPromptOption(candidate, optionTexts);

    if (!selectedText && promptButtonSelector) {
      await page.locator(promptButtonSelector).first().click().catch(() => undefined);
      await page.waitForTimeout(250);
      optionTexts = Array.from(new Set((await extractOptionsFromOpenDropdown(page).catch(() => [] as string[])).map((option) => normalizeText(option)).filter(Boolean)));
      notes?.push(`workday_prompt_options_hydrated:label=${widget.label}:typedCandidate=${candidate}:optionTexts=${optionTexts.join(" | ")}`);
      selectedText = pickFieldOfStudyPromptOption(candidate, optionTexts);
    }

    if (!selectedText) {
      notes?.push(`workday_prompt_commit_failed:label=${widget.label}:typedCandidate=${candidate}:optionTexts=${optionTexts.join(" | ")}:selectedText=:committedText=${await readCommittedText()}`);
      await page.keyboard.press("Escape").catch(() => undefined);
      continue;
    }

    const picked = await chooseExactOpenWorkdayOption(page, selectedText).catch(() => false) ||
      await chooseOpenWorkdayOption(page, selectedText).catch(() => false);
    notes?.push(`workday_prompt_option_selected:label=${widget.label}:typedCandidate=${candidate}:optionTexts=${optionTexts.join(" | ")}:selectedText=${selectedText}:committedText=`);
    if (!picked) {
      await page.keyboard.press("Escape").catch(() => undefined);
      continue;
    }

    await page.waitForTimeout(180);
    await page.keyboard.press("Tab").catch(() => undefined);
    await page.waitForTimeout(180);
    const committedText = await readCommittedText();
    const verified = await verifyPromptInputSelectValue(page, widget, [selectedText, candidate, value]);
    if (verified) {
      notes?.push(`workday_prompt_commit_verified:label=${widget.label}:typedCandidate=${candidate}:optionTexts=${optionTexts.join(" | ")}:selectedText=${selectedText}:committedText=${committedText}`);
      return true;
    }
    notes?.push(`workday_prompt_commit_failed:label=${widget.label}:typedCandidate=${candidate}:optionTexts=${optionTexts.join(" | ")}:selectedText=${selectedText}:committedText=${committedText}`);
  }

  return false;
}

async function fillWorkdaySkillsPromptWidget(
  page: Page,
  widget: WorkdayWidgetSchema,
  value: string,
  notes?: string[]
): Promise<boolean> {
  const selector = widget.selectorHints.controlSelector;
  if (!selector) return false;
  const input = page.locator(selector).first();
  if (!await input.isVisible().catch(() => false)) return false;

  const committed = await verifySourcePromptCommitted(input, value).catch(() => false);
  if (committed) {
    notes?.push(`workday_prompt_commit_verified:label=${widget.label}:typedCandidate=preexisting:optionTexts=:selectedText=:committedText=selected`);
    return true;
  }

  await clearWorkdaySelectedItems(page, selector).catch(() => false);
  await input.click().catch(() => undefined);
  await input.fill("").catch(() => undefined);
  await input.fill(value).catch(async () => {
    await input.type(value, { delay: 35 }).catch(() => undefined);
  });
  await page.waitForTimeout(250);

  const optionTexts = Array.from(new Set((await extractOptionsFromOpenDropdown(page).catch(() => [] as string[])).map((option) => normalizeText(option)).filter(Boolean)));
  notes?.push(`workday_prompt_options_hydrated:label=${widget.label}:typedCandidate=${value}:optionTexts=${optionTexts.join(" | ")}`);
  const meaningfulOptions = optionTexts.filter((option) => !/^(select one|all|partial list \(first 500 entries\)|no items\.?)$/i.test(normalizeText(option)));
  const pickedText = pickWorkdayPromptOption(value, meaningfulOptions);

  let picked = false;
  if (pickedText) {
    picked = await chooseExactOpenWorkdayOption(page, pickedText).catch(() => false) ||
      await chooseOpenWorkdayOption(page, pickedText).catch(() => false);
    notes?.push(`workday_prompt_option_selected:label=${widget.label}:typedCandidate=${value}:optionTexts=${optionTexts.join(" | ")}:selectedText=${pickedText}:committedText=`);
  }
  if (!picked) {
    await page.keyboard.press("Enter").catch(() => undefined);
    await page.keyboard.press("Enter", { delay: 5000 }).catch(() => undefined);
  } else {
    await page.keyboard.press("Enter").catch(() => undefined);
    await page.keyboard.press("Enter", { delay: 5000 }).catch(() => undefined);
  }

  await page.waitForTimeout(220);
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(180);
  let verified = await verifySourcePromptCommitted(input, value).catch(() => false) ||
    await verifySourcePromptCommitted(input).catch(() => false);
  if (!verified) {
    await input.click().catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
    await page.waitForTimeout(220);
    verified = await verifySourcePromptCommitted(input, value).catch(() => false) ||
      await verifySourcePromptCommitted(input).catch(() => false);
  }
  if (verified) {
    notes?.push(`workday_prompt_commit_verified:label=${widget.label}:typedCandidate=${value}:optionTexts=${optionTexts.join(" | ")}:selectedText=${pickedText}:committedText=selected`);
    return true;
  }
  notes?.push(`workday_prompt_commit_failed:label=${widget.label}:typedCandidate=${value}:optionTexts=${optionTexts.join(" | ")}:selectedText=${pickedText}:committedText=`);
  await page.keyboard.press("Escape").catch(() => undefined);
  return false;
}

async function fillWorkdayPromptInputSelectWidget(page: Page, widget: WorkdayWidgetSchema, value: string, notes?: string[]): Promise<boolean> {
  const selector = widget.selectorHints.controlSelector;
  if (!selector) return false;
  if (/how did you hear|application source|\bsource\b/i.test(`${widget.label} ${widget.selectorHints.dataAutomationId || ""}`)) {
    return fillWorkdaySourcePrompt(page, selector, value);
  }
  if (/country\/region phone code|country phone code|phone code/i.test(widget.label)) {
    return fillWorkdayPhoneCodeRadioPicker(page, selector, value);
  }
  if (isFieldOfStudyEducationLabel(widget.label)) {
    return fillWorkdayFieldOfStudyPromptWidget(page, widget, value, notes);
  }
  if (/type to add skills|\bskills?\b/i.test(widget.label)) {
    return fillWorkdaySkillsPromptWidget(page, widget, value, notes);
  }
  const input = page.locator(selector).first();
  if (!await input.isVisible().catch(() => false)) return false;

  await input.click().catch(() => undefined);
  await input.fill("").catch(() => undefined);
  await input.type(value, { delay: 35 }).catch(() => undefined);
  await page.waitForTimeout(220);

  const options = await extractOptionsFromOpenDropdown(page).catch(() => [] as string[]);
  const picked = pickWorkdayPromptOption(value, options);
  if (!picked) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return verifyDropdownSelected(input, value);
  }

  const exactPicked = await chooseExactOpenWorkdayOption(page, picked).catch(() => false) ||
    await chooseOpenWorkdayOption(page, picked).catch(() => false);
  if (!exactPicked) {
    await input.press("ArrowDown").catch(() => undefined);
    await input.press("Enter").catch(() => undefined);
  }
  await page.waitForTimeout(180);
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(150);
  return verifyDropdownSelected(input, picked);
}

async function fillWorkdayButtonSelectWidget(page: Page, widget: WorkdayWidgetSchema, value: string): Promise<boolean> {
  const selector = widget.selectorHints.controlSelector;
  if (!selector) return false;
  const trigger = page.locator(selector).first();
  if (!await trigger.isVisible().catch(() => false)) return false;
  await trigger.click().catch(() => undefined);
  await page.waitForTimeout(220);
  const picked = await chooseScopedOpenWorkdayOption(page, trigger, value).catch(() => false) ||
    await chooseExactOpenWorkdayOption(page, value).catch(() => false) ||
    await chooseOpenWorkdayOption(page, value).catch(() => false);
  if (!picked) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }
  await page.waitForTimeout(180);
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(150);
  return verifyDropdownSelected(trigger, value);
}

async function fillWorkdayRadioGroupWidget(page: Page, widget: WorkdayWidgetSchema, value: string): Promise<boolean> {
  const selector = widget.selectorHints.optionSelectors?.[value];
  if (!selector) return false;
  const clicked = await clickOptionSelector(page, selector);
  if (!clicked) return false;
  return verifyRadioOption(page, selector);
}

async function fillWorkdayCheckboxGroupWidget(page: Page, widget: WorkdayWidgetSchema, values: string[]): Promise<boolean> {
  let allChecked = true;
  for (const value of values) {
    const selector = widget.selectorHints.optionSelectors?.[value];
    if (!selector) {
      allChecked = false;
      continue;
    }
    await clickOptionSelector(page, selector).catch(() => false);
    const checked = await page.locator(selector).first().isChecked().catch(() => false);
    if (!checked) allChecked = false;
  }
  return allChecked;
}

async function fillWorkdayDateWidget(page: Page, widget: WorkdayWidgetSchema, raw: string | string[]): Promise<boolean> {
  const parts = normalizeDateWidgetValue(widget.widgetType as "date_mm_yyyy" | "date_mm_dd_yyyy", raw);
  const setDatePart = async (locator: Locator, value: string): Promise<boolean> => {
    const normalizePart = (part: string): string => normalizeText(part).replace(/^0+(?=\d)/, "");
    const matches = async (): Promise<boolean> => locator.inputValue()
      .then((current) => normalizePart(current) === normalizePart(value))
      .catch(() => false);
    await locator.evaluate((element, nextValue) => {
      const input = element as HTMLInputElement;
      input.scrollIntoView({ block: "center", inline: "nearest" });
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, nextValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    }, value).catch(() => undefined);
    if (await matches()) return true;
    await locator.click({ force: true }).catch(() => undefined);
    await page.keyboard.press("ControlOrMeta+A").catch(() => undefined);
    await page.keyboard.type(value, { delay: 35 }).catch(() => undefined);
    await locator.press("Tab").catch(() => undefined);
    await page.waitForTimeout(80);
    return matches();
  };

  if (widget.widgetType === "date_mm_yyyy") {
    if (parts.length !== 2 || !widget.selectorHints.monthSelector || !widget.selectorHints.yearSelector) return false;
    const current = await readWidgetCurrentValue(page, widget);
    const currentParts = Array.isArray(current)
      ? [normalizeText(current[0] || ""), normalizeText(current[1] || "")]
      : [];
    if (shouldClearDateWidgetBeforeRefill("date_mm_yyyy", currentParts, parts)) {
      await page.locator(widget.selectorHints.monthSelector).first().fill("").catch(() => undefined);
      await page.locator(widget.selectorHints.yearSelector).first().fill("").catch(() => undefined);
      await page.waitForTimeout(80);
    }
    return fillWorkdayDateSection(page, widget.selectorHints.monthSelector, widget.selectorHints.yearSelector, parts[0], parts[1]);
  }
  if (parts.length !== 3 || !widget.selectorHints.monthSelector || !widget.selectorHints.daySelector || !widget.selectorHints.yearSelector) return false;
  const month = page.locator(widget.selectorHints.monthSelector).first();
  const day = page.locator(widget.selectorHints.daySelector).first();
  const year = page.locator(widget.selectorHints.yearSelector).first();
  if (!await month.isVisible().catch(() => false) || !await day.isVisible().catch(() => false) || !await year.isVisible().catch(() => false)) return false;
  const current = await readWidgetCurrentValue(page, widget);
  const currentParts = Array.isArray(current)
    ? [normalizeText(current[0] || ""), normalizeText(current[1] || ""), normalizeText(current[2] || "")]
    : [];
    if (shouldClearDateWidgetBeforeRefill("date_mm_dd_yyyy", currentParts, parts)) {
      await month.fill("").catch(() => undefined);
      await month.press("Tab").catch(() => undefined);
      await day.fill("").catch(() => undefined);
      await day.press("Tab").catch(() => undefined);
    await year.fill("").catch(() => undefined);
      await year.press("Tab").catch(() => undefined);
      await page.waitForTimeout(80);
    }
  const monthOk = await setDatePart(month, parts[0]!);
  const dayOk = await setDatePart(day, parts[1]!);
  const yearOk = await setDatePart(year, parts[2]!);
  if (!(monthOk && dayOk && yearOk)) return false;
  const committed = await Promise.all([
    month.inputValue().catch(() => ""),
    day.inputValue().catch(() => ""),
    year.inputValue().catch(() => "")
  ]);
  const normalizePart = (value: string): string => normalizeText(value).replace(/^0+(?=\d)/, "");
  return committed.map(normalizePart).join("/") === parts.map((value) => normalizePart(value || "")).join("/");
}

async function fillWorkdayUnknownWidget(page: Page, widget: WorkdayWidgetSchema, value: string | string[]): Promise<boolean> {
  const selector = widget.selectorHints.controlSelector || widget.selectorHints.containerSelector;
  if (!selector) return false;
  const nextValue = Array.isArray(value) ? value[0] || "" : value;
  const htmlTag = String(widget.htmlSummary.tag || "").toLowerCase();

  if (htmlTag === "select") {
    const control = page.locator(selector).first();
    if (!await control.isVisible().catch(() => false)) return false;
    const selected = await control.selectOption({ label: nextValue }).then((result) => result.length > 0).catch(() => false) ||
      await control.selectOption({ value: nextValue }).then((result) => result.length > 0).catch(() => false);
    if (!selected) return false;
    const currentText = normalizeText(await control.locator("option:checked").first().innerText().catch(() => ""));
    const currentValue = normalizeText(await control.inputValue().catch(() => ""));
    return currentText.includes(normalizeText(nextValue)) || currentValue.includes(normalizeText(nextValue));
  }

  return safeFill(page, selector, nextValue);
}

async function collectVisibleExperienceRows(page: Page, prefixes: string[]): Promise<PanelRowMatchInput[]> {
  const rows: PanelRowMatchInput[] = [];
  for (const prefix of prefixes) {
    const jobTitle = await page.locator(`#${escapeSelectorId(`${prefix}--jobTitle`)}`).first().inputValue().catch(() => "");
    const company = await page.locator(`#${escapeSelectorId(`${prefix}--companyName`)}, #${escapeSelectorId(`${prefix}--company`)}`).first().inputValue().catch(() => "");
    rows.push({ primary: jobTitle, secondary: company });
  }
  return rows;
}

async function collectVisibleEducationRows(page: Page, prefixes: string[]): Promise<PanelRowMatchInput[]> {
  const rows: PanelRowMatchInput[] = [];
  for (const prefix of prefixes) {
    const school = await page.locator(`#${escapeSelectorId(`${prefix}--school`)}`).first().inputValue().catch(() => "");
    const degree = await page.locator(`#${escapeSelectorId(`${prefix}--degree`)}`).first().inputValue().catch(() => "");
    rows.push({ primary: school, secondary: degree });
  }
  return rows;
}

async function hasSatisfiedExperiencePanelRows(page: Page, profile: NormalizedWorkdayProfile): Promise<boolean> {
  if (!profile.experience.length) return true;
  const prefixes = await settlePanelPrefixes(page, "--jobTitle");
  if (prefixes.length < profile.experience.length) return false;
  const visibleRows = await collectVisibleExperienceRows(page, prefixes);
  const desiredRows = profile.experience.map((exp) => ({ primary: exp.jobTitle, secondary: exp.company }));
  const plan = planPanelRowAssignments(visibleRows, desiredRows);
  return plan.addCount === 0 && plan.assignments.length >= desiredRows.length;
}

async function hasSatisfiedEducationPanelRows(page: Page, profile: NormalizedWorkdayProfile): Promise<boolean> {
  if (!profile.education.length) return true;
  const prefixes = await settlePanelPrefixes(page, "--school");
  if (prefixes.length < profile.education.length) return false;
  const visibleRows = await collectVisibleEducationRows(page, prefixes);
  const desiredRows = profile.education.map((edu) => ({ primary: edu.school, secondary: edu.degree }));
  const plan = planPanelRowAssignments(visibleRows, desiredRows);
  return plan.addCount === 0 && plan.assignments.length >= desiredRows.length;
}

async function hasCommittedSkills(page: Page, skills: string[]): Promise<boolean> {
  if (!skills.length) return true;
  return page.evaluate((expectedSkills) => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const roots = [
      document.querySelector("#skills--skills")?.closest("[data-automation-id='formField-skillsPrompt'], [data-automation-id='skillsSection'], section, fieldset, div") ?? null,
      ...Array.from(document.querySelectorAll("[data-automation-id='formField-skillsPrompt'], [data-automation-id='skillsSection']"))
    ].filter((node): node is HTMLElement => visible(node));
    if (!roots.length) return false;
    const text = roots.map((root) => normalize(root.innerText || "")).join(" ");
    return expectedSkills.some((skill) => {
      const normalized = normalize(skill);
      return normalized && text.includes(normalized);
    });
  }, skills).catch(() => false);
}

async function fillExperienceRow(page: Page, prefix: string, exp: NormalizedWorkdayProfile["experience"][number]): Promise<void> {
  await page.locator(`#${escapeSelectorId(`${prefix}--jobTitle`)}, input[data-automation-id='jobTitle']`).first().fill(exp.jobTitle).catch(() => undefined);
  await page.locator(`#${escapeSelectorId(`${prefix}--companyName`)}, #${escapeSelectorId(`${prefix}--company`)}, input[data-automation-id='company']`).first().fill(exp.company).catch(() => undefined);
  await page.locator(`#${escapeSelectorId(`${prefix}--location`)}, input[data-automation-id='location']`).first().fill(exp.location).catch(() => undefined);
  await fillWorkdayMonthYearComposite(
    page,
    `#${escapeSelectorId(`${prefix}--startDate`)}`,
    `#${escapeSelectorId(`${prefix}--startDate-dateSectionMonth-input`)}`,
    `#${escapeSelectorId(`${prefix}--startDate-dateSectionYear-input`)}`,
    exp.startDateMonth,
    exp.startDateYear
  ).catch(() => false) || await fillWorkdayDateSection(
    page,
    `#${escapeSelectorId(`${prefix}--startDate-dateSectionMonth-input`)}`,
    `#${escapeSelectorId(`${prefix}--startDate-dateSectionYear-input`)}`,
    exp.startDateMonth,
    exp.startDateYear
  ).catch(() => false);
  if (exp.endDateMonth || exp.endDateYear) {
    await fillWorkdayMonthYearComposite(
      page,
      `#${escapeSelectorId(`${prefix}--endDate`)}`,
      `#${escapeSelectorId(`${prefix}--endDate-dateSectionMonth-input`)}`,
      `#${escapeSelectorId(`${prefix}--endDate-dateSectionYear-input`)}`,
      exp.endDateMonth,
      exp.endDateYear
    ).catch(() => false) || await fillWorkdayDateSection(
      page,
      `#${escapeSelectorId(`${prefix}--endDate-dateSectionMonth-input`)}`,
      `#${escapeSelectorId(`${prefix}--endDate-dateSectionYear-input`)}`,
      exp.endDateMonth,
      exp.endDateYear
    ).catch(() => false);
  } else {
    const currentRoleCheckbox = page.locator(`#${escapeSelectorId(`${prefix}--currentlyWorkHere`)}`).first();
    if (await currentRoleCheckbox.isVisible().catch(() => false)) {
      const checked = await currentRoleCheckbox.isChecked().catch(() => false);
      if (!checked) await currentRoleCheckbox.check().catch(() => undefined);
    }
  }
  await page.locator(`#${escapeSelectorId(`${prefix}--roleDescription`)}, textarea[data-automation-id='description']`).first().fill(exp.description).catch(() => undefined);
}

async function fillEducationRow(page: Page, prefix: string, edu: NormalizedWorkdayProfile["education"][number]): Promise<void> {
  const schoolSelector = `#${escapeSelectorId(`${prefix}--school`)}`;
  const schoolInput = page.locator(`${schoolSelector}, input[data-automation-id*='school']`).first();
  await fillWorkdaySearchPicker(page, schoolSelector, edu.school, { keyboardCommit: true }).catch(() => false) ||
    await fillComboboxInput(page, schoolInput, edu.school).catch(() => false);

  const degreeChoice = /b\.?s\.?|bachelor/i.test(edu.degree) ? "Bachelor" : edu.degree;
  await fillWorkdayDropdown(page, `#${escapeSelectorId(`${prefix}--degree`)}, button[data-automation-id*='degree']`, degreeChoice).catch(() => false);

  const fieldOfStudySelector = `#${escapeSelectorId(`${prefix}--fieldOfStudy`)}`;
  const fieldInput = page.locator(`${fieldOfStudySelector}, input[data-automation-id*='fieldOfStudy'], input[data-automation-id*='field']`).first();
  await fillWorkdaySearchPicker(page, fieldOfStudySelector, edu.fieldOfStudy, {
    expandAll: true,
    pressEnterBeforeExactWait: true
  }).catch(() => false) || await fillComboboxInput(page, fieldInput, edu.fieldOfStudy).catch(() => false);

  if (edu.gpa) await page.locator(`#${escapeSelectorId(`${prefix}--gradeAverage`)}, input[name='gradeAverage'], input[data-automation-id*='gpa'], input[data-automation-id*='gradeAverage']`).first().fill(edu.gpa).catch(() => undefined);
  if (edu.startYear) await page.locator(`#${escapeSelectorId(`${prefix}--firstYearAttended`)}, input[data-automation-id*='firstYearAttended']`).first().fill(edu.startYear).catch(() => undefined);
  if (edu.endYear) await page.locator(`#${escapeSelectorId(`${prefix}--lastYearAttended`)}, input[data-automation-id*='lastYearAttended']`).first().fill(edu.endYear).catch(() => undefined);
}

async function fillWorkdayPanelCollectionWidget(
  page: Page,
  widget: WorkdayWidgetSchema,
  profile: NormalizedWorkdayProfile,
  filledFields: FilledFieldRecord[]
): Promise<boolean> {
  const panelKind = String(widget.htmlSummary.panelKind || widget.selectorHints.dataAutomationId || "").toLowerCase();
  if (/skills/.test(panelKind)) return false;
  if (/website/.test(panelKind)) {
    await fillWebsiteLinks(page, profile, filledFields);
    return true;
  }

  const addButtonSelector = widget.selectorHints.addButtonSelector;
  const suffix = widget.selectorHints.rowPrefixFieldSuffix;
  if (!suffix) return false;

  if (/workexperience/.test(panelKind)) {
    const desiredRows = profile.experience.map((exp) => ({ primary: exp.jobTitle, secondary: exp.company }));
    if (!desiredRows.length) return false;
    let prefixes = await collectWorkdayPanelPrefixes(page, suffix);
    const sectionSelector = widget.selectorHints.containerSelector || widget.selectorHints.controlSelector || "";
    const baseline = sectionSelector
      ? await inspectWorkdaySectionRowBaseline(page, sectionSelector, suffix)
      : {
        prefixCount: prefixes.length,
        deleteButtonCount: 0,
        hasVisibleFields: prefixes.length > 0,
        estimatedExistingCount: prefixes.length > 0 ? 1 : 0
      };
    const addClicksNeeded = computePanelCollectionAddClicks(profile.experience.length, baseline.estimatedExistingCount);
    for (let addAttempt = 0; addAttempt < addClicksNeeded && addButtonSelector; addAttempt += 1) {
      const previousBaseline = sectionSelector
        ? await inspectWorkdaySectionRowBaseline(page, sectionSelector, suffix)
        : {
          prefixCount: prefixes.length,
          deleteButtonCount: 0,
          hasVisibleFields: prefixes.length > 0,
          estimatedExistingCount: prefixes.length > 0 ? 1 : 0
        };
      const clicked = await safeClick(page, addButtonSelector);
      if (!clicked) break;
      await page.waitForTimeout(400);
      await waitForPanelPrefixGrowth(page, suffix, previousBaseline.prefixCount).catch(() => previousBaseline.prefixCount);
      prefixes = await collectWorkdayPanelPrefixes(page, suffix);
      if (sectionSelector) {
        const nextBaseline = await inspectWorkdaySectionRowBaseline(page, sectionSelector, suffix);
        if (nextBaseline.estimatedExistingCount <= previousBaseline.estimatedExistingCount) break;
      } else if (prefixes.length <= previousBaseline.prefixCount) {
        break;
      }
    }
    const visibleRows = await collectVisibleExperienceRows(page, prefixes);
    const plan = planPanelRowAssignments(visibleRows, desiredRows);
    for (const assignment of plan.assignments) {
      const prefix = prefixes[assignment.visibleIndex];
      const exp = profile.experience[assignment.desiredIndex];
      if (!prefix || !exp) continue;
      await fillExperienceRow(page, prefix, exp);
      filledFields.push({ id: `experience:${assignment.desiredIndex + 1}`, label: "Work Experience", value: `${exp.jobTitle} @ ${exp.company}`, source: "profile", inputKind: "panel_collection" });
    }
    return true;
  }

  if (/education/.test(panelKind)) {
    const desiredRows = profile.education.map((edu) => ({ primary: edu.school, secondary: edu.degree }));
    if (!desiredRows.length) return false;
    let prefixes = await collectWorkdayPanelPrefixes(page, suffix);
    const sectionSelector = widget.selectorHints.containerSelector || widget.selectorHints.controlSelector || "";
    const baseline = sectionSelector
      ? await inspectWorkdaySectionRowBaseline(page, sectionSelector, suffix)
      : {
        prefixCount: prefixes.length,
        deleteButtonCount: 0,
        hasVisibleFields: prefixes.length > 0,
        estimatedExistingCount: prefixes.length > 0 ? 1 : 0
      };
    let visibleRows = await collectVisibleEducationRows(page, prefixes);
    let plan = planPanelRowAssignments(visibleRows, desiredRows);
    const addClicksBudget = Math.min(
      plan.addCount,
      computePanelCollectionAddClicks(desiredRows.length, baseline.estimatedExistingCount)
    );
    for (let addAttempt = 0; addAttempt < addClicksBudget && plan.addCount > 0 && addButtonSelector; addAttempt += 1) {
      const previousBaseline = sectionSelector
        ? await inspectWorkdaySectionRowBaseline(page, sectionSelector, suffix)
        : {
          prefixCount: prefixes.length,
          deleteButtonCount: 0,
          hasVisibleFields: prefixes.length > 0,
          estimatedExistingCount: prefixes.length > 0 ? 1 : 0
        };
      const clicked = await safeClick(page, addButtonSelector);
      if (!clicked) break;
      await page.waitForTimeout(400);
      await waitForPanelPrefixGrowth(page, suffix, previousBaseline.prefixCount).catch(() => previousBaseline.prefixCount);
      prefixes = await collectWorkdayPanelPrefixes(page, suffix);
      if (sectionSelector) {
        const nextBaseline = await inspectWorkdaySectionRowBaseline(page, sectionSelector, suffix);
        if (nextBaseline.estimatedExistingCount <= previousBaseline.estimatedExistingCount) break;
      } else if (prefixes.length <= previousBaseline.prefixCount) {
        break;
      }
      visibleRows = await collectVisibleEducationRows(page, prefixes);
      plan = planPanelRowAssignments(visibleRows, desiredRows);
    }
    for (const assignment of plan.assignments) {
      const prefix = prefixes[assignment.visibleIndex];
      const edu = profile.education[assignment.desiredIndex];
      if (!prefix || !edu) continue;
      await fillEducationRow(page, prefix, edu);
      filledFields.push({ id: `education:${assignment.desiredIndex + 1}`, label: "Education", value: `${edu.school} - ${edu.degree}`, source: "profile", inputKind: "panel_collection" });
    }
    return true;
  }

  return false;
}

function resolveFieldFromWidget(widget: WorkdayWidgetSchema): ResolvedWorkdayField | null {
  const containerSelector = widget.selectorHints.containerSelector || widget.selectorHints.controlSelector;
  const controlSelector = widget.selectorHints.controlSelector || widget.selectorHints.containerSelector;
  if (!containerSelector || !controlSelector) return null;

  let controlKind: ResolvedWorkdayFieldControlKind = "unknown";
  if (widget.widgetType === "prompt_input_select") controlKind = "prompt_input_select";
  else if (widget.widgetType === "radio_group") controlKind = "radio_group";
  else if (widget.widgetType === "button_select") controlKind = "prompt_input_select";
  else if (widget.widgetType === "text_input" || widget.widgetType === "textarea") controlKind = "text_input";

  return {
    label: widget.label,
    containerSelector,
    controlSelector,
    controlKind,
    optionSelectors: widget.selectorHints.optionSelectors,
    dataAutomationId: widget.selectorHints.dataAutomationId
  };
}

async function tryFillSpecialContactWidget(
  page: Page,
  widget: WorkdayWidgetSchema,
  profile: NormalizedWorkdayProfile,
  plannedValue: string,
  notes?: string[]
): Promise<boolean | null> {
  const field = resolveFieldFromWidget(widget);
  if (!field) return null;

  if (isSourceContactQuestion(widget.label, widget.selectorHints.dataAutomationId || "")) {
    const options = await extractVisibleOptions(page, field);
    const chosen = pickBestRuntimeSourceOption(options, plannedValue) || plannedValue;
    notes?.push(`workday_contact_source_options:${options.join(" | ") || "none"}`);
    notes?.push(`workday_contact_source_choice:${chosen}`);
    return fillSourceQuestion(page, field, chosen, options);
  }

  if (isPriorCompanyContactQuestion(widget.label, widget.selectorHints.dataAutomationId || "")) {
    const companyName = deriveCompanyNameFromLabel(widget.label);
    const options = await extractVisibleOptions(page, field);
    const preferred = profileShowsPriorCompany(profile, companyName)
      ? ["Yes", "Yes, I have", "Previously worked"]
      : ["No", "No, I have not", "Never"];
    const chosen = pickPreferredOption(options, preferred) || preferred[0]!;
    notes?.push(`workday_contact_prior_company_label:${widget.label}`);
    if (companyName) notes?.push(`workday_contact_prior_company_name:${companyName}`);
    notes?.push(`workday_contact_prior_company_options:${options.join(" | ") || "none"}`);
    notes?.push(`workday_contact_prior_company_choice:${chosen}`);
    return fillPriorCompanyQuestion(page, field, companyName, profile, options);
  }

  return null;
}

function isMyExperienceEducationWidget(widget: WorkdayWidgetSchema): boolean {
  const key = normalizeText([
    widget.label,
    widget.promptText,
    String(widget.selectorHints.dataAutomationId || ""),
    String(widget.selectorHints.controlSelector || ""),
    String(widget.selectorHints.containerSelector || ""),
    String(widget.htmlSummary.sectionKind || ""),
    String(widget.htmlSummary.panelKind || "")
  ].join(" "));
  if (widget.step !== "my_experience") return false;
  if (widget.widgetType === "panel_collection" && !/educationsection/.test(key)) return false;
  if (/educationsection/.test(key)) return true;
  return /school|university|college|degree|major|field of study|discipline|grade average|gpa|overall|graduation|language|firstyearattended|lastyearattended|actual or expected/.test(key);
}

function serializeWidgetValueForTelemetry(value: string | string[]): string {
  return Array.isArray(value) ? value.join("/") : value;
}

function isFieldOfStudyEducationLabel(value: string): boolean {
  return /field of study|major|discipline|fieldofstudy/.test(normalizeText(value));
}

function tokenizeComparableEducationValue(value: string): string[] {
  return normalizeText(value)
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2)
    .filter((token) => !["and", "the", "for", "with", "from", "study", "field", "major"].includes(token));
}

function matchesFieldOfStudyValue(currentValue: string, expectedValue: string): boolean {
  const currentTokens = new Set(tokenizeComparableEducationValue(currentValue));
  const expectedTokens = tokenizeComparableEducationValue(expectedValue);
  if (!currentTokens.size || !expectedTokens.length) return false;
  return expectedTokens.every((token) => currentTokens.has(token));
}

export function fieldOfStudyPromptCandidates(rawValue: string): string[] {
  return Array.from(new Set([
    rawValue,
    "Computer Science",
    "Computer and Information Science",
    "Computer and Information Sciences",
    "Computer Science, General",
    "Software Engineering",
    "Information Technology"
  ].map((value) => normalizeText(value)).filter(Boolean)));
}

export function pickFieldOfStudyPromptOption(rawValue: string, options: string[]): string | null {
  const candidates = fieldOfStudyPromptCandidates(rawValue);
  const normalizedOptions = Array.from(new Set(options.map((option) => normalizeText(option)).filter(Boolean)));
  for (const candidate of candidates) {
    const exact = normalizedOptions.find((option) => option.toLowerCase() === candidate.toLowerCase());
    if (exact) return exact;
  }
  for (const candidate of candidates) {
    const semantic = normalizedOptions.find((option) => matchesFieldOfStudyValue(option, candidate) || matchesFieldOfStudyValue(candidate, option));
    if (semantic) return semantic;
  }
  return null;
}

async function fillMyExperienceExactButtonSelect(
  page: Page,
  widget: WorkdayWidgetSchema,
  preferredValues: string[]
): Promise<boolean> {
  const selector = widget.selectorHints.controlSelector;
  if (!selector) return false;
  const trigger = page.locator(selector).first();
  if (!await trigger.isVisible().catch(() => false)) return false;

  await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
  await trigger.click().catch(() => undefined);
  await page.waitForTimeout(250);

  const visibleOptions = await extractOptionsFromOpenDropdown(page).catch(() => [] as string[]);
  const picks = preferredValues
    .map((value) => exactNormalizedOptionMatch(value, visibleOptions))
    .filter(Boolean) as string[];

  for (const pick of picks) {
    const exact = await chooseExactOpenWorkdayOption(page, pick).catch(() => false);
    if (!exact) continue;
    await page.waitForTimeout(180);
    await page.keyboard.press("Tab").catch(() => undefined);
    await page.waitForTimeout(150);
    if (await verifyDropdownSelected(trigger, pick)) return true;
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  return false;
}

async function fillMyExperienceFieldOfStudySearch(page: Page, selector: string, rawValue: string): Promise<boolean> {
  const control = page.locator(selector).first();
  if (!await control.isVisible().catch(() => false)) return false;
  const candidates = Array.from(new Set([
    rawValue,
    "Applied Computer Science",
    "Computer Science"
  ].filter(Boolean)));

  await control.scrollIntoViewIfNeeded().catch(() => undefined);
  await control.click().catch(() => undefined);
  await control.press("ControlOrMeta+A").catch(() => undefined);
  await control.press("Backspace").catch(() => undefined);
  await control.type(rawValue, { delay: 55 }).catch(() => undefined);
  await control.press("Enter").catch(() => undefined);
  await page.waitForTimeout(3000);

  const directPick = await chooseOpenWorkdayOptionFromCandidates(page, candidates).catch(() => null);
  if (directPick) {
    await page.keyboard.press("Tab").catch(() => undefined);
    await page.waitForTimeout(200);
    return verifyDropdownSelected(control, directPick);
  }

  await control.press("ArrowDown").catch(() => undefined);
  await page.waitForTimeout(180);
  await control.press("Enter").catch(() => undefined);
  await page.waitForTimeout(250);
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(200);

  for (const candidate of candidates) {
    if (await verifyDropdownSelected(control, candidate)) return true;
  }
  const current = normalizeText(await control.inputValue().catch(() => ""));
  return current.includes("computer science");
}

async function fillMyExperienceEducationWidget(
  page: Page,
  widget: WorkdayWidgetSchema,
  value: string | string[],
  notes?: string[]
): Promise<boolean> {
  const nextValue = Array.isArray(value) ? value.join("/") : value;
  const selector = widget.selectorHints.controlSelector || widget.selectorHints.containerSelector;
  const educationLabel = normalizeText(`${widget.label} ${widget.promptText} ${widget.widgetId} ${widget.selectorHints.dataAutomationId || ""}`);
  const shouldUseSearchCommit = /school|university|college|degree|field of study|major|discipline|language|type to add skills|\bskills?\b/.test(educationLabel);
  const isFieldOfStudy = /field of study|major|discipline|fieldofstudy/.test(educationLabel);
  const isSkillsPrompt = /type to add skills|\bskills?\b/.test(educationLabel);
  const isLanguageDropdown = /\blanguage\b/.test(educationLabel) && !/overall|native|fluent/.test(educationLabel);
  const isLanguageOverallDropdown = /overall/.test(educationLabel) && /language_/.test(educationLabel);

  switch (widget.widgetType) {
    case "text_input":
    case "textarea": {
      if (!selector) return false;
      const control = page.locator(selector).first();
      if (isFieldOfStudy) {
        const picked = await fillMyExperienceFieldOfStudySearch(page, selector, nextValue).catch(() => false);
        if (picked) return true;
      }
      if (shouldUseSearchCommit) {
        const picked = await fillWorkdaySearchPicker(page, selector, nextValue, {
          expandAll: true,
          pressEnterBeforeExactWait: true,
          keyboardCommit: true
        }).catch(() => false);
        if (picked) return true;
        const comboPicked = await fillComboboxInput(page, control, nextValue).catch(() => false);
        if (comboPicked) return true;
      }
      return safeFill(page, selector, nextValue);
    }
    case "prompt_input_select":
      if (isFieldOfStudy && selector) {
        const picked = await fillMyExperienceFieldOfStudySearch(page, selector, nextValue).catch(() => false);
        if (picked) return true;
      }
      if (isSkillsPrompt) {
        const picked = await fillWorkdaySearchPicker(page, selector || "", nextValue, {
          expandAll: true,
          pressEnterBeforeExactWait: true,
          keyboardCommit: true
        }).catch(() => false);
        if (picked) return true;
      }
      return fillWorkdayPromptInputSelectWidget(page, widget, nextValue, notes);
    case "button_select":
      if (isLanguageDropdown) {
        const exact = await fillMyExperienceExactButtonSelect(page, widget, ["English"]);
        if (exact) return true;
      }
      if (isLanguageOverallDropdown) {
        const exact = await fillMyExperienceExactButtonSelect(page, widget, ["4 - Fluent", "Fluent"]);
        if (exact) return true;
      }
      return fillWorkdayButtonSelectWidget(page, widget, nextValue);
    case "radio_group":
      return fillWorkdayRadioGroupWidget(page, widget, nextValue);
    case "checkbox_group":
      return fillWorkdayCheckboxGroupWidget(page, widget, Array.isArray(value) ? value : [nextValue]);
    case "date_mm_yyyy":
    case "date_mm_dd_yyyy":
      return fillWorkdayDateWidget(page, widget, value);
    default: {
      if (shouldUseSearchCommit && selector) {
        const control = page.locator(selector).first();
        if (isFieldOfStudy) {
          const picked = await fillMyExperienceFieldOfStudySearch(page, selector, nextValue).catch(() => false);
          if (picked) return true;
        }
        const picked = await fillWorkdaySearchPicker(page, selector, nextValue, {
          expandAll: true,
          pressEnterBeforeExactWait: true,
          keyboardCommit: true
        }).catch(() => false);
        if (picked) return true;
        const comboPicked = await fillComboboxInput(page, control, nextValue).catch(() => false);
        if (comboPicked) return true;
      }
      return fillWorkdayUnknownWidget(page, widget, value);
    }
  }
}

async function inspectMyExperienceLanguageState(page: Page): Promise<{ language: string; overall: string }> {
  return page.evaluate(() => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const languageRoot = Array.from(document.querySelectorAll<HTMLElement>("[role='group'], section, div"))
      .find((node) => (visible(node) && /languages/i.test(normalize(node.getAttribute("aria-labelledby") || ""))) || (visible(node) && /\blanguages\b/i.test(normalize(node.textContent || ""))));
    if (!languageRoot) return { language: "", overall: "" };

    const fields = Array.from(languageRoot.querySelectorAll<HTMLElement>("[data-automation-id^='formField-']")).filter((node) => visible(node));
    const labelFor = (field: HTMLElement | null): string => normalize(field?.querySelector("label")?.textContent || "");
    const valueFor = (field: HTMLElement | null): string => normalize(field?.querySelector<HTMLElement>("button[aria-haspopup='listbox']")?.textContent || "");
    const languageField = fields.find((field) => /\blanguage\b/i.test(labelFor(field)));
    const overallField = fields.find((field) => /\boverall\b/i.test(labelFor(field)));

    return {
      language: valueFor(languageField || null),
      overall: valueFor(overallField || null)
    };
  }).catch(() => ({ language: "", overall: "" }));
}

async function inspectMyExperienceResumeState(page: Page): Promise<{ handled: boolean; duplicateCount: number }> {
  return page.evaluate(() => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const resumeRoot = Array.from(document.querySelectorAll<HTMLElement>("section, div, [role='group']"))
      .find((node) => visible(node) && /resume\/cv|upload a file/i.test(normalize(node.textContent || "")));
    if (!resumeRoot) return { handled: false, duplicateCount: 0 };
    const text = normalize(resumeRoot.textContent || "");
    const duplicateCount = (text.match(/4-21resume\.pdf/ig) || []).length;
    return {
      handled: /successfully uploaded/i.test(text) || duplicateCount > 0,
      duplicateCount
    };
  }).catch(() => ({ handled: false, duplicateCount: 0 }));
}

async function resolveMyExperienceLanguagesSelectors(page: Page): Promise<{
  languageSelector?: string;
  overallSelector?: string;
  languageLabel?: string;
  overallLabel?: string;
  languageRequired: boolean;
  overallRequired: boolean;
}> {
  return page.evaluate(() => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const selectorFor = (node: HTMLElement | null): string | undefined => {
      if (!node) return undefined;
      const id = normalize(node.getAttribute("id") || "");
      if (id) return `[id="${id.replace(/"/g, '\\"')}"]`;
      const automationId = normalize(node.getAttribute("data-automation-id") || "");
      if (automationId) return `${node.tagName.toLowerCase()}[data-automation-id="${automationId.replace(/"/g, '\\"')}"]`;
      return undefined;
    };

    const languagesRoot = document.querySelector<HTMLElement>("[role='group'][aria-labelledby='Languages-section'], [data-automation-id='languageSection'], [data-automation-id='languagesSection']");
    const root = visible(languagesRoot) ? languagesRoot : Array.from(document.querySelectorAll<HTMLElement>("[role='group'], section, div"))
      .find((node) => visible(node) && /\blanguages\b/i.test(normalize(node.textContent || "")));
    if (!root) {
      return {
        languageSelector: undefined,
        overallSelector: undefined,
        languageLabel: undefined,
        overallLabel: undefined,
        languageRequired: false,
        overallRequired: false
      };
    }

    const fields = Array.from(root.querySelectorAll<HTMLElement>("[data-automation-id^='formField-'], div"))
      .filter((node) => visible(node));
    const findField = (labelPattern: RegExp): HTMLElement | null =>
      fields.find((node) => labelPattern.test(normalize(node.textContent || ""))) || null;
    const labelFor = (field: HTMLElement | null): string => normalize(field?.querySelector("label")?.textContent || field?.textContent || "");
    const requiredFor = (field: HTMLElement | null): boolean => {
      if (!field) return false;
      return Boolean(field.querySelector("abbr, [aria-required='true'], [required], [aria-invalid='true']"));
    };
    const findControl = (field: HTMLElement | null): HTMLElement | null => {
      if (!field) return null;
      return field.querySelector<HTMLElement>("button[aria-haspopup='listbox'], input[type='text'], input[role='combobox'], [role='combobox']");
    };
    const languageField = findField(/\blanguage\b/i);
    const overallField = findField(/\boverall\b/i);

    return {
      languageSelector: selectorFor(findControl(languageField)),
      overallSelector: selectorFor(findControl(overallField)),
      languageLabel: labelFor(languageField),
      overallLabel: labelFor(overallField),
      languageRequired: requiredFor(languageField),
      overallRequired: requiredFor(overallField)
    };
  }).catch(() => ({
    languageSelector: undefined,
    overallSelector: undefined,
    languageLabel: undefined,
    overallLabel: undefined,
    languageRequired: false,
    overallRequired: false
  }));
}

async function fillMyExperienceLanguageEnglishExact(page: Page, notes?: string[]): Promise<{ ok: boolean; reason?: string }> {
  const selectors = await resolveMyExperienceLanguagesSelectors(page);
  if (!selectors.languageSelector) return { ok: !selectors.languageRequired, reason: selectors.languageRequired ? "language_option_not_found" : undefined };
  const trigger = page.locator(selectors.languageSelector).first();
  notes?.push(`workday_language_field_detected:${normalizeText(selectors.languageLabel || "language")}`);
  if (!await trigger.isVisible().catch(() => false)) return { ok: false, reason: "language_option_not_found" };

  const current = normalizeText(await trigger.innerText().catch(() => ""));
  if (/^english$|^english \(united states\)$|^english - united states$|^american english$/.test(current)) {
    notes?.push(`workday_language_selected:${current}`);
    notes?.push("workday_language_verified");
    return { ok: true };
  }

  await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
  await trigger.click().catch(() => undefined);
  await page.waitForTimeout(250);
  let options = await extractOptionsFromOpenDropdown(page).catch(() => [] as string[]);
  notes?.push(`workday_language_live_options:${options.join(" | ")}`);
  let pickedValue = pickStrongLanguageOption(options, selectors.languageLabel || "language");

  if (!pickedValue) {
    const isTextInput = await trigger.evaluate((el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement).catch(() => false);
    if (isTextInput) {
      notes?.push("workday_language_query_attempted:English");
      await trigger.fill("").catch(() => undefined);
      await trigger.type("English", { delay: 50 }).catch(() => undefined);
      await page.waitForTimeout(400);
      options = await extractOptionsFromOpenDropdown(page).catch(() => [] as string[]);
      notes?.push(`workday_language_live_options:${options.join(" | ")}`);
      pickedValue = pickStrongLanguageOption(options, selectors.languageLabel || "language");
    }
  }

  if (!pickedValue) {
    await page.keyboard.press("Escape").catch(() => undefined);
    const screenshotPath = `${process.cwd()}/output/screenshots/workday-language-diag-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    notes?.push(`workday_language_diagnostic:${JSON.stringify({
      label: selectors.languageLabel || "Language",
      fieldType: "button_select",
      currentValue: current || "",
      liveOptions: options,
      screenshotPath
    })}`);
    notes?.push("language_option_not_found");
    return { ok: false, reason: "language_option_not_found" };
  }

  const picked = await chooseExactOpenWorkdayOption(page, pickedValue).catch(() => false);
  if (!picked) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return { ok: false, reason: "language_option_not_found" };
  }
  await page.waitForTimeout(180);
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(180);
  const verified = await verifyDropdownSelected(trigger, pickedValue);
  if (verified) {
    notes?.push(`workday_language_selected:${normalizeText(pickedValue)}`);
    notes?.push("workday_language_verified");
  }
  return { ok: verified, reason: "language_option_not_found" };
}

export async function forceWorkdayApplicationQuestionExactNo(
  page: Page,
  widget: WorkdayWidgetSchema,
  notes?: string[]
): Promise<boolean> {
  if (widget.step !== "application_questions") return false;
  const exactNo = exactNormalizedOptionMatch("No", widget.options);
  if (!exactNo) return false;

  if (widget.widgetType === "button_select") {
    const selector = widget.selectorHints.controlSelector;
    if (!selector) return false;
    const trigger = page.locator(selector).first();
    if (!await trigger.isVisible().catch(() => false)) return false;
    await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
    await trigger.click().catch(() => undefined);
    await page.waitForTimeout(220);
    const openOptions = await extractOptionsFromOpenDropdown(page).catch(() => [] as string[]);
    const openExactNo = exactNormalizedOptionMatch("No", openOptions);
    if (!openExactNo) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return false;
    }
    const picked = await chooseExactOpenWorkdayOption(page, openExactNo).catch(() => false);
    if (!picked) return false;
    await page.waitForTimeout(180);
    await page.keyboard.press("Tab").catch(() => undefined);
    await page.waitForTimeout(150);
    const verified = await verifyDropdownSelected(trigger, "No");
    if (verified) notes?.push(`workday_question_verified:${normalizeText(widget.label)}`);
    return verified;
  }

  if (widget.widgetType === "prompt_input_select") {
    const selector = widget.selectorHints.controlSelector;
    if (!selector) return false;
    const input = page.locator(selector).first();
    if (!await input.isVisible().catch(() => false)) return false;
    await input.scrollIntoViewIfNeeded().catch(() => undefined);
    await input.click().catch(() => undefined);
    await input.press("ControlOrMeta+A").catch(() => undefined);
    await input.press("Backspace").catch(() => undefined);
    await input.type("No", { delay: 35 }).catch(() => undefined);
    await page.waitForTimeout(220);
    const openOptions = await extractOptionsFromOpenDropdown(page).catch(() => [] as string[]);
    const openExactNo = exactNormalizedOptionMatch("No", openOptions);
    if (!openExactNo) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return false;
    }
    const picked = await chooseExactOpenWorkdayOption(page, openExactNo).catch(() => false);
    if (!picked) return false;
    await page.waitForTimeout(180);
    await page.keyboard.press("Tab").catch(() => undefined);
    await page.waitForTimeout(150);
    const verified = await verifyDropdownSelected(input, "No");
    if (verified) notes?.push(`workday_question_verified:${normalizeText(widget.label)}`);
    return verified;
  }

  if (widget.widgetType === "radio_group") {
    const optionSelector = widget.selectorHints.optionSelectors?.[exactNo];
    if (!optionSelector) return false;
    const clicked = await clickOptionSelector(page, optionSelector);
    if (!clicked) return false;
    const verified = await verifyRadioOption(page, optionSelector);
    if (verified) notes?.push(`workday_question_verified:${normalizeText(widget.label)}`);
    return verified;
  }

  return false;
}

export async function verifyMyExperienceProgressionGuard(
  page: Page,
  filledFields: FilledFieldRecord[],
  notes?: string[]
): Promise<{ ok: boolean; reason?: string }> {
  const resumeState = await inspectMyExperienceResumeState(page);
  const resumeHandled = Boolean(readFilledFieldValue(filledFields, "resume_upload")) || resumeState.handled;
  const educationCommitted = readFilledFieldCount(filledFields, "__edu_filled_count__") > 0;
  const state = await inspectMyExperienceLanguageState(page);
  const selectors = await resolveMyExperienceLanguagesSelectors(page);
  const initialLanguage = normalizeText(state.language);
  const hasLanguageField = Boolean(selectors.languageSelector);
  const hasOverallField = Boolean(selectors.overallSelector);
  const overallCommitted = !hasOverallField || !selectors.overallRequired || (Boolean(state.overall) && !isPlaceholderOption(state.overall));

  notes?.push(`workday_resume_upload_attempt_count:${readFilledFieldCount(filledFields, "__resume_upload_attempt_count__")}`);
  notes?.push(`workday_resume_upload_live_entry_count:${resumeState.duplicateCount}`);
  notes?.push(`workday_my_experience_language_value:${state.language || "missing"}`);
  notes?.push(`workday_my_experience_overall_value:${state.overall || "missing"}`);

  let languageOk = !hasLanguageField || !selectors.languageRequired || /^english$|^english \(united states\)$|^english - united states$|^american english$/.test(initialLanguage);
  if (!languageOk && hasLanguageField) {
    const retried = await fillMyExperienceLanguageEnglishExact(page, notes);
    if (!retried.ok) {
      notes?.push(retried.reason || "workday_my_experience_language_verification_failed");
      upsertFilledFieldRecord(filledFields, { id: "__my_experience_language_verified__", label: "workday_my_experience_language_verified", value: "false", source: "manual", inputKind: "button_select" });
      return { ok: false, reason: retried.reason || "workday_my_experience_language_verification_failed" };
    }
    const afterRetry = await inspectMyExperienceLanguageState(page);
    notes?.push(`workday_my_experience_language_value:${afterRetry.language || "missing"}`);
    languageOk = /^english$|^english \(united states\)$|^english - united states$|^american english$/.test(normalizeText(afterRetry.language));
  }

  upsertFilledFieldRecord(filledFields, { id: "__my_experience_language_verified__", label: "workday_my_experience_language_verified", value: languageOk ? "true" : "false", source: "manual", inputKind: "button_select" });
  if (!resumeHandled) return { ok: false, reason: "workday_my_experience_resume_not_handled" };
  if (!educationCommitted) return { ok: false, reason: "workday_my_experience_education_not_committed" };
  if (!languageOk) return { ok: false, reason: "workday_my_experience_language_verification_failed" };
  if (!overallCommitted) return { ok: false, reason: "workday_my_experience_overall_not_committed" };
  return { ok: true };
}

export async function executeWorkdayWidgetPlan(input: {
  page: Page;
  plan: WorkdayWidgetAnswer[];
  widgets: WorkdayWidgetSchema[];
  profile: NormalizedWorkdayProfile;
  currentStep: string;
  filledFields: FilledFieldRecord[];
  notes?: string[];
  recoveryMode?: boolean;
  logger?: AppLogger;
}): Promise<WorkdayWidgetExecutionResult[]> {
  const { page, plan, widgets, profile, filledFields, notes, recoveryMode, logger } = input;
  setWorkdayExecutorRuntimeContext({
    step: input.currentStep,
    notes,
    label: "",
    selector: "",
    lastAction: "execute_widget_plan_start"
  });
  const betweenFieldDelayMs = recoveryMode ? 260 : 420;
  const widgetsById = new Map(widgets.map((widget) => [widget.widgetId, widget]));
  const educationCommitted = new Set<string>();
  const executionResults: WorkdayWidgetExecutionResult[] = [];
  if (input.currentStep === "my_experience") {
    const educationWidgets = widgets.filter((widget) => isMyExperienceEducationWidget(widget) && widget.widgetType !== "panel_collection");
    notes?.push(`workday_education_fields_extracted_count:${educationWidgets.length}`);
  }
  logger?.info("workday_step_execute_start", {
    step: input.currentStep,
    widgetPlanCount: plan.length,
    widgetCount: widgets.length,
    recoveryMode: Boolean(recoveryMode)
  });

  for (const answer of plan) {
    if (answer.value === null || answer.value === undefined) continue;
    const widget = widgetsById.get(answer.widgetId);
    if (!widget) continue;
    const isEducationWidget = input.currentStep === "my_experience" && isMyExperienceEducationWidget(widget) && widget.widgetType !== "panel_collection";

    const value = answer.value;
    const currentValue = Array.isArray(widget.currentValue) ? widget.currentValue.join("/") : String(widget.currentValue || "");
    const nextValue = Array.isArray(value) ? value.join("/") : String(value);
    const isSourceQuestion = isWorkdaySourceQuestionKey(widget.label, widget.selectorHints.dataAutomationId || "");
    setWorkdayExecutorRuntimeContext({
      label: widget.label,
      selector: widget.selectorHints.controlSelector || widget.selectorHints.containerSelector || "",
      lastAction: "resolve_widget_execution"
    });
    if (isEducationWidget) {
      notes?.push(`workday_education_field_resolved:${widget.label}:${serializeWidgetValueForTelemetry(value)}`);
    }
    if (isSourceQuestion) {
      notes?.push(`workday_source_question_detected:${normalizeText(widget.label)}`);
      notes?.push(`workday_source_options:${widget.options.map((option) => normalizeText(option)).join(" | ")}`);
    }
    const preexistingAcceptable = shouldAllowPreexistingWidgetShortCircuit(input.currentStep, widget.widgetType) && currentValue && (
      (isSourceQuestion && !isPlaceholderOption(normalizeText(currentValue))) ||
      normalizeText(currentValue) === normalizeText(nextValue) ||
      (isFieldOfStudyEducationLabel(widget.label) && matchesFieldOfStudyValue(currentValue, nextValue))
    );
    if (preexistingAcceptable) {
      logger?.info("workday_widget_execution_skipped_preexisting", {
        step: input.currentStep,
        label: widget.label,
        widgetType: widget.widgetType,
        currentValue: normalizeText(currentValue)
      });
      const verified = await verifyWorkdayWidgetValue(page, widget, value);
      executionResults.push({
        widgetId: widget.widgetId,
        executed: false,
        verified,
        failureReason: verified ? undefined : "preexisting_value_not_verified"
      });
      if (isSourceQuestion) {
        notes?.push(`workday_source_selected:${normalizeText(nextValue)}`);
        notes?.push(`workday_source_verified:${normalizeText(widget.label)}`);
      }
      continue;
    }

    let applied = false;
    let verified = false;
    let failureReason = "execution_not_attempted";
    for (let attempt = 0; attempt < 2 && !verified; attempt += 1) {
      logger?.info("workday_widget_execution_attempt", {
        step: input.currentStep,
        label: widget.label,
        widgetType: widget.widgetType,
        attempt: attempt + 1,
        targetValue: serializeWidgetValueForTelemetry(value)
      });
      notes?.push(`workday_widget_attempt:${normalizeText(widget.label)}:${widget.widgetType}:attempt=${attempt + 1}:value=${serializeWidgetValueForTelemetry(value)}`);
      applied = false;
      if (widget.step === "contact_information") {
        const specialApplied = await tryFillSpecialContactWidget(page, widget, profile, nextValue, notes);
        if (specialApplied !== null) {
          applied = specialApplied;
        } else {
          switch (widget.widgetType) {
            case "text_input":
            case "textarea":
              applied = widget.selectorHints.controlSelector ? await safeFill(page, widget.selectorHints.controlSelector, nextValue) : false;
              if (applied) await page.keyboard.press("Tab").catch(() => undefined);
              break;
            case "prompt_input_select":
              applied = await fillWorkdayPromptInputSelectWidget(page, widget, nextValue, notes);
              break;
            case "button_select":
              applied = await fillWorkdayButtonSelectWidget(page, widget, nextValue);
              break;
            case "radio_group":
              applied = await fillWorkdayRadioGroupWidget(page, widget, nextValue);
              break;
            case "checkbox_group":
              applied = await fillWorkdayCheckboxGroupWidget(page, widget, Array.isArray(value) ? value : [nextValue]);
              break;
            case "date_mm_yyyy":
            case "date_mm_dd_yyyy":
              if (input.currentStep === "self_identification") {
                applied = await fillSelfIdentificationDateField(page, notes);
                if (!applied) {
                  applied = await fillWorkdayDateWidget(page, widget, value);
                }
              } else {
                applied = await fillWorkdayDateWidget(page, widget, value);
              }
              break;
            case "file_upload":
              await fillResume(page, nextValue, filledFields, notes);
              applied = true;
              break;
            case "panel_collection":
              applied = await fillWorkdayPanelCollectionWidget(page, widget, profile, filledFields);
              break;
            default:
              applied = await fillWorkdayUnknownWidget(page, widget, value);
              break;
          }
        }
      } else if (isEducationWidget) {
        applied = await fillMyExperienceEducationWidget(page, widget, value, notes);
      } else {
        switch (widget.widgetType) {
          case "text_input":
          case "textarea":
            applied = widget.selectorHints.controlSelector ? await safeFill(page, widget.selectorHints.controlSelector, nextValue) : false;
            if (applied) await page.keyboard.press("Tab").catch(() => undefined);
            break;
          case "prompt_input_select":
            applied = await fillWorkdayPromptInputSelectWidget(page, widget, nextValue, notes);
            break;
          case "button_select":
            applied = await fillWorkdayButtonSelectWidget(page, widget, nextValue);
            break;
          case "radio_group":
            applied = await fillWorkdayRadioGroupWidget(page, widget, nextValue);
            break;
          case "checkbox_group":
            applied = await fillWorkdayCheckboxGroupWidget(page, widget, Array.isArray(value) ? value : [nextValue]);
            break;
          case "date_mm_yyyy":
          case "date_mm_dd_yyyy":
            if (input.currentStep === "self_identification") {
              applied = await fillSelfIdentificationDateField(page, notes);
              if (!applied) {
                applied = await fillWorkdayDateWidget(page, widget, value);
              }
            } else {
              applied = await fillWorkdayDateWidget(page, widget, value);
            }
            break;
          case "file_upload":
            await fillResume(page, nextValue, filledFields, notes);
            applied = true;
            break;
          case "panel_collection":
            applied = await fillWorkdayPanelCollectionWidget(page, widget, profile, filledFields);
            break;
          default:
            applied = await fillWorkdayUnknownWidget(page, widget, value);
            break;
        }
      }

      if (!applied) {
        failureReason = "execution_failed";
        logger?.warn("workday_widget_execution_apply_failed", {
          step: input.currentStep,
          label: widget.label,
          widgetType: widget.widgetType,
          attempt: attempt + 1
        });
        continue;
      }
      logger?.info("workday_widget_execution_applied", {
        step: input.currentStep,
        label: widget.label,
        widgetType: widget.widgetType,
        attempt: attempt + 1
      });
      verified = await verifyWorkdayWidgetValue(page, widget, value);
      logger?.info("workday_widget_execution_verify", {
        step: input.currentStep,
        label: widget.label,
        widgetType: widget.widgetType,
        attempt: attempt + 1,
        verified
      });
      if (input.currentStep === "application_questions" && (widget.widgetType === "button_select" || widget.widgetType === "prompt_input_select")) {
        const committedState = await readWidgetCurrentValue(page, widget);
        const committedValue = Array.isArray(committedState)
          ? committedState.map((entry) => normalizeText(entry)).filter(Boolean).join(" / ")
          : normalizeText(String(committedState || ""));
        notes?.push(`workday_questionnaire_commit_state:${normalizeText(widget.label)}:expected=${normalizeText(nextValue)}:live=${committedValue}:verified=${verified ? "true" : "false"}`);
      }
      failureReason = verified ? "" : "verification_failed";
    }

    executionResults.push({
      widgetId: widget.widgetId,
      executed: applied,
      verified,
      failureReason: failureReason || undefined
    });

    if (verified) {
      notes?.push(`workday_widget_executed:${widget.widgetId}`);
      notes?.push(`workday_widget_verified:${widget.widgetId}`);
      if (isSourceQuestion) {
        notes?.push(`workday_source_selected:${normalizeText(nextValue)}`);
        if (isSourceOtherOption(nextValue)) {
          await maybeFillSourceOtherDetails(page, widget.selectorHints.containerSelector, widget.selectorHints.controlSelector, profile.applicationSource || "LinkedIn");
        }
        notes?.push(`workday_source_verified:${normalizeText(widget.label)}`);
      }
      if (widget.step === "application_questions") {
        notes?.push(`workday_question_executed:${normalizeText(widget.label)}`);
        notes?.push(`workday_question_verified:${normalizeText(widget.label)}`);
      }
      if (isEducationWidget) {
        notes?.push(`workday_education_field_committed:${widget.label}`);
        educationCommitted.add(widget.widgetId);
      }
      filledFields.push({
        id: widget.widgetId,
        label: widget.label,
        value: nextValue,
        source: answer.source === "llm" ? "llm" : "profile",
        inputKind: widget.widgetType
      });
    } else {
      notes?.push(`workday_widget_failed:${widget.widgetId}:${failureReason}`);
      logger?.warn("workday_widget_execution_failed", {
        step: input.currentStep,
        label: widget.label,
        widgetType: widget.widgetType,
        failureReason
      });
    }

    await page.waitForTimeout(betweenFieldDelayMs);
  }

  logger?.info("workday_step_execute_done", {
    step: input.currentStep,
    executedCount: executionResults.filter((row) => row.executed).length,
    verifiedCount: executionResults.filter((row) => row.verified).length,
    failedCount: executionResults.filter((row) => row.failureReason).length
  });

  if (input.currentStep === "my_experience") {
    const prefilledCount = readFilledFieldCount(filledFields, "__edu_filled_count__");
    const finalEducationCount = Math.max(prefilledCount, educationCommitted.size);
    notes?.push(`workday_education_filled_count:${finalEducationCount}`);
    upsertFilledFieldRecord(filledFields, {
      id: "__edu_filled_count__",
      label: "workday_education_filled_count",
      value: String(finalEducationCount),
      source: "manual",
      inputKind: "panel_collection"
    });
  }

  return executionResults;
}
