import test from "node:test";
import assert from "node:assert/strict";
import { pickLanguageQuestionnaireOption, isLanguageQuestionnaireLegend } from "./workday/executor.js";
import { normalizeWorkdayProfile, resolveQuestionnaireField, resolveWorkdayDeterministic, type WorkdayQuestionnaireField } from "./workday/resolver.js";
import type { WorkdayFieldSchema } from "./workday/schema.js";
import type { CandidateProfile } from "../core/types.js";

function mkField(fieldId: string, label: string): WorkdayFieldSchema {
  return {
    fieldId,
    label,
    required: true,
    fieldType: "dropdown",
    possibleAnswers: [],
    currentValue: null,
    selectorHints: {},
    step: "application_questions",
    htmlSummary: {}
  };
}

test("language legend matcher catches english/language/proficiency/speak-read-write patterns", () => {
  assert.equal(isLanguageQuestionnaireLegend("English"), true);
  assert.equal(isLanguageQuestionnaireLegend("Language Proficiency"), true);
  assert.equal(isLanguageQuestionnaireLegend("Can you speak, read, and write Spanish?"), true);
  assert.equal(isLanguageQuestionnaireLegend("Work authorization"), false);
});

test("language option picker honors priority order", () => {
  const picked = pickLanguageQuestionnaireOption(["Select One", "Native speaker", "Fluent", "Professional working"]);
  assert.equal(picked, "Fluent");
});

test("language option picker falls back to first non-placeholder option", () => {
  const picked = pickLanguageQuestionnaireOption(["Select One", "Conversational", "Beginner"]);
  assert.equal(picked, "Conversational");
});

test("deterministic resolver defaults language/proficiency labels to Fluent", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const schema: WorkdayFieldSchema[] = [
    mkField("f1", "English Proficiency"),
    mkField("f2", "Primary Language"),
    mkField("f3", "Can you speak/read/write English?")
  ];

  const resolved = resolveWorkdayDeterministic(schema, profile, "application_questions");
  assert.equal(resolved.get("f1")?.value, "Fluent");
  assert.equal(resolved.get("f2")?.value, "Fluent");
  assert.equal(resolved.get("f3")?.value, "Fluent");
});

test("deterministic resolver does not default low-risk application questions to No", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const schema: WorkdayFieldSchema[] = [
    mkField("prev_applicant", "Have you previously applied to this company?")
  ];

  const resolved = resolveWorkdayDeterministic(schema, profile, "application_questions");
  assert.equal(resolved.get("prev_applicant"), undefined);
});

test("resolveQuestionnaireField lets llm answer low-risk application question with yes", async () => {
  const profileRaw = {
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" }
  } as CandidateProfile;
  const normalized = normalizeWorkdayProfile(profileRaw);
  const field = mkQuestionField(
    "Do you have a relative(s) employed by GPC or any GPC subsidiaries?",
    ["Select One", "Yes", "No"]
  );
  const out = await resolveQuestionnaireField({
    field,
    profile: normalized,
    profileRaw,
    jobContext: { url: "https://example.com" },
    aiEngine: { resolve: async () => [{ questionId: field.fieldId, value: "Yes", source: "llm" }] } as any,
    resumeText: ""
  });
  assert.equal(out.source, "llm");
  assert.equal(out.value, "Yes");
});

test("normalizeWorkdayProfile derives address fields from basics location fallback", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com",
      location: "1497 Oakpoint Ave, San Diego, 91913, California"
    }
  } as CandidateProfile);

  assert.equal(profile.contact.address.line1, "1497 Oakpoint Ave");
  assert.equal(profile.contact.address.city, "San Diego");
  assert.equal(profile.contact.address.postalCode, "91913");
});

test("normalizeWorkdayProfile parses postal code from custom address string", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    customAnswers: {
      address: "1497 Oakpoint Ave, San Diego, 91913, California"
    }
  } as CandidateProfile);

  assert.equal(profile.contact.address.line1, "1497 Oakpoint Ave");
  assert.equal(profile.contact.address.city, "San Diego");
  assert.equal(profile.contact.address.postalCode, "91913");
});

test("normalizeWorkdayProfile derives graduation date formats from top-level education fallback", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    education: {
      school: "Example University",
      degree: "B.S.",
      field: "Computer Science",
      endMonth: "May",
      endYear: "2027",
      graduationDateMmDdYyyy: "05/15/2027"
    }
  } as CandidateProfile);

  assert.equal(profile.education[0]?.graduationDateMmDdYyyy, "05/15/2027");
  assert.equal(profile.education[0]?.graduationDateMmYyyy, "05/2027");
});

