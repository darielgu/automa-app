import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import {
  AshbyAdapter,
  ashbyComputeRetryCooldownMs,
  ashbyClassifySubmissionOutcome,
  ashbyIsAnsweredControl,
  ashbyCollectBotChallengeEvidence,
  ashbyBuildGroupIdentity,
  ashbyClassifyCheckboxControl,
  ashbyExtractValidationErrors,
  ashbyHasBotChallengeIndicators,
  ashbyHasConfirmationText,
  ashbySampleDelayMs,
  ashbyUrlMatchesSuccess
} from "./ashby.js";
import type { CandidateProfile } from "../core/types.js";

test("ashbyHasConfirmationText matches common confirmation copy variants", () => {
  assert.equal(ashbyHasConfirmationText("Thanks, your application has been submitted."), true);
  assert.equal(ashbyHasConfirmationText("We have started reviewing candidates."), false);
});

test("ashbyUrlMatchesSuccess detects expanded success URL patterns", () => {
  assert.equal(ashbyUrlMatchesSuccess("https://jobs.ashbyhq.com/example/application-submitted"), true);
  assert.equal(ashbyUrlMatchesSuccess("https://jobs.ashbyhq.com/example/jobs/123"), false);
});

test("ashbyExtractValidationErrors keeps real errors and drops confirmation text", () => {
  const output = ashbyExtractValidationErrors([
    "Application submitted successfully",
    "Please enter a valid email address",
    "Phone is required",
    "Please enter a valid email address"
  ]);

  assert.deepEqual(output, ["Please enter a valid email address", "Phone is required"]);
});

test("ashbyExtractValidationErrors splits concatenated required-field messages", () => {
  const output = ashbyExtractValidationErrors([
    "Your form needs correctionsMissing entry for required field: NameMissing entry for required field: Email"
  ]);

  assert.deepEqual(output, ["Missing entry for required field: Name", "Missing entry for required field: Email"]);
});

test("ashbyHasBotChallengeIndicators detects challenge text and iframe signals", () => {
  assert.equal(ashbyHasBotChallengeIndicators("Complete this security check to continue", []), true);
  assert.equal(ashbyHasBotChallengeIndicators("Your application submission was flagged as possible spam.", []), false);
  assert.equal(ashbyHasBotChallengeIndicators("We couldn't submit your application.", []), false);
  assert.equal(ashbyHasBotChallengeIndicators("", ["https://challenges.cloudflare.com/turnstile/v0/api.js"]), true);
  assert.equal(ashbyHasBotChallengeIndicators("Application form", ["https://example.com/frame"]), false);
});

test("ashbyHasBotChallengeIndicators detects selector and script-based hard signals", () => {
  assert.equal(ashbyHasBotChallengeIndicators("Application form", [], [".captcha-container"]), true);
  assert.equal(ashbyHasBotChallengeIndicators("Application form", [], [], ["https://www.google.com/recaptcha/api.js"]), false);
});

test("ashbyCollectBotChallengeEvidence returns explicit evidence tags", () => {
  const evidence = ashbyCollectBotChallengeEvidence(
    "Verify you are human",
    ["https://challenges.cloudflare.com/turnstile/v0/api.js"],
    [".captcha-container"],
    ["https://www.google.com/recaptcha/api.js"]
  );

  assert.ok(evidence.some((item) => item.startsWith("hard_text:")));
  assert.ok(evidence.some((item) => item.startsWith("iframe:")));
  assert.ok(evidence.some((item) => item.startsWith("selector:")));
  assert.ok(!evidence.some((item) => item.startsWith("script:")));
});

test("ashbyIsAnsweredControl validates canonical control states", () => {
  assert.equal(ashbyIsAnsweredControl({ kind: "url", value: "https://github.com/dariel" }), true);
  assert.equal(ashbyIsAnsweredControl({ kind: "radio", checkedCount: 1 }), true);
  assert.equal(ashbyIsAnsweredControl({ kind: "yes_no_button", selected: true }), true);
  assert.equal(ashbyIsAnsweredControl({ kind: "textarea", value: "I built resilient automation flows." }), true);
  assert.equal(ashbyIsAnsweredControl({ kind: "combobox", value: "San Diego" }), true);
  assert.equal(ashbyIsAnsweredControl({ kind: "choice_group", selectedCount: 1, checkedCount: 0 }), true);
  assert.equal(ashbyIsAnsweredControl({ kind: "file", fileCount: 0, hasFileChip: true }), true);
  assert.equal(ashbyIsAnsweredControl({ kind: "text", value: "" }), false);
});

test("ashbyClassifyCheckboxControl classifies custom selector groups correctly", () => {
  assert.equal(
    ashbyClassifyCheckboxControl({
      label: "Which office are you willing to work from three days/week?",
      checkboxCount: 3,
      optionLabels: ["San Francisco", "New York", "London"],
      buttonOptionCount: 3
    }),
    "single_select"
  );
  assert.equal(
    ashbyClassifyCheckboxControl({
      label: "Select all technologies you have used",
      checkboxCount: 4,
      optionLabels: ["TypeScript", "Python", "Go", "Rust"],
      buttonOptionCount: 0
    }),
    "multi_select"
  );
  assert.equal(
    ashbyClassifyCheckboxControl({
      label: "I agree to the terms",
      checkboxCount: 1,
      optionLabels: ["I agree"],
      buttonOptionCount: 0
    }),
    "boolean"
  );
  assert.equal(
    ashbyClassifyCheckboxControl({
      label: "Are you authorized to work in the country this role is listed in?",
      checkboxCount: 4,
      optionLabels: ["United States", "Singapore", "No", "N.A. - this is a remote position"],
      buttonOptionCount: 0
    }),
    "single_select"
  );
});

test("ashby group identity is stable across option order", () => {
  const left = ashbyBuildGroupIdentity("workEligibility.office", "office_group", ["San Francisco", "New York"]);
  const right = ashbyBuildGroupIdentity("workEligibility.office", "office_group", ["New York", "San Francisco"]);
  assert.equal(left, right);
});

test("ashby targeted deterministic fallbacks cover known blocker intents", () => {
  const adapter = new AshbyAdapter();
  const profile: CandidateProfile = {
    basics: {
      firstName: "Dariel",
      lastName: "Gutierrez",
      email: "dariel@example.com"
    },
    links: {
      github: "https://github.com/darielgutierrez"
    },
    experience: {
      years: 3
    }
  };

  const givenName = (adapter as any).targetedFallbackValue(
    { id: "q0", label: "Given Name", required: true, type: "text", selector: "", tag: "input" },
    "Given Name",
    profile
  );
  assert.equal(givenName, "Dariel");

  const surname = (adapter as any).targetedFallbackValue(
    { id: "q0b", label: "Family Name", required: true, type: "text", selector: "", tag: "input" },
    "Family Name",
    profile
  );
  assert.equal(surname, "Gutierrez");

  const firstJob = (adapter as any).targetedFallbackValue(
    { id: "q1", label: "Is this your first job?", required: true, type: "single_select", selector: "", tag: "input", options: ["Yes", "No"] },
    "Is this your first job?",
    profile
  );
  assert.equal(firstJob, "No");

  const languageExperience = (adapter as any).targetedFallbackValue(
    { id: "q2", label: "Do you have experience in one or more of the following programming languages?", required: true, type: "single_select", selector: "", tag: "input", options: ["Yes", "No"] },
    "Do you have experience in one or more of the following programming languages?",
    profile
  );
  assert.equal(languageExperience, "Yes");

  const preferredLanguage = (adapter as any).targetedFallbackValue(
    { id: "q3", label: "Preferred coding language", required: true, type: "single_select", selector: "", tag: "input", options: ["Go", "TypeScript", "Python"] },
    "Preferred coding language",
    profile
  );
  assert.equal(preferredLanguage, "TypeScript");

  const source = (adapter as any).targetedFallbackValue(
    { id: "q4", label: "How did you hear about us?", required: true, type: "single_select", selector: "", tag: "input", options: ["Referral", "LinkedIn", "Online Job Board"] },
    "How did you hear about us?",
    profile
  );
  assert.equal(source, "Online Job Board");

  const workCountry = (adapter as any).targetedFallbackValue(
    {
      id: "q4b",
      label: "Are you authorized to work in the country this role is listed in?",
      required: true,
      type: "single_select",
      selector: "",
      tag: "input",
      options: ["United States", "Singapore", "No", "N.A. - this is a remote position"]
    },
    "Are you authorized to work in the country this role is listed in?",
    {
      ...profile,
      country: "United States",
      workAuthorization: {
        authorizedToWork: true,
        requiresSponsorship: false
      }
    }
  );
  assert.equal(workCountry, "United States");

  const github = (adapter as any).targetedFallbackValue(
    { id: "q5", label: "GitHub or code sample URL", required: true, type: "text", selector: "", tag: "input" },
    "GitHub or code sample URL",
    profile
  );
  assert.equal(github, "https://github.com/darielgutierrez");

  const linkedin = (adapter as any).targetedFallbackValue(
    { id: "q5b", label: "LinkedIn Profile", required: true, type: "text", selector: "", tag: "input" },
    "LinkedIn Profile",
    {
      ...profile,
      links: {
        ...profile.links,
        linkedin: "https://linkedin.com/in/dariel-gutierrez"
      }
    }
  );
  assert.equal(linkedin, "https://linkedin.com/in/dariel-gutierrez");

  const commute = (adapter as any).targetedFallbackValue(
    {
      id: "q6",
      label: "Can you commit to commute to the office three days each week?",
      required: true,
      type: "single_select",
      selector: "",
      tag: "input",
      options: ["Yes", "No"]
    },
    "Can you commit to commute to the office three days each week?",
    profile
  );
  assert.equal(commute, "Yes");

  const finalYear = (adapter as any).targetedFallbackValue(
    {
      id: "q7",
      label: "Are you currently in your final year of a Bachelor’s program, or enrolled in a Master’s or PhD program in Computer Science or a related field?",
      required: true,
      type: "single_select",
      selector: "",
      tag: "input",
      options: ["Yes", "No"]
    },
    "Are you currently in your final year of a Bachelor’s program, or enrolled in a Master’s or PhD program in Computer Science or a related field?",
    {
      ...profile,
      education: {
        graduationYear: "2027"
      }
    }
  );
  assert.equal(finalYear, "Yes");

  const graduationDate = (adapter as any).targetedFallbackValue(
    {
      id: "q8",
      label: "Graduation Date",
      required: true,
      type: "text",
      selector: "",
      tag: "input",
      placeholder: "MM/YYYY"
    },
    "Graduation Date",
    {
      ...profile,
      education: {
        endMonth: "May",
        endYear: "2027",
        graduationYear: "2027"
      }
    }
  );
  assert.equal(graduationDate, "05/2027");
});

