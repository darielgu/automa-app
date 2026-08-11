import type { BatchProviderInput } from "../types.js";
import type { PlatformBatchResolver } from "./types.js";

export const leverBatchResolver: PlatformBatchResolver = {
  platform: "lever",
  rules(_input: BatchProviderInput): string[] {
    return [
      "For required free-text questions (type=text or type=textarea) with no options, NEVER return null/empty.",
      "For required free-text, return a concise best-effort answer grounded in candidateProfile/resumeText/customAnswers.",
      "If question.required=true and question type is free-text, null is disallowed unless answering would require fabricating restricted credentials."
    ];
  }
};

