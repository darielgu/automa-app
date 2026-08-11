import test from "node:test";
import assert from "node:assert/strict";
import {
  LeverAdapter,
  buildLeverLocationAnswer,
  formatDateMmDdYyyy,
  isValidLeverSelectedLocation,
  mapLeverTemplateTypeToFieldType,
  normalizeText,
  parseLeverSelectedLocationStatus,
  parseLeverBaseTemplateJson,
  pickEarliestNonPlaceholderOption,
  resolveDeterministicProfileValue,
  validateAndRepairOption,
  type LeverFieldSchema
} from "./lever.js";
import type { CandidateProfile } from "../core/types.js";

test("normalizeText collapses whitespace and trims", () => {
  assert.equal(normalizeText("  hello\n   world  "), "hello world");
  assert.equal(normalizeText(null), "");
});

test("parseLeverBaseTemplateJson parses valid fields", () => {
  const raw = JSON.stringify({
    fields: [
      {
        type: "multiple-choice",
        text: "Work authorization",
        required: true,
        options: [{ text: "Yes" }, { text: "No" }]
      }
    ]
  });

  const out = parseLeverBaseTemplateJson(raw, "card_1");
  assert.equal(out.length, 1);
  assert.equal(out[0]?.label, "Work authorization");
  assert.equal(out[0]?.required, true);
  assert.equal(out[0]?.fieldType, "radio");
  assert.deepEqual(out[0]?.options, ["Yes", "No"]);
});

test("parseLeverBaseTemplateJson handles malformed json", () => {
  const out = parseLeverBaseTemplateJson("{bad-json", "card_1");
  assert.deepEqual(out, []);
});

test("mapLeverTemplateTypeToFieldType maps expected values", () => {
  assert.equal(mapLeverTemplateTypeToFieldType("text"), "text");
  assert.equal(mapLeverTemplateTypeToFieldType("textarea"), "textarea");
  assert.equal(mapLeverTemplateTypeToFieldType("multiple-choice"), "radio");
  assert.equal(mapLeverTemplateTypeToFieldType("multiple-select"), "checkbox_group");
  assert.equal(mapLeverTemplateTypeToFieldType("dropdown"), "select");
  assert.equal(mapLeverTemplateTypeToFieldType("other"), "unknown");
});

test("validateAndRepairOption repairs single-choice option", () => {
  const repaired = validateAndRepairOption("radio", ["Yes", "No"], "yes", []);
  assert.equal(repaired.answer, "Yes");
  assert.deepEqual(repaired.selectedOptions, ["Yes"]);
});

test("validateAndRepairOption filters checkbox options", () => {
  const repaired = validateAndRepairOption("checkbox_group", ["TypeScript", "Go"], null, ["Go", "Rust"]);
  assert.equal(repaired.answer, null);
  assert.deepEqual(repaired.selectedOptions, ["Go"]);
});

test("formatDateMmDdYyyy emits strict MM/DD/YYYY", () => {
  const out = formatDateMmDdYyyy(new Date("2026-04-30T00:00:00.000Z"));
  assert.match(out, /^\d{2}\/\d{2}\/\d{4}$/);
});

test("pickEarliestNonPlaceholderOption picks first real option", () => {
  const picked = pickEarliestNonPlaceholderOption(["Select...", "Choose one", "Summer 2026", "Fall 2026"]);
  assert.equal(picked, "Summer 2026");
});

