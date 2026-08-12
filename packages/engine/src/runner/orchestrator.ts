import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { buildAdapters } from "../adapters/index.js";
import { AnswerEngine } from "../ai/engine.js";
import { AppLogger } from "../core/logger.js";
import { detectPlatform } from "../core/platform-detector.js";
import { withDerivedSubmissionReceipt, writeResults } from "../core/results.js";
import type { ActiveAutomationPage, AutomationConfig, CandidateProfile, JobRunResult, JobTarget } from "../core/types.js";

export interface RunInput {
  config: AutomationConfig;
  profile: CandidateProfile;
  resumeText: string;
  targets: JobTarget[];
  hooks?: {
    onActivePage?: (page: ActiveAutomationPage) => void;
  };
}

export interface RunOutput {
  resultsPath: string;
  results: JobRunResult[];
}

function readPreviousResults(outputDir: string): JobRunResult[] {
  const resultsPath = path.resolve(outputDir, "results.json");
  if (!fs.existsSync(resultsPath)) return [];
  try {
    const raw = fs.readFileSync(resultsPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is JobRunResult => typeof item?.url === "string");
  } catch {
    return [];
  }
}

function shouldSkipRecentAshbyReplay(
  targetUrl: string,
  platform: string,
  config: AutomationConfig,
  previousResults: JobRunResult[]
): JobRunResult | null {
  if (platform !== "ashby") return null;
  if (config.mode !== "auto-submit") return null;
  const ashbyConfig = config.ashby ?? {};
  if (ashbyConfig.allowResubmitRecent) return null;
  const requireFinalized = ashbyConfig.requireFinalizedRunForVerification ?? true;

  const cooldownHours = Math.max(1, ashbyConfig.resubmitCooldownHours ?? 48);
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  const now = Date.now();
  const normalizedTarget = targetUrl.trim().toLowerCase();
  const prior = previousResults
    .filter((entry) => entry.platform === "ashby")
    .filter((entry) => !requireFinalized || entry.notes.includes("run_finalized:apply_finalized"))
    .filter((entry) => String(entry.url || "").trim().toLowerCase() === normalizedTarget)
    .sort((a, b) => new Date(b.finishedAt).getTime() - new Date(a.finishedAt).getTime())[0];
  if (!prior) return null;
  if (!prior.submitted && !prior.submissionConfirmed) return null;

  const priorTs = new Date(prior.finishedAt).getTime();
  if (!Number.isFinite(priorTs)) return null;
  if (now - priorTs > cooldownMs) return null;

  return prior;
}

function hasSecurityCodeMissingSignal(result: JobRunResult): boolean {
  if (result.notes.some((note) => /security[- ]input|security code/i.test(note))) {
    return true;
  }
  return result.notes.some((note) => /submit_challenge_detected:yes/i.test(note));
}

function shouldRetryGreenhouseHeaded(input: {
  result: JobRunResult;
  platform: string;
  mode: AutomationConfig["mode"];
  effectiveHeadless: boolean;
  hasCdp: boolean;
}): boolean {
  // Auto-submit runs operate in one-shot mode for deterministic blocker diagnosis.
  if (input.mode === "auto-submit") return false;
  const { result, platform, effectiveHeadless, hasCdp } = input;
  if (platform !== "greenhouse") return false;
  if (!effectiveHeadless) return false;
  if (hasCdp) return false;
  if (result.submissionConfirmed) return false;

  return (
    result.submitOutcome === "blocked_bot_challenge" ||
    result.submitOutcome === "challenge_detected" ||
    result.notes.some((note) => /submit_reason:challenge_blocked/i.test(note)) ||
    hasSecurityCodeMissingSignal(result)
  );
}

function shouldRetryGreenhouseSessionLostInfra(input: {
  result: JobRunResult;
  platform: string;
}): boolean {
  const { result, platform } = input;
  if (platform !== "greenhouse") return false;
  if (result.submissionConfirmed) return false;
  return result.submitOutcome === "session_lost";
}

async function safeClose(
  label: string,
  fn: () => Promise<unknown>,
  logger: AppLogger,
  timeoutMs = 5000
): Promise<void> {
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const closePromise = fn()
    .then(() => "ok" as const)
    .catch((error) => {
      logger.warn("close_failed", {
        target: label,
        error: error instanceof Error ? error.message : String(error)
      });
      return "error" as const;
    });

  const outcome = await Promise.race([closePromise, timeoutPromise]);
  if (outcome === "timeout") {
    logger.warn("close_timeout", { target: label, timeoutMs });
  }
}

