import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectTextFieldSemantic,
  GreenhouseAdapter,
  buildGreenhouseQuestionCacheKey,
  evaluateSubmitStopReason,
  isPlaceholderOption,
  isSessionLostError,
  pickBestOption
} from "./greenhouse.js";
import type { AdapterRunContext } from "../core/types.js";

test("pickBestOption returns input when no matching option exists", () => {
  const options = ["Select...", "Please select one", "LinkedIn", "Referral"];
  const picked = pickBestOption("Yes", options);
  assert.equal(picked, "Yes");
});

test("pickBestOption chooses numeric range match", () => {
  const options = ["0-1 years", "2-4 years", "5+ years"];
  const picked = pickBestOption("3 years", options);
  assert.equal(picked, "2-4 years");
});

test("buildGreenhouseQuestionCacheKey is stable across option order and case", () => {
  const keyA = buildGreenhouseQuestionCacheKey(
    {
      id: "q1",
      label: "Are you authorized to work?",
      type: "single_select",
      required: true,
      options: ["Yes", "No"],
      platformMeta: { inputKind: "combobox" }
    },
    "Staff Engineer",
    "Acme"
  );
  const keyB = buildGreenhouseQuestionCacheKey(
    {
      id: "q2",
      label: "  ARE YOU AUTHORIZED TO WORK? ",
      type: "single_select",
      required: true,
      options: ["no", "yes"],
      platformMeta: { inputKind: "combobox" }
    },
    "staff engineer",
    "acme"
  );
  assert.equal(keyA, keyB);
});

test("isSessionLostError detects closed-page failures", () => {
  assert.equal(isSessionLostError(new Error("Target page, context or browser has been closed")), true);
  assert.equal(isSessionLostError(new Error("validation_errors_after_submit")), false);
});

test("isPlaceholderOption recognizes placeholder labels", () => {
  assert.equal(isPlaceholderOption("Select..."), true);
  assert.equal(isPlaceholderOption("Please select"), true);
  assert.equal(isPlaceholderOption("Remote"), false);
});

test("detectTextFieldSemantic classifies compensation and motivation prompts", () => {
  assert.equal(detectTextFieldSemantic("What is your desired annual compensation?", "", ""), "compensation");
  assert.equal(detectTextFieldSemantic("Why are you interested in this role?", "", ""), "motivation");
  assert.equal(detectTextFieldSemantic("Please provide additional details", "", ""), "generic_text");
});

test("evaluateSubmitStopReason handles stable validation, challenge, and max-attempt fallback", () => {
  assert.equal(
    evaluateSubmitStopReason({
      attempt: 2,
      maxAttempts: 3,
      validationSignature: "Email required|Phone required",
      previousValidationSignature: "Email required|Phone required",
      challengeDetected: false
    }),
    "validation_stable_errors"
  );

  assert.equal(
    evaluateSubmitStopReason({
      attempt: 2,
      maxAttempts: 3,
      challengeDetected: true
    }),
    "challenge_blocked"
  );

  assert.equal(
    evaluateSubmitStopReason({
      attempt: 3,
      maxAttempts: 3,
      challengeDetected: false
    }),
    "confirmation_not_detected"
  );
});

test("evaluateSubmitStopReason stops on repeated missing-signature no-progress cycle", () => {
  assert.equal(
    evaluateSubmitStopReason({
      attempt: 2,
      maxAttempts: 3,
      missingSignature: "4002004009|4002005009|4002006009",
      previousMissingSignature: "4002004009|4002005009|4002006009",
      challengeDetected: false
    }),
    "validation_missing_fields"
  );
});

function makeGreenhouseContext(): AdapterRunContext {
  const page = {} as AdapterRunContext["page"];
  return {
    page,
    target: { url: "https://job-boards.greenhouse.io/example/jobs/123" },
    profile: {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "555-555-5555"
      }
    },
    resumeText: "resume",
    config: {
      mode: "auto-submit",
      headless: true,
      timeoutMs: 60_000,
      outputDir: "./output",
      screenshotsDir: "./output/screenshots",
      resumePath: "/tmp/resume.pdf",
      ai: {
        provider: "none",
        model: "none"
      }
    },
    aiEngine: {
      resolve: async () => []
    } as unknown as AdapterRunContext["aiEngine"],
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    } as unknown as AdapterRunContext["logger"]
  };
}

test("core-field resume verification is verification-only when strict check fails", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const context = makeGreenhouseContext();
  const filledFields: Array<{ id: string; value: string; source: string; inputKind: string; label: string }> = [];

  let uploadCalls = 0;
  adapter.readInputValue = async () => "already-filled";
  adapter.verifyStrictResumeUploadDetailed = async () => {
    return {
      ok: false,
      inputFileOk: true,
      visibleCueOk: false,
      missingScanOk: false,
      resumeMissingDetail: "resume:Resume:file"
    };
  };
  adapter.uploadResumeWithRecoveryFlow = async () => {
    uploadCalls += 1;
    return {
      ok: true,
      inputFileOk: true,
      visibleCueOk: true,
      missingScanOk: true
    };
  };
  adapter.collectMissingRequiredDetails = async () => [];
  adapter.collectMissingRequiredFields = async () => [];

  const result = (await adapter.verifyAndReapplyCoreIdentityFields(
    context,
    filledFields
  )) as { reapplied: boolean; resumeVerified: boolean; missingDetails: string[] };

  assert.equal(uploadCalls, 0);
  assert.equal(result.resumeVerified, false);
  assert.equal(result.missingDetails.includes("resume:Resume:file"), true);
});

test("verifyStrictResumeUploadDetailed reports subcheck status for cue and missing scan failures", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const page = {} as AdapterRunContext["page"];

  adapter.findResumeInputWithSelectedFile = async () => ({ ok: true, selector: "#resume" });
  adapter.findVisibleResumeCue = async () => ({ ok: false });
  adapter.collectMissingRequiredDetails = async () => [
    { id: "resume", label: "Resume", role: "file", tag: "input" }
  ];

  const result = await adapter.verifyStrictResumeUploadDetailed(page, "/tmp/resume.pdf");
  assert.equal(result.ok, true);
  assert.equal(result.confidence, "confirmed");
  assert.equal(result.verificationMode, "signal");
  assert.equal(result.inputFileOk, true);
  assert.equal(result.visibleCueOk, false);
  assert.equal(result.missingScanOk, false);
  assert.equal(result.matchedInputSelector, "#resume");
  assert.match(result.resumeMissingDetail ?? "", /^resume:Resume:/);
});

