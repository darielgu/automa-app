import type { BatchProviderInput } from "../types.js";
import type { PlatformBatchResolver } from "./types.js";

export const genericBatchResolver: PlatformBatchResolver = {
  platform: "generic",
  rules(_input: BatchProviderInput): string[] {
    return [
      "For required non-credential questions, provide a best-effort professional answer from available context instead of null.",
      "Return null only when answering would require inventing credentials/facts."
    ];
  }
};

