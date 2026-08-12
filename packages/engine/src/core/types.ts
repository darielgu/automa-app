export type Platform = "greenhouse" | "lever" | "workday" | "ashby" | "workatastartup" | "generic" | "unknown";

export type RunMode = "dry-run" | "auto-submit";

export type QuestionType =
  | "text"
  | "textarea"
  | "single_select"
  | "multi_select"
  | "boolean"
  | "file"
  | "unknown";

export type AnswerValue = string | string[] | boolean | null;

export type AnswerSource = "seeded" | "rule" | "profile" | "llm" | "fallback" | "manual" | "skipped";

export interface ApplicationQuestion {
  id: string;
  label: string;
  type: QuestionType;
  required: boolean;
  options?: string[];
  placeholder?: string;
  platformMeta?: Record<string, unknown>;
}

export interface ResolvedAnswer {
  questionId: string;
  value: AnswerValue;
  source: AnswerSource;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkdayProfile {
  account?: {
    email: string;
    password: string;
  };
  identity?: {
    fullName: string;
    firstName: string;
    middleName?: string;
    lastName: string;
    suffix?: string;
    preferredName?: string;
  };
  contact?: {
    email: string;
    phone: string;
    phoneType: "Mobile" | "Home" | "Work";
    address: {
      line1: string;
      line2?: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
    };
  };
  workAuthorization?: {
    authorizedInUS: boolean;
    requiresSponsorship: boolean;
    visaStatus?: string;
    usCitizen?: boolean;
    permanentResident?: boolean;
  };
  exportControl?: {
    usPerson?: boolean;
  };
  applicationSource?: string;
  experience?: Array<{
    jobTitle: string;
    company: string;
    location: string;
    startDateMonth: string;
    startDateYear: string;
    endDateMonth?: string;
    endDateYear?: string;
    currentlyWorkHere?: boolean;
    description: string;
  }>;
  previousEmployers?: string[];
  education?: Array<{
    school: string;
    degree: string;
    fieldOfStudy: string;
    gpa?: string;
    startYear?: string;
    endYear: string;
    startMonth?: string;
    endMonth?: string;
    graduationDateMmDdYyyy?: string;
    graduationDateMmYyyy?: string;
  }>;
  skills?: string[];
  links?: {
    linkedin?: string;
    github?: string;
    portfolio?: string;
    other?: string[];
  };
  files?: {
    resumePath: string;
  };
  demographics?: {
    gender?: string;
    hispanicOrLatino?: string;
    ethnicity?: string;
    raceEthnicity?: string;
    veteranStatus?: string;
    disabilityStatus?: "yes" | "no" | "decline";
  };
  logistics?: {
    earliestStartDate?: string;
    earliest_start_date?: string;
    allowDateFallbackToday?: boolean;
    allow_date_fallback_today?: boolean;
  };
}

export interface CandidateProfile {
  workday?: WorkdayProfile;
  previousEmployers?: string[];
  basics: {
    firstName: string;
    lastName: string;
    fullName?: string;
    email: string;
    phone?: string;
    location?: string;
  };
  locationStructured?: {
    city?: string;
    region?: string;
    country?: string;
    ashbyQuery?: string;
    ashbyTarget?: string;
  };
  links?: {
    linkedin?: string;
    github?: string;
    portfolio?: string;
    website?: string;
  };
  workAuthorization?: {
    authorizedToWork?: boolean;
    requiresSponsorship?: boolean;
    usCitizen?: boolean;
    permanentResident?: boolean;
    visaStatus?: string;
    clearanceLevel?: string;
  };
  exportControl?: {
    usPerson?: boolean;
  };
  education?: {
    highestDegree?: string;
    school?: string;
    degree?: string;
    discipline?: string;
    field?: string;
    university?: string;
    startMonth?: string;
    startYear?: string;
    endMonth?: string;
    endYear?: string;
    graduationYear?: string;
    graduationDateMmDdYyyy?: string;
    graduationDateMmYyyy?: string;
    gpa?: string;
  };
  experience?: {
    years?: number;
    summary?: string;
    currentCompany?: string;
    currentTitle?: string;
  };
  applicationSource?: string;
  salary?: string;
  country?: string;
  state?: string;
  skillsSummary?: string;
  logistics?: {
    earliestStartDate?: string;
    earliest_start_date?: string;
    allowDateFallbackToday?: boolean;
    allow_date_fallback_today?: boolean;
  };
  customAnswers?: Record<string, string | boolean | string[] | number>;
}

export interface JobTarget {
  url: string;
  jobTitle?: string;
  company?: string;
}

export interface AutomationConfig {
  mode: RunMode;
  headless: boolean;
  timeoutMs: number;
  outputDir: string;
  screenshotsDir: string;
  resumePath?: string;
  coverLetterPath?: string;
  browser?: BrowserConfig;
  greenhouse?: GreenhouseConfig;
  ashby?: AshbyConfig;
  ai: AIConfig;
}

export interface BrowserConfig {
  launchMode?: "cdp" | "persistent-profile" | "ephemeral";
  cdpUrl?: string;
  channel?: string;
  userDataDir?: string;
  cdpPageTitle?: string;
  cdpPageUrlPattern?: string;
  cdpResetUrl?: string;
  reuseAnchorPage?: boolean;
  embedded?: boolean;
  windowVisibility?: "hidden" | "visible";
}

export interface StringFieldOverride {
  id: string;
  value: string;
}

export interface FileFieldOverride {
  id: string;
  path: string;
}

export interface GreenhouseConfig {
  textValues?: StringFieldOverride[];
  textareaValues?: StringFieldOverride[];
  selectValues?: StringFieldOverride[];
  fileValues?: FileFieldOverride[];
  submissionPollSeconds?: number;
  answerOptionalNarratives?: boolean;
  compensationTextFallback?: string;
  compensationNumericFallback?: string;
  allowPlaceholderRequiredText?: boolean;
}

export interface AshbyConfig {
  preSubmitGateMode?: "hard_block" | "soft_submit";
  maxReadinessAttempts?: number;
  unknownOptionProbeEnabled?: boolean;
  unknownOptionProbeChar?: string;
  unknownOptionProbeWaitMs?: number;
  unknownResolutionAttempts?: number;
  textCommitMode?: "robust";
  dateFallbackPolicy?: "today";
  unknownRequiredTextPolicy?: "llm_first_then_terminal_fallback";
  answerOptionalNarratives?: boolean;
  finalTextFallbackValue?: string;
  allowProfileSummaryFallbackForExplicitSummaryPrompts?: boolean;
  officeFallbackPolicy?: "best_match" | "none_of_above" | "block_submit";
  accommodationPolicy?: "no_and_fill_followup_na";
  accommodationFollowupDefaultText?: string;
  requireFinalizedRunForVerification?: boolean;
  relocationOpenKeywordHints?: string[];
  profileMapperEnabled?: boolean;
  pronounsDefault?: string;
  textValues?: StringFieldOverride[];
  textareaValues?: StringFieldOverride[];
  selectValues?: StringFieldOverride[];
  fileValues?: FileFieldOverride[];
  blockedQuestionPatterns?: string[];
  confirmationTextPatterns?: string[];
  successUrlPatterns?: string[];
  submissionPollSeconds?: number;
  maxFillPasses?: number;
  maxSubmitAttempts?: number;
  submitRetryDelayMs?: number;
  requiredFieldSelectors?: string[];
  challengeSelectors?: string[];
  extractFieldTimeoutMs?: number;
  extractRetryCount?: number;
  lowConfidencePolicy?: "block_submit" | "submit_with_warning";
  requiredDeterministicOnly?: boolean;
  minFieldDelayMs?: number;
  maxFieldDelayMs?: number;
  minSubmitDelayMs?: number;
  maxSubmitDelayMs?: number;
  allowResubmitRecent?: boolean;
  resubmitCooldownHours?: number;
  locationCommitRetries?: number;
  locationOneShotExtraRetry?: boolean;
}

/**
 * "automa_api" is deliberately absent. It was accepted here and never handled
 * in AnswerEngine, so choosing it silently produced the same behaviour as
 * "none" -- deterministic rules only, with the UI claiming an AI was answering.
 */
export type AIProvider = "openai" | "ollama" | "none";

export interface AIConfig {
  provider: AIProvider;
  model: string;
  openai?: {
    /** Read first. Held in the app's local settings, never on disk in plain view. */
    apiKey?: string;
    /** Fallback for terminal launches and CI. */
    apiKeyEnv: string;
    baseUrl?: string;
  };
  ollama?: {
    baseUrl: string;
  };
}

export interface AdapterRunContext {
  page: import("playwright-core").Page;
  target: JobTarget;
  profile: CandidateProfile;
  resumeText: string;
  config: AutomationConfig;
  aiEngine: import("../ai/engine.js").AnswerEngine;
  logger: import("./logger.js").AppLogger;
}

export interface ActiveAutomationPage {
  page: import("playwright-core").Page;
  context: import("playwright-core").BrowserContext;
  browserMode: "cdp" | "persistent_context" | "ephemeral";
  reveal: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Structured failure taxonomy. Ported from the standalone engine so the desktop
 * UI can explain *why* a run stopped and what the user should do next, instead
 * of surfacing a raw error string.
 */
export interface FailureReason {
  category:
    | "required_missing"
    | "validation_error"
    | "bot_challenge"
    | "session_lost"
    | "inactive_posting"
    | "unsupported_widget"
    | "submit_unavailable"
    | "auth_issue"
    | "unknown";
  code: string;
  userMessage: string;
  action: "retry" | "update_profile" | "manual_apply" | "verify_auth" | "wait_and_retry";
  evidence: string[];
}

export interface JobRunResult {
  url: string;
  platform: Platform;
  status: "applied" | "filled" | "skipped" | "failed";
  submitted: boolean;
  submissionConfirmed: boolean;
  submitOutcome?:
    | "not_submitted"
    | "confirmed"
    | "submitted"
    | "pending_confirmation"
    | "manual_assessment_required"
    | "validation_error"
    | "submit_validation_error"
    | "blocked_pre_submit_unresolved_required"
    | "blocked_bot_challenge"
    | "challenge_detected"
    | "submit_unavailable"
    | "submit_failed"
    | "session_lost"
    | "inactive_posting"
    | "sign_in_failed"
    | "email_verification_required"
    | "account_creation_failed"
    | "browser_context_closed"
    | "page_validation_error";
  dryRun: boolean;
  jobTitle?: string;
  company?: string;
  notes: string[];
  answers: ResolvedAnswer[];
  filledFields: FilledFieldRecord[];
  questionnaireResolution?: QuestionnaireResolutionRecord[];
  unresolvedQuestionnaire?: UnresolvedQuestionnaireRecord[];
  reviewReceipt?: ReviewReceiptItem[];
  submissionReceipt?: SubmissionReceipt;
  workdayRunSummary?: WorkdayRunSummary;
  screenshotPaths: string[];
  startedAt: string;
  finishedAt: string;
  error?: string;
  failureReason?: FailureReason;
  failureStage?: string;
  failureStep?: string;
  failureLabel?: string;
  failureLastAction?: string;
  readinessGatePassed?: boolean;
  requiredUnresolvedBeforeSubmit?: string[];
  requiredUnresolvedAfterRecovery?: string[];
  locationCommitVerified?: boolean;
  gateMode?: "hard_block" | "soft_submit";
  unknownFieldsSeen?: string[];
  unknownFieldsResolved?: string[];
  unknownFieldsUnresolved?: string[];
  llmEvents?: LlmEventRecord[];
}

export interface LlmEventRecord {
  ts: string;
  event:
    | "unknown_llm_request"
    | "llm_batch_start"
    | "llm_batch_result"
    | "unknown_llm_response"
    | "deterministic_answer_applied"
    | "llm_request_payload"
    | "llm_response_payload"
    | "answer_resolution"
    | "llm_answer_applied"
    | "greenhouse_free_text_generation"
    | "greenhouse_free_text_retry"
    | "greenhouse_free_text_fallback"
    | "greenhouse_compensation_answer_selected"
    | "greenhouse_text_fill_verify_result"
    | "llm_answer_empty"
    | "llm_answer_invalid_option"
    | "llm_answer_skipped_optional"
    | "llm_answer_blocked_policy";
  platform?: Platform;
  phase?: string;
  requestId?: string;
  questionCount?: number;
  unresolvedCount?: number;
  answerKeyCount?: number;
  nonNullAnswerCount?: number;
  durationMs?: number;
  timeoutMs?: number;
  fieldId?: string;
  fieldIds?: string[];
  label?: string;
  labels?: string[];
  controlTypes?: string[];
  requiredFlags?: boolean[];
  inclusionReasons?: string[];
  source?: string;
  hasValue?: boolean;
  outcomeReason?: string;
  value?: AnswerValue;
  metadata?: Record<string, unknown>;
}

export interface WorkdayRunSummary {
  tenantHost: string;
  jobUrl: string;
  stepsReached: string[];
  status: JobRunResult["status"];
  submitted: boolean;
  submissionConfirmed: boolean;
  submitOutcome?: JobRunResult["submitOutcome"];
  deterministicResolvedCount: number;
  aliasResolvedCount: number;
  llmResolvedCount: number;
  validationRecoveriesUsed: string[];
  finalSubmitEvidence: string[];
}

export interface FilledFieldRecord {
  id: string;
  label: string;
  value: string;
  /**
   * Where the value came from.
   *
   * "prefilled" means the form already held it and Automa left it alone. It is
   * separate from the rest because a receipt that says "Automa filled this"
   * about a value the page supplied is a false claim, and because counting
   * those as work done overstates how much of a form was actually completed.
   */
  source: "seeded" | "rule" | "profile" | "llm" | "fallback" | "manual" | "prefilled";
  inputKind?: string;
}

export interface ReviewReceiptItem {
  question: string;
  answer: string;
  section?: string;
}

export interface SubmissionReceiptItem {
  question: string;
  answer: string;
  section?: string;
}

export interface SubmissionReceipt {
  source: "review_receipt" | "filled_fields" | "answers";
  items: SubmissionReceiptItem[];
}

export interface QuestionnaireResolutionRecord {
  label: string;
  inputKind: "dropdown" | "radio" | "checkbox" | "text" | "textarea" | "unknown";
  options: string[];
  selected: string | null;
  source: "deterministic" | "llm" | "manual_review";
  confidence: number;
  reason?: string;
  requiresManualReview?: boolean;
  attemptedStrategies?: string[];
  applied?: boolean;
  verified?: boolean;
  failureReason?: string;
}

export interface UnresolvedQuestionnaireRecord {
  label: string;
  inputKind: "dropdown" | "radio" | "checkbox" | "text" | "textarea" | "unknown";
  options: string[];
  currentValue: string;
  attemptedStrategies: string[];
  failureReason: string;
}
