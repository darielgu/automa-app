import path from "node:path";
import { BaseAdapter } from "./base.js";
import { buildQuestionMap, extractVisibleFields, fillField, indexAnswersByQuestion } from "../browser/form-helper.js";
import type { AdapterRunContext } from "../core/types.js";

export class GenericAdapter extends BaseAdapter {
  readonly platform = "generic" as const;

  canHandle(url: string): boolean {
    return url.startsWith("http://") || url.startsWith("https://");
  }

  /**
   * Waits for a form to exist before deciding there is not one.
   *
   * Counts real inputs rather than any element: a careers page carries a search
   * box and a cookie banner long before the application form renders, and
   * treating those as "the form is here" is how this adapter used to conclude
   * a page had nothing on it.
   */
  private async waitForAnyFormFields(page: AdapterRunContext["page"], timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const count = await page
        .evaluate(() =>
          Array.from(
            document.querySelectorAll("input, textarea, select")
          ).filter((node) => {
            const element = node as HTMLInputElement;
            const type = (element.getAttribute("type") || "").toLowerCase();
            if (["hidden", "submit", "button", "search"].includes(type)) return false;
            const style = window.getComputedStyle(element);
            return style.display !== "none" && style.visibility !== "hidden";
          }).length
        )
        .catch(() => 0);
      if (count >= 3) return true;
      await page.waitForTimeout(300).catch(() => undefined);
    }
    return false;
  }

  async apply(context: AdapterRunContext) {
    const { page, target, config } = context;
    const result = this.baseResult(context);
    result.startedAt = new Date().toISOString();

    try {
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });

      // A second was never going to be enough. Most application forms behind a
      // careers URL are client-rendered: measured on live Workable postings,
      // the form has 23 inputs once React has run and none before it. Waiting
      // for fields to exist is the difference between filling a form and
      // reporting that there was nothing there.
      const started = Date.now();
      const mark = (phase: string, extra: Record<string, unknown> = {}) =>
        context.logger.info("generic_phase", { phase, elapsedMs: Date.now() - started, ...extra });

      await this.waitForAnyFormFields(page, 15000);
      mark("form_ready");

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
      mark("fields_extracted", { fieldCount: fields.length });
      const questions = buildQuestionMap(fields);
      const answers = await context.aiEngine.resolve(questions, {
        profile: context.profile,
        resumeText: context.resumeText,
        jobTitle: result.jobTitle,
        company: result.company
      });

      mark("answers_resolved", { answerCount: answers.length });
      let byId = indexAnswersByQuestion(answers);

      // Second pass for anything the label could not answer.
      //
      // Application forms are localised; the input names are not. A live
      // Workable posting labels its fields "Prenom" and "Nom de famille" while
      // naming the inputs firstname and lastname, so matching on the visible
      // label alone missed the applicant's name entirely and filled only the
      // fields whose labels happened to be English. The name is already carried
      // in the field id, so ask again using that, and keep the original label
      // for the receipt so the user still reads what the form actually said.
      const unanswered = fields.filter((field) => {
        const existing = byId.get(field.id);
        return !existing || existing.value === null;
      });
      if (unanswered.length) {
        const byNameQuestions = unanswered.map((field) => ({
          ...field,
          label: field.id.replace(/^field_\d+_/, "").replace(/[_-]+/g, " ").trim() || field.label
        }));
        const nameAnswers = await context.aiEngine
          .resolve(byNameQuestions, {
            profile: context.profile,
            resumeText: context.resumeText,
            jobTitle: result.jobTitle,
            company: result.company
          })
          .catch(() => []);
        const merged = [...answers];
        for (const answer of nameAnswers) {
          if (answer.value === null || answer.value === undefined) continue;
          if (merged.some((existing) => existing.questionId === answer.questionId && existing.value !== null)) continue;
          merged.push(answer);
        }
        answers.length = 0;
        answers.push(...merged);
        byId = indexAnswersByQuestion(answers);
      }

      mark("second_pass_done");
      for (const field of fields) {
        const answer = byId.get(field.id);
        if (!answer || answer.value === null) continue;
        const fieldStarted = Date.now();
        const filled = await fillField(page, field, answer.value).catch(() => false);
        // Per-field timing, because the whole adapter used to be one silent
        // twelve-minute gap between job_start and job_done.
        context.logger.info("generic_field_filled", {
          id: field.id,
          ms: Date.now() - fieldStarted,
          filled
        });
        // Without this the adapter filled fields and told nobody: filledFields
        // stayed empty, so the run's receipt showed no work and every audit of
        // it read as zero fields regardless of what actually went into the form.
        if (filled) {
          result.filledFields.push({
            id: field.id,
            label: field.label || field.id,
            value: String(answer.value),
            source: answer.source === "llm" ? "llm" : "profile",
            inputKind: field.type
          });
        }
      }

      result.answers = answers;
      result.status = result.filledFields.length ? "filled" : "failed";
      mark("fill_done", { filled: result.filledFields.length });
      result.notes.push(`generic_fields_detected:${fields.length}`);
      result.notes.push(`generic_fields_filled:${result.filledFields.length}`);
      if (!result.filledFields.length) {
        result.notes.push("No application fields were found on this page.");
      }

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