test("verifyStrictResumeUploadDetailed passes when all subchecks pass", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const page = {} as AdapterRunContext["page"];

  adapter.findResumeInputWithSelectedFile = async () => ({ ok: true, selector: "#resume" });
  adapter.findVisibleResumeCue = async () => ({ ok: true, cueText: "resume.pdf uploaded" });
  adapter.collectMissingRequiredDetails = async () => [];

  const result = await adapter.verifyStrictResumeUploadDetailed(page, "/tmp/resume.pdf");
  assert.equal(result.ok, true);
  assert.equal(result.confidence, "confirmed");
  assert.equal(result.verificationMode, "signal");
  assert.equal(result.inputFileOk, true);
  assert.equal(result.visibleCueOk, true);
  assert.equal(result.missingScanOk, true);
  assert.equal(result.matchedCueText, "resume.pdf uploaded");
});

test("verifyStrictResumeUploadDetailed returns provisional pass when only input is set without upload-confirmation signal", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const page = {} as AdapterRunContext["page"];

  adapter.findResumeInputWithSelectedFile = async () => ({ ok: true, selector: "#resume" });
  adapter.findVisibleResumeCue = async () => ({ ok: false });
  adapter.collectMissingRequiredDetails = async () => [];

  const result = await adapter.verifyStrictResumeUploadDetailed(page, "/tmp/resume.pdf");
  assert.equal(result.ok, true);
  assert.equal(result.confidence, "confirmed");
  assert.equal(result.verificationMode, "signal");
  assert.equal(result.inputFileOk, true);
  assert.equal(result.visibleCueOk, false);
  assert.equal(result.missingScanOk, true);
  assert.equal(result.uploadSignalOk, true);
  assert.equal(result.failureTag, undefined);
});

test("verifyStrictResumeUploadDetailed passes when input is replaced but filename cue is present", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const page = {} as AdapterRunContext["page"];

  adapter.findResumeInputWithSelectedFile = async () => ({ ok: false });
  adapter.findVisibleResumeCue = async () => ({ ok: true, cueText: "resume.pdf" });
  adapter.collectMissingRequiredDetails = async () => [];

  const result = await adapter.verifyStrictResumeUploadDetailed(page, "/tmp/resume.pdf");
  assert.equal(result.ok, true);
  assert.equal(result.confidence, "confirmed");
  assert.equal(result.verificationMode, "signal");
  assert.equal(result.inputFileOk, false);
  assert.equal(result.visibleCueOk, true);
  assert.equal(result.missingScanOk, true);
});

test("verifyStrictResumeUploadDetailed accepts successful binary upload attempt signal", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const page = {} as AdapterRunContext["page"];

  adapter.findResumeInputWithSelectedFile = async () => ({ ok: false });
  adapter.findVisibleResumeCue = async () => ({ ok: false });
  adapter.findResumeAttachmentToken = async () => ({ ok: false });
  adapter.collectMissingRequiredDetails = async () => [];

  const result = await adapter.verifyStrictResumeUploadDetailed(page, "/tmp/resume.pdf", [
    {
      phase: "direct",
      applied: true,
      sawPresign: true,
      sawBinaryUpload: true,
      sawNetworkFailure: false,
      jsErrors: []
    }
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.confidence, "confirmed");
  assert.equal(result.verificationMode, "signal");
  assert.equal(result.uploadSignalOk, true);
  assert.equal(result.uploadState, "upload_confirmed");
});

test("submit sequence fails fast with validation_missing_fields when resume remains unresolved", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const context = makeGreenhouseContext();
  const answers: [] = [];
  const filledFields: [] = [];

  adapter.reconcileRequiredFieldsBeforeSubmit = async () => undefined;
  adapter.verifyAndReapplyCoreIdentityFields = async () => ({
    reapplied: true,
    missing: [],
    missingDetails: ["resume:Resume:file"],
    resumeVerified: false
  });

  const result = (await adapter.submitWithDeterministicAttempts(
    context,
    answers,
    filledFields
  )) as {
    submitted: boolean;
    reasonTag?: string;
    missingRequiredDetails: string[];
    attempts: Array<{ reasonTag?: string }>;
  };

  assert.equal(result.submitted, false);
  assert.equal(result.reasonTag, "validation_missing_fields");
  assert.equal(result.missingRequiredDetails.includes("resume:Resume:file"), true);
  assert.equal(result.attempts[0]?.reasonTag, "validation_missing_fields");
});

test("core-field check accepts provisional resume confidence for pre-submit gating", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const context = makeGreenhouseContext();
  const filledFields: Array<{ id: string; value: string; source: string; inputKind: string; label: string }> = [];

  adapter.readInputValue = async () => "already-filled";
  adapter.verifyStrictResumeUploadDetailed = async () => ({
    ok: true,
    confidence: "provisional",
    verificationMode: "input_only",
    inputFileOk: true,
    visibleCueOk: false,
    uploadSignalOk: false,
    missingScanOk: true
  });
  adapter.collectMissingRequiredDetails = async () => [];
  adapter.collectMissingRequiredFields = async () => [];

  const result = (await adapter.verifyAndReapplyCoreIdentityFields(
    context,
    filledFields
  )) as { resumeVerified: boolean; missingDetails: string[] };

  assert.equal(result.resumeVerified, true);
  assert.equal(result.missingDetails.includes("resume:Resume:file"), false);
});

test("submit sequence does not run post-submit resume recovery upload path", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const context = makeGreenhouseContext();
  const answers: [] = [];
  const filledFields: [] = [];
  let uploadCalls = 0;

  adapter.reconcileRequiredFieldsBeforeSubmit = async () => undefined;
  adapter.verifyAndReapplyCoreIdentityFields = async () => ({
    reapplied: false,
    missing: [],
    missingDetails: [],
    resumeVerified: true,
    resumeVerification: {
      ok: true,
      confidence: "provisional",
      verificationMode: "input_only",
      inputFileOk: true,
      visibleCueOk: false,
      uploadSignalOk: false,
      missingScanOk: true
    },
    identityAudit: [],
    identityCandidateAudit: []
  });
  adapter.primeRecaptchaToken = async () => undefined;
  adapter.syncAllRequiredSelectSentinels = async () => undefined;
  adapter.shortPostSubmitSweep = async () => ({
    confirmed: false,
    validationErrors: ["Resume is required"],
    challengeDetected: false
  });
  adapter.collectIdentityAuditNotes = async () => [];
  adapter.collectIdentityCandidateAuditNotes = async () => [];
  adapter.uploadResumeWithRecoveryFlow = async () => {
    uploadCalls += 1;
    return {
      ok: true,
      inputFileOk: true,
      visibleCueOk: true,
      missingScanOk: true
    };
  };

  const page = {
    keyboard: {
      press: async () => undefined
    },
    locator: () => ({
      first: () => ({
        count: async () => 1,
        click: async () => undefined
      })
    })
  } as unknown as AdapterRunContext["page"];
  context.page = page;

  const result = (await adapter.submitWithDeterministicAttempts(
    context,
    answers,
    filledFields
  )) as { submitted: boolean; reasonTag?: string; resumeVerification?: { failureTag?: string; confidence?: string } };

  assert.equal(result.submitted, false);
  assert.equal(result.reasonTag, "validation_stable_errors");
  assert.equal(result.resumeVerification?.failureTag, "resume_rejected_post_submit");
  assert.equal(result.resumeVerification?.confidence, "failed");
  assert.equal(uploadCalls, 0);
});