test("ashby profile-like prompts do not fall back to narrative summary text", () => {
  const adapter = new AshbyAdapter();
  const profile: CandidateProfile = {
    basics: {
      firstName: "Dariel",
      lastName: "Gutierrez",
      fullName: "Dariel Gutierrez",
      email: "dariel@example.com",
      phone: "619-555-1234",
      location: "San Diego, CA"
    },
    experience: {
      summary: "Founder building AI/browser-agent job automation systems."
    },
    customAnswers: {
      gender: "Male"
    }
  };

  const firstName = (adapter as any).autofillFallbackValue(
    { id: "q1", label: "First Name", required: true, type: "text", selector: "", tag: "input" },
    profile
  );
  assert.equal(firstName, "Dariel");

  const pronouns = (adapter as any).autofillFallbackValue(
    { id: "q2", label: "Pronouns", required: true, type: "text", selector: "", tag: "input" },
    profile
  );
  assert.equal(pronouns, "He/Him");

  const missingLabelFallback = (adapter as any).fallbackTextForMissingLabel("Last Name", profile);
  assert.equal(missingLabelFallback, "Gutierrez");
});

test("ashby source mapping order prefers online job board, then LinkedIn, then company website", () => {
  const adapter = new AshbyAdapter() as any;
  const profile: CandidateProfile = {
    basics: {
      firstName: "Dariel",
      lastName: "Gutierrez",
      email: "dariel@example.com"
    }
  };

  const onlineBoard = adapter.targetedFallbackValue(
    {
      id: "source_online_board",
      label: "How did you hear about us?",
      required: true,
      type: "single_select",
      selector: "",
      tag: "input",
      options: ["Referral", "Online Job Board", "LinkedIn", "Company Website"]
    },
    "How did you hear about us?",
    profile
  );
  assert.equal(onlineBoard, "Online Job Board");

  const linkedin = adapter.targetedFallbackValue(
    {
      id: "source_linkedin",
      label: "How did you hear about us?",
      required: true,
      type: "single_select",
      selector: "",
      tag: "input",
      options: ["Referral", "LinkedIn", "Company Website"]
    },
    "How did you hear about us?",
    profile
  );
  assert.equal(linkedin, "LinkedIn");

  const companyWebsite = adapter.targetedFallbackValue(
    {
      id: "source_company_site",
      label: "How did you hear about us?",
      required: true,
      type: "single_select",
      selector: "",
      tag: "input",
      options: ["Referral", "Company Website"]
    },
    "How did you hear about us?",
    profile
  );
  assert.equal(companyWebsite, "Company Website");
});

test("ashby required fallback for source prompts uses deterministic source order", () => {
  const adapter = new AshbyAdapter() as any;
  const fallback = adapter.requiredFallbackValue({
    id: "source_required",
    label: "How did you hear about us?",
    required: true,
    type: "single_select",
    selector: "",
    tag: "input",
    options: ["Referral", "LinkedIn", "Company Website"]
  });
  assert.equal(fallback, "LinkedIn");
});

test("ashby missing-label text fallback uses intent resolver and deterministic terminal fallback", () => {
  const adapter = new AshbyAdapter() as any;
  const profile: CandidateProfile = {
    basics: {
      firstName: "Dariel",
      lastName: "Gutierrez",
      email: "dariel@example.com"
    },
    experience: {
      summary: "Founder summary that should not leak into generic missing-label recovery."
    }
  };

  const generic = adapter.fallbackTextForMissingLabel("Additional context", profile);
  assert.equal(generic, "N/A");

  const explicitSummaryAllowed = adapter.fallbackTextForMissingLabel(
    "Brief background summary",
    profile,
    undefined,
    undefined,
    undefined,
    undefined,
    { allowProfileSummaryFallbackForExplicitSummaryPrompts: true }
  );
  assert.equal(explicitSummaryAllowed, "Founder summary that should not leak into generic missing-label recovery.");

  const explicitSummaryBlocked = adapter.fallbackTextForMissingLabel(
    "Brief background summary",
    profile,
    undefined,
    undefined,
    undefined,
    undefined,
    { allowProfileSummaryFallbackForExplicitSummaryPrompts: false }
  );
  assert.equal(explicitSummaryBlocked, "N/A");
});

test("ashby date-like fallback defaults to today's date and respects placeholder format", () => {
  const adapter = new AshbyAdapter() as any;
  const profile: CandidateProfile = {
    basics: {
      firstName: "Dariel",
      lastName: "Gutierrez",
      email: "dariel@example.com"
    }
  };

  const value = adapter.targetedFallbackValue(
    {
      id: "date_q",
      label: "Earliest start date",
      required: true,
      type: "text",
      selector: "",
      tag: "input",
      placeholder: "MM/DD/YYYY"
    },
    "Earliest start date",
    profile,
    undefined,
    undefined,
    undefined,
    undefined,
    { dateFallbackPolicy: "today" }
  );

  assert.match(String(value), /^\d{2}\/\d{2}\/\d{4}$/);
});

test("ashby date-like token verification accepts equivalent formats", () => {
  const adapter = new AshbyAdapter() as any;
  const field = {
    id: "date_q",
    label: "Earliest start date",
    required: true,
    type: "text",
    selector: "",
    tag: "input"
  };
  const expectedTokens = adapter.expectedSelectionTokens(field, "April 28, 2026");
  const matched = adapter.doesStateMatchExpectedTokens(
    { kind: "text", value: "2026-04-28" },
    expectedTokens
  );
  assert.equal(matched, true);
});

test("ashby graduation option scoring prioritizes year+quarter over weaker matches", () => {
  const adapter = new AshbyAdapter() as any;
  const exact = adapter.scoreGraduationOption("April - June 2027", 2027, "april - june", "may");
  const yearOnly = adapter.scoreGraduationOption("January - March 2027", 2027, "april - june", "may");
  const wrongYear = adapter.scoreGraduationOption("April - June 2028", 2027, "april - june", "may");
  assert.equal(exact > yearOnly, true);
  assert.equal(yearOnly > wrongYear, true);
});

test("ashby graduation prompt detector matches expected graduation combobox labels", () => {
  const adapter = new AshbyAdapter() as any;
  assert.equal(adapter.isGraduationComboboxPrompt("What is your expected graduation date?"), true);
  assert.equal(adapter.isGraduationComboboxPrompt("Earliest start date"), false);
});

test("ashby strict required text keeps llm narrative for unknown prompts when policy is llm-first", () => {
  const adapter = new AshbyAdapter() as any;
  const profile: CandidateProfile = {
    basics: {
      firstName: "Dariel",
      lastName: "Gutierrez",
      email: "dariel@example.com"
    }
  };
  const field = {
    id: "unknown_required",
    label: "Additional context",
    required: true,
    type: "text",
    selector: "",
    tag: "input"
  };
  const narrative = "I focus on reliability-first execution, instrumented debugging, and measurable delivery outcomes across ambiguous projects.";
  const resolved = adapter.resolveEffectiveAnswerForField(
    field,
    { questionId: field.id, value: narrative, source: "llm" },
    profile,
    undefined,
    undefined,
    undefined,
    undefined,
    { unknownRequiredTextPolicy: "llm_first_then_terminal_fallback" },
    true
  );
  assert.equal(resolved?.source, "llm");
  assert.equal(resolved?.value, narrative);
});

test("ashby strict required protected follow-up does not keep llm narrative", () => {
  const adapter = new AshbyAdapter() as any;
  const profile: CandidateProfile = {
    basics: {
      firstName: "Dariel",
      lastName: "Gutierrez",
      email: "dariel@example.com"
    }
  };
  const field = {
    id: "accommodation_followup_required",
    label: "If yes, how can we support you with accommodations during this process?",
    required: true,
    type: "textarea",
    selector: "",
    tag: "textarea"
  };
  const resolved = adapter.resolveEffectiveAnswerForField(
    field,
    { questionId: field.id, value: "Here is a long narrative that should not be used for protected follow-up prompts.", source: "llm" },
    profile,
    undefined,
    undefined,
    undefined,
    undefined,
    { unknownRequiredTextPolicy: "llm_first_then_terminal_fallback" },
    true
  );
  assert.notEqual(resolved?.source, "llm");
  assert.equal(String(resolved?.value), "N/A");
});

