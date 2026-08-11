import type { AnswerValue, ApplicationQuestion } from "../core/types.js";

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeOptionValue(answer: string, options: string[]): string | null {
  const exact = options.find((option) => normalizeText(option) === normalizeText(answer));
  if (exact) return exact;

  const contains = options.find((option) => normalizeText(option).includes(normalizeText(answer)));
  if (contains) return contains;

  const reverseContains = options.find((option) => normalizeText(answer).includes(normalizeText(option)));
  if (reverseContains) return reverseContains;

  if (["yes", "true", "y"].includes(normalizeText(answer))) {
    const yesOption = options.find((option) =>
      ["yes", "true"].includes(normalizeText(option)) ||
      /\backnowledge\b|\bconfirm\b|\baccept\b/i.test(option)
    );
    if (yesOption) return yesOption;
  }

  if (["no", "false", "n"].includes(normalizeText(answer))) {
    const noOption = options.find((option) => ["no", "false"].includes(normalizeText(option)));
    if (noOption) return noOption;
  }

  return null;
}

export function normalizeAnswerToQuestion(question: ApplicationQuestion, value: AnswerValue): AnswerValue {
  if (value === null || value === undefined) return null;
  const hintedOptions = Array.isArray(question.platformMeta?.optionHints)
    ? (question.platformMeta.optionHints as string[])
    : [];
  const optionPool = question.options?.length ? question.options : hintedOptions;

  if (!optionPool.length) {
    if (question.type === "boolean" && typeof value === "string") {
      const normalized = normalizeText(value);
      if (["yes", "true"].includes(normalized)) return true;
      if (["no", "false"].includes(normalized)) return false;
    }

    return value;
  }

  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => normalizeOptionValue(String(entry), optionPool))
      .filter((entry): entry is string => Boolean(entry));
    return normalized.length ? normalized : value.map((entry) => String(entry));
  }

  if (typeof value === "boolean") {
    const target = value ? ["yes", "true"] : ["no", "false"];
    const found = optionPool.find((option) => target.includes(normalizeText(option)));
    return found ?? (value ? "Yes" : "No");
  }

  const normalized = normalizeOptionValue(String(value), optionPool);
  return normalized ?? String(value);
}