test("resolveResumeUploadPath prefers sibling PDF when accept only allows document formats", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-resume-test-"));
  try {
    const txtPath = path.join(tmpDir, "resume.txt");
    const pdfPath = path.join(tmpDir, "resume.pdf");
    fs.writeFileSync(txtPath, "plain text resume");
    fs.writeFileSync(pdfPath, "fake pdf bytes");

    const page = {
      evaluate: async () => [".pdf,.doc,.docx"]
    } as unknown as AdapterRunContext["page"];

    const resolved = await adapter.resolveResumeUploadPath(page, txtPath);
    assert.equal(resolved, pdfPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("degree heuristic maps B.S. degree text to Bachelor's option", () => {
  const adapter = new GreenhouseAdapter() as any;
  const mapped = adapter.applyGreenhouseRequiredHeuristics(
    {
      id: "degree--0",
      label: "Degree",
      type: "select",
      required: true,
      options: ["Associate's Degree", "Bachelor's Degree", "Master's Degree"]
    },
    "B.S. Computer Science",
    {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "555-555-5555"
      }
    }
  );
  assert.equal(mapped, "Bachelor's Degree");
});

test("legally eligible heuristic maps authorized profile to yes/no option", () => {
  const adapter = new GreenhouseAdapter() as any;
  const mapped = adapter.applyGreenhouseRequiredHeuristics(
    {
      id: "eligible_to_work",
      label: "Are you legally eligible/right to work in the United States?",
      type: "single_select",
      required: true,
      options: ["Yes", "No"]
    },
    "",
    {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "555-555-5555"
      },
      workAuthorization: {
        authorizedToWork: true,
        requiresSponsorship: false
      }
    }
  );
  assert.equal(mapped, "Yes");
});

test("status allows work/live heuristic picks authorized no-sponsorship option", () => {
  const adapter = new GreenhouseAdapter() as any;
  const mapped = adapter.applyGreenhouseRequiredHeuristics(
    {
      id: "work_status",
      label: "Select the status that allows you to work and live in the country",
      type: "single_select",
      required: true,
      options: [
        "Work visa requiring sponsorship",
        "Authorized to work without sponsorship",
        "Prefer not to say"
      ]
    },
    "",
    {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "555-555-5555"
      },
      workAuthorization: {
        authorizedToWork: true,
        requiresSponsorship: false
      }
    }
  );
  assert.equal(mapped, "Authorized to work without sponsorship");
});

test("veteran heuristic maps not-a-veteran answer to available greenhouse option", () => {
  const adapter = new GreenhouseAdapter() as any;
  const mapped = adapter.applyGreenhouseRequiredHeuristics(
    {
      id: "veteran_status",
      label: "Veteran Status",
      type: "select",
      required: true,
      options: ["I am a protected veteran", "No, I am not a protected veteran", "I don't wish to answer"]
    },
    "I am not a protected veteran",
    {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "555-555-5555"
      }
    }
  );
  assert.equal(mapped, "No, I am not a protected veteran");
});

test("disability heuristic maps no-disability answer to available greenhouse option", () => {
  const adapter = new GreenhouseAdapter() as any;
  const mapped = adapter.applyGreenhouseRequiredHeuristics(
    {
      id: "disability_status",
      label: "Disability Status",
      type: "select",
      required: true,
      options: [
        "Yes, I have a disability (or previously had a disability)",
        "No, I do not have a disability and have not had one in the past",
        "I don't wish to answer"
      ]
    },
    "No",
    {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "555-555-5555"
      }
    }
  );
  assert.equal(mapped, "No, I do not have a disability and have not had one in the past");
});

test("based-location heuristic maps country dropdown to United States", () => {
  const adapter = new GreenhouseAdapter() as any;
  const mapped = adapter.applyGreenhouseRequiredHeuristics(
    {
      id: "location_country",
      label: "Where are you currently based?",
      type: "single_select",
      required: true,
      options: ["Select...", "Afghanistan", "United States", "Zimbabwe"]
    },
    "",
    {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "555-555-5555",
        location: "San Diego, CA"
      },
      country: "United States",
      state: "California"
    }
  );
  assert.equal(mapped, "United States");
});

test("based-location heuristic maps state dropdown using state normalization", () => {
  const adapter = new GreenhouseAdapter() as any;
  const mapped = adapter.applyGreenhouseRequiredHeuristics(
    {
      id: "location_state",
      label: "Where are you currently based?",
      type: "single_select",
      required: true,
      options: ["Select...", "CA", "NY", "TX"]
    },
    "",
    {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "555-555-5555",
        location: "San Diego, CA"
      },
      country: "United States",
      state: "California"
    }
  );
  assert.equal(mapped, "CA");
});

test("based-location heuristic returns city, full state, and country for text fields", () => {
  const adapter = new GreenhouseAdapter() as any;
  const mapped = adapter.applyGreenhouseRequiredHeuristics(
    {
      id: "location_text",
      label: "Where are you currently based?",
      type: "text",
      required: true
    },
    "",
    {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "555-555-5555",
        location: "San Diego, CA"
      },
      country: "United States",
      state: "California"
    }
  );
  assert.equal(mapped, "San Diego, California, United States");
});

test("based-location heuristic defaults ambiguous single-select with no options to country", () => {
  const adapter = new GreenhouseAdapter() as any;
  const mapped = adapter.applyGreenhouseRequiredHeuristics(
    {
      id: "location_unknown_select",
      label: "Where are you currently based?",
      type: "single_select",
      required: true,
      platformMeta: { inputKind: "combobox" }
    },
    "",
    {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "555-555-5555",
        location: "San Diego, CA"
      },
      country: "United States",
      state: "California"
    }
  );
  assert.equal(mapped, "United States");
});