test("ashby recovery target mapping uses identity first to avoid cross-field collisions", () => {
  const adapter = new AshbyAdapter();
  const officeIdentity = ashbyBuildGroupIdentity("work.office", "office_group", ["San Francisco", "New York"]);
  const legalIdentity = ashbyBuildGroupIdentity("work.legal", "legal_group", ["Yes", "No"]);
  const fields = [
    {
      id: "office_field",
      label: "Which office are you willing to work from 3 days/week?",
      required: true,
      type: "single_select",
      selector: "",
      tag: "input",
      options: ["San Francisco", "New York"],
      platformMeta: { fieldPath: "work.office", groupIdentity: officeIdentity }
    },
    {
      id: "legal_field",
      label: "Will you now or in the future require sponsorship?",
      required: true,
      type: "single_select",
      selector: "",
      tag: "input",
      options: ["Yes", "No"],
      platformMeta: { fieldPath: "work.legal", groupIdentity: legalIdentity }
    }
  ];
  const targets = (adapter as any).mapMissingLabelsToRecoveryTargets(
    fields,
    ["Which office are you willing to work from 3 days/week?"],
    [{ label: "Which office are you willing to work from 3 days/week?", identity: officeIdentity }]
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.field?.id, "office_field");
});

test("ashby recovery target mapping does not fallback to generic location for non-location validation label", () => {
  const adapter = new AshbyAdapter() as any;
  const fields = [
    {
      id: "loc_field",
      label: "Location",
      required: true,
      type: "single_select",
      selector: "",
      tag: "input",
      options: ["San Francisco", "New York"],
      platformMeta: { fieldPath: "work.location" }
    },
    {
      id: "availability_field",
      label: "Which offices can you work from three days/week?",
      required: true,
      type: "single_select",
      selector: "",
      tag: "input",
      options: ["Paris", "Bordeaux", "Barcelona", "Berlin"],
      platformMeta: { fieldPath: "work.availability" }
    }
  ];
  const targets = adapter.mapMissingLabelsToRecoveryTargets(
    fields,
    ["Preferred deployment environment"],
    []
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.field, undefined);
  assert.equal(String(targets[0]?.identity).startsWith("label:"), true);
});

test("ashby recovery schema conversion keeps container identity for deterministic executor binding", () => {
  const adapter = new AshbyAdapter() as any;
  const detected = adapter.toDetectedFieldFromRecoverySchema({
    fieldPath: "",
    containerIdentity: "group:no_field_path::availability_group::paris|bordeaux|barcelona|berlin",
    label: "Where can you work from?",
    required: true,
    fieldType: "radio",
    possibleAnswers: ["Paris", "Bordeaux", "Barcelona", "Berlin"],
    currentValue: null,
    validationError: "Missing entry for required field: Where can you work from?",
    previousAttempt: { answer: null, selectedOptions: [], failureReason: "missing" },
    htmlSummary: "{}"
  });
  assert.equal(detected.platformMeta?.groupIdentity, "group:no_field_path::availability_group::paris|bordeaux|barcelona|berlin");
  assert.equal(detected.platformMeta?.stableKey, "group:no_field_path::availability_group::paris|bordeaux|barcelona|berlin");
});

test("ashby submit pause sampler stays in configured bounds", () => {
  assert.equal(ashbySampleDelayMs(500, 900, 0), 500);
  assert.equal(ashbySampleDelayMs(500, 900, 0.999), 900);
  const mid = ashbySampleDelayMs(500, 900, 0.5);
  assert.equal(mid >= 500 && mid <= 900, true);
});

test("ashby retry cooldown enforces base delay plus jitter floor", () => {
  const cooldown = ashbyComputeRetryCooldownMs(1200, 180, 520, 0);
  assert.equal(cooldown, 1380);
  const maxCooldown = ashbyComputeRetryCooldownMs(1200, 180, 520, 0.999);
  assert.equal(maxCooldown >= 1380, true);
});

test("ashby timing defaults and explicit overrides are resolved exactly", () => {
  const defaultFieldDelay = ashbySampleDelayMs(220, 640, 0);
  const overrideFieldDelay = ashbySampleDelayMs(333, 333, 0.5);
  assert.equal(defaultFieldDelay, 220);
  assert.equal(overrideFieldDelay, 333);
});

test("ashby validation-error anchoring uses rendered error node container from Back Market fixture", async () => {
  const adapter = new AshbyAdapter() as any;
  const fixturePath = path.resolve(process.cwd(), "src/adapters/fixtures/ashby/backmarket-validation-anchor.html");
  const html = fs.readFileSync(fixturePath, "utf8");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const schema = await adapter.extractSingleFieldSchemaFromValidationErrorNode(
      page,
      "Please confirm which location(s) you would be available to work from ?",
      { answer: null, selectedOptions: [], failureReason: "required" }
    );
    assert.ok(schema);
    assert.ok(schema?.anchorStrategy === "error_node_ancestor" || schema?.anchorStrategy === "aria_describedby");
    assert.equal(schema?.fieldPath, "location.availability");
    assert.equal(schema?.label.includes("location"), true);
    assert.equal(schema?.fieldType, "checkbox_group");
    assert.deepEqual(schema?.possibleAnswers, ["Paris", "Bordeaux", "Barcelona", "Berlin"]);
  } finally {
    await page.close();
    await browser.close();
  }
});

test("ashby live-dom extraction handles Back Market location fieldset without data-field-path", async () => {
  const adapter = new AshbyAdapter() as any;
  const fixturePath = path.resolve(process.cwd(), "src/adapters/fixtures/ashby/backmarket-location-fieldset.html");
  const html = fs.readFileSync(fixturePath, "utf8");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const schema = await adapter.extractSingleFieldSchemaFromLiveDom(
      page,
      "Please confirm which location(s) you would be available to work from ?",
      { basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com", location: "San Diego, CA" } },
      { answer: null, selectedOptions: [], failureReason: "required" }
    );
    assert.ok(schema);
    assert.equal(schema?.fieldType, "checkbox_group");
    assert.equal(schema?.fieldPath, "926b8489-9669-4135-98c7-6b5dff7aeb04");
    assert.equal(schema?.label, "Please confirm which location(s) you would be available to work from ?");
    assert.deepEqual(schema?.possibleAnswers, [
      "Paris, France",
      "Bordeaux, France",
      "Barcelona, Spain",
      "Berlin, Germany"
    ]);
  } finally {
    await page.close();
    await browser.close();
  }
});

test("ashby hard-force checkbox executor clicks all Back Market location options", async () => {
  const adapter = new AshbyAdapter() as any;
  const fixturePath = path.resolve(process.cwd(), "src/adapters/fixtures/ashby/backmarket-location-fieldset.html");
  const html = fs.readFileSync(fixturePath, "utf8");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const forced = await adapter.forceSelectAllCheckboxOptionsInContainer(
      page,
      {
        fieldPath: "926b8489-9669-4135-98c7-6b5dff7aeb04",
        containerIdentity: undefined,
        label: "Please confirm which location(s) you would be available to work from ?",
        required: true,
        fieldType: "checkbox_group",
        possibleAnswers: ["Paris, France", "Bordeaux, France", "Barcelona, Spain", "Berlin, Germany"],
        currentValue: null,
        validationError: "Missing entry for required field: Please confirm which location(s) you would be available to work from ?",
        previousAttempt: { answer: null, selectedOptions: [], failureReason: "required" },
        htmlSummary: "{}"
      },
      ["Paris, France", "Bordeaux, France", "Barcelona, Spain", "Berlin, Germany"]
    );
    assert.equal(forced?.allChecked, true);
    const checked = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLInputElement>("input[type='checkbox']")).filter((item) => item.checked).length
    );
    assert.equal(checked, 4);
  } finally {
    await page.close();
    await browser.close();
  }
});

test("ashby checkbox-group fallback does not toggle off already selected option", async () => {
  const adapter = new AshbyAdapter() as any;
  const html = `
    <fieldset data-field-path="degree_group">
      <div class="_option_abc true">
        <span class="_checked_1hpbx_">
          <input id="degree_undergrad" type="checkbox" name="Undergraduate/Bachelors" checked />
        </span>
        <label for="degree_undergrad" class="_checked_1v5e2_">Undergraduate/Bachelors</label>
      </div>
      <div class="_option_abc">
        <span><input id="degree_masters" type="checkbox" name="Master's" /></span>
        <label for="degree_masters">Master's</label>
      </div>
    </fieldset>
    <script>
      window.__checkboxClicks = 0;
      for (const node of document.querySelectorAll("label, input, div[class*='_option_']")) {
        node.addEventListener("click", () => { window.__checkboxClicks += 1; });
      }
    </script>
  `;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const output = await adapter.fillCheckboxGroupFieldsetFallback(
      page,
      {
        id: "degree_type",
        label: "Degree Type",
        type: "multi_select",
        required: true,
        selector: "",
        selectorCandidates: [],
        options: ["Undergraduate/Bachelors", "Master's"],
        placeholder: "",
        tag: "input",
        platformMeta: { fieldPath: "degree_group" }
      },
      ["Undergraduate/Bachelors"]
    );
    assert.equal(output.applied, true);
    const checked = await page.evaluate(() =>
      (document.querySelector("#degree_undergrad") as HTMLInputElement | null)?.checked ?? false
    );
    const clicks = await page.evaluate(() => (window as any).__checkboxClicks ?? 0);
    assert.equal(checked, true);
    assert.equal(clicks, 0);
  } finally {
    await page.close();
    await browser.close();
  }
});

