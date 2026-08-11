import fs from "node:fs";
import path from "node:path";
import { detectPlatform } from "../core/platform-detector.js";
import type { AutomationConfig, CandidateProfile, JobRunResult, Platform } from "../core/types.js";
import type { FailureReason } from "../core/types.js";
import { runAutomation } from "./orchestrator.js";
import { readJobUrls } from "../utils/fs.js";
import { buildFailureSummary, deriveFailureReason } from "../core/failure-reason.js";

export type LoopProvider = Exclude<Platform, "unknown">;

export interface ProviderLoopInput {
  provider: LoopProvider;
  config: AutomationConfig;
  profile: CandidateProfile;
  resumeText: string;
  jobsFile: string;
  maxAttempts: number;
  goalConfirmedApplications: number;
  maxRetriesPerJob: number;
  retryDelaySeconds: number;
  idleDelaySeconds: number;
  maxIdleCycles: number;
  stopAfterConsecutiveFailures: number;
  sessionOutputDir?: string;
}

export interface ProviderLoopSummary {
  provider: LoopProvider;
  reason: "goal_reached" | "max_attempts_reached" | "no_eligible_jobs" | "consecutive_failures_guard";
  attempts: number;
  confirmedApplications: number;
  successRate: number;
  statePath: string;
  reportPath: string;
}

interface ProviderJobState {
  url: string;
  attempts: number;
  failures: number;
  transientFailures?: number;
  appliedCount: number;
  confirmedCount: number;
  completed: boolean;
  exhausted: boolean;
  nextEligibleAt?: string;
  lastStatus?: JobRunResult["status"];
  lastError?: string;
  lastNotes?: string[];
  lastAttemptAt?: string;
  terminalOutcome?: JobRunResult["submitOutcome"];
}

interface LoopAttemptRecord {
  ts: string;
  url: string;
  status: JobRunResult["status"];
  submitted: boolean;
  submissionConfirmed: boolean;
  submitOutcome?: JobRunResult["submitOutcome"];
  reason: string;
  error?: string;
  failureReason?: FailureReason;
  failureSummary?: string;
}

interface ProviderLoopState {
  provider: LoopProvider;
  startedAt: string;
  updatedAt: string;
  attempts: number;
  confirmedApplications: number;
  appliedResults: number;
  failedResults: number;
  filledResults: number;
  skippedResults: number;
  pendingConfirmationResults: number;
  blockedResults: number;
  transientFailureResults: number;
  consecutiveFailures: number;
  jobs: Record<string, ProviderJobState>;
  history: LoopAttemptRecord[];
}

