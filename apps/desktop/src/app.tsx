import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowUpRight,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  CheckCircle2,
  Eye,
  EyeOff,
  FileText,
  Loader2,
  ListChecks,
  LogOut,
  Mail,
  MessageSquarePlus,
  MoveRight,
  Plus,
  PlayCircle,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Users,
  X
} from "lucide-react";
import type {
  AppliedJobDetailRecord,
  AppliedJobRecord,
  ApplicationContactTarget,
  ApplicationMessageDraft,
  ApplicationTrackerStage,
  JobFeedItem,
  RunCompletionEvent,
  RunOutcome,
  UserProfileInput
} from "@automa/shared-types";
import {
  AuthLayoutShell,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Progress,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  Textarea,
  useSidebar,
  WorkspaceFrame
} from "./ui/index.js";
import FixedHeaderFooterTable, { type FixedHeaderFooterTableItem, type JobTableFeedback } from "./components/ui/fixed-header-footer-table.js";
import { AsciiLogoViewer } from "./components/ui/ascii-logo-viewer.js";
import BackButton from "./components/ui/back-button.js";
import ConfirmCancelButton from "./components/ui/confirm-cancel-button.js";
import FeedbackWidget from "./components/ui/feedback-widget.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip.js";
import type { DesktopAutomationConfig, DesktopBrowserDrawerBounds, DesktopResumeRecord, ResumeParseDraft } from "./desktop-types.js";
import { cn } from "./lib/utils.js";

const DEFAULT_API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

type SessionState = {
  loading: boolean;
  user: { id: string; email: string; onboardingCompleted: boolean } | null;
};

type DesktopState = {
  onboarding?: UserProfileInput;
  resume?: DesktopResumeRecord;
  runs: RunOutcome[];
  config: DesktopAutomationConfig;
};

type AppliedJobsState = {
  appliedJobs: AppliedJobRecord[];
  loading: boolean;
  error: string | null;
};

type AppliedJobDetailState = {
  application: AppliedJobDetailRecord | null;
  loading: boolean;
  error: string | null;
};

type ToastItem = {
  id: string;
  tone: "success" | "error" | "neutral";
  message: string;
};

function createFallbackConfig(): DesktopAutomationConfig {
  return {
    apiBaseUrl: DEFAULT_API_BASE_URL,
    mode: "auto-submit",
    headless: false,
    timeoutMs: 60000,
    outputDir: "",
    screenshotsDir: "",
    automationDebugPort: 9223,
    automationPartition: "persist:automa-automation",
    aiProvider: "automa_api",
    openaiModel: "gpt-4o-mini",
    openaiApiKeyEnv: "OPENAI_API_KEY",
    ollamaBaseUrl: "http://localhost:11434",
    maxParallelRuns: 2,
    workerVisibility: "hidden"
  };
}

function createEmptyProfile(): UserProfileInput {
  return {
    basics: {
      firstName: "",
      lastName: "",
      fullName: "",
      email: "",
      phone: "",
      location: ""
    },
    links: {},
    workAuthorization: {
      authorizedToWork: true,
      requiresSponsorship: false
    },
    education: {},
    experience: {},
    preferences: {
      desiredRoles: [],
      desiredLocations: [],
      employmentTypes: ["full-time"],
      remoteOnly: true
    }
  };
}

function normalizeProfile(profile?: UserProfileInput): UserProfileInput {
  if (!profile) return createEmptyProfile();
  return {
    ...createEmptyProfile(),
    ...profile,
    basics: {
      ...createEmptyProfile().basics,
      ...profile.basics
    },
    links: {
      ...createEmptyProfile().links,
      ...profile.links
    },
    workAuthorization: {
      ...createEmptyProfile().workAuthorization,
      ...profile.workAuthorization
    },
    education: {
      ...createEmptyProfile().education,
      ...profile.education
    },
    experience: {
      ...createEmptyProfile().experience,
      ...profile.experience
    },
    preferences: {
      ...createEmptyProfile().preferences,
      ...profile.preferences
    }
  };
}

function formatProviderLabel(source: string) {
  return source === "greenhouse" ? "Greenhouse" : source === "ashby" ? "Ashby" : source;
}

function formatFeedReason(reason: JobFeedItem["feedReason"]) {
  return reason.replaceAll("_", " ");
}

function formatPostedAt(postedAt?: string) {
  if (!postedAt) return "Unknown";
  const parsed = new Date(postedAt);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function formatPhase(phase: RunOutcome["phase"]) {
  return phase.replaceAll("_", " ");
}

function formatRunStatus(status: RunOutcome["status"]) {
  return status.replaceAll("_", " ");
}

function formatDateTime(value?: string) {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatDuration(startedAt?: string, finishedAt?: string) {
  if (!startedAt || !finishedAt) return "In progress";
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "Unknown";
  const totalSeconds = Math.round((end - start) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatRunOutcomeLabel(run: RunOutcome) {
  const status = run.status as string;
  if (run.submissionConfirmed || run.submitted) return "Submitted";
  const submitOutcomeLabel = formatSubmissionOutcomeLabel(run.submitOutcome);
  if (submitOutcomeLabel === "Submitted") return "Submitted";
  if (status === "blocked_auth") return "Authentication required";
  if (status === "paused_app_unavailable" || status === "paused_interrupted") return "Paused";
  if (status === "unknown_needs_review") return "Needs review";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return formatRunStatus(run.status);
}

function formatSubmissionOutcomeLabel(outcome?: string | null) {
  if (!outcome) return null;
  const normalized = outcome.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (!normalized) return null;
  if (
    normalized === "submitted" ||
    normalized === "confirmed" ||
    normalized === "cofirmed" ||
    normalized === "completed"
  ) {
    return "Submitted";
  }
  return titleizeSlug(normalized);
}

function formatRunFinishedLabel(value?: string) {
  if (!value) return "In progress";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  const now = new Date();
  const sameDay = parsed.toDateString() === now.toDateString();
  if (sameDay) {
    return parsed.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit"
    });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (parsed.toDateString() === yesterday.toDateString()) {
    return "Yesterday";
  }
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
}

function titleizeSlug(value: string) {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function deriveRunCompanyLabel(run: RunOutcome) {
  if (run.company?.trim()) return run.company.trim();
  if (!run.sourceUrl) return run.jobTitle || "Automation run";
  try {
    const url = new URL(run.sourceUrl);
    const ignoredSegments = new Set([
      "jobs",
      "job",
      "embed",
      "job_app",
      "recruiting",
      "application",
      "applications",
      "details",
      "viewjob",
      "jobdetails"
    ]);
    const pathCandidate = url.pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).trim())
      .find((segment) =>
        segment &&
        /[a-z]/i.test(segment) &&
        !ignoredSegments.has(segment.toLowerCase()) &&
        !/^[0-9-]+$/.test(segment) &&
        !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(segment)
      );
    if (pathCandidate) return titleizeSlug(pathCandidate);

    const hostCandidate = url.hostname
      .split(".")
      .find((segment) => segment && !["www", "jobs", "job", "boards", "careers", "apply", "wd1", "wd2"].includes(segment.toLowerCase()));
    if (hostCandidate) return titleizeSlug(hostCandidate);
  } catch {
    return run.jobTitle || "Automation run";
  }
  return run.jobTitle || "Automation run";
}

function getRunStatusBadge(run: RunOutcome) {
  const status = run.status as string;
  if (status === "running") {
    return { label: "Running", className: "desktop-run-badge desktop-run-badge--running" };
  }
  if (status === "queued") {
    return { label: "Queued", className: "desktop-run-badge desktop-run-badge--running" };
  }
  if (status === "completed") {
    return {
      label: run.submissionConfirmed ? "Submitted" : run.submitted ? "Submitted" : "Completed",
      className: "desktop-run-badge desktop-run-badge--completed"
    };
  }
  if (status === "blocked_auth") {
    return {
      label: "Auth required",
      className: "desktop-run-badge desktop-run-badge--failed"
    };
  }
  if (status === "paused_app_unavailable" || status === "paused_interrupted") {
    return {
      label: "Paused",
      className: "desktop-run-badge desktop-run-badge--failed"
    };
  }
  if (status === "unknown_needs_review") {
    return {
      label: "Needs review",
      className: "desktop-run-badge desktop-run-badge--failed"
    };
  }
  return {
    label: status === "cancelled" ? "Cancelled" : "Failed",
    className: "desktop-run-badge desktop-run-badge--failed"
  };
}

function formatSubmissionReceiptSource(source: "review_receipt" | "filled_fields" | "answers") {
  if (source === "review_receipt") return "review receipt";
  if (source === "filled_fields") return "filled fields";
  return "resolved answers";
}

function formatAppliedAt(value?: string) {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function formatApplicationTrackerStage(stage: ApplicationTrackerStage) {
  if (stage === "interview") return "Interview";
  if (stage === "offer") return "Offer";
  if (stage === "rejected") return "Rejected";
  return "Applied";
}

function getAppliedStageBadge(stage: ApplicationTrackerStage) {
  if (stage === "interview") {
    return {
      label: "Interview",
      className: "desktop-applied-stage-badge desktop-applied-stage-badge--interview"
    };
  }
  if (stage === "offer") {
    return {
      label: "Offer",
      className: "desktop-applied-stage-badge desktop-applied-stage-badge--offer"
    };
  }
  if (stage === "rejected") {
    return {
      label: "Rejected",
      className: "desktop-applied-stage-badge desktop-applied-stage-badge--rejected"
    };
  }
  return {
    label: "Applied",
    className: "desktop-applied-stage-badge desktop-applied-stage-badge--applied"
  };
}

function createEmptyContactTarget(): ApplicationContactTarget {
  return {
    id: crypto.randomUUID(),
    name: "",
    title: "",
    channel: "",
    profileUrl: "",
    note: ""
  };
}

function createEmptyMessageDraft(): ApplicationMessageDraft {
  return {
    id: crypto.randomUUID(),
    title: "",
    body: "",
    channel: ""
  };
}

function moveAppliedJobToStage(
  jobs: AppliedJobRecord[],
  appliedJobId: string,
  targetStage: ApplicationTrackerStage
) {
  const nextJobs = jobs.map((job) => ({ ...job }));
  const current = nextJobs.find((job) => job.id === appliedJobId);
  if (!current || current.trackerStage === targetStage) return nextJobs;
  const nextOrder = nextJobs
    .filter((job) => job.id !== appliedJobId && job.trackerStage === targetStage)
    .reduce((highest, job) => Math.max(highest, job.trackerOrder), -1) + 1;
  current.trackerStage = targetStage;
  current.trackerOrder = nextOrder;
  current.updatedAt = new Date().toISOString();
  return nextJobs;
}

function getRunReceiptRows(run?: RunOutcome | null) {
  if (!run) return [];
  if (run.submissionReceipt) {
    return run.submissionReceipt.items.map((item, index) => ({
      id: `receipt:${index}:${item.question}`,
      section: item.section,
      label: item.question,
      value: item.answer,
      context: formatSubmissionReceiptSource(run.submissionReceipt!.source),
      fillMethod: "Captured"
    }));
  }
  return (run.filledFields ?? []).map((field) => ({
    id: `${field.id}:${field.label}`,
    section: undefined,
    label: field.label,
    value: field.value || "Empty",
    context: "Filled field",
    fillMethod: titleizeSlug(field.source)
  }));
}

function getRunProgress(run?: RunOutcome) {
  if (!run) return 0;
  if (run.status === "queued") return 16;
  if (run.phase === "launching_browser") return 32;
  if (run.phase === "filling") return 62;
  if (run.phase === "submitting") return 82;
  if (run.phase === "finalizing") return 94;
  if (run.status === "blocked_auth") return 100;
  return 100;
}

function getActiveVisibleRun(runs: RunOutcome[]) {
  return runs.find((run) => run.status === "running" && run.browserVisible);
}

// ---------------------------------------------------------------------------
// Local data bridge
//
// Every screen used to talk HTTP to a Fastify server. There is no server now:
// these adapters convert what the main process returns over IPC into the shapes
// the screens already render, so the UI did not have to be rewritten.
// ---------------------------------------------------------------------------

type TrackerStageName = "saved" | "applied" | "interviewing" | "offer" | "rejected";

interface LocalJobRecord {
  simplifyId: string;
  company: string;
  title: string;
  url: string;
  platform: string;
  automatable: boolean;
  category: string | null;
  locations: string[];
  terms: string[];
  sponsorship: string | null;
  datePosted: number | null;
  feedback: "liked" | "hidden" | "saved" | null;
  applied: boolean;
  support: "verified" | "experimental" | "generic";
}

interface LocalAppliedRecord {
  id: string;
  jobId: string;
  runId: string | null;
  sourceUrl: string;
  title: string;
  company: string;
  location: string;
  source: string;
  stage: TrackerStageName;
  notes: string;
  appliedAt: string;
  updatedAt: string;
}

interface LocalBridge {
  listJobs(query: Record<string, unknown>): Promise<{ jobs: LocalJobRecord[]; total: number }>;
  setJobFeedback(jobId: string, verdict: "liked" | "hidden" | "saved" | null): Promise<boolean>;
  syncJobs(force?: boolean): Promise<unknown>;
  jobsStatus(): Promise<unknown>;
  listApplied(): Promise<LocalAppliedRecord[]>;
  moveApplied(id: string, stage: TrackerStageName, note?: string): Promise<unknown>;
  setAppliedNotes(id: string, notes: string): Promise<boolean>;
  appliedTimeline(id: string): Promise<Array<{ from: string | null; to: string; note: string; at: string }>>;
  startGuest(): Promise<DesktopState>;
  isGuest(): Promise<boolean>;
}

const bridge = (typeof window !== "undefined" && window.automaDesktop
  ? (window.automaDesktop as unknown as LocalBridge)
  : {
      listJobs: async () => ({ jobs: [], total: 0 }),
      setJobFeedback: async () => true,
      syncJobs: async () => undefined,
      jobsStatus: async () => undefined,
      listApplied: async () => [],
      moveApplied: async () => undefined,
      setAppliedNotes: async () => true,
      appliedTimeline: async () => [],
      startGuest: async () => ({ runs: [], config: createFallbackConfig() }) as DesktopState,
      isGuest: async () => false
    }) as LocalBridge;

/** One short, honest line about what Automa can do with this posting. */
function describeJobSupport(support?: string): string {
  if (support === "verified") return "Fills automatically";
  if (support === "experimental") return "Partial — check it";
  return "You finish it";
}

/** A stored job as the jobs screen wants it. */
function toJobFeedItem(job: LocalJobRecord): JobFeedItem {
  const tags = [job.category, ...job.terms].filter((tag): tag is string => Boolean(tag));
  return {
    id: job.simplifyId,
    sourceUrl: job.url,
    title: job.title,
    company: job.company,
    location: job.locations[0] ?? "",
    source: job.platform,
    postedAt: job.datePosted ? new Date(job.datePosted * 1000).toISOString() : undefined,
    // Say plainly whether an adapter can drive this one. About 40% of listings
    // are company career sites where the generic adapter often needs a human,
    // and implying otherwise would set the wrong expectation.
    // Say exactly what is known about this platform. Overstating it would let a
    // user believe an application was filled when it was not.
    summary: (() => {
      const label = formatProviderLabel(job.platform);
      if (job.support === "verified") return `Automa fills ${label} applications end to end.`;
      if (job.support === "experimental") {
        return `${label} support is experimental. Automa opens the form and fills what it can — check it before you rely on it.`;
      }
      return "Company career site. Automa will fill what it can, but you will probably need to finish it.";
    })(),
    compensation: job.sponsorship ?? undefined,
    roleTags: tags.slice(0, 6),
    feedReason: "role_match",
    feedback: job.feedback === "liked" ? "up" : job.feedback === "hidden" ? "down" : null
  };
}

function toAppliedRecord(applied: LocalAppliedRecord): AppliedJobRecord {
  return {
    id: applied.id,
    userId: "local",
    jobId: applied.jobId,
    runId: applied.runId ?? "",
    sourceUrl: applied.sourceUrl,
    title: applied.title,
    company: applied.company,
    location: applied.location,
    source: applied.source,
    appliedAt: applied.appliedAt,
    trackerStage: applied.stage as ApplicationTrackerStage,
    trackerOrder: 0
  } as AppliedJobRecord;
}

/** Rebuilds the detail view from the tracker row plus its stage history. */
async function loadApplicationDetail(appliedJobId: string) {
  const [applied, timeline] = await Promise.all([
    bridge.listApplied(),
    bridge.appliedTimeline(appliedJobId)
  ]);
  const row = applied.find((entry) => entry.id === appliedJobId);
  if (!row) return null;

  let stored: { insightsSummary?: string; contactTargets?: unknown[]; messageDrafts?: unknown[] } = {};
  try {
    stored = row.notes ? JSON.parse(row.notes) : {};
  } catch {
    stored = {};
  }

  return {
    appliedJob: toAppliedRecord(row),
    insightsSummary: stored.insightsSummary ?? "",
    contactTargets: (stored.contactTargets ?? []) as ApplicationContactTarget[],
    messageDrafts: (stored.messageDrafts ?? []) as ApplicationMessageDraft[],
    timeline: timeline.map((entry) => ({
      stage: entry.to,
      note: entry.note,
      occurredAt: entry.at
    }))
  } as never;
}

const desktopBridge = typeof window !== "undefined" && window.automaDesktop
  ? window.automaDesktop
  : {
      getState: async () => ({ runs: [], config: createFallbackConfig() }),
      saveOnboarding: async () => undefined,
      saveConfig: async (config: DesktopAutomationConfig) => config,
      pickResume: async () => null,
      parseResume: async () => ({
        profile: createEmptyProfile(),
        extractedText: "",
        warnings: ["Resume parsing is unavailable in browser-only mode."]
      } satisfies ResumeParseDraft),
      openExternal: async (url: string) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
      openAutomationBrowser: async (url?: string) => {
        if (url) {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      },
      closeAutomationBrowser: async () => undefined,
      setBrowserDrawerBounds: async (_bounds?: DesktopBrowserDrawerBounds | null) => undefined,
      listRuns: async () => [],
      openRunBrowser: async () => undefined,
      closeRunBrowser: async () => undefined,
      enqueueRun: async () => undefined,
      cancelRun: async () => undefined,
      resumeRun: async () => undefined,
      onRunsUpdated: () => () => undefined,
      onRunCompleted: () => () => undefined
    };

function useSession(desktopState: DesktopState) {
  return useMemo<SessionState>(() => {
    const onboarding = desktopState.onboarding;
    if (!onboarding) return { loading: false, user: null };
    return {
      loading: false,
      user: {
        id: "local",
        email: onboarding.basics?.email || "local@automa.app",
        onboardingCompleted: Boolean(onboarding && desktopState.resume)
      }
    };
  }, [desktopState.onboarding, desktopState.resume]);
}

function InlineBrowserDrawer({
  run
}: {
  run?: RunOutcome;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!run) {
      void desktopBridge.setBrowserDrawerBounds(null);
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) {
      void desktopBridge.setBrowserDrawerBounds(null);
      return;
    }

    let frameId = 0;
    const syncBounds = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        const rect = viewport.getBoundingClientRect();
        const bounds: DesktopBrowserDrawerBounds | null = rect.width > 0 && rect.height > 0
          ? {
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height
            }
          : null;
        void desktopBridge.setBrowserDrawerBounds(bounds);
      });
    };

    syncBounds();
    const resizeObserver = new ResizeObserver(() => syncBounds());
    resizeObserver.observe(viewport);
    window.addEventListener("resize", syncBounds);

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      window.removeEventListener("resize", syncBounds);
      void desktopBridge.setBrowserDrawerBounds(null);
    };
  }, [run?.id, run?.workerId, run?.browserVisible]);

  if (!run) return null;

  const providerLabel = run.source ? formatProviderLabel(run.source) : "Automation";
  const workerLabel = run.workerId ? run.workerId.toUpperCase() : "Worker";

  return (
    <aside className="desktop-inline-browser" aria-label={`In-app browser for ${run.jobTitle || deriveRunCompanyLabel(run)}`}>
      <div className="desktop-inline-browser__header">
        <div className="desktop-inline-browser__meta">
          <span className="desktop-inline-browser__eyebrow">In-app browser</span>
          <div className="desktop-inline-browser__title-row">
            <span className="desktop-inline-browser__title">{run.jobTitle || deriveRunCompanyLabel(run)}</span>
            <Badge variant="secondary" className="rounded-none">{workerLabel}</Badge>
          </div>
          <div className="desktop-inline-browser__subtitle">
            {run.company ? `${run.company} · ` : ""}
            {providerLabel}
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          className="rounded-none"
          onClick={() => void desktopBridge.closeRunBrowser(run.id)}
        >
          <X className="size-4" />
          Close
        </Button>
      </div>
      <div ref={viewportRef} className="desktop-inline-browser__viewport">
        <div className="desktop-inline-browser__viewport-state">
          Automa keeps this browser surface inside the app and swaps it between active worker slots.
        </div>
      </div>
    </aside>
  );
}

