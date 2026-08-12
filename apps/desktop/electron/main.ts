import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, Notification, WebContentsView, dialog, ipcMain, safeStorage, shell } from "electron";
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
import {
  appendRunEvent, getProfile, listApplied, listRunEvents, listStageEvents,
  moveAppliedStage, saveProfile, setAppliedNotes, upsertAppliedJob, getSetting,
  setSetting, type TrackerStage
} from "./db/app-repo.js";
import { deleteJobsBySource, getJob, jobFacets, queryJobs, setJobFeedback, upsertJobs, type JobQuery } from "./db/jobs-repo.js";
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
// app.getAppPath() is the app directory in dev and the asar root once packaged.
// Both contain dist/, so this is correct in either case. The earlier bug was
// the subpaths, not this call.
const appRoot = app.getAppPath();
const rendererDir = path.join(appRoot, "dist");

/**
 * Bundled read-only files. electron-builder copies `resources/` next to the
 * asar rather than inside it, so a packaged build must look at
 * process.resourcesPath.
 */
/**
 * The preload sits beside the compiled main process, whose location differs
 * between the tsc dev output and the bundled production output. Deliberately
 * not derived from import.meta.url: esbuild stubs that to undefined in a CJS
 * bundle, which threw before the window was ever created.
 */
function resolvePreload(): string {
  const candidates = [
    path.join(appRoot, "dist-electron", "preload.cjs"),
    path.join(appRoot, "dist-electron", "electron", "preload.cjs")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function resolveResource(...segments: string[]): string {
  const packaged = path.join(process.resourcesPath || "", "resources", ...segments);
  if (existsSync(packaged)) return packaged;
  return path.join(appRoot, "resources", ...segments);
}

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
  notifyRenderer("run:events", { runId, event, data, level, ts: new Date().toISOString() });
}

/**
 * The bundled demo application. Guest mode needs somewhere safe to prove the
 * automation really works: a fictional persona pointed at a real posting would
 * send junk to a real company.
 */
/**
 * Bundled practice applications, used only by the adapter test harness.
 *
 * These are the only end-to-end proof that every adapter works inside the
 * embedded browser surface, which is where four real bugs hid: a background
 * view reports every element as invisible, so anything depending on visibility
 * silently did nothing. A standalone Chromium run cannot reproduce that.
 *
 * They are NOT a product feature. Seeding is gated on AUTOMA_DEV_PRACTICE,
 * which shipped builds never set, so they are unreachable in a real install.
 */
const PRACTICE_JOBS = [
  { id: "00000000-0000-4000-8000-00000000d3m0", file: "greenhouse-practice.html",     platform: "greenhouse",     title: "Software Engineer — practice" },
  { id: "00000000-0000-4000-8000-00000000d3m1", file: "lever-practice.html",          platform: "lever",          title: "Data Analyst — practice" },
  { id: "00000000-0000-4000-8000-00000000d3m2", file: "ashby-practice.html",          platform: "ashby",          title: "Product Engineer — practice" },
  { id: "00000000-0000-4000-8000-00000000d3m3", file: "workday-practice.html",        platform: "workday",        title: "Field Engineer — practice" },
  { id: "00000000-0000-4000-8000-00000000d3m4", file: "workatastartup-practice.html", platform: "workatastartup", title: "Founding Engineer — practice" }
] as const;

export function practiceModeEnabled(): boolean {
  return process.env.AUTOMA_DEV_PRACTICE === "1";
}


function seedPracticeJobs(): void {
  if (!practiceModeEnabled()) return;
  const now = Math.floor(Date.now() / 1000);
  upsertJobs(
    db(),
    PRACTICE_JOBS.map((practice) => {
      const url = `file://${resolveResource("practice", practice.file)}`;
      return {
        simplify_id: practice.id,
        source_repos: ["practice"],
        company_name: "Automa Practice Co",
        company_url: null,
        title: practice.title,
        url,
        dedupe_key: url,
        apply_host: "localhost",
        ats_platform: practice.platform,
        category: "Practice",
        locations: ["Remote"],
        terms: ["Practice"],
        degrees: [],
        sponsorship: null,
        source: "automa-practice",
        feed_active: true,
        is_visible: true,
        date_posted: now,
        date_updated: now,
        content_hash: `practice-${practice.platform}`,
        flags: ["practice"]
      };
    })
  );
}

/**
 * Frees anyone who used the retired demo mode.
 *
 * Demo mode wrote a fictional persona and a generated resume into the same
 * fields real onboarding uses, and forced dry-run. With the demo path deleted,
 * the first-run gate sees a profile and a resume present and never redirects —
 * so that user would be permanently stuck as a fictional candidate, in
 * dry-run, with five practice jobs in their feed and no route back.
 *
 * Clearing the profile drops them into the real first-run flow, which is what
 * they would have got had demo mode never existed.
 */
function migrateAwayFromDemoMode(): void {
  try {
    if (getSetting(db(), "guest_mode") !== "1") return;

    const state = readState();
    state.onboarding = undefined;
    state.resume = undefined;
    state.config = { ...state.config, mode: "auto-submit" };
    writeState(state);

    const removed = deleteJobsBySource(db(), "automa-demo");
    setSetting(db(), "guest_mode", "0");
    setSetting(db(), "onboarding_completed", "0");
    console.log(`Cleared retired demo mode; removed ${removed} practice jobs.`);
  } catch (error) {
    // A failed migration must not stop the app from opening.
    console.error("Could not clear demo mode state", error);
  }
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
/**
 * Geometry for a run surface the user is not watching.
 *
 * This used to be 0x0. That hides the view, but it also gives every element
 * inside it zero width and height, so Playwright's actionability checks decide
 * nothing is visible and refuse to click or fill. Adapters that write through
 * real user-like interaction — Ashby, Lever, Workday, Work at a Startup — then
 * filled nothing, while Greenhouse happened to work because it sets values
 * directly. Standalone the same adapters filled the same forms fine, which is
 * what pointed at the surface rather than the adapters.
 *
 * Keep a realistic viewport and move it outside the window instead, so the
 * layout is real but nothing is drawn on screen.
 */
/**
 * Where a run's browser lives while nobody is watching it.
 *
 * Off-screen rather than hidden, and that distinction is the whole point. A
 * WebContentsView with setVisible(false) reports a 0x0 viewport: window
 * .innerWidth is 0, every container measures zero width, and a responsive site
 * lays out into nothing. Every adapter has been driving real forms in that
 * viewport. Greenhouse and Lever happen to survive it because their extractors
 * key off inputs and ids; Ashby's keys off field containers, which measure zero
 * width, so it found no fields on any live posting.
 *
 * x is far enough left that the view cannot intersect the window on any
 * display, so it stays unseen while Chromium still lays it out at a real size.
 */
const HIDDEN_BROWSER_DRAWER_BOUNDS: Rectangle = { x: -1460, y: 0, width: 1440, height: 1200 };

let mainWindow: BrowserWindow | null = null;
let browserDrawerBounds: Rectangle | null = null;
const cancellationRequests = new Set<string>();
const workerSessions = new Map<string, ActiveWorkerSession>();
const workerSlots = new Map<WorkerSlotId, WorkerSlot>();
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
    mode: "auto-submit",
    headless: false,
    timeoutMs: 60000,
    outputDir,
    screenshotsDir: path.join(outputDir, "screenshots"),
    automationDebugPort: 0,
    automationPartition: EMBEDDED_AUTOMATION_PARTITION,
    aiProvider: "none",
    openaiModel: "gpt-4o-mini",
    openaiApiKeySet: false,
    openaiApiKeyEnv: "OPENAI_API_KEY",
    ollamaBaseUrl: "http://localhost:11434",
    maxParallelRuns: 2,
    workerVisibility: "hidden"
  };
}

