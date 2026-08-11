import OpenAI from "openai";
import type { AIConfig } from "../core/types.js";
import type { BatchProviderInput, BatchProviderOutput, FounderMessageInput, FounderMessageOutput, LlmProvider } from "./types.js";
import { resolvePlatformBatchRules } from "./platform-resolvers/index.js";

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function buildBatchPrompt(input: BatchProviderInput): string {
  const profileContext = buildProfileContextSummary(input.context.profile);
  const platform = (input.context.platform ?? "generic").trim().toLowerCase();
  const payload = {
    platform,
    candidateProfile: input.context.profile,
    profileContext,
    resumeText: input.context.resumeText,
    jobTitle: input.context.jobTitle,
    company: input.context.company,
    companyContext: input.context.companyContext,
    unresolvedQuestions: input.questions
  };
  const commonRules = [
    "Never fabricate credentials or facts.",
    "For option questions, choose from provided options or optionHints only.",
    "Use fieldContext and optionHints when present.",
    "If a required question is a consent/acknowledgement/policy statement, answer 'Yes'.",
    "If a required question asks for mailing/current address and profile has location, use profile location.",
    "If a question is demographic-sensitive (race/ethnicity/hispanic/gender) and optional, answer 'Prefer not to say'.",
    "If question appears yes/no but rendered as text input, return plain 'Yes' or 'No'.",
    "For 'understanding of company' questions, use companyContext when provided and avoid fabrication.",
    "Follow each question.expectedOutput strictly.",
    "If expectedOutput.allowedOptions is provided, return exactly one allowed option for single_select and only allowed options for multi_select.",
    "For expectedOutput.kind=narrative, never return yes/no/true/false and satisfy minChars when provided.",
    "For expectedOutput.kind=email, return a syntactically valid email only.",
    "If retryHint is present, correct the prior invalid output using expectedOutput.",
    "For narrative answers, avoid generic claims. Use first-person voice and include concrete details from candidateProfile/resumeText/companyContext (tools, scope, metrics, outcomes).",
    "For narrative answers, do not reuse the same opening sentence structure across different questions in the same batch.",
    "Do not mention being an AI assistant, model, or automation agent unless the question explicitly asks about AI systems built by the candidate."
  ];
  const platformRules = resolvePlatformBatchRules(input);
  const rules = [...commonRules, ...platformRules];

  return [
    "You are filling a job application safely and accurately.",
    "Rules:",
    ...rules.map((rule, index) => `${index + 1}) ${rule}`),
    "Return strict JSON object: {\"answers\": {\"<questionId>\": <value or null>}}",
    JSON.stringify(payload)
  ].join("\n");
}

function buildProfileContextSummary(profile: BatchProviderInput["context"]["profile"]): Record<string, unknown> {
  const basics = profile.basics ?? ({} as Record<string, unknown>);
  return {
    identity: {
      fullName: profile.basics.fullName || `${profile.basics.firstName} ${profile.basics.lastName}`.trim(),
      email: basics.email,
      phone: basics.phone
    },
    location: {
      cityState: basics.location,
      state: profile.state,
      country: profile.country
    },
    links: profile.links ?? {},
    workAuthorization: profile.workAuthorization ?? {},
    education: profile.education ?? {},
    experience: profile.experience ?? {},
    skillsSummary: profile.skillsSummary ?? "",
    salary: profile.salary ?? "",
    customAnswers: profile.customAnswers ?? {}
  };
}

function extractAnswers(rawText: string): BatchProviderOutput {
  const parsed = safeJsonParse(rawText);
  if (!parsed) return {};

  const answers = parsed.answers;
  if (!answers) {
    return coerceTopLevelAnswers(parsed);
  }

  if (Array.isArray(answers)) {
    const output: BatchProviderOutput = {};
    for (const entry of answers) {
      if (!entry || typeof entry !== "object") continue;
      const id = (entry as { id?: unknown }).id;
      const value = (entry as { value?: unknown; answer?: unknown }).value ?? (entry as { answer?: unknown }).answer;
      if (typeof id !== "string") continue;
      output[id] = normalizeProviderValue(value);
    }
    return output;
  }

  if (typeof answers !== "object") {
    return {};
  }

  const output: BatchProviderOutput = {};
  for (const [id, value] of Object.entries(answers as Record<string, unknown>)) {
    output[id] = normalizeProviderValue(value);
  }
  return output;
}

