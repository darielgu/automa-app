/**
 * Forward-only schema migrations, keyed on `PRAGMA user_version`.
 *
 * The index of each entry is the version it produces, so MIGRATIONS[0] takes a
 * blank database to user_version 1. Never edit a released migration; append a
 * new one instead. There is no down path on purpose: a desktop app cannot
 * coordinate a rollback across installs, and a bad migration is better fixed by
 * a follow-up migration than by reversing one that already ran.
 */
export const MIGRATIONS: readonly string[] = [
  // ---- 1: initial local schema -------------------------------------------
  `
  -- Exactly one profile. There are no accounts, so there is no user table and
  -- no user_id anywhere in this schema.
  CREATE TABLE profile (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    full_name            TEXT    NOT NULL DEFAULT '',
    first_name           TEXT    NOT NULL DEFAULT '',
    last_name            TEXT    NOT NULL DEFAULT '',
    email                TEXT    NOT NULL DEFAULT '',
    phone                TEXT    NOT NULL DEFAULT '',
    location             TEXT    NOT NULL DEFAULT '',
    -- JSON blobs, mirroring the engine's CandidateProfile sub-objects.
    basics_json          TEXT    NOT NULL DEFAULT '{}',
    location_json        TEXT    NOT NULL DEFAULT '{}',
    links_json           TEXT    NOT NULL DEFAULT '{}',
    work_auth_json       TEXT    NOT NULL DEFAULT '{}',
    education_json       TEXT    NOT NULL DEFAULT '{}',
    experience_json      TEXT    NOT NULL DEFAULT '{}',
    workday_json         TEXT    NOT NULL DEFAULT '{}',
    demographics_json    TEXT    NOT NULL DEFAULT '{}',
    logistics_json       TEXT    NOT NULL DEFAULT '{}',
    preferences_json     TEXT    NOT NULL DEFAULT '{}',
    custom_answers_json  TEXT    NOT NULL DEFAULT '{}',
    previous_employers_json TEXT NOT NULL DEFAULT '[]',
    is_demo              INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT    NOT NULL,
    updated_at           TEXT    NOT NULL
  );

  CREATE TABLE resumes (
    id             TEXT PRIMARY KEY,
    file_name      TEXT NOT NULL,
    file_path      TEXT NOT NULL,
    mime_type      TEXT NOT NULL DEFAULT '',
    size_bytes     INTEGER NOT NULL DEFAULT 0,
    extracted_text TEXT NOT NULL DEFAULT '',
    -- 'picked' = the user chose a file, 'demo_generated' = we produced it.
    source         TEXT NOT NULL DEFAULT 'picked',
    is_active      INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX resumes_active_idx ON resumes (is_active);

  -- The job corpus. Filled from Supabase or straight from GitHub; the columns
  -- are identical either way because both paths share one normalizer.
  CREATE TABLE jobs (
    simplify_id   TEXT PRIMARY KEY,
    source_repos  TEXT NOT NULL DEFAULT '[]',
    company_name  TEXT NOT NULL,
    company_url   TEXT,
    title         TEXT NOT NULL,
    url           TEXT NOT NULL,
    dedupe_key    TEXT NOT NULL,
    apply_host    TEXT,
    ats_platform  TEXT NOT NULL,
    category      TEXT,
    locations     TEXT NOT NULL DEFAULT '[]',
    terms         TEXT NOT NULL DEFAULT '[]',
    degrees       TEXT NOT NULL DEFAULT '[]',
    sponsorship   TEXT,
    source        TEXT,
    feed_active   INTEGER NOT NULL DEFAULT 1,
    is_visible    INTEGER NOT NULL DEFAULT 1,
    removed_at    INTEGER,
    date_posted   INTEGER,
    date_updated  INTEGER,
    first_seen_at INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    content_hash  TEXT NOT NULL,
    flags         TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX jobs_feed_idx     ON jobs (date_posted DESC, simplify_id DESC);
  CREATE INDEX jobs_platform_idx ON jobs (ats_platform);
  CREATE INDEX jobs_category_idx ON jobs (category);
  CREATE INDEX jobs_active_idx   ON jobs (feed_active, is_visible, removed_at);

  CREATE VIRTUAL TABLE jobs_fts USING fts5(
    title, company_name, content='jobs', content_rowid='rowid'
  );
  CREATE TRIGGER jobs_fts_ai AFTER INSERT ON jobs BEGIN
    INSERT INTO jobs_fts(rowid, title, company_name)
    VALUES (new.rowid, new.title, new.company_name);
  END;
  CREATE TRIGGER jobs_fts_ad AFTER DELETE ON jobs BEGIN
    INSERT INTO jobs_fts(jobs_fts, rowid, title, company_name)
    VALUES ('delete', old.rowid, old.title, old.company_name);
  END;
  CREATE TRIGGER jobs_fts_au AFTER UPDATE ON jobs BEGIN
    INSERT INTO jobs_fts(jobs_fts, rowid, title, company_name)
    VALUES ('delete', old.rowid, old.title, old.company_name);
    INSERT INTO jobs_fts(rowid, title, company_name)
    VALUES (new.rowid, new.title, new.company_name);
  END;

  CREATE TABLE job_feedback (
    job_id     TEXT PRIMARY KEY REFERENCES jobs(simplify_id) ON DELETE CASCADE,
    verdict    TEXT NOT NULL CHECK (verdict IN ('liked','hidden','saved')),
    created_at TEXT NOT NULL
  );

  -- One row per automation attempt. Absorbs what used to live in the
  -- automa-state.json blob, which lost writes when two workers raced.
  CREATE TABLE runs (
    id                  TEXT PRIMARY KEY,
    job_id              TEXT NOT NULL,
    status              TEXT NOT NULL,
    phase               TEXT NOT NULL DEFAULT 'queued',
    mode                TEXT NOT NULL DEFAULT 'dry-run',
    submitted           INTEGER NOT NULL DEFAULT 0,
    submission_confirmed INTEGER NOT NULL DEFAULT 0,
    submit_outcome      TEXT,
    source_url          TEXT NOT NULL DEFAULT '',
    job_title           TEXT NOT NULL DEFAULT '',
    company             TEXT NOT NULL DEFAULT '',
    location            TEXT NOT NULL DEFAULT '',
    source              TEXT NOT NULL DEFAULT '',
    provider            TEXT,
    worker_id           TEXT,
    slot_id             TEXT,
    browser_visible     INTEGER NOT NULL DEFAULT 0,
    failure_detail_json TEXT,
    notes_json          TEXT NOT NULL DEFAULT '[]',
    answers_json        TEXT NOT NULL DEFAULT '[]',
    filled_fields_json  TEXT NOT NULL DEFAULT '[]',
    screenshot_paths_json TEXT NOT NULL DEFAULT '[]',
    submission_receipt_json TEXT,
    workday_summary_json    TEXT,
    output_dir          TEXT,
    created_at          TEXT NOT NULL,
    started_at          TEXT,
    finished_at         TEXT
  );
  CREATE INDEX runs_status_idx  ON runs (status, created_at);
  CREATE INDEX runs_job_idx     ON runs (job_id);
  CREATE INDEX runs_created_idx ON runs (created_at DESC);

  -- The live step stream behind the run view.
  CREATE TABLE run_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id  TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ts      TEXT NOT NULL,
    level   TEXT NOT NULL DEFAULT 'info',
    event   TEXT NOT NULL,
    data    TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX run_events_run_idx ON run_events (run_id, id);

  CREATE TABLE applied_jobs (
    id          TEXT PRIMARY KEY,
    job_id      TEXT NOT NULL UNIQUE,
    run_id      TEXT,
    source_url  TEXT NOT NULL DEFAULT '',
    title       TEXT NOT NULL DEFAULT '',
    company     TEXT NOT NULL DEFAULT '',
    location    TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT '',
    stage       TEXT NOT NULL DEFAULT 'applied'
                CHECK (stage IN ('saved','applied','interviewing','offer','rejected')),
    tracker_order INTEGER NOT NULL DEFAULT 0,
    notes       TEXT NOT NULL DEFAULT '',
    applied_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX applied_stage_idx ON applied_jobs (stage, tracker_order);

  CREATE TABLE applied_job_stage_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    applied_id TEXT NOT NULL REFERENCES applied_jobs(id) ON DELETE CASCADE,
    from_stage TEXT,
    to_stage   TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX applied_stage_events_idx ON applied_job_stage_events (applied_id, id);

  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Per-feed sync bookkeeping, so we can send If-None-Match and stay polite.
  CREATE TABLE feed_meta (
    repo             TEXT PRIMARY KEY,
    etag             TEXT,
    last_fetched_at  INTEGER,
    last_success_at  INTEGER,
    last_http_status INTEGER,
    last_entry_count INTEGER,
    last_error       TEXT
  );

  -- Worker slots, so acquiring one is a transaction instead of a race on a
  -- JSON file.
  CREATE TABLE scheduler_slots (
    slot_id        TEXT PRIMARY KEY,
    lease_id       TEXT,
    current_run_id TEXT,
    dirty          INTEGER NOT NULL DEFAULT 0,
    state          TEXT NOT NULL DEFAULT 'idle'
  );
  `
];
