import type { BatchProviderInput } from "../types.js";
import type { PlatformBatchResolver } from "./types.js";

export const ashbyBatchResolver: PlatformBatchResolver = {
  platform: "ashby",
  rules(_input: BatchProviderInput): string[] {
    return [
      "For strict option workflows, return exactly the option text shown in allowedOptions/optionHints.",
      "If expectedOutput is provided, satisfy it exactly and prefer deterministic, non-verbose outputs."
    ];
  }
};

