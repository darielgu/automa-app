import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Notification, WebContentsView, dialog, ipcMain, shell } from "electron";
import type { OpenDialogOptions, Rectangle, Session } from "electron";
import {
  detectPlatform,
  runAutomation,
  type ActiveAutomationPage,
  type AutomationConfig,
  type CandidateProfile,
  type JobRunResult,
  type Platform
} from "@automa/automation-engine";
import type {
  DesktopAutomationConfig,
  RunCompletionEvent,
  RunOutcome,
  UserProfileInput
} from "@automa/shared-types";
import type { DesktopBrowserDrawerBounds, DesktopResumeRecord, ResumeParseDraft } from "../src/desktop-types.js";
import { createResumeRecord, parseResumeRecord } from "./resume.js";
import { openDatabase, type Db } from "./db/database.js";
import { GUEST_DEMOGRAPHICS, GUEST_PERSONA, guestResumeText } from "./guest-persona.js";
import { generateGuestResume } from "./guest-resume.js";
import {
  appendRunEvent, getProfile, listApplied, listRunEvents, listStageEvents,
  moveAppliedStage, saveProfile, setAppliedNotes, upsertAppliedJob, getSetting,
  setSetting, type TrackerStage
} from "./db/app-repo.js";
import { getJob, jobFacets, queryJobs, setJobFeedback, upsertJobs, type JobQuery } from "./db/jobs-repo.js";
import { feedStatus, syncJobFeed } from "./job-feed/sync.js";

type QueueEntry = RunOutcome & {
  sourceUrl: string;
  jobTitle?: string;
  company?: string;
  location?: string;
  source?: string;
};

type DesktopState = {
  onboarding?: UserProfileInput;
  resume?: DesktopResumeRecord;
  config: DesktopAutomationConfig;
  runs: QueueEntry[];
  scheduler: {
    queueVersion: number;
    slots: Record<WorkerSlotId, {
      leaseId: string | null;
      currentRunId: string | null;
      dirty: boolean;
      state: "idle" | "leased" | "resetting";
    }>;
  };
};

const WORKER_SLOT_IDS = ["slot-1", "slot-2"] as const;
type WorkerSlotId = (typeof WORKER_SLOT_IDS)[number];

type WorkerSlot = {
  slotId: WorkerSlotId;
  title: string;
  marker: string;
  // legacy fields preserved for state compatibility
  landingUrl: string;
};

type SchedulerPermit = {
  slotId: WorkerSlotId;
  permitId: string;
  runId: string;
};

type RunSurface = {
  runId: string;
  permitId: string;
  slotId: WorkerSlotId;
  view: WebContentsView;
  destroyed: boolean;
};

type ActiveWorkerSession = {
  runId: string;
  leaseId: string;
  workerId: string;
  slotId: WorkerSlotId;
  provider: Platform;
  browserVisible: boolean;
  reveal?: () => Promise<void>;
  cancel?: () => Promise<void>;
};

const EMBEDDED_AUTOMATION_PARTITION = "persist:automa-automation";
/**
 * The CDP port the automation engine attaches to.
 *
 * A fixed port is wrong for a distributed app: any other Chrome on 9223 and we
 * would drive the wrong browser. Passing 0 makes Chromium choose a free port
 * and write it to `DevToolsActivePort` in userData, which we then read back.
 */
let resolvedDebugPort: number | null = null;

function readDevToolsPort(): number {
  if (resolvedDebugPort) return resolvedDebugPort;
  const forced = Number(process.env.AUTOMA_EMBEDDED_DEBUG_PORT || 0);
  if (forced) {
    resolvedDebugPort = forced;
    return forced;
  }
  const portFile = path.join(app.getPath("userData"), "DevToolsActivePort");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const first = readFileSync(portFile, "utf8").split("\n")[0]?.trim();
      const parsed = Number(first);
      if (parsed > 0) {
        resolvedDebugPort = parsed;
        return parsed;
      }
    } catch {
      // Chromium has not written the file yet.
    }
    // Chromium writes this during startup; a short synchronous wait is simpler
    // and more reliable here than racing an async watcher.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error("Could not determine the embedded browser debugging port.");
}

const MAX_EMBEDDED_VIEW_DIMENSION = 8192;
// Resolve bundled files relative to this compiled module rather than
// app.getAppPath(). In a packaged app the `electron/` and `public/` source
// directories are not shipped, so the old paths resolved to nothing and the
// window came up with no preload and no icon.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(moduleDir, "..", "..");
const rendererDir = path.join(appRoot, "dist");

function resolveAsset(fileName: string): string {
  for (const candidate of [path.join(rendererDir, fileName), path.join(appRoot, "public", fileName)]) {
    if (existsSync(candidate)) return candidate;
  }
  return path.join(rendererDir, fileName);
}

// Set before anything reads app.getPath("userData"): otherwise the directory
// is derived from the package name (@automa/desktop) instead of the product.
app.setName("Automa");
// setPath throws if the target does not exist yet, so create it first. Without
// this the app dies silently before whenReady and never opens a window.
const userDataDir = path.join(app.getPath("appData"), "Automa");
mkdirSync(userDataDir, { recursive: true });
app.setPath("userData", userDataDir);

// Only one instance may own the CDP port and the database.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

const statePath = path.join(app.getPath("userData"), "automa-state.json");

// One local database. Opened lazily so a migration failure surfaces as a real
// error at first use rather than a silent crash during module evaluation.
let dbHandle: Db | null = null;
function db(): Db {
  if (!dbHandle) dbHandle = openDatabase(path.join(app.getPath("userData"), "automa.db"));
  return dbHandle;
}

/**
 * Records a run step and pushes it to the renderer. This is what turns the run
 * view from a status label into a live log of what the automation is doing.
 */
function emitRunEvent(runId: string, event: string, data?: unknown, level = "info"): void {
  try {
    appendRunEvent(db(), runId, { event, data, level });
  } catch (error) {
    console.error("Failed to record run event", error);
  }
  mainWindow?.webContents.send("run:events", { runId, event, data, level, ts: new Date().toISOString() });
}

/**
 * The bundled demo application. Guest mode needs somewhere safe to prove the
 * automation really works: a fictional persona pointed at a real posting would
 * send junk to a real company.
 */
const DEMO_JOB_ID = "00000000-0000-4000-8000-00000000d3m0";

function demoJobUrl(): string {
  return `file://${path.join(appRoot, "resources", "demo", "greenhouse-demo.html")}`;
}

function seedDemoJob(): void {
  const url = demoJobUrl();
  upsertJobs(db(), [
    {
      simplify_id: DEMO_JOB_ID,
      source_repos: ["demo"],
      company_name: "Automa Demo Co",
      company_url: null,
      title: "Software Engineer (built-in demo application)",
      url,
      dedupe_key: url,
      apply_host: "localhost",
      ats_platform: "greenhouse",
      category: "Software Engineering",
      locations: ["Remote"],
      terms: ["Demo"],
      degrees: [],
      sponsorship: null,
      source: "automa-demo",
      feed_active: true,
      is_visible: true,
      date_posted: Math.floor(Date.now() / 1000),
      date_updated: Math.floor(Date.now() / 1000),
      content_hash: "demo",
      flags: ["demo"]
    }
  ]);
}