test("ashby checkbox-group fallback ensures expected option selected without clearing others", async () => {
  const adapter = new AshbyAdapter() as any;
  const html = `
    <fieldset data-field-path="role_group">
      <div class="_option_abc">
        <span><input id="role_product" type="checkbox" name="Product" /></span>
        <label for="role_product">Product</label>
      </div>
      <div class="_option_abc">
        <span class="_checked_1hpbx_"><input id="role_platform" type="checkbox" name="Platform" checked /></span>
        <label for="role_platform" class="_checked_1v5e2_">Platform</label>
      </div>
    </fieldset>
  `;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const output = await adapter.fillCheckboxGroupFieldsetFallback(
      page,
      {
        id: "role_type",
        label: "What type of role are you interested in?",
        type: "multi_select",
        required: true,
        selector: "",
        selectorCandidates: [],
        options: ["Product", "Platform"],
        placeholder: "",
        tag: "input",
        platformMeta: { fieldPath: "role_group" }
      },
      ["Product"]
    );
    assert.equal(output.applied, true);
    const state = await page.evaluate(() => ({
      product: (document.querySelector("#role_product") as HTMLInputElement | null)?.checked ?? false,
      platform: (document.querySelector("#role_platform") as HTMLInputElement | null)?.checked ?? false
    }));
    assert.equal(state.product, true);
    assert.equal(state.platform, true);
  } finally {
    await page.close();
    await browser.close();
  }
});

test("ashby verifyFieldAnswered uses checkbox selected class signals for multi-select", async () => {
  const adapter = new AshbyAdapter() as any;
  const html = `
    <fieldset data-field-path="role_group_verify">
      <div class="_option_row true">
        <span class="_checked_1hpbx_"><input id="role_data" type="checkbox" name="Data" /></span>
        <label for="role_data" class="_checked_1v5e2_">Data</label>
      </div>
    </fieldset>
  `;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const verified = await adapter.verifyFieldAnswered(
      page,
      {
        id: "role_verify",
        label: "What type of role are you interested in?",
        type: "multi_select",
        required: true,
        selector: "",
        selectorCandidates: [],
        options: ["Data"],
        placeholder: "",
        tag: "input",
        platformMeta: { fieldPath: "role_group_verify" }
      },
      ["Data"]
    );
    assert.equal(verified, true);
  } finally {
    await page.close();
    await browser.close();
  }
});

test("ashby office fallback resolver prefers direct match, then best office match when relocation-open", () => {
  const adapter = new AshbyAdapter();
  const direct = (adapter as any).resolveOfficeOption(
    ["San Francisco, CA", "New York, NY"],
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com", location: "San Francisco, CA" },
      customAnswers: { "open to relocating anywhere": true }
    },
    "San Francisco, CA",
    { officeFallbackPolicy: "best_match" }
  );
  assert.equal(direct, "San Francisco, CA");

  const bestMatch = (adapter as any).resolveOfficeOption(
    ["Austin, TX", "San Francisco, CA", "London, UK"],
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com", location: "San Diego, CA" },
      state: "California",
      country: "United States",
      customAnswers: { "open to relocating anywhere": true }
    },
    "San Diego, CA",
    { officeFallbackPolicy: "best_match" }
  );
  assert.equal(bestMatch, "San Francisco, CA");
});

test("ashby location-availability selector chooses best profile-context option", () => {
  const adapter = new AshbyAdapter() as any;
  const selected = adapter.resolveLocationAvailabilitySelections(
    ["Paris", "Bordeaux", "Barcelona", "Berlin", "San Francisco, CA"],
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com", location: "San Diego, CA" },
      state: "California",
      country: "United States"
    },
    "San Diego, CA",
    { officeFallbackPolicy: "best_match" }
  );
  assert.deepEqual(selected, ["San Francisco, CA"]);
});

test("ashby location-availability selector falls back to office resolver when no scored match", () => {
  const adapter = new AshbyAdapter() as any;
  const selected = adapter.resolveLocationAvailabilitySelections(
    ["Paris", "Bordeaux", "Barcelona", "Berlin"],
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com", location: "San Diego, CA" },
      state: "California",
      country: "United States"
    },
    undefined,
    { officeFallbackPolicy: "best_match" }
  );
  assert.equal(Array.isArray(selected), true);
  assert.equal(selected.length, 1);
  assert.equal(["Paris", "Bordeaux", "Barcelona", "Berlin"].includes(selected[0]), true);
});

test("ashby sponsorship single-select mapping prefers explicit no-sponsorship option", () => {
  const adapter = new AshbyAdapter() as any;
  const mapped = adapter.pickOptionForYesNo(
    ["I will require sponsorship", "I will not require sponsorship"],
    "Will you require sponsorship to work in the United States now or in the future?",
    "no"
  );
  assert.equal(mapped, "I will not require sponsorship");
});

test("ashby sanitizeValueForField maps no/false to semantic no-sponsorship option", () => {
  const adapter = new AshbyAdapter() as any;
  const field = {
    id: "sponsor_field",
    label: "Will you require sponsorship to work in the United States now or in the future?",
    required: true,
    type: "single_select",
    selector: "",
    tag: "input",
    options: ["I will require sponsorship", "I will not require sponsorship"]
  };
  const sanitizedFromNo = adapter.sanitizeValueForField(field, "No");
  const sanitizedFromFalse = adapter.sanitizeValueForField(field, false);
  assert.equal(sanitizedFromNo, "I will not require sponsorship");
  assert.equal(sanitizedFromFalse, "I will not require sponsorship");
});

test("ashby expected selection matcher rejects wrong selected yes/no option", () => {
  const adapter = new AshbyAdapter() as any;
  const field = {
    id: "sponsor_field",
    label: "Will you require sponsorship to work in the United States now or in the future?",
    required: true,
    type: "single_select",
    selector: "",
    tag: "input",
    options: ["I will require sponsorship", "I will not require sponsorship"]
  };
  const expectedTokens = adapter.expectedSelectionTokens(field, "No");
  const wrong = adapter.doesStateMatchExpectedTokens(
    { kind: "choice_group", selectedCount: 1, checkedCount: 1, selectedLabels: ["I will require sponsorship"] },
    expectedTokens
  );
  const correct = adapter.doesStateMatchExpectedTokens(
    { kind: "choice_group", selectedCount: 1, checkedCount: 1, selectedLabels: ["I will not require sponsorship"] },
    expectedTokens
  );
  assert.equal(wrong, false);
  assert.equal(correct, true);
});

test("ashby expected selection matcher accepts degree semantic aliases for combobox selections", () => {
  const adapter = new AshbyAdapter() as any;
  const field = {
    id: "degree_field",
    label: "Degree",
    required: true,
    type: "single_select",
    selector: "",
    tag: "input",
    options: ["Undergraduate/Bachelors", "Master's Degree"]
  };
  const expectedTokens = adapter.expectedSelectionTokens(field, "Bachelor's Degree");
  const matched = adapter.doesStateMatchExpectedTokens(
    { kind: "combobox", value: "", selectedCount: 1, selectedLabels: ["Undergraduate/Bachelors"] },
    expectedTokens
  );
  assert.equal(matched, true);
});

test("ashby location-aware fallback handles 'currently based' prompt labels", () => {
  const adapter = new AshbyAdapter() as any;
  const value = adapter.locationAwareFallbackValue(
    {
      label: "Where are you currently based?",
      type: "text"
    },
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com", location: "San Diego, CA" }
    }
  );
  assert.equal(value, "San Diego, California, United States");
});

test("ashby location-aware fallback prefers profile location over posting location for selection", () => {
  const adapter = new AshbyAdapter() as any;
  const value = adapter.locationAwareFallbackValue(
    {
      label: "Where are you currently based?",
      type: "single_select",
      options: ["San Diego, CA", "New York, NY"]
    },
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com", location: "San Diego, CA" },
      state: "California",
      country: "United States"
    },
    "New York, NY"
  );
  assert.equal(value, "San Diego, CA");
});

test("ashby country-of-residence prompt prefers profile country and not city", () => {
  const adapter = new AshbyAdapter() as any;
  const singleSelectValue = adapter.locationAwareFallbackValue(
    {
      label: "Please let us know your current country of residence",
      type: "single_select",
      options: ["United Kingdom", "United States"]
    },
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com", location: "San Diego, CA" },
      state: "California",
      country: "United States"
    },
    "London, United Kingdom"
  );
  assert.equal(singleSelectValue, "United States");

  const textValue = adapter.locationAwareFallbackValue(
    {
      label: "Please let us know your current country of residence",
      type: "text",
      options: undefined
    },
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com", location: "San Diego, CA" },
      state: "California",
      country: "United States"
    },
    "London, United Kingdom"
  );
  assert.equal(textValue, "United States");
});

test("ashby hybrid work preference selects remote when profile is not near listed hubs", () => {
  const adapter = new AshbyAdapter() as any;
  const value = adapter.autofillFallbackValue(
    {
      id: "q_hybrid",
      label:
        "What best describes your interest in hybrid work at Homebase? Homebase is a hybrid-first company. We work from the office on Tuesdays and Wednesdays in Denver, Houston, San Francisco, and Toronto.",
      required: true,
      type: "single_select",
      selector: "",
      tag: "input",
      options: [
        "I live near a Homebase hub and can work hybrid (in-office Tues/Wed)",
        "I don’t live near a hub and prefer remote opportunities"
      ]
    },
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com", location: "San Diego, CA" },
      state: "California",
      country: "United States"
    }
  );
  assert.equal(value, "I don’t live near a hub and prefer remote opportunities");
});

