import { AshbyAdapter } from "./ashby.js";
import { GenericAdapter } from "./generic.js";
import { GreenhouseAdapter } from "./greenhouse.js";
import { LeverAdapter } from "./lever.js";
import { WorkAtAStartupAdapter } from "./workatastartup.js";
import { WorkdayAdapter } from "./workday.js";
import type { JobPlatformAdapter } from "./base.js";

export function buildAdapters(): JobPlatformAdapter[] {
  return [
    new GreenhouseAdapter(),
    new LeverAdapter(),
    new WorkdayAdapter(),
    new AshbyAdapter(),
    new WorkAtAStartupAdapter(),
    new GenericAdapter()
  ];
}