function useDesktopState() {
  const [state, setState] = useState<DesktopState>({
    runs: [],
    config: createFallbackConfig()
  });

  useEffect(() => {
    void desktopBridge.getState().then((next) => {
      const loaded = next as Partial<DesktopState>;
      setState({
        runs: Array.isArray(loaded.runs) ? loaded.runs : [],
        onboarding: loaded.onboarding,
        resume: loaded.resume,
        config: loaded.config ? { ...createFallbackConfig(), ...loaded.config } : createFallbackConfig()
      });
    });
    return desktopBridge.onRunsUpdated((runs) => {
      setState((current) => ({ ...current, runs: runs as RunOutcome[] }));
    });
  }, []);

  return [state, setState] as const;
}

function useAppliedJobs(apiBaseUrl: string, enabled: boolean) {
  const [state, setState] = useState<AppliedJobsState>({
    appliedJobs: [],
    loading: enabled,
    error: null
  });

  const refresh = useCallback(async () => {
    if (!enabled) {
      setState({ appliedJobs: [], loading: false, error: null });
      return;
    }

    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const applied = await bridge.listApplied();
      setState({
        appliedJobs: applied.map(toAppliedRecord),
        loading: false,
        error: null
      });
    } catch (error) {
      setState({
        appliedJobs: [],
        loading: false,
        error: error instanceof Error ? error.message : "Unable to load applied jobs."
      });
    }
  }, [apiBaseUrl, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    ...state,
    refresh
  };
}

function useAppliedJobDetail(apiBaseUrl: string, appliedJobId: string | undefined, enabled: boolean) {
  const [state, setState] = useState<AppliedJobDetailState>({
    application: null,
    loading: enabled,
    error: null
  });

  const refresh = useCallback(async () => {
    if (!enabled || !appliedJobId) {
      setState({ application: null, loading: false, error: null });
      return;
    }

    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const application = await loadApplicationDetail(appliedJobId);
      setState({
        application,
        loading: false,
        error: null
      });
    } catch (error) {
      setState({
        application: null,
        loading: false,
        error: error instanceof Error ? error.message : "Unable to load tracked application."
      });
    }
  }, [apiBaseUrl, appliedJobId, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    ...state,
    refresh
  };
}