test("ashby accommodations prompt defaults to no", () => {
  const adapter = new AshbyAdapter() as any;
  const value = adapter.autofillFallbackValue(
    {
      id: "q_accommodation",
      label:
        "Do you require any accommodations or assistance to participate fully in our application process or perform the essential functions of this role?",
      required: true,
      type: "single_select",
      selector: "",
      tag: "input",
      options: [
        "Yes, I would like to request an accommodation(s)",
        "No, I do not require any accommodations at this time"
      ]
    },
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com", location: "San Diego, CA" }
    }
  );
  assert.equal(value, "No, I do not require any accommodations at this time");
});

test("ashby accommodation policy acknowledgement prompt is not forced to no-accommodation policy answer", () => {
  const adapter = new AshbyAdapter() as any;
  const value = adapter.resolveAccommodationPolicyValue(
    {
      label:
        "Notion is an in person company. Please confirm that you have read and understand Notion’s in office requirements and policy. Notion will consider requests for accommodation.",
      type: "single_select",
      options: ["Yes", "No"]
    },
    { accommodationPolicy: "no_and_fill_followup_na" }
  );
  assert.equal(value, null);
});

test("ashby work-authorization prompt maps to yes when authorizedToWork is true", () => {
  const adapter = new AshbyAdapter() as any;
  const mapped = adapter.resolveProfilePromptValue(
    {
      id: "auth_q",
      label: "Are you authorized to work lawfully in the United States?",
      required: true,
      type: "single_select",
      selector: "",
      tag: "input",
      options: ["Yes", "No"]
    },
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com" },
      workAuthorization: { authorizedToWork: true, requiresSponsorship: false }
    }
  );
  assert.equal(mapped?.value, "Yes");
});

test("ashby accommodation follow-up prompt defaults to N/A", () => {
  const adapter = new AshbyAdapter() as any;
  const value = adapter.autofillFallbackValue(
    {
      id: "q_accommodation_followup",
      label: "If yes, how can we support you with accommodations during this process?",
      required: true,
      type: "textarea",
      selector: "",
      tag: "textarea"
    },
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com", location: "San Diego, CA" },
      experience: { summary: "Founder summary should not be used here." }
    }
  );
  assert.equal(value, "N/A");
});

test("ashby accommodation follow-up never falls back to profile summary", () => {
  const adapter = new AshbyAdapter() as any;
  const value = adapter.targetedFallbackValue(
    {
      id: "q_accommodation_followup",
      label: "If you selected yes, how can we support you? Your privacy matters to us.",
      required: true,
      type: "textarea",
      selector: "",
      tag: "textarea"
    },
    "If you selected yes, how can we support you? Your privacy matters to us.",
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com" },
      experience: { summary: "This should not appear in accommodation follow-up fields." }
    }
  );
  assert.equal(value, "N/A");
});

test("ashby conditional text follow-up falls back to deterministic N/A and not profile summary", () => {
  const adapter = new AshbyAdapter() as any;
  const value = adapter.targetedFallbackValue(
    {
      id: "q_conditional_followup",
      label: "If yes, please explain",
      required: true,
      type: "textarea",
      selector: "",
      tag: "textarea"
    },
    "If yes, please explain",
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com" },
      experience: { summary: "This should never be used for conditional follow-up." }
    }
  );
  assert.equal(value, "N/A");
});

test("ashby quoted conditional prompts classify as conditional follow-up and resolve to deterministic N/A", () => {
  const adapter = new AshbyAdapter() as any;
  const intent = adapter.classifyAshbyTextPromptIntent("If you selected “Yes,” please explain.", "textarea");
  assert.equal(intent, "conditional_followup");

  const value = adapter.targetedFallbackValue(
    {
      id: "q_conditional_quotes",
      label: "If you selected “Yes,” please explain.",
      required: true,
      type: "textarea",
      selector: "",
      tag: "textarea"
    },
    "If you selected “Yes,” please explain.",
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com" },
      experience: { summary: "Should not be used." }
    }
  );
  assert.equal(value, "N/A");
});

test("ashby referral detail prompt is treated as conditional follow-up and not application source", () => {
  const adapter = new AshbyAdapter() as any;
  const field = {
    id: "q_referral_detail",
    label:
      "Are you a referral? If so, please provide the name of the employee who referred you and your relationship.",
    required: true,
    type: "text",
    selector: "",
    tag: "input"
  };
  const profile: CandidateProfile = {
    basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com" }
  };

  const mapped = adapter.resolveProfilePromptValue(field, profile, undefined, undefined);
  assert.equal(mapped, null);

  const value = adapter.autofillFallbackValue(field, profile);
  assert.equal(value, "N/A");
});

test("ashby generic open text prompt resolves to deterministic final fallback instead of profile summary", () => {
  const adapter = new AshbyAdapter() as any;
  const value = adapter.autofillFallbackValue(
    {
      id: "q_generic",
      label: "Any additional information you'd like to share?",
      required: true,
      type: "textarea",
      selector: "",
      tag: "textarea"
    },
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com" },
      experience: { summary: "Founder summary that should not leak here." }
    }
  );
  assert.equal(value, "N/A");
});

test("ashby explicit summary prompts may use profile summary fallback when enabled", () => {
  const adapter = new AshbyAdapter() as any;
  const value = adapter.autofillFallbackValue(
    {
      id: "q_summary",
      label: "Please provide a brief background summary.",
      required: true,
      type: "textarea",
      selector: "",
      tag: "textarea"
    },
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com" },
      experience: { summary: "Founder building reliable TypeScript automation systems." }
    },
    undefined,
    undefined,
    undefined,
    undefined,
    { allowProfileSummaryFallbackForExplicitSummaryPrompts: true }
  );
  assert.equal(value, "Founder building reliable TypeScript automation systems.");
});

test("ashby explicit summary prompts fall back to deterministic final fallback when summary allowance is disabled", () => {
  const adapter = new AshbyAdapter() as any;
  const value = adapter.autofillFallbackValue(
    {
      id: "q_summary_disabled",
      label: "Please provide a brief background summary.",
      required: true,
      type: "textarea",
      selector: "",
      tag: "textarea"
    },
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com" },
      experience: { summary: "Founder summary that should be blocked when disabled." }
    },
    undefined,
    undefined,
    undefined,
    undefined,
    { allowProfileSummaryFallbackForExplicitSummaryPrompts: false }
  );
  assert.equal(value, "N/A");
});

test("ashby accommodation policy markers are emitted for no + follow-up N/A", () => {
  const adapter = new AshbyAdapter() as any;
  const result = { notes: [] as string[] };
  adapter.recordAccommodationPolicyMarker(
    result,
    {
      label: "Do you require any accommodations for this role?",
      type: "single_select",
      options: ["Yes", "No"]
    },
    "No"
  );
  adapter.recordAccommodationPolicyMarker(
    result,
    {
      label: "If yes, how can we support you with accommodations?",
      type: "textarea",
      options: undefined
    },
    "N/A"
  );
  assert.ok(result.notes.includes("policy:accommodation:no_selected"));
  assert.ok(result.notes.includes("policy:accommodation_followup:na_filled"));
});

test("ashby deterministic terminal text fallback marker is emitted for required text fields", () => {
  const adapter = new AshbyAdapter() as any;
  const result = { notes: [] as string[] };
  adapter.recordDeterministicFinalTextFallbackMarker(
    result,
    {
      label: "Additional context",
      type: "textarea",
      required: true
    },
    "N/A",
    { finalTextFallbackValue: "N/A" },
    "deterministic_final_text_fallback"
  );
  assert.ok(result.notes.includes("policy:text_fallback:deterministic_final:Additional context"));
});

test("ashby narrative fallback covers AI build/program prompts with substantive responses", () => {
  const adapter = new AshbyAdapter();
  const profile: CandidateProfile = {
    basics: {
      firstName: "Dariel",
      lastName: "Gutierrez",
      email: "dariel@example.com"
    },
    experience: {
      summary: "Founder building AI/browser-agent job automation systems and former Software Engineer Intern at Salesforce."
    }
  };

  const aiBuild = (adapter as any).buildNarrativeFallback(
    "What’s the last thing you’ve built or automated using AI in your personal or professional career?",
    profile,
    "Notable",
    "Program Manager"
  );
  assert.ok(typeof aiBuild === "string" && aiBuild.length > 120);

  const ownedProgram = (adapter as any).buildNarrativeFallback(
    "Describe a program you personally owned that required coordinating multiple teams.",
    profile,
    "Notable",
    "Program Manager"
  );
  assert.ok(typeof ownedProgram === "string" && ownedProgram.length > 120);

  const funnel = (adapter as any).buildNarrativeFallback(
    "Tell me about a program or funnel you’ve managed. What metrics did you track, and how did you identify and fix a bottleneck?",
    profile,
    "Notable",
    "Program Manager"
  );
  assert.ok(typeof funnel === "string" && funnel.length > 120);

  const wellSuited = (adapter as any).buildNarrativeFallback(
    "What makes you particularly well suited for this role?",
    profile,
    "Notable",
    "Program Manager"
  );
  assert.ok(typeof wellSuited === "string" && wellSuited.length > 120);
});

test("ashby strict required mode keeps LLM answer for open-ended prompts", () => {
  const adapter = new AshbyAdapter();
  const field = {
    id: "q_open",
    label: "Tell me about a program or funnel you've managed and how you fixed a bottleneck",
    required: true,
    type: "textarea",
    selector: "",
    tag: "textarea"
  };
  const raw = {
    questionId: "q_open",
    value:
      "I owned an intake-to-execution funnel, tracked stage conversion and cycle time, then fixed bottlenecks by tightening qualification and automating handoffs across teams.",
    source: "llm",
    reason: "llm_batch"
  };
  const out = (adapter as any).resolveEffectiveAnswerForField(
    field,
    raw,
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com" }
    },
    "Notable",
    "Program Manager",
    undefined,
    undefined,
    undefined,
    true
  );
  assert.equal(out?.source, "llm");
  assert.equal(String(out?.value ?? "").includes("funnel"), true);
});

