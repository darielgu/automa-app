import path from "node:path";
import { BaseAdapter } from "./base.js";
import type { AdapterRunContext } from "../core/types.js";

const INACTIVE_POSTING_TEXT_PATTERNS = [
  "job not found",
  "posting not found",
  "this job has expired",
  "no longer accepting applications",
  "position has been filled"
];

const BOT_CHALLENGE_PATTERNS = [
  "captcha",
  "recaptcha",
  "hcaptcha",
  "turnstile",
  "verify you are human",
  "security check",
  "robot"
];

const SUCCESS_PATTERNS = [
  "application sent",
  "message sent",
  "thanks for applying",
  "thank you for applying",
  "we'll be in touch",
  "we will be in touch",
  "application received"
];

const VALIDATION_PATTERNS = ["please write at least 50 characters", "please write at least"];

interface SubmissionObservation {
  bodyText: string;
  modalOpen: boolean;
  hasValidationError: boolean;
  hasBotChallenge: boolean;
}

export function waasExtractHiringManagerAndCompany(text: string): { hiringManager?: string; company?: string } {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match = normalized.match(/reach out to\s+(.+?)\s+at\s+(.+)$/i);
  if (!match) return {};

  const hiringManager = match[1]?.trim();
  const company = match[2]?.trim();
  return {
    hiringManager: hiringManager || undefined,
    company: company || undefined
  };
}

export function waasClassifySubmissionObservation(
  observation: SubmissionObservation
): { outcome: "confirmed" | "validation_error" | "blocked_bot_challenge" | "pending_confirmation"; confirmed: boolean } {
  const lowered = observation.bodyText.toLowerCase();
  if (observation.hasBotChallenge || BOT_CHALLENGE_PATTERNS.some((token) => lowered.includes(token))) {
    return { outcome: "blocked_bot_challenge", confirmed: false };
  }

  if (observation.hasValidationError || VALIDATION_PATTERNS.some((token) => lowered.includes(token))) {
    return { outcome: "validation_error", confirmed: false };
  }

  if (!observation.modalOpen || SUCCESS_PATTERNS.some((token) => lowered.includes(token))) {
    return { outcome: "confirmed", confirmed: true };
  }

  return { outcome: "pending_confirmation", confirmed: false };
}

export function ensureMinimumFounderMessage(
  text: string,
  profileName: string,
  minimumLength = 50
): string {
  const trimmed = text.trim();
  if (trimmed.length >= minimumLength) return trimmed;
  const suffix = ` I am ready to contribute immediately and would value the opportunity to build with your team.`;
  const prefixed = trimmed || `Hi - I am ${profileName} and I am excited about this opportunity.`;
  const expanded = `${prefixed}${suffix}`.replace(/\s+/g, " ").trim();
  return expanded.length >= minimumLength ? expanded : expanded.padEnd(minimumLength + 1, ".");
}

function includesAnyPattern(text: string, patterns: string[]): boolean {
  const lowered = text.toLowerCase();
  return patterns.some((pattern) => lowered.includes(pattern));
}

export function waasExtractCompanyDirectionContext(text: string, company?: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 40 && line.length <= 220);

  if (!lines.length) return undefined;

  const companyToken = company?.trim() ? company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
  const companyRegex = companyToken ? new RegExp(`\\b${companyToken}\\b`, "i") : null;
  const directionRegex =
    /(mission|platform|infrastructure|developers|developer|product|foundational|next generation|ai agents|scale|customers|autonomous)/i;
  const skipRegex = /(privacy|terms|contact|save|view job|my profile|jobs by|remote jobs|internships|events)/i;

  const scored = lines
    .map((line, index) => {
      if (skipRegex.test(line)) return null;

      let score = 0;
      if (directionRegex.test(line)) score += 2;
      if (companyRegex?.test(line)) score += 1;
      if (line.length >= 60 && line.length <= 170) score += 1;
      if (score === 0) return null;

      return { line, score, index };
    })
    .filter((entry): entry is { line: string; score: number; index: number } => Boolean(entry))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));

  if (!scored.length) return undefined;

  const selected: string[] = [];
  const seen = new Set<string>();
  for (const item of scored) {
    const normalized = item.line.toLowerCase();
    if (seen.has(normalized)) continue;
    selected.push(item.line);
    seen.add(normalized);
    if (selected.length >= 3) break;
  }

  const context = selected.join(" ").replace(/\s+/g, " ").trim();
  if (!context) return undefined;
  return context.length > 420 ? `${context.slice(0, 417).trim()}...` : context;
}

export class WorkAtAStartupAdapter extends BaseAdapter {
  readonly platform = "workatastartup" as const;

  canHandle(url: string): boolean {
    const normalized = url.toLowerCase();
    return normalized.includes("workatastartup.com") || normalized.includes("workatastartup-demo.html");
  }

  async apply(context: AdapterRunContext) {
    const { page, target, config, profile, resumeText } = context;
    const result = this.baseResult(context);
    result.startedAt = new Date().toISOString();

    try {
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });
      await page.waitForTimeout(800);

      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (includesAnyPattern(bodyText, INACTIVE_POSTING_TEXT_PATTERNS)) {
        result.status = "skipped";
        result.submitOutcome = "inactive_posting";
        result.notes.push("Inactive Work at a Startup posting detected.");
        return result;
      }

      const jobHeaderText = await page.locator("h1").first().innerText().catch(() => "");
      if (!result.jobTitle && jobHeaderText.trim()) {
        result.jobTitle = jobHeaderText.trim();
      }

      await this.clickApply(page);

