import { randomUUID } from "node:crypto";
import { jsonParse, nowIso, plain, plainAll, transaction, type Db } from "./database.js";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as unknown as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?
  `).run(key, value, nowIso(), value, nowIso());
}

export function getJsonSetting<T>(db: Db, key: string, fallback: T): T {
  return jsonParse<T>(getSetting(db, key), fallback);
}

export function setJsonSetting(db: Db, key: string, value: unknown): void {
  setSetting(db, key, JSON.stringify(value));
}

export function getFlag(db: Db, key: string): boolean {
  return getSetting(db, key) === "1";
}

export function setFlag(db: Db, key: string, value: boolean): void {
  setSetting(db, key, value ? "1" : "0");
}

// ---------------------------------------------------------------------------
// Profile
//
// One row, id = 1. Scalar columns hold the fields the UI filters and sorts on;
// everything nested is JSON, matching the engine's CandidateProfile shape.
// ---------------------------------------------------------------------------

export interface ProfileRecord {
  fullName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  basics: Record<string, unknown>;
  locationStructured: Record<string, unknown>;
  links: Record<string, unknown>;
  workAuthorization: Record<string, unknown>;
  education: Record<string, unknown>;
  experience: Record<string, unknown>;
  workday: Record<string, unknown>;
  demographics: Record<string, unknown>;
  logistics: Record<string, unknown>;
  preferences: Record<string, unknown>;
  customAnswers: Record<string, unknown>;
  previousEmployers: string[];
  isDemo: boolean;
}

const EMPTY_PROFILE: ProfileRecord = {
  fullName: "", firstName: "", lastName: "", email: "", phone: "", location: "",
  basics: {}, locationStructured: {}, links: {}, workAuthorization: {}, education: {},
  experience: {}, workday: {}, demographics: {}, logistics: {}, preferences: {},
  customAnswers: {}, previousEmployers: [], isDemo: false
};

export function getProfile(db: Db): ProfileRecord | null {
  const row = plain(
    db.prepare("SELECT * FROM profile WHERE id = 1").get() as unknown as Record<string, unknown> | undefined
  );
  if (!row) return null;
  return {
    fullName: String(row.full_name ?? ""),
    firstName: String(row.first_name ?? ""),
    lastName: String(row.last_name ?? ""),
    email: String(row.email ?? ""),
    phone: String(row.phone ?? ""),
    location: String(row.location ?? ""),
    basics: jsonParse(row.basics_json, {}),
    locationStructured: jsonParse(row.location_json, {}),
    links: jsonParse(row.links_json, {}),
    workAuthorization: jsonParse(row.work_auth_json, {}),
    education: jsonParse(row.education_json, {}),
    experience: jsonParse(row.experience_json, {}),
    workday: jsonParse(row.workday_json, {}),
    demographics: jsonParse(row.demographics_json, {}),
    logistics: jsonParse(row.logistics_json, {}),
    preferences: jsonParse(row.preferences_json, {}),
    customAnswers: jsonParse(row.custom_answers_json, {}),
    previousEmployers: jsonParse(row.previous_employers_json, [] as string[]),
    isDemo: Number(row.is_demo ?? 0) === 1
  };
}

export function saveProfile(db: Db, input: Partial<ProfileRecord>): ProfileRecord {
  const current = getProfile(db) ?? EMPTY_PROFILE;
  const next: ProfileRecord = { ...current, ...input };
  const now = nowIso();

  db.prepare(`
    INSERT INTO profile (
      id, full_name, first_name, last_name, email, phone, location,
      basics_json, location_json, links_json, work_auth_json, education_json,
      experience_json, workday_json, demographics_json, logistics_json,
      preferences_json, custom_answers_json, previous_employers_json, is_demo,
      created_at, updated_at
    ) VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      full_name = ?, first_name = ?, last_name = ?, email = ?, phone = ?, location = ?,
      basics_json = ?, location_json = ?, links_json = ?, work_auth_json = ?,
      education_json = ?, experience_json = ?, workday_json = ?, demographics_json = ?,
      logistics_json = ?, preferences_json = ?, custom_answers_json = ?,
      previous_employers_json = ?, is_demo = ?, updated_at = ?
  `).run(
    next.fullName, next.firstName, next.lastName, next.email, next.phone, next.location,
    JSON.stringify(next.basics), JSON.stringify(next.locationStructured), JSON.stringify(next.links),
    JSON.stringify(next.workAuthorization), JSON.stringify(next.education), JSON.stringify(next.experience),
    JSON.stringify(next.workday), JSON.stringify(next.demographics), JSON.stringify(next.logistics),
    JSON.stringify(next.preferences), JSON.stringify(next.customAnswers),
    JSON.stringify(next.previousEmployers), next.isDemo ? 1 : 0, now, now,
    // update arm
    next.fullName, next.firstName, next.lastName, next.email, next.phone, next.location,
    JSON.stringify(next.basics), JSON.stringify(next.locationStructured), JSON.stringify(next.links),
    JSON.stringify(next.workAuthorization), JSON.stringify(next.education), JSON.stringify(next.experience),
    JSON.stringify(next.workday), JSON.stringify(next.demographics), JSON.stringify(next.logistics),
    JSON.stringify(next.preferences), JSON.stringify(next.customAnswers),
    JSON.stringify(next.previousEmployers), next.isDemo ? 1 : 0, now
  );

  return next;
}

// ---------------------------------------------------------------------------
// Resumes
// ---------------------------------------------------------------------------

export interface ResumeRecord {
  id: string;
  fileName: string;
  filePath: string;
  mimeType: string;
  sizeBytes: number;
  extractedText: string;
  source: string;
  isActive: boolean;
  createdAt: string;
}

function toResume(row: Record<string, unknown>): ResumeRecord {
  return {
    id: String(row.id),
    fileName: String(row.file_name ?? ""),
    filePath: String(row.file_path ?? ""),
    mimeType: String(row.mime_type ?? ""),
    sizeBytes: Number(row.size_bytes ?? 0),
    extractedText: String(row.extracted_text ?? ""),
    source: String(row.source ?? "picked"),
    isActive: Number(row.is_active ?? 0) === 1,
    createdAt: String(row.created_at ?? "")
  };
}

export function addResume(
  db: Db,
  input: { fileName: string; filePath: string; mimeType?: string; sizeBytes?: number; extractedText?: string; source?: string; makeActive?: boolean }
): ResumeRecord {
  const id = randomUUID();
  return transaction(db, () => {
    if (input.makeActive !== false) db.prepare("UPDATE resumes SET is_active = 0").run();
    db.prepare(`
      INSERT INTO resumes (id, file_name, file_path, mime_type, size_bytes, extracted_text, source, is_active, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      id, input.fileName, input.filePath, input.mimeType ?? "", input.sizeBytes ?? 0,
      input.extractedText ?? "", input.source ?? "picked", input.makeActive === false ? 0 : 1, nowIso()
    );
    return getResume(db, id)!;
  });
}