interface JobActivityCheck {
  active: boolean;
  reason?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function inactiveTextPresent(bodySnippet: string): boolean {
  const normalized = bodySnippet.toLowerCase();
  return [
    "job not found",
    "posting not found",
    "no longer accepting applications",
    "position has been filled",
    "this job has expired"
  ].some((token) => normalized.includes(token));
}

async function checkJobIsActive(provider: LoopProvider, url: string): Promise<JobActivityCheck> {
  const timeout = AbortSignal.timeout(12000);
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal: timeout });
  } catch (error) {
    return {
      active: true,
      reason: `activity_check_unavailable:${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (!response.ok) {
    return { active: false, reason: `http_${response.status}` };
  }

  const finalUrl = response.url.toLowerCase();
  const body = (await response.text()).slice(0, 50_000);
  const normalizedBody = body.toLowerCase();

  if (provider === "ashby") {
    if (!finalUrl.includes("jobs.ashbyhq.com")) {
      return { active: false, reason: `unexpected_redirect:${finalUrl}` };
    }
    if (inactiveTextPresent(body)) {
      return { active: false, reason: "inactive_posting_marker" };
    }
    if (!body.toLowerCase().includes("apply")) {
      return { active: false, reason: "no_apply_marker" };
    }
  } else if (provider === "greenhouse") {
    if (
      normalizedBody.includes("job not found") ||
      normalizedBody.includes("posting not found") ||
      normalizedBody.includes("this job has expired") ||
      normalizedBody.includes("no longer accepting applications")
    ) {
      return { active: false, reason: "inactive_posting_marker" };
    }
  } else if (provider === "workatastartup") {
    if (!finalUrl.includes("workatastartup.com")) {
      return { active: false, reason: `unexpected_redirect:${finalUrl}` };
    }
    if (inactiveTextPresent(body)) {
      return { active: false, reason: "inactive_posting_marker" };
    }
    if (!normalizedBody.includes("apply")) {
      return { active: false, reason: "no_apply_marker" };
    }
  } else if (inactiveTextPresent(body)) {
    return { active: false, reason: "inactive_posting_marker" };
  }

  return { active: true };
}

export function isTelemetryNote(note: string): boolean {
  return /^[a-z]+_stage:/i.test(note.trim());
}

export function parseReason(result: JobRunResult): string {
  if (result.failureReason?.code) return result.failureReason.code;
  if (result.error) return result.error.split("\n")[0]?.trim() || "error";

  const nonTelemetryNote = result.notes.find((note) => !isTelemetryNote(note));
  if (nonTelemetryNote) return nonTelemetryNote;

  if (result.submitOutcome) return result.submitOutcome;

  const fallbackNote = result.notes[0];
  if (fallbackNote) return fallbackNote;

  return result.status;
}

function computeRetryDelaySeconds(base: number, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(60 * 60, base * 2 ** exponent);
}

export function isTransientInfrastructureFailure(result: JobRunResult): boolean {
  if (result.submitOutcome === "session_lost") return true;
  const reason = parseReason(result).toLowerCase();
  return (
    reason.includes("target page, context or browser has been closed") ||
    reason.includes("browser has been closed") ||
    reason.includes("context has been closed") ||
    reason.includes("session_lost")
  );
}

function isSuccess(result: JobRunResult): boolean {
  return result.status === "applied" && result.submissionConfirmed;
}

function buildInitialState(provider: LoopProvider): ProviderLoopState {
  const now = nowIso();
  return {
    provider,
    startedAt: now,
    updatedAt: now,
    attempts: 0,
    confirmedApplications: 0,
    appliedResults: 0,
    failedResults: 0,
    filledResults: 0,
    skippedResults: 0,
    pendingConfirmationResults: 0,
    blockedResults: 0,
    transientFailureResults: 0,
    consecutiveFailures: 0,
    jobs: {},
    history: []
  };
}

function readState(statePath: string, provider: LoopProvider): ProviderLoopState {
  if (!fs.existsSync(statePath)) return buildInitialState(provider);
  const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as ProviderLoopState;
  if (parsed.provider !== provider) {
    throw new Error(`State provider mismatch for ${statePath}. Expected "${provider}", found "${parsed.provider}".`);
  }
  parsed.pendingConfirmationResults = parsed.pendingConfirmationResults ?? 0;
  parsed.blockedResults = parsed.blockedResults ?? 0;
  parsed.transientFailureResults = parsed.transientFailureResults ?? 0;
  return parsed;
}

function writeState(statePath: string, state: ProviderLoopState): void {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function writeReport(reportPath: string, state: ProviderLoopState, totalProviderJobs: number): void {
  const reasonCounts = new Map<string, number>();
  for (const item of state.history) {
    reasonCounts.set(item.reason, (reasonCounts.get(item.reason) ?? 0) + 1);
  }

  const topReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const jobs = Object.values(state.jobs);
  const completedJobs = jobs.filter((job) => job.completed).length;
  const exhaustedJobs = jobs.filter((job) => job.exhausted).length;
  const attempts = Math.max(1, state.attempts);
  const successRate = (state.confirmedApplications / attempts) * 100;

  const lines = [
    `# Provider Validation Session (${state.provider})`,
    "",
    `Updated: ${state.updatedAt}`,
    `Started: ${state.startedAt}`,
    "",
    "## Scoreboard",
    `- Provider jobs discovered: ${totalProviderJobs}`,
    `- Total attempts: ${state.attempts}`,
    `- Confirmed applications: ${state.confirmedApplications}`,
    `- Success rate: ${successRate.toFixed(2)}%`,
    `- Applied results: ${state.appliedResults}`,
    `- Failed results: ${state.failedResults}`,
    `- Filled results: ${state.filledResults}`,
    `- Skipped results: ${state.skippedResults}`,
    `- Pending confirmations: ${state.pendingConfirmationResults}`,
    `- Bot/captcha blocked: ${state.blockedResults}`,
    `- Transient infra failures: ${state.transientFailureResults}`,
    `- Completed jobs: ${completedJobs}`,
    `- Exhausted jobs: ${exhaustedJobs}`,
    `- Consecutive failures: ${state.consecutiveFailures}`,
    "",
    "## Top Failure/Blocker Reasons"
  ];

  if (topReasons.length === 0) {
    lines.push("- none");
  } else {
    for (const [reason, count] of topReasons) {
      lines.push(`- ${count}x ${reason}`);
    }
  }

  lines.push("");
  lines.push("## Recent Attempts");

  const recent = state.history.slice(-15).reverse();
  if (recent.length === 0) {
    lines.push("- none");
  } else {
    for (const item of recent) {
      lines.push(
        `- ${item.ts} | ${item.status} | outcome=${item.submitOutcome ?? "n/a"} | confirmed=${item.submissionConfirmed ? "yes" : "no"} | ${item.url} | ${item.reason}${item.failureSummary ? ` | ${item.failureSummary}` : ""}`
      );
    }
  }

  fs.writeFileSync(reportPath, `${lines.join("\n")}\n`, "utf8");
}