function cdpHttpBaseUrl(cdpUrl: string): string | null {
  const trimmed = cdpUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `${parsed.protocol}//${parsed.host}`;
    }
    if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
      return `${parsed.protocol === "wss:" ? "https:" : "http:"}//${parsed.host}`;
    }
  } catch {
    return null;
  }
  return null;
}

async function ensureCdpInspectableTarget(cdpUrl: string, logger: AppLogger): Promise<void> {
  const baseUrl = cdpHttpBaseUrl(cdpUrl);
  if (!baseUrl) return;

  const listUrl = `${baseUrl}/json/list`;
  const requestInit = {
    redirect: "follow" as const,
    signal: AbortSignal.timeout(4000)
  };

  let existingTargets = 0;
  try {
    const listResponse = await fetch(listUrl, requestInit);
    if (listResponse.ok) {
      const payload = await listResponse.json().catch(() => null);
      if (Array.isArray(payload)) {
        existingTargets = payload.length;
      }
    }
  } catch {
    return;
  }

  if (existingTargets > 0) return;

  const newTargetUrl = `${baseUrl}/json/new?about:blank`;
  try {
    await fetch(newTargetUrl, {
      ...requestInit,
      method: "PUT"
    });
    logger.info("cdp_seed_target_created", { baseUrl });
  } catch (error) {
    logger.warn("cdp_seed_target_failed", {
      baseUrl,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function closeStaleCdpPages(
  context: import("playwright-core").BrowserContext,
  anchorPage: import("playwright-core").Page | undefined,
  logger: AppLogger
): Promise<void> {
  for (const page of context.pages()) {
    if (page === anchorPage || page.isClosed()) continue;
    const url = page.url();
    // Automa desktop embeds multiple "automation surface" pages (one per slot) in the same CDP
    // context. Never close sibling surfaces while another run is executing.
    if (url.includes("automa-automation-surface-")) continue;
    await safeClose(`stale-cdp-page:${page.url() || "unknown"}`, () => page.close(), logger);
  }
}

async function findPreferredCdpPage(input: {
  context: import("playwright-core").BrowserContext;
  titleHint?: string;
  urlPatternHint?: string;
}): Promise<import("playwright-core").Page | undefined> {
  const { context, titleHint, urlPatternHint } = input;
  const normalizedTitleHint = titleHint?.trim().toLowerCase();
  const normalizedUrlPatternHint = urlPatternHint?.trim().toLowerCase();
  const pages = context.pages();

  for (const page of pages) {
    const currentUrl = page.url().trim().toLowerCase();
    if (normalizedUrlPatternHint && currentUrl.includes(normalizedUrlPatternHint)) {
      return page;
    }
  }

  if (!normalizedTitleHint) return undefined;

  for (const page of pages) {
    try {
      const title = (await page.title()).trim().toLowerCase();
      if (title.includes(normalizedTitleHint)) {
        return page;
      }
    } catch {
      // Ignore targets that cannot report title during attach.
    }
  }

  return undefined;
}

async function closeStaleWorkdayPages(
  context: import("playwright-core").BrowserContext,
  logger: AppLogger
): Promise<void> {
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    const url = page.url().toLowerCase();
    if (!/workday|myworkdayjobs|workdaysite/.test(url)) continue;
    await safeClose(`stale-workday-page:${page.url() || "unknown"}`, () => page.close(), logger);
  }
}

async function clearWorkdayPageState(
  page: import("playwright-core").Page,
  targetUrl: string,
  logger: AppLogger
): Promise<void> {
  const target = new URL(targetUrl);
  const origin = `${target.protocol}//${target.host}`;
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => undefined);
  await page.evaluate(() => {
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch {
      // no-op
    }
  }).catch((error) => {
    logger.warn("workday_state_clear_storage_failed", {
      origin,
      error: error instanceof Error ? error.message : String(error)
    });
  });
  await page.goto("about:blank", { waitUntil: "load", timeout: 5000 }).catch(() => undefined);
}

async function resetCdpAnchorPage(
  page: import("playwright-core").Page,
  resetUrl: string | undefined,
  logger: AppLogger
): Promise<void> {
  if (page.isClosed()) {
    logger.info("cdp_anchor_reset_skipped_closed", {});
    return;
  }
  const targetUrl = resetUrl?.trim() || "about:blank";
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 12000 }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("Target page, context or browser has been closed")
      || message.toLowerCase().includes("target page, context or browser has been closed")
      || message.toLowerCase().includes("has been closed")
      || message.toLowerCase().includes("target closed")
    ) {
      logger.info("cdp_anchor_reset_skipped_closed_target", { targetUrl });
      return undefined;
    }
    logger.warn("cdp_anchor_reset_failed", {
      targetUrl,
      error: message
    });
    return undefined;
  });
}

