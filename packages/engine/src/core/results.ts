import fs from "node:fs";
import path from "node:path";
import type { JobRunResult } from "./types.js";

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function answerValueToDisplay(value: JobRunResult["answers"][number]["value"]): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(String(item))).filter(Boolean).join(", ");
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  return normalizeText(String(value));
}

export function deriveSubmissionReceipt(result: JobRunResult): JobRunResult["submissionReceipt"] | undefined {
  const shouldExpose = result.submitted || result.submissionConfirmed || result.status === "applied";
  if (!shouldExpose) return undefined;

  if (result.reviewReceipt?.length) {
    const items = result.reviewReceipt
      .map((item) => ({
        section: item.section ? normalizeText(item.section) : undefined,
        question: normalizeText(item.question),
        answer: normalizeText(item.answer)
      }))
      .filter((item) => item.question && item.answer)
      .filter((item) => !/^no response$/i.test(item.answer));
    if (items.length) {
      return { source: "review_receipt", items };
    }
  }

  if (result.filledFields.length) {
    const deduped = new Map<string, { section?: string; question: string; answer: string }>();
    for (const field of result.filledFields) {
      const question = normalizeText(field.label || field.id);
      const answer = normalizeText(field.value || "");
      if (!question || !answer) continue;
      deduped.set(question.toLowerCase(), { question, answer });
    }
    if (deduped.size) {
      return { source: "filled_fields", items: Array.from(deduped.values()) };
    }
  }

  if (result.answers.length) {
    const deduped = new Map<string, { section?: string; question: string; answer: string }>();
    for (const answer of result.answers) {
      const question = normalizeText(answer.questionId);
      const value = answerValueToDisplay(answer.value);
      if (!question || !value) continue;
      deduped.set(question.toLowerCase(), { question, answer: value });
    }
    if (deduped.size) {
      return { source: "answers", items: Array.from(deduped.values()) };
    }
  }

  return undefined;
}

export function withDerivedSubmissionReceipt(result: JobRunResult): JobRunResult {
  return {
    ...result,
    submissionReceipt: deriveSubmissionReceipt(result)
  };
}

export function writeResults(outputDir: string, results: JobRunResult[]): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, "results.json");
  const withReceipts = results.map(withDerivedSubmissionReceipt);
  fs.writeFileSync(filePath, JSON.stringify(withReceipts, null, 2), "utf8");
  return filePath;
}
