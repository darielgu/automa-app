import fs from "node:fs";
import path from "node:path";
import type { AnswerValue, ApplicationQuestion, ResolvedAnswer } from "../core/types.js";
import type { AppLogger } from "../core/logger.js";
import { normalizeAnswerToQuestion } from "./normalize.js";
import { OllamaProvider, OpenAIProvider } from "./providers.js";
import { evaluateDeterministicRule, evaluateProfileMapping, isCredentialQuestion } from "./rules.js";
import type { AnswerContext, BatchPromptQuestion, ExpectedOutputSpec, FounderMessageInput, LlmProvider } from "./types.js";
import type { AIConfig } from "../core/types.js";

export class AnswerEngine {
  private readonly provider: LlmProvider | null;
  private readonly logger: AppLogger;
  private readonly llmTimeoutMs: number;

  constructor(config: AIConfig, logger: AppLogger) {
    this.logger = logger;
    const envTimeout = Number.parseInt(process.env.LLM_TIMEOUT_MS ?? "", 10);
    this.llmTimeoutMs = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 45_000;

    if (config.provider === "openai") {
      try {
        this.provider = new OpenAIProvider(config);
      } catch (error) {
        this.logger.warn("llm_provider_init_failed", {
          provider: "openai",
          error: error instanceof Error ? error.message : String(error)
        });
        this.provider = null;
      }
      return;
    }

    if (config.provider === "ollama") {
      try {
        this.provider = new OllamaProvider(config);
      } catch (error) {
        this.logger.warn("llm_provider_init_failed", {
          provider: "ollama",
          error: error instanceof Error ? error.message : String(error)
        });
        this.provider = null;
      }
      return;
    }

    this.provider = null;
  }