test("location city heuristic returns city, state, country and avoids street address fallback", () => {
  const adapter = new GreenhouseAdapter() as any;
  const profile = {
    basics: {
      firstName: "Test",
      lastName: "User",
      email: "test@example.com",
      phone: "555-555-5555",
      location: "1497 Oakpoint Ave, San Diego, 91913, California"
    },
    country: "United States",
    state: "California"
  };
  const mapped = adapter.applyGreenhouseRequiredHeuristics(
    {
      id: "candidate-location",
      label: "Location (City)",
      type: "single_select",
      required: true,
      platformMeta: { inputKind: "combobox" }
    },
    "1497 Oakpoint Ave, California",
    profile
  );
  assert.equal(mapped, "San Diego, California, United States");

  const candidates = adapter.defaultComboboxFallbackCandidates("Location (City)", profile, "1497 Oakpoint Ave, California");
  assert.equal(candidates[0], "San Diego, California, United States");
});

test("motivation prompt is not coerced into application source answer", () => {
  const adapter = new GreenhouseAdapter() as any;
  const mapped = adapter.applyGreenhouseRequiredHeuristics(
    {
      id: "question_interest",
      label: "Why are you interested in applying to this company?",
      type: "textarea",
      required: true
    },
    "I admire the mission and product impact.",
    {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com"
      },
      links: {
        linkedin: "https://linkedin.com/in/test-user"
      }
    }
  );
  assert.equal(mapped, "I admire the mission and product impact.");
});

test("verifyFieldSatisfied fails fast when field is still in missing-required details", async () => {
  const adapter = new GreenhouseAdapter() as any;
  adapter.collectMissingRequiredDetails = async () => [
    { id: "question_1", label: "Question", role: "combobox", tag: "input" }
  ];

  const page = {} as AdapterRunContext["page"];
  const satisfied = await adapter.verifyFieldSatisfied(page, "question_1", "select", "Yes");
  assert.equal(satisfied, false);
});

test("constrained answer normalization always returns available option for unmatched answers", () => {
  const adapter = new GreenhouseAdapter() as any;
  const normalized = adapter.normalizeAnswerForFieldType("select", "Unmatched answer", [
    "Select...",
    "LinkedIn",
    "Referral"
  ]);
  assert.equal(normalized, "LinkedIn");
});

test("non-demographic combobox fallback does not force prefer-not-to-say", () => {
  const adapter = new GreenhouseAdapter() as any;
  const options = adapter.defaultComboboxFallbackCandidates("Country", {
    basics: {
      firstName: "Test",
      lastName: "User",
      email: "test@example.com",
      phone: "555-555-5555"
    },
    country: "United States"
  });
  assert.equal(options.some((item: string) => /prefer not|decline/i.test(item)), false);
});

test("demographic combobox fallback prioritizes don't wish then decline", () => {
  const adapter = new GreenhouseAdapter() as any;
  const options = adapter.defaultComboboxFallbackCandidates("Gender Identity", {
    basics: {
      firstName: "Test",
      lastName: "User",
      email: "test@example.com",
      phone: "555-555-5555"
    }
  });
  assert.equal(options[0], "I don't wish to answer");
  assert.equal(options[1], "Decline To Self Identify");
});

test("demographic first-pass candidates prioritize don't wish even when answer says prefer-not", () => {
  const adapter = new GreenhouseAdapter() as any;
  const candidates = adapter.firstPassComboboxCandidates("pronoun", "Prefer not to say");
  assert.equal(candidates[0], "I don't wish to answer");
  assert.equal(candidates[1], "Decline To Self Identify");
});

test("verifyFieldSatisfied enforces expected combobox value when required", async () => {
  const adapter = new GreenhouseAdapter() as any;
  adapter.collectMissingRequiredDetails = async () => [];
  adapter.verifyRequiredComboboxSatisfied = async () => true;

  const page = {
    evaluate: async () => "No"
  } as unknown as AdapterRunContext["page"];

  const mismatch = await adapter.verifyFieldSatisfied(page, "question_2", "select", "Yes");
  const exact = await adapter.verifyFieldSatisfied(page, "question_2", "select", "No");
  assert.equal(mismatch, false);
  assert.equal(exact, true);
});

test("verifyFieldSatisfied rejects required text when native validity fails", async () => {
  const adapter = new GreenhouseAdapter() as any;
  adapter.collectMissingRequiredDetails = async () => [];
  adapter.inspectRequiredValidationState = async () => ({
    currentValue: "$10,000+",
    errorText: "This field is required.",
    ariaInvalid: true,
    hiddenValues: []
  });
  adapter.inspectTextInputConstraints = async () => ({
    inputType: "text",
    pattern: "",
    inputmode: "",
    placeholder: "",
    min: "",
    max: "",
    step: "",
    maxlength: undefined,
    currentValue: "$10,000+",
    validityValid: false,
    validationMessage: "Please match the requested format.",
    numericOnly: true
  });

  const page = {} as AdapterRunContext["page"];
  const verified = await adapter.verifyFieldSatisfied(page, "question_comp", "text", "$10,000+", {
    id: "question_comp",
    selector: "#question_comp"
  });
  assert.equal(verified, false);
});

test("normalizeCompensationAnswerForConstraints strips non-numeric characters for numeric-only fields", () => {
  const adapter = new GreenhouseAdapter() as any;
  const normalized = adapter.normalizeCompensationAnswerForConstraints("$100,000+", {
    numericOnly: true
  });
  assert.equal(normalized, "100000");
});

test("required text placeholder guard blocks denylisted values by default", () => {
  const adapter = new GreenhouseAdapter() as any;
  const blocked = adapter.isDisallowedRequiredTextAnswer("N/A", { greenhouse: {} });
  const allowed = adapter.isDisallowedRequiredTextAnswer("N/A", { greenhouse: { allowPlaceholderRequiredText: true } });
  assert.equal(blocked, true);
  assert.equal(allowed, false);
});

test("core-field resume verification uses resolved effective resume path", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const context = makeGreenhouseContext();
  const filledFields: Array<{ id: string; value: string; source: string; inputKind: string; label: string }> = [];
  let verifiedPath = "";

  adapter.readInputValue = async () => "already-filled";
  adapter.resolveResumeUploadPath = async () => "/tmp/resume.pdf";
  adapter.verifyStrictResumeUploadDetailed = async (_page: unknown, resumePath: string) => {
    verifiedPath = resumePath;
    return {
      ok: true,
      inputFileOk: true,
      visibleCueOk: true,
      missingScanOk: true
    };
  };
  adapter.collectMissingRequiredDetails = async () => [];
  adapter.collectMissingRequiredFields = async () => [];

  const result = (await adapter.verifyAndReapplyCoreIdentityFields(
    context,
    filledFields
  )) as { resumeVerified: boolean };
  assert.equal(result.resumeVerified, true);
  assert.equal(verifiedPath, "/tmp/resume.pdf");
});

