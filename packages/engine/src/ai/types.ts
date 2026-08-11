import type { AnswerValue, ApplicationQuestion, CandidateProfile, ResolvedAnswer } from "../core/types.js";

export interface AnswerContext {
  profile: CandidateProfile;
  resumeText: string;
  jobTitle?: string;
  company?: string;
  companyContext?: string;
  platform?: string;
}

export interface BatchPromptQuestion {
  id: string;
  label: string;
  type: ApplicationQuestion["type"];
  required: boolean;
  options?: string[];
  optionHints?: string[];
  fieldContext?: string;
  inputKind?: string;
  expectedOutput?: ExpectedOutputSpec;
  retryHint?: string;
}

export interface ExpectedOutputSpec {
  kind: "single_select" | "multi_select" | "boolean" | "email" | "narrative" | "text";
  required: boolean;
  allowedOptions?: string[];
  minChars?: number;
}

export interface BatchProviderInput {
  context: AnswerContext;
  questions: BatchPromptQuestion[];
}

export type BatchProviderOutput = Record<string, AnswerValue>;

export interface FounderMessageInput {
  profile: CandidateProfile;
  resumeText: string;
  jobTitle?: string;
  company?: string;
  hiringManager?: string;
  companyContext?: string;
}

export interface FounderMessageOutput {
  text: string;
}

export interface LlmProvider {
  answerBatch(input: BatchProviderInput): Promise<BatchProviderOutput>;
  generateFounderMessage?(input: FounderMessageInput): Promise<FounderMessageOutput>;
}

export interface RuleEvaluation {
  answer?: AnswerValue;
  source?: ResolvedAnswer["source"];
  reason?: string;
}