  async resolve(questions: ApplicationQuestion[], context: AnswerContext): Promise<ResolvedAnswer[]> {
    const resolved = new Map<string, ResolvedAnswer>();
    const unresolved: ApplicationQuestion[] = [];
    const ashbyMode = context.platform === "ashby";
    const confirmedAnswerCorpus = ashbyMode ? readConfirmedAnswersCorpus() : [];

    for (const question of questions) {
      if (shouldUseLlmFirstForQuestion(question)) {
        unresolved.push(question);
        continue;
      }

      const deterministic = evaluateDeterministicRule(question, context.profile);
      if (deterministic.answer !== undefined) {
        resolved.set(question.id, {
          questionId: question.id,
          value: normalizeAnswerToQuestion(question, deterministic.answer),
          source: deterministic.source ?? "rule",
          reason: deterministic.reason
        });
        continue;
      }

      const fromProfile = evaluateProfileMapping(question, context.profile);
      if (fromProfile.answer !== undefined) {
        resolved.set(question.id, {
          questionId: question.id,
          value: normalizeAnswerToQuestion(question, fromProfile.answer),
          source: fromProfile.source ?? "profile",
          reason: fromProfile.reason
        });
        continue;
      }

      unresolved.push(question);
    }

    if (unresolved.length && this.provider) {
      this.logger.info("llm_batch_start", {
        unresolvedCount: unresolved.length,
        timeoutMs: this.llmTimeoutMs
      });
      const startedAt = Date.now();
      try {
        const promptQuestions = unresolved.map((question) =>
          this.buildBatchPromptQuestion(question, context, confirmedAnswerCorpus, undefined, ashbyMode)
        );
        const llmRaw = await withTimeout(
          this.provider.answerBatch({
            context,
            questions: promptQuestions
          }),
          this.llmTimeoutMs,
          "llm_batch_timeout"
        );

        const invalids: Array<{ question: ApplicationQuestion; reason: string }> = [];
        for (const question of unresolved) {
          const rawAnswer = readBatchAnswer(llmRaw, question.id, question.label);
          const guarded = this.guardAgainstFabrication(question, rawAnswer);
          const normalized = normalizeAnswerToQuestion(question, guarded);
          if (ashbyMode) {
            const contract = buildExpectedOutputSpec(question);
            const validation = validateAgainstContract(question, normalized, contract);
            if (!validation.valid) {
              invalids.push({ question, reason: validation.reason ?? "contract_violation" });
              continue;
            }
          }
          resolved.set(question.id, {
            questionId: question.id,
            value: normalized,
            source: "llm",
            reason: "llm_batch"
          });
        }

        if (ashbyMode && invalids.length > 0) {
          this.logger.warn("llm_batch_invalid_output", {
            invalidCount: invalids.length,
            sample: invalids.slice(0, 3).map((item) => `${item.question.label}:${item.reason}`)
          });
          const retryQuestions = invalids.map((item) =>
            this.buildBatchPromptQuestion(item.question, context, confirmedAnswerCorpus, item.reason, true)
          );
          const retryRaw = await withTimeout(
            this.provider.answerBatch({
              context,
              questions: retryQuestions
            }),
            this.llmTimeoutMs,
            "llm_batch_retry_timeout"
          );

          for (const item of invalids) {
            const retryValue = readBatchAnswer(retryRaw, item.question.id, item.question.label);
            const guarded = this.guardAgainstFabrication(item.question, retryValue);
            const normalized = normalizeAnswerToQuestion(item.question, guarded);
            const contract = buildExpectedOutputSpec(item.question);
            const validation = validateAgainstContract(item.question, normalized, contract);
            if (!validation.valid) continue;
            resolved.set(item.question.id, {
              questionId: item.question.id,
              value: normalized,
              source: "llm",
              reason: "llm_batch_retry"
            });
          }
        }

        this.logger.info("llm_batch_result", {
          unresolvedCount: unresolved.length,
          answerKeyCount: Object.keys(llmRaw).length,
          nonNullAnswerCount: unresolved.filter((question) => {
            const value = readBatchAnswer(llmRaw, question.id, question.label);
            return value !== null && value !== undefined && value !== "";
          }).length,
          durationMs: Date.now() - startedAt
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "llm_batch_timeout" || message === "llm_batch_retry_timeout") {
          this.logger.warn("llm_batch_timeout", {
            unresolvedCount: unresolved.length,
            timeoutMs: this.llmTimeoutMs,
            durationMs: Date.now() - startedAt
          });
        }
        this.logger.warn("llm_batch_failed", {
          error: message,
          unresolvedCount: unresolved.length,
          durationMs: Date.now() - startedAt
        });
      }
    }

    for (const question of unresolved) {
      if (!resolved.has(question.id)) {
        resolved.set(question.id, {
          questionId: question.id,
          value: null,
          source: "fallback",
          reason: "unresolved_or_model_failure"
        });
      }
    }

    return questions.map((question) => resolved.get(question.id) ?? fallbackAnswer(question.id));
  }

  private buildBatchPromptQuestion(
    question: ApplicationQuestion,
    context: AnswerContext,
    confirmedAnswerCorpus: ConfirmedAnswerRecord[],
    retryHint?: string,
    strictExpectedOutput: boolean = false
  ): BatchPromptQuestion {
    const existingFieldContext =
      typeof question.platformMeta?.fieldContext === "string"
        ? (question.platformMeta.fieldContext as string)
        : "";
    const ragContext = strictExpectedOutput ? buildHybridFieldContext(question, context, confirmedAnswerCorpus) : "";
    return {
      id: question.id,
      label: question.label,
      type: question.type,
      required: question.required,
      options: question.options,
      optionHints: Array.isArray(question.platformMeta?.optionHints)
        ? (question.platformMeta?.optionHints as string[])
        : undefined,
      fieldContext: [existingFieldContext, ragContext].filter(Boolean).join("\n"),
      inputKind:
        typeof question.platformMeta?.inputKind === "string"
          ? (question.platformMeta.inputKind as string)
          : undefined,
      expectedOutput: strictExpectedOutput ? buildExpectedOutputSpec(question) : undefined,
      retryHint: strictExpectedOutput ? retryHint : undefined
    };
  }

  async generateFounderMessage(
    input: FounderMessageInput
  ): Promise<{ text: string; source: "llm" | "fallback"; reason: string }> {
    if (this.provider?.generateFounderMessage) {
      this.logger.info("llm_founder_message_start", {
        timeoutMs: this.llmTimeoutMs
      });
      const startedAt = Date.now();
      try {
        const output = await withTimeout(
          this.provider.generateFounderMessage(input),
          this.llmTimeoutMs,
          "llm_founder_message_timeout"
        );
        const text = output.text.trim();
        if (text) {
          this.logger.info("llm_founder_message_result", {
            durationMs: Date.now() - startedAt
          });
          return {
            text,
            source: "llm",
            reason: "llm_founder_message"
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "llm_founder_message_timeout") {
          this.logger.warn("llm_founder_message_timeout", {
            timeoutMs: this.llmTimeoutMs,
            durationMs: Date.now() - startedAt
          });
        }
        this.logger.warn("llm_founder_message_failed", {
          error: message,
          durationMs: Date.now() - startedAt
        });
      }
    }

    const fullName =
      input.profile.basics.fullName?.trim() ||
      `${input.profile.basics.firstName} ${input.profile.basics.lastName}`.trim();
    const role = input.jobTitle ? ` for the ${input.jobTitle} role` : "";
    const company = input.company ? ` at ${input.company}` : "";
    const skills = input.profile.skillsSummary?.trim() || input.profile.experience?.summary?.trim() || "";
    const experienceYears = input.profile.experience?.years;
    const experienceSnippet = Number.isFinite(experienceYears)
      ? ` I bring ${experienceYears} years of hands-on engineering experience.`
      : "";
    const companyDirectionSnippet = input.companyContext
      ? ` I’m especially aligned with your direction: ${input.companyContext.slice(0, 220)}`
      : "";
    const personalization = input.hiringManager
      ? ` I’m especially excited to connect with ${input.hiringManager} and collaborate directly on high-impact product work.`
      : " I’m excited to work directly with the founding team on product-defining priorities.";
    const text = [
      `Hi${input.hiringManager ? ` ${input.hiringManager}` : ""} - I’m ${fullName}, and I’d love to be considered${role}${company}.`,
      experienceSnippet,
      skills
        ? ` My background centers on ${skills}, and I consistently ship production-grade features quickly while keeping quality high.`
        : " I ship quickly, communicate clearly, and own outcomes from idea to production.",
      companyDirectionSnippet,
      personalization,
      " If helpful, I can share relevant project examples and jump into a short intro call."
    ]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    return {
      text,
      source: "fallback",
      reason: "template_founder_message"
    };
  }

  private guardAgainstFabrication(question: ApplicationQuestion, value: AnswerValue | undefined): AnswerValue {
    if (value === null || value === undefined) return null;

    if (isCredentialQuestion(question)) {
      return null;
    }

    return value;
  }
}

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

interface ConfirmedAnswerRecord {
  label: string;
  value: string;
}

const ASHBY_REQUIRED_NARRATIVE_MIN_CHARS = 120;

function fallbackAnswer(questionId: string): ResolvedAnswer {
  return {
    questionId,
    value: null,
    source: "fallback",
    reason: "default"
  };
}

function buildExpectedOutputSpec(question: ApplicationQuestion): ExpectedOutputSpec {
  const label = question.label.toLowerCase();
  const options = question.options ?? [];
  if (question.type === "single_select") {
    return {
      kind: "single_select",
      required: question.required,
      allowedOptions: options
    };
  }
  if (question.type === "multi_select") {
    return {
      kind: "multi_select",
      required: question.required,
      allowedOptions: options
    };
  }
  if (question.type === "boolean") {
    return {
      kind: "boolean",
      required: question.required
    };
  }
  if (/email|e-mail/.test(label)) {
    return {
      kind: "email",
      required: question.required
    };
  }
  if (looksNarrativePrompt(question)) {
    return {
      kind: "narrative",
      required: question.required,
      minChars: question.required ? ASHBY_REQUIRED_NARRATIVE_MIN_CHARS : 40
    };
  }
  return {
    kind: "text",
    required: question.required
  };
}

function validateAgainstContract(
  question: ApplicationQuestion,
  value: AnswerValue,
  contract: ExpectedOutputSpec
): ValidationResult {
  if (value === null || value === undefined) {
    return contract.required ? { valid: false, reason: "required_null" } : { valid: true };
  }

  if (contract.kind === "single_select") {
    if (Array.isArray(value)) return { valid: false, reason: "single_select_array" };
    if (typeof value !== "string") return { valid: false, reason: "single_select_non_string" };
    const normalized = value.trim().toLowerCase();
    if (!contract.allowedOptions?.length) {
      if (["true", "false"].includes(normalized)) {
        return { valid: false, reason: "single_select_boolean_literal" };
      }
      return { valid: true };
    }
    const isAllowed = contract.allowedOptions.some((option) => option.trim().toLowerCase() === normalized);
    return isAllowed ? { valid: true } : { valid: false, reason: "single_select_not_allowed" };
  }

  if (contract.kind === "multi_select") {
    const values = Array.isArray(value) ? value : [String(value)];
    if (!contract.allowedOptions?.length) return { valid: true };
    const allowed = new Set(contract.allowedOptions.map((item) => item.trim().toLowerCase()));
    const invalid = values.some((item) => !allowed.has(String(item).trim().toLowerCase()));
    return invalid ? { valid: false, reason: "multi_select_not_allowed" } : { valid: true };
  }

  if (contract.kind === "boolean") {
    if (typeof value === "boolean") return { valid: true };
    const normalized = String(value).trim().toLowerCase();
    return ["yes", "no", "true", "false", "y", "n", "1", "0"].includes(normalized)
      ? { valid: true }
      : { valid: false, reason: "boolean_invalid_literal" };
  }

  if (contract.kind === "email") {
    if (typeof value !== "string") return { valid: false, reason: "email_non_string" };
    const normalized = value.trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
      ? { valid: true }
      : { valid: false, reason: "email_invalid_format" };
  }

  if (contract.kind === "narrative") {
    const text = String(value).trim();
    if (!text) return { valid: false, reason: "narrative_empty" };
    if (["yes", "no", "true", "false"].includes(text.toLowerCase())) {
      return { valid: false, reason: "narrative_boolean_literal" };
    }
    if (contract.minChars && text.length < contract.minChars) {
      return { valid: false, reason: "narrative_too_short" };
    }
    return { valid: true };
  }

  return { valid: true };
}

function looksNarrativePrompt(question: ApplicationQuestion): boolean {
  const label = question.label.toLowerCase();
  return (
    question.type === "textarea" ||
    /what interests you|tell us about|describe a time|specific contribution|why this role|why this company|how did you/.test(label)
  );
}

function readConfirmedAnswersCorpus(): ConfirmedAnswerRecord[] {
  const candidates = [path.resolve(process.cwd(), "output", "results.json")];
  const out: ConfirmedAnswerRecord[] = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
      for (const entry of parsed) {
        const submitOutcome = typeof entry.submitOutcome === "string" ? entry.submitOutcome : "";
        const submissionConfirmed = entry.submissionConfirmed === true;
        if (!(submissionConfirmed || submitOutcome === "confirmed")) continue;
        const platform = typeof entry.platform === "string" ? entry.platform : "";
        if (platform === "ashby") {
          const notes = Array.isArray(entry.notes) ? entry.notes : [];
          if (!notes.includes("run_finalized:apply_finalized")) continue;
        }
        const filledFields = Array.isArray(entry.filledFields) ? entry.filledFields : [];
        for (const field of filledFields) {
          if (!field || typeof field !== "object") continue;
          const label = typeof (field as { label?: unknown }).label === "string" ? String((field as { label?: unknown }).label) : "";
          const value = typeof (field as { value?: unknown }).value === "string" ? String((field as { value?: unknown }).value) : "";
          if (!label || !value) continue;
          out.push({ label, value });
        }
      }
    } catch {
      return [];
    }
  }
  return out.slice(-600);
}