test("deterministic profile resolver maps resume/email/location/work auth", () => {
  const profile: CandidateProfile = {
    basics: {
      firstName: "Alex",
      lastName: "Rivera",
      email: "alex.rivera@example.com",
      location: "San Diego, CA"
    },
    workAuthorization: {
      authorizedToWork: true,
      requiresSponsorship: false
    },
    links: {
      linkedin: "https://linkedin.com/in/alex-rivera",
      github: "https://github.com/alex-rivera"
    }
  };

  const mkField = (label: string, fieldType: LeverFieldSchema["fieldType"], possibleAnswers: string[] = []): LeverFieldSchema => ({
    fieldId: label.toLowerCase().replace(/\s+/g, "_"),
    label,
    sectionTitle: "Application",
    required: true,
    fieldType,
    possibleAnswers,
    currentValue: null,
    selectorHints: { selector: "input" },
    htmlSummary: {}
  });

  const resume = resolveDeterministicProfileValue(mkField("Resume/CV", "file"), profile, "/tmp/resume.pdf");
  assert.equal(resume?.answer, "/tmp/resume.pdf");

  const email = resolveDeterministicProfileValue(mkField("Email", "email"), profile);
  assert.equal(email?.answer, "alex.rivera@example.com");

  const github = resolveDeterministicProfileValue(mkField("GitHub URL", "text"), profile);
  assert.equal(github?.answer, "https://github.com/alex-rivera");
  assert.equal(github?.reason, "profile_github");

  const personalWebsite = resolveDeterministicProfileValue(mkField("Personal website", "text"), profile);
  assert.equal(personalWebsite?.answer, "https://github.com/alex-rivera");
  assert.equal(personalWebsite?.reason, "profile_portfolio_site");

  const location = resolveDeterministicProfileValue(mkField("Current location", "location_autocomplete"), profile);
  assert.equal(location?.answer, "San Diego, CA");

  const auth = resolveDeterministicProfileValue(mkField("Are you authorized to work in the U.S.?", "radio", ["Yes", "No"]), profile);
  assert.equal(auth?.answer, "Yes");

  const sponsorship = resolveDeterministicProfileValue(mkField("Will you require visa sponsorship?", "radio", ["Yes", "No"]), profile);
  assert.equal(sponsorship?.answer, "No");
});

test("buildLeverLocationAnswer prefers structured city and region", () => {
  const profile: CandidateProfile = {
    basics: {
      firstName: "Alex",
      lastName: "Rivera",
      email: "alex.rivera@example.com",
      location: "1497 Oakpoint Ave, San Diego, California, 91913"
    },
    locationStructured: {
      city: "San Diego",
      region: "CA",
      country: "United States"
    }
  };

  assert.equal(buildLeverLocationAnswer(profile), "San Diego, CA");
});

test("buildLeverLocationAnswer parses address-like basics.location into city and region", () => {
  const profile: CandidateProfile = {
    basics: {
      firstName: "Alex",
      lastName: "Rivera",
      email: "alex.rivera@example.com",
      location: "1497 Oakpoint Ave, San Diego, California, 91913"
    }
  };

  assert.equal(buildLeverLocationAnswer(profile), "San Diego, California");
});

test("parseLeverSelectedLocationStatus validates hidden selectedLocation payload", () => {
  const parsed = parseLeverSelectedLocationStatus('{"name":"San Diego, California, United States","id":"city-123"}');
  assert.equal(parsed.name, "San Diego, California, United States");
  assert.equal(parsed.id, "city-123");
  assert.equal(parsed.valid, true);
});

test("isValidLeverSelectedLocation rejects stale or malformed location payloads", () => {
  assert.equal(isValidLeverSelectedLocation(""), false);
  assert.equal(isValidLeverSelectedLocation("not-json"), false);
  assert.equal(isValidLeverSelectedLocation('{"name":"No location found"}'), false);
  assert.equal(isValidLeverSelectedLocation('{"name":"San Diego, CA"}'), true);
});

test("deterministic resolver maps location select to available region option", () => {
  const profile: CandidateProfile = {
    basics: {
      firstName: "Alex",
      lastName: "Rivera",
      email: "alex.rivera@example.com",
      location: "1497 Oakpoint Ave, San Diego, 91913, California"
    }
  };

  const field: LeverFieldSchema = {
    fieldId: "cards[location][field0]",
    label: "Which location are you currently based in?",
    sectionTitle: "Location Based",
    required: true,
    fieldType: "select",
    possibleAnswers: ["Melbourne, Australia", "Texas, USA", "New York, USA", "California, USA", "Others"],
    currentValue: null,
    selectorHints: { selector: "select" },
    htmlSummary: {}
  };

  const resolved = resolveDeterministicProfileValue(field, profile);
  assert.equal(resolved?.answer, "California, USA");
  assert.deepEqual(resolved?.selectedOptions, ["California, USA"]);
});

test("deterministic resolver auto-selects single required confirmation checkbox", () => {
  const profile: CandidateProfile = {
    basics: {
      firstName: "Alex",
      lastName: "Rivera",
      email: "alex.rivera@example.com",
      location: "San Diego, CA"
    }
  };

  const field: LeverFieldSchema = {
    fieldId: "cards[declaration][field0]",
    label: "Confirmation of Information Provided",
    sectionTitle: "Declaration",
    required: true,
    fieldType: "checkbox_group",
    possibleAnswers: [
      "I hereby confirm that all information provided to ShopBack Group, including but not limited to the information provided above, the information represented on my LinkedIn profile, the information stated on my resume, and any other information provided in connection with my employment application, is true and accurate."
    ],
    currentValue: null,
    selectorHints: { selector: "input" },
    htmlSummary: {}
  };

  const resolved = resolveDeterministicProfileValue(field, profile);
  assert.equal(resolved?.answer, null);
  assert.deepEqual(resolved?.selectedOptions, field.possibleAnswers);
  assert.equal(resolved?.reason, "deterministic_confirmation_checkbox");
});

