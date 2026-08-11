import test from "node:test";
import assert from "node:assert/strict";
import { deriveSubmissionReceipt } from "./results.js";
import type { JobRunResult } from "./types.js";

function makeResult(overrides: Partial<JobRunResult> = {}): JobRunResult {
  return {
    url: "https://example.com/job",
    platform: "greenhouse",
    status: "applied",
    submitted: true,
    submissionConfirmed: true,
    submitOutcome: "confirmed",
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

test("deriveSubmissionReceipt prefers review receipt and filters no response rows", () => {
  const result = makeResult({
    platform: "workday",
    reviewReceipt: [
      { section: "Application Questions", question: "Authorized to work", answer: "Yes" },
      { section: "Education", question: "GPA", answer: "No Response" }
    ],
    filledFields: [
      { id: "fallback", label: "Fallback", value: "Ignored", source: "profile", inputKind: "text" }
    ]
  });

  const receipt = deriveSubmissionReceipt(result);
  assert.equal(receipt?.source, "review_receipt");
  assert.deepEqual(receipt?.items, [
    { section: "Application Questions", question: "Authorized to work", answer: "Yes" }
  ]);
});

test("deriveSubmissionReceipt falls back to deduped filled fields", () => {
  const result = makeResult({
    filledFields: [
      { id: "email", label: "Email", value: "first@example.com", source: "profile", inputKind: "text" },
      { id: "email", label: "Email", value: "final@example.com", source: "manual", inputKind: "text" },
      { id: "city", label: "City", value: "San Diego", source: "profile", inputKind: "text" }
    ]
  });

  const receipt = deriveSubmissionReceipt(result);
  assert.equal(receipt?.source, "filled_fields");
  assert.deepEqual(receipt?.items, [
    { question: "Email", answer: "final@example.com" },
    { question: "City", answer: "San Diego" }
  ]);
});

test("deriveSubmissionReceipt falls back to answers and renders arrays and booleans", () => {
  const result = makeResult({
    submitted: true,
    submissionConfirmed: false,
    filledFields: [],
    answers: [
      { questionId: "authorized_to_work", value: true, source: "profile" },
      { questionId: "skills", value: ["TypeScript", "Playwright"], source: "llm" }
    ]
  });

  const receipt = deriveSubmissionReceipt(result);
  assert.equal(receipt?.source, "answers");
  assert.deepEqual(receipt?.items, [
    { question: "authorized_to_work", answer: "Yes" },
    { question: "skills", answer: "TypeScript, Playwright" }
  ]);
});

test("deriveSubmissionReceipt returns undefined for non-submitted results", () => {
  const result = makeResult({
    status: "filled",
    submitted: false,
    submissionConfirmed: false,
    submitOutcome: "not_submitted",
    filledFields: [
      { id: "email", label: "Email", value: "test@example.com", source: "profile", inputKind: "text" }
    ]
  });

  assert.equal(deriveSubmissionReceipt(result), undefined);
});
