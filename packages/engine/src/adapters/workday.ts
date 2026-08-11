import path from "node:path";
import { BaseAdapter } from "./base.js";
import type { AdapterRunContext, JobRunResult, ReviewReceiptItem, WorkdayRunSummary } from "../core/types.js";
import { classifyFooterButton, clickSubmit, nextStepMarkersFor, openJob, safeClick, safeFill, selectorExists, startApplyFlowDeterministic, waitForExpectedTransitionMarker } from "./workday/navigation.js";
import { collectWorkdayWidgetDebugPayload, executeWorkdayWidgetPlan, isWorkdayExecutorRuntimeError, prepareMyExperienceStep, runWorkdayCommitSweep, serializeWorkdayWidgetAnswer } from "./workday/executor.js";
import { clickNextAndRecoverValidation, hydrateRetryWidgetsWithLiveOptions } from "./workday/recovery.js";
import {
  collectPreexistingWorkdayWidgetAnswers,
  mergeLockedWidgetAnswers,
  normalizeWorkdayProfile,
  planWorkdayUnresolvedWidgets,
  resolveWorkdayWidgetAlias,
  resolveWorkdayWidgetDeterministic,
  unresolvedWidgets,
  validateResolvedWorkdayWidgetAnswer
} from "./workday/resolver.js";
import { STEP_VISIBLE_MARKERS, collectWorkdayApplicationQuestionsExtractionDiagnostics, detectWorkdayStep, extractWorkdayStepWidgets, isFirstActionableWorkdayStepReady, isReviewOrSubmitPage, resolveActiveWorkdayContainerSelector, type WorkdayStep } from "./workday/schema.js";
import { normalizeWorkdayApplyUrl } from "./workday/entry.js";
import { probeWorkdayReadyState, type WorkdayReadyProbe } from "./workday/readiness.js";

const WORKDAY_AUTH_READY_TIMEOUT_MS = 60_000;
const WORKDAY_POST_CREATE_ACCOUNT_TIMEOUT_MS = 40_000;
const WORKDAY_POST_SIGN_IN_TIMEOUT_MS = 45_000;
const WORKDAY_POST_SIGN_IN_AUTH_RETRY_TIMEOUT_MS = 2_500;
const WORKDAY_FIRST_ACTIONABLE_STEP_TIMEOUT_MS = 180_000;
const WORKDAY_STEP_ACTIONABLE_TIMEOUT_MS = 60_000;
const WORKDAY_REVIEW_RECEIPT_WAIT_MS = 3_000;

const WORKDAY_ACTIONABLE_STEPS: WorkdayStep[] = [
  "contact_information",
  "my_experience",
  "application_questions",
  "voluntary_disclosures",
  "self_identification",
  "take_assessment",
  "review",
  "submit"
];

function normalizeWorkdayText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function parseWorkdayNoteValue(note: string, prefix: string): string | null {
  return note.startsWith(prefix) ? note.slice(prefix.length) : null;
}

function uniqueWorkdayStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function dedupeWorkdayReviewReceipt(items: ReviewReceiptItem[]): ReviewReceiptItem[] {
  const seen = new Set<string>();
  const ordered: ReviewReceiptItem[] = [];
  for (const item of items) {
    const question = normalizeWorkdayText(item.question || "");
    const answer = normalizeWorkdayText(item.answer || "");
    if (!question || !answer) continue;
    const section = normalizeWorkdayText(item.section || "");
    const key = `${section}||${question}||${answer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push({
      section: item.section?.trim() || undefined,
      question: item.question.trim(),
      answer: item.answer.trim()
    });
  }
  return ordered;
}

interface WorkdayReviewReceiptDiagnostics {
  rootSelector: string;
  strategyCounts: Record<string, number>;
  finalCount: number;
}

function formatWorkdayReviewReceiptDiagnostics(diagnostics: WorkdayReviewReceiptDiagnostics): string {
  const strategySummary = Object.entries(diagnostics.strategyCounts)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return `root=${diagnostics.rootSelector || "unknown"};counts=${strategySummary || "none"};final=${diagnostics.finalCount}`;
}

export async function extractWorkdayReviewReceiptWithDiagnostics(page: import("playwright").Page): Promise<{
  items: ReviewReceiptItem[];
  diagnostics: WorkdayReviewReceiptDiagnostics;
}> {
  const extracted = await page.evaluate(() => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
    const normalizeLoose = (value: unknown): string => normalize(value).toLowerCase();
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const reviewRootCandidates = [
      "div[data-automation-id='reviewPage']",
      "div[data-automation-id*='reviewPage']",
      "div[data-automation-id*='applicationReview']",
      "[data-automation-id*='reviewStep']",
      "[data-automation-id*='summaryPage']",
      "main",
      "form",
      "body"
    ];
    const resolvedRoot = (() => {
      for (const selector of reviewRootCandidates) {
        const node = document.querySelector(selector);
        if (visible(node)) return { selector, node };
      }
      return { selector: "body", node: document.body };
    })();
    const root = resolvedRoot.node;
    const rootSelector = resolvedRoot.selector;
    if (!visible(root)) {
      return {
        items: [] as Array<{ section?: string; question: string; answer: string }>,
        diagnostics: {
          rootSelector,
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

    const strategyCounts = {
      formField: 0,
      descriptionList: 0,
      tableRow: 0,
      groupedField: 0,
      pairedBlock: 0
    };

    const findSectionTitle = (node: Element | null): string => {
      let current: Element | null = node;
      while (current) {
        const heading = current.querySelector("h1, h2, h3, h4, legend, [data-automation-id*='sectionTitle'], [data-automation-id*='pageHeader'], [data-automation-id*='sectionHeader']");
        const text = normalize(heading?.textContent || "");
        if (text) return text;
        let sibling: Element | null = current.previousElementSibling;
        while (sibling) {
          if (visible(sibling) && /^(h1|h2|h3|h4|legend)$/i.test(sibling.tagName)) {
            const siblingText = normalize(sibling.textContent || "");
            if (siblingText) return siblingText;
          }
          sibling = sibling.previousElementSibling;
        }
        current = current.parentElement;
      }
      return "";
    };

    const cloneAndStrip = (node: Element): HTMLElement => {
      const clone = node.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("button, svg, path, script, style, [aria-hidden='true'], [hidden], .sr-only, .visually-hidden").forEach((child) => child.remove());
      return clone;
    };

    const cleanAnswer = (value: string, question = ""): string => {
      let cleaned = normalize(value)
        .replace(/\bedit\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      const normalizedQuestion = normalize(question);
      if (normalizedQuestion) {
        const questionPrefix = new RegExp(`^${normalizedQuestion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[:\\s-]*`, "i");
        cleaned = cleaned.replace(questionPrefix, "").trim();
      }
      return cleaned;
    };

    const pushItem = (items: Array<{ section?: string; question: string; answer: string }>, question: string, answer: string, section?: string, strategy?: keyof typeof strategyCounts) => {
      const normalizedQuestion = normalize(question);
      const cleanedAnswer = cleanAnswer(answer, normalizedQuestion);
      if (!normalizedQuestion || !cleanedAnswer) return;
      items.push({
        section: section || undefined,
        question: normalizedQuestion,
        answer: cleanedAnswer
      });
      if (strategy) strategyCounts[strategy] += 1;
    };

    const items: Array<{ section?: string; question: string; answer: string }> = [];

    for (const row of Array.from(root.querySelectorAll("[data-automation-id^='formField-'], [data-automation-id*='formField']"))) {
      if (!visible(row)) continue;
      const labelNode = row.querySelector("label, legend, [data-automation-id='formLabel'], [data-automation-id*='formLabel']");
      const question = normalize(labelNode?.textContent || "");
      if (!question) continue;
      const clone = cloneAndStrip(row);
      const clonedLabel = clone.querySelector("label, legend, [data-automation-id='formLabel'], [data-automation-id*='formLabel']");
      if (clonedLabel) clonedLabel.remove();
      pushItem(items, question, clone.innerText || clone.textContent || "", findSectionTitle(row) || undefined, "formField");
    }

    for (const list of Array.from(root.querySelectorAll("dl"))) {
      if (!visible(list)) continue;
      const terms = Array.from(list.querySelectorAll("dt"));
      for (const term of terms) {
        if (!visible(term)) continue;
        const question = normalize(term.textContent || "");
        if (!question) continue;
        pushItem(items, question, term.nextElementSibling?.textContent || "", findSectionTitle(list) || undefined, "descriptionList");
      }
    }

    for (const row of Array.from(root.querySelectorAll("tr"))) {
      if (!visible(row)) continue;
      const cells = Array.from(row.querySelectorAll("th, td")).filter((cell) => visible(cell));
      if (cells.length < 2) continue;
      const question = normalize(cells[0]?.textContent || "");
      pushItem(
        items,
        question,
        cells.slice(1).map((cell) => normalize(cell.textContent || "")).join(" "),
        findSectionTitle(row) || undefined,
        "tableRow"
      );
    }

    const groupedCandidates = Array.from(root.querySelectorAll(
      "[data-automation-id*='reviewItem'], [data-automation-id*='summaryItem'], [data-automation-id*='fieldSet'], [data-automation-id*='fieldGroup'], .review-item, .summary-item, li, section > div, article > div"
    ));
    for (const candidate of groupedCandidates) {
      if (!visible(candidate)) continue;
      if (candidate.querySelector("[data-automation-id^='formField-'], [data-automation-id*='formField'], dl, table, tr")) continue;
      const questionNode = candidate.querySelector(
        "label, legend, dt, th, [data-automation-id='formLabel'], [data-automation-id*='formLabel'], [data-automation-id*='fieldLabel'], [data-automation-id*='prompt'], strong"
      );
      const question = normalize(questionNode?.textContent || "");
      if (!question) continue;
      const answerNode = candidate.querySelector(
        "[data-automation-id*='fieldValue'], [data-automation-id*='value'], dd, td, p, span, div"
      );
      const answer = normalize(answerNode?.textContent || "");
      if (!answer || normalizeLoose(answer) === normalizeLoose(question)) continue;
      pushItem(items, question, answer, findSectionTitle(candidate) || undefined, "groupedField");
    }

    const pairedBlockCandidates = Array.from(root.querySelectorAll("section, article, li, div"));
    for (const candidate of pairedBlockCandidates) {
      if (!visible(candidate)) continue;
      if (candidate.querySelector("[data-automation-id^='formField-'], [data-automation-id*='formField'], dl, table, tr")) continue;
      const children = Array.from(candidate.children).filter((child) => visible(child));
      if (children.length < 2 || children.length > 4) continue;
      const first = children[0];
      const second = children[1];
      if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement)) continue;
      // A block that leads with a heading is a section wrapper, not a question/answer
      // pair. Without this guard the wrapper is captured as
      // {question: "<section title>", answer: "<everything inside>"} in addition to
      // the real inner rows, which both duplicates and corrupts the receipt.
      if (/^(h1|h2|h3|h4|h5|h6|legend)$/i.test(first.tagName)) continue;
      if (first.querySelector("input, select, textarea, button") || second.querySelector("input, select, textarea, button")) continue;
      const question = normalize(first.innerText || first.textContent || "");
      const answer = normalize(second.innerText || second.textContent || "");
      if (!question || !answer) continue;
      if (normalizeLoose(question) === normalizeLoose(answer)) continue;
      if (question.length > 180 || answer.length > 400) continue;
      pushItem(items, question, answer, findSectionTitle(candidate) || undefined, "pairedBlock");
    }

    return {
      items,
      diagnostics: {
        rootSelector,
        strategyCounts,
        finalCount: items.length
      }
    };
  }).catch(() => ({
    items: [] as ReviewReceiptItem[],
    diagnostics: {
      rootSelector: "evaluation_error",
      strategyCounts: {
        formField: 0,
        descriptionList: 0,
        tableRow: 0,
        groupedField: 0,
        pairedBlock: 0
      },
      finalCount: 0
    }
  }));

  const deduped = dedupeWorkdayReviewReceipt(extracted.items);
  return {
    items: deduped,
    diagnostics: {
      ...extracted.diagnostics,
      finalCount: deduped.length
    }
  };
}

export async function extractWorkdayReviewReceipt(page: import("playwright").Page): Promise<ReviewReceiptItem[]> {
  return (await extractWorkdayReviewReceiptWithDiagnostics(page)).items;
}

function isActionableWorkdayStep(step: WorkdayStep | null | undefined): step is WorkdayStep {
  return Boolean(step && WORKDAY_ACTIONABLE_STEPS.includes(step));
}

export function resolveAcceptedWorkdayDirectStep(input: {
  expectedStep?: WorkdayStep;
  observedStep?: WorkdayStep | null;
  probe?: Pick<WorkdayReadyProbe, "state" | "step" | "stepReady"> | null;
}): WorkdayStep | null {
  const matchesExpected = (step: WorkdayStep | null | undefined): step is WorkdayStep =>
    isActionableWorkdayStep(step) && (!input.expectedStep || step === input.expectedStep || step !== "unknown");

  if (matchesExpected(input.observedStep)) return input.observedStep;
  if (input.probe?.state === "application_step" && matchesExpected(input.probe.step)) return input.probe.step;
  return null;
}

async function waitForVisibleWorkdayStep(page: AdapterRunContext["page"], steps: WorkdayStep[], timeoutMs: number): Promise<WorkdayStep | null> {
  const stepMarkers = steps
    .map((step) => ({ step, markers: STEP_VISIBLE_MARKERS[step] || [] }))
    .filter((entry) => entry.markers.length > 0);
  if (!stepMarkers.length) return null;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const entry of stepMarkers) {
      for (const selector of entry.markers) {
        if (await selectorExists(page, selector, 150)) return entry.step;
      }
    }
    await page.waitForTimeout(200);
  }
  return null;
}

export async function captureWorkdayReviewReceiptIfPresent(input: {
  page: AdapterRunContext["page"];
  result: Pick<JobRunResult, "reviewReceipt" | "notes">;
  waitForMarkersMs?: number;
  detectReviewStep?: (page: AdapterRunContext["page"]) => Promise<WorkdayStep>;
  extractReceipt?: (page: AdapterRunContext["page"]) => Promise<ReviewReceiptItem[]>;
  extractReceiptWithDiagnostics?: (page: AdapterRunContext["page"]) => Promise<{
    items: ReviewReceiptItem[];
    diagnostics: WorkdayReviewReceiptDiagnostics;
  }>;
  waitForReviewEvidence?: (page: AdapterRunContext["page"], steps: WorkdayStep[], timeoutMs: number) => Promise<WorkdayStep | null>;
}): Promise<number> {
  if (input.result.reviewReceipt?.length) return input.result.reviewReceipt.length;

  let reviewEvidenceStep: WorkdayStep | null = null;
  if ((input.waitForMarkersMs || 0) > 0) {
    reviewEvidenceStep = await (input.waitForReviewEvidence || waitForVisibleWorkdayStep)(input.page, ["review", "submit"], input.waitForMarkersMs || 0);
  }

  const step = await (input.detectReviewStep || detectWorkdayStep)(input.page).catch(() => "unknown" as WorkdayStep);
  const confirmedReviewStep = step === "review" || step === "submit" ? step : reviewEvidenceStep;
  if (confirmedReviewStep !== "review" && confirmedReviewStep !== "submit") return 0;

  const extractWithDiagnostics = async () => {
    if (input.extractReceiptWithDiagnostics) return input.extractReceiptWithDiagnostics(input.page);
    if (input.extractReceipt) {
      const items = await input.extractReceipt(input.page);
      return {
        items,
        diagnostics: {
          rootSelector: "custom_extractor",
          strategyCounts: {
            formField: 0,
            descriptionList: 0,
            tableRow: 0,
            groupedField: 0,
            pairedBlock: 0
          },
          finalCount: items.length
        }
      };
    }
    return extractWorkdayReviewReceiptWithDiagnostics(input.page);
  };

  let extraction = await extractWithDiagnostics().catch(() => ({
    items: [] as ReviewReceiptItem[],
    diagnostics: {
      rootSelector: "extraction_error",
      strategyCounts: {
        formField: 0,
        descriptionList: 0,
        tableRow: 0,
        groupedField: 0,
        pairedBlock: 0
      },
      finalCount: 0
    }
  }));

  if (!extraction.items.length && reviewEvidenceStep) {
    await input.page.waitForTimeout(400);
    extraction = await extractWithDiagnostics().catch(() => extraction);
  }

  input.result.notes.push(`workday_review_receipt_count:${extraction.items.length}`);
  if (extraction.items.length) {
    input.result.reviewReceipt = extraction.items;
    return extraction.items.length;
  }

  input.result.notes.push(`workday_review_receipt_diagnostics:${confirmedReviewStep}:${formatWorkdayReviewReceiptDiagnostics(extraction.diagnostics)}`);
  return 0;
}

function isCommittedWorkdayDebugValue(row: Record<string, unknown>): boolean {
  const fieldType = String(row.fieldType || "").toLowerCase();
  const currentValue = String(row.currentValue || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!currentValue) return false;
  if (/^(select one|choose one|please select|search|add|upload|select files|calendar|0 items selected)$/.test(currentValue)) {
    return false;
  }
  if (fieldType === "checkbox") return currentValue !== "";
  if (fieldType === "dropdown" || fieldType === "combobox" || fieldType === "radio") return currentValue !== "";
  if (fieldType === "text" || fieldType === "textarea" || fieldType === "date") return currentValue !== "";
  return true;
}

function actionableWorkdayWidgets(
  widgets: import("./workday/schema.js").WorkdayWidgetSchema[],
  step: WorkdayStep
): import("./workday/schema.js").WorkdayWidgetSchema[] {
  return widgets.filter((widget) => {
    if (widget.widgetType === "panel_collection") return false;
    if (step === "my_experience" && widget.widgetType === "unknown") {
      const key = normalizeWorkdayText([
        widget.label,
        widget.promptText,
        String(widget.selectorHints.dataAutomationId || ""),
        String(widget.selectorHints.controlSelector || ""),
        String(widget.selectorHints.containerSelector || "")
      ].join(" "));
      if (/select-files|choose-file|delete-file|remove-file|upload/.test(key)) return false;
    }
    return true;
  });
}

function isWorkdayPlaceholderOption(value: string): boolean {
  return /^(select one|select\.\.\.|select|please select|choose one|choose|search|all|partial list \(first 500 entries\)|no items\.?)$/i.test(normalizeWorkdayText(value));
}

function hasRealWorkdayOptions(widget: import("./workday/schema.js").WorkdayWidgetSchema): boolean {
  return widget.options.some((option) => !isWorkdayPlaceholderOption(option));
}

function isHydratableSingleSelectWidget(widget: import("./workday/schema.js").WorkdayWidgetSchema): boolean {
  return widget.widgetType === "button_select" ||
    widget.widgetType === "prompt_input_select" ||
    widget.widgetType === "radio_group";
}

async function hydrateRequiredApplicationQuestionSelectWidgets(input: {
  page: import("playwright").Page;
  widgets: import("./workday/schema.js").WorkdayWidgetSchema[];
  notes: string[];
  logger: AdapterRunContext["logger"];
  step: WorkdayStep;
}): Promise<import("./workday/schema.js").WorkdayWidgetSchema[]> {
  if (input.step !== "application_questions") return input.widgets;
  const candidates = input.widgets.filter((widget) => widget.required && isHydratableSingleSelectWidget(widget) && !hasRealWorkdayOptions(widget));
  if (!candidates.length) return input.widgets;

  const hydratedCandidates = await hydrateRetryWidgetsWithLiveOptions(input.page, candidates, input.notes);
  const hydratedById = new Map(hydratedCandidates.map((widget) => [widget.widgetId, widget]));
  const merged = input.widgets.map((widget) => hydratedById.get(widget.widgetId) || widget);

  for (const widget of merged) {
    if (!widget.required || !isHydratableSingleSelectWidget(widget)) continue;
    if (hasRealWorkdayOptions(widget)) continue;
    input.logger.warn("workday_dropdown_hydration_failed", {
      step: input.step,
      widgetId: widget.widgetId,
      label: widget.label,
      selector: widget.selectorHints.controlSelector || "",
      currentLabel: Array.isArray(widget.currentValue) ? widget.currentValue.join(" / ") : String(widget.currentValue || ""),
      visibleOptionCount: widget.options.length
    });
    input.notes.push(
      `workday_dropdown_hydration_failed:${normalizeWorkdayText(widget.label)}:widgetId=${widget.widgetId}:selector=${widget.selectorHints.controlSelector || ""}:current=${normalizeWorkdayText(Array.isArray(widget.currentValue) ? widget.currentValue.join(" / ") : String(widget.currentValue || ""))}:visibleOptionCount=${widget.options.length}`
    );
  }

  return merged;
}

function noteWorkdayPhase(
  notes: string[] | undefined,
  logger: AdapterRunContext["logger"] | undefined,
  event: string,
  data: Record<string, unknown>
): void {
  if (notes) {
    const step = typeof data.step === "string" ? data.step : "";
    const phase = typeof data.phase === "string" ? data.phase : "";
    const message = typeof data.message === "string" ? data.message : "";
    notes.push(`workday_phase:${event}:${step}:${phase}:${message}`);
  }
  logger?.info(event, data);
}

function logExtractedWorkdayWidgets(
  logger: AdapterRunContext["logger"] | undefined,
  step: WorkdayStep,
  widgets: import("./workday/schema.js").WorkdayWidgetSchema[]
): void {
  for (const widget of widgets) {
    logger?.info("workday_widget_extracted", {
      step,
      widgetId: widget.widgetId,
      label: widget.label,
      widgetType: widget.widgetType,
      required: widget.required,
      currentValue: Array.isArray(widget.currentValue) ? widget.currentValue.join(" / ") : String(widget.currentValue ?? ""),
      possibleAnswers: widget.options,
      possibleAnswersCount: widget.options.length,
      controlSelector: widget.selectorHints.controlSelector || "",
      containerSelector: widget.selectorHints.containerSelector || "",
      dataAutomationId: widget.selectorHints.dataAutomationId || ""
    });
  }
}

function logResolvedWorkdayWidgetPlan(
  logger: AdapterRunContext["logger"] | undefined,
  step: WorkdayStep,
  widgets: import("./workday/schema.js").WorkdayWidgetSchema[],
  answers: import("./workday/resolver.js").WorkdayWidgetAnswer[],
  phase: "deterministic" | "preexisting" | "alias" | "llm" | "merged"
): void {
  const widgetsById = new Map(widgets.map((widget) => [widget.widgetId, widget]));
  for (const answer of answers) {
    const widget = widgetsById.get(answer.widgetId);
    logger?.info("workday_widget_resolved", {
      step,
      phase,
      widgetId: answer.widgetId,
      label: widget?.label || "",
      widgetType: widget?.widgetType || "",
      source: answer.source,
      reason: answer.reason || "",
      value: Array.isArray(answer.value) ? answer.value.join(" / ") : String(answer.value ?? ""),
      possibleAnswers: widget?.options || []
    });
  }
}

function validateWorkdayWidgetPlan(
  logger: AdapterRunContext["logger"] | undefined,
  notes: string[],
  step: WorkdayStep,
  widgets: import("./workday/schema.js").WorkdayWidgetSchema[],
  answers: Iterable<import("./workday/resolver.js").WorkdayWidgetAnswer>
): Map<string, import("./workday/resolver.js").WorkdayWidgetAnswer> {
  const widgetsById = new Map(widgets.map((widget) => [widget.widgetId, widget]));
  const validated = new Map<string, import("./workday/resolver.js").WorkdayWidgetAnswer>();

  for (const answer of answers) {
    const widget = widgetsById.get(answer.widgetId);
    if (!widget) continue;
    const validation = validateResolvedWorkdayWidgetAnswer(widget, answer);
    if (!validation.accepted) {
      logger?.warn("workday_widget_resolution_rejected", {
        step,
        widgetId: widget.widgetId,
        label: widget.label,
        widgetType: widget.widgetType,
        resolvedAnswer: Array.isArray(answer.value) ? answer.value.join(" / ") : String(answer.value ?? ""),
        possibleAnswers: widget.options,
        reason: validation.reason || "answer_not_in_options"
      });
      notes.push(`workday_widget_resolution_rejected:${JSON.stringify({
        widgetId: widget.widgetId,
        label: widget.label,
        widgetType: widget.widgetType,
        resolvedAnswer: Array.isArray(answer.value) ? answer.value.join(" / ") : String(answer.value ?? ""),
        possibleAnswers: widget.options,
        reason: validation.reason || "answer_not_in_options"
      })}`);
      continue;
    }
    validated.set(answer.widgetId, {
      ...answer,
      value: validation.value
    });
  }

  return validated;
}

function logUnresolvedWorkdayWidgets(
  logger: AdapterRunContext["logger"] | undefined,
  step: WorkdayStep,
  widgets: import("./workday/schema.js").WorkdayWidgetSchema[]
): void {
  for (const widget of widgets) {
    logger?.warn("workday_widget_unresolved", {
      step,
      widgetId: widget.widgetId,
      label: widget.label,
      widgetType: widget.widgetType,
      required: widget.required,
      currentValue: Array.isArray(widget.currentValue) ? widget.currentValue.join(" / ") : String(widget.currentValue ?? ""),
      possibleAnswers: widget.options,
      controlSelector: widget.selectorHints.controlSelector || "",
      containerSelector: widget.selectorHints.containerSelector || ""
    });
  }
}

function buildWorkdayRunSummary(result: JobRunResult): WorkdayRunSummary {
  const jobUrl = result.url;
  const tenantHost = (() => {
    try {
      return new URL(jobUrl).host;
    } catch {
      return "";
    }
  })();
  const stepStarts = result.notes
    .map((note) => parseWorkdayNoteValue(note, "workday_known_flow_step_start:"))
    .filter((value): value is string => Boolean(value));
  const stepDones = result.notes
    .map((note) => parseWorkdayNoteValue(note, "workday_known_flow_step_done:"))
    .filter((value): value is string => Boolean(value));
  const postSubmitStep = result.notes
    .map((note) => parseWorkdayNoteValue(note, "workday_post_submit_step:"))
    .filter((value): value is string => Boolean(value) && value !== "unknown");
  const reviewDetected = result.notes.some((note) => note === "workday_submit_clicked" || note.startsWith("workday_post_submit_confirmation:"))
    ? ["review_or_submit_exit"]
    : [];
  const validationRecoveriesUsed = uniqueWorkdayStrings([
    ...result.notes
      .map((note) => parseWorkdayNoteValue(note, "workday_recovery:step="))
      .filter((value): value is string => Boolean(value))
      .filter((value) => /attempts=(?!0\b)\d+/.test(value))
      .map((value) => `step:${value}`),
    ...(result.questionnaireResolution || [])
      .filter((entry) => entry.applied || entry.verified || (entry.attemptedStrategies?.length ?? 0) > 0)
      .map((entry) => `field:${entry.label}:${entry.attemptedStrategies?.join("+") || "recovery"}`)
  ]);
  const finalSubmitEvidence = uniqueWorkdayStrings(result.notes.filter((note) => (
    note === "workday_submit_clicked" ||
    note.startsWith("workday_post_submit_") ||
    note === "workday_exit_reason:submitted_or_confirmed"
  )));

  return {
    tenantHost,
    jobUrl,
    stepsReached: uniqueWorkdayStrings([...stepStarts, ...stepDones, ...postSubmitStep, ...reviewDetected]),
    status: result.status,
    submitted: result.submitted,
    submissionConfirmed: result.submissionConfirmed,
    submitOutcome: result.submitOutcome,
    deterministicResolvedCount: result.notes.filter((note) => note.startsWith("workday_question_deterministic_resolved:")).length,
    aliasResolvedCount: result.notes.filter((note) => note.startsWith("workday_question_alias_resolved:")).length,
    llmResolvedCount: result.notes.filter((note) => note.startsWith("workday_question_llm_answer:")).length,
    validationRecoveriesUsed,
    finalSubmitEvidence
  };
}

function markWorkdayTakeAssessmentRequired(result: JobRunResult): void {
  const message = "We could not finish your application because Workday requires a manual assessment. Open the application and complete the assessment to continue.";
  result.status = "failed";
  result.submitOutcome = "manual_assessment_required";
  result.error = "workday_take_assessment_required";
  result.notes.push("workday_take_assessment_detected");
  result.notes.push("workday_action_required:take_assessment");
  result.notes.push(`workday_manual_handoff_message:${message}`);
}

function noteResolvedWorkdayQuestionAnswers(
  notes: string[],
  prefix: "workday_question_deterministic_resolved" | "workday_question_alias_resolved",
  plan: Map<string, import("./workday/resolver.js").WorkdayWidgetAnswer>,
  widgets: import("./workday/schema.js").WorkdayWidgetSchema[]
): void {
  const widgetsById = new Map(widgets.map((widget) => [widget.widgetId, widget]));
  for (const [widgetId, answer] of plan.entries()) {
    const widget = widgetsById.get(widgetId);
    if (!widget) continue;
    const value = Array.isArray(answer.value) ? answer.value.join(" | ") : String(answer.value ?? "");
    notes.push(`${prefix}:${normalizeWorkdayText(widget.label)}:${normalizeWorkdayText(value)}`);
  }
}

async function footerContinueDisabled(page: AdapterRunContext["page"]): Promise<boolean> {
  return page.locator("button[data-automation-id='pageFooterNextButton'], button[data-automation-id='bottom-navigation-next-button']").first()
    .evaluate((btn) => {
      if (!(btn instanceof HTMLButtonElement)) return true;
      const cs = window.getComputedStyle(btn);
      return Boolean(btn.disabled || btn.getAttribute("aria-disabled") === "true" || cs.pointerEvents === "none");
    })
    .catch(() => false);
}

async function countVisibleRequiredControls(page: AdapterRunContext["page"], activeSelector: string): Promise<number> {
  return page.locator(activeSelector)
    .locator("[required], [aria-required='true'], .requiredAsterisk, abbr[aria-hidden='true']")
    .evaluateAll((nodes) => nodes.filter((n) => {
      const el = n as HTMLElement;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    }).length)
    .catch(() => 0);
}

async function evaluateUniversalWorkdayStepReadiness(input: {
  page: AdapterRunContext["page"];
  widgets: import("./workday/schema.js").WorkdayWidgetSchema[];
  widgetPlan: import("./workday/resolver.js").WorkdayWidgetAnswer[];
  executionResults: import("./workday/executor.js").WorkdayWidgetExecutionResult[];
  notes: string[];
}): Promise<{
  ok: boolean;
  stage?: "resolver" | "verification" | "commit";
  payload: Array<Record<string, unknown>>;
}> {
  const executionById = new Map(input.executionResults.map((result) => [result.widgetId, result]));
  const widgetsToInspect = input.widgets.filter((widget) => {
    if (widget.required) return true;
    const execution = executionById.get(widget.widgetId);
    return Boolean(execution?.executed || execution?.failureReason);
  });
  const payload = await collectWorkdayWidgetDebugPayload({
    page: input.page,
    widgets: widgetsToInspect,
    plan: input.widgetPlan,
    executionResults: input.executionResults
  });
  for (const row of payload) {
    input.notes.push(`workday_widget_state:${JSON.stringify(row)}`);
  }

  const unresolvedRequired = payload.filter((row) => Boolean(row.required) && !String(row.resolvedAnswer || "").trim() && !isCommittedWorkdayDebugValue(row));
  if (unresolvedRequired.length) {
    return { ok: false, stage: "resolver", payload: unresolvedRequired };
  }

  await runWorkdayCommitSweep(input.page);
  const committedPayload = await collectWorkdayWidgetDebugPayload({
    page: input.page,
    widgets: widgetsToInspect,
    plan: input.widgetPlan,
    executionResults: input.executionResults
  });
  for (const row of committedPayload) {
    input.notes.push(`workday_widget_committed_state:${JSON.stringify(row)}`);
  }
  const uncommittedRequired = committedPayload.filter((row) => Boolean(row.required) && !String(row.resolvedAnswer || "").trim() && !isCommittedWorkdayDebugValue(row));
  if (uncommittedRequired.length) {
    return { ok: false, stage: "resolver", payload: uncommittedRequired };
  }
  const unverifiedRequired = committedPayload.filter((row) => Boolean(row.required) && row.verified !== true);
  if (unverifiedRequired.length) {
    input.notes.push(`workday_unverified_required_before_next:${JSON.stringify(unverifiedRequired)}`);
  }

  if (await footerContinueDisabled(input.page)) {
    return { ok: false, stage: "commit", payload: committedPayload.filter((row) => Boolean(row.required) && row.verified !== true) };
  }

  return { ok: true, payload: committedPayload };
}

async function collectPostSubmitValidationErrors(page: AdapterRunContext["page"]): Promise<string[]> {
  const messages = await page
    .locator("[data-automation-id*='error'], [role='alert'], [aria-invalid='true'], .error")
    .allInnerTexts()
    .catch(() => [] as string[]);

  const relevant = messages
    .map((message) => normalizeWorkdayText(message))
    .filter(Boolean)
    .filter((message) => (
      /required and must have a value|invalid date|invalid value|field .* is required|please check one of the boxes below|please select|please complete|error:/.test(message) &&
      !/completed step \d of \d|current step \d of \d|step \d of \d/.test(message)
    ));

  return [...new Set(relevant)].slice(0, 10);
}

async function detectPostSubmitConfirmation(page: AdapterRunContext["page"]): Promise<{
  confirmed: boolean;
  pending: boolean;
  evidence?: string;
}> {
  const url = page.url();
  const visibleText = normalizeWorkdayText(await page.locator("main, body").first().innerText().catch(() => ""));
  const headings = normalizeWorkdayText((await page.locator("h1, h2, h3").allInnerTexts().catch(() => [] as string[])).join(" "));

  const confirmationPatterns = [
    /application submitted/,
    /your application has been submitted/,
    /thank you for applying/,
    /thank you for your interest/,
    /we have received your application/,
    /successfully submitted/
  ];
  if (confirmationPatterns.some((pattern) => pattern.test(visibleText) || pattern.test(headings))) {
    return { confirmed: true, pending: false, evidence: "confirmation_text" };
  }

  const leftApplyFlow = !/\/apply\/applymanually/i.test(url);
  const footer = await classifyFooterButton(page).catch(() => ({ kind: "none", text: "" }));
  if (leftApplyFlow && footer.kind !== "submit" && footer.kind !== "continue") {
    return { confirmed: false, pending: true, evidence: "left_apply_flow" };
  }

  return { confirmed: false, pending: false };
}

async function pacedWait(page: AdapterRunContext["page"], minMs = 500, maxMs = 1400): Promise<void> {
  const ms = minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs + 1));
  await page.waitForTimeout(ms);
}

function noteWorkdayVerificationAction(notes: string[] | undefined, probe: Pick<WorkdayReadyProbe, "verificationEvidence">): void {
  if (!notes) return;
  notes.push("workday_action_required:verify_email_then_rerun");
  if (probe.verificationEvidence) {
    notes.push(`workday_auth_verification_gate_evidence:${normalizeWorkdayText(probe.verificationEvidence)}`);
  }
}

function isWorkdayPageClosedLikeError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error ?? "");
  return /target page, context or browser has been closed|browser has been closed|context.*closed|page\.waitfor/i.test(text);
}

async function ensureWorkdayPageOpen(
  page: AdapterRunContext["page"],
  stage: string,
  notes?: string[],
  step?: string
): Promise<void> {
  if (!page.isClosed()) return;
  if (notes) {
    notes.push("workday_executor_page_closed");
    notes.push(`workday_failure_stage:${stage}`);
    if (step) notes.push(`workday_failure_step:${step}`);
  }
  const runtimeUrl = page.isClosed() ? "" : page.url();
  throw new Error(`workday_browser_context_closed:stage=${stage}:step=${step || "unknown"}:url=${runtimeUrl}`);
}

async function waitForWorkdayDirectProbe(
  page: AdapterRunContext["page"],
  timeoutMs: number,
  predicate: (probe: WorkdayReadyProbe) => boolean
): Promise<WorkdayReadyProbe | null> {
  const deadline = Date.now() + timeoutMs;
  let lastProbe: WorkdayReadyProbe | null = null;
  while (Date.now() < deadline) {
    await ensureWorkdayPageOpen(page, "auth");
    const probe = await probeWorkdayReadyState(page);
    lastProbe = probe;
    if (predicate(probe)) return probe;
    if (probe.hasApplicationShell || probe.hasLoadingIndicator || probe.state === "application_loading") {
      await page.waitForLoadState("networkidle", { timeout: 1200 }).catch(() => undefined);
    }
    await page.waitForTimeout(350);
  }
  return lastProbe;
}

async function triggerWorkdayEmailAuthFallback(
  page: AdapterRunContext["page"],
  notes?: string[]
): Promise<boolean> {
  await ensureWorkdayPageOpen(page, "auth");
  const clicked = await safeClick(page, "button[data-automation-id='SignInWithEmailButton']") ||
    await safeClick(page, "a[data-automation-id='SignInWithEmailButton']") ||
    await safeClick(page, "button:has-text('Sign in with email')") ||
    await safeClick(page, "a:has-text('Sign in with email')");
  if (!clicked) return false;
  notes?.push("workday_auth_fallback:sign_in_with_email_clicked");
  await pacedWait(page, 500, 1100);
  return true;
}

async function triggerWorkdayCreateAccountFallback(
  page: AdapterRunContext["page"],
  notes?: string[]
): Promise<boolean> {
  await ensureWorkdayPageOpen(page, "auth");
  const clicked = await safeClick(page, "button[data-automation-id='createAccountLink']") ||
    await safeClick(page, "a[data-automation-id='createAccountLink']") ||
    await safeClick(page, "button:has-text('Create Account')") ||
    await safeClick(page, "a:has-text('Create Account')");
  if (!clicked) return false;
  notes?.push("workday_auth_fallback:create_account_clicked");
  await pacedWait(page, 500, 1100);
  return true;
}

async function hasVisibleWorkdayAuthFallbackSurface(page: AdapterRunContext["page"]): Promise<boolean> {
  await ensureWorkdayPageOpen(page, "auth");
  return selectorExists(page, "button[data-automation-id='SignInWithEmailButton']", 200) ||
    selectorExists(page, "a[data-automation-id='SignInWithEmailButton']", 200) ||
    selectorExists(page, "button[data-automation-id='createAccountLink']", 200) ||
    selectorExists(page, "a[data-automation-id='createAccountLink']", 200) ||
    selectorExists(page, "button:has-text('Sign in with email')", 200) ||
    selectorExists(page, "a:has-text('Sign in with email')", 200) ||
    selectorExists(page, "button:has-text('Create Account')", 200) ||
    selectorExists(page, "a:has-text('Create Account')", 200);
}

export function resolveInitialWorkdayAuthStrategy(input: {
  probe: Pick<WorkdayReadyProbe, "state" | "hasVerificationGate"> | null;
  hasVisibleFallbackSurface: boolean;
}): "use_probe" | "fallback_now" | "wait" {
  if (input.probe && (input.probe.state === "application_step" || input.probe.state === "create_account" || input.probe.state === "sign_in" || input.probe.hasVerificationGate)) {
    return "use_probe";
  }
  if (input.hasVisibleFallbackSurface) return "fallback_now";
  return "wait";
}

export async function resolveWorkdayFallbackAfterEmailAuth(input: {
  page: AdapterRunContext["page"];
  account: { email: string; password: string };
  notes?: string[];
  triggerEmailFallback?: (page: AdapterRunContext["page"], notes?: string[]) => Promise<boolean>;
  triggerCreateAccountFallback?: (page: AdapterRunContext["page"], notes?: string[]) => Promise<boolean>;
  waitForProbe?: (page: AdapterRunContext["page"], timeoutMs: number, predicate: (probe: WorkdayReadyProbe) => boolean) => Promise<WorkdayReadyProbe | null>;
}): Promise<{
  probe: WorkdayReadyProbe | null;
  emailFallbackClicked: boolean;
  createAccountClicked: boolean;
}> {
  const waitForProbe = input.waitForProbe || waitForWorkdayDirectProbe;
  const triggerEmailFallback = input.triggerEmailFallback || triggerWorkdayEmailAuthFallback;
  const triggerCreateAccountFallback = input.triggerCreateAccountFallback || triggerWorkdayCreateAccountFallback;
  const waitPredicate = (probe: WorkdayReadyProbe) =>
    probe.state === "application_step" || probe.state === "create_account" || probe.state === "sign_in" || probe.hasVerificationGate;

  const emailFallbackClicked = await triggerEmailFallback(input.page, input.notes);
  if (!emailFallbackClicked) {
    return {
      probe: null,
      emailFallbackClicked: false,
      createAccountClicked: false
    };
  }

  const createAccountClicked = await triggerCreateAccountFallback(input.page, input.notes);
  if (!createAccountClicked) {
    const probe = await waitForProbe(input.page, WORKDAY_AUTH_READY_TIMEOUT_MS, waitPredicate);
    return {
      probe,
      emailFallbackClicked: true,
      createAccountClicked: false
    };
  }

  const probe = await waitForProbe(input.page, WORKDAY_AUTH_READY_TIMEOUT_MS, waitPredicate);
  return {
    probe,
    emailFallbackClicked: true,
    createAccountClicked: true
  };
}

function hasUsableWorkdayAuthOrApplicationProbe(probe: WorkdayReadyProbe | null | undefined): boolean {
  if (!probe) return false;
  if (probe.hasVerificationGate) return true;
  return probe.state === "application_step" || probe.state === "create_account" || probe.state === "sign_in";
}

function isWorkdayProbeStillLoading(probe: Pick<WorkdayReadyProbe, "state" | "hasApplicationShell" | "hasLoadingIndicator"> | null | undefined): boolean {
  if (!probe) return false;
  return probe.state === "application_loading" || probe.hasApplicationShell || probe.hasLoadingIndicator;
}

async function submitSignInDirect(
  page: AdapterRunContext["page"],
  account: { email: string; password: string },
  notes?: string[]
): Promise<{ ok: boolean; reason?: string; step?: WorkdayStep }> {
  await ensureWorkdayPageOpen(page, "auth");
  await safeFill(page, "input[data-automation-id='email']", account.email);
  await pacedWait(page, 250, 600);
  await safeFill(page, "input[data-automation-id='password']", account.password);
  await pacedWait(page, 600, 1200);
  const submitted = await safeClick(page, "div[data-automation-id='click_filter'][aria-label='Sign In']") ||
    await safeClick(page, "[data-automation-id='click_filter'][aria-label='Sign In']") ||
    await safeClick(page, "button[data-automation-id='signInSubmitButton']") ||
    await safeClick(page, "button:has-text('Sign In')") ||
    await page.locator("button[data-automation-id='signInSubmitButton']").first().click({ force: true }).then(() => true).catch(() => false);
  if (!submitted) return { ok: false, reason: "sign_in_failed" };
  notes?.push("workday_sign_in_submitted");
  await pacedWait(page, 300, 700);
  const waitPredicate = (next: WorkdayReadyProbe) =>
    next.state === "application_step" || next.state === "sign_in" || next.state === "create_account" || next.hasVerificationGate || next.hasAuthError;
  let probe = await waitForWorkdayDirectProbe(page, WORKDAY_POST_SIGN_IN_TIMEOUT_MS, waitPredicate);
  if (!probe) return { ok: false, reason: "application_not_ready" };
  if (probe.state === "application_step") {
    notes?.push(`workday_post_sign_in_result:application_step:${probe.step}`);
    return { ok: true, step: probe.step };
  }
  if (probe.hasVerificationGate) {
    notes?.push("workday_auth_verification_gate_detected");
    notes?.push("workday_auth_verification_gate_phase:post_sign_in");
    noteWorkdayVerificationAction(notes, probe);
    return { ok: false, reason: "email_verification_required" };
  }
  if (probe.hasAuthError) {
    notes?.push("workday_auth_error_detected");
  }
  if (probe.state === "sign_in" || probe.state === "create_account") {
    notes?.push(`workday_post_sign_in_auth_visible:${probe.state}`);
    probe = await waitForWorkdayDirectProbe(page, WORKDAY_POST_SIGN_IN_AUTH_RETRY_TIMEOUT_MS, waitPredicate);
    if (!probe) return { ok: false, reason: "sign_in_failed" };
    if (probe.state === "application_step") {
      notes?.push(`workday_post_sign_in_result:application_step:${probe.step}`);
      return { ok: true, step: probe.step };
    }
    if (probe.hasVerificationGate) {
      notes?.push("workday_auth_verification_gate_detected");
      notes?.push("workday_auth_verification_gate_phase:post_sign_in");
      noteWorkdayVerificationAction(notes, probe);
      return { ok: false, reason: "email_verification_required" };
    }
    if (probe.hasAuthError) {
      notes?.push("workday_auth_error_detected");
      return { ok: false, reason: "sign_in_failed" };
    }
    if (probe.state === "sign_in" || probe.state === "create_account") {
      notes?.push(`workday_post_sign_in_result:auth_still_visible:${probe.state}`);
      return { ok: false, reason: "sign_in_failed" };
    }
  }
  if (isWorkdayProbeStillLoading(probe)) {
    notes?.push("workday_post_sign_in_result:loading");
    return { ok: true };
  }
  return { ok: false, reason: "sign_in_failed" };
}

async function createAccountDirect(
  page: AdapterRunContext["page"],
  account: { email: string; password: string },
  notes?: string[]
): Promise<{ ok: boolean; reason?: string; landedOnSignIn?: boolean; step?: WorkdayStep }> {
  await ensureWorkdayPageOpen(page, "auth");
  const hasCreateAccountForm = async (): Promise<boolean> => {
    const hasEmail = await page.locator("input[data-automation-id='email']").first().isVisible().catch(() => false);
    const hasPassword = await page.locator("input[data-automation-id='password']").first().isVisible().catch(() => false);
    const hasVerifyPassword = await page.locator("input[data-automation-id='verifyPassword']").first().isVisible().catch(() => false);
    return hasEmail && hasPassword && hasVerifyPassword;
  };

  if (!await hasCreateAccountForm()) {
    const opened = await safeClick(page, "button[data-automation-id='createAccountLink']") ||
      await safeClick(page, "a[data-automation-id='createAccountLink']") ||
      await safeClick(page, "button:has-text('Create Account')");
    if (!opened) return { ok: false, reason: "account_creation_failed" };
    await pacedWait(page, 500, 1100);
  }

  if (!await hasCreateAccountForm()) return { ok: false, reason: "account_creation_failed" };

  await safeFill(page, "input[data-automation-id='email']", account.email);
  await pacedWait(page, 250, 600);
  await safeFill(page, "input[data-automation-id='password']", account.password);
  await pacedWait(page, 250, 600);
  await safeFill(page, "input[data-automation-id='verifyPassword']", account.password);
  const createAccountCheckbox = "input[data-automation-id='createAccountCheckbox']";
  if (await selectorExists(page, createAccountCheckbox, 800)) {
    await page.click(createAccountCheckbox).catch(() => undefined);
  }
  await pacedWait(page, 500, 1100);
  const submitted = await safeClick(page, "div[data-automation-id='click_filter'][aria-label='Create Account']") ||
    await safeClick(page, "[data-automation-id='click_filter'][aria-label='Create Account']") ||
    await safeClick(page, "button[data-automation-id='createAccountSubmitButton']") ||
    await safeClick(page, "button:has-text('Create Account')") ||
    await page.locator("button[data-automation-id='createAccountSubmitButton']").first().click({ force: true }).then(() => true).catch(() => false);
  if (!submitted) return { ok: false, reason: "account_creation_failed" };
  notes?.push("workday_create_account_submitted");

  const probe = await waitForWorkdayDirectProbe(page, WORKDAY_POST_CREATE_ACCOUNT_TIMEOUT_MS, (next) =>
    next.state === "application_step" || next.state === "sign_in" || next.hasVerificationGate || next.hasAuthError
  );
  if (!probe) return { ok: false, reason: "application_not_ready" };
  if (probe.state === "application_step") {
    notes?.push(`workday_post_create_account_result:${probe.step}`);
    return { ok: true, step: probe.step };
  }
  if (probe.hasVerificationGate) {
    notes?.push("workday_auth_verification_gate_detected");
    notes?.push("workday_auth_verification_gate_phase:post_create_account");
    noteWorkdayVerificationAction(notes, probe);
    return { ok: false, reason: "email_verification_required" };
  }
  if (probe.state === "sign_in") {
    notes?.push("workday_post_create_account_result:sign_in");
    return { ok: true, landedOnSignIn: true };
  }
  if (probe.hasAuthError) {
    notes?.push("workday_auth_error_detected");
  }
  if (isWorkdayProbeStillLoading(probe)) {
    notes?.push("workday_post_create_account_result:loading");
    return { ok: true };
  }
  return { ok: false, reason: "account_creation_failed" };
}

async function ensureWorkdayAuthOrApplicationReadyDirect(
  page: AdapterRunContext["page"],
  account: { email: string; password: string },
  notes?: string[]
): Promise<{ ok: boolean; accountCreated: boolean; usedExistingAccount: boolean; reason?: string; step?: WorkdayStep }> {
  if (!account.email || !account.password) {
    return { ok: false, accountCreated: false, usedExistingAccount: false, reason: "missing_account_credentials" };
  }
  const waitPredicate = (probe: WorkdayReadyProbe) =>
    probe.state === "application_step" || probe.state === "create_account" || probe.state === "sign_in" || probe.hasVerificationGate;
  const immediateProbe = await probeWorkdayReadyState(page).catch(() => null);
  const immediateFallbackSurface = await hasVisibleWorkdayAuthFallbackSurface(page).catch(() => false);
  const initialStrategy = resolveInitialWorkdayAuthStrategy({
    probe: immediateProbe,
    hasVisibleFallbackSurface: immediateFallbackSurface
  });
  let effectiveInitialProbe = immediateProbe;
  if (initialStrategy === "fallback_now") {
    notes?.push("workday_auth_fast_path:fallback_surface_visible");
  } else if (initialStrategy === "wait") {
    effectiveInitialProbe = await waitForWorkdayDirectProbe(page, WORKDAY_AUTH_READY_TIMEOUT_MS, waitPredicate);
  }
  if (!hasUsableWorkdayAuthOrApplicationProbe(effectiveInitialProbe)) {
    const fallbackAfterEmail = await resolveWorkdayFallbackAfterEmailAuth({
      page,
      account,
      notes
    });
    effectiveInitialProbe = fallbackAfterEmail.probe;
  }
  if (!hasUsableWorkdayAuthOrApplicationProbe(effectiveInitialProbe) && await triggerWorkdayCreateAccountFallback(page, notes)) {
    effectiveInitialProbe = await waitForWorkdayDirectProbe(page, WORKDAY_AUTH_READY_TIMEOUT_MS, (probe) =>
      probe.state === "application_step" || probe.state === "create_account" || probe.state === "sign_in" || probe.hasVerificationGate
    );
  }
  if (!effectiveInitialProbe || !hasUsableWorkdayAuthOrApplicationProbe(effectiveInitialProbe)) {
    notes?.push("workday_auth_timeout_reason:unresolved");
    return { ok: false, accountCreated: false, usedExistingAccount: false, reason: "application_not_ready" };
  }
  const readyProbe = effectiveInitialProbe;
  if (readyProbe.state === "application_step") {
    notes?.push(`workday_auth_ready:state=application_step:step=${readyProbe.step}`);
    return { ok: true, accountCreated: false, usedExistingAccount: true, step: readyProbe.step };
  }
  if (readyProbe.hasVerificationGate) {
    notes?.push("workday_auth_verification_gate_detected");
    notes?.push("workday_auth_verification_gate_phase:initial");
    noteWorkdayVerificationAction(notes, readyProbe);
    return { ok: false, accountCreated: false, usedExistingAccount: false, reason: "email_verification_required" };
  }
  if (readyProbe.state === "create_account") {
    const created = await createAccountDirect(page, account, notes);
    if (!created.ok) return { ok: false, accountCreated: false, usedExistingAccount: false, reason: created.reason };
    if (created.landedOnSignIn) {
      const signedIn = await submitSignInDirect(page, account, notes);
      if (!signedIn.ok) return { ok: false, accountCreated: true, usedExistingAccount: false, reason: signedIn.reason };
      return { ok: true, accountCreated: true, usedExistingAccount: false, step: signedIn.step };
    }
    return { ok: true, accountCreated: true, usedExistingAccount: false, step: created.step };
  }
  if (readyProbe.state === "sign_in") {
    const signedIn = await submitSignInDirect(page, account, notes);
    if (!signedIn.ok) return { ok: false, accountCreated: false, usedExistingAccount: true, reason: signedIn.reason };
    return { ok: true, accountCreated: false, usedExistingAccount: true, step: signedIn.step };
  }
  return { ok: false, accountCreated: false, usedExistingAccount: false, reason: "application_not_ready" };
}

async function waitForDirectApplicationStep(
  page: AdapterRunContext["page"],
  expectedStep: WorkdayStep | undefined,
  timeoutMs: number,
  notes?: string[],
  observedStep?: WorkdayStep
): Promise<{ ok: boolean; step: WorkdayStep; reason?: string }> {
  const observedAcceptedStep = resolveAcceptedWorkdayDirectStep({
    expectedStep,
    observedStep
  });
  if (observedAcceptedStep) {
    const observedReady = await isFirstActionableWorkdayStepReady(page, observedAcceptedStep).catch(() => false);
    if (observedReady) {
      notes?.push(`workday_step_fast_path:${expectedStep || "any"}:${observedAcceptedStep}:observed`);
      return { ok: true, step: observedAcceptedStep };
    }
    notes?.push(`workday_step_fast_path:${expectedStep || "any"}:${observedAcceptedStep}:observed_not_ready`);
  }

  const probe = await waitForWorkdayDirectProbe(page, timeoutMs, (next) =>
    next.state === "application_step" &&
    (expectedStep ? next.step === expectedStep || next.step !== "unknown" : true)
  );
  const visibleStep = await detectWorkdayStep(page).catch(() => "unknown" as WorkdayStep);
  const acceptedStep = resolveAcceptedWorkdayDirectStep({
    expectedStep,
    observedStep: visibleStep,
    probe
  });
  if (!probe || !acceptedStep) {
    notes?.push(`workday_step_timeout_reason:${expectedStep || "any"}:${probe?.state || "unknown"}:${probe?.step || "unknown"}`);
    return { ok: false, step: acceptedStep || probe?.step || visibleStep || "unknown", reason: "application_step_timeout" };
  }
  if (!probe.stepReady || acceptedStep !== probe.step) {
    notes?.push(`workday_step_fast_path:${expectedStep || "any"}:${acceptedStep}:${probe.stepReady ? "visible" : "probe_not_ready"}`);
  }
  return { ok: true, step: acceptedStep };
}

export class WorkdayAdapter extends BaseAdapter {
  readonly platform = "workday" as const;

  canHandle(url: string): boolean {
    const normalized = url.toLowerCase();
    return normalized.includes("myworkdayjobs.com") || normalized.includes("workday");
  }

  async apply(context: AdapterRunContext) {
    const { page, target, config, profile, aiEngine, resumeText, logger } = context;
    const result = this.baseResult(context);
    result.startedAt = new Date().toISOString();

    const normalizedProfile = normalizeWorkdayProfile(profile, config.resumePath);
    const questionnaireResolution: import("../core/types.js").QuestionnaireResolutionRecord[] = [];
    const unresolvedQuestionnaire: import("../core/types.js").UnresolvedQuestionnaireRecord[] = [];
    let failureStage = "entry";
    let failureStep = "";

    try {
      failureStage = "entry";
      noteWorkdayPhase(result.notes, logger, "workday_phase", {
        step: "entry",
        phase: "open_job",
        url: target.url,
        message: "opening_job_page"
      });
      await openJob(page, normalizeWorkdayApplyUrl(target.url), config.timeoutMs);
      noteWorkdayPhase(result.notes, logger, "workday_phase", {
        step: "entry",
        phase: "apply_entry",
        message: "starting_apply_flow"
      });
      const entry = await startApplyFlowDeterministic(page, result.notes);
      if (!entry.ok) {
        result.status = "failed";
        result.submitOutcome = "submit_failed";
        result.error = entry.reason || "workday_apply_entry_failed";
        return result;
      }

      failureStage = "auth";
      noteWorkdayPhase(result.notes, logger, "workday_phase", {
        step: "auth",
        phase: "auth_ready",
        message: "waiting_for_auth_or_application_step"
      });
      const auth = await ensureWorkdayAuthOrApplicationReadyDirect(page, normalizedProfile.account, result.notes);
      result.notes.push(`workday_auth:account_created=${auth.accountCreated}:used_existing=${auth.usedExistingAccount}`);
      if (!auth.ok) {
        result.status = "failed";
        result.submitOutcome = auth.reason === "account_creation_failed"
          ? "account_creation_failed"
          : auth.reason === "email_verification_required"
            ? "email_verification_required"
            : "sign_in_failed";
        result.error = auth.reason === "email_verification_required"
          ? "workday_email_verification_required"
          : auth.reason || "sign_in_failed";
        return result;
      }

      if (auth.step) {
        result.notes.push(`workday_first_actionable_step_ready:${auth.step}`);
        noteWorkdayPhase(result.notes, logger, "workday_phase", {
          step: auth.step,
          phase: "first_step_ready",
          message: "auth_reported_first_step_ready"
        });
      } else {
        noteWorkdayPhase(result.notes, logger, "workday_phase", {
          step: "entry",
          phase: "first_step_wait",
          message: "waiting_for_first_actionable_step"
        });
        const firstStep = await waitForDirectApplicationStep(page, undefined, WORKDAY_FIRST_ACTIONABLE_STEP_TIMEOUT_MS, result.notes, auth.step);
        if (!firstStep.ok) {
          result.status = "failed";
          result.submitOutcome = "sign_in_failed";
          result.error = firstStep.reason || "application_step_timeout";
          return result;
        }
      }

      const knownFlow: WorkdayStep[] = [
        "contact_information",
        "my_experience",
        "application_questions",
        "voluntary_disclosures",
        "self_identification",
        "review"
      ];
      const sameStepContinuationCounts = new Map<WorkdayStep, number>();
      for (let stepIndex = 0; stepIndex < knownFlow.length;) {
        const plannedStep = knownFlow[stepIndex]!;
        if (plannedStep === "review") break;
        if (await isReviewOrSubmitPage(page)) break;
        const detectedStep: WorkdayStep = await detectWorkdayStep(page);
        if (detectedStep === "take_assessment") {
          result.notes.push("workday_known_flow_step_start:take_assessment");
          markWorkdayTakeAssessmentRequired(result);
          break;
        }
        if (detectedStep === "unknown") break;
        if (detectedStep !== plannedStep) {
          stepIndex += 1;
          continue;
        }
        failureStage = "step";
        failureStep = detectedStep;
        noteWorkdayPhase(result.notes, logger, "workday_phase", {
          step: detectedStep,
          phase: "step_wait",
          message: "waiting_for_actionable_step"
        });
        const actionableStep = await waitForDirectApplicationStep(page, detectedStep, WORKDAY_STEP_ACTIONABLE_TIMEOUT_MS, result.notes, detectedStep);
        if (!actionableStep.ok) {
          result.status = "failed";
          result.submitOutcome = "page_validation_error";
          result.error = actionableStep.reason || "workday_step_not_actionable";
          break;
        }
        const currentStep = actionableStep.step;
        if (currentStep !== plannedStep) {
          stepIndex += 1;
          continue;
        }
        result.notes.push(`workday_known_flow_step_start:${plannedStep}`);
        result.notes.push(`workday_step:${currentStep}`);
        noteWorkdayPhase(result.notes, logger, "workday_phase", {
          step: currentStep,
          phase: "step_start",
          message: "step_processing_started"
        });
        if (currentStep === "my_experience") {
          noteWorkdayPhase(result.notes, logger, "workday_phase", {
            step: currentStep,
            phase: "prepare",
            message: "preparing_repeatable_sections"
          });
          await prepareMyExperienceStep(page, normalizedProfile, result.filledFields, result.notes);
        }
        const activeContainerSelector = await resolveActiveWorkdayContainerSelector(page, currentStep);
        result.notes.push(`workday_active_container_selector:${activeContainerSelector}`);
        noteWorkdayPhase(result.notes, logger, "workday_phase", {
          step: currentStep,
          phase: "extract",
          activeContainerSelector,
          message: "extracting_widgets_and_schema"
        });
        if (currentStep === "application_questions" || currentStep === "voluntary_disclosures" || currentStep === "self_identification") {
          result.notes.push("workday_global_language_selector_ignored=true");
        }
        if (currentStep === "self_identification") result.notes.push("workday_self_identification_detected");

        const widgets = await extractWorkdayStepWidgets(page, currentStep);
        let actionableWidgets = actionableWorkdayWidgets(widgets, currentStep);
        actionableWidgets = await hydrateRequiredApplicationQuestionSelectWidgets({
          page,
          widgets: actionableWidgets,
          notes: result.notes,
          logger,
          step: currentStep
        });
        const visibleRequiredControls = await countVisibleRequiredControls(page, activeContainerSelector);
        logger.info("workday_step_schema_extracted", {
          step: currentStep,
          activeContainerSelector,
          schemaCount: actionableWidgets.length,
          widgetCount: widgets.length,
          visibleRequiredControls
        });
        logExtractedWorkdayWidgets(logger, currentStep, widgets);
        result.notes.push(`workday_extracted_fields_count_from_active_container=${actionableWidgets.length}`);
        result.notes.push(`workday_extracted_widgets_count_from_active_container=${widgets.length}`);
        result.notes.push(`workday_actionable_widgets_count_from_active_container=${actionableWidgets.length}`);
        result.notes.push(`workday_visible_required_controls_count:${visibleRequiredControls}`);
        if (currentStep === "application_questions") {
          result.notes.push(`workday_application_questions_total:${actionableWidgets.length}`);
          if (actionableWidgets.length === 0) {
            const extractionDiagnostics = await collectWorkdayApplicationQuestionsExtractionDiagnostics(page);
            result.notes.push(`workday_application_questions_active_container_selector_used:${extractionDiagnostics.activeContainerSelectorUsed}`);
            result.notes.push(`workday_application_questions_active_container_text_snippet:${normalizeWorkdayText(extractionDiagnostics.activeContainerTextSnippet)}`);
            result.notes.push(`workday_application_questions_aria_haspopup_button_count:${extractionDiagnostics.ariaHaspopupButtonCount}`);
            result.notes.push(`workday_application_questions_select_one_button_count:${extractionDiagnostics.selectOneButtonCount}`);
            result.notes.push(`workday_application_questions_visible_listbox_button_count:${extractionDiagnostics.visibleListboxButtonCount}`);
            result.notes.push(`workday_application_questions_required_aria_label_count:${extractionDiagnostics.requiredAriaLabelCount}`);
            result.notes.push(`workday_application_questions_form_field_node_count:${extractionDiagnostics.formFieldNodeCount}`);
            for (const button of extractionDiagnostics.topVisibleButtons) {
              result.notes.push(`workday_application_questions_visible_button:${normalizeWorkdayText(button.text)}:aria=${normalizeWorkdayText(button.ariaLabel)}:aid=${normalizeWorkdayText(button.dataAutomationId)}`);
            }
          }
          for (const widget of actionableWidgets) {
            result.notes.push(`workday_question_extracted:${normalizeWorkdayText(widget.label)}:${widget.widgetType}`);
            if (widget.options.length) {
              result.notes.push(`workday_question_possible_answers:${normalizeWorkdayText(widget.label)}:${widget.options.map((option) => normalizeWorkdayText(option)).join(" | ")}`);
            }
          }
        }
        if (actionableWidgets.length === 0 && visibleRequiredControls > 0) {
          const screenshotPath = path.join(config.screenshotsDir, `workday-extraction-${currentStep}-${Date.now()}.png`);
          await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
          result.screenshotPaths.push(screenshotPath);
          result.notes.push(`workday_failure_stage:extraction`);
          result.notes.push(`workday_extraction_failed_step:${currentStep}`);
          result.notes.push(`workday_extraction_failed_active_container:${activeContainerSelector}`);
          result.notes.push(`workday_extraction_failed_screenshot:${screenshotPath}`);
          result.status = "failed";
          result.submitOutcome = "page_validation_error";
          result.error = "workday_stage_extraction_failed";
          break;
        }
        const deterministicWidgetPlan = validateWorkdayWidgetPlan(
          logger,
          result.notes,
          currentStep,
          actionableWidgets,
          resolveWorkdayWidgetDeterministic(actionableWidgets, normalizedProfile, currentStep, {
            contextWidgets: actionableWidgets,
            jobContext: {
              url: target.url,
              jobTitle: target.jobTitle,
              company: target.company
            }
          }).values()
        );
        logResolvedWorkdayWidgetPlan(logger, currentStep, actionableWidgets, Array.from(deterministicWidgetPlan.values()), "deterministic");
        noteWorkdayPhase(result.notes, logger, "workday_phase", {
          step: currentStep,
          phase: "resolve_deterministic",
          widgetCount: actionableWidgets.length,
          resolvedCount: deterministicWidgetPlan.size,
          message: "deterministic_resolution_complete"
        });
        noteResolvedWorkdayQuestionAnswers(result.notes, "workday_question_deterministic_resolved", deterministicWidgetPlan, actionableWidgets);
        const unresolvedAfterDeterministic = unresolvedWidgets(actionableWidgets, deterministicWidgetPlan);
        const preexistingWidgetPlan = validateWorkdayWidgetPlan(
          logger,
          result.notes,
          currentStep,
          actionableWidgets,
          collectPreexistingWorkdayWidgetAnswers(unresolvedAfterDeterministic, {
            requiredOnly: currentStep !== "my_experience"
          }).values()
        );
        logResolvedWorkdayWidgetPlan(logger, currentStep, actionableWidgets, Array.from(preexistingWidgetPlan.values()), "preexisting");
        noteWorkdayPhase(result.notes, logger, "workday_phase", {
          step: currentStep,
          phase: "resolve_preexisting",
          resolvedCount: preexistingWidgetPlan.size,
          unresolvedAfterDeterministic: unresolvedAfterDeterministic.length,
          message: "preexisting_resolution_complete"
        });
        const lockedBeforeAlias = new Map(deterministicWidgetPlan);
        for (const [widgetId, answer] of preexistingWidgetPlan.entries()) {
          if (!lockedBeforeAlias.has(widgetId)) lockedBeforeAlias.set(widgetId, answer);
        }
        logUnresolvedWorkdayWidgets(logger, currentStep, unresolvedWidgets(actionableWidgets, lockedBeforeAlias));
        const aliasWidgetPlan = validateWorkdayWidgetPlan(
          logger,
          result.notes,
          currentStep,
          actionableWidgets,
          resolveWorkdayWidgetAlias(unresolvedWidgets(actionableWidgets, lockedBeforeAlias), normalizedProfile, currentStep, profile, {
            contextWidgets: actionableWidgets,
            jobContext: {
              url: target.url,
              jobTitle: target.jobTitle,
              company: target.company
            }
          }).values()
        );
        logResolvedWorkdayWidgetPlan(logger, currentStep, actionableWidgets, Array.from(aliasWidgetPlan.values()), "alias");
        noteWorkdayPhase(result.notes, logger, "workday_phase", {
          step: currentStep,
          phase: "resolve_alias",
          resolvedCount: aliasWidgetPlan.size,
          unresolvedAfterDeterministic: unresolvedWidgets(actionableWidgets, lockedBeforeAlias).length,
          message: "alias_resolution_complete"
        });
        noteResolvedWorkdayQuestionAnswers(result.notes, "workday_question_alias_resolved", aliasWidgetPlan, actionableWidgets);
        const lockedWidgetPlan = new Map(lockedBeforeAlias);
        for (const [widgetId, answer] of aliasWidgetPlan.entries()) {
          if (!lockedWidgetPlan.has(widgetId)) lockedWidgetPlan.set(widgetId, answer);
        }
        const unresolvedWidgetSet = unresolvedWidgets(actionableWidgets, lockedWidgetPlan);
        logUnresolvedWorkdayWidgets(logger, currentStep, unresolvedWidgetSet);
        const llmUnresolved = currentStep === "contact_information" || currentStep === "my_experience"
          ? unresolvedWidgetSet.filter((widget) => widget.required)
          : unresolvedWidgetSet;
        const llmWidgetPlan = validateWorkdayWidgetPlan(
          logger,
          result.notes,
          currentStep,
          actionableWidgets,
          await planWorkdayUnresolvedWidgets({
          unresolved: llmUnresolved,
          contextWidgets: actionableWidgets,
          aiEngine,
          profile,
          resumeText,
          notes: result.notes,
          jobContext: {
            url: target.url,
            jobTitle: target.jobTitle,
            company: target.company
          }
          })
        );
        logResolvedWorkdayWidgetPlan(logger, currentStep, actionableWidgets, Array.from(llmWidgetPlan.values()), "llm");
        noteWorkdayPhase(result.notes, logger, "workday_phase", {
          step: currentStep,
          phase: "resolve_llm",
          requestedCount: llmUnresolved.length,
          answeredCount: llmWidgetPlan.size,
          message: "llm_resolution_complete"
        });

        if (currentStep === "application_questions") {
          result.notes.push(`workday_application_questions_resolved_count:${lockedWidgetPlan.size + llmWidgetPlan.size}`);
          result.notes.push(`workday_application_questions_unresolved_count:${Math.max(0, actionableWidgets.length - (lockedWidgetPlan.size + llmWidgetPlan.size))}`);
        }

        let widgetPlan = mergeLockedWidgetAnswers(lockedWidgetPlan, Array.from(llmWidgetPlan.values()));
        logResolvedWorkdayWidgetPlan(logger, currentStep, actionableWidgets, widgetPlan, "merged");
        logUnresolvedWorkdayWidgets(logger, currentStep, unresolvedWidgets(actionableWidgets, new Map(widgetPlan.map((answer) => [answer.widgetId, answer]))));
        noteWorkdayPhase(result.notes, logger, "workday_phase", {
          step: currentStep,
          phase: "execute",
          widgetPlanCount: widgetPlan.length,
          message: "executing_widget_plan"
        });
        result.answers.push(...widgetPlan
          .map(serializeWorkdayWidgetAnswer)
          .filter((p) => !result.answers.some((existing) => existing.questionId === p.questionId)));

        failureStage = "executor";
        failureStep = currentStep;
        let executionResults = await executeWorkdayWidgetPlan({
          page,
          plan: widgetPlan,
          widgets: actionableWidgets,
          profile: normalizedProfile,
          currentStep,
          filledFields: result.filledFields,
          notes: result.notes,
          recoveryMode: false,
          logger
        });

        for (let revealPass = 0; revealPass < 2; revealPass += 1) {
          let refreshedWidgets = actionableWorkdayWidgets(await extractWorkdayStepWidgets(page, currentStep), currentStep);
          refreshedWidgets = await hydrateRequiredApplicationQuestionSelectWidgets({
            page,
            widgets: refreshedWidgets,
            notes: result.notes,
            logger,
            step: currentStep
          });
          const knownWidgetIds = new Set(actionableWidgets.map((widget) => widget.widgetId));
          const revealedRequiredWidgets = refreshedWidgets.filter((widget) => widget.required && !knownWidgetIds.has(widget.widgetId));
          if (!revealedRequiredWidgets.length) {
            actionableWidgets = refreshedWidgets;
            break;
          }

          result.notes.push(`workday_revealed_required_widgets_count:${revealedRequiredWidgets.length}`);
          result.notes.push(`workday_revealed_required_widgets:${revealedRequiredWidgets.map((widget) => normalizeWorkdayText(widget.label)).join(" | ")}`);
          noteWorkdayPhase(result.notes, logger, "workday_phase", {
            step: currentStep,
            phase: "reveal",
            revealedCount: revealedRequiredWidgets.length,
            message: "new_required_widgets_detected_after_execution"
          });
          logExtractedWorkdayWidgets(logger, currentStep, revealedRequiredWidgets);

          const revealedDeterministicPlan = validateWorkdayWidgetPlan(
            logger,
            result.notes,
            currentStep,
            refreshedWidgets,
            resolveWorkdayWidgetDeterministic(revealedRequiredWidgets, normalizedProfile, currentStep, {
              contextWidgets: refreshedWidgets,
              jobContext: {
                url: target.url,
                jobTitle: target.jobTitle,
                company: target.company
              }
            }).values()
          );
          const unresolvedRevealedAfterDeterministic = unresolvedWidgets(revealedRequiredWidgets, revealedDeterministicPlan);
          const revealedPreexistingPlan = validateWorkdayWidgetPlan(
            logger,
            result.notes,
            currentStep,
            refreshedWidgets,
            collectPreexistingWorkdayWidgetAnswers(unresolvedRevealedAfterDeterministic, {
              requiredOnly: currentStep !== "my_experience"
            }).values()
          );
          const revealedLockedBeforeAlias = new Map(revealedDeterministicPlan);
          for (const [widgetId, answer] of revealedPreexistingPlan.entries()) {
            if (!revealedLockedBeforeAlias.has(widgetId)) revealedLockedBeforeAlias.set(widgetId, answer);
          }
          const revealedAliasPlan = validateWorkdayWidgetPlan(
            logger,
            result.notes,
            currentStep,
            refreshedWidgets,
            resolveWorkdayWidgetAlias(unresolvedWidgets(revealedRequiredWidgets, revealedLockedBeforeAlias), normalizedProfile, currentStep, profile, {
              contextWidgets: refreshedWidgets,
              jobContext: {
                url: target.url,
                jobTitle: target.jobTitle,
                company: target.company
              }
            }).values()
          );
          const revealedLockedPlan = new Map(revealedLockedBeforeAlias);
          for (const [widgetId, answer] of revealedAliasPlan.entries()) {
            if (!revealedLockedPlan.has(widgetId)) revealedLockedPlan.set(widgetId, answer);
          }
          const unresolvedRevealed = unresolvedWidgets(revealedRequiredWidgets, revealedLockedPlan);
          const revealedLlmPlan = validateWorkdayWidgetPlan(
            logger,
            result.notes,
            currentStep,
            refreshedWidgets,
            await planWorkdayUnresolvedWidgets({
              unresolved: currentStep === "contact_information" || currentStep === "my_experience"
                ? unresolvedRevealed.filter((widget) => widget.required)
                : unresolvedRevealed,
              contextWidgets: refreshedWidgets,
              aiEngine,
              profile,
              resumeText,
              notes: result.notes,
              jobContext: {
                url: target.url,
                jobTitle: target.jobTitle,
                company: target.company
              }
            })
          );
          const revealedWidgetPlan = mergeLockedWidgetAnswers(revealedLockedPlan, Array.from(revealedLlmPlan.values()));
          logResolvedWorkdayWidgetPlan(logger, currentStep, refreshedWidgets, revealedWidgetPlan, "merged");
          const revealedExecutionResults = await executeWorkdayWidgetPlan({
            page,
            plan: revealedWidgetPlan,
            widgets: refreshedWidgets,
            profile: normalizedProfile,
            currentStep,
            filledFields: result.filledFields,
            notes: result.notes,
            recoveryMode: false,
            logger
          });

          const mergedPlanById = new Map(widgetPlan.map((answer) => [answer.widgetId, answer]));
          for (const answer of revealedWidgetPlan) mergedPlanById.set(answer.widgetId, answer);
          widgetPlan = Array.from(mergedPlanById.values());

          const mergedExecutionById = new Map(executionResults.map((row) => [row.widgetId, row]));
          for (const row of revealedExecutionResults) mergedExecutionById.set(row.widgetId, row);
          executionResults = Array.from(mergedExecutionById.values());
          actionableWidgets = refreshedWidgets;
        }

        noteWorkdayPhase(result.notes, logger, "workday_phase", {
          step: currentStep,
          phase: "verify",
          executedCount: executionResults.filter((row) => row.executed).length,
          verifiedCount: executionResults.filter((row) => row.verified).length,
          failedCount: executionResults.filter((row) => row.failureReason).length,
          message: "evaluating_step_readiness"
        });
        const readiness = await evaluateUniversalWorkdayStepReadiness({
          page,
          widgets: actionableWidgets,
          widgetPlan,
          executionResults,
          notes: result.notes
        });
        if (!readiness.ok) {
          result.status = "failed";
          result.submitOutcome = "page_validation_error";
          result.error = `workday_stage_${readiness.stage || "verification"}_failed`;
          result.notes.push(`workday_failure_stage:${readiness.stage || "verification"}`);
          if (readiness.payload.length) {
            result.notes.push(`workday_required_widget_payload:${JSON.stringify(readiness.payload)}`);
          }
          break;
        }

        const footer = await classifyFooterButton(page);
        if (footer.text) result.notes.push(`workday_footer_button_text:${footer.text}`);
        result.notes.push(`workday_footer_button_kind:${footer.kind}`);
        noteWorkdayPhase(result.notes, logger, "workday_phase", {
          step: currentStep,
          phase: "next",
          footerKind: footer.kind,
          footerText: footer.text,
          message: "clicking_save_and_continue"
        });

        failureStage = "transition";
        failureStep = currentStep;
        const recovery = await clickNextAndRecoverValidation({
          page,
          currentStep,
          widgets: actionableWidgets,
          profile: normalizedProfile,
          profileRaw: profile,
          aiEngine,
          resumeText,
          jobContext: {
            url: target.url,
            jobTitle: target.jobTitle,
            company: target.company
          },
          filledFields: result.filledFields,
          verifiedWidgetIds: executionResults.filter((row) => row.verified).map((row) => row.widgetId),
          notes: result.notes,
          logger,
          questionnaireResolution,
          unresolvedQuestionnaire
        });
        result.notes.push("workday_continue_clicked");

        result.notes.push(`workday_recovery:step=${currentStep}:attempts=${recovery.recoveryAttempts}:advanced=${recovery.advanced}`);
        if (recovery.transitionFailureClass) {
          result.notes.push(`workday_transition_failure_class:${recovery.transitionFailureClass}`);
        }
        if (recovery.validationErrors.length) {
          result.notes.push(`workday_validation_errors:${recovery.validationErrors.slice(0, 5).join(" | ")}`);
        }
        if (recovery.unresolvedQuestionnaire?.length) {
          unresolvedQuestionnaire.push(...recovery.unresolvedQuestionnaire);
          result.notes.push(`workday_unresolved_questionnaire:${recovery.unresolvedQuestionnaire.length}`);
        }

        if (!recovery.advanced) {
          const markerWait = await waitForExpectedTransitionMarker(page, currentStep, 6000);
          if (!markerWait) {
            result.status = "failed";
            result.submitOutcome = "page_validation_error";
            result.notes.push(`workday_failure_stage:${recovery.validationErrors.length ? "validation_recovery" : "transition"}`);
            result.error = recovery.unchangedSignature
              ? "workday_validation_unchanged_across_retries"
              : "workday_page_validation_error";
            break;
          }
        }
        if (currentStep === "self_identification" && recovery.advanced) {
          result.notes.push("workday_self_identification_filled");
          result.notes.push("workday_self_identification_next_clicked");
          if (recovery.currentStep === "review" || recovery.currentStep === "submit") {
            await captureWorkdayReviewReceiptIfPresent({
              page,
              result,
              waitForMarkersMs: 1500
            });
          }
        }
        result.notes.push(`workday_known_flow_step_done:${plannedStep}`);
        noteWorkdayPhase(result.notes, logger, "workday_phase", {
          step: plannedStep,
          phase: "step_done",
          message: "step_completed"
        });
        if (recovery.currentStep === "take_assessment") {
          result.notes.push("workday_known_flow_step_start:take_assessment");
          markWorkdayTakeAssessmentRequired(result);
          break;
        }
        if (recovery.advanced && recovery.currentStep === currentStep) {
          const sameStepCount = (sameStepContinuationCounts.get(currentStep) || 0) + 1;
          sameStepContinuationCounts.set(currentStep, sameStepCount);
          result.notes.push(`workday_same_step_continuation:${currentStep}:${sameStepCount}`);
          if (sameStepCount >= 5) {
            result.status = "failed";
            result.submitOutcome = "page_validation_error";
            result.error = "workday_same_step_continuation_limit";
            result.notes.push("workday_failure_stage:same_step_continuation_limit");
            break;
          }
          continue;
        }
        sameStepContinuationCounts.delete(currentStep);
        stepIndex += 1;
      }

      if (result.status !== "failed") {
        result.status = "filled";
        result.submitOutcome = "not_submitted";
      }

      if (result.status !== "failed") {
        await captureWorkdayReviewReceiptIfPresent({
          page,
          result,
          waitForMarkersMs: WORKDAY_REVIEW_RECEIPT_WAIT_MS
        });
      }

      if (config.mode === "auto-submit" && result.status !== "failed") {
        const footer = await classifyFooterButton(page);
        if (footer.text) result.notes.push(`workday_footer_button_text:${footer.text}`);
        result.notes.push(`workday_footer_button_kind:${footer.kind}`);

        if (footer.kind !== "submit") {
          result.status = "failed";
          result.submitOutcome = "submit_failed";
          result.error = "workday_submit_button_not_ready";
        } else {
          const submitClicked = await clickSubmit(page);
          if (!submitClicked) {
            result.status = "failed";
            result.submitOutcome = "submit_failed";
            result.error = "workday_submit_button_not_found";
          } else {
            result.notes.push("workday_submit_clicked");
            result.submitted = true;
            await page.waitForTimeout(1200);
            await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
            await page.waitForTimeout(800);

            const postStep = await detectWorkdayStep(page);
            const postValidationErrors = await collectPostSubmitValidationErrors(page);
            const confirmation = await detectPostSubmitConfirmation(page);
            result.notes.push(`workday_post_submit_step:${postStep}`);
            result.notes.push(`workday_post_submit_url:${page.url()}`);
            if (postValidationErrors.length) {
              result.notes.push(`workday_post_submit_validation_errors:${postValidationErrors.slice(0, 5).join(" | ")}`);
            }
            if (confirmation.evidence) {
              result.notes.push(`workday_post_submit_confirmation:${confirmation.evidence}`);
            }

            if (postValidationErrors.length && !confirmation.confirmed) {
              result.status = "failed";
              result.submitOutcome = "submit_validation_error";
              result.error = "workday_submit_validation_error";
            } else if (confirmation.confirmed) {
              result.status = "applied";
              result.submissionConfirmed = true;
              result.submitOutcome = "confirmed";
            } else if (confirmation.pending || (postStep !== "review" && postStep !== "submit")) {
              result.status = "applied";
              result.submitOutcome = "pending_confirmation";
            } else {
              result.status = "failed";
              result.submitOutcome = "submit_failed";
              result.error = "workday_submit_confirmation_not_detected";
            }
          }
        }
      }

      const screenshotPath = path.join(config.screenshotsDir, `workday-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      result.screenshotPaths.push(screenshotPath);
      if (questionnaireResolution.length) result.questionnaireResolution = questionnaireResolution;
      if (unresolvedQuestionnaire.length) result.unresolvedQuestionnaire = unresolvedQuestionnaire;
    } catch (error) {
      result.status = "failed";
      if (isWorkdayExecutorRuntimeError(error)) {
        result.submitOutcome = "browser_context_closed";
        result.error = "workday_browser_context_closed";
        result.failureStage = error.stage;
        result.failureStep = error.step;
        result.failureLabel = error.label;
        result.failureLastAction = error.lastAction;
        result.notes.push("workday_executor_page_closed");
        result.notes.push(`workday_failure_stage:${error.stage}`);
        result.notes.push(`workday_failure_step:${error.step}`);
        if (error.label) result.notes.push(`workday_executor_last_widget_label:${error.label}`);
        if (error.lastAction) result.notes.push(`workday_executor_last_action:${error.lastAction}`);
        if (error.selector) result.notes.push(`workday_executor_last_selector:${error.selector}`);
        if (error.url) result.notes.push(`workday_runtime_url_before_failure:${error.url}`);
      } else if (isWorkdayPageClosedLikeError(error) || page.isClosed()) {
        result.submitOutcome = "browser_context_closed";
        result.error = "workday_browser_context_closed";
        result.failureStage = failureStage;
        result.failureStep = failureStep || undefined;
        result.notes.push("workday_executor_page_closed");
        result.notes.push(`workday_failure_stage:${failureStage}`);
        if (failureStep) result.notes.push(`workday_failure_step:${failureStep}`);
        if (!page.isClosed()) {
          result.notes.push(`workday_runtime_url_before_failure:${page.url()}`);
        }
      } else {
        result.submitOutcome = "submit_failed";
        result.error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
      }
    }

    if (result.status === "applied") result.notes.push("workday_exit_reason:submitted_or_confirmed");
    else if (result.status === "failed") result.notes.push("workday_exit_reason:terminal_failure");
    else result.notes.push("workday_exit_reason:filled_not_submitted");
    if (result.status !== "failed") {
      result.workdayRunSummary = buildWorkdayRunSummary(result);
    }
    result.finishedAt = new Date().toISOString();
    return result;
  }
}
