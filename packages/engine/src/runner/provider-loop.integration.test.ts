import test from "node:test";
import assert from "node:assert/strict";
import { isTelemetryNote, isTransientInfrastructureFailure, parseReason } from "./provider-loop.js";
import type { JobRunResult } from "../core/types.js";

function makeResult(overrides: Partial<JobRunResult>): JobRunResult {
  return {
    url: "https://jobs.lever.co/example/test",
    platform: "lever",
    status: "filled",
    submitted: false,
    submissionConfirmed: false,
    submitOutcome: "not_submitted",
    dryRun: false,
    notes: [],
    answers: [],
    filledFields: [],
    screenshotPaths: [],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides
  };
}

test("provider-loop integration: telemetry notes are detected", () => {
  assert.equal(isTelemetryNote("lever_stage:navigate attempt=1 ms=12"), true);
  assert.equal(isTelemetryNote("unresolved_required_question:field_1"), false);
});

test("provider-loop integration: parseReason ignores telemetry note in favor of blocker note", () => {
  const result = makeResult({
    notes: [
      "lever_stage:navigate attempt=1 ms=120",
      "unresolved_required_question:field_1:Work authorization"
    ]
  });

  assert.equal(parseReason(result), "unresolved_required_question:field_1:Work authorization");
});

test("provider-loop integration: parseReason falls back to submitOutcome when only telemetry notes exist", () => {
  const result = makeResult({
    notes: ["lever_stage:discover_step_fields attempt=1 ms=450"],
    submitOutcome: "pending_confirmation"
  });

  assert.equal(parseReason(result), "pending_confirmation");
});

test("provider-loop integration: parseReason prefers explicit error first", () => {
  const result = makeResult({
    error: "validation_errors_after_submit:email required\nstack-line",
    notes: ["lever_stage:confirm attempt=1 ms=1200"],
    submitOutcome: "validation_error"
  });

  assert.equal(parseReason(result), "validation_errors_after_submit:email required");
});

test("provider-loop integration: classifies session-lost outcomes as transient infrastructure failures", () => {
  const result = makeResult({
    status: "failed",
    submitOutcome: "session_lost",
    error: "page.evaluate: Target page, context or browser has been closed"
  });

  assert.equal(isTransientInfrastructureFailure(result), true);
});

test("provider-loop integration: does not classify validation errors as transient infrastructure failures", () => {
  const result = makeResult({
    status: "filled",
    submitOutcome: "validation_error",
    notes: ["submit_missing_required:work authorization"]
  });

  assert.equal(isTransientInfrastructureFailure(result), false);
});
