import type { BatchProviderInput } from "../types.js";

export interface PlatformBatchResolver {
  platform: string;
  rules(input: BatchProviderInput): string[];
}