test("deterministic resolver maps disability date and semester option", () => {
  const profile: CandidateProfile = {
    basics: {
      firstName: "Alex",
      lastName: "Rivera",
      email: "alex.rivera@example.com",
      location: "San Diego, CA"
    }
  };

  const mkField = (label: string, fieldType: LeverFieldSchema["fieldType"], possibleAnswers: string[] = []): LeverFieldSchema => ({
    fieldId: label.toLowerCase().replace(/\s+/g, "_"),
    label,
    sectionTitle: "Application",
    required: true,
    fieldType,
    possibleAnswers,
    currentValue: null,
    selectorHints: { selector: "input" },
    htmlSummary: {}
  });

  const disabilityDate = resolveDeterministicProfileValue(mkField("Disability status signature date", "text"), profile);
  assert.match(String(disabilityDate?.answer ?? ""), /^\d{2}\/\d{2}\/\d{4}$/);

  const semester = resolveDeterministicProfileValue(
    mkField("What semester are you interested in?", "radio", ["Select...", "Summer 2026", "Fall 2026"]),
    profile
  );
  assert.equal(semester?.answer, "Summer 2026");
});

test("pre-submit gate treats verified invalid required radio as soft conflict", async () => {
  const adapter = new LeverAdapter() as unknown as {
    evaluatePreSubmitGate: (...args: unknown[]) => Promise<{
      hardBlockerFieldIds: string[];
      softConflictFieldIds: string[];
      blockerFieldIds: string[];
    }>;
    extractInvalidFieldIds: () => Promise<string[]>;
    collectRequiredFieldDomStatus: () => Promise<Map<string, { fieldId: string; satisfied: boolean }>>;
  };
  adapter.extractInvalidFieldIds = async () => ["cards[auth][field0]"];
  adapter.collectRequiredFieldDomStatus = async () => new Map();

  const schema: LeverFieldSchema[] = [
    {
      fieldId: "cards[auth][field0]",
      label: "Are you authorized to work in the U.S.?",
      sectionTitle: "Application",
      required: true,
      fieldType: "radio",
      possibleAnswers: ["Yes", "No"],
      currentValue: null,
      selectorHints: { selector: "input[name='cards[auth][field0]']", name: "cards[auth][field0]" },
      htmlSummary: {}
    }
  ];
  const planned = [{ fieldId: "cards[auth][field0]", answer: "Yes", selectedOptions: ["Yes"] }];
  const execution = new Map([
    ["cards[auth][field0]", { fieldId: "cards[auth][field0]", applied: true, verified: true, lastVerifiedAt: new Date().toISOString() }]
  ]);

  const status = await adapter.evaluatePreSubmitGate({ evaluate: async () => [] } as never, schema, planned, new Set<string>(), execution);
  assert.deepEqual(status.hardBlockerFieldIds, []);
  assert.deepEqual(status.softConflictFieldIds, ["cards[auth][field0]"]);
  assert.deepEqual(status.blockerFieldIds, ["cards[auth][field0]"]);
});

test("pre-submit gate keeps unverified invalid required radio as hard blocker", async () => {
  const adapter = new LeverAdapter() as unknown as {
    evaluatePreSubmitGate: (...args: unknown[]) => Promise<{
      hardBlockerFieldIds: string[];
      softConflictFieldIds: string[];
      blockerFieldIds: string[];
    }>;
    extractInvalidFieldIds: () => Promise<string[]>;
    collectRequiredFieldDomStatus: () => Promise<Map<string, { fieldId: string; satisfied: boolean }>>;
  };
  adapter.extractInvalidFieldIds = async () => ["cards[auth][field0]"];
  adapter.collectRequiredFieldDomStatus = async () => new Map();

  const schema: LeverFieldSchema[] = [
    {
      fieldId: "cards[auth][field0]",
      label: "Are you authorized to work in the U.S.?",
      sectionTitle: "Application",
      required: true,
      fieldType: "radio",
      possibleAnswers: ["Yes", "No"],
      currentValue: null,
      selectorHints: { selector: "input[name='cards[auth][field0]']", name: "cards[auth][field0]" },
      htmlSummary: {}
    }
  ];
  const planned = [{ fieldId: "cards[auth][field0]", answer: "Yes", selectedOptions: ["Yes"] }];
  const execution = new Map([
    ["cards[auth][field0]", { fieldId: "cards[auth][field0]", applied: true, verified: false, lastVerifiedAt: null }]
  ]);

  const status = await adapter.evaluatePreSubmitGate({ evaluate: async () => [] } as never, schema, planned, new Set<string>(), execution);
  assert.deepEqual(status.hardBlockerFieldIds, ["cards[auth][field0]"]);
  assert.deepEqual(status.softConflictFieldIds, []);
  assert.deepEqual(status.blockerFieldIds, ["cards[auth][field0]"]);
});

