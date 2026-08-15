import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateProfile } from "../core/types.js";
import { resolveDeterministicProfileValue, validateAndRepairOption, type LeverFieldSchema, type LeverFieldType } from "./lever.js";

const profile: CandidateProfile = {
  basics: {
    firstName: "Alex",
    lastName: "Rivera",
    email: "alex-riverarivera332@gmail.com",
    phone: "619-289-5672"
  },
  country: "United States",
  workAuthorization: {
    authorizedToWork: true,
    requiresSponsorship: false,
    usCitizen: true
  }
};

function field(label: string, fieldType: LeverFieldType, possibleAnswers: string[] = []): LeverFieldSchema {
  return {
    fieldId: `cards[test][${label.slice(0, 12)}]`,
    label,
    sectionTitle: "Additional Information",
    required: true,
    fieldType,
    possibleAnswers,
    currentValue: null,
    selectorHints: {},
    htmlSummary: {}
  };
}

test("name and email fields keep their deterministic answers", () => {
  const first = resolveDeterministicProfileValue(field("First Name✱", "text"), profile);
  assert.equal(first?.answer, "Alex");
  assert.equal(first?.reason, "profile_first_name");

  const email = resolveDeterministicProfileValue(field("Email✱", "email"), profile);
  assert.equal(email?.answer, "alex-riverarivera332@gmail.com");
  assert.equal(email?.reason, "profile_email");
});

test("a yes/no export-control question still answers deterministically", () => {
  const result = resolveDeterministicProfileValue(
    field("Are you a U.S. Person as defined under export control regulations?", "radio", ["Yes", "No"]),
    profile
  );
  assert.equal(result?.answer, "Yes");
  assert.equal(result?.reason, "profile_export_control");
});

test("a citizenship-status list is released to the shared rules engine", () => {
  // Observed live (Anduril, Istari): the export-control branch coerced these
  // to Yes/No, matched nothing, and locked an empty plan. The field then
  // never reached the rules engine, which knows how to pick a status option.
  const longList = resolveDeterministicProfileValue(
    field("Please confirm your export control status. Are you a U.S. Person?", "select", [
      "U.S. Citizen or National",
      "U.S. Lawful Permanent Resident",
      "Person granted Refugee status in the United States",
      "None of the above"
    ]),
    profile
  );
  assert.equal(longList, null);

  const unrepairableYesNo = resolveDeterministicProfileValue(
    field("Are you a U.S. Person under export control rules?", "select", [
      "I am a U.S. Person",
      "I am not a U.S. Person"
    ]),
    profile
  );
  assert.equal(unrepairableYesNo, null);
});

test("a checkbox group keeps a single string answer as a one-item selection", () => {
  // planAnswers turns a string answer into selectedOptions before repair;
  // this locks the repair-layer behavior that made that fix necessary.
  const dropped = validateAndRepairOption("checkbox_group", ["I am a US Citizen", "None of these apply to me"], "I am a US Citizen", []);
  assert.equal(dropped.selectedOptions.length, 0);

  const kept = validateAndRepairOption(
    "checkbox_group",
    ["I am a US Citizen", "None of these apply to me"],
    "I am a US Citizen",
    ["I am a US Citizen"]
  );
  assert.deepEqual(kept.selectedOptions, ["I am a US Citizen"]);
});