test("ashby resolveEffectiveAnswerForField in strict required mode does not synthesize fallback answers", () => {
  const adapter = new AshbyAdapter() as any;
  const profile: CandidateProfile = {
    basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com" },
    experience: { summary: "Built reliable automation systems in TypeScript." }
  };

  const motivationField = {
    id: "q_motivation_reason",
    label: "Why do you think you're a great fit for this role?",
    required: true,
    type: "text",
    selector: "",
    tag: "input"
  };
  const motivationResolved = adapter.resolveEffectiveAnswerForField(
    motivationField,
    undefined,
    profile,
    "Acme",
    "Software Engineer",
    undefined,
    undefined,
    undefined,
    true
  );
  assert.equal(motivationResolved, undefined);

  const genericField = {
    id: "q_generic_reason",
    label: "Additional context",
    required: true,
    type: "text",
    selector: "",
    tag: "input"
  };
  const genericResolved = adapter.resolveEffectiveAnswerForField(
    genericField,
    undefined,
    profile,
    undefined,
    undefined,
    undefined,
    undefined,
    { finalTextFallbackValue: "N/A" },
    true
  );
  assert.equal(genericResolved, undefined);
});

test("ashby keeps llm narrative for open-ended prompts when content is valid", () => {
  const adapter = new AshbyAdapter();
  const field = {
    id: "q_narrative_guard",
    label: "Describe a program you personally owned that required coordinating multiple teams.",
    required: true,
    type: "textarea",
    selector: "",
    tag: "textarea"
  };
  const raw = {
    questionId: "q_narrative_guard",
    value:
      "I managed a project that involved coordinating multiple teams. I tracked metrics and improved efficiency with a successful launch.",
    source: "llm",
    reason: "llm_batch"
  };
  const out = (adapter as any).resolveEffectiveAnswerForField(
    field,
    raw,
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com" },
      experience: { summary: "Founder building automation systems", currentCompany: "Automa", currentTitle: "Founder" },
      skillsSummary: "TypeScript, Playwright, Node.js"
    },
    "Notable",
    "Program Manager",
    undefined,
    undefined,
    undefined,
    false
  );
  assert.equal(out?.source, "llm");
  assert.equal(String(out?.value ?? "").includes("coordinating multiple teams"), true);
});

test("ashby narrative quality guardrail keeps specific llm narrative", () => {
  const adapter = new AshbyAdapter();
  const field = {
    id: "q_narrative_keep",
    label: "Tell me about a program or funnel you’ve managed. What metrics did you track, and how did you identify and fix a bottleneck?",
    required: true,
    type: "textarea",
    selector: "",
    tag: "textarea"
  };
  const raw = {
    questionId: "q_narrative_keep",
    value:
      "At Automa, I owned the onboarding funnel for our TypeScript automation product. I tracked activation, completion, and week-1 retention, identified drop-off at setup, and shipped guided Playwright templates that improved completion by 24%.",
    source: "llm",
    reason: "llm_batch"
  };
  const out = (adapter as any).resolveEffectiveAnswerForField(
    field,
    raw,
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com" },
      experience: { summary: "Founder building automation systems", currentCompany: "Automa", currentTitle: "Founder" },
      skillsSummary: "TypeScript, Playwright, Node.js"
    },
    "Notable",
    "Program Manager",
    undefined,
    undefined,
    undefined,
    false
  );
  assert.equal(out?.source, "llm");
  assert.equal(String(out?.value ?? "").includes("Automa"), true);
});

test("ashby shouldAskLlmForField keeps required narrative prompts in Phase B", () => {
  const adapter = new AshbyAdapter() as any;
  const field = {
    id: "q_why_notion",
    label: "Why do you want to work at Notion?",
    type: "textarea",
    required: true
  };
  const shouldAsk = adapter.shouldAskLlmForField(field, {});
  assert.equal(shouldAsk, true);
});

test("ashby resolveProfileRuleSeededOnly does not emit fallback for unresolved required field", () => {
  const adapter = new AshbyAdapter() as any;
  const profile: CandidateProfile = {
    basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com" }
  };
  const field = {
    id: "q_required_unknown",
    label: "Custom required policy acknowledgment",
    required: true,
    type: "single_select",
    selector: "",
    tag: "input",
    options: ["Option A", "Option B"]
  };
  const resolved = adapter.resolveProfileRuleSeededOnly(field, profile, undefined, {});
  assert.equal(resolved, undefined);
});

test("ashby shouldAskLlmForField excludes blocked labels and file controls", () => {
  const adapter = new AshbyAdapter() as any;
  const blockedField = {
    id: "q_blocked",
    label: "Custom blocked field",
    type: "text",
    required: true
  };
  assert.equal(adapter.shouldAskLlmForField(blockedField, { blockedQuestionPatterns: ["custom blocked"] }), false);
  const fileField = {
    id: "q_resume_file",
    label: "Resume",
    type: "file",
    required: true
  };
  assert.equal(adapter.shouldAskLlmForField(fileField, {}), false);
});

test("ashby shouldAskLlmForField skips optional freeform narrative by default", () => {
  const adapter = new AshbyAdapter() as any;
  const field = {
    id: "q_optional_anything_else",
    label: "Anything else? (Optional)",
    type: "textarea",
    required: false
  };
  assert.equal(adapter.shouldAskLlmForField(field, {}), false);
});

test("ashby shouldAskLlmForField allows optional freeform narrative when explicitly enabled", () => {
  const adapter = new AshbyAdapter() as any;
  const field = {
    id: "q_optional_anything_else_enabled",
    label: "Anything else? (Optional)",
    type: "textarea",
    required: false
  };
  assert.equal(adapter.shouldAskLlmForField(field, { answerOptionalNarratives: true }), true);
});

test("ashby ensureRequiredNarrativeFallbackValue never leaves required narrative as N/A", () => {
  const adapter = new AshbyAdapter() as any;
  const profile: CandidateProfile = {
    basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com" },
    experience: { summary: "Founder building reliable automation systems in TypeScript." }
  };
  const field = {
    label: "Why do you want to work at Notion?",
    required: true,
    type: "textarea"
  };
  const value = adapter.ensureRequiredNarrativeFallbackValue(field, "N/A", profile, "Notion", "Software Engineer Intern");
  const normalized = String(value ?? "").trim().toLowerCase();
  assert.notEqual(normalized, "n/a");
  assert.equal(normalized.length > 20, true);
});

test("ashby office willingness fallback guard flips unsafe No to Yes when profile indicates relocation openness", () => {
  const adapter = new AshbyAdapter() as any;
  const profile: CandidateProfile = {
    basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com" },
    customAnswers: {
      "Open to relocation": "Yes"
    }
  };
  const result: any = { filledFields: [], notes: [] };
  const field = {
    id: "office_q",
    label: "Are you willing to work from our NYC, SF, or WA office 2-3 days a week?",
    required: true,
    type: "single_select",
    selector: "",
    tag: "input",
    options: ["Yes", "No"]
  };
  const guarded = adapter.guardUnsafeOfficeRelocationFallback(field, "No", profile, result, {}, "fill_pass");
  assert.equal(guarded, "Yes");
});

test("ashby office willingness fallback guard enforces semantic consistency with prior relocation Yes", () => {
  const adapter = new AshbyAdapter() as any;
  const profile: CandidateProfile = {
    basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com" }
  };
  const result: any = {
    filledFields: [
      {
        id: "relocate_q",
        label: "Are you willing to relocate if selected for this role and required to work from our New York City OR San Francisco 2-3 days a week?",
        value: "Yes",
        source: "rule",
        inputKind: "single_select"
      }
    ],
    notes: []
  };
  const field = {
    id: "office_q_2",
    label: "Are you willing to work from our NYC, SF, or WA office 2-3 days a week?",
    required: true,
    type: "single_select",
    selector: "",
    tag: "input",
    options: ["Yes", "No"]
  };
  const guarded = adapter.guardUnsafeOfficeRelocationFallback(field, "No", profile, result, {}, "recovery");
  assert.equal(guarded, "Yes");
});