test("pre-submit gate trusts live dom satisfied required radio as soft conflict", async () => {
  const adapter = new LeverAdapter() as unknown as {
    evaluatePreSubmitGate: (...args: unknown[]) => Promise<{
      hardBlockerFieldIds: string[];
      softConflictFieldIds: string[];
      blockerFieldIds: string[];
    }>;
    extractInvalidFieldIds: () => Promise<string[]>;
    collectRequiredFieldDomStatus: () => Promise<Map<string, { fieldId: string; satisfied: boolean }>>;
  };
  adapter.extractInvalidFieldIds = async () => ["cards[auth][field0]"];
  adapter.collectRequiredFieldDomStatus = async () =>
    new Map([["cards[auth][field0]", { fieldId: "cards[auth][field0]", satisfied: true }]]);

  const schema: LeverFieldSchema[] = [
    {
      fieldId: "cards[auth][field0]",
      label: "Are you authorized to work in the U.S.?",
      sectionTitle: "Application",
      required: true,
      fieldType: "radio",
      possibleAnswers: ["Yes", "No"],
      currentValue: null,
      selectorHints: { selector: "input[name='cards[auth][field0]']", name: "cards[auth][field0]" },
      htmlSummary: {}
    }
  ];
  const planned = [{ fieldId: "cards[auth][field0]", answer: "Yes", selectedOptions: ["Yes"] }];
  const execution = new Map([
    ["cards[auth][field0]", { fieldId: "cards[auth][field0]", applied: true, verified: false, lastVerifiedAt: null }]
  ]);

  const status = await adapter.evaluatePreSubmitGate({} as never, schema, planned, new Set<string>(), execution);
  assert.deepEqual(status.hardBlockerFieldIds, []);
  assert.deepEqual(status.softConflictFieldIds, ["cards[auth][field0]"]);
  assert.deepEqual(status.blockerFieldIds, ["cards[auth][field0]"]);
});

test("pre-submit gate marks location token missing when text exists without structured token", async () => {
  const adapter = new LeverAdapter() as unknown as {
    evaluatePreSubmitGate: (...args: unknown[]) => Promise<{
      locationTokenMissingFieldIds: string[];
      hardBlockerFieldIds: string[];
      blockerFieldIds: string[];
    }>;
    extractInvalidFieldIds: () => Promise<string[]>;
    collectRequiredFieldDomStatus: () => Promise<Map<string, {
      fieldId: string;
      satisfied: boolean;
      locationVisibleValue: string;
      locationHiddenValue: string;
      locationTokenValid: boolean;
    }>>;
  };
  adapter.extractInvalidFieldIds = async () => ["location"];
  adapter.collectRequiredFieldDomStatus = async () =>
    new Map([[
      "location",
      {
        fieldId: "location",
        satisfied: false,
        locationVisibleValue: "San Diego, California",
        locationHiddenValue: "",
        locationTokenValid: false
      }
    ]]);

  const schema: LeverFieldSchema[] = [
    {
      fieldId: "location",
      label: "Current location",
      sectionTitle: "Application",
      required: true,
      fieldType: "location_autocomplete",
      possibleAnswers: [],
      currentValue: null,
      selectorHints: { selector: "#location-input", name: "location" },
      htmlSummary: {}
    }
  ];
  const planned = [{ fieldId: "location", answer: "San Diego, California", selectedOptions: [] }];
  const execution = new Map([["location", { fieldId: "location", applied: true, verified: false, lastVerifiedAt: null }]]);

  const status = await adapter.evaluatePreSubmitGate({ evaluate: async () => [] } as never, schema, planned, new Set<string>(), execution);
  assert.deepEqual(status.locationTokenMissingFieldIds, ["location"]);
  assert.deepEqual(status.hardBlockerFieldIds, ["location"]);
  assert.deepEqual(status.blockerFieldIds, ["location"]);
});