/** Puts a finished run on the tracker board. */
function recordAppliedJob(run: QueueEntry): void {
  if (!run.jobId) return;
  upsertAppliedJob(db(), {
    jobId: run.jobId,
    runId: run.id,
    sourceUrl: run.sourceUrl,
    title: run.jobTitle ?? "",
    company: run.company ?? "",
    location: run.location ?? "",
    source: run.source ?? "",
    stage: run.submissionConfirmed || run.submitted ? "applied" : "saved"
  });
}
const HIDDEN_BROWSER_DRAWER_BOUNDS: Rectangle = { x: 0, y: 0, width: 0, height: 0 };

let mainWindow: BrowserWindow | null = null;
let browserDrawerBounds: Rectangle | null = null;
const cancellationRequests = new Set<string>();
const workerSessions = new Map<string, ActiveWorkerSession>();
const workerSlots = new Map<WorkerSlotId, WorkerSlot>();
const runApiCookieHeaders = new Map<string, string>();
const lastKnownApiCookieHeaders = new Map<string, string>();
const runSurfaces = new Map<string, RunSurface>();
let sharedHistoryWrite = Promise.resolve();
let schedulerRunning = false;
let schedulerWakeRequested = false;
let schedulerSuspendedReason: string | null = null;

app.commandLine.appendSwitch("remote-debugging-port", String(Number(process.env.AUTOMA_EMBEDDED_DEBUG_PORT || 0)));

function sleepMs(durationMs: number): Promise<void> {
  if (!durationMs || durationMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

class DesktopApiError extends Error {
  status: number;
  statusText: string;
  detail: string;

  constructor(input: { message: string; status: number; statusText: string; detail: string }) {
    super(input.message);
    this.name = "DesktopApiError";
    this.status = input.status;
    this.statusText = input.statusText;
    this.detail = input.detail;
  }
}

function logWorkerViewLifecycle(event: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    event,
    data
  }));
}

function buildWorkerSurfaceTitle(slotId: WorkerSlotId) {
  return `Automa Automation Surface ${slotId.toUpperCase()}`;
}

function buildWorkerSurfaceMarker(slotId: WorkerSlotId) {
  return `automa-automation-surface-${slotId}`;
}

function buildAutomationLandingUrl(slotId: WorkerSlotId) {
  const title = buildWorkerSurfaceTitle(slotId);
  const marker = buildWorkerSurfaceMarker(slotId);
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="automa-surface" content="${marker}" />
    <title>${title}</title>
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: linear-gradient(135deg, #f5f3ee, #ece7dd); color: #1e1d1a; }
      main { max-width: 32rem; padding: 2rem; text-align: left; }
      h1 { font-size: 1.35rem; margin: 0 0 0.75rem; }
      p { margin: 0.5rem 0; line-height: 1.5; color: #4c4a44; }
      code { padding: 0.15rem 0.4rem; background: rgba(0,0,0,0.06); border-radius: 0.4rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>This Chromium surface is owned by Automa and shares the in-app session partition with the other worker window.</p>
      <p>Automa reuses this slot for contained automation runs and resets it back here when the run finishes.</p>
    </main>
  </body>
</html>`
  )}`;
}

function buildDefaultDesktopConfig(): DesktopAutomationConfig {
  const outputDir = path.join(app.getPath("userData"), "automation-output");
  return {
    apiBaseUrl: process.env.AUTOMA_API_URL || "http://127.0.0.1:7461",
    mode: "auto-submit",
    headless: false,
    timeoutMs: 60000,
    outputDir,
    screenshotsDir: path.join(outputDir, "screenshots"),
    automationDebugPort: 0,
    automationPartition: EMBEDDED_AUTOMATION_PARTITION,
    aiProvider: "automa_api",
    openaiModel: "gpt-4o-mini",
    openaiApiKeyEnv: "OPENAI_API_KEY",
    ollamaBaseUrl: "http://localhost:11434",
    maxParallelRuns: 2,
    workerVisibility: "hidden"
  };
}

function normalizeDesktopAiProvider(provider: DesktopAutomationConfig["aiProvider"]): DesktopAutomationConfig["aiProvider"] {
  return provider === "none" ? "none" : "automa_api";
}

function buildDefaultSchedulerState() {
  return {
    queueVersion: 0,
    slots: Object.fromEntries(
      WORKER_SLOT_IDS.map((slotId) => [slotId, {
        leaseId: null,
        currentRunId: null,
        dirty: false,
        state: "idle" as const
      }])
    ) as DesktopState["scheduler"]["slots"]
  };
}

function normalizeState(value: unknown): DesktopState {
  const defaults = buildDefaultDesktopConfig();
  if (!value || typeof value !== "object") {
    return { config: defaults, runs: [], scheduler: buildDefaultSchedulerState() };
  }

  const source = value as Partial<DesktopState>;
  const schedulerDefaults = buildDefaultSchedulerState();
  const sourceScheduler = source.scheduler;
  const rawConfig = {
    ...defaults,
    ...(source.config ?? {})
  };
  // Enforce server-side AI routing for all LLM-enabled desktop runs.
  const migratedAiProvider = normalizeDesktopAiProvider(rawConfig.aiProvider);
  return {
    onboarding: source.onboarding,
    resume: source.resume,
    config: {
      ...rawConfig,
      aiProvider: migratedAiProvider
    },
    runs: Array.isArray(source.runs) ? source.runs as QueueEntry[] : [],
    scheduler: {
      queueVersion: typeof sourceScheduler?.queueVersion === "number" ? sourceScheduler.queueVersion : schedulerDefaults.queueVersion,
      slots: Object.fromEntries(
        WORKER_SLOT_IDS.map((slotId) => {
          const existing = sourceScheduler?.slots?.[slotId];
          return [slotId, {
            leaseId: typeof existing?.leaseId === "string" ? existing.leaseId : null,
            currentRunId: typeof existing?.currentRunId === "string" ? existing.currentRunId : null,
            dirty: existing?.dirty === true,
            state: existing?.state === "leased" || existing?.state === "resetting" ? existing.state : "idle"
          }];
        })
      ) as DesktopState["scheduler"]["slots"]
    }
  };
}

function readState(): DesktopState {
  try {
    if (!existsSync(statePath)) {
      return normalizeState(null);
    }
    return normalizeState(JSON.parse(readFileSync(statePath, "utf8")));
  } catch {
    return normalizeState(null);
  }
}

function writeState(next: DesktopState) {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(next, null, 2), "utf8");
}

function emitRunsUpdated() {
  mainWindow?.webContents.send("runs:updated", readState().runs);
}

function writeRuns(runs: QueueEntry[]) {
  const state = readState();
  state.runs = runs;
  writeState(state);
  emitRunsUpdated();
  return state;
}

function updateSchedulerState(mutator: (scheduler: DesktopState["scheduler"]) => void) {
  const state = readState();
  mutator(state.scheduler);
  state.scheduler.queueVersion += 1;
  writeState(state);
  emitRunsUpdated();
}

function setSlotSchedulerState(slotId: WorkerSlotId, patch: Partial<DesktopState["scheduler"]["slots"][WorkerSlotId]>) {
  updateSchedulerState((scheduler) => {
    scheduler.slots[slotId] = {
      ...scheduler.slots[slotId],
      ...patch
    };
  });
}

function persistRun(run: QueueEntry) {
  const state = readState();
  const index = state.runs.findIndex((entry) => entry.id === run.id);
  if (index >= 0) {
    state.runs[index] = {
      ...state.runs[index],
      ...run
    };
  } else {
    state.runs.unshift(run);
  }
  writeState(state);
  emitRunsUpdated();
  return state;
}

function buildAutomationProfile(profile: UserProfileInput): CandidateProfile {
  const { preferences: _preferences, ...candidateProfile } = profile;
  return candidateProfile;
}

function sanitizePathSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function getRunOutputDirs(config: DesktopAutomationConfig, runId: string) {
  const outputDir = path.join(config.outputDir, "runs", sanitizePathSegment(runId));
  return {
    outputDir,
    screenshotsDir: path.join(outputDir, "screenshots")
  };
}

function getWorkerSlot(slotId: WorkerSlotId): WorkerSlot {
  const existing = workerSlots.get(slotId);
  if (existing) return existing;
  const created: WorkerSlot = {
    slotId,
    title: buildWorkerSurfaceTitle(slotId),
    marker: buildWorkerSurfaceMarker(slotId),
    landingUrl: buildAutomationLandingUrl(slotId)
  };
  workerSlots.set(slotId, created);
  return created;
}

function getWorkerSlots(): WorkerSlot[] {
  return WORKER_SLOT_IDS.map((slotId) => getWorkerSlot(slotId));
}

function normalizeBrowserDrawerBounds(bounds: DesktopBrowserDrawerBounds | null | undefined): Rectangle | null {
  if (!bounds) return null;
  const x = Math.max(0, Math.round(bounds.x));
  const y = Math.max(0, Math.round(bounds.y));
  const width = Math.min(MAX_EMBEDDED_VIEW_DIMENSION, Math.max(0, Math.round(bounds.width)));
  const height = Math.min(MAX_EMBEDDED_VIEW_DIMENSION, Math.max(0, Math.round(bounds.height)));
  if (width === 0 || height === 0) return null;
  return { x, y, width, height };
}

function wakeScheduler(reason: string) {
  schedulerWakeRequested = true;
  if (schedulerRunning) return;
  void runSchedulerLoop(reason).catch((error) => {
    console.error(`Failed to schedule queued runs (${reason})`, error);
  });
}

function isAbortedNavigationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: string; message?: string };
  const message = maybe.message || "";
  return (
    maybe.code === "ERR_ABORTED"
    || message.includes("ERR_ABORTED")
    || message.includes("net::ERR_ABORTED")
    || message.includes("Navigation cancelled")
    || message.includes("navigation was aborted")
  );
}