test("ashby runFillPass logs phase-b llm request telemetry with labels and inclusion reasons", async () => {
  const adapter = new AshbyAdapter() as any;
  const logged: Array<{ event: string; data: any }> = [];
  const field = {
    id: "q_age",
    label: "What is your current age?",
    required: true,
    type: "single_select",
    selector: "",
    tag: "input",
    options: ["Under 30", "30-39"]
  };

  adapter.extractVisibleFieldsSafely = async () => [field];
  adapter.enrichUnknownFieldsWithLiveOptions = async () => undefined;
  adapter.resolvePreferredResumePath = () => undefined;
  adapter.isProfileUnknownField = () => true;
  adapter.pickOverride = () => undefined;
  adapter.resolveProfileRuleSeededOnly = () => undefined;
  adapter.fillFieldWithVerification = async () => true;
  adapter.verifyFieldAnswered = async () => true;
  adapter.resolveCanonicalFilledValue = async (_scope: unknown, _field: unknown, value: unknown) => value;
  adapter.humanPause = async () => undefined;
  adapter.withTimeout = async (promise: Promise<unknown>) => promise;
  adapter.applyBlockedQuestionPolicies = (answers: unknown) => answers;
  adapter.resolveEffectiveAnswerForField = (_field: unknown, answer: unknown) => answer;
  adapter.normalizeAnswerForField = (_field: unknown, value: unknown) => value;
  adapter.validateAndRepairFieldAnswer = (_field: unknown, value: unknown) => ({
    value,
    repaired: false,
    invalid: false,
    reason: null
  });
  adapter.sanitizeValueForField = (_field: unknown, value: unknown) => value;
  adapter.requiredFallbackValue = () => null;
  adapter.companyAwareFallbackValue = () => null;
  adapter.locationAwareFallbackValue = () => null;
  adapter.resolveAshbyTextFallback = () => ({ value: null, reason: "text_fallback_misc", intent: "misc", deterministicFinal: false });
  adapter.autofillFallbackValue = () => null;
  adapter.ensureRequiredNarrativeFallbackValue = (_field: unknown, value: unknown) => value;
  adapter.recordAccommodationPolicyMarker = () => undefined;
  adapter.recordDeterministicFinalTextFallbackMarker = () => undefined;
  adapter.markUnknownFieldSeen = () => undefined;
  adapter.markUnknownFieldResolved = () => undefined;
  adapter.markUnknownFieldUnresolved = () => undefined;
  adapter.detectMissingRequiredFields = async () => [];
  adapter.readValidationErrors = async () => [];
  adapter.recordLlmEvent = () => undefined;

  const context: any = {
    logger: {
      info: (event: string, data: any) => logged.push({ event, data }),
      warn: () => undefined
    },
    aiEngine: {
      resolve: async () => [{ questionId: "q_age", value: "Under 30", source: "llm", reason: "llm_batch" }]
    },
    profile: {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com" }
    },
    resumeText: "",
    config: {
      mode: "auto-submit",
      resumePath: ""
    }
  };
  const result: any = {
    url: "https://jobs.ashbyhq.com/imprint/test/application",
    notes: [],
    filledFields: [],
    answers: [],
    unknownFieldsSeen: [],
    unknownFieldsResolved: [],
    unknownFieldsUnresolved: [],
    llmEvents: []
  };

  await adapter.runFillPass(
    context,
    {},
    {},
    result,
    1,
    [],
    undefined,
    undefined,
    false
  );

  const pendingEvent = logged.find((entry) => entry.event === "ashby_pending_for_llm");
  const requestEvent = logged.find((entry) => entry.event === "ashby_phase_b_llm_request");
  const unknownRequestEvent = logged.find((entry) => entry.event === "unknown_llm_request");
  const terminalOutcomes = logged.filter((entry) => entry.event === "llm_answer_applied");
  assert.ok(pendingEvent);
  assert.ok(requestEvent);
  assert.ok(unknownRequestEvent);
  assert.deepEqual(requestEvent?.data?.fieldIds, ["q_age"]);
  assert.deepEqual(requestEvent?.data?.labels, ["What is your current age?"]);
  assert.deepEqual(requestEvent?.data?.controlTypes, ["single_select"]);
  assert.deepEqual(requestEvent?.data?.requiredFlags, [true]);
  assert.deepEqual(requestEvent?.data?.inclusionReasons, ["unresolved_eligible"]);
  assert.equal(typeof requestEvent?.data?.requestId, "string");
  assert.equal(requestEvent?.data?.requestId, unknownRequestEvent?.data?.requestId);
  assert.equal(terminalOutcomes.length, requestEvent?.data?.questionCount);
});

test("ashby targeted fallback uses safe values for project/password/replit and non-veteran option", () => {
  const adapter = new AshbyAdapter();
  const profile: CandidateProfile = {
    basics: {
      firstName: "Dariel",
      lastName: "Gutierrez",
      email: "dariel@example.com"
    },
    links: {
      github: "https://github.com/darielgu",
      portfolio: "https://aboutdariel.me"
    }
  };

  const projectUrl = (adapter as any).targetedFallbackValue(
    { id: "p1", label: "Project URL", required: true, type: "text", selector: "", tag: "input" },
    "Project URL",
    profile
  );
  assert.equal(projectUrl, "https://aboutdariel.me");

  const projectPassword = (adapter as any).targetedFallbackValue(
    { id: "p2", label: "Project Password", required: true, type: "text", selector: "", tag: "input" },
    "Project Password",
    profile
  );
  assert.equal(projectPassword, "N/A");

  const replitProfile = (adapter as any).targetedFallbackValue(
    { id: "p3", label: "Replit Profile URL", required: true, type: "text", selector: "", tag: "input" },
    "Replit Profile URL",
    profile
  );
  assert.equal(replitProfile, "https://aboutdariel.me");

  const veteran = (adapter as any).requiredFallbackValue({
    id: "p4",
    label: "Veteran Status",
    required: true,
    type: "single_select",
    selector: "",
    tag: "input",
    options: [
      "I identify as one or more of the classifications of protected veteran listed above",
      "I am not a protected veteran"
    ]
  });
  assert.equal(veteran, "I am not a protected veteran");
});

test("ashby sensitive policy blocks narrative fallback for credential-like prompts", () => {
  const adapter = new AshbyAdapter();
  const profile: CandidateProfile = {
    basics: {
      firstName: "Dariel",
      lastName: "Gutierrez",
      email: "dariel@example.com"
    },
    experience: {
      summary: "Founder building AI/browser-agent job automation systems."
    }
  };

  const token = (adapter as any).autofillFallbackValue(
    { id: "s1", label: "Access Token", required: true, type: "text", selector: "", tag: "input" },
    profile
  );
  assert.equal(token, "N/A");

  const legal = (adapter as any).requiredFallbackValue({
    id: "s2",
    label: "Will you now or in the future require sponsorship?",
    required: true,
    type: "boolean",
    selector: "",
    tag: "input"
  });
  assert.equal(legal, false);

  const background = (adapter as any).requiredFallbackValue({
    id: "s3",
    label: "Are you willing to undergo a background check as part of our recruitment process, if required?",
    required: true,
    type: "single_select",
    selector: "",
    tag: "input",
    options: ["Yes", "No"]
  });
  assert.equal(background, "Yes");
});

test("ashby normalizeAnswerForField maps boolean to single-select option", () => {
  const adapter = new AshbyAdapter() as any;
  const out = adapter.normalizeAnswerForField(
    {
      id: "q_bool_single",
      label: "Are you willing to undergo a background check?",
      required: true,
      type: "single_select",
      selector: "",
      tag: "input",
      options: ["Yes", "No"]
    },
    true
  );
  assert.equal(out, "Yes");
});

test("ashby detects location-only validation blocker sets", () => {
  const adapter = new AshbyAdapter() as any;
  assert.equal(
    adapter.areValidationBlockersLocationOnly(["Missing entry for required field: Location", "Missing entry for required field: Where are you currently based?"]),
    true
  );
  assert.equal(
    adapter.areValidationBlockersLocationOnly(["Missing entry for required field: Location", "Missing entry for required field: Email"]),
    false
  );
});

test("ashby location similarity matcher accepts close variants and rejects unrelated options", () => {
  const adapter = new AshbyAdapter() as any;
  assert.equal(adapter.looksLikeLocationMatch("San Diego, California, United States", "San Diego, CA"), true);
  assert.equal(adapter.looksLikeLocationMatch("Austin, Texas, United States", "San Diego, CA"), false);
});

test("ashby location candidates prefer qualified-first query for typeahead safety", () => {
  const adapter = new AshbyAdapter() as any;
  const values = adapter.buildLocationCandidateValues(
    "Current Location",
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com", location: "San Diego, CA" },
      state: "California",
      country: "United States"
    }
  );
  assert.equal(values[0], "San Diego, California, United States");
  assert.equal(values[1], "San Diego, California");
});

test("ashby location fallback triggers by location-like field id even with generic label", () => {
  const adapter = new AshbyAdapter() as any;
  const value = adapter.locationAwareFallbackValue(
    {
      id: "_systemfield_location",
      type: "single_select",
      label: "Start typing...",
      options: undefined
    },
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com", location: "San Diego, CA" },
      state: "California",
      country: "United States"
    }
  );
  assert.equal(value, "San Diego, California, United States");
});

test("ashby resolves structured location into ashby query and canonical target", () => {
  const adapter = new AshbyAdapter() as any;
  const spec = adapter.resolveAshbyLocationSpec({
    basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com", location: "San Diego, CA" },
    locationStructured: {
      city: "San Diego",
      region: "California",
      country: "United States",
      ashbyQuery: "San Diego",
      ashbyTarget: "San Diego, California, United States"
    }
  });
  assert.equal(spec?.query, "San Diego");
  assert.equal(spec?.target, "San Diego, California, United States");
});

test("ashby derives ashby location query/target from legacy flat profile location", () => {
  const adapter = new AshbyAdapter() as any;
  const spec = adapter.resolveAshbyLocationSpec({
    basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com", location: "San Diego, CA" },
    state: "California",
    country: "United States"
  });
  assert.equal(spec?.query, "San Diego, California, United States");
  assert.equal(spec?.target, "San Diego, California, United States");
});

test("ashby resolves city-state-country query from street-address profile location", () => {
  const adapter = new AshbyAdapter() as any;
  const spec = adapter.resolveAshbyLocationSpec({
    basics: {
      firstName: "Dariel",
      lastName: "Gutierrez",
      email: "dariel@example.com",
      location: "1497 Oakpoint Ave, San Diego, 91913, California"
    },
    state: "California",
    country: "United States"
  });
  assert.equal(spec?.city, "San Diego");
  assert.equal(spec?.query, "San Diego, California, United States");
  assert.equal(spec?.target, "San Diego, California, United States");
});

