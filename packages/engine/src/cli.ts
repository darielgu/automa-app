import "dotenv/config";
import path from "node:path";
import { runAutomation } from "./runner/orchestrator.js";
import { runProviderLoop, type LoopProvider } from "./runner/provider-loop.js";
import type { AutomationConfig, CandidateProfile, RunMode } from "./core/types.js";
import { readJobUrls, readJsonFile, readTextFile } from "./utils/fs.js";

type CliCommand = "run" | "provider:loop";
const LOOP_PROVIDERS: LoopProvider[] = ["greenhouse", "lever", "workday", "ashby", "workatastartup", "generic"];

interface CliArgs {
  command: CliCommand;
  config: string;
  profile: string;
  url?: string;
  jobsFile?: string;
  mode?: RunMode;
  resumeText?: string;
  headless?: string;
  provider?: LoopProvider;
  goalConfirmedApps?: number;
  maxAttempts?: number;
  maxRetriesPerJob?: number;
  retryDelaySeconds?: number;
  idleDelaySeconds?: number;
  maxIdleCycles?: number;
  stopAfterConsecutiveFailures?: number;
  sessionOutputDir?: string;
}

function parsePositiveInt(value: string | undefined, key: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${key} value "${value}". Expected a positive integer.`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliArgs {
  let command: CliCommand = "run";
  const normalizedArgv = [...argv];

  if (normalizedArgv[0] && !normalizedArgv[0].startsWith("--")) {
    const candidate = normalizedArgv.shift();
    if (candidate === "provider:loop" || candidate === "run") {
      command = candidate;
    } else {
      throw new Error(`Unknown command "${candidate}". Supported commands: run, provider:loop`);
    }
  }

  const parsed: Record<string, string> = {};

  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const arg = normalizedArgv[index];
    if (!arg || !arg.startsWith("--")) continue;

    const key = arg.replace(/^--/, "");
    const nextValue = normalizedArgv[index + 1];
    const value = nextValue && !nextValue.startsWith("--") ? nextValue : "true";
    parsed[key] = value;
  }

  if (!parsed.config || !parsed.profile) {
    throw new Error(
      [
        "Missing required args.",
        "Usage: npm run start -- --config examples/config.example.json --profile examples/profile.example.json --url <job-url>",
        "Or:    npm run start -- --config ... --profile ... --jobs-file examples/jobs.example.txt",
        "Loop:  npm run loop -- --config ... --profile ... --provider greenhouse --jobs-file examples/jobs.example.txt"
      ].join("\n")
    );
  }

  return {
    command,
    config: parsed.config,
    profile: parsed.profile,
    url: parsed.url,
    jobsFile: parsed["jobs-file"],
    mode: parsed.mode as RunMode | undefined,
    resumeText: parsed["resume-text"],
    headless: parsed.headless,
    provider: parsed.provider as LoopProvider | undefined,
    goalConfirmedApps: parsePositiveInt(parsed["goal-confirmed-apps"], "goal-confirmed-apps"),
    maxAttempts: parsePositiveInt(parsed["max-attempts"], "max-attempts"),
    maxRetriesPerJob: parsePositiveInt(parsed["max-retries-per-job"], "max-retries-per-job"),
    retryDelaySeconds: parsePositiveInt(parsed["retry-delay-seconds"], "retry-delay-seconds"),
    idleDelaySeconds: parsePositiveInt(parsed["idle-delay-seconds"], "idle-delay-seconds"),
    maxIdleCycles: parsePositiveInt(parsed["max-idle-cycles"], "max-idle-cycles"),
    stopAfterConsecutiveFailures: parsePositiveInt(
      parsed["stop-after-consecutive-failures"],
      "stop-after-consecutive-failures"
    ),
    sessionOutputDir: parsed["session-output-dir"]
  };
}

function normalizeConfig(config: AutomationConfig, args: CliArgs): AutomationConfig {
  const mode = args.mode ?? config.mode;
  const headless = args.headless ? args.headless !== "false" : config.headless;

  return {
    ...config,
    mode,
    headless,
    outputDir: path.resolve(config.outputDir),
    screenshotsDir: path.resolve(config.screenshotsDir),
    resumePath: config.resumePath ? path.resolve(config.resumePath) : undefined,
    coverLetterPath: config.coverLetterPath ? path.resolve(config.coverLetterPath) : undefined,
    browser: config.browser
      ? {
          ...config.browser,
          userDataDir: config.browser.userDataDir ? path.resolve(config.browser.userDataDir) : config.browser.userDataDir
        }
      : config.browser
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const configFile = path.resolve(args.config);
  const profileFile = path.resolve(args.profile);

  const rawConfig = readJsonFile<AutomationConfig>(configFile);
  const profile = readJsonFile<CandidateProfile>(profileFile);

  const config = normalizeConfig(rawConfig, args);

  const resumeTextPath = args.resumeText
    ? path.resolve(args.resumeText)
    : config.resumePath
      ? path.resolve(config.resumePath)
      : undefined;

  const resumeText = resumeTextPath ? readTextFile(resumeTextPath) : "";

  if (args.command === "provider:loop") {
    if (!args.provider) {
      throw new Error(
        `Missing --provider for provider:loop. Use one of: ${LOOP_PROVIDERS.join(", ")}`
      );
    }
    if (!LOOP_PROVIDERS.includes(args.provider)) {
      throw new Error(`Invalid --provider "${args.provider}". Use one of: ${LOOP_PROVIDERS.join(", ")}`);
    }
    if (!args.jobsFile) {
      throw new Error("Missing --jobs-file for provider:loop.");
    }

    const summary = await runProviderLoop({
      provider: args.provider,
      config,
      profile,
      resumeText,
      jobsFile: path.resolve(args.jobsFile),
      maxAttempts: args.maxAttempts ?? 500,
      goalConfirmedApplications: args.goalConfirmedApps ?? 100,
      maxRetriesPerJob: args.maxRetriesPerJob ?? 3,
      retryDelaySeconds: args.retryDelaySeconds ?? 60,
      idleDelaySeconds: args.idleDelaySeconds ?? 45,
      maxIdleCycles: args.maxIdleCycles ?? 30,
      stopAfterConsecutiveFailures: args.stopAfterConsecutiveFailures ?? 15,
      sessionOutputDir: args.sessionOutputDir ? path.resolve(args.sessionOutputDir) : undefined
    });

    console.log(JSON.stringify({ event: "provider_loop_summary", ...summary }, null, 2));
    return;
  }

  const urls = readJobUrls(args.url, args.jobsFile);
  if (!urls.length) {
    throw new Error("Provide at least one job URL via --url or --jobs-file");
  }

  const targets = urls.map((url) => ({ url }));
  const output = await runAutomation({ config, profile, resumeText, targets });

  console.log(
    JSON.stringify(
      {
        event: "summary",
        total: output.results.length,
        applied: output.results.filter((result) => result.status === "applied").length,
        filled: output.results.filter((result) => result.status === "filled").length,
        failed: output.results.filter((result) => result.status === "failed").length,
        resultsPath: output.resultsPath
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