async function createWorkdayRunSurface(input: {
  browser: import("playwright-core").Browser | undefined;
  sharedContext: import("playwright-core").BrowserContext;
  browserMode: "cdp" | "persistent_context" | "ephemeral";
  logger: AppLogger;
  targetUrl: string;
}): Promise<{
  page: import("playwright-core").Page;
  runContext?: import("playwright-core").BrowserContext;
  mode: "fresh_context" | "fresh_page" | "fresh_page_with_state_clear";
}> {
  const { browser, sharedContext, browserMode, logger, targetUrl } = input;

  if (browser) {
    try {
      const runContext = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
      const page = await runContext.newPage();
      await page.goto("about:blank").catch(() => undefined);
      return { page, runContext, mode: "fresh_context" };
    } catch (error) {
      logger.warn("workday_fresh_context_failed", {
        browserMode,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  await closeStaleWorkdayPages(sharedContext, logger);
  const page = await sharedContext.newPage();
  await page.goto("about:blank").catch(() => undefined);

  if (browserMode === "cdp" || browserMode === "persistent_context") {
    await clearWorkdayPageState(page, targetUrl, logger);
    return { page, mode: "fresh_page_with_state_clear" };
  }

  return { page, mode: "fresh_page" };
}

async function detectEmbeddedGreenhouseOnPage(
  page: import("playwright-core").Page,
  url: string,
  timeoutMs: number
): Promise<boolean> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs, 45000) }).catch(() => undefined);
  const hasEmbeddedMarker = async (): Promise<boolean> => page.evaluate(() => {
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
    const hasMyGreenhouseButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .some((button) => /autofill with mygreenhouse/.test(normalize(button.textContent || "")));
    if (hasMyGreenhouseButton) return true;

    const hasGreenhouseApplicationForm =
      Boolean(document.querySelector("form#application-form.application--form")) ||
      Boolean(document.querySelector(".application--container .application--header")) ||
      Boolean(document.querySelector('form[action*="/embed/job_app"]')) ||
      Boolean(document.querySelector("#first_name")) ||
      Boolean(document.querySelector("#last_name")) ||
      Boolean(document.querySelector("#email"));
    if (hasGreenhouseApplicationForm) return true;

    const hasGreenhouseFrame = Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe"))
      .some((frame) => {
        const src = (frame.src || "").toLowerCase();
        return /greenhouse|job_app|gh_jid|gh_src/.test(src);
      });
    if (hasGreenhouseFrame) return true;

    const inlineText = normalize((document.body?.innerText || "").slice(0, 20000));
    return /autofill with mygreenhouse|apply for this job/.test(inlineText);
  }).catch(() => false);

  if (await hasEmbeddedMarker()) return true;

  const pollDeadline = Date.now() + Math.min(Math.max(Math.floor(timeoutMs * 0.3), 3000), 12000);
  while (Date.now() < pollDeadline) {
    await page.waitForTimeout(350).catch(() => undefined);
    if (await hasEmbeddedMarker()) return true;
  }

  return false;
}

async function createRevealHandler(
  page: import("playwright-core").Page,
  logger: AppLogger,
  embedded: boolean
): Promise<() => Promise<void>> {
  if (embedded) {
    return async () => undefined;
  }
  return async () => {
    try {
      const cdpSession = await page.context().newCDPSession(page);
      const windowForTarget = await cdpSession.send("Browser.getWindowForTarget");
      const windowId = typeof windowForTarget.windowId === "number" ? windowForTarget.windowId : undefined;
      if (windowId !== undefined) {
        await cdpSession.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "normal" }
        }).catch(() => undefined);
      }
      await page.bringToFront().catch(() => undefined);
    } catch (error) {
      logger.warn("browser_window_reveal_failed", {
        error: error instanceof Error ? error.message : String(error),
        url: page.url()
      });
    }
  };
}

