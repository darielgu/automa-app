import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { Frame, Locator, Page } from "playwright-core";
import { BaseAdapter } from "./base.js";
import {
  buildQuestionMap,
  extractVisibleFields,
  fillField,
  indexAnswersByQuestion,
  type DetectedField
} from "../browser/form-helper.js";
import {
  extractCompanyDirectionContextFromText,
  htmlToText
} from "./company-context.js";
import { evaluateDeterministicRule, evaluateProfileMapping } from "../ai/rules.js";
import type { AdapterRunContext, ApplicationQuestion, AshbyConfig, CandidateProfile, JobRunResult, LlmEventRecord, QuestionType, ResolvedAnswer } from "../core/types.js";

const DEFAULT_CONFIRMATION_TEXT_PATTERNS = [
  "application submitted",
  "thanks for applying",
  "thank you for applying",
  "we've received your application",
  "application received",
  "your application has been submitted",
  "application is complete",
  "application complete",
  "we will be in touch",
  "we'll be in touch",
  "thanks, your application",
  "thank you, your application"
];

const DEFAULT_SOFT_COMPLETION_TEXT_PATTERNS = [
  "application submitted",
  "application received",
  "we received your application",
  "your application was received",
  "thanks for applying",
  "thank you for applying",
  "thank you for your application",
  "we'll review your application",
  "we will review your application",
  "your submission has been received",
  "you have successfully applied",
  "applied successfully"
];

const DEFAULT_SUCCESS_URL_PATTERNS = [
  "/submitted",
  "/thanks",
  "/thank-you",
  "/application-submitted",
  "/application_complete",
  "/application-complete"
];

const INACTIVE_POSTING_TEXT_PATTERNS = [
  "job not found",
  "position has been filled",
  "posting not found",
  "no longer accepting applications",
  "this job has expired"
];

const VALIDATION_ERROR_HINTS = [
  "required",
  "please enter",
  "please provide",
  "must be",
  "invalid",
  "error",
  "is missing",
  "can't be blank",
  "cannot be blank"
];

const HARD_BOT_CHALLENGE_TEXT_PATTERNS = [
  "verify you are human",
  "verify you're human",
  "are you human",
  "security check",
  "complete this security check",
  "captcha",
  "hcaptcha",
  "recaptcha",
  "turnstile",
  "robot check",
  "prove you are human",
  "press and hold"
];

const SOFT_BOT_FAILURE_TEXT_PATTERNS = [
  "we couldn't submit your application",
  "flagged as possible spam",
  "submission was flagged as possible spam",
  "your application submission was flagged"
];

const DEFAULT_CHALLENGE_SELECTORS = [
  "iframe[src*='recaptcha']",
  "iframe[src*='hcaptcha']",
  "iframe[src*='turnstile']",
  "iframe[src*='challenges.cloudflare.com']",
  "[data-sitekey]",
  "[id*='captcha']",
  "[class*='captcha']"
];

const DEFAULT_REQUIRED_FIELD_SELECTORS = [
  "[role='alert']",
  "[aria-live='assertive']",
  ".error",
  ".errors",
  ".field-error",
  ".invalid-feedback",
  "[aria-invalid='true']"
];

const DEFAULT_MAX_FILL_PASSES = 1;
const DEFAULT_MAX_SUBMIT_ATTEMPTS = 2;
const DEFAULT_SUBMIT_RETRY_DELAY_MS = 1600;
const DEFAULT_FIELD_DELAY_MIN_MS = 220;
const DEFAULT_FIELD_DELAY_MAX_MS = 640;
const DEFAULT_SUBMIT_DELAY_MIN_MS = 1200;
const DEFAULT_SUBMIT_DELAY_MAX_MS = 2800;
const DEFAULT_SUBMIT_RETRY_JITTER_MIN_MS = 180;
const DEFAULT_SUBMIT_RETRY_JITTER_MAX_MS = 520;
const DEFAULT_FORM_SETTLE_MIN_MS = 650;
const DEFAULT_ACCOMMODATION_FOLLOWUP_TEXT = "N/A";
const DEFAULT_FINAL_TEXT_FALLBACK_VALUE = "N/A";
const DEFAULT_ASHBY_TEXT_COMMIT_MODE = "robust";
const DEFAULT_ASHBY_DATE_FALLBACK_POLICY = "today";
const DEFAULT_ASHBY_UNKNOWN_REQUIRED_TEXT_POLICY = "llm_first_then_terminal_fallback";
const DEFAULT_ASHBY_UNKNOWN_OPTION_PROBE_CHAR = "a";
const DEFAULT_ASHBY_UNKNOWN_OPTION_PROBE_WAIT_MS = 420;
const DEFAULT_ASHBY_UNKNOWN_RESOLUTION_ATTEMPTS = 2;
const US_STATE_ABBREVIATIONS: Record<string, string> = {
  ca: "California",
  ny: "New York",
  tx: "Texas",
  wa: "Washington",
  ma: "Massachusetts",
  il: "Illinois",
  fl: "Florida"
};

type AshbyTextCommitMode = "robust";
type AshbyDateFallbackPolicy = "today";
type AshbyUnknownRequiredTextPolicy = "llm_first_then_terminal_fallback";

type AshbyFieldCapability = "date_like_text" | "typeahead_text" | "plain_text" | "interactive_text";

interface AshbyLocationFillSpec {
  city: string;
  region: string;
  country: string;
  query: string;
  target: string;
}

type AshbyTextPromptIntent =
  | "accommodation_followup"
  | "conditional_followup"
  | "links"
  | "compensation"
  | "notice_start_date"
  | "location_country"
  | "legal_work_auth"
  | "company_understanding"
  | "motivation_fit"
  | "summary_background"
  | "open_ended_narrative"
  | "misc";

interface AshbyTextFallbackResolution {
  value: string | null;
  reason: string;
  intent: AshbyTextPromptIntent;
  deterministicFinal: boolean;
}

interface BotChallengeSignals {
  bodyText: string;
  iframeSources: string[];
  selectorMatches: string[];
}

interface BotChallengeEvidence {
  detected: boolean;
  evidence: string[];
  softSignals: string[];
}

interface SubmitOutcome {
  confirmed: boolean;
  blockedByBot: boolean;
  validationErrors: string[];
  confirmationEvidence?: string;
  challengeEvidence?: string[];
}

interface AshbyPreSubmitGateStatus {
  blockerLabels: string[];
  invalidControls: string[];
  requiredUnresolved: string[];
}

interface AshbyUnknownProbeResult {
  fieldId: string;
  label: string;
  options: string[];
  queryChar: string;
  source: "aria_controls" | "global_option" | "result_container" | "none";
}

interface AshbyPreSubmitGateStatus {
  blockerLabels: string[];
  invalidControls: string[];
  requiredUnresolved: string[];
}

export interface AshbySubmissionClassifierInput {
  strictUrlMatch: boolean;
  strictTextMatch: boolean;
  blockedByBot: boolean;
  activeValidationErrors: string[];
  submitVisible: boolean;
  visibleFormControls: boolean;
  softCompletionTextMatch: string | null;
  noValidationStreak: number;
  secondsSinceSubmit: number;
  strictUrlEvidence?: string;
}

export interface AshbySubmissionClassifierResult {
  outcome: "confirmed" | "blocked_bot_challenge" | "validation_error" | "pending_confirmation";
  confirmationEvidence?: string;
}

export function ashbyClassifySubmissionOutcome(input: AshbySubmissionClassifierInput): AshbySubmissionClassifierResult {
  if (input.strictUrlMatch) {
    return {
      outcome: "confirmed",
      confirmationEvidence: `strict:success_url:${input.strictUrlEvidence ?? "matched"}`
    };
  }

  if (input.strictTextMatch) {
    return {
      outcome: "confirmed",
      confirmationEvidence: "strict:confirmation_text_detected"
    };
  }

  if (input.activeValidationErrors.length > 0) {
    return { outcome: "validation_error" };
  }

  if (input.blockedByBot) {
    return { outcome: "blocked_bot_challenge" };
  }

  const hasStableNoValidation = input.secondsSinceSubmit >= 2 && input.noValidationStreak >= 2;
  const formExited = !input.submitVisible && !input.visibleFormControls;
  const hasSoftCompletionText = typeof input.softCompletionTextMatch === "string" && input.softCompletionTextMatch.length > 0;
  if (hasStableNoValidation && (formExited || hasSoftCompletionText)) {
    const evidence: string[] = [];
    if (formExited) evidence.push("soft:submit_and_form_controls_hidden");
    if (hasSoftCompletionText) evidence.push(`soft:completion_text:${input.softCompletionTextMatch}`);
    return {
      outcome: "confirmed",
      confirmationEvidence: evidence.join("|")
    };
  }

  return { outcome: "pending_confirmation" };
}

export function ashbySampleDelayMs(minMs: number, maxMs: number, randomUnit: number = Math.random()): number {
  const lo = Math.max(0, Math.floor(minMs));
  const hi = Math.max(lo, Math.floor(maxMs));
  const unit = Number.isFinite(randomUnit) ? Math.min(0.999999, Math.max(0, randomUnit)) : 0.5;
  return lo + Math.floor(unit * (hi - lo + 1));
}

export function ashbyComputeRetryCooldownMs(
  baseDelayMs: number,
  jitterMinMs: number = DEFAULT_SUBMIT_RETRY_JITTER_MIN_MS,
  jitterMaxMs: number = DEFAULT_SUBMIT_RETRY_JITTER_MAX_MS,
  randomUnit: number = Math.random()
): number {
  const base = Math.max(0, Math.floor(baseDelayMs));
  const jitter = ashbySampleDelayMs(jitterMinMs, jitterMaxMs, randomUnit);
  return base + jitter;
}

type AshbyInteractionScope = Page | Frame;

interface AshbyRecoveryTarget {
  label: string;
  field?: DetectedField;
  identity: string;
}

interface AshbyRecoveryOptions {
  validatedGood?: Map<string, string>;
  failingLabels?: string[];
}

interface MissingFieldDescriptor {
  label: string;
  identity?: string;
}

type AshbyDomFieldType =
  | "text"
  | "textarea"
  | "file"
  | "combobox"
  | "radio"
  | "checkbox_group"
  | "yes_no"
  | "date"
  | "unknown";

interface AshbyFailedFieldRecoverySchema {
  fieldPath: string;
  containerIdentity?: string;
  anchorStrategy?: "error_node_ancestor" | "aria_describedby" | "label_fuzzy_fallback";
  label: string;
  required: boolean;
  fieldType: AshbyDomFieldType;
  possibleAnswers: string[];
  currentValue: string | string[] | null;
  validationError: string;
  errorText?: string;
  previousAttempt: {
    answer: string | null;
    selectedOptions: string[];
    failureReason: string;
  };
  htmlSummary: string;
  containerHtmlSnippet?: string;
}

interface AshbySingleFieldRecoveryAnswer {
  fieldPath: string;
  fieldType: string;
  answer: string | boolean | null;
  selectedOptions: string[];
  comboboxQuery: string;
  comboboxTargetOption: string;
  reason: string;
}

interface AshbyContainerSelectionState {
  selectedLabels: string[];
  checkedCount: number;
}

export type AshbyControlKind =
  | "url"
  | "email"
  | "text"
  | "number"
  | "textarea"
  | "radio"
  | "yes_no_button"
  | "choice_group"
  | "combobox"
  | "file";

export interface AshbyControlState {
  kind: AshbyControlKind;
  value?: string;
  checkedCount?: number;
  selected?: boolean;
  selectedCount?: number;
  selectedLabels?: string[];
  fileCount?: number;
  hasFileChip?: boolean;
  hasFileNameCue?: boolean;
}

const DEFAULT_ASHBY_RELOCATION_HINTS = [
  "open to relocating anywhere",
  "open to relocation",
  "willing to relocate",
  "relocation preference",
  "location preference"
];

function normalizeOptionToken(value: string): string {
  return normalizeWhitespace(String(value || "")).toLowerCase();
}

function stringifyBooleanish(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
  const normalized = normalizeOptionToken(String(value ?? ""));
  if (["true", "yes", "y", "1", "open", "anywhere"].includes(normalized)) return true;
  if (["false", "no", "n", "0"].includes(normalized)) return false;
  return null;
}

export function ashbyBuildGroupIdentity(
  fieldPath: string | undefined,
  groupName: string | undefined,
  options: string[] | undefined
): string {
  const normalizedFieldPath = normalizeOptionToken(fieldPath ?? "") || "no_field_path";
  const normalizedGroupName = normalizeOptionToken(groupName ?? "") || "no_group_name";
  const normalizedOptions = (options ?? [])
    .map((option) => normalizeOptionToken(option))
    .filter(Boolean)
    .sort()
    .join("|") || "no_options";
  return `group:${normalizedFieldPath}::${normalizedGroupName}::${normalizedOptions}`;
}

export function ashbyClassifyCheckboxControl(input: {
  label: string;
  checkboxCount: number;
  optionLabels: string[];
  buttonOptionCount: number;
}): "boolean" | "single_select" | "multi_select" {
  const normalizedLabel = normalizeOptionToken(input.label);
  const normalizedOptions = Array.from(
    new Set(input.optionLabels.map((option) => normalizeOptionToken(option)).filter(Boolean))
  );
  const optionCount = normalizedOptions.length;
  if (input.checkboxCount <= 0) return "boolean";

  const multiHints = /(select all|all that apply|check all|multiple|any that apply)/i.test(normalizedLabel);
  if (multiHints) return "multi_select";
  const yesNoLikeCount = normalizedOptions.filter((option) =>
    /^(yes|no|true|false)\b/.test(option) || /\bn\/a\b|not applicable|remote position/.test(option)
  ).length;
  const questionIntentSingleChoice =
    /\b(authorized to work|work authorization|legally authorized|sponsorship|visa|internship|full-time|part-time|how did you hear|currently based|country)\b/.test(
      normalizedLabel
    );
  const countryOptionCount = normalizedOptions.filter((option) =>
    /\b(united states|usa|us|canada|singapore|india|united kingdom|uk|germany|australia)\b/.test(option)
  ).length;
  const mutuallyExclusiveOptions = yesNoLikeCount >= 2 || (countryOptionCount >= 1 && yesNoLikeCount >= 1);

  if (input.checkboxCount > 1) {
    if (input.buttonOptionCount > 1) return "single_select";
    if (questionIntentSingleChoice || mutuallyExclusiveOptions) return "single_select";
    return "multi_select";
  }
  if (optionCount > 1 || input.buttonOptionCount > 1) return "single_select";
  return "boolean";
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function ashbyIsAnsweredControl(state: AshbyControlState): boolean {
  switch (state.kind) {
    case "url":
    case "email":
    case "text":
    case "number":
    case "textarea":
      return String(state.value ?? "").trim().length > 0;
    case "radio":
      return Number(state.checkedCount ?? 0) > 0;
    case "yes_no_button":
      return state.selected === true || Number(state.checkedCount ?? 0) > 0;
    case "choice_group":
      return Number(state.selectedCount ?? 0) > 0 || Number(state.checkedCount ?? 0) > 0 || state.selected === true;
    case "combobox":
      return String(state.value ?? "").trim().length > 0 || Number(state.selectedCount ?? 0) > 0;
    case "file":
      return state.hasFileChip === true || state.hasFileNameCue === true;
    default:
      return false;
  }
}

export function ashbyMatchesAnyPattern(text: string, patterns: string[]): boolean {
  const normalized = text.toLowerCase();
  return patterns.some((pattern) => {
    const candidate = pattern.trim();
    if (!candidate) return false;
    try {
      return new RegExp(candidate, "i").test(text);
    } catch {
      return normalized.includes(candidate.toLowerCase());
    }
  });
}

export function ashbyUrlMatchesSuccess(url: string, patterns: string[] = DEFAULT_SUCCESS_URL_PATTERNS): boolean {
  const normalizedUrl = url.toLowerCase();
  return patterns.some((pattern) => normalizedUrl.includes(pattern.toLowerCase()));
}

export function ashbyHasConfirmationText(
  text: string,
  patterns: string[] = DEFAULT_CONFIRMATION_TEXT_PATTERNS
): boolean {
  return ashbyMatchesAnyPattern(text, patterns);
}

export function ashbyExtractValidationErrors(
  texts: string[],
  confirmationPatterns: string[] = DEFAULT_CONFIRMATION_TEXT_PATTERNS
): string[] {
  const splitCandidates = texts.flatMap((value) =>
    String(value)
      .split(/\n+/)
      .flatMap((line) =>
        line
          .split(
            /(?=Missing entry for required field:)|(?=Please enter)|(?=Please provide)|(?=Invalid)|(?=Error:)/gi
          )
          .map((part) => part.trim())
      )
  );

  const normalizedErrors = splitCandidates
    .map((value) => normalizeWhitespace(value))
    .filter(Boolean)
    .filter((value) => !ashbyHasConfirmationText(value, confirmationPatterns))
    .filter((value) => {
      const lowered = value.toLowerCase();
      return VALIDATION_ERROR_HINTS.some((token) => lowered.includes(token));
    })
    .slice(0, 8);
  return [...new Set(normalizedErrors)];
}

export function ashbyCollectBotChallengeEvidence(
  bodyText: string,
  iframeSources: string[],
  selectorMatches: string[] = [],
  scriptSources: string[] = []
): string[] {
  const evidence: string[] = [];
  const loweredText = bodyText.toLowerCase();

  const textMatch = HARD_BOT_CHALLENGE_TEXT_PATTERNS.find((pattern) => loweredText.includes(pattern));
  if (textMatch) {
    evidence.push(`hard_text:${textMatch}`);
  }

  const normalizedFrames = iframeSources.map((value) => value.toLowerCase());
  const iframeMatch = normalizedFrames.find(
    (src) =>
      src.includes("recaptcha") ||
      src.includes("hcaptcha") ||
      src.includes("captcha") ||
      src.includes("turnstile") ||
      src.includes("cf-chl") ||
      src.includes("/challenge")
  );
  if (iframeMatch) {
    evidence.push(`iframe:${iframeMatch.slice(0, 120)}`);
  }

  void scriptSources;

  if (selectorMatches.length > 0) {
    evidence.push(...selectorMatches.map((item) => `selector:${item}`));
  }

  return [...new Set(evidence)];
}

export function ashbyHasBotChallengeIndicators(
  bodyText: string,
  iframeSources: string[],
  selectorMatches: string[] = [],
  scriptSources: string[] = []
): boolean {
  return ashbyCollectBotChallengeEvidence(bodyText, iframeSources, selectorMatches, scriptSources).length > 0;
}

export class AshbyAdapter extends BaseAdapter {
  readonly platform = "ashby" as const;

  canHandle(url: string): boolean {
    return url.toLowerCase().includes("ashbyhq.com");
  }

  private buildFixtureCaptureDir(company: string | undefined, url: string): string {
    const safe = (value: string) => this.normalize(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "unknown";
    const companyToken = safe(company || this.inferCompanyFromAshbyUrl(url) || "unknown_company");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path.resolve(process.cwd(), ".playwright-mcp", "ashby-fixtures", companyToken, stamp);
  }

  private async captureFixtureSnapshot(
    page: AdapterRunContext["page"],
    dir: string,
    phase: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    try {
      mkdirSync(dir, { recursive: true });
      const html = await page.content().catch(() => "");
      const shotPath = path.join(dir, `${phase}.png`);
      const htmlPath = path.join(dir, `${phase}.html`);
      const metaPath = path.join(dir, `${phase}.json`);
      writeFileSync(htmlPath, html || "", "utf8");
      writeFileSync(metaPath, JSON.stringify({ phase, capturedAt: new Date().toISOString(), ...metadata }, null, 2), "utf8");
      await page.screenshot({ path: shotPath, fullPage: true }).catch(() => undefined);
    } catch {
      // Local fixture capture is best-effort and must never affect apply flow.
    }
  }

  async apply(context: AdapterRunContext) {
    const { page, target, config, logger } = context;
    const ashbyConfig = config.ashby ?? {};
    const result = this.baseResult(context);
    result.startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    const logPhase = (phase: string, data?: Record<string, unknown>) =>
      logger.info("ashby_phase", {
        url: target.url,
        phase,
        elapsedMs: Date.now() - startedAtMs,
        ...(data ?? {})
      });

    const confirmationPatterns = ashbyConfig.confirmationTextPatterns?.length
      ? ashbyConfig.confirmationTextPatterns
      : DEFAULT_CONFIRMATION_TEXT_PATTERNS;
    const successUrlPatterns = ashbyConfig.successUrlPatterns?.length
      ? ashbyConfig.successUrlPatterns
      : DEFAULT_SUCCESS_URL_PATTERNS;
    const requestedFillPasses = Math.max(1, ashbyConfig.maxFillPasses ?? DEFAULT_MAX_FILL_PASSES);
    const maxFillPasses = 1;
    const maxSubmitAttempts = Math.max(1, ashbyConfig.maxSubmitAttempts ?? DEFAULT_MAX_SUBMIT_ATTEMPTS);
    const locationOneShotExtraRetry = ashbyConfig.locationOneShotExtraRetry ?? true;
    const submitRetryDelayMs = Math.max(200, ashbyConfig.submitRetryDelayMs ?? DEFAULT_SUBMIT_RETRY_DELAY_MS);
    const lowConfidencePolicy = ashbyConfig.lowConfidencePolicy ?? "submit_with_warning";
    const gateMode = ashbyConfig.preSubmitGateMode ?? "hard_block";
    const maxReadinessAttempts = Math.max(1, ashbyConfig.maxReadinessAttempts ?? 3);
    let submitAttemptsUsed = 0;
    const recoveredFieldPaths = new Set<string>();
    const unresolvedAfterRecoveryPaths = new Set<string>();
    const requiredDeterministicOnly = ashbyConfig.requiredDeterministicOnly ?? config.mode === "auto-submit";
    const minSubmitDelayMs = Math.max(250, ashbyConfig.minSubmitDelayMs ?? DEFAULT_SUBMIT_DELAY_MIN_MS);
    const maxSubmitDelayMs = Math.max(minSubmitDelayMs, ashbyConfig.maxSubmitDelayMs ?? DEFAULT_SUBMIT_DELAY_MAX_MS);
    const minFieldDelayMs = Math.max(0, ashbyConfig.minFieldDelayMs ?? DEFAULT_FIELD_DELAY_MIN_MS);
    const maxFieldDelayMs = Math.max(minFieldDelayMs, ashbyConfig.maxFieldDelayMs ?? DEFAULT_FIELD_DELAY_MAX_MS);
    const formSettleMinMs = DEFAULT_FORM_SETTLE_MIN_MS;
    const fixtureCaptureEnabled = process.env.ASHBY_FIXTURE_CAPTURE === "1";
    const fixtureCaptureDir = this.buildFixtureCaptureDir(result.company, target.url);
    let lastFieldInteractionAtMs = Date.now();
    result.gateMode = gateMode;
    result.readinessGatePassed = false;
    result.requiredUnresolvedBeforeSubmit = [];
    result.requiredUnresolvedAfterRecovery = [];
    result.locationCommitVerified = false;
    result.unknownFieldsSeen = [];
    result.unknownFieldsResolved = [];
    result.unknownFieldsUnresolved = [];
    result.gateMode = gateMode;
    result.readinessGatePassed = false;
    result.requiredUnresolvedBeforeSubmit = [];
    result.requiredUnresolvedAfterRecovery = [];
    result.locationCommitVerified = false;
    result.notes.push(
      `timing_profile:field_delay=${minFieldDelayMs}-${maxFieldDelayMs}:submit_delay=${minSubmitDelayMs}-${maxSubmitDelayMs}:retry_base=${submitRetryDelayMs}:retry_jitter=${DEFAULT_SUBMIT_RETRY_JITTER_MIN_MS}-${DEFAULT_SUBMIT_RETRY_JITTER_MAX_MS}:form_settle_min=${formSettleMinMs}`
    );
    if (requestedFillPasses > 1) {
      result.notes.push(`ashby_one_shot_enforced:maxFillPasses=${requestedFillPasses}->1`);
    }

    try {
      logPhase("goto_start", { timeoutMs: config.timeoutMs });
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });
      await page.waitForTimeout(1000);
      logPhase("goto_done", { finalUrl: page.url() });
      if (fixtureCaptureEnabled) {
        await this.captureFixtureSnapshot(page, fixtureCaptureDir, "post_load", {
          url: page.url(),
          jobTitle: result.jobTitle ?? "",
          company: result.company ?? ""
        });
      }

      if (await this.isInactivePosting(page)) {
        logPhase("inactive_posting");
        result.status = "skipped";
        result.submitOutcome = "inactive_posting";
        result.notes.push("Inactive Ashby posting detected.");
        return result;
      }

      result.jobTitle = result.jobTitle ?? (await this.extractAshbyJobTitle(page)) ?? target.jobTitle;
      result.company = result.company ?? this.inferCompanyFromAshbyUrl(target.url) ?? target.company;
      const postingLocation = await this.extractAshbyPostingLocation(page);
      if (postingLocation) {
        result.notes.push(`posting_location_hint:${postingLocation}`);
      }
      logPhase("context_extract_start");
      const companyContext = await this.buildCompanyContextFromOverview(page, result.company);
      logPhase("context_extract_done", {
        jobTitle: result.jobTitle ?? null,
        company: result.company ?? null,
        hasCompanyContext: Boolean(companyContext)
      });
      result.notes.push(`company_context:${companyContext ? "present" : "absent"}`);
      logPhase("enter_apply_flow_start");
      await this.enterApplyFlow(page);
      logPhase("enter_apply_flow_done", { landingUrl: page.url() });
      const scope = await this.resolveInteractionScope(page);
      logPhase("scope_normalized", {
        scope: scope === page ? "page" : "frame",
        scopeUrl: scope.url()
      });

      let unresolvedRequired: string[] = [];
      let latestAnswers: ResolvedAnswer[] = [];
      let previousUnresolvedSignature = "";

      for (let pass = 1; pass <= maxFillPasses; pass += 1) {
        logPhase("fill_pass_start", { pass, maxFillPasses });
        const passResult = await this.runFillPass(
          context,
          scope,
          ashbyConfig,
          result,
          pass,
          confirmationPatterns,
          companyContext,
          postingLocation,
          requiredDeterministicOnly
        );
        latestAnswers = passResult.answers;
        unresolvedRequired = passResult.unresolved;

        result.notes.push(
          `fill_pass:${pass}/${maxFillPasses} fields=${passResult.fieldCount} filled=${passResult.filledCount} unresolved=${unresolvedRequired.length}`
        );
        logPhase("fill_pass_done", {
          pass,
          fieldCount: passResult.fieldCount,
          filledCount: passResult.filledCount,
          unresolvedCount: unresolvedRequired.length
        });

        if (config.mode === "auto-submit" && pass === 1 && passResult.fieldCount === 0) {
          result.status = "filled";
          result.submitOutcome = "submit_unavailable";
          result.notes.push("submit_reason:submit_unavailable_no_visible_fields");
          return result;
        }

        if (unresolvedRequired.length === 0) break;

        const signature = unresolvedRequired.map((value) => value.toLowerCase()).sort().join("||");
        if (signature && signature === previousUnresolvedSignature) {
          result.notes.push("fill_pass:stable_unresolved_required");
          break;
        }

        previousUnresolvedSignature = signature;
        await page.waitForTimeout(350);
      }

      result.answers = latestAnswers;
      result.status = "filled";
      result.submitOutcome = "not_submitted";

      if (config.mode !== "auto-submit") {
        logPhase("mode_dry_or_fill_only_exit");
        return result;
      }
      if (!this.hasCdpConfigured(config)) {
        result.notes.push("submit_degraded:cdp_not_configured");
      }
      result.notes.push("submit_policy:one_shot");
      void lowConfidencePolicy;
      if (unresolvedRequired.length > 0 && lowConfidencePolicy === "submit_with_warning") {
        result.notes.push("submit_warning:low_confidence_unresolved_required");
      }

      logPhase("required_reconcile_start");
      await this.reconcileRequiredAshbySections(
        context,
        scope,
        result,
        maxFillPasses + 1,
        companyContext,
        postingLocation
      );
      logPhase("required_reconcile_done");

      if (unresolvedRequired.length > 0) {
        result.notes.push(`pre_submit_unresolved_required:${unresolvedRequired.join(" | ")}`);
      }
      if (fixtureCaptureEnabled) {
        await this.captureFixtureSnapshot(page, fixtureCaptureDir, "pre_submit", {
          unresolvedRequired
        });
      }

      const preSubmitChallenge = await this.detectBotChallenge(scope, ashbyConfig.challengeSelectors);
      if (preSubmitChallenge.softSignals.length > 0) {
        result.notes.push(`spam_soft_signals:${preSubmitChallenge.softSignals.join(" | ")}`);
      }
      if (preSubmitChallenge.detected) {
        logPhase("pre_submit_challenge_detected", { evidenceCount: preSubmitChallenge.evidence.length });
        result.submitOutcome = "challenge_detected";
        result.notes.push("submit_reason:challenge_detected_pre_submit");
        result.notes.push(`challenge_evidence:${preSubmitChallenge.evidence.join(" | ")}`);
        await this.captureChallengeEvidence(page, result, config, "pre-submit");
        return result;
      }

      const validatedGoodByIdentity = new Map<string, string>();
      let readiness = await this.evaluatePreSubmitGate(
        scope,
        ashbyConfig,
        confirmationPatterns,
        unresolvedRequired
      );
      result.requiredUnresolvedBeforeSubmit = readiness.requiredUnresolved;

      for (let readinessAttempt = 1; readinessAttempt <= maxReadinessAttempts; readinessAttempt += 1) {
        if (readiness.blockerLabels.length === 0) break;
        logger.info("readiness_gate_failed", {
          platform: "ashby",
          attempt: readinessAttempt,
          required_unresolved: readiness.requiredUnresolved,
          invalid_controls: readiness.invalidControls
        });
        result.notes.push(
          `readiness_gate_failed:${readinessAttempt}:blocked=${readiness.blockerLabels.join(" | ")}`
        );

        if (readinessAttempt >= maxReadinessAttempts) break;

        await this.reconcileRequiredAshbySections(
          context,
          scope,
          result,
          maxFillPasses + maxSubmitAttempts + readinessAttempt + 500,
          companyContext,
          postingLocation
        );
        await this.stabilizeCriticalRequiredFields(
          context,
          scope,
          ashbyConfig,
          result,
          maxFillPasses + maxSubmitAttempts + readinessAttempt + 1500,
          companyContext,
          postingLocation,
          validatedGoodByIdentity
        );
        const recovery = await this.fillMissingFieldsByLabel(
          context,
          scope,
          ashbyConfig,
          readiness.blockerLabels,
          result,
          maxFillPasses + maxSubmitAttempts + readinessAttempt + 800,
          companyContext,
          postingLocation,
          {
            validatedGood: validatedGoodByIdentity,
            failingLabels: readiness.blockerLabels
          }
        );
        recovery.recoveredLabels.forEach((label) => recoveredFieldPaths.add(label));
        recovery.remainingLabels.forEach((label) => unresolvedAfterRecoveryPaths.add(label));
        lastFieldInteractionAtMs = Date.now();
        readiness = await this.evaluatePreSubmitGate(
          scope,
          ashbyConfig,
          confirmationPatterns,
          recovery.remainingLabels
        );
      }

      result.requiredUnresolvedAfterRecovery = readiness.requiredUnresolved;
      result.readinessGatePassed = readiness.blockerLabels.length === 0;
      if (!result.readinessGatePassed) {
        for (const label of readiness.blockerLabels) this.markUnknownFieldUnresolved(result, label);
        result.notes.push(`pre_submit_unresolved_required:${readiness.blockerLabels.join(" | ")}`);
        if (gateMode === "hard_block") {
          result.status = "failed";
          result.submitOutcome = "blocked_pre_submit_unresolved_required";
          result.submitted = false;
          result.submissionConfirmed = false;
          result.error = `blocked_pre_submit_unresolved_required:${readiness.blockerLabels.join(" | ")}`;
          return result;
        }
        result.notes.push("submit_warning:pre_submit_gate_failed_soft_override");
      }

      let sawSubmitClick = false;
      let pendingConfirmation = false;
      let locationGraceAttemptUsed = false;

      for (let attempt = 1; attempt <= maxSubmitAttempts + (locationOneShotExtraRetry ? 1 : 0); attempt += 1) {
        const isGraceAttempt = attempt > maxSubmitAttempts;
        if (isGraceAttempt && !locationGraceAttemptUsed) break;
        submitAttemptsUsed = attempt;
        logPhase("submit_attempt_start", { attempt, maxSubmitAttempts });
        result.notes.push(
          `submit_attempt:${attempt}/${maxSubmitAttempts}${isGraceAttempt ? ":location_grace" : ""}`
        );
        await this.reconcileRequiredAshbySections(
          context,
          scope,
          result,
          maxFillPasses + attempt + 1,
          companyContext,
          postingLocation
        );
        await this.stabilizeCriticalRequiredFields(
          context,
          scope,
          ashbyConfig,
          result,
          maxFillPasses + attempt + 1000,
          companyContext,
          postingLocation,
          validatedGoodByIdentity
        );
        lastFieldInteractionAtMs = Date.now();

        let attemptGate = await this.evaluatePreSubmitGate(
          scope,
          ashbyConfig,
          confirmationPatterns
        );
        if (attemptGate.blockerLabels.length > 0) {
          logPhase("submit_attempt_unresolved_required", {
            attempt,
            unresolvedCount: attemptGate.blockerLabels.length
          });
          const recovery = await this.fillMissingFieldsByLabel(
            context,
            scope,
            ashbyConfig,
            attemptGate.blockerLabels,
            result,
            maxFillPasses + attempt + 100,
            companyContext,
            postingLocation,
            {
              validatedGood: validatedGoodByIdentity,
              failingLabels: attemptGate.blockerLabels
            }
          );
          result.notes.push(
            `submit_unresolved_recovery:${attempt}/${maxSubmitAttempts}:targets=${attemptGate.blockerLabels.length}:filled=${recovery.filledCount}:remaining=${recovery.remainingLabels.length}`
          );
          recovery.recoveredLabels.forEach((label) => recoveredFieldPaths.add(label));
          recovery.remainingLabels.forEach((label) => unresolvedAfterRecoveryPaths.add(label));
          if (recovery.remainingLabels.length > 0) {
            result.notes.push(`attempted_skipped_required:${recovery.remainingLabels.join(" | ")}`);
          }
          lastFieldInteractionAtMs = Date.now();
          attemptGate = await this.evaluatePreSubmitGate(
            scope,
            ashbyConfig,
            confirmationPatterns,
            recovery.remainingLabels
          );
        }
        if (attemptGate.blockerLabels.length > 0) {
          for (const label of attemptGate.blockerLabels) this.markUnknownFieldUnresolved(result, label);
          logger.info("readiness_gate_failed", {
            platform: "ashby",
            attempt,
            required_unresolved: attemptGate.requiredUnresolved,
            invalid_controls: attemptGate.invalidControls
          });
          result.requiredUnresolvedAfterRecovery = attemptGate.requiredUnresolved;
          result.readinessGatePassed = false;
          result.notes.push(`pre_submit_unresolved_required_attempt:${attempt}:${attemptGate.blockerLabels.join(" | ")}`);
          if (gateMode === "hard_block") {
            result.status = "failed";
            result.submitOutcome = "blocked_pre_submit_unresolved_required";
            result.submitted = false;
            result.submissionConfirmed = false;
            result.error = `blocked_pre_submit_unresolved_required:${attemptGate.blockerLabels.join(" | ")}`;
            return result;
          }
          result.notes.push("submit_warning:attempt_gate_failed_soft_override");
        } else {
          result.readinessGatePassed = true;
          result.requiredUnresolvedAfterRecovery = [];
        }

        const challengeSignals = await this.detectBotChallenge(scope, ashbyConfig.challengeSelectors);
        if (challengeSignals.softSignals.length > 0) {
          result.notes.push(`spam_soft_signals:${challengeSignals.softSignals.join(" | ")}`);
        }
        if (challengeSignals.detected) {
          result.submitOutcome = "challenge_detected";
          result.notes.push("submit_reason:challenge_detected_pre_submit");
          result.notes.push(`challenge_evidence:${challengeSignals.evidence.join(" | ")}`);
          await this.captureChallengeEvidence(page, result, config, `submit-attempt-${attempt}-pre`);
          return result;
        }

        const submit = await this.findSubmitButton(scope);
        if (!submit) {
          logPhase("submit_button_missing");
          result.submitOutcome = "submit_failed";
          result.notes.push("submit_reason:submit_button_unavailable");
          return result;
        }

        const sinceLastInteractionMs = Date.now() - lastFieldInteractionAtMs;
        const settleWaitMs = Math.max(0, formSettleMinMs - sinceLastInteractionMs);
        if (settleWaitMs > 0) {
          result.notes.push(`submit_form_settle_wait_ms:${attempt}:${settleWaitMs}`);
          await page.waitForTimeout(settleWaitMs);
        }
        const submitPauseMs = await this.humanPause(page, minSubmitDelayMs, maxSubmitDelayMs);
        result.notes.push(`submit_pause_ms:${attempt}:${submitPauseMs}`);
        await submit.click();
        logPhase("submit_click_done", { attempt });
        sawSubmitClick = true;

        const submission = await this.waitForSubmissionOutcome(
          page,
          scope,
          ashbyConfig,
          confirmationPatterns,
          successUrlPatterns
        );

        if (submission.confirmed) {
          logPhase("submit_confirmed", { attempt });
          result.submitted = true;
          result.submissionConfirmed = true;
          result.submitOutcome = "submitted";
          result.status = "applied";
          result.notes.push("submit_reason:confirmed");
          result.notes.push(`submit_confirmation:${submission.confirmationEvidence ?? "strict:confirmation_marker_detected"}`);
          return result;
        }

        if (submission.blockedByBot) {
          logPhase("submit_blocked_bot", { attempt });
          result.submitOutcome = "challenge_detected";
          result.notes.push("submit_reason:challenge_detected_post_submit");
          if (submission.challengeEvidence?.length) {
            result.notes.push(`challenge_evidence:${submission.challengeEvidence.join(" | ")}`);
          }
          await this.captureChallengeEvidence(page, result, config, `submit-attempt-${attempt}-post`);
          return result;
        }

        if (submission.validationErrors.length > 0) {
          logPhase("submit_validation_errors", {
            attempt,
            validationCount: submission.validationErrors.length
          });
          const validationLabels = this.parseMissingRequiredFieldLabels(submission.validationErrors);
          const failingLabels = validationLabels.length > 0 ? validationLabels : submission.validationErrors;
          result.notes.push(`validation_error_field_paths:${failingLabels.join(" | ")}`);
          if (fixtureCaptureEnabled) {
            await this.captureFixtureSnapshot(page, fixtureCaptureDir, `post_validation_error_attempt_${attempt}`, {
              validationErrors: submission.validationErrors,
              failingLabels
            });
          }
          const beforeDiff = await this.captureAttemptFieldSnapshot(scope, failingLabels);
          if (attempt < maxSubmitAttempts || (attempt === maxSubmitAttempts && locationOneShotExtraRetry && !locationGraceAttemptUsed)) {
            const recovery = await this.recoverValidationErrorsWithDomReExtraction(
              context,
              scope,
              ashbyConfig,
              submission.validationErrors,
              result,
              maxFillPasses + attempt + 10,
              companyContext,
              postingLocation
            );
            const afterDiff = await this.captureAttemptFieldSnapshot(scope, failingLabels);
            result.notes.push(`attempt_1_vs_attempt_2_diff:${this.diffSnapshots(beforeDiff, afterDiff)}`);
            result.notes.push(
              `submit_validation_recovery:${attempt}/${maxSubmitAttempts}:targets=${failingLabels.length}:filled=${recovery.recoveredLabels.length}:remaining=${recovery.remainingLabels.length}`
            );
            recovery.recoveredLabels.forEach((label) => recoveredFieldPaths.add(label));
            recovery.remainingLabels.forEach((label) => unresolvedAfterRecoveryPaths.add(label));
            if (attempt === maxSubmitAttempts && locationOneShotExtraRetry && !locationGraceAttemptUsed) {
              locationGraceAttemptUsed = true;
            }
            const retryCooldownMs = ashbyComputeRetryCooldownMs(submitRetryDelayMs);
            result.notes.push(`submit_retry_cooldown_ms:${attempt}:${retryCooldownMs}`);
            await page.waitForTimeout(retryCooldownMs);
            continue;
          }

          result.submitOutcome = "submit_validation_error";
          result.notes.push("submit_reason:validation_errors_one_shot_no_refill");
          result.notes.push(`validation_errors:${submission.validationErrors.join(" | ")}`);
          return result;
        }

        pendingConfirmation = true;
        if (attempt < maxSubmitAttempts) {
          const retryCooldownMs = ashbyComputeRetryCooldownMs(submitRetryDelayMs);
          result.notes.push(`submit_retry_cooldown_ms:${attempt}:${retryCooldownMs}`);
          await page.waitForTimeout(retryCooldownMs);
        }
      }

      result.submitted = sawSubmitClick;
      result.status = "filled";
      result.submitOutcome = pendingConfirmation ? "submit_failed" : "submit_failed";
      result.notes.push(
        pendingConfirmation ? "submit_reason:confirmation_not_detected" : "submit_reason:submit_failed"
      );
      result.notes.push(`submit_attempts:${maxSubmitAttempts}`);
    } catch (error) {
      logPhase("apply_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      result.status = "failed";
      result.error = error instanceof Error ? error.stack ?? error.message : String(error);
      result.submitOutcome = "submit_failed";
    } finally {
      result.notes.push(
        `submit_attempt_summary:attempts=${submitAttemptsUsed}:recovered=${Array.from(recoveredFieldPaths).join(" | ") || "none"}:unresolved_after_recovery=${Array.from(unresolvedAfterRecoveryPaths).join(" | ") || "none"}:final_outcome=${result.submitOutcome ?? "unknown"}`
      );
      result.notes.push("run_finalized:apply_finalized");
      this.syncCanonicalAnswersFromFilledFields(result);
      const screenshotPath = path.join(config.screenshotsDir, `ashby-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      result.screenshotPaths.push(screenshotPath);
      result.finishedAt = new Date().toISOString();
      logPhase("apply_finalized", {
        status: result.status,
        submitOutcome: result.submitOutcome ?? null
      });
    }

    return result;
  }

  private async runFillPass(
    context: AdapterRunContext,
    scope: AshbyInteractionScope,
    ashbyConfig: AshbyConfig,
    result: JobRunResult,
    pass: number,
    confirmationPatterns: string[],
    companyContext?: string,
    postingLocation?: string,
    requiredDeterministicOnly: boolean = false
  ): Promise<{ answers: ResolvedAnswer[]; unresolved: string[]; fieldCount: number; filledCount: number }> {
    context.logger.info("ashby_phase", {
      url: result.url,
      phase: "fill_pass_extract_start"
    });
    const fields = await this.extractVisibleFieldsSafely(scope, context.logger, result.url, ashbyConfig);
    await this.enrichUnknownFieldsWithLiveOptions(
      context,
      scope,
      fields,
      result,
      "fill_pass",
      context.profile,
      postingLocation,
      ashbyConfig
    );
    context.logger.info("ashby_phase", {
      url: result.url,
      phase: "fill_pass_extract_done",
      fieldCount: fields.length
    });
    const byId = new Map<string, ResolvedAnswer>();
    const allResolvedAnswersById = new Map<string, ResolvedAnswer>();
    const unknownFieldIds = new Set<string>();
    const unknownFieldLabels = new Map<string, string>();
    const resolvedResumePath = this.resolvePreferredResumePath(context.profile, context.config.resumePath, ashbyConfig);
    if (resolvedResumePath) {
      result.notes.push(`resume_path_resolved:${resolvedResumePath}`);
    }
    let filledCount = 0;
    const satisfiedRequiredFieldIds = new Set<string>();
    const minFieldDelayMs = Math.max(0, ashbyConfig.minFieldDelayMs ?? DEFAULT_FIELD_DELAY_MIN_MS);
    const maxFieldDelayMs = Math.max(minFieldDelayMs, ashbyConfig.maxFieldDelayMs ?? DEFAULT_FIELD_DELAY_MAX_MS);
    const phaseBFields: DetectedField[] = [];
    const pendingForLlmFields: DetectedField[] = [];

    // Phase A: deterministic/profile/seeded execution and verification first.
    for (const field of fields) {
      const profileUnknown = this.isProfileUnknownField(field, context.profile, postingLocation, ashbyConfig);
      if (profileUnknown) {
        unknownFieldIds.add(field.id);
        unknownFieldLabels.set(field.id, field.label);
        this.markUnknownFieldSeen(result, field.label);
      }

      const override = this.pickOverride(field, ashbyConfig);
      const autoResumePath =
        field.type === "file" &&
        resolvedResumePath &&
        (field.required || /resume|cv/i.test(field.label))
          ? resolvedResumePath
          : undefined;

      if (override) {
        const filled = await this.fillFieldWithVerification(scope, field, override.value, {
          profile: context.profile,
          postingLocation,
          ashbyConfig,
          logger: context.logger
        });
        const verified = filled && (await this.verifyFieldAnswered(scope, field, override.value));
        if (filled) filledCount += 1;
        if (!field.required || verified) satisfiedRequiredFieldIds.add(field.id);
        if (filled) {
          this.recordFilledField(result, {
            id: field.id,
            label: field.label,
            value: this.stringifyValue(await this.resolveCanonicalFilledValue(scope, field, override.value)),
            source: "seeded",
            inputKind: field.type
          });
          if (verified && profileUnknown) this.markUnknownFieldResolved(result, field.label);
          await this.humanPause(scope, minFieldDelayMs, maxFieldDelayMs);
        }
        if (!verified) phaseBFields.push(field);
        continue;
      }

      if (autoResumePath) {
        const filled = await this.fillFieldWithVerification(scope, field, autoResumePath, {
          profile: context.profile,
          postingLocation,
          ashbyConfig,
          logger: context.logger
        });
        const verified = filled && (await this.verifyFieldAnswered(scope, field, autoResumePath));
        if (filled) filledCount += 1;
        if (!field.required || verified) satisfiedRequiredFieldIds.add(field.id);
        if (filled) {
          this.recordFilledField(result, {
            id: field.id,
            label: field.label,
            value: this.stringifyValue(await this.resolveCanonicalFilledValue(scope, field, autoResumePath)),
            source: "seeded",
            inputKind: field.type
          });
          if (verified && profileUnknown) this.markUnknownFieldResolved(result, field.label);
          result.notes.push(`fill:${pass}:${field.label}:seeded_resume_path`);
          await this.humanPause(scope, minFieldDelayMs, maxFieldDelayMs);
        }
        if (!verified) phaseBFields.push(field);
        continue;
      }

      if (field.id === "_systemfield_location") {
        const locationAttempt = await this.fillAshbySystemLocationCombobox(scope, context.profile, postingLocation);
        result.notes.push(`location_query_attempt:${locationAttempt.query || "none"}`);
        result.notes.push(`location_target:${locationAttempt.target || "none"}`);
        result.notes.push(`location_option_visible:${locationAttempt.optionVisible ? "true" : "false"}`);
        result.notes.push(`location_exact_option:${locationAttempt.optionExact ? "true" : "false"}`);
        result.notes.push(`location_value_match:${locationAttempt.valueMatched ? "true" : "false"}`);
        if (locationAttempt.valueMatched) {
          result.locationCommitVerified = true;
        }
        const verified = Boolean(locationAttempt.applied && locationAttempt.valueMatched);
        if (locationAttempt.applied) {
          filledCount += 1;
          if (!field.required || (await this.verifyFieldAnswered(scope, field, locationAttempt.value ?? locationAttempt.target))) {
            satisfiedRequiredFieldIds.add(field.id);
          }
          result.notes.push(`fill:${pass}:${field.label}:profile`);
          result.notes.push("commit_strategy:typeahead_text");
          this.recordFilledField(result, {
            id: field.id,
            label: field.label,
            value: locationAttempt.value ?? locationAttempt.target,
            source: "profile",
            inputKind: field.type
          });
          if (verified && profileUnknown) this.markUnknownFieldResolved(result, field.label);
          await this.humanPause(scope, minFieldDelayMs, maxFieldDelayMs);
        }
        if (!verified) phaseBFields.push(field);
        continue;
      }

      const deterministicProfile = this.resolveProfileRuleSeededOnly(
        field,
        context.profile,
        postingLocation,
        ashbyConfig
      );
      if (deterministicProfile && this.answerHasValue(deterministicProfile.value)) {
        context.logger.info("ashby_phase_a_profile_resolved", {
          fieldId: field.id,
          label: field.label,
          source: deterministicProfile.source,
          reason: deterministicProfile.reason
        });
        const normalized = this.normalizeAnswerForField(field, deterministicProfile.value);
        const repaired = this.validateAndRepairFieldAnswer(field, normalized);
        const sanitized = this.sanitizeValueForField(field, repaired.value);
        if (!this.answerHasValue(sanitized)) {
          phaseBFields.push(field);
          continue;
        }
        allResolvedAnswersById.set(field.id, {
          ...deterministicProfile,
          value: sanitized
        });
        const applied = await this.fillFieldWithVerification(scope, field, sanitized, {
          profile: context.profile,
          postingLocation,
          ashbyConfig,
          logger: context.logger
        });
        const verified = applied && (await this.verifyFieldAnswered(scope, field, sanitized));
        context.logger.info("ashby_phase_a_execute_result", {
          fieldId: field.id,
          label: field.label,
          applied,
          verified
        });
        if (applied) {
          filledCount += 1;
          const fillSource = deterministicProfile.source ?? "rule";
          result.notes.push(`fill:${pass}:${field.label}:${fillSource}`);
          result.notes.push(`commit_strategy:${this.commitStrategyMarkerForField(field)}`);
          this.recordFilledField(result, {
            id: field.id,
            label: field.label,
            value: this.stringifyValue(await this.resolveCanonicalFilledValue(scope, field, sanitized)),
            source: fillSource === "skipped" ? "fallback" : fillSource,
            inputKind: field.type
          });
          if (verified && profileUnknown) this.markUnknownFieldResolved(result, field.label);
          await this.humanPause(scope, minFieldDelayMs, maxFieldDelayMs);
        }
        if (!field.required || verified) {
          satisfiedRequiredFieldIds.add(field.id);
        } else {
          phaseBFields.push(field);
        }
        continue;
      }

      phaseBFields.push(field);
    }

    const pendingForLlmMeta: Array<{
      fieldId: string;
      label: string;
      controlType: string;
      required: boolean;
      inclusionReason: string;
    }> = [];
    const llmSkippedOptionalMeta: Array<{ fieldId: string; label: string; controlType: string; required: boolean }> = [];
    const llmBlockedPolicyMeta: Array<{ fieldId: string; label: string; controlType: string; required: boolean }> = [];
    for (const field of phaseBFields) {
      const inclusionReason = this.llmInclusionReasonForField(field, ashbyConfig);
      if (!inclusionReason) {
        const meta = {
          fieldId: field.id,
          label: field.label,
          controlType: field.type,
          required: Boolean(field.required)
        };
        if (this.matchesAnyPattern(field.label, ashbyConfig?.blockedQuestionPatterns ?? [])) {
          llmBlockedPolicyMeta.push(meta);
        } else if (this.isOptionalFreeformNarrativeField(field) && !this.resolveAnswerOptionalNarratives(ashbyConfig)) {
          llmSkippedOptionalMeta.push(meta);
        }
        continue;
      }
      pendingForLlmFields.push(field);
      pendingForLlmMeta.push({
        fieldId: field.id,
        label: field.label,
        controlType: field.type,
        required: Boolean(field.required),
        inclusionReason
      });
    }
    const llmRequestId =
      pendingForLlmFields.length > 0
        ? `ashby_fill_pass_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        : undefined;
    const llmRequestedFieldIds = new Set(pendingForLlmFields.map((item) => item.id));
    const llmTerminalOutcomeFieldIds = new Set<string>();
    const recordLlmTerminalOutcome = (
      field: Pick<DetectedField, "id" | "label">,
      event: Extract<
        LlmEventRecord["event"],
        | "llm_answer_applied"
        | "llm_answer_empty"
        | "llm_answer_invalid_option"
        | "llm_answer_skipped_optional"
        | "llm_answer_blocked_policy"
      >,
      extra?: Omit<LlmEventRecord, "ts" | "event" | "fieldId" | "label" | "phase" | "platform" | "requestId">
    ) => {
      if (!llmRequestedFieldIds.has(field.id)) return;
      if (llmTerminalOutcomeFieldIds.has(field.id)) return;
      llmTerminalOutcomeFieldIds.add(field.id);
      context.logger.info(event, {
        platform: "ashby",
        phase: "fill_pass",
        requestId: llmRequestId,
        fieldId: field.id,
        label: field.label,
        ...(extra ?? {})
      });
      this.recordLlmEvent(result, event, {
        platform: "ashby",
        phase: "fill_pass",
        requestId: llmRequestId,
        fieldId: field.id,
        label: field.label,
        ...(extra ?? {})
      });
    };
    context.logger.info("ashby_pending_for_llm", {
      count: pendingForLlmFields.length,
      fieldCount: pendingForLlmFields.length,
      requestId: llmRequestId,
      fieldIds: pendingForLlmMeta.map((item) => item.fieldId),
      labels: pendingForLlmMeta.map((item) => item.label),
      controlTypes: pendingForLlmMeta.map((item) => item.controlType),
      requiredFlags: pendingForLlmMeta.map((item) => item.required),
      inclusionReasons: pendingForLlmMeta.map((item) => item.inclusionReason),
      fields: pendingForLlmMeta
    });
    for (const field of llmSkippedOptionalMeta) {
      context.logger.info("llm_answer_skipped_optional", {
        platform: "ashby",
        phase: "fill_pass",
        requestId: llmRequestId,
        fieldId: field.fieldId,
        label: field.label,
        controlType: field.controlType,
        required: field.required,
        outcomeReason: "optional_freeform_narrative_disabled"
      });
      this.recordLlmEvent(result, "llm_answer_skipped_optional", {
        platform: "ashby",
        phase: "fill_pass",
        requestId: llmRequestId,
        fieldId: field.fieldId,
        label: field.label,
        controlTypes: [field.controlType],
        requiredFlags: [field.required],
        outcomeReason: "optional_freeform_narrative_disabled"
      });
    }
    for (const field of llmBlockedPolicyMeta) {
      context.logger.info("llm_answer_blocked_policy", {
        platform: "ashby",
        phase: "fill_pass",
        requestId: llmRequestId,
        fieldId: field.fieldId,
        label: field.label,
        controlType: field.controlType,
        required: field.required,
        outcomeReason: "blocked_question_pattern"
      });
      this.recordLlmEvent(result, "llm_answer_blocked_policy", {
        platform: "ashby",
        phase: "fill_pass",
        requestId: llmRequestId,
        fieldId: field.fieldId,
        label: field.label,
        controlTypes: [field.controlType],
        requiredFlags: [field.required],
        outcomeReason: "blocked_question_pattern"
      });
    }

    if (pendingForLlmFields.length > 0) {
      const llmQuestions = buildQuestionMap(pendingForLlmFields);
      context.logger.info("ashby_phase_b_llm_request", {
        questionCount: llmQuestions.length,
        requestId: llmRequestId,
        fieldIds: pendingForLlmMeta.map((item) => item.fieldId),
        labels: pendingForLlmMeta.map((item) => item.label),
        controlTypes: pendingForLlmMeta.map((item) => item.controlType),
        requiredFlags: pendingForLlmMeta.map((item) => item.required),
        inclusionReasons: pendingForLlmMeta.map((item) => item.inclusionReason),
        fields: pendingForLlmMeta
      });
      context.logger.info("ashby_phase", {
        url: result.url,
        phase: "fill_pass_ai_resolve_start",
        questionCount: llmQuestions.length
      });
      context.logger.info("unknown_llm_request", {
        platform: "ashby",
        phase: "fill_pass",
        requestId: llmRequestId,
        questionCount: llmQuestions.length,
        fieldIds: pendingForLlmMeta.map((item) => item.fieldId),
        labels: pendingForLlmMeta.map((item) => item.label)
      });
      this.recordLlmEvent(result, "unknown_llm_request", {
        platform: "ashby",
        phase: "fill_pass",
        requestId: llmRequestId,
        questionCount: llmQuestions.length,
        fieldIds: pendingForLlmMeta.map((item) => item.fieldId),
        labels: pendingForLlmMeta.map((item) => item.label),
        controlTypes: pendingForLlmMeta.map((item) => item.controlType),
        requiredFlags: pendingForLlmMeta.map((item) => item.required),
        inclusionReasons: pendingForLlmMeta.map((item) => item.inclusionReason)
      });
      const aiResolveTimeoutMs = this.resolveAiTimeoutMs();
      const llmBatchStartedAt = Date.now();
      this.recordLlmEvent(result, "llm_batch_start", {
        phase: "fill_pass",
        unresolvedCount: llmQuestions.length,
        timeoutMs: aiResolveTimeoutMs
      });
      const rawAnswers = await this.withTimeout(
        context.aiEngine.resolve(llmQuestions, {
          profile: context.profile,
          resumeText: context.resumeText,
          jobTitle: result.jobTitle,
          company: result.company,
          companyContext,
          platform: "ashby"
        }),
        aiResolveTimeoutMs,
        "ashby_ai_resolve_timeout"
      );
      const llmAnswerCount = rawAnswers.length;
      const llmNonNullCount = rawAnswers.filter((answer) => this.answerHasValue(answer.value)).length;
      this.recordLlmEvent(result, "llm_batch_result", {
        phase: "fill_pass",
        unresolvedCount: llmQuestions.length,
        answerKeyCount: llmAnswerCount,
        nonNullAnswerCount: llmNonNullCount,
        durationMs: Date.now() - llmBatchStartedAt
      });
      const answers = this.applyBlockedQuestionPolicies(rawAnswers, llmQuestions, ashbyConfig.blockedQuestionPatterns);
      for (const answer of answers) byId.set(answer.questionId, answer);
      context.logger.info("ashby_phase", {
        url: result.url,
        phase: "fill_pass_ai_resolve_done"
      });
    }

    // Phase B: LLM for unresolved fields, then fallback only if still unresolved.
    for (const field of phaseBFields) {
      if (this.isOptionalFreeformNarrativeField(field) && !this.resolveAnswerOptionalNarratives(ashbyConfig)) {
        if (llmRequestedFieldIds.has(field.id)) {
          recordLlmTerminalOutcome(field, "llm_answer_skipped_optional", {
            outcomeReason: "optional_freeform_narrative_disabled"
          });
        }
        continue;
      }
      const profileUnknown = this.isProfileUnknownField(field, context.profile, postingLocation, ashbyConfig);
      const answer = byId.get(field.id);
      if (llmRequestedFieldIds.has(field.id) && !this.answerHasValue(answer?.value)) {
        recordLlmTerminalOutcome(field, "llm_answer_empty", {
          source: answer?.source ?? "none",
          hasValue: false
        });
      }
      if (profileUnknown) {
        context.logger.info("unknown_llm_response", {
          platform: "ashby",
          phase: "fill_pass",
          requestId: llmRequestId,
          fieldId: field.id,
          label: field.label,
          source: answer?.source ?? "none",
          hasValue: this.answerHasValue(answer?.value),
          value: answer?.value ?? null
        });
        this.recordLlmEvent(result, "unknown_llm_response", {
          platform: "ashby",
          phase: "fill_pass",
          requestId: llmRequestId,
          fieldId: field.id,
          label: field.label,
          source: answer?.source ?? "none",
          hasValue: this.answerHasValue(answer?.value),
          value: answer?.value ?? null
        });
      }
      const effectiveAnswer = this.resolveEffectiveAnswerForField(
        field,
        answer,
        context.profile,
        result.company,
        result.jobTitle,
        companyContext,
        postingLocation,
        ashbyConfig,
        requiredDeterministicOnly
      );
      if (effectiveAnswer) {
        allResolvedAnswersById.set(field.id, effectiveAnswer);
      }
      const normalizedEffectiveValue = this.normalizeAnswerForField(field, effectiveAnswer?.value);
      const repairedAnswer = this.validateAndRepairFieldAnswer(field, normalizedEffectiveValue);
      if (repairedAnswer.invalid && effectiveAnswer?.source === "llm") {
        result.notes.push(`attempted_skipped:${field.label}:invalid_llm_option:${repairedAnswer.reason ?? "unmatched_option"}`);
        recordLlmTerminalOutcome(field, "llm_answer_invalid_option", {
          source: effectiveAnswer?.source ?? "llm",
          outcomeReason: repairedAnswer.reason ?? "unmatched_option"
        });
      } else if (repairedAnswer.repaired && effectiveAnswer?.source === "llm") {
        result.notes.push(`llm_option_repaired:${field.label}`);
      }
      const fallbackValue = this.requiredFallbackValue(field);
      const companyAwareFallback = this.companyAwareFallbackValue(
        field,
        context.profile,
        result.company,
        result.jobTitle,
        companyContext
      );
      const locationAwareFallback = this.locationAwareFallbackValue(field, context.profile, postingLocation, ashbyConfig);
      const textIntentFallback =
        field.type === "text" || field.type === "textarea"
          ? this.resolveAshbyTextFallback(
              field.label,
              field.type,
              context.profile,
              result.company,
              result.jobTitle,
              companyContext,
              postingLocation,
              ashbyConfig,
              field.placeholder
            )
          : null;
      const aggressiveFallback =
        context.config.mode === "auto-submit"
          ? (
            textIntentFallback?.value ??
            this.autofillFallbackValue(
              field,
              context.profile,
              result.company,
              result.jobTitle,
              companyContext,
              postingLocation,
              ashbyConfig
            )
          )
          : null;
      const blockFallbackForUnknownRequired =
        profileUnknown &&
        field.required &&
        !this.answerHasValue(repairedAnswer.value) &&
        !this.answerHasValue(normalizedEffectiveValue);
      const rawFallbackValue = (
        locationAwareFallback ??
        companyAwareFallback ??
        textIntentFallback?.value ??
        aggressiveFallback ??
        (field.required ? fallbackValue : null)
      );
      const guardedFallbackValue = this.guardUnsafeOfficeRelocationFallback(
        field,
        rawFallbackValue,
        context.profile,
        result,
        ashbyConfig,
        "fill_pass"
      );
      const valueToFill =
        blockFallbackForUnknownRequired
          ? (this.answerHasValue(repairedAnswer.value) ? repairedAnswer.value : null)
          : (
            repairedAnswer.value ??
            guardedFallbackValue
          );
      const narrativeSafeValue = this.ensureRequiredNarrativeFallbackValue(
        field,
        valueToFill,
        context.profile,
        result.company,
        result.jobTitle
      );
      const sanitizedValueToFill = this.sanitizeValueForField(field, narrativeSafeValue);
      if (!this.answerHasValue(sanitizedValueToFill)) {
        if (llmRequestedFieldIds.has(field.id)) {
          if (this.answerHasValue(answer?.value) && effectiveAnswer?.source !== "llm") {
            recordLlmTerminalOutcome(field, "llm_answer_blocked_policy", {
              source: effectiveAnswer?.source ?? "none",
              outcomeReason: `resolved_by_non_llm_source:${effectiveAnswer?.source ?? "none"}`
            });
          } else if (!this.answerHasValue(answer?.value)) {
            recordLlmTerminalOutcome(field, "llm_answer_empty", {
              source: answer?.source ?? "none",
              hasValue: false
            });
          }
        }
        continue;
      }
      this.recordAccommodationPolicyMarker(result, field, sanitizedValueToFill, ashbyConfig);
      this.recordDeterministicFinalTextFallbackMarker(
        result,
        field,
        sanitizedValueToFill,
        ashbyConfig,
        effectiveAnswer?.reason ?? (textIntentFallback?.deterministicFinal ? "deterministic_final_text_fallback" : undefined)
      );

      const filled = await this.fillFieldWithVerification(scope, field, sanitizedValueToFill, {
        profile: context.profile,
        postingLocation,
        ashbyConfig,
        logger: context.logger
      });
      if (profileUnknown) {
        context.logger.info("unknown_execute_result", {
          platform: "ashby",
          phase: "fill_pass",
          fieldId: field.id,
          label: field.label,
          applied: filled
        });
      }
      if (filled) {
        const verified = !field.required || (await this.verifyFieldAnswered(scope, field, sanitizedValueToFill));
        filledCount += 1;
        if (verified) {
          satisfiedRequiredFieldIds.add(field.id);
          if (profileUnknown) {
            context.logger.info("unknown_verify_result", {
              platform: "ashby",
              phase: "fill_pass",
              fieldId: field.id,
              label: field.label,
              verified: true
            });
          }
        }
        context.logger.info("ashby_phase_b_execute_result", {
          fieldId: field.id,
          label: field.label,
          applied: filled,
          verified
        });
        const fillSource =
          normalizedEffectiveValue !== null && normalizedEffectiveValue !== undefined
            ? effectiveAnswer?.source ?? "fallback"
            : "required_fallback";
        result.notes.push(`fill:${pass}:${field.label}:${fillSource}`);
        result.notes.push(`commit_strategy:${this.commitStrategyMarkerForField(field)}`);
        if (effectiveAnswer?.reason?.startsWith("deterministic_text_intent:")) {
          result.notes.push(`fallback_intent:${field.label}:${effectiveAnswer.reason.replace("deterministic_text_intent:", "")}`);
        }
        if (
          (normalizedEffectiveValue === null || normalizedEffectiveValue === undefined) &&
          textIntentFallback?.reason.startsWith("text_fallback_")
        ) {
          result.notes.push(`fallback_intent:${field.label}:${textIntentFallback.intent}`);
        }
        this.recordFilledField(result, {
          id: field.id,
          label: field.label,
          value: this.stringifyValue(await this.resolveCanonicalFilledValue(scope, field, sanitizedValueToFill)),
          source:
            normalizedEffectiveValue !== null && normalizedEffectiveValue !== undefined
              ? effectiveAnswer?.source === "skipped"
                ? "fallback"
                : effectiveAnswer?.source ?? "fallback"
              : "fallback",
          inputKind: field.type
        });
        if (llmRequestedFieldIds.has(field.id)) {
          if (effectiveAnswer?.source === "llm") {
            recordLlmTerminalOutcome(field, "llm_answer_applied", {
              source: "llm",
              hasValue: true
            });
          } else if (this.answerHasValue(answer?.value)) {
            recordLlmTerminalOutcome(field, "llm_answer_blocked_policy", {
              source: effectiveAnswer?.source ?? "none",
              outcomeReason: `resolved_by_non_llm_source:${effectiveAnswer?.source ?? "none"}`
            });
          } else {
            recordLlmTerminalOutcome(field, "llm_answer_empty", {
              source: answer?.source ?? "none",
              hasValue: false
            });
          }
        }
        if (profileUnknown) this.markUnknownFieldResolved(result, field.label);
        await this.humanPause(scope, minFieldDelayMs, maxFieldDelayMs);
      }
    }
    if (llmRequestedFieldIds.size > 0) {
      for (const field of pendingForLlmFields) {
        if (llmTerminalOutcomeFieldIds.has(field.id)) continue;
        recordLlmTerminalOutcome(field, "llm_answer_empty", {
          outcomeReason: "no_terminal_outcome_recorded"
        });
      }
    }

    const hasRecordedLocation = result.filledFields.some((entry) =>
      /(^|[^a-z0-9])location([^a-z0-9]|$)/.test(this.normalize(entry.label))
    );
    if (!hasRecordedLocation && context.profile.basics.location?.trim()) {
      const forcedLocation = await this.ensureCurrentLocationCommitted(
        scope,
        context.profile,
        postingLocation
      );
      if (forcedLocation) {
        filledCount += 1;
        result.notes.push(`fill:${pass}:Current Location:profile`);
        result.notes.push("commit_strategy:typeahead_text");
        this.recordFilledField(result, {
          id: "_systemfield_location",
          label: "Current Location",
          value: forcedLocation,
          source: "profile",
          inputKind: "text"
        });
      }
    }

    const unansweredRequiredFields = fields
      .filter((field) => field.required)
      .filter((field) => !satisfiedRequiredFieldIds.has(field.id))
      .filter((field) => !this.pickOverride(field, ashbyConfig))
      .map((field) => field.label)
      .filter(Boolean);
    for (const field of fields) {
      if (!field.required) continue;
      if (satisfiedRequiredFieldIds.has(field.id)) continue;
      if (!unknownFieldIds.has(field.id)) continue;
      const label = unknownFieldLabels.get(field.id) ?? field.label;
      if (label) this.markUnknownFieldUnresolved(result, label);
    }
    const missingRequiredFields = await this.detectMissingRequiredFields(scope, ashbyConfig.requiredFieldSelectors);
    const validationErrors = await this.readValidationErrors(
      scope,
      confirmationPatterns,
      ashbyConfig.requiredFieldSelectors
    );

    return {
      answers: Array.from(allResolvedAnswersById.values()),
      unresolved: this.mergeUnique(unansweredRequiredFields, missingRequiredFields, validationErrors),
      fieldCount: fields.length,
      filledCount
    };
  }

  private async humanPause(scope: AshbyInteractionScope, minMs: number, maxMs: number): Promise<number> {
    if (maxMs <= 0) return 0;
    const delay = ashbySampleDelayMs(minMs, maxMs);
    await scope.waitForTimeout(delay).catch(() => undefined);
    return delay;
  }

  private pushUnique(list: string[] | undefined, value: string): string[] {
    const target = Array.isArray(list) ? list : [];
    const normalized = this.normalize(value);
    if (!normalized) return target;
    if (!target.some((item) => this.normalize(item) === normalized)) target.push(value);
    return target;
  }

  private removeNormalized(list: string[] | undefined, value: string): string[] {
    const target = Array.isArray(list) ? list : [];
    const normalized = this.normalize(value);
    if (!normalized) return target;
    return target.filter((item) => this.normalize(item) !== normalized);
  }

  private markUnknownFieldSeen(result: JobRunResult, label: string): void {
    result.unknownFieldsSeen = this.pushUnique(result.unknownFieldsSeen, label);
    if (!(result.unknownFieldsResolved ?? []).some((item) => this.normalize(item) === this.normalize(label))) {
      result.unknownFieldsUnresolved = this.pushUnique(result.unknownFieldsUnresolved, label);
    }
  }

  private markUnknownFieldResolved(result: JobRunResult, label: string): void {
    result.unknownFieldsSeen = this.pushUnique(result.unknownFieldsSeen, label);
    result.unknownFieldsResolved = this.pushUnique(result.unknownFieldsResolved, label);
    result.unknownFieldsUnresolved = this.removeNormalized(result.unknownFieldsUnresolved, label);
  }

  private markUnknownFieldUnresolved(result: JobRunResult, label: string): void {
    result.unknownFieldsSeen = this.pushUnique(result.unknownFieldsSeen, label);
    if ((result.unknownFieldsResolved ?? []).some((item) => this.normalize(item) === this.normalize(label))) return;
    result.unknownFieldsUnresolved = this.pushUnique(result.unknownFieldsUnresolved, label);
  }

  private toApplicationQuestionFromField(field: DetectedField): ApplicationQuestion {
    return {
      id: field.id,
      label: field.label,
      type: field.type,
      required: field.required,
      options: field.options,
      placeholder: field.placeholder,
      platformMeta: field.platformMeta
    };
  }

  private resolveProfileRuleSeededOnly(
    field: DetectedField,
    profile: CandidateProfile,
    postingLocation?: string,
    ashbyConfig?: AshbyConfig
  ): ResolvedAnswer | undefined {
    const profileMapped = this.resolveProfilePromptValue(field, profile, postingLocation, ashbyConfig);
    if (profileMapped && this.answerHasValue(profileMapped.value)) {
      return {
        questionId: field.id,
        value: profileMapped.value,
        source: profileMapped.source,
        reason: profileMapped.reason
      };
    }

    const question = this.toApplicationQuestionFromField(field);
    const deterministic = evaluateDeterministicRule(question, profile);
    if (this.answerHasValue(deterministic.answer)) {
      return {
        questionId: field.id,
        value: deterministic.answer as ResolvedAnswer["value"],
        source: deterministic.source ?? "rule",
        reason: deterministic.reason ?? "deterministic_required"
      };
    }

    const mapped = evaluateProfileMapping(question, profile);
    if (this.answerHasValue(mapped.answer)) {
      return {
        questionId: field.id,
        value: mapped.answer as ResolvedAnswer["value"],
        source: mapped.source ?? "profile",
        reason: mapped.reason ?? "profile_required"
      };
    }

    return undefined;
  }

  private shouldAskLlmForField(field: Pick<DetectedField, "id" | "label" | "type" | "required">, ashbyConfig?: AshbyConfig): boolean {
    return this.llmInclusionReasonForField(field, ashbyConfig) !== null;
  }

  private llmInclusionReasonForField(
    field: Pick<DetectedField, "id" | "label" | "type" | "required">,
    ashbyConfig?: AshbyConfig
  ): string | null {
    if (field.id === "_systemfield_location") return null;
    if (field.type === "file") return null;
    if (this.matchesAnyPattern(field.label, ashbyConfig?.blockedQuestionPatterns ?? [])) return null;
    if (this.isOptionalFreeformNarrativeField(field) && !this.resolveAnswerOptionalNarratives(ashbyConfig)) {
      return null;
    }
    if ((field.type === "text" || field.type === "textarea") && field.required) {
      const intent = this.classifyAshbyTextPromptIntent(field.label, field.type);
      if (
        intent === "open_ended_narrative" ||
        intent === "motivation_fit" ||
        intent === "company_understanding" ||
        intent === "summary_background"
      ) {
        return "required_narrative";
      }
    }
    return "unresolved_eligible";
  }

  private resolveAnswerOptionalNarratives(ashbyConfig?: AshbyConfig): boolean {
    return ashbyConfig?.answerOptionalNarratives ?? false;
  }

  private isOptionalFreeformNarrativeField(
    field: Pick<DetectedField, "label" | "type" | "required">
  ): boolean {
    if (field.required) return false;
    if (field.type !== "text" && field.type !== "textarea") return false;
    const intent = this.classifyAshbyTextPromptIntent(field.label, field.type);
    const structuredIntents: AshbyTextPromptIntent[] = [
      "links",
      "location_country",
      "legal_work_auth",
      "compensation",
      "notice_start_date"
    ];
    if (structuredIntents.includes(intent)) return false;
    const normalized = this.normalize(field.label);
    if (normalized.includes("optional")) return true;
    return (
      intent === "open_ended_narrative" ||
      intent === "motivation_fit" ||
      intent === "company_understanding" ||
      intent === "summary_background" ||
      intent === "misc"
    );
  }

  private ensureRequiredNarrativeFallbackValue(
    field: Pick<DetectedField, "label" | "required" | "type">,
    value: string | string[] | boolean | null | undefined,
    profile: CandidateProfile,
    company?: string,
    jobTitle?: string
  ): string | string[] | boolean | null | undefined {
    if (!field.required) return value;
    if (field.type !== "text" && field.type !== "textarea") return value;
    const intent = this.classifyAshbyTextPromptIntent(field.label, field.type);
    const narrativeRequired =
      intent === "open_ended_narrative" ||
      intent === "motivation_fit" ||
      intent === "company_understanding" ||
      intent === "summary_background";
    if (!narrativeRequired) return value;
    const normalized = this.normalize(String(value ?? ""));
    if (
      this.answerHasValue(value) &&
      normalized !== "n/a" &&
      normalized !== "na" &&
      normalized !== "none" &&
      normalized !== "null"
    ) {
      return value;
    }
    const narrative =
      this.buildNarrativeFallback(field.label, profile, company, jobTitle) ??
      `I am excited about this opportunity because it aligns with my software engineering background and I can contribute quickly with high-quality execution.`;
    return narrative;
  }

  private isProfileUnknownField(
    field: DetectedField,
    profile: CandidateProfile,
    postingLocation?: string,
    ashbyConfig?: AshbyConfig
  ): boolean {
    if (field.id === "_systemfield_location") return false;
    if (field.type === "file") return false;
    const question = this.toApplicationQuestionFromField(field);
    const deterministic = evaluateDeterministicRule(question, profile);
    if (this.answerHasValue(deterministic.answer)) return false;
    const mapped = evaluateProfileMapping(question, profile);
    if (this.answerHasValue(mapped.answer)) return false;
    const profileMapped = this.resolveProfilePromptValue(field, profile, postingLocation, ashbyConfig);
    if (profileMapped && this.answerHasValue(profileMapped.value)) return false;
    return true;
  }

  private shouldProbeUnknownOptions(field: DetectedField): boolean {
    if (field.type === "single_select" || field.type === "multi_select") return true;
    const capability = this.fieldCapability(field);
    return capability === "typeahead_text";
  }

  private isComboboxBackedSelectionField(field: Pick<DetectedField, "type" | "selector" | "platformMeta">): boolean {
    if (field.type !== "single_select" && field.type !== "multi_select") return false;
    const role = this.normalize(String(field.platformMeta?.role ?? ""));
    const inputType = this.normalize(String(field.platformMeta?.inputType ?? ""));
    const ariaHasPopup = this.normalize(String(field.platformMeta?.ariaHasPopup ?? ""));
    const selector = this.normalize(String(field.selector ?? ""));
    return (
      role === "combobox" ||
      ariaHasPopup === "listbox" ||
      inputType === "search" ||
      selector.includes("combobox")
    );
  }

  private async commitStrictComboboxTypeahead(
    scope: AshbyInteractionScope,
    control: Locator,
    candidate: string
  ): Promise<boolean> {
    const desired = String(candidate ?? "").trim();
    if (!desired) return false;
    await control.click({ force: true }).catch(() => undefined);
    await control.fill("").catch(() => undefined);
    await control.type(desired, { delay: 38 }).catch(() => undefined);
    const startedAt = Date.now();
    let optionsSeen = false;
    while (Date.now() - startedAt < 3000) {
      const optionCount = await this.countVisibleTypeaheadOptions(scope);
      if (optionCount > 0) {
        optionsSeen = true;
        break;
      }
      await scope.waitForTimeout(120).catch(() => undefined);
    }
    if (!optionsSeen) return false;
    const selected = await this.selectTypeaheadOption(scope, control, desired, { strict: true });
    if (!selected) return false;
    await scope.waitForTimeout(90).catch(() => undefined);
    await control.press("Enter").catch(() => undefined);
    await scope.waitForTimeout(90).catch(() => undefined);
    await control.press("Tab").catch(() => undefined);
    await control.blur().catch(() => undefined);
    const committed = String((await control.inputValue().catch(() => "")) ?? "").trim();
    return committed.length > 0;
  }

  private async collectRoleOptionsFromLocator(
    scope: AshbyInteractionScope,
    selector: string
  ): Promise<string[]> {
    const locator = scope.locator(selector);
    const count = await locator.count().catch(() => 0);
    const options: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const node = locator.nth(i);
      const visible = await node.isVisible().catch(() => false);
      if (!visible) continue;
      const text = String((await node.innerText().catch(() => "")) ?? "").trim();
      if (text) options.push(text);
    }
    return this.mergeUnique(options);
  }

  private async collectVisibleOptionTexts(locator: Locator): Promise<string[]> {
    const count = await locator.count().catch(() => 0);
    const options: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const node = locator.nth(i);
      const visible = await node.isVisible().catch(() => false);
      if (!visible) continue;
      const text = String((await node.innerText().catch(() => "")) ?? "").trim();
      if (text) options.push(text);
    }
    return this.mergeUnique(options);
  }

  private async probeUnknownFieldOptions(
    scope: AshbyInteractionScope,
    field: DetectedField,
    ashbyConfig?: AshbyConfig
  ): Promise<AshbyUnknownProbeResult> {
    const queryCharRaw = String(ashbyConfig?.unknownOptionProbeChar ?? DEFAULT_ASHBY_UNKNOWN_OPTION_PROBE_CHAR).trim();
    const queryChar = queryCharRaw.slice(0, 1) || DEFAULT_ASHBY_UNKNOWN_OPTION_PROBE_CHAR;
    const probeWaitMs = Math.max(160, ashbyConfig?.unknownOptionProbeWaitMs ?? DEFAULT_ASHBY_UNKNOWN_OPTION_PROBE_WAIT_MS);
    const targetControl = await this.resolveTextControlLocator(scope, field);
    if (!targetControl || !(await targetControl.isVisible().catch(() => false))) {
      return { fieldId: field.id, label: field.label, options: [], queryChar, source: "none" };
    }

    await targetControl.click({ force: true }).catch(() => undefined);
    await targetControl.press("End").catch(() => undefined);
    await targetControl.type(queryChar, { delay: 70 }).catch(() => undefined);
    await scope.waitForTimeout(probeWaitMs).catch(() => undefined);
    await targetControl.press("Backspace").catch(() => undefined);
    await scope.waitForTimeout(probeWaitMs).catch(() => undefined);

    const ariaControls = String((await targetControl.getAttribute("aria-controls").catch(() => "")) ?? "").trim();
    if (ariaControls) {
      const scoped = await this.collectRoleOptionsFromLocator(
        scope,
        `[id="${ariaControls.replace(/"/g, '\\"')}"] [role='option']`
      );
      if (scoped.length > 0) {
        return { fieldId: field.id, label: field.label, options: scoped, queryChar, source: "aria_controls" };
      }
    }

    const global = await this.collectRoleOptionsFromLocator(scope, "[role='option']");
    if (global.length > 0) {
      return { fieldId: field.id, label: field.label, options: global, queryChar, source: "global_option" };
    }

    const fromResultContainer = await this.collectRoleOptionsFromLocator(
      scope,
      "[class*='resultContainer'] [role='option']"
    );
    if (fromResultContainer.length > 0) {
      return {
        fieldId: field.id,
        label: field.label,
        options: fromResultContainer,
        queryChar,
        source: "result_container"
      };
    }

    return { fieldId: field.id, label: field.label, options: [], queryChar, source: "none" };
  }

  private async enrichUnknownFieldsWithLiveOptions(
    context: AdapterRunContext,
    scope: AshbyInteractionScope,
    fields: DetectedField[],
    result: JobRunResult,
    phase: "fill_pass" | "recovery",
    profile: CandidateProfile,
    postingLocation: string | undefined,
    ashbyConfig?: AshbyConfig
  ): Promise<void> {
    const probeEnabled = ashbyConfig?.unknownOptionProbeEnabled ?? true;
    if (!probeEnabled) return;
    const maxAttempts = Math.max(1, ashbyConfig?.unknownResolutionAttempts ?? DEFAULT_ASHBY_UNKNOWN_RESOLUTION_ATTEMPTS);
    for (const field of fields) {
      if (!this.isProfileUnknownField(field, profile, postingLocation, ashbyConfig)) continue;
      this.markUnknownFieldSeen(result, field.label);
      if (!this.shouldProbeUnknownOptions(field)) continue;
      let best: AshbyUnknownProbeResult | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        context.logger.info("unknown_probe_start", {
          platform: "ashby",
          phase,
          attempt,
          fieldId: field.id,
          label: field.label
        });
        const probed = await this.probeUnknownFieldOptions(scope, field, ashbyConfig);
        if (!best || probed.options.length > best.options.length) best = probed;
        if (probed.options.length > 0) break;
      }
      if (!best) continue;
      if (best.options.length > 0) {
        field.options = this.mergeUnique(best.options);
      }
      context.logger.info("unknown_probe_result", {
        platform: "ashby",
        phase,
        fieldId: field.id,
        label: field.label,
        optionCount: best.options.length,
        source: best.source,
        queryChar: best.queryChar
      });
      result.notes.push(`unknown_probe:${phase}:${field.label}:options=${best.options.length}:source=${best.source}`);
    }
  }

  private recordFilledField(
    result: JobRunResult,
    entry: {
      id: string;
      label: string;
      value: string;
      source: "seeded" | "rule" | "profile" | "llm" | "fallback" | "manual";
      inputKind: string;
    }
  ): void {
    const existingIndex = result.filledFields.findIndex((item) => item.id === entry.id);
    if (existingIndex >= 0) {
      result.filledFields[existingIndex] = entry;
      return;
    }
    result.filledFields.push(entry);
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

  private recordAccommodationPolicyMarker(
    result: JobRunResult,
    field: Pick<DetectedField, "label" | "type" | "options">,
    value: string | string[] | boolean | null,
    ashbyConfig?: AshbyConfig
  ): void {
    if (!this.answerHasValue(value)) return;
    if (this.resolveAccommodationPolicy(ashbyConfig) !== "no_and_fill_followup_na") return;
    const label = this.normalize(field.label);
    const canonical = this.normalize(this.stringifyValue(value));
    if (!canonical) return;

    if (this.isAccommodationFollowupPrompt(label) && (field.type === "text" || field.type === "textarea")) {
      const expected = this.normalize(this.resolveAccommodationFollowupDefaultText(ashbyConfig));
      if (canonical === expected && !result.notes.includes("policy:accommodation_followup:na_filled")) {
        result.notes.push("policy:accommodation_followup:na_filled");
      }
      return;
    }
    if (!this.isAccommodationPrompt(label)) return;

    const noLike = canonical === "no" || canonical.includes("do not require") || canonical.includes("no accommodations");
    if (noLike && !result.notes.includes("policy:accommodation:no_selected")) {
      result.notes.push("policy:accommodation:no_selected");
    }
  }

  private recordDeterministicFinalTextFallbackMarker(
    result: JobRunResult,
    field: Pick<DetectedField, "label" | "type" | "required">,
    value: string | string[] | boolean | null,
    ashbyConfig?: AshbyConfig,
    reason?: string
  ): void {
    if (field.type !== "text" && field.type !== "textarea") return;
    if (!field.required) return;
    if (reason && reason !== "deterministic_final_text_fallback") return;
    const normalizedValue = this.normalize(this.stringifyValue(value));
    const normalizedFinal = this.normalize(this.resolveFinalTextFallbackValue(ashbyConfig));
    if (!normalizedValue || normalizedValue !== normalizedFinal) return;
    const marker = `policy:text_fallback:deterministic_final:${field.label}`;
    if (!result.notes.includes(marker)) {
      result.notes.push(marker);
    }
  }

  private syncCanonicalAnswersFromFilledFields(result: JobRunResult): void {
    result.answers = result.filledFields.map((field) => ({
      questionId: field.id,
      value: this.parseCanonicalAnswerValue(field.value, field.inputKind),
      source: this.toAnswerSource(field.source),
      reason: "filled_payload"
    }));
  }

  private parseCanonicalAnswerValue(
    value: string,
    inputKind?: string
  ): string | string[] | boolean | null {
    const normalizedKind = this.normalize(String(inputKind ?? ""));
    const trimmed = String(value ?? "").trim();
    if (!trimmed.length) return null;
    if (normalizedKind === "boolean") {
      const lowered = trimmed.toLowerCase();
      if (["true", "yes", "y", "1"].includes(lowered)) return true;
      if (["false", "no", "n", "0"].includes(lowered)) return false;
    }
    if (normalizedKind === "multi_select") {
      return trimmed
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return trimmed;
  }

  private toAnswerSource(
    source: "seeded" | "rule" | "profile" | "llm" | "fallback" | "manual"
  ): ResolvedAnswer["source"] {
    if (
      source === "seeded" ||
      source === "rule" ||
      source === "profile" ||
      source === "llm" ||
      source === "fallback" ||
      source === "manual"
    ) {
      return source;
    }
    return "fallback";
  }

  private async enterApplyFlow(page: AdapterRunContext["page"]): Promise<void> {
    if ((await this.hasVisibleApplicationFields(page)) || (await this.hasVisibleApplicationFieldsInAnyFrame(page))) return;

    const candidates = [
      page.getByRole("button", { name: /apply|start application|apply now/i }).first(),
      page.getByRole("link", { name: /apply|start application|apply now/i }).first(),
      page.locator("button:has-text('Apply')").first(),
      page.getByRole("button", { name: /apply for this job/i }).first()
    ];

    let clickedApply = false;
    for (const locator of candidates) {
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      await locator.click().catch(() => undefined);
      clickedApply = true;
      await page.waitForTimeout(1000);
      break;
    }

    const applicationTabCandidates = [
      page.getByRole("tab", { name: /^application$/i }).first(),
      page.getByRole("button", { name: /^application$/i }).first(),
      page.getByRole("link", { name: /^application$/i }).first()
    ];
    for (const tab of applicationTabCandidates) {
      const visible = await tab.isVisible().catch(() => false);
      if (!visible) continue;
      await tab.click().catch(() => undefined);
      await page.waitForTimeout(600);
      break;
    }

    if (clickedApply) {
      await page.waitForTimeout(600);
    }

    if ((await this.hasVisibleApplicationFields(page)) || (await this.hasVisibleApplicationFieldsInAnyFrame(page))) return;

    const currentUrl = page.url();
    if (!/\/application(?:\/)?(?:\?|$)/i.test(currentUrl)) {
      const applicationUrl = currentUrl.endsWith("/") ? `${currentUrl}application` : `${currentUrl}/application`;
      await page.goto(applicationUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
      await page.waitForTimeout(800);
    }

    await this.waitForApplicationFields(page, 10_000);
  }

  private pickOverride(field: DetectedField, config: AshbyConfig): { value: string } | undefined {
    const normalizedLabel = this.normalize(field.label);
    const normalizedId = this.normalize(field.id);
    const normalizedSelector = this.normalize(field.selector);

    const findStringOverride = (items: { id: string; value: string }[] | undefined) =>
      items?.find((item) => {
        const candidate = this.normalize(item.id);
        if (!candidate) return false;
        return (
          candidate === normalizedId ||
          candidate === normalizedSelector ||
          normalizedId.includes(candidate) ||
          normalizedLabel.includes(candidate)
        );
      });

    const findFileOverride = (items: { id: string; path: string }[] | undefined) =>
      items?.find((item) => {
        const candidate = this.normalize(item.id);
        if (!candidate) return false;
        return (
          candidate === normalizedId ||
          candidate === normalizedSelector ||
          normalizedId.includes(candidate) ||
          normalizedLabel.includes(candidate)
        );
      });

    if (field.type === "file") {
      const file = findFileOverride(config.fileValues);
      return file ? { value: file.path } : undefined;
    }

    if (field.type === "single_select" || field.type === "multi_select") {
      const select = findStringOverride(config.selectValues);
      return select ? { value: select.value } : undefined;
    }

    if (field.type === "textarea") {
      const textArea = findStringOverride(config.textareaValues);
      return textArea ? { value: textArea.value } : undefined;
    }

    const text = findStringOverride(config.textValues);
    return text ? { value: text.value } : undefined;
  }

  private applyBlockedQuestionPolicies(
    answers: ResolvedAnswer[],
    questions: { id: string; label: string }[],
    patterns: string[] | undefined
  ): ResolvedAnswer[] {
    if (!patterns || patterns.length === 0) return answers;
    const questionLabels = new Map(questions.map((question) => [question.id, question.label]));
    return answers.map((answer) => {
      const label = questionLabels.get(answer.questionId) ?? answer.questionId;
      if (!this.matchesAnyPattern(label, patterns)) return answer;
      return {
        ...answer,
        value: null,
        source: "skipped",
        reason: "blocked_question_pattern"
      };
    });
  }

  private async findSubmitButton(scope: AshbyInteractionScope): Promise<Locator | null> {
    const candidates = [
      scope.getByRole("button", { name: /submit|send application|finish application|apply/i }).first(),
      scope.locator("button[type='submit']").first(),
      scope.locator("button:has-text('Submit')").first()
    ];
    for (const locator of candidates) {
      const visible = await locator.isVisible().catch(() => false);
      if (visible) return locator;
    }
    return null;
  }

  private async detectMissingRequiredFields(
    scope: AshbyInteractionScope,
    extraSelectors: string[] | undefined
  ): Promise<string[]> {
    const descriptors = await this.detectMissingRequiredFieldDescriptors(scope, extraSelectors);
    return descriptors.map((item) => item.label);
  }

  private async detectMissingRequiredFieldDescriptors(
    scope: AshbyInteractionScope,
    extraSelectors: string[] | undefined
  ): Promise<MissingFieldDescriptor[]> {
    const selectors = this.mergeUnique(DEFAULT_REQUIRED_FIELD_SELECTORS, extraSelectors ?? []);
    const values = (await scope
      .evaluate(
        ({ selectors: rawSelectors, hints }) => {
          const normalize = (value: string) => (value || "").replace(/\s+/g, " ").trim();
          const normalizeIdentity = (value: string) => normalize(value).toLowerCase();
          const dedupe = (items: Array<{ label: string; identity?: string }>) => {
            const seen = new Set<string>();
            const out: Array<{ label: string; identity?: string }> = [];
            for (const item of items) {
              const label = normalize(item.label);
              if (!label) continue;
              const identity = normalize(item.identity || "");
              const key = `${label.toLowerCase()}::${identity.toLowerCase()}`;
              if (seen.has(key)) continue;
              seen.add(key);
              out.push(identity ? { label, identity } : { label });
            }
            return out.slice(0, 12);
          };
          const buildIdentity = (block: HTMLElement | null, html: HTMLElement | null) => {
            const fieldPath = normalize(block?.getAttribute("data-field-path") || "") || "no_field_path";
            const groupName = normalize(
              (html as HTMLInputElement | null)?.name ||
              (block?.querySelector("input[type='radio'], input[type='checkbox']") as HTMLInputElement | null)?.name ||
              ""
            ) || "no_group_name";
            const optionTexts = Array.from(
              (block ?? html ?? document).querySelectorAll("label, button, option")
            )
              .map((node) => normalize(node.textContent || ""))
              .filter(Boolean)
              .slice(0, 20)
              .sort()
              .join("|") || "no_options";
            return normalizeIdentity(`group:${fieldPath.toLowerCase()}::${groupName.toLowerCase()}::${optionTexts.toLowerCase()}`);
          };
          const selectors = Array.isArray(rawSelectors) ? rawSelectors : [];
          const output: Array<{ label: string; identity?: string }> = [];
          const controls = Array.from(document.querySelectorAll("form input, form textarea, form select"));

          for (const element of controls) {
            const html = element;
            if (!(html instanceof HTMLElement)) continue;

            const style = window.getComputedStyle(html);
            const rect = html.getBoundingClientRect();
            const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
            if (!visible) continue;
            if (html.hasAttribute("disabled")) continue;

            const required = html.hasAttribute("required") || html.getAttribute("aria-required") === "true";
            if (!required) continue;

            const labelText = (() => {
              const id = html.getAttribute("id");
              if (id) {
                const direct = document.querySelector(`label[for="${id}"]`);
                if (direct && direct.textContent) return normalize(direct.textContent);
              }
              const parentLabel = html.closest("label");
              if (parentLabel && parentLabel.textContent) return normalize(parentLabel.textContent);
              return normalize(html.getAttribute("aria-label") || html.getAttribute("name") || html.getAttribute("id") || html.tagName);
            })();
            const fieldBlock =
              (html.closest("[data-field-path]") as HTMLElement | null) ??
              (html.closest("fieldset") as HTMLElement | null) ??
              (html.closest("div[class*='_fieldEntry_']") as HTMLElement | null);
            const identity = buildIdentity(fieldBlock, html);

            const tag = html.tagName.toLowerCase();
            const type = (html.getAttribute("type") || "").toLowerCase();
            let missing = false;

            if (type === "checkbox") {
              missing = !(html as HTMLInputElement).checked;
            } else if (type === "radio") {
              const name = html.getAttribute("name");
              if (name) {
                const group = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`));
                missing = !group.some((radio) => (radio instanceof HTMLInputElement ? radio.checked : false));
              } else {
                missing = !(html as HTMLInputElement).checked;
              }
            } else if (tag === "select") {
              missing = !normalize((html as HTMLSelectElement).value);
            } else {
              missing = !normalize((html as HTMLInputElement | HTMLTextAreaElement).value || "");
            }

            if (missing) output.push({ label: labelText, identity });
          }

          for (const selector of selectors) {
            const nodes = Array.from(document.querySelectorAll(selector));
            for (const node of nodes) {
              if (!(node instanceof HTMLElement)) continue;
              const style = window.getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
              if (!visible) continue;

              const text = normalize(node.innerText || node.textContent || "");
              if (!text) continue;
              const lowered = text.toLowerCase();
              if (hints.some((hint) => lowered.includes(hint))) {
                const block =
                  (node.closest("[data-field-path]") as HTMLElement | null) ??
                  (node.closest("fieldset") as HTMLElement | null) ??
                  (node.closest("div[class*='_fieldEntry_']") as HTMLElement | null);
                output.push({ label: text, identity: buildIdentity(block, block) });
              }
            }
          }

          return dedupe(output);
        },
        { selectors, hints: VALIDATION_ERROR_HINTS }
      )
      .catch(() => [] as MissingFieldDescriptor[])) as MissingFieldDescriptor[];

    return Array.isArray(values)
      ? values
          .filter((item): item is MissingFieldDescriptor => Boolean(item && typeof item.label === "string"))
          .map((item) => ({
            label: normalizeWhitespace(item.label),
            identity: typeof item.identity === "string" && item.identity.trim() ? normalizeWhitespace(item.identity) : undefined
          }))
      : [];
  }

  private async detectBotChallenge(
    scope: AshbyInteractionScope,
    configuredSelectors: string[] | undefined
  ): Promise<BotChallengeEvidence> {
    const selectors = this.mergeUnique(DEFAULT_CHALLENGE_SELECTORS, configuredSelectors ?? []);
    const rawSignals = (await scope
      .evaluate(
        ({ selectors: candidateSelectors }) => {
          const iframeSources = Array.from(document.querySelectorAll("iframe")).map(
            (frame) => {
              if (!(frame instanceof HTMLElement)) return "";
              const style = window.getComputedStyle(frame);
              const rect = frame.getBoundingClientRect();
              const visible =
                style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
              if (!visible) return "";
              return frame.getAttribute("src") || "";
            }
          );
          const selectorMatches = candidateSelectors.filter((selector: string) => {
            try {
              const match = document.querySelector(selector);
              if (!(match instanceof HTMLElement)) return false;
              const style = window.getComputedStyle(match);
              const rect = match.getBoundingClientRect();
              return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
            } catch {
              return false;
            }
          });
          const bodyText = document.body?.innerText || "";
          return { iframeSources, selectorMatches, bodyText };
        },
        { selectors }
      )
      .catch(() => null)) as BotChallengeSignals | null;

    const signals: BotChallengeSignals = {
      iframeSources: Array.isArray(rawSignals?.iframeSources)
        ? rawSignals.iframeSources.filter((value): value is string => typeof value === "string")
        : [],
      selectorMatches: Array.isArray(rawSignals?.selectorMatches)
        ? rawSignals.selectorMatches.filter((value): value is string => typeof value === "string")
        : [],
      bodyText: typeof rawSignals?.bodyText === "string" ? rawSignals.bodyText : ""
    };

    const evidence = ashbyCollectBotChallengeEvidence(
      signals.bodyText,
      signals.iframeSources,
      signals.selectorMatches
    );
    const lowered = signals.bodyText.toLowerCase();
    const softSignals = SOFT_BOT_FAILURE_TEXT_PATTERNS.filter((item) => lowered.includes(item));

    return {
      detected: evidence.length > 0,
      evidence,
      softSignals
    };
  }

  private async waitForSubmissionOutcome(
    page: AdapterRunContext["page"],
    scope: AshbyInteractionScope,
    config: AshbyConfig,
    confirmationPatterns: string[],
    successUrlPatterns: string[]
  ): Promise<SubmitOutcome> {
    const seconds = Math.max(5, config.submissionPollSeconds ?? 45);
    let noValidationStreak = 0;

    for (let second = 0; second < seconds; second += 1) {
      const currentUrl = page.url();
      const scopeUrl = scope.url();
      const strictUrlMatch =
        ashbyUrlMatchesSuccess(currentUrl, successUrlPatterns) || ashbyUrlMatchesSuccess(scopeUrl, successUrlPatterns);
      const navigatedAboutBlank =
        currentUrl.toLowerCase().startsWith("about:blank") || scopeUrl.toLowerCase().startsWith("about:blank");

      const confirmationTextSignals = await this.readConfirmationTextSignals(page, scope, confirmationPatterns);
      const strictTextMatch = confirmationTextSignals.strictMatch;

      const validationErrors = await this.readValidationErrors(scope, confirmationPatterns, config.requiredFieldSelectors);
      let activeValidationErrors: string[] = [];
      if (validationErrors.length > 0 && second >= 2) {
        activeValidationErrors = await this.filterActiveValidationErrors(scope, validationErrors, config.requiredFieldSelectors);
      }
      noValidationStreak = activeValidationErrors.length === 0 ? noValidationStreak + 1 : 0;

      const challengeSignals = await this.detectBotChallenge(scope, config.challengeSelectors);

      const submitVisible = await this.isSubmitButtonVisible(scope);
      const visibleFormControls = await this.hasVisibleApplicationFields(scope);
      const classified = ashbyClassifySubmissionOutcome({
        strictUrlMatch,
        strictTextMatch,
        blockedByBot: challengeSignals.detected,
        activeValidationErrors,
        submitVisible,
        visibleFormControls,
        softCompletionTextMatch: confirmationTextSignals.softPattern ?? (navigatedAboutBlank ? "about_blank_post_submit" : null),
        noValidationStreak,
        secondsSinceSubmit: second,
        strictUrlEvidence: scopeUrl || currentUrl
      });

      if (classified.outcome === "confirmed") {
        return {
          confirmed: true,
          blockedByBot: false,
          validationErrors: [],
          confirmationEvidence: classified.confirmationEvidence ?? "strict:confirmation_text_detected"
        };
      }

      if (classified.outcome === "validation_error") {
        return { confirmed: false, blockedByBot: false, validationErrors: activeValidationErrors };
      }

      if (classified.outcome === "blocked_bot_challenge") {
        return {
          confirmed: false,
          blockedByBot: true,
          validationErrors: [],
          confirmationEvidence: "bot_challenge_marker_detected",
          challengeEvidence: challengeSignals.evidence
        };
      }

      await page.waitForTimeout(1000);
    }

    return { confirmed: false, blockedByBot: false, validationErrors: [] };
  }

  private async readConfirmationTextSignals(
    page: Page,
    scope: AshbyInteractionScope,
    confirmationPatterns: string[]
  ): Promise<{ strictMatch: boolean; softPattern: string | null }> {
    const scopeText = await this.readBodyText(scope);
    const pageText = scope === page ? "" : await this.readBodyText(page);
    const ashbyFrameTexts = await Promise.all(
      page
        .frames()
        .filter((frame) => frame !== page.mainFrame() && /ashbyhq\.com|jobs\.ashbyhq\.com/i.test(frame.url()))
        .slice(0, 4)
        .map((frame) => this.readBodyText(frame))
    );
    const allTexts = [scopeText, pageText, ...ashbyFrameTexts].filter((value) => value.length > 0);
    const strictMatch = allTexts.some((text) => ashbyHasConfirmationText(text, confirmationPatterns));
    if (strictMatch) return { strictMatch: true, softPattern: null };

    const softPattern =
      DEFAULT_SOFT_COMPLETION_TEXT_PATTERNS.find((pattern) =>
        allTexts.some((text) => text.toLowerCase().includes(pattern.toLowerCase()))
      ) ?? null;
    return { strictMatch: false, softPattern };
  }

  private async readBodyText(scope: AshbyInteractionScope): Promise<string> {
    return scope
      .locator("body")
      .innerText()
      .then((text) => text.slice(0, 6000))
      .catch(() => "");
  }

  private async isSubmitButtonVisible(scope: AshbyInteractionScope): Promise<boolean> {
    const submit = await this.findSubmitButton(scope);
    if (!submit) return false;
    return submit.isVisible().catch(() => false);
  }

  private async readValidationErrors(
    scope: AshbyInteractionScope,
    confirmationPatterns: string[],
    extraSelectors: string[] | undefined
  ): Promise<string[]> {
    const selectors = this.mergeUnique(DEFAULT_REQUIRED_FIELD_SELECTORS, extraSelectors ?? []);
    const texts = await scope
      .locator(selectors.join(","))
      .allTextContents()
      .then((items) => ashbyExtractValidationErrors(items, confirmationPatterns))
      .catch(() => [] as string[]);

    return texts;
  }

  private async filterActiveValidationErrors(
    scope: AshbyInteractionScope,
    validationErrors: string[],
    extraSelectors: string[] | undefined
  ): Promise<string[]> {
    const missingLabels = this.parseMissingRequiredFieldLabels(validationErrors);
    if (missingLabels.length === 0) return validationErrors;
    const currentlyMissing = await this.detectMissingRequiredFields(scope, extraSelectors);
    const activeLabels = missingLabels.filter((label) =>
      currentlyMissing.some((candidate) => this.labelsRoughlyMatch(candidate, label))
    );
    if (activeLabels.length === 0) return [];
    return validationErrors.filter((error) => activeLabels.some((label) => this.labelsRoughlyMatch(error, label)));
  }

  private async evaluatePreSubmitGate(
    scope: AshbyInteractionScope,
    config: AshbyConfig,
    confirmationPatterns: string[],
    knownUnresolved: string[] = []
  ): Promise<AshbyPreSubmitGateStatus> {
    const missingRequiredFields = await this.detectMissingRequiredFields(scope, config.requiredFieldSelectors);
    const sectionRequiredFields = await this.listRequiredSectionUnfilledLabels(scope);
    const validationErrors = await this.readValidationErrors(scope, confirmationPatterns, config.requiredFieldSelectors);
    const parsedValidationLabels = this.parseMissingRequiredFieldLabels(validationErrors);
    const invalidControls = this.mergeUnique(validationErrors);
    const requiredUnresolved = this.mergeUnique(
      knownUnresolved,
      sectionRequiredFields,
      missingRequiredFields,
      parsedValidationLabels
    );
    if (await this.isSystemLocationRequiredAndUnanswered(scope)) {
      requiredUnresolved.push("Location");
    }
    const blockerLabels = this.mergeUnique(requiredUnresolved, invalidControls);
    return {
      blockerLabels,
      invalidControls,
      requiredUnresolved
    };
  }

  private async isSystemLocationRequiredAndUnanswered(scope: AshbyInteractionScope): Promise<boolean> {
    return scope
      .evaluate(() => {
        const normalize = (value: string) => String(value || "").replace(/\s+/g, " ").trim();
        const field = document.querySelector('[data-field-path="_systemfield_location"]');
        if (!(field instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(field);
        const rect = field.getBoundingClientRect();
        const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        if (!visible) return false;
        const title = field.querySelector(".ashby-application-form-question-title");
        const titleText = normalize(title?.textContent || "");
        const requiredByTitle = /(^|\s)\*(\s|$)/.test(titleText) || Boolean(title?.className.includes("_required_"));
        const input = field.querySelector("input[role='combobox'], input[type='text'], input:not([type])") as HTMLInputElement | null;
        if (!input) return requiredByTitle;
        const requiredByControl = input.hasAttribute("required") || input.getAttribute("aria-required") === "true";
        if (!requiredByTitle && !requiredByControl) return false;
        return !normalize(input.value);
      })
      .catch(() => false);
  }

  private async captureChallengeEvidence(
    page: AdapterRunContext["page"],
    result: JobRunResult,
    config: AdapterRunContext["config"],
    phase: string
  ): Promise<void> {
    const evidencePath = path.join(config.screenshotsDir, `ashby-bot-challenge-${phase}-${Date.now()}.png`);
    await page.screenshot({ path: evidencePath, fullPage: true }).catch(() => undefined);
    result.screenshotPaths.push(evidencePath);
  }

  private async isInactivePosting(page: AdapterRunContext["page"]): Promise<boolean> {
    const body = await page
      .locator("body")
      .innerText()
      .then((text) => text.slice(0, 6000).toLowerCase())
      .catch(() => "");
    return INACTIVE_POSTING_TEXT_PATTERNS.some((pattern) => body.includes(pattern));
  }

  private mergeUnique(...groups: string[][]): string[] {
    const out = groups
      .flat()
      .map((value) => normalizeWhitespace(String(value)))
      .filter(Boolean)
      .slice(0, 12);
    return [...new Set(out)];
  }

  private answerHasValue(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.some((item) => String(item ?? "").trim().length > 0);
    if (typeof value === "boolean") return true;
    return String(value).trim().length > 0;
  }

  private parseMissingRequiredFieldLabels(validationErrors: string[]): string[] {
    return validationErrors
      .map((item) => {
        const match = item.match(/missing entry for required field:\s*(.+)$/i);
        return match?.[1]?.trim() ?? "";
      })
      .filter(Boolean);
  }

  private areValidationBlockersLocationOnly(rawMessages: string[]): boolean {
    if (!rawMessages.length) return false;
    const parsed = this.parseMissingRequiredFieldLabels(rawMessages);
    const labels = (parsed.length > 0 ? parsed : rawMessages)
      .map((item) => normalizeWhitespace(String(item ?? "")))
      .filter(Boolean);
    if (!labels.length) return false;
    return labels.every((label) => {
      const normalized = this.normalize(label);
      return this.isLocationPrompt(normalized) || normalized === "location" || normalized.includes("current country of residence");
    });
  }

  private resolveEffectiveAnswerForField(
    field: DetectedField,
    raw: ResolvedAnswer | undefined,
    profile: CandidateProfile,
    company?: string,
    jobTitle?: string,
    companyContext?: string,
    postingLocation?: string,
    ashbyConfig?: AshbyConfig,
    requiredDeterministicOnly: boolean = false
  ): ResolvedAnswer | undefined {
    const profileMapped = this.resolveProfilePromptValue(field, profile, postingLocation, ashbyConfig);
    if (profileMapped && this.answerHasValue(profileMapped.value)) {
      return {
        questionId: field.id,
        value: profileMapped.value,
        source: profileMapped.source,
        reason: profileMapped.reason
      };
    }

    if (raw && raw.source === "llm" && this.isOpenEndedPrompt(field) && this.answerHasValue(raw.value)) {
      const text = String(raw.value ?? "").trim();
      if (this.isInvalidNarrativeAnswer(text)) {
        const strengthened = this.buildNarrativeFallback(field.label, profile, company, jobTitle);
        if (this.answerHasValue(strengthened)) {
          return {
            questionId: field.id,
            value: strengthened,
            source: "fallback",
            reason: "narrative_quality_guardrail"
          };
        }
      }
    }

    const normalizedLabel = this.normalize(field.label);
    if (raw && this.isInternshipAgreementPrompt(normalizedLabel)) {
      const rawText = this.normalize(String(raw.value ?? ""));
      const schoolTokens = this.mergeUnique(
        [String(profile.education?.school ?? "")],
        [String(profile.education?.university ?? "")]
      )
        .map((item) => this.normalize(item))
        .filter(Boolean);
      if (raw.source === "profile" || schoolTokens.some((token) => token && rawText.includes(token))) {
        return undefined;
      }
    }

    if (!requiredDeterministicOnly || !field.required) {
      return raw;
    }

    const question: ApplicationQuestion = {
      id: field.id,
      label: field.label,
      type: field.type,
      required: field.required,
      options: field.options,
      placeholder: field.placeholder,
      platformMeta: field.platformMeta
    };

    const deterministic = evaluateDeterministicRule(question, profile);
    if (deterministic.answer !== undefined && deterministic.answer !== null) {
      return {
        questionId: field.id,
        value: deterministic.answer,
        source: deterministic.source ?? "rule",
        reason: deterministic.reason ?? "deterministic_required"
      };
    }

    const mapped = evaluateProfileMapping(question, profile);
    if (mapped.answer !== undefined && mapped.answer !== null) {
      return {
        questionId: field.id,
        value: mapped.answer,
        source: mapped.source ?? "profile",
        reason: mapped.reason ?? "profile_required"
      };
    }

    return raw;
  }

  private isInvalidNarrativeAnswer(text: string): boolean {
    const normalized = this.normalize(text);
    if (!normalized) return true;
    if (normalized.length < 80) return true;
    if (["yes", "no", "true", "false"].includes(normalized)) return true;
    return false;
  }

  private normalizeAnswerForField(
    field: DetectedField,
    value: ResolvedAnswer["value"] | undefined
  ): string | string[] | boolean | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;

    if (field.type === "boolean") {
      if (typeof value === "boolean") return value;
      if (Array.isArray(value)) return this.normalizeAnswerForField(field, value[0] ?? null);
      const normalized = String(value).trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(normalized)) return true;
      if (["false", "no", "n", "0"].includes(normalized)) return false;
      return null;
    }

    if (typeof value === "boolean") {
      if (field.type === "single_select") {
        return this.pickOptionForYesNo(field.options, this.normalize(field.label), value ? "yes" : "no") ?? null;
      }
      return null;
    }

    if (Array.isArray(value)) {
      const sanitized = value.map((item) => String(item ?? "").trim()).filter(Boolean);
      if (field.type === "multi_select") return sanitized;
      return this.normalizeAnswerForField(field, sanitized[0] ?? null);
    }

    const text = String(value).trim();
    const normalizedText = text.toLowerCase();
    if (field.type === "single_select" && ["true", "false", "yes", "no"].includes(normalizedText)) {
      const wantsYes = normalizedText === "yes" || normalizedText === "true";
      const mapped = this.pickOptionForYesNo(field.options, this.normalize(field.label), wantsYes ? "yes" : "no");
      return mapped ?? null;
    }
    if (field.type === "text" && ["true", "false"].includes(normalizedText)) {
      return null;
    }
    if (field.type === "textarea" && ["yes", "no", "true", "false"].includes(normalizedText)) {
      return null;
    }
    const looksNarrativePrompt =
      field.type === "textarea" ||
      this.isCompanyUnderstandingPrompt(field.label) ||
      this.normalize(field.label).includes("tell us about") ||
      this.normalize(field.label).includes("describe a time") ||
      this.normalize(field.label).includes("what interests you") ||
      this.normalize(field.label).includes("why this role") ||
      this.normalize(field.label).includes("why this company") ||
      this.normalize(field.label).includes("specific contribution");
    if (looksNarrativePrompt && ["yes", "no", "true", "false"].includes(normalizedText)) {
      return null;
    }
    return text.length > 0 ? text : null;
  }

  private normalizeMatchToken(value: string): string {
    return String(value).toLowerCase().replace(/\s+/g, " ").trim();
  }

  private repairOptionChoice(
    wanted: string,
    options: string[]
  ): { value: string | null; strategy: "exact" | "normalized" | "fuzzy" | "invalid" } {
    const raw = String(wanted ?? "").trim();
    if (!raw) return { value: null, strategy: "invalid" };

    const exact = options.find((option) => option === raw);
    if (exact) return { value: exact, strategy: "exact" };

    const normalizedWanted = this.normalizeMatchToken(raw);
    const normalized = options.find((option) => this.normalizeMatchToken(option) === normalizedWanted);
    if (normalized) return { value: normalized, strategy: "normalized" };

    const fuzzy = options
      .map((option) => ({ option, normalized: this.normalizeMatchToken(option) }))
      .filter((item) => item.normalized.includes(normalizedWanted) || normalizedWanted.includes(item.normalized))
      .sort((a, b) => b.normalized.length - a.normalized.length)[0];
    if (fuzzy) return { value: fuzzy.option, strategy: "fuzzy" };

    return { value: null, strategy: "invalid" };
  }

  private validateAndRepairFieldAnswer(
    field: DetectedField,
    value: string | string[] | boolean | null | undefined
  ): {
    value: string | string[] | boolean | null | undefined;
    repaired: boolean;
    invalid: boolean;
    reason?: string;
  } {
    if (value === undefined || value === null) return { value, repaired: false, invalid: false };
    if (!Array.isArray(field.options) || field.options.length === 0) return { value, repaired: false, invalid: false };

    if (field.type === "single_select") {
      const token = Array.isArray(value) ? String(value[0] ?? "") : String(value);
      const repaired = this.repairOptionChoice(token, field.options);
      if (!repaired.value) {
        return { value: null, repaired: false, invalid: true, reason: "llm_option_not_in_dom_options" };
      }
      return { value: repaired.value, repaired: repaired.strategy !== "exact", invalid: false };
    }

    if (field.type === "multi_select") {
      const tokens = Array.isArray(value) ? value.map((item) => String(item ?? "")) : [String(value)];
      const selected: string[] = [];
      const invalidTokens: string[] = [];
      let repairedAny = false;
      for (const token of tokens) {
        const repaired = this.repairOptionChoice(token, field.options);
        if (!repaired.value) {
          invalidTokens.push(token);
          continue;
        }
        if (repaired.strategy !== "exact") repairedAny = true;
        if (!selected.some((item) => this.normalize(item) === this.normalize(repaired.value!))) {
          selected.push(repaired.value!);
        }
      }
      if (!selected.length) {
        return {
          value: null,
          repaired: false,
          invalid: true,
          reason: `llm_options_not_in_dom_options:${invalidTokens.join(",") || "none"}`
        };
      }
      return {
        value: selected,
        repaired: repairedAny || invalidTokens.length > 0 || selected.length !== tokens.length,
        invalid: false,
        reason: invalidTokens.length > 0 ? `llm_options_partially_repaired:${invalidTokens.join(",")}` : undefined
      };
    }

    return { value, repaired: false, invalid: false };
  }

  private isOpenEndedPrompt(field: Pick<DetectedField, "type" | "label" | "options">): boolean {
    if (field.type !== "text" && field.type !== "textarea") return false;
    if (field.options?.length) return false;
    if (this.isProfilePromptLike(field.label)) return false;
    const label = this.normalize(field.label);
    if (
      label === "name" ||
      label.includes("full legal name") ||
      label.includes("full name") ||
      label.includes("legal name") ||
      label.includes("email") ||
      label.includes("phone") ||
      label.includes("linkedin") ||
      label.includes("github") ||
      label.includes("portfolio") ||
      label.includes("website")
    ) {
      return false;
    }
    return (
      field.type === "textarea" ||
      label.includes("what interests you") ||
      label.includes("tell us about") ||
      label.includes("describe a time") ||
      label.includes("describe") ||
      label.includes("how did you") ||
      label.includes("how would you") ||
      label.includes("why this role") ||
      label.includes("why this company") ||
      label.includes("specific contribution") ||
      label.includes("program") ||
      label.includes("funnel") ||
      label.includes("bottleneck") ||
      label.includes("last thing") ||
      label.includes("built or automated")
    );
  }

  private sanitizeValueForField(
    field: DetectedField,
    value: string | string[] | boolean | null | undefined
  ): string | string[] | boolean | null {
    if (value === null || value === undefined) return null;
    if (field.type === "boolean") return value;

    const mapYesNoOption = (wantsYes: boolean): string | null => {
      const mapped = this.pickOptionForYesNo(field.options, this.normalize(field.label), wantsYes ? "yes" : "no");
      return mapped ?? (field.type === "single_select" ? (wantsYes ? "Yes" : "No") : null);
    };

    if (typeof value === "boolean") {
      if (field.type === "single_select") return mapYesNoOption(value);
      return null;
    }

    if (Array.isArray(value)) {
      if (field.type === "multi_select") return value;
      return this.sanitizeValueForField(field, value[0] ?? null);
    }

    const text = String(value).trim();
    const normalized = text.toLowerCase();
    if (["true", "false", "yes", "no"].includes(normalized)) {
      const wantsYes = normalized === "true" || normalized === "yes";
      if (field.type === "single_select") return mapYesNoOption(wantsYes);
      return null;
    }
    return value;
  }

  private toQuestionTypeFromDomFieldType(fieldType: AshbyDomFieldType): QuestionType {
    if (fieldType === "textarea") return "textarea";
    if (fieldType === "file") return "file";
    if (fieldType === "radio" || fieldType === "combobox" || fieldType === "yes_no") return "single_select";
    if (fieldType === "checkbox_group") return "multi_select";
    if (fieldType === "text" || fieldType === "date") return "text";
    return "unknown";
  }

  private toDetectedFieldTypeFromDomFieldType(fieldType: AshbyDomFieldType): DetectedField["type"] {
    if (fieldType === "textarea") return "textarea";
    if (fieldType === "file") return "file";
    if (fieldType === "radio" || fieldType === "combobox" || fieldType === "yes_no") return "single_select";
    if (fieldType === "checkbox_group") return "multi_select";
    if (fieldType === "text" || fieldType === "date") return "text";
    return "text";
  }

  private buildPreviousAttemptForLabel(result: JobRunResult, label: string, validationError: string): AshbyFailedFieldRecoverySchema["previousAttempt"] {
    const normalizedLabel = this.normalize(label);
    const last = [...result.filledFields]
      .reverse()
      .find((item) => this.normalize(item.label) === normalizedLabel || this.normalize(item.label).includes(normalizedLabel));
    if (!last) {
      return {
        answer: null,
        selectedOptions: [],
        failureReason: validationError
      };
    }
    return {
      answer: String(last.value ?? ""),
      selectedOptions: String(last.value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      failureReason: validationError
    };
  }

  private buildLocationLikeComboboxQuery(
    profile: CandidateProfile,
    previousAttempt?: AshbyFailedFieldRecoverySchema["previousAttempt"]
  ): string {
    const previous = String(previousAttempt?.answer ?? "").trim();
    if (previous) return previous;
    const structuredCity = String(profile.locationStructured?.city ?? "").trim();
    if (structuredCity) return structuredCity;
    const basicsLocation = String(profile.basics.location ?? "").trim();
    if (basicsLocation) return basicsLocation.split(",")[0]?.trim() ?? basicsLocation;
    return "San";
  }

  private async collectComboboxOptionsForRecovery(
    scope: AshbyInteractionScope,
    schema: AshbyFailedFieldRecoverySchema,
    profile: CandidateProfile
  ): Promise<{ options: string[]; queryUsed: string }> {
    const fieldPath = schema.fieldPath;
    const queryUsed = this.buildLocationLikeComboboxQuery(profile, schema.previousAttempt);
    if (!fieldPath) return { options: [], queryUsed };
    const field = scope.locator(`[data-field-path="${fieldPath.replace(/"/g, '\\"')}"]`).first();
    const combo = field.locator("input[role='combobox'], input[aria-autocomplete='list']").first();
    const visible = await combo.isVisible().catch(() => false);
    if (!visible) return { options: [], queryUsed };
    await combo.click().catch(() => undefined);
    await combo.fill("").catch(() => undefined);
    await combo.type(DEFAULT_ASHBY_UNKNOWN_OPTION_PROBE_CHAR, { delay: 70 }).catch(() => undefined);
    await scope.waitForTimeout(DEFAULT_ASHBY_UNKNOWN_OPTION_PROBE_WAIT_MS).catch(() => undefined);
    await combo.press("Backspace").catch(() => undefined);
    await scope.waitForTimeout(DEFAULT_ASHBY_UNKNOWN_OPTION_PROBE_WAIT_MS).catch(() => undefined);
    const listboxId = String((await combo.getAttribute("aria-controls").catch(() => "")) ?? "").trim();
    const scopedOptions = listboxId
      ? await this.collectRoleOptionsFromLocator(
          scope,
          `[id="${listboxId.replace(/"/g, '\\"')}"] [role='option']`
        )
      : [];
    if (scopedOptions.length > 0) return { options: scopedOptions, queryUsed };
    const globalOptions = await this.collectRoleOptionsFromLocator(scope, "[role='option']");
    if (globalOptions.length > 0) return { options: globalOptions, queryUsed };
    const resultContainerOptions = await this.collectRoleOptionsFromLocator(
      scope,
      "[class*='resultContainer'] [role='option']"
    );
    return { options: resultContainerOptions, queryUsed };
  }

  private async extractSingleFieldSchemaFromLiveDom(
    scope: AshbyInteractionScope,
    errorText: string,
    profile: CandidateProfile,
    previousAttempt: AshbyFailedFieldRecoverySchema["previousAttempt"],
    preferredFieldPath?: string
  ): Promise<AshbyFailedFieldRecoverySchema | null> {
    const normalizedError = this.normalize(errorText);
    const extracted = await scope
      .evaluate(({ normalizedErrorText, preferredPath }) => {
        const normalize = (value: string) => String(value || "").replace(/\s+/g, " ").trim();
        const normalizeLower = (value: string) => normalize(value).toLowerCase();
        const buildIdentity = (block: HTMLElement | null): string => {
          if (!block) return "";
          const fieldPath = normalizeLower(block.getAttribute("data-field-path") || "") || "no_field_path";
          const firstInput = block.querySelector("input[type='radio'], input[type='checkbox']") as HTMLInputElement | null;
          const groupName = normalizeLower(firstInput?.name || "") || "no_group_name";
          const optionLabels = Array.from(block.querySelectorAll("label, button, [role='radio'], [role='option'], option"))
            .map((node) => normalizeLower((node as HTMLElement).innerText || node.textContent || ""))
            .filter(Boolean)
            .sort()
            .join("|") || "no_options";
          return `group:${fieldPath}::${groupName}::${optionLabels}`;
        };
        const visible = (el: Element | null) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const labelForInput = (input: HTMLInputElement): string => {
          const parentLabel = normalize(input.closest("label")?.textContent || "");
          if (parentLabel) return parentLabel;
          if (input.id) {
            const byFor = normalize((document.querySelector(`label[for="${CSS.escape(input.id)}"]`) as HTMLElement | null)?.textContent || "");
            if (byFor) return byFor;
          }
          return normalize(input.getAttribute("aria-label") || input.value || input.name || "");
        };
        const blocks = Array.from(document.querySelectorAll("[data-field-path], fieldset, .ashby-application-form-field-entry"))
          .filter((node) => node instanceof HTMLElement && visible(node as HTMLElement)) as HTMLElement[];
        if (!blocks.length) return null;
        const resolveFieldPath = (block: HTMLElement): string => {
          const fromData = normalize(block.getAttribute("data-field-path") || "");
          if (fromData) return fromData;
          const title = block.querySelector(".ashby-application-form-question-title") as HTMLElement | null;
          const fromFor = normalize(title?.getAttribute("for") || "");
          if (fromFor) return fromFor;
          const labelText = normalize(title?.textContent || (block.querySelector("legend, label") as HTMLElement | null)?.textContent || "");
          return labelText ? `label_${normalizeLower(labelText).replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "")}` : "";
        };

        const withMeta = blocks.map((block) => {
          const title =
            normalize(block.querySelector(".ashby-application-form-question-title")?.textContent || "") ||
            normalize((block.querySelector("label") as HTMLElement | null)?.textContent || "") ||
            normalize(block.getAttribute("data-field-path") || "");
          return {
            block,
            label: title,
            normalizedLabel: normalizeLower(title),
            fieldPath: resolveFieldPath(block)
          };
        });
        const isLocationAvailabilityError =
          normalizedErrorText.includes("location") &&
          (normalizedErrorText.includes("work from") || normalizedErrorText.includes("available"));
        const isLocationAvailabilityCandidate = (item: (typeof withMeta)[number]) => {
          const optionText = normalizeLower(
            Array.from(item.block.querySelectorAll("label, button, [role='radio'], [role='checkbox'], [role='option'], option"))
              .map((node) => (node as HTMLElement).innerText || node.textContent || "")
              .join(" ")
          );
          const labelOrPath = `${item.normalizedLabel} ${normalizeLower(item.fieldPath)}`;
          if (labelOrPath.includes("location") || labelOrPath.includes("work from") || labelOrPath.includes("office")) return true;
          if (/(paris|bordeaux|barcelona|berlin|london|remote|hybrid|onsite|on-site)/.test(optionText)) return true;
          return false;
        };
        const candidatePool = isLocationAvailabilityError
          ? withMeta.filter((item) => isLocationAvailabilityCandidate(item))
          : withMeta;
        const activePool = candidatePool.length > 0 ? candidatePool : withMeta;
        const checkboxFieldsets = blocks
          .filter((block) => block.tagName === "FIELDSET")
          .filter((block) => {
            const title = block.querySelector("label.ashby-application-form-question-title, .ashby-application-form-question-title, legend, label");
            const checkboxes = block.querySelectorAll("input[type='checkbox']");
            return Boolean(title) && checkboxes.length > 0;
          });
        const fieldsetMatch = checkboxFieldsets
          .map((fieldset) => {
            const title = fieldset.querySelector("label.ashby-application-form-question-title, .ashby-application-form-question-title, legend, label") as HTMLElement | null;
            const label = normalize(title?.textContent || "");
            const normalizedLabel = normalizeLower(label);
            const fieldPath = normalize(title?.getAttribute("for") || "") || `label_${normalizedLabel.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "")}`;
            const overlapTokens = normalizedLabel.split(/\s+/).filter((token) => token.length > 2);
            const score = overlapTokens.filter((token) => normalizedErrorText.includes(token)).length;
            return { fieldset, title, label, normalizedLabel, fieldPath, score };
          })
          .sort((a, b) => b.score - a.score)[0];
        if (
          fieldsetMatch &&
          fieldsetMatch.label &&
          (normalizedErrorText.includes(fieldsetMatch.normalizedLabel) || fieldsetMatch.score >= 3)
        ) {
          const checkboxes = Array.from(fieldsetMatch.fieldset.querySelectorAll("input[type='checkbox']")) as HTMLInputElement[];
          const options = checkboxes
            .map((input) => {
              const id = String(input.id || "");
              const optionLabel = id
                ? (fieldsetMatch.fieldset.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLElement | null)
                : null;
              return normalize(optionLabel?.textContent || input.getAttribute("name") || "");
            })
            .filter(Boolean);
          return {
            fieldPath: fieldsetMatch.fieldPath,
            label: fieldsetMatch.label,
            required: Boolean(
              fieldsetMatch.title?.className?.toLowerCase().includes("required") ||
                /required/.test(normalizeLower(fieldsetMatch.fieldset.innerText || ""))
            ),
            fieldType: "checkbox_group" as AshbyDomFieldType,
            possibleAnswers: Array.from(new Set(options)),
            currentValue: checkboxes
              .filter((item) => item.checked)
              .map((input) => {
                const id = String(input.id || "");
                const optionLabel = id
                  ? (fieldsetMatch.fieldset.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLElement | null)
                  : null;
                return normalize(optionLabel?.textContent || input.getAttribute("name") || "");
              })
              .filter(Boolean),
            containerIdentity: buildIdentity(fieldsetMatch.fieldset),
            htmlSummary: JSON.stringify({
              label: fieldsetMatch.label,
              required: true,
              fieldPath: fieldsetMatch.fieldPath,
              controls: options
            })
          };
        }

        const exactTitle = Array.from(
          document.querySelectorAll(".ashby-application-form-question-title, legend, label")
        ).find((node) => {
          if (!(node instanceof HTMLElement)) return false;
          if (!visible(node)) return false;
          const text = normalizeLower(node.innerText || node.textContent || "");
          return text.length > 0 && text === normalizedErrorText;
        }) as HTMLElement | undefined;
        const matchingTextNode = (exactTitle ?? Array.from(
          document.querySelectorAll(".ashby-application-form-question-title, label, legend, p, span")
        ).find((node) => {
          if (!(node instanceof HTMLElement)) return false;
          if (!visible(node)) return false;
          const text = normalizeLower(node.innerText || node.textContent || "");
          if (!text) return false;
          return text.includes(normalizedErrorText) || normalizedErrorText.includes(text);
        })) as HTMLElement | undefined;
        if (matchingTextNode) {
          let directBlock = matchingTextNode.closest("[data-field-path], fieldset, .ashby-application-form-field-entry") as HTMLElement | null;
          if (!directBlock) {
            let cursor: HTMLElement | null = matchingTextNode;
            while (cursor && !directBlock) {
              if (
                visible(cursor) &&
                Boolean(cursor.querySelector("input, textarea, button, [role='radio'], [role='option']"))
              ) {
                directBlock = cursor;
                break;
              }
              cursor = cursor.parentElement;
            }
          }
          if (directBlock) {
            const blockLabel =
              normalize(directBlock.querySelector(".ashby-application-form-question-title")?.textContent || "") ||
              normalize((directBlock.querySelector("label") as HTMLElement | null)?.textContent || "") ||
              normalize(directBlock.getAttribute("data-field-path") || "");
            const blockLabelTokens = new Set(normalizeLower(blockLabel).split(/\s+/).filter((token) => token.length > 2));
            const errorTokens = new Set(normalizedErrorText.split(/\s+/).filter((token) => token.length > 2));
            let overlap = 0;
            for (const token of blockLabelTokens) {
              if (errorTokens.has(token)) overlap += 1;
            }
            if (normalizedErrorText.length > 0 && overlap === 0) {
              directBlock = null;
            }
          }
          if (directBlock) {
            const blockLabel =
              normalize(directBlock.querySelector(".ashby-application-form-question-title")?.textContent || "") ||
              normalize((directBlock.querySelector("label") as HTMLElement | null)?.textContent || "") ||
              normalize(directBlock.getAttribute("data-field-path") || "");
            const directPath = resolveFieldPath(directBlock);
            const directMatch = withMeta.find((item) => item.block === directBlock);
            if (directMatch) {
              directMatch.label = blockLabel;
              directMatch.normalizedLabel = normalizeLower(blockLabel);
              directMatch.fieldPath = directPath;
            } else {
              withMeta.unshift({
                block: directBlock,
                label: blockLabel,
                normalizedLabel: normalizeLower(blockLabel),
                fieldPath: directPath
              });
            }
          }
        }

        let best = preferredPath
          ? activePool.find((item) => item.fieldPath && normalizeLower(item.fieldPath) === normalizeLower(preferredPath))
          : undefined;
        if (!best) {
          if (normalizedErrorText.includes("available") && normalizedErrorText.includes("work from")) {
            const availabilityCandidate = activePool
              .map((item) => ({
                item,
                hasAvailabilityLabel:
                  item.normalizedLabel.includes("available") &&
                  item.normalizedLabel.includes("work from")
              }))
              .find((entry) => entry.hasAvailabilityLabel);
            if (availabilityCandidate) {
              best = availabilityCandidate.item;
            }
          }
        }
        if (!best) {
          best = activePool.find((item) => item.normalizedLabel && (normalizedErrorText.includes(item.normalizedLabel) || item.normalizedLabel.includes(normalizedErrorText)));
        }
        if (!best) {
          best = activePool
            .map((item) => {
              const left = new Set(item.normalizedLabel.split(/\s+/).filter((token) => token.length > 2));
              const right = new Set(normalizedErrorText.split(/\s+/).filter((token) => token.length > 2));
              let overlap = 0;
              for (const token of left) if (right.has(token)) overlap += 1;
              return { item, score: overlap };
            })
            .sort((a, b) => b.score - a.score)[0]?.item;
        }
        if (!best) return null;

        const block = best.block;
        const textarea = block.querySelector("textarea");
        const file = block.querySelector("input[type='file']");
        const combo = block.querySelector("input[role='combobox'], input[aria-autocomplete='list']");
        const radios = Array.from(block.querySelectorAll("input[type='radio']")) as HTMLInputElement[];
        const checkboxes = Array.from(block.querySelectorAll("input[type='checkbox']")) as HTMLInputElement[];
        const choiceButtons = Array.from(block.querySelectorAll("button, [role='radio'], [role='option']"))
          .map((node) => normalize((node as HTMLElement).innerText || (node as HTMLElement).textContent || (node as HTMLElement).getAttribute("aria-label") || ""))
          .filter((text) => text.length > 0 && text.length < 80);
        const uniqueChoiceButtons = Array.from(new Set(choiceButtons));
        const yesButton = Array.from(block.querySelectorAll("button")).find((button) => normalizeLower((button as HTMLElement).innerText || "") === "yes");
        const noButton = Array.from(block.querySelectorAll("button")).find((button) => normalizeLower((button as HTMLElement).innerText || "") === "no");
        const input = block.querySelector("input:not([type='hidden'])") as HTMLInputElement | null;

        let fieldType: AshbyDomFieldType = "unknown";
        if (textarea) fieldType = "textarea";
        else if (file) fieldType = "file";
        else if (combo) fieldType = "combobox";
        else if (radios.length > 0) fieldType = "radio";
        else if (uniqueChoiceButtons.length > 1) fieldType = "radio";
        else if (yesButton && noButton) fieldType = "yes_no";
        else if (checkboxes.length > 1) fieldType = "checkbox_group";
        else if (input && /(pick date|mm\/dd\/yyyy|date)/i.test(`${input.placeholder || ""} ${input.value || ""}`)) fieldType = "date";
        else if (input) fieldType = "text";

        const possibleAnswers: string[] = [];
        if (fieldType === "radio") {
          if (radios.length > 0) {
            radios.forEach((radio) => {
              const label = labelForInput(radio);
              if (label) possibleAnswers.push(label);
            });
          } else {
            uniqueChoiceButtons.forEach((label) => possibleAnswers.push(label));
          }
        } else if (fieldType === "checkbox_group") {
          checkboxes.forEach((checkbox) => {
            const label = labelForInput(checkbox);
            if (label) possibleAnswers.push(label);
          });
        } else if (fieldType === "yes_no") {
          possibleAnswers.push("Yes", "No");
        }

        let currentValue: string | string[] | null = null;
        if (fieldType === "textarea") {
          currentValue = normalize((textarea as HTMLTextAreaElement).value || "");
        } else if (fieldType === "text" || fieldType === "date" || fieldType === "combobox") {
          currentValue = normalize((input?.value || (combo as HTMLInputElement | null)?.value || ""));
        } else if (fieldType === "radio") {
          if (radios.length > 0) {
            const checked = radios.find((radio) => radio.checked);
            currentValue = checked ? labelForInput(checked) : null;
          } else {
            const selectedButton = Array.from(
              block.querySelectorAll("button[aria-pressed='true'], button[aria-checked='true'], button[aria-selected='true'], [role='radio'][aria-checked='true'], [role='option'][aria-selected='true']")
            )
              .map((node) => normalize((node as HTMLElement).innerText || (node as HTMLElement).textContent || (node as HTMLElement).getAttribute("aria-label") || ""))
              .find(Boolean);
            currentValue = selectedButton || null;
          }
        } else if (fieldType === "checkbox_group") {
          currentValue = checkboxes.filter((item) => item.checked).map((item) => labelForInput(item)).filter(Boolean);
        }

        const controls: Array<Record<string, string>> = [];
        if (fieldType === "radio") radios.forEach((radio) => controls.push({ type: "radio", label: labelForInput(radio), checked: radio.checked ? "true" : "false" }));
        if (fieldType === "checkbox_group") checkboxes.forEach((checkbox) => controls.push({ type: "checkbox", label: labelForInput(checkbox), checked: checkbox.checked ? "true" : "false" }));
        if (fieldType === "yes_no") controls.push({ type: "button", label: "Yes" }, { type: "button", label: "No" });
        if (fieldType === "combobox") controls.push({ type: "combobox", role: "combobox" });
        if (fieldType === "text") controls.push({ type: "text" });
        if (fieldType === "textarea") controls.push({ type: "textarea" });
        if (fieldType === "file") controls.push({ type: "file" });

        const required = Boolean(
          block.querySelector("[required]") ||
            block.querySelector(".ashby-application-form-question-title._required_") ||
            /required/.test(normalizeLower(block.innerText))
        );
        return {
          fieldPath: best.fieldPath,
          label: best.label || "Required Field",
          required,
          fieldType,
          possibleAnswers: Array.from(new Set(possibleAnswers.map((item) => normalize(item)).filter(Boolean))),
          currentValue,
          containerIdentity: buildIdentity(block),
          htmlSummary: JSON.stringify({
            label: best.label,
            controls,
            required,
            fieldPath: best.fieldPath
          })
        };
      }, { normalizedErrorText: normalizedError, preferredPath: preferredFieldPath ?? "" })
      .catch(() => null as any);
    if (!extracted) return null;
    const schema: AshbyFailedFieldRecoverySchema = {
      fieldPath: String(extracted.fieldPath || "").trim(),
      containerIdentity: String(extracted.containerIdentity || "").trim() || undefined,
      label: String(extracted.label || "").trim() || errorText,
      required: Boolean(extracted.required),
      fieldType: (String(extracted.fieldType || "unknown") as AshbyDomFieldType),
      possibleAnswers: Array.isArray(extracted.possibleAnswers) ? extracted.possibleAnswers.map((item: string) => String(item).trim()).filter(Boolean) : [],
      currentValue: Array.isArray(extracted.currentValue)
        ? extracted.currentValue.map((item: string) => String(item))
        : extracted.currentValue == null
          ? null
          : String(extracted.currentValue),
      validationError: errorText,
      previousAttempt,
      htmlSummary: String(extracted.htmlSummary || "")
    };
    if (schema.fieldType === "combobox") {
      const combo = await this.collectComboboxOptionsForRecovery(scope, schema, profile);
      if (combo.options.length > 0) schema.possibleAnswers = combo.options;
    }
    if (schema.fieldType === "file" && previousAttempt.answer) {
      schema.possibleAnswers = [previousAttempt.answer];
    }
    return schema;
  }

  private async extractSingleFieldSchemaFromValidationErrorNode(
    scope: AshbyInteractionScope,
    errorText: string,
    previousAttempt: AshbyFailedFieldRecoverySchema["previousAttempt"]
  ): Promise<AshbyFailedFieldRecoverySchema | null> {
    const extracted = await scope.evaluate(({ rawErrorText }) => {
      const normalize = (value: string) => String(value || "").replace(/\s+/g, " ").trim();
      const lower = (value: string) => normalize(value).toLowerCase();
      const visible = (el: Element | null) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const isControl = (node: Element) =>
        node.matches("input, textarea, button, [role='radio'], [role='checkbox'], [role='option'], [role='combobox']");
      const controlSelector = "input, textarea, button, [role='radio'], [role='checkbox'], [role='option'], [role='combobox']";
      const labelForInput = (input: HTMLInputElement): string => {
        const parentLabel = normalize(input.closest("label")?.textContent || "");
        if (parentLabel) return parentLabel;
        if (input.id) {
          const byFor = normalize((document.querySelector(`label[for="${CSS.escape(input.id)}"]`) as HTMLElement | null)?.textContent || "");
          if (byFor) return byFor;
        }
        return normalize(input.getAttribute("aria-label") || input.value || input.name || "");
      };
      const buildIdentity = (block: HTMLElement | null): string => {
        if (!block) return "";
        const fieldPath = lower(block.getAttribute("data-field-path") || "") || "no_field_path";
        const firstInput = block.querySelector("input[type='radio'], input[type='checkbox']") as HTMLInputElement | null;
        const groupName = lower(firstInput?.name || "") || "no_group_name";
        const optionLabels = Array.from(block.querySelectorAll("label, button, [role='radio'], [role='option'], option"))
          .map((node) => lower((node as HTMLElement).innerText || node.textContent || ""))
          .filter(Boolean)
          .sort()
          .join("|") || "no_options";
        return `group:${fieldPath}::${groupName}::${optionLabels}`;
      };
      const hasControls = (container: HTMLElement | null): container is HTMLElement => {
        if (!container) return false;
        return Array.from(container.querySelectorAll(controlSelector)).some((node) => isControl(node));
      };
      const describeContainer = (container: HTMLElement | null) =>
        normalize(container?.outerHTML || "").slice(0, 800);
      const resolveContainerFromNode = (
        startNode: HTMLElement | null
      ): { container: HTMLElement | null; strategy: "error_node_ancestor" | "aria_describedby" } => {
        if (!startNode) return { container: null, strategy: "error_node_ancestor" };
        const anchorCandidates: HTMLElement[] = [];
        let cursor: HTMLElement | null = startNode;
        while (cursor) {
          if (
            cursor.matches("[data-field-path], .ashby-application-form-field-entry, fieldset") ||
            (visible(cursor) && Boolean(cursor.querySelector(".ashby-application-form-question-title, legend, label")) && hasControls(cursor))
          ) {
            anchorCandidates.push(cursor);
          }
          cursor = cursor.parentElement;
        }
        for (const candidate of anchorCandidates) {
          if (hasControls(candidate)) return { container: candidate, strategy: "error_node_ancestor" };
        }
        return { container: null, strategy: "error_node_ancestor" };
      };

      const errorNeedles = ["required", "please", "this field"];
      const isLocationLikeText = (text: string): boolean => {
        const t = lower(text);
        return (
          (t.includes("location") && (t.includes("work from") || t.includes("available"))) ||
          t.includes("office preference") ||
          t.includes("where can you work")
        );
      };
      const containerScore = (candidate: HTMLElement | null, requestedText: string): number => {
        if (!candidate) return -1;
        const titleText =
          lower(candidate.querySelector(".ashby-application-form-question-title")?.textContent || "") ||
          lower((candidate.querySelector("legend, label") as HTMLElement | null)?.textContent || "") ||
          lower(candidate.getAttribute("data-field-path") || "");
        const optionText = lower(
          Array.from(candidate.querySelectorAll("label, button, [role='radio'], [role='checkbox'], [role='option'], option"))
            .map((node) => (node as HTMLElement).innerText || node.textContent || (node as HTMLElement).getAttribute("aria-label") || "")
            .join(" ")
        );
        let score = 0;
        if (requestedText && (titleText.includes(requestedText) || requestedText.includes(titleText))) score += 6;
        const requestedTokens = requestedText.split(/\s+/).filter((tok) => tok.length > 3);
        for (const tok of requestedTokens) {
          if (titleText.includes(tok)) score += 2;
          if (optionText.includes(tok)) score += 1;
        }
        if (isLocationLikeText(requestedText)) {
          if (isLocationLikeText(`${titleText} ${optionText}`)) score += 6;
          if (/(paris|bordeaux|barcelona|berlin|london|new york|san francisco|remote|hybrid)/.test(optionText)) score += 4;
          if (/(yes|no)/.test(optionText) && !/(paris|bordeaux|barcelona|berlin|london|new york|san francisco|remote|hybrid)/.test(optionText)) {
            score -= 6;
          }
        }
        return score;
      };
      const errorNodes = Array.from(document.querySelectorAll("form *"))
        .filter((node) => node instanceof HTMLElement && visible(node as HTMLElement))
        .map((node) => node as HTMLElement)
        .filter((node) => {
          const text = lower(node.innerText || node.textContent || "");
          return text.length > 0 && errorNeedles.some((needle) => text.includes(needle));
        });
      const ariaInvalidControls = Array.from(document.querySelectorAll("[aria-invalid='true']"))
        .filter((node) => node instanceof HTMLElement && visible(node as HTMLElement))
        .map((node) => node as HTMLElement);

      const requested = lower(rawErrorText);
      const candidateAnchors: Array<{ node: HTMLElement; container: HTMLElement; strategy: "error_node_ancestor" | "aria_describedby"; score: number }> = [];
      for (const node of errorNodes) {
        const text = lower(node.innerText || node.textContent || "");
        if (requested && !(text.includes(requested) || requested.includes(text) || text.includes("required"))) continue;
        const resolved = resolveContainerFromNode(node);
        if (resolved.container && hasControls(resolved.container)) {
          candidateAnchors.push({
            node,
            container: resolved.container,
            strategy: "error_node_ancestor",
            score: containerScore(resolved.container, requested)
          });
        }
      }
      for (const control of ariaInvalidControls) {
        const describedBy = normalize(control.getAttribute("aria-describedby") || "");
        if (describedBy) {
          const ids = describedBy.split(/\s+/).filter(Boolean);
          for (const id of ids) {
            const describedNode = document.getElementById(id);
            if (!(describedNode instanceof HTMLElement) || !visible(describedNode)) continue;
            const resolved = resolveContainerFromNode(describedNode);
            if (resolved.container && hasControls(resolved.container)) {
              candidateAnchors.push({
                node: describedNode,
                container: resolved.container,
                strategy: "aria_describedby",
                score: containerScore(resolved.container, requested) + 1
              });
            }
          }
        }
        const fromControl = (control.closest("[data-field-path], .ashby-application-form-field-entry, fieldset") as HTMLElement | null) ?? control.parentElement;
        if (fromControl && hasControls(fromControl)) {
          candidateAnchors.push({
            node: control,
            container: fromControl,
            strategy: "aria_describedby",
            score: containerScore(fromControl, requested)
          });
        }
      }
      candidateAnchors.sort((a, b) => b.score - a.score);
      const picked = candidateAnchors.find((item) => item.score >= 0) ?? candidateAnchors[0];
      let chosenNode: HTMLElement | null = picked?.node ?? null;
      let container: HTMLElement | null = picked?.container ?? null;
      let strategy: "error_node_ancestor" | "aria_describedby" = picked?.strategy ?? "error_node_ancestor";
      if (!container || !hasControls(container)) return null;

      const title =
        normalize(container.querySelector(".ashby-application-form-question-title")?.textContent || "") ||
        normalize((container.querySelector("legend, label") as HTMLElement | null)?.textContent || "") ||
        normalize(container.getAttribute("data-field-path") || "") ||
        "Required Field";
      const fieldPath = normalize(container.getAttribute("data-field-path") || "");
      const textarea = container.querySelector("textarea");
      const file = container.querySelector("input[type='file']");
      const combo = container.querySelector("input[role='combobox'], [role='combobox']");
      const radios = Array.from(container.querySelectorAll("input[type='radio'], [role='radio']")) as HTMLElement[];
      const checkboxes = Array.from(container.querySelectorAll("input[type='checkbox'], [role='checkbox']")) as HTMLElement[];
      const options = Array.from(container.querySelectorAll("button, [role='option'], [role='radio'], [role='checkbox']")) as HTMLElement[];
      let fieldType: AshbyDomFieldType = "unknown";
      if (textarea) fieldType = "textarea";
      else if (file) fieldType = "file";
      else if (combo) fieldType = "combobox";
      else if (radios.length > 0) fieldType = "radio";
      else if (checkboxes.length > 1) fieldType = "checkbox_group";
      else if (options.length > 1) fieldType = "radio";
      else if (container.querySelector("input:not([type='hidden'])")) fieldType = "text";

      const isPromptLikeOption = (optionText: string, fieldLabel: string) => {
        const optionNorm = normalize(optionText);
        if (!optionNorm) return true;
        const optionLower = lower(optionNorm);
        const labelLower = lower(fieldLabel);
        if (labelLower && optionLower === labelLower) return true;
        if (optionLower.includes("missing entry for required field")) return true;
        if (optionNorm.endsWith("?") && optionNorm.split(/\s+/).length >= 6 && !/[,:;/-]/.test(optionNorm)) return true;
        return false;
      };

      const possibleAnswers: string[] = [];
      if (fieldType === "radio" || fieldType === "checkbox_group") {
        const controlTexts = Array.from(container.querySelectorAll("label, button, [role='radio'], [role='checkbox'], [role='option']"))
          .map((node) => normalize((node as HTMLElement).innerText || node.textContent || (node as HTMLElement).getAttribute("aria-label") || ""))
          .filter((text) => Boolean(text) && !isPromptLikeOption(text, title));
        for (const text of controlTexts) possibleAnswers.push(text);
      }
      if (possibleAnswers.length === 0 && (fieldType === "radio" || fieldType === "checkbox_group")) {
        const inputs = Array.from(container.querySelectorAll("input[type='radio'], input[type='checkbox']")) as HTMLInputElement[];
        for (const input of inputs) {
          const label = labelForInput(input);
          if (label && !isPromptLikeOption(label, title)) possibleAnswers.push(label);
        }
      }

      let currentValue: string | string[] | null = null;
      const textInput = container.querySelector("input[type='text'], input[type='email'], input[type='tel'], input[type='number'], input:not([type])") as HTMLInputElement | null;
      if (fieldType === "textarea") currentValue = normalize((textarea as HTMLTextAreaElement).value || "");
      else if (fieldType === "combobox") currentValue = normalize(((combo as HTMLInputElement | null)?.value || ""));
      else if (fieldType === "text") currentValue = normalize(textInput?.value || "");
      else if (fieldType === "radio") {
        const checked = container.querySelector("input[type='radio']:checked, [role='radio'][aria-checked='true'], [role='option'][aria-selected='true'], button[aria-pressed='true']") as HTMLElement | null;
        currentValue = checked ? normalize(checked.innerText || checked.textContent || checked.getAttribute("aria-label") || "") : null;
      } else if (fieldType === "checkbox_group") {
        currentValue = Array.from(container.querySelectorAll("input[type='checkbox']:checked, [role='checkbox'][aria-checked='true']"))
          .map((node) => normalize((node as HTMLElement).innerText || (node as HTMLElement).textContent || (node as HTMLElement).getAttribute("aria-label") || ""))
          .filter(Boolean);
      }

      return {
        fieldPath,
        containerIdentity: buildIdentity(container),
        label: title,
        required: Boolean(container.querySelector("[required]") || /required/.test(lower(container.innerText || ""))),
        fieldType,
        possibleAnswers: Array.from(new Set(possibleAnswers.map((item) => normalize(item)).filter(Boolean))),
        currentValue,
        htmlSummary: JSON.stringify({ label: title, fieldPath, fieldType, possibleAnswers, currentValue }),
        containerHtmlSnippet: describeContainer(container),
        anchorStrategy: strategy,
        validationError: normalize(rawErrorText || normalize(chosenNode?.innerText || chosenNode?.textContent || "")) || "Validation error",
        errorText: normalize(chosenNode?.innerText || chosenNode?.textContent || "") || normalize(rawErrorText)
      };
    }, { rawErrorText: errorText }).catch(() => null as any);
    if (!extracted) return null;
    return {
      fieldPath: String(extracted.fieldPath || "").trim(),
      containerIdentity: String(extracted.containerIdentity || "").trim() || undefined,
      anchorStrategy: extracted.anchorStrategy,
      label: String(extracted.label || "").trim() || errorText,
      required: Boolean(extracted.required),
      fieldType: (String(extracted.fieldType || "unknown") as AshbyDomFieldType),
      possibleAnswers: Array.isArray(extracted.possibleAnswers) ? extracted.possibleAnswers.map((item: string) => String(item).trim()).filter(Boolean) : [],
      currentValue: Array.isArray(extracted.currentValue)
        ? extracted.currentValue.map((item: string) => String(item))
        : extracted.currentValue == null
          ? null
          : String(extracted.currentValue),
      validationError: String(extracted.validationError || errorText),
      errorText: String(extracted.errorText || errorText),
      previousAttempt,
      htmlSummary: String(extracted.htmlSummary || ""),
      containerHtmlSnippet: String(extracted.containerHtmlSnippet || "")
    };
  }

  private async extractLocationAvailabilitySchemaFallback(
    scope: AshbyInteractionScope,
    errorText: string,
    previousAttempt: AshbyFailedFieldRecoverySchema["previousAttempt"]
  ): Promise<AshbyFailedFieldRecoverySchema | null> {
    const extracted = await scope.evaluate(({ rawErrorText }) => {
      const normalize = (value: string) => String(value || "").replace(/\s+/g, " ").trim();
      const lower = (value: string) => normalize(value).toLowerCase();
      const visible = (el: Element | null) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const blocks = Array.from(document.querySelectorAll("[data-field-path], fieldset, .ashby-application-form-field-entry"))
        .filter((node) => node instanceof HTMLElement && visible(node as HTMLElement)) as HTMLElement[];
      const requested = lower(rawErrorText);
      const cityLike = /(paris|bordeaux|barcelona|berlin|london|madrid|new york|san francisco|remote|hybrid)/;
      const isPromptLikeOption = (optionText: string, fieldLabel: string) => {
        const optionNorm = normalize(optionText);
        if (!optionNorm) return true;
        const optionLower = lower(optionNorm);
        const labelLower = lower(fieldLabel);
        if (labelLower && optionLower === labelLower) return true;
        if (optionLower.includes("missing entry for required field")) return true;
        if (optionNorm.endsWith("?") && optionNorm.split(/\s+/).length >= 6 && !/[,:;/-]/.test(optionNorm)) return true;
        return false;
      };

      const scored = blocks
        .map((block) => {
          const label = normalize(
            block.querySelector(".ashby-application-form-question-title")?.textContent ||
            (block.querySelector("legend, label") as HTMLElement | null)?.textContent ||
            block.getAttribute("data-field-path") ||
            ""
          );
          const options = Array.from(block.querySelectorAll("label, button, [role='radio'], [role='checkbox'], [role='option']"))
            .map((node) => normalize((node as HTMLElement).innerText || node.textContent || (node as HTMLElement).getAttribute("aria-label") || ""))
            .filter((text) => Boolean(text) && !isPromptLikeOption(text, label));
          const optionText = lower(options.join(" "));
          const radios = Array.from(block.querySelectorAll("input[type='radio']"));
          const checks = Array.from(block.querySelectorAll("input[type='checkbox']"));
          if (options.length < 2 && radios.length + checks.length < 2) return null;
          let score = 0;
          const labelL = lower(label);
          if (labelL.includes("location")) score += 4;
          if (labelL.includes("work from")) score += 4;
          if (labelL.includes("available")) score += 2;
          if (requested && (requested.includes(labelL) || labelL.includes(requested))) score += 3;
          if (cityLike.test(optionText)) score += 4;
          if (/\byes\b/.test(optionText) && /\bno\b/.test(optionText) && !cityLike.test(optionText)) score -= 5;
          return { block, label, options, score, radios: radios.length, checks: checks.length };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (!best || best.score < 3) return null;
      const fieldPath = normalize(best.block.getAttribute("data-field-path") || "");
      const fieldType: AshbyDomFieldType = best.checks > 1 ? "checkbox_group" : "radio";
      return {
        fieldPath,
        label: best.label || "Location availability",
        required: true,
        fieldType,
        possibleAnswers: Array.from(new Set(best.options)),
        currentValue: null,
        validationError: normalize(rawErrorText),
        htmlSummary: JSON.stringify({
          label: best.label,
          fieldPath,
          controls: best.options
        })
      };
    }, { rawErrorText: errorText }).catch(() => null as any);
    if (!extracted) return null;
    return {
      fieldPath: String(extracted.fieldPath || "").trim(),
      label: String(extracted.label || "").trim() || errorText,
      required: Boolean(extracted.required),
      fieldType: (String(extracted.fieldType || "unknown") as AshbyDomFieldType),
      possibleAnswers: Array.isArray(extracted.possibleAnswers) ? extracted.possibleAnswers.map((item: string) => String(item).trim()).filter(Boolean) : [],
      currentValue: null,
      validationError: String(extracted.validationError || errorText),
      previousAttempt,
      htmlSummary: String(extracted.htmlSummary || ""),
      anchorStrategy: "label_fuzzy_fallback"
    };
  }

  private buildSingleFieldRecoveryPrompt(schema: AshbyFailedFieldRecoverySchema): string {
    return [
      "You are recovering one failed Ashby application field.",
      `Validation error: ${schema.validationError}`,
      `Field label: ${schema.label}`,
      `DOM-derived field type: ${schema.fieldType}`,
      `Possible answers extracted from live DOM: ${JSON.stringify(schema.possibleAnswers)}`,
      `Current value: ${JSON.stringify(schema.currentValue)}`,
      `Previous attempt: ${JSON.stringify(schema.previousAttempt)}`,
      `HTML summary: ${schema.htmlSummary}`,
      "Rules:",
      "- Return JSON only.",
      "- You must provide an answer.",
      "- If possible answers are provided, choose only from those options.",
      "- Do not invent options.",
      "- For combobox, provide comboboxQuery and comboboxTargetOption.",
      "- For text/textarea, provide concise truthful text.",
      "- For file, provide resume path if available.",
      "Return keys exactly: fieldPath, fieldType, answer, selectedOptions, comboboxQuery, comboboxTargetOption, reason."
    ].join("\n");
  }

  private async askLlmForSingleFieldRecovery(
    context: AdapterRunContext,
    schema: AshbyFailedFieldRecoverySchema,
    result: JobRunResult,
    companyContext?: string
  ): Promise<AshbySingleFieldRecoveryAnswer> {
    const question: ApplicationQuestion = {
      id: schema.fieldPath || `recovery:${this.normalize(schema.label)}`,
      label: schema.label,
      type: this.toQuestionTypeFromDomFieldType(schema.fieldType),
      required: schema.required,
      options: schema.possibleAnswers.length > 0 ? schema.possibleAnswers : undefined,
      platformMeta: {
        fieldContext: this.buildSingleFieldRecoveryPrompt(schema),
        inputKind: schema.fieldType,
        expectedOutput: {
          kind:
            schema.fieldType === "checkbox_group"
              ? "multi_select"
              : schema.fieldType === "yes_no"
                ? "boolean"
                : schema.fieldType === "radio" || schema.fieldType === "combobox"
                  ? "single_select"
                  : "text",
          required: schema.required,
          allowedOptions: schema.possibleAnswers
        }
      }
    };
    const answers = await context.aiEngine.resolve([question], {
      profile: context.profile,
      resumeText: context.resumeText,
      jobTitle: result.jobTitle,
      company: result.company,
      companyContext,
      platform: "ashby"
    });
    const resolved = answers[0];
    const rawValue = resolved?.value ?? null;
    const selectedOptions = Array.isArray(rawValue)
      ? rawValue.map((item) => String(item))
      : rawValue == null
        ? []
        : [String(rawValue)];
    return {
      fieldPath: schema.fieldPath,
      fieldType: schema.fieldType,
      answer: typeof rawValue === "boolean" || typeof rawValue === "string" || rawValue === null ? rawValue : String(rawValue ?? ""),
      selectedOptions,
      comboboxQuery: schema.fieldType === "combobox" ? this.buildLocationLikeComboboxQuery(context.profile, schema.previousAttempt) : "",
      comboboxTargetOption: selectedOptions[0] ?? "",
      reason: resolved?.reason ?? "llm_single_field_recovery"
    };
  }

  private toDetectedFieldFromRecoverySchema(schema: AshbyFailedFieldRecoverySchema): DetectedField {
    const selector = schema.fieldPath
      ? (schema.fieldPath.includes(".") || schema.fieldPath.includes(":")
        ? `[data-field-path="${schema.fieldPath.replace(/"/g, '\\"')}"]`
        : `#${schema.fieldPath.replace(/"/g, '\\"')}, [data-field-path="${schema.fieldPath.replace(/"/g, '\\"')}"]`)
      : "";
    return {
      id: schema.fieldPath || `recovery_${this.normalize(schema.label).replace(/\s+/g, "_")}`,
      label: schema.label,
      required: schema.required,
      type: this.toDetectedFieldTypeFromDomFieldType(schema.fieldType),
      selector,
      tag: schema.fieldType === "textarea" ? "textarea" : "input",
      options: schema.possibleAnswers,
      platformMeta: {
        fieldPath: schema.fieldPath,
        groupIdentity: schema.containerIdentity,
        stableKey: schema.fieldPath || schema.containerIdentity || schema.label
      }
    };
  }

  private async readContainerSelectionState(scope: AshbyInteractionScope, field: DetectedField): Promise<AshbyContainerSelectionState> {
    const fieldPath = typeof field.platformMeta?.fieldPath === "string" ? String(field.platformMeta.fieldPath) : "";
    const groupIdentity = typeof field.platformMeta?.groupIdentity === "string" ? String(field.platformMeta.groupIdentity) : "";
    const selector = String(field.selector || "");
    const state = (await scope.evaluate(({ rawFieldPath, rawGroupIdentity, rawSelector }) => {
      const normalize = (value: string) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const buildIdentity = (block: HTMLElement): string => {
        const fieldPath = normalize(block.getAttribute("data-field-path") || "") || "no_field_path";
        const firstInput = block.querySelector("input[type='radio'], input[type='checkbox']") as HTMLInputElement | null;
        const groupName = normalize(firstInput?.name || "") || "no_group_name";
        const optionLabels = Array.from(block.querySelectorAll("label, button, [role='radio'], [role='option'], option"))
          .map((node) => normalize((node as HTMLElement).innerText || node.textContent || ""))
          .filter(Boolean)
          .sort()
          .join("|") || "no_options";
        return `group:${fieldPath}::${groupName}::${optionLabels}`;
      };
      let block: HTMLElement | null = null;
      const fieldPath = String(rawFieldPath || "").trim();
      if (fieldPath) block = document.querySelector(`[data-field-path="${CSS.escape(fieldPath)}"]`);
      if (!block && rawGroupIdentity) {
        const target = normalize(String(rawGroupIdentity || ""));
        block = Array.from(document.querySelectorAll("[data-field-path], fieldset, .ashby-application-form-field-entry, section, div"))
          .find((node) => node instanceof HTMLElement && buildIdentity(node as HTMLElement) === target) as HTMLElement | undefined ?? null;
      }
      if (!block && rawSelector) {
        const node = document.querySelector(String(rawSelector));
        if (node instanceof HTMLElement) {
          block = (node.closest("[data-field-path], fieldset, .ashby-application-form-field-entry, section, div") as HTMLElement | null) ?? node;
        }
      }
      if (!block) return { selectedLabels: [], checkedCount: 0 };
      const selectedLabels = Array.from(
        block.querySelectorAll(
          "input[type='radio']:checked, input[type='checkbox']:checked, button[aria-pressed='true'], button[aria-checked='true'], button[aria-selected='true'], button[data-state='checked'], [role='radio'][aria-checked='true'], [role='option'][aria-selected='true']"
        )
      )
        .map((node) => normalize((node as HTMLElement).innerText || (node as HTMLElement).textContent || (node as HTMLInputElement).value || (node as HTMLElement).getAttribute("aria-label") || ""))
        .filter(Boolean);
      return { selectedLabels, checkedCount: selectedLabels.length };
    }, { rawFieldPath: fieldPath, rawGroupIdentity: groupIdentity, rawSelector: selector }).catch(() => ({ selectedLabels: [], checkedCount: 0 }))) as {
      selectedLabels?: string[];
      checkedCount?: number;
    };
    return {
      selectedLabels: Array.isArray(state.selectedLabels) ? state.selectedLabels.map((item) => String(item)) : [],
      checkedCount: Number(state.checkedCount ?? 0)
    };
  }

  private async recoverValidationErrorsWithDomReExtraction(
    context: AdapterRunContext,
    scope: AshbyInteractionScope,
    ashbyConfig: AshbyConfig,
    validationErrors: string[],
    result: JobRunResult,
    pass: number,
    companyContext?: string,
    postingLocation?: string
  ): Promise<{ recoveredLabels: string[]; remainingLabels: string[]; changedLabels: string[] }> {
    const labels = this.parseMissingRequiredFieldLabels(validationErrors);
    const targets = labels.length > 0 ? labels : validationErrors;
    const fields = await this.extractVisibleFieldsSafely(scope, context.logger, result.url, ashbyConfig);
    const missingDescriptors = await this.detectMissingRequiredFieldDescriptors(scope, ashbyConfig.requiredFieldSelectors);
    const mappedTargets = this.mapMissingLabelsToRecoveryTargets(fields, targets, missingDescriptors);
    const recoveredLabels: string[] = [];
    const remainingLabels: string[] = [];
    const changedLabels: string[] = [];

    for (const mappedTarget of mappedTargets) {
      const errorLabel = mappedTarget.label;
      const isBackMarketLocationAvailability = this.isBackMarketLocationAvailabilityLabel(errorLabel);
      const previousAttempt = this.buildPreviousAttemptForLabel(result, errorLabel, errorLabel);
      const preferredFieldPath = typeof mappedTarget.field?.platformMeta?.fieldPath === "string"
        ? String(mappedTarget.field.platformMeta.fieldPath)
        : "";
      let schema = await this.extractSingleFieldSchemaFromValidationErrorNode(
        scope,
        errorLabel,
        previousAttempt
      );
      const locationAvailabilityTarget = this.isLocationAvailabilityPrompt(this.normalize(errorLabel));
      if ((!schema || !this.isLocationAvailabilityPrompt(this.normalize(`${schema.label} ${schema.validationError}`))) && locationAvailabilityTarget) {
        schema = await this.extractLocationAvailabilitySchemaFallback(scope, errorLabel, previousAttempt);
      }
      if (!schema) {
        schema = await this.extractSingleFieldSchemaFromLiveDom(
          scope,
          errorLabel,
          context.profile,
          previousAttempt,
          preferredFieldPath || undefined
        );
        if (schema) schema.anchorStrategy = "label_fuzzy_fallback";
      } else if (!schema.fieldPath && preferredFieldPath) {
        schema = await this.extractSingleFieldSchemaFromLiveDom(
          scope,
          errorLabel,
          context.profile,
          previousAttempt,
          preferredFieldPath
        );
        if (schema) schema.anchorStrategy = "label_fuzzy_fallback";
      }
      if (!schema) {
        remainingLabels.push(errorLabel);
        result.notes.push(`recovery_dom_not_found:${errorLabel}`);
        continue;
      }

      if (isBackMarketLocationAvailability && schema.fieldType === "checkbox_group") {
        const forcedOptions = schema.possibleAnswers.length > 0
          ? schema.possibleAnswers
          : ["Paris, France", "Bordeaux, France", "Barcelona, Spain", "Berlin, Germany"];
        const forceResult = await this.forceSelectAllCheckboxOptionsInContainer(scope, schema, forcedOptions);
        result.notes.push(`recovery_error_text:${schema.errorText || errorLabel}`);
        result.notes.push(`recovery_anchor_strategy:${schema.anchorStrategy || "label_fuzzy_fallback"}`);
        result.notes.push(`recovery_anchored_field_path:${schema.fieldPath || "no_field_path"}`);
        result.notes.push(`recovery_anchored_label:${schema.label}`);
        result.notes.push(`recovery_dom_field_type:${schema.label}:${schema.fieldType}`);
        result.notes.push(`recovery_possible_answers_count:${schema.label}:${forcedOptions.length}`);
        result.notes.push(`recovery_possible_answers:${schema.label}:${forcedOptions.join(" || ")}`);
        result.notes.push(`recovery_reason:${schema.label}:deterministic_select_all_location_options`);
        result.notes.push(`recovery_reason:${schema.label}:backmarket_literal_click_all`);
        if (forceResult.allChecked) {
          recoveredLabels.push(schema.label);
          changedLabels.push(schema.label);
          result.notes.push(`fill:${pass}:${schema.label}:dom_validation_recovery`);
          result.notes.push(`recovery_execute_result:${schema.label}:verified`);
          result.notes.push(`recovery_reason:${schema.label}:container_matched_exact`);
          result.notes.push(`recovery_reason:${schema.label}:option_selected_from_dom`);
        } else {
          remainingLabels.push(schema.label);
          result.notes.push(`recovery_execute_result:${schema.label}:not_verified`);
          result.notes.push(`recovery_reason:${schema.label}:no_progress_after_recovery`);
        }
        continue;
      }
      result.notes.push(`recovery_error_text:${schema.errorText || errorLabel}`);
      result.notes.push(`recovery_anchor_strategy:${schema.anchorStrategy || "label_fuzzy_fallback"}`);
      result.notes.push(`recovery_anchored_field_path:${schema.fieldPath || "no_field_path"}`);
      result.notes.push(`recovery_anchored_label:${schema.label}`);
      result.notes.push(`recovery_dom_field_type:${schema.label}:${schema.fieldType}`);
      result.notes.push(`recovery_possible_answers_count:${schema.label}:${schema.possibleAnswers.length}`);
      if (schema.possibleAnswers.length > 0) {
        result.notes.push(`recovery_possible_answers:${schema.label}:${schema.possibleAnswers.join(" || ")}`);
      }
      if (schema.containerHtmlSnippet) {
        result.notes.push(`recovery_container_html_snippet:${schema.containerHtmlSnippet}`);
      }

      const answer = await this.askLlmForSingleFieldRecovery(context, schema, result, companyContext);
      let selectedValue: string | string[] | boolean | null = answer.answer;
      const isLocationAvailabilityRecovery = this.isLocationAvailabilityPrompt(
        this.normalize(`${schema.label} ${errorLabel}`)
      );
      if (schema.fieldType === "checkbox_group") {
        selectedValue = answer.selectedOptions.length > 0 ? answer.selectedOptions : selectedValue == null ? [] : [String(selectedValue)];
        if (isLocationAvailabilityRecovery && schema.possibleAnswers.length > 0) {
          selectedValue = schema.possibleAnswers.slice();
          result.notes.push(`recovery_reason:${schema.label}:deterministic_select_all_location_options`);
        }
      } else if (schema.fieldType === "radio" || schema.fieldType === "yes_no" || schema.fieldType === "combobox") {
        selectedValue = answer.comboboxTargetOption || answer.selectedOptions[0] || (selectedValue == null ? "" : String(selectedValue));
        if (isLocationAvailabilityRecovery && schema.possibleAnswers.length > 0) {
          const constrained = schema.possibleAnswers.find(
            (option) => this.normalize(option) === this.normalize(String(selectedValue ?? ""))
          );
          if (constrained) {
            selectedValue = constrained;
          } else {
            const profileGuess = this.resolveLocationAvailabilitySelections(
              schema.possibleAnswers,
              context.profile,
              postingLocation,
              ashbyConfig
            );
            selectedValue = profileGuess[0] ?? "";
            if (selectedValue) {
              result.notes.push(`recovery_reason:${schema.label}:container_matched_fuzzy`);
            }
          }
        }
      } else if (schema.fieldType === "file") {
        selectedValue = context.config.resumePath ?? answer.answer;
      }

      const detectedField = this.toDetectedFieldFromRecoverySchema(schema);
      const beforeSelection = await this.readContainerSelectionState(scope, detectedField);
      const normalizedValue = this.normalizeAnswerForField(detectedField, selectedValue as any);
      const repaired = this.validateAndRepairFieldAnswer(detectedField, normalizedValue);
      const finalValue = this.sanitizeValueForField(detectedField, repaired.value);
      if (!this.answerHasValue(finalValue)) {
        remainingLabels.push(schema.label);
        result.notes.push(`recovery_execute_result:${schema.label}:not_verified`);
        continue;
      }

      const before = await this.verifyFieldAnswered(scope, detectedField, undefined);
      const applied = await this.fillFieldWithVerification(scope, detectedField, finalValue, {
        profile: context.profile,
        postingLocation,
        ashbyConfig,
        logger: context.logger
      });
      const verified = applied && (await this.verifyFieldAnswered(scope, detectedField, finalValue));
      const after = await this.verifyFieldAnswered(scope, detectedField, undefined);
      const afterSelection = await this.readContainerSelectionState(scope, detectedField);
      const beforeSig = this.normalize(beforeSelection.selectedLabels.slice().sort().join("|"));
      const afterSig = this.normalize(afterSelection.selectedLabels.slice().sort().join("|"));
      const meaningfulDelta = beforeSig !== afterSig || beforeSelection.checkedCount !== afterSelection.checkedCount;
      if (after && !before) changedLabels.push(schema.label);
      if (verified && meaningfulDelta) {
        recoveredLabels.push(schema.label);
        result.notes.push(`fill:${pass}:${schema.label}:dom_validation_recovery`);
        result.notes.push(`recovery_execute_result:${schema.label}:verified`);
        result.notes.push(`recovery_reason:${schema.label}:container_matched_exact`);
        result.notes.push(`recovery_reason:${schema.label}:option_selected_from_dom`);
        this.recordFilledField(result, {
          id: detectedField.id,
          label: detectedField.label,
          value: this.stringifyValue(await this.resolveCanonicalFilledValue(scope, detectedField, finalValue)),
          source: "llm",
          inputKind: detectedField.type
        });
      } else {
        remainingLabels.push(schema.label);
        result.notes.push(`recovery_execute_result:${schema.label}:not_verified`);
        if (!meaningfulDelta) {
          result.notes.push(`recovery_reason:${schema.label}:no_progress_after_recovery`);
        }
      }
    }

    return {
      recoveredLabels: this.mergeUnique(recoveredLabels),
      remainingLabels: this.mergeUnique(remainingLabels),
      changedLabels: this.mergeUnique(changedLabels)
    };
  }

  private isBackMarketLocationAvailabilityLabel(label: string): boolean {
    const normalized = this.normalize(String(label || ""))
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return normalized.includes("please confirm which location s you would be available to work from")
      || normalized.includes("please confirm which locations you would be available to work from");
  }

  private async forceSelectAllCheckboxOptionsInContainer(
    scope: AshbyInteractionScope,
    schema: AshbyFailedFieldRecoverySchema,
    selectedOptions: string[]
  ): Promise<{ allChecked: boolean; checkedLabels: string[] }> {
    const output = (await scope.evaluate(
      ({ rawLabel, rawFieldPath, rawIdentity, rawSelectedOptions }) => {
        const normalize = (value: string) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
        const visible = (el: Element | null): el is HTMLElement => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const labelText = normalize(rawLabel);
        const options = Array.isArray(rawSelectedOptions) ? rawSelectedOptions.map((item) => String(item)) : [];

        const locateContainer = (): HTMLElement | null => {
          const preferredByPath = String(rawFieldPath || "").trim();
          if (preferredByPath) {
            const byFieldPath = document.querySelector(`[data-field-path="${CSS.escape(preferredByPath)}"]`);
            if (byFieldPath instanceof HTMLElement) return byFieldPath;
            const byId = document.getElementById(preferredByPath);
            if (byId instanceof HTMLElement) return byId.closest("fieldset, [data-field-path], .ashby-application-form-field-entry") as HTMLElement | null;
          }
          const identity = normalize(String(rawIdentity || ""));
          if (identity) {
            const blocks = Array.from(document.querySelectorAll("[data-field-path], fieldset, .ashby-application-form-field-entry"));
            const buildIdentity = (block: HTMLElement): string => {
              const fieldPath = normalize(block.getAttribute("data-field-path") || "") || "no_field_path";
              const firstInput = block.querySelector("input[type='radio'], input[type='checkbox']") as HTMLInputElement | null;
              const groupName = normalize(firstInput?.name || "") || "no_group_name";
              const optionLabels = Array.from(block.querySelectorAll("label, button, [role='radio'], [role='checkbox'], [role='option']"))
                .map((node) => normalize((node as HTMLElement).innerText || node.textContent || ""))
                .filter(Boolean)
                .sort()
                .join("|") || "no_options";
              return `group:${fieldPath}::${groupName}::${optionLabels}`;
            };
            const match = blocks.find((block) => block instanceof HTMLElement && buildIdentity(block as HTMLElement) === identity);
            if (match instanceof HTMLElement) return match;
          }
          const questionTitles = Array.from(document.querySelectorAll("label.ashby-application-form-question-title, .ashby-application-form-question-title"));
          for (const title of questionTitles) {
            if (!(title instanceof HTMLElement)) continue;
            if (normalize(title.textContent || "") !== labelText) continue;
            const forAttr = title.getAttribute("for");
            if (forAttr) {
              const control = document.getElementById(forAttr);
              const fromControl = control?.closest("fieldset, [data-field-path], .ashby-application-form-field-entry");
              if (fromControl instanceof HTMLElement) return fromControl;
            }
            const nearest = title.closest("fieldset, [data-field-path], .ashby-application-form-field-entry");
            if (nearest instanceof HTMLElement) return nearest;
          }
          return null;
        };

        const container = locateContainer();
        if (!container) return { allChecked: false, checkedLabels: [] };

        const clickOption = (optionText: string) => {
          const target = normalize(optionText);
          if (!target) return false;
          const labels = Array.from(container.querySelectorAll("label")) as HTMLLabelElement[];
          for (const label of labels) {
            if (!visible(label)) continue;
            if (normalize(label.textContent || "") !== target) continue;
            label.click();
            return true;
          }
          const idMatchedLabel = labels.find((label) => {
            const forAttr = String(label.getAttribute("for") || "");
            if (!forAttr) return false;
            const input = container.querySelector(`#${CSS.escape(forAttr)}`) as HTMLInputElement | null;
            if (!input || input.type !== "checkbox") return false;
            return normalize(input.name || "") === target;
          });
          if (idMatchedLabel && visible(idMatchedLabel)) {
            idMatchedLabel.click();
            return true;
          }
          const byName = container.querySelector(`input[type='checkbox'][name="${CSS.escape(optionText)}"]`) as HTMLInputElement | null;
          if (byName) {
            const labelByFor = container.querySelector(`label[for="${CSS.escape(byName.id || "")}"]`) as HTMLElement | null;
            if (labelByFor && visible(labelByFor)) {
              labelByFor.click();
            } else {
              byName.click();
            }
            return true;
          }
          return false;
        };

        const selected = options.length > 0
          ? options
          : Array.from(container.querySelectorAll("input[type='checkbox']"))
              .map((node) => String((node as HTMLInputElement).name || ""))
              .filter(Boolean);
        for (const option of selected) clickOption(option);
        for (const option of selected) {
          const normalizedOption = normalize(option);
          const input = Array.from(container.querySelectorAll("input[type='checkbox']")).find((node) => {
            if (!(node instanceof HTMLInputElement)) return false;
            const labelFor = container.querySelector(`label[for="${CSS.escape(node.id || "")}"]`) as HTMLElement | null;
            const labelText = normalize(labelFor?.textContent || "");
            return labelText === normalizedOption || normalize(node.name || "") === normalizedOption;
          }) as HTMLInputElement | undefined;
          if (input && !input.checked) clickOption(option);
        }

        const checkedLabels = Array.from(container.querySelectorAll("input[type='checkbox']"))
          .filter((node) => (node as HTMLInputElement).checked)
          .map((node) => {
            const input = node as HTMLInputElement;
            const byFor = container.querySelector(`label[for="${CSS.escape(input.id || "")}"]`) as HTMLElement | null;
            return String(byFor?.textContent || input.name || "").trim();
          })
          .filter(Boolean);
        const normalizedChecked = checkedLabels.map((item) => normalize(item));
        const allChecked = selected.every((item) => normalizedChecked.includes(normalize(item)));
        return { allChecked, checkedLabels };
      },
      {
        rawLabel: schema.label,
        rawFieldPath: schema.fieldPath,
        rawIdentity: schema.containerIdentity ?? "",
        rawSelectedOptions: selectedOptions
      }
    ).catch(() => ({ allChecked: false, checkedLabels: [] }))) as { allChecked?: boolean; checkedLabels?: string[] };
    return {
      allChecked: Boolean(output?.allChecked),
      checkedLabels: Array.isArray(output?.checkedLabels) ? output.checkedLabels.map((item) => String(item)) : []
    };
  }

  private async fillMissingFieldsByLabel(
    context: AdapterRunContext,
    scope: AshbyInteractionScope,
    ashbyConfig: AshbyConfig,
    missingLabels: string[],
    result: JobRunResult,
    pass: number,
    companyContext?: string,
    postingLocation?: string,
    recoveryOptions?: AshbyRecoveryOptions
  ): Promise<{ filledCount: number; remainingLabels: string[]; remainingTargetIds: string[]; recoveredLabels: string[] }> {
    const fields = await this.extractVisibleFieldsSafely(scope, context.logger, result.url, ashbyConfig);
    const missingDescriptors = await this.detectMissingRequiredFieldDescriptors(scope, ashbyConfig.requiredFieldSelectors);
    const targets = this.mapMissingLabelsToRecoveryTargets(fields, missingLabels, missingDescriptors);
    const targetedFields = targets
      .map((item) => item.field)
      .filter((item): item is DetectedField => Boolean(item));
    await this.enrichUnknownFieldsWithLiveOptions(
      context,
      scope,
      targetedFields,
      result,
      "recovery",
      context.profile,
      postingLocation,
      ashbyConfig
    );
    const questions = buildQuestionMap(targetedFields);
    const llmRequestId = questions.length > 0
      ? `ashby_recovery_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      : undefined;
    const aiResolveTimeoutMs = this.resolveAiTimeoutMs();
    context.logger.info("unknown_llm_request", {
      platform: "ashby",
      phase: "recovery",
      requestId: llmRequestId,
      questionCount: questions.length,
      fieldIds: questions.map((question) => question.id),
      labels: questions.map((question) => question.label)
    });
    this.recordLlmEvent(result, "unknown_llm_request", {
      platform: "ashby",
      phase: "recovery",
      requestId: llmRequestId,
      questionCount: questions.length,
      fieldIds: questions.map((question) => question.id),
      labels: questions.map((question) => question.label),
      controlTypes: questions.map((question) => question.type),
      requiredFlags: questions.map((question) => Boolean(question.required))
    });
    const recoveryBatchStartedAt = Date.now();
    this.recordLlmEvent(result, "llm_batch_start", {
      phase: "recovery",
      unresolvedCount: questions.length,
      timeoutMs: aiResolveTimeoutMs
    });
    const rawAnswers = await this.withTimeout(
      context.aiEngine.resolve(questions, {
        profile: context.profile,
        resumeText: context.resumeText,
        jobTitle: result.jobTitle,
        company: result.company,
        companyContext,
        platform: "ashby"
      }),
      aiResolveTimeoutMs,
      "ashby_ai_resolve_timeout"
    );
    const recoveryAnswerCount = rawAnswers.length;
    const recoveryNonNullCount = rawAnswers.filter((answer) => this.answerHasValue(answer.value)).length;
    this.recordLlmEvent(result, "llm_batch_result", {
      phase: "recovery",
      unresolvedCount: questions.length,
      answerKeyCount: recoveryAnswerCount,
      nonNullAnswerCount: recoveryNonNullCount,
      durationMs: Date.now() - recoveryBatchStartedAt
    });
    const answers = this.applyBlockedQuestionPolicies(rawAnswers, questions, ashbyConfig.blockedQuestionPatterns);
    const byId = indexAnswersByQuestion(answers);
    const llmRequestedFieldIds = new Set(questions.map((question) => question.id));
    const llmTerminalOutcomeFieldIds = new Set<string>();
    const recordLlmTerminalOutcome = (
      field: Pick<DetectedField, "id" | "label">,
      event: Extract<
        LlmEventRecord["event"],
        | "llm_answer_applied"
        | "llm_answer_empty"
        | "llm_answer_invalid_option"
        | "llm_answer_skipped_optional"
        | "llm_answer_blocked_policy"
      >,
      extra?: Omit<LlmEventRecord, "ts" | "event" | "fieldId" | "label" | "phase" | "platform" | "requestId">
    ) => {
      if (!llmRequestedFieldIds.has(field.id)) return;
      if (llmTerminalOutcomeFieldIds.has(field.id)) return;
      llmTerminalOutcomeFieldIds.add(field.id);
      context.logger.info(event, {
        platform: "ashby",
        phase: "recovery",
        requestId: llmRequestId,
        fieldId: field.id,
        label: field.label,
        ...(extra ?? {})
      });
      this.recordLlmEvent(result, event, {
        platform: "ashby",
        phase: "recovery",
        requestId: llmRequestId,
        fieldId: field.id,
        label: field.label,
        ...(extra ?? {})
      });
    };
    const resolvedResumePath = this.resolvePreferredResumePath(context.profile, context.config.resumePath, ashbyConfig);

    let filled = 0;
    for (const targetInfo of targets) {
      const { label: missingLabel, field: target } = targetInfo;
      const profileUnknown = target
        ? this.isProfileUnknownField(target, context.profile, postingLocation, ashbyConfig)
        : false;
      if (profileUnknown && target) this.markUnknownFieldSeen(result, target.label);
      if (this.isBackMarketLocationAvailabilityLabel(missingLabel)) {
        const schema = await this.extractSingleFieldSchemaFromLiveDom(
          scope,
          missingLabel,
          context.profile,
          this.buildPreviousAttemptForLabel(result, missingLabel, missingLabel),
          undefined
        );
        if (schema && schema.fieldType === "checkbox_group") {
          const options = schema.possibleAnswers.length > 0
            ? schema.possibleAnswers
            : ["Paris, France", "Bordeaux, France", "Barcelona, Spain", "Berlin, Germany"];
          const forced = await this.forceSelectAllCheckboxOptionsInContainer(scope, schema, options);
          if (forced.allChecked) {
            filled += 1;
            result.notes.push(`fill:${pass}:${missingLabel}:section_recovery`);
            result.notes.push(`recovery_target:${targetInfo.identity}:applied`);
            continue;
          }
        }
      }
      if (!target) {
        const sectionRecovered = await this.recoverMissingLabelBySection(
          ashbyConfig,
          scope,
          missingLabel,
          context.profile,
          result.company,
          result.jobTitle,
          companyContext,
          postingLocation,
          null
        );
        if (sectionRecovered) {
          filled += 1;
          result.notes.push(`fill:${pass}:${missingLabel}:section_recovery`);
          result.notes.push(`recovery_target:${targetInfo.identity}:applied`);
          if (profileUnknown) this.markUnknownFieldResolved(result, missingLabel);
        } else {
          result.notes.push(`fill:${pass}:${missingLabel}:section_recovery_not_sticky`);
          result.notes.push(`recovery_target:${targetInfo.identity}:not_sticky`);
        }
        continue;
      }
      const identity = this.getFieldIdentity(target);
      if (recoveryOptions?.validatedGood?.has(identity)) {
        const stillFailing = (recoveryOptions.failingLabels ?? []).some((label) => this.labelsRoughlyMatch(label, target.label));
        if (!stillFailing) {
          result.notes.push(`recovery_target:${targetInfo.identity}:skip_validated_cache`);
          continue;
        }
      }

      const override = this.pickOverride(target, ashbyConfig);
      const seededResume =
        target.type === "file" &&
        (override?.value ||
          (resolvedResumePath && (target.required || /resume|cv/i.test(target.label))
            ? resolvedResumePath
            : undefined));

      const resolved = this.resolveEffectiveAnswerForField(
        target,
        byId.get(target.id),
        context.profile,
        result.company,
        result.jobTitle,
        companyContext,
        postingLocation,
        ashbyConfig,
        true
      );
      if (profileUnknown) {
        const raw = byId.get(target.id);
        context.logger.info("unknown_llm_response", {
          platform: "ashby",
          phase: "recovery",
          requestId: llmRequestId,
          fieldId: target.id,
          label: target.label,
          source: raw?.source ?? "none",
          hasValue: this.answerHasValue(raw?.value),
          value: raw?.value ?? null
        });
        this.recordLlmEvent(result, "unknown_llm_response", {
          platform: "ashby",
          phase: "recovery",
          requestId: llmRequestId,
          fieldId: target.id,
          label: target.label,
          source: raw?.source ?? "none",
          hasValue: this.answerHasValue(raw?.value),
          value: raw?.value ?? null
        });
      }
      const normalizedAnswerValue = this.normalizeAnswerForField(target, resolved?.value);
      const repairedAnswer = this.validateAndRepairFieldAnswer(target, normalizedAnswerValue);
      if (repairedAnswer.invalid && resolved?.source === "llm") {
        result.notes.push(`attempted_skipped:${target.label}:invalid_llm_option:${repairedAnswer.reason ?? "unmatched_option"}`);
        recordLlmTerminalOutcome(target, "llm_answer_invalid_option", {
          source: resolved?.source ?? "llm",
          outcomeReason: repairedAnswer.reason ?? "unmatched_option"
        });
      } else if (repairedAnswer.repaired && resolved?.source === "llm") {
        result.notes.push(`llm_option_repaired:${target.label}`);
      }
      const textFallbackResolution =
        (target.type === "text" || target.type === "textarea") && !this.answerHasValue(repairedAnswer.value)
          ? this.resolveAshbyTextFallback(
              missingLabel,
              target.type,
              context.profile,
              result.company,
              result.jobTitle,
              companyContext,
              postingLocation,
              ashbyConfig,
              target.placeholder
            )
          : null;
      const resolvedValue = this.answerHasValue(repairedAnswer.value) ? repairedAnswer.value : null;
      const rawRecoveryFallbackValue = (
        textFallbackResolution?.value ??
        this.targetedFallbackValue(
          target,
          missingLabel,
          context.profile,
          result.company,
          result.jobTitle,
          companyContext,
          postingLocation,
          ashbyConfig
        )
      );
      const guardedRecoveryFallbackValue = this.guardUnsafeOfficeRelocationFallback(
        target,
        rawRecoveryFallbackValue,
        context.profile,
        result,
        ashbyConfig,
        "recovery"
      );
      const value =
        profileUnknown && target.required && !this.answerHasValue(repairedAnswer.value)
          ? null
          : (
            override?.value ??
            seededResume ??
            resolvedValue ??
            guardedRecoveryFallbackValue
          );
      const sanitizedValue = this.sanitizeValueForField(target, value);
      this.recordAccommodationPolicyMarker(result, target, sanitizedValue, ashbyConfig);
      this.recordDeterministicFinalTextFallbackMarker(
        result,
        target,
        sanitizedValue,
        ashbyConfig,
        resolved?.reason ?? (textFallbackResolution?.deterministicFinal ? "deterministic_final_text_fallback" : undefined)
      );

      if (!this.answerHasValue(sanitizedValue)) {
        if (llmRequestedFieldIds.has(target.id)) {
          if (this.answerHasValue(byId.get(target.id)?.value) && resolved?.source !== "llm") {
            recordLlmTerminalOutcome(target, "llm_answer_blocked_policy", {
              source: resolved?.source ?? "none",
              outcomeReason: `resolved_by_non_llm_source:${resolved?.source ?? "none"}`
            });
          } else {
            recordLlmTerminalOutcome(target, "llm_answer_empty", {
              source: byId.get(target.id)?.source ?? "none",
              hasValue: false
            });
          }
        }
        if (profileUnknown && target.required) {
          result.notes.push(`recovery_target:${targetInfo.identity}:unknown_required_unresolved`);
          this.markUnknownFieldUnresolved(result, target.label);
          continue;
        }
        const sectionRecovered = await this.recoverMissingLabelBySection(
          ashbyConfig,
          scope,
          missingLabel,
          context.profile,
          result.company,
          result.jobTitle,
          companyContext,
          postingLocation,
          sanitizedValue
        );
        const sectionRecoveredVerified = sectionRecovered && (await this.verifyFieldAnswered(scope, target, sanitizedValue));
        if (sectionRecoveredVerified) {
          filled += 1;
          result.notes.push(`fill:${pass}:${missingLabel}:section_recovery`);
          result.notes.push(`recovery_target:${targetInfo.identity}:applied`);
          if (profileUnknown) this.markUnknownFieldResolved(result, target.label);
        } else {
          result.notes.push(`fill:${pass}:${missingLabel}:section_recovery_not_sticky`);
          result.notes.push(`recovery_target:${targetInfo.identity}:not_sticky`);
        }
        continue;
      }
      const applied = await this.fillFieldWithVerification(scope, target, sanitizedValue, {
        profile: context.profile,
        postingLocation,
        ashbyConfig,
        logger: context.logger
      });
      const appliedVerified = applied && (await this.verifyFieldAnswered(scope, target, sanitizedValue));
      if (profileUnknown) {
        context.logger.info("unknown_execute_result", {
          platform: "ashby",
          phase: "recovery",
          fieldId: target.id,
          label: target.label,
          applied,
          verified: appliedVerified
        });
      }
      if (!appliedVerified) {
        let deterministicTextRecovered = false;
        if (
          target.required &&
          (target.type === "text" || target.type === "textarea") &&
          resolved?.source === "llm" &&
          this.resolveUnknownRequiredTextPolicy(ashbyConfig) === "llm_first_then_terminal_fallback"
        ) {
          const terminal = this.resolveFinalTextFallbackValue(ashbyConfig);
          if (this.answerHasValue(terminal) && this.normalize(String(sanitizedValue ?? "")) !== this.normalize(terminal)) {
            const recovered = await this.fillFieldWithVerification(scope, target, terminal, {
              profile: context.profile,
              postingLocation,
              ashbyConfig,
              logger: context.logger
            });
            if (recovered && (await this.verifyFieldAnswered(scope, target, terminal))) {
              filled += 1;
              deterministicTextRecovered = true;
              result.notes.push(`fill:${pass}:${target.label}:terminal_text_fallback_after_non_sticky_llm`);
              result.notes.push(`recovery_target:${targetInfo.identity}:verified`);
              result.notes.push(`commit_strategy:${this.commitStrategyMarkerForField(target)}`);
              this.recordFilledField(result, {
                id: target.id,
                label: target.label,
                value: this.stringifyValue(await this.resolveCanonicalFilledValue(scope, target, terminal)),
                source: "fallback",
                inputKind: target.type
              });
              if (profileUnknown) this.markUnknownFieldResolved(result, target.label);
            }
          }
        }
        if (deterministicTextRecovered) {
          continue;
        }
        if (profileUnknown && target.required) {
          result.notes.push(`recovery_target:${targetInfo.identity}:unknown_required_not_verified`);
          this.markUnknownFieldUnresolved(result, target.label);
          continue;
        }
        const sectionRecovered = await this.recoverMissingLabelBySection(
          ashbyConfig,
          scope,
          missingLabel,
          context.profile,
          result.company,
          result.jobTitle,
          companyContext,
          postingLocation,
          sanitizedValue
        );
        const sectionRecoveredVerified = sectionRecovered && (await this.verifyFieldAnswered(scope, target, sanitizedValue));
        if (sectionRecoveredVerified) {
          filled += 1;
          result.notes.push(`fill:${pass}:${missingLabel}:section_recovery_after_verify`);
          result.notes.push(`recovery_target:${targetInfo.identity}:applied`);
          if (profileUnknown) this.markUnknownFieldResolved(result, target.label);
        } else {
          result.notes.push(`fill:${pass}:${missingLabel}:section_recovery_after_verify_not_sticky`);
          result.notes.push(`recovery_target:${targetInfo.identity}:not_sticky`);
        }
        continue;
      }

      filled += 1;
      recoveryOptions?.validatedGood?.set(identity, this.stringifyValue(await this.resolveCanonicalFilledValue(scope, target, sanitizedValue)));
      result.notes.push(`fill:${pass}:${target.label}:missing_field_recovery`);
      result.notes.push(`commit_strategy:${this.commitStrategyMarkerForField(target)}`);
      if (textFallbackResolution?.reason.startsWith("text_fallback_")) {
        result.notes.push(`fallback_intent:${target.label}:${textFallbackResolution.intent}`);
      }
      result.notes.push(`recovery_target:${targetInfo.identity}:verified`);
      this.recordFilledField(result, {
        id: target.id,
        label: target.label,
        value: this.stringifyValue(await this.resolveCanonicalFilledValue(scope, target, sanitizedValue)),
        source: "fallback",
        inputKind: target.type
      });
      if (llmRequestedFieldIds.has(target.id)) {
        if (resolved?.source === "llm") {
          recordLlmTerminalOutcome(target, "llm_answer_applied", {
            source: "llm",
            hasValue: true
          });
        } else if (this.answerHasValue(byId.get(target.id)?.value)) {
          recordLlmTerminalOutcome(target, "llm_answer_blocked_policy", {
            source: resolved?.source ?? "none",
            outcomeReason: `resolved_by_non_llm_source:${resolved?.source ?? "none"}`
          });
        } else {
          recordLlmTerminalOutcome(target, "llm_answer_empty", {
            source: byId.get(target.id)?.source ?? "none",
            hasValue: false
          });
        }
      }
      if (profileUnknown) this.markUnknownFieldResolved(result, target.label);
    }
    for (const question of questions) {
      if (llmTerminalOutcomeFieldIds.has(question.id)) continue;
      const synthetic: Pick<DetectedField, "id" | "label"> = { id: question.id, label: question.label };
      recordLlmTerminalOutcome(synthetic, "llm_answer_empty", {
        outcomeReason: "no_terminal_outcome_recorded"
      });
    }

    const { remainingLabels, remainingTargetIds } = await this.findRemainingMissingTargets(
      scope,
      targets,
      ashbyConfig.requiredFieldSelectors
    );
    const remainingSet = new Set(remainingLabels.map((label) => this.normalize(label)));
    const recoveredLabels = this.mergeUnique(
      targets
        .map((target) => target.label)
        .filter((label) => !remainingSet.has(this.normalize(label)))
    );
    for (const target of targets) {
      if (!target.field) continue;
      if (!target.field.required) continue;
      if (!this.isProfileUnknownField(target.field, context.profile, postingLocation, ashbyConfig)) continue;
      if (remainingSet.has(this.normalize(target.label))) {
        this.markUnknownFieldUnresolved(result, target.label);
      }
    }
    return { filledCount: filled, remainingLabels, remainingTargetIds, recoveredLabels };
  }

  private async findRemainingMissingTargets(
    scope: AshbyInteractionScope,
    targets: AshbyRecoveryTarget[],
    requiredFieldSelectors: string[] | undefined
  ): Promise<{ remainingLabels: string[]; remainingTargetIds: string[] }> {
    const currentlyMissingDescriptors = await this.detectMissingRequiredFieldDescriptors(scope, requiredFieldSelectors);
    const currentlyMissing = currentlyMissingDescriptors.map((item) => item.label);
    const missingIdentitySet = new Set(
      currentlyMissingDescriptors
        .map((item) => this.normalize(item.identity ?? ""))
        .filter(Boolean)
    );
    const remainingLabels: string[] = [];
    const remainingTargetIds: string[] = [];

    for (const target of targets) {
      const targetIdentity = this.normalize(target.identity);
      const unresolvedByIdentity = targetIdentity ? missingIdentitySet.has(targetIdentity) : false;
      const unresolvedFromRequiredSignals = currentlyMissing.some((candidate) =>
        this.labelsRoughlyMatch(candidate, target.label)
      );
      const answered = target.field
        ? await this.verifyFieldAnswered(scope, target.field)
        : await this.isQuestionAnsweredByLabel(scope, target.label);
      if (!answered || unresolvedFromRequiredSignals || unresolvedByIdentity) {
        remainingLabels.push(target.label);
        remainingTargetIds.push(target.identity);
      }
    }

    return {
      remainingLabels: this.mergeUnique(remainingLabels),
      remainingTargetIds: this.mergeUnique(remainingTargetIds)
    };
  }

  private isCriticalRequiredField(field: DetectedField): boolean {
    if (!field.required) return false;
    if (field.type === "file") return true;
    const label = this.normalize(field.label);
    const id = this.normalize(field.id);
    if (this.isLocationPrompt(label) || this.isCountryResidencePrompt(label) || /(^|[^a-z0-9])location([^a-z0-9]|$)/.test(id)) {
      return true;
    }
    const consentLike = /\b(consent|acknowledg|agree|policy|terms|privacy|background check|authorization)\b/.test(label);
    return consentLike && (field.type === "single_select" || field.type === "boolean");
  }

  private async stabilizeCriticalRequiredFields(
    context: AdapterRunContext,
    scope: AshbyInteractionScope,
    ashbyConfig: AshbyConfig,
    result: JobRunResult,
    pass: number,
    companyContext?: string,
    postingLocation?: string,
    validatedGood?: Map<string, string>
  ): Promise<void> {
    const fields = await this.extractVisibleFieldsSafely(scope, context.logger, result.url, ashbyConfig);
    const critical = fields.filter((field) => this.isCriticalRequiredField(field));
    let recommitted = 0;
    let resumeAck = false;
    for (const field of critical) {
      const answered = await this.verifyFieldAnswered(scope, field);
      if (answered) {
        const canonical = this.stringifyValue(await this.resolveCanonicalFilledValue(scope, field, null));
        validatedGood?.set(this.getFieldIdentity(field), canonical);
        if (field.type === "file") resumeAck = true;
        continue;
      }

      const resolved = this.resolveEffectiveAnswerForField(
        field,
        undefined,
        context.profile,
        result.company,
        result.jobTitle,
        companyContext,
        postingLocation,
        ashbyConfig,
        true
      );
      const normalized = this.normalizeAnswerForField(field, resolved?.value);
      const fallback = this.targetedFallbackValue(
        field,
        field.label,
        context.profile,
        result.company,
        result.jobTitle,
        companyContext,
        postingLocation,
        ashbyConfig
      );
      const value = this.sanitizeValueForField(field, normalized ?? fallback);
      if (!this.answerHasValue(value)) continue;
      const applied = await this.fillFieldWithVerification(scope, field, value, {
        profile: context.profile,
        postingLocation,
        ashbyConfig,
        logger: context.logger
      });
      if (!applied) continue;
      recommitted += 1;
      const canonical = this.stringifyValue(await this.resolveCanonicalFilledValue(scope, field, value));
      validatedGood?.set(this.getFieldIdentity(field), canonical);
      result.notes.push(`fill:${pass}:${field.label}:pre_submit_stabilization`);
      if (field.type === "file") resumeAck = true;
    }
    result.notes.push(
      `pre_submit_stabilization:critical_checked=${critical.length}:recommitted=${recommitted}:resume_ack=${resumeAck ? "ok" : "fail"}`
    );
  }

  private async captureAttemptFieldSnapshot(
    scope: AshbyInteractionScope,
    labels: string[]
  ): Promise<Map<string, string>> {
    const snapshot = new Map<string, string>();
    for (const label of this.mergeUnique(labels)) {
      const key = this.normalize(label);
      const answered = await this.isQuestionAnsweredByLabel(scope, label);
      snapshot.set(key, answered ? "answered" : "missing");
    }
    return snapshot;
  }

  private diffSnapshots(before: Map<string, string>, after: Map<string, string>): string {
    const keys = Array.from(new Set([...before.keys(), ...after.keys()]));
    const parts: string[] = [];
    for (const key of keys) {
      const left = before.get(key) ?? "unknown";
      const right = after.get(key) ?? "unknown";
      if (left !== right) parts.push(`${key}=${left}->${right}`);
    }
    return parts.length ? parts.join(";") : "no_change";
  }

  private mapMissingLabelsToRecoveryTargets(
    fields: DetectedField[],
    labels: string[],
    descriptors: MissingFieldDescriptor[] = []
  ): AshbyRecoveryTarget[] {
    const dedupedLabels = this.mergeUnique(labels);
    const descriptorByLabel = new Map<string, MissingFieldDescriptor[]>();
    for (const descriptor of descriptors) {
      const key = this.normalize(descriptor.label);
      if (!key) continue;
      const existing = descriptorByLabel.get(key) ?? [];
      existing.push(descriptor);
      descriptorByLabel.set(key, existing);
    }
    return dedupedLabels.map((label) => {
      const candidatesByLabel = descriptorByLabel.get(this.normalize(label)) ?? [];
      for (const candidate of candidatesByLabel) {
        const candidateIdentity = candidate.identity;
        if (!candidateIdentity) continue;
        const matchedByIdentity = fields.find((field) => this.normalize(this.getFieldIdentity(field)) === this.normalize(candidateIdentity));
        if (matchedByIdentity) {
          return {
            label,
            field: matchedByIdentity,
            identity: this.getFieldIdentity(matchedByIdentity)
          };
        }
      }

      const best = fields
        .map((field) => ({
          field,
          score: this.computeLabelMatchScore(field.label, label)
        }))
        .sort((a, b) => b.score - a.score)[0];
      if (!best || best.score <= 0) {
        return { label, identity: `label:${this.normalize(label)}` };
      }
      const bestIsLocation = this.isLocationPrompt(this.normalize(best.field.label));
      const targetIsLocation = this.isLocationPrompt(this.normalize(label));
      if (bestIsLocation && !targetIsLocation) {
        return { label, identity: `label:${this.normalize(label)}` };
      }
      return {
        label,
        field: best.field,
        identity: this.getFieldIdentity(best.field)
      };
    });
  }

  private computeLabelMatchScore(fieldLabel: string, missingLabel: string): number {
    const left = this.normalize(fieldLabel).replace(/[^\w\s]/g, "");
    const right = this.normalize(missingLabel).replace(/[^\w\s]/g, "");
    if (!left || !right) return 0;
    if (left === right) return 100;
    if (left.includes(right) || right.includes(left)) return 80;
    const leftTokens = new Set(left.split(/\s+/).filter((token) => token.length > 2));
    const rightTokens = new Set(right.split(/\s+/).filter((token) => token.length > 2));
    if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
    let overlap = 0;
    for (const token of leftTokens) {
      if (rightTokens.has(token)) overlap += 1;
    }
    return overlap / Math.max(Math.min(leftTokens.size, rightTokens.size), 1);
  }

  private getFieldIdentity(field: DetectedField): string {
    const groupIdentity = typeof field.platformMeta?.groupIdentity === "string" ? String(field.platformMeta.groupIdentity) : "";
    if (groupIdentity.trim()) return groupIdentity.trim();
    const fieldPath = typeof field.platformMeta?.fieldPath === "string" ? String(field.platformMeta.fieldPath) : "";
    if (fieldPath.trim()) return `fieldPath:${fieldPath}`;
    return `fieldId:${field.id}`;
  }

  private labelsRoughlyMatch(fieldLabel: string, missingLabel: string): boolean {
    const left = this.normalize(fieldLabel).replace(/[^\w\s]/g, "");
    const right = this.normalize(missingLabel).replace(/[^\w\s]/g, "");
    if (!left || !right) return false;
    return left.includes(right) || right.includes(left);
  }

  private async recoverMissingLabelBySection(
    ashbyConfig: AshbyConfig,
    scope: AshbyInteractionScope,
    missingLabel: string,
    profile: CandidateProfile,
    company?: string,
    jobTitle?: string,
    companyContext?: string,
    postingLocation?: string,
    preferredValue?: string | string[] | boolean | null
  ): Promise<boolean> {
    const tryRecover = async (value?: string | string[] | boolean | null): Promise<boolean> => {
      const recovered = await this.fillByQuestionSection(
        scope,
        missingLabel,
        profile,
        company,
        jobTitle,
        companyContext,
        postingLocation,
        value,
        ashbyConfig
      );
      if (!recovered) return false;
      await new Promise((resolve) => setTimeout(resolve, 180));
      const answered = await this.isQuestionAnsweredByLabel(scope, missingLabel);
      if (answered) return true;
      const stillMissingLabels = await this.detectMissingRequiredFields(scope, ashbyConfig.requiredFieldSelectors);
      return !stillMissingLabels.some((label) => this.labelsRoughlyMatch(label, missingLabel));
    };

    if (await tryRecover(preferredValue ?? null)) return true;
    if (preferredValue !== undefined && preferredValue !== null) {
      if (await tryRecover(null)) return true;
    }
    return false;
  }

  private companyAwareFallbackValue(
    field: DetectedField,
    profile: CandidateProfile,
    company?: string,
    jobTitle?: string,
    companyContext?: string
  ): string | null {
    if (field.type !== "text" && field.type !== "textarea") return null;
    if (!this.isCompanyUnderstandingPrompt(field.label) && !this.normalize(field.label).includes("great fit")) {
      return null;
    }
    if (this.isCompanyUnderstandingPrompt(field.label)) {
      return this.buildCompanyUnderstandingResponse(field.label, company, jobTitle, companyContext);
    }
    if (this.normalize(field.label).includes("great fit")) {
      if (companyContext?.trim()) {
        return `I’m a strong fit because my experience aligns with ${company ?? "the team"} and this ${jobTitle ?? "role"}. I’m motivated by ${companyContext.slice(0, 140).replace(/\s+/g, " ").trim()}.`;
      }
      const narrative = this.buildNarrativeFallback(field.label, profile, company, jobTitle);
      return narrative ?? "Strong fit based on relevant software engineering experience.";
    }
    return null;
  }

  private isOfficeChoicePrompt(normalizedLabel: string): boolean {
    if (this.isHybridWorkPreferencePrompt(normalizedLabel)) return false;
    return (
      normalizedLabel.includes("which office") ||
      (normalizedLabel.includes("office") && normalizedLabel.includes("work from")) ||
      (normalizedLabel.includes("office") && normalizedLabel.includes("days/week")) ||
      (normalizedLabel.includes("office") && normalizedLabel.includes("days per week")) ||
      (normalizedLabel.includes("willing to work") && normalizedLabel.includes("office"))
    );
  }

  private resolveOfficeFallbackPolicy(ashbyConfig?: AshbyConfig): "best_match" | "none_of_above" | "block_submit" {
    const policy = ashbyConfig?.officeFallbackPolicy;
    if (policy === "none_of_above" || policy === "block_submit" || policy === "best_match") return policy;
    return "best_match";
  }

  private isRelocationOpen(profile: CandidateProfile, ashbyConfig?: AshbyConfig): boolean {
    const custom = profile.customAnswers ?? {};
    const normalized = new Map<string, unknown>();
    for (const [key, value] of Object.entries(custom)) {
      normalized.set(this.normalize(key), value);
    }
    const hints = this.mergeUnique(DEFAULT_ASHBY_RELOCATION_HINTS, ashbyConfig?.relocationOpenKeywordHints ?? [])
      .map((item) => this.normalize(item))
      .filter(Boolean);
    for (const hint of hints) {
      for (const [key, value] of normalized.entries()) {
        if (!key.includes(hint)) continue;
        const boolLike = stringifyBooleanish(value);
        if (boolLike !== null) return boolLike;
        const text = this.normalize(String(value ?? ""));
        if (text.includes("open") || text.includes("anywhere") || text.includes("yes")) return true;
      }
    }
    return false;
  }

  private resolveOfficeOption(
    options: string[],
    profile: CandidateProfile,
    postingLocation?: string,
    ashbyConfig?: AshbyConfig
  ): string | null {
    const usableOptions = options.filter((item) => {
      const normalized = this.normalize(item);
      return normalized.length > 0 && !["select", "select one", "choose", "choose one", "please select"].includes(normalized);
    });
    if (usableOptions.length === 0) return null;

    const preferredLocations = [
      postingLocation,
      profile.basics.location,
      profile.state,
      profile.country
    ]
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);

    for (const preferred of preferredLocations) {
      const normalizedPreferred = this.normalize(preferred);
      const exact = usableOptions.find((option) => {
        const normalizedOption = this.normalize(option);
        return (
          normalizedOption === normalizedPreferred ||
          normalizedOption.includes(normalizedPreferred) ||
          normalizedPreferred.includes(normalizedOption)
        );
      });
      if (exact) return exact;
    }

    const policy = this.resolveOfficeFallbackPolicy(ashbyConfig);
    if (policy === "block_submit") return null;
    if (policy === "none_of_above") {
      const none = usableOptions.find((option) => /(none of the above|none|n\/a|not listed)/i.test(option));
      return none ?? this.pickFirstUsableOption(usableOptions) ?? null;
    }

    const relocationOpen = this.isRelocationOpen(profile, ashbyConfig);
    if (!relocationOpen) {
      return this.pickFirstUsableOption(usableOptions) ?? null;
    }

    const preferenceTokens = preferredLocations
      .flatMap((item) => this.normalize(item).split(/[\s,/-]+/))
      .filter((token) => token.length > 1);
    const preferredTokenSet = new Set(preferenceTokens);
    const scored = usableOptions.map((option) => {
      const normalized = this.normalize(option);
      const optionTokens = normalized.split(/[\s,/-]+/).filter((token) => token.length > 1);
      let score = 0;
      for (const token of optionTokens) {
        if (preferredTokenSet.has(token)) score += 20;
      }
      if (/\b(california|ca)\b/.test(normalized) && /california|ca/.test(this.normalize(profile.state ?? ""))) score += 25;
      if (/\b(united states|usa|us)\b/.test(normalized) && /united states|usa|us/.test(this.normalize(profile.country ?? "united states"))) score += 10;
      if (/\b(remote|anywhere)\b/.test(normalized)) score -= 5;
      return { option, score };
    });
    scored.sort((a, b) => b.score - a.score);
    if (scored[0] && scored[0].score > 0) return scored[0].option;

    return this.pickFirstUsableOption(usableOptions) ?? null;
  }

  private isOfficeRelocationInPersonPrompt(normalizedLabel: string): boolean {
    if (!normalizedLabel) return false;
    return (
      this.isOfficeChoicePrompt(normalizedLabel) ||
      normalizedLabel.includes("willing to work from our") ||
      normalizedLabel.includes("in office") ||
      normalizedLabel.includes("in-office") ||
      normalizedLabel.includes("hybrid") ||
      normalizedLabel.includes("commute") ||
      normalizedLabel.includes("relocate") ||
      normalizedLabel.includes("2-3 days a week") ||
      normalizedLabel.includes("office requirement") ||
      normalizedLabel.includes("anchor days") ||
      (normalizedLabel.includes("read and understand") && normalizedLabel.includes("office")) ||
      (normalizedLabel.includes("read and understand") && normalizedLabel.includes("policy"))
    );
  }

  private isAffirmativeWillingnessValue(value: unknown): boolean {
    const normalized = this.normalize(String(value ?? ""));
    if (!normalized) return false;
    return (
      normalized === "yes" ||
      normalized === "true" ||
      /\byes\b/.test(normalized) ||
      normalized.includes("i understand") ||
      normalized.includes("willing") ||
      normalized.includes("open to") ||
      normalized.includes("can commute")
    );
  }

  private isNegativeWillingnessValue(value: unknown): boolean {
    const normalized = this.normalize(String(value ?? ""));
    if (!normalized) return false;
    return (
      normalized === "no" ||
      normalized === "false" ||
      /\bno\b/.test(normalized) ||
      normalized.includes("not willing") ||
      normalized.includes("cannot commute")
    );
  }

  private resolveAffirmativeWillingnessValue(
    field: Pick<DetectedField, "label" | "type" | "options">
  ): string | string[] | boolean | null {
    const normalizedLabel = this.normalize(field.label);
    if (field.type === "single_select") {
      return (
        this.pickOptionForYesNo(field.options, normalizedLabel, "yes") ??
        this.pickOptionByKeywords(field.options, ["yes", "true", "willing", "open", "understand"]) ??
        "Yes"
      );
    }
    if (field.type === "boolean") return true;
    if (field.type === "multi_select") {
      const yesLike =
        this.pickOptionForYesNo(field.options, normalizedLabel, "yes") ??
        this.pickOptionByKeywords(field.options, ["yes", "true", "willing", "open", "understand"]);
      return yesLike ? [yesLike] : null;
    }
    if (field.type === "text" || field.type === "textarea") return "Yes";
    return null;
  }

  private profileIndicatesOfficeRelocationOpenness(profile: CandidateProfile, ashbyConfig?: AshbyConfig): boolean {
    if (this.isRelocationOpen(profile, ashbyConfig)) return true;
    const custom = profile.customAnswers ?? {};
    for (const [rawKey, rawValue] of Object.entries(custom)) {
      const key = this.normalize(rawKey);
      if (
        !key.includes("relocat") &&
        !key.includes("office") &&
        !key.includes("hybrid") &&
        !key.includes("commute") &&
        !key.includes("anchor days") &&
        !key.includes("work from")
      ) {
        continue;
      }
      const boolLike = stringifyBooleanish(rawValue);
      if (boolLike === true) return true;
      const value = this.normalize(String(rawValue ?? ""));
      if (value.includes("yes") || value.includes("open") || value.includes("willing") || value.includes("hybrid")) {
        return true;
      }
    }
    return false;
  }

  private hasPriorAffirmativeOfficeRelocationIntent(result: JobRunResult): boolean {
    return (result.filledFields ?? []).some((entry) => {
      const normalizedLabel = this.normalize(entry.label);
      if (!this.isOfficeRelocationInPersonPrompt(normalizedLabel)) return false;
      return this.isAffirmativeWillingnessValue(entry.value);
    });
  }

  private guardUnsafeOfficeRelocationFallback(
    field: Pick<DetectedField, "label" | "type" | "options">,
    fallbackValue: string | string[] | boolean | null,
    profile: CandidateProfile,
    result: JobRunResult,
    ashbyConfig: AshbyConfig | undefined,
    phase: "fill_pass" | "recovery"
  ): string | string[] | boolean | null {
    if (!this.answerHasValue(fallbackValue)) return fallbackValue;
    const normalizedLabel = this.normalize(field.label);
    if (!this.isOfficeRelocationInPersonPrompt(normalizedLabel)) return fallbackValue;
    if (!this.isNegativeWillingnessValue(fallbackValue)) return fallbackValue;

    const profileOpen = this.profileIndicatesOfficeRelocationOpenness(profile, ashbyConfig);
    const priorAffirmative = this.hasPriorAffirmativeOfficeRelocationIntent(result);
    if (!profileOpen && !priorAffirmative) {
      result.notes.push(`fallback_guard:${phase}:${field.label}:blocked_unsafe_no`);
      return null;
    }

    const affirmative = this.resolveAffirmativeWillingnessValue(field);
    if (this.answerHasValue(affirmative)) {
      result.notes.push(
        `fallback_guard:${phase}:${field.label}:no_to_yes:${profileOpen ? "profile_open" : "prior_affirmative_intent"}`
      );
      return affirmative as string | string[] | boolean;
    }
    return fallbackValue;
  }

  private resolveLocationAvailabilitySelections(
    options: string[],
    profile: CandidateProfile,
    postingLocation?: string,
    ashbyConfig?: AshbyConfig
  ): string[] {
    const usableOptions = options.filter((item) => {
      const normalized = this.normalize(item);
      return normalized.length > 0 && !["select", "select one", "choose", "choose one", "please select"].includes(normalized);
    });
    if (usableOptions.length === 0) return [];

    const ranked = usableOptions
      .map((option) => {
        const normalized = this.normalize(option);
        let score = 0;
        const preferred = [
          postingLocation,
          profile.basics.location,
          profile.state,
          profile.country
        ]
          .map((item) => this.normalize(String(item ?? "")))
          .filter(Boolean);
        for (const token of preferred.flatMap((item) => item.split(/[\s,/-]+/).filter((part) => part.length > 1))) {
          if (normalized.includes(token)) score += 12;
        }
        if (/\b(california|ca)\b/.test(normalized) && /california|ca/.test(this.normalize(profile.state ?? ""))) score += 18;
        if (/\b(united states|usa|us)\b/.test(normalized) && /united states|usa|us/.test(this.normalize(profile.country ?? "united states"))) score += 8;
        if (/\b(remote|anywhere)\b/.test(normalized)) score += this.isRelocationOpen(profile, ashbyConfig) ? 4 : -6;
        return { option, score };
      })
      .sort((a, b) => b.score - a.score);

    if (ranked[0] && ranked[0].score > 0) return [ranked[0].option];
    const office = this.resolveOfficeOption(usableOptions, profile, postingLocation, ashbyConfig);
    return office ? [office] : [];
  }

  private locationAwareFallbackValue(
    field: Pick<DetectedField, "id" | "type" | "label" | "options">,
    profile: CandidateProfile,
    postingLocation?: string,
    ashbyConfig?: AshbyConfig
  ): string | string[] | boolean | null {
    const normalized = this.normalize(field.label);
    if (this.isOfficeChoicePrompt(normalized) && field.type === "single_select" && field.options?.length) {
      return this.resolveOfficeOption(field.options, profile, postingLocation, ashbyConfig);
    }
    const normalizedId = this.normalize(String(field.id ?? ""));
    const locationById = /(^|[^a-z0-9])location([^a-z0-9]|$)/.test(normalizedId);
    if (!this.isLocationPrompt(normalized) && !locationById) return null;
    const locationSpec = this.resolveAshbyLocationSpec(profile, postingLocation);
    const canonicalLocation = locationSpec?.target ?? null;

    if (field.type === "single_select" && field.options?.length) {
      const preferred = this.isCountryResidencePrompt(normalized)
        ? [profile.country, canonicalLocation, profile.state, postingLocation]
        : [canonicalLocation, profile.state, profile.country, postingLocation];
      const preferredList = preferred
        .map((value) => String(value ?? "").trim())
        .filter(Boolean);
      for (const candidate of preferredList) {
        const match = field.options.find((option) => {
          const left = this.normalize(option);
          const right = this.normalize(candidate);
          return left === right || left.includes(right) || right.includes(left);
        });
        if (match) return match;
      }
      return this.pickFirstUsableOption(field.options) ?? null;
    }
    if (this.isCountryResidencePrompt(normalized)) {
      return profile.country ?? "United States";
    }
    if (locationById && field.id === "_systemfield_location") {
      return canonicalLocation ?? profile.state ?? profile.country ?? null;
    }
    return canonicalLocation ?? profile.state ?? profile.country ?? postingLocation ?? "United States";
  }

  private profileMapperEnabled(ashbyConfig?: AshbyConfig): boolean {
    return ashbyConfig?.profileMapperEnabled ?? true;
  }

  private findCustomAnswerText(profile: CandidateProfile, patterns: RegExp[]): string | undefined {
    for (const [rawKey, rawValue] of Object.entries(profile.customAnswers ?? {})) {
      const key = this.normalize(rawKey);
      if (!patterns.some((pattern) => pattern.test(key))) continue;
      const value = String(rawValue ?? "").trim();
      if (value) return value;
    }
    return undefined;
  }

  private findCustomAnswerUrl(profile: CandidateProfile, patterns: RegExp[]): string | undefined {
    for (const [rawKey, rawValue] of Object.entries(profile.customAnswers ?? {})) {
      const key = this.normalize(rawKey);
      if (!patterns.some((pattern) => pattern.test(key))) continue;
      if (typeof rawValue === "string") {
        const value = rawValue.trim();
        if (/^https?:\/\//i.test(value)) return value;
      }
      if (Array.isArray(rawValue)) {
        for (const item of rawValue) {
          const value = String(item ?? "").trim();
          if (/^https?:\/\//i.test(value)) return value;
        }
      }
    }
    return undefined;
  }

  private resolveGithubContributionUrl(profile: CandidateProfile): string | undefined {
    const fromCustom = this.findCustomAnswerUrl(profile, [
      /\bfavorite github contribution\b/,
      /\bgithub contribution\b/,
      /\bgithub project\b/,
      /\brepository link\b/,
      /\brepo link\b/,
      /\bcode sample\b/
    ]);
    if (fromCustom) return fromCustom;
    return profile.links?.github;
  }

  private resolvePronounsValue(profile: CandidateProfile, ashbyConfig?: AshbyConfig): string {
    const fromCustom = this.findCustomAnswerText(profile, [
      /\bpronouns?\b/,
      /\bpronoun\b/,
      /\bgender pronouns?\b/
    ]);
    if (fromCustom) return fromCustom;
    const configured = String(ashbyConfig?.pronounsDefault ?? "").trim();
    if (configured) return configured;
    const gender = this.normalize(
      String(this.findCustomAnswerText(profile, [/\bgender\b/, /\bsex\b/]) ?? "")
    );
    if (gender.includes("male")) return "He/Him";
    if (gender.includes("female")) return "She/Her";
    return "He/Him";
  }

  private resolveProfilePromptValue(
    field: Pick<DetectedField, "id" | "label" | "type" | "required" | "options" | "placeholder" | "platformMeta">,
    profile: CandidateProfile,
    postingLocation?: string,
    ashbyConfig?: AshbyConfig
  ): { value: string | string[] | boolean | null; source: ResolvedAnswer["source"]; reason: string } | null {
    if (!this.profileMapperEnabled(ashbyConfig)) return null;

    const label = this.normalize(field.label);
    const question: ApplicationQuestion = {
      id: field.id,
      label: field.label,
      type: field.type,
      required: field.required ?? false,
      options: field.options,
      placeholder: field.placeholder,
      platformMeta: field.platformMeta
    };

    const accommodationPolicyValue = this.resolveAccommodationPolicyValue(field, ashbyConfig);
    if (accommodationPolicyValue) {
      return {
        value: accommodationPolicyValue,
        source: "rule",
        reason: "policy_accommodation"
      };
    }

    const isFirstNamePrompt =
      /\b(first|given|forename)\s+name\b/.test(label) ||
      /\blegal\s+first\s+name\b/.test(label) ||
      /\bname\s*\(\s*first\s*\)/.test(label);
    const isLastNamePrompt =
      /\b(last|family|sur)\s*name\b/.test(label) ||
      /\bsurname\b/.test(label) ||
      /\blegal\s+last\s+name\b/.test(label) ||
      /\bname\s*\(\s*last\s*\)/.test(label);

    if (isFirstNamePrompt && !/(preferred first name|first name if different|if different)/.test(label)) {
      return { value: profile.basics.firstName, source: "profile", reason: "profile_mapper_first_name" };
    }

    if (isLastNamePrompt) {
      return { value: profile.basics.lastName, source: "profile", reason: "profile_mapper_last_name" };
    }

    if (
      label === "name" ||
      label.includes("full legal name") ||
      label.includes("full name") ||
      label.includes("legal name")
    ) {
      return {
        value: profile.basics.fullName ?? `${profile.basics.firstName} ${profile.basics.lastName}`.trim(),
        source: "profile",
        reason: "profile_mapper_full_name"
      };
    }

    if (label.includes("pronoun")) {
      const pronouns = this.resolvePronounsValue(profile, ashbyConfig);
      if (field.type === "single_select" && field.options?.length) {
        const matched =
          this.pickOptionByKeywords(field.options, [this.normalize(pronouns)]) ??
          this.pickOptionByKeywords(field.options, ["he/him", "he him", "he"]) ??
          this.pickFirstUsableOption(field.options);
        if (matched) return { value: matched, source: "profile", reason: "profile_mapper_pronouns" };
      }
      return { value: pronouns, source: "profile", reason: "profile_mapper_pronouns" };
    }

    if ((this.isLocationPrompt(label) || this.isOfficeChoicePrompt(label)) && !this.isLocationAvailabilityPrompt(label)) {
      const value = this.locationAwareFallbackValue(field, profile, postingLocation, ashbyConfig);
      if (this.answerHasValue(value)) {
        return { value, source: "profile", reason: "profile_mapper_location" };
      }
    }
    if (this.isInternshipAgreementPrompt(label)) {
      return null;
    }
    if (this.isGithubContributionPrompt(label)) {
      const contributionUrl = this.resolveGithubContributionUrl(profile);
      if (contributionUrl) {
        return { value: contributionUrl, source: "profile", reason: "profile_mapper_github_contribution" };
      }
    }

    if (this.isApplicationSourcePrompt(label) && !this.isConditionalFollowupPrompt(label)) {
      if (field.type === "single_select") {
        return {
          value: this.pickSourceOption(field.options) ?? this.pickFirstUsableOption(field.options) ?? "Online Job Board",
          source: "rule",
          reason: "profile_mapper_source"
        };
      }
      return { value: "Online Job Board", source: "rule", reason: "profile_mapper_source" };
    }

    if ((label.includes("authorized to work") || label.includes("work authorization")) && field.type === "single_select") {
      const preferredCountry = profile.country ?? "United States";
      const countryMatch = field.options?.find((option) => {
        const normalizedOption = this.normalize(option);
        const normalizedCountry = this.normalize(preferredCountry);
        return (
          normalizedOption === normalizedCountry ||
          normalizedOption.includes(normalizedCountry) ||
          normalizedCountry.includes(normalizedOption)
        );
      });
      if (countryMatch) {
        return { value: countryMatch, source: "profile", reason: "profile_mapper_work_auth_country" };
      }
      const authorizedToWork = profile.workAuthorization?.authorizedToWork ?? true;
      const yesNo = this.pickOptionForYesNo(field.options, label, authorizedToWork ? "yes" : "no");
      if (yesNo) return { value: yesNo, source: "profile", reason: "profile_mapper_work_auth_yes_no" };
    }
    if (
      (label.includes("currently pursuing") || label.includes("pursuing a degree")) &&
      (label.includes("computer science") || label.includes("related field"))
    ) {
      const educationText = this.normalize(
        `${profile.education?.field ?? ""} ${profile.education?.degree ?? ""} ${profile.education?.highestDegree ?? ""}`
      );
      const isCsLike = /\b(computer science|cs|software|engineering)\b/.test(educationText);
      if (field.type === "single_select") {
        const choice = this.pickOptionForYesNo(field.options, label, isCsLike ? "yes" : "no");
        if (choice) return { value: choice, source: "profile", reason: "profile_mapper_degree_field_alignment" };
      }
      return { value: isCsLike ? "Yes" : "No", source: "profile", reason: "profile_mapper_degree_field_alignment" };
    }
    if (field.type === "single_select" && this.isHybridWorkPreferencePrompt(label)) {
      const hybridChoice = this.resolveHybridWorkPreferenceOption(field.label, field.options, profile);
      if (hybridChoice) {
        return { value: hybridChoice, source: "profile", reason: "profile_mapper_hybrid_preference" };
      }
    }

    if (!this.isProfilePromptLike(field.label)) {
      return null;
    }

    const deterministic = evaluateDeterministicRule(question, profile);
    if (deterministic.answer !== undefined && deterministic.answer !== null) {
      return {
        value: deterministic.answer,
        source: deterministic.source ?? "rule",
        reason: deterministic.reason ?? "profile_mapper_deterministic"
      };
    }

    const mapped = evaluateProfileMapping(question, profile);
    if (mapped.answer !== undefined && mapped.answer !== null) {
      return {
        value: mapped.answer,
        source: mapped.source ?? "profile",
        reason: mapped.reason ?? "profile_mapper_profile"
      };
    }

    return null;
  }

  private isProfilePromptLike(label: string): boolean {
    const normalized = this.normalize(label);
    const firstNameLike =
      /\b(first|given|forename)\s+name\b/.test(normalized) ||
      /\blegal\s+first\s+name\b/.test(normalized) ||
      /\bname\s*\(\s*first\s*\)/.test(normalized);
    const lastNameLike =
      /\b(last|family|sur)\s*name\b/.test(normalized) ||
      /\bsurname\b/.test(normalized) ||
      /\blegal\s+last\s+name\b/.test(normalized) ||
      /\bname\s*\(\s*last\s*\)/.test(normalized);
    return (
      firstNameLike ||
      lastNameLike ||
      normalized.includes("preferred first name") ||
      normalized.includes("full legal name") ||
      normalized.includes("full name") ||
      normalized.includes("legal name") ||
      /\bemail\b|e-mail/.test(normalized) ||
      /\bphone\b|mobile|telephone|contact number/.test(normalized) ||
      normalized.includes("pronoun") ||
      this.isLocationPrompt(normalized) ||
      normalized.includes("current country of residence") ||
      normalized.includes("country of citizenship") ||
      normalized.includes("citizenship") ||
      normalized.includes("authorized to work") ||
      normalized.includes("work authorization") ||
      normalized.includes("visa") ||
      normalized.includes("work permit") ||
      normalized.includes("sponsorship") ||
      this.isApplicationSourcePrompt(normalized) ||
      this.isGithubContributionPrompt(normalized)
    );
  }

  private resolveFinalTextFallbackValue(ashbyConfig?: AshbyConfig): string {
    const configured = String(ashbyConfig?.finalTextFallbackValue ?? "").trim();
    return configured || DEFAULT_FINAL_TEXT_FALLBACK_VALUE;
  }

  private allowProfileSummaryFallbackForExplicitSummaryPrompts(ashbyConfig?: AshbyConfig): boolean {
    return ashbyConfig?.allowProfileSummaryFallbackForExplicitSummaryPrompts ?? true;
  }

  private resolveTextCommitMode(ashbyConfig?: AshbyConfig): AshbyTextCommitMode {
    return ashbyConfig?.textCommitMode ?? DEFAULT_ASHBY_TEXT_COMMIT_MODE;
  }

  private resolveDateFallbackPolicy(ashbyConfig?: AshbyConfig): AshbyDateFallbackPolicy {
    return ashbyConfig?.dateFallbackPolicy ?? DEFAULT_ASHBY_DATE_FALLBACK_POLICY;
  }

  private resolveUnknownRequiredTextPolicy(ashbyConfig?: AshbyConfig): AshbyUnknownRequiredTextPolicy {
    return ashbyConfig?.unknownRequiredTextPolicy ?? DEFAULT_ASHBY_UNKNOWN_REQUIRED_TEXT_POLICY;
  }

  private isDateLikePrompt(label: string, placeholder?: string): boolean {
    const normalized = this.normalize(label);
    const normalizedPlaceholder = this.normalize(String(placeholder ?? ""));
    return (
      /\b(start date|earliest start|available to start|availability date|date available|when can you start|notice period)\b/.test(normalized) ||
      /\bdate\b/.test(normalized) ||
      /\b(mm\/dd\/yyyy|yyyy-mm-dd|dd\/mm\/yyyy|date)\b/.test(normalizedPlaceholder)
    );
  }

  private parseDateLikeValue(raw: string): Date | null {
    const value = String(raw ?? "").trim();
    if (!value) return null;
    const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) {
      const year = Number(iso[1]);
      const month = Number(iso[2]);
      const day = Number(iso[3]);
      if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
      const date = new Date(year, month - 1, day);
      if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) return date;
      return null;
    }

    const slash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) {
      const month = Number(slash[1]);
      const day = Number(slash[2]);
      const year = Number(slash[3]);
      if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
      const date = new Date(year, month - 1, day);
      if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) return date;
      return null;
    }

    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
    }
    return null;
  }

  private formatDateWithMonthName(date: Date): string {
    const monthName = date.toLocaleString("en-US", { month: "long" });
    return `${monthName} ${date.getDate()}, ${date.getFullYear()}`;
  }

  private formatDateAsMMDDYYYY(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${month}/${day}/${date.getFullYear()}`;
  }

  private formatDateAsISO(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  private buildDateFormatCandidates(date: Date, placeholder?: string): string[] {
    const monthName = this.formatDateWithMonthName(date);
    const mmddyyyy = this.formatDateAsMMDDYYYY(date);
    const iso = this.formatDateAsISO(date);
    const normalizedPlaceholder = this.normalize(String(placeholder ?? ""));
    const byPlaceholder = /\byyyy-mm-dd\b/.test(normalizedPlaceholder)
      ? [iso, mmddyyyy, monthName]
      : /\b(mm\/dd\/yyyy|m\/d\/yyyy)\b/.test(normalizedPlaceholder)
        ? [mmddyyyy, monthName, iso]
        : [monthName, mmddyyyy, iso];
    return this.mergeUnique(byPlaceholder);
  }

  private canonicalizeDateText(raw: string): string | null {
    const parsed = this.parseDateLikeValue(raw);
    if (!parsed) return null;
    return `date:${this.formatDateAsISO(parsed)}`;
  }

  private fieldCapability(
    field: Pick<DetectedField, "type" | "label" | "placeholder" | "platformMeta">
  ): AshbyFieldCapability | null {
    if (field.type !== "text" && field.type !== "textarea") return null;
    const normalizedLabel = this.normalize(field.label);
    const normalizedPlaceholder = this.normalize(String(field.placeholder ?? ""));
    const role = this.normalize(String(field.platformMeta?.role ?? ""));
    const inputType = this.normalize(String(field.platformMeta?.inputType ?? ""));
    const hasDatalist = Boolean(field.platformMeta?.hasDatalist);
    const ariaHasPopup = this.normalize(String(field.platformMeta?.ariaHasPopup ?? ""));

    if (
      this.isDateLikePrompt(field.label, field.placeholder) ||
      inputType === "date" ||
      normalizedPlaceholder.includes("date") ||
      ariaHasPopup === "dialog"
    ) {
      return "date_like_text";
    }

    if (
      role === "combobox" ||
      ariaHasPopup === "listbox" ||
      hasDatalist ||
      inputType === "search" ||
      this.isLocationPrompt(normalizedLabel)
    ) {
      return "typeahead_text";
    }

    if (field.type === "textarea") return "interactive_text";
    return "plain_text";
  }

  private isDegreeSelectionPrompt(label: string | undefined): boolean {
    const normalized = this.normalize(String(label ?? ""));
    if (!normalized || !normalized.includes("degree")) return false;
    if (
      normalized.includes("currently pursuing") ||
      normalized.includes("pursuing a degree") ||
      normalized.includes("computer science or a related field")
    ) {
      return false;
    }
    if (
      normalized.includes("field of study") ||
      normalized.includes("major") ||
      normalized.includes("discipline")
    ) {
      return false;
    }
    return true;
  }

  private canonicalizeDegreeSelectionCandidate(label: string | undefined, candidate: string): string {
    const raw = String(candidate ?? "").trim();
    if (!raw) return "";
    if (!this.isDegreeSelectionPrompt(label)) return raw;
    const normalized = this.normalize(raw);
    const bachelorLike =
      /\bbachelor\b/.test(normalized) ||
      /\bbachelors\b/.test(normalized) ||
      /\bbachelor of science\b/.test(normalized) ||
      /\bb\.?s\.?\b/.test(normalized) ||
      /\bb\s*s\b/.test(normalized) ||
      /\bbs\b/.test(normalized) ||
      /\bbsc\b/.test(normalized) ||
      /\bundergraduate\b/.test(normalized);
    if (bachelorLike) return "Bachelor's Degree";
    return raw;
  }

  private degreeSelectionAliases(text: string): string[] {
    const normalized = this.normalize(text);
    if (!normalized) return [];
    const aliases: string[] = [];
    const push = (value: string) => {
      const token = this.normalize(String(value));
      if (!token) return;
      aliases.push(token);
    };
    const bachelorLike =
      /\bbachelor\b/.test(normalized) ||
      /\bbachelors\b/.test(normalized) ||
      /\bbachelor of science\b/.test(normalized) ||
      /\bb\.?s\.?\b/.test(normalized) ||
      /\bbs\b/.test(normalized) ||
      /\bbsc\b/.test(normalized) ||
      /\bundergraduate\b/.test(normalized);
    if (bachelorLike) {
      push("Bachelor's Degree");
      push("Bachelors Degree");
      push("Bachelor");
      push("Undergraduate/Bachelors");
      push("Undergraduate");
    }
    return this.mergeUnique(aliases);
  }

  private commitStrategyMarkerForField(field: Pick<DetectedField, "type" | "label" | "placeholder" | "platformMeta">): string {
    return this.fieldCapability(field) ?? field.type;
  }

  private isExplicitSummaryBackgroundPrompt(normalizedLabel: string): boolean {
    return (
      normalizedLabel.includes("experience summary") ||
      normalizedLabel.includes("brief background") ||
      normalizedLabel.includes("professional background") ||
      normalizedLabel.includes("work history") ||
      normalizedLabel.includes("career summary") ||
      normalizedLabel.includes("headline companies") ||
      normalizedLabel.includes("summarize your experience") ||
      normalizedLabel.includes("summary of your experience")
    );
  }

  private classifyAshbyTextPromptIntent(label: string, fieldType: "text" | "textarea" = "text"): AshbyTextPromptIntent {
    const normalized = this.normalize(label);
    if (this.isAccommodationFollowupPrompt(normalized)) return "accommodation_followup";
    if (this.isConditionalFollowupPrompt(normalized)) return "conditional_followup";
    if (
      this.isLinkedinPrompt(normalized) ||
      this.isProjectUrlPrompt(normalized) ||
      this.isReplitProfilePrompt(normalized) ||
      this.isPortfolioOrWebsitePrompt(normalized) ||
      this.isGithubOrCodeSamplePrompt(normalized) ||
      normalized.includes("url") ||
      normalized.includes("link")
    ) {
      return "links";
    }
    if (
      normalized.includes("salary") ||
      normalized.includes("compensation") ||
      normalized.includes("base pay") ||
      normalized.includes("pay range") ||
      normalized.includes("total compensation")
    ) {
      return "compensation";
    }
    if (
      this.isDateLikePrompt(label) ||
      normalized.includes("start date") ||
      normalized.includes("notice period") ||
      normalized.includes("available to start") ||
      normalized.includes("when can you start")
    ) {
      return "notice_start_date";
    }
    if (this.isLocationPrompt(normalized) || normalized.includes("country of residence")) {
      return "location_country";
    }
    if (
      normalized.includes("authorized to work") ||
      normalized.includes("work authorization") ||
      normalized.includes("visa") ||
      normalized.includes("work permit") ||
      normalized.includes("sponsorship")
    ) {
      return "legal_work_auth";
    }
    if (this.isCompanyUnderstandingPrompt(label)) return "company_understanding";
    if (
      normalized.includes("great fit") ||
      normalized.includes("why this role") ||
      normalized.includes("why this company") ||
      normalized.includes("what interests you")
    ) {
      return "motivation_fit";
    }
    if (this.isExplicitSummaryBackgroundPrompt(normalized)) return "summary_background";
    if (this.isOpenEndedPrompt({ type: fieldType, label, options: undefined })) return "open_ended_narrative";
    return "misc";
  }

  private resolveAshbyTextFallback(
    label: string,
    fieldType: "text" | "textarea",
    profile: CandidateProfile,
    company?: string,
    jobTitle?: string,
    companyContext?: string,
    postingLocation?: string,
    ashbyConfig?: AshbyConfig,
    placeholder?: string
  ): AshbyTextFallbackResolution {
    const normalized = this.normalize(label);
    const intent = this.classifyAshbyTextPromptIntent(label, fieldType);
    const deterministicFinal = this.resolveFinalTextFallbackValue(ashbyConfig);
    const summary = profile.experience?.summary?.trim() || profile.skillsSummary?.trim() || "";

    const finalize = (value: string | null, reason: string): AshbyTextFallbackResolution => {
      if (this.answerHasValue(value)) {
        return { value: String(value).trim(), reason, intent, deterministicFinal: false };
      }
      return {
        value: deterministicFinal,
        reason: "text_fallback_deterministic_final",
        intent,
        deterministicFinal: true
      };
    };

    if (intent === "accommodation_followup") {
      return finalize(this.resolveAccommodationFollowupDefaultText(ashbyConfig), "text_fallback_accommodation_followup");
    }
    if (intent === "conditional_followup") {
      return finalize(null, "text_fallback_conditional_followup");
    }
    if (normalized === "email" || normalized.includes("email")) {
      return finalize(profile.basics.email ?? null, "text_fallback_email");
    }
    if (normalized === "phone" || normalized.includes("phone")) {
      return finalize(profile.basics.phone ?? null, "text_fallback_phone");
    }
    if (
      normalized === "name" ||
      normalized.includes("full legal name") ||
      normalized.includes("full name") ||
      normalized.includes("legal name")
    ) {
      return finalize(profile.basics.fullName ?? `${profile.basics.firstName} ${profile.basics.lastName}`.trim(), "text_fallback_name");
    }
    if (intent === "links") {
      if (this.isLinkedinPrompt(normalized)) return finalize(profile.links?.linkedin ?? null, "text_fallback_linkedin");
      if (this.isProjectPasswordPrompt(normalized)) return finalize("N/A", "text_fallback_project_password");
      if (this.isProjectUrlPrompt(normalized) || this.isReplitProfilePrompt(normalized)) {
        return finalize(profile.links?.portfolio ?? profile.links?.github ?? profile.links?.website ?? null, "text_fallback_project_url");
      }
      if (this.isGithubContributionPrompt(normalized)) {
        return finalize(this.resolveGithubContributionUrl(profile) ?? null, "text_fallback_github_contribution");
      }
      if (this.isPortfolioOrWebsitePrompt(normalized)) {
        return finalize(profile.links?.portfolio ?? profile.links?.website ?? profile.links?.github ?? null, "text_fallback_portfolio");
      }
      if (this.isGithubOrCodeSamplePrompt(normalized)) {
        return finalize(this.resolveGithubContributionUrl(profile) ?? profile.links?.portfolio ?? profile.links?.website ?? null, "text_fallback_github");
      }
      return finalize(null, "text_fallback_link_generic");
    }
    if (intent === "location_country") {
      if (normalized.includes("country of residence")) {
        return finalize(profile.country ?? "United States", "text_fallback_country_residence");
      }
      const locationValue = this.locationAwareFallbackValue(
        { id: "__text__", label, type: "text", required: true, selector: "", tag: "input", options: undefined } as DetectedField,
        profile,
        postingLocation,
        ashbyConfig
      );
      return finalize(typeof locationValue === "string" ? locationValue : null, "text_fallback_location");
    }
    if (intent === "legal_work_auth") {
      return finalize(profile.workAuthorization?.requiresSponsorship ? "Yes" : "No", "text_fallback_work_auth");
    }
    if (intent === "compensation") {
      return finalize(profile.salary ?? null, "text_fallback_compensation");
    }
    if (intent === "notice_start_date") {
      const custom = profile.customAnswers ?? {};
      for (const [rawKey, rawValue] of Object.entries(custom)) {
        const key = this.normalize(rawKey);
        if (!key.includes("start date") && !key.includes("notice period") && !key.includes("available")) continue;
        const value = String(rawValue ?? "").trim();
        if (value) return finalize(value, "text_fallback_notice_start_custom");
      }
      if (this.resolveDateFallbackPolicy(ashbyConfig) === "today") {
        const today = new Date();
        const candidate = this.buildDateFormatCandidates(today, placeholder)[0] ?? this.formatDateWithMonthName(today);
        return finalize(candidate, "text_fallback_notice_start_today");
      }
      return finalize("2 weeks", "text_fallback_notice_start_default");
    }
    if (intent === "company_understanding") {
      return finalize(this.buildCompanyUnderstandingResponse(label, company, jobTitle, companyContext), "text_fallback_company_understanding");
    }
    if (intent === "motivation_fit") {
      const narrative = this.buildNarrativeFallback(label, profile, company, jobTitle);
      if (narrative) return finalize(narrative, "text_fallback_motivation_narrative");
      if (companyContext?.trim()) {
        return finalize(
          `I’m a strong fit because my experience aligns with ${company ?? "the team"} and this ${jobTitle ?? "role"}. I’m motivated by ${companyContext.slice(0, 140).replace(/\s+/g, " ").trim()}.`,
          "text_fallback_motivation_company_context"
        );
      }
      return finalize("I’m excited to contribute in this role and deliver measurable impact quickly.", "text_fallback_motivation_default");
    }
    if (intent === "summary_background") {
      if (this.allowProfileSummaryFallbackForExplicitSummaryPrompts(ashbyConfig) && summary) {
        return finalize(summary, "text_fallback_profile_summary_explicit_prompt");
      }
      const narrative = this.buildNarrativeFallback(label, profile, company, jobTitle);
      return finalize(narrative, "text_fallback_summary_without_profile_summary");
    }
    if (intent === "open_ended_narrative") {
      const narrative = this.buildNarrativeFallback(label, profile, company, jobTitle);
      return finalize(narrative, "text_fallback_open_ended_narrative");
    }
    if (this.isApplicationSourcePrompt(normalized)) {
      return finalize("Online Job Board", "text_fallback_application_source");
    }
    if (this.isProjectPasswordPrompt(normalized)) {
      return finalize("N/A", "text_fallback_project_password_generic");
    }
    return finalize(null, "text_fallback_misc");
  }

  private targetedFallbackValue(
    field: DetectedField,
    missingLabel: string,
    profile: CandidateProfile,
    company?: string,
    jobTitle?: string,
    companyContext?: string,
    postingLocation?: string,
    ashbyConfig?: AshbyConfig
  ): string | string[] | boolean | null {
    const label = this.normalize(missingLabel);
    const yesNo = (value: boolean): string => (value ? "Yes" : "No");
    const years = profile.experience?.years ?? 3;
    const educationDateValue = this.buildEducationDateValue(field, profile);
    if (educationDateValue) return educationDateValue;
    const profileMapped = this.resolveProfilePromptValue(field, profile, postingLocation, ashbyConfig);
    if (profileMapped) return profileMapped.value;

    if (label.includes("years of paid experience") || label.includes("years of relevant experience") || label.includes("years of experience")) {
      return this.selectExperienceOption(field.options, years) ?? String(years);
    }
    if (label.includes("first job")) {
      if (field.type === "single_select") {
        return this.pickOptionByKeywords(field.options, ["no", "false"]) ?? "No";
      }
      if (field.type === "boolean") return false;
      return "No";
    }
    if (label.includes("experience in one or more of the following programming languages") || label.includes("programming languages")) {
      if (field.type === "single_select") {
        return this.pickOptionByKeywords(field.options, ["yes", "true"]) ?? "Yes";
      }
      if (field.type === "boolean") return true;
      return "Yes";
    }
    if (label.includes("preferred coding language")) {
      const preferredLanguage =
        this.pickOptionByKeywords(field.options, ["typescript"]) ??
        this.pickOptionByKeywords(field.options, ["python"]) ??
        this.pickFirstUsableOption(field.options);
      if (preferredLanguage) return preferredLanguage;
    }
    if (this.isApplicationSourcePrompt(label) && !this.isConditionalFollowupPrompt(label)) {
      if (field.type === "single_select") {
        return this.pickSourceOption(field.options) ?? this.pickFirstUsableOption(field.options) ?? "Online Job Board";
      }
      return "Online Job Board";
    }
    const accommodationPolicyValue = this.resolveAccommodationPolicyValue(field, ashbyConfig);
    if (accommodationPolicyValue !== null) return accommodationPolicyValue;
    if (this.isLinkedinPrompt(label)) {
      return profile.links?.linkedin ?? null;
    }
    if (this.isProjectPasswordPrompt(label)) {
      return "N/A";
    }
    if (this.isProjectUrlPrompt(label) || this.isReplitProfilePrompt(label)) {
      return profile.links?.portfolio ?? profile.links?.github ?? profile.links?.website ?? null;
    }
    if (this.isGithubContributionPrompt(label)) {
      return this.resolveGithubContributionUrl(profile) ?? profile.links?.portfolio ?? profile.links?.website ?? null;
    }
    if (this.isPortfolioOrWebsitePrompt(label)) {
      return profile.links?.portfolio ?? profile.links?.website ?? profile.links?.github ?? null;
    }
    if (this.isGithubOrCodeSamplePrompt(label)) {
      return this.resolveGithubContributionUrl(profile) ?? profile.links?.portfolio ?? profile.links?.website ?? "https://github.com/";
    }
    if (label.includes("current country of residence")) {
      return profile.country ?? "United States";
    }
    if ((label.includes("authorized to work") || label.includes("work authorization")) && field.type === "single_select") {
      const preferredCountry = profile.country ?? "United States";
      const countryMatch = field.options?.find((option) => {
        const normalizedOption = this.normalize(option);
        const normalizedCountry = this.normalize(preferredCountry);
        return (
          normalizedOption === normalizedCountry ||
          normalizedOption.includes(normalizedCountry) ||
          normalizedCountry.includes(normalizedOption)
        );
      });
      if (countryMatch) return countryMatch;
      return this.pickOptionForYesNo(field.options, label, "yes") ?? this.requiredFallbackValue(field);
    }
    if (
      label === "name" ||
      label.includes("full legal name") ||
      label.includes("full name") ||
      label.includes("legal name")
    ) {
      return profile.basics.fullName ?? `${profile.basics.firstName} ${profile.basics.lastName}`.trim();
    }
    if (this.isLocationPrompt(label) && !this.isLocationAvailabilityPrompt(label)) {
      return this.locationAwareFallbackValue(field, profile, postingLocation, ashbyConfig);
    }
    if (label.includes("visa") || label.includes("work permit") || label.includes("sponsorship")) {
      const requiresSponsorship = profile.workAuthorization?.requiresSponsorship ?? false;
      if (field.type === "single_select") {
        return (
          this.pickOptionForYesNo(field.options, label, requiresSponsorship ? "yes" : "no") ??
          yesNo(requiresSponsorship)
        );
      }
      if (field.type === "boolean") return requiresSponsorship;
      return yesNo(requiresSponsorship);
    }
    if (this.isOfficeChoicePrompt(label) && field.type === "single_select" && field.options?.length) {
      return this.resolveOfficeOption(field.options, profile, postingLocation, ashbyConfig);
    }
    if (label.includes("in person at our offices")) {
      return "Yes";
    }
    if (label.includes("commute") || (label.includes("office") && label.includes("week"))) {
      if (field.type === "single_select") {
        return this.pickOptionByKeywords(field.options, ["yes", "true"]) ?? "Yes";
      }
      if (field.type === "boolean") return true;
      return "Yes";
    }
    if (label.includes("permanent") || label.includes("non-contractor")) {
      return "Yes";
    }
    if (label.includes("challenge") && (label.includes("javascript") || label.includes("typescript"))) {
      return "Yes";
    }
    if (label.includes("more junior software engineering")) {
      return "Yes";
    }
    if (this.isCompanyUnderstandingPrompt(missingLabel)) {
      return this.buildCompanyUnderstandingResponse(missingLabel, company, jobTitle, companyContext);
    }
    if (
      label.includes("final year of a bachelor") ||
      (label.includes("enrolled in a master") && label.includes("phd")) ||
      (label.includes("final year") && label.includes("bachelor"))
    ) {
      const currentYear = new Date().getFullYear();
      const gradYear = Number(profile.education?.graduationYear ?? profile.education?.endYear ?? currentYear + 1);
      const likelyEligible = Number.isFinite(gradYear) ? gradYear <= currentYear + 1 : true;
      if (field.type === "single_select") {
        return this.pickOptionByKeywords(field.options, likelyEligible ? ["yes", "true"] : ["no", "false"]) ??
          (likelyEligible ? "Yes" : "No");
      }
      if (field.type === "boolean") return likelyEligible;
      return likelyEligible ? "Yes" : "No";
    }

    if (field.type === "single_select") {
      const option = this.pickOptionForYesNo(field.options, label);
      return option ?? this.requiredFallbackValue(field);
    }
    if (field.type === "multi_select" || field.type === "boolean") {
      return this.requiredFallbackValue(field);
    }
    if (field.type === "text" || field.type === "textarea") {
      const sensitiveFallback = this.sensitivePromptFallback(field, label, profile);
      if (sensitiveFallback !== undefined) return sensitiveFallback;
      return this.resolveAshbyTextFallback(
        missingLabel,
        field.type,
        profile,
        company,
        jobTitle,
        companyContext,
        postingLocation,
        ashbyConfig,
        field.placeholder
      ).value;
    }
    return this.requiredFallbackValue(field);
  }

  private pickOptionForYesNo(
    options: string[] | undefined,
    label: string,
    preferredAnswer?: "yes" | "no"
  ): string | undefined {
    if (!options?.length) return undefined;
    const sponsorshipIntent =
      label.includes("visa") ||
      label.includes("work permit") ||
      label.includes("sponsorship") ||
      /\brequire(?:s|d)?\s+(visa|sponsorship|permit)\b/.test(label) ||
      /\bnow or in the future\b/.test(label);
    const target: "yes" | "no" = preferredAnswer ?? (sponsorshipIntent ? "no" : "yes");
    const normalizedOptions = options.map((item) => ({ raw: item, normalized: this.normalize(item) }));

    const noPatterns = [
      /\bno\b/,
      /\bfalse\b/,
      /\bnot\b.*\brequire\b.*\bsponsorship\b/,
      /\bwithout\b.*\bsponsorship\b/,
      /\bwill not require\b/,
      /\bdoes not require\b/,
      /\bno sponsorship\b/,
      /\bwithout restriction\b/
    ];
    const yesPatterns = [
      /\byes\b/,
      /\btrue\b/,
      /\brequire\b.*\bsponsorship\b/,
      /\bneed\b.*\bsponsorship\b/,
      /\brequires sponsorship\b/
    ];
    const patterns = target === "no" ? noPatterns : yesPatterns;

    for (const option of normalizedOptions) {
      if (patterns.some((pattern) => pattern.test(option.normalized))) {
        return option.raw;
      }
    }

    for (const option of normalizedOptions) {
      if (target === "no" && option.normalized.startsWith("no")) return option.raw;
      if (target === "yes" && option.normalized.startsWith("yes")) return option.raw;
    }

    return undefined;
  }

  private pickOptionByKeywords(options: string[] | undefined, keywords: string[]): string | undefined {
    if (!options?.length) return undefined;
    const normalizedKeywords = keywords.map((keyword) => keyword.toLowerCase());
    for (const option of options) {
      const normalized = this.normalize(option);
      if (normalizedKeywords.some((keyword) => normalized.includes(keyword))) {
        return option;
      }
    }
    return undefined;
  }

  private isLocationPrompt(normalizedLabel: string): boolean {
    if (!normalizedLabel) return false;
    if (this.isCountryResidencePrompt(normalizedLabel)) return true;
    if (
      normalizedLabel.includes("export control") ||
      normalizedLabel.includes("citizenship") ||
      normalizedLabel.includes("nationality") ||
      normalizedLabel.includes("permanent residence")
    ) {
      return false;
    }
    return (
      normalizedLabel === "location" ||
      normalizedLabel.includes("location") ||
      normalizedLabel.includes("currently based") ||
      normalizedLabel.includes("based in") ||
      normalizedLabel.includes("where are you") ||
      normalizedLabel.includes("current city")
    );
  }

  private isLocationAvailabilityPrompt(normalizedLabel: string): boolean {
    return (
      (normalizedLabel.includes("available") && normalizedLabel.includes("work from")) ||
      (normalizedLabel.includes("which location") && normalizedLabel.includes("available to work"))
    );
  }

  private isInternshipAgreementPrompt(normalizedLabel: string): boolean {
    return normalizedLabel.includes("internship agreement");
  }

  private isCountryResidencePrompt(normalizedLabel: string): boolean {
    return (
      normalizedLabel.includes("current country of residence") ||
      normalizedLabel.includes("country of residence")
    );
  }

  private isApplicationSourcePrompt(normalizedLabel: string): boolean {
    return (
      /how did you hear|how did you find|how did you learn/i.test(normalizedLabel) ||
      /\bapplication source\b/i.test(normalizedLabel) ||
      /\bsource\b/i.test(normalizedLabel) ||
      /\breferral\b/i.test(normalizedLabel) ||
      /\breferred\b/i.test(normalizedLabel)
    );
  }

  private isAccommodationPrompt(normalizedLabel: string): boolean {
    const hasAccommodationWord =
      normalizedLabel.includes("accommodation") || normalizedLabel.includes("accommodations");
    if (!hasAccommodationWord) {
      return normalizedLabel.includes("assist") && normalizedLabel.includes("application process");
    }
    // Do not classify policy-acknowledgement prompts as accommodation requests.
    if (
      normalizedLabel.includes("please confirm") &&
      normalizedLabel.includes("read and understand") &&
      normalizedLabel.includes("policy")
    ) {
      return false;
    }
    return (
      /\b(require|request|need|receive|support)\b/.test(normalizedLabel) ||
      normalizedLabel.includes("application process")
    );
  }

  private isConditionalFollowupPrompt(normalizedLabel: string): boolean {
    return (
      /\bif\s+(you\s+)?(selected|answered)\s*["'“”]?\s*(yes|no|other)\b/.test(normalizedLabel) ||
      /\bif\s+(yes|no|other)\b/.test(normalizedLabel) ||
      /\bif so\b/.test(normalizedLabel) ||
      /\bif applicable\b/.test(normalizedLabel) ||
      /\bplease explain\b/.test(normalizedLabel) ||
      /\bplease describe\b/.test(normalizedLabel) ||
      normalizedLabel.includes("if you answered other")
    );
  }

  private isAccommodationFollowupPrompt(normalizedLabel: string): boolean {
    return (
      (this.isConditionalFollowupPrompt(normalizedLabel) && this.isAccommodationPrompt(normalizedLabel)) ||
      /how can we support/.test(normalizedLabel) ||
      (normalizedLabel.includes("support") && normalizedLabel.includes("accommodation")) ||
      (normalizedLabel.includes("privacy matters") && normalizedLabel.includes("accommodation")) ||
      (normalizedLabel.includes("what") && normalizedLabel.includes("accommodation") && normalizedLabel.includes("need"))
    );
  }

  private resolveAccommodationPolicy(
    ashbyConfig?: AshbyConfig
  ): "no_and_fill_followup_na" {
    return ashbyConfig?.accommodationPolicy ?? "no_and_fill_followup_na";
  }

  private resolveAccommodationFollowupDefaultText(ashbyConfig?: AshbyConfig): string {
    const configured = String(ashbyConfig?.accommodationFollowupDefaultText ?? "").trim();
    return configured || DEFAULT_ACCOMMODATION_FOLLOWUP_TEXT;
  }

  private resolveAccommodationPolicyValue(
    field: Pick<DetectedField, "label" | "type" | "options">,
    ashbyConfig?: AshbyConfig
  ): string | boolean | null {
    if (this.resolveAccommodationPolicy(ashbyConfig) !== "no_and_fill_followup_na") return null;
    const label = this.normalize(field.label);
    if (this.isAccommodationFollowupPrompt(label) && (field.type === "text" || field.type === "textarea")) {
      return this.resolveAccommodationFollowupDefaultText(ashbyConfig);
    }
    if (!this.isAccommodationPrompt(label)) return null;

    if (field.type === "single_select") {
      return (
        this.pickOptionByKeywords(field.options, ["do not require", "no accommodations"]) ??
        this.pickOptionForYesNo(field.options, label, "no") ??
        "No"
      );
    }
    if (field.type === "boolean") return false;
    if (field.type === "text" || field.type === "textarea") return "No";
    return null;
  }

  private isHybridWorkPreferencePrompt(normalizedLabel: string): boolean {
    return (
      (normalizedLabel.includes("hybrid") && normalizedLabel.includes("work")) ||
      normalizedLabel.includes("homebase hub") ||
      (normalizedLabel.includes("live near") && normalizedLabel.includes("hub"))
    );
  }

  private resolveHybridWorkPreferenceOption(
    rawLabel: string,
    options: string[] | undefined,
    profile: CandidateProfile
  ): string | null {
    if (!options?.length) return null;
    const normalizedLabel = this.normalize(rawLabel);
    const normalizedLocation = this.normalize(
      `${profile.basics.location ?? ""} ${profile.state ?? ""} ${profile.country ?? ""}`
    );
    const normalizedOptions = options.map((option) => ({ raw: option, normalized: this.normalize(option) }));
    const hubCities = ["denver", "houston", "san francisco", "toronto"];
    const nearHub = hubCities.some((city) => normalizedLocation.includes(city));
    const nearHubOption = normalizedOptions.find((option) =>
      (/\blive near\b|\bcan work hybrid\b|\bin-office\b/.test(option.normalized)) &&
      !/don.?t live near|do not live near/.test(option.normalized)
    )?.raw ?? null;
    const remoteOption = normalizedOptions.find((option) =>
      /prefer remote|don.?t live near|do not live near|remote opportunities?|remote/.test(option.normalized)
    )?.raw ?? null;
    if (!nearHub && remoteOption) return remoteOption;
    if (nearHub && nearHubOption) return nearHubOption;
    if (normalizedLabel.includes("relocation assistance") && remoteOption) return remoteOption;
    return nearHubOption ?? remoteOption ?? null;
  }

  private isGithubOrCodeSamplePrompt(normalizedLabel: string): boolean {
    return (
      normalizedLabel.includes("github") ||
      normalizedLabel.includes("code sample") ||
      normalizedLabel.includes("repository") ||
      normalizedLabel.includes("portfolio url")
    );
  }

  private isGithubContributionPrompt(normalizedLabel: string): boolean {
    return (
      normalizedLabel.includes("favorite github contribution") ||
      normalizedLabel.includes("github contribution") ||
      (normalizedLabel.includes("github") && normalizedLabel.includes("favorite")) ||
      (normalizedLabel.includes("github") && normalizedLabel.includes("contribution")) ||
      (normalizedLabel.includes("github") && normalizedLabel.includes("project"))
    );
  }

  private isLinkedinPrompt(normalizedLabel: string): boolean {
    return normalizedLabel.includes("linkedin");
  }

  private isReplitProfilePrompt(normalizedLabel: string): boolean {
    return normalizedLabel.includes("replit profile");
  }

  private isProjectUrlPrompt(normalizedLabel: string): boolean {
    return (
      normalizedLabel.includes("project url") ||
      normalizedLabel.includes("submitted project") ||
      (normalizedLabel.includes("project") && normalizedLabel.includes("url"))
    );
  }

  private isProjectPasswordPrompt(normalizedLabel: string): boolean {
    return normalizedLabel.includes("project password") || normalizedLabel.includes("password");
  }

  private isVeteranPrompt(normalizedLabel: string): boolean {
    return normalizedLabel.includes("veteran");
  }

  private pickVeteranSafeOption(options: string[] | undefined): string | undefined {
    return (
      this.pickOptionByKeywords(options, ["not a protected veteran"]) ??
      this.pickOptionByKeywords(options, ["not protected veteran"]) ??
      this.pickOptionByKeywords(options, ["not a veteran"]) ??
      this.pickOptionByKeywords(options, ["i am not"]) ??
      this.pickOptionByKeywords(options, ["prefer not"]) ??
      this.pickFirstUsableOption(options)
    );
  }

  private isPortfolioOrWebsitePrompt(normalizedLabel: string): boolean {
    return (
      normalizedLabel.includes("portfolio") ||
      normalizedLabel.includes("personal website") ||
      (normalizedLabel.includes("website") && !normalizedLabel.includes("company website"))
    );
  }

  private pickSourceOption(options: string[] | undefined): string | undefined {
    return (
      this.pickOptionByKeywords(options, ["online job board"]) ??
      this.pickOptionByKeywords(options, ["job board"]) ??
      this.pickOptionByKeywords(options, ["linkedin"]) ??
      this.pickOptionByKeywords(options, ["company website"]) ??
      this.pickOptionByKeywords(options, ["other"])
    );
  }

  private selectExperienceOption(options: string[] | undefined, years: number): string | undefined {
    if (!options?.length) return undefined;
    for (const option of options) {
      const normalized = this.normalize(option);
      const plus = normalized.match(/(\d+)\s*\+/);
      if (plus && years >= Number(plus[1])) return option;
      const range = normalized.match(/(\d+)\s*[-–]\s*(\d+)/);
      if (range) {
        const min = Number(range[1]);
        const max = Number(range[2]);
        if (years >= min && years <= max) return option;
      }
    }
    return undefined;
  }

  private autofillFallbackValue(
    field: DetectedField,
    profile: CandidateProfile,
    company?: string,
    jobTitle?: string,
    companyContext?: string,
    postingLocation?: string,
    ashbyConfig?: AshbyConfig
  ): string | string[] | boolean | null {
    const label = this.normalize(field.label);
    const educationDateValue = this.buildEducationDateValue(field, profile);
    if (educationDateValue) return educationDateValue;
    const profileMapped = this.resolveProfilePromptValue(field, profile, postingLocation, ashbyConfig);
    if (profileMapped) return profileMapped.value;
    const accommodationPolicyValue = this.resolveAccommodationPolicyValue(field, ashbyConfig);
    if (accommodationPolicyValue !== null) return accommodationPolicyValue;

    if (field.type === "single_select") {
      const sensitiveFallback = this.sensitivePromptFallback(field, label, profile);
      if (sensitiveFallback !== undefined) return sensitiveFallback;
      if (this.isHybridWorkPreferencePrompt(label)) {
        const hybridChoice = this.resolveHybridWorkPreferenceOption(field.label, field.options, profile);
        if (hybridChoice) return hybridChoice;
      }
      if (this.isVeteranPrompt(label)) {
        return this.pickVeteranSafeOption(field.options) ?? "I am not a protected veteran";
      }
      if (label.includes("first job")) {
        return this.pickOptionByKeywords(field.options, ["no", "false"]) ?? "No";
      }
      if (label.includes("experience in one or more of the following programming languages") || label.includes("programming languages")) {
        return this.pickOptionByKeywords(field.options, ["yes", "true"]) ?? "Yes";
      }
      if (label.includes("preferred coding language")) {
        return (
          this.pickOptionByKeywords(field.options, ["typescript"]) ??
          this.pickOptionByKeywords(field.options, ["python"]) ??
          this.pickFirstUsableOption(field.options) ??
          "Typescript"
        );
      }
      if (label.includes("years of paid experience") || label.includes("years of relevant experience") || label.includes("years of experience")) {
        return this.selectExperienceOption(field.options, profile.experience?.years ?? 3) ?? this.pickFirstUsableOption(field.options) ?? "2-4 years";
      }
      if (this.isOfficeChoicePrompt(label)) {
        return this.resolveOfficeOption(field.options ?? [], profile, postingLocation, ashbyConfig);
      }
      if (
        label.includes("final year of a bachelor") ||
        (label.includes("enrolled in a master") && label.includes("phd")) ||
        (label.includes("final year") && label.includes("bachelor"))
      ) {
        const currentYear = new Date().getFullYear();
        const gradYear = Number(profile.education?.graduationYear ?? profile.education?.endYear ?? currentYear + 1);
        const likelyEligible = Number.isFinite(gradYear) ? gradYear <= currentYear + 1 : true;
        return this.pickOptionByKeywords(field.options, likelyEligible ? ["yes", "true"] : ["no", "false"]) ??
          (likelyEligible ? "Yes" : "No");
      }
      if (label.includes("commute") || (label.includes("office") && label.includes("week"))) {
        return this.pickOptionByKeywords(field.options, ["yes", "true"]) ?? "Yes";
      }
      if (this.isApplicationSourcePrompt(label) && !this.isConditionalFollowupPrompt(label)) {
        return this.pickSourceOption(field.options) ?? this.pickFirstUsableOption(field.options) ?? "Online Job Board";
      }
      const preferred = this.pickOptionForYesNo(field.options, label);
      return preferred ?? this.pickFirstUsableOption(field.options) ?? "Yes";
    }
    if (field.type === "multi_select") {
      const sensitiveFallback = this.sensitivePromptFallback(field, label, profile);
      if (sensitiveFallback !== undefined) return sensitiveFallback;
      const option = this.pickFirstUsableOption(field.options);
      return option ? [option] : ["Yes"];
    }
    if (field.type === "boolean") {
      const sensitiveFallback = this.sensitivePromptFallback(field, label, profile);
      if (sensitiveFallback !== undefined) return sensitiveFallback;
      if (label.includes("first job")) return false;
      if (label.includes("experience in one or more of the following programming languages") || label.includes("programming languages")) {
        return true;
      }
      if (label.includes("visa") || label.includes("work permit") || label.includes("sponsorship")) {
        return profile.workAuthorization?.requiresSponsorship ?? false;
      }
      return true;
    }
    if (field.type === "text" || field.type === "textarea") {
      const sensitiveFallback = this.sensitivePromptFallback(field, label, profile);
      if (sensitiveFallback !== undefined) return sensitiveFallback;
      if (label.includes("years of paid experience") || label.includes("years of relevant experience") || label.includes("years of experience")) {
        return String(profile.experience?.years ?? 3);
      }
      if (label.includes("in person") || label.includes("permanent") || label.includes("non-contractor")) return "Yes";
      if (label.includes("challenge") && (label.includes("javascript") || label.includes("typescript"))) return "Yes";
      if (label.includes("more junior")) return "Yes";
      return this.resolveAshbyTextFallback(
        field.label,
        field.type,
        profile,
        company,
        jobTitle,
        companyContext,
        postingLocation,
        ashbyConfig,
        field.placeholder
      ).value;
    }
    return null;
  }

  private fallbackTextForMissingLabel(
    label: string,
    profile: CandidateProfile,
    company?: string,
    jobTitle?: string,
    companyContext?: string,
    postingLocation?: string,
    ashbyConfig?: AshbyConfig
  ): string {
    const normalized = this.normalize(label);
    const educationDateValue = this.buildEducationDateValue({ label, placeholder: undefined } as DetectedField, profile);
    if (educationDateValue) return educationDateValue;
    const profileMapped = this.resolveProfilePromptValue(
      { id: "__missing__", label, type: "text", required: true, selector: "", tag: "input", options: undefined } as DetectedField,
      profile,
      postingLocation,
      ashbyConfig
    );
    if (profileMapped && this.answerHasValue(profileMapped.value)) return String(profileMapped.value);
    const accommodationPolicyValue = this.resolveAccommodationPolicyValue(
      { label, type: "text", options: undefined } as Pick<DetectedField, "label" | "type" | "options">,
      ashbyConfig
    );
    if (accommodationPolicyValue !== null) return String(accommodationPolicyValue);
    const sensitiveFallback = this.sensitivePromptFallback(
      { type: "text", options: undefined },
      normalized,
      profile
    );
    if (sensitiveFallback !== undefined && typeof sensitiveFallback === "string") {
      return sensitiveFallback;
    }
    if (
      normalized.includes("years of paid experience") ||
      normalized.includes("years of relevant experience") ||
      normalized.includes("years of experience")
    ) {
      const years = profile.experience?.years ?? 3;
      if (years <= 1) return "0-1 years";
      if (years <= 4) return "2-4 years";
      if (years <= 8) return "5-8 years";
      if (years <= 14) return "9-14 years";
      return "15+ years";
    }
    return this.resolveAshbyTextFallback(
      label,
      "text",
      profile,
      company,
      jobTitle,
      companyContext,
      postingLocation,
      ashbyConfig
    ).value ?? this.resolveFinalTextFallbackValue(ashbyConfig);
  }

  private buildEducationDateValue(
    field: Pick<DetectedField, "label" | "placeholder">,
    profile: CandidateProfile
  ): string | null {
    const label = this.normalize(field.label);
    const placeholder = this.normalize(String(field.placeholder ?? ""));
    const monthToNumber: Record<string, string> = {
      january: "01",
      february: "02",
      march: "03",
      april: "04",
      may: "05",
      june: "06",
      july: "07",
      august: "08",
      september: "09",
      october: "10",
      november: "11",
      december: "12"
    };
    const toMonthNumber = (value?: string): string => {
      const normalized = this.normalize(String(value ?? ""));
      if (!normalized) return "";
      if (/^\d{1,2}$/.test(normalized)) return normalized.padStart(2, "0");
      return monthToNumber[normalized] ?? monthToNumber[normalized.slice(0, 3)] ?? "";
    };
    const toTitleMonth = (value?: string): string => {
      const normalized = this.normalize(String(value ?? ""));
      if (!normalized) return "";
      const byName = Object.keys(monthToNumber).find((name) => name === normalized || name.slice(0, 3) === normalized.slice(0, 3));
      if (byName) return byName.charAt(0).toUpperCase() + byName.slice(1);
      if (/^\d{1,2}$/.test(normalized)) {
        const match = Object.entries(monthToNumber).find(([, num]) => num === normalized.padStart(2, "0"))?.[0];
        if (match) return match.charAt(0).toUpperCase() + match.slice(1);
      }
      return "";
    };
    const formatDate = (month: string | undefined, year: string | undefined): string | null => {
      const resolvedYear = String(year ?? "").trim();
      if (!resolvedYear) return null;
      const resolvedMonthNumber = toMonthNumber(month) || "05";
      const resolvedMonthName = toTitleMonth(month) || "May";
      if (placeholder.includes("mm/yyyy")) return `${resolvedMonthNumber}/${resolvedYear}`;
      if (placeholder.includes("yyyy-mm") || placeholder.includes("yyyy/mm")) return `${resolvedYear}-${resolvedMonthNumber}`;
      if (placeholder.includes("mm-dd-yyyy")) return `${resolvedMonthNumber}-01-${resolvedYear}`;
      return `${resolvedMonthName} ${resolvedYear}`;
    };

    const looksGraduationDate =
      (label.includes("graduation") && (label.includes("date") || !label.includes("year"))) ||
      label.includes("graduate date");
    const looksStartDate =
      label.includes("start date") || label.includes("date started") || label.includes("school start");
    const looksEndDate =
      label.includes("end date") || label.includes("date ended") || label.includes("expected graduation");

    if (!looksGraduationDate && !looksStartDate && !looksEndDate) return null;

    if (looksStartDate) {
      return formatDate(profile.education?.startMonth, profile.education?.startYear) ?? null;
    }
    if (looksEndDate || looksGraduationDate) {
      return formatDate(
        profile.education?.endMonth ?? profile.education?.startMonth,
        profile.education?.endYear ?? profile.education?.graduationYear
      ) ?? null;
    }
    return null;
  }

  private graduationQuarterToken(profile: CandidateProfile): string {
    const monthRaw = this.normalize(
      String(profile.education?.endMonth ?? profile.education?.startMonth ?? "")
    );
    if (!monthRaw) return "";
    const monthMap: Record<string, number> = {
      jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
      apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
      aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
      nov: 11, november: 11, dec: 12, december: 12
    };
    const month = monthMap[monthRaw] ?? monthMap[monthRaw.slice(0, 3)] ?? 0;
    if (month >= 1 && month <= 3) return "january - march";
    if (month >= 4 && month <= 6) return "april - june";
    if (month >= 7 && month <= 9) return "july - september";
    if (month >= 10 && month <= 12) return "october - december";
    return "";
  }

  private isGraduationComboboxPrompt(label: string | undefined): boolean {
    const normalized = this.normalize(String(label ?? ""));
    if (!normalized) return false;
    return (
      normalized.includes("expected graduation") ||
      normalized.includes("graduation date") ||
      (normalized.includes("graduation") && normalized.includes("date"))
    );
  }

  private graduationMonthToken(profile: CandidateProfile): string {
    const monthRaw = this.normalize(String(profile.education?.endMonth ?? profile.education?.startMonth ?? ""));
    if (!monthRaw) return "";
    const monthMap: Record<string, string> = {
      jan: "january",
      january: "january",
      feb: "february",
      february: "february",
      mar: "march",
      march: "march",
      apr: "april",
      april: "april",
      may: "may",
      jun: "june",
      june: "june",
      jul: "july",
      july: "july",
      aug: "august",
      august: "august",
      sep: "september",
      sept: "september",
      september: "september",
      oct: "october",
      october: "october",
      nov: "november",
      november: "november",
      dec: "december",
      december: "december"
    };
    return monthMap[monthRaw] ?? monthMap[monthRaw.slice(0, 3)] ?? "";
  }

  private scoreGraduationOption(option: string, targetYear: number, quarterToken: string, monthToken: string): number {
    const normalized = this.normalize(option);
    if (!normalized) return -100;
    let score = 0;
    if (normalized.includes(String(targetYear))) score += 55;
    if (quarterToken && normalized.includes(quarterToken)) score += 40;
    if (monthToken && normalized.includes(monthToken)) score += 20;
    if (normalized.includes("other")) score -= 25;
    return score;
  }

  private async selectGraduationComboboxOption(
    scope: AshbyInteractionScope,
    container: Locator,
    comboControl: Locator,
    profile: CandidateProfile
  ): Promise<boolean> {
    const targetYear = Number(profile.education?.graduationYear ?? profile.education?.endYear ?? "");
    if (!Number.isFinite(targetYear) || targetYear <= 0) return false;
    const quarterToken = this.graduationQuarterToken(profile);
    const monthToken = this.graduationMonthToken(profile);

    const listboxOptionsSelectorFrom = (listboxId: string): string =>
      `[id="${listboxId.replace(/"/g, '\\"')}"] [role='option']`;

    await comboControl.click({ force: true }).catch(() => undefined);
    const dropdownButton = container.locator("button").last();
    if (await dropdownButton.isVisible().catch(() => false)) await dropdownButton.click().catch(() => undefined);
    await scope.waitForTimeout(240).catch(() => undefined);

    const query = quarterToken ? `${quarterToken} ${targetYear}` : String(targetYear);
    if (query) {
      await comboControl.fill("").catch(() => undefined);
      await comboControl.type(query, { delay: 34 }).catch(() => undefined);
      await scope.waitForTimeout(260).catch(() => undefined);
    }

    const listboxId = String((await comboControl.getAttribute("aria-controls").catch(() => "")) ?? "").trim();
    let options: string[] = [];
    let optionSelector = "";
    if (listboxId) {
      optionSelector = listboxOptionsSelectorFrom(listboxId);
      options = await this.collectRoleOptionsFromLocator(scope, optionSelector);
    }
    if (options.length === 0) {
      options = await this.collectVisibleOptionTexts(container.locator("[role='option']"));
      optionSelector = "[role='option']";
    }
    if (options.length === 0) {
      options = await this.collectRoleOptionsFromLocator(scope, "[class*='resultContainer'] [role='option']");
      optionSelector = "[class*='resultContainer'] [role='option']";
    }
    if (options.length === 0) {
      options = await this.collectRoleOptionsFromLocator(scope, "[role='option']");
      optionSelector = "[role='option']";
    }
    if (!options.length) return false;

    const scored = options
      .map((option) => ({
        option,
        score: this.scoreGraduationOption(option, targetYear, quarterToken, monthToken)
      }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < 35) return false;

    // Ashby graduation combobox commits reliably with keyboard selection:
    // type exact matched option, settle, ArrowDown, then Enter.
    await comboControl.fill("").catch(() => undefined);
    await comboControl.type(best.option, { delay: 34 }).catch(() => undefined);
    await scope.waitForTimeout(420).catch(() => undefined);
    await comboControl.press("ArrowDown").catch(() => undefined);
    await scope.waitForTimeout(120).catch(() => undefined);
    await comboControl.press("Enter").catch(() => undefined);

    let current = String((await comboControl.inputValue().catch(() => "")) ?? "").trim();
    let normalizedCurrent = this.normalize(current);
    if (!normalizedCurrent || !normalizedCurrent.includes(String(targetYear))) {
      const optionPattern = new RegExp(`^\\s*${this.escapeRegex(best.option)}\\s*$`, "i");
      let clicked = false;
      if (listboxId) {
        clicked = await scope
          .locator(`${listboxOptionsSelectorFrom(listboxId)}:text-matches("${this.escapeRegex(best.option)}", "i")`)
          .first()
          .click()
          .then(() => true)
          .catch(() => false);
      }
      if (!clicked && optionSelector) {
        clicked = await scope
          .locator(optionSelector)
          .filter({ hasText: optionPattern })
          .first()
          .click()
          .then(() => true)
          .catch(() => false);
      }
      if (clicked) {
        await scope.waitForTimeout(120).catch(() => undefined);
        await comboControl.press("Enter").catch(() => undefined);
      }
    }

    await scope.waitForTimeout(90).catch(() => undefined);
    await comboControl.press("Tab").catch(() => undefined);
    await comboControl.blur().catch(() => undefined);
    current = String((await comboControl.inputValue().catch(() => "")) ?? "").trim();
    normalizedCurrent = this.normalize(current);
    if (!normalizedCurrent) return false;
    return normalizedCurrent.includes(String(targetYear));
  }

  private sensitivePromptFallback(
    field: Pick<DetectedField, "type" | "options">,
    normalizedLabel: string,
    profile?: CandidateProfile
  ): string | string[] | boolean | null | undefined {
    if (!this.isSensitivePrompt(normalizedLabel)) return undefined;

    if (this.isProjectPasswordPrompt(normalizedLabel) || this.isCredentialLikePrompt(normalizedLabel)) {
      if (field.type === "boolean") return false;
      if (field.type === "single_select") {
        return this.pickOptionByKeywords(field.options, ["no", "false", "not required", "n/a"]) ?? "No";
      }
      if (field.type === "multi_select") return [];
      return "N/A";
    }

    if (this.isVeteranPrompt(normalizedLabel) && field.type === "single_select") {
      return this.pickVeteranSafeOption(field.options) ?? "I am not a protected veteran";
    }

    if (this.isDemographicDisclosurePrompt(normalizedLabel)) {
      if (field.type === "single_select") {
        return this.pickPreferNotToSayOption(field.options) ?? this.pickFirstUsableOption(field.options) ?? null;
      }
      if (field.type === "multi_select") {
        const choice = this.pickPreferNotToSayOption(field.options);
        return choice ? [choice] : [];
      }
      if (field.type === "boolean") return false;
      return "Prefer not to say";
    }

    if (this.isLegalDisclosurePrompt(normalizedLabel)) {
      const legalIntentAnswer = this.resolveLegalDisclosureFallback(field, normalizedLabel, profile);
      if (legalIntentAnswer !== undefined) return legalIntentAnswer;
      if (field.type === "single_select") {
        return (
          this.pickOptionByKeywords(field.options, ["no", "false", "not required", "not applicable"]) ??
          this.pickPreferNotToSayOption(field.options) ??
          this.pickFirstUsableOption(field.options) ??
          "No"
        );
      }
      if (field.type === "multi_select") return [];
      if (field.type === "boolean") return false;
      return "N/A";
    }

    if (this.isAccommodationPrompt(normalizedLabel)) {
      if (this.isAccommodationFollowupPrompt(normalizedLabel) && (field.type === "text" || field.type === "textarea")) {
        return DEFAULT_ACCOMMODATION_FOLLOWUP_TEXT;
      }
      const policyValue = this.resolveAccommodationPolicyValue(
        { label: normalizedLabel, type: field.type, options: field.options } as Pick<DetectedField, "label" | "type" | "options">
      );
      if (policyValue !== null) return policyValue;
      if (field.type === "multi_select") return [];
      return "No";
    }

    return undefined;
  }

  private resolveLegalDisclosureFallback(
    field: Pick<DetectedField, "type" | "options">,
    normalizedLabel: string,
    profile?: CandidateProfile
  ): string | string[] | boolean | null | undefined {
    const custom = profile?.customAnswers ?? {};
    const readCustomBoolean = (patterns: RegExp[]): boolean | undefined => {
      for (const [rawKey, rawValue] of Object.entries(custom)) {
        const key = this.normalize(rawKey);
        if (!patterns.some((pattern) => pattern.test(key))) continue;
        const normalizedValue = this.normalize(String(rawValue ?? ""));
        if (["true", "yes", "y", "1"].includes(normalizedValue)) return true;
        if (["false", "no", "n", "0"].includes(normalizedValue)) return false;
      }
      return undefined;
    };
    const mapBool = (value: boolean): string | string[] | boolean | null => {
      if (field.type === "boolean") return value;
      if (field.type === "single_select") {
        return this.pickOptionForYesNo(field.options, normalizedLabel, value ? "yes" : "no") ?? (value ? "Yes" : "No");
      }
      return value ? "Yes" : "No";
    };

    if (normalizedLabel.includes("background check")) {
      const explicit = readCustomBoolean([/background/, /criminal.*check/]);
      return mapBool(explicit ?? true);
    }
    if (normalizedLabel.includes("conviction") || normalizedLabel.includes("felony")) {
      const explicit = readCustomBoolean([/conviction/, /felony/, /crime/]);
      return mapBool(explicit ?? false);
    }
    if (
      normalizedLabel.includes("legal restriction") ||
      normalizedLabel.includes("contractual") ||
      normalizedLabel.includes("non-compete") ||
      normalizedLabel.includes("non solicitation") ||
      normalizedLabel.includes("confidentiality agreement")
    ) {
      const explicit = readCustomBoolean([/legal restriction/, /contractual/, /non-?compete/, /non-?solicitation/]);
      return mapBool(explicit ?? false);
    }
    return undefined;
  }

  private isSensitivePrompt(normalizedLabel: string): boolean {
    return (
      this.isCredentialLikePrompt(normalizedLabel) ||
      this.isLegalDisclosurePrompt(normalizedLabel) ||
      this.isDemographicDisclosurePrompt(normalizedLabel) ||
      this.isAccommodationPrompt(normalizedLabel) ||
      this.isProjectPasswordPrompt(normalizedLabel)
    );
  }

  private isCredentialLikePrompt(normalizedLabel: string): boolean {
    return (
      normalizedLabel.includes("password") ||
      normalizedLabel.includes("passcode") ||
      normalizedLabel.includes("verification code") ||
      normalizedLabel.includes("security code") ||
      normalizedLabel.includes("otp") ||
      normalizedLabel.includes("access token") ||
      normalizedLabel.includes("api key") ||
      normalizedLabel.includes("secret") ||
      normalizedLabel.includes("private key")
    );
  }

  private isLegalDisclosurePrompt(normalizedLabel: string): boolean {
    return (
      normalizedLabel.includes("visa") ||
      normalizedLabel.includes("sponsorship") ||
      normalizedLabel.includes("work permit") ||
      normalizedLabel.includes("authorized to work") ||
      normalizedLabel.includes("legally authorized") ||
      normalizedLabel.includes("citizenship") ||
      normalizedLabel.includes("background check") ||
      normalizedLabel.includes("felony") ||
      normalizedLabel.includes("conviction")
    );
  }

  private isDemographicDisclosurePrompt(normalizedLabel: string): boolean {
    return (
      normalizedLabel.includes("gender") ||
      normalizedLabel.includes("sex") ||
      normalizedLabel.includes("race") ||
      normalizedLabel.includes("ethnicity") ||
      normalizedLabel.includes("hispanic") ||
      normalizedLabel.includes("disability")
    );
  }

  private pickPreferNotToSayOption(options: string[] | undefined): string | undefined {
    return (
      this.pickOptionByKeywords(options, ["prefer not to say"]) ??
      this.pickOptionByKeywords(options, ["decline to self-identify"]) ??
      this.pickOptionByKeywords(options, ["do not wish to answer"]) ??
      this.pickOptionByKeywords(options, ["choose not to answer"])
    );
  }

  private buildNarrativeFallback(
    label: string,
    profile: CandidateProfile,
    company?: string,
    jobTitle?: string
  ): string | null {
    const normalized = this.normalize(label);
    const companyName = company ?? "the team";
    const role = jobTitle ?? "this role";
    const summary = profile.experience?.summary?.trim() || profile.skillsSummary?.trim() || "";

    if (normalized.includes("what interests you")) {
      return `I’m interested in ${companyName} because it applies software and AI to real-world problems with measurable impact. This ${role} aligns with my background in building TypeScript and automation systems, and I’m excited to contribute while learning from a high-ownership engineering team.`;
    }
    if (normalized.includes("why are you interested in this position")) {
      return `I’m interested in this ${role} at ${companyName} because it sits at the intersection of product execution and technical depth, which is where I do my best work. I’ve built AI-assisted automation systems end to end, owned the reliability roadmap, and translated ambiguous goals into measurable delivery milestones. That mix of ownership, cross-functional execution, and fast iteration is exactly what I want to bring to this team.`;
    }
    if (normalized.includes("superpowers")) {
      return `My superpowers are execution clarity, systems thinking, and shipping velocity. I can quickly turn vague requirements into concrete milestones, instrument the workflow so progress is visible, and iterate from evidence instead of assumptions. In practice, that looked like building a TypeScript + Playwright automation system, tracing failure patterns with structured logs, and improving completion reliability by tightening selectors, retries, and validation recovery.`;
    }
    if (normalized.includes("biggest career accomplishments")) {
      return `A major accomplishment was building and operating an AI-assisted job-application automation platform from scratch. I designed the adapter architecture, implemented resilient form extraction/fill logic across ATS providers, and introduced validation-aware recovery so failed submissions became recoverable workflows. I also built the feedback loop using run telemetry and blocker taxonomies, which let me prioritize fixes that materially improved successful completion rates.`;
    }
    if (normalized.includes("biggest career lessons learned")) {
      return `My biggest lesson is that reliability beats cleverness in production systems. Early on, I over-indexed on happy-path automation and learned that unhandled edge cases, selector drift, and weak verification can erase otherwise good engineering. Now I design for observability first, add deterministic fallbacks for known failure classes, and treat validation/error handling as core product behavior rather than afterthoughts.`;
    }
    if (normalized.includes("technical project") || normalized.includes("most proud")) {
      return `A project I’m proud of is building an automated job-application workflow using TypeScript and browser automation. I designed the adapter architecture, implemented field extraction and filling flows, and improved reliability by adding deterministic fallbacks and validation-aware retries across ATS platforms.`;
    }
    if (
      normalized.includes("last thing") &&
      (normalized.includes("built") || normalized.includes("automated")) &&
      normalized.includes("ai")
    ) {
      return `The last thing I built was an AI-assisted browser automation system that handles end-to-end job application workflows. I owned the architecture, implemented extraction and field-filling logic, and added validation-aware retries so failed submissions became recoverable instead of silent. I used structured run logs and per-field verification to identify failure patterns and improve completion reliability over repeated runs.`;
    }
    if (normalized.includes("personally owned") && normalized.includes("multiple teams")) {
      return `I personally owned a cross-functional automation program that required coordinating engineering priorities and operational workflows across multiple contributors. I directly owned execution planning, technical implementation, and dependency tracking, using shared milestone dashboards and weekly check-ins to keep delivery on track. The outcome was a more reliable pipeline with clearer ownership boundaries, faster issue resolution, and a measurable reduction in repeated validation failures.`;
    }
    if (normalized.includes("program or funnel") || (normalized.includes("funnel") && normalized.includes("bottleneck"))) {
      return `I managed an application funnel and tracked stage conversion, validation-failure frequency, and median completion time as primary metrics. I found bottlenecks by segmenting failures by field type and form section, then prioritized fixes that removed the largest drop-off points first. After addressing sticky selection controls and weak fallback logic, conversion through final submission improved and repeat retries dropped significantly.`;
    }
    if (normalized.includes("did not work as expected") || normalized.includes("how did you debug")) {
      return `In one automation flow, submissions failed because required combobox values were not being committed reliably. I debugged by tracing run logs and DOM state after each fill step, then fixed selector scoping and commit behavior so the correct values persisted through submit validation.`;
    }
    if (normalized.includes("vague problem") || normalized.includes("how did you decide what to do")) {
      return `When I get a vague problem, I define the outcome and constraints first, then break the work into testable milestones. I implement the highest-risk slice early, validate with logs and tests, and iterate based on failures until behavior is stable and repeatable.`;
    }
    if (normalized.includes("well suited for this role") || normalized.includes("particularly well suited")) {
      return `I’m well suited for this role because I combine strong implementation depth with reliability-focused execution. I’ve built TypeScript-based automation systems end to end, owned debugging and quality loops, and improved completion outcomes by turning recurring failures into deterministic fixes. I’m comfortable moving quickly in ambiguous environments while maintaining engineering rigor on testing, observability, and production behavior.`;
    }
    if (normalized.includes("anything else you would like us to know")) {
      return `I care deeply about execution quality and ownership. Beyond building features, I focus on making systems reliable under real-world edge cases, documenting decisions clearly, and collaborating closely across teams so outcomes ship quickly and hold up in production.`;
    }
    if (
      normalized.includes("tell us about") ||
      normalized.includes("describe a time") ||
      normalized.includes("why are you interested") ||
      normalized.includes("why this role") ||
      normalized.includes("why this company")
    ) {
      return summary ||
        `My background is in software engineering with a focus on TypeScript, automation, and reliable delivery. I’m motivated by roles like ${role} at ${companyName} where I can own implementation details, collaborate closely, and ship practical features with measurable user impact.`;
    }

    return null;
  }

  private async resolveTextControlLocator(scope: AshbyInteractionScope, field: DetectedField): Promise<Locator | null> {
    const fieldPath = typeof field.platformMeta?.fieldPath === "string" ? String(field.platformMeta.fieldPath).trim() : "";
    if (fieldPath) {
      const block = scope.locator(`[data-field-path="${fieldPath.replace(/"/g, "\\\"")}"]`).first();
      const inBlock = block
        .locator(
          "input[role='combobox'], input[aria-autocomplete='list'], input[placeholder*='Start typing'], input[type='text'], input[type='email'], input[type='tel'], input[type='number'], input:not([type]), textarea"
        )
        .first();
      if (await inBlock.isVisible().catch(() => false)) return inBlock;
    }

    const selectors = [field.selector, ...(field.selectorCandidates ?? [])].filter(Boolean);
    for (const selector of selectors) {
      const candidate = scope.locator(selector).first();
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }

    const byLabel = scope.getByLabel(new RegExp(this.escapeRegex(field.label), "i")).first();
    if (await byLabel.isVisible().catch(() => false)) return byLabel;
    return null;
  }

  private async selectTypeaheadOption(
    scope: AshbyInteractionScope,
    control: Locator,
    desired: string,
    options?: { strict?: boolean }
  ): Promise<boolean> {
    const clickIfVisible = async (locator: Locator): Promise<boolean> => {
      if (!(await locator.isVisible().catch(() => false))) return false;
      await locator.click().catch(() => undefined);
      return true;
    };
    const escaped = this.escapeRegex(desired);
    const exactPattern = new RegExp(`^\\s*${escaped}\\s*$`, "i");
    const listboxId = String((await control.getAttribute("aria-controls").catch(() => "")) ?? "").trim();
    const strict = Boolean(options?.strict);

    const clickedByDomHeuristic = await scope
      .evaluate(
        ({ rawDesired, listboxId: rawListboxId, strictMode }) => {
          const normalize = (value: string) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
          const desired = normalize(rawDesired);
          if (!desired) return false;
          const isVisible = (node: Element | null): node is HTMLElement => {
            if (!(node instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          const root = rawListboxId ? document.querySelector(`[id="${CSS.escape(String(rawListboxId))}"]`) : document;
          if (!root) return false;
          const candidates = Array.from(
            root.querySelectorAll(
              "[role='option'], [data-option], [aria-selected], [aria-checked], [role='menuitem'], [id*='listbox'] li, [class*='option'], [class*='menu'] li, [class*='dropdown'] li"
            )
          ).filter((node) => isVisible(node));
          if (candidates.length === 0) return false;

          const getText = (node: Element): string =>
            normalize(
              (node.textContent || "") ||
              (node.getAttribute("aria-label") || "") ||
              ((node as HTMLInputElement).value || "")
            );

          const toTokens = (value: string): string[] =>
            value
              .split(/[^a-z0-9]+/)
              .map((token) => normalize(token))
              .filter((token) => token.length >= 2);
          const desiredTokens = toTokens(desired);
          const scoreFor = (text: string): number => {
            if (!text) return -1;
            if (text === desired) return 10_000;
            if (text.includes(desired) || desired.includes(text)) return 8_000 + Math.min(text.length, desired.length);
            if (desiredTokens.length === 0) return -1;
            const textTokens = toTokens(text);
            if (textTokens.length === 0) return -1;
            const overlap = desiredTokens.filter((token) => textTokens.includes(token)).length;
            if (overlap <= 0) return -1;
            const overlapRatio = overlap / desiredTokens.length;
            const penalty = Math.abs(textTokens.length - desiredTokens.length);
            return 4_000 + overlap * 100 + Math.round(overlapRatio * 100) - penalty;
          };

          let best: { node: Element; score: number } | null = null;
          for (const node of candidates) {
            const score = scoreFor(getText(node));
            if (score < 0) continue;
            if (!best || score > best.score) {
              best = { node, score };
            }
          }
          if (best?.node instanceof HTMLElement) {
            best.node.click();
            return true;
          }

          if (strictMode) return false;
          const first = candidates[0];
          if (first instanceof HTMLElement) {
            first.click();
            return true;
          }
          return false;
        },
        { rawDesired: desired, listboxId, strictMode: strict }
      )
      .catch(() => false);
    if (clickedByDomHeuristic) return true;

    if (listboxId) {
      const idSelector = `[id="${listboxId.replace(/"/g, '\\"')}"]`;
      const scopedExact = scope.locator(
        `${idSelector} [role='option']:text-matches("${escaped}", "i"), ${idSelector} button:text-matches("${escaped}", "i"), ${idSelector} li:text-matches("${escaped}", "i"), ${idSelector} [data-option]:text-matches("${escaped}", "i")`
      ).first();
      if (await clickIfVisible(scopedExact)) return true;

      if (!strict) {
        const scopedFirst = scope.locator(
          `${idSelector} [role='option'], ${idSelector} [data-option], ${idSelector} li, ${idSelector} button`
        ).first();
        if (await clickIfVisible(scopedFirst)) return true;
      }
    }

    if (await clickIfVisible(scope.getByRole("option", { name: exactPattern }).first())) return true;
    if (await clickIfVisible(scope.getByRole("button", { name: exactPattern }).first())) return true;
    if (await clickIfVisible(scope.getByText(exactPattern).first())) return true;

    const popupExact = scope
      .locator(
        "[role='listbox'] [role='option']:text-matches(\"" + escaped + "\", \"i\"), [class*='dropdown'] li:text-matches(\"" + escaped + "\", \"i\"), [class*='menu'] li:text-matches(\"" + escaped + "\", \"i\"), [class*='option']:text-matches(\"" + escaped + "\", \"i\")"
      )
      .first();
    if (await clickIfVisible(popupExact)) return true;

    if (!strict) {
      const firstOption = scope.getByRole("option").first();
      if (await clickIfVisible(firstOption)) return true;

      const firstPopupItem = scope
        .locator("[role='listbox'] [role='option'], [class*='dropdown'] li, [class*='menu'] li, [class*='option']")
        .first();
      if (await clickIfVisible(firstPopupItem)) return true;
    }

    if (strict) return false;
    await control.press("ArrowDown").catch(() => undefined);
    await control.press("Enter").catch(() => undefined);
    const valueAfterKeyboard = String((await control.inputValue().catch(() => "")) ?? "").trim();
    if (valueAfterKeyboard.length > 0) {
      return true;
    }
    return false;
  }

  private async commitTextControl(
    scope: AshbyInteractionScope,
    control: Locator,
    strategy: AshbyFieldCapability,
    value: string,
    options?: { strictTypeahead?: boolean }
  ): Promise<boolean> {
    const candidate = String(value ?? "").trim();
    if (!candidate) return false;
    await control.click({ force: true }).catch(() => undefined);
    await control.fill("").catch(() => undefined);

    if (strategy === "typeahead_text") {
      if (Boolean(options?.strictTypeahead)) {
        const strictCommitted = await this.commitStrictLocationTypeahead(scope, control, candidate);
        return strictCommitted.applied;
      }
      await control.type(candidate, { delay: 20 }).catch(() => undefined);
      const startedAt = Date.now();
      while (Date.now() - startedAt < 2500) {
        const options = await scope.getByRole("option").count().catch(() => 0);
        const popupItems = await scope
          .locator("[role='listbox'] [role='option'], [class*='dropdown'] li, [class*='menu'] li, [class*='option']")
          .count()
          .catch(() => 0);
        if (options > 0 || popupItems > 0) break;
        await scope.waitForTimeout(120).catch(() => undefined);
      }
      const strictTypeahead = Boolean(options?.strictTypeahead);
      const selected = await this.selectTypeaheadOption(scope, control, candidate, { strict: strictTypeahead });
      await scope.waitForTimeout(80).catch(() => undefined);
      const beforeTab = String((await control.inputValue().catch(() => "")) ?? "").trim();
      if (!beforeTab && !strictTypeahead) {
        await control.press("ArrowDown").catch(() => undefined);
        await control.press("Enter").catch(() => undefined);
      }
      await control.press("Tab").catch(() => undefined);
      await control.blur().catch(() => undefined);
    } else if (strategy === "date_like_text") {
      await control.type(candidate, { delay: 16 }).catch(() => undefined);
      await control.press("Enter").catch(() => undefined);
      await scope.waitForTimeout(80).catch(() => undefined);
      const afterEnter = String((await control.inputValue().catch(() => "")) ?? "").trim();
      if (!afterEnter) {
        await control.press("ArrowDown").catch(() => undefined);
        await control.press("Enter").catch(() => undefined);
      }
      await control.press("Tab").catch(() => undefined);
      await control.blur().catch(() => undefined);
    } else if (strategy === "interactive_text") {
      await control.type(candidate, { delay: 8 }).catch(() => undefined);
      await control.press("Enter").catch(() => undefined);
      await control.press("Tab").catch(() => undefined);
      await control.blur().catch(() => undefined);
    } else {
      await control.type(candidate, { delay: 24 }).catch(() => undefined);
      await control.press("Tab").catch(() => undefined);
      await control.blur().catch(() => undefined);
    }

    const valueAfterCommit = String((await control.inputValue().catch(() => "")) ?? "").trim();
    return valueAfterCommit.length > 0;
  }

  private async countVisibleTypeaheadOptions(scope: AshbyInteractionScope): Promise<number> {
    const directOptions = await scope.getByRole("option").count().catch(() => 0);
    const popupItems = await scope
      .locator("[role='listbox'] [role='option'], [class*='dropdown'] li, [class*='menu'] li, [class*='option']")
      .count()
      .catch(() => 0);
    return Math.max(directOptions, popupItems);
  }

  private async selectTopVisibleTypeaheadOption(scope: AshbyInteractionScope, control: Locator): Promise<boolean> {
    const listboxId = String((await control.getAttribute("aria-controls").catch(() => "")) ?? "").trim();
    const clickIfVisible = async (locator: Locator): Promise<boolean> => {
      if (!(await locator.isVisible().catch(() => false))) return false;
      await locator.click().catch(() => undefined);
      return true;
    };

    if (listboxId) {
      const idSelector = `[id="${listboxId.replace(/"/g, '\\"')}"]`;
      const scopedFirst = scope
        .locator(`${idSelector} [role='option'], ${idSelector} [data-option], ${idSelector} li, ${idSelector} button`)
        .first();
      if (await clickIfVisible(scopedFirst)) return true;
    }

    const firstOption = scope.getByRole("option").first();
    if (await clickIfVisible(firstOption)) return true;
    const firstPopupItem = scope
      .locator("[role='listbox'] [role='option'], [class*='dropdown'] li, [class*='menu'] li, [class*='option']")
      .first();
    if (await clickIfVisible(firstPopupItem)) return true;
    return false;
  }

  private async commitStrictLocationTypeahead(
    scope: AshbyInteractionScope,
    control: Locator,
    candidate: string
  ): Promise<{ applied: boolean; optionsSeen: boolean }> {
    const applyDirectEnterFallback = async (): Promise<boolean> => {
      await control.click({ force: true }).catch(() => undefined);
      await control.fill("").catch(() => undefined);
      await control.type(candidate, { delay: 20 }).catch(() => undefined);
      await scope.waitForTimeout(1000).catch(() => undefined);
      await control.press("Enter").catch(() => undefined);
      await scope.waitForTimeout(120).catch(() => undefined);
      await control.press("Tab").catch(() => undefined);
      await control.blur().catch(() => undefined);
      const directValue = String((await control.inputValue().catch(() => "")) ?? "").trim();
      return directValue.length > 0 && this.looksLikeLocationMatch(directValue, candidate);
    };

    await control.type(candidate, { delay: 20 }).catch(() => undefined);
    let optionsSeen = false;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 2500) {
      const optionCount = await this.countVisibleTypeaheadOptions(scope);
      if (optionCount > 0) {
        optionsSeen = true;
        break;
      }
      await scope.waitForTimeout(120).catch(() => undefined);
    }

    let selected = false;
    if (optionsSeen) {
      selected = await this.selectTopVisibleTypeaheadOption(scope, control);
    }
    if (!selected) await control.press("Enter").catch(() => undefined);

    await scope.waitForTimeout(100).catch(() => undefined);
    let valueAfterSelection = String((await control.inputValue().catch(() => "")) ?? "").trim();
    if (!valueAfterSelection && optionsSeen) {
      // Some Ashby comboboxes require Enter after click to commit selected option text.
      await control.press("Enter").catch(() => undefined);
      await scope.waitForTimeout(80).catch(() => undefined);
      valueAfterSelection = String((await control.inputValue().catch(() => "")) ?? "").trim();
    }

    if (valueAfterSelection && !this.looksLikeLocationMatch(valueAfterSelection, candidate)) {
      await control.fill("").catch(() => undefined);
      return { applied: false, optionsSeen };
    }

    await control.press("Tab").catch(() => undefined);
    await control.blur().catch(() => undefined);
    const valueAfterCommit = String((await control.inputValue().catch(() => "")) ?? "").trim();
    if (valueAfterCommit && !this.looksLikeLocationMatch(valueAfterCommit, candidate)) {
      const directFallbackApplied = await applyDirectEnterFallback();
      if (directFallbackApplied) return { applied: true, optionsSeen };
      await control.fill("").catch(() => undefined);
      return { applied: false, optionsSeen };
    }

    if (valueAfterCommit.length > 0) return { applied: true, optionsSeen };
    if (optionsSeen && selected) return { applied: true, optionsSeen };
    const directFallbackApplied = await applyDirectEnterFallback();
    if (directFallbackApplied) return { applied: true, optionsSeen };
    return { applied: false, optionsSeen };
  }

  private async inferCapabilityForControl(label: string, control: Locator): Promise<AshbyFieldCapability> {
    const role = this.normalize(String((await control.getAttribute("role").catch(() => "")) ?? ""));
    const ariaHasPopup = this.normalize(String((await control.getAttribute("aria-haspopup").catch(() => "")) ?? ""));
    const inputType = this.normalize(String((await control.getAttribute("type").catch(() => "")) ?? ""));
    const placeholder = String((await control.getAttribute("placeholder").catch(() => "")) ?? "");
    if (this.isDateLikePrompt(label, placeholder) || inputType === "date" || ariaHasPopup === "dialog") {
      return "date_like_text";
    }
    if (role === "combobox" || ariaHasPopup === "listbox" || inputType === "search" || this.isLocationPrompt(this.normalize(label))) {
      return "typeahead_text";
    }
    const tagName = this.normalize(String((await control.evaluate((node) => node.tagName).catch(() => "")) ?? ""));
    if (tagName === "textarea") return "interactive_text";
    return "plain_text";
  }

  private buildCommitValuesForTextField(
    field: Pick<DetectedField, "label" | "placeholder">,
    capability: AshbyFieldCapability,
    value: string | string[] | boolean | null
  ): string[] {
    const raw = Array.isArray(value)
      ? String(value[0] ?? "").trim()
      : typeof value === "boolean"
        ? value
          ? "Yes"
          : "No"
        : String(value ?? "").trim();
    if (!raw) return [];
    const degreeCanonical = this.canonicalizeDegreeSelectionCandidate(field.label, raw);
    if (capability !== "date_like_text") return this.mergeUnique([degreeCanonical, raw]);

    const parsed = this.parseDateLikeValue(raw);
    if (!parsed) return this.mergeUnique([degreeCanonical, raw]);
    return this.buildDateFormatCandidates(parsed, field.placeholder);
  }

  private looksLikeLocationMatch(actual: string, desired: string): boolean {
    const left = this.normalize(actual);
    const right = this.normalize(desired);
    if (!left || !right) return false;
    if (/(united states|usa|us)\b/.test(right) && this.isCountryMismatch(actual, "United States")) {
      return false;
    }
    if (left === right || left.includes(right) || right.includes(left)) return true;
    const leftTokens = left.split(/[\s,]+/).filter((token) => token.length >= 2);
    const rightTokens = right.split(/[\s,]+/).filter((token) => token.length >= 2);
    if (leftTokens.length === 0 || rightTokens.length === 0) return false;
    const overlap = rightTokens.filter((token) => leftTokens.includes(token)).length;
    return overlap >= Math.min(2, rightTokens.length);
  }

  private async fillFieldWithVerification(
    scope: AshbyInteractionScope,
    field: DetectedField,
    value: string | string[] | boolean | null,
    options?: {
      profile?: CandidateProfile;
      postingLocation?: string;
      ashbyConfig?: AshbyConfig;
      logger?: AdapterRunContext["logger"];
    }
  ): Promise<boolean> {
    if (!this.answerHasValue(value)) return false;
    if (field.type === "file") {
      const filePath = String(value ?? "").trim();
      if (!filePath) return false;
      const effectiveResumePath = await this.resolveAshbyResumeUploadPath(scope, filePath, field);
      const fileApplied = await fillField(scope, field, effectiveResumePath).catch(() => false);
      if (!fileApplied) return false;
      const fileVerified = await this.verifyFieldAnswered(scope, field, effectiveResumePath);
      return fileVerified;
    }
    if (field.id === "_systemfield_location" && options?.profile) {
      const locationAttempt = await this.fillAshbySystemLocationCombobox(scope, options.profile, options.postingLocation);
      return locationAttempt.applied;
    }
    if (this.isComboboxBackedSelectionField(field) && (field.type === "single_select" || field.type === "multi_select")) {
      const control = await this.resolveTextControlLocator(scope, field);
      if (control) {
        if (options?.profile && field.type === "single_select" && this.isGraduationComboboxPrompt(field.label)) {
          const fieldPath = typeof field.platformMeta?.fieldPath === "string" ? String(field.platformMeta.fieldPath).trim() : "";
          const container = fieldPath
            ? scope.locator(`[data-field-path="${fieldPath.replace(/"/g, "\\\"")}"]`).first()
            : control.locator("xpath=ancestor::*[@data-field-path][1] | ancestor::fieldset[1] | ancestor::div[contains(@class,'_fieldEntry_')][1]").first();
          if (await container.isVisible().catch(() => false)) {
            const committed = await this.selectGraduationComboboxOption(scope, container, control, options.profile);
            if (committed && (await this.verifyFieldAnswered(scope, field))) return true;
          }
        }
        const tokens = Array.isArray(value)
          ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
          : [String(value ?? "").trim()].filter(Boolean);
        const normalizedTokens = this.mergeUnique(
          tokens.map((token) => this.canonicalizeDegreeSelectionCandidate(field.label, token))
        );
        if (normalizedTokens.length > 0) {
          if (field.type === "single_select") {
            const firstToken = normalizedTokens[0];
            if (!firstToken) return false;
            const committed = await this.commitStrictComboboxTypeahead(scope, control, firstToken);
            if (committed && (await this.verifyFieldAnswered(scope, field, firstToken))) return true;
          } else {
            let committedCount = 0;
            for (const token of normalizedTokens) {
              const committed = await this.commitStrictComboboxTypeahead(scope, control, token);
              if (committed) committedCount += 1;
            }
            if (committedCount > 0 && (await this.verifyFieldAnswered(scope, field, normalizedTokens))) return true;
          }
        }
      }
    }
    if (field.type === "multi_select" && Array.isArray(value) && value.length > 0) {
      const fallback = await this.fillCheckboxGroupFieldsetFallback(scope, field, value.map((item) => String(item)));
      options?.logger?.info("ashby_checkbox_group_options_extracted", {
        question: field.label,
        targetAnswer: value.map((item) => String(item)),
        extractedOptions: fallback.extractedOptions
      });
      for (const match of fallback.matches) {
        options?.logger?.info("ashby_checkbox_group_option_match", {
          question: field.label,
          targetAnswer: match.targetAnswer,
          extractedOptions: fallback.extractedOptions,
          matchedOption: match.matchedOption
        });
      }
      for (const attempt of fallback.clickAttempts) {
        options?.logger?.info("ashby_checkbox_group_click_attempt", {
          question: field.label,
          targetAnswer: attempt.targetAnswer,
          matchedOption: attempt.matchedOption,
          clickTargetUsed: attempt.clickTargetUsed,
          selectedSignalsObserved: attempt.selectedSignalsObserved,
          applied: attempt.applied
        });
      }
      options?.logger?.info("ashby_checkbox_group_verify_result", {
        question: field.label,
        targetAnswer: value.map((item) => String(item)),
        extractedOptions: fallback.extractedOptions,
        selectedSignalsObserved: fallback.selectedSignalsObserved,
        applied: fallback.applied
      });
      if (fallback.applied && (await this.verifyFieldAnswered(scope, field, value))) return true;
    }
    let applied = false;
    let strictTypeaheadAttempted = false;
    const capability = this.fieldCapability(field);
    if ((field.type === "text" || field.type === "textarea") && capability && this.resolveTextCommitMode(options?.ashbyConfig) === "robust") {
      const control = await this.resolveTextControlLocator(scope, field);
      if (control) {
        const commitValues = this.buildCommitValuesForTextField(field, capability, value);
        const normalizedLabel = this.normalize(field.label);
        const strictTypeahead = capability === "typeahead_text" && (
          this.isLocationPrompt(normalizedLabel) ||
          this.isCountryResidencePrompt(normalizedLabel) ||
          /(^|[^a-z0-9])location([^a-z0-9]|$)/.test(this.normalize(String(field.id ?? "")))
        );
        strictTypeaheadAttempted = strictTypeahead;
        for (const candidate of commitValues) {
          const committed = await this.commitTextControl(scope, control, capability, candidate, { strictTypeahead });
          if (!committed) continue;
          if (await this.verifyFieldAnswered(scope, field, candidate)) return true;
          applied = true;
        }
      }
    }
    if (strictTypeaheadAttempted && !applied) {
      return false;
    }
    if (!applied) {
      applied = await fillField(scope, field, value).catch(() => false);
    }
    if (!applied) return false;
    const verified = await this.verifyFieldAnswered(scope, field, value);
    if (verified) return true;

    const normalizedLabel = this.normalize(field.label);
    if (
      (this.isLocationPrompt(normalizedLabel) ||
        /(^|[^a-z0-9])location([^a-z0-9]|$)/.test(this.normalize(String(field.id ?? "")))) &&
      options?.profile
    ) {
      if (this.isCountryResidencePrompt(normalizedLabel)) {
        const countryRecovered = await this.retryCountryResidenceTypeaheadSelection(
          scope,
          field,
          options.profile.country ?? "United States"
        );
        if (countryRecovered) return true;
      }
      const locationRecovered = await this.retryLocationCommitSelection(
        scope,
        field,
        options.profile,
        field.label,
        options.postingLocation,
        options.ashbyConfig
      );
      if (locationRecovered) return true;
    }

    const isCustomSingleChoice =
      field.type === "single_select" && String(field.platformMeta?.inputType ?? "").toLowerCase().includes("custom");
    if (!isCustomSingleChoice) return false;

    await this.retryCustomSingleChoiceSelection(scope, field, value);
    return this.verifyFieldAnswered(scope, field, value);
  }

  private async fillCheckboxGroupFieldsetFallback(
    scope: AshbyInteractionScope,
    field: DetectedField,
    selectedOptions: string[]
  ): Promise<{
    applied: boolean;
    extractedOptions: string[];
    selectedSignalsObserved: string[];
    matches: Array<{ targetAnswer: string; matchedOption: string | null }>;
    clickAttempts: Array<{
      targetAnswer: string;
      matchedOption: string;
      clickTargetUsed: "label" | "row" | "input" | "native_input_click";
      selectedSignalsObserved: string[];
      applied: boolean;
    }>;
  }> {
    if (!selectedOptions.length) {
      return {
        applied: false,
        extractedOptions: [],
        selectedSignalsObserved: [],
        matches: [],
        clickAttempts: []
      };
    }
    const fieldPath = typeof field.platformMeta?.fieldPath === "string" ? String(field.platformMeta.fieldPath) : "";
    const output = (await scope.evaluate(async ({ rawFieldPath, rawSelector, rawSelectedOptions }) => {
      const normalize = (value: string) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const selected = Array.isArray(rawSelectedOptions) ? rawSelectedOptions.map((item) => String(item).trim()).filter(Boolean) : [];
      const visible = (el: Element | null): el is HTMLElement => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const locateFieldset = (): HTMLElement | null => {
        const fieldPath = String(rawFieldPath || "").trim();
        if (fieldPath) {
          const direct = document.querySelector(`[data-field-path="${CSS.escape(fieldPath)}"]`);
          if (direct instanceof HTMLElement) return direct;
          const byTitleFor = Array.from(document.querySelectorAll("fieldset")).find((fieldset) =>
            Boolean(fieldset.querySelector(`label[for="${CSS.escape(fieldPath)}"]`))
          );
          if (byTitleFor instanceof HTMLElement) return byTitleFor;
        }
        const selector = String(rawSelector || "").trim();
        if (selector) {
          const node = document.querySelector(selector);
          if (node instanceof HTMLElement) {
            const fieldset = node.closest("fieldset, [data-field-path], .ashby-application-form-field-entry");
            if (fieldset instanceof HTMLElement) return fieldset;
          }
        }
        return null;
      };
      const container = locateFieldset();
      if (!container) {
        return {
          applied: false,
          extractedOptions: [] as string[],
          selectedSignalsObserved: [] as string[],
          matches: [] as Array<{ targetAnswer: string; matchedOption: string | null }>,
          clickAttempts: [] as Array<{
            targetAnswer: string;
            matchedOption: string;
            clickTargetUsed: "label" | "row" | "input" | "native_input_click";
            selectedSignalsObserved: string[];
            applied: boolean;
          }>
        };
      }

      const hasClassToken = (element: Element | null, token: string): boolean => {
        if (!(element instanceof HTMLElement)) return false;
        const tokens = String(element.className || "").split(/\s+/).map((item) => item.trim()).filter(Boolean);
        return tokens.includes(token);
      };

      const extractOptions = () => {
        const checkboxes = Array.from(container.querySelectorAll("input[type='checkbox']")) as HTMLInputElement[];
        return checkboxes.map((input) => {
          const id = String(input.id || "");
          const label = id ? (container.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLLabelElement | null) : null;
          const optionRoot = input.closest("div[class*='_option_']") as HTMLElement | null;
          const visualSpan = input.parentElement as HTMLElement | null;
          const optionText = String(
            label?.innerText ||
            input.name ||
            input.value ||
            optionRoot?.innerText ||
            ""
          ).replace(/\s+/g, " ").trim();
          return {
            input,
            label,
            optionRoot,
            visualSpan,
            optionText,
            normalizedOptionText: normalize(optionText)
          };
        }).filter((item) => Boolean(item.normalizedOptionText));
      };

      const options = extractOptions();
      const extractedOptions = options.map((item) => item.optionText);

      const safeMatch = (target: string) => {
        const normalizedTarget = normalize(target);
        if (!normalizedTarget) return null;
        const exact = options.find((item) => item.normalizedOptionText === normalizedTarget);
        if (exact) return exact;
        const fuzzy = options.find((item) =>
          item.normalizedOptionText.includes(normalizedTarget) ||
          normalizedTarget.includes(item.normalizedOptionText)
        );
        if (fuzzy) return fuzzy;
        const bachelorLike = /\b(bachelor|b\.s|bs|undergraduate)\b/.test(normalizedTarget);
        if (bachelorLike) {
          const undergrad = options.find((item) =>
            item.normalizedOptionText.includes("undergraduate") || item.normalizedOptionText.includes("bachelor")
          );
          if (undergrad) return undergrad;
        }
        return null;
      };

      const selectedSignals = (entry: {
        input: HTMLInputElement;
        label: HTMLLabelElement | null;
        optionRoot: HTMLElement | null;
        visualSpan: HTMLElement | null;
      }): string[] => {
        const signals: string[] = [];
        if (entry.input.checked) signals.push("input_checked");
        if (hasClassToken(entry.optionRoot, "true")) signals.push("option_root_true_token");
        if (String(entry.visualSpan?.className || "").includes("_checked_1hpbx_")) signals.push("visual_span_checked_class");
        if (String(entry.label?.className || "").includes("_checked_1v5e2_")) signals.push("label_checked_class");
        return signals;
      };

      const isSelected = (entry: {
        input: HTMLInputElement;
        label: HTMLLabelElement | null;
        optionRoot: HTMLElement | null;
        visualSpan: HTMLElement | null;
      }) => selectedSignals(entry).length > 0;

      const clickAttempts: Array<{
        targetAnswer: string;
        matchedOption: string;
        clickTargetUsed: "label" | "row" | "input" | "native_input_click";
        selectedSignalsObserved: string[];
        applied: boolean;
      }> = [];
      const matches: Array<{ targetAnswer: string; matchedOption: string | null }> = [];
      const successfulSignals: string[] = [];
      let appliedAny = false;

      const wait = () => new Promise((resolve) => window.setTimeout(resolve, 150));

      for (const target of selected) {
        const match = safeMatch(target);
        matches.push({ targetAnswer: target, matchedOption: match?.optionText ?? null });
        if (!match) continue;

        // Prevent retry from toggling an already-selected checkbox off.
        if (isSelected(match)) {
          const signals = selectedSignals(match);
          successfulSignals.push(...signals);
          clickAttempts.push({
            targetAnswer: target,
            matchedOption: match.optionText,
            clickTargetUsed: "input",
            selectedSignalsObserved: signals,
            applied: true
          });
          appliedAny = true;
          continue;
        }

        const clickOrder: Array<{ key: "label" | "row" | "input"; node: HTMLElement | null }> = [
          { key: "label", node: match.label },
          { key: "row", node: match.optionRoot },
          { key: "input", node: match.input }
        ];
        let selectedNow = false;
        for (const clickTarget of clickOrder) {
          if (!(clickTarget.node instanceof HTMLElement)) continue;
          if (!visible(clickTarget.node)) continue;
          clickTarget.node.click();
          await wait();
          const signals = selectedSignals(match);
          const hit = signals.length > 0;
          clickAttempts.push({
            targetAnswer: target,
            matchedOption: match.optionText,
            clickTargetUsed: clickTarget.key,
            selectedSignalsObserved: signals,
            applied: hit
          });
          if (hit) {
            selectedNow = true;
            appliedAny = true;
            successfulSignals.push(...signals);
            break;
          }
        }
        if (selectedNow) continue;

        match.input.click();
        match.input.dispatchEvent(new Event("input", { bubbles: true }));
        match.input.dispatchEvent(new Event("change", { bubbles: true }));
        await wait();
        const signals = selectedSignals(match);
        const hit = signals.length > 0;
        clickAttempts.push({
          targetAnswer: target,
          matchedOption: match.optionText,
          clickTargetUsed: "native_input_click",
          selectedSignalsObserved: signals,
          applied: hit
        });
        if (hit) {
          appliedAny = true;
          successfulSignals.push(...signals);
        }
      }

      const matchedExpected = selected
        .map((item) => safeMatch(item))
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      const expectedSelected = matchedExpected.length > 0 && matchedExpected.some((entry) => isSelected(entry));
      return {
        applied: appliedAny && expectedSelected,
        extractedOptions,
        selectedSignalsObserved: Array.from(new Set(successfulSignals)),
        matches,
        clickAttempts
      };
    }, {
      rawFieldPath: fieldPath,
      rawSelector: String(field.selector || ""),
      rawSelectedOptions: selectedOptions
    }).catch(() => ({
      applied: false,
      extractedOptions: [] as string[],
      selectedSignalsObserved: [] as string[],
      matches: [] as Array<{ targetAnswer: string; matchedOption: string | null }>,
      clickAttempts: [] as Array<{
        targetAnswer: string;
        matchedOption: string;
        clickTargetUsed: "label" | "row" | "input" | "native_input_click";
        selectedSignalsObserved: string[];
        applied: boolean;
      }>
    }))) as {
      applied?: boolean;
      extractedOptions?: string[];
      selectedSignalsObserved?: string[];
      matches?: Array<{ targetAnswer: string; matchedOption: string | null }>;
      clickAttempts?: Array<{
        targetAnswer: string;
        matchedOption: string;
        clickTargetUsed: "label" | "row" | "input" | "native_input_click";
        selectedSignalsObserved: string[];
        applied: boolean;
      }>;
    };
    return {
      applied: Boolean(output.applied),
      extractedOptions: Array.isArray(output.extractedOptions) ? output.extractedOptions : [],
      selectedSignalsObserved: Array.isArray(output.selectedSignalsObserved) ? output.selectedSignalsObserved : [],
      matches: Array.isArray(output.matches) ? output.matches : [],
      clickAttempts: Array.isArray(output.clickAttempts) ? output.clickAttempts : []
    };
  }

  private async resolveAshbyResumeUploadPath(
    scope: AshbyInteractionScope,
    resumePath: string,
    field?: Pick<DetectedField, "selector">
  ): Promise<string> {
    const ext = path.extname(resumePath).toLowerCase();
    if ([".pdf", ".doc", ".docx", ".rtf"].includes(ext)) {
      return resumePath;
    }

    let acceptHints: string[] = [];
    const selector = String(field?.selector ?? "").trim();
    if (selector) {
      const accept = await scope.locator(selector).first().getAttribute("accept").catch(() => null);
      if (accept?.trim()) acceptHints.push(accept.toLowerCase());
    }
    if (!acceptHints.length) {
      acceptHints = await scope.evaluate(() => {
        return Array.from(document.querySelectorAll<HTMLInputElement>("input[type='file']"))
          .map((input) => (input.accept || "").toLowerCase())
          .filter(Boolean)
          .slice(0, 12);
      }).catch(() => [] as string[]);
    }

    const acceptOnlyDocumentFormats =
      acceptHints.length > 0 &&
      acceptHints.every((accept) => /pdf|doc|docx|msword|officedocument|rtf/.test(accept) && !/\btxt\b|text\/plain/.test(accept));
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

  private resolvePreferredResumePath(
    profile: CandidateProfile,
    configuredResumePath?: string,
    ashbyConfig?: AshbyConfig
  ): string | undefined {
    const candidates: string[] = [];
    const push = (value?: string) => {
      const text = String(value ?? "").trim();
      if (!text) return;
      if (candidates.includes(text)) return;
      candidates.push(text);
    };

    push(configuredResumePath);
    for (const entry of ashbyConfig?.fileValues ?? []) {
      if (/resume|cv/i.test(String(entry.id ?? ""))) push(entry.path);
    }

    const custom = profile.customAnswers ?? {};
    for (const [key, raw] of Object.entries(custom)) {
      const normalizedKey = this.normalize(key);
      if (!/resume|cv/.test(normalizedKey)) continue;
      if (typeof raw === "string") push(raw);
    }

    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const ext = path.extname(candidate).toLowerCase();
      if ([".pdf", ".doc", ".docx", ".rtf", ".txt"].includes(ext)) return candidate;
    }
    return undefined;
  }

  private buildLocationCandidateValues(
    fieldLabel: string | undefined,
    profile: CandidateProfile,
    postingLocation?: string
  ): string[] {
    const values: string[] = [];
    const push = (value?: string) => {
      const normalized = normalizeWhitespace(String(value ?? ""));
      if (!normalized) return;
      if (values.some((item) => this.normalize(item) === this.normalize(normalized))) return;
      values.push(normalized);
    };
    const normalizedLabel = this.normalize(String(fieldLabel ?? ""));
    const countryOnly = this.isCountryResidencePrompt(normalizedLabel);
    if (countryOnly) {
      push(profile.country ?? "United States");
      push("United States");
      return values;
    }

    const locationSpec = this.resolveAshbyLocationSpec(profile, postingLocation);
    if (locationSpec) {
      // Prefer fully-qualified City, State, Country before any looser variants.
      push(`${locationSpec.city}, ${locationSpec.region}, ${locationSpec.country}`);
      push(`${locationSpec.city}, ${locationSpec.region}`);
      push(locationSpec.city);
    }
    push(profile.state);
    push(profile.country ?? "United States");
    push(postingLocation);
    return values;
  }

  private async retryLocationCommitSelection(
    scope: AshbyInteractionScope,
    field: DetectedField,
    profile: CandidateProfile,
    fieldLabel?: string,
    postingLocation?: string,
    ashbyConfig?: AshbyConfig
  ): Promise<boolean> {
    const locationSpec = this.resolveAshbyLocationSpec(profile, postingLocation);
    const candidates = locationSpec?.query
      ? [locationSpec.query]
      : this.buildLocationCandidateValues(fieldLabel, profile, postingLocation).slice(0, 1);
    if (candidates.length === 0) return false;
    const perCandidateRetries = Math.max(1, ashbyConfig?.locationCommitRetries ?? 3);
    const control = await this.resolveTextControlLocator(scope, field);
    const capability = this.fieldCapability(field);
    if (!control || capability !== "typeahead_text") return false;
    for (const candidate of candidates) {
      let sawOptionsForCandidate = false;
      for (let attempt = 1; attempt <= perCandidateRetries; attempt += 1) {
        const commit = await this.commitStrictLocationTypeahead(scope, control, candidate);
        if (commit.optionsSeen) sawOptionsForCandidate = true;
        const applied = commit.applied;
        if (!applied) continue;
        if (await this.verifyFieldAnswered(scope, field, candidate)) return true;
        await scope.waitForTimeout(140).catch(() => undefined);
      }
      if (sawOptionsForCandidate) {
        // If options are visible for this query, do not escalate to broader queries.
        return false;
      }
    }
    return false;
  }

  private async retryCountryResidenceTypeaheadSelection(
    scope: AshbyInteractionScope,
    field: DetectedField,
    country: string
  ): Promise<boolean> {
    const desired = normalizeWhitespace(country) || "United States";
    const fieldPath = typeof field.platformMeta?.fieldPath === "string" ? String(field.platformMeta.fieldPath).trim() : "";
    const escaped = this.escapeRegex(desired);
    const textPattern = new RegExp(`^${escaped}$`, "i");

    const candidateInputs: Locator[] = [];
    const pushInput = (locator: Locator) => candidateInputs.push(locator);
    if (fieldPath) {
      const block = scope.locator(`[data-field-path="${fieldPath.replace(/"/g, "\\\"")}"]`).first();
      pushInput(block.locator("input[role='combobox']").first());
      pushInput(block.locator("input[type='text']").first());
      pushInput(block.locator("input:not([type])").first());
    }
    if (String(field.selector || "").trim()) {
      pushInput(scope.locator(field.selector).first());
    }
    pushInput(scope.getByLabel(/country of residence|current country/i).first());
    pushInput(scope.locator("input[role='combobox']").first());

    const tryClick = async (locator: Locator): Promise<boolean> => {
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) return false;
      await locator.click({ force: true }).catch(() => undefined);
      return true;
    };

    for (const input of candidateInputs) {
      const visible = await input.isVisible().catch(() => false);
      if (!visible) continue;
      await input.click({ force: true }).catch(() => undefined);
      await input.fill("").catch(() => undefined);
      await input.type(desired, { delay: 55 }).catch(() => undefined);
      await scope.waitForTimeout(220).catch(() => undefined);

      if (await tryClick(scope.getByRole("option", { name: textPattern }).first())) {
        if (await this.verifyFieldAnswered(scope, field, desired)) return true;
      }
      if (await tryClick(scope.getByRole("button", { name: textPattern }).first())) {
        if (await this.verifyFieldAnswered(scope, field, desired)) return true;
      }
      if (await tryClick(scope.getByText(textPattern).first())) {
        if (await this.verifyFieldAnswered(scope, field, desired)) return true;
      }
    }
    return false;
  }

  private normalizeLocationLabel(value: string): string {
    const normalized = String(value || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/\s*,\s*/g, ", ")
      .trim();
    const parts = normalized
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const deduped: string[] = [];
    for (const part of parts) {
      if (deduped.length && deduped[deduped.length - 1] === part) continue;
      deduped.push(part);
    }
    return deduped.join(", ");
  }

  private isCountryMismatch(actual: string, preferredCountry: string): boolean {
    const a = this.normalizeLocationLabel(actual);
    const p = this.normalize(preferredCountry);
    if (!a || !p) return false;
    const mentionsUs = /\b(united states|usa|us)\b/.test(a);
    const mentionsMexico = /\bmexico\b/.test(a);
    if (/(united states|usa|us)/.test(p)) {
      return mentionsMexico && !mentionsUs;
    }
    return false;
  }

  private expandRegionToken(value?: string): string {
    const raw = normalizeWhitespace(String(value ?? ""));
    if (!raw) return "";
    const normalized = this.normalize(raw);
    return US_STATE_ABBREVIATIONS[normalized] ?? raw;
  }

  private abbreviateRegionToken(value?: string): string {
    const raw = normalizeWhitespace(String(value ?? ""));
    if (!raw) return "";
    const normalized = this.normalize(raw);
    if (/^[a-z]{2}$/.test(normalized)) return normalized.toUpperCase();
    for (const [abbr, full] of Object.entries(US_STATE_ABBREVIATIONS)) {
      if (this.normalize(full) === normalized) return abbr.toUpperCase();
    }
    return raw;
  }

  private resolveAshbyLocationSpec(profile: CandidateProfile, postingLocation?: string): AshbyLocationFillSpec | null {
    const structured = profile.locationStructured;
    const locationParts = normalizeWhitespace(profile.basics.location ?? "")
      .split(",")
      .map((part) => normalizeWhitespace(part))
      .filter(Boolean);
    const hasStreetToken = (value: string): boolean => {
      const normalized = this.normalize(value);
      if (!normalized) return false;
      return /^\d/.test(normalized) || /\b(ave|avenue|st|street|rd|road|dr|drive|blvd|boulevard|ln|lane|way|suite|ste|apt|unit)\b/.test(normalized);
    };
    const isLikelyPostalCode = (value: string): boolean => /^\d{5}(?:-\d{4})?$/.test(value.trim());
    const cityFromFlat = (() => {
      if (locationParts.length === 0) return "";
      const firstPart = locationParts[0] ?? "";
      if (locationParts.length >= 2 && hasStreetToken(firstPart)) {
        return locationParts.find((part, index) => index > 0 && !isLikelyPostalCode(part)) ?? "";
      }
      return firstPart;
    })();

    const city = normalizeWhitespace(structured?.city ?? cityFromFlat);
    if (!city) return null;
    const region = this.expandRegionToken(
      structured?.region ??
      profile.state ??
      locationParts[1] ??
      ""
    ) || "California";
    const country = normalizeWhitespace(
      structured?.country ??
      profile.country ??
      locationParts[2] ??
      "United States"
    ) || "United States";

    const query = normalizeWhitespace(structured?.ashbyQuery ?? `${city}, ${region}, ${country}`);
    const target = normalizeWhitespace(structured?.ashbyTarget ?? `${city}, ${region}, ${country}`);
    if (!query || !target) return null;
    return { city, region, country, query, target };
  }

  private async fillAshbySystemLocationCombobox(
    scope: AshbyInteractionScope,
    profile: CandidateProfile,
    postingLocation?: string
  ): Promise<{
    applied: boolean;
    query: string;
    target: string;
    optionVisible: boolean;
    optionExact: boolean;
    valueMatched: boolean;
    value?: string;
  }> {
    const spec = this.resolveAshbyLocationSpec(profile, postingLocation);
    if (!spec) {
      return {
        applied: false,
        query: "",
        target: "",
        optionVisible: false,
        optionExact: false,
        valueMatched: false
      };
    }

    const field = scope.locator('[data-field-path="_systemfield_location"]').first();
    if (!(await field.isVisible().catch(() => false))) {
      return {
        applied: false,
        query: spec.query,
        target: spec.target,
        optionVisible: false,
        optionExact: false,
        valueMatched: false
      };
    }

    const input = field.locator('input[role="combobox"], input[placeholder="Start typing..."]').first();
    if (!(await input.isVisible().catch(() => false))) {
      return {
        applied: false,
        query: spec.query,
        target: spec.target,
        optionVisible: false,
        optionExact: false,
        valueMatched: false
      };
    }

    await input.click({ force: true }).catch(() => undefined);
    await input.fill("").catch(() => undefined);
    await input.type(spec.query, { delay: 55 }).catch(() => undefined);

    const listboxId = String((await input.getAttribute("aria-controls").catch(() => "")) ?? "").trim();
    let optionVisible = false;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5000) {
      const scopedCount = listboxId
        ? await scope.locator(`[id="${listboxId.replace(/"/g, '\\"')}"] [role='option']`).count().catch(() => 0)
        : 0;
      const globalCount = await scope.getByRole("option").count().catch(() => 0);
      if (Math.max(scopedCount, globalCount) > 0) {
        optionVisible = true;
        break;
      }
      await scope.waitForTimeout(120).catch(() => undefined);
    }

    // Give the typeahead a brief settle window, then commit via Enter.
    await scope.waitForTimeout(650).catch(() => undefined);
    await input.press("Enter").catch(() => undefined);
    const optionExact = false;

    const targetNormalized = this.normalizeLocationLabel(spec.target);
    const verifyStarted = Date.now();
    let value = "";
    let valueMatched = false;
    let enterRetried = false;
    while (Date.now() - verifyStarted < 5000) {
      value = String((await input.inputValue().catch(() => "")) ?? "").trim();
      valueMatched = this.normalizeLocationLabel(value) === targetNormalized;
      if (valueMatched) break;
      if (!enterRetried && Date.now() - verifyStarted > 350) {
        // Ashby combobox occasionally needs Enter to commit clicked option text.
        await input.press("Enter").catch(() => undefined);
        enterRetried = true;
      }
      await scope.waitForTimeout(100).catch(() => undefined);
    }

    if (!valueMatched) {
      return {
        applied: false,
        query: spec.query,
        target: spec.target,
        optionVisible: true,
        optionExact,
        valueMatched: false,
        value
      };
    }

    return {
      applied: true,
      query: spec.query,
      target: spec.target,
      optionVisible: true,
      optionExact,
      valueMatched: true,
      value
    };
  }

  private async ensureCurrentLocationCommitted(
    scope: AshbyInteractionScope,
    profile: CandidateProfile,
    postingLocation: string | undefined
  ): Promise<string | null> {
    const attempt = await this.fillAshbySystemLocationCombobox(scope, profile, postingLocation);
    if (!attempt.applied) return null;
    return attempt.value ?? attempt.target;
  }

  private async retryCustomSingleChoiceSelection(
    scope: AshbyInteractionScope,
    field: DetectedField,
    value: string | string[] | boolean | null
  ): Promise<void> {
    const desired = Array.isArray(value) ? String(value[0] ?? "") : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value ?? "");
    const groupNames = Array.isArray(field.platformMeta?.groupNames)
      ? (field.platformMeta.groupNames as unknown[]).map((item) => String(item).trim()).filter(Boolean)
      : [];
    const payload = {
      fieldPath: typeof field.platformMeta?.fieldPath === "string" ? field.platformMeta.fieldPath : "",
      groupName: typeof field.platformMeta?.groupName === "string" ? field.platformMeta.groupName : "",
      groupNames,
      desired
    };
    await scope.evaluate(({ fieldPath, groupName, groupNames, desired: rawDesired }) => {
      const normalize = (item: string) => String(item || "").replace(/\s+/g, " ").trim().toLowerCase();
      const desired = normalize(rawDesired);
      if (!desired) return;
      const names = Array.from(new Set([String(groupName || "").trim(), ...(Array.isArray(groupNames) ? groupNames : [])].filter(Boolean)));

      const byFieldPath = fieldPath ? document.querySelector(`[data-field-path="${CSS.escape(fieldPath)}"]`) : null;
      const byGroupName = groupName
        ? (document.querySelector(
            `input[type="radio"][name="${CSS.escape(groupName)}"], input[type="checkbox"][name="${CSS.escape(groupName)}"]`
          )?.closest("[data-field-path], fieldset, div[class*='_fieldEntry_']") as HTMLElement | null)
        : null;
      const block = (byFieldPath ?? byGroupName) as HTMLElement | null;
      if (!block) return;

      const optionNodes = Array.from(block.querySelectorAll("button, label, [role='radio'], [role='option']")) as HTMLElement[];
      const aliases = desired === "yes" ? ["yes", "true"] : desired === "no" ? ["no", "false"] : [desired];
      for (const alias of aliases) {
        const match = optionNodes.find((node) => {
          const text = normalize(node.textContent || node.getAttribute("aria-label") || "");
          return text === alias || text.includes(alias);
        });
        if (match) {
          match.click();
          break;
        }
      }

      const inputs = Array.from(block.querySelectorAll("input[type='radio'], input[type='checkbox']")) as HTMLInputElement[];
      for (const input of inputs) {
        if (names.length > 0 && !names.includes(input.name || "")) continue;
        const text = normalize(
          input.getAttribute("value") ||
            input.getAttribute("aria-label") ||
            (input.closest("label")?.textContent || "")
        );
        const isDesired = aliases.some((alias) => text === alias || text.includes(alias));
        if (!isDesired) continue;
        if (input.type === "radio") {
          input.checked = true;
        } else {
          input.checked = true;
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        break;
      }
    }, payload).catch(() => undefined);
  }

  private async verifyFieldAnswered(
    scope: AshbyInteractionScope,
    field: DetectedField,
    expectedValue?: string | string[] | boolean | null
  ): Promise<boolean> {
    const fieldPath = typeof field.platformMeta?.fieldPath === "string" ? String(field.platformMeta.fieldPath) : "";
    const groupIdentity = typeof field.platformMeta?.groupIdentity === "string" ? String(field.platformMeta.groupIdentity) : "";
    const selectorCandidates = [field.selector, ...(field.selectorCandidates ?? [])].filter(Boolean);
    const expectedTokens = this.expectedSelectionTokens(field, expectedValue);
    const payload = {
      fieldPath,
      groupIdentity,
      label: field.label,
      selectorCandidates,
      expectedType: field.type,
      expectedTokens
    };
    const state = (await scope
      .evaluate(
        ({
          fieldPath: rawFieldPath,
          groupIdentity: rawGroupIdentity,
          label: rawLabel,
          selectorCandidates: rawSelectors,
          expectedType
        }) => {
          const normalize = (value: string) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
          const buildIdentity = (block: HTMLElement): string => {
            const fieldPath = normalize(block.getAttribute("data-field-path") || "") || "no_field_path";
            const firstInput = block.querySelector("input[type='radio'], input[type='checkbox']") as HTMLInputElement | null;
            const groupName = normalize(firstInput?.name || "") || "no_group_name";
            const optionLabels = Array.from(block.querySelectorAll("label, button, option"))
              .map((node) => normalize(node.textContent || ""))
              .filter(Boolean)
              .sort()
              .join("|") || "no_options";
            return `group:${fieldPath}::${groupName}::${optionLabels}`;
          };
          const isVisible = (node: Element | null): node is HTMLElement => {
            if (!(node instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };

          const selectedLabelFromInput = (input: HTMLInputElement): string => {
            const fromAncestor = normalize(input.closest("label")?.textContent || "");
            if (fromAncestor) return fromAncestor;
            const inputId = normalize(input.id || "");
            if (inputId) {
              const fromFor = normalize(
                (document.querySelector(`label[for="${CSS.escape(input.id)}"]`) as HTMLElement | null)?.textContent || ""
              );
              if (fromFor) return fromFor;
            }
            const aria = normalize(input.getAttribute("aria-label") || "");
            if (aria) return aria;
            const value = normalize(input.value || "");
            if (value && value !== "on") return value;
            return "";
          };

          const selectedByButtonState = (buttons: HTMLButtonElement[]): boolean =>
            buttons.some((button) => {
              const ariaPressed = normalize(button.getAttribute("aria-pressed") || "");
              const ariaChecked = normalize(button.getAttribute("aria-checked") || "");
              const dataState = normalize(button.getAttribute("data-state") || "");
              const className = normalize(button.className || "");
              return (
                ariaPressed === "true" ||
                ariaChecked === "true" ||
                dataState === "checked" ||
                className.includes("selected") ||
                className.includes("active") ||
                className.includes("checked")
              );
            });

          const label = normalize(rawLabel).replace(/[^\w\s]/g, "");
          const fieldPath = String(rawFieldPath || "").trim();
          const selectors = Array.isArray(rawSelectors) ? rawSelectors : [];

          let block: HTMLElement | null = null;
          if (fieldPath) {
            block = document.querySelector(`[data-field-path="${CSS.escape(fieldPath)}"]`);
          }
          const expectedIdentity = normalize(String(rawGroupIdentity || ""));
          if (!block && expectedIdentity) {
            const blocks = Array.from(document.querySelectorAll("[data-field-path], fieldset, div[class*='_fieldEntry_']"));
            for (const candidate of blocks) {
              if (!(candidate instanceof HTMLElement)) continue;
              if (!isVisible(candidate)) continue;
              if (buildIdentity(candidate) === expectedIdentity) {
                block = candidate;
                break;
              }
            }
          }

          if (!block) {
            for (const selector of selectors) {
              if (!selector) continue;
              try {
                const node = document.querySelector(selector);
                if (!(node instanceof HTMLElement)) continue;
                block =
                  (node.closest("[data-field-path]") as HTMLElement | null) ??
                  (node.closest("fieldset") as HTMLElement | null) ??
                  (node.closest("div[class*='_fieldEntry_']") as HTMLElement | null) ??
                  node;
                if (block) break;
              } catch {
                continue;
              }
            }
          }

          if (!block && label) {
            const title = Array.from(document.querySelectorAll(".ashby-application-form-question-title")).find((node) => {
              if (!(node instanceof HTMLElement)) return false;
              const text = normalize(node.textContent || "").replace(/[^\w\s]/g, "");
              return text.includes(label) || label.includes(text);
            }) as HTMLElement | undefined;
            if (title) {
              block =
                (title.closest("[data-field-path]") as HTMLElement | null) ??
                (title.closest("fieldset") as HTMLElement | null) ??
                (title.closest("div[class*='_fieldEntry_']") as HTMLElement | null);
            }
          }

          if (!block || !isVisible(block)) return { kind: "text", value: "" } as AshbyControlState;

          const fileInput = block.querySelector("input[type='file']") as HTMLInputElement | null;
          if (fileInput) {
            const fileCount = fileInput.files?.length ?? 0;
            const hasFileChip = Boolean(block.querySelector("._file_1fd3o_77, [class*='_file_'], [class*='upload'][class*='success']"));
            const fileValue = normalize(fileInput.value || "");
            const hasServerAckCue = /upload(ed)?\s*(complete|successful|success)?|file uploaded|replace|remove/i.test(
              normalize(block.innerText || "")
            );
            const hasFileNameCue =
              Boolean(block.querySelector("[data-testid*='file'], [class*='filename'], [class*='fileName']")) ||
              /\.(pdf|docx?|rtf|txt)\b/i.test(fileValue) ||
              /\.(pdf|docx?|rtf|txt)\b/i.test(normalize(block.innerText || ""));
            return { kind: "file", fileCount, hasFileChip, hasFileNameCue: hasFileNameCue || hasServerAckCue } as AshbyControlState;
          }

          const yesNoButtons = Array.from(block.querySelectorAll("button")).filter((button) => {
            if (!(button instanceof HTMLButtonElement)) return false;
            const text = normalize(button.textContent || "");
            return text === "yes" || text === "no";
          }) as HTMLButtonElement[];
          const genericChoiceButtons = Array.from(block.querySelectorAll("button[aria-pressed], button[aria-checked], [role='radio'], [role='option']"))
            .filter((node) => node instanceof HTMLElement) as HTMLElement[];
          const radios = Array.from(block.querySelectorAll("input[type='radio']")) as HTMLInputElement[];
          const checkboxes = Array.from(block.querySelectorAll("input[type='checkbox']")) as HTMLInputElement[];
          if (yesNoButtons.length > 0 || expectedType === "boolean") {
            const selected = selectedByButtonState(yesNoButtons);
            const checkedCount = checkboxes.filter((item) => item.checked).length;
            const selectedLabels = [
              ...yesNoButtons
                .filter((button) => {
                  const ariaPressed = normalize(button.getAttribute("aria-pressed") || "");
                  const ariaChecked = normalize(button.getAttribute("aria-checked") || "");
                  const dataState = normalize(button.getAttribute("data-state") || "");
                  const className = normalize(button.className || "");
                  return (
                    ariaPressed === "true" ||
                    ariaChecked === "true" ||
                    dataState === "checked" ||
                    className.includes("selected") ||
                    className.includes("active") ||
                    className.includes("checked")
                  );
                })
                .map((button) => normalize(button.textContent || button.getAttribute("aria-label") || "")),
              ...radios.filter((radio) => radio.checked).map((radio) => selectedLabelFromInput(radio)),
              ...checkboxes.filter((checkbox) => checkbox.checked).map((checkbox) => selectedLabelFromInput(checkbox))
            ].filter(Boolean);
            if (radios.length > 0) {
              const radioChecked = radios.filter((radio) => radio.checked).length;
              return {
                kind: "yes_no_button",
                selected,
                checkedCount: Math.max(checkedCount, radioChecked),
                selectedLabels
              } as AshbyControlState;
            }
            return { kind: "yes_no_button", selected, checkedCount, selectedLabels } as AshbyControlState;
          }
          if (expectedType === "single_select" && (radios.length > 0 || checkboxes.length > 0 || genericChoiceButtons.length > 0)) {
            const checkedCount = [...radios, ...checkboxes].filter((item) => item.checked).length;
            const selectedButtons = genericChoiceButtons.filter((button) => {
              const ariaPressed = normalize(button.getAttribute("aria-pressed") || "");
              const ariaChecked = normalize(button.getAttribute("aria-checked") || "");
              const dataState = normalize(button.getAttribute("data-state") || "");
              const ariaSelected = normalize(button.getAttribute("aria-selected") || "");
              const className = normalize((button as HTMLElement).className || "");
              return (
                ariaPressed === "true" ||
                ariaChecked === "true" ||
                ariaSelected === "true" ||
                dataState === "checked" ||
                className.includes("selected") ||
                className.includes("active") ||
                className.includes("checked")
              );
            });
            const selectedCount = selectedButtons.length;
            const selectedLabels = [
              ...selectedButtons.map((button) => normalize(button.textContent || button.getAttribute("aria-label") || "")),
              ...radios.filter((radio) => radio.checked).map((radio) => selectedLabelFromInput(radio)),
              ...checkboxes.filter((checkbox) => checkbox.checked).map((checkbox) => selectedLabelFromInput(checkbox))
            ].filter(Boolean);
            return { kind: "choice_group", checkedCount, selectedCount, selectedLabels } as AshbyControlState;
          }
          if (expectedType === "multi_select" && checkboxes.length > 0) {
            const selectedBySignals = checkboxes.filter((checkbox) => {
              const inputChecked = checkbox.checked;
              const optionRoot = checkbox.closest("div[class*='_option_']") as HTMLElement | null;
              const visualSpan = checkbox.parentElement as HTMLElement | null;
              const labelByFor = checkbox.id
                ? (block.querySelector(`label[for="${CSS.escape(checkbox.id)}"]`) as HTMLElement | null)
                : null;
              const optionTokens = String(optionRoot?.className || "").split(/\s+/).map((item) => normalize(item)).filter(Boolean);
              const optionRootSelected = optionTokens.includes("true");
              const visualSpanSelected = String(visualSpan?.className || "").includes("_checked_1hpbx_");
              const labelSelected = String(labelByFor?.className || "").includes("_checked_1v5e2_");
              return inputChecked || optionRootSelected || visualSpanSelected || labelSelected;
            });
            const selectedLabels = selectedBySignals.map((checkbox) => selectedLabelFromInput(checkbox)).filter(Boolean);
            return {
              kind: "choice_group",
              checkedCount: selectedBySignals.length,
              selectedCount: selectedBySignals.length,
              selectedLabels
            } as AshbyControlState;
          }
          if (radios.length > 0) {
            const checkedCount = radios.filter((radio) => radio.checked).length;
            const selectedLabels = radios.filter((radio) => radio.checked).map((radio) => selectedLabelFromInput(radio));
            return { kind: "radio", checkedCount, selectedLabels } as AshbyControlState;
          }

          const combo = block.querySelector(
            "input[role='combobox'], input[aria-autocomplete='list'], input[placeholder*='Start typing']"
          ) as HTMLInputElement | null;
          if (combo) {
            const selectedCount = block.querySelectorAll("[role='listbox'] [aria-selected='true']").length;
            const selectedLabels = Array.from(block.querySelectorAll("[role='option'][aria-selected='true']"))
              .map((node) => normalize((node as HTMLElement).textContent || ""))
              .filter(Boolean);
            return { kind: "combobox", value: combo.value, selectedCount, selectedLabels } as AshbyControlState;
          }

          const select = block.querySelector("select") as HTMLSelectElement | null;
          if (select) {
            const selectedCount = Array.from(select.selectedOptions).length;
            const value = normalize(select.value);
            const placeholderLike = ["", "select", "select one", "choose", "choose one", "please select"];
            return {
              kind: "combobox",
              value: placeholderLike.includes(value) ? "" : select.value,
              selectedCount,
              selectedLabels: Array.from(select.selectedOptions)
                .map((option) => normalize(option.textContent || option.value || ""))
                .filter(Boolean)
            } as AshbyControlState;
          }

          const textarea = block.querySelector("textarea") as HTMLTextAreaElement | null;
          if (textarea) {
            return { kind: "textarea", value: textarea.value } as AshbyControlState;
          }

          const urlInput = block.querySelector("input[type='url']") as HTMLInputElement | null;
          if (urlInput) {
            return { kind: "url", value: urlInput.value } as AshbyControlState;
          }

          const emailInput = block.querySelector("input[type='email']") as HTMLInputElement | null;
          if (emailInput) {
            return { kind: "email", value: emailInput.value } as AshbyControlState;
          }

          const numberInput = block.querySelector("input[type='number']") as HTMLInputElement | null;
          if (numberInput) {
            return { kind: "number", value: numberInput.value } as AshbyControlState;
          }

          const textInput = block.querySelector("input[type='text'], input[type='tel'], input:not([type])") as HTMLInputElement | null;
          if (textInput) {
            return { kind: "text", value: textInput.value } as AshbyControlState;
          }

          return { kind: "text", value: "" } as AshbyControlState;
        },
        payload
      )
      .catch(() => ({ kind: "text", value: "" } as AshbyControlState))) as AshbyControlState;
    if (!ashbyIsAnsweredControl(state)) return false;
    if (!expectedTokens.length) return true;
    return this.doesStateMatchExpectedTokens(state, expectedTokens);
  }

  private expectedSelectionTokens(
    field: Pick<DetectedField, "type" | "label" | "options">,
    expectedValue?: string | string[] | boolean | null
  ): string[] {
    if (expectedValue === null || expectedValue === undefined) return [];
    if (field.type !== "single_select" && field.type !== "multi_select" && field.type !== "boolean" && field.type !== "text" && field.type !== "textarea") {
      return [];
    }

    const values = Array.isArray(expectedValue) ? expectedValue : [expectedValue];
    const tokens: string[] = [];
    const isDateLike = this.isDateLikePrompt(field.label);
    for (const value of values) {
      if (typeof value === "boolean") {
        const mapped = this.pickOptionForYesNo(field.options, this.normalize(field.label), value ? "yes" : "no");
        tokens.push(value ? "yes" : "no");
        tokens.push(value ? "true" : "false");
        if (mapped) tokens.push(mapped);
        continue;
      }
      const text = String(value ?? "").trim();
      if (!text) continue;
      const normalized = this.normalize(text);
      tokens.push(text);
      if (this.isDegreeSelectionPrompt(field.label)) {
        for (const alias of this.degreeSelectionAliases(text)) tokens.push(alias);
      }
      if (isDateLike) {
        const canonical = this.canonicalizeDateText(text);
        if (canonical) tokens.push(canonical);
      }
      if (["true", "yes"].includes(normalized)) {
        const mapped = this.pickOptionForYesNo(field.options, this.normalize(field.label), "yes");
        tokens.push("yes", "true");
        if (mapped) tokens.push(mapped);
      } else if (["false", "no"].includes(normalized)) {
        const mapped = this.pickOptionForYesNo(field.options, this.normalize(field.label), "no");
        tokens.push("no", "false");
        if (mapped) tokens.push(mapped);
      }
    }

    return this.mergeUnique(tokens.map((token) => this.normalize(String(token))).filter(Boolean));
  }

  private doesStateMatchExpectedTokens(state: AshbyControlState, expectedTokens: string[]): boolean {
    const rawValues = [state.value ?? "", ...(state.selectedLabels ?? [])].map((value) => String(value));
    const dateCanonical = rawValues
      .map((value) => this.canonicalizeDateText(value))
      .filter((value): value is string => Boolean(value));
    const candidates = this.mergeUnique(
      [...rawValues, ...dateCanonical].map((value) => this.normalize(String(value))).filter(Boolean)
    );
    if (!candidates.length || !expectedTokens.length) return false;
    return expectedTokens.some((expected) =>
      candidates.some((candidate) => candidate === expected || candidate.includes(expected) || expected.includes(candidate))
    );
  }

  private async resolveCanonicalFilledValue(
    scope: AshbyInteractionScope,
    field: DetectedField,
    fallbackValue: string | string[] | boolean | null
  ): Promise<string | string[] | boolean | null> {
    const fieldPath = typeof field.platformMeta?.fieldPath === "string" ? String(field.platformMeta.fieldPath) : "";
    const selectorCandidates = [field.selector, ...(field.selectorCandidates ?? [])].filter(Boolean);
    const payload = {
      fieldPath,
      selectors: selectorCandidates
    };
    const state = (await scope
      .evaluate(({ fieldPath: rawFieldPath, selectors }) => {
        const normalize = (value: string) => String(value || "").replace(/\s+/g, " ").trim();
        const selectedLabelFromInput = (input: HTMLInputElement): string => {
          const fromAncestor = normalize(input.closest("label")?.textContent || "");
          if (fromAncestor) return fromAncestor;
          if (input.id) {
            const byFor = normalize(
              (document.querySelector(`label[for="${CSS.escape(input.id)}"]`) as HTMLElement | null)?.textContent || ""
            );
            if (byFor) return byFor;
          }
          const aria = normalize(input.getAttribute("aria-label") || "");
          if (aria) return aria;
          const value = normalize(input.value || "");
          if (value && value !== "on") return value;
          return "";
        };

        let block: HTMLElement | null = null;
        const fieldPath = String(rawFieldPath || "").trim();
        if (fieldPath) {
          block = document.querySelector(`[data-field-path="${CSS.escape(fieldPath)}"]`);
        }
        if (!block) {
          for (const selector of Array.isArray(selectors) ? selectors : []) {
            if (!selector) continue;
            try {
              const node = document.querySelector(selector);
              if (!(node instanceof HTMLElement)) continue;
              block = (node.closest("[data-field-path], fieldset, div[class*='_fieldEntry_']") as HTMLElement | null) ?? node;
              if (block) break;
            } catch {
              continue;
            }
          }
        }
        if (!block) return { kind: "none" as const };

        const combo = block.querySelector(
          "input[role='combobox'], input[aria-autocomplete='list'], input[placeholder*='Start typing']"
        ) as HTMLInputElement | null;
        if (combo && normalize(combo.value)) return { kind: "text" as const, value: normalize(combo.value) };

        const select = block.querySelector("select") as HTMLSelectElement | null;
        if (select) {
          const selected = Array.from(select.selectedOptions).map((option) => normalize(option.textContent || option.value || "")).filter(Boolean);
          if (selected.length > 1) return { kind: "multi" as const, values: selected };
          if (selected.length === 1) return { kind: "text" as const, value: selected[0] };
        }

        const radios = Array.from(block.querySelectorAll("input[type='radio']")) as HTMLInputElement[];
        const checkedRadio = radios.find((radio) => radio.checked);
        if (checkedRadio) return { kind: "text" as const, value: selectedLabelFromInput(checkedRadio) };

        const checkboxes = Array.from(block.querySelectorAll("input[type='checkbox']")) as HTMLInputElement[];
        const checkedCheckboxes = checkboxes.filter((checkbox) => checkbox.checked);
        if (checkedCheckboxes.length > 1) {
          return { kind: "multi" as const, values: checkedCheckboxes.map((checkbox) => selectedLabelFromInput(checkbox)).filter(Boolean) };
        }
        if (checkedCheckboxes.length === 1) {
          const [firstChecked] = checkedCheckboxes;
          if (firstChecked) {
            return { kind: "text" as const, value: selectedLabelFromInput(firstChecked) };
          }
        }

        const selectedButtons = Array.from(
          block.querySelectorAll(
            "button[aria-pressed='true'], button[aria-checked='true'], button[aria-selected='true'], button[data-state='checked'], button[class*='selected'], button[class*='active'], button[class*='checked'], [role='radio'][aria-checked='true'], [role='option'][aria-selected='true']"
          )
        ) as HTMLElement[];
        const selectedButtonText = selectedButtons.map((button) => normalize(button.textContent || button.getAttribute("aria-label") || "")).filter(Boolean);
        if (selectedButtonText.length > 1) return { kind: "multi" as const, values: selectedButtonText };
        if (selectedButtonText.length === 1) return { kind: "text" as const, value: selectedButtonText[0] };

        const textInput = block.querySelector(
          "input[type='url'], input[type='text'], input[type='email'], input[type='tel'], input[type='number'], input:not([type])"
        ) as HTMLInputElement | null;
        if (textInput && normalize(textInput.value)) return { kind: "text" as const, value: normalize(textInput.value) };

        const textarea = block.querySelector("textarea") as HTMLTextAreaElement | null;
        if (textarea && normalize(textarea.value)) return { kind: "text" as const, value: normalize(textarea.value) };

        return { kind: "none" as const };
      }, payload)
      .catch(() => ({ kind: "none" as const }))) as
      | { kind: "none" }
      | { kind: "text"; value: string }
      | { kind: "multi"; values: string[] };

    if (state.kind === "text" && state.value) return state.value;
    if (state.kind === "multi" && state.values.length) return state.values;
    return fallbackValue;
  }

  private async isQuestionAnsweredByLabel(scope: AshbyInteractionScope, label: string): Promise<boolean> {
    const answered = (await scope
      .evaluate(({ rawLabel }) => {
        const normalize = (value: string) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
        const target = normalize(rawLabel).replace(/[^\w\s]/g, "");
        if (!target) return false;

        const titles = Array.from(document.querySelectorAll(".ashby-application-form-question-title"));
        const title = titles.find((node) => {
          if (!(node instanceof HTMLElement)) return false;
          const text = normalize(node.textContent || "").replace(/[^\w\s]/g, "");
          return text.includes(target) || target.includes(text);
        }) as HTMLElement | undefined;
        if (!title) return false;

        const block =
          (title.closest("[data-field-path]") as HTMLElement | null) ??
          (title.closest("fieldset") as HTMLElement | null) ??
          (title.closest("div[class*='_fieldEntry_']") as HTMLElement | null);
        if (!block) return false;

        const fileInput = block.querySelector("input[type='file']") as HTMLInputElement | null;
        if (fileInput) {
          const hasFileChip = Boolean(block.querySelector("._file_1fd3o_77, [class*='_file_'], [class*='upload'][class*='success']"));
          const fileValue = normalize(fileInput.value || "");
          const hasServerAckCue = /upload(ed)?\s*(complete|successful|success)?|file uploaded|replace|remove/i.test(
            normalize(block.innerText || "")
          );
          const hasFileNameCue =
            Boolean(block.querySelector("[data-testid*='file'], [class*='filename'], [class*='fileName']")) ||
            /\.(pdf|docx?|rtf|txt)\b/i.test(fileValue) ||
            /\.(pdf|docx?|rtf|txt)\b/i.test(normalize(block.innerText || ""));
          return hasFileChip || hasFileNameCue || hasServerAckCue;
        }

        const radios = Array.from(block.querySelectorAll("input[type='radio']")) as HTMLInputElement[];
        if (radios.length > 0) return radios.some((item) => item.checked);

        const checkboxes = Array.from(block.querySelectorAll("input[type='checkbox']")) as HTMLInputElement[];
        if (checkboxes.length > 0) return checkboxes.some((item) => item.checked);

        const combo = block.querySelector(
          "input[role='combobox'], input[aria-autocomplete='list'], input[placeholder*='Start typing']"
        ) as HTMLInputElement | null;
        if (combo) return normalize(combo.value).length > 0;

        const select = block.querySelector("select") as HTMLSelectElement | null;
        if (select) {
          const value = normalize(select.value);
          if (!value) return false;
          if (["select", "select one", "choose", "choose one", "please select"].includes(value)) return false;
          return true;
        }

        const textarea = block.querySelector("textarea") as HTMLTextAreaElement | null;
        if (textarea) return normalize(textarea.value).length > 0;

        const textInput = block.querySelector(
          "input[type='url'], input[type='text'], input[type='email'], input[type='tel'], input[type='number'], input:not([type])"
        ) as HTMLInputElement | null;
        if (textInput) return normalize(textInput.value).length > 0;

        return false;
      }, { rawLabel: label })
      .catch(() => false)) as boolean;
    return Boolean(answered);
  }

  private async fillByQuestionSection(
    scope: AshbyInteractionScope,
    missingLabel: string,
    profile: CandidateProfile,
    company?: string,
    jobTitle?: string,
    companyContext?: string,
    postingLocation?: string,
    preferredValue?: string | string[] | boolean | null,
    ashbyConfig?: AshbyConfig
  ): Promise<boolean> {
    const fallbackFromPolicy = this.fallbackTextForMissingLabel(
      missingLabel,
      profile,
      company,
      jobTitle,
      companyContext,
      postingLocation,
      ashbyConfig
    );
    const preferred =
      preferredValue === undefined || preferredValue === null
        ? ""
        : Array.isArray(preferredValue)
          ? String(preferredValue[0] ?? "").trim()
          : typeof preferredValue === "boolean"
            ? preferredValue
              ? "Yes"
              : "No"
            : String(preferredValue).trim();
    const fallback = preferred || fallbackFromPolicy;
    const normalizedMissingLabel = this.normalize(missingLabel);
    const isPhonePrompt = normalizedMissingLabel.includes("phone");
    const isConditionalSourceDetailPrompt =
      normalizedMissingLabel.includes("if you answered other") ||
      normalizedMissingLabel.includes("please enter your source below");
    const preferDiscreteSourceChoice =
      this.isApplicationSourcePrompt(normalizedMissingLabel) && !isConditionalSourceDetailPrompt;
    const missingLabelPattern = new RegExp(this.escapeRegex(missingLabel), "i");
    const questionTitle = scope.locator(".ashby-application-form-question-title").filter({ hasText: missingLabelPattern }).first();
    if (!(await questionTitle.isVisible().catch(() => false))) return false;

    let container = questionTitle.locator("xpath=ancestor::*[@data-field-path][1]").first();
    if (!(await container.count().catch(() => 0))) {
      container = questionTitle.locator("xpath=ancestor::fieldset[1] | ancestor::div[contains(@class,'_fieldEntry_')][1]").first();
    }
    if (!(await container.count().catch(() => 0))) return false;

    const tryClick = async (locator: import("playwright-core").Locator): Promise<boolean> => {
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) return false;
      await locator.click().catch(() => undefined);
      return true;
    };
    const hasRadioSelection = async (): Promise<boolean> => {
      const radios = container.locator("input[type='radio']");
      const total = await radios.count().catch(() => 0);
      for (let i = 0; i < total; i += 1) {
        const checked = await radios.nth(i).isChecked().catch(() => false);
        if (checked) return true;
      }
      return false;
    };
    const hasYesNoButtonSelection = async (): Promise<boolean> => {
      const buttons = container.locator("button");
      const total = await buttons.count().catch(() => 0);
      for (let i = 0; i < total; i += 1) {
        const button = buttons.nth(i);
        const text = ((await button.textContent().catch(() => "")) ?? "").trim().toLowerCase();
        if (!(text === "yes" || text === "no")) continue;
        const ariaPressed = String((await button.getAttribute("aria-pressed").catch(() => "")) ?? "").toLowerCase();
        const ariaChecked = String((await button.getAttribute("aria-checked").catch(() => "")) ?? "").toLowerCase();
        const dataState = String((await button.getAttribute("data-state").catch(() => "")) ?? "").toLowerCase();
        const className = String((await button.getAttribute("class").catch(() => "")) ?? "").toLowerCase();
        if (
          ariaPressed === "true" ||
          ariaChecked === "true" ||
          dataState === "checked" ||
          className.includes("selected") ||
          className.includes("active") ||
          className.includes("checked")
        ) {
          return true;
        }
      }
      return false;
    };
    const hasGenericChoiceSelection = async (): Promise<boolean> => {
      const selectedButtons = await container
        .locator(
          "button[aria-pressed='true'], button[aria-checked='true'], button[aria-selected='true'], button[data-state='checked'], button[class*='selected'], button[class*='active'], button[class*='checked'], [role='radio'][aria-checked='true'], [role='option'][aria-selected='true']"
        )
        .count()
        .catch(() => 0);
      if (selectedButtons > 0) return true;
      const checkedInputs = await container
        .locator("input[type='radio']:checked, input[type='checkbox']:checked")
        .count()
        .catch(() => 0);
      return checkedInputs > 0;
    };

    if (isPhonePrompt) {
      const consentNo = container.getByRole("radio", { name: /no\s*-\s*i do not consent to receiving text messages/i }).first();
      if (await tryClick(consentNo)) {
        if (await hasRadioSelection()) return true;
      }
      const anyNo = container.getByRole("radio", { name: /^no$/i }).first();
      if (await tryClick(anyNo)) {
        if (await hasRadioSelection()) return true;
      }
      const anyRadio = container.locator("input[type='radio']").first();
      if (await anyRadio.isVisible().catch(() => false)) {
        await anyRadio.check({ force: true }).catch(() => undefined);
        if (await hasRadioSelection()) return true;
      }
    }

    const fallbackLower = fallback.toLowerCase();
    const yesNoButtons = container.locator("._container_y2cw4_29 button");
    if ((await yesNoButtons.count().catch(() => 0)) > 0) {
      if (fallbackLower === "yes" || fallbackLower === "no") {
        if (await tryClick(yesNoButtons.filter({ hasText: new RegExp(`^${fallback}$`, "i") }).first())) {
          if ((await hasYesNoButtonSelection()) || (await hasRadioSelection())) return true;
        }
      }
      if (await tryClick(yesNoButtons.first())) {
        if ((await hasYesNoButtonSelection()) || (await hasRadioSelection())) return true;
      }
    }

    const genericChoiceButtons = container.locator("button, [role='radio'], [role='option']");
    if ((await genericChoiceButtons.count().catch(() => 0)) > 0) {
      if (await tryClick(genericChoiceButtons.filter({ hasText: new RegExp(this.escapeRegex(fallback), "i") }).first())) {
        if (await hasGenericChoiceSelection()) return true;
      }
      if (await tryClick(genericChoiceButtons.first())) {
        if (await hasGenericChoiceSelection()) return true;
      }
    }

    const radioLabels = container.locator("label[for*='labeled-radio-']");
    const radioLabelCount = await radioLabels.count().catch(() => 0);
    if (radioLabelCount > 0) {
      if (await tryClick(radioLabels.filter({ hasText: new RegExp(this.escapeRegex(fallback), "i") }).first())) {
        if (await hasRadioSelection()) return true;
      }

      if (fallbackLower === "yes" || fallbackLower === "no") {
        if (await tryClick(radioLabels.filter({ hasText: new RegExp(`^${fallback}$`, "i") }).first())) {
          if (await hasRadioSelection()) return true;
        }
      }

      if (await tryClick(radioLabels.first())) {
        if (await hasRadioSelection()) return true;
      }
      const radios = container.locator("input[type='radio']");
      if ((await radios.count().catch(() => 0)) > 0) {
        const pickedByText = fallbackLower === "yes" || fallbackLower === "no"
          ? radios.filter({ has: container.getByText(new RegExp(`^${fallback}$`, "i")) }).first()
          : null;
        if (pickedByText && (await pickedByText.count().catch(() => 0)) > 0) {
          await pickedByText.check({ force: true }).catch(() => undefined);
        } else {
          await radios.first().check({ force: true }).catch(() => undefined);
        }
        if (await hasRadioSelection()) return true;
      }
    }

    if (fallbackLower === "yes" || fallbackLower === "no") {
      if (await tryClick(container.getByRole("radio", { name: new RegExp(`^${fallback}$`, "i") }).first())) {
        if (await hasRadioSelection()) return true;
      }
      if (await tryClick(container.getByRole("button", { name: new RegExp(`^${fallback}$`, "i") }).first())) {
        if ((await hasYesNoButtonSelection()) || (await hasRadioSelection())) return true;
      }
      if (await tryClick(container.getByText(new RegExp(`^${fallback}$`, "i")).first())) {
        if ((await hasYesNoButtonSelection()) || (await hasRadioSelection())) return true;
      }
    }

    const checkboxLabels = container.locator("label");
    if ((await checkboxLabels.count().catch(() => 0)) > 0) {
      if (await tryClick(checkboxLabels.filter({ hasText: new RegExp(this.escapeRegex(fallback), "i") }).first())) {
        if (await hasGenericChoiceSelection()) return true;
      }
      const checkboxes = container.locator("input[type='checkbox']");
      const total = await checkboxes.count().catch(() => 0);
      for (let i = 0; i < total; i += 1) {
        const checkbox = checkboxes.nth(i);
        const aria = ((await checkbox.getAttribute("aria-label").catch(() => "")) ?? "").trim();
        const value = ((await checkbox.getAttribute("value").catch(() => "")) ?? "").trim();
        const optionText = `${aria} ${value}`.toLowerCase();
        if (!optionText.includes(fallbackLower)) continue;
        await checkbox.check({ force: true }).catch(() => undefined);
        if (await hasGenericChoiceSelection()) return true;
      }
      if (total > 0) {
        await checkboxes.first().check({ force: true }).catch(() => undefined);
        if (await hasGenericChoiceSelection()) return true;
      }
    }

    const hasDiscreteChoiceControls = preferDiscreteSourceChoice
      ? (await container
          .locator("input[type='radio'], input[type='checkbox'], select, [role='option'], [role='radio'], button")
          .count()
          .catch(() => 0)) > 0
      : false;
    const textInput = container.locator("input[type='text'], input:not([type])").first();
    if ((await textInput.isVisible().catch(() => false)) && !(preferDiscreteSourceChoice && hasDiscreteChoiceControls)) {
      const capability = await this.inferCapabilityForControl(missingLabel, textInput);
      const strictTypeahead = capability === "typeahead_text" && this.isLocationPrompt(this.normalize(missingLabel));
      const placeholder = String((await textInput.getAttribute("placeholder").catch(() => "")) ?? "");
      const candidates = capability === "date_like_text"
        ? this.buildCommitValuesForTextField({ label: missingLabel, placeholder } as Pick<DetectedField, "label" | "placeholder">, capability, fallback)
        : [fallback];
      for (const candidate of candidates) {
        const committed = await this.commitTextControl(scope, textInput, capability, candidate, { strictTypeahead });
        if (!committed) continue;
        const current = String((await textInput.inputValue().catch(() => "")) ?? "").trim();
        if (current) return true;
      }
    }

    const numberInput = container.locator("input[type='number']").first();
    if (await numberInput.isVisible().catch(() => false)) {
      await numberInput.fill(fallback.replace(/[^\d.]/g, "") || "3").catch(() => undefined);
      await numberInput.press("Tab").catch(() => undefined);
      return true;
    }

    const textArea = container.locator("textarea").first();
    if ((await textArea.isVisible().catch(() => false)) && !(preferDiscreteSourceChoice && hasDiscreteChoiceControls)) {
      const capability = await this.inferCapabilityForControl(missingLabel, textArea);
      const strictTypeahead = capability === "typeahead_text" && this.isLocationPrompt(this.normalize(missingLabel));
      const placeholder = String((await textArea.getAttribute("placeholder").catch(() => "")) ?? "");
      const candidates = capability === "date_like_text"
        ? this.buildCommitValuesForTextField({ label: missingLabel, placeholder } as Pick<DetectedField, "label" | "placeholder">, capability, fallback)
        : [fallback];
      for (const candidate of candidates) {
        const committed = await this.commitTextControl(scope, textArea, capability, candidate, { strictTypeahead });
        if (!committed) continue;
        const current = String((await textArea.inputValue().catch(() => "")) ?? "").trim();
        if (current) return true;
      }
    }

    const combo = container.getByRole("combobox").first();
    if (await combo.isVisible().catch(() => false)) {
      let comboControl = combo;
      const comboTagName = this.normalize(
        String((await combo.evaluate((node) => node.tagName).catch(() => "")) ?? "")
      );
      if (comboTagName !== "input" && comboTagName !== "textarea") {
        const nestedInput = container.locator("input[role='combobox'], input[type='text'], input:not([type])").first();
        if (await nestedInput.isVisible().catch(() => false)) {
          comboControl = nestedInput;
        }
      }
      if (normalizedMissingLabel.includes("graduation") && (await this.selectGraduationComboboxOption(scope, container, comboControl, profile))) {
        return true;
      }
      const isLocationPrompt = this.isLocationPrompt(this.normalize(missingLabel));
      const locationCandidates = isLocationPrompt
        ? this.buildLocationCandidateValues(missingLabel, profile, postingLocation).filter(Boolean)
        : [fallback];
      const capability = await this.inferCapabilityForControl(missingLabel, comboControl);
      const strictTypeahead = capability === "typeahead_text" && this.isLocationPrompt(this.normalize(missingLabel));
      for (const candidate of locationCandidates) {
        const committed = await this.commitTextControl(scope, comboControl, capability, candidate, { strictTypeahead });
        if (!committed) continue;
        const current = String((await comboControl.inputValue().catch(() => "")) ?? "").trim();
        if (current.length > 0) return true;
      }
      return false;
    }

    const select = container.locator("select").first();
    if (await select.isVisible().catch(() => false)) {
      const selected = await select.selectOption({ label: fallback }).catch(() => [] as string[]);
      if (selected.length > 0) return true;
      const first = await select.locator("option").nth(1).getAttribute("value").catch(() => null);
      if (first) {
        const fallbackSelected = await select.selectOption(first).catch(() => [] as string[]);
        return fallbackSelected.length > 0;
      }
    }

    return false;
  }

  private async reconcileRequiredAshbySections(
    context: AdapterRunContext,
    scope: AshbyInteractionScope,
    result: JobRunResult,
    pass: number,
    companyContext?: string,
    postingLocation?: string
  ): Promise<void> {
    const resolvedResumePath = this.resolvePreferredResumePath(context.profile, context.config.resumePath, context.config.ashby);
    const requiredLabels = await this.listRequiredSectionUnfilledLabels(scope);

    if (requiredLabels.length === 0) return;
    result.notes.push(`required_section_unfilled_count:${requiredLabels.length}`);

    for (const label of requiredLabels) {
      if (label.toLowerCase() === "resume" && resolvedResumePath) {
        const resumeField = await extractVisibleFields(scope).then((fields) =>
          fields.find((field) => field.type === "file" && /resume|cv/i.test(field.label))
        );
        if (resumeField) {
          const applied = await this.fillFieldWithVerification(scope, resumeField, resolvedResumePath).catch(() => false);
          if (applied) {
            result.notes.push(`fill:${pass}:${label}:required_section_resume`);
            continue;
          }
        }
      }

      const recovered = await this.fillByQuestionSection(
        scope,
        label,
        context.profile,
        result.company,
        result.jobTitle,
        companyContext,
        postingLocation,
        undefined,
        context.config.ashby
      );
      if (recovered) {
        result.notes.push(`fill:${pass}:${label}:required_section_recovery`);
      }
    }
  }

  private async listRequiredSectionUnfilledLabels(scope: AshbyInteractionScope): Promise<string[]> {
    return ((await scope
      .evaluate(() => {
        const normalize = (value: string) => String(value || "").replace(/\s+/g, " ").trim();
        const blocks = Array.from(document.querySelectorAll("[data-field-path]"));
        const unresolved: string[] = [];

        for (const block of blocks) {
          if (!(block instanceof HTMLElement)) continue;
          const title = block.querySelector(".ashby-application-form-question-title");
          const label = normalize(title?.textContent || "");
          if (!label) continue;
          const required = title?.className.includes("_required_") || Boolean(block.querySelector("[required]"));
          if (!required) continue;

          const fileInput = block.querySelector("input[type='file']") as HTMLInputElement | null;
          if (fileInput) {
            const hasFileChip = Boolean(block.querySelector("._file_1fd3o_77, [class*='_file_'], [class*='upload'][class*='success']"));
            const fileValue = normalize(fileInput.value || "");
            const hasServerAckCue = /upload(ed)?\s*(complete|successful|success)?|file uploaded|replace|remove/i.test(
              normalize(block.innerText || "")
            );
            const hasFileNameCue =
              Boolean(block.querySelector("[data-testid*='file'], [class*='filename'], [class*='fileName']")) ||
              /\.(pdf|docx?|rtf|txt)\b/i.test(fileValue) ||
              /\.(pdf|docx?|rtf|txt)\b/i.test(normalize(block.innerText || ""));
            if (!hasFileChip && !hasFileNameCue && !hasServerAckCue) unresolved.push(label);
            continue;
          }

          const radios = Array.from(block.querySelectorAll("input[type='radio']")) as HTMLInputElement[];
          if (radios.length > 0) {
            if (!radios.some((item) => item.checked)) unresolved.push(label);
            continue;
          }

          const yesNoCheckbox = block.querySelector("._container_y2cw4_29 input[type='checkbox']") as HTMLInputElement | null;
          if (yesNoCheckbox) {
            const yesNoButtons = Array.from(block.querySelectorAll("._container_y2cw4_29 button")) as HTMLButtonElement[];
            const hasSelectedButton = yesNoButtons.some((button) => {
              const ariaPressed = normalize(button.getAttribute("aria-pressed") || "");
              const ariaChecked = normalize(button.getAttribute("aria-checked") || "");
              const className = normalize(button.className || "");
              const dataState = normalize(button.getAttribute("data-state") || "");
              return (
                ariaPressed === "true" ||
                ariaChecked === "true" ||
                dataState === "checked" ||
                className.includes("selected") ||
                className.includes("active") ||
                className.includes("checked")
              );
            });
            if (!yesNoCheckbox.checked && !hasSelectedButton) unresolved.push(label);
            continue;
          }

          const combo = block.querySelector(
            "input[role='combobox'], input[aria-autocomplete='list'], input[placeholder*='Start typing']"
          ) as HTMLInputElement | null;
          if (combo) {
            if (!normalize(combo.value)) unresolved.push(label);
            continue;
          }

          const textInput = block.querySelector("input[type='text'], input[type='email'], input[type='tel'], input[type='number'], input:not([type])") as
            | HTMLInputElement
            | null;
          if (textInput) {
            if (!normalize(textInput.value)) unresolved.push(label);
            continue;
          }

          const textarea = block.querySelector("textarea") as HTMLTextAreaElement | null;
          if (textarea) {
            if (!normalize(textarea.value)) unresolved.push(label);
            continue;
          }
        }

        return Array.from(new Set(unresolved));
      })
      .catch(() => [] as string[])) as string[])
      .map((label) => normalizeWhitespace(label))
      .filter(Boolean);
  }

  private async hasVisibleApplicationFields(scope: AshbyInteractionScope): Promise<boolean> {
    return scope
      .evaluate(() => {
        const nodes = Array.from(
          document.querySelectorAll(
            "[data-field-path], .ashby-application-form-field-entry, form input, form textarea, form select, input[type='radio'], input[type='file']"
          )
        );
        return nodes.some((node) => {
          if (!(node instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        });
      })
      .catch(() => false);
  }

  private async hasVisibleApplicationFieldsInAnyFrame(page: Page): Promise<boolean> {
    const frames = page.frames().filter((frame) => frame !== page.mainFrame());
    for (const frame of frames) {
      if (await this.hasVisibleApplicationFields(frame)) return true;
    }
    return false;
  }

  private async resolveInteractionScope(page: Page): Promise<AshbyInteractionScope> {
    if (await this.hasVisibleApplicationFields(page)) return page;

    const embeddedFrameBySelector = page
      .frameLocator("#ashby_embed iframe, iframe[src*='ashbyhq.com'], iframe[src*='jobs.ashbyhq.com']")
      .first();
    const embeddedBody = embeddedFrameBySelector.locator("body").first();
    if (await embeddedBody.count().catch(() => 0)) {
      const frameHandle = await embeddedBody.elementHandle().catch(() => null);
      const ownerFrame = await frameHandle?.ownerFrame().catch(() => null);
      if (ownerFrame && (await this.hasVisibleApplicationFields(ownerFrame))) {
        return ownerFrame;
      }
    }

    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      if (!(frame.url().includes("ashbyhq.com") || frame.url().includes("jobs.ashbyhq.com"))) continue;
      if (await this.hasVisibleApplicationFields(frame)) return frame;
    }

    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      if (await this.hasVisibleApplicationFields(frame)) return frame;
    }

    return page;
  }

  private async waitForApplicationFields(page: AdapterRunContext["page"], timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.hasVisibleApplicationFields(page)) return;
      if (await this.hasVisibleApplicationFieldsInAnyFrame(page)) return;
      await page.waitForTimeout(250);
    }
  }

  private async extractAshbyJobTitle(page: AdapterRunContext["page"]): Promise<string | undefined> {
    const title = await page
      .locator("h1")
      .first()
      .innerText()
      .then((value) => normalizeWhitespace(value))
      .catch(() => "");
    return title || undefined;
  }

  private async extractAshbyPostingLocation(page: AdapterRunContext["page"]): Promise<string | undefined> {
    const value = await page
      .evaluate(() => {
        const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
        const sections = Array.from(document.querySelectorAll("section, aside, div"));
        for (const section of sections) {
          if (!(section instanceof HTMLElement)) continue;
          const text = normalize(section.innerText || "");
          if (!text || !/location/i.test(text)) continue;
          const lines = text.split("\n").map((line) => normalize(line)).filter(Boolean);
          for (let i = 0; i < lines.length; i += 1) {
            const current = lines[i];
            if (current && /^location$/i.test(current)) {
              const next = lines[i + 1];
              if (next && !/^employment type|job function|department|team/i.test(next)) {
                return next;
              }
            }
          }
        }
        return "";
      })
      .catch(() => "");
    const normalized = normalizeWhitespace(value);
    return normalized || undefined;
  }

  private async buildCompanyContextFromOverview(
    page: AdapterRunContext["page"],
    company?: string
  ): Promise<string | undefined> {
    const overviewTab = page
      .locator("#job-overview, [aria-controls='overview'], [aria-labelledby='job-overview']")
      .first();
    if (await overviewTab.isVisible().catch(() => false)) {
      await overviewTab.click().catch(() => undefined);
      await page.waitForTimeout(200);
    }

    const overviewText = await page
      .evaluate(() => {
        const normalize = (value: string) => String(value || "").replace(/\s+/g, " ").trim();
        const visible = (node: Element | null): node is HTMLElement => {
          if (!(node instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const uniquePush = (out: string[], text: string) => {
          const normalized = normalize(text);
          if (!normalized || normalized.length < 80) return;
          if (out.some((item) => item === normalized)) return;
          out.push(normalized);
        };
        const selectors = [
          "#overview",
          "[role='tabpanel'][id='overview']",
          "[aria-labelledby='job-overview']",
          "[data-testid='job-description']",
          "[class*='jobDescription']",
          "[class*='description']",
          "main article",
          "main section",
          "article section",
          "div[id='overview'] ._descriptionText_135ul_202",
          "._descriptionText_135ul_202"
        ];

        const chunks: string[] = [];
        for (const selector of selectors) {
          const nodes = Array.from(document.querySelectorAll(selector));
          for (const node of nodes) {
            if (!visible(node)) continue;
            uniquePush(chunks, node.innerText || node.textContent || "");
          }
        }

        const headingKeywords = /(about|overview|company|mission|what you'll do|responsibilit|role|team|product|platform|requirements|qualifications)/i;
        const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, strong"));
        for (const heading of headings) {
          if (!(heading instanceof HTMLElement) || !visible(heading)) continue;
          const headingText = normalize(heading.innerText || heading.textContent || "");
          if (!headingKeywords.test(headingText)) continue;
          const section =
            heading.closest("section, article, [role='region'], div[class*='section'], div[class*='content']") as HTMLElement | null;
          const block = section ?? (heading.parentElement as HTMLElement | null);
          if (!block || !visible(block)) continue;
          uniquePush(chunks, block.innerText || block.textContent || "");
        }

        const listContainers = Array.from(document.querySelectorAll("ul, ol"));
        for (const list of listContainers) {
          if (!(list instanceof HTMLElement) || !visible(list)) continue;
          const listText = normalize(list.innerText || list.textContent || "");
          const itemCount = list.querySelectorAll("li").length;
          if (itemCount < 3 || listText.length < 120) continue;
          uniquePush(chunks, listText);
        }

        if (chunks.length === 0) {
          const metaDescription =
            normalize(document.querySelector("meta[name='description']")?.getAttribute("content") || "") ||
            normalize(document.querySelector("meta[property='og:description']")?.getAttribute("content") || "");
          if (metaDescription) uniquePush(chunks, metaDescription);
        }

        if (chunks.length > 0) {
          return chunks.slice(0, 10).join("\n");
        }

        const fallback = document.body?.innerText || "";
        return normalize(fallback).slice(0, 8000);
      })
      .catch(() => "");

    if (!overviewText) return undefined;
    const fromOverview = extractCompanyDirectionContextFromText(overviewText, company);
    if (fromOverview) return fromOverview;
    if (overviewText.trim().length > 120) {
      return overviewText.replace(/\s+/g, " ").trim().slice(0, 700);
    }

    const html = await page.content().catch(() => "");
    if (!html) return undefined;
    const fromHtml = extractCompanyDirectionContextFromText(htmlToText(html), company);
    if (fromHtml) return fromHtml;
    const fallbackText = htmlToText(html).replace(/\s+/g, " ").trim();
    return fallbackText.length > 120 ? fallbackText.slice(0, 700) : undefined;
  }

  private async extractVisibleFieldsSafely(
    scope: AshbyInteractionScope,
    logger: AdapterRunContext["logger"],
    url: string,
    ashbyConfig: AshbyConfig
  ): Promise<DetectedField[]> {
    const extractionTimeoutMs = Math.max(3_000, ashbyConfig.extractFieldTimeoutMs ?? 9_000);
    const retries = Math.max(0, ashbyConfig.extractRetryCount ?? 1);

    const hybridFields = await this.detectAshbyFieldsFallback(scope).catch(() => [] as DetectedField[]);
    if (hybridFields.length > 0) {
      return hybridFields;
    }

    let lastErrorMessage = "unknown";
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.withTimeout(extractVisibleFields(scope), extractionTimeoutMs, "ashby_extract_fields_timeout");
      } catch (error) {
        lastErrorMessage = error instanceof Error ? error.message : String(error);
      }
    }

    logger.warn("ashby_extract_fields_failed", {
      url,
      error: lastErrorMessage
    });
    const fallbackFields = await this.detectAshbyFieldsFallback(scope).catch(() => [] as DetectedField[]);
    logger.info("ashby_extract_fields_fallback", {
      url,
      fieldCount: fallbackFields.length
    });
    return fallbackFields;
  }

  private async detectAshbyFieldsFallback(scope: AshbyInteractionScope): Promise<DetectedField[]> {
    const rows = (await scope.evaluate(() => {
      type Row = {
        id: string;
        label: string;
        required: boolean;
        type: "text" | "textarea" | "single_select" | "multi_select" | "boolean" | "file";
        selector: string;
        selectorCandidates: string[];
        tag: "input" | "textarea" | "select";
        options?: string[];
        placeholder?: string;
        platformMeta?: Record<string, unknown>;
      };

      const normalize = (value: string) => String(value || "").replace(/\s+/g, " ").trim();
      const dedupe = (values: string[]) => Array.from(new Set(values.map((v) => normalize(v)).filter(Boolean)));
      const safeAttr = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const visible = (el: Element | null) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const fieldBlocks = Array.from(document.querySelectorAll("[data-field-path]"));
      const out: Row[] = [];
      let idx = 0;
      const classify = (label: string, type: Row["type"], id: string): string => {
        const lower = normalize(`${label} ${id}`);
        if (/name|email|phone|resume|linkedin|github|location|portfolio|website/.test(lower)) return "system";
        if (/authorized|sponsorship|visa|relocat|veteran|disability|gender|race|ethnicity|hispanic/.test(lower)) {
          return "compliance";
        }
        if (type === "textarea") return "narrative";
        if (type === "single_select" || type === "multi_select" || type === "boolean") return "short_custom";
        if (type === "text") return "short_custom";
        return "unknown";
      };

      for (const block of fieldBlocks) {
        if (!(block instanceof HTMLElement)) continue;
        if (!visible(block)) continue;

        const fieldPath = normalize(block.getAttribute("data-field-path") || "");
        const title = block.querySelector(".ashby-application-form-question-title");
        const label = normalize(title?.textContent || block.getAttribute("data-field-path") || `field_${idx}`);
        const required = title?.className.includes("_required_") || Boolean(block.querySelector("[required]"));

        const fileInput = block.querySelector("input[type='file']") as HTMLInputElement | null;
        if (fileInput) {
          const id = normalize(fileInput.id || fileInput.name || `ashby_file_${idx}`);
          out.push({
            id,
            label,
            required,
            type: "file",
            selector: fileInput.id
              ? `input[type="file"]#${safeAttr(fileInput.id)}`
              : `input[type="file"][name="${safeAttr(fileInput.name || id)}"]`,
            selectorCandidates: dedupe([
              fileInput.id ? `#${safeAttr(fileInput.id)}` : "",
              fileInput.name ? `input[type="file"][name="${safeAttr(fileInput.name)}"]` : ""
            ]),
            tag: "input",
            platformMeta: {
              fieldPath,
              stableKey: fieldPath || id,
              classification: classify(label, "file", id),
              confidence: "high",
              inputType: "file",
              groupName: fileInput.name || undefined
            }
          });
          idx += 1;
          continue;
        }

        const directInput = block.querySelector(
          "input[type='url'], input[type='tel'], input[type='email'], input[type='text'], input[type='number'], input:not([type])"
        ) as HTMLInputElement | null;
        const directInputLabel = normalize(
          `${label} ${directInput?.name || ""} ${directInput?.id || ""} ${directInput?.placeholder || ""}`
        ).toLowerCase();
        const directInputType = String(directInput?.type || "text").toLowerCase();
        const isContactInput =
          directInputType === "tel" ||
          directInputType === "email" ||
          /\b(phone|email)\b/.test(directInputLabel);
        if (directInput && visible(directInput) && isContactInput) {
          const id = directInput.id || directInput.name || `ashby_text_${idx}`;
          const scopedInputSelector = fieldPath
            ? `[data-field-path="${safeAttr(fieldPath)}"] input[type='url'], [data-field-path="${safeAttr(fieldPath)}"] input[type='tel'], [data-field-path="${safeAttr(fieldPath)}"] input[type='email'], [data-field-path="${safeAttr(fieldPath)}"] input[type='text'], [data-field-path="${safeAttr(fieldPath)}"] input[type='number'], [data-field-path="${safeAttr(fieldPath)}"] input:not([type])`
            : "";
          out.push({
            id,
            label,
            required,
            type: "text",
            selector: directInput.id
              ? `#${safeAttr(directInput.id)}`
              : scopedInputSelector || `input[name="${safeAttr(directInput.name || id)}"]`,
            selectorCandidates: dedupe([
              scopedInputSelector,
              directInput.id ? `#${safeAttr(directInput.id)}` : "",
              directInput.name ? `input[name="${safeAttr(directInput.name)}"]` : ""
            ]),
            tag: "input",
            placeholder: directInput.placeholder || undefined,
            platformMeta: {
              fieldPath,
              stableKey: fieldPath || id,
              classification: classify(label, "text", id),
              confidence: "high",
              inputType: directInput.type || "text"
            }
          });
          idx += 1;
          continue;
        }

        const normalizeOption = (value: string) => normalize(value).toLowerCase();
        const firstNonEmpty = (...values: Array<string | undefined | null>) =>
          values.map((item) => normalize(String(item || ""))).find(Boolean) || "";
        const optionTextForInput = (input: HTMLInputElement): string => {
          const id = normalize(input.id || "");
          if (id) {
            const direct = block.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (direct) {
              const directText = normalize(direct.textContent || "");
              if (directText) return directText;
            }
          }
          const wrap = input.closest("label");
          if (wrap) {
            const wrapText = normalize(wrap.textContent || "");
            if (wrapText) return wrapText;
          }
          return firstNonEmpty(input.getAttribute("aria-label"), input.value, input.name, input.id);
        };
        const buttonChoiceOptions = dedupe(
          Array.from(block.querySelectorAll("button, [role='radio'], [role='option']"))
            .map((el) => normalize((el as HTMLElement).textContent || (el as HTMLElement).getAttribute("aria-label") || ""))
        );
        const radios = Array.from(block.querySelectorAll("input[type='radio']")) as HTMLInputElement[];
        if (radios.length > 0) {
          const first = radios[0];
          const name = first?.name || `ashby_radio_${idx}`;
          const options = dedupe([...radios.map((radio) => optionTextForInput(radio)), ...buttonChoiceOptions]);
          const groupIdentity = `group:${normalizeOption(fieldPath || "no_field_path")}::${normalizeOption(name || "no_group_name")}::${(options.map((item) => normalizeOption(item)).filter(Boolean).sort().join("|")) || "no_options"}`;
          out.push({
            id: `radio_${name}`,
            label,
            required,
            type: "single_select",
            selector: `input[type="radio"][name="${safeAttr(name)}"]`,
            selectorCandidates: dedupe([
              `input[type="radio"][name="${safeAttr(name)}"]`,
              first?.id ? `#${safeAttr(first.id)}` : ""
            ]),
            tag: "input",
            options,
            platformMeta: {
              fieldPath,
              stableKey: groupIdentity,
              classification: classify(label, "single_select", `radio_${name}`),
              confidence: "high",
              inputType: "radio",
              groupName: name,
              groupIdentity
            }
          });
          idx += 1;
          continue;
        }

        const checkboxes = Array.from(block.querySelectorAll("input[type='checkbox']")) as HTMLInputElement[];
        if (checkboxes.length > 0) {
          const first = checkboxes[0];
          const name = first?.name || `ashby_checkbox_${idx}`;
          const options = dedupe([...checkboxes.map((checkbox) => optionTextForInput(checkbox)), ...buttonChoiceOptions]);
          const normalizedLabel = normalize(label).toLowerCase();
          const hasMultiHint = /(select all|all that apply|check all|multiple|any that apply)/i.test(normalizedLabel);
          const buttonOptionCount = buttonChoiceOptions.length;
          const optionCount = options.length;
          const normalizedOptions = options.map((option) => normalizeOption(option));
          const yesNoLikeCount = normalizedOptions.filter((option) =>
            /^(yes|no|true|false)\b/.test(option) || /\bn\/a\b|not applicable|remote position/.test(option)
          ).length;
          const countryOptionCount = normalizedOptions.filter((option) =>
            /\b(united states|usa|us|canada|singapore|india|united kingdom|uk|germany|australia)\b/.test(option)
          ).length;
          const questionIntentSingleChoice =
            /\b(authorized to work|work authorization|legally authorized|sponsorship|visa|internship|full-time|part-time|how did you hear|currently based|country)\b/.test(
              normalizedLabel
            );
          const mutuallyExclusiveOptions = yesNoLikeCount >= 2 || (countryOptionCount >= 1 && yesNoLikeCount >= 1);
          const classifiedType: "boolean" | "single_select" | "multi_select" =
            hasMultiHint
              ? "multi_select"
              : checkboxes.length > 1
                ? (buttonOptionCount > 1 || questionIntentSingleChoice || mutuallyExclusiveOptions ? "single_select" : "multi_select")
                : (optionCount > 1 || buttonOptionCount > 1 ? "single_select" : "boolean");
          const checkboxNames = dedupe(checkboxes.map((checkbox) => normalize(checkbox.name || "")).filter(Boolean));
          const groupIdentity = `group:${normalizeOption(fieldPath || "no_field_path")}::${normalizeOption(name || "no_group_name")}::${(options.map((item) => normalizeOption(item)).filter(Boolean).sort().join("|")) || "no_options"}`;
          const scopedCheckboxSelector =
            fieldPath && classifiedType === "single_select"
              ? `[data-field-path="${safeAttr(fieldPath)}"] input[type="checkbox"]`
              : `input[type="checkbox"][name="${safeAttr(name)}"]`;
          out.push({
            id: `${classifiedType}_${name}`,
            label,
            required,
            type: classifiedType,
            selector: scopedCheckboxSelector,
            selectorCandidates: dedupe([
              fieldPath ? `[data-field-path="${safeAttr(fieldPath)}"] input[type="checkbox"]` : "",
              `input[type="checkbox"][name="${safeAttr(name)}"]`,
              first?.id ? `#${safeAttr(first.id)}` : ""
            ]),
            tag: "input",
            options: options.length > 0 ? options : ["Yes", "No"],
            platformMeta: {
              fieldPath,
              stableKey: groupIdentity,
              classification: classify(label, classifiedType, `${classifiedType}_${name}`),
              confidence: "high",
              inputType: classifiedType === "single_select" ? "custom_single_choice" : "checkbox",
              groupName: name,
              groupNames: checkboxNames,
              optionCount: options.length,
              groupIdentity
            }
          });
          idx += 1;
          continue;
        }

        const combo = block.querySelector(
          "input[role='combobox'], input[aria-autocomplete='list'], input[placeholder*='Start typing']"
        ) as HTMLInputElement | null;
        if (combo) {
          const id = combo.id || combo.name || `ashby_combo_${idx}`;
          const scopedComboSelector = fieldPath
            ? `[data-field-path="${safeAttr(fieldPath)}"] input[role="combobox"], [data-field-path="${safeAttr(fieldPath)}"] input[aria-autocomplete="list"], [data-field-path="${safeAttr(fieldPath)}"] input[placeholder*="Start typing"]`
            : "";
          out.push({
            id,
            label,
            required,
            type: "single_select",
            selector:
              combo.id
                ? `#${safeAttr(combo.id)}`
                : scopedComboSelector || `input[name="${safeAttr(combo.name || id)}"]`,
            selectorCandidates: dedupe([
              scopedComboSelector,
              combo.id ? `#${safeAttr(combo.id)}` : "",
              combo.name ? `input[name="${safeAttr(combo.name)}"]` : "",
              "input[role='combobox']",
              "input[aria-autocomplete='list']",
              "input[placeholder*='Start typing']"
            ]),
            tag: "input",
            placeholder: combo.placeholder || undefined,
            platformMeta: {
              fieldPath,
              stableKey: fieldPath || id,
              classification: classify(label, "single_select", id),
              confidence: "high",
              inputType: "text",
              role: "combobox"
            }
          });
          idx += 1;
          continue;
        }

        const textarea = block.querySelector("textarea") as HTMLTextAreaElement | null;
        if (textarea && visible(textarea)) {
          const id = textarea.id || textarea.name || `ashby_textarea_${idx}`;
          const scopedTextAreaSelector = fieldPath ? `[data-field-path="${safeAttr(fieldPath)}"] textarea` : "";
          out.push({
            id,
            label,
            required,
            type: "textarea",
            selector:
              textarea.id
                ? `#${safeAttr(textarea.id)}`
                : scopedTextAreaSelector || `textarea[name="${safeAttr(textarea.name || id)}"]`,
            selectorCandidates: dedupe([
              scopedTextAreaSelector,
              textarea.id ? `#${safeAttr(textarea.id)}` : "",
              textarea.name ? `textarea[name="${safeAttr(textarea.name)}"]` : ""
            ]),
            tag: "textarea",
            placeholder: textarea.placeholder || undefined,
            platformMeta: {
              fieldPath,
              stableKey: fieldPath || id,
              classification: classify(label, "textarea", id),
              confidence: "high",
              inputType: "textarea"
            }
          });
          idx += 1;
          continue;
        }

        const input = block.querySelector(
          "input[type='url'], input[type='text'], input[type='email'], input[type='tel'], input[type='number'], input:not([type])"
        ) as HTMLInputElement | null;
        if (input && visible(input)) {
          const id = input.id || input.name || `ashby_text_${idx}`;
          const scopedInputSelector = fieldPath
            ? `[data-field-path="${safeAttr(fieldPath)}"] input[type='url'], [data-field-path="${safeAttr(fieldPath)}"] input[type='text'], [data-field-path="${safeAttr(fieldPath)}"] input[type='email'], [data-field-path="${safeAttr(fieldPath)}"] input[type='tel'], [data-field-path="${safeAttr(fieldPath)}"] input[type='number'], [data-field-path="${safeAttr(fieldPath)}"] input:not([type])`
            : "";
          out.push({
            id,
            label,
            required,
            type: "text",
            selector: input.id ? `#${safeAttr(input.id)}` : scopedInputSelector || `input[name="${safeAttr(input.name || id)}"]`,
            selectorCandidates: dedupe([
              scopedInputSelector,
              input.id ? `#${safeAttr(input.id)}` : "",
              input.name ? `input[name="${safeAttr(input.name)}"]` : ""
            ]),
            tag: "input",
            placeholder: input.placeholder || undefined,
            platformMeta: {
              fieldPath,
              stableKey: fieldPath || id,
              classification: classify(label, "text", id),
              confidence: "high",
              inputType: input.type || "text"
            }
          });
          idx += 1;
        }
      }

      return out;
    })) as DetectedField[];
    const safeRows = Array.isArray(rows) ? rows : [];
    if (safeRows.length === 0) return [];

    const mergeKeyForRow = (field: DetectedField): string | null => {
      if (field.type !== "single_select") return null;
      const inputType = String(field.platformMeta?.inputType ?? "").toLowerCase();
      if (inputType !== "radio" && inputType !== "custom_single_choice") return null;
      const labelKey = this.normalize(field.label);
      if (!labelKey) return null;
      return `single_select_label:${labelKey}`;
    };

    const mergedRows: DetectedField[] = [];
    const mergedByKey = new Map<string, DetectedField>();

    for (const row of safeRows) {
      const key = mergeKeyForRow(row);
      if (!key) {
        mergedRows.push(row);
        continue;
      }

      const existing = mergedByKey.get(key);
      if (!existing) {
        const existingGroupName = String(row.platformMeta?.groupName ?? "").trim();
        row.platformMeta = {
          ...(row.platformMeta ?? {}),
          groupNames: existingGroupName ? [existingGroupName] : []
        };
        mergedByKey.set(key, row);
        mergedRows.push(row);
        continue;
      }

      const mergedOptions = this.mergeUnique([...(existing.options ?? []), ...(row.options ?? [])]);
      const mergedSelectors = this.mergeUnique([
        existing.selector,
        ...(existing.selectorCandidates ?? []),
        row.selector,
        ...(row.selectorCandidates ?? [])
      ]);
      const existingGroupNames = Array.isArray(existing.platformMeta?.groupNames)
        ? (existing.platformMeta?.groupNames as unknown[]).map((item) => String(item)).filter(Boolean)
        : [];
      const rowGroupName = String(row.platformMeta?.groupName ?? "").trim();
      const mergedGroupNames = this.mergeUnique([...existingGroupNames, ...(rowGroupName ? [rowGroupName] : [])]);
      const fieldPath =
        String(existing.platformMeta?.fieldPath ?? "").trim() || String(row.platformMeta?.fieldPath ?? "").trim();
      const primaryGroupName = String(existing.platformMeta?.groupName ?? "").trim() || rowGroupName;
      const groupIdentity = ashbyBuildGroupIdentity(fieldPath, primaryGroupName, mergedOptions);

      existing.required = existing.required || row.required;
      existing.options = mergedOptions;
      existing.selector = mergedSelectors[0] ?? existing.selector;
      existing.selectorCandidates = mergedSelectors;
      existing.platformMeta = {
        ...(existing.platformMeta ?? {}),
        fieldPath,
        groupName: primaryGroupName || undefined,
        groupNames: mergedGroupNames,
        optionCount: mergedOptions.length,
        groupIdentity,
        stableKey: groupIdentity
      };
    }

    return mergedRows;
  }

  private inferCompanyFromAshbyUrl(url: string): string | undefined {
    try {
      const parsed = new URL(url);
      const [slug] = parsed.pathname.split("/").filter(Boolean);
      if (!slug) return undefined;
      if (["jobs", "job", "apply", "careers"].includes(slug.toLowerCase())) return undefined;
      return slug
        .split(/[-_]/g)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
    } catch {
      return undefined;
    }
  }

  private isCompanyUnderstandingPrompt(label: string): boolean {
    const normalized = this.normalize(label);
    return (
      normalized.includes("from what you can find online") ||
      normalized.includes("understanding of") ||
      normalized.includes("what does") ||
      normalized.includes("what we do") ||
      normalized.includes("about us") ||
      normalized.includes("about the company") ||
      normalized.includes("why this company")
    );
  }

  private extractWordLimit(label: string): number | undefined {
    const match = label.match(/(?:no more than|up to|maximum of|max(?:imum)?)[^\d]{0,12}(\d{1,3})\s*words?/i);
    return match?.[1] ? Number(match[1]) : undefined;
  }

  private buildCompanyUnderstandingResponse(
    label: string,
    company?: string,
    jobTitle?: string,
    companyContext?: string
  ): string {
    const limit = this.extractWordLimit(label);
    const role = jobTitle || "this role";
    const companyName = company || "your company";
    const contextSnippet = companyContext ? companyContext.replace(/\s+/g, " ").trim() : "";

    const grounded = contextSnippet
      ? `${companyName} is focused on ${contextSnippet}. I’m excited about the mission and the chance to contribute in ${role} by shipping reliable, user-focused software quickly.`
      : `From the role description, I understand ${companyName} is focused on building practical software with high ownership and customer impact. I’m excited to contribute in ${role} by shipping high-quality features quickly and collaboratively.`;

    return this.enforceWordLimit(grounded, limit);
  }

  private enforceWordLimit(text: string, limit?: number): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!limit || limit <= 0) return normalized;
    const words = normalized.split(" ");
    if (words.length <= limit) return normalized;
    return `${words.slice(0, limit).join(" ").replace(/[.,;:!?-]+$/, "")}.`;
  }

  private requiredFallbackValue(field: DetectedField): string | string[] | boolean | null {
    if (!field.required) return null;
    const label = this.normalize(field.label);
    const sensitiveFallback = this.sensitivePromptFallback(field, label);
    if (sensitiveFallback !== undefined) return sensitiveFallback;

    if (field.type === "boolean") {
      if (label.includes("background check")) return true;
      if (label.includes("conviction") || label.includes("felony")) return false;
      if (
        label.includes("legal restriction") ||
        label.includes("contractual") ||
        label.includes("non-compete") ||
        label.includes("non solicitation") ||
        label.includes("confidentiality agreement")
      ) {
        return false;
      }
      if (label.includes("visa") || label.includes("work permit") || label.includes("sponsorship")) {
        return false;
      }
      return true;
    }

    if (field.type === "single_select") {
      if (this.isApplicationSourcePrompt(label) && !this.isConditionalFollowupPrompt(label)) {
        return this.pickSourceOption(field.options) ?? this.pickFirstUsableOption(field.options) ?? "Online Job Board";
      }
      if (this.isAccommodationPrompt(label)) {
        return (
          this.pickOptionByKeywords(field.options, ["do not require", "no accommodations"]) ??
          this.pickOptionForYesNo(field.options, label, "no") ??
          "No"
        );
      }
      if (label.includes("background check")) {
        return this.pickOptionForYesNo(field.options, label, "yes") ?? "Yes";
      }
      if (label.includes("conviction") || label.includes("felony")) {
        return this.pickOptionForYesNo(field.options, label, "no") ?? "No";
      }
      if (
        label.includes("legal restriction") ||
        label.includes("contractual") ||
        label.includes("non-compete") ||
        label.includes("non solicitation") ||
        label.includes("confidentiality agreement")
      ) {
        return this.pickOptionForYesNo(field.options, label, "no") ?? "No";
      }
      if (this.isVeteranPrompt(label)) {
        return this.pickVeteranSafeOption(field.options) ?? "I am not a protected veteran";
      }
      const option = this.pickFirstUsableOption(field.options);
      return option ?? "Yes";
    }

    if (field.type === "multi_select") {
      const option = this.pickFirstUsableOption(field.options);
      return option ? [option] : null;
    }

    return null;
  }

  private pickFirstUsableOption(options: string[] | undefined): string | undefined {
    if (!options?.length) return undefined;
    return options.find((item) => {
      const normalized = String(item).trim().toLowerCase();
      if (!normalized) return false;
      return !["select", "select one", "choose", "choose one", "please select", "n/a"].includes(normalized);
    });
  }

  private stringifyValue(value: unknown): string {
    if (Array.isArray(value)) return value.map(String).join(", ");
    if (typeof value === "boolean") return value ? "true" : "false";
    if (value === null || value === undefined) return "";
    return String(value);
  }

  private normalize(value: string): string {
    return value.trim().toLowerCase();
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private matchesAnyPattern(text: string, patterns: string[]): boolean {
    return ashbyMatchesAnyPattern(text, patterns);
  }

  private hasCdpConfigured(config: AdapterRunContext["config"]): boolean {
    const cdpFromConfig = config.browser?.cdpUrl?.trim() ?? "";
    const cdpFromEnv = process.env.CDP_URL?.trim() ?? "";
    return cdpFromConfig.length > 0 || cdpFromEnv.length > 0;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutErrorMessage: string): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(timeoutErrorMessage)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private resolveAiTimeoutMs(): number {
    const llmTimeout = Number.parseInt(process.env.LLM_TIMEOUT_MS ?? "", 10);
    const base = Number.isFinite(llmTimeout) && llmTimeout > 0 ? llmTimeout : 30_000;
    return Math.min(Math.max(base + 20_000, 35_000), 150_000);
  }
}