      const modal = page
        .locator("[id^='headlessui-dialog-panel']:visible, [role='dialog']:visible")
        .filter({ hasText: "Reach out to" })
        .first();
      await modal.waitFor({ state: "visible", timeout: 12_000 });

      const managerRow = await modal.locator("div").first().innerText().catch(() => "");
      const managerInfo = waasExtractHiringManagerAndCompany(managerRow);
      if (managerInfo.company && !result.company) {
        result.company = managerInfo.company;
      }

      const companyContext = waasExtractCompanyDirectionContext(bodyText, result.company);
      if (companyContext) {
        result.notes.push("Founder message grounded with company page context.");
      }

      const textarea = modal.locator("textarea").first();
      await textarea.waitFor({ state: "visible", timeout: 6_000 });

      const fullName = profile.basics.fullName?.trim() || `${profile.basics.firstName} ${profile.basics.lastName}`.trim();
      const founderMessage = await context.aiEngine.generateFounderMessage({
        profile,
        resumeText,
        jobTitle: result.jobTitle,
        company: result.company,
        hiringManager: managerInfo.hiringManager,
        companyContext
      });
      const finalMessage = ensureMinimumFounderMessage(founderMessage.text, fullName, 50);

      await textarea.fill(finalMessage);
      result.filledFields.push({
        id: "founder_message",
        label: "Founder outreach message",
        value: finalMessage,
        source: founderMessage.source,
        inputKind: "textarea"
      });
      result.notes.push(`Founder message generated via ${founderMessage.source}.`);
      result.status = "filled";
      result.submitOutcome = "not_submitted";

      if (config.mode === "auto-submit") {
        const sendButton = modal.getByRole("button", { name: /^send$/i }).first();
        await sendButton.waitFor({ state: "visible", timeout: 8_000 });

        const disabled = await sendButton.isDisabled().catch(() => false);
        if (disabled) {
          result.submitOutcome = "validation_error";
          result.notes.push("Send button stayed disabled after message fill.");
          return result;
        }

        await sendButton.click();
        result.submitted = true;
        result.status = "applied";
        result.submitOutcome = "pending_confirmation";

        const submission = await this.waitForSubmissionObservation(page, modal);
        const classified = waasClassifySubmissionObservation(submission);

        result.submissionConfirmed = classified.confirmed;
        result.submitOutcome = classified.outcome;

        if (classified.outcome === "confirmed") {
          result.notes.push("Submission confirmed by modal close or success marker.");
        } else if (classified.outcome === "validation_error") {
          result.submitted = false;
          result.status = "filled";
          result.notes.push("Validation error detected after submit.");
        } else if (classified.outcome === "blocked_bot_challenge") {
          result.notes.push("Bot challenge detected after submit.");
        } else {
          result.notes.push("Submit clicked but confirmation marker was not detected.");
        }
      }
    } catch (error) {
      result.status = "failed";
      result.submitOutcome = "not_submitted";
      result.error = error instanceof Error ? error.stack ?? error.message : String(error);
    } finally {
      const screenshotPath = path.join(config.screenshotsDir, `workatastartup-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      result.screenshotPaths.push(screenshotPath);
      result.finishedAt = new Date().toISOString();
    }

    return result;
  }

  private async clickApply(page: AdapterRunContext["page"]): Promise<void> {
    const candidates = [
      page.getByRole("button", { name: /^apply$/i }).first(),
      page.getByRole("link", { name: /^apply$/i }).first(),
      page.getByRole("button", { name: /apply/i }).first(),
      page.getByRole("link", { name: /apply/i }).first(),
      page.locator("a:has-text('Apply')").first(),
      page.locator("button:has-text('Apply')").first()
    ];

    for (const candidate of candidates) {
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;
      await candidate.click().catch(() => undefined);
      await page.waitForTimeout(400);

      // A synthesised mouse click is delivered by coordinates and hit-testing,
      // which does not reach a browser view running in the background — the way
      // the desktop app runs automations while you work. If the click did not
      // take, dispatch one on the element itself, which does not depend on
      // pointer position or focus.
      const opened = await page
        .locator("[role='dialog']:visible, textarea:visible")
        .first()
        .isVisible()
        .catch(() => false);
      if (!opened) {
        await candidate.evaluate((node) => (node as HTMLElement).click()).catch(() => undefined);
        await page.waitForTimeout(400);
      }
      return;
    }

    throw new Error("Work at a Startup Apply button not found.");
  }

  private async waitForSubmissionObservation(
    page: AdapterRunContext["page"],
    modal: import("playwright-core").Locator
  ): Promise<SubmissionObservation> {
    const deadline = Date.now() + 20_000;
    let latest: SubmissionObservation = {
      bodyText: "",
      modalOpen: true,
      hasValidationError: false,
      hasBotChallenge: false
    };

    while (Date.now() < deadline) {
      const bodyText = await page.locator("body").innerText().then((text) => text.slice(0, 10000)).catch(() => "");
      const modalOpen = await modal.isVisible().catch(() => false);
      const validationText = await modal.locator("text=/please write at least/i").first().isVisible().catch(() => false);
      const botVisible = BOT_CHALLENGE_PATTERNS.some((pattern) => bodyText.toLowerCase().includes(pattern));

      latest = {
        bodyText,
        modalOpen,
        hasValidationError: validationText,
        hasBotChallenge: botVisible
      };

      const classified = waasClassifySubmissionObservation(latest);
      if (classified.outcome !== "pending_confirmation") {
        return latest;
      }

      await page.waitForTimeout(750);
    }

    return latest;
  }
}