test("deterministic resolver maps previously worked for company prompt to No", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const schema: WorkdayFieldSchema[] = [
    mkField("prev_worker", "Have you previously worked for CAE?")
  ];
  const resolved = resolveWorkdayDeterministic(schema, profile, "contact_information");
  assert.equal(resolved.get("prev_worker")?.value, "No");
});

test("deterministic resolver maps candidateIsPreviousWorker radio 'No' option", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const schema: WorkdayFieldSchema[] = [
    { ...mkField("candidateIsPreviousWorker_1", "Yes"), fieldType: "radio" },
    { ...mkField("candidateIsPreviousWorker_2", "No"), fieldType: "radio" }
  ];
  const resolved = resolveWorkdayDeterministic(schema, profile, "contact_information");
  assert.equal(resolved.get("candidateIsPreviousWorker_1"), undefined);
  assert.equal(resolved.get("candidateIsPreviousWorker_2")?.value, "No");
});

function mkQuestionField(labelText: string, options: string[] = []): WorkdayQuestionnaireField {
  return {
    fieldId: labelText.toLowerCase().replace(/\s+/g, "_"),
    labelText,
    inputKind: "dropdown",
    options,
    selector: "button[data-automation-id='fake']",
    currentValue: "select one",
    required: true
  };
}

test("resolveQuestionnaireField deterministic maps work authorization to affirmative option", async () => {
  const profileRaw = {
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" },
    workAuthorization: { authorizedToWork: true, requiresSponsorship: false }
  } as CandidateProfile;
  const normalized = normalizeWorkdayProfile(profileRaw);
  const field = mkQuestionField(
    "Are you legally authorised to work in the country where you are applying for this position?",
    ["Select One", "Yes", "No"]
  );
  const out = await resolveQuestionnaireField({
    field,
    profile: normalized,
    profileRaw,
    jobContext: { url: "https://example.com" },
    aiEngine: { resolve: async () => [] } as any,
    resumeText: ""
  });
  assert.equal(out.source, "deterministic");
  assert.equal(out.value, "Yes");
});

test("resolveQuestionnaireField deterministic maps lawfully permitted work question to affirmative option", async () => {
  const profileRaw = {
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" },
    workAuthorization: { authorizedToWork: true, requiresSponsorship: false }
  } as CandidateProfile;
  const normalized = normalizeWorkdayProfile(profileRaw);
  const field = mkQuestionField(
    "Are you lawfully permitted to work in the United States?",
    ["Select One", "Yes", "No"]
  );
  const out = await resolveQuestionnaireField({
    field,
    profile: normalized,
    profileRaw,
    jobContext: { url: "https://example.com" },
    aiEngine: { resolve: async () => [] } as any,
    resumeText: ""
  });
  assert.equal(out.source, "deterministic");
  assert.equal(out.value, "Yes");
});

test("resolveQuestionnaireField deterministic maps sponsorship to negative option", async () => {
  const profileRaw = {
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" },
    workAuthorization: { authorizedToWork: true, requiresSponsorship: false }
  } as CandidateProfile;
  const normalized = normalizeWorkdayProfile(profileRaw);
  const field = mkQuestionField("Will you require visa sponsorship?", ["Select One", "Yes", "No"]);
  const out = await resolveQuestionnaireField({
    field,
    profile: normalized,
    profileRaw,
    jobContext: { url: "https://example.com" },
    aiEngine: { resolve: async () => [] } as any,
    resumeText: ""
  });
  assert.equal(out.source, "deterministic");
  assert.equal(out.value, "No");
});

test("resolveQuestionnaireField deterministic maps start date to earliest reasonable option", async () => {
  const profileRaw = {
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" }
  } as CandidateProfile;
  const normalized = normalizeWorkdayProfile(profileRaw);
  const field = mkQuestionField("What is your available start date?", ["Select One", "2-4 weeks", "Immediately"]);
  const out = await resolveQuestionnaireField({
    field,
    profile: normalized,
    profileRaw,
    jobContext: { url: "https://example.com" },
    aiEngine: { resolve: async () => [] } as any,
    resumeText: ""
  });
  assert.equal(out.source, "deterministic");
  assert.equal(out.value, "Immediately");
});