function coerceTopLevelAnswers(parsed: Record<string, unknown>): BatchProviderOutput {
  const output: BatchProviderOutput = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (id === "answers") continue;
    output[id] = normalizeProviderValue(value);
  }
  return output;
}

function normalizeProviderValue(value: unknown): string | string[] | boolean | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const nested = record.answer ?? record.value ?? record.text ?? null;
    if (nested === null || nested === undefined) return null;
    if (typeof nested === "string" || typeof nested === "boolean") return nested;
    if (typeof nested === "number") return String(nested);
  }
  return null;
}

function buildFounderMessagePrompt(input: FounderMessageInput): string {
  const payload = {
    candidateProfile: input.profile,
    resumeText: input.resumeText,
    targetRole: {
      jobTitle: input.jobTitle,
      company: input.company,
      hiringManager: input.hiringManager
    },
    companyContext: input.companyContext
  };

  return [
    "Write a concise first-message to a startup founder/hiring manager for a YC Work at a Startup application.",
    "Rules:",
    "1) Persuasive and high-conviction tone, but factual-only from provided profile/resume/context.",
    "2) Do not invent employers, titles, results, metrics, or credentials.",
    "3) Mention specific interest in the company and role when context is available.",
    "3b) If companyContext includes mission/product/direction details, reference one concrete detail naturally.",
    "4) Keep message between 90 and 180 words.",
    "5) Return strict JSON object: {\"message\": \"...\"}.",
    JSON.stringify(payload)
  ].join("\n");
}

function extractFounderMessage(rawText: string): FounderMessageOutput {
  const parsed = safeJsonParse(rawText);
  if (parsed && typeof parsed.message === "string" && parsed.message.trim()) {
    return { text: parsed.message.trim() };
  }

  const fallback = rawText.trim();
  return { text: fallback };
}

export class OpenAIProvider implements LlmProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: AIConfig) {
    const envKey = config.openai?.apiKeyEnv ?? "OPENAI_API_KEY";
    const apiKey =
      process.env[envKey] ||
      process.env.OPENAI_API_KEY ||
      process.env.OPEN_AI_KEY ||
      process.env.OPENAI_KEY;

    if (!apiKey) {
      throw new Error(
        `Missing OpenAI API key. Checked: ${envKey}, OPENAI_API_KEY, OPEN_AI_KEY, OPENAI_KEY`
      );
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: config.openai?.baseUrl
    });
    this.model = config.model;
  }

  async answerBatch(input: BatchProviderInput): Promise<BatchProviderOutput> {
    const prompt = buildBatchPrompt(input);

    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a strict job application assistant. Return JSON only with keys requested. Never invent credentials."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) return {};
    return extractAnswers(content);
  }

  async generateFounderMessage(input: FounderMessageInput): Promise<FounderMessageOutput> {
    const prompt = buildFounderMessagePrompt(input);

    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You write concise, persuasive founder outreach for job applications. Keep it factual and grounded in provided data."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) return { text: "" };
    return extractFounderMessage(content);
  }
}

export class OllamaProvider implements LlmProvider {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(config: AIConfig) {
    this.baseUrl = config.ollama?.baseUrl ?? "http://localhost:11434";
    this.model = config.model;
  }

  async answerBatch(input: BatchProviderInput): Promise<BatchProviderOutput> {
    const prompt = buildBatchPrompt(input);

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "You are a strict job application assistant. Return JSON only with keys requested. Never invent credentials."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as { message?: { content?: string } };
    const content = payload.message?.content ?? "";
    return extractAnswers(content);
  }

  async generateFounderMessage(input: FounderMessageInput): Promise<FounderMessageOutput> {
    const prompt = buildFounderMessagePrompt(input);

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "You write concise, persuasive founder outreach for job applications. Keep it factual and grounded in provided data."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as { message?: { content?: string } };
    const content = payload.message?.content ?? "";
    return extractFounderMessage(content);
  }
}
