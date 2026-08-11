import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureMinimumFounderMessage,
  waasClassifySubmissionObservation,
  waasExtractCompanyDirectionContext,
  waasExtractHiringManagerAndCompany
} from "./workatastartup.js";

test("waasExtractHiringManagerAndCompany parses modal manager row", () => {
  const parsed = waasExtractHiringManagerAndCompany("Reach out to Vignesh at Unbound");
  assert.equal(parsed.hiringManager, "Vignesh");
  assert.equal(parsed.company, "Unbound");
});

test("waasExtractHiringManagerAndCompany safely handles unmatched text", () => {
  const parsed = waasExtractHiringManagerAndCompany("Connect with the team");
  assert.deepEqual(parsed, {});
});

test("ensureMinimumFounderMessage expands short messages to required minimum", () => {
  const output = ensureMinimumFounderMessage("Hi", "Alex Rivera", 50);
  assert.equal(output.length >= 50, true);
});

test("waasClassifySubmissionObservation identifies validation outcomes", () => {
  const classified = waasClassifySubmissionObservation({
    bodyText: "Please write at least 50 characters.",
    modalOpen: true,
    hasValidationError: true,
    hasBotChallenge: false
  });
  assert.equal(classified.outcome, "validation_error");
  assert.equal(classified.confirmed, false);
});

test("waasClassifySubmissionObservation identifies confirmed outcomes", () => {
  const classified = waasClassifySubmissionObservation({
    bodyText: "Thanks for applying. We will be in touch.",
    modalOpen: false,
    hasValidationError: false,
    hasBotChallenge: false
  });
  assert.equal(classified.outcome, "confirmed");
  assert.equal(classified.confirmed, true);
});

test("waasExtractCompanyDirectionContext extracts mission and product direction signals", () => {
  const context = waasExtractCompanyDirectionContext(
    [
      "At Manufact, we're building the infrastructure layer for the next generation of software: AI agents.",
      "Our platform helps developers build, test, and deploy MCP servers and AI-powered applications.",
      "Work directly with founders and shape a YC startup from the inside."
    ].join("\n"),
    "Manufact"
  );

  assert.ok(context);
  assert.match(context ?? "", /infrastructure layer/i);
  assert.match(context ?? "", /platform helps developers/i);
});

test("waasExtractCompanyDirectionContext ignores footer/navigation noise", () => {
  const context = waasExtractCompanyDirectionContext(
    ["Jobs by Role", "Privacy & Terms", "Contact", "Remote Jobs"].join("\n"),
    "Manufact"
  );

  assert.equal(context, undefined);
});