export function getResume(db: Db, id: string): ResumeRecord | null {
  const row = plain(db.prepare("SELECT * FROM resumes WHERE id = ?").get(id) as unknown as Record<string, unknown> | undefined);
  return row ? toResume(row) : null;
}

export function listResumes(db: Db): ResumeRecord[] {
  const rows = plainAll(
    db.prepare("SELECT * FROM resumes ORDER BY is_active DESC, created_at DESC").all() as unknown as Array<Record<string, unknown>>
  );
  return rows.map(toResume);
}

export function getActiveResume(db: Db): ResumeRecord | null {
  const row = plain(
    db.prepare("SELECT * FROM resumes WHERE is_active = 1 LIMIT 1").get() as unknown as Record<string, unknown> | undefined
  );
  return row ? toResume(row) : null;
}

export function setActiveResume(db: Db, id: string): void {
  transaction(db, () => {
    db.prepare("UPDATE resumes SET is_active = 0").run();
    db.prepare("UPDATE resumes SET is_active = 1 WHERE id = ?").run(id);
  });
}

export function deleteResume(db: Db, id: string): void {
  db.prepare("DELETE FROM resumes WHERE id = ?").run(id);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunRecord {
  id: string;
  jobId: string;
  status: string;
  phase: string;
  mode: string;
  submitted: boolean;
  submissionConfirmed: boolean;
  submitOutcome: string | null;
  sourceUrl: string;
  jobTitle: string;
  company: string;
  location: string;
  source: string;
  provider: string | null;
  workerId: string | null;
  slotId: string | null;
  browserVisible: boolean;
  failureDetail: unknown;
  notes: string[];
  answers: unknown[];
  filledFields: unknown[];
  screenshotPaths: string[];
  submissionReceipt: unknown;
  workdayRunSummary: unknown;
  outputDir: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function toRun(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id),
    jobId: String(row.job_id ?? ""),
    status: String(row.status ?? "queued"),
    phase: String(row.phase ?? "queued"),
    mode: String(row.mode ?? "dry-run"),
    submitted: Number(row.submitted ?? 0) === 1,
    submissionConfirmed: Number(row.submission_confirmed ?? 0) === 1,
    submitOutcome: (row.submit_outcome as string) ?? null,
    sourceUrl: String(row.source_url ?? ""),
    jobTitle: String(row.job_title ?? ""),
    company: String(row.company ?? ""),
    location: String(row.location ?? ""),
    source: String(row.source ?? ""),
    provider: (row.provider as string) ?? null,
    workerId: (row.worker_id as string) ?? null,
    slotId: (row.slot_id as string) ?? null,
    browserVisible: Number(row.browser_visible ?? 0) === 1,
    failureDetail: jsonParse(row.failure_detail_json, null),
    notes: jsonParse(row.notes_json, [] as string[]),
    answers: jsonParse(row.answers_json, [] as unknown[]),
    filledFields: jsonParse(row.filled_fields_json, [] as unknown[]),
    screenshotPaths: jsonParse(row.screenshot_paths_json, [] as string[]),
    submissionReceipt: jsonParse(row.submission_receipt_json, null),
    workdayRunSummary: jsonParse(row.workday_summary_json, null),
    outputDir: (row.output_dir as string) ?? null,
    createdAt: String(row.created_at ?? ""),
    startedAt: (row.started_at as string) ?? null,
    finishedAt: (row.finished_at as string) ?? null
  };
}