function getVisibleRun(state = readState()) {
  return state.runs.find((entry) => entry.status === "running" && entry.browserVisible && entry.workerId);
}

function logTelemetry(event: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    event,
    data
  }));
}

function hideAllRunSurfaces(exceptRunId?: string) {
  for (const [runId, surface] of runSurfaces.entries()) {
    if (exceptRunId && runId === exceptRunId) continue;
    try {
      surface.view.setVisible(false);
      surface.view.setBounds(HIDDEN_BROWSER_DRAWER_BOUNDS);
    } catch {
      // no-op
    }
  }
}

async function createFreshRunSurface(input: { runId: string; permitId: string; slotId: WorkerSlotId }): Promise<RunSurface> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("Automa main window is not ready.");
  }

  const { runId, permitId, slotId } = input;
  const view = new WebContentsView({
    webPreferences: {
      partition: EMBEDDED_AUTOMATION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  view.setBackgroundColor("#ffffff");
  view.setVisible(false);
  view.setBounds(HIDDEN_BROWSER_DRAWER_BOUNDS);

  if (!mainWindow.contentView.children.includes(view)) {
    mainWindow.contentView.addChildView(view);
  }

  view.webContents.setWindowOpenHandler(({ url }) => {
    void view.webContents.loadURL(url);
    return { action: "deny" };
  });

  const surface: RunSurface = {
    runId,
    permitId,
    slotId,
    view,
    destroyed: false
  };
  runSurfaces.set(runId, surface);

  const marker = `automa-run-surface-${runId}`;
  const title = `Automa Run Surface ${runId}`;
  const landingUrl = `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="automa-surface" content="${marker}" />
    <title>${title}</title>
  </head>
  <body></body>
</html>`
  )}`;

  view.webContents.on("render-process-gone", (_event, details) => {
    logTelemetry("run_surface_render_process_gone", {
      runId,
      slotId,
      reason: details.reason,
      exitCode: details.exitCode
    });
  });

  view.webContents.on("destroyed", () => {
    surface.destroyed = true;
    logTelemetry("run_surface_destroyed", { runId, slotId });
    const current = readState().runs.find((entry) => entry.id === runId);
    if (current && current.status === "running") {
      const stage = current.phase === "submitting" ? "submitting" : "running";
      const paused = markRunPausedForWindow(current, stage);
      persistRun({
        ...paused,
        notes: [...(paused.notes ?? []), "run_surface_destroyed_mid_run"]
      });
      releaseSchedulerPermitIdempotent({ runId, permitId, slotId });
      wakeScheduler("run-surface-destroyed");
    }
    workerSessions.delete(runId);
    cancellationRequests.delete(runId);
    runApiCookieHeaders.delete(runId);
    runSurfaces.delete(runId);
  });

  await view.webContents.loadURL(landingUrl);
  logTelemetry("run_surface_created", { runId, slotId });
  return surface;
}

function destroyRunSurface(runId: string) {
  const surface = runSurfaces.get(runId);
  if (!surface) return;
  if (surface.destroyed) return;
  surface.destroyed = true;
  logTelemetry("run_surface_destroy_requested", { runId, slotId: surface.slotId });
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.contentView.children.includes(surface.view)) {
      mainWindow.contentView.removeChildView(surface.view);
    }
  } catch (error) {
    logTelemetry("run_surface_destroy_failed_nonfatal", {
      runId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  try {
    if (!surface.view.webContents.isDestroyed()) {
      surface.view.webContents.close({ waitForBeforeUnload: false });
    }
  } catch {
    // no-op
  }
  runSurfaces.delete(runId);
}

async function syncEmbeddedBrowserDrawer() {
  const state = readState();
  const visibleRun = getVisibleRun(state);
  if (!visibleRun || !visibleRun.workerId || !browserDrawerBounds || !mainWindow) {
    hideAllRunSurfaces();
    return;
  }

  const surface = runSurfaces.get(visibleRun.id);
  if (!surface) {
    hideAllRunSurfaces();
    return;
  }
  const activeView = surface.view;
  const contentBounds = mainWindow.getContentBounds();
  const x = Math.max(0, Math.min(browserDrawerBounds.x, Math.max(0, contentBounds.width - 1)));
  const y = Math.max(0, Math.min(browserDrawerBounds.y, Math.max(0, contentBounds.height - 1)));
  const width = Math.max(1, Math.min(browserDrawerBounds.width, contentBounds.width - x, MAX_EMBEDDED_VIEW_DIMENSION));
  const height = Math.max(1, Math.min(browserDrawerBounds.height, contentBounds.height - y, MAX_EMBEDDED_VIEW_DIMENSION));
  mainWindow.contentView.addChildView(activeView);
  activeView.setBounds({ x, y, width, height });
  activeView.setVisible(true);

  hideAllRunSurfaces(visibleRun.id);
}

function acquireSchedulerPermit(runId: string): SchedulerPermit | null {
  const state = readState();
  const eligibleSlots = WORKER_SLOT_IDS.slice(0, getMaxParallelRuns(state.config));
  const freeSlotId = eligibleSlots.find((slotId) => {
    const slot = state.scheduler.slots[slotId];
    return slot.state === "idle" && !slot.leaseId && !slot.currentRunId;
  });
  if (!freeSlotId) return null;

  const permitId = crypto.randomUUID();
  const slot = state.scheduler.slots[freeSlotId];
  state.scheduler.queueVersion += 1;
  state.scheduler.slots[freeSlotId] = {
    ...slot,
    leaseId: permitId,
    currentRunId: runId,
    dirty: false,
    state: "leased"
  };
  writeState(state);
  emitRunsUpdated();
  logTelemetry("scheduler_permit_acquired", { runId, permitId, slotId: freeSlotId });
  return { runId, permitId, slotId: freeSlotId };
}

function schedulerPermitMatches(permit: SchedulerPermit): boolean {
  const state = readState();
  const slot = state.scheduler.slots[permit.slotId];
  return slot.leaseId === permit.permitId && slot.currentRunId === permit.runId;
}

function releaseSchedulerPermit(permit: SchedulerPermit): boolean {
  const state = readState();
  const slot = state.scheduler.slots[permit.slotId];
  if (slot.leaseId !== permit.permitId || slot.currentRunId !== permit.runId) {
    return false;
  }
  state.scheduler.queueVersion += 1;
  state.scheduler.slots[permit.slotId] = {
    ...slot,
    leaseId: null,
    currentRunId: null,
    state: "idle"
  };
  writeState(state);
  emitRunsUpdated();
  logTelemetry("scheduler_permit_released", { runId: permit.runId, permitId: permit.permitId, slotId: permit.slotId });
  return true;
}

function releaseSchedulerPermitIdempotent(permit: SchedulerPermit) {
  try {
    if (!releaseSchedulerPermit(permit)) {
      logTelemetry("scheduler_permit_release_noop", { runId: permit.runId, permitId: permit.permitId, slotId: permit.slotId });
    }
  } catch (error) {
    logTelemetry("scheduler_permit_release_failed_nonfatal", { error: error instanceof Error ? error.message : String(error) });
  }
}

function markRunPausedForWindow(run: QueueEntry, stage: "queued" | "running" | "submitting"): QueueEntry {
  const now = new Date().toISOString();
  if (stage === "queued") {
    return {
      ...run,
      status: "paused_app_unavailable" as RunOutcome["status"],
      notes: [...(run.notes ?? []), "window_unavailable:queued"]
    };
  }
  if (stage === "submitting") {
    return {
      ...run,
      status: "unknown_needs_review" as RunOutcome["status"],
      phase: "finalizing",
      finishedAt: now,
      notes: [...(run.notes ?? []), "window_unavailable:submitting"],
      failureDetail: {
        reason: "window_unavailable",
        notes: [...(run.notes ?? []), "window_unavailable", "needs_manual_review"]
      }
    };
  }
  return {
    ...run,
    status: "paused_interrupted" as RunOutcome["status"],
    notes: [...(run.notes ?? []), "window_unavailable:running"]
  };
}

function readSharedResults(outputDir: string): JobRunResult[] {
  const resultsPath = path.join(outputDir, "results.json");
  if (!existsSync(resultsPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(resultsPath, "utf8"));
    return Array.isArray(raw) ? raw as JobRunResult[] : [];
  } catch {
    return [];
  }
}

function appendSharedResult(outputDir: string, result: JobRunResult): Promise<void> {
  sharedHistoryWrite = sharedHistoryWrite.then(async () => {
    mkdirSync(outputDir, { recursive: true });
    const resultsPath = path.join(outputDir, "results.json");
    const current = readSharedResults(outputDir).filter((entry) => {
      return !(entry.url === result.url && entry.startedAt === result.startedAt && entry.finishedAt === result.finishedAt);
    });
    current.unshift(result);
    writeFileSync(resultsPath, JSON.stringify(current, null, 2), "utf8");
  }).catch((error) => {
    console.error("Failed to append shared results history", error);
  });
  return sharedHistoryWrite;
}

function buildWorkerAutomationConfig(input: {
  config: DesktopAutomationConfig;
  resumePath?: string;
  outputDir: string;
  screenshotsDir: string;
  slot: WorkerSlot;
  runId: string;
  apiCookieHeader?: string;
}): AutomationConfig {
  const { config, resumePath, outputDir, screenshotsDir, slot, runId, apiCookieHeader } = input;
  const runMarker = `automa-run-surface-${runId}`;
  const runTitle = `Automa Run Surface ${runId}`;
  return {
    mode: config.mode,
    headless: config.headless,
    timeoutMs: config.timeoutMs,
    outputDir,
    screenshotsDir,
    resumePath,
    ai: {
      provider: normalizeDesktopAiProvider(config.aiProvider),
      model: config.openaiModel,
      openai: {
        apiKeyEnv: config.openaiApiKeyEnv
      },
      ollama: {
        baseUrl: config.ollamaBaseUrl
      },
      automaApi: {
        baseUrl: config.apiBaseUrl,
        cookieHeader: apiCookieHeader
      }
    },
    browser: {
      cdpUrl: `http://127.0.0.1:${readDevToolsPort()}`,
      cdpPageTitle: runTitle,
      cdpPageUrlPattern: runMarker,
      reuseAnchorPage: true,
      embedded: true,
      windowVisibility: config.workerVisibility
    }
  };
}