test("deterministic profile answers lock identity and auth fields before llm", () => {
  const adapter = new GreenhouseAdapter() as any;
  const answers = adapter.buildDeterministicProfileAnswers(
    [
      { id: "first_name", label: "First Name", type: "text", required: true },
      { id: "email", label: "Email", type: "text", required: true },
      { id: "work_auth", label: "Are you legally eligible to work in the US?", type: "single_select", required: true, options: ["Yes", "No"] }
    ],
    {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "555-555-5555"
      },
      workAuthorization: {
        authorizedToWork: true
      }
    },
    "/tmp/resume.pdf"
  ) as Map<string, { value: string; source: string; reason: string }>;
  assert.equal(answers.get("first_name")?.value, "Test");
  assert.equal(answers.get("email")?.value, "test@example.com");
  assert.equal(answers.get("work_auth")?.value, "Yes");
  assert.equal(answers.get("first_name")?.reason, "deterministic_profile");
});

test("deterministic education month mapping uses month values, not year fallback", () => {
  const adapter = new GreenhouseAdapter() as any;
  const answers = adapter.buildDeterministicProfileAnswers(
    [
      { id: "edu_end_month", label: "End date month", type: "single_select", required: true, options: ["January", "May"] },
      { id: "edu_end_year", label: "End date year", type: "single_select", required: true, options: ["2026", "2027"] }
    ],
    {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "555-555-5555"
      },
      education: {
        endMonth: "May",
        endYear: "2027"
      }
    }
  ) as Map<string, { value: string }>;

  assert.equal(answers.get("edu_end_month")?.value, "May");
  assert.equal(answers.get("edu_end_year")?.value, "2027");
});

test("deterministic export-control mapping chooses affirmative option for U.S. person", () => {
  const adapter = new GreenhouseAdapter() as any;
  const answers = adapter.buildDeterministicProfileAnswers(
    [
      {
        id: "export_q",
        label: "Astranis complies with U.S. Government space technology export regulations. Which applies to you?",
        type: "single_select",
        required: true,
        options: ["I am a U.S. person", "I am not a U.S. person"]
      }
    ],
    {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "555-555-5555"
      },
      workAuthorization: {
        usCitizen: true
      }
    }
  ) as Map<string, { value: string }>;
  assert.equal(answers.get("export_q")?.value, "I am a U.S. person");
});

test("school deterministic mapping does not overmatch long project prompts", () => {
  const adapter = new GreenhouseAdapter() as any;
  const answers = adapter.buildDeterministicProfileAnswers(
    [
      {
        id: "project_prompt",
        label: "Please describe the most impressive and complex project you have worked on.",
        type: "textarea",
        required: true
      }
    ],
    {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "555-555-5555"
      },
      education: {
        school: "San Diego State University"
      }
    }
  ) as Map<string, { value: string }>;
  assert.equal(answers.has("project_prompt"), false);
});

test("resume verification accepts replace/remove UI action as success signal", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const page = {} as AdapterRunContext["page"];

  adapter.findResumeInputWithSelectedFile = async () => ({ ok: false });
  adapter.findVisibleResumeCue = async () => ({ ok: false });
  adapter.findResumeAttachmentToken = async () => ({ ok: false });
  adapter.inspectResumeFieldState = async () => ({
    allowS3False: false,
    requiredSentinelUnsatisfied: false,
    explicitInvalid: false,
    hasReplaceOrRemoveAction: true
  });
  adapter.collectMissingRequiredDetails = async () => [];
  adapter.collectSubmitValidationErrors = async () => [];

  const result = await adapter.verifyStrictResumeUploadDetailed(page, "/tmp/resume.pdf", [
    { phase: "direct", applied: true, sawPresign: false, sawBinaryUpload: false, sawNetworkFailure: false, jsErrors: [] }
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.confidence, "confirmed");
});

test("live react-select probe reads options from global menu/listbox", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const page = {
    keyboard: {
      press: async () => undefined
    },
    locator: () => ({
      first: () => ({
        count: async () => 1,
        click: async () => undefined,
        press: async () => undefined
      })
    }),
    waitForTimeout: async () => undefined,
    evaluate: async () => ({
      fieldId: "question_30650574003",
      label: "Are you an EU citizen?",
      controlType: "combobox",
      required: true,
      options: [
        { text: "Yes", id: "opt-yes", disabled: false, selector: "#opt-yes" },
        { text: "No", id: "opt-no", disabled: false, selector: "#opt-no" }
      ],
      optionSource: "live_probe",
      listboxId: "react-select-question_30650574003-listbox",
      menuSelector: ".select__menu",
      currentValue: "",
      validationErrorText: "This field is required",
      ariaInvalid: true,
      hiddenValues: []
    })
  } as unknown as AdapterRunContext["page"];
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined
  } as unknown as AdapterRunContext["logger"];

  const probed = await adapter.probeLiveSelectOptions(page, {
    key: "question_30650574003",
    id: "question_30650574003",
    label: "Are you an EU citizen?",
    required: true,
    invalid: false,
    controlType: "combobox",
    options: [],
    optionHints: [],
    selector: "#question_30650574003",
    selectorCandidates: ["#question_30650574003"]
  }, logger);

  assert.deepEqual(probed.options.map((item: { text: string }) => item.text), ["Yes", "No"]);
  assert.equal(probed.listboxId, "react-select-question_30650574003-listbox");
});

test("Pronoun live probe drops country-code option leakage", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const page = {
    keyboard: { press: async () => undefined },
    locator: () => ({
      first: () => ({
        count: async () => 1,
        click: async () => undefined,
        press: async () => undefined
      })
    }),
    waitForTimeout: async () => undefined,
    evaluate: async () => ({
      fieldId: "4000981003",
      label: "Pronoun",
      controlType: "combobox",
      required: true,
      options: [
        { text: "United States +1", id: "opt-us", disabled: false, selector: "#opt-us" },
        { text: "Canada +1", id: "opt-ca", disabled: false, selector: "#opt-ca" },
        { text: "Mexico +52", id: "opt-mx", disabled: false, selector: "#opt-mx" }
      ],
      optionSource: "live_probe",
      listboxId: "react-select-country-listbox",
      menuSelector: ".select__menu",
      currentValue: "",
      validationErrorText: "",
      ariaInvalid: true,
      hiddenValues: [],
      ariaControls: "react-select-country-listbox",
      bindingStatus: "bound"
    })
  } as unknown as AdapterRunContext["page"];
  const logger = {
    info: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined
  } as unknown as AdapterRunContext["logger"];

  const probed = await adapter.probeLiveSelectOptions(page, {
    key: "4000981003",
    id: "4000981003",
    label: "Pronoun",
    required: true,
    invalid: false,
    controlType: "combobox",
    options: [],
    optionHints: [],
    selector: "#4000981003",
    selectorCandidates: ["#4000981003"]
  }, logger);

  assert.deepEqual(probed.options.map((item: { text: string }) => item.text), []);
  assert.equal(events.some((entry) => entry.event === "greenhouse_select_binding_mismatch"), true);
  assert.equal(events.some((entry) => entry.event === "greenhouse_demographic_probe_result"), true);
});