/** Anything saved by an older build that named a provider we no longer have. */
/**
 * The OpenAI key, at rest.
 *
 * safeStorage encrypts against the login keychain, so the key is not sitting in
 * plain text in a JSON file that any other program on the Mac can read. On a
 * system where encryption is unavailable it is refused rather than quietly
 * stored in the clear -- a key the user believes is protected and is not is
 * worse than one they know to keep in an environment variable.
 */
function readOpenAiKey(): string {
  const stored = getSetting(db(), "openai_api_key_enc");
  if (!stored) return "";
  if (!safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(stored, "base64"));
  } catch {
    return "";
  }
}

function writeOpenAiKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) {
    setSetting(db(), "openai_api_key_enc", "");
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("This Mac cannot encrypt the key. Set OPENAI_API_KEY in your environment instead.");
  }
  setSetting(db(), "openai_api_key_enc", safeStorage.encryptString(trimmed).toString("base64"));
}

async function resolveRunOnboardingProfile(): Promise<UserProfileInput | undefined> {
  return readState().onboarding;
}

function normalizeDesktopAiProvider(provider: DesktopAutomationConfig["aiProvider"]): DesktopAutomationConfig["aiProvider"] {
  return provider === "openai" || provider === "ollama" ? provider : "none";
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
  // apiBaseUrl named a server this project never had. Dropping it here stops it
  // being written back out on every save and living forever in configs upgraded
  // from an older build.
  const { apiBaseUrl: _removedApiBaseUrl, ...storedConfig } = (source.config ?? {}) as Record<string, unknown>;
  const rawConfig = {
    ...defaults,
    ...(storedConfig as Partial<DesktopAutomationConfig>)
  };
  // Older builds saved aiProvider: "automa_api", which no longer exists.
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

/**
 * Sends to the window, if there is a window able to receive it.
 *
 * Runs keep executing after the window closes -- the app deliberately stays
 * alive on macOS -- so every run update fires into a renderer that may be gone.
 * The optional chain on mainWindow is not enough: a window mid-teardown is
 * non-null with a disposed render frame, and sending to it throws
 * "Render frame was disposed before WebFrameMain could be accessed" from inside
 * a WebContents event handler, where nothing is there to catch it.
 */
function notifyRenderer(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  if (contents.isDestroyed()) return;
  try {
    contents.send(channel, payload);
  } catch {
    // The window went away between the check and the send. Nothing to do: the
    // state is already on disk and the renderer reads it on next launch.
  }
}

function emitRunsUpdated() {
  notifyRenderer("runs:updated", readState().runs);
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
      // Visible, but parked off-screen: hiding it would collapse the viewport
      // to 0x0 and break layout for the form being filled.
      surface.view.setBounds(HIDDEN_BROWSER_DRAWER_BOUNDS);
      surface.view.setVisible(true);
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
  view.setBounds(HIDDEN_BROWSER_DRAWER_BOUNDS);
  view.setVisible(true);

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
        apiKey: readOpenAiKey(),
        apiKeyEnv: config.openaiApiKeyEnv
      },
      ollama: {
        baseUrl: config.ollamaBaseUrl
      },
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

  notifyRenderer("run:completed", payload);
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
    } else if (!run.submitted && (run.filledFields?.length ?? 0) === 0) {
      // The engine reached the page and reported success, but nothing was
      // actually filled. Reporting that as a clean "completed" is exactly the
      // false success this product promises not to give: the user would believe
      // an application had been worked on when it had not. Some forms sit
      // behind an extra step, or render fields the extractor cannot see.
      run.status = "failed";
      run.failureDetail = {
        reason: "no_fields_filled",
        notes: [
          "Automa opened the application but could not find any fields to fill.",
          "This usually means the form is behind another step, or the page renders its fields in a way Automa cannot read yet.",
          "Open it externally and apply by hand.",
          ...(outcome?.notes ?? [])
        ]
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

/**
 * Hands a URL to the user's browser, if it is the kind of URL a browser opens.
 *
 * shell.openExternal passes whatever it is given to the OS, which will happily
 * act on file:, smb: or a custom scheme registered by some other application.
 * The only URLs this app ever needs to open are job postings.
 */
async function openExternalUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  await shell.openExternal(parsed.toString()).catch(() => undefined);
}

function createWindow() {
  const preloadPath = resolvePreload();
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

  // Anything the app asks to open in a new window is an external job posting.
  // Without a handler, Electron's default is "allow", which opens the site in a
  // bare BrowserWindow -- no address bar, no back button, and inheriting this
  // app's webPreferences. Hand it to the real browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: "deny" };
  });

  // A file dropped anywhere outside the drop target would otherwise navigate
  // the window to that file and blank the app.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
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
  migrateAwayFromDemoMode();
  // No-op unless AUTOMA_DEV_PRACTICE=1. Seeding here as well as after
  // onboarding means the harness can run against a pre-seeded state file.
  seedPracticeJobs();
  recoverRunsOnStartup();

  // Keep the job feed fresh from the main process rather than letting a screen
  // trigger it. The renderer used to sync only when the local list came back
  // empty, so once the practice applications were seeded the list was never
  // empty and a fresh install never fetched any real jobs.
  //
  // syncJobFeed enforces its own polite interval, so calling it on every launch
  // and hourly costs nothing when the feeds are unchanged.
  const runFeedSync = (reason: string) => {
    void syncJobFeed(db())
      .then((result) => {
        console.log(`job feed sync (${reason}):`, result.counts.total, "jobs");
        notifyRenderer("jobs:updated", result);
      })
      .catch((error) => console.error(`job feed sync failed (${reason})`, error));
  };

  setTimeout(() => runFeedSync("startup"), 3_000);
  setInterval(() => runFeedSync("hourly"), 60 * 60 * 1000);

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
    notifyRenderer("jobs:updated", result);
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

  ipcMain.handle("runs:events", (_event, runId: string, afterId?: number) =>
    listRunEvents(db(), String(runId), Number(afterId ?? 0))
  );
  ipcMain.handle("desktop:save-onboarding", async (_event, profile: UserProfileInput) => {
    const state = readState();
    state.onboarding = profile;
    writeState(state);

    // Also write the database. Until now only the demo path called saveProfile,
    // so a real user's profile existed solely in automa-state.json while every
    // query read an empty table.
    saveProfile(db(), {
      fullName: profile.basics.fullName ?? `${profile.basics.firstName} ${profile.basics.lastName}`.trim(),
      firstName: profile.basics.firstName,
      lastName: profile.basics.lastName,
      email: profile.basics.email,
      phone: profile.basics.phone ?? "",
      location: profile.basics.location ?? "",
      basics: { ...profile.basics } as Record<string, unknown>,
      locationStructured: { ...(profile.locationStructured ?? {}) } as Record<string, unknown>,
      links: { ...profile.links } as Record<string, unknown>,
      workAuthorization: { ...profile.workAuthorization } as Record<string, unknown>,
      education: { ...profile.education } as Record<string, unknown>,
      experience: { ...profile.experience } as Record<string, unknown>,
      workday: { ...(profile.workday ?? {}) } as Record<string, unknown>,
      logistics: { ...(profile.logistics ?? {}) } as Record<string, unknown>,
      preferences: { ...profile.preferences } as Record<string, unknown>,
      customAnswers: { ...(profile.customAnswers ?? {}) } as Record<string, unknown>,
      previousEmployers: profile.previousEmployers ?? [],
      isDemo: false
    });
    setSetting(db(), "onboarding_completed", "1");

    // Practice applications exist only for the adapter test harness and are
    // gated on AUTOMA_DEV_PRACTICE, which shipped builds never set.
    seedPracticeJobs();

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
  // Returns only what it changed. Returning the whole config would hand the
  // renderer the copy on disk, silently discarding any other setting the user
  // had edited but not yet saved -- including the provider they picked in order
  // to reach this field.
  ipcMain.handle("desktop:set-openai-key", async (_event, key: unknown) => {
    if (typeof key !== "string") throw new Error("Invalid key.");
    writeOpenAiKey(key);
    const stored = Boolean(key.trim());
    const state = readState();
    state.config.openaiApiKeySet = stored;
    writeState(state);
    return { openaiApiKeySet: stored };
  });
  ipcMain.handle("desktop:set-resume-path", (_event, filePath: string) => {
    const resolved = String(filePath ?? "");
    const extension = path.extname(resolved).toLowerCase();
    if (![".pdf", ".doc", ".docx", ".rtf", ".txt"].includes(extension)) {
      throw new Error("That file type is not supported. Use PDF, DOC, DOCX, RTF or TXT.");
    }
    const resume = createResumeRecord(resolved);
    const state = readState();
    state.resume = resume;
    writeState(state);
    return resume;
  });
  ipcMain.handle("desktop:parse-resume", () => parseCurrentResume());
  ipcMain.handle("desktop:open-external", async (_event, url: string) => {
    await openExternalUrl(url);
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

// Without this, Cmd+W is a trap. window-all-closed deliberately keeps the app
// alive on macOS, so closing the window left a process in the Dock with no way
// to get a window back and no way to reach the runs it was still executing.
app.on("activate", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createWindow();
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