async function openAutomationBrowser(url?: string) {
  const state = readState();
  const visibleRun = getVisibleRun(state);
  if (visibleRun?.id) {
    await openRunBrowser(visibleRun.id);
    return;
  }
  const firstSurface = Array.from(runSurfaces.values())[0];
  if (!firstSurface) return;
  if (url?.trim()) {
    await firstSurface.view.webContents.loadURL(url.trim());
  }
  if (!browserDrawerBounds || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const contentBounds = mainWindow.getContentBounds();
  const x = Math.max(0, Math.min(browserDrawerBounds.x, Math.max(0, contentBounds.width - 1)));
  const y = Math.max(0, Math.min(browserDrawerBounds.y, Math.max(0, contentBounds.height - 1)));
  const width = Math.max(1, Math.min(browserDrawerBounds.width, contentBounds.width - x, MAX_EMBEDDED_VIEW_DIMENSION));
  const height = Math.max(1, Math.min(browserDrawerBounds.height, contentBounds.height - y, MAX_EMBEDDED_VIEW_DIMENSION));
  mainWindow.contentView.addChildView(firstSurface.view);
  firstSurface.view.setBounds({ x, y, width, height });
  firstSurface.view.setVisible(true);
  hideAllRunSurfaces(firstSurface.runId);
}

function closeAutomationBrowser() {
  hideAllRunSurfaces();
}

async function buildApiCookieHeaderForSession(session: Session | null | undefined, apiBaseUrl: string): Promise<string> {
  if (!session) return "";
  const cookies = await session.cookies.get({ url: apiBaseUrl }).catch(() => []);
  const header = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  if (header.trim()) {
    lastKnownApiCookieHeaders.set(apiBaseUrl, header);
  }
  return header;
}

async function buildApiCookieHeader(apiBaseUrl: string): Promise<string> {
  return await buildApiCookieHeaderForSession(mainWindow?.webContents.session, apiBaseUrl);
}

async function desktopApiRequest<T>(input: {
  apiBaseUrl: string;
  path: string;
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  cookieHeader?: string;
}): Promise<T> {
  const endpoint = new URL(input.path, input.apiBaseUrl.endsWith("/") ? input.apiBaseUrl : `${input.apiBaseUrl}/`);
  const headers = new Headers();
  const suppliedCookieHeader = input.cookieHeader?.trim();
  const cookieHeader =
    suppliedCookieHeader
    || await buildApiCookieHeader(endpoint.origin)
    || lastKnownApiCookieHeaders.get(endpoint.origin)
    || "";
  if (cookieHeader?.trim()) {
    headers.set("Cookie", cookieHeader);
  }
  if (input.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(endpoint, {
    method: input.method ?? (input.body === undefined ? "GET" : "POST"),
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body)
  });

  if (response.ok && input.method === "PATCH" && input.path.includes("/finalize")) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "desktop_finalize_sync_ok",
      data: {
        path: input.path,
        status: response.status,
        hasCookieHeader: Boolean(headers.get("Cookie"))
      }
    }));
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (input.path.includes("/finalize")) {
      console.error("desktop_finalize_sync_failed", {
        path: input.path,
        status: response.status,
        statusText: response.statusText,
        hasCookieHeader: Boolean(headers.get("Cookie")),
        cookieHeaderLength: headers.get("Cookie")?.length ?? 0,
        detail
      });
    }
    throw new DesktopApiError({
      message: `Desktop API request failed (${response.status} ${response.statusText})`.trim(),
      status: response.status,
      statusText: response.statusText,
      detail
    });
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return await response.json() as T;
}