function upsertJobs(state: ProviderLoopState, providerUrls: string[]): void {
  for (const url of providerUrls) {
    if (state.jobs[url]) continue;
    state.jobs[url] = {
      url,
      attempts: 0,
      failures: 0,
      appliedCount: 0,
      confirmedCount: 0,
      completed: false,
      exhausted: false
    };
  }
}

function pickNextUrl(state: ProviderLoopState, providerUrls: string[]): string | undefined {
  const now = Date.now();
  const jobEntries = providerUrls
    .map((url) => state.jobs[url])
    .filter((job): job is ProviderJobState => Boolean(job))
    .filter((job) => !job.completed && !job.exhausted);

  const unseen = jobEntries
    .filter((job) => job.attempts === 0)
    .sort((a, b) => a.url.localeCompare(b.url));
  if (unseen.length > 0) return unseen[0]?.url;

  const retriable = jobEntries
    .filter((job) => !job.nextEligibleAt || new Date(job.nextEligibleAt).getTime() <= now)
    .sort((a, b) => a.attempts - b.attempts);

  return retriable[0]?.url;
}

function recordResult(
  state: ProviderLoopState,
  job: ProviderJobState,
  result: JobRunResult,
  maxRetriesPerJob: number,
  retryDelaySeconds: number
): void {
  const at = nowIso();
  const reason = parseReason(result);
  const failureReason = result.failureReason ?? deriveFailureReason(result);
  if (!result.failureReason && failureReason) result.failureReason = failureReason;
  const failureSummary = buildFailureSummary(failureReason);
  const success = isSuccess(result);
  const pendingConfirmation = result.submitOutcome === "pending_confirmation";
  const blockedByBot = result.submitOutcome === "blocked_bot_challenge" || result.submitOutcome === "challenge_detected";
  const transientFailure = isTransientInfrastructureFailure(result);

  state.attempts += 1;
  if (result.status === "applied") state.appliedResults += 1;
  if (result.status === "failed") state.failedResults += 1;
  if (result.status === "filled") state.filledResults += 1;
  if (result.status === "skipped") state.skippedResults += 1;
  if (pendingConfirmation) state.pendingConfirmationResults += 1;
  if (blockedByBot) state.blockedResults += 1;
  if (transientFailure) state.transientFailureResults += 1;

  job.attempts += 1;
  job.lastAttemptAt = at;
  job.lastStatus = result.status;
  job.lastError = result.error;
  job.lastNotes = result.notes;
  job.terminalOutcome = result.submitOutcome;

  if (result.status === "applied") job.appliedCount += 1;
  if (success) {
    job.confirmedCount += 1;
    job.completed = true;
    job.nextEligibleAt = undefined;
    state.confirmedApplications += 1;
    state.consecutiveFailures = 0;
  } else if (pendingConfirmation) {
    job.completed = true;
    job.exhausted = true;
    job.nextEligibleAt = undefined;
    state.consecutiveFailures = 0;
  } else if (blockedByBot) {
    job.completed = true;
    job.exhausted = true;
    job.nextEligibleAt = undefined;
    job.failures += 1;
    state.consecutiveFailures += 1;
  } else if (transientFailure) {
    job.transientFailures = (job.transientFailures ?? 0) + 1;
    job.exhausted = false;
    // Session/browser losses are retriable and should not immediately trip failure guardrails.
    state.consecutiveFailures = 0;
    const transientDelaySeconds = Math.max(10, Math.min(90, Math.floor(retryDelaySeconds / 2)));
    job.nextEligibleAt = new Date(Date.now() + transientDelaySeconds * 1000).toISOString();
  } else {
    job.failures += 1;
    state.consecutiveFailures += 1;

    if (job.attempts > maxRetriesPerJob) {
      job.exhausted = true;
      job.nextEligibleAt = undefined;
    } else {
      const delaySeconds = computeRetryDelaySeconds(retryDelaySeconds, job.attempts);
      job.nextEligibleAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    }
  }

  state.updatedAt = at;
  state.history.push({
    ts: at,
    url: result.url,
    status: result.status,
    submitted: result.submitted,
    submissionConfirmed: result.submissionConfirmed,
    submitOutcome: result.submitOutcome,
    reason,
    error: result.error,
    failureReason,
    failureSummary
  });
  if (state.history.length > 1000) {
    state.history = state.history.slice(-1000);
  }
}