function buildHybridFieldContext(
  question: ApplicationQuestion,
  context: AnswerContext,
  confirmedAnswers: ConfirmedAnswerRecord[]
): string {
  const snippets: string[] = [];
  const label = question.label.toLowerCase();
  if (context.profile.skillsSummary) snippets.push(`skills_summary: ${context.profile.skillsSummary}`);
  if (context.profile.experience?.summary) snippets.push(`experience_summary: ${context.profile.experience.summary}`);
  if (context.resumeText?.trim()) snippets.push(`resume_excerpt: ${context.resumeText.slice(0, 600)}`);
  if (context.companyContext?.trim()) snippets.push(`company_context: ${context.companyContext.slice(0, 500)}`);
  const prior = rankPriorAnswers(label, confirmedAnswers).slice(0, 3);
  for (const item of prior) {
    snippets.push(`prior_confirmed_answer for "${item.label}": ${item.value}`);
  }
  return snippets.filter(Boolean).join("\n");
}

function rankPriorAnswers(label: string, corpus: ConfirmedAnswerRecord[]): ConfirmedAnswerRecord[] {
  const wanted = tokenize(label);
  const scored = corpus
    .map((record) => ({ record, score: overlapScore(wanted, tokenize(record.label.toLowerCase())) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.map((item) => item.record);
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
  );
}

function overlapScore(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / Math.max(left.size, 1);
}

function shouldUseLlmFirstForQuestion(question: ApplicationQuestion): boolean {
  if (!question.required) return false;
  if (question.type !== "text" && question.type !== "textarea") return false;
  if (question.options?.length) return false;

  const label = question.label.toLowerCase();
  const motivationSignals = [
    /why.*(company|interested|interest|role|position|team|us)/,
    /what.*(motivates|attracts).* (company|role|position|team|opportunity)/,
    /(interested|interest).* (company|role|position|team|opportunity)/,
    /(why.*apply|why are you applying|why do you want to work)/
  ];
  return motivationSignals.some((signal) => signal.test(label));
}

function readBatchAnswer(
  answers: Record<string, AnswerValue>,
  questionId: string,
  label: string
): AnswerValue | undefined {
  if (answers[questionId] !== undefined) return answers[questionId];
  if (answers[label] !== undefined) return answers[label];

  const normalizedLabel = normalizeBatchKey(label);
  if (answers[normalizedLabel] !== undefined) return answers[normalizedLabel];

  const byNormalizedKey = Object.entries(answers).find(
    ([key]) => normalizeBatchKey(key) === normalizedLabel
  );
  return byNormalizedKey?.[1];
}

function normalizeBatchKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[*:]/g, "")
    .replace(/[^\w\s]/g, "")
    .trim();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
