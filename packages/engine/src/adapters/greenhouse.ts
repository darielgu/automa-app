import path from "node:path";
import { existsSync } from "node:fs";
import { BaseAdapter } from "./base.js";
import { hasGreenhouseUrlSignals } from "../core/platform-detector.js";
import type {
  AdapterRunContext,
  AnswerValue,
  ApplicationQuestion,
  FilledFieldRecord,
  JobRunResult,
  LlmEventRecord,
  QuestionType,
  ResolvedAnswer
} from "../core/types.js";

interface GreenhouseQuestion extends ApplicationQuestion {
  key: string;
  inputKind: FieldControlType;
  name?: string;
  domId?: string;
  selector?: string;
  selectorCandidates?: string[];
}

type FieldControlType =
  | "text"
  | "textarea"
  | "date"
  | "select"
  | "combobox"
  | "radio-group"
  | "checkbox-group";

interface FieldDescriptor {
  key: string;
  id?: string;
  name?: string;
  label: string;
  required: boolean;
  invalid: boolean;
  controlType: FieldControlType;
  options: string[];
  optionHints: string[];
  optionMeta?: Array<{
    id?: string;
    name?: string;
    value?: string;
    label: string;
    selector: string;
    checked: boolean;
  }>;
  optionSource?: "inline" | "live_probe" | "both";
  listboxId?: string;
  menuSelector?: string;
  currentValue?: string;
  validationErrorText?: string;
  fieldContext?: string;
  selector: string;
  selectorCandidates: string[];
}

interface LiveSelectOption {
  text: string;
  id?: string;
  disabled: boolean;
  selector?: string;
}

interface LiveSelectProbeResult {
  fieldId: string;
  label: string;
  controlType: FieldControlType;
  required: boolean;
  options: LiveSelectOption[];
  optionSource: "inline" | "live_probe" | "both";
  listboxId?: string;
  menuSelector?: string;
  currentValue?: string;
  validationErrorText?: string;
  ariaInvalid?: boolean;
  hiddenValues?: string[];
  ariaControls?: string;
  bindingStatus?: "bound" | "mismatch" | "fallback" | "none";
}

interface RequiredValidationState {
  currentValue: string;
  errorText: string;
  ariaInvalid: boolean;
  hiddenValues: string[];
}

type TextFieldSemantic =
  | "compensation"
  | "availability"
  | "relocation"
  | "motivation"
  | "notice_period"
  | "generic_text";

type DemographicFieldKind = "pronoun" | "sexual_orientation" | "gender_identity" | "race_ethnicity";
type ComboboxSemantic =
  | "phone_country_code"
  | "city_location"
  | "school"
  | "degree"
  | "discipline"
  | "demographic"
  | "generic_select";

type FreeTextGenerationSource = "llm" | "retry" | "fallback";

interface TextInputConstraintSnapshot {
  inputType: string;
  pattern: string;
  inputmode: string;
  placeholder: string;
  min: string;
  max: string;
  step: string;
  maxlength?: number;
  currentValue: string;
  validityValid: boolean;
  validationMessage: string;
  numericOnly: boolean;
}

type GreenhouseFieldType =
  | "text"
  | "textarea"
  | "file"
  | "react_select"
  | "phone"
  | "phone_country"
  | "radio"
  | "checkbox_group"
  | "date"
  | "unknown";

interface GreenhouseContainerMeta {
  containerSelector?: string;
  containerIdentity?: string;
  controlId?: string;
  controlName?: string;
  labelFor?: string;
  ariaLabelledBy?: string;
}

interface GreenhouseFieldSchema {
  fieldId: string;
  label: string;
  required: boolean;
  fieldType: GreenhouseFieldType;
  possibleAnswers: string[];
  optionMeta?: Array<{
    id?: string;
    name?: string;
    value?: string;
    label: string;
    selector: string;
    checked: boolean;
  }>;
  currentValue?: string;
  htmlSummary?: string;
  containerMeta: GreenhouseContainerMeta;
}

type SubmitFailureReasonTag =
  | "validation_missing_fields"
  | "validation_stable_errors"
  | "challenge_blocked"
  | "confirmation_not_detected"
  | "submit_unavailable";

interface MissingFieldDetail {
  id: string;
  label: string;
  role: string;
  tag: string;
}

interface CoreFieldCheckResult {
  reapplied: boolean;
  missing: string[];
  missingDetails: string[];
  resumeVerified: boolean;
  resumeVerification?: ResumeVerificationResult;
  identityAudit: string[];
  identityCandidateAudit?: string[];
  preSubmitBlocker?: string;
}

interface SubmitAttemptDiagnostics {
  attempt: number;
  confirmed: boolean;
  reasonTag?: SubmitFailureReasonTag;
  validationErrors: string[];
  missingRequired: string[];
  missingRequiredDetails: string[];
  reapplyOccurred: boolean;
  challengeDetected: boolean;
}

interface SubmitSequenceResult {
  submitted: boolean;
  reasonTag?: SubmitFailureReasonTag;
  firstBlockingReason?: SubmitFailureReasonTag;
  preSubmitBlocker?: string;
  challengeDetected: boolean;
  validationErrors: string[];
  missingRequired: string[];
  missingRequiredDetails: string[];
  reapplyOccurred: boolean;
  resumeVerification?: ResumeVerificationResult;
  identityAuditBeforeSubmit: string[];
  identityAuditAfterSubmit: string[];
  identityCandidateAuditBeforeSubmit?: string[];
  identityCandidateAuditAfterSubmit?: string[];
  attempts: SubmitAttemptDiagnostics[];
}

interface ShortSubmitSweepState {
  confirmed: boolean;
  validationErrors: string[];
  challengeDetected: boolean;
}

interface ResumeVerificationResult {
  ok: boolean;
  confidence?: "confirmed" | "provisional" | "failed";
  verificationMode?: "signal" | "input_only" | "error";
  inputFileOk: boolean;
  visibleCueOk: boolean;
  missingScanOk: boolean;
  manualEntryOk?: boolean;
  uploadSignalOk?: boolean;
  uploadState?: "not_started" | "input_set" | "upload_confirmed" | "upload_failed";
  failureTag?:
    | "resume_upload_signal_missing"
    | "resume_upload_js_error"
    | "resume_upload_network_failed"
    | "resume_rejected_post_submit";
  diagnostics?: string[];
  matchedInputSelector?: string;
  matchedCueText?: string;
  resumeMissingDetail?: string;
}

interface ResumeUploadAttemptDiagnostics {
  phase: "direct" | "attach";
  applied: boolean;
  sawPresign: boolean;
  sawBinaryUpload: boolean;
  sawNetworkFailure: boolean;
  jsErrors: string[];
}

interface ResumeAttachTarget {
  selector: string;
  linkedInputSelector?: string;
}

interface ResumeUploadTargets {
  inputSelectors: string[];
  attachTargets: ResumeAttachTarget[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const RESUME_INPUT_SELECTOR =
  "#resume, input[type='file'][name*='resume' i], input[type='file'][id*='resume' i], input[type='file'][name*='cv' i], input[type='file'][id*='cv' i]";

const US_STATE_ABBR_TO_NAME: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  DC: "District of Columbia"
};

const US_STATE_NAME_TO_ABBR = Object.fromEntries(
  Object.entries(US_STATE_ABBR_TO_NAME).map(([abbr, name]) => [normalizeText(name), abbr])
) as Record<string, string>;

const EU_EFTA_COUNTRIES = new Set([
  "austria",
  "belgium",
  "bulgaria",
  "croatia",
  "cyprus",
  "czech republic",
  "czechia",
  "denmark",
  "estonia",
  "finland",
  "france",
  "germany",
  "greece",
  "hungary",
  "ireland",
  "italy",
  "latvia",
  "lithuania",
  "luxembourg",
  "malta",
  "netherlands",
  "poland",
  "portugal",
  "romania",
  "slovakia",
  "slovenia",
  "spain",
  "sweden",
  "iceland",
  "liechtenstein",
  "norway",
  "switzerland"
]);

const REQUIRED_TEXT_PLACEHOLDER_DENYLIST = new Set([
  "n/a",
  "na",
  "none",
  "unknown",
  "test",
  "123"
]);

export function isPlaceholderOption(option: string): boolean {
  const normalized = normalizeText(option);
  if (!normalized) return true;
  return (
    normalized === "select" ||
    normalized === "select..." ||
    normalized === "--" ||
    normalized === "-" ||
    normalized === "choose" ||
    normalized === "choose..." ||
    normalized.includes("please select")
  );
}

export function pickBestOption(answer: string, options: string[]): string {
  const matched = findBestOptionMatch(answer, options);
  if (matched) return matched;
  return answer;
}

/**
 * Ways real forms write "I would rather not say".
 *
 * The rules engine answers self-identification questions with "Decline to
 * self-identify" -- deliberately, because Automa must never invent a person's
 * race, gender, veteran or disability status. But almost no site uses that
 * exact wording, and the matcher below is substring-based, so
 * "Decline to self-identify" against an option list offering
 * "I don't wish to answer" found nothing. Measured against live Greenhouse
 * postings, that single mismatch left four required questions unanswered on
 * every form.
 */
const DECLINE_PATTERNS: RegExp[] = [
  /decline/,
  /prefer not/,
  /do ?n[o']?t wish/,
  /not wish to (answer|disclose|identify|self)/,
  /choose not to/,
  /rather not/,
  /not to disclose/,
  /prefer to not/,
  /no response/,
  /wish not to/
];

function isDeclineOption(value: string): boolean {
  const normalized = normalizeText(value);
  return DECLINE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function findBestOptionMatch(answer: string, options: string[]): string | undefined {
  if (!options.length) return answer;
  const validOptions = options.filter((option) => !isPlaceholderOption(option));
  const searchPool = validOptions.length ? validOptions : options;

  const wanted = normalizeText(answer);
  const exact = searchPool.find((option) => normalizeText(option) === wanted);
  if (exact) return exact;

  const contains = searchPool.find((option) => normalizeText(option).includes(wanted));
  if (contains) return contains;

  const reverseContains = searchPool.find((option) => wanted.includes(normalizeText(option)));
  if (reverseContains) return reverseContains;

  // Intent match, not text match: every phrasing of "I would rather not say"
  // means the same thing, and the site chooses the words.
  if (isDeclineOption(answer)) {
    const declineOption = searchPool.find((option) => isDeclineOption(option));
    if (declineOption) return declineOption;
  }

  const answerNumberMatch = answer.match(/-?\d+(?:\.\d+)?/);
  if (answerNumberMatch) {
    const answerNumber = Number(answerNumberMatch[0]);
    const numericOptions = searchPool
      .map((option) => {
        const matches = option.match(/-?\d+(?:\.\d+)?/g) ?? [];
        const numbers = matches.map((value) => Number(value)).filter((value) => Number.isFinite(value));
        return { option, numbers };
      })
      .filter((entry) => entry.numbers.length > 0);

    const ranged = numericOptions.find((entry) => {
      if (entry.numbers.length < 2) return false;
      const min = Math.min(entry.numbers[0]!, entry.numbers[1]!);
      const max = Math.max(entry.numbers[0]!, entry.numbers[1]!);
      return answerNumber >= min && answerNumber <= max;
    });
    if (ranged) return ranged.option;

    let nearest: { option: string; distance: number } | undefined;
    for (const entry of numericOptions) {
      const first = entry.numbers[0];
      if (first === undefined) continue;
      const distance = Math.abs(answerNumber - first);
      if (!nearest || distance < nearest.distance) {
        nearest = { option: entry.option, distance };
      }
    }
    if (nearest) return nearest.option;
  }

  if (["yes", "true", "1"].includes(wanted)) {
    const yesish = searchPool.find((option) =>
      /\byes\b|\btrue\b|\bi am authorized\b|\backnowledge\b|\bconfirm\b|\baccept\b/i.test(option)
    );
    if (yesish) return yesish;
  }

  if (["no", "false", "0"].includes(wanted)) {
    const noish = searchPool.find((option) => /\bno\b|\bfalse\b|\bdo not\b|\bnot\b/i.test(option));
    if (noish) return noish;
  }

  return undefined;
}

function mapInputType(
  inputType: FieldControlType,
  options: string[]
): { questionType: QuestionType; kind: GreenhouseQuestion["inputKind"] } {
  if (inputType === "textarea") {
    return { questionType: "textarea", kind: "textarea" };
  }

  if (inputType === "date") {
    return { questionType: "text", kind: "text" };
  }

  if (inputType === "select") {
    return { questionType: "single_select", kind: "select" };
  }

  if (inputType === "radio-group") {
    return { questionType: "single_select", kind: "radio-group" };
  }

  if (inputType === "checkbox-group") {
    if (options.length > 1) {
      return { questionType: "single_select", kind: "checkbox-group" };
    }
    return { questionType: "boolean", kind: "checkbox-group" };
  }

  if (inputType === "combobox") {
    return { questionType: "single_select", kind: "combobox" };
  }

  return { questionType: "text", kind: "text" };
}

export function detectTextFieldSemantic(
  label: string,
  placeholder?: string,
  description?: string
): TextFieldSemantic {
  const haystack = normalizeText(`${label || ""} ${placeholder || ""} ${description || ""}`);
  if (
    /desired annual compensation|desired salary|salary expectation|compensation expectation|expected compensation|annual pay|salary|compensation/.test(haystack)
  ) {
    return "compensation";
  }
  if (/availability|available to start|earliest start|start date/.test(haystack)) {
    return "availability";
  }
  if (/relocat|commute|on[- ]?site|onsite|hybrid|remote/.test(haystack)) {
    return "relocation";
  }
  if (/notice period|two weeks|weeks notice/.test(haystack)) {
    return "notice_period";
  }
  if (/why|motivation|interest|draws you|make an impact|tell us|describe|summary/.test(haystack)) {
    return "motivation";
  }
  return "generic_text";
}

function answerValueToString(value: AnswerValue): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function isTruthyAnswer(value: string): boolean {
  const normalized = normalizeText(value);
  return ["true", "yes", "1", "y"].includes(normalized);
}

function summarizeMissingDetails(details: MissingFieldDetail[]): string[] {
  return details.slice(0, 12).map((item) => `${item.id}:${item.label || "unknown"}:${item.role || item.tag || "input"}`);
}

function normalizeReasonTagToOutcome(reasonTag: SubmitFailureReasonTag): JobRunResult["submitOutcome"] {
  if (reasonTag === "challenge_blocked") return "blocked_bot_challenge";
  if (reasonTag === "submit_unavailable") return "submit_unavailable";
  if (reasonTag === "confirmation_not_detected") return "pending_confirmation";
  return "validation_error";
}

export function isSessionLostError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("target page, context or browser has been closed") ||
    normalized.includes("target closed") ||
    normalized.includes("page has been closed") ||
    normalized.includes("context has been closed") ||
    normalized.includes("browser has been closed") ||
    normalized.includes("session_lost")
  );
}

export function buildGreenhouseQuestionCacheKey(
  question: ApplicationQuestion,
  jobTitle?: string,
  company?: string
): string {
  const options = [...(question.options ?? [])]
    .map((option) => normalizeText(option))
    .sort((a, b) => a.localeCompare(b))
    .join("|");
  const inputKind = typeof question.platformMeta?.inputKind === "string"
    ? String(question.platformMeta.inputKind)
    : "unknown";
  return [
    normalizeText(question.label),
    question.type,
    inputKind,
    normalizeText(jobTitle ?? ""),
    normalizeText(company ?? ""),
    options
  ].join("::");
}

export function evaluateSubmitStopReason(input: {
  attempt: number;
  maxAttempts: number;
  missingSignature?: string;
  previousMissingSignature?: string;
  validationSignature?: string;
  previousValidationSignature?: string;
  challengeDetected: boolean;
}): SubmitFailureReasonTag | undefined {
  const {
    attempt,
    maxAttempts,
    missingSignature,
    previousMissingSignature,
    validationSignature,
    previousValidationSignature,
    challengeDetected
  } = input;

  if (missingSignature && (attempt === maxAttempts || missingSignature === previousMissingSignature)) {
    return "validation_missing_fields";
  }
  if (challengeDetected && (attempt >= 2 || attempt === maxAttempts)) {
    return "challenge_blocked";
  }
  if (validationSignature && (attempt === maxAttempts || validationSignature === previousValidationSignature)) {
    return "validation_stable_errors";
  }
  if (attempt === maxAttempts) {
    return "confirmation_not_detected";
  }
  return undefined;
}

export class GreenhouseAdapter extends BaseAdapter {
  readonly platform = "greenhouse" as const;
  private aiAnswerCache = new Map<string, ResolvedAnswer>();

  canHandle(url: string): boolean {
    return hasGreenhouseUrlSignals(url);
  }

  private pushStageNote(result: JobRunResult, stage: string): void {
    result.notes.push(`greenhouse_stage:${stage}`);
  }

  private ensurePageOpen(page: AdapterRunContext["page"], stage: string): void {
    if (!page.isClosed()) return;
    throw new Error(`session_lost:${stage}:page_closed`);
  }

  private logGreenhouseEvent(context: AdapterRunContext, event: string, data: Record<string, unknown>): void {
    context.logger.info(event, data);
  }

  private recordLlmEvent(
    result: JobRunResult,
    event: LlmEventRecord["event"],
    payload: Omit<LlmEventRecord, "ts" | "event">
  ): void {
    if (!Array.isArray(result.llmEvents)) result.llmEvents = [];
    result.llmEvents.push({
      ts: new Date().toISOString(),
      event,
      ...payload
    });
  }

  private hasRequiredValidationErrorText(errorText: string | undefined): boolean {
    const normalized = normalizeText(errorText || "");
    if (!normalized) return false;
    return normalized.includes("this field is required");
  }

  private isOptionBackedField(kind: FieldControlType): boolean {
    return kind === "select" || kind === "combobox" || kind === "radio-group" || kind === "checkbox-group";
  }

  private isOptionBackedMissingField(field: MissingFieldDetail): boolean {
    return field.tag === "select" || field.role === "combobox" || field.role === "radio" || field.role === "checkbox";
  }

  private isLiveProbeEligibleField(kind: FieldControlType): boolean {
    return kind === "select" || kind === "combobox";
  }

  private buildOptionOnlyRetryQuestion(question: ApplicationQuestion, optionPool: string[]): ApplicationQuestion {
    const sanitizedOptions = optionPool.filter((option) => !isPlaceholderOption(option));
    const retryOptions = sanitizedOptions.length ? sanitizedOptions : optionPool;
    const optionList = retryOptions.join(" | ");
    return {
      ...question,
      type: "single_select",
      options: retryOptions,
      label: `${question.label}\nSelect exactly one option from this list and return only that exact option text: ${optionList}`,
      platformMeta: {
        ...(question.platformMeta ?? {}),
        optionHints: retryOptions
      }
    };
  }

  private shouldAnswerOptionalNarrative(question: ApplicationQuestion, config: AdapterRunContext["config"]): boolean {
    if (question.required) return true;
    if (question.type !== "textarea" && !this.isNarrativePrompt(normalizeText(question.label))) return true;
    return Boolean(config.greenhouse?.answerOptionalNarratives);
  }

  private questionDescription(question: ApplicationQuestion): string {
    const fieldContext = typeof question.platformMeta?.fieldContext === "string"
      ? question.platformMeta.fieldContext
      : "";
    return fieldContext || "";
  }

  private isOptionBackedInputKind(kind: GreenhouseQuestion["inputKind"] | "select"): boolean {
    return kind === "select" || kind === "combobox" || kind === "radio-group" || kind === "checkbox-group";
  }

  private isDisallowedRequiredTextAnswer(answer: string, config: AdapterRunContext["config"]): boolean {
    if (config.greenhouse?.allowPlaceholderRequiredText) return false;
    const normalized = normalizeText(answer);
    if (!normalized) return true;
    return REQUIRED_TEXT_PLACEHOLDER_DENYLIST.has(normalized);
  }

  private async inspectTextInputConstraints(
    page: AdapterRunContext["page"],
    locatorHint: {
      id?: string;
      name?: string;
      selector?: string;
      selectorCandidates?: string[];
      label?: string;
    }
  ): Promise<TextInputConstraintSnapshot | null> {
    return page.evaluate((hint) => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const selectors = [
        hint.selector || "",
        ...(hint.selectorCandidates || []),
        hint.id ? `[id=${JSON.stringify(hint.id)}], [name=${JSON.stringify(hint.id)}]` : "",
        hint.name ? `[name=${JSON.stringify(hint.name)}]` : ""
      ].filter(Boolean);
      let element: HTMLInputElement | HTMLTextAreaElement | null = null;
      for (const selector of selectors) {
        const found = document.querySelector(selector);
        if (found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement) {
          element = found;
          break;
        }
      }

      if (!element && hint.label) {
        const labels = Array.from(document.querySelectorAll("label"));
        const wanted = normalize(hint.label).toLowerCase();
        const matched = labels.find((entry) => normalize(entry.textContent || "").replace(/\*/g, "").toLowerCase() === wanted);
        const forId = matched?.getAttribute("for");
        if (forId) {
          const byFor = document.getElementById(forId);
          if (byFor instanceof HTMLInputElement || byFor instanceof HTMLTextAreaElement) {
            element = byFor;
          }
        }
      }

      if (!element) return null;
      const typeAttr = element instanceof HTMLInputElement ? (element.getAttribute("type") || "text") : "textarea";
      const pattern = element.getAttribute("pattern") || "";
      const inputmode = element.getAttribute("inputmode") || "";
      const min = element.getAttribute("min") || "";
      const max = element.getAttribute("max") || "";
      const step = element.getAttribute("step") || "";
      const maxlengthRaw = element.getAttribute("maxlength");
      const maxlength = maxlengthRaw ? Number(maxlengthRaw) : undefined;
      const placeholder = element.getAttribute("placeholder") || "";
      const currentValue = normalize(element.value || "");
      const validityValid = typeof element.checkValidity === "function" ? element.checkValidity() : true;
      const validationMessage = normalize(element.validationMessage || "");
      const looksNumeric = (
        typeAttr === "number" ||
        inputmode === "numeric" ||
        inputmode === "decimal" ||
        /\\d|[0-9]/.test(pattern) ||
        /salary|compensation|annual pay|expected pay/.test(normalize(placeholder))
      );

      return {
        inputType: typeAttr,
        pattern,
        inputmode,
        placeholder,
        min,
        max,
        step,
        maxlength: Number.isFinite(maxlength) ? maxlength : undefined,
        currentValue,
        validityValid,
        validationMessage,
        numericOnly: looksNumeric
      };
    }, locatorHint).catch(() => null);
  }

  private normalizeCompensationAnswerForConstraints(answer: string, constraints: TextInputConstraintSnapshot | null): string {
    const trimmed = (answer || "").trim();
    if (!trimmed) return "";
    if (!constraints?.numericOnly) return trimmed;
    const digitsOnly = trimmed.replace(/[^0-9.-]/g, "");
    if (!digitsOnly) return "";
    return digitsOnly;
  }

  private pickRequiredTextFallback(
    semanticClass: TextFieldSemantic,
    constraints: TextInputConstraintSnapshot | null,
    profile: AdapterRunContext["profile"],
    config: AdapterRunContext["config"]
  ): string {
    const profileComp = (profile.salary || "").trim();
    if (semanticClass === "compensation") {
      if (profileComp) {
        const normalizedProfileComp = this.normalizeCompensationAnswerForConstraints(profileComp, constraints);
        if (normalizedProfileComp) return normalizedProfileComp;
      }
      if (constraints?.numericOnly) {
        return (config.greenhouse?.compensationNumericFallback || "100000").trim();
      }
      return (config.greenhouse?.compensationTextFallback || "Open to market rate").trim();
    }
    if (semanticClass === "availability") return "Available to start based on hiring timeline.";
    if (semanticClass === "relocation") return "Open to discussing relocation based on role requirements.";
    if (semanticClass === "notice_period") return "Two weeks notice.";
    if (semanticClass === "motivation") return this.narrativeFallbackAnswer(profile);
    return "Open to discussion based on role expectations.";
  }

  private buildRequiredTextRetryQuestion(question: ApplicationQuestion): ApplicationQuestion {
    return {
      ...question,
      label: `${question.label}\nRequired field. Provide a concise, professional answer for this application field.`,
      options: undefined
    };
  }

  async apply(context: AdapterRunContext): Promise<JobRunResult> {
    const { page, logger, target, profile, config } = context;
    const result = this.baseResult(context);
    const filledFields: FilledFieldRecord[] = [];
    this.aiAnswerCache.clear();
    result.startedAt = new Date().toISOString();

    try {
      if (config.mode === "auto-submit") {
        this.assertLlmConfiguredForGreenhouseAutoSubmit(config);
      }
      this.pushStageNote(result, "navigate");

      await page.goto(target.url, {
        waitUntil: "domcontentloaded",
        timeout: config.timeoutMs
      });

      this.ensurePageOpen(page, "post_navigate");
      this.pushStageNote(result, "open_form");
      await this.ensureApplicationFormOpen(page);
      this.ensurePageOpen(page, "post_open_form");
      this.pushStageNote(result, "seed_fields");
      const seededFields = await this.fillConfiguredFields(context);
      await this.closePhoneCountryWidget(page).catch(() => undefined);
      for (const seededField of seededFields) {
        this.upsertFilledField(filledFields, seededField);
      }

      this.pushStageNote(result, "extract_context");
      const contextInfo = await this.extractJobContext(page, target.url);
      result.jobTitle = result.jobTitle ?? contextInfo.jobTitle;
      result.company = result.company ?? contextInfo.company;
      const companyContext = contextInfo.companyContext;

      const finalAnswersById = new Map<string, ResolvedAnswer>();
      const processedQuestionIds = new Set<string>();
      const knownSeededIds = new Set(seededFields.map((item) => normalizeText(item.id)));

      for (let pass = 0; pass < 3; pass += 1) {
        this.pushStageNote(result, `pass_${pass + 1}_scan`);
        await this.closePhoneCountryWidget(page).catch(() => undefined);
        const scanned = await this.scanFieldDescriptors(page);
        const pending = scanned
          .filter((field) => field.required)
          .filter((field) => !knownSeededIds.has(normalizeText(field.id || field.key)))
          .filter((field) => !processedQuestionIds.has(field.key));
        if (!pending.length) break;

        const questions: ApplicationQuestion[] = pending.map((field) => {
          const mappedType = mapInputType(field.controlType, field.options ?? []);
          return {
            id: field.key,
            label: field.label,
            type: mappedType.questionType,
            required: field.required,
            options: field.options,
            platformMeta: {
              inputKind: mappedType.kind,
              name: field.name,
              domId: field.id,
              selector: field.selector,
              selectorCandidates: field.selectorCandidates,
              optionHints: field.optionHints,
              optionMeta: field.optionMeta,
              fieldContext: field.fieldContext
            }
          };
        });
        const questionById = new Map(questions.map((question) => [question.id, question]));
        const fieldById = new Map(pending.map((field) => [field.key, field]));
        await this.enrichSelectOptionHints(page, questions);

        // Phase A: deterministic/profile only.
        const deterministicByQuestionId = this.buildDeterministicProfileAnswers(questions, profile, config.resumePath);
        const unresolvedAfterPhaseA = new Set<string>();
        for (const field of pending) {
          const question = questionById.get(field.key);
          if (!question) continue;
          const deterministic = deterministicByQuestionId.get(field.key);
          if (!deterministic) {
            if (this.isOptionBackedField(field.controlType)) {
              const preexistingState = await this.inspectRequiredValidationState(page, {
                id: field.id ?? field.key,
                label: field.label,
                selector: field.selector,
                name: field.name
              }).catch(() => null);
              if (
                preexistingState &&
                preexistingState.currentValue &&
                !preexistingState.ariaInvalid &&
                !this.hasRequiredValidationErrorText(preexistingState.errorText)
              ) {
                this.upsertFilledField(filledFields, {
                  id: field.key,
                  label: question.label,
                  value: preexistingState.currentValue,
                  source: "manual",
                  inputKind: mapInputType(field.controlType, field.options ?? []).kind
                });
                processedQuestionIds.add(field.key);
                continue;
              }
            }
            unresolvedAfterPhaseA.add(field.key);
            continue;
          }

          const mappedType = mapInputType(field.controlType, field.options ?? []);
          const hintedOptions = Array.isArray(question.platformMeta?.optionHints)
            ? (question.platformMeta.optionHints as string[])
            : [];
          const optionPool = question.options?.length ? question.options : hintedOptions;
          let answerString = answerValueToString(deterministic.value).trim();
          answerString = this.applyGreenhouseRequiredHeuristics(question, answerString, profile, {
            logger: context.logger,
            fieldId: question.id,
            stage: "phase_a"
          });
          answerString = this.normalizeAnswerForFieldType(mappedType.kind, answerString, optionPool, question.label);
          if (mappedType.kind === "select" || mappedType.kind === "combobox") {
            answerString = this.normalizeSelectAnswer(answerString);
          }

          this.logGreenhouseEvent(context, "greenhouse_phase_a_profile_resolved", {
            fieldId: field.key,
            label: question.label,
            controlType: mappedType.kind,
            required: field.required,
            source: deterministic.source,
            reason: deterministic.reason,
            answer: answerString
          });

          const domId = typeof question.platformMeta?.domId === "string" ? (question.platformMeta.domId as string) : field.id;
          const selector = typeof question.platformMeta?.selector === "string" ? (question.platformMeta.selector as string) : field.selector;
          const selectorCandidates = Array.isArray(question.platformMeta?.selectorCandidates)
            ? (question.platformMeta.selectorCandidates as string[])
            : field.selectorCandidates;
          const greenhouseQuestion: GreenhouseQuestion = {
            ...question,
            key: field.key,
            inputKind: mappedType.kind,
            name: field.name,
            domId,
            selector,
            selectorCandidates
          };
          let applied = await this.applyAnswer(page, greenhouseQuestion, answerString);
          let verified = applied
            ? await this.verifyFieldSatisfied(page, field.key, mappedType.kind, answerString, {
                id: domId,
                name: field.name,
                selector,
                selectorCandidates
              }).catch(() => false)
            : false;
          let retryApplied = false;
          if (!verified) {
            retryApplied = true;
            applied = await this.applyAnswer(page, greenhouseQuestion, answerString);
            verified = applied
              ? await this.verifyFieldSatisfied(page, field.key, mappedType.kind, answerString, {
                  id: domId,
                  name: field.name,
                  selector,
                  selectorCandidates
                }).catch(() => false)
              : false;
          }

          this.logGreenhouseEvent(context, "greenhouse_phase_a_execute_result", {
            fieldId: field.key,
            label: question.label,
            controlType: mappedType.kind,
            required: field.required,
            answer: answerString,
            applied,
            verified,
            retried: retryApplied
          });

          if (verified) {
            finalAnswersById.set(field.key, {
              questionId: field.key,
              value: answerString || null,
              source: deterministic.source,
              reason: deterministic.reason
            });
            result.notes.push(`deterministic_profile_locked:${field.key}`);
            this.upsertFilledField(filledFields, {
              id: field.key,
              label: question.label,
              value: answerString,
              source: this.toFilledSource(deterministic.source),
              inputKind: mappedType.kind
            });
            this.recordLlmEvent(result, "deterministic_answer_applied", {
              platform: "greenhouse",
              phase: "phase_a",
              fieldId: field.key,
              label: question.label,
              source: deterministic.source,
              value: answerString,
              hasValue: Boolean(answerString),
              outcomeReason: "deterministic_verified",
              metadata: {
                controlType: mappedType.kind,
                required: field.required,
                reason: deterministic.reason
              }
            });
            processedQuestionIds.add(field.key);
          } else {
            this.recordLlmEvent(result, "answer_resolution", {
              platform: "greenhouse",
              phase: "phase_a",
              fieldId: field.key,
              label: question.label,
              source: deterministic.source,
              value: answerString,
              hasValue: Boolean(answerString),
              outcomeReason: "deterministic_unverified",
              metadata: {
                controlType: mappedType.kind,
                required: field.required,
                reason: deterministic.reason
              }
            });
            unresolvedAfterPhaseA.add(field.key);
          }
        }

        const unresolvedQuestions: ApplicationQuestion[] = [];
        for (const questionId of unresolvedAfterPhaseA) {
          const unresolvedQuestion = questionById.get(questionId);
          if (unresolvedQuestion) unresolvedQuestions.push(unresolvedQuestion);
        }
        if (!unresolvedQuestions.length) continue;

        // Probe live options before LLM for unresolved option-backed fields.
        for (const unresolvedQuestion of unresolvedQuestions) {
          const field = fieldById.get(unresolvedQuestion.id);
          if (!field || !this.isLiveProbeEligibleField(field.controlType)) continue;
          const probe = await this.probeLiveSelectOptions(page, field, context.logger).catch(() => null);
          if (!probe) continue;
          unresolvedQuestion.options = probe.options.map((option) => option.text);
          unresolvedQuestion.platformMeta = {
            ...(unresolvedQuestion.platformMeta ?? {}),
            optionHints: probe.options.map((option) => option.text),
            fieldContext: [unresolvedQuestion.platformMeta?.fieldContext, probe.validationErrorText].filter(Boolean).join("\n"),
            listboxId: probe.listboxId,
            menuSelector: probe.menuSelector
          };
        }

        this.logGreenhouseEvent(context, "greenhouse_pending_for_llm", {
          count: unresolvedQuestions.length,
          fields: unresolvedQuestions.map((question) => {
            const field = fieldById.get(question.id);
            const optionHints = Array.isArray(question.platformMeta?.optionHints)
              ? (question.platformMeta.optionHints as string[])
              : [];
            return {
              fieldId: question.id,
              label: question.label,
              controlType: field?.controlType ?? question.platformMeta?.inputKind ?? "unknown",
              required: question.required,
              options: question.options ?? optionHints,
              optionSource: (field?.options?.length && optionHints.length) ? "both" : (optionHints.length ? "live_probe" : "inline"),
              inclusionReason: "unresolved_after_phase_a"
            };
          })
        });
        this.logGreenhouseEvent(context, "greenhouse_phase_b_llm_request", {
          questionCount: unresolvedQuestions.length,
          fieldIds: unresolvedQuestions.map((question) => question.id),
          labels: unresolvedQuestions.map((question) => question.label)
        });
        this.recordLlmEvent(result, "llm_request_payload", {
          platform: "greenhouse",
          phase: `phase_b_pass_${pass + 1}`,
          fieldIds: unresolvedQuestions.map((question) => question.id),
          labels: unresolvedQuestions.map((question) => question.label),
          questionCount: unresolvedQuestions.length,
          metadata: {
            fields: unresolvedQuestions.map((question) => {
              const field = fieldById.get(question.id);
              const optionHints = Array.isArray(question.platformMeta?.optionHints)
                ? (question.platformMeta.optionHints as string[])
                : [];
              return {
                fieldId: question.id,
                label: question.label,
                required: question.required,
                controlType: field?.controlType ?? "unknown",
                options: question.options ?? optionHints
              };
            })
          }
        });

        const aiResolved = await this.resolveQuestionsWithCache(
          unresolvedQuestions,
          context,
          result.jobTitle,
          result.company,
          companyContext,
          true
        );
        const aiByQuestion = new Map(aiResolved.map((answer) => [answer.questionId, answer]));
        this.recordLlmEvent(result, "llm_response_payload", {
          platform: "greenhouse",
          phase: `phase_b_pass_${pass + 1}`,
          questionCount: unresolvedQuestions.length,
          answerKeyCount: aiResolved.length,
          nonNullAnswerCount: aiResolved.filter((answer) => Boolean(answerValueToString(answer.value).trim())).length,
          metadata: {
            answers: aiResolved.map((answer) => ({
              questionId: answer.questionId,
              source: answer.source,
              reason: answer.reason,
              value: answerValueToString(answer.value ?? null)
            }))
          }
        });

        // Phase B: LLM only for unresolved fields.
        for (const unresolvedId of unresolvedAfterPhaseA) {
          const field = fieldById.get(unresolvedId);
          const question = questionById.get(unresolvedId);
          if (!field || !question) continue;
          if (!this.shouldAnswerOptionalNarrative(question, config)) {
            this.recordLlmEvent(result, "answer_resolution", {
              platform: "greenhouse",
              phase: "phase_b",
              fieldId: unresolvedId,
              label: question.label,
              source: "skipped",
              hasValue: false,
              outcomeReason: "optional_narrative_skipped"
            });
            continue;
          }
          const mappedType = mapInputType(field.controlType, field.options ?? []);
          const hintedOptions = Array.isArray(question.platformMeta?.optionHints)
            ? (question.platformMeta.optionHints as string[])
            : [];
          const optionPool = question.options?.length ? question.options : hintedOptions;
          const resolved = aiByQuestion.get(unresolvedId);
          let source: ResolvedAnswer["source"] = resolved?.source ?? "llm";
          let reason = resolved?.reason;
          let answerString = answerValueToString(resolved?.value ?? null).trim();
          const normalizedQuestionLabel = normalizeText(question.label);
          const demographicKind = mappedType.kind === "combobox"
            ? this.getDemographicFieldKind(normalizedQuestionLabel)
            : undefined;
          let generationSource: FreeTextGenerationSource = "llm";
          let semanticClass = detectTextFieldSemantic(
            question.label,
            question.placeholder,
            this.questionDescription(question)
          );
          let textConstraints: TextInputConstraintSnapshot | null = null;
          let usedFallback = false;

          if ((mappedType.kind === "text" || mappedType.kind === "textarea") && question.required) {
            const resolvedText = await this.resolveRequiredFreeTextAnswer({
              question,
              field,
              initialResolved: resolved,
              context,
              result,
              jobTitle: result.jobTitle,
              company: result.company,
              companyContext
            });
            answerString = resolvedText.answer;
            source = resolvedText.source;
            reason = resolvedText.reason;
            generationSource = resolvedText.generationSource;
            semanticClass = resolvedText.semanticClass;
            textConstraints = resolvedText.constraints;
            usedFallback = resolvedText.usedFallback;
          }

          if (mappedType.kind === "combobox" && this.isLocationBasedPrompt(normalizedQuestionLabel)) {
            const forcedLocationAnswer = this.buildCityStateCountryCandidate(context.profile);
            if (forcedLocationAnswer) {
              answerString = forcedLocationAnswer;
              source = "profile";
              reason = "deterministic_location_city_state_country";
            }
          }

          if (mappedType.kind === "combobox" && demographicKind && !optionPool.length) {
            const demographicState = await this.inspectRequiredValidationState(page, {
              id: field.id ?? field.key,
              label: question.label,
              selector: field.selector,
              name: field.name
            }).catch(() => null);
            const currentDemographicValue = (demographicState?.currentValue || "").trim();
            if (currentDemographicValue && !isPlaceholderOption(currentDemographicValue)) {
              answerString = currentDemographicValue;
              source = "manual";
              reason = "preserve_existing_demographic_value";
            } else {
              answerString = "I don't wish to answer";
              source = "profile";
              reason = "demographic_prefer_not_fallback";
            }
          }

          if (!answerString && this.isOptionBackedField(field.controlType) && optionPool.length) {
            const retryAnswers = await context.aiEngine.resolve([{
              ...question,
              options: optionPool,
              platformMeta: {
                ...(question.platformMeta ?? {}),
                optionHints: optionPool
              }
            }], {
              profile: context.profile,
              resumeText: context.resumeText,
              jobTitle: result.jobTitle,
              company: result.company,
              companyContext
            }).catch(() => []);
            const retry = retryAnswers[0];
            if (retry) {
              answerString = answerValueToString(retry.value ?? null).trim();
              source = retry.source;
              reason = retry.reason ?? "llm_single_retry";
            }
          }
          if (!answerString) {
            this.recordLlmEvent(result, "llm_answer_empty", {
              platform: "greenhouse",
              phase: "phase_b",
              fieldId: unresolvedId,
              label: question.label,
              source,
              hasValue: false,
              outcomeReason: "no_llm_answer"
            });
            continue;
          }
          if (this.isOptionBackedField(field.controlType) && optionPool.length) {
            let matchedOption = findBestOptionMatch(answerString, optionPool);
            if (!matchedOption) {
              this.logGreenhouseEvent(context, "greenhouse_option_answer_rejected", {
                fieldId: field.key,
                label: question.label,
                controlType: mappedType.kind,
                required: field.required,
                selectedAnswer: answerString,
                options: optionPool
              });
              this.logGreenhouseEvent(context, "greenhouse_required_option_retry", {
                fieldId: field.key,
                label: question.label,
                controlType: mappedType.kind,
                required: field.required,
                selectedAnswer: answerString,
                options: optionPool
              });
              const retryQuestion = this.buildOptionOnlyRetryQuestion({
                ...question,
                options: optionPool,
                platformMeta: {
                  ...(question.platformMeta ?? {}),
                  optionHints: optionPool
                }
              }, optionPool);
              const retryAnswers = await context.aiEngine.resolve([retryQuestion], {
                profile: context.profile,
                resumeText: context.resumeText,
                jobTitle: result.jobTitle,
                company: result.company,
                companyContext
              }).catch(() => []);
              const retry = retryAnswers[0];
              if (retry) {
                const retryString = answerValueToString(retry.value ?? null).trim();
                const retryMatch = findBestOptionMatch(retryString, optionPool);
                if (retryMatch) {
                  answerString = retryString;
                  matchedOption = retryMatch;
                  source = retry.source;
                  reason = retry.reason ?? "llm_single_retry_match";
                }
              }
            }
            this.logGreenhouseEvent(context, "greenhouse_option_match_result", {
              fieldId: field.key,
              label: question.label,
              controlType: mappedType.kind,
              required: field.required,
              selectedAnswer: answerString,
              matchedOption: matchedOption ?? null,
              options: optionPool
            });
            if (!matchedOption) {
              this.logGreenhouseEvent(context, "greenhouse_required_option_unresolved", {
                fieldId: field.key,
                label: question.label,
                controlType: mappedType.kind,
                required: field.required,
                selectedAnswer: answerString,
                options: optionPool
              });
              this.recordLlmEvent(result, "llm_answer_invalid_option", {
                platform: "greenhouse",
                phase: "phase_b",
                fieldId: unresolvedId,
                label: question.label,
                source,
                value: answerString,
                hasValue: true,
                outcomeReason: "llm_answer_not_in_options",
                metadata: { options: optionPool }
              });
              continue;
            }
            answerString = matchedOption;
          }

          answerString = this.normalizeAnswerForFieldType(mappedType.kind, answerString, optionPool, question.label);
          if (mappedType.kind === "select" || mappedType.kind === "combobox") {
            answerString = this.normalizeSelectAnswer(answerString);
          }

          const domId = typeof question.platformMeta?.domId === "string" ? (question.platformMeta.domId as string) : field.id;
          const selector = typeof question.platformMeta?.selector === "string" ? (question.platformMeta.selector as string) : field.selector;
          const selectorCandidates = Array.isArray(question.platformMeta?.selectorCandidates)
            ? (question.platformMeta.selectorCandidates as string[])
            : field.selectorCandidates;
          const greenhouseQuestion: GreenhouseQuestion = {
            ...question,
            key: field.key,
            inputKind: mappedType.kind,
            name: field.name,
            domId,
            selector,
            selectorCandidates
          };

          if (mappedType.kind === "select" || mappedType.kind === "combobox") {
            this.logGreenhouseEvent(context, "greenhouse_react_select_commit_start", {
              fieldId: field.key,
              label: question.label,
              controlType: mappedType.kind,
              required: field.required,
              selectedAnswer: answerString,
              listboxId: question.platformMeta?.listboxId ?? null
            });
          }
          const applied = await this.applyAnswer(page, greenhouseQuestion, answerString);
          const verified = applied
            ? await this.verifyFieldSatisfied(page, field.key, mappedType.kind, answerString, {
                id: domId,
                name: field.name,
                selector,
                selectorCandidates
              }).catch(() => false)
            : false;
          if ((mappedType.kind === "text" || mappedType.kind === "textarea") && !textConstraints) {
            textConstraints = await this.inspectTextInputConstraints(page, {
              id: domId ?? field.key,
              name: field.name,
              selector,
              selectorCandidates,
              label: question.label
            });
          }
          const validationState = await this.inspectRequiredValidationState(page, {
            id: domId ?? field.key,
            label: question.label,
            selector,
            name: field.name
          }).catch(() => null);
          if (validationState) {
            this.logGreenhouseEvent(context, "greenhouse_required_validation_state", {
              fieldId: field.key,
              label: question.label,
              controlType: mappedType.kind,
              required: field.required,
              currentValue: validationState.currentValue,
              errorText: validationState.errorText,
              ariaInvalid: validationState.ariaInvalid,
              hiddenValues: validationState.hiddenValues
            });
            if (validationState.currentValue && (validationState.ariaInvalid || this.hasRequiredValidationErrorText(validationState.errorText))) {
              this.logGreenhouseEvent(context, "greenhouse_visible_value_but_invalid", {
                fieldId: field.key,
                label: question.label,
                currentValue: validationState.currentValue,
                errorText: validationState.errorText,
                ariaInvalid: validationState.ariaInvalid
              });
            }
            if (mappedType.kind === "select" || mappedType.kind === "combobox") {
              this.logGreenhouseEvent(context, "greenhouse_react_select_commit_state", {
                fieldId: field.key,
                label: question.label,
                controlType: mappedType.kind,
                required: field.required,
                selectedAnswer: answerString,
                applied,
                verified,
                currentValue: validationState.currentValue,
                errorText: validationState.errorText,
                ariaInvalid: validationState.ariaInvalid,
                hiddenValues: validationState.hiddenValues
              });
            }
          }
          if (mappedType.kind === "text" || mappedType.kind === "textarea") {
            this.logGreenhouseEvent(context, "greenhouse_text_fill_verify_result", {
              fieldId: field.key,
              label: question.label,
              answer: answerString,
              answerLength: answerString.length,
              semanticClass,
              generationSource,
              inputType: textConstraints?.inputType || "",
              pattern: textConstraints?.pattern || "",
              inputmode: textConstraints?.inputmode || "",
              min: textConstraints?.min || "",
              max: textConstraints?.max || "",
              step: textConstraints?.step || "",
              maxlength: textConstraints?.maxlength,
              validityValid: textConstraints?.validityValid ?? false,
              validationMessage: textConstraints?.validationMessage || "",
              errorText: validationState?.errorText ?? "",
              fallbackUsed: usedFallback,
              verified
            });
            this.recordLlmEvent(result, "greenhouse_text_fill_verify_result", {
              platform: "greenhouse",
              phase: "phase_b",
              fieldId: field.key,
              label: question.label,
              source,
              hasValue: Boolean(answerString),
              value: answerString,
              outcomeReason: verified ? "verified" : "unverified_after_apply",
              metadata: {
                semanticClass,
                generationSource,
                inputType: textConstraints?.inputType || "",
                pattern: textConstraints?.pattern || "",
                inputmode: textConstraints?.inputmode || "",
                min: textConstraints?.min || "",
                max: textConstraints?.max || "",
                step: textConstraints?.step || "",
                maxlength: textConstraints?.maxlength,
                validityValid: textConstraints?.validityValid ?? false,
                validationMessage: textConstraints?.validationMessage || "",
                errorText: validationState?.errorText ?? "",
                fallbackUsed: usedFallback
              }
            });
          }

          if (verified) {
            this.upsertFilledField(filledFields, {
              id: field.key,
              label: question.label,
              value: answerString,
              source: this.toFilledSource(source),
              inputKind: mappedType.kind
            });
            finalAnswersById.set(field.key, {
              questionId: field.key,
              value: answerString || null,
              source,
              reason,
              metadata: (mappedType.kind === "text" || mappedType.kind === "textarea")
                ? {
                    generationSource,
                    semanticClass
                  }
                : undefined
            });
            const appliedEvent = source === "llm" ? "llm_answer_applied" : "deterministic_answer_applied";
            this.recordLlmEvent(result, appliedEvent, {
              platform: "greenhouse",
              phase: "phase_b",
              fieldId: field.key,
              label: question.label,
              source,
              value: answerString,
              hasValue: true,
              outcomeReason: "verified",
              metadata: {
                controlType: mappedType.kind,
                required: field.required,
                reason
              }
            });
            processedQuestionIds.add(field.key);
          } else {
            this.recordLlmEvent(result, "answer_resolution", {
              platform: "greenhouse",
              phase: "phase_b",
              fieldId: field.key,
              label: question.label,
              source,
              value: answerString,
              hasValue: true,
              outcomeReason: "unverified_after_apply",
              metadata: {
                controlType: mappedType.kind,
                required: field.required
              }
            });
          }
        }
      }

      const finalAnswers = Array.from(finalAnswersById.values());
      result.answers = finalAnswers;
      result.filledFields = filledFields;
      result.status = "filled";

      this.pushStageNote(result, "reconcile_required");
        await this.reconcileRequiredFieldsBeforeSubmit(
          page,
          finalAnswers,
          profile,
          filledFields,
          {
            logger: context.logger,
            aiEngine: context.aiEngine,
            resumeText: context.resumeText,
            jobTitle: result.jobTitle,
            company: result.company,
            companyContext,
            config: context.config
        }
      );

      const preSubmitPath = path.join(config.screenshotsDir, `greenhouse-filled-${Date.now()}.png`);
      this.ensurePageOpen(page, "pre_submit_screenshot");
      await page.screenshot({ path: preSubmitPath, fullPage: true }).catch((error) => {
        if (isSessionLostError(error)) {
          throw new Error("session_lost:pre_submit_screenshot");
        }
      });
      if (existsSync(preSubmitPath)) {
        result.screenshotPaths.push(preSubmitPath);
      }

      if (config.mode === "auto-submit") {
        result.notes.push("submit_policy:one_shot");
        this.pushStageNote(result, "submit_sequence");
        const submission = await this.submitWithDeterministicAttempts(
          context,
          finalAnswers,
          filledFields
        );
        result.submitted = submission.submitted;
        result.submissionConfirmed = submission.submitted;
        result.status = submission.submitted ? "applied" : "filled";
        result.submitOutcome = submission.submitted
          ? "confirmed"
          : submission.reasonTag
            ? normalizeReasonTagToOutcome(submission.reasonTag)
            : "pending_confirmation";

        if (!submission.submitted) {
          if (submission.identityAuditBeforeSubmit.length) {
            result.notes.push(`identity_audit_before_submit:${submission.identityAuditBeforeSubmit.join(" | ")}`);
          }
          if ((submission.identityCandidateAuditBeforeSubmit ?? []).length) {
            result.notes.push(
              `identity_audit_candidates_before_submit:${(submission.identityCandidateAuditBeforeSubmit ?? []).join(" | ")}`
            );
          }
          if (submission.identityAuditAfterSubmit.length) {
            result.notes.push(`identity_audit_after_submit:${submission.identityAuditAfterSubmit.join(" | ")}`);
          }
          if ((submission.identityCandidateAuditAfterSubmit ?? []).length) {
            result.notes.push(
              `identity_audit_candidates_after_submit:${(submission.identityCandidateAuditAfterSubmit ?? []).join(" | ")}`
            );
          }
          if (submission.preSubmitBlocker) {
            result.notes.push(`pre_submit_blocker:${submission.preSubmitBlocker}`);
          }
          if (submission.validationErrors.length) {
            result.notes.push(`submit_validation_errors:${submission.validationErrors.join(" | ")}`);
          }
          if (submission.missingRequired.length) {
            result.notes.push(`submit_missing_required:${submission.missingRequired.join(", ")}`);
          }
          if (submission.missingRequiredDetails.length) {
            result.notes.push(`submit_missing_required_details:${submission.missingRequiredDetails.join(" | ")}`);
          }
          if (submission.resumeVerification) {
            result.notes.push(
              `resume_subcheck:input=${submission.resumeVerification.inputFileOk ? "ok" : "fail"},cue=${submission.resumeVerification.visibleCueOk ? "ok" : "fail"},upload_signal=${submission.resumeVerification.uploadSignalOk ? "ok" : "fail"},missing_scan=${submission.resumeVerification.missingScanOk ? "ok" : "fail"}`
            );
            if (submission.resumeVerification.confidence) {
              result.notes.push(`resume_confidence:${submission.resumeVerification.confidence}`);
            }
            if (submission.resumeVerification.verificationMode) {
              result.notes.push(`resume_verification_mode:${submission.resumeVerification.verificationMode}`);
            }
            if (submission.resumeVerification.matchedInputSelector) {
              result.notes.push(`resume_debug:input_selector=${submission.resumeVerification.matchedInputSelector}`);
            }
            if (submission.resumeVerification.matchedCueText) {
              result.notes.push(`resume_debug:cue_text=${submission.resumeVerification.matchedCueText}`);
            }
            if (submission.resumeVerification.uploadState) {
              result.notes.push(`resume_state:${submission.resumeVerification.uploadState}`);
            }
            if (submission.resumeVerification.failureTag) {
              result.notes.push(`resume_reason:${submission.resumeVerification.failureTag}`);
            }
            if (submission.resumeVerification.diagnostics?.length) {
              result.notes.push(`resume_diag:${submission.resumeVerification.diagnostics.join(" | ")}`);
            }
          }
          if (
            submission.resumeVerification?.ok &&
            submission.resumeVerification.visibleCueOk &&
            submission.resumeVerification.missingScanOk
          ) {
            result.notes.push("resume_verdict:ui_cue_verified");
            if (!submission.resumeVerification.uploadSignalOk) {
              result.notes.push("resume_verdict:network_signal_missing_but_accepted");
            }
          }
          if (submission.reasonTag) {
            result.notes.push(`submit_reason:${submission.reasonTag}`);
            result.notes.push(`post_submit_blocker:${submission.reasonTag}`);
          }
          if (submission.firstBlockingReason) {
            result.notes.push(`submit_first_blocker:${submission.firstBlockingReason}`);
          }
          result.notes.push(`submit_reapply:${submission.reapplyOccurred ? "yes" : "no"}`);
          result.notes.push(`submit_challenge_detected:${submission.challengeDetected ? "yes" : "no"}`);
          result.notes.push(`submit_attempts:${submission.attempts.length}`);
        } else {
          if (submission.identityAuditBeforeSubmit.length) {
            result.notes.push(`identity_audit_before_submit:${submission.identityAuditBeforeSubmit.join(" | ")}`);
          }
          if ((submission.identityCandidateAuditBeforeSubmit ?? []).length) {
            result.notes.push(
              `identity_audit_candidates_before_submit:${(submission.identityCandidateAuditBeforeSubmit ?? []).join(" | ")}`
            );
          }
          if (submission.identityAuditAfterSubmit.length) {
            result.notes.push(`identity_audit_after_submit:${submission.identityAuditAfterSubmit.join(" | ")}`);
          }
          if ((submission.identityCandidateAuditAfterSubmit ?? []).length) {
            result.notes.push(
              `identity_audit_candidates_after_submit:${(submission.identityCandidateAuditAfterSubmit ?? []).join(" | ")}`
            );
          }
          if (
            submission.resumeVerification?.ok &&
            submission.resumeVerification.visibleCueOk &&
            submission.resumeVerification.missingScanOk
          ) {
            result.notes.push("resume_verdict:ui_cue_verified");
            if (!submission.resumeVerification.uploadSignalOk) {
              result.notes.push("resume_verdict:network_signal_missing_but_accepted");
            }
          }
          if (submission.resumeVerification?.confidence) {
            result.notes.push(`resume_confidence:${submission.resumeVerification.confidence}`);
          }
          if (submission.resumeVerification?.verificationMode) {
            result.notes.push(`resume_verification_mode:${submission.resumeVerification.verificationMode}`);
          }
          result.notes.push(`submit_reapply:${submission.reapplyOccurred ? "yes" : "no"}`);
          result.notes.push(`submit_challenge_detected:${submission.challengeDetected ? "yes" : "no"}`);
        }
      } else {
        result.notes.push("Dry run enabled, submit skipped.");
      }

      const donePath = path.join(config.screenshotsDir, `greenhouse-final-${Date.now()}.png`);
      this.ensurePageOpen(page, "final_screenshot");
      await page.screenshot({ path: donePath, fullPage: true }).catch((error) => {
        if (isSessionLostError(error)) {
          throw new Error("session_lost:final_screenshot");
        }
      });
      if (existsSync(donePath)) {
        result.screenshotPaths.push(donePath);
      }
    } catch (error) {
      logger.error("greenhouse_apply_failed", {
        url: target.url,
        error: error instanceof Error ? error.message : String(error)
      });

      result.status = "failed";
      result.error = error instanceof Error ? error.message : String(error);
      if (isSessionLostError(error)) {
        result.submitOutcome = "session_lost";
        const stageMatch = result.error.match(/session_lost:([^:\s]+)/i);
        const stage = stageMatch?.[1] ?? "unknown";
        result.notes.push(`submit_reason:session_lost:${stage}`);
      }

      const screenshotPath = path.join(config.screenshotsDir, `greenhouse-error-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      if (existsSync(screenshotPath)) {
        result.screenshotPaths.push(screenshotPath);
      }
    }

    result.filledFields = filledFields;
    result.finishedAt = new Date().toISOString();
    return result;
  }

  private async ensureApplicationFormOpen(page: AdapterRunContext["page"]): Promise<void> {
    const firstName = page.locator("#first_name");
    const waitForFirstName = async (timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const count = await firstName.count().catch(() => 0);
        if (count > 0) {
          const visible = await firstName.first().isVisible().catch(() => true);
          if (visible) return true;
        }
        await sleep(250);
      }
      return false;
    };

    if (await waitForFirstName(7000)) return;

    const candidates = [
      page.getByRole("button", { name: /apply/i }).first(),
      page.getByRole("link", { name: /apply/i }).first(),
      page.locator('a[href*="#app"]').first(),
      page.locator(".postings-btn").first()
    ];

    for (const candidate of candidates) {
      if (!(await candidate.count())) continue;
      try {
        await candidate.click({ timeout: 5000 });
        if (await waitForFirstName(10000)) return;
      } catch {
        // try next selector
      }
    }

    const embeddedGreenhouseUrl = await page.evaluate(() => {
      const frames = Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe"));
      for (const frame of frames) {
        const src = (frame.getAttribute("src") || "").trim();
        if (!src) continue;
        const lowered = src.toLowerCase();
        if (/greenhouse|job_app|gh_jid|gh_src/.test(lowered)) {
          try {
            return new URL(src, window.location.href).toString();
          } catch {
            return src;
          }
        }
      }
      return "";
    }).catch(() => "");

    if (embeddedGreenhouseUrl) {
      await page.goto(embeddedGreenhouseUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => undefined);
      if (await waitForFirstName(12000)) return;
    }

    if (await waitForFirstName(5000)) return;
    throw new Error("application_form_not_ready:first_name_missing");
  }

  private async probeLiveSelectOptions(
    page: AdapterRunContext["page"],
    field: FieldDescriptor,
    logger?: AdapterRunContext["logger"]
  ): Promise<LiveSelectProbeResult> {
    logger?.info("greenhouse_select_live_probe_start", {
      fieldId: field.key,
      label: field.label,
      controlType: field.controlType,
      required: field.required
    });

    const selectorPool = [
      field.id ? `#react-select-${field.id}-input` : "",
      field.id ? `#${field.id}` : "",
      field.selector,
      ...(field.selectorCandidates ?? [])
    ].filter(Boolean);
    for (const selector of selectorPool) {
      const control = page.locator(selector).first();
      if (!(await control.count().catch(() => 0))) continue;
      await control.click({ force: true }).catch(() => undefined);
      const hasVisibleValue = typeof (control as { evaluate?: unknown }).evaluate === "function"
        ? await control.evaluate((element) => {
            const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
            const shell = element.closest(".select-shell");
            const visibleValue = normalize(
              (shell?.querySelector(".select__single-value, [class*='singleValue' i]")?.textContent ||
                (element as HTMLInputElement).value ||
                "")
            );
            return Boolean(visibleValue && !/^select(\.\.\.)?$/i.test(visibleValue));
          }).catch(() => false)
        : false;
      // Only clear when safe: if there's no committed visible value yet.
      if (!hasVisibleValue) {
        await control.press("Backspace").catch(() => undefined);
      }
      break;
    }
    await page.waitForTimeout(120).catch(() => undefined);

    const probed = await page.evaluate((input) => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const visible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const target = (() => {
        const byId = input.domId ? document.getElementById(input.domId) : null;
        if (byId) return byId as HTMLElement;
        for (const selector of input.selectorCandidates ?? []) {
          if (!selector) continue;
          const found = document.querySelector(selector);
          if (found) return found as HTMLElement;
        }
        if (input.selector) {
          const found = document.querySelector(input.selector);
          if (found) return found as HTMLElement;
        }
        return document.activeElement as HTMLElement | null;
      })();

      const active = document.activeElement as HTMLElement | null;
      const ariaControls = active?.getAttribute("aria-controls") || target?.getAttribute("aria-controls") || "";
      const listboxes = Array.from(document.querySelectorAll<HTMLElement>(".select__menu-list[role='listbox'], [role='listbox'], [id^='react-select-'][id$='-listbox']"))
        .filter((listbox) => visible(listbox));
      let bindingStatus: "bound" | "mismatch" | "fallback" | "none" = "none";
      let matchedListbox: HTMLElement | null = null;
      if (ariaControls) {
        matchedListbox = listboxes.find((listbox) => listbox.id === ariaControls) || null;
        bindingStatus = matchedListbox ? "bound" : "mismatch";
      } else {
        matchedListbox =
          listboxes.find((listbox) => input.fieldId && listbox.id.includes(input.fieldId)) ||
          listboxes.find((listbox) => input.domId && listbox.id.includes(input.domId)) ||
          listboxes[0] ||
          null;
        bindingStatus = matchedListbox ? "fallback" : "none";
      }
      const menu = matchedListbox?.closest(".select__menu") as HTMLElement | null;

      const optionNodes = (matchedListbox
        ? Array.from(matchedListbox.querySelectorAll<HTMLElement>(".select__option, [role='option']"))
        : [])
        .filter((option) => visible(option));
      const optionSeen = new Set<string>();
      const options = optionNodes
        .map((option) => {
          const text = normalize(option.textContent || "");
          const id = option.id || undefined;
          const disabled = option.getAttribute("aria-disabled") === "true" || option.className.toLowerCase().includes("disabled");
          const selector = id ? `#${CSS.escape(id)}` : undefined;
          return { text, id, disabled, selector };
        })
        .filter((option) => {
          if (!option.text) return false;
          const dedupe = `${option.text.toLowerCase()}::${option.id || ""}`;
          if (optionSeen.has(dedupe)) return false;
          optionSeen.add(dedupe);
          return true;
        });

      const shell = target?.closest(".select-shell") || target?.closest(".field-wrapper, .input-wrapper, fieldset, li, section");
      const currentValue = normalize(
        (shell?.querySelector(".select__single-value, [class*='singleValue' i]")?.textContent || (target as HTMLInputElement | null)?.value || "")
      );
      const errorScope = (shell || target?.closest(".field-wrapper, .input-wrapper, fieldset, li, section") || target?.parentElement) as Element | null;
      const errorNodes = errorScope
        ? Array.from(
            errorScope.querySelectorAll<HTMLElement>(
              ".field-error, .error, .invalid-feedback, [role='alert'], [aria-live='polite'], [aria-live='assertive'], [data-qa*='error' i], [id*='error' i]"
            )
          )
        : [];
      let errorText = "";
      for (const node of errorNodes) {
        const text = normalize(node.textContent || "");
        if (!text) continue;
        if (text.toLowerCase().includes("this field is required")) {
          errorText = text.slice(0, 500);
          break;
        }
      }
      const ariaInvalid = Boolean(
        target?.getAttribute("aria-invalid") === "true" ||
        shell?.querySelector("[aria-invalid='true']")
      );
      const hiddenValues = shell
        ? Array.from(shell.querySelectorAll<HTMLInputElement>("input[type='hidden'], input[required][aria-hidden='true'], input.remix-css-1a0ro4n-requiredInput"))
          .map((node) => normalize(node.value || ""))
          .filter(Boolean)
        : [];

      return {
        fieldId: input.fieldId,
        label: input.label,
        controlType: input.controlType,
        required: input.required,
        options,
        optionSource: options.length ? "live_probe" : "inline",
        listboxId: matchedListbox?.id || "",
        menuSelector: menu?.className ? `.${String(menu.className).split(/\s+/)[0]}` : "",
        currentValue,
        validationErrorText: errorText,
        ariaInvalid,
        hiddenValues,
        ariaControls,
        bindingStatus
      };
    }, {
      fieldId: field.key,
      domId: field.id ?? "",
      label: field.label,
      controlType: field.controlType,
      required: field.required,
      selector: field.selector,
      selectorCandidates: field.selectorCandidates ?? []
    });

    const optionSource = field.options?.length && probed.options.length
      ? "both"
      : probed.options.length
        ? "live_probe"
        : "inline";
    const demographicKind = this.getDemographicFieldKind(normalizeText(field.label));
    const hasCountryCodeOptionLeak = Boolean(
      demographicKind &&
      this.looksLikeCountryCodeOptionSet(probed.options.map((option) => option.text))
    );
    const bindingMismatch = probed.bindingStatus === "mismatch";
    if (bindingMismatch || hasCountryCodeOptionLeak) {
      logger?.info("greenhouse_select_binding_mismatch", {
        fieldId: field.key,
        label: field.label,
        controlType: field.controlType,
        required: field.required,
        listboxId: probed.listboxId || null,
        ariaControls: probed.ariaControls || null,
        bindingStatus: probed.bindingStatus || "none",
        demographicKind: demographicKind ?? null,
        reason: bindingMismatch ? "aria_controls_no_matching_listbox" : "demographic_country_code_option_leak"
      });
    }
    const merged: LiveSelectProbeResult = {
      ...probed,
      optionSource,
      options: hasCountryCodeOptionLeak ? [] : probed.options
    };
    if (hasCountryCodeOptionLeak) {
      merged.optionSource = "inline";
    }
    if (demographicKind) {
      logger?.info("greenhouse_demographic_probe_result", {
        fieldId: field.key,
        label: field.label,
        controlType: field.controlType,
        demographicKind,
        listboxId: merged.listboxId || null,
        ariaControls: merged.ariaControls || null,
        bindingStatus: merged.bindingStatus || "none",
        optionCount: merged.options.length,
        options: merged.options.map((option) => option.text)
      });
    }
    logger?.info("greenhouse_select_live_probe_result", {
      fieldId: field.key,
      label: field.label,
      controlType: field.controlType,
      required: field.required,
      currentValue: merged.currentValue,
      options: merged.options.map((option) => option.text),
      optionSource: merged.optionSource,
      listboxId: merged.listboxId || null,
      menuSelector: merged.menuSelector || null,
      ariaControls: merged.ariaControls || null,
      bindingStatus: merged.bindingStatus || "none",
      errorText: merged.validationErrorText || null,
      ariaInvalid: merged.ariaInvalid ?? false,
      hiddenValues: merged.hiddenValues ?? []
    });
    await page.keyboard.press("Escape").catch(() => undefined);
    return merged;
  }

  private async inspectRequiredValidationState(
    page: AdapterRunContext["page"],
    field: { id: string; label?: string; selector?: string; name?: string }
  ): Promise<RequiredValidationState> {
    return page.evaluate((target) => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const selectors = [
        target.id ? `#${target.id}` : "",
        target.selector || "",
        target.name ? `input[name="${target.name}"], select[name="${target.name}"], textarea[name="${target.name}"]` : ""
      ].filter(Boolean);
      let control: HTMLElement | null = null;
      for (const selector of selectors) {
        const found = document.querySelector(selector) as HTMLElement | null;
        if (found) {
          control = found;
          break;
        }
      }
      if (!control && target.label) {
        const wanted = normalize(target.label).toLowerCase();
        const labelNode = Array.from(document.querySelectorAll("label")).find((candidate) => normalize(candidate.textContent || "").toLowerCase() === wanted);
        const forId = labelNode?.getAttribute("for");
        if (forId) {
          control = document.getElementById(forId) as HTMLElement | null;
        }
      }
      const shell = control?.closest(".select-shell") || control?.closest(".field-wrapper, .input-wrapper, fieldset, li, section");
      const currentValue = normalize(
        (shell?.querySelector(".select__single-value, [class*='singleValue' i]")?.textContent || (control as HTMLInputElement | null)?.value || "")
      );
      const ariaInvalid = Boolean(
        control?.getAttribute("aria-invalid") === "true" ||
        shell?.querySelector("[aria-invalid='true']")
      );
      const hiddenValues = shell
        ? Array.from(shell.querySelectorAll<HTMLInputElement>("input[type='hidden'], input[required][aria-hidden='true'], input.remix-css-1a0ro4n-requiredInput"))
          .map((node) => normalize(node.value || ""))
          .filter(Boolean)
        : [];
      const errorScope = (shell || control?.closest(".field-wrapper, .input-wrapper, fieldset, li, section") || control?.parentElement) as Element | null;
      const errorNodes = errorScope
        ? Array.from(
            errorScope.querySelectorAll<HTMLElement>(
              ".field-error, .error, .invalid-feedback, [role='alert'], [aria-live='polite'], [aria-live='assertive'], [data-qa*='error' i], [id*='error' i]"
            )
          )
        : [];
      let errorText = "";
      for (const node of errorNodes) {
        const text = normalize(node.textContent || "");
        if (!text) continue;
        if (text.toLowerCase().includes("this field is required")) {
          errorText = text.slice(0, 500);
          break;
        }
      }
      return {
        currentValue,
        errorText,
        ariaInvalid,
        hiddenValues
      };
    }, field);
  }

  private async resolveQuestionsWithCache(
    questions: ApplicationQuestion[],
    context: AdapterRunContext,
    jobTitle?: string,
    company?: string,
    companyContext?: string,
    llmOnly = false
  ): Promise<ResolvedAnswer[]> {
    if (!questions.length) return [];
    const resolved = new Map<string, ResolvedAnswer>();
    const unresolved: ApplicationQuestion[] = [];
    const unresolvedKeys = new Map<string, string>();

    for (const question of questions) {
      const cacheKey = buildGreenhouseQuestionCacheKey(question, jobTitle, company);
      const cached = this.aiAnswerCache.get(cacheKey);
      if (cached && (!llmOnly || cached.source === "llm")) {
        resolved.set(question.id, { ...cached, questionId: question.id });
      } else {
        unresolved.push(question);
        unresolvedKeys.set(question.id, cacheKey);
      }
    }

    if (unresolved.length) {
      const aiResolved = await context.aiEngine.resolve(unresolved, {
        profile: context.profile,
        resumeText: context.resumeText,
        jobTitle,
        company,
        companyContext
      });
      for (const answer of aiResolved) {
        if (llmOnly && answer.source !== "llm") {
          continue;
        }
        resolved.set(answer.questionId, answer);
        const cacheKey = unresolvedKeys.get(answer.questionId);
        if (cacheKey && answer.source === "llm") {
          this.aiAnswerCache.set(cacheKey, answer);
        }
      }
    }

    return questions
      .map((question) => resolved.get(question.id))
      .filter((answer): answer is ResolvedAnswer => Boolean(answer));
  }

  private async resolveSingleQuestionWithCache(
    question: ApplicationQuestion,
    context: {
      aiEngine: AdapterRunContext["aiEngine"];
      profile: AdapterRunContext["profile"];
      resumeText: string;
      jobTitle?: string;
      company?: string;
      companyContext?: string;
    }
  ): Promise<string> {
    const cacheKey = buildGreenhouseQuestionCacheKey(question, context.jobTitle, context.company);
    const cached = this.aiAnswerCache.get(cacheKey);
    if (cached) {
      return answerValueToString(cached.value).trim();
    }

    const resolved = await context.aiEngine.resolve([question], {
      profile: context.profile,
      resumeText: context.resumeText,
      jobTitle: context.jobTitle,
      company: context.company,
      companyContext: context.companyContext
    }).catch(() => []);
    const first = resolved[0];
    if (!first) return "";

    this.aiAnswerCache.set(cacheKey, first);
    return answerValueToString(first.value ?? null).trim();
  }

  private async resolveRequiredFreeTextAnswer(input: {
    question: ApplicationQuestion;
    field: FieldDescriptor;
    initialResolved?: ResolvedAnswer;
    context: AdapterRunContext;
    result: JobRunResult;
    jobTitle?: string;
    company?: string;
    companyContext?: string;
  }): Promise<{
    answer: string;
    source: ResolvedAnswer["source"];
    reason?: string;
    generationSource: FreeTextGenerationSource;
    semanticClass: TextFieldSemantic;
    constraints: TextInputConstraintSnapshot | null;
    usedFallback: boolean;
  }> {
    const { question, field, initialResolved, context, result, jobTitle, company, companyContext } = input;
    const semanticClass = detectTextFieldSemantic(
      question.label,
      question.placeholder,
      this.questionDescription(question)
    );
    const domId = typeof question.platformMeta?.domId === "string" ? (question.platformMeta.domId as string) : field.id;
    const selector = typeof question.platformMeta?.selector === "string" ? (question.platformMeta.selector as string) : field.selector;
    const selectorCandidates = Array.isArray(question.platformMeta?.selectorCandidates)
      ? (question.platformMeta.selectorCandidates as string[])
      : field.selectorCandidates;

    let source: ResolvedAnswer["source"] = initialResolved?.source ?? "llm";
    let reason = initialResolved?.reason ?? "llm_batch";
    let generationSource: FreeTextGenerationSource = "llm";
    let answer = answerValueToString(initialResolved?.value ?? null).trim();

    if (this.isDisallowedRequiredTextAnswer(answer, context.config)) {
      answer = "";
    }

    const generationPayload = {
      fieldId: field.key,
      label: question.label,
      semanticClass,
      answer,
      answerLength: answer.length
    };
    this.logGreenhouseEvent(context, "greenhouse_free_text_generation", generationPayload);
    this.recordLlmEvent(result, "greenhouse_free_text_generation", {
      platform: "greenhouse",
      phase: "phase_b",
      fieldId: field.key,
      label: question.label,
      source,
      hasValue: Boolean(answer),
      value: answer,
      metadata: generationPayload
    });

    if (!answer) {
      const retryQuestion = this.buildRequiredTextRetryQuestion(question);
      const retryAnswer = await this.resolveSingleQuestionWithCache(retryQuestion, {
        aiEngine: context.aiEngine,
        profile: context.profile,
        resumeText: context.resumeText,
        jobTitle,
        company,
        companyContext
      });
      let retryValue = retryAnswer.trim();
      if (this.isDisallowedRequiredTextAnswer(retryValue, context.config)) retryValue = "";
      this.logGreenhouseEvent(context, "greenhouse_free_text_retry", {
        fieldId: field.key,
        label: question.label,
        semanticClass,
        retryReason: "initial_empty",
        answerLength: retryValue.length
      });
      this.recordLlmEvent(result, "greenhouse_free_text_retry", {
        platform: "greenhouse",
        phase: "phase_b",
        fieldId: field.key,
        label: question.label,
        source: "llm",
        hasValue: Boolean(retryValue),
        value: retryValue,
        metadata: {
          semanticClass,
          retryReason: "initial_empty",
          answerLength: retryValue.length
        }
      });
      if (retryValue) {
        answer = retryValue;
        source = "llm";
        reason = "llm_single_retry_text";
        generationSource = "retry";
      }
    }

    let constraints = await this.inspectTextInputConstraints(context.page, {
      id: domId ?? field.key,
      name: field.name,
      selector,
      selectorCandidates,
      label: question.label
    });
    if (semanticClass === "compensation" && answer) {
      answer = this.normalizeCompensationAnswerForConstraints(answer, constraints);
    }
    if (constraints?.maxlength && answer.length > constraints.maxlength) {
      answer = answer.slice(0, constraints.maxlength);
    }
    if (this.isDisallowedRequiredTextAnswer(answer, context.config)) {
      answer = "";
    }

    let usedFallback = false;
    if (!answer) {
      usedFallback = true;
      generationSource = "fallback";
      source = "fallback";
      reason = `${semanticClass}_fallback`;
      answer = this.pickRequiredTextFallback(semanticClass, constraints, context.profile, context.config);
      if (semanticClass === "compensation") {
        answer = this.normalizeCompensationAnswerForConstraints(answer, constraints);
      }
      if (constraints?.maxlength && answer.length > constraints.maxlength) {
        answer = answer.slice(0, constraints.maxlength);
      }
      this.logGreenhouseEvent(context, "greenhouse_free_text_fallback", {
        fieldId: field.key,
        label: question.label,
        semanticClass,
        answer,
        answerLength: answer.length,
        inputType: constraints?.inputType || "",
        pattern: constraints?.pattern || "",
        inputmode: constraints?.inputmode || "",
        min: constraints?.min || "",
        max: constraints?.max || "",
        step: constraints?.step || "",
        maxlength: constraints?.maxlength
      });
      this.recordLlmEvent(result, "greenhouse_free_text_fallback", {
        platform: "greenhouse",
        phase: "phase_b",
        fieldId: field.key,
        label: question.label,
        source,
        hasValue: Boolean(answer),
        value: answer,
        metadata: {
          semanticClass,
          generationSource,
          inputType: constraints?.inputType || "",
          pattern: constraints?.pattern || "",
          inputmode: constraints?.inputmode || "",
          min: constraints?.min || "",
          max: constraints?.max || "",
          step: constraints?.step || "",
          maxlength: constraints?.maxlength
        }
      });
    }

    if (semanticClass === "compensation") {
      this.logGreenhouseEvent(context, "greenhouse_compensation_answer_selected", {
        fieldId: field.key,
        label: question.label,
        answer,
        answerLength: answer.length,
        semanticClass,
        generationSource,
        inputType: constraints?.inputType || "",
        pattern: constraints?.pattern || "",
        inputmode: constraints?.inputmode || "",
        min: constraints?.min || "",
        max: constraints?.max || "",
        step: constraints?.step || "",
        maxlength: constraints?.maxlength
      });
      this.recordLlmEvent(result, "greenhouse_compensation_answer_selected", {
        platform: "greenhouse",
        phase: "phase_b",
        fieldId: field.key,
        label: question.label,
        source,
        hasValue: Boolean(answer),
        value: answer,
        metadata: {
          semanticClass,
          generationSource,
          inputType: constraints?.inputType || "",
          pattern: constraints?.pattern || "",
          inputmode: constraints?.inputmode || ""
        }
      });
    }

    return { answer, source, reason, generationSource, semanticClass, constraints, usedFallback };
  }

  private buildDeterministicProfileAnswers(
    questions: ApplicationQuestion[],
    profile: AdapterRunContext["profile"],
    resumePath?: string
  ): Map<string, ResolvedAnswer> {
    const out = new Map<string, ResolvedAnswer>();
    const phone = this.splitPhone(profile.basics.phone).local;
    const edu = this.primaryEducation(profile);
    for (const question of questions) {
      const label = normalizeText(question.label);
      const id = normalizeText(question.id);
      let value = "";
      if (/first.?name/.test(label) || id === "first_name") value = profile.basics.firstName || "";
      else if (/last.?name/.test(label) || id === "last_name") value = profile.basics.lastName || "";
      else if (label === "name" || id === "name") value = profile.basics.fullName || `${profile.basics.firstName} ${profile.basics.lastName}`.trim();
      else if (/email/.test(label) || id === "email") value = profile.basics.email || "";
      else if (/phone/.test(label) && !/country|code|dial/.test(label)) value = phone || "";
      else if (/country code|dial code|phone country/.test(label)) value = "+1";
      else if (/linkedin/.test(label)) value = profile.links?.linkedin || "";
      else if (/github/.test(label)) value = profile.links?.github || "";
      else if (/(website|portfolio|personal site)/.test(label)) value = profile.links?.website || profile.links?.portfolio || "";
      else if (this.shouldDeterministicallyMapSchool(label, question)) value = edu.school || edu.university || "";
      else if (/degree/.test(label)) value = edu.highestDegree || edu.degree || "";
      else if (/major|field of study|discipline/.test(label)) value = edu.field || edu.discipline || "";
      else if (/start date month/.test(label)) value = edu.startMonth || "";
      else if (/end date month/.test(label)) value = edu.endMonth || "";
      else if (/start date year/.test(label)) value = edu.startYear || "";
      else if (/end date year|graduation year/.test(label)) value = edu.endYear || edu.graduationYear || "";
      else if (/graduation|graduated|end date/.test(label)) value = edu.graduationYear || edu.endYear || "";
      else if (this.isExportControlPrompt(label)) {
        const isUsPerson = this.deriveUsPersonStatus(profile);
        if (typeof isUsPerson === "boolean") {
          const optionPool = question.options ?? [];
          value = this.pickExportControlOption(optionPool, isUsPerson) ?? (isUsPerson ? "Yes" : "No");
        }
      }
      else if (/authorized to work|legally eligible|right to work/.test(label)) {
        if (typeof profile.workAuthorization?.authorizedToWork === "boolean") value = profile.workAuthorization.authorizedToWork ? "Yes" : "No";
      } else if (/require sponsorship|need sponsorship|visa sponsorship/.test(label)) {
        if (typeof profile.workAuthorization?.requiresSponsorship === "boolean") value = profile.workAuthorization.requiresSponsorship ? "Yes" : "No";
      } else if (question.options?.length) {
        const demographicMapped = this.mapDemographicAnswer(question, question.options, profile);
        if (demographicMapped) value = demographicMapped;
      } else if (/resume|cv/.test(label) && resumePath) {
        value = path.basename(resumePath);
      }
      if (!value) continue;
      out.set(question.id, {
        questionId: question.id,
        value,
        source: "profile",
        reason: "deterministic_profile"
      });
    }
    return out;
  }

  private deriveUsPersonStatus(profile: AdapterRunContext["profile"]): boolean | undefined {
    if (typeof profile.exportControl?.usPerson === "boolean") return profile.exportControl.usPerson;
    if (profile.workAuthorization?.usCitizen === true || profile.workAuthorization?.permanentResident === true) return true;
    if (profile.workAuthorization?.usCitizen === false && profile.workAuthorization?.permanentResident === false) return false;
    if (profile.workAuthorization?.authorizedToWork === true && profile.workAuthorization?.requiresSponsorship === false) return true;
    return undefined;
  }

  private isExportControlPrompt(normalizedLabel: string): boolean {
    return (
      /export control/.test(normalizedLabel) ||
      /u\.?s\.? government space technology export regulations/.test(normalizedLabel) ||
      /\bitar\b/.test(normalizedLabel) ||
      /\bear\b/.test(normalizedLabel) ||
      /u\.?s\.? person/.test(normalizedLabel) ||
      /citizen or permanent resident/.test(normalizedLabel)
    );
  }

  private pickExportControlOption(optionPool: string[], isUsPerson: boolean): string | undefined {
    if (!optionPool.length) return undefined;
    const normalizedOptions = optionPool.map((option) => ({ raw: option, normalized: normalizeText(option) }));
    if (isUsPerson) {
      return normalizedOptions.find((option) =>
        /\byes\b|\bu\.?s\.? person\b|citizen|permanent resident|national of the united states|authorized.*without.*sponsorship|lawful permanent resident/.test(option.normalized)
      )?.raw;
    }
    return normalizedOptions.find((option) =>
      /\bno\b|not a u\.?s\.? person|none of the above|requires sponsorship|work visa/.test(option.normalized)
    )?.raw;
  }

  private shouldDeterministicallyMapSchool(normalizedLabel: string, question: ApplicationQuestion): boolean {
    const disallowed = /\bproject\b|\bdescribe\b|\bexperience\b|\bexplain\b|\btell us\b|\bwhy\b|\bchallenge\b|\btechnical\b|\bcomplex\b/;
    if (disallowed.test(normalizedLabel)) return false;
    if (question.type === "textarea") return false;
    if (normalizedLabel.length > 70) return false;
    const exactSchoolLabels = new Set(["school", "university", "college", "institution", "education institution"]);
    if (exactSchoolLabels.has(normalizedLabel)) return true;
    return /^school\b|^university\b|^college\b|^institution\b|^education institution\b/.test(normalizedLabel);
  }

  private isNarrativeEducationLeak(
    normalizedLabel: string,
    question: ApplicationQuestion,
    answer: string,
    profile: AdapterRunContext["profile"]
  ): boolean {
    if (!answer) return false;
    const disallowed = /\bproject\b|\bdescribe\b|\bexperience\b|\bexplain\b|\btell us\b|\bwhy\b|\bchallenge\b|\btechnical\b|\bcomplex\b/;
    if (!disallowed.test(normalizedLabel) && question.type !== "textarea") return false;
    const edu = this.primaryEducation(profile);
    const school = normalizeText(edu.school || edu.university || "");
    if (!school) return false;
    return normalizeText(answer) === school;
  }

  private isNarrativePrompt(normalizedLabel: string): boolean {
    return /\bproject\b|\bdescribe\b|\bexperience\b|\bexplain\b|\btell us\b|\bchallenge\b|\bcomplex\b|\baccomplishment\b/.test(normalizedLabel);
  }

  private narrativeFallbackAnswer(profile: AdapterRunContext["profile"]): string {
    const customProject = profile.customAnswers?.["project summary"];
    if (typeof customProject === "string" && customProject.trim()) return customProject.trim();
    const summary = profile.experience?.summary?.trim();
    if (summary) return summary;
    return "I built production-grade software systems, collaborated cross-functionally, and delivered measurable impact through ownership of complex technical projects.";
  }

  private primaryEducation(profile: AdapterRunContext["profile"]): Record<string, string | undefined> {
    if (Array.isArray(profile.education)) {
      const first = profile.education[0] ?? {};
      return {
        school: first.school,
        degree: first.degree,
        discipline: first.discipline,
        field: first.field,
        startMonth: first.startMonth,
        startYear: first.startYear,
        endMonth: first.endMonth,
        endYear: first.endYear,
        graduationYear: first.graduationYear
      };
    }
    return profile.education ?? {};
  }

  private async fillConfiguredFields(context: AdapterRunContext): Promise<FilledFieldRecord[]> {
    const { page, profile, config } = context;
    const greenhouse = config.greenhouse;
    const filled: FilledFieldRecord[] = [];

    for (const field of greenhouse?.fileValues ?? []) {
      const uploaded = await this.setFileInputById(page, field.id, field.path).catch(() => false);
      if (uploaded) {
        this.upsertFilledField(filled, {
          id: field.id,
          label: field.id,
          value: path.basename(field.path),
          source: "seeded",
          inputKind: "file"
        });
      }
    }

    if (config.resumePath) {
      const uploadResult = await this.uploadResumeWithRecoveryFlow(page, config.resumePath).catch(() =>
        this.emptyResumeVerificationResult()
      );
      if (uploadResult.ok) {
        this.upsertFilledField(filled, {
          id: "resume",
          label: "Resume",
          value: path.basename(config.resumePath),
          source: "seeded",
          inputKind: "file"
        });
      }
    }

    for (const field of greenhouse?.textValues ?? []) {
      const set = await this.setValueById(page, field.id, field.value).catch(() => false);
      if (set) {
        this.upsertFilledField(filled, {
          id: field.id,
          label: field.id,
          value: field.value,
          source: "seeded",
          inputKind: "text"
        });
      }
    }

    for (const field of greenhouse?.textareaValues ?? []) {
      const set = await this.setValueById(page, field.id, field.value).catch(() => false);
      if (set) {
        this.upsertFilledField(filled, {
          id: field.id,
          label: field.id,
          value: field.value,
          source: "seeded",
          inputKind: "textarea"
        });
      }
    }

    for (const field of greenhouse?.selectValues ?? []) {
      const selected = await this.selectReactOption(page, field.id, field.value).catch(async () => {
        return this.selectNativeOption(page, field.id, field.value).catch(() => false);
      });
      if (selected) {
        this.upsertFilledField(filled, {
          id: field.id,
          label: field.id,
          value: field.value,
          source: "seeded",
          inputKind: "select"
        });
      }
    }

    const fullName = profile.basics.fullName ?? `${profile.basics.firstName} ${profile.basics.lastName}`.trim();
    const phoneParts = this.splitPhone(profile.basics.phone);
    const directMap: Array<[string, string | undefined]> = [
      ["name", fullName],
      ["first_name", profile.basics.firstName],
      ["preferred_name", profile.basics.firstName],
      ["last_name", profile.basics.lastName],
      ["email", profile.basics.email]
    ];

    for (const [id, value] of directMap) {
      if (!value) continue;
      const set = await this.setIdentityValueById(page, id, value).catch(() => false);
      if (set) {
        this.upsertFilledField(filled, {
          id,
          label: this.humanizeId(id),
          value,
          source: "seeded",
          inputKind: "text"
        });
      }
    }

    if (phoneParts.local) {
      const phoneSet = await this.setIdentityValueById(page, "phone", phoneParts.local).catch(() => false)
        || await this.fillByLabelOrSelector(page, phoneParts.local, /phone/i, [
          "#phone",
          "input[name='phone']",
          'input[name*="phone" i]',
          'input[id*="phone" i]',
          'input[autocomplete*="tel" i]'
        ]);
      if (phoneSet) {
        this.upsertFilledField(filled, {
          id: "phone",
          label: "Phone",
          value: phoneParts.local,
          source: "seeded",
          inputKind: "text"
        });
      }
    }

    if (phoneParts.countryCode === "+1") {
      const countrySet = await this.selectCountryCodeUS(page);
      if (countrySet) {
        this.upsertFilledField(filled, {
          id: "country_code",
          label: "Country Code",
          value: phoneParts.countryCode,
          source: "seeded",
          inputKind: "select"
        });
      }
    }

    if (profile.country) {
      const countryCandidates = this.countryOptionCandidates(profile.country);
      const countryControl = this.locatorById(page, "country").first();
      const countryIsCombobox = await countryControl
        .evaluate(
          (element) =>
            element.getAttribute("role") === "combobox" ||
            element.getAttribute("aria-autocomplete") === "list" ||
            Boolean(element.closest(".select-shell"))
        )
        .catch(() => false);

      let countrySet = false;
      if (countryIsCombobox) {
        for (const candidate of countryCandidates) {
          countrySet = await this.selectReactOptionByIdPrefix(page, "country", candidate).catch(() => false);
          if (countrySet) break;
          countrySet = await this.selectReactOption(page, "country", candidate).catch(() => false);
          if (countrySet) break;
        }
        if (!countrySet) {
          countrySet = await this.selectComboboxByMissingField(page, {
            id: "country",
            label: "Country",
            role: "combobox",
            tag: "input"
          }, countryCandidates);
        }
      } else {
        for (const candidate of countryCandidates) {
          countrySet = await this.selectReactOption(page, "country", candidate).catch(() => false);
          if (countrySet) break;
          countrySet = await this.fillByLabelOrSelector(page, candidate, /^country$/i, [
            '#country',
            'input[id=\"country\"]',
            'input[name=\"country\"]',
            'select[id=\"country\"]',
            'select[name=\"country\"]'
          ]);
          if (countrySet) break;
        }
      }

      if (countrySet) {
        await this.syncCountryHiddenInput(page, countryCandidates[0] ?? profile.country).catch(() => undefined);
      }

      if (countrySet) {
        this.upsertFilledField(filled, {
          id: "country",
          label: "Country",
          value: countryCandidates[0] ?? profile.country,
          source: "seeded",
          inputKind: "select"
        });
      }
    }

    if (profile.links?.linkedin) {
      const set = await this.fillByLabelOrSelector(page, profile.links.linkedin, /linkedin/i, [
        '[autocomplete*="linkedin" i]',
        'input[name*="linkedin" i]',
        'input[id*="linkedin" i]',
        'input[placeholder*="linkedin" i]'
      ]);
      if (set) {
        this.upsertFilledField(filled, {
          id: "linkedin",
          label: "LinkedIn",
          value: profile.links.linkedin,
          source: "seeded",
          inputKind: "text"
        });
      }
    }

    if (profile.links?.github) {
      const set = await this.fillByLabelOrSelector(page, profile.links.github, /github/i, [
        'input[name*="github" i]',
        'input[id*="github" i]',
        'input[placeholder*="github" i]'
      ]);
      if (set) {
        this.upsertFilledField(filled, {
          id: "github",
          label: "GitHub",
          value: profile.links.github,
          source: "seeded",
          inputKind: "text"
        });
      }
    }

    if (profile.links?.portfolio || profile.links?.website) {
      const portfolio = profile.links.portfolio ?? profile.links.website ?? "";
      const set = await this.fillByLabelOrSelector(page, portfolio, /(portfolio|website|personal site|personal url)/i, [
        'input[name*="portfolio" i]',
        'input[id*="portfolio" i]',
        'input[name*="website" i]',
        'input[id*="website" i]',
        'input[placeholder*="portfolio" i]',
        'input[placeholder*="website" i]'
      ]);
      if (set) {
        this.upsertFilledField(filled, {
          id: "portfolio",
          label: "Portfolio/Website",
          value: portfolio,
          source: "seeded",
          inputKind: "text"
        });
      }
    }

    const educationFilled = await this.fillGreenhouseEducation(page, profile).catch(() => [] as FilledFieldRecord[]);
    for (const entry of educationFilled) {
      this.upsertFilledField(filled, entry);
    }

    return filled;
  }

  private async fillGreenhouseEducation(
    page: AdapterRunContext["page"],
    profile: AdapterRunContext["profile"]
  ): Promise<FilledFieldRecord[]> {
    const edu = this.primaryEducation(profile);
    const hasEducationForm = await page.locator(".education--form").first().count().catch(() => 0);
    if (!hasEducationForm) return [];
    const filled: FilledFieldRecord[] = [];

    const reactSelectPairs: Array<{ id: string; value?: string; label: string }> = [
      { id: "school--0", value: edu.school, label: "School" },
      { id: "degree--0", value: this.normalizeEducationDegreeValue(edu.degree ?? edu.highestDegree), label: "Degree" },
      { id: "discipline--0", value: edu.discipline ?? edu.field, label: "Discipline" },
      { id: "start-month--0", value: edu.startMonth, label: "Start date month" },
      { id: "end-month--0", value: edu.endMonth, label: "End date month" }
    ];
    for (const pair of reactSelectPairs) {
      if (!pair.value) continue;
      const ok = await this.fillGreenhouseReactSelect(page, pair.id, pair.value).catch(() => false);
      if (!ok) continue;
      filled.push({
        id: pair.id,
        label: pair.label,
        value: pair.value,
        source: "profile",
        inputKind: "combobox"
      });
    }

    const yearPairs: Array<{ id: string; value?: string; label: string }> = [
      { id: "start-year--0", value: edu.startYear, label: "Start date year" },
      { id: "end-year--0", value: edu.endYear ?? edu.graduationYear, label: "End date year" }
    ];
    for (const pair of yearPairs) {
      if (!pair.value) continue;
      const ok = await this.setValueById(page, pair.id, pair.value).catch(() => false);
      if (!ok) continue;
      const verified = await this.readInputValue(page, pair.id).then((value) => normalizeText(value) === normalizeText(pair.value || "")).catch(() => false);
      if (!verified) continue;
      filled.push({
        id: pair.id,
        label: pair.label,
        value: pair.value,
        source: "profile",
        inputKind: "text"
      });
    }

    return filled;
  }

  private normalizeEducationDegreeValue(raw: string | undefined): string | undefined {
    const normalized = normalizeText(raw || "");
    if (!normalized) return raw;
    if (/\bb\.?\s*s\.?\b|\bbachelor\b/.test(normalized)) return "Bachelor's";
    if (/\bm\.?\s*s\.?\b|\bmaster\b|\bmba\b/.test(normalized)) return "Master's";
    if (/\bassociate\b/.test(normalized)) return "Associate's";
    if (/\bphd\b|doctor|jd\b/.test(normalized)) return "Doctorate";
    return raw;
  }

  private async fillGreenhouseReactSelect(
    page: AdapterRunContext["page"],
    inputId: string,
    query: string,
    targetOption?: string
  ): Promise<boolean> {
    const input = page.locator(`#${inputId}`).first();
    if (!(await input.count().catch(() => 0))) return false;
    const container = input.locator('xpath=ancestor::div[contains(@class,"select__container")]').first();
    await container.locator(".select__control").click().catch(async () => {
      await input.click({ force: true }).catch(() => undefined);
    });
    await input.fill("").catch(() => undefined);
    await input.type(query, { delay: 12 }).catch(() => undefined);
    await page.locator('[role="option"]').first().waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
    const wanted = targetOption || query;
    await page.keyboard.press("ArrowDown").catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
    await page.waitForTimeout(140).catch(() => undefined);
    if (await this.verifyReactSelectSelected(container, wanted)) {
      return true;
    }
    const option = page.locator('[role="option"]').filter({ hasText: new RegExp(escapeRegExp(wanted), "i") }).first();
    const optionCount = await option.count().catch(() => 0);
    if (optionCount) {
      await option.click().catch(() => undefined);
    } else {
      const best = await this.findBestVisibleOption(page, wanted);
      if (!best) return false;
      await best.click().catch(() => undefined);
    }
    await page.waitForTimeout(120).catch(() => undefined);
    return this.verifyReactSelectSelected(container, wanted);
  }

  private async findBestVisibleOption(
    page: AdapterRunContext["page"],
    wanted: string
  ): Promise<ReturnType<AdapterRunContext["page"]["locator"]> | null> {
    const options = page.locator('[role="option"]');
    const count = await options.count().catch(() => 0);
    if (!count) return null;
    const texts: string[] = [];
    for (let i = 0; i < count; i += 1) {
      texts.push(await options.nth(i).innerText().catch(() => ""));
    }
    const picked = pickBestOption(wanted, texts.filter(Boolean));
    const index = texts.findIndex((item) => normalizeText(item) === normalizeText(picked));
    if (index >= 0) return options.nth(index);
    return options.first();
  }

  private async verifyReactSelectSelected(
    container: ReturnType<AdapterRunContext["page"]["locator"]>,
    expected: string
  ): Promise<boolean> {
    const selectedText = await container
      .locator(".select__single-value, .select__value-container")
      .first()
      .innerText()
      .catch(() => "");
    const normalizedSelected = normalizeText(selectedText);
    const normalizedExpected = normalizeText(expected);
    return Boolean(
      normalizedSelected &&
      !isPlaceholderOption(normalizedSelected) &&
      (normalizedSelected === normalizedExpected ||
        normalizedSelected.includes(normalizedExpected) ||
        normalizedExpected.includes(normalizedSelected))
    );
  }

  private async extractJobContext(
    page: AdapterRunContext["page"],
    url: string
  ): Promise<{ jobTitle?: string; company?: string; companyContext?: string }> {
    const extracted = await page.evaluate(() => {
      const jobTitle =
        (document.querySelector("h1")?.textContent ?? "").trim() ||
        (document.querySelector(".posting-headline h2")?.textContent ?? "").trim() ||
        (document.querySelector("[data-qa='job-title']")?.textContent ?? "").trim();

      const company =
        (document.querySelector("span[class*='company'], div[class*='company']")?.textContent ?? "").trim() ||
        (document.querySelector(".posting-categories .sort-by-team")?.textContent ?? "").trim() ||
        (document.querySelector('meta[property="og:site_name"]') as HTMLMetaElement | null)?.content ||
        "";

      const contextCandidates = [
        document.querySelector(".job__description")?.textContent ?? "",
        document.querySelector(".description")?.textContent ?? "",
        document.querySelector("article")?.textContent ?? "",
        document.querySelector("main")?.textContent ?? "",
        document.querySelector('meta[name="description"]')?.getAttribute("content") ?? ""
      ]
        .map((value) => value.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const companyContext = contextCandidates.find((value) => value.length >= 80)?.slice(0, 1400) ?? "";

      return { jobTitle, company, companyContext };
    });

    const fallbackCompany = (() => {
      const match = url.match(/greenhouse\.io\/([^/]+)/i);
      return match?.[1] || "";
    })();

    return {
      jobTitle: extracted.jobTitle || undefined,
      company: extracted.company || fallbackCompany || undefined,
      companyContext: extracted.companyContext || undefined
    };
  }

  private async scanFieldDescriptors(page: AdapterRunContext["page"]): Promise<FieldDescriptor[]> {
    const schemas = await this.extractGreenhouseFieldSchemas(page);
    const mapped: FieldDescriptor[] = schemas.map((schema, index) => {
      const normalizedType: FieldControlType = (() => {
        if (schema.fieldType === "textarea") return "textarea";
        if (schema.fieldType === "date") return "date";
        if (schema.fieldType === "radio") return "radio-group";
        if (schema.fieldType === "checkbox_group") return "checkbox-group";
        if (schema.fieldType === "react_select" || schema.fieldType === "phone_country") return "combobox";
        if (schema.fieldType === "unknown") return "text";
        return "text";
      })();
      const fieldId = schema.fieldId || `field_${index}`;
      const selector = schema.containerMeta.controlId ? `#${schema.containerMeta.controlId}` : (schema.containerMeta.containerSelector || "input");
      const selectorCandidates = [
        schema.containerMeta.controlId ? `#${schema.containerMeta.controlId}` : "",
        schema.containerMeta.controlName ? `input[name="${schema.containerMeta.controlName}"]` : "",
        schema.containerMeta.containerSelector || ""
      ].filter(Boolean);
      return {
        key: fieldId,
        id: normalizedType === "radio-group" || normalizedType === "checkbox-group"
          ? fieldId
          : schema.containerMeta.controlId || fieldId,
        name: schema.containerMeta.controlName,
        label: schema.label || this.humanizeId(fieldId),
        required: schema.required,
        invalid: false,
        controlType: normalizedType,
        options: schema.possibleAnswers,
        optionHints: schema.possibleAnswers,
        optionMeta: schema.optionMeta,
        fieldContext: schema.htmlSummary,
        selector: (normalizedType === "radio-group" || normalizedType === "checkbox-group") && schema.containerMeta.controlName
          ? `input[type="${normalizedType === "radio-group" ? "radio" : "checkbox"}"][name="${schema.containerMeta.controlName.replace(/"/g, '\\"')}"]`
          : selector,
        selectorCandidates: (normalizedType === "radio-group" || normalizedType === "checkbox-group") && schema.containerMeta.controlName
          ? [
              `input[type="${normalizedType === "radio-group" ? "radio" : "checkbox"}"][name="${schema.containerMeta.controlName.replace(/"/g, '\\"')}"]`,
              ...selectorCandidates
            ]
          : selectorCandidates
      };
    });
    return mapped;
  }

  private async extractGreenhouseFieldSchemas(page: AdapterRunContext["page"]): Promise<GreenhouseFieldSchema[]> {
    return page.evaluate(() => {
      type BrowserSchema = GreenhouseFieldSchema;
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const keyify = (value: string): string => normalize(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      const isVisible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const unique = (values: string[]): string[] => Array.from(new Set(values.map((v) => normalize(v)).filter(Boolean)));
      const pickContainer = (control: Element): Element => (
        control.closest(".field-wrapper, .input-wrapper, .select__container, fieldset, .phone-input, .education--form, .eeoc__question__wrapper, .resume, [class*='resume' i]") ||
        control.closest("div, li, section, form") ||
        control.parentElement ||
        control
      );
      const labelForControl = (control: Element): string => {
        const html = control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        if (html.id) {
          const explicit = document.querySelector(`label[for="${CSS.escape(html.id)}"]`);
          const explicitText = normalize(explicit?.textContent || "");
          if (explicitText) return explicitText.replace(/\*/g, "");
        }
        const wrapped = control.closest("label");
        const wrappedText = normalize(wrapped?.textContent || "");
        if (wrappedText) return wrappedText.replace(/\*/g, "");
        const labelledBy = (control.getAttribute("aria-labelledby") || "").trim();
        if (labelledBy) {
          const target = document.getElementById(labelledBy.split(/\s+/)[0] || "");
          const targetText = normalize(target?.textContent || "");
          if (targetText) return targetText.replace(/\*/g, "");
        }
        const legend = control.closest("fieldset")?.querySelector("legend");
        const legendText = normalize(legend?.textContent || "");
        if (legendText) return legendText.replace(/\*/g, "");
        return normalize(control.getAttribute("aria-label") || "").replace(/\*/g, "");
      };
      const fieldIdFrom = (control: Element, label: string): string => {
        const html = control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        if (html.id) return html.id;
        const fromLabel = (label && control instanceof HTMLElement)
          ? Array.from(document.querySelectorAll("label")).find((item) => normalize(item.textContent || "") === normalize(label))?.getAttribute("for")
          : "";
        if (fromLabel) return fromLabel;
        const labelledBy = (control.getAttribute("aria-labelledby") || "").trim();
        if (labelledBy) return labelledBy.split(/\s+/)[0] || "";
        return keyify(label) || `field_${Math.random().toString(16).slice(2, 8)}`;
      };
      const detectType = (control: Element, label: string): GreenhouseFieldType => {
        if (control instanceof HTMLTextAreaElement) return "textarea";
        if (control instanceof HTMLSelectElement) return /country.*phone|dial code/i.test(label) ? "phone_country" : "unknown";
        if (control instanceof HTMLInputElement && control.type === "file") return "file";
        if (control instanceof HTMLInputElement && control.type === "date") return "date";
        if (control instanceof HTMLInputElement && control.type === "radio") return "radio";
        if (control instanceof HTMLInputElement && control.type === "checkbox") return "checkbox_group";
        const role = (control.getAttribute("role") || "").toLowerCase();
        if (role === "combobox" || control.getAttribute("aria-autocomplete") === "list" || control.closest(".select-shell")) {
          return /country.*phone|dial code/i.test(label) ? "phone_country" : "react_select";
        }
        const nameBlob = `${(control as HTMLInputElement).name || ""} ${(control as HTMLInputElement).id || ""}`.toLowerCase();
        if (/phone/.test(nameBlob)) return "phone";
        return "text";
      };
      const selectorForControl = (control: HTMLInputElement): string => {
        if (control.id) return `#${CSS.escape(control.id)}`;
        if (control.name) return `input[type="${control.type}"][name="${control.name.replace(/"/g, '\\"')}"]`;
        return `input[type="${control.type}"]`;
      };
      const optionLabelForInput = (input: HTMLInputElement): string => {
        const explicit = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
        const explicitText = normalize(explicit?.textContent || "");
        if (explicitText) return explicitText.replace(/\*/g, "");
        const wrapping = input.closest("label");
        const wrappingText = normalize(wrapping?.textContent || "");
        if (wrappingText) return wrappingText.replace(/\*/g, "");
        return normalize(input.value || "").replace(/\*/g, "");
      };
      const parentQuestionLabelForGroup = (
        input: HTMLInputElement,
        optionLabels: string[]
      ): string => {
        const optionSet = new Set(optionLabels.map((value) => normalize(value)));
        const fieldset = input.closest("fieldset");
        const legendText = normalize(fieldset?.querySelector("legend")?.textContent || "").replace(/\*/g, "");
        if (legendText && !optionSet.has(normalize(legendText))) return legendText;
        const container = input.closest(".field-wrapper, .input-wrapper, .checkbox, .radio, [data-qa], section, li, div");
        if (container) {
          const candidates = Array.from(
            container.querySelectorAll<HTMLElement>(
              ".checkbox__description, .radio__description, legend, .label, [id$='-description'], [data-qa*='question' i], h1, h2, h3, p"
            )
          );
          for (const candidate of candidates) {
            const text = normalize(candidate.textContent || "").replace(/\*/g, "");
            if (!text) continue;
            if (optionSet.has(normalize(text))) continue;
            if (text.length <= 2) continue;
            return text;
          }
        }
        return labelForControl(input) || "Required field";
      };
      const groupBaseKey = (input: HTMLInputElement): string => {
        const name = (input.name || "").trim();
        if (name) return name;
        const id = (input.id || "").trim();
        if (!id) return "";
        const bracketMatch = id.match(/^(.+\[\])_[^_]+$/);
        if (bracketMatch?.[1]) return bracketMatch[1];
        const numericSuffix = id.match(/^(.+)_\d+$/);
        if (numericSuffix?.[1]) return numericSuffix[1];
        return id;
      };
      const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        "form input, form textarea, form select, form [role='combobox']"
      ));
      const schemas: BrowserSchema[] = [];
      const seen = new Set<string>();
      const groupedChoiceControls = new Map<string, {
        fieldType: GreenhouseFieldType;
        fieldId: string;
        first: HTMLInputElement;
        required: boolean;
        invalid: boolean;
        options: string[];
        optionMeta: Array<{
          id?: string;
          name?: string;
          value?: string;
          label: string;
          selector: string;
          checked: boolean;
        }>;
      }>();
      for (const control of controls) {
        if (!isVisible(control)) continue;
        if (control instanceof HTMLInputElement && ["hidden", "submit", "button", "reset", "image"].includes(control.type)) continue;
        if ((control as HTMLElement).id?.startsWith("iti-")) continue;
        if (control instanceof HTMLInputElement && (control.type === "radio" || control.type === "checkbox")) {
          const fieldId = groupBaseKey(control) || `group_${control.type}_${schemas.length}`;
          const key = `${control.type}:${fieldId}`;
          const label = optionLabelForInput(control);
          const required =
            control.required ||
            control.getAttribute("aria-required") === "true" ||
            control.getAttribute("data-required") === "true" ||
            Boolean(control.closest("[aria-required='true'], .required, .requiredInput, .label--required"));
          const invalid =
            control.getAttribute("aria-invalid") === "true" ||
            Boolean(control.closest("fieldset")?.querySelector("[aria-invalid='true']"));
          const existing = groupedChoiceControls.get(key);
          if (!existing) {
            groupedChoiceControls.set(key, {
              fieldType: control.type === "radio" ? "radio" : "checkbox_group",
              fieldId,
              first: control,
              required,
              invalid,
              options: label ? [label] : [],
              optionMeta: [{
                id: control.id || undefined,
                name: control.name || undefined,
                value: control.value || undefined,
                label,
                selector: selectorForControl(control),
                checked: Boolean(control.checked)
              }]
            });
          } else {
            if (label) existing.options.push(label);
            existing.required = existing.required || required;
            existing.invalid = existing.invalid || invalid;
            existing.optionMeta.push({
              id: control.id || undefined,
              name: control.name || undefined,
              value: control.value || undefined,
              label,
              selector: selectorForControl(control),
              checked: Boolean(control.checked)
            });
          }
          continue;
        }
        const label = labelForControl(control);
        const container = pickContainer(control);
        const required = Boolean(
          (control as HTMLInputElement).required ||
          control.getAttribute("aria-required") === "true" ||
          control.closest(".required, .requiredInput, .label--required") ||
          /\*$/.test(label)
        );
        const fieldId = fieldIdFrom(control, label);
        if (!fieldId || seen.has(fieldId)) continue;
        seen.add(fieldId);
        const fieldType = detectType(control, label);
        const optionTexts = unique([
          ...(control instanceof HTMLSelectElement ? Array.from(control.options).map((opt) => opt.textContent || "") : []),
          ...Array.from((container || document).querySelectorAll<HTMLElement>("[role='option'], .select__option, option")).map((item) => item.textContent || "")
        ]);
        schemas.push({
          fieldId,
          label: label || `Question ${schemas.length + 1}`,
          required,
          fieldType,
          possibleAnswers: optionTexts,
          currentValue: control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement
            ? normalize((control as HTMLInputElement).value || "")
            : "",
          htmlSummary: normalize((container?.textContent || "").slice(0, 700)),
          containerMeta: {
            containerSelector: container?.className ? `.${String(container.className).split(/\s+/)[0]}` : undefined,
            containerIdentity: (container as HTMLElement | null)?.id || undefined,
            controlId: (control as HTMLElement).id || undefined,
            controlName: (control as HTMLInputElement).name || undefined,
            labelFor: (control as HTMLElement).id || undefined,
            ariaLabelledBy: control.getAttribute("aria-labelledby") || undefined
          }
        });
      }
      for (const grouped of groupedChoiceControls.values()) {
        const container = pickContainer(grouped.first);
        const possibleAnswers = unique(grouped.options);
        const currentValue = unique(grouped.optionMeta.filter((option) => option.checked).map((option) => option.label)).join(", ");
        const label = parentQuestionLabelForGroup(grouped.first, possibleAnswers);
        schemas.push({
          fieldId: grouped.fieldId,
          label: label || `Question ${schemas.length + 1}`,
          required: grouped.required,
          fieldType: grouped.fieldType,
          possibleAnswers,
          optionMeta: grouped.optionMeta,
          currentValue,
          htmlSummary: normalize((container?.textContent || "").slice(0, 700)),
          containerMeta: {
            containerSelector: container?.className ? `.${String(container.className).split(/\s+/)[0]}` : undefined,
            containerIdentity: (container as HTMLElement | null)?.id || undefined,
            controlId: undefined,
            controlName: grouped.first.name || grouped.fieldId,
            labelFor: undefined,
            ariaLabelledBy: grouped.first.getAttribute("aria-labelledby") || undefined
          }
        });
      }
      return schemas;
    });
  }

  private async legacyScanFieldDescriptors(page: AdapterRunContext["page"]): Promise<FieldDescriptor[]> {
    return page.evaluate(() => {
      type BrowserFieldDescriptor = {
        key: string;
        id?: string;
        name?: string;
        label: string;
        required: boolean;
        invalid: boolean;
        controlType: FieldControlType;
        options: string[];
        optionHints: string[];
        fieldContext?: string;
        selector: string;
        selectorCandidates: string[];
      };

      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const isVisible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const labelForControl = (control: Element): string => {
        const input = control as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        if ("id" in input && input.id) {
          const explicit = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
          const explicitText = normalize(explicit?.textContent || "");
          if (explicitText) return explicitText.replace(/\*/g, "");
        }
        const wrapping = control.closest("label");
        const wrappingText = normalize(wrapping?.textContent || "");
        if (wrappingText) return wrappingText.replace(/\*/g, "");
        const legend = control.closest("fieldset")?.querySelector("legend");
        const legendText = normalize(legend?.textContent || "");
        if (legendText) return legendText.replace(/\*/g, "");
        const ariaLabel = normalize((control as HTMLElement).getAttribute("aria-label") || "");
        if (ariaLabel) return ariaLabel.replace(/\*/g, "");
        const placeholder = normalize((control as HTMLInputElement).getAttribute?.("placeholder") || "");
        if (placeholder) return placeholder.replace(/\*/g, "");
        const name = normalize((control as HTMLInputElement).getAttribute?.("name") || "");
        return name.replace(/\*/g, "");
      };
      const fieldContextFor = (control: Element): string | undefined => {
        const container = control.closest("fieldset, section, li, [class*='field' i], [data-qa], div") ?? control.parentElement;
        const text = normalize((container?.textContent || "").slice(0, 1400));
        return text ? text.slice(0, 700) : undefined;
      };
      const selectorFor = (control: Element): string => {
        const html = control as HTMLElement;
        if ((html as HTMLInputElement).id) return `#${CSS.escape((html as HTMLInputElement).id)}`;
        const name = (html as HTMLInputElement).name || html.getAttribute("name") || "";
        const tag = html.tagName.toLowerCase();
        if (name) return `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
        return tag;
      };
      const selectorCandidatesFor = (control: Element, label: string): string[] => {
        const html = control as HTMLElement;
        const tag = html.tagName.toLowerCase();
        const out: string[] = [];
        const push = (value: string): void => {
          if (!value) return;
          if (!out.includes(value)) out.push(value);
        };
        if ((html as HTMLInputElement).id) {
          const escapedId = CSS.escape((html as HTMLInputElement).id);
          push(`#${escapedId}`);
          push(`label[for="${escapedId}"]`);
        }
        const name = (html as HTMLInputElement).name || html.getAttribute("name") || "";
        if (name) {
          push(`${tag}[name="${name.replace(/"/g, '\\"')}"]`);
          push(`input[name="${name.replace(/"/g, '\\"')}"]`);
          push(`textarea[name="${name.replace(/"/g, '\\"')}"]`);
          push(`select[name="${name.replace(/"/g, '\\"')}"]`);
        }
        if (label) {
          push(`label:has-text("${label.replace(/"/g, '\\"')}")`);
        }
        push(tag);
        return out.slice(0, 12);
      };
      const uniqueOptions = (values: string[]): string[] => Array.from(new Set(values.map((value) => normalize(value)).filter(Boolean)));

      const results: BrowserFieldDescriptor[] = [];
      const processedGroups = new Set<string>();
      const controls = Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
          "form input, form textarea, form select"
        )
      );

      for (const control of controls) {
        if (!isVisible(control)) continue;
        if (control instanceof HTMLInputElement && ["hidden", "file", "submit", "button", "reset", "image"].includes(control.type)) continue;
        if (control.id && control.id.startsWith("iti-")) continue;

        const name = control.getAttribute("name") || "";
        const id = control.id || "";
        const label = labelForControl(control);
        const requiredAttr =
          control.required ||
          control.getAttribute("aria-required") === "true" ||
          control.getAttribute("data-required") === "true";
        const invalid = control.getAttribute("aria-invalid") === "true";

        if (control instanceof HTMLInputElement && (control.type === "radio" || control.type === "checkbox")) {
          const groupName = name || id;
          const groupKey = `${control.type}:${groupName || id || label}`;
          if (processedGroups.has(groupKey)) continue;
          processedGroups.add(groupKey);

          const group = groupName
            ? (Array.from(document.querySelectorAll(`input[type="${control.type}"][name="${CSS.escape(groupName)}"]`)) as HTMLInputElement[])
            : [control];
          const visibleGroup = group.filter((item) => isVisible(item));
          if (!visibleGroup.length) continue;
          const checked = visibleGroup.some((item) => item.checked);
          const groupRequired = visibleGroup.some((item) =>
            item.required || item.getAttribute("aria-required") === "true" || item.getAttribute("data-required") === "true"
          );
          const options = uniqueOptions(
            visibleGroup.map((item) => {
              const explicit = item.id ? document.querySelector(`label[for="${CSS.escape(item.id)}"]`) : null;
              const wrapping = item.closest("label");
              const optionText = normalize(explicit?.textContent || wrapping?.textContent || item.value || "");
              return optionText;
            })
          );
          const first = visibleGroup[0]!;
          const groupLabel = label || labelForControl(first);
          const key = id || name || `group_${control.type}_${results.length}`;
          results.push({
            key,
            id: id || undefined,
            name: name || undefined,
            label: groupLabel || `Question ${results.length + 1}`,
            required: groupRequired || requiredAttr,
            invalid: invalid || (!checked && groupRequired),
            controlType: control.type === "radio" ? "radio-group" : "checkbox-group",
            options,
            optionHints: options,
            fieldContext: fieldContextFor(first),
            selector: selectorFor(first),
            selectorCandidates: selectorCandidatesFor(first, groupLabel)
          });
          continue;
        }

        const role = control.getAttribute("role") || "";
        const isComboboxLike =
          role === "combobox" ||
          control.getAttribute("aria-autocomplete") === "list" ||
          Boolean(control.closest(".select-shell"));

        let controlType: FieldControlType = "text";
        if (control instanceof HTMLTextAreaElement) controlType = "textarea";
        else if (control instanceof HTMLSelectElement) controlType = "select";
        else if (control instanceof HTMLInputElement && control.type === "date") controlType = "date";
        else if (isComboboxLike) controlType = "combobox";

        const shell = control.closest(".select-shell");
        const requiredSentinel = shell?.querySelector(
          "input.remix-css-1a0ro4n-requiredInput[required], input[required][aria-hidden='true']"
        ) as HTMLInputElement | null;
        const required = requiredAttr || Boolean(requiredSentinel);
        const options: string[] = [];
        if (control instanceof HTMLSelectElement) {
          options.push(...Array.from(control.options).map((option) => normalize(option.textContent || "")));
        }
        const hintContainer = shell ?? control.closest("fieldset, section, li, div") ?? control.parentElement ?? document.body;
        options.push(
          ...Array.from(hintContainer.querySelectorAll<HTMLElement>("[role='option'], li[role='option'], .select__option, option"))
            .map((node) => normalize(node.textContent || ""))
            .filter((value) => value.length <= 120)
        );
        const optionHints = uniqueOptions(options);
        const key = id || name || `${control.tagName.toLowerCase()}_${results.length}`;
        results.push({
          key,
          id: id || undefined,
          name: name || undefined,
          label: label || `Question ${results.length + 1}`,
          required,
          invalid: invalid || control.getAttribute("aria-invalid") === "true",
          controlType,
          options: optionHints,
          optionHints,
          fieldContext: fieldContextFor(control),
          selector: selectorFor(control),
          selectorCandidates: selectorCandidatesFor(control, label)
        });
      }

      const deduped = new Map<string, BrowserFieldDescriptor>();
      for (const item of results) {
        const dedupeKey = item.key || item.selector;
        if (!dedupeKey) continue;
        deduped.set(dedupeKey, item);
      }
      return Array.from(deduped.values());
    });
  }

  private async applyAnswer(page: AdapterRunContext["page"], question: GreenhouseQuestion, answer: string): Promise<boolean> {
    if (!answer) return false;

    if (question.inputKind === "text" || question.inputKind === "textarea" || question.inputKind === "date") {
      const direct = await this.setValueByQuestion(page, question, answer).catch(() => false);
      if (direct) return true;

      const locator = this.locateQuestionControl(page, question);
      if (await locator.count().catch(() => 0)) {
        const filled = await locator.fill(answer).then(() => true).catch(() => false);
        if (filled) return true;
      }
      return false;
    }

    if (question.inputKind === "select" || question.inputKind === "combobox") {
      const normalizedQuestionLabel = normalizeText(question.label);
      const comboboxSemantic = this.classifyComboboxSemantic(normalizedQuestionLabel);
      const preferTypedFirstPass = question.inputKind === "combobox" && this.shouldUseTypeWaitEnterComboboxFirstPass(normalizedQuestionLabel);
      if (preferTypedFirstPass) {
        const firstPassCandidates = this.firstPassComboboxCandidates(normalizedQuestionLabel, answer);
        const locationRetryAttempts = this.isLocationBasedPrompt(normalizedQuestionLabel) ? 2 : 1;
        if (question.domId) {
          for (const candidate of firstPassCandidates) {
            for (let attempt = 0; attempt < locationRetryAttempts; attempt += 1) {
              const selected = await this.fillReactComboboxByTyping(page, question.domId, candidate, comboboxSemantic).catch(() => false);
              if (selected) return true;
              if (attempt + 1 < locationRetryAttempts) {
                await page.waitForTimeout(320).catch(() => undefined);
              }
            }
          }
        }
        if (question.selector) {
          const combobox = page.locator(question.selector).first();
          if (await combobox.count().catch(() => 0)) {
            const selected = await this.selectComboboxByLocator(page, combobox, firstPassCandidates).catch(() => false);
            if (selected) return true;
          }
        }
        for (const selector of question.selectorCandidates ?? []) {
          const combobox = page.locator(selector).first();
          if (!(await combobox.count().catch(() => 0))) continue;
          const selected = await this.selectComboboxByLocator(page, combobox, firstPassCandidates).catch(() => false);
          if (selected) return true;
        }
        return false;
      }

      if (question.domId) {
        const prefixedSelected = await this.selectReactOptionByIdPrefix(page, question.domId, answer).catch(() => false);
        if (prefixedSelected) return true;
        const nativeSelected = await this.selectNativeOption(page, question.domId, answer).catch(() => false);
        if (nativeSelected) return true;
        const typed = await this.fillReactComboboxByTyping(page, question.domId, answer, comboboxSemantic).catch(() => false);
        if (typed) return true;
      }
      if (question.selector) {
        const selected = await this.selectBySelector(page, question.selector, answer).catch(() => false);
        if (selected) return true;
      }
      for (const selector of question.selectorCandidates ?? []) {
        const selected = await this.selectBySelector(page, selector, answer).catch(() => false);
        if (selected) return true;
      }
      return false;
    }

    if (question.inputKind === "radio-group" || question.inputKind === "checkbox-group") {
      return this.clickRadioOrCheckbox(page, question, answer).catch(() => false);
    }

    return false;
  }

  private async fillReactComboboxByTyping(
    page: AdapterRunContext["page"],
    id: string,
    answer: string,
    semantic: ComboboxSemantic = "generic_select"
  ): Promise<boolean> {
    const input = await this.reactSelectInputLocator(page, id);
    if (!(await input.count().catch(() => 0))) {
      return false;
    }

    await page.keyboard.press("Escape").catch(() => undefined);
    await input.click({ force: true }).catch(() => undefined);
    await input.fill("").catch(() => undefined);
    await input.type(answer, { delay: 15 }).catch(() => undefined);
    await this.waitForTypedInputValue(input, answer).catch(() => undefined);
    await page.waitForTimeout(180).catch(() => undefined);

    const bound = await input.evaluate((element, expectedId) => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
      const visible = (candidate: Element): boolean => {
        const html = candidate as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const ariaControls = (element.getAttribute("aria-controls") || "").trim();
      if (!ariaControls) return { bound: false, listboxId: "", options: [] as string[] };
      const listbox = document.getElementById(ariaControls);
      if (!listbox || !visible(listbox)) return { bound: false, listboxId: ariaControls, options: [] as string[] };
      if (expectedId && ariaControls !== expectedId) return { bound: false, listboxId: ariaControls, options: [] as string[] };
      const options = Array.from(listbox.querySelectorAll<HTMLElement>(".select__option, [role='option']"))
        .filter((option) => visible(option))
        .map((option) => (option.textContent || "").replace(/\s+/g, " ").trim())
        .filter((text) => text.length > 0);
      return {
        bound: true,
        listboxId: ariaControls,
        options,
        hasCountryCodes: options.filter((text) => /\+\d{1,4}\b/.test(normalize(text))).length >= 3
      };
    }, `react-select-${id}-listbox`).catch(() => ({ bound: false, listboxId: "", options: [] as string[], hasCountryCodes: false }));

    if (!bound.bound) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return false;
    }
    if (semantic !== "phone_country_code" && bound.hasCountryCodes) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return false;
    }

    const picked = await input.evaluate((element, desiredRaw) => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
      const visible = (candidate: Element): boolean => {
        const html = candidate as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const desired = normalize(desiredRaw || "");
      const ariaControls = (element.getAttribute("aria-controls") || "").trim();
      if (!ariaControls) return "";
      const listbox = document.getElementById(ariaControls);
      if (!listbox || !visible(listbox)) return "";
      const options = Array.from(listbox.querySelectorAll<HTMLElement>(".select__option, [role='option']"))
        .filter((option) => visible(option))
        .filter((option) => option.getAttribute("aria-disabled") !== "true")
        .map((option) => ({
          element: option,
          text: (option.textContent || "").replace(/\s+/g, " ").trim(),
          normalized: normalize(option.textContent || "")
        }));
      const exact = options.find((option) => option.normalized === desired);
      const contains = options.find((option) => option.normalized.includes(desired));
      const reverse = options.find((option) => desired.includes(option.normalized));
      const chosen = exact || contains || reverse;
      if (!chosen) return "";
      chosen.element.click();
      return chosen.text;
    }, answer).catch(() => "");

    if (!picked) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return false;
    }

    await page.waitForTimeout(180).catch(() => undefined);

    const verified = await this.verifyRequiredComboboxSatisfied(page, {
      id,
      label: "",
      role: "combobox",
      tag: "input"
    }).catch(() => false);
    if (verified) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return true;
    }

    const hasSelectedValue = await page.evaluate((targetId) => {
      const element = document.getElementById(targetId) as HTMLInputElement | null;
      if (!element) return false;
      const shell = element.closest(".select-shell");
      if (!shell) return false;
      const singleValue = (
        shell.querySelector(".select__single-value, [class*='singleValue' i]")?.textContent || ""
      ).replace(/\s+/g, " ").trim();
      if (!singleValue) return false;
      return !/^select(\.\.\.)?$/i.test(singleValue);
    }, id).catch(() => false);

    if (hasSelectedValue) {
      await this.syncReactSelectRequiredInput(page, id, picked || answer).catch(() => undefined);
      await page.keyboard.press("Escape").catch(() => undefined);
      return true;
    }

    return false;
  }

  private async commitReactSelectOption(
    page: AdapterRunContext["page"],
    id: string,
    answer: string,
    listboxHint?: string
  ): Promise<{ applied: boolean; matchedOption: string; listboxId: string; state: RequiredValidationState | null }> {
    const input = await this.reactSelectInputLocator(page, id);
    if (!(await input.count().catch(() => 0))) {
      return { applied: false, matchedOption: "", listboxId: "", state: null };
    }

    const pickFromOpenMenu = async (): Promise<{
      matchedOption: string;
      listboxId: string;
      ariaControls: string;
      bindingStatus: "bound" | "mismatch" | "none";
    }> => {
      return page.evaluate(({ targetId, desired, preferredListboxId }) => {
        const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
        const visible = (element: Element): boolean => {
          const html = element as HTMLElement;
          const style = window.getComputedStyle(html);
          const rect = html.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const desiredNormalized = normalize(desired);
        const control = document.getElementById(targetId) as HTMLElement | null;
        const active = document.activeElement as HTMLElement | null;
        const ariaControls = active?.getAttribute("aria-controls") || control?.getAttribute("aria-controls") || "";
        const listboxes = Array.from(
          document.querySelectorAll<HTMLElement>(".select__menu-list[role='listbox'], [role='listbox'], [id^='react-select-'][id$='-listbox']")
        ).filter((listbox) => visible(listbox));
        let bindingStatus: "bound" | "mismatch" | "none" = "none";
        let listbox: HTMLElement | null = null;
        if (ariaControls) {
          listbox = listboxes.find((candidate) => candidate.id === ariaControls) || null;
          bindingStatus = listbox ? "bound" : "mismatch";
          if (preferredListboxId && ariaControls !== preferredListboxId) {
            bindingStatus = "mismatch";
            listbox = null;
          }
        }
        if (!listbox) return { matchedOption: "", listboxId: "", ariaControls, bindingStatus };

        const options = Array.from(listbox.querySelectorAll<HTMLElement>(".select__option, [role='option']"))
          .filter((option) => visible(option))
          .filter((option) => option.getAttribute("aria-disabled") !== "true")
          .map((option) => ({
            element: option,
            text: (option.textContent || "").replace(/\s+/g, " ").trim(),
            normalized: normalize(option.textContent || "")
          }))
          .filter((option) => option.normalized.length > 0);
        if (!options.length) return { matchedOption: "", listboxId: listbox.id || "", ariaControls, bindingStatus };

        const exact = options.find((option) => option.normalized === desiredNormalized);
        const contains = options.find((option) => option.normalized.includes(desiredNormalized));
        const reverse = options.find((option) => desiredNormalized.includes(option.normalized));
        const chosen = exact || contains || reverse;
        if (!chosen) return { matchedOption: "", listboxId: listbox.id || "", ariaControls, bindingStatus };
        chosen.element.click();
        return { matchedOption: chosen.text, listboxId: listbox.id || "", ariaControls, bindingStatus };
      }, { targetId: id, desired: answer, preferredListboxId: listboxHint ?? "" }).catch(() => ({
        matchedOption: "",
        listboxId: "",
        ariaControls: "",
        bindingStatus: "none" as const
      }));
    };

    await page.keyboard.press("Escape").catch(() => undefined);
    await input.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(120).catch(() => undefined);
    let picked = await pickFromOpenMenu();
    if (!picked.matchedOption) {
      await input.fill("").catch(() => undefined);
      await input.type(answer, { delay: 15 }).catch(() => undefined);
      await this.waitForTypedInputValue(input, answer).catch(() => undefined);
      await page.waitForTimeout(120).catch(() => undefined);
      picked = await pickFromOpenMenu();
    }
    if (!picked.matchedOption) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return { applied: false, matchedOption: "", listboxId: picked.listboxId || "", state: null };
    }

    await page.waitForTimeout(120).catch(() => undefined);
    await this.syncReactSelectRequiredInput(page, id, picked.matchedOption || answer).catch(() => undefined);
    await input.press("Tab").catch(() => undefined);
    await input.dispatchEvent("blur").catch(() => undefined);

    const state = await this.inspectRequiredValidationState(page, {
      id,
      label: "",
      selector: `[id=${JSON.stringify(id)}], [name=${JSON.stringify(id)}]`
    }).catch(() => null);
    await page.keyboard.press("Escape").catch(() => undefined);
    const hasHiddenValue = Boolean(state?.hiddenValues?.some((value) => value && !isPlaceholderOption(value)));
    const hasCurrentValue = Boolean(state?.currentValue && !isPlaceholderOption(state.currentValue));
    const applied = Boolean(
      picked.matchedOption &&
      state &&
      !state.ariaInvalid &&
      !this.hasRequiredValidationErrorText(state.errorText) &&
      (hasCurrentValue || hasHiddenValue)
    );
    return { applied, matchedOption: picked.matchedOption, listboxId: picked.listboxId || "", state };
  }

  private async selectReactOptionByIdPrefix(
    page: AdapterRunContext["page"],
    id: string,
    answer: string
  ): Promise<boolean> {
    const committed = await this.commitReactSelectOption(page, id, answer, `react-select-${id}-listbox`).catch(() => null);
    if (committed?.applied) return true;

    const toggled = await this.pickReactSelectOptionFromToggle(page, id, answer).catch(() => false);
    if (!toggled) return false;
    const postToggle = await this.commitReactSelectOption(page, id, answer, `react-select-${id}-listbox`).catch(() => null);
    return Boolean(postToggle?.applied);
  }

  private async pickReactSelectOptionFromToggle(
    page: AdapterRunContext["page"],
    id: string,
    answer: string
  ): Promise<boolean> {
    const opened = await page.evaluate((targetId) => {
      const input = document.getElementById(targetId) as HTMLElement | null;
      if (!input) return false;
      const shell = input.closest(".select-shell");
      if (!shell) return false;
      const toggle = shell.querySelector<HTMLElement>(
        "button[aria-label*='toggle' i], button[aria-label*='flyout' i], .select__indicators button"
      );
      if (!toggle) return false;
      toggle.click();
      return true;
    }, id).catch(() => false);
    if (!opened) return false;

    const exact = page
      .locator(`[id^=${JSON.stringify(`react-select-${id}-option-`)}]`)
      .filter({ hasText: new RegExp(`^${escapeRegExp(answer)}$`, "i") })
      .first();
    const contains = page
      .locator(`[id^=${JSON.stringify(`react-select-${id}-option-`)}]`)
      .filter({ hasText: new RegExp(escapeRegExp(answer), "i") })
      .first();
    await page
      .locator(`[id^=${JSON.stringify(`react-select-${id}-option-`)}]`)
      .first()
      .waitFor({ state: "visible", timeout: 1200 })
      .catch(() => undefined);

    if (await exact.count().catch(() => 0)) {
      await exact.click().catch(() => undefined);
      return true;
    }
    if (await contains.count().catch(() => 0)) {
      await contains.click().catch(() => undefined);
      return true;
    }
    return false;
  }

  private normalizeSelectAnswer(value: string): string {
    const normalized = normalizeText(value);
    if (normalized === "true") return "Yes";
    if (normalized === "false") return "No";
    return value;
  }

  private async enrichSelectOptionHints(page: AdapterRunContext["page"], questions: ApplicationQuestion[]): Promise<void> {
    for (const question of questions) {
      const inputKind = typeof question.platformMeta?.inputKind === "string" ? question.platformMeta.inputKind : "";
      if (inputKind !== "select" && inputKind !== "combobox") continue;
      if (question.options?.length) continue;

      const existingHints = Array.isArray(question.platformMeta?.optionHints)
        ? (question.platformMeta?.optionHints as string[])
        : [];
      if (existingHints.length) continue;

      const domId = typeof question.platformMeta?.domId === "string" ? (question.platformMeta.domId as string) : question.id;
      const hints = await this.peekSelectOptionHints(page, domId);
      if (!hints.length) continue;

      question.platformMeta = {
        ...(question.platformMeta ?? {}),
        optionHints: hints
      };
    }
  }

  private async peekSelectOptionHints(page: AdapterRunContext["page"], id: string): Promise<string[]> {
    const input = await this.reactSelectInputLocator(page, id);
    if (!(await input.count())) return [];

    await page.keyboard.press("Escape").catch(() => undefined);
    await input.click({ force: true }).catch(() => undefined);
    await page
      .locator(`[id^="react-select-${id}-option-"], [role="option"][id*="react-select"]`)
      .first()
      .waitFor({ state: "visible", timeout: 1200 })
      .catch(() => undefined);

    const hints = await page.evaluate((targetId) => {
      const byPrefix = Array.from(
        document.querySelectorAll<HTMLElement>(`[id^="react-select-${targetId}-option-"]`)
      )
        .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      return Array.from(new Set(byPrefix)).slice(0, 30);
    }, id).catch(() => [] as string[]);

    await page.keyboard.press("Escape").catch(() => undefined);
    return hints;
  }

  private async reconcileRequiredFieldsBeforeSubmit(
    page: AdapterRunContext["page"],
    answers: ResolvedAnswer[],
    profile: AdapterRunContext["profile"],
    filledFields: FilledFieldRecord[],
    aiContext?: {
      logger?: AdapterRunContext["logger"];
      aiEngine: AdapterRunContext["aiEngine"];
      resumeText: string;
      jobTitle?: string;
      company?: string;
      companyContext?: string;
      config?: AdapterRunContext["config"];
    }
  ): Promise<void> {
    const answerMap = new Map<string, string>();
    for (const answer of answers) {
      const value = answerValueToString(answer.value).trim();
      if (value) answerMap.set(answer.questionId, value);
    }

    const attemptedFieldKeys = new Set<string>();
    /**
     * Fields proven to have no possible answer, so they are not worked again.
     *
     * A required question is unanswerable when the profile has nothing for it,
     * or when the value it does have is absent from the option list the site
     * offers. Neither changes between repair passes -- nothing on the page or
     * in the profile moves -- so retrying is pure cost. Against a real
     * Greenhouse posting that cost was measured at roughly eight seconds per
     * dropdown probe, and one application spent sixteen minutes re-probing the
     * same six questions it could never answer.
     *
     * These are the questions a person has to finish, which is exactly what the
     * run should report rather than grind on.
     */
    const unanswerableFieldIds = new Set<string>();
    let previousMissingSignature = "";
    let noProgressCycles = 0;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.closePhoneCountryWidget(page).catch(() => undefined);
      await this.syncAllRequiredSelectSentinels(page).catch(() => undefined);
      const missing = await this.collectMissingRequiredDetails(page);
      if (!missing.length) break;
      const missingSignature = missing
        .map((field) => field.id)
        .sort((a, b) => a.localeCompare(b))
        .join("|");

      if (missingSignature && missingSignature === previousMissingSignature) {
        noProgressCycles += 1;
      } else {
        noProgressCycles = 0;
      }

      if (noProgressCycles >= 1) {
        break;
      }
      previousMissingSignature = missingSignature;

      for (const field of missing) {
        if (unanswerableFieldIds.has(field.id)) continue;
        let applied = false;
        const validationStateBefore = await this.inspectRequiredValidationState(page, {
          id: field.id,
          label: field.label
        }).catch(() => null);
        if (validationStateBefore && aiContext?.logger) {
          aiContext.logger.info("greenhouse_required_validation_state", {
            fieldId: field.id,
            label: field.label,
            controlType: field.role,
            required: true,
            currentValue: validationStateBefore.currentValue,
            errorText: validationStateBefore.errorText,
            ariaInvalid: validationStateBefore.ariaInvalid,
            hiddenValues: validationStateBefore.hiddenValues
          });
          if (
            validationStateBefore.currentValue &&
            (validationStateBefore.ariaInvalid || this.hasRequiredValidationErrorText(validationStateBefore.errorText))
          ) {
            aiContext.logger.info("greenhouse_visible_value_but_invalid", {
              fieldId: field.id,
              label: field.label,
              currentValue: validationStateBefore.currentValue,
              errorText: validationStateBefore.errorText,
              ariaInvalid: validationStateBefore.ariaInvalid
            });
          }
        }
        if (
          validationStateBefore &&
          field.role === "combobox" &&
          validationStateBefore.currentValue &&
          !isPlaceholderOption(validationStateBefore.currentValue) &&
          !validationStateBefore.ariaInvalid &&
          !this.hasRequiredValidationErrorText(validationStateBefore.errorText)
        ) {
          continue;
        }

        const answer = answerMap.get(field.id);
        let normalizedAnswer = answer ? this.normalizeSelectAnswer(answer) : "";
        const normalizedFieldLabel = normalizeText(field.label || "");
        const demographicKind = field.role === "combobox"
          ? this.getDemographicFieldKind(normalizedFieldLabel)
          : undefined;
        const currentComboboxValue = (validationStateBefore?.currentValue || "").trim();
        const hasCurrentComboboxValue = Boolean(currentComboboxValue && !isPlaceholderOption(currentComboboxValue));
        if (field.role === "combobox" && this.isLocationBasedPrompt(normalizedFieldLabel)) {
          const forcedLocationAnswer = this.buildCityStateCountryCandidate(profile);
          if (forcedLocationAnswer) {
            normalizedAnswer = forcedLocationAnswer;
            answerMap.set(field.id, forcedLocationAnswer);
          }
        }
        if (demographicKind && hasCurrentComboboxValue) {
          normalizedAnswer = currentComboboxValue;
        } else if (demographicKind) {
          normalizedAnswer = "I don't wish to answer";
          answerMap.set(field.id, normalizedAnswer);
        }
        if (!normalizedAnswer && validationStateBefore?.currentValue && (field.role === "combobox" || field.tag === "select")) {
          normalizedAnswer = validationStateBefore.currentValue;
        }
        if (!normalizedAnswer && (field.role === "combobox" || field.tag === "select")) {
          const aiSuggested = await this.resolveMissingRequiredFieldAnswerWithAi(page, field, profile, aiContext).catch(() => "");
          if (aiSuggested) {
            normalizedAnswer = aiSuggested;
            answerMap.set(field.id, aiSuggested);
          }
        }
        if (!normalizedAnswer && (field.tag === "input" || field.tag === "textarea")) {
          const semanticClass = detectTextFieldSemantic(field.label || this.humanizeId(field.id), "", validationStateBefore?.errorText || "");
          const textQuestion: ApplicationQuestion = {
            id: field.id,
            label: field.label || this.humanizeId(field.id),
            required: true,
            type: field.tag === "textarea" ? "textarea" : "text",
            platformMeta: {
              inputKind: field.tag === "textarea" ? "textarea" : "text",
              domId: field.id,
              selector: field.id ? `#${field.id}` : undefined,
              fieldContext: validationStateBefore?.errorText || ""
            }
          };
          let generated = "";
          if (aiContext) {
            generated = await this.resolveSingleQuestionWithCache(textQuestion, {
              aiEngine: aiContext.aiEngine,
              profile,
              resumeText: aiContext.resumeText,
              jobTitle: aiContext.jobTitle,
              company: aiContext.company,
              companyContext: aiContext.companyContext
            }).catch(() => "");
            if (this.isDisallowedRequiredTextAnswer(generated, aiContext.config ?? ({ greenhouse: {} } as AdapterRunContext["config"]))) {
              generated = "";
            }
            if (!generated) {
              const retryQuestion = this.buildRequiredTextRetryQuestion(textQuestion);
              generated = await this.resolveSingleQuestionWithCache(retryQuestion, {
                aiEngine: aiContext.aiEngine,
                profile,
                resumeText: aiContext.resumeText,
                jobTitle: aiContext.jobTitle,
                company: aiContext.company,
                companyContext: aiContext.companyContext
              }).catch(() => "");
            }
          }
          const constraints = await this.inspectTextInputConstraints(page, {
            id: field.id,
            name: field.id,
            selector: field.id ? `#${field.id}` : "",
            label: field.label
          }).catch(() => null);
          if (semanticClass === "compensation") {
            generated = this.normalizeCompensationAnswerForConstraints(generated, constraints);
          }
          if (!generated) {
            generated = this.pickRequiredTextFallback(
              semanticClass,
              constraints,
              profile,
              aiContext?.config ?? ({ greenhouse: {} } as AdapterRunContext["config"])
            );
            if (semanticClass === "compensation") {
              generated = this.normalizeCompensationAnswerForConstraints(generated, constraints);
            }
          }
          if (generated && !this.isDisallowedRequiredTextAnswer(generated, aiContext?.config ?? ({ greenhouse: {} } as AdapterRunContext["config"]))) {
            normalizedAnswer = generated;
            answerMap.set(field.id, generated);
          }
        }
        const fieldAttemptKey = `${field.id}::${normalizedAnswer || "__fallback__"}`;
        if (attemptedFieldKeys.has(fieldAttemptKey)) {
          continue;
        }

        if (field.id === "preferred_name") {
          attemptedFieldKeys.add(fieldAttemptKey);
          applied = await this.setValueById(page, field.id, profile.basics.firstName).catch(() => false);
          const verified = applied
            ? await this.verifyFieldSatisfied(page, field.id, "text", profile.basics.firstName).catch(() => false)
            : false;
          if (verified) {
            this.upsertFilledField(filledFields, {
              id: field.id,
              label: "Preferred Name",
              value: profile.basics.firstName,
              source: "seeded",
              inputKind: "text"
            });
          }
        } else if (field.id === "country") {
          attemptedFieldKeys.add(fieldAttemptKey);
          const country = profile.country ?? "United States";
          applied = await this.selectReactOptionByIdPrefix(page, field.id, country).catch(() => false);
          if (!applied) {
            applied = await this.selectReactOption(page, field.id, country).catch(() => false);
          }
          if (!applied) {
            applied = await this.fillByLabelOrSelector(page, country, /^country$/i, [
              "#country",
              'input[id="country"]',
              'input[name="country"]'
            ]);
          }
          const verified = applied
            ? await this.verifyFieldSatisfied(page, field.id, "select", country).catch(() => false)
            : false;
          if (verified) {
            this.upsertFilledField(filledFields, {
              id: "country",
              label: "Country",
              value: country,
              source: "seeded",
              inputKind: "select"
            });
          }
        } else if (normalizedAnswer) {
          attemptedFieldKeys.add(fieldAttemptKey);
          if (field.role === "combobox") {
            let matchedFromProbe: string | undefined;
            const probed = await this.probeLiveSelectOptions(page, {
              key: field.id,
              id: field.id,
              label: field.label,
              required: true,
              invalid: false,
              controlType: "combobox",
              options: [],
              optionHints: [],
              selector: `#${field.id}`,
              selectorCandidates: field.id ? [`#${field.id}`] : []
            }, aiContext?.logger).catch(() => null);
            const optionTexts = probed?.options?.map((option) => option.text) ?? [];
            if (probed?.options?.length && aiContext?.logger) {
              matchedFromProbe = findBestOptionMatch(normalizedAnswer, optionTexts);
              aiContext.logger.info("greenhouse_option_match_result", {
                fieldId: field.id,
                label: field.label,
                controlType: "combobox",
                required: true,
                selectedAnswer: normalizedAnswer,
                matchedOption: matchedFromProbe ?? null,
                options: optionTexts,
                optionSource: probed.optionSource,
                listboxId: probed.listboxId || null
              });
            }
            if (probed?.options?.length) {
              if (!matchedFromProbe) {
                aiContext?.logger?.info("greenhouse_option_answer_rejected", {
                  fieldId: field.id,
                  label: field.label,
                  controlType: "combobox",
                  required: true,
                  selectedAnswer: normalizedAnswer,
                  options: optionTexts,
                  stage: "reconcile_required"
                });
                if (validationStateBefore?.currentValue) {
                  const matchedCurrent = findBestOptionMatch(validationStateBefore.currentValue, optionTexts);
                  if (matchedCurrent) {
                    normalizedAnswer = matchedCurrent;
                  } else {
                    unanswerableFieldIds.add(field.id);
                    aiContext?.logger?.info("greenhouse_required_option_unresolved", {
                      fieldId: field.id,
                      label: field.label,
                      controlType: "combobox",
                      required: true,
                      selectedAnswer: normalizedAnswer,
                      options: optionTexts,
                      stage: "reconcile_required"
                    });
                    continue;
                  }
                } else {
                  unanswerableFieldIds.add(field.id);
                  aiContext?.logger?.info("greenhouse_required_option_unresolved", {
                    fieldId: field.id,
                    label: field.label,
                    controlType: "combobox",
                    required: true,
                    selectedAnswer: normalizedAnswer,
                    options: optionTexts,
                    stage: "reconcile_required"
                  });
                  continue;
                }
              } else {
                normalizedAnswer = matchedFromProbe;
              }
            }
            applied = await this.selectReactOptionByIdPrefix(page, field.id, normalizedAnswer).catch(() => false);
            if (!applied) {
              applied = await this.selectReactOption(page, field.id, normalizedAnswer).catch(() => false);
            }
            if (!applied && probed?.options?.length) {
              const committed = await this.commitReactSelectOption(page, field.id, normalizedAnswer, probed.listboxId || undefined).catch(() => null);
              if (committed?.applied) {
                applied = true;
                normalizedAnswer = committed.matchedOption || normalizedAnswer;
              }
            }
            if (!applied) {
              if (!probed?.options?.length) {
                const fallbackCandidates = this.defaultComboboxFallbackCandidates(field.label, profile, normalizedAnswer);
                applied = await this.selectComboboxByMissingField(page, field, fallbackCandidates);
              }
            }
          } else if (field.tag === "select") {
            applied = await this.selectNativeOption(page, field.id, normalizedAnswer).catch(() => false);
          } else {
            applied = await this.setValueById(page, field.id, normalizedAnswer).catch(() => false);
          }
          const expectedKind = field.role === "combobox" || field.tag === "select" ? "select" : "text";
          const verified = applied
            ? await this.verifyFieldSatisfied(page, field.id, expectedKind, normalizedAnswer).catch(() => false)
            : false;
          if (verified) {
            this.upsertFilledField(filledFields, {
              id: field.id,
              label: field.label || this.humanizeId(field.id),
              value: normalizedAnswer,
              source: "manual",
              inputKind: expectedKind
            });
          }
          // Every strategy ran and the value still did not land. The page and
          // the profile are both unchanged, so the next pass would do the same
          // work for the same result; stop paying for it.
          if (!applied || !verified) unanswerableFieldIds.add(field.id);
          if (aiContext?.logger) {
            aiContext.logger.info("greenhouse_required_repair_result", {
              fieldId: field.id,
              label: field.label,
              controlType: field.role || field.tag,
              required: true,
              answer: normalizedAnswer,
              applied,
              verified
            });
          }
        } else if (field.role === "combobox" && !this.isOptionBackedMissingField(field)) {
          attemptedFieldKeys.add(fieldAttemptKey);
          const fallbackCandidates = this.defaultComboboxFallbackCandidates(field.label, profile);
          applied = await this.selectComboboxByMissingField(page, field, fallbackCandidates);
          const verified = applied
            ? await this.verifyFieldSatisfied(page, field.id, "select", fallbackCandidates[0] ?? "").catch(() => false)
            : false;
          if (verified) {
            this.upsertFilledField(filledFields, {
              id: field.id,
              label: field.label || this.humanizeId(field.id),
              value: fallbackCandidates[0] ?? "Yes",
              source: "manual",
              inputKind: "select"
            });
          }
        }
      }
    }
  }

  private async resolveMissingRequiredFieldAnswerWithAi(
    page: AdapterRunContext["page"],
    field: MissingFieldDetail,
    profile: AdapterRunContext["profile"],
    aiContext?: {
      logger?: AdapterRunContext["logger"];
      aiEngine: AdapterRunContext["aiEngine"];
      resumeText: string;
      jobTitle?: string;
      company?: string;
      companyContext?: string;
    }
  ): Promise<string> {
    if (!aiContext) return "";
    const label = field.label || this.humanizeId(field.id);
    const scanned = await this.scanFieldDescriptors(page).catch(() => []);
    const matched = scanned.find((question) => question.key === field.id || question.id === field.id)
      ?? scanned.find((question) => normalizeText(question.label) === normalizeText(label))
      ?? scanned.find((question) => normalizeText(question.label).includes(normalizeText(label)));
    const fieldLooksOptionBacked = this.isOptionBackedMissingField(field);
    const fallbackOptionHints = fieldLooksOptionBacked ? [] : this.defaultComboboxFallbackCandidates(label, profile);
    const fallbackControlType: FieldControlType = field.tag === "select" ? "select" : "combobox";
    const mappedType = mapInputType(matched?.controlType ?? fallbackControlType, matched?.options ?? fallbackOptionHints);
    const isOptionBackedRequired = fieldLooksOptionBacked || this.isOptionBackedField(mappedType.kind);
    const hintedFromMatched = Array.isArray(matched?.optionHints) ? (matched.optionHints as string[]) : [];
    let optionPool = matched?.options?.length ? matched.options : hintedFromMatched;

    if (!optionPool.length && this.isLiveProbeEligibleField(mappedType.kind)) {
      const probed = await this.probeLiveSelectOptions(page, {
        key: field.id,
        id: field.id,
        label,
        required: true,
        invalid: false,
        controlType: mappedType.kind,
        options: [],
        optionHints: [],
        selector: matched?.selector ?? `#${field.id}`,
        selectorCandidates: matched?.selectorCandidates?.length
          ? matched.selectorCandidates
          : field.id
            ? [`#${field.id}`]
            : []
      }, aiContext.logger).catch(() => null);
      if (probed?.options?.length) {
        optionPool = probed.options.map((option) => option.text);
      }
    }

    if (!optionPool.length && !isOptionBackedRequired) {
      optionPool = fallbackOptionHints;
    }

    if (isOptionBackedRequired && !optionPool.length) {
      aiContext.logger?.info("greenhouse_required_option_unresolved", {
        fieldId: field.id,
        label,
        controlType: mappedType.kind,
        required: true,
        selectedAnswer: null,
        options: [],
        stage: "resolve_missing_required",
        reason: "no_options_probed"
      });
      return "";
    }

    const aiQuestion: ApplicationQuestion = {
      id: matched?.key ?? field.id,
      label,
      type: mappedType.questionType,
      required: true,
      options: optionPool.length ? optionPool : undefined,
      platformMeta: {
        inputKind: mappedType.kind,
        name: matched?.name,
        domId: matched?.id,
        selector: matched?.selector,
        selectorCandidates: matched?.selectorCandidates,
        optionHints: optionPool.length ? optionPool : fallbackOptionHints,
        fieldContext: matched?.fieldContext
      }
    };
    if (mappedType.kind === "select" || mappedType.kind === "combobox") {
      await this.enrichSelectOptionHints(page, [aiQuestion]).catch(() => undefined);
    }

    const aiAnswer = await this.resolveSingleQuestionWithCache(aiQuestion, {
      aiEngine: aiContext.aiEngine,
      profile,
      resumeText: aiContext.resumeText,
      jobTitle: aiContext.jobTitle,
      company: aiContext.company,
      companyContext: aiContext.companyContext
    });
    if (!aiAnswer) return "";

    const hintedOptions = Array.isArray(aiQuestion.platformMeta?.optionHints)
      ? (aiQuestion.platformMeta.optionHints as string[])
      : [];
    const finalOptionPool = aiQuestion.options?.length ? aiQuestion.options : hintedOptions;

    let normalized = this.applyGreenhouseRequiredHeuristics(aiQuestion, aiAnswer, profile, {
      logger: aiContext.logger,
      fieldId: field.id,
      stage: "resolve_missing_required"
    });
    if (isOptionBackedRequired && finalOptionPool.length) {
      const firstAttempt = findBestOptionMatch(normalized, finalOptionPool) ?? findBestOptionMatch(aiAnswer, finalOptionPool);
      if (firstAttempt) {
        return firstAttempt.trim();
      }

      aiContext.logger?.info("greenhouse_option_answer_rejected", {
        fieldId: field.id,
        label,
        controlType: mappedType.kind,
        required: true,
        selectedAnswer: normalized || aiAnswer,
        options: finalOptionPool,
        stage: "resolve_missing_required"
      });
      aiContext.logger?.info("greenhouse_required_option_retry", {
        fieldId: field.id,
        label,
        controlType: mappedType.kind,
        required: true,
        selectedAnswer: normalized || aiAnswer,
        options: finalOptionPool,
        stage: "resolve_missing_required"
      });

      const retryQuestion = this.buildOptionOnlyRetryQuestion(aiQuestion, finalOptionPool);
      const retryAnswers = await aiContext.aiEngine.resolve([retryQuestion], {
        profile,
        resumeText: aiContext.resumeText,
        jobTitle: aiContext.jobTitle,
        company: aiContext.company,
        companyContext: aiContext.companyContext
      }).catch(() => []);
      const retry = retryAnswers[0];
      if (retry) {
        const retryAnswer = answerValueToString(retry.value ?? null).trim();
        const retryNormalized = this.applyGreenhouseRequiredHeuristics(aiQuestion, retryAnswer, profile, {
          logger: aiContext.logger,
          fieldId: field.id,
          stage: "resolve_missing_required_retry"
        });
        const retryMatch = findBestOptionMatch(retryNormalized, finalOptionPool) ?? findBestOptionMatch(retryAnswer, finalOptionPool);
        if (retryMatch) {
          return retryMatch.trim();
        }
        aiContext.logger?.info("greenhouse_option_answer_rejected", {
          fieldId: field.id,
          label,
          controlType: mappedType.kind,
          required: true,
          selectedAnswer: retryNormalized || retryAnswer,
          options: finalOptionPool,
          stage: "resolve_missing_required_retry"
        });
      }

      aiContext.logger?.info("greenhouse_required_option_unresolved", {
        fieldId: field.id,
        label,
        controlType: mappedType.kind,
        required: true,
        selectedAnswer: normalized || aiAnswer,
        options: finalOptionPool,
        stage: "resolve_missing_required"
      });
      return "";
    }

    normalized = this.normalizeAnswerForFieldType(mappedType.kind, normalized, finalOptionPool, aiQuestion.label);
    if (mappedType.kind === "select" || mappedType.kind === "combobox") {
      normalized = this.normalizeSelectAnswer(normalized);
    }
    return normalized.trim();
  }

  private assertLlmConfiguredForGreenhouseAutoSubmit(config: AdapterRunContext["config"]): void {
    if (config.ai.provider === "none") {
      throw new Error(
        "Greenhouse auto-submit hardening requires LLM mode. Set config.ai.provider to openai or ollama."
      );
    }

    if (config.ai.provider !== "openai") {
      return;
    }

    const envKey = config.ai.openai?.apiKeyEnv ?? "OPENAI_API_KEY";
    const hasKey = Boolean(
      process.env[envKey] ||
      process.env.OPENAI_API_KEY ||
      process.env.OPEN_AI_KEY ||
      process.env.OPENAI_KEY
    );

    if (!hasKey) {
      throw new Error(
        `Greenhouse auto-submit hardening requires OpenAI credentials. Missing API key in ${envKey} (or OPENAI_API_KEY/OPENAI_KEY).`
      );
    }
  }

  private getDemographicFieldKind(normalizedLabel: string): DemographicFieldKind | undefined {
    if (/pronoun/.test(normalizedLabel)) return "pronoun";
    if (/sexual orientation/.test(normalizedLabel)) return "sexual_orientation";
    if (/gender identity|\bgender\b|\bsex\b/.test(normalizedLabel)) return "gender_identity";
    if (/race|ethnicity|eeo|eeoc/.test(normalizedLabel)) return "race_ethnicity";
    return undefined;
  }

  private looksLikeCountryCodeOptionSet(options: string[]): boolean {
    const meaningful = options
      .map((option) => option.trim())
      .filter((option) => option.length > 0 && !isPlaceholderOption(option));
    if (meaningful.length < 3) return false;
    const dialCodeHits = meaningful.filter((option) => /\+\d{1,4}\b/.test(option)).length;
    return dialCodeHits >= 3;
  }

  private pickPreferNotDemographicOption(optionPool: string[]): string | undefined {
    const options = optionPool.map((option) => ({ raw: option, normalized: normalizeText(option) }));
    const patterns = [
      /i don't wish to answer|i do not wish to answer/,
      /do not wish to answer|don't wish to answer/,
      /decline to self[- ]?identify|decline to self identify|decline/,
      /prefer not to say/,
      /choose not to answer|choose not/,
      /prefer not/,
      /self describe/
    ];
    for (const pattern of patterns) {
      const matched = options.find((option) => pattern.test(option.normalized));
      if (matched) return matched.raw;
    }
    return undefined;
  }

  private readCustomAnswerValue(profile: AdapterRunContext["profile"], keys: string[]): string | undefined {
    const custom = profile.customAnswers ?? {};
    for (const key of keys) {
      const direct = custom[key];
      if (typeof direct === "string" && direct.trim()) return direct.trim();
    }
    const normalizedKeys = new Set(keys.map((key) => normalizeText(key)));
    for (const [key, value] of Object.entries(custom)) {
      if (!normalizedKeys.has(normalizeText(key))) continue;
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  }

  private mapDemographicAnswer(
    question: ApplicationQuestion,
    optionPool: string[],
    profile: AdapterRunContext["profile"],
    telemetry?: { logger?: AdapterRunContext["logger"]; fieldId?: string; stage?: string }
  ): string | undefined {
    const normalizedLabel = normalizeText(question.label);
    const kind = this.getDemographicFieldKind(normalizedLabel);
    if (!kind || !optionPool.length) return undefined;
    const emit = (strategy: "explicit_profile" | "prefer_not_to_answer" | "unresolved", selectedAnswer?: string): void => {
      telemetry?.logger?.info("greenhouse_demographic_mapper_used", {
        fieldId: telemetry.fieldId ?? question.id,
        label: question.label,
        demographicKind: kind,
        strategy,
        selectedAnswer: selectedAnswer ?? null,
        stage: telemetry.stage ?? "apply_heuristics"
      });
    };

    let explicitAnswer = "";
    if (kind === "pronoun") {
      explicitAnswer = this.readCustomAnswerValue(profile, ["pronouns", "pronoun"]) ?? "";
    } else if (kind === "sexual_orientation") {
      explicitAnswer = this.readCustomAnswerValue(profile, ["sexual orientation", "sexual_orientation", "orientation"]) ?? "";
    } else if (kind === "gender_identity") {
      explicitAnswer =
        this.readCustomAnswerValue(profile, ["gender identity", "gender_identity", "gender", "sex"]) ??
        profile.workday?.demographics?.gender ??
        "";
    } else if (kind === "race_ethnicity") {
      explicitAnswer =
        this.readCustomAnswerValue(profile, ["race", "race ethnicity", "race_ethnicity", "ethnicity", "hispanic or latino"]) ??
        profile.workday?.demographics?.raceEthnicity ??
        profile.workday?.demographics?.ethnicity ??
        "";
    }

    if (explicitAnswer) {
      const explicitMatch = findBestOptionMatch(explicitAnswer, optionPool);
      if (explicitMatch) {
        emit("explicit_profile", explicitMatch);
        return explicitMatch;
      }
    }

    const preferNot = this.pickPreferNotDemographicOption(optionPool);
    if (preferNot) {
      emit("prefer_not_to_answer", preferNot);
      return preferNot;
    }

    emit("unresolved");
    return undefined;
  }

  private applyGreenhouseRequiredHeuristics(
    question: ApplicationQuestion,
    answer: string,
    profile: AdapterRunContext["profile"],
    telemetry?: { logger?: AdapterRunContext["logger"]; fieldId?: string; stage?: string }
  ): string {
    const label = normalizeText(question.label);
    const hintedOptions = Array.isArray(question.platformMeta?.optionHints)
      ? (question.platformMeta.optionHints as string[])
      : [];
    const optionPool = question.options?.length ? question.options : hintedOptions;

    const pickFromPool = (candidate: string): string => {
      if (!optionPool.length) return candidate;
      return pickBestOption(candidate, optionPool);
    };

    const mappedDemographic = this.mapDemographicAnswer(question, optionPool, profile, telemetry);
    if (mappedDemographic) {
      return mappedDemographic;
    }

    if (/authorized to work|work authorization|legally authorized/.test(label)) {
      if (typeof profile.workAuthorization?.authorizedToWork === "boolean") {
        return pickFromPool(profile.workAuthorization.authorizedToWork ? "Yes" : "No");
      }
    }

    if (/legally eligible to work|eligible to work in (the )?country|right to work/.test(label)) {
      if (typeof profile.workAuthorization?.authorizedToWork === "boolean") {
        return pickFromPool(profile.workAuthorization.authorizedToWork ? "Yes" : "No");
      }
    }

    if (/eu|european union|member state|eu\/efta/.test(label) && /\bcitizen|citizenship|national\b/.test(label)) {
      const customAnswers = profile.customAnswers ?? {};
      let explicitEuCitizen: boolean | undefined;
      for (const [key, value] of Object.entries(customAnswers)) {
        if (!/eu|european union|member state|eu\/efta/.test(normalizeText(key))) continue;
        if (typeof value === "boolean") {
          explicitEuCitizen = value;
          break;
        }
        if (typeof value === "string") {
          const normalizedValue = normalizeText(value);
          if (["yes", "true", "y", "1"].includes(normalizedValue)) {
            explicitEuCitizen = true;
            break;
          }
          if (["no", "false", "n", "0"].includes(normalizedValue)) {
            explicitEuCitizen = false;
            break;
          }
        }
      }
      if (typeof explicitEuCitizen === "boolean") {
        return pickFromPool(explicitEuCitizen ? "Yes" : "No");
      }
      const normalizedCountry = normalizeText(profile.country || "");
      if (normalizedCountry) {
        return pickFromPool(EU_EFTA_COUNTRIES.has(normalizedCountry) ? "Yes" : "No");
      }
      if (typeof profile.workAuthorization?.authorizedToWork === "boolean" && profile.workAuthorization?.requiresSponsorship === true) {
        return pickFromPool("No");
      }
    }

    if (/require sponsorship|need sponsorship|visa sponsorship/.test(label)) {
      if (typeof profile.workAuthorization?.requiresSponsorship === "boolean") {
        return pickFromPool(profile.workAuthorization.requiresSponsorship ? "Yes" : "No");
      }
    }

    if (/how.*hear|how.*find|where.*hear|how did you hear|how did you find|referral source/.test(label)) {
      const preferredSource =
        typeof profile.customAnswers?.application_source === "string"
          ? String(profile.customAnswers.application_source)
          : profile.links?.linkedin
            ? "LinkedIn"
            : "Company Website";
      return pickFromPool(preferredSource);
    }

    if (/willing.*relocate|open.*relocation/.test(label)) {
      return pickFromPool("No");
    }

    if (/status.*allows? you to work and live|work authorization status|immigration status|eligible.*status.*work/.test(label)) {
      const requiresSponsorship = profile.workAuthorization?.requiresSponsorship;
      const pickAuthorized = (): string => {
        const authorized = optionPool.find((option) =>
          /\bcitizen\b|permanent resident|green card|authorized.*without.*sponsorship|no sponsorship|does not require sponsorship|unrestricted/i.test(
            option
          )
        );
        return authorized ?? pickFromPool("Citizen / Permanent Resident");
      };
      if (requiresSponsorship === false || profile.workAuthorization?.authorizedToWork === true) {
        return pickAuthorized();
      }
      if (requiresSponsorship === true) {
        return pickFromPool("Work Visa");
      }
    }

    if (
      /comfortable|able|willing/.test(label) &&
      /(on[- ]?site|onsite|in[- ]?person|office|commute|days?\s+a\s+week|\b3\s+days?\b|\bthree\s+days?\b)/.test(label)
    ) {
      const custom = profile.customAnswers ?? {};
      const onsiteSignals = [
        custom["able to work onsite"],
        custom["work onsite"],
        custom["onsite"],
        custom["open to relocation"],
        custom["willing to relocate"]
      ];
      const preferred = onsiteSignals.find((value) => typeof value === "boolean" || typeof value === "string");
      if (typeof preferred === "boolean") {
        return pickFromPool(preferred ? "Yes" : "No");
      }
      if (typeof preferred === "string" && preferred.trim()) {
        return pickFromPool(preferred);
      }
      return pickFromPool("Yes");
    }

    const isLocationModeQuestion =
      /(location mode|work model|work arrangement|preferred work (location|model)|remote\/hybrid|hybrid\/remote)/.test(label) ||
      (/(remote|hybrid|onsite|on-site)/.test(label) && /(preference|preferred|choose|model|arrangement)/.test(label));
    if (isLocationModeQuestion && optionPool.length) {
      const explicit = profile.customAnswers?.location_mode;
      if (typeof explicit === "string" && explicit.trim()) {
        return pickFromPool(explicit);
      }
      return pickFromPool("Remote");
    }

    if (this.isLocationBasedPrompt(label)) {
      const locationAnswer = this.pickLocationAnswerForQuestion(question, optionPool, profile, answer);
      if (locationAnswer) {
        return locationAnswer;
      }
    }

    if (/\bdegree\b/.test(label) && optionPool.length) {
      const preferredDegree =
        answer ||
        profile.education?.highestDegree ||
        profile.education?.degree ||
        profile.education?.field ||
        "";
      const mappedDegree = this.mapDegreeAnswerToOption(preferredDegree, optionPool);
      if (mappedDegree) {
        return mappedDegree;
      }
      // Avoid typing invalid freeform degree strings into categorical selects.
      return "";
    }

    if (optionPool.length) {
      const mappedCommon = this.mapCommonGreenhouseOption(label, answer, optionPool, profile);
      if (mappedCommon) {
        return mappedCommon;
      }
    }

    if (!answer && optionPool.length) {
      return pickBestOption("Yes", optionPool);
    }

    if (optionPool.length) {
      return pickBestOption(answer, optionPool);
    }

    return answer;
  }

  private isLocationBasedPrompt(normalizedLabel: string): boolean {
    return /(location\s*\(\s*city\s*\)|current(ly)? location|current city|where are you currently located|where are you located|where are you currently based|where are you based|candidate[-\s]?location|location city|city\s*[,/]\s*state|current(ly)? based|based in)/.test(normalizedLabel);
  }

  private classifyComboboxSemantic(normalizedLabel: string): ComboboxSemantic {
    if (/country code|dial code|phone country|phone code/.test(normalizedLabel)) return "phone_country_code";
    if (this.isLocationBasedPrompt(normalizedLabel)) return "city_location";
    if (/\bschool\b|\buniversity\b|\bcollege\b|\binstitution\b/.test(normalizedLabel)) return "school";
    if (/\bdegree\b/.test(normalizedLabel)) return "degree";
    if (/\bdiscipline\b|\bmajor\b|\bfield of study\b/.test(normalizedLabel)) return "discipline";
    if (Boolean(this.getDemographicFieldKind(normalizedLabel))) return "demographic";
    return "generic_select";
  }

  private isStreetAddressLike(value: string | undefined): boolean {
    const normalized = normalizeText(value || "");
    if (!normalized) return false;
    return (
      /^\d{1,6}\s+/.test(normalized) &&
      /\b(st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|ct|court|way|pkwy|parkway|pl|place|apt|suite|unit)\b/.test(normalized)
    );
  }

  private buildCityStateCountryCandidate(profile: AdapterRunContext["profile"]): string | undefined {
    const rawLocation = profile.basics.location?.trim() || "";
    const locationParts = rawLocation
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    let city = locationParts[0] || "";
    if (this.isStreetAddressLike(city) && locationParts[1]) {
      city = locationParts[1] || city;
    }
    let region = locationParts[1] || "";
    if (/^\d{4,6}$/.test(normalizeText(region)) && locationParts[2]) {
      region = locationParts[2] || region;
    }
    if (this.isStreetAddressLike(region) && locationParts[2]) {
      region = locationParts[2] || region;
    }
    const fullState = this.toUsStateFull(profile.state) ?? this.toUsStateFull(region) ?? region;
    const country = profile.country || "";
    const cityTrimmed = city.trim();
    const stateTrimmed = (fullState || "").trim();
    const countryTrimmed = country.trim();
    if (!cityTrimmed) return undefined;
    if (stateTrimmed && countryTrimmed) return `${cityTrimmed}, ${stateTrimmed}, ${countryTrimmed}`;
    if (stateTrimmed) return `${cityTrimmed}, ${stateTrimmed}`;
    if (countryTrimmed) return `${cityTrimmed}, ${countryTrimmed}`;
    return cityTrimmed;
  }

  private toUsStateFull(value: string | undefined): string | undefined {
    const normalized = normalizeText(value || "");
    if (!normalized) return undefined;
    const byName = Object.entries(US_STATE_ABBR_TO_NAME).find(([, name]) => normalizeText(name) === normalized)?.[1];
    if (byName) return byName;
    const direct = US_STATE_ABBR_TO_NAME[normalized.toUpperCase()];
    if (direct) return direct;
    return undefined;
  }

  private toUsStateAbbr(value: string | undefined): string | undefined {
    const normalized = normalizeText(value || "");
    if (!normalized) return undefined;
    if (normalized.length === 2) {
      const upper = normalized.toUpperCase();
      if (US_STATE_ABBR_TO_NAME[upper]) return upper;
    }
    return US_STATE_NAME_TO_ABBR[normalized];
  }

  private buildGeoAnswerCandidates(profile: AdapterRunContext["profile"]): string[] {
    const out: string[] = [];
    const push = (value: string | undefined): void => {
      const trimmed = (value || "").trim();
      if (!trimmed) return;
      if (!out.some((existing) => normalizeText(existing) === normalizeText(trimmed))) {
        out.push(trimmed);
      }
    };

    const rawLocation = profile.basics.location?.trim() || "";
    const locationParts = rawLocation
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    let city = locationParts[0];
    if (this.isStreetAddressLike(city) && locationParts[1]) {
      city = locationParts[1];
    }
    const region = locationParts[1];
    const fullState = this.toUsStateFull(profile.state) ?? this.toUsStateFull(region);
    const stateAbbr = this.toUsStateAbbr(profile.state) ?? this.toUsStateAbbr(region);
    const cityStateCountry = this.buildCityStateCountryCandidate(profile);
    push(cityStateCountry);
    if (city && fullState) push(`${city}, ${fullState}`);
    if (city && stateAbbr) push(`${city}, ${stateAbbr}`);
    push(city);
    push(fullState);
    push(stateAbbr);
    push(profile.country);
    if (/united states|^us$|^usa$/i.test(profile.country || "")) {
      push("United States");
    }

    return out;
  }

  private mapToKnownOption(candidate: string | undefined, optionPool: string[]): string | undefined {
    const trimmed = (candidate || "").trim();
    if (!trimmed || !optionPool.length) return undefined;
    const picked = pickBestOption(trimmed, optionPool);
    if (!optionPool.some((option) => normalizeText(option) === normalizeText(picked))) {
      return undefined;
    }
    return picked;
  }

  private classifyGeoOptionPool(optionPool: string[]): "country" | "state" | "other" {
    const normalizedOptions = optionPool
      .map((option) => option.trim())
      .filter((option) => !isPlaceholderOption(option))
      .map((option) => normalizeText(option));
    if (!normalizedOptions.length) return "other";

    const countrySignals = [
      "united states",
      "united states of america",
      "afghanistan",
      "canada",
      "mexico",
      "germany",
      "france",
      "india",
      "china",
      "japan",
      "australia",
      "united kingdom"
    ];
    const stateNames = new Set(Object.values(US_STATE_ABBR_TO_NAME).map((name) => normalizeText(name)));
    const stateAbbrs = new Set(Object.keys(US_STATE_ABBR_TO_NAME).map((abbr) => normalizeText(abbr)));

    const countryHits = normalizedOptions.filter((option) =>
      countrySignals.some((signal) => option === signal || option.includes(signal))
    ).length;
    const stateHits = normalizedOptions.filter((option) => stateNames.has(option) || stateAbbrs.has(option)).length;

    if (countryHits >= 2 || normalizedOptions.some((option) => option === "afghanistan")) return "country";
    if (stateHits >= 2 && countryHits === 0) return "state";
    return "other";
  }

  private pickLocationAnswerForQuestion(
    question: ApplicationQuestion,
    optionPool: string[],
    profile: AdapterRunContext["profile"],
    fallbackAnswer: string
  ): string | undefined {
    const candidates = this.buildGeoAnswerCandidates(profile);
    const normalizedLabel = normalizeText(question.label);
    const inputKind = typeof question.platformMeta?.inputKind === "string"
      ? normalizeText(String(question.platformMeta.inputKind))
      : "";
    const isSelectable = ["select", "combobox", "radio-group", "checkbox-group"].includes(inputKind) || question.type === "single_select";
    if (!optionPool.length) {
      const cityStateCountry = this.buildCityStateCountryCandidate(profile);
      if (/\bcity\b|location\s*\(\s*city\s*\)|candidate[-\s]?location/.test(normalizedLabel) && cityStateCountry) {
        return cityStateCountry;
      }
      if (/\bcountry\b/.test(normalizedLabel)) {
        return profile.country ?? "United States";
      }
      if (/\bstate\b|\bprovince\b/.test(normalizedLabel)) {
        return this.toUsStateFull(profile.state) ?? this.toUsStateAbbr(profile.state) ?? profile.state ?? fallbackAnswer;
      }
      // Ambiguous "based" combobox/select questions are more often country lists.
      if (isSelectable) {
        return profile.country ?? "United States";
      }
      return candidates[0] ?? fallbackAnswer;
    }

    const poolType = this.classifyGeoOptionPool(optionPool);
    if (poolType === "country") {
      return (
        this.mapToKnownOption(profile.country, optionPool) ??
        this.mapToKnownOption("United States", optionPool) ??
        this.mapToKnownOption(fallbackAnswer, optionPool)
      );
    }

    if (poolType === "state") {
      const stateCandidates = [
        this.toUsStateFull(profile.state),
        this.toUsStateAbbr(profile.state),
        ...candidates
      ];
      for (const candidate of stateCandidates) {
        const mapped = this.mapToKnownOption(candidate, optionPool);
        if (mapped) return mapped;
      }
      return this.mapToKnownOption(fallbackAnswer, optionPool);
    }

    if (isSelectable && this.isLocationBasedPrompt(normalizedLabel)) {
      const forcedCountry = this.mapToKnownOption(profile.country ?? "United States", optionPool) ??
        this.mapToKnownOption("United States", optionPool);
      if (forcedCountry) return forcedCountry;
    }

    for (const candidate of candidates) {
      const mapped = this.mapToKnownOption(candidate, optionPool);
      if (mapped) return mapped;
    }
    return this.mapToKnownOption(fallbackAnswer, optionPool);
  }

  private mapDegreeAnswerToOption(answer: string, optionPool: string[]): string | undefined {
    const matched = findBestOptionMatch(answer, optionPool);
    if (matched) return matched;

    const normalized = normalizeText(answer);
    if (!normalized) return undefined;

    const classify = (() => {
      if (/\bassociate|a\.?\s*a\b|a\.?\s*s\b/.test(normalized)) return "associate";
      if (/\bbachelor|b\.?\s*a\b|b\.?\s*s\b|undergrad/.test(normalized)) return "bachelor";
      if (/\bmaster|m\.?\s*a\b|m\.?\s*s\b|mba\b/.test(normalized)) return "master";
      if (/\bphd\b|doctor|d\.?\s*phil\b|d\.?\s*sc\b|jd\b/.test(normalized)) return "doctorate";
      if (/\bhigh school\b|secondary/.test(normalized)) return "high_school";
      return "";
    })();
    if (!classify) return undefined;

    const options = optionPool.map((option) => ({
      raw: option,
      normalized: normalizeText(option)
    }));

    const byCategory = (category: string): string | undefined => {
      if (category === "associate") {
        return options.find((option) => /\bassociate\b/.test(option.normalized))?.raw;
      }
      if (category === "bachelor") {
        return options.find((option) => /\bbachelor\b/.test(option.normalized))?.raw;
      }
      if (category === "master") {
        return options.find((option) => /\bmaster|mba\b/.test(option.normalized))?.raw;
      }
      if (category === "doctorate") {
        return options.find((option) => /\bdoctor|phd|jd\b/.test(option.normalized))?.raw;
      }
      if (category === "high_school") {
        return options.find((option) => /\bhigh school|secondary\b/.test(option.normalized))?.raw;
      }
      return undefined;
    };

    return byCategory(classify);
  }

  private mapCommonGreenhouseOption(
    normalizedLabel: string,
    answer: string,
    optionPool: string[],
    profile: AdapterRunContext["profile"]
  ): string | undefined {
    if (!optionPool.length) return undefined;
    const normalizedAnswer = normalizeText(answer);
    const options = optionPool.map((option) => ({ raw: option, normalized: normalizeText(option) }));
    const pickByPatterns = (patterns: RegExp[]): string | undefined => {
      for (const pattern of patterns) {
        const matched = options.find((option) => pattern.test(option.normalized));
        if (matched) return matched.raw;
      }
      return undefined;
    };
    const coerceBool = (value: unknown): boolean | undefined => {
      if (typeof value === "boolean") return value;
      if (typeof value !== "string") return undefined;
      const normalized = normalizeText(value);
      if (["true", "yes", "y", "1"].includes(normalized)) return true;
      if (["false", "no", "n", "0"].includes(normalized)) return false;
      return undefined;
    };
    const customEthnicityRaw = profile.customAnswers?.["ethnicity"] ?? profile.customAnswers?.["race"];
    const customEthnicity = typeof customEthnicityRaw === "string" ? normalizeText(customEthnicityRaw) : "";

    if (
      /comfortable|able|willing/.test(normalizedLabel) &&
      /(on[- ]?site|onsite|in[- ]?person|office|commute|days?\s+a\s+week|\b3\s+days?\b|\bthree\s+days?\b)/.test(normalizedLabel)
    ) {
      const custom = profile.customAnswers ?? {};
      const onsiteSignals = [
        custom["able to work onsite"],
        custom["work onsite"],
        custom["onsite"],
        custom["open to relocation"],
        custom["willing to relocate"]
      ];
      const preferred = onsiteSignals.find((value) => typeof value === "boolean" || typeof value === "string");
      const preferredBool = coerceBool(preferred);
      if (preferredBool === true) {
        return pickByPatterns([/\byes\b/, /\bcomfortable\b/, /\bable\b/]);
      }
      if (preferredBool === false) {
        return pickByPatterns([/\bno\b/, /\bnot\b.*\bable\b/, /\bnot\b.*\bcomfortable\b/]);
      }
      if (normalizedAnswer === "yes") {
        return pickByPatterns([/\byes\b/]);
      }
      if (normalizedAnswer === "no") {
        return pickByPatterns([/\bno\b/]);
      }
      return pickByPatterns([/\byes\b/, /\bcomfortable\b/, /\bable\b/]);
    }

    if (/country code|dial code/.test(normalizedLabel)) {
      return pickByPatterns([/\+?1\b/, /\bunited states\b/, /^us$/, /^usa$/]);
    }

    if (
      /export control|citizenship|nationality|permanent residence|which option applies to you/.test(normalizedLabel) &&
      optionPool.some((option) =>
        /citizen or national of the united states|lawful permanent resident|none of the above/i.test(option)
      )
    ) {
      const authorizedNoSponsor =
        profile.workAuthorization?.authorizedToWork === true ||
        profile.workAuthorization?.requiresSponsorship === false ||
        (/united states|^us$|^usa$/i.test(profile.country || "") && profile.workAuthorization?.requiresSponsorship !== true);
      if (authorizedNoSponsor) {
        return pickByPatterns([
          /citizen or national of the united states/,
          /lawful permanent resident|greencard|green card holder/,
          /\bcitizen\b/
        ]);
      }
      return pickByPatterns([/none of the above/]);
    }

    if (/\bcountry\b/.test(normalizedLabel)) {
      const preferredCountry = profile.country || "United States";
      const exactCountry = options.find((option) => option.normalized === normalizeText(preferredCountry));
      if (exactCountry) return exactCountry.raw;
      return pickByPatterns([/\bunited states of america\b/, /\bunited states\b/, /^us$/, /^usa$/]);
    }

    if (/status.*allows? you to work and live|work authorization status|immigration status|eligible.*status.*work/.test(normalizedLabel)) {
      const requiresSponsorship = profile.workAuthorization?.requiresSponsorship;
      if (requiresSponsorship === false) {
        return pickByPatterns([
          /\bcitizen\b/,
          /permanent resident|green card/,
          /authorized.*without.*sponsorship|no sponsorship|does not require sponsorship|unrestricted/
        ]);
      }
      if (requiresSponsorship === true) {
        return pickByPatterns([/work visa|visa|permit|sponsorship required/]);
      }
      return pickByPatterns([/\bcitizen\b/, /permanent resident|green card/, /work visa|visa|permit/]);
    }

    if (/veteran|military|armed forces/.test(normalizedLabel)) {
      const customVeteran = coerceBool(profile.customAnswers?.["veteran status"] ?? profile.customAnswers?.["veteran"]);
      const isNoVeteran =
        customVeteran === false ||
        /\bnot\b.*\bprotected veteran\b/.test(normalizedAnswer) ||
        /\bnot\b.*\bveteran\b/.test(normalizedAnswer) ||
        normalizedAnswer === "no";
      const isYesVeteran =
        customVeteran === true ||
        (/\bprotected veteran\b/.test(normalizedAnswer) && !/\bnot\b/.test(normalizedAnswer)) ||
        (/\bveteran\b/.test(normalizedAnswer) && !/\bnot\b/.test(normalizedAnswer)) ||
        normalizedAnswer === "yes";

      if (isNoVeteran) {
        return pickByPatterns([/\bnot\b.*\bprotected veteran\b/, /\bnot\b.*\bveteran\b/, /\bno\b/]);
      }
      if (isYesVeteran) {
        return pickByPatterns([/\bprotected veteran\b/, /\bveteran\b/, /\byes\b/]);
      }
    }

    if (/disability|disabled|handicap/.test(normalizedLabel)) {
      const customDisability = coerceBool(profile.customAnswers?.["disability status"] ?? profile.customAnswers?.["disability"]);
      const isNoDisability =
        customDisability === false ||
        /no.*(do not|don't).*(disability|disabled)/.test(normalizedAnswer) ||
        /\bno\b.*\bdisability\b/.test(normalizedAnswer) ||
        normalizedAnswer === "no";
      const isYesDisability =
        customDisability === true ||
        /yes.*(disability|disabled)/.test(normalizedAnswer) ||
        /\bhave\b.*\bdisability\b/.test(normalizedAnswer) ||
        normalizedAnswer === "yes";
      const isDeclined = /prefer not|do not wish|decline|choose not/.test(normalizedAnswer);

      if (isNoDisability) {
        return pickByPatterns([/no.*(do not|don't).*(disability|disabled)/, /\bno\b.*\bdisability\b/, /\bno\b/]);
      }
      if (isYesDisability) {
        return pickByPatterns([/yes.*(disability|disabled)/, /\bhave\b.*\bdisability\b/, /\byes\b/]);
      }
      if (isDeclined) {
        return pickByPatterns([/prefer not|do not wish|decline|choose not/]);
      }
    }

    if (/hispanic|latino/.test(normalizedLabel)) {
      const customHispanic = coerceBool(profile.customAnswers?.["hispanic or latino"]);
      if (customHispanic === true) {
        return pickByPatterns([/\byes\b/, /hispanic|latino/]);
      }
      if (customHispanic === false) {
        return pickByPatterns([/\bno\b/, /not.*hispanic|not.*latino/]);
      }
      if (["yes", "true", "1"].includes(normalizedAnswer)) {
        return pickByPatterns([/\byes\b/, /hispanic|latino/]);
      }
      if (["no", "false", "0"].includes(normalizedAnswer)) {
        return pickByPatterns([/\bno\b/]);
      }
    }

    if (/race|ethnicity|eeo|eeoc/.test(normalizedLabel)) {
      if (/hispanic|latino/.test(customEthnicity)) {
        return pickByPatterns([/hispanic|latino/]);
      }
      if (/\basian\b/.test(customEthnicity)) {
        return pickByPatterns([/\basian\b/]);
      }
      if (/\bblack\b|african/.test(customEthnicity)) {
        return pickByPatterns([/black|african/]);
      }
      if (/\bwhite\b/.test(customEthnicity)) {
        return pickByPatterns([/\bwhite\b/]);
      }
      if (/two or more|multi/.test(customEthnicity)) {
        return pickByPatterns([/two or more|multiple/]);
      }
      if (/native/.test(customEthnicity)) {
        return pickByPatterns([/native|american indian|alaska native/]);
      }
      if (/pacific/.test(customEthnicity)) {
        return pickByPatterns([/pacific islander|hawaiian/]);
      }
      return pickByPatterns([/prefer not|decline|choose not/]);
    }

    if (/gender|sex/.test(normalizedLabel) && normalizedAnswer) {
      const exact = options.find((option) => option.normalized === normalizedAnswer);
      if (exact) return exact.raw;
      const contains = options.find((option) => option.normalized.includes(normalizedAnswer));
      if (contains) return contains.raw;
      if (/male/.test(normalizedAnswer)) return pickByPatterns([/\bmale\b/]);
      if (/female/.test(normalizedAnswer)) return pickByPatterns([/\bfemale\b/]);
      if (/non[- ]?binary|nonbinary/.test(normalizedAnswer)) return pickByPatterns([/non[- ]?binary/]);
      if (/prefer not|decline|choose not/.test(normalizedAnswer)) {
        return pickByPatterns([/prefer not|decline|choose not/]);
      }
    }

    return undefined;
  }

  private async submitWithDeterministicAttempts(
    context: AdapterRunContext,
    answers: ResolvedAnswer[],
    filledFields: FilledFieldRecord[]
  ): Promise<SubmitSequenceResult> {
    const { page, profile, config } = context;
    const attempts: SubmitAttemptDiagnostics[] = [];
    const maxAttempts = Math.max(1, Math.min(config.greenhouse?.submissionPollSeconds ? 2 : 2, 3));
    let firstBlockingReason: SubmitFailureReasonTag | undefined;
    let reapplyOccurred = false;
    let challengeDetected = false;
    let latestValidationErrors: string[] = [];
    let latestMissingRequired: string[] = [];
    let latestMissingRequiredDetails: string[] = [];
    let latestResumeVerification: ResumeVerificationResult | undefined;
    let identityAuditBeforeSubmit: string[] = [];
    let identityAuditAfterSubmit: string[] = [];
    let identityCandidateAuditBeforeSubmit: string[] = [];
    let identityCandidateAuditAfterSubmit: string[] = [];
    let preSubmitBlocker: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await this.reconcileRequiredFieldsBeforeSubmit(page, answers, profile, filledFields, {
        logger: context.logger,
        aiEngine: context.aiEngine,
        resumeText: context.resumeText,
        jobTitle: context.target.jobTitle,
        company: context.target.company,
        config: context.config
      });
      const coreCheck = await this.verifyAndReapplyCoreIdentityFields(context, filledFields);
      reapplyOccurred = reapplyOccurred || coreCheck.reapplied;
      latestMissingRequired = coreCheck.missing;
      latestMissingRequiredDetails = coreCheck.missingDetails;
      latestResumeVerification = coreCheck.resumeVerification;
      identityAuditBeforeSubmit = coreCheck.identityAudit;
      identityCandidateAuditBeforeSubmit = coreCheck.identityCandidateAudit ?? [];
      preSubmitBlocker = coreCheck.preSubmitBlocker;

      const attemptResult: SubmitAttemptDiagnostics = {
        attempt,
        confirmed: false,
        validationErrors: [],
        missingRequired: coreCheck.missing,
        missingRequiredDetails: coreCheck.missingDetails,
        reapplyOccurred: coreCheck.reapplied,
        challengeDetected: false
      };

      if (preSubmitBlocker) {
        attemptResult.reasonTag = "validation_missing_fields";
        attempts.push(attemptResult);
        if (!firstBlockingReason) firstBlockingReason = attemptResult.reasonTag;
        return {
          submitted: false,
          reasonTag: attemptResult.reasonTag,
          firstBlockingReason,
          preSubmitBlocker,
          challengeDetected,
          validationErrors: latestValidationErrors,
          missingRequired: latestMissingRequired,
          missingRequiredDetails: latestMissingRequiredDetails,
          reapplyOccurred,
          resumeVerification: latestResumeVerification,
          identityAuditBeforeSubmit,
          identityAuditAfterSubmit,
          identityCandidateAuditBeforeSubmit,
          identityCandidateAuditAfterSubmit,
          attempts
        };
      }

      if (coreCheck.missing.length > 0 || !coreCheck.resumeVerified) {
        if (!coreCheck.resumeVerified) {
          attemptResult.reasonTag = "validation_missing_fields";
          attempts.push(attemptResult);
          if (!firstBlockingReason) firstBlockingReason = attemptResult.reasonTag;
          return {
            submitted: false,
            reasonTag: attemptResult.reasonTag,
            firstBlockingReason,
            challengeDetected,
            validationErrors: latestValidationErrors,
            missingRequired: latestMissingRequired,
            missingRequiredDetails: latestMissingRequiredDetails,
            reapplyOccurred,
            resumeVerification: latestResumeVerification,
            identityAuditBeforeSubmit,
            identityAuditAfterSubmit,
            identityCandidateAuditBeforeSubmit,
            identityCandidateAuditAfterSubmit,
            preSubmitBlocker,
            attempts
          };
        }

        const stopReason = evaluateSubmitStopReason({
          attempt,
          maxAttempts,
          missingSignature: `${coreCheck.missing.join("|")}::${coreCheck.missingDetails.join("|")}::resume=${coreCheck.resumeVerified ? "ok" : "missing"}`,
          challengeDetected: false
        });
        if (stopReason) {
          const hasMissingEvidence = coreCheck.missing.length > 0 || coreCheck.missingDetails.length > 0 || !coreCheck.resumeVerified;
          attemptResult.reasonTag =
            stopReason === "validation_missing_fields" && !hasMissingEvidence
              ? "confirmation_not_detected"
              : stopReason;
          attempts.push(attemptResult);
          if (!firstBlockingReason) firstBlockingReason = attemptResult.reasonTag;
          return {
            submitted: false,
            reasonTag: attemptResult.reasonTag,
            firstBlockingReason,
            challengeDetected,
            validationErrors: latestValidationErrors,
            missingRequired: latestMissingRequired,
            missingRequiredDetails: latestMissingRequiredDetails,
            reapplyOccurred,
            resumeVerification: latestResumeVerification,
            identityAuditBeforeSubmit,
            identityAuditAfterSubmit,
            identityCandidateAuditBeforeSubmit,
            identityCandidateAuditAfterSubmit,
            preSubmitBlocker,
            attempts
          };
        }
      }

      await this.primeRecaptchaToken(page).catch(() => undefined);
      await this.syncAllRequiredSelectSentinels(page).catch(() => undefined);

      const submitButton = page.locator('button[type="submit"], #submit_app, input[type="submit"]').first();
      if (!(await submitButton.count())) {
        attemptResult.reasonTag = "submit_unavailable";
        attempts.push(attemptResult);
        if (!firstBlockingReason) firstBlockingReason = attemptResult.reasonTag;
        return {
          submitted: false,
          reasonTag: attemptResult.reasonTag,
          firstBlockingReason,
          challengeDetected,
          validationErrors: latestValidationErrors,
          missingRequired: latestMissingRequired,
          missingRequiredDetails: latestMissingRequiredDetails,
          reapplyOccurred,
          resumeVerification: latestResumeVerification,
          identityAuditBeforeSubmit,
          identityAuditAfterSubmit,
          identityCandidateAuditBeforeSubmit,
          identityCandidateAuditAfterSubmit,
          preSubmitBlocker,
          attempts
        };
      }

      await submitButton.click({ timeout: 10000 });
      const sweep = await this.shortPostSubmitSweep(page, Math.min(config.greenhouse?.submissionPollSeconds ?? 14, 14));
      const effectiveChallengeDetected = sweep.challengeDetected && sweep.validationErrors.length === 0;
      challengeDetected = challengeDetected || effectiveChallengeDetected;
      identityAuditAfterSubmit = await this.collectIdentityAuditNotes(page);
      identityCandidateAuditAfterSubmit = await this.collectIdentityCandidateAuditNotes(page);

      if (sweep.confirmed) {
        attemptResult.confirmed = true;
        attemptResult.challengeDetected = sweep.challengeDetected;
        attempts.push(attemptResult);
        return {
          submitted: true,
          firstBlockingReason,
          challengeDetected,
          validationErrors: [],
          missingRequired: [],
          missingRequiredDetails: [],
          reapplyOccurred,
          resumeVerification: latestResumeVerification,
          identityAuditBeforeSubmit,
          identityAuditAfterSubmit,
          identityCandidateAuditBeforeSubmit,
          identityCandidateAuditAfterSubmit,
          preSubmitBlocker,
          attempts
        };
      }

      latestValidationErrors = sweep.validationErrors;
      attemptResult.validationErrors = sweep.validationErrors;
      attemptResult.challengeDetected = effectiveChallengeDetected;

      if (sweep.validationErrors.length > 0) {
        if (attempt < maxAttempts) {
          await this.recoverFromValidationErrors(page, context, filledFields, sweep.validationErrors).catch(() => undefined);
          continue;
        }
        if (this.hasResumeValidationError(sweep.validationErrors) && latestResumeVerification?.confidence === "provisional") {
          latestResumeVerification = {
            ...latestResumeVerification,
            ok: false,
            confidence: "failed",
            verificationMode: "error",
            failureTag: "resume_rejected_post_submit",
            diagnostics: [
              ...(latestResumeVerification.diagnostics ?? []),
              "post_submit_resume_required"
            ].slice(0, 12)
          };
        }
        attemptResult.reasonTag = "validation_stable_errors";
        attempts.push(attemptResult);
        if (!firstBlockingReason) firstBlockingReason = attemptResult.reasonTag;
        return {
          submitted: false,
          reasonTag: attemptResult.reasonTag,
          firstBlockingReason,
          challengeDetected,
          validationErrors: latestValidationErrors,
          missingRequired: latestMissingRequired,
          missingRequiredDetails: latestMissingRequiredDetails,
          reapplyOccurred,
          resumeVerification: latestResumeVerification,
          identityAuditBeforeSubmit,
          identityAuditAfterSubmit,
          identityCandidateAuditBeforeSubmit,
          identityCandidateAuditAfterSubmit,
          preSubmitBlocker,
          attempts
        };
      }

      const rawStopReason = evaluateSubmitStopReason({
        attempt,
        maxAttempts,
        validationSignature: sweep.validationErrors.length ? sweep.validationErrors.join("|") : undefined,
        challengeDetected: sweep.challengeDetected
      });
      const stopReason =
        rawStopReason === "challenge_blocked" && sweep.validationErrors.length > 0
          ? undefined
          : rawStopReason;
      if (stopReason && stopReason !== "confirmation_not_detected") {
        attemptResult.reasonTag = stopReason;
        attempts.push(attemptResult);
        if (!firstBlockingReason) firstBlockingReason = attemptResult.reasonTag;
        return {
          submitted: false,
          reasonTag: attemptResult.reasonTag,
          firstBlockingReason,
          challengeDetected,
          validationErrors: latestValidationErrors,
          missingRequired: latestMissingRequired,
          missingRequiredDetails: latestMissingRequiredDetails,
          reapplyOccurred,
          resumeVerification: latestResumeVerification,
          identityAuditBeforeSubmit,
          identityAuditAfterSubmit,
          identityCandidateAuditBeforeSubmit,
          identityCandidateAuditAfterSubmit,
          preSubmitBlocker,
          attempts
        };
      }
      attemptResult.reasonTag = "confirmation_not_detected";
      attempts.push(attemptResult);
      if (!firstBlockingReason) firstBlockingReason = attemptResult.reasonTag;
      return {
        submitted: false,
        reasonTag: attemptResult.reasonTag,
        firstBlockingReason,
        challengeDetected,
        validationErrors: latestValidationErrors,
        missingRequired: latestMissingRequired,
        missingRequiredDetails: latestMissingRequiredDetails,
        reapplyOccurred,
        resumeVerification: latestResumeVerification,
        identityAuditBeforeSubmit,
        identityAuditAfterSubmit,
        identityCandidateAuditBeforeSubmit,
        identityCandidateAuditAfterSubmit,
        preSubmitBlocker,
        attempts
      };
    }

    if (!firstBlockingReason) {
      firstBlockingReason = "confirmation_not_detected";
    }

    return {
      submitted: false,
      reasonTag: "confirmation_not_detected",
      firstBlockingReason,
      challengeDetected,
      validationErrors: latestValidationErrors,
      missingRequired: latestMissingRequired,
      missingRequiredDetails: latestMissingRequiredDetails,
      reapplyOccurred,
      resumeVerification: latestResumeVerification,
      identityAuditBeforeSubmit,
      identityAuditAfterSubmit,
      identityCandidateAuditBeforeSubmit,
      identityCandidateAuditAfterSubmit,
      preSubmitBlocker,
      attempts
    };
  }

  private async verifyAndReapplyCoreIdentityFields(
    context: AdapterRunContext,
    filledFields: FilledFieldRecord[]
  ): Promise<CoreFieldCheckResult> {
    const { page, profile, config } = context;
    let reapplied = false;
    const identityIssues = await this.collectIdentityIssues(page);

    const applyIfMissingOrInvalid = async (id: string, label: string, value: string | undefined): Promise<boolean> => {
      if (!value) return false;
      const current = await this.readInputValue(page, id);
      const shouldReapply = !current.trim() || identityIssues.has(id);
      if (!shouldReapply) return false;
      const applied = await this.setIdentityValueById(page, id, value).catch(() => false);
      if (applied) {
        reapplied = true;
        this.upsertFilledField(filledFields, {
          id,
          label,
          value,
          source: "manual",
          inputKind: "text"
        });
      }
      return applied;
    };

    await applyIfMissingOrInvalid("first_name", "First Name", profile.basics.firstName);
    await applyIfMissingOrInvalid("last_name", "Last Name", profile.basics.lastName);
    await applyIfMissingOrInvalid("email", "Email", profile.basics.email);
    await applyIfMissingOrInvalid("phone", "Phone", this.splitPhone(profile.basics.phone).local);

    const firstNameSynced = await this.ensureIdentityFieldSynchronized(page, "first_name", profile.basics.firstName);
    const lastNameSynced = await this.ensureIdentityFieldSynchronized(page, "last_name", profile.basics.lastName);
    const emailSynced = await this.ensureIdentityFieldSynchronized(page, "email", profile.basics.email);
    const phoneSynced = await this.ensureIdentityFieldSynchronized(page, "phone", this.splitPhone(profile.basics.phone).local);
    if (!firstNameSynced || !lastNameSynced || !emailSynced || !phoneSynced) {
      reapplied = true;
    }

    let resumeVerified = true;
    let resumeVerification: ResumeVerificationResult | undefined;
    if (config.resumePath) {
      const effectiveResumePath = await this.resolveResumeUploadPath(page, config.resumePath);
      resumeVerification = await this.verifyStrictResumeUploadDetailed(page, effectiveResumePath);
      resumeVerified = resumeVerification.ok;
    }

    const missingDetails = await this.collectMissingRequiredDetails(page);
    const summarizedMissingDetails = summarizeMissingDetails(missingDetails);
    const missing = await this.collectMissingRequiredFields(page);
    let preSubmitBlocker: string | undefined;
    if (!firstNameSynced) {
      if (!missing.some((item) => normalizeText(item).includes("first name"))) {
        missing.push("First Name");
      }
      if (!summarizedMissingDetails.some((item) => normalizeText(item).includes("first_name"))) {
        summarizedMissingDetails.push("first_name:First Name:sync_mismatch");
      }
      preSubmitBlocker = "first_name_sync_failed";
    }
    if (!resumeVerified) {
      const explicitResumeDetail = resumeVerification?.resumeMissingDetail;
      if (explicitResumeDetail) {
        summarizedMissingDetails.push(explicitResumeDetail);
      }
      if (!summarizedMissingDetails.includes("resume:Resume:file")) {
        summarizedMissingDetails.push("resume:Resume:file");
      }
    }
    return {
      reapplied,
      missing,
      missingDetails: summarizedMissingDetails,
      resumeVerified,
      resumeVerification,
      identityAudit: await this.collectIdentityAuditNotes(page),
      identityCandidateAudit: await this.collectIdentityCandidateAuditNotes(page),
      preSubmitBlocker
    };
  }

  private async recoverFromValidationErrors(
    page: AdapterRunContext["page"],
    context: AdapterRunContext,
    filledFields: FilledFieldRecord[],
    validationErrors: string[]
  ): Promise<void> {
    const anchored = await this.extractSchemasFromValidationAnchors(page);
    if (!anchored.length) return;
    const questions: ApplicationQuestion[] = anchored.map((field) => {
      const kind: GreenhouseQuestion["inputKind"] = field.fieldType === "textarea"
        ? "textarea"
        : (field.fieldType === "react_select" || field.fieldType === "phone_country")
          ? "combobox"
          : field.fieldType === "radio"
            ? "radio-group"
            : field.fieldType === "checkbox_group"
              ? "checkbox-group"
              : "text";
      const type: QuestionType = kind === "textarea" ? "textarea" : (kind === "combobox" || kind === "radio-group" || kind === "checkbox-group") ? "single_select" : "text";
      return {
        id: field.fieldId,
        label: field.label,
        required: true,
        type,
        options: field.possibleAnswers,
        platformMeta: {
          inputKind: kind,
          domId: field.containerMeta.controlId ?? field.fieldId,
          selector: field.containerMeta.controlId ? `#${field.containerMeta.controlId}` : field.containerMeta.containerSelector,
          optionHints: field.possibleAnswers,
          validationContext: validationErrors.join(" | ")
        }
      };
    });
    const deterministic = this.buildDeterministicProfileAnswers(questions, context.profile, context.config.resumePath);
    const unresolved = questions.filter((q) => !deterministic.has(q.id));
    const aiResolved = unresolved.length
      ? await this.resolveQuestionsWithCache(unresolved, context).catch(() => [])
      : [];
    const aiById = new Map(aiResolved.map((item) => [item.questionId, item]));
    for (const question of questions) {
      const deterministicAnswer = deterministic.get(question.id);
      const aiAnswer = aiById.get(question.id);
      const chosen = deterministicAnswer ?? aiAnswer;
      const answer = answerValueToString(chosen?.value ?? "").trim();
      if (!answer) continue;
      const inputKind = String(question.platformMeta?.inputKind || "text") as GreenhouseQuestion["inputKind"];
      const ok = await this.applyAnswer(page, {
        key: question.id,
        id: question.id,
        label: question.label,
        required: true,
        options: question.options ?? [],
        type: question.type,
        inputKind,
        domId: typeof question.platformMeta?.domId === "string" ? question.platformMeta.domId : question.id,
        selector: typeof question.platformMeta?.selector === "string" ? question.platformMeta.selector : undefined
      }, this.normalizeAnswerForFieldType(inputKind, answer, question.options ?? [], question.label)).catch(() => false);
      if (!ok) continue;
      const verified = await this.verifyFieldSatisfied(page, question.id, inputKind, answer, {
        id: typeof question.platformMeta?.domId === "string" ? question.platformMeta.domId : question.id,
        selector: typeof question.platformMeta?.selector === "string" ? question.platformMeta.selector : undefined
      }).catch(() => false);
      if (!verified) continue;
      this.upsertFilledField(filledFields, {
        id: question.id,
        label: question.label,
        value: answer,
        source: this.toFilledSource(chosen?.source),
        inputKind
      });
    }
  }

  private async extractSchemasFromValidationAnchors(page: AdapterRunContext["page"]): Promise<GreenhouseFieldSchema[]> {
    return page.evaluate(() => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const unique = (values: string[]): string[] => Array.from(new Set(values.map((v) => normalize(v)).filter(Boolean)));
      const anchors = Array.from(document.querySelectorAll<HTMLElement>(
        "[aria-invalid='true'], [aria-errormessage], [id$='-error'], [id*='error'], .field-error, .invalid-feedback, .error"
      ));
      const out: GreenhouseFieldSchema[] = [];
      const seen = new Set<string>();
      for (const anchor of anchors) {
        const container = anchor.closest(".field-wrapper, .select__container, fieldset, .eeoc__question__wrapper, .phone-input, .input-wrapper, li, section, div");
        if (!container) continue;
        const control = container.querySelector<HTMLElement>("input, textarea, select, [role='combobox']");
        if (!control) continue;
        const controlId = (control as HTMLInputElement).id || "";
        const controlName = (control as HTMLInputElement).name || "";
        const label = normalize(
          (container.querySelector("label, legend, [aria-label]")?.textContent || control.getAttribute("aria-label") || "")
        );
        const fieldId = controlId || controlName || normalize(label).toLowerCase().replace(/[^a-z0-9]+/g, "_");
        if (!fieldId || seen.has(fieldId)) continue;
        seen.add(fieldId);
        const optionPool = unique(Array.from(container.querySelectorAll<HTMLElement>("[role='option'], option, .select__option")).map((item) => item.textContent || ""));
        out.push({
          fieldId,
          label: label || fieldId,
          required: true,
          fieldType: control.getAttribute("role") === "combobox" ? "react_select" : "text",
          possibleAnswers: optionPool,
          currentValue: normalize((control as HTMLInputElement).value || ""),
          htmlSummary: normalize((container.textContent || "").slice(0, 500)),
          containerMeta: {
            containerSelector: container.className ? `.${String(container.className).split(/\s+/)[0]}` : undefined,
            containerIdentity: container.id || undefined,
            controlId: controlId || undefined,
            controlName: controlName || undefined,
            ariaLabelledBy: control.getAttribute("aria-labelledby") || undefined
          }
        });
      }
      return out;
    });
  }

  private hasResumeValidationError(errors: string[]): boolean {
    return errors.some((error) => /resume|cv|required/i.test(error));
  }

  private async collectIdentityIssues(page: AdapterRunContext["page"]): Promise<Set<string>> {
    const [missingDetails, validationErrors] = await Promise.all([
      this.collectMissingRequiredDetails(page).catch(() => [] as MissingFieldDetail[]),
      this.collectSubmitValidationErrors(page).catch(() => [] as string[])
    ]);
    const issues = new Set<string>();
    for (const field of missingDetails) {
      const key = normalizeText(field.id);
      if (["first_name", "last_name", "email", "phone"].includes(key)) {
        issues.add(key);
      }
      const label = normalizeText(field.label);
      if (label.includes("first name")) issues.add("first_name");
      if (label.includes("last name")) issues.add("last_name");
      if (label === "email" || label.includes("email")) issues.add("email");
      if (label.includes("phone")) issues.add("phone");
    }
    for (const error of validationErrors) {
      const normalized = normalizeText(error);
      if (normalized.includes("first name")) issues.add("first_name");
      if (normalized.includes("last name")) issues.add("last_name");
      if (normalized.includes("email")) issues.add("email");
      if (normalized.includes("phone")) issues.add("phone");
    }
    return issues;
  }

  private identityFieldConfig(id: "first_name" | "last_name" | "email" | "phone"): {
    aliases: string[];
    labelTokens: string[];
  } {
    if (id === "first_name") {
      return {
        aliases: ["first_name", "firstname", "first-name", "firstName", "given_name", "givenname"],
        labelTokens: ["first name", "given name", "legal first name"]
      };
    }
    if (id === "last_name") {
      return {
        aliases: ["last_name", "lastname", "last-name", "lastName", "family_name", "surname"],
        labelTokens: ["last name", "family name", "surname"]
      };
    }
    if (id === "email") {
      return {
        aliases: ["email", "email_address", "emailaddress", "work_email"],
        labelTokens: ["email", "email address"]
      };
    }
    return {
      aliases: ["phone", "phone_number", "phonenumber", "mobile", "telephone"],
      labelTokens: ["phone", "mobile", "telephone"]
    };
  }

  private async collectIdentityCandidateSnapshot(
    page: AdapterRunContext["page"],
    id: "first_name" | "last_name" | "email" | "phone"
  ): Promise<Array<{ id: string; name: string; type: string; visible: boolean; required: boolean; invalid: boolean; value: string }>> {
    const evaluate = (page as unknown as { evaluate?: (...args: unknown[]) => Promise<unknown> }).evaluate;
    if (typeof evaluate !== "function") {
      return [];
    }
    const { aliases, labelTokens } = this.identityFieldConfig(id);
    const raw = await page.evaluate(({ aliases: rawAliases, labelTokens: rawLabelTokens, fieldId }) => {
      const aliases = rawAliases.map((value) => value.toLowerCase());
      const labelTokens = rawLabelTokens.map((value) => value.toLowerCase());
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const shouldExcludePhoneTarget = (element: HTMLInputElement | HTMLTextAreaElement, key: string, labelText: string): boolean => {
        if (fieldId !== "phone") return false;
        const input = element as HTMLInputElement;
        const role = (element.getAttribute("role") || "").toLowerCase();
        const type = (input.type || "").toLowerCase();
        const ariaLabel = (element.getAttribute("aria-label") || "").toLowerCase();
        if (type === "search") return true;
        if (role === "combobox") return true;
        if (/\bcountry\b|\bcountry code\b|\bdial code\b/.test(key)) return true;
        if (/\bcountry\b|\bcountry code\b|\bdial code\b/.test(labelText)) return true;
        if (/\bcountry\b|\bcountry code\b|\bdial code\b/.test(ariaLabel)) return true;
        if ((element.id || "").startsWith("iti-")) return true;
        return false;
      };
      const isVisible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const candidates = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"))
        .filter((element) => {
          const input = element as HTMLInputElement;
          if (input.type === "file") return false;
          const key = `${element.id || ""} ${element.getAttribute("name") || ""}`.toLowerCase();
          const explicit = element.id
            ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)
            : null;
          const wrapping = element.closest("label");
          const legend = element.closest("fieldset")?.querySelector("legend");
          const labelText = normalize(
            `${explicit?.textContent || ""} ${wrapping?.textContent || ""} ${legend?.textContent || ""} ${element.getAttribute("aria-label") || ""}`
          ).toLowerCase();
          if (shouldExcludePhoneTarget(element, key, labelText)) return false;
          if (aliases.some((alias) => key.includes(alias))) return true;
          return labelTokens.some((token) => labelText.includes(token));
        })
        .map((element) => {
          const input = element as HTMLInputElement;
          return {
            id: element.id || "",
            name: element.getAttribute("name") || "",
            type: input.type || element.tagName.toLowerCase(),
            visible: isVisible(element),
            required: Boolean(element.hasAttribute("required") || element.getAttribute("aria-required") === "true"),
            invalid: element.getAttribute("aria-invalid") === "true",
            value: normalize((input.value || "").slice(0, 160))
          };
        });

      const deduped = new Map<string, (typeof candidates)[number]>();
      for (const candidate of candidates) {
        const key = `${candidate.id}|${candidate.name}|${candidate.type}`;
        if (!deduped.has(key)) {
          deduped.set(key, candidate);
        }
      }
      return Array.from(deduped.values());
    }, { aliases, labelTokens, fieldId: id }).catch(() => [] as Array<{ id: string; name: string; type: string; visible: boolean; required: boolean; invalid: boolean; value: string }>);
    return raw;
  }

  private async syncIdentityMirrors(
    page: AdapterRunContext["page"],
    id: "first_name" | "last_name" | "email" | "phone",
    value: string
  ): Promise<boolean> {
    const evaluate = (page as unknown as { evaluate?: (...args: unknown[]) => Promise<unknown> }).evaluate;
    if (typeof evaluate !== "function") {
      return false;
    }
    const { aliases, labelTokens } = this.identityFieldConfig(id);
    return page.evaluate(({ aliases: rawAliases, labelTokens: rawLabelTokens, nextValue, fieldId }) => {
      const aliases = rawAliases.map((item) => item.toLowerCase());
      const labelTokens = rawLabelTokens.map((item) => item.toLowerCase());
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const shouldExcludePhoneTarget = (element: HTMLInputElement | HTMLTextAreaElement, key: string, labelText: string): boolean => {
        if (fieldId !== "phone") return false;
        const input = element as HTMLInputElement;
        const role = (element.getAttribute("role") || "").toLowerCase();
        const type = (input.type || "").toLowerCase();
        const ariaLabel = (element.getAttribute("aria-label") || "").toLowerCase();
        if (type === "search") return true;
        if (role === "combobox") return true;
        if (/\bcountry\b|\bcountry code\b|\bdial code\b/.test(key)) return true;
        if (/\bcountry\b|\bcountry code\b|\bdial code\b/.test(labelText)) return true;
        if (/\bcountry\b|\bcountry code\b|\bdial code\b/.test(ariaLabel)) return true;
        if ((element.id || "").startsWith("iti-")) return true;
        return false;
      };
      const setNativeValue = (element: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(element, value);
        else element.value = value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        element.dispatchEvent(new Event("blur", { bubbles: true }));
      };

      const targets = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")).filter((element) => {
        const input = element as HTMLInputElement;
        if (input.type === "file") return false;
        const key = `${element.id || ""} ${element.getAttribute("name") || ""}`.toLowerCase();
        const explicit = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`) : null;
        const wrapping = element.closest("label");
        const legend = element.closest("fieldset")?.querySelector("legend");
        const labelText = normalize(
          `${explicit?.textContent || ""} ${wrapping?.textContent || ""} ${legend?.textContent || ""} ${element.getAttribute("aria-label") || ""}`
        ).toLowerCase();
        if (shouldExcludePhoneTarget(element, key, labelText)) return false;
        if (aliases.some((alias) => key.includes(alias))) return true;
        return labelTokens.some((token) => labelText.includes(token));
      });

      if (!targets.length) return false;
      for (const target of targets) {
        setNativeValue(target, nextValue);
      }
      return true;
    }, { aliases, labelTokens, nextValue: value, fieldId: id }).then(Boolean).catch(() => false);
  }

  private async ensureIdentityFieldSynchronized(
    page: AdapterRunContext["page"],
    id: "first_name" | "last_name" | "email" | "phone",
    value: string | undefined
  ): Promise<boolean> {
    const target = (value || "").trim();
    if (!target) return true;
    const normalizedTarget = normalizeText(target);
    const currentSnapshot = await this.collectIdentityCandidateSnapshot(page, id).catch(() => []);
    if (currentSnapshot.length) {
      let allSynced = true;
      for (const candidate of currentSnapshot) {
        if (!candidate.visible && !candidate.required) continue;
        const normalizedValue = normalizeText(candidate.value);
        if (normalizedValue !== normalizedTarget || candidate.invalid) {
          allSynced = false;
          break;
        }
      }
      if (allSynced) return true;
    } else {
      const currentValue = await this.readInputValue(page, id).catch(() => "");
      if (normalizeText(currentValue) === normalizedTarget) return true;
    }

    await this.setIdentityValueById(page, id, target).catch(() => false);
    await this.syncIdentityMirrors(page, id, target).catch(() => false);
    const snapshot = await this.collectIdentityCandidateSnapshot(page, id).catch(() => []);
    if (!snapshot.length) {
      const currentValue = await this.readInputValue(page, id).catch(() => "");
      return normalizeText(currentValue) === normalizedTarget;
    }
    for (const candidate of snapshot) {
      if (!candidate.visible && !candidate.required) continue;
      const normalizedValue = normalizeText(candidate.value);
      if (normalizedValue !== normalizedTarget || candidate.invalid) return false;
    }
    return true;
  }

  private async collectIdentityCandidateAuditNotes(page: AdapterRunContext["page"]): Promise<string[]> {
    const fields: Array<"first_name" | "last_name" | "email" | "phone"> = ["first_name", "last_name", "email", "phone"];
    const notes: string[] = [];
    for (const field of fields) {
      const snapshot = await this.collectIdentityCandidateSnapshot(page, field).catch(() => []);
      if (!snapshot.length) {
        notes.push(`${field}=[none]`);
        continue;
      }
      const compact = snapshot
        .slice(0, 6)
        .map((candidate) => {
          const idPart = candidate.id ? `id:${candidate.id}` : "id:-";
          const namePart = candidate.name ? `name:${candidate.name}` : "name:-";
          return `${idPart},${namePart},type:${candidate.type},vis:${candidate.visible ? "y" : "n"},req:${candidate.required ? "y" : "n"},inv:${candidate.invalid ? "y" : "n"},val:${candidate.value ? "set" : "empty"}`;
        })
        .join(" || ");
      notes.push(`${field}=[${compact}]`);
    }
    return notes;
  }

  private async collectIdentityAuditNotes(page: AdapterRunContext["page"]): Promise<string[]> {
    const evaluate = (page as unknown as { evaluate?: (...args: unknown[]) => Promise<unknown> }).evaluate;
    if (typeof evaluate !== "function") {
      return [];
    }
    return page.evaluate(() => {
      const fields = [
        { key: "first_name", label: "first_name" },
        { key: "last_name", label: "last_name" },
        { key: "email", label: "email" },
        { key: "phone", label: "phone" }
      ] as const;
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const notes: string[] = [];

      for (const field of fields) {
        const candidates = Array.from(
          document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(`[id="${field.key}"], [name="${field.key}"]`)
        );
        const visible = candidates.find((item) => {
          const style = window.getComputedStyle(item);
          const rect = item.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        }) ?? candidates[0];

        if (!visible) {
          notes.push(`${field.label}=missing`);
          continue;
        }

        const value = normalize((visible.value || "").slice(0, 120));
        const invalid = visible.getAttribute("aria-invalid") === "true";
        const parentText = normalize((visible.closest("div, li, section, fieldset")?.textContent || "").slice(0, 240));
        const hasErrorText = /valid|required|invalid|enter/i.test(parentText);
        const validity = (visible as HTMLInputElement).validity;
        const validationMessage = normalize((visible as HTMLInputElement).validationMessage || "");
        const validityState = validity
          ? [
              validity.valueMissing ? "valueMissing" : "",
              validity.typeMismatch ? "typeMismatch" : "",
              validity.patternMismatch ? "patternMismatch" : "",
              validity.tooShort ? "tooShort" : "",
              validity.tooLong ? "tooLong" : "",
              validity.rangeUnderflow ? "rangeUnderflow" : "",
              validity.rangeOverflow ? "rangeOverflow" : "",
              validity.stepMismatch ? "stepMismatch" : "",
              validity.badInput ? "badInput" : "",
              validity.customError ? "customError" : ""
            ]
              .filter(Boolean)
              .join(",")
          : "";
        notes.push(
          `${field.label}=value:${value ? "set" : "empty"};invalid:${invalid ? "yes" : "no"};error_text:${hasErrorText ? "yes" : "no"};validity:${validityState || "ok"};message:${validationMessage || "none"}`
        );
      }
      return notes;
    }).catch(() => []);
  }

  private async uploadResumeWithRecoveryFlow(
    page: AdapterRunContext["page"],
    resumePath: string
  ): Promise<ResumeVerificationResult> {
    const effectiveResumePath = await this.resolveResumeUploadPath(page, resumePath);
    const targets = await this.waitForResumeTargets(page);
    // Prefer direct file-input assignment first; some Greenhouse variants throw
    // client-side errors on attach-button click handlers.
    const directAttempt = await this.runResumeUploadAttemptWithDiagnostics(page, "direct", async () =>
      this.performResumeUpload(page, effectiveResumePath, targets, "direct")
    );
    let verification = await this.verifyStrictResumeUploadDetailed(page, effectiveResumePath, [directAttempt]);
    if (verification.ok && verification.visibleCueOk) {
      return verification;
    }

    const refreshedTargets = await this.waitForResumeTargets(page, 3000);
    const attachAttempt = await this.runResumeUploadAttemptWithDiagnostics(page, "attach", async () =>
      this.performResumeUpload(page, effectiveResumePath, refreshedTargets, "attach")
    );
    verification = await this.verifyStrictResumeUploadDetailed(page, effectiveResumePath, [directAttempt, attachAttempt]);
    return verification;
  }

  private async runResumeUploadAttemptWithDiagnostics(
    page: AdapterRunContext["page"],
    phase: "direct" | "attach",
    action: () => Promise<boolean>
  ): Promise<ResumeUploadAttemptDiagnostics> {
    let sawPresign = false;
    let sawBinaryUpload = false;
    let sawNetworkFailure = false;
    const jsErrors: string[] = [];
    const pushError = (raw: string): void => {
      const message = raw.replace(/\s+/g, " ").trim();
      if (!message) return;
      if (!jsErrors.some((existing) => existing === message)) {
        jsErrors.push(message);
      }
    };
    const isPresignRequest = (url: string): boolean => /presigned_fields/i.test(url);
    const isLikelyBinaryUpload = (method: string, url: string): boolean => {
      const isWrite = ["PUT", "POST", "PATCH"].includes(method.toUpperCase());
      if (!isWrite) return false;
      if (isPresignRequest(url)) return false;
      return /(amazonaws|cloudfront|upload|attachment|resume|cv|greenhouse\.io\/.*(upload|attachment))/i.test(url);
    };

    const onFinished = (request: { method: () => string; url: () => string }): void => {
      const url = request.url();
      const method = request.method();
      if (isPresignRequest(url)) sawPresign = true;
      if (isLikelyBinaryUpload(method, url)) sawBinaryUpload = true;
    };
    const onFailed = (request: { method: () => string; url: () => string }): void => {
      const url = request.url();
      const method = request.method();
      if (isPresignRequest(url)) sawPresign = true;
      if (isLikelyBinaryUpload(method, url)) {
        sawBinaryUpload = true;
        sawNetworkFailure = true;
      }
    };
    const onConsole = (msg: { type: () => string; text: () => string }): void => {
      const type = msg.type();
      if (type !== "error" && type !== "warning") return;
      const text = msg.text();
      if (/upload|resume|cv|cannot read|exception|failed/i.test(text)) {
        pushError(text);
      }
    };
    const onPageError = (error: Error): void => {
      const message = error?.message ?? String(error);
      if (/upload|resume|cv|cannot read|exception|failed/i.test(message)) {
        pushError(message);
      }
    };

    page.on("requestfinished", onFinished);
    page.on("requestfailed", onFailed);
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    let applied = false;
    try {
      applied = await action();
      await page.waitForTimeout(1600).catch(() => undefined);
    } finally {
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFailed);
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
    }

    return {
      phase,
      applied,
      sawPresign,
      sawBinaryUpload,
      sawNetworkFailure,
      jsErrors: jsErrors.slice(0, 8)
    };
  }

  private async resolveResumeUploadPath(
    page: AdapterRunContext["page"],
    resumePath: string
  ): Promise<string> {
    const ext = path.extname(resumePath).toLowerCase();
    if ([".pdf", ".doc", ".docx", ".rtf"].includes(ext)) {
      return resumePath;
    }

    const acceptHints = await page.evaluate(() => {
      return Array.from(document.querySelectorAll<HTMLInputElement>("input[type='file']"))
        .map((input) => (input.accept || "").toLowerCase())
        .filter(Boolean)
        .slice(0, 10);
    }).catch(() => [] as string[]);
    const acceptOnlyDocumentFormats =
      acceptHints.length > 0 &&
      acceptHints.every((accept) => /pdf|doc|docx|msword|officedocument/.test(accept) && !/\btxt\b|text\/plain/.test(accept));

    if (!acceptOnlyDocumentFormats) {
      return resumePath;
    }

    const parsed = path.parse(resumePath);
    const alternatives = [".pdf", ".docx", ".doc", ".rtf"].map((candidateExt) =>
      path.join(parsed.dir, `${parsed.name}${candidateExt}`)
    );
    for (const alternative of alternatives) {
      if (existsSync(alternative)) {
        return alternative;
      }
    }

    return resumePath;
  }

  private async waitForResumeTargets(page: AdapterRunContext["page"], timeoutMs = 8000): Promise<ResumeUploadTargets> {
    const startedAt = Date.now();
    let latest: ResumeUploadTargets = { inputSelectors: [RESUME_INPUT_SELECTOR], attachTargets: [] };

    while (Date.now() - startedAt < timeoutMs) {
      latest = await this.discoverResumeTargets(page);
      if (latest.inputSelectors.length > 1 || latest.attachTargets.length > 0) {
        return latest;
      }
      await sleep(250);
    }

    return latest;
  }

  private emptyResumeVerificationResult(): ResumeVerificationResult {
    return {
      ok: false,
      confidence: "failed",
      verificationMode: "error",
      inputFileOk: false,
      visibleCueOk: false,
      missingScanOk: false,
      uploadSignalOk: false,
      uploadState: "upload_failed",
      failureTag: "resume_upload_signal_missing"
    };
  }

  private async discoverResumeTargets(page: AdapterRunContext["page"]): Promise<ResumeUploadTargets> {
    const discovered = await page.evaluate(() => {
      const isVisible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const buildSelector = (element: Element): string => {
        const html = element as HTMLElement;
        if (html.id) return `#${CSS.escape(html.id)}`;

        if (html instanceof HTMLInputElement && html.type === "file" && html.name) {
          return `input[type="file"][name="${html.name.replace(/"/g, '\\"')}"]`;
        }
        if (html instanceof HTMLLabelElement && html.htmlFor) {
          return `label[for="${html.htmlFor.replace(/"/g, '\\"')}"]`;
        }

        const segments: string[] = [];
        let current: Element | null = element;
        while (current && current !== document.body) {
          const tag = current.tagName.toLowerCase();
          let sibling: Element | null = current.previousElementSibling;
          let index = 1;
          while (sibling) {
            if (sibling.tagName.toLowerCase() === tag) index += 1;
            sibling = sibling.previousElementSibling;
          }
          segments.unshift(`${tag}:nth-of-type(${index})`);
          current = current.parentElement;
        }

        return segments.length ? `body > ${segments.join(" > ")}` : "";
      };

      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
      const resumePattern = /\b(resume|cv|curriculum vitae)\b/i;
      const attachPattern = /\b(attach|upload|resume|cv|browse|choose file|add file)\b/i;

      const inputCandidates = Array.from(document.querySelectorAll<HTMLInputElement>("input[type='file']"))
        .map((input) => {
          const containerText = normalize((input.closest("div, section, li, fieldset, form")?.textContent || "").slice(0, 500));
          const name = normalize(input.name || "");
          const id = normalize(input.id || "");
          const accept = normalize(input.accept || "");
          let score = 0;
          if (resumePattern.test(name)) score += 6;
          if (resumePattern.test(id)) score += 6;
          if (resumePattern.test(containerText)) score += 4;
          if (/\b(pdf|doc|docx)\b/.test(accept)) score += 2;
          if (isVisible(input)) score += 1;
          return {
            selector: buildSelector(input),
            score
          };
        })
        .filter((entry) => Boolean(entry.selector))
        .sort((a, b) => b.score - a.score);

      const attachCandidates = Array.from(
        document.querySelectorAll<HTMLElement>("button, a, label, [role='button'], div[role='button'], span[role='button']")
      )
        .map((element) => {
          const text = normalize((element.textContent || "").slice(0, 180));
          const labelFor = element instanceof HTMLLabelElement ? (element.htmlFor || "").trim() : "";
          const linkedInput = labelFor ? document.getElementById(labelFor) : null;
          const isFileLabel = linkedInput instanceof HTMLInputElement && linkedInput.type === "file";
          const containerText = normalize((element.closest("div, section, li, fieldset, form")?.textContent || "").slice(0, 500));
          const matches = attachPattern.test(text) || resumePattern.test(containerText) || isFileLabel;
          if (!matches || !isVisible(element)) {
            return null;
          }
          return {
            selector: buildSelector(element),
            ...(isFileLabel ? { linkedInputSelector: buildSelector(linkedInput) } : {})
          };
        })
        .filter((entry): entry is { selector: string; linkedInputSelector?: string } => entry !== null && Boolean(entry.selector));

      const dedupe = <T extends { selector: string }>(items: T[]): T[] => {
        const seen = new Set<string>();
        const output: T[] = [];
        for (const item of items) {
          if (seen.has(item.selector)) continue;
          seen.add(item.selector);
          output.push(item);
        }
        return output;
      };

      return {
        inputSelectors: dedupe(inputCandidates).map((entry) => entry.selector),
        attachTargets: dedupe(attachCandidates)
      };
    }).catch(() => ({ inputSelectors: [], attachTargets: [] as ResumeAttachTarget[] }));

    const inputSelectors = Array.from(new Set([...(discovered.inputSelectors ?? []), RESUME_INPUT_SELECTOR]));
    return {
      inputSelectors,
      attachTargets: discovered.attachTargets ?? []
    };
  }

  private async performResumeUpload(
    page: AdapterRunContext["page"],
    resumePath: string,
    targets: ResumeUploadTargets,
    phase: "direct" | "attach"
  ): Promise<boolean> {
    const expectedName = path.basename(resumePath).toLowerCase();
    const primaryTarget = await this.discoverPrimaryResumeUploadTarget(page);

    if (phase === "direct") {
      if (primaryTarget.inputSelector) {
        const scopedUploaded = await this.setFileInputBySelector(page, primaryTarget.inputSelector, resumePath).catch(() => false);
        if (scopedUploaded) {
          await this.waitForResumeCueStabilization(page, expectedName);
          return true;
        }
      }
      for (const selector of targets.inputSelectors) {
        const uploaded = await this.setFileInputBySelector(page, selector, resumePath).catch(() => false);
        if (uploaded) {
          await this.waitForResumeCueStabilization(page, expectedName);
          return true;
        }
      }
      return false;
    }

    if (primaryTarget.attachSelector) {
      const scopedTrigger = page.locator(primaryTarget.attachSelector).first();
      if (await scopedTrigger.count().catch(() => 0)) {
        const chooserPromise = page.waitForEvent("filechooser", { timeout: 1800 }).catch(() => undefined);
        await scopedTrigger.click({ timeout: 1500 }).catch(() => undefined);
        const chooser = await chooserPromise;
        if (chooser) {
          const chooserSet = await chooser.setFiles(resumePath).then(() => true).catch(() => false);
          if (chooserSet) {
            await this.waitForResumeCueStabilization(page, expectedName);
            return true;
          }
        }
      }
    }

    if (primaryTarget.inputSelector) {
      const scopedUpload = await this.setFileInputBySelector(page, primaryTarget.inputSelector, resumePath).catch(() => false);
      if (scopedUpload) {
        await this.waitForResumeCueStabilization(page, expectedName);
        return true;
      }
    }

    const stableAttachTriggers: Array<{ locator: ReturnType<AdapterRunContext["page"]["locator"]>; linkedInputSelector?: string }> = [
      { locator: page.locator("label[for='resume']").first(), linkedInputSelector: "#resume" },
      { locator: page.getByRole("button", { name: /^attach$/i }).first(), linkedInputSelector: "#resume" },
      { locator: page.locator("label:has-text('Attach'), label:has-text('Upload')").first(), linkedInputSelector: "#resume" },
      { locator: page.getByRole("button", { name: /attach|upload|resume|cv|browse|choose file|add file/i }).first() }
    ];

    for (const triggerDef of stableAttachTriggers) {
      const trigger = triggerDef.locator;
      if (!(await trigger.count().catch(() => 0))) continue;

      const chooserPromise = page.waitForEvent("filechooser", { timeout: 1800 }).catch(() => undefined);
      await trigger.click({ timeout: 1500 }).catch(() => undefined);
      const chooser = await chooserPromise;
      if (chooser) {
        const chooserSet = await chooser.setFiles(resumePath).then(() => true).catch(() => false);
        if (chooserSet) {
          await this.waitForResumeCueStabilization(page, expectedName);
          return true;
        }
      }

      if (triggerDef.linkedInputSelector) {
        const linkedUpload = await this.setFileInputBySelector(page, triggerDef.linkedInputSelector, resumePath).catch(() => false);
        if (linkedUpload) {
          await this.waitForResumeCueStabilization(page, expectedName);
          return true;
        }
      }
    }

    for (const target of targets.attachTargets) {
      const trigger = page.locator(target.selector).first();
      if (!(await trigger.count().catch(() => 0))) continue;

      const chooserPromise = page.waitForEvent("filechooser", { timeout: 1800 }).catch(() => undefined);
      await trigger.click({ timeout: 1500 }).catch(() => undefined);
      const chooser = await chooserPromise;
      if (chooser) {
        const chooserSet = await chooser.setFiles(resumePath).then(() => true).catch(() => false);
        if (chooserSet) {
          await this.waitForResumeCueStabilization(page, expectedName);
          return true;
        }
      }

      if (target.linkedInputSelector) {
        const linkedUpload = await this.setFileInputBySelector(page, target.linkedInputSelector, resumePath).catch(() => false);
        if (linkedUpload) {
          await this.waitForResumeCueStabilization(page, expectedName);
          return true;
        }
      }

      const shellUpload = await this.tryUploadFromAttachSelector(page, target.selector, resumePath);
      if (shellUpload) {
        await this.waitForResumeCueStabilization(page, expectedName);
        return true;
      }
    }

    return false;
  }

  private async discoverPrimaryResumeUploadTarget(
    page: AdapterRunContext["page"]
  ): Promise<{ inputSelector?: string; attachSelector?: string }> {
    return page.evaluate(() => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
      const isVisible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const buildSelector = (element: Element): string => {
        const html = element as HTMLElement;
        if (html.id) return `#${CSS.escape(html.id)}`;
        const tag = html.tagName.toLowerCase();
        const name = html.getAttribute("name");
        if (name) return `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
        const dataTestId = html.getAttribute("data-testid");
        if (dataTestId) return `${tag}[data-testid="${dataTestId.replace(/"/g, '\\"')}"]`;
        const role = html.getAttribute("role");
        if (role) return `${tag}[role="${role.replace(/"/g, '\\"')}"]`;
        return tag;
      };

      const groups = Array.from(document.querySelectorAll<HTMLElement>(".file-upload, [role='group'].file-upload"));
      const ranked = groups
        .map((group) => {
          const labelNode =
            group.querySelector<HTMLElement>(".upload-label, .label") ||
            (group.getAttribute("aria-labelledby")
              ? document.getElementById(group.getAttribute("aria-labelledby") || "")
              : null);
          const labelText = normalize(labelNode?.textContent || "");
          const groupText = normalize((group.textContent || "").slice(0, 500));
          let score = 0;
          if (/resume|curriculum vitae|\bcv\b/.test(labelText)) score += 8;
          if (/resume|curriculum vitae|\bcv\b/.test(groupText)) score += 4;
          if (group.getAttribute("aria-required") === "true") score += 2;
          if (group.dataset.allowS3 === "false") score += 1;
          return { group, score };
        })
        .sort((a, b) => b.score - a.score);
      const best = ranked[0]?.group;
      if (!best) return {};

      const input =
        best.querySelector<HTMLInputElement>(
          "input[type='file']#resume, input[type='file'][id*='resume' i], input[type='file'][name*='resume' i], input[type='file'][id*='cv' i], input[type='file'][name*='cv' i]"
        ) ||
        best.querySelector<HTMLInputElement>("input[type='file']");
      const attach = Array.from(best.querySelectorAll<HTMLElement>("button, [role='button'], label")).find((element) => {
        if (!isVisible(element)) return false;
        const text = normalize((element.textContent || "").slice(0, 120));
        const labelFor = element instanceof HTMLLabelElement ? (element.htmlFor || "").trim() : "";
        return /^attach$/.test(text) || /attach|upload|browse|choose file/.test(text) || (labelFor && labelFor === input?.id);
      });

      return {
        inputSelector: input ? buildSelector(input) : undefined,
        attachSelector: attach ? buildSelector(attach) : undefined
      };
    }).catch(() => ({}));
  }

  private async tryUploadFromAttachSelector(
    page: AdapterRunContext["page"],
    triggerSelector: string,
    resumePath: string
  ): Promise<boolean> {
    const trigger = page.locator(triggerSelector).first();
    const handle = await trigger.elementHandle().catch(() => null);
    if (!handle) return false;
    const selector = await page
      .evaluate((element) => {
        const root = element as HTMLElement;
        const container =
          root.closest("[data-qa], [class*='resume' i], [class*='attach' i], [class*='upload' i], li, section, div") ||
          root.parentElement;
        const nearbyInput = container?.querySelector<HTMLInputElement>("input[type='file']");
        if (nearbyInput?.id) {
          return `#${CSS.escape(nearbyInput.id)}`;
        }
        if (nearbyInput?.name) {
          return `input[type='file'][name="${nearbyInput.name.replace(/"/g, '\\"')}"]`;
        }
        return "";
      }, handle)
      .catch(() => "");
    await handle.dispose().catch(() => undefined);

    if (!selector) return false;
    return this.setFileInputBySelector(page, selector, resumePath).catch(() => false);
  }

  private async verifyStrictResumeUpload(
    page: AdapterRunContext["page"],
    resumePath: string
  ): Promise<boolean> {
    const result = await this.verifyStrictResumeUploadDetailed(page, resumePath);
    return result.ok;
  }

  private async verifyStrictResumeUploadDetailed(
    page: AdapterRunContext["page"],
    resumePath: string,
    attempts: ResumeUploadAttemptDiagnostics[] = []
  ): Promise<ResumeVerificationResult> {
    let inputState = await this.findResumeInputWithSelectedFile(page, resumePath);
    let cueState = await this.findVisibleResumeCue(page, resumePath, 2500);
    let tokenState = await this.findResumeAttachmentToken(page);
    let fieldState = await this.inspectResumeFieldState(page, resumePath);
    let missingDetails = await this.collectMissingRequiredDetails(page);
    let resumeMissingDetail = this.findResumeMissingDetail(missingDetails);
    const sawBinaryUpload = attempts.some((attempt) => attempt.sawBinaryUpload && !attempt.sawNetworkFailure);
    const networkSignalOk = tokenState.ok || sawBinaryUpload;
    const hasJsError = attempts.some((attempt) => attempt.jsErrors.length > 0);
    const hasNetworkFailure = attempts.some((attempt) => attempt.sawNetworkFailure);
    const diagnostics = attempts
      .flatMap((attempt) => [
        `phase=${attempt.phase}:applied=${attempt.applied ? "yes" : "no"}:presign=${attempt.sawPresign ? "yes" : "no"}:binary_upload=${attempt.sawBinaryUpload ? "yes" : "no"}:network_fail=${attempt.sawNetworkFailure ? "yes" : "no"}`,
        ...attempt.jsErrors.map((error) => `phase=${attempt.phase}:js_error=${error}`)
      ]);

    // Greenhouse can transiently leave stale "resume required" markers right after upload.
    // Re-check once before declaring failure when the UI already shows a resume cue.
    if (resumeMissingDetail && (cueState.ok || inputState.ok)) {
      await sleep(400);
      missingDetails = await this.collectMissingRequiredDetails(page);
      const recheckedMissing = this.findResumeMissingDetail(missingDetails);
      if (!recheckedMissing) {
        resumeMissingDetail = undefined;
        diagnostics.push("resume_missing_recheck:cleared");
      } else {
        diagnostics.push("resume_missing_recheck:still_missing");
      }
    }

    let uiCueVerified = cueState.ok && !resumeMissingDetail;
    let uploadSignalOk = networkSignalOk || uiCueVerified || inputState.ok || tokenState.ok || fieldState.hasReplaceOrRemoveAction;

    // When setInputFiles worked but the UI lags, poll up to 5s before failing.
    if (!uploadSignalOk && attempts.some((attempt) => attempt.applied)) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !uploadSignalOk) {
        await sleep(300);
        inputState = await this.findResumeInputWithSelectedFile(page, resumePath);
        cueState = await this.findVisibleResumeCue(page, resumePath, 800);
        tokenState = await this.findResumeAttachmentToken(page);
        fieldState = await this.inspectResumeFieldState(page, resumePath);
        missingDetails = await this.collectMissingRequiredDetails(page);
        resumeMissingDetail = this.findResumeMissingDetail(missingDetails);
        uiCueVerified = cueState.ok && !resumeMissingDetail;
        uploadSignalOk = networkSignalOk || uiCueVerified || inputState.ok || tokenState.ok || fieldState.hasReplaceOrRemoveAction;
      }
    }

    const hasResumeValidationError = await this.collectSubmitValidationErrors(page)
      .then((errors) => errors.some((error) => {
        const normalized = normalizeText(error || "");
        if (!normalized) return false;
        if (!/\bresume\b|\bcv\b/.test(normalized)) return false;
        if (/cannot read properties of undefined/.test(normalized) && /uploadfile/.test(normalized)) {
          return false;
        }
        return /\brequired\b|\bmissing\b|\bupload\b|\battach\b|\bmust\b/.test(normalized);
      }))
      .catch(() => false);
    const explicitInvalid = fieldState.explicitInvalid || fieldState.requiredSentinelUnsatisfied;
    const confidence: NonNullable<ResumeVerificationResult["confidence"]> =
      hasResumeValidationError
        ? "failed"
        : (Boolean(resumeMissingDetail) || explicitInvalid) && !uploadSignalOk
        ? "failed"
        : uploadSignalOk
          ? "confirmed"
          : inputState.ok
            ? "provisional"
            : "failed";
    const verificationMode: NonNullable<ResumeVerificationResult["verificationMode"]> =
      confidence === "confirmed"
        ? "signal"
        : confidence === "provisional"
          ? "input_only"
          : "error";

    let failureTag: ResumeVerificationResult["failureTag"];
    if (confidence === "failed" && !networkSignalOk && !uiCueVerified && hasJsError) {
      failureTag = "resume_upload_js_error";
    } else if (confidence === "failed" && !networkSignalOk && !uiCueVerified && hasNetworkFailure) {
      failureTag = "resume_upload_network_failed";
    } else if (confidence === "failed" && hasResumeValidationError) {
      failureTag = "resume_upload_signal_missing";
    }
    const uploadState: ResumeVerificationResult["uploadState"] =
      confidence === "confirmed"
        ? "upload_confirmed"
        : inputState.ok
          ? "input_set"
          : "upload_failed";

    const result: ResumeVerificationResult = {
      ok: confidence !== "failed",
      confidence,
      verificationMode,
      inputFileOk: inputState.ok,
      visibleCueOk: cueState.ok,
      uploadSignalOk,
      missingScanOk: !resumeMissingDetail,
      uploadState,
      failureTag,
      diagnostics: (
        diagnostics.length
          ? [
              ...diagnostics,
              `resume_field_state:allow_s3_false=${fieldState.allowS3False ? "yes" : "no"}:sentinel_unsatisfied=${fieldState.requiredSentinelUnsatisfied ? "yes" : "no"}:explicit_invalid=${fieldState.explicitInvalid ? "yes" : "no"}:replace_action=${fieldState.hasReplaceOrRemoveAction ? "yes" : "no"}`
            ]
          : undefined
      )?.slice(0, 12),
      matchedInputSelector: inputState.selector,
      matchedCueText: cueState.cueText,
      resumeMissingDetail
    };

    return result;
  }

  private async inspectResumeFieldState(
    page: AdapterRunContext["page"],
    resumePath: string
  ): Promise<{ allowS3False: boolean; requiredSentinelUnsatisfied: boolean; explicitInvalid: boolean; hasReplaceOrRemoveAction: boolean }> {
    const expectedName = path.basename(resumePath).toLowerCase();
    const evaluate = (page as unknown as { evaluate?: (...args: unknown[]) => Promise<unknown> }).evaluate;
    if (typeof evaluate !== "function") {
      return {
        allowS3False: false,
        requiredSentinelUnsatisfied: false,
        explicitInvalid: false,
        hasReplaceOrRemoveAction: false
      };
    }
    return page.evaluate(({ expected }) => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
      const isVisible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const hasMatchedFile = (input: HTMLInputElement): boolean => {
        const files = Array.from(input.files ?? []);
        if (!files.length) return false;
        const names = files.map((file) => (file.name || "").toLowerCase());
        return names.some((name) => name === expected || name.endsWith(expected));
      };

      const candidates = Array.from(
        document.querySelectorAll<HTMLInputElement>(
          "#resume, input[type='file'][name*='resume' i], input[type='file'][id*='resume' i], input[type='file'][name*='cv' i], input[type='file'][id*='cv' i]"
        )
      );
      const matched = candidates.find((input) => hasMatchedFile(input));
      const fallback = candidates[0] ?? null;
      const input = matched ?? fallback;
      if (!input) {
        return {
          allowS3False: false,
          requiredSentinelUnsatisfied: false,
          explicitInvalid: false,
          hasReplaceOrRemoveAction: false
        };
      }

      const wrapper =
        input.closest(".file-upload, [role='group'], li, fieldset, section, form, div") ??
        input.parentElement;
      const fileUploadRoot =
        input.closest(".file-upload") ??
        wrapper?.querySelector(".file-upload") ??
        null;

      const sentinels = Array.from(
        (wrapper ?? document).querySelectorAll<HTMLInputElement>(
          "input.remix-css-1a0ro4n-requiredInput[required], input[required][aria-hidden='true']"
        )
      );
      const requiredSentinelUnsatisfied = sentinels.some((sentinel) => !normalize(sentinel.value || ""));
      const explicitInvalid =
        input.getAttribute("aria-invalid") === "true" ||
        sentinels.some((sentinel) => sentinel.getAttribute("aria-invalid") === "true") ||
        Boolean(
          (wrapper ?? document).querySelector(
            "[aria-invalid='true'], .select__control--error, .input-wrapper--error, .label--error, .error, .field-error, .invalid-feedback"
          )
        ) ||
        Array.from((wrapper ?? document).querySelectorAll<HTMLElement>("[role='alert'], [aria-live='polite'], [aria-live='assertive']")).some(
          (element) => {
            if (!isVisible(element)) return false;
            const text = normalize(element.textContent || "");
            return /resume|cv/.test(text) && /required|invalid|must|attach|upload|please/.test(text);
          }
        );
      const allowS3False = (fileUploadRoot as HTMLElement | null)?.dataset?.allowS3 === "false";
      const actionText = normalize((wrapper?.textContent || "").slice(0, 500));
      const hasReplaceOrRemoveAction = /remove|replace|change file|change resume|uploaded/.test(actionText);

      return {
        allowS3False,
        requiredSentinelUnsatisfied,
        explicitInvalid,
        hasReplaceOrRemoveAction
      };
    }, { expected: expectedName }).catch(() => ({
      allowS3False: false,
      requiredSentinelUnsatisfied: false,
      explicitInvalid: false,
      hasReplaceOrRemoveAction: false
    }));
  }

  private async findResumeAttachmentToken(
    page: AdapterRunContext["page"]
  ): Promise<{ ok: boolean; selector?: string }> {
    const evaluate = (page as unknown as { evaluate?: (...args: unknown[]) => Promise<unknown> }).evaluate;
    if (typeof evaluate !== "function") {
      return { ok: false };
    }
    return page.evaluate(() => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const candidates = Array.from(
        document.querySelectorAll<HTMLInputElement>("input[type='hidden'], input[type='text'], textarea")
      );
      for (const field of candidates) {
        const key = `${field.id || ""} ${field.name || ""} ${field.getAttribute("data-testid") || ""}`.toLowerCase();
        if (!/(resume|cv|attachment|upload)/i.test(key)) continue;
        const value = normalize((field as HTMLInputElement).value || "");
        if (!value) continue;
        if (/fakepath/i.test(value)) continue;
        if (/select|choose|attach|upload|enter manually/i.test(value.toLowerCase())) continue;

        const selector = field.id
          ? `#${CSS.escape(field.id)}`
          : field.name
            ? `${field.tagName.toLowerCase()}[name="${field.name.replace(/"/g, '\\"')}"]`
            : undefined;
        return { ok: true, selector };
      }
      return { ok: false };
    }).catch(() => ({ ok: false }));
  }

  private async findResumeInputWithSelectedFile(
    page: AdapterRunContext["page"],
    resumePath: string
  ): Promise<{ ok: boolean; selector?: string }> {
    const expectedName = path.basename(resumePath).toLowerCase();
    return page
      .evaluate((expected) => {
        const selectors = [
          "#resume",
          "input[type='file'][name*='resume' i]",
          "input[type='file'][id*='resume' i]",
          "input[type='file'][name*='cv' i]",
          "input[type='file'][id*='cv' i]",
          "input[type='file']"
        ];

        const seen = new Set<HTMLInputElement>();
        const candidates: HTMLInputElement[] = [];
        for (const selector of selectors) {
          for (const input of Array.from(document.querySelectorAll<HTMLInputElement>(selector))) {
            if (seen.has(input)) continue;
            seen.add(input);
            candidates.push(input);
          }
        }

        for (const input of candidates) {
          const files = Array.from(input.files ?? []);
          if (!files.length) continue;
          const names = files.map((file) => (file.name || "").toLowerCase());
          const matches = names.some((name) => name === expected || name.endsWith(expected));
          if (!matches) continue;

          if (input.id) {
            return { ok: true, selector: `#${CSS.escape(input.id)}` };
          }
          if (input.name) {
            return {
              ok: true,
              selector: `input[type="file"][name="${input.name.replace(/"/g, '\\"')}"]`
            };
          }
          return { ok: true, selector: "input[type='file']" };
        }

        return { ok: false };
      }, expectedName)
      .catch(() => ({ ok: false }));
  }

  private async waitForResumeCueStabilization(
    page: AdapterRunContext["page"],
    expectedName: string
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const hasCue = await this.findVisibleResumeCue(page, expectedName, 0).then((result) => result.ok);
      if (hasCue) return;
      await sleep(250);
    }
  }

  private async findVisibleResumeCue(
    page: AdapterRunContext["page"],
    resumePathOrName: string,
    waitMs: number
  ): Promise<{ ok: boolean; cueText?: string }> {
    const expectedName = path.basename(resumePathOrName).toLowerCase();
    const deadline = Date.now() + Math.max(0, waitMs);

    do {
      const cue = await page
        .evaluate(({ expected }) => {
          const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
          const isVisible = (element: HTMLElement): boolean => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };

          const extractCueFromRoot = (root: Element | null): { ok: boolean; cueText?: string } => {
            if (!root) return { ok: false };
            const scopedCandidates = Array.from(
              root.querySelectorAll<HTMLElement>(
                ".file-name, .filename, .attachment, [data-qa*='resume' i], [class*='resume' i], [class*='attach' i], [class*='upload' i], [aria-live='polite'], [aria-live='assertive']"
              )
            );

            for (const element of scopedCandidates) {
              if (!isVisible(element)) continue;
              const text = normalize(element.textContent || "");
              if (!text) continue;
              if (text.includes(expected)) {
                return { ok: true, cueText: text };
              }
            }

            const rootText = normalize(root.textContent || "");
            if (rootText.includes(expected)) {
              return { ok: true, cueText: expected };
            }

            return { ok: false };
          };

          const resumeInput = document.querySelector<HTMLInputElement>("#resume, input[type='file'][name*='resume' i], input[type='file'][id*='resume' i], input[type='file'][name*='cv' i], input[type='file'][id*='cv' i]");
          const resumeLabel = document.querySelector<HTMLElement>("label[for='resume'], label[for*='resume' i], label[for*='cv' i]");
          const scopeCandidates = [
            resumeLabel?.closest("div, section, li, fieldset, form"),
            resumeInput?.closest("div, section, li, fieldset, form"),
            resumeInput?.closest("li, fieldset, section, form"),
            resumeLabel,
            resumeInput?.parentElement
          ].filter((entry): entry is Element => Boolean(entry));

          if (resumeInput) {
            let ancestor: Element | null = resumeInput.parentElement;
            let depth = 0;
            while (ancestor && depth < 6) {
              const scopedCue = extractCueFromRoot(ancestor);
              if (scopedCue.ok) {
                return scopedCue;
              }
              ancestor = ancestor.parentElement;
              depth += 1;
            }
          }

          for (const scope of scopeCandidates) {
            const scopedCue = extractCueFromRoot(scope);
            if (scopedCue.ok) {
              return scopedCue;
            }
          }

          const candidates = Array.from(
            document.querySelectorAll<HTMLElement>(
              ".file-name, .filename, .attachment, [data-qa*='resume' i], [class*='resume' i], [class*='attach' i], [class*='upload' i], [aria-live='polite'], [aria-live='assertive']"
            )
          );

          for (const element of candidates) {
            if (!isVisible(element)) continue;

            const text = normalize(element.textContent || "");
            if (!text) continue;
            if (text.includes(expected)) {
              return { ok: true, cueText: text };
            }
          }

          return { ok: false };
        }, { expected: expectedName })
        .catch(() => ({ ok: false }));

      if (cue.ok) return cue;
      if (waitMs <= 0 || Date.now() >= deadline) return { ok: false };
      await sleep(250);
    } while (true);
  }

  private findResumeMissingDetail(details: MissingFieldDetail[]): string | undefined {
    for (const detail of details) {
      const id = normalizeText(detail.id);
      const label = normalizeText(detail.label);
      if (/\b(resume|cv)\b/.test(id) || /\b(resume|curriculum vitae|cv)\b/.test(label)) {
        return `${detail.id || "resume"}:${detail.label || "Resume"}:${detail.role || detail.tag || "file"}`;
      }
      if (id === "resume" || id === "cv") {
        return `${detail.id || "resume"}:${detail.label || "Resume"}:${detail.role || detail.tag || "file"}`;
      }
    }
    return undefined;
  }

  private async shortPostSubmitSweep(
    page: AdapterRunContext["page"],
    seconds: number
  ): Promise<ShortSubmitSweepState> {
    const maxSeconds = Math.max(4, Math.min(20, seconds));
    for (let elapsed = 0; elapsed < maxSeconds; elapsed += 1) {
      const state = await page.evaluate(() => {
        const text = (document.body?.innerText || "").slice(0, 25000);
        const title = (document.title || "").slice(0, 500);
        const url = window.location.href || "";
        const headingText = Array.from(document.querySelectorAll<HTMLElement>("h1, h2, [role='heading']"))
          .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 8)
          .join(" | ");
        const successNodeText = Array.from(
          document.querySelectorAll<HTMLElement>(
            "[data-qa*='success' i], [data-qa*='confirm' i], .application_confirmation, .success-message, .thank-you, [class*='confirmation' i], [class*='success' i]"
          )
        )
          .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 8)
          .join(" | ");
        const combined = `${title}\n${headingText}\n${successNodeText}\n${text}`;
        const confirmedByText =
          /application (has been )?submitted|application received|your application (is|was|has been) (received|submitted)|we have received your application|thank you for applying|thanks for applying|submission (received|successful)|successfully submitted/i.test(
            combined
          );
        const confirmedByUrl =
          /submitted|thank-?you|application_confirmation|application-success|confirmation/i.test(url) &&
          !/apply|jobs?\/\d+/.test(url);
        const confirmed = confirmedByText || confirmedByUrl;
        const challengeDetected = Array.from(document.querySelectorAll("iframe")).some((frame) => {
          const src = (frame as HTMLIFrameElement).src || "";
          return /captcha|recaptcha/i.test(src);
        });
        const validationErrors = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".field-error, .error, .invalid-feedback, [role='alert'], [aria-live='polite'], [aria-live='assertive']"
          )
        )
          .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
          .filter((textValue) => Boolean(textValue) && /required|invalid|too short|please|must|select/i.test(textValue));

        return {
          confirmed,
          challengeDetected,
          validationErrors: Array.from(new Set(validationErrors)).slice(0, 12)
        };
      });

      if (state.confirmed) return state;
      if (state.validationErrors.length > 0 && elapsed >= 1) return state;
      if (state.challengeDetected && elapsed >= 2) return state;
      await sleep(1000);
    }

    const finalState = await page.evaluate(() => {
      const text = (document.body?.innerText || "").slice(0, 25000);
      const title = (document.title || "").slice(0, 500);
      const url = window.location.href || "";
      const headingText = Array.from(document.querySelectorAll<HTMLElement>("h1, h2, [role='heading']"))
        .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 8)
        .join(" | ");
      const successNodeText = Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-qa*='success' i], [data-qa*='confirm' i], .application_confirmation, .success-message, .thank-you, [class*='confirmation' i], [class*='success' i]"
        )
      )
        .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 8)
        .join(" | ");
      const combined = `${title}\n${headingText}\n${successNodeText}\n${text}`;
      const confirmedByText =
        /application (has been )?submitted|application received|your application (is|was|has been) (received|submitted)|we have received your application|thank you for applying|thanks for applying|submission (received|successful)|successfully submitted/i.test(
          combined
        );
      const confirmedByUrl =
        /submitted|thank-?you|application_confirmation|application-success|confirmation/i.test(url) &&
        !/apply|jobs?\/\d+/.test(url);
      const challengeDetected = Array.from(document.querySelectorAll("iframe")).some((frame) =>
        /captcha|recaptcha/i.test((frame as HTMLIFrameElement).src || "")
      );
      return { confirmed: confirmedByText || confirmedByUrl, challengeDetected };
    }).catch(() => ({ confirmed: false, challengeDetected: false }));

    return {
      confirmed: finalState.confirmed,
      challengeDetected: finalState.challengeDetected,
      validationErrors: await this.collectSubmitValidationErrors(page)
    };
  }

  private genericAnswer(question: ApplicationQuestion, context: { jobTitle?: string; company?: string }): string {
    const normalized = question.label.toLowerCase();
    const hintedOptions = Array.isArray(question.platformMeta?.optionHints)
      ? (question.platformMeta.optionHints as string[])
      : [];
    const optionPool = question.options?.length ? question.options : hintedOptions;

    if (question.type === "boolean") return "true";

    if (
      normalized.includes("why") &&
      (normalized.includes("role") || normalized.includes("company") || normalized.includes("position") || normalized.includes("interest"))
    ) {
      return `I'm excited about the opportunity to contribute to ${context.company ?? "your team"} in the ${context.jobTitle ?? "role"}. My background aligns with the responsibilities, and I'm motivated to build impactful production systems.`;
    }

    if (normalized.includes("start date") || normalized.includes("earliest start")) {
      return "Immediately";
    }

    if (optionPool.length) {
      const picked = pickBestOption("Yes", optionPool);
      if (normalizeText(picked) !== "yes") {
        return picked;
      }

      const firstUsable = optionPool.find((option) => !isPlaceholderOption(option));
      return firstUsable ?? optionPool[0] ?? "Yes";
    }

    return "Yes";
  }

  private async monitorSubmission(
    page: AdapterRunContext["page"],
    maxSeconds: number
  ): Promise<{ submitted: boolean; validationErrors: string[]; captchaDetected: boolean }> {
    let retriedWithToken = false;
    let captchaDetected = false;

    for (let second = 0; second < maxSeconds; second += 1) {
      const state = await page.evaluate(() => {
        const text = document.body ? document.body.innerText.slice(0, 18000) : "";
        const title = (document.title || "").slice(0, 500);
        const url = window.location.href || "";
        const headingText = Array.from(document.querySelectorAll<HTMLElement>("h1, h2, [role='heading']"))
          .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 8)
          .join(" | ");
        const successNodeText = Array.from(
          document.querySelectorAll<HTMLElement>(
            "[data-qa*='success' i], [data-qa*='confirm' i], .application_confirmation, .success-message, .thank-you, [class*='confirmation' i], [class*='success' i]"
          )
        )
          .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 8)
          .join(" | ");
        const combined = `${title}\n${headingText}\n${successNodeText}\n${text}`;
        const captchaFrames = Array.from(document.querySelectorAll("iframe"))
          .map((frame) => (frame as HTMLIFrameElement).src || "")
          .filter((src) => src.includes("recaptcha") || src.includes("captcha"));

        return {
          submitted:
            /application (has been )?submitted|application received|your application (is|was|has been) (received|submitted)|we have received your application|thank you for applying|thanks for applying|submission (received|successful)|successfully submitted/i.test(
              combined
            ) ||
            (/submitted|thank-?you|application_confirmation|application-success|confirmation/i.test(url) &&
              !/apply|jobs?\/\d+/.test(url)),
          captchaFrames,
          tokenValue: (() => {
            const fields = Array.from(
              document.querySelectorAll<HTMLTextAreaElement>(
                'textarea[name="g-recaptcha-response"], textarea[id^="g-recaptcha-response"]'
              )
            );
            for (const field of fields) {
              const token = (field.value || "").trim();
              if (token) return token;
            }
            return "";
          })(),
          validationErrors: (() => {
            const output = new Set<string>();

            const errorElements = Array.from(
              document.querySelectorAll<HTMLElement>(
                ".field-error, .error, .invalid-feedback, [role='alert'], [aria-live='polite'], [aria-live='assertive']"
              )
            );
            for (const errorElement of errorElements) {
              const message = (errorElement.textContent || "").replace(/\s+/g, " ").trim();
              if (!message) continue;
              if (/required|invalid|too short|please|must|select/i.test(message)) {
                output.add(message);
              }
            }

            return Array.from(output).slice(0, 12);
          })()
        };
      });

      if (state.submitted) {
        return { submitted: true, validationErrors: [], captchaDetected };
      }

      if (state.captchaFrames.length > 0) {
        captchaDetected = true;
      }

      if (state.captchaFrames.length > 0 && !state.tokenValue && second % 4 === 0) {
        const primed = await this.primeRecaptchaToken(page).catch(() => false);
        if (primed) {
          await page.waitForLoadState("domcontentloaded", { timeout: 500 }).catch(() => undefined);
        }
      }

      if (!retriedWithToken && state.captchaFrames.length > 0 && state.tokenValue) {
        retriedWithToken = true;

        await page.evaluate((token) => {
          const fields = Array.from(
            document.querySelectorAll<HTMLTextAreaElement>(
              'textarea[name="g-recaptcha-response"], textarea[id^="g-recaptcha-response"]'
            )
          );
          for (const field of fields) {
            field.value = token;
            field.innerHTML = token;
            field.dispatchEvent(new Event("input", { bubbles: true }));
            field.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }, state.tokenValue);

        await page
          .locator('button[type="submit"], #submit_app, input[type="submit"]')
          .first()
          .click()
          .catch(() => undefined);
      }

      if (!captchaDetected && state.validationErrors.length > 0 && second >= 3) {
        return { submitted: false, validationErrors: state.validationErrors, captchaDetected };
      }

      await sleep(1000);
    }

    const finalErrors = await this.collectSubmitValidationErrors(page);
    return { submitted: false, validationErrors: finalErrors, captchaDetected };
  }

  private async primeRecaptchaToken(page: AdapterRunContext["page"]): Promise<boolean> {
    return page.evaluate(async () => {
      const tokenSelectors = [
        'textarea[name="g-recaptcha-response"]',
        'textarea[id^="g-recaptcha-response"]'
      ];

      const applyToken = (token: string): boolean => {
        if (!token) return false;

        let applied = false;
        for (const selector of tokenSelectors) {
          const fields = Array.from(document.querySelectorAll<HTMLTextAreaElement>(selector));
          for (const field of fields) {
            field.value = token;
            field.innerHTML = token;
            field.dispatchEvent(new Event("input", { bubbles: true }));
            field.dispatchEvent(new Event("change", { bubbles: true }));
            field.dispatchEvent(new Event("blur", { bubbles: true }));
            applied = true;
          }
        }

        return applied;
      };

      const firstExisting = (
        document.querySelector('textarea[name="g-recaptcha-response"], textarea[id^="g-recaptcha-response"]') as
          | HTMLTextAreaElement
          | null
      )?.value;
      if (firstExisting && applyToken(firstExisting)) {
        return true;
      }

      const globalWindow = window as unknown as {
        grecaptcha?: {
          execute?: (key?: string, options?: { action?: string }) => Promise<string>;
          getResponse?: (arg0?: number) => string;
          enterprise?: {
            execute?: (arg0?: number | string, arg1?: { action?: string }) => Promise<string>;
            getResponse?: (arg0?: number) => string;
          };
          ready?: (callback: () => void) => void;
        };
        ___grecaptcha_cfg?: {
          clients?: Record<string, unknown>;
        };
      };

      const iframeSiteKeys = Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe"))
        .map((frame) => frame.src || "")
        .filter((src) => src.includes("recaptcha"))
        .map((src) => {
          try {
            return new URL(src).searchParams.get("k") || "";
          } catch {
            return "";
          }
        })
        .filter(Boolean);

      const siteKeys = Array.from(new Set(iframeSiteKeys));
      for (const siteKey of siteKeys) {
        try {
          const enterpriseToken = await globalWindow.grecaptcha?.enterprise?.execute?.(siteKey, { action: "submit" });
          if (enterpriseToken && applyToken(enterpriseToken)) {
            return true;
          }
        } catch {
          // continue
        }

        try {
          const standardToken = await globalWindow.grecaptcha?.execute?.(siteKey, { action: "submit" });
          if (standardToken && applyToken(standardToken)) {
            return true;
          }
        } catch {
          // continue
        }
      }

      const clientIds = Object.keys(globalWindow.___grecaptcha_cfg?.clients ?? {});
      for (const rawClientId of clientIds) {
        const parsedClientId = Number(rawClientId);
        const clientId = Number.isFinite(parsedClientId) ? parsedClientId : undefined;

        try {
          const fromGetResponse = globalWindow.grecaptcha?.enterprise?.getResponse?.(clientId);
          if (fromGetResponse && applyToken(fromGetResponse)) {
            return true;
          }
        } catch {
          // continue
        }

        try {
          const executed = await globalWindow.grecaptcha?.enterprise?.execute?.(clientId, { action: "submit" });
          if (executed && applyToken(executed)) {
            return true;
          }
        } catch {
          // continue
        }
      }

      return false;
    }).catch(() => false);
  }

  private async collectSubmitValidationErrors(page: AdapterRunContext["page"]): Promise<string[]> {
    return page.evaluate(() => {
      const output = new Set<string>();

      const errorElements = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".field-error, .error, .invalid-feedback, [role='alert'], [aria-live='polite'], [aria-live='assertive']"
        )
      );
      for (const errorElement of errorElements) {
        const message = (errorElement.textContent || "").replace(/\s+/g, " ").trim();
        if (!message) continue;
        if (/required|invalid|too short|please|must|select/i.test(message)) {
          output.add(message);
        }
      }

      return Array.from(output).slice(0, 12);
    });
  }

  private locatorById(page: AdapterRunContext["page"], id: string) {
    return page.locator(`[id=${JSON.stringify(id)}], [name=${JSON.stringify(id)}]`);
  }

  private locateQuestionControl(page: AdapterRunContext["page"], question: GreenhouseQuestion) {
    const selectors = [
      question.domId ? `[id=${JSON.stringify(question.domId)}], [name=${JSON.stringify(question.domId)}]` : "",
      question.selector ?? "",
      ...(question.selectorCandidates ?? [])
    ].filter(Boolean);
    if (!selectors.length) {
      return this.locatorById(page, question.id).first();
    }
    return page.locator(selectors.join(", ")).first();
  }

  private async setValueByQuestion(
    page: AdapterRunContext["page"],
    question: Pick<GreenhouseQuestion, "id" | "domId" | "selector" | "selectorCandidates">,
    value: string
  ): Promise<boolean> {
    if (question.domId) {
      const ok = await this.setValueById(page, question.domId, value).catch(() => false);
      if (ok) return true;
    }
    const selectorPool = [question.selector ?? "", ...(question.selectorCandidates ?? [])].filter(Boolean);
    for (const selector of selectorPool) {
      const locator = page.locator(selector).first();
      if (!(await locator.count().catch(() => 0))) continue;
      const filled = await locator.fill(value).then(() => true).catch(() => false);
      if (filled) return true;
    }
    return this.setValueById(page, question.id, value).catch(() => false);
  }

  private async selectBySelector(
    page: AdapterRunContext["page"],
    selector: string,
    answer: string
  ): Promise<boolean> {
    const locator = page.locator(selector).first();
    if (!(await locator.count().catch(() => 0))) return false;
    const tag = await locator.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
    if (tag === "select") {
      return locator.selectOption({ label: answer }).then(() => true).catch(() => false);
    }
    const role = await locator.evaluate((element) => element.getAttribute("role") || "").catch(() => "");
    if (role === "combobox") {
      return this.selectComboboxByLocator(page, locator, [answer]).catch(() => false);
    }
    return false;
  }

  private normalizeAnswerForFieldType(
    inputKind: FieldControlType,
    answer: string,
    optionPool: string[],
    label?: string
  ): string {
    if (!optionPool.length) return answer;
    if (inputKind !== "select" && inputKind !== "combobox" && inputKind !== "radio-group" && inputKind !== "checkbox-group") {
      return answer;
    }
    const matched = findBestOptionMatch(answer, optionPool);
    if (matched) return matched;
    const normalizedLabel = normalizeText(label || "");
    if (this.isLocationBasedPrompt(normalizedLabel) || /\bcountry\b|\bstate\b|\bcity\b|\blocation\b/.test(normalizedLabel)) {
      return answer;
    }
    if (/\bschool\b|\buniversity\b|\bcollege\b|\bdegree\b|\bdiscipline\b|\bmajor\b|\bfield\b|start date|end date|graduation/.test(normalizedLabel)) {
      return answer;
    }
    const firstUsable = optionPool.find((option) => !isPlaceholderOption(option));
    return firstUsable ?? optionPool[0] ?? answer;
  }

  private async collectMissingRequiredFields(page: AdapterRunContext["page"]): Promise<string[]> {
    const details = await this.collectMissingRequiredDetails(page);
    const output = new Set<string>();
    for (const detail of details) {
      const label = (detail.label || "").trim();
      output.add(label || detail.id);
    }
    return Array.from(output);
  }

  private async collectMissingRequiredDetails(
    page: AdapterRunContext["page"]
  ): Promise<MissingFieldDetail[]> {
    return page.evaluate(() => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const isVisible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const labelFor = (control: Element): string => {
        const input = control as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        if (input instanceof HTMLInputElement && (input.type === "radio" || input.type === "checkbox")) {
          const legend = input.closest("fieldset")?.querySelector("legend");
          const legendText = normalize(legend?.textContent || "");
          if (legendText) return legendText.replace(/\*/g, "");
        }
        if ("id" in input && input.id) {
          const explicit = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
          const text = normalize(explicit?.textContent || "");
          if (text) return text.replace(/\*/g, "");
        }
        const wrapping = control.closest("label");
        const wrappingText = normalize(wrapping?.textContent || "");
        if (wrappingText) return wrappingText.replace(/\*/g, "");
        const legend = control.closest("fieldset")?.querySelector("legend");
        const legendText = normalize(legend?.textContent || "");
        if (legendText) return legendText.replace(/\*/g, "");
        return normalize((control as HTMLElement).getAttribute("aria-label") || "");
      };
      const isPlaceholder = (value: string): boolean => {
        const normalized = normalize(value).toLowerCase();
        return (
          !normalized ||
          normalized === "select" ||
          normalized === "select..." ||
          normalized === "--" ||
          normalized === "-" ||
          normalized === "choose" ||
          normalized === "choose..." ||
          normalized.includes("please select")
        );
      };

      const output: MissingFieldDetail[] = [];
      const seenGroup = new Set<string>();
      const controls = Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")
      );

      for (const control of controls) {
        if (!isVisible(control)) continue;
        if (control instanceof HTMLInputElement && ["hidden", "submit", "button", "reset", "image"].includes(control.type)) continue;
        if (control instanceof HTMLInputElement && control.classList.contains("remix-css-1a0ro4n-requiredInput") && !control.id && !control.name) {
          continue;
        }

        const requiredByAttribute =
          control.required ||
          control.getAttribute("aria-required") === "true" ||
          control.getAttribute("data-required") === "true";
        const isCombobox =
          control.getAttribute("role") === "combobox" ||
          control.getAttribute("aria-autocomplete") === "list" ||
          Boolean(control.closest(".select-shell"));
        const shell = control.closest(".select-shell");
        const requiredSentinel = shell?.querySelector(
          "input.remix-css-1a0ro4n-requiredInput[required], input[required][aria-hidden='true']"
        ) as HTMLInputElement | null;
        const required = requiredByAttribute || Boolean(requiredSentinel);
        if (!required) continue;

        if (control instanceof HTMLInputElement && (control.type === "radio" || control.type === "checkbox")) {
          const groupName = control.name || control.id || `group_${control.type}_${output.length}`;
          const groupKey = `${control.type}:${groupName}`;
          if (seenGroup.has(groupKey)) continue;
          seenGroup.add(groupKey);

          const group = control.name
            ? Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="${control.type}"][name="${CSS.escape(control.name)}"]`))
            : [control];
          const visibleGroup = group.filter((item) => isVisible(item));
          if (!visibleGroup.length) continue;
          const requiredGroup = visibleGroup.some((item) =>
            item.required || item.getAttribute("aria-required") === "true" || item.getAttribute("data-required") === "true"
          );
          if (!requiredGroup) continue;
          const anyChecked = visibleGroup.some((item) => item.checked);
          const anyInvalid = visibleGroup.some((item) => item.getAttribute("aria-invalid") === "true");
          if (anyChecked && !anyInvalid) continue;
          const first = visibleGroup[0]!;
          const fieldsetLegend = normalize(first.closest("fieldset")?.querySelector("legend")?.textContent || "").replace(/\*/g, "");
          output.push({
            id: control.name || control.id || groupKey,
            label: fieldsetLegend || labelFor(first) || control.name || control.id || "Required field",
            role: control.type,
            tag: "input"
          });
          continue;
        }

        let satisfied = false;
        if (control instanceof HTMLSelectElement) {
          const selected = normalize(control.selectedOptions[0]?.textContent || control.value || "");
          satisfied = Boolean(selected && !isPlaceholder(selected));
        } else if (isCombobox) {
          const selectedValue = normalize(
            shell?.querySelector(".select__single-value, [class*='singleValue' i]")?.textContent || (control as HTMLInputElement).value || ""
          );
          const sentinelValue = normalize(requiredSentinel?.value || "");
          satisfied = Boolean(selectedValue && !isPlaceholder(selectedValue) && (!requiredSentinel || sentinelValue));
        } else {
          satisfied = Boolean(normalize(control.value || ""));
        }

        const invalid =
          control.getAttribute("aria-invalid") === "true" ||
          (requiredSentinel?.getAttribute("aria-invalid") === "true");
        if (satisfied && !invalid) continue;

        const id = control.id || control.getAttribute("name") || `missing_${output.length}_${control.tagName.toLowerCase()}`;
        output.push({
          id,
          label: labelFor(control) || control.getAttribute("name") || id,
          role: control.getAttribute("role") || "",
          tag: control.tagName.toLowerCase()
        });
      }

      const fileGroups = Array.from(document.querySelectorAll<HTMLElement>(".file-upload, [role='group'].file-upload, [role='group']"));
      for (const group of fileGroups) {
        const fileInput = group.querySelector<HTMLInputElement>("input[type='file']");
        if (!fileInput) continue;

        const groupLabelNode =
          group.querySelector<HTMLElement>(".upload-label, .label") ||
          (group.getAttribute("aria-labelledby")
            ? document.getElementById(group.getAttribute("aria-labelledby") || "")
            : null);
        const groupLabel = normalize((groupLabelNode?.textContent || labelFor(fileInput) || "").replace(/\*/g, ""));
        const isResumeGroup =
          /\bresume\b|\bcv\b|curriculum vitae/i.test(groupLabel) ||
          /\bresume\b|\bcv\b/i.test(`${fileInput.id || ""} ${fileInput.name || ""}`);
        if (!isResumeGroup) continue;

        const requiredByGroup =
          group.getAttribute("aria-required") === "true" ||
          Boolean(groupLabelNode?.textContent && /\*/.test(groupLabelNode.textContent));
        const requiredByInput =
          fileInput.required ||
          fileInput.getAttribute("aria-required") === "true";
        const required = requiredByGroup || requiredByInput;
        if (!required) continue;

        const files = Array.from(fileInput.files ?? []);
        const hasFile = files.length > 0;
        const sentinel = group.querySelector<HTMLInputElement>(
          "input.remix-css-1a0ro4n-requiredInput[required], input[required][aria-hidden='true']"
        );
        const sentinelSatisfied = Boolean(normalize(sentinel?.value || ""));
        const hasErrorMarker =
          fileInput.getAttribute("aria-invalid") === "true" ||
          group.querySelector("[aria-invalid='true'], .label--error, .input-wrapper--error, .error, .field-error, .invalid-feedback") !== null ||
          Array.from(group.querySelectorAll<HTMLElement>("[role='alert'], [aria-live='polite'], [aria-live='assertive']")).some((element) => {
            if (!isVisible(element)) return false;
            const text = normalize(element.textContent || "");
            return /required|invalid|must|attach|upload|please/.test(text);
          });

        const satisfied = hasFile && (!sentinel || sentinelSatisfied);
        if (satisfied && !hasErrorMarker) continue;

        output.push({
          id: fileInput.id || fileInput.name || "resume",
          label: groupLabel || "Resume",
          role: "file",
          tag: "input"
        });
      }

      const unique = new Map<string, MissingFieldDetail>();
      for (const item of output) unique.set(`${item.id}:${item.role}:${item.tag}`, item);
      return Array.from(unique.values());
    });
  }

  private splitPhone(raw: string | undefined): { countryCode: string; local?: string } {
    if (!raw) {
      return { countryCode: "+1", local: undefined };
    }

    const digits = raw.replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("1")) {
      const local = digits.slice(1);
      return {
        countryCode: "+1",
        local: `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6, 10)}`
      };
    }

    if (digits.length === 10) {
      return {
        countryCode: "+1",
        local: `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 10)}`
      };
    }

    return { countryCode: "+1", local: raw };
  }

  private async closePhoneCountryWidget(page: AdapterRunContext["page"]): Promise<void> {
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.evaluate(() => {
      const searchInputs = Array.from(
        document.querySelectorAll<HTMLInputElement>("input[id^='iti-'][id$='__search-input']")
      );
      for (const input of searchInputs) {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.blur();
      }

      const listboxes = Array.from(document.querySelectorAll<HTMLElement>(".iti__country-listbox"));
      for (const listbox of listboxes) {
        listbox.style.display = "none";
      }
    }).catch(() => undefined);
    await page.keyboard.press("Escape").catch(() => undefined);
  }

  private async fillByLabelOrSelector(
    page: AdapterRunContext["page"],
    value: string,
    labelPattern: RegExp,
    selectors: string[]
  ): Promise<boolean> {
    if (!value) return false;

    const byLabel = page.getByLabel(labelPattern).first();
    if (await byLabel.count()) {
      const tag = await byLabel.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
      if (tag === "select") {
        await byLabel.selectOption({ label: value }).catch(() => undefined);
      } else {
        await byLabel.fill(value).catch(() => undefined);
      }
      return true;
    }

    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (!(await locator.count())) continue;
      await locator.fill(value).catch(() => undefined);
      return true;
    }

    return false;
  }

  private async selectCountryCodeUS(page: AdapterRunContext["page"]): Promise<boolean> {
    const candidates = ["+1", "1", "United States", "United States (+1)", "US", "USA"];
    const selectors = [
      'select[name*="country code" i]',
      'select[id*="country code" i]',
      'select[name*="dial" i]',
      'select[id*="dial" i]',
      'select[name*="country" i]',
      'select[id*="country" i]',
      'select[name*="phone" i]',
      'select[id*="phone" i]'
    ];

    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (!(await locator.count())) continue;

      const optionLabels = await locator.locator("option").allTextContents().catch(() => []);
      const best =
        optionLabels.find((label) => /\(\+?1\)|\+1\b/.test(label)) ||
        optionLabels.find((label) => /united states|^us$|^usa$/i.test(label));
      if (!best) continue;

      const selected = await locator.selectOption({ label: best }).then(() => true).catch(() => false);
      if (selected) {
        await this.syncCountryHiddenInput(page, "+1").catch(() => undefined);
        await page.keyboard.press("Escape").catch(() => undefined);
        return true;
      }
    }

    for (const id of ["country_code", "phone_country_code", "dial_code", "phone_dial_code"]) {
      for (const candidate of candidates) {
        const selected = await this.selectReactOptionByIdPrefix(page, id, candidate).catch(() => false);
        if (selected) {
          await this.syncCountryHiddenInput(page, "+1").catch(() => undefined);
          return true;
        }
      }
    }

    const combobox = page.getByRole("combobox", { name: /country code|dial code|phone country/i }).first();
    if (await combobox.count().catch(() => 0)) {
      const selected = await this.selectComboboxByLocator(page, combobox, candidates).catch(() => false);
      if (selected) {
        await this.syncCountryHiddenInput(page, "+1").catch(() => undefined);
        return true;
      }
    }

    return false;
  }

  private countryOptionCandidates(country: string | undefined): string[] {
    const out: string[] = [];
    const push = (value: string | undefined): void => {
      const trimmed = (value || "").trim();
      if (!trimmed) return;
      if (!out.some((existing) => normalizeText(existing) === normalizeText(trimmed))) {
        out.push(trimmed);
      }
    };

    push(country);
    const normalized = normalizeText(country || "");
    if (/\bunited states\b|\busa\b|\bus\b|\bu\.s\b/.test(normalized)) {
      push("United States");
      push("United States of America");
      push("US");
      push("USA");
    }

    return out;
  }

  private async findInputIdByLabel(page: AdapterRunContext["page"], labelPattern: string): Promise<string | undefined> {
    return page.evaluate((rawPattern) => {
      const pattern = new RegExp(rawPattern, "i");
      const labels = Array.from(document.querySelectorAll("label"));
      for (const label of labels) {
        const text = (label.textContent || "").trim();
        if (!pattern.test(text)) continue;

        const htmlFor = label.getAttribute("for");
        if (htmlFor) return htmlFor;

        const nested = label.querySelector("input, textarea, select") as
          | HTMLInputElement
          | HTMLTextAreaElement
          | HTMLSelectElement
          | null;
        if (nested?.id) return nested.id;
      }
      return undefined;
    }, labelPattern);
  }

  private async syncCountryHiddenInput(page: AdapterRunContext["page"], value: string): Promise<void> {
    await page.evaluate((nextValue) => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLInputElement>(
          'input.remix-css-1a0ro4n-requiredInput, input[required][aria-hidden="true"]'
        )
      ).filter((input) => {
        const parentText = (input.closest("div")?.textContent || "").toLowerCase();
        return parentText.includes("country") || parentText.includes("phone");
      });

      for (const input of candidates) {
        if (input.value && input.value.trim()) continue;
        input.value = nextValue;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("blur", { bubbles: true }));
      }
    }, value);
  }

  private async syncReactSelectRequiredInput(
    page: AdapterRunContext["page"],
    id: string,
    fallbackValue: string
  ): Promise<void> {
    await page.evaluate(({ targetId, nextValue }) => {
      const element = document.getElementById(targetId) as HTMLInputElement | null;
      if (!element) return;

      const shell = element.closest(".select-shell");
      if (!shell) return;

      const selectedText = (
        shell.querySelector(".select__single-value, [class*='singleValue' i]")?.textContent || ""
      )
        .replace(/\s+/g, " ")
        .trim();
      const applied = (selectedText || nextValue || element.value || "").trim();
      if (!applied) return;

      const hidden = shell.querySelector(
        "input.remix-css-1a0ro4n-requiredInput, input[required][aria-hidden='true']"
      ) as HTMLInputElement | null;
      if (hidden) {
        hidden.value = applied;
        hidden.dispatchEvent(new Event("input", { bubbles: true }));
        hidden.dispatchEvent(new Event("change", { bubbles: true }));
        hidden.dispatchEvent(new Event("blur", { bubbles: true }));
      }

      const relatedInputs = Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
          "input[type='hidden'], input[required], input[aria-hidden='true'], select[required], select"
        )
      ).filter((candidate) => {
        const idOrName = `${candidate.id || ""} ${candidate.getAttribute("name") || ""}`.toLowerCase();
        return idOrName.includes(targetId.toLowerCase());
      });
      for (const candidate of relatedInputs) {
        if (candidate instanceof HTMLSelectElement) {
          if (!candidate.value && applied) {
            const matchingOption = Array.from(candidate.options).find((option) => {
              const text = (option.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
              const value = (option.value || "").replace(/\s+/g, " ").trim().toLowerCase();
              const wanted = applied.toLowerCase();
              return text === wanted || value === wanted || text.includes(wanted) || wanted.includes(text);
            });
            if (matchingOption) candidate.value = matchingOption.value;
          }
        } else if (!(candidate.value || "").trim()) {
          candidate.value = applied;
        }
        candidate.dispatchEvent(new Event("input", { bubbles: true }));
        candidate.dispatchEvent(new Event("change", { bubbles: true }));
        candidate.dispatchEvent(new Event("blur", { bubbles: true }));
      }

      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));
    }, { targetId: id, nextValue: fallbackValue });
  }

  private async syncAllRequiredSelectSentinels(page: AdapterRunContext["page"]): Promise<void> {
    await page.evaluate(() => {
      const shells = Array.from(document.querySelectorAll<HTMLElement>(".select-shell"));
      for (const shell of shells) {
        const hidden = shell.querySelector(
          "input.remix-css-1a0ro4n-requiredInput[required], input[required][aria-hidden='true']"
        ) as HTMLInputElement | null;
        if (!hidden) continue;
        if (hidden.value && hidden.value.trim()) continue;

        const selected = (
          shell.querySelector(".select__single-value, [class*='singleValue' i]")?.textContent || ""
        )
          .replace(/\s+/g, " ")
          .trim();
        if (!selected || /^select\.\.\.$/i.test(selected)) continue;

        hidden.value = selected;
        hidden.dispatchEvent(new Event("input", { bubbles: true }));
        hidden.dispatchEvent(new Event("change", { bubbles: true }));
        hidden.dispatchEvent(new Event("blur", { bubbles: true }));
      }
    });
  }

  private async setFileInputById(
    page: AdapterRunContext["page"],
    id: string,
    filePath: string
  ): Promise<boolean> {
    return this.setFileInputBySelector(page, `[id=${JSON.stringify(id)}]`, filePath);
  }

  private async setFileInputBySelector(
    page: AdapterRunContext["page"],
    selector: string,
    filePath: string
  ): Promise<boolean> {
    const locator = page.locator(selector).first();
    if (!(await locator.count())) return false;

    const uploaded = await locator
      .setInputFiles(filePath)
      .then(() => true)
      .catch(() => false);
    if (!uploaded) return false;
    await locator.evaluate((element) => {
      const input = element as HTMLInputElement;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    }).catch(() => undefined);

    const inputPresence = await this.verifyFileUploadPresence(page, selector, filePath);
    if (inputPresence) return true;

    return this.findVisibleResumeCue(page, filePath, 1200)
      .then((result) => result.ok)
      .catch(() => false);
  }

  private async verifyFileUploadPresence(
    page: AdapterRunContext["page"],
    selector: string,
    filePath: string
  ): Promise<boolean> {
    const expectedName = path.basename(filePath).toLowerCase();
    const locator = page.locator(selector).first();
    if (!(await locator.count())) return false;

    return locator
      .evaluate((element, expected) => {
        const input = element as HTMLInputElement;
        const files = input.files;
        const inputHasFile = Boolean(files && files.length > 0);
        if (!inputHasFile) return false;

        const names = Array.from(files ?? []).map((file) => (file.name || "").toLowerCase());
        return names.some((name) => name === expected || name.endsWith(expected));
      }, expectedName)
      .catch(() => false);
  }

  private async readInputValue(page: AdapterRunContext["page"], id: string): Promise<string> {
    const locator = await this.resolveFieldLocator(page, id);
    return locator
      .evaluate((element) => {
        const input = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        return (input.value || "").trim();
      })
      .catch(() => "");
  }

  private async setValueById(page: AdapterRunContext["page"], id: string, value: string): Promise<boolean> {
    const locator = await this.resolveFieldLocator(page, id);
    if (!(await locator.count().catch(() => 0))) return false;
    await locator.evaluate((element, nextValue) => {
      const input = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const prototype =
        input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : input instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;

      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(input, nextValue ?? "");
      else input.value = nextValue ?? "";

      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    }, value ?? "");

    return true;
  }

  private async setIdentityValueById(page: AdapterRunContext["page"], id: string, value: string): Promise<boolean> {
    const locator = await this.resolveFieldLocator(page, id);
    if (!(await locator.count().catch(() => 0))) return false;
    const normalizedTarget = normalizeText(value ?? "");
    await locator.click({ force: true }).catch(() => undefined);
    await locator.press("ControlOrMeta+A").catch(() => undefined);
    await locator.type(value ?? "", { delay: 16 }).catch(() => undefined);
    let current = await locator.inputValue().catch(() => "");
    if (normalizeText(current) !== normalizedTarget) {
      await locator.fill(value ?? "").catch(() => undefined);
      current = await locator.inputValue().catch(() => "");
    }
    await locator.dispatchEvent("change").catch(() => undefined);
    await locator.dispatchEvent("blur").catch(() => undefined);
    if (normalizeText(current) !== normalizedTarget) {
      return this.setValueById(page, id, value);
    }
    return true;
  }

  private async resolveFieldLocator(page: AdapterRunContext["page"], id: string): Promise<ReturnType<AdapterRunContext["page"]["locator"]>> {
    const locator = this.locatorById(page, id);
    const count = await locator.count().catch(() => 0);
    if (!count) return locator.first();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;
      const enabled = await candidate.isEnabled().catch(() => true);
      if (!enabled) continue;
      return candidate;
    }
    return locator.first();
  }

  private async selectNativeOption(page: AdapterRunContext["page"], id: string, answer: string): Promise<boolean> {
    const locator = this.locatorById(page, id);
    const isSelect = await locator
      .evaluate((element) => element.tagName.toLowerCase() === "select")
      .catch(() => false);
    if (!isSelect) return false;

    const picked = await locator.selectOption({ label: answer }).then(() => true).catch(async () => {
      const options = await locator.locator("option").allTextContents().catch(() => [] as string[]);
      const best =
        options.find((option) => normalizeText(option) === normalizeText(answer)) ||
        options.find((option) => normalizeText(option).includes(normalizeText(answer))) ||
        options.find((option) => normalizeText(answer).includes(normalizeText(option)));

      if (best) {
        return locator.selectOption({ label: best }).then(() => true).catch(() => false);
      }
      return false;
    });

    return picked;
  }

  private async selectReactOption(page: AdapterRunContext["page"], id: string, answer: string): Promise<boolean> {
    const committed = await this.commitReactSelectOption(page, id, answer).catch(() => null);
    if (committed?.applied) return true;

    const hints = await this.peekSelectOptionHints(page, id);
    if (!hints.length) return false;
    const matchedHint = pickBestOption(answer, hints);
    if (normalizeText(matchedHint) === normalizeText(answer)) return false;

    const hintCommit = await this.commitReactSelectOption(page, id, matchedHint).catch(() => null);
    return Boolean(hintCommit?.applied);
  }

  private async waitForTypedInputValue(
    input: ReturnType<AdapterRunContext["page"]["locator"]>,
    desired: string
  ): Promise<void> {
    const normalizedDesired = normalizeText(desired);
    if (!normalizedDesired) return;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await input.inputValue().then((value) => normalizeText(value)).catch(() => "");
      if (!current || current === normalizedDesired || normalizedDesired.includes(current) || current.includes(normalizedDesired)) {
        return;
      }
      await sleep(60);
    }
  }

  private async reactSelectInputLocator(
    page: AdapterRunContext["page"],
    id: string
  ): Promise<ReturnType<AdapterRunContext["page"]["locator"]>> {
    const fallback = this.locatorById(page, id).first();
    const shellInputSelector = await page
      .evaluate((targetId) => {
        const target = document.getElementById(targetId);
        if (!target) return "";
        const shell = target.closest(".select-shell");
        if (!shell) return "";
        const input = shell.querySelector<HTMLInputElement>(
          "input[id^='react-select-'][id$='-input'], input[role='combobox'], input[aria-autocomplete='list']"
        );
        if (!input?.id) return "";
        return `#${CSS.escape(input.id)}`;
      }, id)
      .catch(() => "");
    if (shellInputSelector) {
      const shellInput = page.locator(shellInputSelector).first();
      if (await shellInput.count().catch(() => 0)) {
        return shellInput;
      }
    }

    const explicitReactId = page.locator(`[id=${JSON.stringify(`react-select-${id}-input`)}]`).first();
    if (await explicitReactId.count().catch(() => 0)) {
      return explicitReactId;
    }

    return fallback;
  }

  private defaultComboboxFallbackCandidates(
    label: string,
    profile: AdapterRunContext["profile"],
    primary?: string
  ): string[] {
    const normalized = normalizeText(label);
    const out: string[] = [];
    const push = (value: string | undefined): void => {
      const trimmed = (value || "").trim();
      if (!trimmed) return;
      if (!out.some((existing) => normalizeText(existing) === normalizeText(trimmed))) {
        out.push(trimmed);
      }
    };

    if (this.isLocationBasedPrompt(normalized)) {
      const cityStateCountry = this.buildCityStateCountryCandidate(profile);
      push(cityStateCountry);
      for (const candidate of this.buildGeoAnswerCandidates(profile)) {
        push(candidate);
      }
      return out;
    }
    push(primary);

    if (
      /comfortable|able|willing/.test(normalized) &&
      /(on[- ]?site|onsite|in[- ]?person|office|commute|days?\s+a\s+week|\b3\s+days?\b|\bthree\s+days?\b)/.test(normalized)
    ) {
      const custom = profile.customAnswers ?? {};
      const onsiteSignal = [
        custom["able to work onsite"],
        custom["work onsite"],
        custom["onsite"],
        custom["open to relocation"],
        custom["willing to relocate"]
      ].find((value) => typeof value === "boolean" || typeof value === "string");
      if (typeof onsiteSignal === "boolean") {
        push(onsiteSignal ? "Yes" : "No");
      } else if (typeof onsiteSignal === "string") {
        push(onsiteSignal);
      }
      push("Yes");
      push("No");
      return out;
    }

    if (
      /(location mode|work model|work arrangement|preferred work (location|model)|remote\/hybrid|hybrid\/remote)/.test(normalized) ||
      (/(remote|hybrid|onsite|on-site)/.test(normalized) && /(preference|preferred|choose|model|arrangement)/.test(normalized))
    ) {
      if (typeof profile.customAnswers?.location_mode === "string") {
        push(profile.customAnswers.location_mode);
      }
      push("Remote");
      push("Hybrid");
      push("On-site");
      push("Onsite");
      return out;
    }

    if (/legally eligible|right to work|authorized to work|work authorization/.test(normalized)) {
      if (profile.workAuthorization?.authorizedToWork === true) {
        push("Yes");
        push("I am authorized to work");
      } else if (profile.workAuthorization?.authorizedToWork === false) {
        push("No");
      }
      return out;
    }

    if (/status.*allows? you to work and live|immigration status|visa/.test(normalized)) {
      if (profile.workAuthorization?.requiresSponsorship === false || profile.workAuthorization?.authorizedToWork === true) {
        push("Citizen");
        push("Permanent Resident");
        push("Authorized");
        push("No sponsorship required");
      }
      if (profile.workAuthorization?.requiresSponsorship === true) {
        push("Work Visa");
        push("Sponsorship required");
      }
      return out;
    }

    if (/gender/.test(normalized)) {
      push("I don't wish to answer");
      push("Decline To Self Identify");
      push("Prefer not to say");
      return out;
    }

    if (/race|ethnic/.test(normalized)) {
      push("I don't wish to answer");
      push("Decline To Self Identify");
      push("Prefer not to say");
      return out;
    }

    if (/sexual orientation/.test(normalized)) {
      push("I don't wish to answer");
      push("Decline To Self Identify");
      push("Prefer not to say");
      return out;
    }

    if (/pronoun/.test(normalized)) {
      push("I don't wish to answer");
      push("Decline To Self Identify");
      push("Prefer not to say");
      return out;
    }

    if (/veteran|disability/.test(normalized)) {
      push("Prefer not to say");
      push("Decline to self-identify");
      push("No");
      push("Yes");
      return out;
    }

    push("Yes");
    push("No");
    return out;
  }

  private shouldUseTypeWaitEnterComboboxFirstPass(normalizedLabel: string): boolean {
    const semantic = this.classifyComboboxSemantic(normalizedLabel);
    return semantic === "city_location" || semantic === "demographic" || semantic === "school" || semantic === "degree" || semantic === "discipline";
  }

  private firstPassComboboxCandidates(normalizedLabel: string, answer: string): string[] {
    const out: string[] = [];
    const push = (value: string | undefined): void => {
      const trimmed = (value || "").trim();
      if (!trimmed) return;
      if (!out.some((existing) => normalizeText(existing) === normalizeText(trimmed))) {
        out.push(trimmed);
      }
    };

    if (this.getDemographicFieldKind(normalizedLabel)) {
      push("I don't wish to answer");
      push("Decline To Self Identify");
      push(answer);
      return out;
    }
    push(answer);
    return out;
  }

  private async selectComboboxByMissingField(
    page: AdapterRunContext["page"],
    field: MissingFieldDetail,
    rawCandidates: string[]
  ): Promise<boolean> {
    const candidates = rawCandidates.map((value) => value.trim()).filter(Boolean);
    if (!candidates.length) {
      return false;
    }

    const comboboxTargets = [
      this.locatorById(page, field.id).first(),
      field.label ? page.getByLabel(new RegExp(escapeRegExp(field.label), "i")).first() : undefined,
      field.label
        ? page.getByRole("combobox", { name: new RegExp(escapeRegExp(field.label), "i") }).first()
        : undefined,
      field.label
        ? page
            .locator(
              `div:has(label:has-text("${field.label.replace(/"/g, '\\"')}")) [role="combobox"], fieldset:has-text("${field.label.replace(/"/g, '\\"')}") [role="combobox"]`
            )
            .first()
        : undefined
    ].filter((target): target is ReturnType<AdapterRunContext["page"]["locator"]> => Boolean(target));

    for (const target of comboboxTargets) {
      if (!(await target.count().catch(() => 0))) continue;
      const selected = await this.selectComboboxByLocator(page, target, candidates);
      if (selected) return true;
    }

    return false;
  }

  private async selectComboboxByLocator(
    page: AdapterRunContext["page"],
    combobox: ReturnType<AdapterRunContext["page"]["locator"]>,
    candidates: string[]
  ): Promise<boolean> {
    const waitOptions = async (): Promise<boolean> => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const ready = await combobox.evaluate((element) => {
          const visible = (candidate: Element): boolean => {
            const html = candidate as HTMLElement;
            const style = window.getComputedStyle(html);
            const rect = html.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          const ariaControls = (element.getAttribute("aria-controls") || "").trim();
          if (!ariaControls) return false;
          const listbox = document.getElementById(ariaControls);
          if (!listbox || !visible(listbox)) return false;
          const options = Array.from(listbox.querySelectorAll<HTMLElement>(".select__option, [role='option']")).filter((option) => visible(option));
          return options.length > 0;
        }).catch(() => false);
        if (ready) return true;
        await page.waitForTimeout(120).catch(() => undefined);
      }
      return false;
    };

    await page.keyboard.press("Escape").catch(() => undefined);
    await combobox.click({ force: true }).catch(() => undefined);
    await waitOptions();

    const pickVisibleOption = async (optionCandidates: string[]): Promise<string> => {
      const picked = await page.evaluate((desiredCandidates) => {
        const normalize = (value: string) => value.trim().toLowerCase();
        const wanted = desiredCandidates.map((value) => normalize(value)).filter(Boolean);
        const visible = (element: Element): boolean => {
          const html = element as HTMLElement;
          const rect = html.getBoundingClientRect();
          const style = window.getComputedStyle(html);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        };

        const active = document.activeElement as HTMLElement | null;
        const ariaControls = active?.getAttribute("aria-controls") || "";
        const listboxes = Array.from(
          document.querySelectorAll<HTMLElement>(".select__menu-list[role='listbox'], [role='listbox'], [id^='react-select-'][id$='-listbox']")
        ).filter((listbox) => visible(listbox));
        let boundListbox: HTMLElement | null = null;
        if (ariaControls) {
          boundListbox = listboxes.find((listbox) => listbox.id === ariaControls) || null;
          if (!boundListbox) return "";
        } else {
          return "";
        }
        const options = boundListbox
          ? Array.from(boundListbox.querySelectorAll<HTMLElement>(".select__option, [role='option']")).filter((option) => visible(option))
          : [];

        if (!options.length) return "";

        const normalizedOptions = options.map((option) => ({
          element: option,
          text: (option.textContent || "").replace(/\s+/g, " ").trim(),
          normalized: normalize(option.textContent || "")
        }));

        const exact = normalizedOptions.find((option) => wanted.some((candidate) => option.normalized === candidate));
        const contains = normalizedOptions.find((option) => wanted.some((candidate) => option.normalized.includes(candidate)));
        const reverse = normalizedOptions.find((option) => wanted.some((candidate) => candidate.includes(option.normalized)));
        const chosen = exact || contains || reverse;
        if (!chosen) return "";
        chosen.element.click();
        return chosen.text;
      }, optionCandidates).catch(() => "");

      return picked;
    };

    const verifySelectedValue = async (expectedCandidates: string[]): Promise<boolean> => {
      const normalizedExpected = expectedCandidates.map((value) => normalizeText(value)).filter(Boolean);
      if (!normalizedExpected.length) return false;
      const verification = await combobox.evaluate((element) => {
        const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
        const shell = element.closest(".select-shell");
        if (!shell) return { selected: "", ariaInvalid: true, requiredError: true };
        const text = normalize(shell.querySelector(".select__single-value, [class*='singleValue' i]")?.textContent || "");
        const ariaInvalid = Boolean(
          (element as HTMLElement).getAttribute("aria-invalid") === "true" ||
          shell.querySelector("[aria-invalid='true']")
        );
        const errorNodes = Array.from(
          shell.querySelectorAll<HTMLElement>(
            ".field-error, .error, .invalid-feedback, [role='alert'], [aria-live='polite'], [aria-live='assertive'], [data-qa*='error' i], [id*='error' i]"
          )
        );
        const requiredError = errorNodes.some((node) => /this field is required/i.test(normalize(node.textContent || "")));
        return { selected: text, ariaInvalid, requiredError };
      }).catch(() => ({ selected: "", ariaInvalid: true, requiredError: true }));
      const normalizedSelected = normalizeText(verification.selected);
      if (!normalizedSelected || isPlaceholderOption(normalizedSelected)) return false;
      if (verification.ariaInvalid || verification.requiredError) return false;
      return normalizedExpected.some((candidate) => normalizedSelected === candidate || normalizedSelected.includes(candidate) || candidate.includes(normalizedSelected));
    };

    for (const candidate of candidates) {
      await page.keyboard.press("Escape").catch(() => undefined);
      await combobox.click({ force: true }).catch(() => undefined);
      await combobox.fill("").catch(() => undefined);
      await combobox.type(candidate, { delay: 12 }).catch(() => undefined);
      const optionsReady = await waitOptions();
      if (!optionsReady) {
        await page.keyboard.press("Escape").catch(() => undefined);
        continue;
      }
      await page.waitForTimeout(180).catch(() => undefined);
      await page.keyboard.press("Enter").catch(() => undefined);
      await page.waitForTimeout(180).catch(() => undefined);
      if (await verifySelectedValue([candidate, ...candidates])) {
        await combobox.press("Tab").catch(() => undefined);
        await combobox.dispatchEvent("blur").catch(() => undefined);
        await page.keyboard.press("Escape").catch(() => undefined);
        return true;
      }
      const picked = await pickVisibleOption([candidate, ...candidates]);
      if (picked && await verifySelectedValue([picked, candidate, ...candidates])) {
        await combobox.press("Tab").catch(() => undefined);
        await combobox.dispatchEvent("blur").catch(() => undefined);
        await page.keyboard.press("Escape").catch(() => undefined);
        return true;
      }
    }

    const firstPicked = await pickVisibleOption(candidates);
    if (firstPicked && await verifySelectedValue([firstPicked, ...candidates])) {
      await combobox.press("Tab").catch(() => undefined);
      await combobox.dispatchEvent("blur").catch(() => undefined);
      await page.keyboard.press("Escape").catch(() => undefined);
      return true;
    }

    return false;
  }

  private async verifyRequiredComboboxSatisfied(
    page: AdapterRunContext["page"],
    field: MissingFieldDetail
  ): Promise<boolean> {
    return page.evaluate(({ id, label }) => {
      let combobox = document.getElementById(id) as HTMLElement | null;
      if (!combobox && label) {
        const labels = Array.from(document.querySelectorAll("label"));
        const wanted = label.replace(/\s+/g, " ").trim().toLowerCase();
        const matched = labels.find((candidate) => {
          const candidateText = (candidate.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
          return candidateText === wanted;
        });
        const forId = matched?.getAttribute("for");
        if (forId) {
          combobox = document.getElementById(forId);
        }
      }

      if (!combobox) {
        const roleMatches = Array.from(document.querySelectorAll<HTMLElement>('[role="combobox"]'));
        const wanted = (label || "").replace(/\s+/g, " ").trim().toLowerCase();
        combobox =
          roleMatches.find((candidate) => {
            const aria = (candidate.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().toLowerCase();
            return wanted.length > 0 && aria === wanted;
          }) ||
          null;
      }

      if (!combobox) return false;
      const shell = combobox.closest(".select-shell");
      if (!shell) return false;

      const selectedValue = (shell.querySelector(".select__single-value, [class*='singleValue' i]")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      const selectedNormalized = selectedValue.toLowerCase();
      if (
        !selectedNormalized ||
        selectedNormalized === "select" ||
        selectedNormalized === "select..." ||
        selectedNormalized === "choose" ||
        selectedNormalized === "choose..."
      ) return false;

      const requiredSentinel = shell.querySelector(
        "input.remix-css-1a0ro4n-requiredInput[required], input[required][aria-hidden='true']"
      ) as HTMLInputElement | null;
      if (requiredSentinel) {
        const sentinelValue = (requiredSentinel.value || "").replace(/\s+/g, " ").trim();
        if (!sentinelValue) return false;
      }

      const invalid = combobox.getAttribute("aria-invalid") === "true";
      return !invalid;
    }, field).catch(() => false);
  }

  private async verifyFieldSatisfied(
    page: AdapterRunContext["page"],
    id: string,
    inputKind: GreenhouseQuestion["inputKind"] | "select",
    expectedValue?: string,
    locatorHint?: {
      id?: string;
      name?: string;
      selector?: string;
      selectorCandidates?: string[];
    }
  ): Promise<boolean> {
    const missing = await this.collectMissingRequiredDetails(page);
    if (missing.some((field) => field.id === id || field.id === (locatorHint?.id ?? "") || field.id === (locatorHint?.name ?? ""))) {
      return false;
    }

    if (inputKind === "select" || inputKind === "combobox") {
      const state = await this.inspectRequiredValidationState(page, {
        id: locatorHint?.id ?? id,
        label: "",
        selector: locatorHint?.selector,
        name: locatorHint?.name
      }).catch(() => null);
      if (state) {
        const currentValue = state.currentValue ?? "";
        const errorText = state.errorText ?? "";
        if (currentValue && (state.ariaInvalid || this.hasRequiredValidationErrorText(errorText))) {
          return false;
        }
        if (expectedValue?.trim()) {
          const normalizedExpected = normalizeText(expectedValue);
          const normalizedCurrent = normalizeText(currentValue);
          if (normalizedCurrent && normalizedExpected && normalizedCurrent !== normalizedExpected && !normalizedCurrent.includes(normalizedExpected)) {
            return false;
          }
        }
      }

      const targetId = locatorHint?.id ?? id;
      const comboboxOk = await this.verifyRequiredComboboxSatisfied(page, { id: targetId, label: "", role: "combobox", tag: "input" });
      if (comboboxOk) {
        if (!expectedValue?.trim()) return true;
        const selectedValue = await page.evaluate((targetIdValue) => {
          const element = document.getElementById(targetIdValue) as HTMLElement | null;
          if (!element) return "";
          const shell = element.closest(".select-shell");
          if (!shell) return "";
          return (
            shell.querySelector(".select__single-value, [class*='singleValue' i]")?.textContent || ""
          ).replace(/\s+/g, " ").trim();
        }, targetId).catch(() => "");
        if (!selectedValue) return false;
        const selectedNormalized = normalizeText(selectedValue);
        const expectedNormalized = normalizeText(expectedValue);
        return selectedNormalized === expectedNormalized || selectedNormalized.includes(expectedNormalized);
      }

      const selectorPool = [
        targetId ? `[id=${JSON.stringify(targetId)}], [name=${JSON.stringify(targetId)}]` : "",
        locatorHint?.selector ?? "",
        ...(locatorHint?.selectorCandidates ?? [])
      ].filter(Boolean);
      const locator = selectorPool.length
        ? page.locator(selectorPool.join(", ")).first()
        : this.locatorById(page, id).first();

      return locator
        .evaluate((element) => {
          const control = element as HTMLInputElement | HTMLSelectElement;
          const tag = control.tagName.toLowerCase();
          const invalid = control.getAttribute("aria-invalid") === "true";
          if (invalid) return false;

          if (tag === "select") {
            const select = control as HTMLSelectElement;
            const value = (select.value || "").trim();
            if (!value) return false;
            const selectedOption = select.selectedOptions[0];
            const selectedLabel = (selectedOption?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
            return !(
              !selectedLabel ||
              selectedLabel === "select" ||
              selectedLabel === "select..." ||
              selectedLabel === "--" ||
              selectedLabel === "-" ||
              selectedLabel === "choose" ||
              selectedLabel === "choose..." ||
              selectedLabel.includes("please select")
            );
          }

          const value = (control.value || "").replace(/\s+/g, " ").trim().toLowerCase();
          return Boolean(value) && value !== "select" && value !== "select...";
        })
        .catch(() => false);
    }

    if (inputKind === "radio-group" || inputKind === "checkbox-group") {
      const selectorPool = [
        locatorHint?.name ? `input[type="${inputKind === "radio-group" ? "radio" : "checkbox"}"][name=${JSON.stringify(locatorHint.name)}]` : "",
        locatorHint?.selector ?? "",
        ...(locatorHint?.selectorCandidates ?? [])
      ].filter(Boolean);
      const locator = selectorPool.length ? page.locator(selectorPool.join(", ")) : this.locatorById(page, id);
      const count = await locator.count().catch(() => 0);
      if (!count) return false;
      const checkedCount = await locator.locator(":checked").count().catch(async () => {
        let checked = 0;
        for (let idx = 0; idx < count; idx += 1) {
          if (await locator.nth(idx).isChecked().catch(() => false)) checked += 1;
        }
        return checked;
      });
      return checkedCount > 0;
    }

    const state = await this.inspectRequiredValidationState(page, {
      id: locatorHint?.id ?? id,
      label: "",
      selector: locatorHint?.selector,
      name: locatorHint?.name
    }).catch(() => null);
    if (state?.ariaInvalid || this.hasRequiredValidationErrorText(state?.errorText || "")) {
      return false;
    }
    const constraints = await this.inspectTextInputConstraints(page, {
      id: locatorHint?.id ?? id,
      name: locatorHint?.name,
      selector: locatorHint?.selector,
      selectorCandidates: locatorHint?.selectorCandidates,
      label: ""
    }).catch(() => null);
    if (constraints) {
      const currentValue = (constraints.currentValue || "").trim();
      if (!currentValue) return false;
      if (!constraints.validityValid) return false;
      if (constraints.validationMessage && this.hasRequiredValidationErrorText(constraints.validationMessage)) return false;
      if (expectedValue?.trim()) {
        const expected = normalizeText(expectedValue);
        const actual = normalizeText(currentValue);
        if (actual && expected && actual !== expected && !actual.includes(expected)) {
          return false;
        }
      }
      return true;
    }
    return this.readInputValue(page, id).then((value) => Boolean(value.trim())).catch(() => false);
  }

  /**
   * Ticks a radio or checkbox that the page may have hidden.
   *
   * Greenhouse renders its choice inputs as a visually hidden input with a
   * styled label on top. Playwright refuses to check something it considers
   * invisible, and both check() and click() then wait the full default timeout
   * before failing -- measured at 120 seconds per field on a live posting,
   * because the caller retries once. The label is the thing a person actually
   * clicks, so try that first, and only then fall back to setting the property
   * directly with the events React listens for.
   */
  private async toggleChoiceInput(
    page: AdapterRunContext["page"],
    target: ReturnType<AdapterRunContext["page"]["locator"]>,
    inputId: string,
    isCheckbox: boolean
  ): Promise<boolean> {
    const isChecked = async (): Promise<boolean> => target.isChecked().catch(() => false);
    if (await isChecked()) return true;

    if (isCheckbox) {
      await target.check({ timeout: 2500 }).catch(() => undefined);
    } else {
      await target.click({ timeout: 2500 }).catch(() => undefined);
    }
    if (await isChecked()) return true;

    if (inputId) {
      const label = page.locator(`label[for=${JSON.stringify(inputId)}]`).first();
      if (await label.count().catch(() => 0)) {
        await label.click({ timeout: 2500 }).catch(() => undefined);
        if (await isChecked()) return true;
      }
    }

    await target.click({ force: true, timeout: 2500 }).catch(() => undefined);
    if (await isChecked()) return true;

    // Last resort: React only believes a change it hears about.
    const applied = await target
      .evaluate((element) => {
        const input = element as HTMLInputElement;
        if (input.checked) return true;
        input.checked = true;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return input.checked;
      })
      .catch(() => false);
    return applied && (await isChecked());
  }

  private async clickRadioOrCheckbox(page: AdapterRunContext["page"], question: GreenhouseQuestion, answer: string): Promise<boolean> {
    const normalized = normalizeText(answer);
    const groupInputType = question.inputKind === "radio-group" ? "radio" : "checkbox";
    const optionMeta = Array.isArray(question.platformMeta?.optionMeta)
      ? (question.platformMeta.optionMeta as Array<{
          id?: string;
          name?: string;
          value?: string;
          label?: string;
          selector?: string;
          checked?: boolean;
        }>)
      : [];
    if (optionMeta.length) {
      const metaLabels = optionMeta.map((entry) => (entry.label || "").trim()).filter(Boolean);
      const picked = pickBestOption(answer, metaLabels);
      const pickedMeta = optionMeta.find((entry) => normalizeText(entry.label || "") === normalizeText(picked))
        ?? optionMeta.find((entry) => normalizeText(`${entry.value || ""} ${entry.label || ""}`).includes(normalized));
      if (pickedMeta) {
        const selector = pickedMeta.selector
          || (pickedMeta.id ? `#${pickedMeta.id}` : "")
          || (pickedMeta.name ? `input[type="${groupInputType}"][name=${JSON.stringify(pickedMeta.name)}][value=${JSON.stringify(pickedMeta.value || "")}]` : "");
        if (selector) {
          const target = page.locator(selector).first();
          if (await target.count().catch(() => 0)) {
            return this.toggleChoiceInput(page, target, pickedMeta.id || "", question.inputKind === "checkbox-group");
          }
        }
      }
    }
    const groupSelector = question.name
      ? `input[type="${groupInputType}"][name=${JSON.stringify(question.name)}]`
      : question.domId
        ? `input[type="${groupInputType}"][name=${JSON.stringify(question.domId)}], input[type="${groupInputType}"][id=${JSON.stringify(question.domId)}]`
        : `input[type="${groupInputType}"][name=${JSON.stringify(question.id)}]`;

    const candidates = page.locator(groupSelector);
    const count = await candidates.count();

    for (let index = 0; index < count; index += 1) {
      const input = candidates.nth(index);
      const value = ((await input.getAttribute("value")) ?? "").trim();

      const labelText = await input.evaluate((element) => {
        const control = element as HTMLInputElement;
        const label = control.closest("label") || (control.id ? document.querySelector(`label[for="${control.id}"]`) : null);
        return (label?.textContent ?? control.value ?? "").trim();
      });

      const hay = `${value} ${labelText}`.toLowerCase();
      if (hay === normalized || hay.includes(normalized) || normalized.includes(value.toLowerCase())) {
        if (question.inputKind === "checkbox-group") {
          const shouldCheck = isTruthyAnswer(answer) || Boolean(question.options?.length);
          if (shouldCheck) {
            await input.check().catch(async () => {
              await input.click();
            });
          }
        } else {
          await input.click();
        }
        return true;
      }
    }

    if (count > 0) {
      const labels: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const labelText = await candidates.nth(index).evaluate((element) => {
          const control = element as HTMLInputElement;
          const label = control.closest("label") || (control.id ? document.querySelector(`label[for="${control.id}"]`) : null);
          return (label?.textContent ?? control.value ?? "").replace(/\s+/g, " ").trim();
        }).catch(() => "");
        labels.push(labelText);
      }

      const pickedLabel = pickBestOption(answer, labels.filter(Boolean));
      const pickedIndex = labels.findIndex((label) => normalizeText(label) === normalizeText(pickedLabel));
      if (pickedIndex >= 0) {
        const picked = candidates.nth(pickedIndex);
        if (question.inputKind === "checkbox-group") {
          await picked.check().catch(async () => {
            await picked.click();
          });
        } else {
          await picked.click();
        }
        return true;
      }
    }

    if (question.inputKind === "checkbox-group" && isTruthyAnswer(answer) && count > 0) {
      await candidates
        .nth(0)
        .check()
        .catch(async () => {
          await candidates.nth(0).click();
        });
      return true;
    }

    return false;
  }

  private upsertFilledField(target: FilledFieldRecord[], next: FilledFieldRecord): void {
    const index = target.findIndex((entry) => entry.id === next.id);
    if (index >= 0) {
      target[index] = next;
      return;
    }
    target.push(next);
  }

  private humanizeId(id: string): string {
    return id
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  private toFilledSource(source: ResolvedAnswer["source"] | undefined): FilledFieldRecord["source"] {
    if (source === "rule") return "rule";
    if (source === "profile") return "profile";
    if (source === "llm") return "llm";
    if (source === "fallback") return "fallback";
    return "manual";
  }
}
