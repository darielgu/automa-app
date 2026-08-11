import assert from "node:assert/strict";
import test from "node:test";
import { AnswerEngine } from "./engine.js";
import type { AIConfig, AnswerValue, ApplicationQuestion, CandidateProfile } from "../core/types.js";
import type { BatchProviderInput, FounderMessageInput, FounderMessageOutput } from "./types.js";

const baseProfile: CandidateProfile = {
  basics: {
    firstName: "Alex",
    lastName: "Rivera",
    email: "alex.rivera@example.com"
  }
};

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

class StubProvider {
  private readonly handler: (input: BatchProviderInput, callCount: number) => Record<string, AnswerValue>;
  callCount = 0;

  constructor(handler: (input: BatchProviderInput, callCount: number) => Record<string, AnswerValue>) {
    this.handler = handler;
  }

  async answerBatch(input: BatchProviderInput): Promise<Record<string, AnswerValue>> {
    this.callCount += 1;
    return this.handler(input, this.callCount);
  }

  async generateFounderMessage(_input: FounderMessageInput): Promise<FounderMessageOutput> {
    return { text: "stub" };
  }
}

function createEngine(): AnswerEngine {
  const config: AIConfig = {
    provider: "none",
    model: "stub"
  };
  return new AnswerEngine(config, logger as any);
}

test("ashby contract rejects narrative boolean literal", async () => {
  const engine = createEngine();
  const provider = new StubProvider(() => ({ q1: "Yes" }));
  (engine as any).provider = provider;

  const questions: ApplicationQuestion[] = [
    {
      id: "q1",
      label: "Why are you interested in this role?",
      type: "textarea",
      required: true
    }
  ];
  const answers = await engine.resolve(questions, {
    profile: baseProfile,
    resumeText: "resume",
    platform: "ashby"
  });

  assert.equal(provider.callCount, 2);
  assert.equal(answers[0]?.value, null);
});

test("ashby contract enforces required narrative minimum 120 chars", async () => {
  const engine = createEngine();
  const provider = new StubProvider((_input, callCount) =>
    callCount === 1
      ? { q1: "I am interested in the role because I enjoy impact and teamwork." }
      : {
          q1: "I am interested in this role because it combines ownership, technical rigor, and measurable customer impact. I have shipped TypeScript automation systems end to end and want to contribute that same execution discipline here."
        }
  );
  (engine as any).provider = provider;

  const questions: ApplicationQuestion[] = [
    {
      id: "q1",
      label: "Tell us why you are interested in this role and company",
      type: "textarea",
      required: true
    }
  ];
  const answers = await engine.resolve(questions, {
    profile: baseProfile,
    resumeText: "resume",
    platform: "ashby"
  });

  assert.equal(provider.callCount, 2);
  const value = String(answers[0]?.value ?? "");
  assert.ok(value.length >= 120);
});

test("non-ashby answer resolution does not apply ashby contract filtering", async () => {
  const engine = createEngine();
  const provider = new StubProvider(() => ({ q1: "Not In Options" }));
  (engine as any).provider = provider;

  const questions: ApplicationQuestion[] = [
    {
      id: "q1",
      label: "Preferred language",
      type: "single_select",
      required: true,
      options: ["TypeScript", "Python"]
    }
  ];
  const answers = await engine.resolve(questions, {
    profile: baseProfile,
    resumeText: "resume",
    platform: "greenhouse"
  });

  assert.equal(answers[0]?.value, "Not In Options");
  assert.equal(answers[0]?.source, "llm");
});