// There are no accounts, so there is nothing to authenticate. A run is allowed
// to start when the local profile and resume exist; executeRun performs that
// check and reports missing_profile / missing_resume, which the UI already
// renders.
async function resolveRunOnboardingProfile(): Promise<UserProfileInput | undefined> {
  return readState().onboarding;
}

function emitRunCompleted(run: QueueEntry) {
  const applied = Boolean(run.submitted || run.submissionConfirmed);
  const label = [run.jobTitle, run.company].filter(Boolean).join(" at ") || run.jobId;
  const message = applied
    ? `Application submitted for ${label}.`
    : run.status === "cancelled"
      ? `Application run cancelled for ${label}.`
      : run.status === "blocked_auth"
        ? `Authentication needed before ${label} can run.`
        : run.status === "failed"
          ? `Application run failed for ${label}.`
          : `Application run finished for ${label}.`;
  const payload: RunCompletionEvent = {
    runId: run.id,
    jobId: run.jobId,
    jobTitle: run.jobTitle,
    company: run.company,
    status: run.status,
    submitted: run.submitted,
    submissionConfirmed: run.submissionConfirmed,
    submitOutcome: run.submitOutcome,
    applied,
    message
  };

  mainWindow?.webContents.send("run:completed", payload);
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: applied ? "Application submitted" : run.status === "blocked_auth" ? "Authentication required" : run.status === "cancelled" ? "Run cancelled" : run.status === "failed" ? "Application failed" : "Run finished",
      body: label
    });
    notification.show();
  }
}

function createQueuedRun(input: {
  jobId: string;
  sourceUrl: string;
  jobTitle?: string;
  company?: string;
  location?: string;
  source?: string;
}): { id: string } {
  // Run ids used to come from the server. They are local now.
  return { id: randomUUID() };
}

function getMaxParallelRuns(config: DesktopAutomationConfig): number {
  return Math.min(WORKER_SLOT_IDS.length, Math.max(1, Math.floor(config.maxParallelRuns || 1)));
}

async function finalizeRun(run: QueueEntry) {
  persistRun(run);
  // A finished run has to land on the tracker. This used to be the cloud API's
  // job and it is the single behaviour most worth preserving from it.
  try {
    if (run.submitted || run.submissionConfirmed || run.status === "completed") {
      recordAppliedJob(run);
    }
  } catch (error) {
    console.error("Failed to record applied job", error);
  }
  emitRunCompleted(run);
}

function markRunCancellationRequested(runId: string) {
  const run = readState().runs.find((entry) => entry.id === runId);
  if (!run) return;

  const notes = run.notes?.includes("run_cancellation_requested")
    ? run.notes
    : [...(run.notes ?? []), "run_cancellation_requested"];

  persistRun({
    ...run,
    status: "cancelled",
    phase: "finalizing",
    browserVisible: false,
    notes
  });

  const worker = workerSessions.get(runId);
  if (worker) {
    worker.browserVisible = false;
    hideAllRunSurfaces();
  }
  void syncEmbeddedBrowserDrawer();
}

