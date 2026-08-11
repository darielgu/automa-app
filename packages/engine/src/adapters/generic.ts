import path from "node:path";
import { BaseAdapter } from "./base.js";
import { buildQuestionMap, extractVisibleFields, fillField, indexAnswersByQuestion } from "../browser/form-helper.js";
import type { AdapterRunContext } from "../core/types.js";

export class GenericAdapter extends BaseAdapter {
  readonly platform = "generic" as const;

  canHandle(url: string): boolean {
    return url.startsWith("http://") || url.startsWith("https://");
  }

  async apply(context: AdapterRunContext) {
    const { page, target, config } = context;
    const result = this.baseResult(context);
    result.startedAt = new Date().toISOString();

    try {
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });
      await page.waitForTimeout(1000);

      const possibleApplyButtons = [
        page.getByRole("button", { name: /apply/i }).first(),
        page.getByRole("link", { name: /apply/i }).first()
      ];

      for (const button of possibleApplyButtons) {
        if (await button.count()) {
          await button.click();
          await page.waitForTimeout(500);
          break;
        }
      }

      const fields = await extractVisibleFields(page);
      const questions = buildQuestionMap(fields);
      const answers = await context.aiEngine.resolve(questions, {
        profile: context.profile,
        resumeText: context.resumeText,
        jobTitle: result.jobTitle,
        company: result.company
      });

      const byId = indexAnswersByQuestion(answers);
      for (const field of fields) {
        const answer = byId.get(field.id);
        if (!answer || answer.value === null) continue;
        await fillField(page, field, answer.value);
      }

      result.answers = answers;
      result.status = "filled";
      result.notes.push("Generic adapter is heuristic and requires per-site selector hardening.");

      if (config.mode === "auto-submit") {
        const submit = page.locator("button[type='submit']").first();
        if (await submit.count()) {
          await submit.click();
          result.submitted = true;
          result.status = "applied";
        }
      }

      const screenshotPath = path.join(config.screenshotsDir, `generic-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      result.screenshotPaths.push(screenshotPath);
    } catch (error) {
      result.status = "failed";
      result.error = error instanceof Error ? error.message : String(error);
    }

    result.finishedAt = new Date().toISOString();
    return result;
  }
}