function AppSidebar({ runCount, appliedCount }: { runCount?: number; appliedCount?: number }) {
  const location = useLocation();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Navigation</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Jobs" size="sm" isActive={location.pathname === "/jobs"} asChild>
              <Link to="/jobs">
                <BriefcaseBusiness />
                <span>Jobs</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Runs" size="sm" isActive={location.pathname.startsWith("/runs")} asChild>
              <Link to="/runs">
                <PlayCircle />
                <span>Runs</span>
                {typeof runCount === "number" && runCount > 0 ? <SidebarMenuBadge>{runCount}</SidebarMenuBadge> : null}
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Applied" size="sm" isActive={location.pathname.startsWith("/applied")} asChild>
              <Link to="/applied">
                <CheckCircle2 />
                <span>Applied</span>
                {typeof appliedCount === "number" && appliedCount > 0 ? <SidebarMenuBadge>{appliedCount}</SidebarMenuBadge> : null}
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Settings" size="sm" isActive={location.pathname === "/settings"} asChild>
              <Link to="/settings">
                <Settings />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function SidebarLogo() {
  return (
    <span className="relative block size-8 shrink-0 overflow-hidden">
      <img
        src="./Automa-B-NBG.png"
        alt="Automa"
        className="pointer-events-none h-full w-full object-contain dark:hidden"
      />
      <img
        src="./Automa-NBG.png"
        alt="Automa"
        className="pointer-events-none hidden h-full w-full object-contain dark:block"
      />
    </span>
  );
}

function SidebarBrand() {
  const navigate = useNavigate();
  const { isMobile, setOpen, state } = useSidebar();
  const isCollapsed = !isMobile && state === "collapsed";

  if (isCollapsed) {
    return (
      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Open sidebar"
              className="size-8 cursor-pointer border-0 bg-transparent p-0 text-sidebar-foreground outline-hidden"
              onClick={() => setOpen(true)}
            >
              <SidebarLogo />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" align="center">
            Open sidebar
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2">
      <button
        type="button"
        aria-label="Go to Jobs"
        className="flex min-w-0 items-center rounded-md p-1 text-sidebar-foreground ring-sidebar-ring outline-hidden transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2"
        onClick={() => navigate("/jobs")}
      >
        <SidebarLogo />
      </button>
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <SidebarTrigger className="shrink-0 cursor-pointer" />
          </TooltipTrigger>
          <TooltipContent side="right" align="center">
            Close sidebar
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function SidebarFooterPanel({ session }: { session?: SessionState["user"] | null }) {
  const navigate = useNavigate();
  const { isMobile, state } = useSidebar();
  const isCollapsed = !isMobile && state === "collapsed";
  const profileLabel = session?.email || "Local desktop user";
  const profileInitial = profileLabel.trim().charAt(0).toUpperCase() || "A";
  const quickActions = [
    {
      label: "Edit profile",
      icon: FileText,
      onClick: () => navigate("/onboarding")
    }
  ];

  if (isCollapsed) {
    return (
      <div className="desktop-sidebar-footer desktop-sidebar-footer--collapsed">
        <div className="desktop-sidebar-footer__icon-menu">
          {quickActions.map((action) => {
            const Icon = action.icon;
            return (
              <Tooltip key={action.label}>
                <TooltipTrigger asChild>
                  <button type="button" className="desktop-sidebar-footer__icon-action" onClick={action.onClick} aria-label={action.label}>
                    <Icon className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" align="center">
                  {action.label}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="desktop-sidebar-footer__icon-profile" onClick={() => navigate("/settings")} aria-label={profileLabel}>
              <span className="desktop-sidebar-footer__avatar" aria-hidden="true">
                {profileInitial}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" align="center">
            {profileLabel}
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="desktop-sidebar-footer group-data-[collapsible=icon]:hidden">
      <SidebarGroup className="p-0">
        
        <SidebarGroupContent>
          <SidebarMenu>
          {quickActions.map((action) => {
            const Icon = action.icon;
            return (
              <SidebarMenuItem key={action.label}>
                <SidebarMenuButton type="button" size="sm" onClick={action.onClick}>
                  <Icon />
                  <span>{action.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <button type="button" className="desktop-sidebar-footer__profile" onClick={() => navigate("/settings")}>
        <div className="desktop-sidebar-footer__avatar" aria-hidden="true">
          {profileInitial}
        </div>
        <div className="desktop-sidebar-footer__profile-text">{profileLabel}</div>
      </button>
    </div>
  );
}

type OnboardingStep = 0 | 1 | 2;

const ONBOARDING_STEPS = [
  { title: "About you", hint: "Used to fill the name, email and phone fields every application asks for." },
  { title: "Eligibility and education", hint: "Answers the work authorization and school questions." },
  { title: "Resume", hint: "Uploaded to the application and used to answer written questions." }
] as const;

/**
 * First run. There is no sign-in, so this is the only gate: fill in a profile,
 * or load the demo persona and skip straight to the product.
 */
function OnboardingPage({
  desktopState,
  setDesktopState,
  onNotify
}: {
  desktopState: DesktopState;
  setDesktopState: React.Dispatch<React.SetStateAction<DesktopState>>;
  onNotify: (toast: Omit<ToastItem, "id">) => void;
}) {
  const navigate = useNavigate();
  const [step, setStep] = useState<OnboardingStep>(0);
  const [profile, setProfile] = useState<UserProfileInput>(() => normalizeProfile(desktopState.onboarding));
  const [resume, setResume] = useState<DesktopResumeRecord | undefined>(desktopState.resume);
  const [busy, setBusy] = useState<null | "guest" | "resume" | "save">(null);
  const [error, setError] = useState<string | null>(null);

  const setBasics = (patch: Partial<UserProfileInput["basics"]>) =>
    setProfile((prev) => ({ ...prev, basics: { ...prev.basics, ...patch } }));

  const startGuest = async () => {
    setBusy("guest");
    setError(null);
    try {
      const state = await (desktopBridge as unknown as { startGuest: () => Promise<DesktopState> }).startGuest();
      setDesktopState(state);
      onNotify({
        tone: "success",
        message: "Demo profile loaded. Alex Rivera is fictional, and demo runs never submit."
      });
      navigate("/jobs", { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the demo profile.");
    } finally {
      setBusy(null);
    }
  };

  const pickResume = async () => {
    setBusy("resume");
    setError(null);
    try {
      const picked = await desktopBridge.pickResume();
      if (!picked) return;
      setResume(picked);
      // Parsing is a convenience: it pre-fills fields the user can correct. A
      // parse failure must never block finishing onboarding.
      try {
        const draft = await desktopBridge.parseResume();
        if (draft?.profile) {
          setProfile((prev) => mergeParsedProfile(prev, draft.profile));
          if (draft.warnings?.length) {
            onNotify({ tone: "neutral", message: `Resume read with warnings: ${draft.warnings[0]}` });
          }
        }
      } catch {
        onNotify({
          tone: "neutral",
          message: "Could not read the resume text. The file is attached; you can fill the fields yourself."
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open that file.");
    } finally {
      setBusy(null);
    }
  };

  const finish = async () => {
    setBusy("save");
    setError(null);
    try {
      const saved = await desktopBridge.saveOnboarding(profile);
      setDesktopState((prev) => ({ ...prev, onboarding: (saved as UserProfileInput | undefined) ?? profile, resume }));
      navigate("/jobs", { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save your profile.");
    } finally {
      setBusy(null);
    }
  };

  const stepValid = (() => {
    if (step === 0) return Boolean(profile.basics.firstName.trim() && profile.basics.lastName.trim() && profile.basics.email.trim());
    if (step === 1) return Boolean(profile.education.school || profile.education.university);
    return Boolean(resume?.filePath);
  })();

  const current = ONBOARDING_STEPS[step];

  return (
    <div className="onboarding-shell">
      <div className="onboarding-panel">
        <header className="onboarding-header">
          <span className="onboarding-eyebrow">Automa</span>
          <h1 className="onboarding-title">Set up your profile</h1>
          <p className="onboarding-subtitle">
            Everything stays on this Mac. There is no account and nothing is uploaded.
          </p>
        </header>

        <ol className="onboarding-steps" aria-label="Onboarding progress">
          {ONBOARDING_STEPS.map((entry, index) => (
            <li
              key={entry.title}
              className="onboarding-step"
              data-state={index === step ? "current" : index < step ? "done" : "upcoming"}
            >
              <span className="onboarding-step__index">{index + 1}</span>
              <span className="onboarding-step__label">{entry.title}</span>
            </li>
          ))}
        </ol>

        <Card className="rounded-none">
          <CardHeader>
            <CardTitle>{current.title}</CardTitle>
            <CardDescription>{current.hint}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {step === 0 ? (
              <div className="onboarding-grid">
                <OnboardingField label="First name" required>
                  <Input value={profile.basics.firstName} onChange={(e) => setBasics({ firstName: e.target.value })} />
                </OnboardingField>
                <OnboardingField label="Last name" required>
                  <Input value={profile.basics.lastName} onChange={(e) => setBasics({ lastName: e.target.value })} />
                </OnboardingField>
                <OnboardingField label="Email" required>
                  <Input type="email" value={profile.basics.email} onChange={(e) => setBasics({ email: e.target.value })} />
                </OnboardingField>
                <OnboardingField label="Phone">
                  <Input value={profile.basics.phone ?? ""} onChange={(e) => setBasics({ phone: e.target.value })} />
                </OnboardingField>
                <OnboardingField label="Location" hint="City and state, as you would write it on an application.">
                  <Input value={profile.basics.location ?? ""} onChange={(e) => setBasics({ location: e.target.value })} />
                </OnboardingField>
              </div>
            ) : null}

            {step === 1 ? (
              <div className="onboarding-grid">
                <OnboardingField label="Work authorization">
                  <select
                    className="onboarding-select"
                    value={profile.workAuthorization.authorizedToWork ? "yes" : "no"}
                    onChange={(e) =>
                      setProfile((prev) => ({
                        ...prev,
                        workAuthorization: { ...prev.workAuthorization, authorizedToWork: e.target.value === "yes" }
                      }))
                    }
                  >
                    <option value="yes">Authorized to work in the US</option>
                    <option value="no">Not authorized</option>
                  </select>
                </OnboardingField>
                <OnboardingField label="Need sponsorship?">
                  <select
                    className="onboarding-select"
                    value={profile.workAuthorization.requiresSponsorship ? "yes" : "no"}
                    onChange={(e) =>
                      setProfile((prev) => ({
                        ...prev,
                        workAuthorization: { ...prev.workAuthorization, requiresSponsorship: e.target.value === "yes" }
                      }))
                    }
                  >
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </select>
                </OnboardingField>
                <OnboardingField label="School" required>
                  <Input
                    value={profile.education.school ?? ""}
                    onChange={(e) =>
                      setProfile((prev) => ({ ...prev, education: { ...prev.education, school: e.target.value, university: e.target.value } }))
                    }
                  />
                </OnboardingField>
                <OnboardingField label="Degree">
                  <Input
                    value={profile.education.degree ?? ""}
                    onChange={(e) => setProfile((prev) => ({ ...prev, education: { ...prev.education, degree: e.target.value } }))}
                  />
                </OnboardingField>
                <OnboardingField label="Field of study">
                  <Input
                    value={profile.education.field ?? ""}
                    onChange={(e) =>
                      setProfile((prev) => ({ ...prev, education: { ...prev.education, field: e.target.value, discipline: e.target.value } }))
                    }
                  />
                </OnboardingField>
                <OnboardingField label="Graduation year">
                  <Input
                    value={profile.education.graduationYear ?? ""}
                    onChange={(e) =>
                      setProfile((prev) => ({ ...prev, education: { ...prev.education, graduationYear: e.target.value, endYear: e.target.value } }))
                    }
                  />
                </OnboardingField>
              </div>
            ) : null}

            {step === 2 ? (
              <div className="space-y-4">
                <div className="onboarding-resume">
                  <div>
                    <div className="onboarding-resume__name">{resume?.fileName ?? "No resume selected"}</div>
                    <div className="onboarding-resume__hint">
                      {resume ? "Attached. This file is uploaded to each application." : "PDF, DOCX or TXT."}
                    </div>
                  </div>
                  <Button variant="outline" className="rounded-none" onClick={pickResume} disabled={busy === "resume"}>
                    {busy === "resume" ? "Reading…" : resume ? "Choose another" : "Choose file"}
                  </Button>
                </div>
                <OnboardingField label="Short summary" hint="Used when an application asks you to describe yourself.">
                  <Textarea
                    rows={4}
                    value={profile.experience.summary ?? ""}
                    onChange={(e) => setProfile((prev) => ({ ...prev, experience: { ...prev.experience, summary: e.target.value } }))}
                  />
                </OnboardingField>
              </div>
            ) : null}

            {error ? <div className="onboarding-error">{error}</div> : null}
          </CardContent>
          <CardFooter className="onboarding-footer">
            <Button
              variant="ghost"
              className="rounded-none"
              onClick={() => setStep((prev) => (prev > 0 ? ((prev - 1) as OnboardingStep) : prev))}
              disabled={step === 0 || busy !== null}
            >
              Back
            </Button>
            {step < 2 ? (
              <Button
                className="rounded-none"
                onClick={() => setStep((prev) => ((prev + 1) as OnboardingStep))}
                disabled={!stepValid || busy !== null}
              >
                Continue
              </Button>
            ) : (
              <Button className="rounded-none" onClick={finish} disabled={!stepValid || busy !== null}>
                {busy === "save" ? "Saving…" : "Finish"}
              </Button>
            )}
          </CardFooter>
        </Card>

        <div className="onboarding-guest">
          <div>
            <div className="onboarding-guest__title">Just want to look around?</div>
            <div className="onboarding-guest__hint">
              Loads a fictional candidate and a generated resume. Demo runs fill applications but never submit them.
            </div>
          </div>
          <Button variant="outline" className="rounded-none" onClick={startGuest} disabled={busy !== null}>
            {busy === "guest" ? "Preparing…" : "Explore with a demo profile"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function OnboardingField({
  label,
  hint,
  required,
  children
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="onboarding-field">
      <span className="onboarding-field__label">
        {label}
        {required ? <span className="onboarding-field__required" aria-hidden="true"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="onboarding-field__hint">{hint}</span> : null}
    </label>
  );
}

/** Keeps anything the user already typed; the parse only fills blanks. */
function mergeParsedProfile(current: UserProfileInput, parsed: UserProfileInput): UserProfileInput {
  const pick = <T,>(mine: T, theirs: T): T => {
    if (typeof mine === "string") return (mine.trim() ? mine : theirs) as T;
    return (mine ?? theirs) as T;
  };
  return {
    ...current,
    basics: {
      ...current.basics,
      firstName: pick(current.basics.firstName, parsed.basics.firstName),
      lastName: pick(current.basics.lastName, parsed.basics.lastName),
      fullName: pick(current.basics.fullName, parsed.basics.fullName),
      email: pick(current.basics.email, parsed.basics.email),
      phone: pick(current.basics.phone ?? "", parsed.basics.phone ?? ""),
      location: pick(current.basics.location ?? "", parsed.basics.location ?? "")
    },
    education: { ...parsed.education, ...stripEmpty(current.education as unknown as Record<string, unknown>) },
    experience: { ...parsed.experience, ...stripEmpty(current.experience as unknown as Record<string, unknown>) },
    links: { ...parsed.links, ...stripEmpty(current.links as unknown as Record<string, unknown>) }
  };
}

function stripEmpty<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (entry === undefined || entry === null || entry === "") continue;
    out[key] = entry;
  }
  return out as Partial<T>;
}

const RUN_FEEDBACK_STORAGE_KEY = "automa.runs.feedback";

type RunFeedbackVerdict = "looks_right" | "problem" | null;

type RunFeedbackEntry = {
  verdict: RunFeedbackVerdict;
  note: string;
};

function readStoredRunFeedback(): Record<string, RunFeedbackEntry> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(RUN_FEEDBACK_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, RunFeedbackEntry>;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function persistRunFeedback(value: Record<string, RunFeedbackEntry>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RUN_FEEDBACK_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // no-op
  }
}

function JobsPage({
  runs,
  apiBaseUrl,
  onboarding,
  appliedJobs,
  refreshToken,
  sessionUser,
  onNotify
}: {
  runs: RunOutcome[];
  apiBaseUrl: string;
  onboarding?: UserProfileInput;
  appliedJobs: AppliedJobRecord[];
  refreshToken: number;
  sessionUser?: SessionState["user"] | null;
  onNotify: (toast: Omit<ToastItem, "id">) => void;
}) {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<JobFeedItem[]>([]);
  const [supportById, setSupportById] = useState<Record<string, string>>({});
  const [feedVersion, setFeedVersion] = useState(0);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [jobFeedback, setJobFeedback] = useState<Record<string, JobTableFeedback>>({});
  const [savingFeedbackJobIds, setSavingFeedbackJobIds] = useState<Record<string, boolean>>({});
  const [queueingJobIds, setQueueingJobIds] = useState<Record<string, boolean>>({});
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const appliedIds = useMemo(() => new Set(appliedJobs.map((job) => job.jobId)), [appliedJobs]);
  const activeRunsByJobId = useMemo(() => {
    const entries = runs
      .filter((run) => run.status === "queued" || run.status === "running")
      .map((run) => [run.jobId, run] as const);
    return new Map(entries);
  }, [runs]);

  useEffect(() => {
    setJobsLoading(true);
    setJobsError(null);
    let cancelled = false;
    void (async () => {
      try {
        // The corpus lives in local SQLite. If it is empty this is a first run,
        // so pull the feed before showing an empty state.
        let page = await bridge.listJobs({ limit: 100, automatableOnly: false });
        if (!page.jobs.length) {
          await bridge.syncJobs(false);
          page = await bridge.listJobs({ limit: 100, automatableOnly: false });
        }
        if (cancelled) return;
        const nextJobs = page.jobs.map(toJobFeedItem);
        setJobs(nextJobs);
        setSupportById(Object.fromEntries(page.jobs.map((job) => [job.simplifyId, job.support])));
        setJobFeedback(Object.fromEntries(nextJobs.map((job) => [job.id, job.feedback ?? null])));
        setJobsLoading(false);
      } catch (error) {
        if (cancelled) return;
        setJobs([]);
        setJobFeedback({});
        setJobsLoading(false);
        setJobsError(error instanceof Error ? error.message : "Unable to load jobs.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshToken, feedVersion]);

  // The feed is refreshed by the main process on launch and hourly. Without
  // this the first run showed only the seeded practice jobs, because the fetch
  // above had already completed before the sync finished.
  useEffect(() => {
    const unsubscribe = (window.automaDesktop as unknown as {
      onJobsUpdated?: (listener: () => void) => () => void;
    })?.onJobsUpdated?.(() => setFeedVersion((value) => value + 1));
    return () => unsubscribe?.();
  }, []);
  const activeRunCount = runs.filter((run) => run.status === "running" || run.status === "queued").length;
  const submittedRunCount = appliedJobs.length;
  const desiredRoles = onboarding?.preferences.desiredRoles ?? [];
  const desiredLocations = onboarding?.preferences.desiredLocations ?? [];
  const employmentTypes = onboarding?.preferences.employmentTypes ?? [];
  const preferenceSummaryCount = desiredRoles.length + desiredLocations.length + employmentTypes.length;
  const preferenceChips = [
    ...desiredRoles.slice(0, 3).map((role) => ({ key: `role:${role}`, label: role })),
    ...desiredLocations.slice(0, 2).map((location) => ({ key: `location:${location}`, label: location })),
    ...employmentTypes.slice(0, 2).map((type) => ({ key: `employment:${type}`, label: type })),
    ...(onboarding?.preferences.remoteOnly ? [{ key: "remote-only", label: "Remote only" }] : [])
  ];

  function openJobDetails(jobId: string) {
    setExpandedJobId((current) => (current === jobId ? null : jobId));
  }

  async function setFeedback(jobId: string, nextValue: Exclude<JobTableFeedback, null>) {
    if (savingFeedbackJobIds[jobId]) {
      return;
    }

    const previousValue = jobFeedback[jobId] ?? null;
    const verdict = previousValue === nextValue ? null : nextValue;

    setJobFeedback((current) => ({
      ...current,
      [jobId]: verdict,
    }));
    setSavingFeedbackJobIds((current) => ({
      ...current,
      [jobId]: true
    }));

    try {
      // "down" hides the job from the feed; "up" keeps it and marks it liked.
      await bridge.setJobFeedback(jobId, verdict === "down" ? "hidden" : verdict === "up" ? "liked" : null);
    } catch (error) {
      setJobFeedback((current) => ({
        ...current,
        [jobId]: previousValue
      }));
      onNotify({
        tone: "error",
        message: error instanceof Error ? error.message : "Unable to save job feedback."
      });
    } finally {
      setSavingFeedbackJobIds((current) => {
        const next = { ...current };
        delete next[jobId];
        return next;
      });
    }
  }

  async function handleApply(job: JobFeedItem) {
    const isBusy = activeRunsByJobId.has(job.id) || queueingJobIds[job.id] || appliedIds.has(job.id)
    if (isBusy) {
      return;
    }

    await handleApplyMany([job]);
  }

  async function handleApplyMany(targetJobs: JobFeedItem[]) {
    const jobsToQueue = targetJobs.filter((job) => !activeRunsByJobId.has(job.id) && !queueingJobIds[job.id] && !appliedIds.has(job.id));
    if (jobsToQueue.length === 0) {
      return;
    }

    setQueueingJobIds((current) => ({
      ...current,
      ...Object.fromEntries(jobsToQueue.map((job) => [job.id, true]))
    }));

    try {
      const results = await Promise.allSettled(
        jobsToQueue.map((job) =>
          desktopBridge.enqueueRun({
            id: job.id,
            sourceUrl: job.sourceUrl,
            title: job.title,
            company: job.company,
            location: job.location,
            source: job.source
          })
        )
      );
      const failed = results.filter((result) => result.status === "rejected").length;
      const queued = results.length - failed;

      if (queued > 0) {
        onNotify({
          tone: "neutral",
          message: queued === 1 ? "Queued 1 job." : `Queued ${queued} jobs.`
        });
      }
      if (failed > 0) {
        onNotify({
          tone: "error",
          message: failed === 1 ? "1 job failed to queue." : `${failed} jobs failed to queue.`
        });
      }
      if (queued > 0 && failed === 0) {
        setSelectionMode(false);
        setSelectedJobIds([]);
      } else if (failed > 0) {
        const failedIds = jobsToQueue
          .filter((_, index) => results[index]?.status === "rejected")
          .map((job) => job.id);
        setSelectedJobIds(failedIds);
      }
    } catch (error) {
      onNotify({
        tone: "error",
        message: error instanceof Error ? error.message : "Unable to queue application."
      });
    } finally {
      setQueueingJobIds((current) => {
        const next = { ...current };
        for (const job of jobsToQueue) {
          delete next[job.id];
        }
        return next;
      });
    }
  }

  const visibleJobs = useMemo(() => jobs.filter((job) => !appliedIds.has(job.id)), [appliedIds, jobs]);
  const selectableJobs = useMemo(
    () => visibleJobs.filter((job) => !activeRunsByJobId.has(job.id) && !queueingJobIds[job.id]),
    [activeRunsByJobId, queueingJobIds, visibleJobs]
  );
  const selectableJobIds = useMemo(() => selectableJobs.map((job) => job.id), [selectableJobs]);
  const selectedJobs = useMemo(() => visibleJobs.filter((job) => selectedJobIds.includes(job.id)), [selectedJobIds, visibleJobs]);

  useEffect(() => {
    const allowedIds = new Set(selectableJobIds);
    setSelectedJobIds((current) => current.filter((jobId) => allowedIds.has(jobId)));
  }, [jobsLoading, selectableJobIds]);

  const tableItems = visibleJobs.map((job) => {
    const activeRun = activeRunsByJobId.get(job.id);
    const queueing = Boolean(queueingJobIds[job.id]);
    return {
    id: job.id,
    company: job.company,
    title: job.title,
    postedLabel: formatPostedAt(job.postedAt),
    providerLabel: formatProviderLabel(job.source),
    feedReasonLabel: describeJobSupport(supportById[job.id]),
    applied: appliedIds.has(job.id),
    queued: activeRun?.status === "queued",
    applying: queueing || activeRun?.status === "running",
    applyProgress: queueing ? 12 : getRunProgress(activeRun),
    feedback: jobFeedback[job.id] ?? null,
    feedbackPending: Boolean(savingFeedbackJobIds[job.id]),
  };
  });

  function toggleSelectionMode() {
    setSelectionMode((current) => {
      const next = !current;
      if (!next) {
        setSelectedJobIds([]);
      }
      return next;
    });
    setExpandedJobId(null);
  }

  function toggleSelectedJob(jobId: string) {
    if (!selectionMode || !selectableJobIds.includes(jobId)) {
      return;
    }
    setSelectedJobIds((current) => current.includes(jobId) ? current.filter((id) => id !== jobId) : [...current, jobId]);
  }

  function toggleSelectAllJobs() {
    setSelectedJobIds((current) => current.length === selectableJobIds.length ? [] : selectableJobIds);
  }

  return (
    <WorkspaceFrame
      headerTag="Jobs"
      headerTitle="Open roles"
      sidebarHeader={<SidebarBrand />}
      sidebarNav={<AppSidebar runCount={runs.length} appliedCount={appliedJobs.length} />}
      sidebarFooter={<SidebarFooterPanel session={sessionUser} />}
    >
      <section className="desktop-jobs-banner">
        <div className="desktop-jobs-banner__rail" aria-label="Job feed summary">
          <div className="desktop-jobs-banner__metric">
            <span className="desktop-jobs-banner__metric-value">{activeRunCount}</span>
            <span className="desktop-jobs-banner__metric-label">queued</span>
          </div>
          <div className="desktop-jobs-banner__metric">
            <span className="desktop-jobs-banner__metric-value">{submittedRunCount}</span>
            <span className="desktop-jobs-banner__metric-label">applied</span>
          </div>
        </div>
        <div className="desktop-jobs-banner__content">
          <div className="desktop-jobs-banner__metrics" aria-label="Job feed summary">
            <p className="desktop-jobs-banner__copy">
              {preferenceSummaryCount > 0
                ? `Targeting ${desiredRoles.slice(0, 2).join(", ") || "your selected roles"} across ${desiredLocations.slice(0, 2).join(", ") || "your preferred locations"}.`
                : "Set your target roles, locations, and employment preferences so Automa can keep curating the right feed."}
            </p>
          </div>
          <div className="desktop-jobs-banner__toolbar">
            <div className="desktop-jobs-banner__chips">
              {preferenceChips.length > 0 ? (
                preferenceChips.map((chip) => (
                  <span key={chip.key} className="desktop-jobs-banner__chip">
                    {chip.label}
                  </span>
                ))
              ) : (
                <span className="desktop-jobs-banner__chip desktop-jobs-banner__chip--muted">No targeting preferences saved yet</span>
              )}
            </div>
          </div>
        </div>
      </section>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-5">
          <div className="min-w-0">
            <CardTitle>Open roles</CardTitle>
            <CardDescription>
              From the public SimplifyJobs boards, stored on this Mac. Click a row for detail.
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {selectionMode ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={toggleSelectionMode}
                  className="cursor-pointer rounded-none"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={selectedJobIds.length === 0}
                  onClick={() => void handleApplyMany(selectedJobs)}
                  className="cursor-pointer rounded-none"
                >
                  {selectedJobIds.length > 0 ? `Apply ${selectedJobIds.length}` : "Apply"}
                </Button>
              </>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label="Select jobs"
                    onClick={toggleSelectionMode}
                    className="size-8 cursor-pointer rounded-none px-0"
                  >
                    <ListChecks className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="end">
                  Select jobs
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {jobsError ? (
            <div className="desktop-surface-state desktop-surface-state--error">
              <div className="desktop-surface-state__copy">{jobsError}</div>
            </div>
          ) : !jobsLoading && visibleJobs.length === 0 ? (
            <div className="desktop-surface-state">
              <div className="desktop-surface-state__copy">No queued jobs right now. New matches will land here and confirmed submissions move to Applied automatically.</div>
            </div>
          ) : (
            <FixedHeaderFooterTable
              items={tableItems}
              loading={jobsLoading}
              expandedItemId={expandedJobId}
              onRowClick={openJobDetails}
              onApply={(jobId) => {
                const job = visibleJobs.find((entry) => entry.id === jobId);
                if (job) {
                  void handleApply(job);
                }
              }}
              onThumbUp={(jobId) => void setFeedback(jobId, "up")}
              onThumbDown={(jobId) => void setFeedback(jobId, "down")}
              selectionMode={selectionMode}
              selectedItemIds={selectedJobIds}
              selectableItemIds={selectableJobIds}
              onToggleItemSelection={toggleSelectedJob}
              onToggleSelectAll={toggleSelectAllJobs}
              renderExpandedContent={(jobId) => {
                const job = visibleJobs.find((entry) => entry.id === jobId);
                const activeRun = activeRunsByJobId.get(jobId);
                const queueing = Boolean(queueingJobIds[jobId]);
                if (!job) return null;

                return (
                  <div className="desktop-job-expansion">
                    <div className="desktop-job-expansion__meta">
                      <span>{formatProviderLabel(job.source)}</span>
                      <span>{formatFeedReason(job.feedReason)}</span>
                      <span>{formatPostedAt(job.postedAt)}</span>
                      {job.compensation ? <span>{job.compensation}</span> : null}
                      {queueing ? <span>Queueing</span> : null}
                      {activeRun?.status === "queued" ? <span>Queued</span> : null}
                      {activeRun?.status === "running" ? <span>Applying</span> : null}
                    </div>

                    <p className="desktop-job-expansion__summary">{job.summary || "No summary available yet."}</p>

                    <dl className="desktop-job-expansion__facts">
                      <div className="desktop-job-expansion__fact">
                        <dt>Company</dt>
                        <dd>{job.company}</dd>
                      </div>
                      <div className="desktop-job-expansion__fact">
                        <dt>Location</dt>
                        <dd>{job.location}</dd>
                      </div>
                      <div className="desktop-job-expansion__fact">
                        <dt>Date posted</dt>
                        <dd>{formatPostedAt(job.postedAt)}</dd>
                      </div>
                    </dl>

                    <div className="desktop-job-expansion__tags">
                      {job.roleTags.map((tag) => (
                        <Badge key={tag} variant="outline" className="rounded-none">
                          {tag}
                        </Badge>
                      ))}
                    </div>

                    {queueing || activeRun ? (
                      <div className="desktop-job-expansion__progress">
                        <div className="text-sm text-muted-foreground">
                          {queueing
                            ? "Queueing application run…"
                            : activeRun?.status === "queued"
                              ? "Run queued. Waiting for the browser worker."
                              : `Applying now: ${formatPhase(activeRun?.phase || "filling")}.`}
                        </div>
                        <Progress value={queueing ? 12 : getRunProgress(activeRun)} />
                      </div>
                    ) : null}

                    <div className="desktop-job-expansion__actions">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button type="button" variant="outline" onClick={() => window.open(job.sourceUrl, "_blank", "noopener,noreferrer")} className="cursor-pointer rounded-none">
                          <ArrowUpRight className="size-4" />
                          Open externally
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              }}
            />
          )}
        </CardContent>
      </Card>
    </WorkspaceFrame>
  );
}

function RunsPage({
  runs,
  appliedCount,
  sessionUser,
  onNotify
}: {
  runs: RunOutcome[];
  appliedCount: number;
  sessionUser?: SessionState["user"] | null;
  onNotify: (toast: Omit<ToastItem, "id">) => void;
}) {
  const navigate = useNavigate();
  const [cancellingRunIds, setCancellingRunIds] = useState<Record<string, boolean>>({});
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, RunFeedbackEntry>>(() => readStoredRunFeedback());
  const [feedbackTargetRunId, setFeedbackTargetRunId] = useState<string | null>(null);
  const sortedRuns = useMemo(
    () =>
      [...runs].sort((left, right) => {
        const leftTs = new Date(left.finishedAt || left.startedAt || left.createdAt || 0).getTime();
        const rightTs = new Date(right.finishedAt || right.startedAt || right.createdAt || 0).getTime();
        return rightTs - leftTs;
      }),
    [runs]
  );
  useEffect(() => {
    setCancellingRunIds((current) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [runId, pending] of Object.entries(current)) {
        if (!pending) continue;
        const match = runs.find((entry) => entry.id === runId);
        if (match && (match.status === "queued" || match.status === "running")) {
          next[runId] = true;
        } else {
          changed = true;
        }
      }
      if (!changed && Object.keys(next).length === Object.keys(current).length) {
        return current;
      }
      return next;
    });
  }, [runs]);

  useEffect(() => {
    persistRunFeedback(feedback);
  }, [feedback]);

  async function handleCancelRun(run: RunOutcome) {
    if (cancellingRunIds[run.id]) return;
    setCancellingRunIds((current) => ({ ...current, [run.id]: true }));
    try {
      await desktopBridge.cancelRun(run.id);
    } catch {
      setCancellingRunIds((current) => {
        const next = { ...current };
        delete next[run.id];
        return next;
      });
    }
  }

  function toggleRunExpansion(runId: string) {
    setExpandedRunId((current) => (current === runId ? null : runId));
  }

  const tableItems = useMemo<FixedHeaderFooterTableItem[]>(
    () =>
      sortedRuns.map((run) => {
        const isCancelling = Boolean(cancellingRunIds[run.id]);
        return {
          id: run.id,
          company: deriveRunCompanyLabel(run),
          title: run.jobTitle || "Automation run",
          statusBadge: getRunStatusBadge(run),
          postedLabel: formatDuration(run.startedAt, run.finishedAt),
          dateLabel: "Duration",
          dateSubLabel: "Finished",
          dateSubValue: formatRunFinishedLabel(run.finishedAt),
          providerLabel: run.source ? formatProviderLabel(run.source) : "Automation",
          feedReasonLabel: isCancelling ? "Cancellation requested" : formatRunOutcomeLabel(run),
          applied: false,
          queued: false,
          applying: run.status === "queued" || run.status === "running",
          applyProgress: getRunProgress(run),
          feedback: null,
        };
      }),
    [cancellingRunIds, sortedRuns]
  );

  function renderRunActions(item: FixedHeaderFooterTableItem) {
    const run = sortedRuns.find((entry) => entry.id === item.id);
    if (!run) return null;
    const runStatus = run.status as string;

    const isRunning = runStatus === "running";
    const isCancelable = runStatus === "queued" || isRunning;
    const isResumable = runStatus === "paused_app_unavailable" || runStatus === "paused_interrupted";
    const isCancelling = Boolean(cancellingRunIds[run.id]);
    const isFeedbackOnly = runStatus === "failed" || runStatus === "cancelled";
    const hasViewAction = !isCancelable && (runStatus === "completed" || run.submitted || run.submissionConfirmed);
    const activeFeedback = feedback[run.id];
    const feedbackButtonClass = activeFeedback?.verdict === "looks_right"
      ? "border-[rgba(82,125,90,0.18)] bg-[rgba(116,170,124,0.16)] text-[rgb(55,92,61)] hover:bg-[rgba(116,170,124,0.22)]"
      : activeFeedback?.verdict === "problem"
        ? "border-[rgba(166,103,98,0.18)] bg-[rgba(218,142,134,0.16)] text-[rgb(126,72,68)] hover:bg-[rgba(218,142,134,0.22)]"
        : undefined;

    if (isCancelable) {
      return (
        <>
          {isRunning ? (
            <Button
              type="button"
              size="sm"
              className="h-6 cursor-pointer rounded-none px-2 text-[0.72rem]"
              onClick={() => void desktopBridge.openRunBrowser(run.id)}
            >
              View
            </Button>
          ) : null}
          {isRunning && run.browserVisible ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 cursor-pointer rounded-none px-2 text-[0.72rem]"
              onClick={() => void desktopBridge.closeRunBrowser(run.id)}
            >
              Close
            </Button>
          ) : null}
          <ConfirmCancelButton
            busy={isCancelling}
            onConfirm={() => handleCancelRun(run)}
          />
        </>
      );
    }

    if (hasViewAction) {
      return (
        <>
          <Button
            type="button"
            size="sm"
            className="h-6 cursor-pointer rounded-none px-2 text-[0.72rem]"
            onClick={() => navigate(`/runs/${run.id}`)}
          >
            View
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className={cn("size-6 cursor-pointer rounded-none", feedbackButtonClass)}
            onClick={() => setFeedbackTargetRunId(run.id)}
            aria-label={`Leave feedback for ${run.jobTitle || deriveRunCompanyLabel(run)}`}
          >
            <MessageSquarePlus className="size-3.5" />
          </Button>
        </>
      );
    }

    if (isResumable) {
      return (
        <Button
          type="button"
          size="sm"
          className="h-6 cursor-pointer rounded-none px-2 text-[0.72rem]"
          onClick={() => void desktopBridge.resumeRun(run.id)}
        >
          Resume
        </Button>
      );
    }

    if (isFeedbackOnly) {
      return (
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className={cn("size-6 cursor-pointer rounded-none", feedbackButtonClass)}
          onClick={() => setFeedbackTargetRunId(run.id)}
          aria-label={`Leave feedback for ${run.jobTitle || deriveRunCompanyLabel(run)}`}
        >
          <MessageSquarePlus className="size-3.5" />
        </Button>
      );
    }

    return null;
  }

  return (
    <WorkspaceFrame
      headerTag="Runs"
      headerTitle="Run history"
      sidebarHeader={<SidebarBrand />}
      sidebarNav={<AppSidebar runCount={runs.length} appliedCount={appliedCount} />}
      sidebarFooter={<SidebarFooterPanel session={sessionUser} />}
      headerRight={<Badge variant="secondary" className="rounded-none">{runs.length} runs</Badge>}
    >
      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <CardHeader>
          <CardTitle>Recent run history</CardTitle>
          <CardDescription>Every local run stays here in one ledger. Open a row to inspect timing, submission evidence, and feedback.</CardDescription>
        </CardHeader>
        <CardContent className="desktop-runs-index">
          {sortedRuns.length === 0 ? (
            <div className="desktop-surface-state">
              <div className="desktop-surface-state__copy">No runs yet. Queue a job from the jobs feed and it will appear here with a full receipt once automation finishes.</div>
            </div>
          ) : (
            <FixedHeaderFooterTable
              items={tableItems}
              expandedItemId={expandedRunId}
              onRowClick={toggleRunExpansion}
              onApply={() => undefined}
              onThumbUp={() => undefined}
              onThumbDown={() => undefined}
              companyColumnLabel="Company"
              positionColumnLabel="Run"
              dateColumnLabel="Timing"
              actionsColumnLabel="Action"
              statusColumnLabel="Status"
              defaultDateLabel="Duration"
              showPrimaryAction={false}
              showFeedbackActions={false}
              showStatusColumn
              renderActions={renderRunActions}
              renderExpandedContent={(runId) => {
                const run = sortedRuns.find((entry) => entry.id === runId);
                if (!run) return null;

                const isCancelable = run.status === "queued" || run.status === "running";
                const isRunning = run.status === "running";
                const providerLabel = run.source ? formatProviderLabel(run.source) : "Automation";
                const statusBadge = getRunStatusBadge(run);
                const failureNotes = run.failureDetail?.notes ?? [];
                const submitOutcomeLabel = formatSubmissionOutcomeLabel(run.submitOutcome);

                return (
                  <div className="desktop-run-table-expansion">
                    <div className="desktop-job-expansion__meta">
                      <span>{providerLabel}</span>
                      <span>{formatRunOutcomeLabel(run)}</span>
                      <span>{formatDuration(run.startedAt, run.finishedAt)}</span>
                      <span>{formatRunFinishedLabel(run.finishedAt)}</span>
                    </div>

                    <div className="desktop-run-table-expansion__status">
                      <span className={statusBadge.className}>{statusBadge.label}</span>
                      {submitOutcomeLabel ? (
                        <span className="desktop-run-table-expansion__status-copy">{submitOutcomeLabel}</span>
                      ) : null}
                    </div>

                    <dl className="desktop-job-expansion__facts desktop-run-table-expansion__facts">
                      <div className="desktop-job-expansion__fact">
                        <dt>Started</dt>
                        <dd>{formatDateTime(run.startedAt)}</dd>
                      </div>
                      <div className="desktop-job-expansion__fact">
                        <dt>Finished</dt>
                        <dd>{formatDateTime(run.finishedAt)}</dd>
                      </div>
                      <div className="desktop-job-expansion__fact">
                        <dt>Duration</dt>
                        <dd>{formatDuration(run.startedAt, run.finishedAt)}</dd>
                      </div>
                      <div className="desktop-job-expansion__fact">
                        <dt>Submission</dt>
                        <dd>{formatRunOutcomeLabel(run)}</dd>
                      </div>
                    </dl>

                    {run.failureDetail ? (
                      <p className="desktop-run-table-expansion__summary">
                        {run.failureDetail.reason}
                        {failureNotes.length > 0 ? ` ${failureNotes.join(" ")}` : ""}
                      </p>
                    ) : null}

                    <div className="desktop-job-expansion__actions">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="h-9 cursor-pointer rounded-none"
                          onClick={() => navigate(`/runs/${run.id}`)}
                        >
                          View run
                        </Button>
                        {isRunning ? (
                          <Button
                            type="button"
                            variant="outline"
                            className="cursor-pointer rounded-none"
                            onClick={() => void desktopBridge.openRunBrowser(run.id)}
                          >
                            View browser
                          </Button>
                        ) : null}
                        {isRunning && run.browserVisible ? (
                          <Button
                            type="button"
                            variant="outline"
                            className="cursor-pointer rounded-none"
                            onClick={() => void desktopBridge.closeRunBrowser(run.id)}
                          >
                            Close browser
                          </Button>
                        ) : null}
                        {isCancelable ? (
                          <Button
                            type="button"
                            variant="outline"
                            className="cursor-pointer rounded-none"
                            disabled={Boolean(cancellingRunIds[run.id])}
                            onClick={() => {
                              void handleCancelRun(run);
                            }}
                          >
                            {cancellingRunIds[run.id] ? "Cancelling" : "Cancel run"}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              }}
            />
          )}
        </CardContent>
      </Card>
      <AnimatePresence>
        {feedbackTargetRunId ? (
          <FeedbackWidget
            key={feedbackTargetRunId}
            title={`Feedback · ${sortedRuns.find((entry) => entry.id === feedbackTargetRunId)?.jobTitle || "Run"}`}
            initialRating={
              feedback[feedbackTargetRunId]?.verdict === "looks_right"
                ? "helpful"
                : feedback[feedbackTargetRunId]?.verdict === "problem"
                  ? "not-helpful"
                  : null
            }
            initialComment={feedback[feedbackTargetRunId]?.note ?? ""}
            onClose={() => setFeedbackTargetRunId(null)}
            onSubmit={async ({ rating, comment }) => {
              const nextEntry: RunFeedbackEntry = {
                verdict: rating === "helpful" ? "looks_right" : "problem",
                note: comment
              };
              setFeedback((current) => ({
                ...current,
                [feedbackTargetRunId]: nextEntry
              }));
              setFeedbackTargetRunId(null);
              onNotify({
                tone: "neutral",
                message: "Run feedback saved locally."
              });
            }}
          />
        ) : null}
      </AnimatePresence>
    </WorkspaceFrame>
  );
}

function RunDetailPage({
  runs,
  appliedCount,
  sessionUser
}: {
  runs: RunOutcome[];
  appliedCount: number;
  sessionUser?: SessionState["user"] | null;
}) {
  const navigate = useNavigate();
  const { runId } = useParams();
  const run = useMemo(() => runs.find((entry) => entry.id === runId), [runId, runs]);
  const [inspectBusy, setInspectBusy] = useState(false);

  if (!run) {
    return (
      <WorkspaceFrame
        headerTag="Run"
        headerTitle="Run not found"
        sidebarHeader={<SidebarBrand />}
        sidebarNav={<AppSidebar runCount={runs.length} appliedCount={appliedCount} />}
        sidebarFooter={<SidebarFooterPanel session={sessionUser} />}
      >
        <Card>
          <CardHeader>
            <CardTitle>Missing run</CardTitle>
            <CardDescription>This run is not in the local desktop history anymore.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <BackButton onClick={() => navigate("/runs")} />
          </CardContent>
        </Card>
      </WorkspaceFrame>
    );
  }

  const currentRun = run;
  const currentRunStatus = currentRun.status as string;
  const badgeVariant = currentRunStatus === "failed"
    ? "destructive"
    : currentRunStatus === "paused_app_unavailable" || currentRunStatus === "paused_interrupted" || currentRunStatus === "unknown_needs_review"
      ? "secondary"
      : currentRun.submissionConfirmed
        ? "secondary"
        : "outline";
  const normalizedReceipt = currentRun.submissionReceipt;
  const receiptRows = getRunReceiptRows(currentRun);
  const notes = currentRun.notes ?? [];

  async function handleInspectWorker() {
    setInspectBusy(true);
    try {
      await desktopBridge.openRunBrowser(currentRun.id);
    } finally {
      setInspectBusy(false);
    }
  }

  async function handleCloseWorker() {
    setInspectBusy(true);
    try {
      await desktopBridge.closeRunBrowser(currentRun.id);
    } finally {
      setInspectBusy(false);
    }
  }

  return (
      <WorkspaceFrame
        headerTag="Run"
        headerTitle={currentRun.jobTitle || "Automation run"}
        sidebarHeader={<SidebarBrand />}
        sidebarNav={<AppSidebar runCount={runs.length} appliedCount={appliedCount} />}
        sidebarFooter={<SidebarFooterPanel session={sessionUser} />}
        headerIdentityClassName="desktop-run-detail__header-identity"
        headerRight={<Badge variant={badgeVariant} className="rounded-none">{formatRunStatus(currentRun.status)}</Badge>}
      >
        <div className="desktop-run-detail">
        <Card className="overflow-hidden">
          <CardHeader className="desktop-run-detail__hero">
            <div className="desktop-run-detail__hero-copy">
              <CardTitle>{currentRun.jobTitle || "Automation run"}</CardTitle>
              <CardDescription>
                {currentRun.company ? `${currentRun.company} · ` : ""}
                {currentRun.source ? formatProviderLabel(currentRun.source) : "Automation"}
                {currentRun.sourceUrl ? ` · ${currentRun.sourceUrl}` : ""}
              </CardDescription>
            </div>
            <div className="desktop-run-detail__hero-actions">
              <BackButton onClick={() => navigate("/runs")} />
              {currentRun.status === "running" ? (
                <>
                  <Button type="button" variant="outline" className="rounded-none" onClick={() => void handleInspectWorker()} disabled={inspectBusy}>
                    {inspectBusy ? "Opening browser..." : "View browser"}
                  </Button>
                  {currentRun.browserVisible ? (
                    <Button type="button" variant="outline" className="rounded-none" onClick={() => void handleCloseWorker()} disabled={inspectBusy}>
                      {inspectBusy ? "Closing browser..." : "Close browser"}
                    </Button>
                  ) : null}
                </>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="desktop-run-detail__summary-grid">
            <div className="desktop-run-detail__metric">
              <span className="desktop-run-detail__metric-label">Duration</span>
              <strong>{formatDuration(currentRun.startedAt, currentRun.finishedAt)}</strong>
            </div>
            <div className="desktop-run-detail__metric">
              <span className="desktop-run-detail__metric-label">Started</span>
              <strong>{formatDateTime(currentRun.startedAt)}</strong>
            </div>
            <div className="desktop-run-detail__metric">
              <span className="desktop-run-detail__metric-label">Finished</span>
              <strong>{formatDateTime(currentRun.finishedAt)}</strong>
            </div>
            <div className="desktop-run-detail__metric">
              <span className="desktop-run-detail__metric-label">Submission</span>
              <strong>{formatRunOutcomeLabel(currentRun)}</strong>
            </div>
          </CardContent>
        </Card>

        <div className="desktop-run-detail__grid">
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Submission receipt</CardTitle>
              <CardDescription>
                {normalizedReceipt
                  ? `Normalized receipt captured from ${formatSubmissionReceiptSource(normalizedReceipt.source)}.`
                  : "Field values captured during the run. Older runs fall back to raw recorded fields."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {receiptRows.length === 0 ? (
                <div className="desktop-surface-state">
                  <div className="desktop-surface-state__copy">No field receipt was captured for this run. Older runs only retain status and timing.</div>
                </div>
              ) : (
                <div className="desktop-run-receipt">
                  {receiptRows.map((item) => (
                    <div key={item.id} className="desktop-run-receipt__row">
                      <div>
                        {item.section ? <div className="desktop-run-receipt__section">{item.section}</div> : null}
                        <div className="desktop-run-receipt__label">{item.label}</div>
                      </div>
                      <div className="desktop-run-receipt__value">{item.value}</div>
                      <div className="desktop-run-receipt__source">{item.context}</div>
                      <div className="desktop-run-receipt__source">{item.fillMethod}</div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Diagnostics</CardTitle>
              <CardDescription>Timing evidence, step traces, and terminal notes captured during the run.</CardDescription>
            </CardHeader>
            <CardContent className="desktop-run-diagnostics">
              {currentRun.workdayRunSummary ? (
                <div className="desktop-run-diagnostics__summary">
                  <div className="desktop-run-diagnostics__summary-row">
                    <span>Tenant</span>
                    <strong>{currentRun.workdayRunSummary.tenantHost}</strong>
                  </div>
                  <div className="desktop-run-diagnostics__summary-row">
                    <span>Steps reached</span>
                    <strong>{currentRun.workdayRunSummary.stepsReached.join(" → ") || "None"}</strong>
                  </div>
                </div>
              ) : null}
              {notes.length === 0 ? (
                <div className="desktop-surface-state">
                  <div className="desktop-surface-state__copy">No diagnostic notes were stored for this run.</div>
                </div>
              ) : (
                <div className="desktop-run-note-list">
                  {notes.map((note) => (
                    <div key={note} className="desktop-run-note-list__item">{note}</div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

      </div>
    </WorkspaceFrame>
  );
}

const APPLIED_TRACKER_STAGES: ApplicationTrackerStage[] = ["applied", "interview", "offer", "rejected"];

const APPLIED_STAGE_COPY: Record<ApplicationTrackerStage, { title: string; detail: string }> = {
  applied: {
    title: "Applied",
    detail: "Newly submitted applications land here first."
  },
  interview: {
    title: "Interview",
    detail: "Manual stage updates keep the tracker current."
  },
  offer: {
    title: "Offer",
    detail: "High-signal application outcomes and next steps."
  },
  rejected: {
    title: "Rejected",
    detail: "Closed loops stay visible without crowding active work."
  }
};

function AppliedPage({
  runs,
  appliedJobs,
  loading,
  error,
  apiBaseUrl,
  refreshAppliedJobs,
  sessionUser,
  onNotify
}: {
  runs: RunOutcome[];
  appliedJobs: AppliedJobRecord[];
  loading: boolean;
  error: string | null;
  apiBaseUrl: string;
  refreshAppliedJobs: () => Promise<void>;
  sessionUser?: SessionState["user"] | null;
  onNotify: (toast: Omit<ToastItem, "id">) => void;
}) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [boardJobs, setBoardJobs] = useState(appliedJobs);
  const [draggingJobId, setDraggingJobId] = useState<string | null>(null);
  const [dropTargetStage, setDropTargetStage] = useState<ApplicationTrackerStage | null>(null);
  const [movingJobId, setMovingJobId] = useState<string | null>(null);

  useEffect(() => {
    setBoardJobs(appliedJobs);
  }, [appliedJobs]);

  const filteredJobs = useMemo(() => {
    const query = search.trim().toLowerCase();
    return boardJobs.filter((job) => {
      if (!query) return true;
      return [
        job.title,
        job.company,
        job.location,
        job.source,
        job.roleTags.join(" ")
      ].some((value) => value.toLowerCase().includes(query));
    });
  }, [boardJobs, search]);

  const groupedJobs = useMemo(() => {
    return APPLIED_TRACKER_STAGES.reduce<Record<ApplicationTrackerStage, AppliedJobRecord[]>>((accumulator, stage) => {
      accumulator[stage] = filteredJobs
        .filter((job) => job.trackerStage === stage)
        .sort((left, right) => {
          if (left.trackerOrder !== right.trackerOrder) return left.trackerOrder - right.trackerOrder;
          return new Date(right.appliedAt).getTime() - new Date(left.appliedAt).getTime();
        });
      return accumulator;
    }, {
      applied: [],
      interview: [],
      offer: [],
      rejected: []
    });
  }, [filteredJobs]);

  async function handleMove(job: AppliedJobRecord, stage: ApplicationTrackerStage) {
    if (job.trackerStage === stage || movingJobId) return;
    const previousJobs = boardJobs;
    setBoardJobs((current) => moveAppliedJobToStage(current, job.id, stage));
    setMovingJobId(job.id);
    try {
      await bridge.moveApplied(job.id, stage as TrackerStageName);
      await refreshAppliedJobs();
      onNotify({
        tone: "success",
        message: `${job.company} moved to ${formatApplicationTrackerStage(stage)}.`
      });
    } catch (moveError) {
      setBoardJobs(previousJobs);
      onNotify({
        tone: "error",
        message: moveError instanceof Error ? moveError.message : "Unable to update application stage."
      });
    } finally {
      setMovingJobId(null);
      setDraggingJobId(null);
      setDropTargetStage(null);
    }
  }

  return (
    <WorkspaceFrame
      headerTag="Applied"
      headerTitle="Application tracker"
      sidebarHeader={<SidebarBrand />}
      sidebarNav={<AppSidebar runCount={runs.length} appliedCount={appliedJobs.length} />}
      sidebarFooter={<SidebarFooterPanel session={sessionUser} />}
      headerRight={<Badge variant="secondary">{appliedJobs.length} tracked</Badge>}
    >
      <Card className="overflow-hidden">
        <CardHeader className="desktop-applied-board__header">
          <div className="desktop-applied-board__header-copy">
            <CardTitle>Tracked applications</CardTitle>
            <CardDescription>Drag cards between stages to keep your application pipeline current.</CardDescription>
          </div>
          <div className="desktop-applied-board__header-meta">
            <span>{appliedJobs.length} total</span>
            <span>{boardJobs.filter((job) => job.trackerStage === "interview" || job.trackerStage === "offer").length} active follow-ups</span>
          </div>
        </CardHeader>
        <CardContent className="desktop-applied-board">
          <div className="desktop-applied-board__controls">
            <label className="desktop-applied-board__search">
              <Search className="size-4" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search title, company, location"
                className="rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
              />
            </label>
          </div>

          {loading ? (
            <div className="desktop-applied-board__columns">
              {APPLIED_TRACKER_STAGES.map((stage) => (
                <div key={stage} className="desktop-applied-column">
                  <div className="desktop-applied-column__header">
                    <div>
                      <div className="desktop-applied-column__title">{APPLIED_STAGE_COPY[stage].title}</div>
                      <div className="desktop-applied-column__detail">{APPLIED_STAGE_COPY[stage].detail}</div>
                    </div>
                    <div className="desktop-applied-column__count">0</div>
                  </div>
                  <div className="desktop-applied-column__skeletons">
                    <div className="desktop-applied-card-skeleton" />
                    <div className="desktop-applied-card-skeleton" />
                    <div className="desktop-applied-card-skeleton" />
                  </div>
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="desktop-surface-state desktop-surface-state--error">
              <div className="desktop-surface-state__copy">{error}</div>
            </div>
          ) : appliedJobs.length === 0 ? (
            <div className="desktop-surface-state">
              <div className="desktop-surface-state__copy">No submitted applications tracked yet. Confirmed submissions will appear here automatically.</div>
            </div>
          ) : (
            <div className="desktop-applied-board__columns">
              {APPLIED_TRACKER_STAGES.map((stage) => {
                const stageJobs = groupedJobs[stage];
                const isDropActive = dropTargetStage === stage;
                return (
                  <section
                    key={stage}
                    className={cn(
                      "desktop-applied-column",
                      isDropActive ? "desktop-applied-column--drop-active" : null
                    )}
                    onDragOver={(event) => {
                      event.preventDefault();
                      if (draggingJobId) setDropTargetStage(stage);
                    }}
                    onDragEnter={() => {
                      if (draggingJobId) setDropTargetStage(stage);
                    }}
                    onDragLeave={() => {
                      if (dropTargetStage === stage) setDropTargetStage(null);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const droppedId = event.dataTransfer.getData("text/plain") || draggingJobId;
                      const job = boardJobs.find((entry) => entry.id === droppedId);
                      if (job) {
                        void handleMove(job, stage);
                      }
                    }}
                  >
                    <div className="desktop-applied-column__header">
                      <div>
                        <div className="desktop-applied-column__title">{APPLIED_STAGE_COPY[stage].title}</div>
                        <div className="desktop-applied-column__detail">{APPLIED_STAGE_COPY[stage].detail}</div>
                      </div>
                      <div className="desktop-applied-column__count">{stageJobs.length}</div>
                    </div>

                    <div className="desktop-applied-column__body">
                      {stageJobs.length === 0 ? (
                        <div className="desktop-applied-column__empty">
                          {search ? "No matching applications." : "Drop applications here."}
                        </div>
                      ) : (
                        stageJobs.map((job) => {
                          const outcome = job.submissionConfirmed
                            ? "Submitted"
                            : (formatSubmissionOutcomeLabel(job.submitOutcome) ?? "Submitted");
                          const stageBadge = getAppliedStageBadge(job.trackerStage);
                          const pendingMove = movingJobId === job.id;
                          return (
                            <article
                              key={job.id}
                              role="button"
                              tabIndex={0}
                              draggable={!pendingMove}
                              className={cn(
                                "desktop-applied-card",
                                draggingJobId === job.id ? "desktop-applied-card--dragging" : null
                              )}
                              onDragStart={(event) => {
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData("text/plain", job.id);
                                setDraggingJobId(job.id);
                              }}
                              onDragEnd={() => {
                                setDraggingJobId(null);
                                setDropTargetStage(null);
                              }}
                              onClick={() => navigate(`/applied/${job.id}`)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  navigate(`/applied/${job.id}`);
                                }
                              }}
                            >
                              <div className="desktop-applied-card__eyebrow">
                                <span>{formatProviderLabel(job.source)}</span>
                                <span>{formatAppliedAt(job.appliedAt)}</span>
                              </div>
                              <div className="desktop-applied-card__title">{job.title}</div>
                              <div className="desktop-applied-card__company">{job.company}</div>
                              <div className="desktop-applied-card__meta">
                                <span>{job.location}</span>
                                <span>{outcome}</span>
                              </div>
                              <div className="desktop-applied-card__footer">
                                <span className={stageBadge.className}>{stageBadge.label}</span>
                                <div className="desktop-applied-card__actions">
                                  {pendingMove ? (
                                    <span className="desktop-applied-card__moving">
                                      <Loader2 className="size-3.5 animate-spin" />
                                      Moving
                                    </span>
                                  ) : null}
                                  <Button
                                    type="button"
                                    variant="outline"
                                    className="h-7 rounded-none px-2.5 text-[0.72rem]"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      window.open(job.sourceUrl, "_blank", "noopener,noreferrer");
                                    }}
                                  >
                                    <ArrowUpRight className="size-3.5" />
                                    Posting
                                  </Button>
                                </div>
                              </div>
                            </article>
                          );
                        })
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </WorkspaceFrame>
  );
}

function ApplicationDetailPage({
  runs,
  appliedCount,
  apiBaseUrl,
  sessionUser,
  onNotify
}: {
  runs: RunOutcome[];
  appliedCount: number;
  apiBaseUrl: string;
  sessionUser?: SessionState["user"] | null;
  onNotify: (toast: Omit<ToastItem, "id">) => void;
}) {
  const navigate = useNavigate();
  const { appliedJobId } = useParams();
  const {
    application,
    loading,
    error,
    refresh
  } = useAppliedJobDetail(apiBaseUrl, appliedJobId, Boolean(appliedJobId));
  const [insightsSummary, setInsightsSummary] = useState("");
  const [contactTargets, setContactTargets] = useState<ApplicationContactTarget[]>([]);
  const [messageDrafts, setMessageDrafts] = useState<ApplicationMessageDraft[]>([]);
  const [saveBusy, setSaveBusy] = useState(false);

  useEffect(() => {
    if (!application) return;
    setInsightsSummary(application.insightsSummary ?? "");
    setContactTargets(application.contactTargets);
    setMessageDrafts(application.messageDrafts);
  }, [application]);

  const stageBadge = application ? getAppliedStageBadge(application.appliedJob.trackerStage) : null;
  const hasChanges = Boolean(application) && (
    insightsSummary !== (application?.insightsSummary ?? "")
    || JSON.stringify(contactTargets) !== JSON.stringify(application?.contactTargets ?? [])
    || JSON.stringify(messageDrafts) !== JSON.stringify(application?.messageDrafts ?? [])
  );

  async function handleSave() {
    if (!application) return;
    setSaveBusy(true);
    try {
      await bridge.setAppliedNotes(
        application.appliedJob.id,
        JSON.stringify({ insightsSummary, contactTargets, messageDrafts })
      );
      await refresh();
      onNotify({
        tone: "success",
        message: "Application notes saved."
      });
    } catch (saveError) {
      onNotify({
        tone: "error",
        message: saveError instanceof Error ? saveError.message : "Unable to save application notes."
      });
    } finally {
      setSaveBusy(false);
    }
  }

  if (loading && !application) {
    return (
      <WorkspaceFrame
        headerTag="Applied"
        headerTitle="Application"
        sidebarHeader={<SidebarBrand />}
        sidebarNav={<AppSidebar runCount={runs.length} appliedCount={appliedCount} />}
        sidebarFooter={<SidebarFooterPanel session={sessionUser} />}
      >
        <div className="desktop-applied-detail">
          <Card className="overflow-hidden">
            <CardHeader className="desktop-run-detail__hero">
              <div className="desktop-run-detail__hero-copy">
                <div className="desktop-applied-detail__skeleton desktop-applied-detail__skeleton--title" />
                <div className="desktop-applied-detail__skeleton desktop-applied-detail__skeleton--meta" />
              </div>
            </CardHeader>
            <CardContent className="desktop-run-detail__summary-grid">
              <div className="desktop-applied-detail__skeleton desktop-applied-detail__skeleton--metric" />
              <div className="desktop-applied-detail__skeleton desktop-applied-detail__skeleton--metric" />
              <div className="desktop-applied-detail__skeleton desktop-applied-detail__skeleton--metric" />
              <div className="desktop-applied-detail__skeleton desktop-applied-detail__skeleton--metric" />
            </CardContent>
          </Card>
        </div>
      </WorkspaceFrame>
    );
  }

  if (error || !application) {
    return (
      <WorkspaceFrame
        headerTag="Applied"
        headerTitle="Application"
        sidebarHeader={<SidebarBrand />}
        sidebarNav={<AppSidebar runCount={runs.length} appliedCount={appliedCount} />}
        sidebarFooter={<SidebarFooterPanel session={sessionUser} />}
      >
        <Card>
          <CardHeader>
            <CardTitle>Tracked application unavailable</CardTitle>
            <CardDescription>{error || "This application no longer exists in the tracker."}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <BackButton onClick={() => navigate("/applied")} />
          </CardContent>
        </Card>
      </WorkspaceFrame>
    );
  }

  const appliedJob = application.appliedJob;
  const outcomeLabel = appliedJob.submissionConfirmed
    ? "Submitted"
    : (formatSubmissionOutcomeLabel(appliedJob.submitOutcome) ?? "Submitted");

  return (
    <WorkspaceFrame
      headerTag="Applied"
      headerTitle={appliedJob.company}
      sidebarHeader={<SidebarBrand />}
      sidebarNav={<AppSidebar runCount={runs.length} appliedCount={appliedCount} />}
      sidebarFooter={<SidebarFooterPanel session={sessionUser} />}
      headerRight={stageBadge ? <span className={stageBadge.className}>{stageBadge.label}</span> : null}
    >
      <div className="desktop-applied-detail">
        <Card className="overflow-hidden">
          <CardHeader className="desktop-run-detail__hero">
            <div className="desktop-run-detail__hero-copy">
              <CardTitle>{appliedJob.title}</CardTitle>
              <CardDescription>
                {appliedJob.company} · {formatProviderLabel(appliedJob.source)}
                {appliedJob.sourceUrl ? ` · ${appliedJob.sourceUrl}` : ""}
              </CardDescription>
            </div>
            <div className="desktop-run-detail__hero-actions">
              <BackButton onClick={() => navigate("/applied")} />
              <Button
                type="button"
                variant="outline"
                className="h-9 rounded-none"
                onClick={() => window.open(appliedJob.sourceUrl, "_blank", "noopener,noreferrer")}
              >
                <ArrowUpRight className="size-4" />
                Open posting
              </Button>
              {application.run ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 rounded-none"
                  onClick={() => navigate(`/runs/${application.run!.id}`)}
                >
                  View run
                </Button>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="desktop-run-detail__summary-grid">
            <div className="desktop-run-detail__metric">
              <span className="desktop-run-detail__metric-label">Stage</span>
              <strong>{formatApplicationTrackerStage(appliedJob.trackerStage)}</strong>
            </div>
            <div className="desktop-run-detail__metric">
              <span className="desktop-run-detail__metric-label">Applied</span>
              <strong>{formatAppliedAt(appliedJob.appliedAt)}</strong>
            </div>
            <div className="desktop-run-detail__metric">
              <span className="desktop-run-detail__metric-label">Outcome</span>
              <strong>{outcomeLabel}</strong>
            </div>
            <div className="desktop-run-detail__metric">
              <span className="desktop-run-detail__metric-label">Source</span>
              <strong>{formatProviderLabel(appliedJob.source)}</strong>
            </div>
          </CardContent>
        </Card>

        <div className="desktop-applied-detail__grid">
          <div className="desktop-applied-detail__stack">
            <Card className="overflow-hidden">
              <CardHeader>
                <CardTitle>Timeline</CardTitle>
                <CardDescription>Run milestones and manual stage movement stay visible in one sequence.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="desktop-applied-timeline">
                  {application.timeline.map((entry) => (
                    <div key={entry.id} className="desktop-applied-timeline__item">
                      <div className="desktop-applied-timeline__marker" />
                      <div className="desktop-applied-timeline__body">
                        <div className="desktop-applied-timeline__title-row">
                          <strong>{entry.title}</strong>
                          <span>{formatDateTime(entry.occurredAt)}</span>
                        </div>
                        {entry.detail ? <p>{entry.detail}</p> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="overflow-hidden">
              <CardHeader>
                <CardTitle>Company insight</CardTitle>
                <CardDescription>Keep a local brief on why this company matters and what to watch in follow-up.</CardDescription>
              </CardHeader>
              <CardContent className="desktop-applied-editor">
                <label className="desktop-run-feedback__field">
                  <span className="desktop-run-feedback__label">
                    <Sparkles className="size-3.5" />
                    Summary
                  </span>
                  <Textarea
                    value={insightsSummary}
                    onChange={(event) => setInsightsSummary(event.target.value)}
                    rows={6}
                    className="rounded-none"
                    placeholder="What stands out about this company, team, or role?"
                  />
                </label>
              </CardContent>
            </Card>
          </div>

          <div className="desktop-applied-detail__stack">
            <Card className="overflow-hidden">
              <CardHeader className="desktop-applied-card-header">
                <div>
                  <CardTitle>People to reach out to</CardTitle>
                  <CardDescription>Track recruiter, hiring manager, or referral targets for this application.</CardDescription>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 rounded-none px-3 text-[0.74rem]"
                  onClick={() => setContactTargets((current) => [...current, createEmptyContactTarget()])}
                >
                  <Plus className="size-3.5" />
                  Add person
                </Button>
              </CardHeader>
              <CardContent className="desktop-applied-editor">
                {contactTargets.length === 0 ? (
                  <div className="desktop-surface-state">
                    <div className="desktop-surface-state__copy">No outreach targets saved yet.</div>
                  </div>
                ) : (
                  <div className="desktop-applied-editor-list">
                    {contactTargets.map((target) => (
                      <div key={target.id} className="desktop-applied-editor-card">
                        <div className="desktop-applied-editor-card__header">
                          <span><Users className="size-3.5" /> Contact</span>
                          <button
                            type="button"
                            className="desktop-applied-editor-card__remove"
                            onClick={() => setContactTargets((current) => current.filter((entry) => entry.id !== target.id))}
                          >
                            <Trash2 className="size-3.5" />
                            Remove
                          </button>
                        </div>
                        <div className="desktop-applied-editor-card__grid">
                          <Input
                            value={target.name}
                            onChange={(event) => setContactTargets((current) => current.map((entry) => entry.id === target.id ? { ...entry, name: event.target.value } : entry))}
                            className="rounded-none"
                            placeholder="Name"
                          />
                          <Input
                            value={target.title ?? ""}
                            onChange={(event) => setContactTargets((current) => current.map((entry) => entry.id === target.id ? { ...entry, title: event.target.value } : entry))}
                            className="rounded-none"
                            placeholder="Title"
                          />
                          <Input
                            value={target.channel ?? ""}
                            onChange={(event) => setContactTargets((current) => current.map((entry) => entry.id === target.id ? { ...entry, channel: event.target.value } : entry))}
                            className="rounded-none"
                            placeholder="Channel"
                          />
                          <Input
                            value={target.profileUrl ?? ""}
                            onChange={(event) => setContactTargets((current) => current.map((entry) => entry.id === target.id ? { ...entry, profileUrl: event.target.value } : entry))}
                            className="rounded-none"
                            placeholder="Profile URL"
                          />
                        </div>
                        <Textarea
                          value={target.note ?? ""}
                          onChange={(event) => setContactTargets((current) => current.map((entry) => entry.id === target.id ? { ...entry, note: event.target.value } : entry))}
                          rows={3}
                          className="rounded-none"
                          placeholder="Notes"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="overflow-hidden">
              <CardHeader className="desktop-applied-card-header">
                <div>
                  <CardTitle>Message drafts</CardTitle>
                  <CardDescription>Keep reusable outreach drafts attached to this application.</CardDescription>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 rounded-none px-3 text-[0.74rem]"
                  onClick={() => setMessageDrafts((current) => [...current, createEmptyMessageDraft()])}
                >
                  <Plus className="size-3.5" />
                  Add draft
                </Button>
              </CardHeader>
              <CardContent className="desktop-applied-editor">
                {messageDrafts.length === 0 ? (
                  <div className="desktop-surface-state">
                    <div className="desktop-surface-state__copy">No outreach drafts saved yet.</div>
                  </div>
                ) : (
                  <div className="desktop-applied-editor-list">
                    {messageDrafts.map((draft) => (
                      <div key={draft.id} className="desktop-applied-editor-card">
                        <div className="desktop-applied-editor-card__header">
                          <span><Mail className="size-3.5" /> Draft</span>
                          <button
                            type="button"
                            className="desktop-applied-editor-card__remove"
                            onClick={() => setMessageDrafts((current) => current.filter((entry) => entry.id !== draft.id))}
                          >
                            <Trash2 className="size-3.5" />
                            Remove
                          </button>
                        </div>
                        <div className="desktop-applied-editor-card__grid">
                          <Input
                            value={draft.title}
                            onChange={(event) => setMessageDrafts((current) => current.map((entry) => entry.id === draft.id ? { ...entry, title: event.target.value } : entry))}
                            className="rounded-none"
                            placeholder="Draft title"
                          />
                          <Input
                            value={draft.channel ?? ""}
                            onChange={(event) => setMessageDrafts((current) => current.map((entry) => entry.id === draft.id ? { ...entry, channel: event.target.value } : entry))}
                            className="rounded-none"
                            placeholder="Channel"
                          />
                        </div>
                        <Textarea
                          value={draft.body}
                          onChange={(event) => setMessageDrafts((current) => current.map((entry) => entry.id === draft.id ? { ...entry, body: event.target.value } : entry))}
                          rows={5}
                          className="rounded-none"
                          placeholder="Draft message"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="desktop-applied-detail__actions">
              <Button
                type="button"
                className="rounded-none"
                disabled={!hasChanges || saveBusy}
                onClick={() => void handleSave()}
              >
                {saveBusy ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
                Save changes
              </Button>
            </div>
          </div>
        </div>
      </div>
    </WorkspaceFrame>
  );
}

function SettingsPage({
  session,
  desktopState,
  setDesktopState,
  appliedCount
}: {
  session: SessionState;
  desktopState: DesktopState;
  setDesktopState: React.Dispatch<React.SetStateAction<DesktopState>>;
  appliedCount: number;
}) {
  const navigate = useNavigate();
  const [config, setConfig] = useState(desktopState.config);
  const [busy, setBusy] = useState(false);
  const [parseBusy, setParseBusy] = useState(false);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);

  useEffect(() => {
    setConfig(desktopState.config);
  }, [desktopState.config]);

  const resumeRecord = desktopState.resume;
  const onboarding = desktopState.onboarding;
  const profileReady = Boolean(session.user?.onboardingCompleted && onboarding);
  const resumeReady = Boolean(resumeRecord?.filePath);
  const extractedWordCount = resumeRecord?.extractedText?.trim()
    ? resumeRecord.extractedText.trim().split(/\s+/).filter(Boolean).length
    : 0;
  const desiredRoleCount = onboarding?.preferences.desiredRoles.length ?? 0;
  const desiredLocationCount = onboarding?.preferences.desiredLocations.length ?? 0;
  const preferenceCount = desiredRoleCount + desiredLocationCount + (onboarding?.preferences.remoteOnly ? 1 : 0);
  const configDirty = JSON.stringify(config) !== JSON.stringify(desktopState.config);
  const configStateLabel = busy ? "Saving local configuration..." : configDirty ? "Unsaved local changes" : "All local config changes saved.";
  async function saveConfig(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const saved = await desktopBridge.saveConfig(config);
      setDesktopState((current) => ({ ...current, config: saved }));
    } finally {
      setBusy(false);
    }
  }

  async function replaceResume() {
    const picked = await desktopBridge.pickResume() as DesktopResumeRecord | null;
    if (!picked) return;
    setParseBusy(true);
    setParseWarnings([]);
    try {
      const draft = await desktopBridge.parseResume();
      setParseWarnings(draft.warnings);
      setDesktopState((current) => ({
        ...current,
        onboarding: normalizeProfile(draft.profile),
        resume: {
          ...picked,
          extractedText: draft.extractedText
        }
      }));
      await desktopBridge.saveOnboarding(normalizeProfile(draft.profile));
    } catch (error) {
      setDesktopState((current) => ({ ...current, resume: picked }));
      setParseWarnings([error instanceof Error ? error.message : "Resume parsing failed."]);
    } finally {
      setParseBusy(false);
    }
  }

  async function reparseResume() {
    if (!desktopState.resume) return;
    setParseBusy(true);
    setParseWarnings([]);
    try {
      const draft = await desktopBridge.parseResume();
      const normalizedProfile = normalizeProfile(draft.profile);
      setParseWarnings(draft.warnings);
      await desktopBridge.saveOnboarding(normalizedProfile);
      setDesktopState((current) => ({
        ...current,
        onboarding: normalizedProfile,
        resume: current.resume
          ? {
              ...current.resume,
              extractedText: draft.extractedText
            }
          : current.resume
      }));
    } catch (error) {
      setParseWarnings([error instanceof Error ? error.message : "Resume parsing failed."]);
    } finally {
      setParseBusy(false);
    }
  }

  function updateConfig<K extends keyof DesktopAutomationConfig>(key: K, value: DesktopAutomationConfig[K]) {
    setConfig((current: DesktopAutomationConfig) => ({ ...current, [key]: value }));
  }

  function renderConfigSaveBar() {
    return (
      <div className="desktop-settings-savebar">
        <div className="desktop-settings-savebar__copy">{configStateLabel}</div>
        <Button type="submit" size="sm" className="rounded-none" disabled={busy || !configDirty}>
          {busy ? "Saving..." : "Save changes"}
        </Button>
      </div>
    );
  }

  function renderAccountSection() {
    return (
      <div className="desktop-settings-panel-stack">
        <div className="desktop-settings-metrics">
          <div className="desktop-settings-metric">
            <span className="desktop-settings-metric__label">Signed in</span>
            <strong className="desktop-settings-metric__value">{session.user?.email || "Unavailable"}</strong>
          </div>
          <div className="desktop-settings-metric">
            <span className="desktop-settings-metric__label">Profile</span>
            <strong className="desktop-settings-metric__value">{profileReady ? "Complete" : "Incomplete"}</strong>
          </div>
          <div className="desktop-settings-metric">
            <span className="desktop-settings-metric__label">Preferences</span>
            <strong className="desktop-settings-metric__value">{preferenceCount > 0 ? `${preferenceCount} saved` : "None yet"}</strong>
          </div>
        </div>

        <div className="desktop-settings-section-grid">
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Automa account</CardTitle>
              <CardDescription>Session details tied to the currently configured API workspace.</CardDescription>
            </CardHeader>
            <CardContent className="desktop-settings-stack">
              <div className="desktop-settings-list">
                <div className="desktop-settings-list__row">
                  <span className="desktop-settings-list__label">Email</span>
                  <div className="desktop-settings-list__value-block">
                    <strong>{session.user?.email || "Unavailable"}</strong>
                    <span>Signed into the desktop app on this machine.</span>
                  </div>
                </div>
                <div className="desktop-settings-list__row">
                  <span className="desktop-settings-list__label">API workspace</span>
                  <div className="desktop-settings-list__value-block">
                    <strong>{config.apiBaseUrl}</strong>
                    <span>All authenticated product requests route through this origin.</span>
                  </div>
                </div>
                <div className="desktop-settings-list__row">
                  <span className="desktop-settings-list__label">Provider sessions</span>
                  <div className="desktop-settings-list__value-block">
                    <strong>Local to this device</strong>
                    <span>Logins for Workday, Ashby, and other providers stay in the embedded desktop browser.</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Profile control</CardTitle>
              <CardDescription>Use onboarding for your reusable candidate profile and targeting preferences.</CardDescription>
            </CardHeader>
            <CardContent className="desktop-settings-stack">
              <div className="desktop-settings-list">
                <div className="desktop-settings-list__row">
                  <span className="desktop-settings-list__label">Current role</span>
                  <div className="desktop-settings-list__value-block">
                    <strong>{onboarding?.experience.currentTitle || "Not set"}</strong>
                    <span>{onboarding?.experience.currentCompany || "Profile basics and current role are edited in onboarding."}</span>
                  </div>
                </div>
                <div className="desktop-settings-list__row">
                  <span className="desktop-settings-list__label">Targeting</span>
                  <div className="desktop-settings-list__value-block">
                    <strong>{desiredRoleCount > 0 ? `${desiredRoleCount} roles · ${desiredLocationCount} locations` : "No targeting saved"}</strong>
                    <span>These preferences drive the jobs feed and automation queue.</span>
                  </div>
                </div>
              </div>
              <div className="desktop-settings-inline-note">
                Editing profile, resume-derived basics, and targeting in one place keeps the jobs feed and automation answers aligned.
              </div>
              <div className="desktop-settings-inline-actions">
                <Button type="button" variant="outline" size="sm" className="rounded-none" onClick={() => navigate("/onboarding")}>
                  Open onboarding
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  function renderRuntimeSection() {
    return (
      <div className="desktop-settings-panel-stack">
        <div className="desktop-settings-hero">
          <div className="desktop-settings-hero__copy">
            <span className="desktop-settings-hero__eyebrow">Profile runtime</span>
            <h2 className="desktop-settings-hero__title">Resume and browser-visible identity</h2>
            <p className="desktop-settings-hero__body">
              The desktop worker uses your local resume file, parsed profile, and embedded browser session during applications.
            </p>
          </div>
          <Badge variant="secondary" className="w-fit rounded-none">
            {resumeReady ? "Resume loaded" : "Resume missing"}
          </Badge>
        </div>

        <div className="desktop-settings-metrics">
          <div className="desktop-settings-metric">
            <span className="desktop-settings-metric__label">Resume</span>
            <strong className="desktop-settings-metric__value">{resumeReady ? "Ready" : "Missing"}</strong>
          </div>
          <div className="desktop-settings-metric">
            <span className="desktop-settings-metric__label">Extracted text</span>
            <strong className="desktop-settings-metric__value">{extractedWordCount > 0 ? `${extractedWordCount} words` : "Not parsed"}</strong>
          </div>
          <div className="desktop-settings-metric">
            <span className="desktop-settings-metric__label">Embedded browser</span>
            <strong className="desktop-settings-metric__value">Available</strong>
          </div>
        </div>

        <div className="desktop-settings-section-grid">
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Resume asset</CardTitle>
              <CardDescription>The local file Automa uses for parsing and uploads.</CardDescription>
            </CardHeader>
            <CardContent className="desktop-settings-stack">
              {resumeRecord ? (
                <div className="desktop-settings-list">
                  <div className="desktop-settings-list__row">
                    <span className="desktop-settings-list__label">File</span>
                    <div className="desktop-settings-list__value-block">
                      <strong>{resumeRecord.fileName}</strong>
                      <span>{resumeRecord.filePath}</span>
                    </div>
                  </div>
                  <div className="desktop-settings-list__row">
                    <span className="desktop-settings-list__label">Selected</span>
                    <div className="desktop-settings-list__value-block">
                      <strong>{formatDateTime(resumeRecord.selectedAt)}</strong>
                      <span>Re-parse after replacing the file to refresh profile answers.</span>
                    </div>
                  </div>
                  <div className="desktop-settings-list__row">
                    <span className="desktop-settings-list__label">Extracted profile</span>
                    <div className="desktop-settings-list__value-block">
                      <strong>{profileReady ? "Hydrated" : "Needs attention"}</strong>
                      <span>{onboarding?.basics.fullName || onboarding?.basics.email || "No parsed identity available yet."}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="desktop-settings-empty">
                  <div className="desktop-surface-state__copy">No local resume is selected yet. Add one here so Automa can parse your profile and upload the correct file during applications.</div>
                </div>
              )}

              {parseWarnings.length > 0 ? (
                <div className="desktop-warning-stack">
                  {parseWarnings.map((warning) => (
                    <div key={warning} className="desktop-warning-chip">{warning}</div>
                  ))}
                </div>
              ) : null}

              <div className="desktop-settings-inline-actions">
                <Button type="button" variant="outline" size="sm" className="rounded-none" onClick={() => void replaceResume()} disabled={parseBusy}>
                  {parseBusy ? "Parsing..." : resumeRecord ? "Replace resume" : "Add resume"}
                </Button>
                <Button type="button" variant="outline" size="sm" className="rounded-none" onClick={() => void reparseResume()} disabled={parseBusy || !resumeRecord}>
                  Re-parse current resume
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Automation browser</CardTitle>
              <CardDescription>Two contained Electron worker windows keep provider sessions attached to this desktop app.</CardDescription>
            </CardHeader>
            <CardContent className="desktop-settings-stack">
              <div className="desktop-settings-list">
                <div className="desktop-settings-list__row">
                  <span className="desktop-settings-list__label">Session storage</span>
                  <div className="desktop-settings-list__value-block">
                    <strong>{config.automationPartition}</strong>
                    <span>Provider cookies and sessions stay isolated from your normal browser.</span>
                  </div>
                </div>
                <div className="desktop-settings-list__row">
                  <span className="desktop-settings-list__label">Visibility</span>
                  <div className="desktop-settings-list__value-block">
                    <strong>Hidden by default</strong>
                    <span>Open a worker window only when you need to log in, inspect a page, or intervene manually.</span>
                  </div>
                </div>
              </div>
              <div className="desktop-settings-inline-note">
                Browser sessions survive between runs on the shared embedded partition, so both contained worker windows can reuse provider authentication.
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  function renderAutomationSection() {
    return (
      <div className="desktop-settings-panel-stack">
        <div className="desktop-settings-hero">
          <div className="desktop-settings-hero__copy">
            <span className="desktop-settings-hero__eyebrow">Automation</span>
            <h2 className="desktop-settings-hero__title">Daily run behavior</h2>
            <p className="desktop-settings-hero__body">
              Keep the main automation controls visible here. Technical endpoints and filesystem wiring live in Advanced.
            </p>
          </div>
          <Badge variant="secondary" className="w-fit rounded-none">
            {config.mode === "auto-submit" ? "Auto-submit" : "Dry-run"}
          </Badge>
        </div>

        <form className="desktop-settings-form" onSubmit={saveConfig}>
          <div className="desktop-settings-section-grid">
            <Card className="overflow-hidden">
              <CardHeader>
                <CardTitle>Run behavior</CardTitle>
                <CardDescription>Controls that most directly change how the two contained in-app worker windows are executed.</CardDescription>
              </CardHeader>
              <CardContent className="desktop-settings-form-grid">
                <label className="desktop-field">
                  <span className="desktop-field__label">Mode</span>
                  <select className="desktop-select" value={config.mode} onChange={(event) => updateConfig("mode", event.target.value as DesktopAutomationConfig["mode"])}>
                    <option value="auto-submit">Auto-submit</option>
                    <option value="dry-run">Dry-run</option>
                  </select>
                </label>
                <label className="desktop-field">
                  <span className="desktop-field__label">Headless worker</span>
                  <select className="desktop-select" value={config.headless ? "yes" : "no"} onChange={(event) => updateConfig("headless", event.target.value === "yes")}>
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </select>
                </label>
                <label className="desktop-field">
                  <span className="desktop-field__label">Timeout (ms)</span>
                  <Input className="rounded-none" value={String(config.timeoutMs)} onChange={(event) => updateConfig("timeoutMs", Number(event.target.value) || 0)} />
                </label>
                <label className="desktop-field">
                  <span className="desktop-field__label">Parallel workers (max 2)</span>
                  <Input className="rounded-none" value={String(config.maxParallelRuns)} onChange={(event) => updateConfig("maxParallelRuns", Math.max(1, Math.min(2, Number(event.target.value) || 1)))} />
                </label>
                <div className="desktop-settings-inline-note">
                  Worker windows stay hidden by default and only open when you explicitly click View on a running job.
                </div>
              </CardContent>
            </Card>

            <Card className="overflow-hidden">
              <CardHeader>
                <CardTitle>AI routing</CardTitle>
                <CardDescription>Choose which answer engine handles open-ended application questions.</CardDescription>
              </CardHeader>
              <CardContent className="desktop-settings-form-grid">
                <label className="desktop-field">
                  <span className="desktop-field__label">AI provider</span>
                  <select className="desktop-select" value={config.aiProvider} onChange={(event) => updateConfig("aiProvider", event.target.value as DesktopAutomationConfig["aiProvider"])}>
                    <option value="automa_api">Automa API (server key)</option>
                    <option value="none">None</option>
                  </select>
                </label>
                {config.aiProvider === "none" ? (
                  <div className="desktop-settings-inline-note">
                    AI is disabled. Runs will rely on deterministic rules and whatever profile data is already available.
                  </div>
                ) : (
                  <>
                    <div className="desktop-settings-inline-note">
                      AI calls are routed through your authenticated Automa API session so provider keys stay on the server.
                    </div>
                    <label className="desktop-field">
                      <span className="desktop-field__label">Model</span>
                      <Input className="rounded-none" value={config.openaiModel} onChange={(event) => updateConfig("openaiModel", event.target.value)} />
                    </label>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
          {renderConfigSaveBar()}
        </form>
      </div>
    );
  }

  function renderAdvancedSection() {
    return (
      <div className="desktop-settings-panel-stack">
        <div className="desktop-settings-hero">
          <div className="desktop-settings-hero__copy">
            <span className="desktop-settings-hero__eyebrow">Advanced</span>
            <h2 className="desktop-settings-hero__title">Runtime wiring and local paths</h2>
            <p className="desktop-settings-hero__body">
              These controls affect local service routing, API connectivity, and the embedded Electron worker runtime.
            </p>
          </div>
          <Badge variant="outline" className="w-fit rounded-none">
            Technical
          </Badge>
        </div>

        <div className="desktop-settings-disclosure">
          <div className="desktop-settings-disclosure__copy">
            <strong>Advanced controls stay collapsed by default.</strong>
            <span>Open them only when you need to rewire the local desktop environment or inspect the embedded worker runtime.</span>
          </div>
          <Button type="button" variant="outline" size="sm" className="rounded-none" onClick={() => setAdvancedExpanded((current) => !current)}>
            {advancedExpanded ? "Hide advanced" : "Show advanced"}
          </Button>
        </div>

        {advancedExpanded ? (
          <form className="desktop-settings-form" onSubmit={saveConfig}>
            <div className="desktop-settings-section-grid">
              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>Service endpoints</CardTitle>
                  <CardDescription>Origins and service-level configuration used by the desktop app.</CardDescription>
                </CardHeader>
                <CardContent className="desktop-settings-form-grid">
                  <label className="desktop-field">
                    <span className="desktop-field__label">API base URL</span>
                    <Input className="rounded-none" value={config.apiBaseUrl} onChange={(event) => updateConfig("apiBaseUrl", event.target.value)} />
                  </label>
                  <label className="desktop-field">
                    <span className="desktop-field__label">OpenAI API env var</span>
                    <Input className="rounded-none" value={config.openaiApiKeyEnv} onChange={(event) => updateConfig("openaiApiKeyEnv", event.target.value)} />
                  </label>
                  <label className="desktop-field">
                    <span className="desktop-field__label">Ollama base URL</span>
                    <Input className="rounded-none" value={config.ollamaBaseUrl} onChange={(event) => updateConfig("ollamaBaseUrl", event.target.value)} />
                  </label>
                </CardContent>
              </Card>

              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>Embedded worker runtime</CardTitle>
                  <CardDescription>Filesystem output plus the shared in-app browser identifiers the two worker windows attach to.</CardDescription>
                </CardHeader>
                <CardContent className="desktop-settings-form-grid">
                  <label className="desktop-field">
                    <span className="desktop-field__label">Output directory</span>
                    <Input className="rounded-none" value={config.outputDir} onChange={(event) => updateConfig("outputDir", event.target.value)} />
                  </label>
                  <label className="desktop-field">
                    <span className="desktop-field__label">Screenshots directory</span>
                    <Input className="rounded-none" value={config.screenshotsDir} onChange={(event) => updateConfig("screenshotsDir", event.target.value)} />
                  </label>
                  <label className="desktop-field">
                    <span className="desktop-field__label">Embedded debug port</span>
                    <Input className="rounded-none" readOnly value={String(config.automationDebugPort)} />
                  </label>
                  <label className="desktop-field">
                    <span className="desktop-field__label">Embedded partition</span>
                    <Input className="rounded-none" readOnly value={config.automationPartition} />
                  </label>
                </CardContent>
              </Card>
            </div>
            {renderConfigSaveBar()}
          </form>
        ) : (
          <div className="desktop-settings-inline-note">
            The daily workflow stays quieter when API routing, debug ports, and local output paths are hidden until you actually need them.
          </div>
        )}
      </div>
    );
  }

  return (
    <WorkspaceFrame
      headerTag="Settings"
      headerTitle="Settings"
      sidebarHeader={<SidebarBrand />}
      sidebarNav={<AppSidebar runCount={desktopState.runs.length} appliedCount={appliedCount} />}
      sidebarFooter={<SidebarFooterPanel session={session.user} />}
      headerRight={
        <Button
          variant="outline"
          size="sm"
          className="rounded-none"
          onClick={() => window.location.reload()}
        >
          <LogOut className="size-4" />
          Sign out
        </Button>
      }
    >
      <div className="desktop-settings-shell">
        <section className="desktop-settings-content">
          {renderAccountSection()}
          {renderRuntimeSection()}
          {renderAutomationSection()}
          {renderAdvancedSection()}
        </section>
      </div>
    </WorkspaceFrame>
  );
}

function ProtectedRoutes({
  session,
  desktopState,
  setDesktopState,
  hydratingProfile,
  appliedJobs,
  appliedLoading,
  appliedError,
  refreshAppliedJobs,
  jobsRefreshToken,
  onNotify
}: {
  session: SessionState;
  desktopState: DesktopState;
  setDesktopState: React.Dispatch<React.SetStateAction<DesktopState>>;
  hydratingProfile: boolean;
  appliedJobs: AppliedJobRecord[];
  appliedLoading: boolean;
  appliedError: string | null;
  refreshAppliedJobs: () => Promise<void>;
  jobsRefreshToken: number;
  onNotify: (toast: Omit<ToastItem, "id">) => void;
}) {
  const location = useLocation();
  if (session.loading || hydratingProfile) {
    return <div className="flex min-h-screen items-center justify-center">Loading…</div>;
  }
  // No accounts: the only gate is whether first-run setup is done.
  if ((!desktopState.onboarding || !desktopState.resume) && location.pathname !== "/onboarding") {
    return <Navigate to="/onboarding" replace />;
  }

  return (
    <Routes>
      <Route
        path="/onboarding"
        element={<OnboardingPage desktopState={desktopState} setDesktopState={setDesktopState} onNotify={onNotify} />}
      />
      <Route
        path="/jobs"
        element={
          <JobsPage
            runs={desktopState.runs}
            apiBaseUrl={desktopState.config.apiBaseUrl}
            onboarding={desktopState.onboarding}
            appliedJobs={appliedJobs}
            refreshToken={jobsRefreshToken}
            sessionUser={session.user}
            onNotify={onNotify}
          />
        }
      />
      <Route path="/runs" element={<RunsPage runs={desktopState.runs} appliedCount={appliedJobs.length} sessionUser={session.user} onNotify={onNotify} />} />
      <Route path="/runs/:runId" element={<RunDetailPage runs={desktopState.runs} appliedCount={appliedJobs.length} sessionUser={session.user} />} />
      <Route
        path="/applied"
        element={
          <AppliedPage
            runs={desktopState.runs}
            appliedJobs={appliedJobs}
            loading={appliedLoading}
            error={appliedError}
            apiBaseUrl={desktopState.config.apiBaseUrl}
            refreshAppliedJobs={refreshAppliedJobs}
            sessionUser={session.user}
            onNotify={onNotify}
          />
        }
      />
      <Route
        path="/applied/:appliedJobId"
        element={
          <ApplicationDetailPage
            runs={desktopState.runs}
            appliedCount={appliedJobs.length}
            apiBaseUrl={desktopState.config.apiBaseUrl}
            sessionUser={session.user}
            onNotify={onNotify}
          />
        }
      />
      <Route
        path="/settings"
        element={<SettingsPage session={session} desktopState={desktopState} setDesktopState={setDesktopState} appliedCount={appliedJobs.length} />}
      />
      <Route path="*" element={<Navigate to="/jobs" replace />} />
    </Routes>
  );
}

export function App() {
  const [desktopState, setDesktopState] = useDesktopState();
  const session = useSession(desktopState);
  const [hydratingProfile, setHydratingProfile] = useState(false);
  const [jobsRefreshToken, setJobsRefreshToken] = useState(0);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const activeVisibleRun = useMemo(() => getActiveVisibleRun(desktopState.runs), [desktopState.runs]);
  const {
    appliedJobs,
    loading: appliedLoading,
    error: appliedError,
    refresh: refreshAppliedJobs
  } = useAppliedJobs(desktopState.config.apiBaseUrl, Boolean(session.user));

  function pushToast(toast: Omit<ToastItem, "id">) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((current) => [...current, { id, ...toast }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((entry) => entry.id !== id));
    }, 4200);
  }

  useEffect(() => {
    if (session.loading || !session.user?.onboardingCompleted || desktopState.onboarding || hydratingProfile) {
      return;
    }

    // Nothing to hydrate: the profile is written to disk by the main process
    // and arrives with desktop:get-state.
    setHydratingProfile(false);
  }, [desktopState.onboarding, session.loading, session.user]);

  useEffect(() => {
    return desktopBridge.onRunCompleted((payload: RunCompletionEvent) => {
      pushToast({
        tone: payload.applied ? "success" : payload.status === "failed" ? "error" : "neutral",
        message: payload.message
      });
      void refreshAppliedJobs();
      setJobsRefreshToken((current) => current + 1);
    });
  }, [refreshAppliedJobs]);

  return (
    <div className="desktop-app-shell">
      <Routes>
        <Route
          path="/*"
          element={
            <ProtectedRoutes
              session={session}
              desktopState={desktopState}
              setDesktopState={setDesktopState}
              hydratingProfile={hydratingProfile}
              appliedJobs={appliedJobs}
              appliedLoading={appliedLoading}
              appliedError={appliedError}
              refreshAppliedJobs={refreshAppliedJobs}
              jobsRefreshToken={jobsRefreshToken}
              onNotify={pushToast}
            />
          }
      />
      </Routes>
      <InlineBrowserDrawer run={activeVisibleRun} />
      {toasts.length > 0 ? (
        <div
          className={cn(
            "desktop-toast-stack",
            activeVisibleRun ? "desktop-toast-stack--with-drawer" : null
          )}
          aria-live="polite"
          aria-atomic="true"
        >
          {toasts.map((toast) => (
            <div key={toast.id} className={`desktop-toast desktop-toast--${toast.tone}`}>
              {toast.message}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