test("ashby location retry does not escalate when dropdown options are visible for current query", async () => {
  const adapter = new AshbyAdapter() as any;
  const attempted: string[] = [];
  adapter.resolveTextControlLocator = async () => ({}) as any;
  adapter.fieldCapability = () => "typeahead_text";
  adapter.commitStrictLocationTypeahead = async (_scope: unknown, _control: unknown, candidate: string) => {
    attempted.push(candidate);
    return { applied: false, optionsSeen: true };
  };
  adapter.verifyFieldAnswered = async () => false;

  const recovered = await adapter.retryLocationCommitSelection(
    { waitForTimeout: async () => undefined } as any,
    { id: "loc", label: "Current Location", required: true, type: "text", selector: "", tag: "input" },
    {
      basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com", location: "San Diego, CA" },
      state: "California",
      country: "United States"
    },
    "Current Location"
  );

  assert.equal(recovered, false);
  assert.deepEqual(
    attempted,
    [
      "San Diego, California, United States",
      "San Diego, California, United States",
      "San Diego, California, United States"
    ]
  );
});

test("ashby degree candidate canonicalization maps B.S profile text to Bachelor's Degree", () => {
  const adapter = new AshbyAdapter() as any;
  const canonical = adapter.canonicalizeDegreeSelectionCandidate(
    "Degree",
    "B.S Computer Science"
  );
  assert.equal(canonical, "Bachelor's Degree");
});

test("ashby degree candidate canonicalization skips pursuing-degree yes/no prompts", () => {
  const adapter = new AshbyAdapter() as any;
  const canonical = adapter.canonicalizeDegreeSelectionCandidate(
    "Are you currently pursuing a degree in computer science or a related field?",
    "B.S Computer Science"
  );
  assert.equal(canonical, "B.S Computer Science");
});

test("ashby canonical answers are derived from filled fields only", () => {
  const adapter = new AshbyAdapter();
  const result: any = {
    filledFields: [
      { id: "_systemfield_resume", label: "Resume", value: "/tmp/resume.pdf", source: "seeded", inputKind: "file" },
      { id: "q1", label: "Phone", value: "619-555-1234", source: "profile", inputKind: "text" },
      { id: "q2", label: "Sponsorship", value: "false", source: "rule", inputKind: "boolean" },
      { id: "q3", label: "Skills", value: "TypeScript, Playwright", source: "fallback", inputKind: "multi_select" }
    ],
    answers: []
  };
  (adapter as any).syncCanonicalAnswersFromFilledFields(result);
  assert.equal(result.answers.length, 4);
  assert.equal(result.answers[0].questionId, "_systemfield_resume");
  assert.equal(result.answers[0].source, "seeded");
  assert.equal(result.answers[1].questionId, "q1");
  assert.equal(result.answers[1].value, "619-555-1234");
  assert.equal(result.answers[2].value, false);
  assert.deepEqual(result.answers[3].value, ["TypeScript", "Playwright"]);
});

test("ashby diffSnapshots reports changed keys and no_change when stable", () => {
  const adapter = new AshbyAdapter() as any;
  const before = new Map<string, string>([
    ["location", "missing"],
    ["resume", "answered"]
  ]);
  const after = new Map<string, string>([
    ["location", "answered"],
    ["resume", "answered"]
  ]);
  assert.equal(adapter.diffSnapshots(before, after), "location=missing->answered");
  assert.equal(adapter.diffSnapshots(after, after), "no_change");
});

test("ashby missing field recovery returns recovered labels that are not still remaining", async () => {
  const adapter = new AshbyAdapter() as any;
  adapter.extractVisibleFieldsSafely = async () => [
    { id: "f1", label: "Favorite Github contribution", required: true, type: "text", selector: "", tag: "input", platformMeta: {} },
    { id: "f2", label: "Location", required: true, type: "text", selector: "", tag: "input", platformMeta: {} }
  ];
  adapter.detectMissingRequiredFieldDescriptors = async () => [];
  adapter.mapMissingLabelsToRecoveryTargets = (_fields: unknown, labels: string[]) =>
    labels.map((label) => ({ label, field: { id: label, label, required: true, type: "text", selector: "", tag: "input", platformMeta: {} }, identity: `fieldId:${label}` }));
  adapter.resolveAiTimeoutMs = () => 10;
  adapter.withTimeout = async (p: Promise<unknown>) => p;
  adapter.applyBlockedQuestionPolicies = (answers: unknown) => answers;
  adapter.resolveEffectiveAnswerForField = () => ({ value: "https://github.com/darielgu/2ndBrain", source: "profile" });
  adapter.normalizeAnswerForField = (_field: unknown, value: unknown) => value;
  adapter.validateAndRepairFieldAnswer = (field: any, value: unknown) => ({ value, repaired: false, invalid: false, reason: null });
  adapter.answerHasValue = () => true;
  adapter.sanitizeValueForField = (_field: unknown, value: unknown) => value;
  adapter.fillFieldWithVerification = async () => true;
  adapter.verifyFieldAnswered = async () => true;
  adapter.resolveCanonicalFilledValue = async (_scope: unknown, field: any) => field.label;
  adapter.recordAccommodationPolicyMarker = () => undefined;
  adapter.recordDeterministicFinalTextFallbackMarker = () => undefined;
  adapter.recordFilledField = () => undefined;
  adapter.findRemainingMissingTargets = async () => ({ remainingLabels: ["Location"], remainingTargetIds: ["fieldId:Location"] });
  const context: any = {
    logger: { info: () => undefined, warn: () => undefined },
    aiEngine: { resolve: async () => [] },
    profile: { basics: { firstName: "Dariel", lastName: "Gutierrez", email: "dariel@example.com" } },
    resumeText: "",
    config: { resumePath: "" }
  };
  const out = await adapter.fillMissingFieldsByLabel(
    context,
    {} as any,
    { requiredFieldSelectors: [], blockedQuestionPatterns: [] },
    ["Favorite Github contribution", "Location"],
    { url: "https://example.com", notes: [], filledFields: [] } as any,
    1
  );
  assert.deepEqual(out.recoveredLabels, ["Favorite Github contribution"]);
});

test("ashbyClassifySubmissionOutcome confirms on strict URL marker", () => {
  const classified = ashbyClassifySubmissionOutcome({
    strictUrlMatch: true,
    strictTextMatch: false,
    blockedByBot: false,
    activeValidationErrors: [],
    submitVisible: true,
    visibleFormControls: true,
    softCompletionTextMatch: null,
    noValidationStreak: 0,
    secondsSinceSubmit: 0,
    strictUrlEvidence: "https://jobs.ashbyhq.com/acme/application-submitted"
  });

  assert.equal(classified.outcome, "confirmed");
  assert.match(classified.confirmationEvidence ?? "", /^strict:success_url:/);
});

test("ashbyClassifySubmissionOutcome confirms on strict text marker", () => {
  const classified = ashbyClassifySubmissionOutcome({
    strictUrlMatch: false,
    strictTextMatch: true,
    blockedByBot: false,
    activeValidationErrors: [],
    submitVisible: true,
    visibleFormControls: true,
    softCompletionTextMatch: null,
    noValidationStreak: 1,
    secondsSinceSubmit: 1
  });

  assert.equal(classified.outcome, "confirmed");
  assert.equal(classified.confirmationEvidence, "strict:confirmation_text_detected");
});

test("ashbyClassifySubmissionOutcome confirms on soft completion when form exits and no blockers", () => {
  const classified = ashbyClassifySubmissionOutcome({
    strictUrlMatch: false,
    strictTextMatch: false,
    blockedByBot: false,
    activeValidationErrors: [],
    submitVisible: false,
    visibleFormControls: false,
    softCompletionTextMatch: null,
    noValidationStreak: 3,
    secondsSinceSubmit: 3
  });

  assert.equal(classified.outcome, "confirmed");
  assert.match(classified.confirmationEvidence ?? "", /^soft:/);
});

test("ashbyClassifySubmissionOutcome keeps validation error precedence", () => {
  const classified = ashbyClassifySubmissionOutcome({
    strictUrlMatch: false,
    strictTextMatch: false,
    blockedByBot: false,
    activeValidationErrors: ["Missing entry for required field: Email"],
    submitVisible: false,
    visibleFormControls: false,
    softCompletionTextMatch: "application received",
    noValidationStreak: 3,
    secondsSinceSubmit: 3
  });

  assert.equal(classified.outcome, "validation_error");
});

test("ashbyClassifySubmissionOutcome keeps bot challenge precedence over soft confirmation", () => {
  const classified = ashbyClassifySubmissionOutcome({
    strictUrlMatch: false,
    strictTextMatch: false,
    blockedByBot: true,
    activeValidationErrors: [],
    submitVisible: false,
    visibleFormControls: false,
    softCompletionTextMatch: "application received",
    noValidationStreak: 3,
    secondsSinceSubmit: 3
  });

  assert.equal(classified.outcome, "blocked_bot_challenge");
});

test("ashbyClassifySubmissionOutcome returns pending when no strict or soft evidence", () => {
  const classified = ashbyClassifySubmissionOutcome({
    strictUrlMatch: false,
    strictTextMatch: false,
    blockedByBot: false,
    activeValidationErrors: [],
    submitVisible: true,
    visibleFormControls: true,
    softCompletionTextMatch: null,
    noValidationStreak: 1,
    secondsSinceSubmit: 3
  });

  assert.equal(classified.outcome, "pending_confirmation");
});