function attachRunSurfaceLifecycleLogging(input: {
  page: import("playwright-core").Page;
  context: import("playwright-core").BrowserContext;
  logger: AppLogger;
  targetUrl: string;
  browserMode: "cdp" | "persistent_context" | "ephemeral";
  embedded: boolean;
}): void {
  const { page, context, logger, targetUrl, browserMode, embedded } = input;
  page.once("close", () => {
    logger.warn("automation_page_closed", {
      targetUrl,
      browserMode,
      embedded,
      pageUrl: page.url()
    });
  });
  context.once("close", () => {
    logger.warn("automation_context_closed", {
      targetUrl,
      browserMode,
      embedded,
      pageUrl: page.url()
    });
  });
}

export async function runAutomation(input: RunInput): Promise<RunOutput> {
  const { config, profile, resumeText, targets, hooks } = input;

  fs.mkdirSync(config.outputDir, { recursive: true });
  fs.mkdirSync(config.screenshotsDir, { recursive: true });

  const logger = new AppLogger(config.outputDir);
  const aiEngine = new AnswerEngine(config.ai, logger);
  const adapters = buildAdapters();
  const hasAshbyTargets = targets.some((target) => detectPlatform(target.url) === "ashby");

  const launchMode = config.browser?.launchMode;
  const configCdpUrl = launchMode === "persistent-profile" || launchMode === "ephemeral" ? "" : config.browser?.cdpUrl?.trim();
  const cdpUrl = configCdpUrl || (launchMode === "persistent-profile" || launchMode === "ephemeral" ? "" : process.env.CDP_URL);
  const cdpPageTitle = config.browser?.cdpPageTitle?.trim();
  const cdpPageUrlPattern = config.browser?.cdpPageUrlPattern?.trim();
  const cdpResetUrl = config.browser?.cdpResetUrl?.trim();
  const reuseAnchorPage = Boolean(config.browser?.reuseAnchorPage);
  const hostManagedEmbeddedSurface = config.browser?.embedded === true;
  const treatAsHostManagedEmbeddedSurface = hostManagedEmbeddedSurface || (Boolean(cdpUrl) && Boolean(cdpPageTitle || cdpPageUrlPattern));
  const configChannel = config.browser?.channel?.trim();
  const channel = configChannel || process.env.PW_CHANNEL;
  const configUserDataDir = config.browser?.userDataDir?.trim();
  const userDataDir = configUserDataDir || process.env.PW_USER_DATA_DIR;
  const windowVisibility = config.browser?.windowVisibility ?? "visible";
  const envHeadless = process.env.HEADLESS === "0" ? false : undefined;
  const requestedHeadless = envHeadless ?? config.headless;
  const effectiveHeadless = launchMode === "persistent-profile" && windowVisibility === "hidden"
    ? false
    : false;
  if (requestedHeadless) {
    logger.info("headless_forced_off", {
      requestedHeadless,
      effectiveHeadless
    });
  }
  const isAshbyAutoSubmit = hasAshbyTargets && config.mode === "auto-submit";
  if (isAshbyAutoSubmit && effectiveHeadless !== false) {
    logger.warn("ashby_headless_degraded", {
      mode: config.mode,
      effectiveHeadless
    });
  }
  if (isAshbyAutoSubmit && !cdpUrl) {
    logger.warn("ashby_cdp_missing", {
      mode: config.mode,
      userDataDir: userDataDir ?? null
    });
  }
  let browser: import("playwright-core").Browser | undefined;
  let context: import("playwright-core").BrowserContext;
  let browserMode: "cdp" | "persistent_context" | "ephemeral";
  let cdpAnchorPage: import("playwright-core").Page | undefined;

  if (launchMode === "persistent-profile" && !userDataDir) {
    throw new Error("Persistent-profile browser mode requires `browser.userDataDir`.");
  }

  if (cdpUrl) {
    await ensureCdpInspectableTarget(cdpUrl, logger);
    browser = await chromium.connectOverCDP(cdpUrl);
    const existingContext = browser.contexts()[0];
    if (!existingContext) {
      throw new Error(`CDP attach failed: no browser contexts found at ${cdpUrl}. Keep CDP Chrome open and retry.`);
    }
    context = existingContext;
    browserMode = "cdp";
    if (treatAsHostManagedEmbeddedSurface && !cdpPageTitle && !cdpPageUrlPattern) {
      throw new Error("CDP attach failed: embedded mode requires a cdpPageTitle or cdpPageUrlPattern hint.");
    }
    cdpAnchorPage = await findPreferredCdpPage({
      context,
      titleHint: cdpPageTitle,
      urlPatternHint: cdpPageUrlPattern
    });
    if (!cdpAnchorPage) {
      if (treatAsHostManagedEmbeddedSurface) {
        throw new Error(
          `CDP attach failed: embedded automation page not found for title="${cdpPageTitle ?? ""}" url="${cdpPageUrlPattern ?? ""}".`
        );
      }
      if (reuseAnchorPage && (cdpPageTitle || cdpPageUrlPattern)) {
        throw new Error(
          `CDP attach failed: no page matched embedded automation hints title="${cdpPageTitle ?? ""}" url="${cdpPageUrlPattern ?? ""}".`
        );
      }
      cdpAnchorPage = context.pages()[0];
    }
    if (!cdpAnchorPage || cdpAnchorPage.isClosed()) {
      if (reuseAnchorPage) {
        throw new Error("CDP attach failed: embedded automation page is unavailable.");
      }
      cdpAnchorPage = await context.newPage();
    }
    if (!reuseAnchorPage && !treatAsHostManagedEmbeddedSurface) {
      await cdpAnchorPage.goto("about:blank").catch(() => undefined);
      await closeStaleCdpPages(context, cdpAnchorPage, logger);
    }
    // Playwright waits 30 seconds by default for an element to become
    // actionable. On a real application form that is the difference between an
    // adapter noticing a dead end and an application taking a quarter of an
    // hour: one hidden checkbox on a live Greenhouse posting cost 120 seconds
    // in two waits. A field that has not appeared in eight seconds is not
    // going to, and every code path here already handles a failed action.
    context.setDefaultTimeout(8000);
    logger.info("cdp_anchor_ready", { pageCount: context.pages().length });
  } else if (userDataDir) {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: effectiveHeadless,
      channel: channel || undefined,
      viewport: { width: 1440, height: 1200 },
      args: launchMode === "persistent-profile" && windowVisibility === "hidden" ? ["--start-minimized"] : []
    });
    browser = context.browser() ?? undefined;
    browserMode = "persistent_context";
  } else {
    browser = await chromium.launch({
      headless: effectiveHeadless,
      channel: channel || undefined
    });
    context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
    browserMode = "ephemeral";
  }
    logger.info("browser_session_ready", {
      mode: browserMode,
      headless: effectiveHeadless,
      cdpUrl: cdpUrl || null,
      cdpPageTitle: cdpPageTitle || null,
      cdpPageUrlPattern: cdpPageUrlPattern || null,
      reuseAnchorPage,
      hostManagedEmbeddedSurface: treatAsHostManagedEmbeddedSurface,
      userDataDir: userDataDir || null,
      profileDirectory: process.env.CDP_PROFILE_DIRECTORY || null,
      channel: channel || null
    });

  const results: JobRunResult[] = [];
  const previousResults = readPreviousResults(config.outputDir);
  const useEmbeddedAnchorPage = browserMode === "cdp" && reuseAnchorPage && Boolean(cdpAnchorPage);

  for (const target of targets) {
    const platform = detectPlatform(target.url);
    const replayHit = shouldSkipRecentAshbyReplay(target.url, platform, config, previousResults);
    if (replayHit) {
      const now = new Date().toISOString();
      const cooldownHours = Math.max(1, config.ashby?.resubmitCooldownHours ?? 48);
      results.push({
        url: target.url,
        platform: "ashby",
        status: "skipped",
        submitted: false,
        submissionConfirmed: false,
        submitOutcome: "not_submitted",
        dryRun: false,
        jobTitle: target.jobTitle,
        company: target.company,
        notes: [
          `submit_replay_guard:skipped_recent_submission_within_${cooldownHours}h`,
          `submit_replay_guard:last_outcome=${replayHit.submitOutcome ?? replayHit.status}`,
          `submit_replay_guard:last_finished_at=${replayHit.finishedAt}`
        ],
        answers: [],
        filledFields: [],
        screenshotPaths: [],
        startedAt: now,
        finishedAt: now
      });
      logger.info("job_skipped_recent_replay", {
        url: target.url,
        platform,
        cooldownHours,
        lastFinishedAt: replayHit.finishedAt,
        lastOutcome: replayHit.submitOutcome ?? replayHit.status
      });
      continue;
    }

    let page: import("playwright-core").Page;
    let workdayRunContext: import("playwright-core").BrowserContext | undefined;
    let workdayRunSurface: "fresh_context" | "fresh_page" | "fresh_page_with_state_clear" | "embedded_anchor" | undefined;
    if (useEmbeddedAnchorPage && cdpAnchorPage) {
      page = cdpAnchorPage;
      if (platform === "workday") {
        workdayRunSurface = "embedded_anchor";
      }
    } else if (platform === "workday") {
      const runSurface = await createWorkdayRunSurface({
        browser,
        sharedContext: context,
        browserMode,
        logger,
        targetUrl: target.url
      });
      page = runSurface.page;
      workdayRunContext = runSurface.runContext;
      workdayRunSurface = runSurface.mode;
    } else {
      page = await context.newPage();
    }

    const activeContext = workdayRunContext ?? context;
    const embeddedRunSurface = useEmbeddedAnchorPage && page === cdpAnchorPage;
    attachRunSurfaceLifecycleLogging({
      page,
      context: activeContext,
      logger,
      targetUrl: target.url,
      browserMode,
      embedded: embeddedRunSurface
    });

    hooks?.onActivePage?.({
      page,
      context: activeContext,
      browserMode,
      reveal: await createRevealHandler(page, logger, embeddedRunSurface),
      close: async () => {
        if (workdayRunContext) {
          await safeClose(`workday-context:${target.url}`, () => workdayRunContext.close(), logger);
          return;
        }
        if (useEmbeddedAnchorPage && page === cdpAnchorPage) {
            if (treatAsHostManagedEmbeddedSurface) {
              logger.info("embedded_surface_close_noop", { url: target.url });
              return;
            }
          await safeClose(`cdp-anchor:${target.url}`, () => resetCdpAnchorPage(page, cdpResetUrl, logger), logger);
          return;
        }
        await safeClose(`page:${target.url}`, () => page.close(), logger);
      }
    });

    logger.info("job_start", { url: target.url, platform });

    let adapter = adapters.find((candidate) => candidate.canHandle(target.url));
    if (platform === "generic" && adapter?.platform === "generic") {
      const embeddedGreenhouse = await detectEmbeddedGreenhouseOnPage(page, target.url, config.timeoutMs).catch(() => false);
      if (embeddedGreenhouse) {
        const greenhouseAdapter = adapters.find((candidate) => candidate.platform === "greenhouse");
        if (greenhouseAdapter) {
          adapter = greenhouseAdapter;
          logger.info("embedded_greenhouse_detected", { url: target.url });
        }
      }
    }
    if (!adapter) {
      results.push({
        url: target.url,
        platform: "unknown",
        status: "skipped",
        submitted: false,
        submissionConfirmed: false,
        dryRun: config.mode === "dry-run",
        jobTitle: target.jobTitle,
        company: target.company,
        notes: ["No adapter matched URL."],
        answers: [],
        filledFields: [],
        screenshotPaths: [],
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString()
      });
      await safeClose(`page:${target.url}`, () => page.close(), logger);
      continue;
    }

    let result = await adapter.apply({
      page,
      target,
      profile,
      resumeText,
      config,
      aiEngine,
      logger
    });
    if (platform === "workday") {
      result.notes.unshift(`workday_cdp_mode:${browserMode === "cdp"}`);
      if (workdayRunSurface) result.notes.unshift(`workday_run_surface:${workdayRunSurface}`);
    }
    if (config.mode === "auto-submit" && !result.notes.some((note) => note === "submit_policy:one_shot")) {
      result.notes.push("submit_policy:one_shot");
    }

    if (
      shouldRetryGreenhouseSessionLostInfra({
        result,
        platform
      })
    ) {
      logger.info("greenhouse_session_lost_retry_start", { url: target.url });
      result.notes.push("infra_retry:session_lost:start");
      const retryPage = useEmbeddedAnchorPage && cdpAnchorPage ? cdpAnchorPage : await context.newPage();
      const retryResult = await adapter.apply({
        page: retryPage,
        target,
        profile,
        resumeText,
        config,
        aiEngine,
        logger
      });
      if (config.mode === "auto-submit" && !retryResult.notes.some((note) => note === "submit_policy:one_shot")) {
        retryResult.notes.push("submit_policy:one_shot");
      }
      retryResult.notes.push("infra_retry_attempts:1");
      if (retryPage !== cdpAnchorPage) {
        await safeClose(`session-lost-retry-page:${target.url}`, () => retryPage.close(), logger);
      }
      if (retryResult.submissionConfirmed) {
        retryResult.notes.push("infra_retry:session_lost:success");
        result = retryResult;
        logger.info("greenhouse_session_lost_retry_done", { url: target.url, confirmed: true });
      } else {
        retryResult.notes.push("infra_retry:session_lost:failed");
        result = retryResult;
        logger.info("greenhouse_session_lost_retry_done", {
          url: target.url,
          confirmed: false,
          outcome: retryResult.submitOutcome ?? retryResult.status
        });
      }
    }

    if (
      shouldRetryGreenhouseHeaded({
        result,
        platform,
        mode: config.mode,
        effectiveHeadless,
        hasCdp: Boolean(cdpUrl)
      })
    ) {
      logger.info("greenhouse_headed_retry_start", { url: target.url });
      const headedBrowser = await chromium.launch({
        headless: false,
        channel: channel || undefined
      });
      const headedContext = await headedBrowser.newContext({ viewport: { width: 1440, height: 1200 } });
      const headedPage = await headedContext.newPage();
      const headedConfig: AutomationConfig = {
        ...config,
        headless: false
      };

      const retryResult = await adapter.apply({
        page: headedPage,
        target,
        profile,
        resumeText,
        config: headedConfig,
        aiEngine,
        logger
      });
      await safeClose(`headed-retry-page:${target.url}`, () => headedPage.close(), logger);
      await safeClose("headed-retry-context", () => headedContext.close(), logger);
      await safeClose("headed-retry-browser", () => headedBrowser.close(), logger);

      if (retryResult.submissionConfirmed) {
        retryResult.notes.push("submit_retry:headed_fallback_confirmed");
        result = retryResult;
        logger.info("greenhouse_headed_retry_done", { url: target.url, confirmed: true });
      } else {
        result.notes.push(`submit_retry:headed_fallback_failed:${retryResult.submitOutcome ?? retryResult.status}`);
        logger.info("greenhouse_headed_retry_done", { url: target.url, confirmed: false });
      }
    }

    result = withDerivedSubmissionReceipt(result);
    results.push(result);
    logger.info("job_done", {
      url: target.url,
      platform: result.platform,
      status: result.status,
      submitted: result.submitted,
      submissionConfirmed: result.submissionConfirmed
    });

    if (useEmbeddedAnchorPage && page === cdpAnchorPage) {
      if (!treatAsHostManagedEmbeddedSurface) {
        await closeStaleCdpPages(context, cdpAnchorPage, logger);
        await resetCdpAnchorPage(cdpAnchorPage, cdpResetUrl, logger);
      }
    } else {
      await safeClose(`page:${target.url}`, () => page.close(), logger);
    }
    if (workdayRunContext) {
      await safeClose(`workday-context:${target.url}`, () => workdayRunContext!.close(), logger);
    }
  }

  if (!cdpUrl) {
    await safeClose("context", () => context.close(), logger);
  }
  if (cdpUrl && cdpAnchorPage && !cdpAnchorPage.isClosed() && !treatAsHostManagedEmbeddedSurface) {
    await closeStaleCdpPages(context, cdpAnchorPage, logger);
    await resetCdpAnchorPage(cdpAnchorPage, cdpResetUrl, logger);
  }
  if (!cdpUrl && browser) {
    await safeClose("browser", () => browser.close(), logger);
  }

  const resultsPath = writeResults(path.resolve(config.outputDir), results);
  logger.info("run_complete", {
    targets: targets.length,
    resultsPath
  });

  return {
    resultsPath,
    results
  };
}
