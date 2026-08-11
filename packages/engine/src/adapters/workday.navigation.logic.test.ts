import test from "node:test";
import assert from "node:assert/strict";
import { classifyFooterButton, nextStepMarkersFor } from "./workday/navigation.js";

function makePageWithFooter(text: string | null) {
  return {
    locator: () => ({
      first: () => ({
        isVisible: async () => text !== null,
        innerText: async () => text ?? ""
      })
    })
  } as any;
}

test("classifyFooterButton detects continue-like labels", async () => {
  const saveAndContinue = await classifyFooterButton(makePageWithFooter("Save and Continue"));
  assert.equal(saveAndContinue.kind, "continue");
  assert.equal(saveAndContinue.text, "save and continue");

  const next = await classifyFooterButton(makePageWithFooter("Next"));
  assert.equal(next.kind, "continue");
});

test("classifyFooterButton detects submit labels", async () => {
  const submit = await classifyFooterButton(makePageWithFooter("Submit Application"));
  assert.equal(submit.kind, "submit");
  assert.equal(submit.text, "submit application");
});

test("classifyFooterButton returns none when footer button is absent", async () => {
  const absent = await classifyFooterButton(makePageWithFooter(null));
  assert.equal(absent.kind, "none");
  assert.equal(absent.text, "");
});

test("deterministic transition map markers are defined for supported steps", () => {
  assert.equal(nextStepMarkersFor("contact_information").includes("div[data-automation-id='myExperiencePage']"), true);
  assert.equal(nextStepMarkersFor("my_experience").includes("div[data-automation-id='applyFlowPrimaryQuestionsPage']"), true);
  assert.equal(nextStepMarkersFor("application_questions").includes("div[data-automation-id='voluntaryDisclosuresPage']"), true);
  assert.equal(nextStepMarkersFor("application_questions").includes("h2:has-text('Voluntary Disclosures')"), true);
  assert.equal(nextStepMarkersFor("voluntary_disclosures").includes("div[data-automation-id='selfIdentificationPage']"), true);
  assert.equal(nextStepMarkersFor("voluntary_disclosures").includes("h2:has-text('Self Identify')"), true);
  assert.equal(nextStepMarkersFor("self_identification").length > 0, true);
});
