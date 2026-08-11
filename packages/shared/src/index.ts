export type AuthProvider = "google" | "password";
export type Platform = "greenhouse" | "lever" | "workday" | "ashby" | "workatastartup" | "generic" | "unknown";

export interface UserIdentity {
  id: string;
  email: string;
  fullName: string;
  onboardingCompleted: boolean;
  isAdmin?: boolean;
  linkedProviders: AuthProvider[];
  createdAt: string;
}

export interface AuthSession {
  user: UserIdentity;
  token: string;
  expiresAt: string;
}

export interface JobPreferenceInput {
  desiredRoles: string[];
  desiredLocations: string[];
  employmentTypes: string[];
  remoteOnly: boolean;
}

export interface CandidateBasicsInput {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  location: string;
}

export interface CandidateLinksInput {
  linkedin?: string;
  github?: string;
  portfolio?: string;
  website?: string;
}

export interface CandidateWorkAuthorizationInput {
  authorizedToWork: boolean;
  requiresSponsorship: boolean;
  usCitizen?: boolean;
  permanentResident?: boolean;
  visaStatus?: string;
  clearanceLevel?: string;
}

export interface CandidateEducationInput {
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
  gpa?: string;
}

export interface CandidateExperienceInput {
  years?: number;
  summary?: string;
  currentCompany?: string;
  currentTitle?: string;
}

export interface CandidateLocationStructuredInput {
  city?: string;
  region?: string;
  country?: string;
  ashbyQuery?: string;
  ashbyTarget?: string;
}

export interface CandidateExportControlInput {
  usPerson?: boolean;
}

export interface CandidateLogisticsInput {
  earliestStartDate?: string;
  earliest_start_date?: string;
  allowDateFallbackToday?: boolean;
  allow_date_fallback_today?: boolean;
}

export type CandidateCustomAnswerValue = string | boolean | string[] | number;

export interface WorkdayAccountInput {
  email: string;
  password: string;
}

export interface WorkdayIdentityInput {
  fullName: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  suffix?: string;
  preferredName?: string;
}