test("invalid-field mapping prefers exact name/id matches over broad label fallback", async () => {
  const adapter = new LeverAdapter() as unknown as {
    extractInvalidFieldIds: (page: unknown, schema: LeverFieldSchema[], frozen: Set<string>) => Promise<string[]>;
  };
  const page = {
    evaluate: async () => ({
      ids: ["cards[auth][field0]"],
      signals: [{ key: "cards[auth][field0]", containerLabel: "Work authorization" }]
    })
  };
  const schema: LeverFieldSchema[] = [
    {
      fieldId: "cards[auth][field0]",
      label: "Work authorization",
      sectionTitle: "Application",
      required: true,
      fieldType: "radio",
      possibleAnswers: ["Yes", "No"],
      currentValue: null,
      selectorHints: { selector: "input", name: "cards[auth][field0]" },
      htmlSummary: {}
    },
    {
      fieldId: "cards[sponsor][field0]",
      label: "Work authorization details",
      sectionTitle: "Application",
      required: true,
      fieldType: "textarea",
      possibleAnswers: [],
      currentValue: null,
      selectorHints: { selector: "textarea", name: "cards[sponsor][field0]" },
      htmlSummary: {}
    }
  ];

  const invalid = await adapter.extractInvalidFieldIds(page, schema, new Set<string>());
  assert.deepEqual(invalid, ["cards[auth][field0]"]);
});

test("deterministic resolver picks strong internship commitment option", () => {
  const profile: CandidateProfile = {
    basics: {
      firstName: "Alex",
      lastName: "Rivera",
      email: "alex.rivera@example.com",
      location: "San Diego, CA"
    }
  };

  const field: LeverFieldSchema = {
    fieldId: "cards[internship][field0]",
    label: "How long is your commitment period for a full time internship?",
    sectionTitle: "Internship",
    required: true,
    fieldType: "select",
    possibleAnswers: [
      "3 months full time",
      "4 months full time",
      "Priority will be given to interns who can commit 6+ months, full time (Mondays to Fridays, 9.30- 6pm)"
    ],
    currentValue: null,
    selectorHints: { selector: "select" },
    htmlSummary: {}
  };

  const resolved = resolveDeterministicProfileValue(field, profile);
  assert.equal(resolved?.answer, "4 months full time");
  assert.equal(resolved?.reason, "deterministic_internship_commitment");
});

test("deterministic resolver keeps internship availability future-oriented", () => {
  const profile: CandidateProfile = {
    basics: {
      firstName: "Alex",
      lastName: "Rivera",
      email: "alex.rivera@example.com",
      location: "San Diego, CA"
    }
  };

  const field: LeverFieldSchema = {
    fieldId: "cards[internship][field1]",
    label: "When is your availability (eg. Mar'25 - Feb'26)?",
    sectionTitle: "Internship",
    required: true,
    fieldType: "text",
    possibleAnswers: [],
    currentValue: null,
    selectorHints: { selector: "input" },
    htmlSummary: {}
  };

  const resolved = resolveDeterministicProfileValue(field, profile);
  assert.equal(resolved?.reason, "deterministic_internship_availability");
  assert.match(String(resolved?.answer ?? ""), /^[A-Z][a-z]{2}'\d{2} - [A-Z][a-z]{2}'\d{2}$/);
});

test("deterministic resolver picks one relocation city for eu preference checkbox prompt", () => {
  const profile: CandidateProfile = {
    basics: {
      firstName: "Alex",
      lastName: "Rivera",
      email: "alex.rivera@example.com",
      location: "San Diego, CA"
    },
    country: "United States"
  };

  const field: LeverFieldSchema = {
    fieldId: "cards[relocation][field0]",
    label: "Please check all that apply (we offer relocation support including visa sponsorship, housing assistance and more):",
    sectionTitle: "Location Preferences in Europe for Engineers",
    required: true,
    fieldType: "checkbox_group",
    possibleAnswers: ["Berlin", "Cologne", "Karlsruhe", "London", "Munich", "Zurich"],
    currentValue: null,
    selectorHints: { selector: "input" },
    htmlSummary: {}
  };

  const resolved = resolveDeterministicProfileValue(field, profile);
  assert.equal(resolved?.reason, "deterministic_eu_location_preference");
  assert.deepEqual(resolved?.selectedOptions, ["London"]);
});

