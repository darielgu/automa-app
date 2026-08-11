import type { BatchProviderInput } from "../types.js";
import type { PlatformBatchResolver } from "./types.js";
import { ashbyBatchResolver } from "./ashby.js";
import { genericBatchResolver } from "./generic.js";
import { greenhouseBatchResolver } from "./greenhouse.js";
import { leverBatchResolver } from "./lever.js";
import { workdayBatchResolver } from "./workday.js";

const RESOLVERS = new Map<string, PlatformBatchResolver>([
  [genericBatchResolver.platform, genericBatchResolver],
  [leverBatchResolver.platform, leverBatchResolver],
  [ashbyBatchResolver.platform, ashbyBatchResolver],
  [greenhouseBatchResolver.platform, greenhouseBatchResolver],
  [workdayBatchResolver.platform, workdayBatchResolver]
]);

export function resolvePlatformBatchRules(input: BatchProviderInput): string[] {
  const platform = (input.context.platform ?? "generic").trim().toLowerCase();
  const resolver = RESOLVERS.get(platform) ?? genericBatchResolver;
  return resolver.rules(input);
}