export interface WorkdayAddressInput {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface WorkdayContactInput {
  email: string;
  phone: string;
  phoneType: "Mobile" | "Home" | "Work";
  address: WorkdayAddressInput;
}

export interface WorkdayWorkAuthorizationInput {
  authorizedInUS: boolean;
  requiresSponsorship: boolean;
  visaStatus?: string;
  usCitizen?: boolean;
  permanentResident?: boolean;
}

export interface WorkdayExperienceItemInput {
  jobTitle: string;
  company: string;
  location: string;
  startDateMonth: string;
  startDateYear: string;
  endDateMonth?: string;
  endDateYear?: string;
  currentlyWorkHere?: boolean;
  description: string;
}

export interface WorkdayEducationItemInput {
  school: string;
  degree: string;
  fieldOfStudy: string;
  gpa?: string;
  startYear?: string;
  endYear: string;
  startMonth?: string;
  endMonth?: string;
}

export interface WorkdayLinksInput {
  linkedin?: string;
  github?: string;
  portfolio?: string;
  other?: string[];
}

export interface WorkdayFilesInput {
  resumePath: string;
}

export interface WorkdayDemographicsInput {
  gender?: string;
  hispanicOrLatino?: string;
  ethnicity?: string;
  raceEthnicity?: string;
  veteranStatus?: string;
  disabilityStatus?: "yes" | "no" | "decline";
}

export interface WorkdayProfileInput {
  account?: WorkdayAccountInput;
  identity?: WorkdayIdentityInput;
  contact?: WorkdayContactInput;
  workAuthorization?: WorkdayWorkAuthorizationInput;
  exportControl?: CandidateExportControlInput;
  applicationSource?: string;
  experience?: WorkdayExperienceItemInput[];
  previousEmployers?: string[];
  education?: WorkdayEducationItemInput[];
  skills?: string[];
  links?: WorkdayLinksInput;
  files?: WorkdayFilesInput;
  demographics?: WorkdayDemographicsInput;
  logistics?: CandidateLogisticsInput;
}

export interface UserProfileInput {
  workday?: WorkdayProfileInput;
  previousEmployers?: string[];
  basics: CandidateBasicsInput;
  locationStructured?: CandidateLocationStructuredInput;
  links: CandidateLinksInput;
  workAuthorization: CandidateWorkAuthorizationInput;
  exportControl?: CandidateExportControlInput;
  education: CandidateEducationInput;
  experience: CandidateExperienceInput;
  applicationSource?: string;
  salary?: string;
  country?: string;
  state?: string;
  skillsSummary?: string;
  logistics?: CandidateLogisticsInput;
  customAnswers?: Record<string, CandidateCustomAnswerValue>;
  preferences: JobPreferenceInput;
}

export interface UserProfileRecord extends UserProfileInput {
  userId: string;
  resumeAssetId?: string | null;
  updatedAt: string;
}

export interface ResumeAsset {
  id: string;
  userId: string;
  fileName: string;
  storagePath: string;
  mimeType: string;
  createdAt: string;
}

export type DesktopAIProvider = "openai" | "automa_api" | "ollama" | "none";
export type WorkerVisibility = "hidden" | "visible";
export type WorkerSeedStatus = "ready" | "authorizing";
export type RunAuthState = "ready" | "missing_seed" | "blocked_auth";

export interface DesktopAutomationConfig {
  apiBaseUrl: string;
  mode: "dry-run" | "auto-submit";
  headless: boolean;
  timeoutMs: number;
  outputDir: string;
  screenshotsDir: string;
  automationDebugPort: number;
  automationPartition: string;
  aiProvider: DesktopAIProvider;
  openaiModel: string;
  openaiApiKeyEnv: string;
  ollamaBaseUrl: string;
  maxParallelRuns: number;
  workerVisibility: WorkerVisibility;
}

export interface DesktopResumeRecord {
  fileName: string;
  filePath: string;
  mimeType: string;
  selectedAt: string;
  extractedText?: string;
}

export interface ResumeParseDraft {
  profile: UserProfileInput;
  extractedText: string;
  warnings: string[];
}

export interface WorkerSeedRecord {
  seedKey: string;
  provider: Platform;
  host: string;
  sourceUrl: string;
  profileDir: string;
  label: string;
  status: WorkerSeedStatus;
  updatedAt: string;
  lastUsedAt?: string;
}

export type JobFeedReason = "role_match" | "location_match" | "admin_priority" | "manual_assignment";

export interface JobFeedItem {
  id: string;
  sourceUrl: string;
  title: string;
  company: string;
  location: string;
  source: string;
  postedAt?: string;
  summary?: string;
  compensation?: string;
  roleTags: string[];
  feedReason: JobFeedReason;
  queued?: boolean;
  feedback?: JobFeedbackVerdict | null;
}

export type JobFeedbackVerdict = "up" | "down";

export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked_auth"
  | "paused_app_unavailable"
  | "paused_interrupted"
  | "unknown_needs_review";
export type RunPhase = "preparing" | "launching_browser" | "filling" | "submitting" | "finalizing";

export interface RunFailureDetail {
  reason: string;
  notes: string[];
  error?: string;
}

export interface RunResolvedAnswer {
  questionId: string;
  value: string | string[] | boolean | null;
  source: string;
  reason?: string;
}

export interface RunFilledFieldRecord {
  id: string;
  label: string;
  value: string;
  source: string;
  inputKind?: string;
}

export interface RunSubmissionReceiptItem {
  question: string;
  answer: string;
  section?: string;
}

export interface RunSubmissionReceipt {
  source: "review_receipt" | "filled_fields" | "answers";
  items: RunSubmissionReceiptItem[];
}

export interface RunWorkdaySummary {
  tenantHost: string;
  jobUrl: string;
  stepsReached: string[];
  status: "applied" | "filled" | "skipped" | "failed";
  submitted: boolean;
  submissionConfirmed: boolean;
  submitOutcome?: string;
  deterministicResolvedCount: number;
  aliasResolvedCount: number;
  llmResolvedCount: number;
  validationRecoveriesUsed: string[];
  finalSubmitEvidence: string[];
}

export interface RunOutcome {
  id: string;
  jobId: string;
  status: RunStatus;
  phase: RunPhase;
  submitted: boolean;
  submissionConfirmed: boolean;
  submitOutcome?: string;
  sourceUrl?: string;
  jobTitle?: string;
  company?: string;
  location?: string;
  source?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  failureDetail?: RunFailureDetail;
  notes?: string[];
  answers?: RunResolvedAnswer[];
  filledFields?: RunFilledFieldRecord[];
  submissionReceipt?: RunSubmissionReceipt;
  screenshotPaths?: string[];
  workdayRunSummary?: RunWorkdaySummary;
  provider?: Platform;
  workerId?: string;
  authState?: RunAuthState;
  seedKey?: string;
  profileCloneDir?: string;
  browserVisible?: boolean;
}

export interface AppliedJobRecord {
  id: string;
  userId: string;
  jobId: string;
  runId: string;
  sourceUrl: string;
  title: string;
  company: string;
  location: string;
  source: string;
  postedAt?: string;
  summary?: string;
  compensation?: string;
  roleTags: string[];
  trackerStage: ApplicationTrackerStage;
  trackerOrder: number;
  status: RunStatus;
  submitted: boolean;
  submissionConfirmed: boolean;
  submitOutcome?: string;
  appliedAt: string;
  createdAt: string;
  updatedAt: string;
}

export type ApplicationTrackerStage = "applied" | "interview" | "offer" | "rejected";

export interface ApplicationContactTarget {
  id: string;
  name: string;
  title?: string;
  channel?: string;
  profileUrl?: string;
  note?: string;
}

export interface ApplicationMessageDraft {
  id: string;
  title: string;
  body: string;
  channel?: string;
}

export interface ApplicationTimelineEntry {
  id: string;
  title: string;
  detail?: string;
  occurredAt: string;
  kind: "applied" | "run_started" | "run_finished" | "submission_confirmed" | "stage_changed";
}

export interface AppliedJobDetailRecord {
  appliedJob: AppliedJobRecord;
  insightsSummary?: string;
  contactTargets: ApplicationContactTarget[];
  messageDrafts: ApplicationMessageDraft[];
  timeline: ApplicationTimelineEntry[];
  run?: {
    id: string;
    status: RunStatus;
    submitted: boolean;
    submissionConfirmed: boolean;
    submitOutcome?: string;
    startedAt?: string;
    finishedAt?: string;
    createdAt?: string;
  };
}

export interface RunCompletionEvent {
  runId: string;
  jobId: string;
  jobTitle?: string;
  company?: string;
  status: RunStatus;
  submitted: boolean;
  submissionConfirmed: boolean;
  submitOutcome?: string;
  applied: boolean;
  message: string;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  fullName: string;
  onboardingCompleted: boolean;
  isAdmin: boolean;
  createdAt: string;
}

export interface AdminJobImportResult {
  imported: number;
  skipped: number;
  batchId: string;
}
