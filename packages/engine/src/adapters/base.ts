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

  /**
   * Ticks a radio or checkbox that the page may have hidden.
   *
   * Greenhouse renders its choice inputs as a visually hidden input with a
   * styled label on top. Playwright refuses to check something it considers
   * invisible, and both check() and click() then wait the full default timeout
   * before failing -- measured at 120 seconds per field on a live posting,
   * because the caller retries once. The label is the thing a person actually
   * clicks, so try that first, and only then fall back to setting the property
   * directly with the events React listens for.
   */
  protected async toggleChoiceInput(
    page: AdapterRunContext["page"],
    target: ReturnType<AdapterRunContext["page"]["locator"]>,
    inputId: string,
    isCheckbox: boolean
  ): Promise<boolean> {
    const isChecked = async (): Promise<boolean> => target.isChecked().catch(() => false);
    if (await isChecked()) return true;

    if (isCheckbox) {
      await target.check({ timeout: 2500 }).catch(() => undefined);
    } else {
      await target.click({ timeout: 2500 }).catch(() => undefined);
    }
    if (await isChecked()) return true;

    if (inputId) {
      const label = page.locator(`label[for=${JSON.stringify(inputId)}]`).first();
      if (await label.count().catch(() => 0)) {
        await label.click({ timeout: 2500 }).catch(() => undefined);
        if (await isChecked()) return true;
      }
    }

    await target.click({ force: true, timeout: 2500 }).catch(() => undefined);
    if (await isChecked()) return true;

    // Last resort: React only believes a change it hears about.
    const applied = await target
      .evaluate((element) => {
        const input = element as HTMLInputElement;
        if (input.checked) return true;
        input.checked = true;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return input.checked;
      })
      .catch(() => false);
    return applied && (await isChecked());
  }

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