export function createRun(
  db: Db,
  input: { jobId: string; sourceUrl: string; jobTitle?: string; company?: string; location?: string; source?: string; mode?: string; provider?: string }
): RunRecord {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO runs (id, job_id, status, phase, mode, source_url, job_title, company, location, source, provider, created_at)
    VALUES (?,?,'queued','queued',?,?,?,?,?,?,?,?)
  `).run(
    id, input.jobId, input.mode ?? "dry-run", input.sourceUrl, input.jobTitle ?? "",
    input.company ?? "", input.location ?? "", input.source ?? "", input.provider ?? null, nowIso()
  );
  return getRun(db, id)!;
}

export function getRun(db: Db, id: string): RunRecord | null {
  const row = plain(db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as unknown as Record<string, unknown> | undefined);
  return row ? toRun(row) : null;
}

export function listRuns(db: Db, limit = 200): RunRecord[] {
  const rows = plainAll(
    db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as Array<Record<string, unknown>>
  );
  return rows.map(toRun);
}

export function listQueuedRuns(db: Db): RunRecord[] {
  const rows = plainAll(
    db.prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY created_at ASC").all() as unknown as Array<Record<string, unknown>>
  );
  return rows.map(toRun);
}

const RUN_COLUMNS: Record<string, string> = {
  status: "status", phase: "phase", mode: "mode", submitOutcome: "submit_outcome",
  provider: "provider", workerId: "worker_id", slotId: "slot_id", outputDir: "output_dir",
  startedAt: "started_at", finishedAt: "finished_at"
};
const RUN_BOOLS: Record<string, string> = {
  submitted: "submitted", submissionConfirmed: "submission_confirmed", browserVisible: "browser_visible"
};
const RUN_JSON: Record<string, string> = {
  failureDetail: "failure_detail_json", notes: "notes_json", answers: "answers_json",
  filledFields: "filled_fields_json", screenshotPaths: "screenshot_paths_json",
  submissionReceipt: "submission_receipt_json", workdayRunSummary: "workday_summary_json"
};

export function updateRun(db: Db, id: string, patch: Partial<RunRecord>): RunRecord | null {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];

  for (const [key, column] of Object.entries(RUN_COLUMNS)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(value === null ? null : String(value));
  }
  for (const [key, column] of Object.entries(RUN_BOOLS)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(value ? 1 : 0);
  }
  for (const [key, column] of Object.entries(RUN_JSON)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(JSON.stringify(value ?? null));
  }

  if (!sets.length) return getRun(db, id);
  values.push(id);
  db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return getRun(db, id);
}

export function appendRunEvent(
  db: Db,
  runId: string,
  event: { event: string; level?: string; data?: unknown }
): void {
  db.prepare("INSERT INTO run_events (run_id, ts, level, event, data) VALUES (?,?,?,?,?)").run(
    runId, nowIso(), event.level ?? "info", event.event, JSON.stringify(event.data ?? {})
  );
}

export interface RunEventRecord {
  id: number;
  ts: string;
  level: string;
  event: string;
  data: unknown;
}

export function listRunEvents(db: Db, runId: string, afterId = 0, limit = 500): RunEventRecord[] {
  const rows = plainAll(
    db.prepare("SELECT id, ts, level, event, data FROM run_events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?")
      .all(runId, afterId, limit) as unknown as Array<Record<string, unknown>>
  );
  return rows.map((row) => ({
    id: Number(row.id),
    ts: String(row.ts),
    level: String(row.level),
    event: String(row.event),
    data: jsonParse(row.data, {})
  }));
}

/** Keeps the event log from growing without bound on a long or looping run. */
export function pruneRunEvents(db: Db, runId: string, keep = 2000): void {
  db.prepare(`
    DELETE FROM run_events WHERE run_id = ? AND id NOT IN (
      SELECT id FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT ?
    )
  `).run(runId, runId, keep);
}

// ---------------------------------------------------------------------------
// Applied jobs / tracker
// ---------------------------------------------------------------------------

export type TrackerStage = "saved" | "applied" | "interviewing" | "offer" | "rejected";

export interface AppliedRecord {
  id: string;
  jobId: string;
  runId: string | null;
  sourceUrl: string;
  title: string;
  company: string;
  location: string;
  source: string;
  stage: TrackerStage;
  trackerOrder: number;
  notes: string;
  appliedAt: string;
  updatedAt: string;
}

function toApplied(row: Record<string, unknown>): AppliedRecord {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    runId: (row.run_id as string) ?? null,
    sourceUrl: String(row.source_url ?? ""),
    title: String(row.title ?? ""),
    company: String(row.company ?? ""),
    location: String(row.location ?? ""),
    source: String(row.source ?? ""),
    stage: String(row.stage ?? "applied") as TrackerStage,
    trackerOrder: Number(row.tracker_order ?? 0),
    notes: String(row.notes ?? ""),
    appliedAt: String(row.applied_at ?? ""),
    updatedAt: String(row.updated_at ?? "")
  };
}

/**
 * Called when a run finishes. Without this the tracker never fills, which was
 * the single most important behaviour to preserve from the old cloud API.
 */
export function upsertAppliedJob(
  db: Db,
  input: { jobId: string; runId?: string | null; sourceUrl?: string; title?: string; company?: string; location?: string; source?: string; stage?: TrackerStage }
): AppliedRecord {
  return transaction(db, () => {
    const existing = plain(
      db.prepare("SELECT * FROM applied_jobs WHERE job_id = ?").get(input.jobId) as unknown as Record<string, unknown> | undefined
    );
    const stage = input.stage ?? "applied";
    const now = nowIso();

    if (existing) {
      db.prepare("UPDATE applied_jobs SET run_id = COALESCE(?, run_id), updated_at = ? WHERE job_id = ?")
        .run(input.runId ?? null, now, input.jobId);
      return toApplied({ ...existing, run_id: input.runId ?? existing.run_id, updated_at: now });
    }

    const tail = db.prepare("SELECT COALESCE(MAX(tracker_order), -1) + 1 AS next FROM applied_jobs WHERE stage = ?")
      .get(stage) as unknown as { next: number };
    const id = randomUUID();
    db.prepare(`
      INSERT INTO applied_jobs (id, job_id, run_id, source_url, title, company, location, source, stage, tracker_order, applied_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, input.jobId, input.runId ?? null, input.sourceUrl ?? "", input.title ?? "",
      input.company ?? "", input.location ?? "", input.source ?? "", stage,
      Number(tail?.next ?? 0), now, now
    );
    db.prepare("INSERT INTO applied_job_stage_events (applied_id, from_stage, to_stage, created_at) VALUES (?,NULL,?,?)")
      .run(id, stage, now);
    return toApplied(
      db.prepare("SELECT * FROM applied_jobs WHERE id = ?").get(id) as unknown as Record<string, unknown>
    );
  });
}