test("deterministic resolver maps eu citizenship prompt from profile country", () => {
  const profile: CandidateProfile = {
    basics: {
      firstName: "Alex",
      lastName: "Rivera",
      email: "alex.rivera@example.com",
      location: "San Diego, CA"
    },
    country: "United States"
  };

  const field: LeverFieldSchema = {
    fieldId: "cards[eu][field0]",
    label: "Are you a citizen of a country in the EU/EFTA?",
    sectionTitle: "European Employment Eligibility",
    required: true,
    fieldType: "radio",
    possibleAnswers: ["Yes", "No"],
    currentValue: null,
    selectorHints: { selector: "input" },
    htmlSummary: {}
  };

  const resolved = resolveDeterministicProfileValue(field, profile);
  assert.equal(resolved?.reason, "deterministic_eu_efta_citizenship");
  assert.equal(resolved?.answer, "No");
});

test("deterministic resolver does not misclassify narrative textarea as phone field", () => {
  const profile: CandidateProfile = {
    basics: {
      firstName: "Alex",
      lastName: "Rivera",
      email: "alex.rivera@example.com",
      phone: "619-289-5672",
      location: "San Diego, CA"
    }
  };

  const narrativeField: LeverFieldSchema = {
    fieldId: "cards[proud][field0]",
    label: "Tell us one thing that is not on your resume that you are proud of.",
    sectionTitle: "Additional Questions",
    required: true,
    fieldType: "textarea",
    possibleAnswers: [],
    currentValue: null,
    selectorHints: { selector: "textarea" },
    htmlSummary: {}
  };

  const phoneField: LeverFieldSchema = {
    fieldId: "phone",
    label: "Phone",
    sectionTitle: "Contact",
    required: true,
    fieldType: "text",
    possibleAnswers: [],
    currentValue: null,
    selectorHints: { selector: "input" },
    htmlSummary: {}
  };

  const narrativeResolved = resolveDeterministicProfileValue(narrativeField, profile);
  assert.equal(narrativeResolved, null);

  const phoneResolved = resolveDeterministicProfileValue(phoneField, profile);
  assert.equal(phoneResolved?.answer, "619-289-5672");
  assert.equal(phoneResolved?.reason, "profile_phone");
});

test("missing-required rediscovery discovers required custom field by hidden cards field key", async () => {
  const adapter = new LeverAdapter() as unknown as {
    discoverMissingRequiredFields: (page: unknown, schema: LeverFieldSchema[]) => Promise<LeverFieldSchema[]>;
    extractLeverSchema: (page: unknown) => Promise<LeverFieldSchema[]>;
  };

  const schema: LeverFieldSchema[] = [
    {
      fieldId: "name",
      label: "Full name",
      sectionTitle: "Application",
      required: true,
      fieldType: "text",
      possibleAnswers: [],
      currentValue: null,
      selectorHints: { selector: "input[name='name']", name: "name" },
      htmlSummary: {}
    }
  ];
  const discoveredField: LeverFieldSchema = {
    fieldId: "cards[ffb54801-b863-4ec5-973f-f86f8ebbf4c3][field0]",
    label: "Are you able to work on-site?",
    sectionTitle: "Application",
    required: true,
    fieldType: "select",
    fieldKind: "custom_select",
    possibleAnswers: ["Yes", "No"],
    currentValue: null,
    selectorHints: {
      selector: "input[name=\"cards[ffb54801-b863-4ec5-973f-f86f8ebbf4c3][field0]\"]",
      name: "cards[ffb54801-b863-4ec5-973f-f86f8ebbf4c3][field0]",
      containerSelector: "li.application-question",
      customTriggerSelector: "[role='combobox']",
      customOptionSelector: "[role='option']"
    },
    htmlSummary: { extractionSource: "required_container_fallback" }
  };
  adapter.extractLeverSchema = async () => [schema[0]!, discoveredField];

  const page = {
    evaluate: async () => ["cards[ffb54801-b863-4ec5-973f-f86f8ebbf4c3][field0]"]
  };

  const discovered = await adapter.discoverMissingRequiredFields(page, schema);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.fieldId, "cards[ffb54801-b863-4ec5-973f-f86f8ebbf4c3][field0]");
  assert.equal(discovered[0]?.fieldKind, "custom_select");
});