function noteWorkerPageReady(runId: string, activePage: ActiveAutomationPage) {
  const existing = workerSessions.get(runId);
  if (!existing) {
    void activePage.close().catch(() => undefined);
    return;
  }
  existing.reveal = async () => {
    if (!schedulerPermitMatches({ runId, slotId: existing.slotId, permitId: existing.leaseId })) {
      const run = readState().runs.find((entry) => entry.id === runId);
      if (run) {
        persistRun({
          ...run,
          notes: [...(run.notes ?? []), "stale_lease_guarded:reveal"]
        });
      }
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    existing.browserVisible = true;
    await activePage.reveal();
    const run = readState().runs.find((entry) => entry.id === runId);
    if (run) {
      persistRun({
        ...run,
        browserVisible: true
      });
    }
    await syncEmbeddedBrowserDrawer();
  };
  existing.cancel = async () => {
    if (!schedulerPermitMatches({ runId, slotId: existing.slotId, permitId: existing.leaseId })) {
      const run = readState().runs.find((entry) => entry.id === runId);
      if (run) {
        persistRun({
          ...run,
          notes: [...(run.notes ?? []), "stale_lease_guarded:cancel"]
        });
      }
      return;
    }
    if (!activePage.page.isClosed()) {
      await activePage.page.close();
    }
  };
  const run = readState().runs.find((entry) => entry.id === runId);
  if (run) {
    persistRun({
      ...run,
      phase: "filling",
      browserVisible: existing.browserVisible
    });
  }
  if (existing.browserVisible) {
    void syncEmbeddedBrowserDrawer().catch(() => undefined);
  }
  if (cancellationRequests.has(runId)) {
    void activePage.close().catch(() => undefined);
  }
}

async function executeRun(permit: SchedulerPermit) {
  const runId = permit.runId;
  const reserved = readState().runs.find((entry) => entry.id === runId);
  const workerSession = workerSessions.get(runId);
  if (!reserved || !workerSession) {
    workerSessions.delete(runId);
    releaseSchedulerPermitIdempotent(permit);
    return;
  }

  const state = readState();
  const config = state.config;
  let onboardingProfile = state.onboarding;
  let run = { ...reserved };
  const provider = detectPlatform(run.sourceUrl);
  const runOutputDirs = getRunOutputDirs(config, run.id);
  const slot = getWorkerSlot(permit.slotId);

  workerSession.provider = provider;

  try {
    if (cancellationRequests.has(runId)) {
      run.status = "cancelled";
      run.phase = "finalizing";
      run.finishedAt = new Date().toISOString();
      run.notes = [...(run.notes ?? []), "run_cancelled_by_user"];
      await finalizeRun(run);
      return;
    }

    onboardingProfile = onboardingProfile ?? await resolveRunOnboardingProfile();
    if (!onboardingProfile) {
      await sleepMs(Number(process.env.AUTOMA_DEBUG_LEASE_DELAY_MS || 0));
      run.status = "failed";
      run.phase = "finalizing";
      run.finishedAt = new Date().toISOString();
      run.failureDetail = {
        reason: "missing_profile",
        notes: ["Finish onboarding before starting automation."]
      };
      await finalizeRun(run);
      return;
    }

    if (!state.resume?.filePath) {
      await sleepMs(Number(process.env.AUTOMA_DEBUG_LEASE_DELAY_MS || 0));
      run.status = "failed";
      run.phase = "finalizing";
      run.finishedAt = new Date().toISOString();
      run.failureDetail = {
        reason: "missing_resume",
        notes: ["Select a local resume before starting automation."]
      };
      await finalizeRun(run);
      return;
    }

    run.provider = provider;
    run.phase = "launching_browser";
    persistRun(run);
    if (!schedulerPermitMatches(permit)) {
      run.notes = [...(run.notes ?? []), "stale_lease_guarded:pre_launch"];
      return;
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      const paused = markRunPausedForWindow(run, "running");
      persistRun(paused);
      return;
    }

    const surface = runSurfaces.get(runId) ?? await createFreshRunSurface({
      runId,
      permitId: permit.permitId,
      slotId: permit.slotId
    });

    const result = await runAutomation({
      config: buildWorkerAutomationConfig({
        config,
        resumePath: state.resume.filePath,
        outputDir: runOutputDirs.outputDir,
        screenshotsDir: runOutputDirs.screenshotsDir,
        slot,
        runId
      }),
      profile: buildAutomationProfile(onboardingProfile),
      resumeText: state.resume.extractedText || onboardingProfile.experience.summary || "",
      targets: [{ url: run.sourceUrl, jobTitle: run.jobTitle, company: run.company }],
      hooks: {
        onActivePage: (activePage) => noteWorkerPageReady(runId, activePage)
      }
    });

    const outcome = result.results[0];
    if (outcome) {
      await appendSharedResult(config.outputDir, outcome);
    }

    run.phase = "finalizing";
    run.status = outcome?.status === "failed" ? "failed" : "completed";
    run.submitted = Boolean(outcome?.submitted);
    run.submissionConfirmed = Boolean(outcome?.submissionConfirmed);
    run.submitOutcome = outcome?.submitOutcome;
    run.notes = outcome?.notes ?? [];
    run.answers = outcome?.answers ?? [];
    run.filledFields = outcome?.filledFields ?? [];
    run.submissionReceipt = outcome?.submissionReceipt;
    run.screenshotPaths = outcome?.screenshotPaths ?? [];
    run.workdayRunSummary = outcome?.workdayRunSummary;
    run.finishedAt = new Date().toISOString();
    if (outcome?.status === "failed") {
      run.failureDetail = {
        reason: outcome.error || outcome.submitOutcome || "automation_failed",
        notes: outcome.notes,
        error: outcome.error
      };
    } else {
      run.failureDetail = undefined;
    }
    if (cancellationRequests.has(run.id) && !run.submitted && !run.submissionConfirmed) {
      run.status = "cancelled";
      run.failureDetail = undefined;
      run.notes = [...run.notes, "run_cancelled_by_user"];
    }
    await finalizeRun(run);
  } catch (error) {
    if (!mainWindow || mainWindow.isDestroyed() || (error instanceof Error && error.message.includes("main window is not ready"))) {
      const stage = run.phase === "submitting" ? "submitting" : "running";
      const paused = markRunPausedForWindow(run, stage);
      persistRun(paused);
      return;
    }
    if (cancellationRequests.has(run.id)) {
      run.status = "cancelled";
      run.phase = "finalizing";
      run.finishedAt = new Date().toISOString();
      run.submitOutcome = run.submitOutcome ?? "not_submitted";
      run.failureDetail = undefined;
      run.notes = [...(run.notes ?? []), "run_cancelled_by_user"];
    } else {
      run.status = "failed";
      run.phase = "finalizing";
      run.finishedAt = new Date().toISOString();
      run.failureDetail = {
        reason: "automation_failed",
        notes: [error instanceof Error ? error.message : "Unknown automation failure."],
        error: error instanceof Error ? error.message : String(error)
      };
      run.notes = [error instanceof Error ? error.message : "Unknown automation failure."];
      run.answers = [];
      run.filledFields = [];
      run.submissionReceipt = undefined;
      run.screenshotPaths = [];
      run.workdayRunSummary = undefined;
    }
    await finalizeRun(run);
  } finally {
    const currentRun = readState().runs.find((entry) => entry.id === run.id);
    if (currentRun?.browserVisible) {
      persistRun({
        ...currentRun,
        browserVisible: false
      });
    }
    hideAllRunSurfaces();
    workerSessions.delete(runId);
    cancellationRequests.delete(runId);
    runApiCookieHeaders.delete(runId);
    destroyRunSurface(runId);
    void syncEmbeddedBrowserDrawer();
    releaseSchedulerPermitIdempotent(permit);
    wakeScheduler("executeRun:finally");
  }
}

async function runSchedulerLoop(_reason: string) {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    do {
      schedulerWakeRequested = false;

      // Resume anything that was paused because the window went away. The old
      // build also paused runs whenever a server session expired; with no
      // accounts that whole recovery path is gone.
      const preState = readState();
      const resumed = preState.runs.map((entry) => {
        const status = entry.status as string;
        if (status !== "paused_app_unavailable") return entry;
        if (!mainWindow || mainWindow.isDestroyed()) return entry;
        return {
          ...entry,
          status: "queued" as RunOutcome["status"],
          phase: "preparing" as RunOutcome["phase"],
          notes: (entry.notes ?? []).filter((note) => !note.startsWith("paused_"))
        };
      });
      if (JSON.stringify(resumed) !== JSON.stringify(preState.runs)) {
        writeRuns(resumed);
      }

      while (true) {
        const state = readState();
        const queued = state.runs.find((entry) => entry.status === "queued");
        if (!queued) break;

        const running = state.runs.filter((entry) => entry.status === "running").length;
        if (running >= getMaxParallelRuns(state.config)) break;

        if (!mainWindow || mainWindow.isDestroyed()) {
          persistRun(markRunPausedForWindow(queued, "queued"));
          break;
        }

        const permit = acquireSchedulerPermit(queued.id);
        if (!permit) break;

        const startIso = queued.startedAt || new Date().toISOString();
        const reserved: QueueEntry = {
          ...queued,
          status: "running",
          phase: "preparing",
          startedAt: startIso,
          workerId: permit.slotId,
          browserVisible: false,
          notes: [...(queued.notes ?? []), `permit_acquired:${permit.permitId}`]
        };
        persistRun(reserved);

        workerSessions.set(reserved.id, {
          runId: reserved.id,
          leaseId: permit.permitId,
          workerId: reserved.workerId || permit.slotId,
          slotId: permit.slotId,
          provider: "unknown",
          browserVisible: false
        });

        try {
          await createFreshRunSurface({ runId: reserved.id, permitId: permit.permitId, slotId: permit.slotId });
        } catch (error) {
          const paused = markRunPausedForWindow(reserved, "queued");
          persistRun(paused);
          workerSessions.delete(reserved.id);
          destroyRunSurface(reserved.id);
          releaseSchedulerPermitIdempotent(permit);
          if (!mainWindow || mainWindow.isDestroyed()) break;
          console.error("Failed to create run surface before execution", error);
          continue;
        }

        void executeRun(permit).catch((error) => {
          console.error("Execute run crashed unexpectedly", error);
        });
      }
    } while (schedulerWakeRequested);
  } finally {
    schedulerRunning = false;
    if (schedulerWakeRequested) {
      wakeScheduler("pending-wake");
    }
  }
}