test("resolveQuestionnaireField marks manual review when llm answer is not in options", async () => {
  const profileRaw = {
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" }
  } as CandidateProfile;
  const normalized = normalizeWorkdayProfile(profileRaw);
  const field = mkQuestionField("Custom unmapped prompt", ["Option A", "Option B"]);
  const out = await resolveQuestionnaireField({
    field,
    profile: normalized,
    profileRaw,
    jobContext: { url: "https://example.com" },
    aiEngine: { resolve: async () => [{ questionId: field.fieldId, value: "Not In Options", source: "llm" }] } as any,
    resumeText: ""
  });
  assert.equal(out.source, "manual_review");
  assert.equal(out.manualReview, true);
});

test("resolveQuestionnaireField deterministic maps clearance eligibility to affirmative option", async () => {
  const profileRaw = {
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" },
    workAuthorization: { authorizedToWork: true, requiresSponsorship: false }
  } as CandidateProfile;
  const normalized = normalizeWorkdayProfile(profileRaw);
  const field = mkQuestionField(
    "Are you eligible for a US Dept. of Defense Security Clearance?",
    ["Select One", "No", "Yes"]
  );
  const out = await resolveQuestionnaireField({
    field,
    profile: normalized,
    profileRaw,
    jobContext: { url: "https://example.com" },
    aiEngine: { resolve: async () => [] } as any,
    resumeText: ""
  });
  assert.equal(out.source, "deterministic");
  assert.equal(out.value, "Yes");
});

test("resolveQuestionnaireField deterministic maps active government or military status to No", async () => {
  const profileRaw = {
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" },
    workAuthorization: { authorizedToWork: true, requiresSponsorship: false }
  } as CandidateProfile;
  const normalized = normalizeWorkdayProfile(profileRaw);
  const field = mkQuestionField(
    "Are you currently employed by the US Government, active duty military, reserves, or national guard?",
    ["Select One", "Yes", "No"]
  );
  const out = await resolveQuestionnaireField({
    field,
    profile: normalized,
    profileRaw,
    jobContext: { url: "https://example.com" },
    aiEngine: { resolve: async () => [] } as any,
    resumeText: ""
  });
  assert.equal(out.source, "deterministic");
  assert.equal(out.value, "No");
});

test("resolveQuestionnaireField deterministic maps patent or intellectual property question to No", async () => {
  const profileRaw = {
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" }
  } as CandidateProfile;
  const normalized = normalizeWorkdayProfile(profileRaw);
  const field = mkQuestionField(
    "Do you own, control, or have an economic interest in any intellectual property rights (patents, trademarks, or copyrights)?",
    ["Select One", "Yes", "No"]
  );
  const out = await resolveQuestionnaireField({
    field,
    profile: normalized,
    profileRaw,
    jobContext: { url: "https://example.com" },
    aiEngine: { resolve: async () => [] } as any,
    resumeText: ""
  });
  assert.equal(out.source, "deterministic");
  assert.equal(out.value, "No");
});

test("resolveQuestionnaireField deterministic maps future activity multi-select prompt to Neither", async () => {
  const profileRaw = {
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" }
  } as CandidateProfile;
  const normalized = normalizeWorkdayProfile(profileRaw);
  const field = {
    ...mkQuestionField(
      "If hired, do you intend to (select all that apply):",
      ["Maintain any secondary non-Intel employment or engage in a non-Intel business activity?", "Sit on the board of directors or similar governing body (e.g., board of advisors) of a non-Intel entity?", "Neither"]
    ),
    inputKind: "checkbox" as const
  };
  const out = await resolveQuestionnaireField({
    field,
    profile: normalized,
    profileRaw,
    jobContext: { url: "https://example.com" },
    aiEngine: { resolve: async () => [] } as any,
    resumeText: ""
  });
  assert.equal(out.source, "deterministic");
  assert.equal(out.value, "Neither");
});

test("resolveQuestionnaireField deterministic maps export control prompt to Yes for authorized US candidate", async () => {
  const profileRaw = {
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" },
    workAuthorization: { authorizedToWork: true, requiresSponsorship: false }
  } as CandidateProfile;
  const normalized = normalizeWorkdayProfile(profileRaw);
  const field = mkQuestionField(
    "Export Control: Are you a U.S. citizen or national, lawful permanent resident, or have been approved for refugee or asylee status by the U.S. Government?",
    ["Select One", "Yes", "No"]
  );
  const out = await resolveQuestionnaireField({
    field,
    profile: normalized,
    profileRaw,
    jobContext: { url: "https://example.com" },
    aiEngine: { resolve: async () => [] } as any,
    resumeText: ""
  });
  assert.equal(out.source, "deterministic");
  assert.equal(out.value, "Yes");
});