test("Sexual Orientation live probe drops country-code option leakage", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const page = {
    keyboard: { press: async () => undefined },
    locator: () => ({
      first: () => ({
        count: async () => 1,
        click: async () => undefined,
        press: async () => undefined
      })
    }),
    waitForTimeout: async () => undefined,
    evaluate: async () => ({
      fieldId: "4000982003",
      label: "Sexual Orientation",
      controlType: "combobox",
      required: true,
      options: [
        { text: "United States +1", id: "opt-us", disabled: false, selector: "#opt-us" },
        { text: "Canada +1", id: "opt-ca", disabled: false, selector: "#opt-ca" },
        { text: "Mexico +52", id: "opt-mx", disabled: false, selector: "#opt-mx" }
      ],
      optionSource: "live_probe",
      listboxId: "react-select-country-listbox",
      menuSelector: ".select__menu",
      currentValue: "",
      validationErrorText: "",
      ariaInvalid: true,
      hiddenValues: [],
      ariaControls: "react-select-country-listbox",
      bindingStatus: "bound"
    })
  } as unknown as AdapterRunContext["page"];

  const probed = await adapter.probeLiveSelectOptions(page, {
    key: "4000982003",
    id: "4000982003",
    label: "Sexual Orientation",
    required: true,
    invalid: false,
    controlType: "combobox",
    options: [],
    optionHints: [],
    selector: "#4000982003",
    selectorCandidates: ["#4000982003"]
  });

  assert.deepEqual(probed.options.map((item: { text: string }) => item.text), []);
});

test("live react-select probe preserves options when aria-controls binding is correct", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const page = {
    keyboard: { press: async () => undefined },
    locator: () => ({
      first: () => ({
        count: async () => 1,
        click: async () => undefined,
        press: async () => undefined
      })
    }),
    waitForTimeout: async () => undefined,
    evaluate: async () => ({
      fieldId: "4000981003",
      label: "Pronoun",
      controlType: "combobox",
      required: true,
      options: [
        { text: "He/Him/His", id: "opt-he", disabled: false, selector: "#opt-he" },
        { text: "Prefer not to say", id: "opt-no", disabled: false, selector: "#opt-no" }
      ],
      optionSource: "live_probe",
      listboxId: "react-select-4000981003-listbox",
      menuSelector: ".select__menu",
      currentValue: "",
      validationErrorText: "",
      ariaInvalid: false,
      hiddenValues: [],
      ariaControls: "react-select-4000981003-listbox",
      bindingStatus: "bound"
    })
  } as unknown as AdapterRunContext["page"];

  const probed = await adapter.probeLiveSelectOptions(page, {
    key: "4000981003",
    id: "4000981003",
    label: "Pronoun",
    required: true,
    invalid: false,
    controlType: "combobox",
    options: [],
    optionHints: [],
    selector: "#4000981003",
    selectorCandidates: ["#4000981003"]
  });

  assert.equal(probed.bindingStatus, "bound");
  assert.equal(probed.ariaControls, "react-select-4000981003-listbox");
  assert.equal(probed.listboxId, "react-select-4000981003-listbox");
  assert.deepEqual(probed.options.map((item: { text: string }) => item.text), ["He/Him/His", "Prefer not to say"]);
});

test("deterministic pronouns mapper uses explicit profile pronouns option", () => {
  const adapter = new GreenhouseAdapter() as any;
  const mapped = adapter.applyGreenhouseRequiredHeuristics(
    {
      id: "4000981003",
      label: "Pronoun",
      type: "single_select",
      required: true,
      options: ["He/Him/His", "They/Them/Theirs", "Prefer not to say"],
      platformMeta: { inputKind: "combobox" }
    },
    "",
    {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "555-555-5555"
      },
      customAnswers: {
        pronouns: "He/Him/His"
      }
    }
  );
  assert.equal(mapped, "He/Him/His");
});

test("sexual orientation mapper defaults to prefer-not-to-answer without explicit profile value", () => {
  const adapter = new GreenhouseAdapter() as any;
  const mapped = adapter.applyGreenhouseRequiredHeuristics(
    {
      id: "4000982003",
      label: "Sexual Orientation",
      type: "single_select",
      required: true,
      options: ["Straight", "Bisexual", "Prefer not to say"],
      platformMeta: { inputKind: "combobox" }
    },
    "Straight",
    {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "555-555-5555"
      }
    }
  );
  assert.equal(mapped, "Prefer not to say");
});

test("phase-b llm-only resolution rejects non-llm answers", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const context = makeGreenhouseContext();
  context.aiEngine = {
    resolve: async () => [
      {
        questionId: "q1",
        value: "California",
        source: "profile",
        reason: "state"
      }
    ]
  } as unknown as AdapterRunContext["aiEngine"];

  const resolved = await adapter.resolveQuestionsWithCache(
    [{ id: "q1", label: "Are you an EU citizen?", type: "single_select", required: true, options: ["Yes", "No"] }],
    context,
    "Role",
    "Affirm",
    undefined,
    true
  );
  assert.equal(resolved.length, 0);
});

test("verifyFieldSatisfied fails when visible value exists but required validation remains", async () => {
  const adapter = new GreenhouseAdapter() as any;
  adapter.collectMissingRequiredDetails = async () => [];
  adapter.inspectRequiredValidationState = async () => ({
    currentValue: "Yes",
    errorText: "This field is required.",
    ariaInvalid: true,
    hiddenValues: ["Yes"]
  });

  const page = {} as AdapterRunContext["page"];
  const satisfied = await adapter.verifyFieldSatisfied(page, "question_30650574003", "select", "Yes", {
    id: "question_30650574003",
    selector: "#question_30650574003"
  });
  assert.equal(satisfied, false);
});