async function openRunBrowser(runId: string) {
  const session = workerSessions.get(runId);
  if (!session) {
    throw new Error("This run does not have an active browser worker.");
  }
  if (!schedulerPermitMatches({ runId, slotId: session.slotId, permitId: session.leaseId })) {
    throw new Error("This run no longer owns an active worker slot.");
  }

  const state = readState();
  let targetRun: QueueEntry | undefined;
  const nextRuns = state.runs.map((entry) => {
    if (entry.id === runId) {
      targetRun = {
        ...entry,
        browserVisible: true
      };
      return targetRun;
    }
    if (entry.status === "running" && entry.browserVisible) {
      return {
        ...entry,
        browserVisible: false
      };
    }
    return entry;
  });

  if (!targetRun) {
    throw new Error("This run is not available in local state.");
  }

  session.browserVisible = true;
  for (const [candidateRunId, candidateSession] of workerSessions.entries()) {
    if (candidateRunId !== runId) {
      candidateSession.browserVisible = false;
    }
  }
  writeRuns(nextRuns);
  if (session.reveal) {
    await session.reveal();
    return;
  }
  await syncEmbeddedBrowserDrawer();
}

async function closeRunBrowser(runId: string) {
  const session = workerSessions.get(runId);
  if (!session) {
    throw new Error("This run does not have an active browser worker.");
  }
  if (!schedulerPermitMatches({ runId, slotId: session.slotId, permitId: session.leaseId })) {
    return;
  }
  session.browserVisible = false;
  hideAllRunSurfaces();
  const run = readState().runs.find((entry) => entry.id === runId);
  if (run) {
    persistRun({
      ...run,
      browserVisible: false
    });
  }
  await syncEmbeddedBrowserDrawer();
}

function createWindow() {
  const preloadPath = path.join(moduleDir, "preload.cjs");
  const iconPath = resolveAsset("Automa.png");
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 940,
    minWidth: 1180,
    minHeight: 800,
    title: "Automa",
    backgroundColor: "#f5f3ee",
    icon: iconPath,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(rendererDir, "index.html"));
  }
  mainWindow.on("resize", () => {
    void syncEmbeddedBrowserDrawer();
  });
  mainWindow.on("closed", () => {
    browserDrawerBounds = null;
    mainWindow = null;
  });
}