function resolveCdpProbeUrl(cdpUrl: string): string {
  const parsed = new URL(cdpUrl);
  if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    parsed.pathname = "/json/version";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  }

  parsed.pathname = "/json/version";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function assertGreenhouseAutoSubmitCdp(config: AutomationConfig): Promise<void> {
  if (config.mode !== "auto-submit") return;
  const cdpUrl = config.browser?.cdpUrl?.trim() || process.env.CDP_URL?.trim();
  if (!cdpUrl) {
    throw new Error(
      "Greenhouse provider loop in auto-submit mode requires CDP. Set browser.cdpUrl in config or CDP_URL in env."
    );
  }

  let probeUrl: string;
  try {
    probeUrl = resolveCdpProbeUrl(cdpUrl);
  } catch {
    throw new Error(`Invalid CDP_URL "${cdpUrl}".`);
  }

  let response: Response;
  try {
    response = await fetch(probeUrl, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    throw new Error(
      `CDP endpoint is unreachable (${probeUrl}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    throw new Error(`CDP endpoint probe failed (${probeUrl}) with HTTP ${response.status}.`);
  }
}

export async function runProviderLoop(input: ProviderLoopInput): Promise<ProviderLoopSummary> {
  const providerOutputDir = input.sessionOutputDir
    ? path.resolve(input.sessionOutputDir)
    : path.resolve(input.config.outputDir, "sessions", input.provider);

  fs.mkdirSync(providerOutputDir, { recursive: true });

  const statePath = path.join(providerOutputDir, "provider-loop-state.json");
  const reportPath = path.join(providerOutputDir, "provider-loop-report.md");
  const config: AutomationConfig = {
    ...input.config,
    outputDir: providerOutputDir,
    screenshotsDir: path.join(providerOutputDir, "screenshots")
  };

  if (input.provider === "greenhouse") {
    await assertGreenhouseAutoSubmitCdp(config);
  }

  let state = readState(statePath, input.provider);
  let idleCycles = 0;

  while (true) {
    const allUrls = readJobUrls(undefined, input.jobsFile);
    const providerUrls = allUrls.filter((url) => detectPlatform(url) === input.provider);
    upsertJobs(state, providerUrls);

    const nextUrl = pickNextUrl(state, providerUrls);
    if (!nextUrl) {
      idleCycles += 1;
      state.updatedAt = nowIso();
      writeState(statePath, state);
      writeReport(reportPath, state, providerUrls.length);

      if (idleCycles >= input.maxIdleCycles) {
        return {
          provider: input.provider,
          reason: "no_eligible_jobs",
          attempts: state.attempts,
          confirmedApplications: state.confirmedApplications,
          successRate: state.attempts ? state.confirmedApplications / state.attempts : 0,
          statePath,
          reportPath
        };
      }

      await sleep(input.idleDelaySeconds * 1000);
      continue;
    }

    idleCycles = 0;

    const activeCheck = await checkJobIsActive(input.provider, nextUrl);
    if (!activeCheck.active) {
      const at = nowIso();
      const job = state.jobs[nextUrl];
      if (!job) {
        throw new Error(`Missing job state for URL: ${nextUrl}`);
      }

      state.attempts += 1;
      state.skippedResults += 1;
      state.consecutiveFailures += 1;
      state.updatedAt = at;

      job.attempts += 1;
      job.failures += 1;
      job.exhausted = true;
      job.completed = false;
      job.lastAttemptAt = at;
      job.lastStatus = "skipped";
      job.lastError = activeCheck.reason;
      job.lastNotes = [`inactive_job_url:${activeCheck.reason ?? "unknown"}`];
      job.terminalOutcome = "inactive_posting";
      job.nextEligibleAt = undefined;

      state.history.push({
        ts: at,
        url: nextUrl,
        status: "skipped",
        submitted: false,
        submissionConfirmed: false,
        submitOutcome: "inactive_posting",
        reason: `inactive_job_url:${activeCheck.reason ?? "unknown"}`,
        error: activeCheck.reason
      });
      if (state.history.length > 1000) {
        state.history = state.history.slice(-1000);
      }

      writeState(statePath, state);
      writeReport(reportPath, state, providerUrls.length);

      if (state.consecutiveFailures >= input.stopAfterConsecutiveFailures) {
        return {
          provider: input.provider,
          reason: "consecutive_failures_guard",
          attempts: state.attempts,
          confirmedApplications: state.confirmedApplications,
          successRate: state.attempts ? state.confirmedApplications / state.attempts : 0,
          statePath,
          reportPath
        };
      }
      continue;
    }

    const runOutput = await runAutomation({
      config,
      profile: input.profile,
      resumeText: input.resumeText,
      targets: [{ url: nextUrl }]
    });

    const result = runOutput.results[0];
    if (!result) {
      throw new Error(`Missing run result for provider loop URL: ${nextUrl}`);
    }

    const job = state.jobs[nextUrl];
    if (!job) {
      throw new Error(`Missing job state for URL: ${nextUrl}`);
    }

    recordResult(state, job, result, input.maxRetriesPerJob, input.retryDelaySeconds);
    writeState(statePath, state);
    writeReport(reportPath, state, providerUrls.length);

    if (state.confirmedApplications >= input.goalConfirmedApplications) {
      return {
        provider: input.provider,
        reason: "goal_reached",
        attempts: state.attempts,
        confirmedApplications: state.confirmedApplications,
        successRate: state.attempts ? state.confirmedApplications / state.attempts : 0,
        statePath,
        reportPath
      };
    }

    if (state.attempts >= input.maxAttempts) {
      return {
        provider: input.provider,
        reason: "max_attempts_reached",
        attempts: state.attempts,
        confirmedApplications: state.confirmedApplications,
        successRate: state.attempts ? state.confirmedApplications / state.attempts : 0,
        statePath,
        reportPath
      };
    }

    if (state.consecutiveFailures >= input.stopAfterConsecutiveFailures) {
      return {
        provider: input.provider,
        reason: "consecutive_failures_guard",
        attempts: state.attempts,
        confirmedApplications: state.confirmedApplications,
        successRate: state.attempts ? state.confirmedApplications / state.attempts : 0,
        statePath,
        reportPath
      };
    }
  }
}