test("optional narrative answering is disabled by default and enabled by config", () => {
  const adapter = new GreenhouseAdapter() as any;
  const question = {
    id: "q_optional",
    label: "Tell us anything else (optional)",
    type: "textarea",
    required: false
  };
  const disabled = adapter.shouldAnswerOptionalNarrative(question, {
    ...makeGreenhouseContext().config,
    greenhouse: {}
  });
  const enabled = adapter.shouldAnswerOptionalNarrative(question, {
    ...makeGreenhouseContext().config,
    greenhouse: { answerOptionalNarratives: true }
  });
  assert.equal(disabled, false);
  assert.equal(enabled, true);
});

test("live probe eligibility excludes radio groups", () => {
  const adapter = new GreenhouseAdapter() as any;
  assert.equal(adapter.isLiveProbeEligibleField("combobox"), true);
  assert.equal(adapter.isLiveProbeEligibleField("select"), true);
  assert.equal(adapter.isLiveProbeEligibleField("radio-group"), false);
});

test("applyAnswer uses radio path and skips react-select commit methods for radio-group", async () => {
  const adapter = new GreenhouseAdapter() as any;
  let reactSelectCalls = 0;
  let radioCalls = 0;
  adapter.selectReactOptionByIdPrefix = async () => {
    reactSelectCalls += 1;
    return true;
  };
  adapter.selectReactOption = async () => {
    reactSelectCalls += 1;
    return true;
  };
  adapter.clickRadioOrCheckbox = async () => {
    radioCalls += 1;
    return true;
  };

  const applied = await adapter.applyAnswer({} as AdapterRunContext["page"], {
    id: "q_radio",
    key: "q_radio",
    label: "Are you authorized to work?",
    type: "single_select",
    required: true,
    inputKind: "radio-group",
    options: ["Yes", "No"],
    name: "question_eligibility"
  }, "Yes");

  assert.equal(applied, true);
  assert.equal(radioCalls, 1);
  assert.equal(reactSelectCalls, 0);
});

test("applyAnswer uses typed combobox first pass for pronoun prompts", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const typedComboboxCalls: string[] = [];
  let reactSelectCalls = 0;

  adapter.fillReactComboboxByTyping = async (_page: unknown, _id: string, candidate: string) => {
    typedComboboxCalls.push(candidate);
    return candidate === "I don't wish to answer";
  };
  adapter.selectReactOptionByIdPrefix = async () => {
    reactSelectCalls += 1;
    return true;
  };

  const page = {
    locator: () => ({
      first: () => ({
        count: async () => 0
      })
    })
  } as unknown as AdapterRunContext["page"];

  const applied = await adapter.applyAnswer(page, {
    id: "question_pronoun",
    key: "question_pronoun",
    label: "Pronoun",
    type: "single_select",
    required: true,
    inputKind: "combobox",
    domId: "question_pronoun",
    options: []
  }, "I don't wish to answer");

  assert.equal(applied, true);
  assert.deepEqual(typedComboboxCalls, ["I don't wish to answer"]);
  assert.equal(reactSelectCalls, 0);
});

test("applyAnswer retries demographic typed first-pass with decline when first choice fails", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const typedComboboxCalls: string[] = [];

  adapter.fillReactComboboxByTyping = async (_page: unknown, _id: string, candidate: string) => {
    typedComboboxCalls.push(candidate);
    return candidate === "Decline To Self Identify";
  };

  const page = {
    locator: () => ({
      first: () => ({
        count: async () => 0
      })
    })
  } as unknown as AdapterRunContext["page"];

  const applied = await adapter.applyAnswer(page, {
    id: "question_pronoun",
    key: "question_pronoun",
    label: "Pronoun",
    type: "single_select",
    required: true,
    inputKind: "combobox",
    domId: "question_pronoun",
    options: []
  }, "Prefer not to say");

  assert.equal(applied, true);
  assert.deepEqual(typedComboboxCalls, ["I don't wish to answer", "Decline To Self Identify"]);
});

test("applyAnswer retries location typed first-pass once before fallback flow", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const typedCalls: string[] = [];

  adapter.fillReactComboboxByTyping = async (_page: unknown, _id: string, candidate: string) => {
    typedCalls.push(candidate);
    return typedCalls.length === 2;
  };

  const page = {
    waitForTimeout: async () => undefined,
    locator: () => ({
      first: () => ({
        count: async () => 0
      })
    })
  } as unknown as AdapterRunContext["page"];

  const applied = await adapter.applyAnswer(page, {
    id: "candidate-location",
    key: "candidate-location",
    label: "Location (City)",
    type: "single_select",
    required: true,
    inputKind: "combobox",
    domId: "candidate-location",
    options: []
  }, "San Diego, California, United States");

  assert.equal(applied, true);
  assert.deepEqual(typedCalls, [
    "San Diego, California, United States",
    "San Diego, California, United States"
  ]);
});

test("verifyFieldSatisfied checks checked state for radio-group fields", async () => {
  const adapter = new GreenhouseAdapter() as any;
  adapter.collectMissingRequiredDetails = async () => [];
  const page = {
    locator: () => ({
      count: async () => 2,
      locator: () => ({
        count: async () => 1
      }),
      nth: () => ({
        isChecked: async () => true
      })
    })
  } as unknown as AdapterRunContext["page"];

  const verified = await adapter.verifyFieldSatisfied(page, "q_radio", "radio-group", "Yes", {
    name: "question_eligibility"
  });
  assert.equal(verified, true);
});

test("eu member state heuristic maps explicit custom yes/no to available options", () => {
  const adapter = new GreenhouseAdapter() as any;
  const baseProfile = {
    basics: {
      firstName: "Test",
      lastName: "User",
      email: "test@example.com",
      phone: "555-555-5555"
    }
  };
  const yesMapped = adapter.applyGreenhouseRequiredHeuristics(
    {
      id: "eu_member_state",
      label: "Are you a citizen of an EU Member State?",
      type: "single_select",
      required: true,
      options: ["Yes", "No"]
    },
    "",
    {
      ...baseProfile,
      customAnswers: {
        "eu citizen": true
      }
    }
  );
  const noMapped = adapter.applyGreenhouseRequiredHeuristics(
    {
      id: "eu_member_state",
      label: "Are you a citizen of an EU Member State?",
      type: "single_select",
      required: true,
      options: ["Yes", "No"]
    },
    "",
    {
      ...baseProfile,
      customAnswers: {
        "eu citizen": false
      }
    }
  );
  assert.equal(yesMapped, "Yes");
  assert.equal(noMapped, "No");
});

