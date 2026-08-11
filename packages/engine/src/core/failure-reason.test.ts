import test from "node:test";
import assert from "node:assert/strict";
import { deriveFailureReason } from "./failure-reason.js";
import type { JobRunResult } from "./types.js";

function baseResult(): JobRunResult {
  return {
    url: "https://example.com",
    platform: "lever",
    status: "failed",
    submitted: false,
    submissionConfirmed: false,
    dryRun: false,
    notes: [],
    answers: [],
    filledFields: [],
    screenshotPaths: [],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString()
  };
}

test("deriveFailureReason maps blocked required to required_missing", () => {
  const result = baseResult();
  result.submitOutcome = "blocked_pre_submit_unresolved_required";
  result.error = "blocked_pre_submit_unresolved_required:cards[a][field0]";
  const reason = deriveFailureReason(result);
  assert.equal(reason?.category, "required_missing");
  assert.equal(reason?.code, "required_fields_unresolved");
});

test("deriveFailureReason maps session loss", () => {
  const result = baseResult();
  result.submitOutcome = "session_lost";
  result.error = "Target page, context or browser has been closed";
  const reason = deriveFailureReason(result);
  assert.equal(reason?.category, "session_lost");
  assert.equal(reason?.action, "retry");
});

test("deriveFailureReason maps bot challenge", () => {
  const result = baseResult();
  result.submitOutcome = "blocked_bot_challenge";
  const reason = deriveFailureReason(result);
  assert.equal(reason?.category, "bot_challenge");
  assert.equal(reason?.action, "manual_apply");
});