async function pickResumeFile(): Promise<DesktopResumeRecord | null> {
  const options: OpenDialogOptions = {
    title: "Choose your resume",
    properties: ["openFile"],
    filters: [
      {
        name: "Resume files",
        extensions: ["pdf", "doc", "docx", "rtf", "txt"]
      }
    ]
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const resume = createResumeRecord(result.filePaths[0] ?? "");
  const state = readState();
  state.resume = resume;
  writeState(state);
  return resume;
}

async function parseCurrentResume(): Promise<ResumeParseDraft> {
  const state = readState();
  if (!state.resume) {
    throw new Error("Pick a resume before parsing.");
  }
  const parsed = await parseResumeRecord(state.resume, state.config);
  state.resume = {
    ...state.resume,
    extractedText: parsed.extractedText
  };
  writeState(state);
  return parsed;
}

function recoverRunsOnStartup() {
  const state = readState();
  let changed = false;
  const now = new Date().toISOString();
  state.runs = state.runs.map((run) => {
    const runStatus = run.status as string;
    if (
      runStatus === "queued"
      || runStatus === "running"
      || runStatus === "paused_app_unavailable"
      || runStatus === "paused_interrupted"
      || runStatus === "unknown_needs_review"
    ) {
      changed = true;
      return {
        ...run,
        status: "paused_interrupted",
        phase: "preparing",
        workerId: undefined,
        browserVisible: false,
        notes: [...(run.notes ?? []), "startup_recovery:paused_no_autostart"],
        finishedAt: run.finishedAt ?? now
      };
    }
    return run;
  });
  state.scheduler = buildDefaultSchedulerState();
  changed = true;
  if (changed) {
    writeState(state);
    emitRunsUpdated();
  }
}

app.whenReady().then(() => {
  const dockIconPath = resolveAsset("Automa.png");
  if (process.platform === "darwin" && app.dock && existsSync(dockIconPath)) {
    app.dock.setIcon(dockIconPath);
  }
  createWindow();
  recoverRunsOnStartup();

  ipcMain.handle("desktop:get-state", () => readState());

  // ---- job feed ----------------------------------------------------------
  ipcMain.handle("jobs:list", (_event, query: JobQuery = {}) => queryJobs(db(), query));
  ipcMain.handle("jobs:get", (_event, jobId: string) => getJob(db(), String(jobId)));
  ipcMain.handle("jobs:facets", () => jobFacets(db()));
  ipcMain.handle("jobs:feedback", (_event, jobId: string, verdict: "liked" | "hidden" | "saved" | null) => {
    setJobFeedback(db(), String(jobId), verdict);
    return true;
  });
  ipcMain.handle("jobs:sync", async (_event, force?: boolean) => {
    const result = await syncJobFeed(db(), { force: Boolean(force) });
    mainWindow?.webContents.send("jobs:updated", result);
    return result;
  });
  ipcMain.handle("jobs:status", () => feedStatus(db()));

  // ---- tracker -----------------------------------------------------------
  ipcMain.handle("tracker:list", () => listApplied(db()));
  ipcMain.handle("tracker:timeline", (_event, appliedId: string) => listStageEvents(db(), String(appliedId)));
  ipcMain.handle("tracker:move", (_event, appliedId: string, stage: TrackerStage, note?: string) =>
    moveAppliedStage(db(), String(appliedId), stage, note ?? "")
  );
  ipcMain.handle("tracker:notes", (_event, appliedId: string, notes: string) => {
    setAppliedNotes(db(), String(appliedId), String(notes));
    return true;
  });

  // ---- profile and settings ---------------------------------------------
  ipcMain.handle("profile:get", () => getProfile(db()));
  ipcMain.handle("settings:get", (_event, key: string) => getSetting(db(), String(key)));
  ipcMain.handle("settings:set", (_event, key: string, value: string) => {
    setSetting(db(), String(key), String(value));
    return true;
  });

  // ---- guest mode --------------------------------------------------------
  ipcMain.handle("desktop:start-guest", async () => {
    const state = readState();
    const resume = await generateGuestResume();

    state.onboarding = GUEST_PERSONA;
    state.resume = {
      fileName: resume.fileName,
      filePath: resume.filePath,
      mimeType: "application/pdf",
      selectedAt: new Date().toISOString(),
      extractedText: guestResumeText()
    };

    // Demo runs never submit. A fictional persona must not be able to file a
    // real application at a real company.
    state.config = { ...state.config, mode: "dry-run" };
    writeState(state);

    saveProfile(db(), {
      fullName: GUEST_PERSONA.basics.fullName ?? "",
      firstName: GUEST_PERSONA.basics.firstName,
      lastName: GUEST_PERSONA.basics.lastName,
      email: GUEST_PERSONA.basics.email,
      phone: GUEST_PERSONA.basics.phone ?? "",
      location: GUEST_PERSONA.basics.location ?? "",
      links: { ...GUEST_PERSONA.links } as Record<string, unknown>,
      workAuthorization: { ...GUEST_PERSONA.workAuthorization } as Record<string, unknown>,
      education: { ...GUEST_PERSONA.education } as Record<string, unknown>,
      experience: { ...GUEST_PERSONA.experience } as Record<string, unknown>,
      preferences: { ...GUEST_PERSONA.preferences } as Record<string, unknown>,
      demographics: { ...GUEST_DEMOGRAPHICS } as Record<string, unknown>,
      customAnswers: { ...GUEST_PERSONA.customAnswers } as Record<string, unknown>,
      previousEmployers: GUEST_PERSONA.previousEmployers ?? [],
      isDemo: true
    });
    seedDemoJob();
    setSetting(db(), "guest_mode", "1");
    setSetting(db(), "onboarding_completed", "1");

    emitRunsUpdated();
    return readState();
  });
  ipcMain.handle("desktop:is-guest", () => getSetting(db(), "guest_mode") === "1");
  ipcMain.handle("desktop:seed-demo-job", () => {
    seedDemoJob();
    return getJob(db(), DEMO_JOB_ID);
  });
  ipcMain.handle("runs:events", (_event, runId: string, afterId?: number) =>
    listRunEvents(db(), String(runId), Number(afterId ?? 0))
  );
  ipcMain.handle("desktop:save-onboarding", async (_event, profile: UserProfileInput) => {
    const state = readState();
    state.onboarding = profile;
    writeState(state);
    return state.onboarding;
  });
  ipcMain.handle("desktop:save-config", async (_event, config: DesktopAutomationConfig) => {
    const state = readState();
    const normalizedProvider = normalizeDesktopAiProvider(config.aiProvider);
    state.config = {
      ...buildDefaultDesktopConfig(),
      ...config,
      aiProvider: normalizedProvider
    };
    writeState(state);
    return state.config;
  });
  ipcMain.handle("desktop:pick-resume", () => pickResumeFile());
  ipcMain.handle("desktop:parse-resume", () => parseCurrentResume());
  ipcMain.handle("desktop:open-external", async (_event, url: string) => {
    await shell.openExternal(url);
  });
  ipcMain.handle("desktop:open-automation-browser", async (_event, url?: string) => {
    await openAutomationBrowser(url);
  });
  ipcMain.handle("desktop:close-automation-browser", async () => {
    closeAutomationBrowser();
  });
  ipcMain.handle("desktop:set-browser-drawer-bounds", async (_event, bounds: DesktopBrowserDrawerBounds | null) => {
    browserDrawerBounds = normalizeBrowserDrawerBounds(bounds);
    await syncEmbeddedBrowserDrawer();
  });
  ipcMain.handle("desktop:list-runs", () => readState().runs);
  ipcMain.handle("desktop:clear-local-runs", async () => {
    const state = readState();
    const now = new Date().toISOString();
    let changed = false;
    state.runs = state.runs.map((run) => {
      const status = run.status as string;
      if (
        status === "queued"
        || status === "running"
        || status === "paused_app_unavailable"
        || status === "paused_interrupted"
        || status === "unknown_needs_review"
      ) {
        changed = true;
        return {
          ...run,
          status: "cancelled",
          phase: "finalizing",
          finishedAt: run.finishedAt ?? now,
          notes: [...(run.notes ?? []), "manual_clear_local_runs"]
        };
      }
      return run;
    });
    state.scheduler = buildDefaultSchedulerState();
    writeState(state);
    emitRunsUpdated();
    wakeScheduler("manual-clear-local-runs");
    return { cleared: changed, runs: state.runs };
  });
  ipcMain.handle("desktop:open-run-browser", async (_event, runId: string) => {
    await openRunBrowser(runId);
  });
  ipcMain.handle("desktop:close-run-browser", async (_event, runId: string) => {
    await closeRunBrowser(runId);
  });
  ipcMain.handle("desktop:enqueue-run", async (_event, job: {
    id: string;
    sourceUrl: string;
    title?: string;
    company?: string;
    location?: string;
    source?: string;
  }) => {
    const state = readState();
    const created = createQueuedRun({
      jobId: job.id,
      sourceUrl: job.sourceUrl,
      jobTitle: job.title,
      company: job.company,
      location: job.location,
      source: job.source
    });
    const run: QueueEntry = {
      id: created.id,
      jobId: job.id,
      status: "queued",
      phase: "preparing",
      submitted: false,
      submissionConfirmed: false,
      sourceUrl: job.sourceUrl,
      jobTitle: job.title,
      company: job.company,
      location: job.location,
      source: job.source,
      createdAt: new Date().toISOString(),
      notes: []
    };
    state.runs.unshift(run);
    writeState(state);
    emitRunsUpdated();
    wakeScheduler("enqueue-run");
    return run;
  });
  ipcMain.handle("desktop:cancel-run", async (_event, runId: string) => {
    const state = readState();
    const target = state.runs.find((run) => run.id === runId);
    if (target && target.status === "queued") {
      cancellationRequests.delete(runId);
      target.status = "cancelled";
      target.phase = "finalizing";
      target.finishedAt = new Date().toISOString();
      writeState(state);
      emitRunsUpdated();
      await desktopApiRequest({
        apiBaseUrl: state.config.apiBaseUrl,
        path: `runs/${runId}/cancel`,
        method: "POST",
        cookieHeader: runApiCookieHeaders.get(runId)
      }).catch((error) => {
        console.error("Failed to sync run cancellation", error);
      });
      emitRunCompleted(target);
      return;
    }

    if (target && target.status === "running") {
      cancellationRequests.add(runId);
      markRunCancellationRequested(runId);
      const worker = workerSessions.get(runId);
      await worker?.cancel?.().catch((error) => {
        console.error("Failed to cancel worker browser", error);
      });
    }
  });
  ipcMain.handle("desktop:resume-run", async (_event, runId: string) => {
    const state = readState();
    const target = state.runs.find((run) => run.id === runId);
    if (!target) return;
    const targetStatus = target.status as string;
    if (!["paused_app_unavailable", "paused_interrupted", "unknown_needs_review"].includes(targetStatus)) {
      return;
    }
    target.status = "queued";
    target.phase = "preparing";
    target.workerId = undefined;
    target.browserVisible = false;
    target.notes = [...(target.notes ?? []), "manual_resume_requested"];
    writeState(state);
    emitRunsUpdated();
    wakeScheduler("manual-resume");
  });

  wakeScheduler("app-ready");
  setInterval(() => {
    wakeScheduler("heartbeat");
  }, 5000);
});

app.on("before-quit", () => {
  for (const surface of runSurfaces.values()) {
    try {
      if (!surface.view.webContents.isDestroyed()) {
        surface.view.webContents.close({ waitForBeforeUnload: false });
      }
    } catch {
      // no-op
    }
  }
  for (const worker of workerSessions.values()) {
    void worker.cancel?.().catch(() => undefined);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function safelyPauseActiveRuns(reason: string) {
  try {
    const state = readState();
    const updatedRuns: QueueEntry[] = state.runs.map((run) => {
      if (run.status !== "running") return run;
      const stage = run.phase === "submitting" ? "submitting" : "running";
      const paused = markRunPausedForWindow(run, stage);
      return {
        ...paused,
        notes: [...(paused.notes ?? []), `infra_recovery:${reason}`]
      };
    });
    if (JSON.stringify(updatedRuns) !== JSON.stringify(state.runs)) {
      writeRuns(updatedRuns);
    }

    for (const slotId of WORKER_SLOT_IDS) {
      const slotState = readState().scheduler.slots[slotId];
      if (!slotState.currentRunId || !slotState.leaseId) continue;
      const affectedRun = updatedRuns.find((run) => run.id === slotState.currentRunId);
      if (!affectedRun || affectedRun.status === "running") continue;
      releaseSchedulerPermitIdempotent({
        slotId,
        runId: slotState.currentRunId,
        permitId: slotState.leaseId
      });
      setSlotSchedulerState(slotId, { state: "idle" });
    }
  } catch (error) {
    console.error("Failed to pause active runs for recovery", error);
  } finally {
    wakeScheduler(`infra-recovery:${reason}`);
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection in electron main process", reason);
  safelyPauseActiveRuns("unhandledRejection");
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception in electron main process", error);
  safelyPauseActiveRuns("uncaughtException");
});
