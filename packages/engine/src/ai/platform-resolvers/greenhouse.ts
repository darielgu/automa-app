import type { BatchProviderInput } from "../types.js";
import type { PlatformBatchResolver } from "./types.js";

export const greenhouseBatchResolver: PlatformBatchResolver = {
  platform: "greenhouse",
  rules(_input: BatchProviderInput): string[] {
    return [
      "For constrained choice questions, return one of the visible options exactly.",
      "Do not output free-form text when a select/radio/checkbox option list is provided."
    ];
  }
};