export function listApplied(db: Db): AppliedRecord[] {
  const rows = plainAll(
    db.prepare("SELECT * FROM applied_jobs ORDER BY stage, tracker_order").all() as unknown as Array<Record<string, unknown>>
  );
  return rows.map(toApplied);
}

export function moveAppliedStage(db: Db, id: string, stage: TrackerStage, note = ""): AppliedRecord | null {
  return transaction(db, () => {
    const existing = plain(
      db.prepare("SELECT * FROM applied_jobs WHERE id = ?").get(id) as unknown as Record<string, unknown> | undefined
    );
    if (!existing) return null;
    const from = String(existing.stage);
    const tail = db.prepare("SELECT COALESCE(MAX(tracker_order), -1) + 1 AS next FROM applied_jobs WHERE stage = ?")
      .get(stage) as unknown as { next: number };
    const now = nowIso();
    db.prepare("UPDATE applied_jobs SET stage = ?, tracker_order = ?, updated_at = ? WHERE id = ?")
      .run(stage, Number(tail?.next ?? 0), now, id);
    db.prepare("INSERT INTO applied_job_stage_events (applied_id, from_stage, to_stage, note, created_at) VALUES (?,?,?,?,?)")
      .run(id, from, stage, note, now);
    return toApplied(
      db.prepare("SELECT * FROM applied_jobs WHERE id = ?").get(id) as unknown as Record<string, unknown>
    );
  });
}

