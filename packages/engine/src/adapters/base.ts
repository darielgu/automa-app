import type { AdapterRunContext, JobRunResult, Platform } from "../core/types.js";

export interface JobPlatformAdapter {
  readonly platform: Platform;
  canHandle(url: string): boolean;
  apply(context: AdapterRunContext): Promise<JobRunResult>;
}

export abstract class BaseAdapter implements JobPlatformAdapter {
  abstract readonly platform: Platform;

  abstract canHandle(url: string): boolean;

  abstract apply(context: AdapterRunContext): Promise<JobRunResult>;

  protected baseResult(context: AdapterRunContext): JobRunResult {
    const now = new Date().toISOString();
    return {
      url: context.target.url,
      platform: this.platform,
      status: "skipped",
      submitted: false,
      submissionConfirmed: false,
      submitOutcome: "not_submitted",
      dryRun: context.config.mode === "dry-run",
      jobTitle: context.target.jobTitle,
      company: context.target.company,
      notes: [],
      answers: [],
      filledFields: [],
      llmEvents: [],
      screenshotPaths: [],
      startedAt: now,
      finishedAt: now
    };
  }
}