test("resolveMissingRequiredFieldAnswerWithAi rejects invalid option answer and retries with option-only prompt", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const events: string[] = [];
  adapter.scanFieldDescriptors = async () => [{
    key: "eu_member_state",
    id: "eu_member_state",
    name: "eu_member_state",
    label: "Are you a citizen of an EU Member State?",
    required: true,
    invalid: true,
    controlType: "combobox",
    options: ["Yes", "No"],
    optionHints: ["Yes", "No"],
    selector: "#eu_member_state",
    selectorCandidates: ["#eu_member_state"]
  }];
  adapter.enrichSelectOptionHints = async () => undefined;
  adapter.resolveSingleQuestionWithCache = async () => "California";

  const resolved = await adapter.resolveMissingRequiredFieldAnswerWithAi(
    {} as AdapterRunContext["page"],
    {
      id: "eu_member_state",
      label: "Are you a citizen of an EU Member State?",
      role: "combobox",
      tag: "input"
    },
    {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "555-555-5555"
      }
    },
    {
      aiEngine: {
        resolve: async () => [{ value: "No", source: "llm" }]
      } as unknown as AdapterRunContext["aiEngine"],
      resumeText: "resume",
      logger: {
        info: (event: string) => events.push(event)
      } as unknown as AdapterRunContext["logger"]
    }
  );

  assert.equal(resolved, "No");
  assert.equal(events.includes("greenhouse_option_answer_rejected"), true);
  assert.equal(events.includes("greenhouse_required_option_retry"), true);
});

test("resolveMissingRequiredFieldAnswerWithAi leaves unresolved when option-only retry still does not match", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const events: string[] = [];
  adapter.scanFieldDescriptors = async () => [{
    key: "eu_member_state",
    id: "eu_member_state",
    name: "eu_member_state",
    label: "Are you a citizen of an EU Member State?",
    required: true,
    invalid: true,
    controlType: "combobox",
    options: ["Yes", "No"],
    optionHints: ["Yes", "No"],
    selector: "#eu_member_state",
    selectorCandidates: ["#eu_member_state"]
  }];
  adapter.enrichSelectOptionHints = async () => undefined;
  adapter.resolveSingleQuestionWithCache = async () => "California";

  const resolved = await adapter.resolveMissingRequiredFieldAnswerWithAi(
    {} as AdapterRunContext["page"],
    {
      id: "eu_member_state",
      label: "Are you a citizen of an EU Member State?",
      role: "combobox",
      tag: "input"
    },
    {
      basics: {
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "555-555-5555"
      }
    },
    {
      aiEngine: {
        resolve: async () => [{ value: "California", source: "llm" }]
      } as unknown as AdapterRunContext["aiEngine"],
      resumeText: "resume",
      logger: {
        info: (event: string) => events.push(event)
      } as unknown as AdapterRunContext["logger"]
    }
  );

  assert.equal(resolved, "");
  assert.equal(events.includes("greenhouse_required_option_unresolved"), true);
});

test("recoverFromValidationErrors does not upsert unverified required text answers", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const context = makeGreenhouseContext();
  const filledFields: Array<{ id: string; label: string; value: string; source: string; inputKind: string }> = [];

  adapter.extractSchemasFromValidationAnchors = async () => [{
    fieldId: "question_15066150008",
    label: "What is your desired annual compensation?",
    required: true,
    fieldType: "text",
    possibleAnswers: [],
    containerMeta: {
      controlId: "question_15066150008"
    }
  }];
  adapter.resolveQuestionsWithCache = async () => [{
    questionId: "question_15066150008",
    value: "$10,000+",
    source: "llm",
    reason: "llm_batch"
  }];
  adapter.applyAnswer = async () => true;
  adapter.verifyFieldSatisfied = async () => false;

  await adapter.recoverFromValidationErrors(
    {} as AdapterRunContext["page"],
    context,
    filledFields,
    ["This field is required."]
  );

  assert.equal(filledFields.length, 0);
});

test("reconcile required skips already-valid demographic combobox instead of overwriting with llm answer", async () => {
  const adapter = new GreenhouseAdapter() as any;
  const context = makeGreenhouseContext();
  const filledFields: Array<{ id: string; label: string; value: string; source: string; inputKind: string }> = [];
  const selectedAnswers: string[] = [];

  let missingPass = 0;
  adapter.closePhoneCountryWidget = async () => undefined;
  adapter.syncAllRequiredSelectSentinels = async () => undefined;
  adapter.collectMissingRequiredDetails = async () => {
    if (missingPass > 0) return [];
    missingPass += 1;
    return [{ id: "4000981003", label: "Pronoun", role: "combobox", tag: "input" }];
  };
  adapter.inspectRequiredValidationState = async () => ({
    currentValue: "I don't wish to answer",
    errorText: "",
    ariaInvalid: false,
    hiddenValues: []
  });
  adapter.probeLiveSelectOptions = async () => null;
  adapter.selectReactOptionByIdPrefix = async (_page: unknown, _id: string, answer: string) => {
    selectedAnswers.push(answer);
    return true;
  };
  adapter.selectReactOption = async () => false;
  adapter.selectComboboxByMissingField = async () => false;
  adapter.verifyFieldSatisfied = async () => true;

  await adapter.reconcileRequiredFieldsBeforeSubmit(
    {} as AdapterRunContext["page"],
    [{ questionId: "4000981003", value: "He/Him", source: "llm" }],
    context.profile,
    filledFields,
    {
      aiEngine: context.aiEngine,
      resumeText: context.resumeText,
      logger: context.logger,
      config: context.config
    }
  );

  assert.deepEqual(selectedAnswers, []);
});

test("declining to self-identify matches however the site words it", () => {
  // Observed on live Greenhouse postings. The rules engine always answers
  // "Decline to self-identify"; none of these forms use that phrase, and a
  // substring matcher found nothing, so four required questions per form went
  // unanswered and were then retried until the run gave up.
  const wordings = [
    ["I don't wish to answer", "Male", "Female"],
    ["Prefer not to say", "Yes", "No"],
    ["I do not wish to disclose", "Veteran", "Not a veteran"],
    ["Choose not to disclose", "Yes, I have a disability", "No"],
    ["Decline To Self Identify", "Hispanic or Latino", "White"]
  ];
  for (const options of wordings) {
    assert.equal(
      pickBestOption("Decline to self-identify", options),
      options[0],
      `should have matched ${options[0]}`
    );
  }
});

test("declining never invents an answer when the form offers no way to decline", () => {
  // An ethnicity question whose only options are Yes and No cannot be declined.
  // Picking one would be Automa answering a demographic question on the user's
  // behalf, which is the one thing it must never do.
  const picked = pickBestOption("Decline to self-identify", ["Yes", "No"]);
  assert.equal(picked, "Decline to self-identify");
  assert.equal(["Yes", "No"].includes(picked), false);
});
