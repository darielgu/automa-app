import test from "node:test";
import assert from "node:assert/strict";
import { buildBatchPrompt } from "./providers.js";
import type { BatchProviderInput } from "./types.js";

test("buildBatchPrompt includes companyContext in payload", () => {
  const input: BatchProviderInput = {
    context: {
      profile: {
        basics: {
          firstName: "Alex",
          lastName: "Rivera",
          email: "alex.rivera@example.com"
        }
      },
      resumeText: "resume",
      company: "Omnea",
      jobTitle: "Software Engineer",
      companyContext: "Omnea builds AI procurement workflows for operations teams.",
      platform: "lever"
    },
    questions: [
      {
        id: "q1",
        label: "From what you can find online, outline your understanding of Omnea",
        type: "textarea",
        required: true
      }
    ]
  };

  const prompt = buildBatchPrompt(input);
  assert.match(prompt, /companyContext/);
  assert.match(prompt, /AI procurement workflows/i);
});

test("buildBatchPrompt applies platform-specific resolver rules", () => {
  const leverInput: BatchProviderInput = {
    context: {
      profile: {
        basics: {
          firstName: "Alex",
          lastName: "Rivera",
          email: "alex.rivera@example.com"
        }
      },
      resumeText: "resume",
      platform: "lever"
    },
    questions: [
      {
        id: "q1",
        label: "What season are you looking for an Internship?",
        type: "textarea",
        required: true
      }
    ]
  };
  const greenhouseInput: BatchProviderInput = {
    ...leverInput,
    context: {
      ...leverInput.context,
      platform: "greenhouse"
    }
  };

  const leverPrompt = buildBatchPrompt(leverInput);
  const greenhousePrompt = buildBatchPrompt(greenhouseInput);

  assert.match(leverPrompt, /NEVER return null\/empty/i);
  assert.match(greenhousePrompt, /visible options exactly/i);
});