export function setAppliedNotes(db: Db, id: string, notes: string): void {
  db.prepare("UPDATE applied_jobs SET notes = ?, updated_at = ? WHERE id = ?").run(notes, nowIso(), id);
}

export function listStageEvents(db: Db, appliedId: string): Array<{ from: string | null; to: string; note: string; at: string }> {
  const rows = plainAll(
    db.prepare("SELECT from_stage, to_stage, note, created_at FROM applied_job_stage_events WHERE applied_id = ? ORDER BY id")
      .all(appliedId) as unknown as Array<Record<string, unknown>>
  );
  return rows.map((row) => ({
    from: (row.from_stage as string) ?? null,
    to: String(row.to_stage),
    note: String(row.note ?? ""),
    at: String(row.created_at)
  }));
}

// ---------------------------------------------------------------------------
// Feed sync bookkeeping
// ---------------------------------------------------------------------------

export interface FeedMeta {
  repo: string;
  etag: string | null;
  lastFetchedAt: number | null;
  lastSuccessAt: number | null;
  lastHttpStatus: number | null;
  lastEntryCount: number | null;
  lastError: string | null;
}

export function getFeedMeta(db: Db, repo: string): FeedMeta | null {
  const row = plain(
    db.prepare("SELECT * FROM feed_meta WHERE repo = ?").get(repo) as unknown as Record<string, unknown> | undefined
  );
  if (!row) return null;
  return {
    repo: String(row.repo),
    etag: (row.etag as string) ?? null,
    lastFetchedAt: (row.last_fetched_at as number) ?? null,
    lastSuccessAt: (row.last_success_at as number) ?? null,
    lastHttpStatus: (row.last_http_status as number) ?? null,
    lastEntryCount: (row.last_entry_count as number) ?? null,
    lastError: (row.last_error as string) ?? null
  };
}

export function listFeedMeta(db: Db): FeedMeta[] {
  const rows = plainAll(db.prepare("SELECT repo FROM feed_meta").all() as unknown as Array<{ repo: string }>);
  return rows.map((row) => getFeedMeta(db, row.repo)!).filter(Boolean);
}

export function saveFeedMeta(db: Db, meta: Partial<FeedMeta> & { repo: string }): void {
  const current = getFeedMeta(db, meta.repo);
  const next = { ...(current ?? { etag: null, lastFetchedAt: null, lastSuccessAt: null, lastHttpStatus: null, lastEntryCount: null, lastError: null }), ...meta };
  db.prepare(`
    INSERT INTO feed_meta (repo, etag, last_fetched_at, last_success_at, last_http_status, last_entry_count, last_error)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(repo) DO UPDATE SET etag = ?, last_fetched_at = ?, last_success_at = ?,
      last_http_status = ?, last_entry_count = ?, last_error = ?
  `).run(
    next.repo, next.etag ?? null, next.lastFetchedAt ?? null, next.lastSuccessAt ?? null,
    next.lastHttpStatus ?? null, next.lastEntryCount ?? null, next.lastError ?? null,
    next.etag ?? null, next.lastFetchedAt ?? null, next.lastSuccessAt ?? null,
    next.lastHttpStatus ?? null, next.lastEntryCount ?? null, next.lastError ?? null
  );
}
