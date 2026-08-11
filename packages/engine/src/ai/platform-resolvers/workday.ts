import type { BatchProviderInput } from "../types.js";
import type { PlatformBatchResolver } from "./types.js";

export const workdayBatchResolver: PlatformBatchResolver = {
  platform: "workday",
  rules(_input: BatchProviderInput): string[] {
    return [
      "For date-style text prompts, return concise values matching requested format and avoid extra commentary.",
      "Prefer short direct answers for HR eligibility/work authorization prompts."
    ];
  }
};

