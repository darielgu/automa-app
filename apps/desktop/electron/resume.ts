import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import OpenAI from "openai";
import type { UserProfileInput } from "@automa/shared-types";
import type { DesktopAutomationConfig, DesktopResumeRecord, ResumeParseDraft } from "../src/desktop-types.js";

const execFileAsync = promisify(execFile);

function createEmptyProfile(): UserProfileInput {
  return {
    basics: {
      firstName: "",
      lastName: "",
      fullName: "",
      email: "",
      phone: "",
      location: ""
    },
    links: {},
    workAuthorization: {
      authorizedToWork: true,
      requiresSponsorship: false
    },
    education: {},
    experience: {},
    preferences: {
      desiredRoles: [],
      desiredLocations: [],
      employmentTypes: ["full-time"],
      remoteOnly: true
    }
  };
}

function normalizeArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function sanitizeParsedProfile(value: unknown): UserProfileInput {
  const profile = createEmptyProfile();
  if (!value || typeof value !== "object") return profile;
  const source = value as Record<string, unknown>;
  const basics = source.basics && typeof source.basics === "object" ? source.basics as Record<string, unknown> : {};
  const links = source.links && typeof source.links === "object" ? source.links as Record<string, unknown> : {};
  const workAuthorization = source.workAuthorization && typeof source.workAuthorization === "object"
    ? source.workAuthorization as Record<string, unknown>
    : {};
  const education = source.education && typeof source.education === "object" ? source.education as Record<string, unknown> : {};
  const experience = source.experience && typeof source.experience === "object" ? source.experience as Record<string, unknown> : {};
  const preferences = source.preferences && typeof source.preferences === "object" ? source.preferences as Record<string, unknown> : {};

  profile.basics.firstName = String(basics.firstName ?? "").trim();
  profile.basics.lastName = String(basics.lastName ?? "").trim();
  profile.basics.fullName = String(
    basics.fullName ?? `${profile.basics.firstName} ${profile.basics.lastName}`.trim()
  ).trim();
  profile.basics.email = String(basics.email ?? "").trim();
  profile.basics.phone = String(basics.phone ?? "").trim();
  profile.basics.location = String(basics.location ?? "").trim();

  for (const key of ["linkedin", "github", "portfolio", "website"] as const) {
    const candidate = String(links[key] ?? "").trim();
    if (candidate) {
      profile.links[key] = candidate;
    }
  }

  profile.workAuthorization = {
    authorizedToWork: workAuthorization.authorizedToWork === false ? false : true,
    requiresSponsorship: Boolean(workAuthorization.requiresSponsorship),
    usCitizen: typeof workAuthorization.usCitizen === "boolean" ? workAuthorization.usCitizen : undefined,
    permanentResident: typeof workAuthorization.permanentResident === "boolean" ? workAuthorization.permanentResident : undefined,
    visaStatus: String(workAuthorization.visaStatus ?? "").trim() || undefined
  };

  profile.education = {
    highestDegree: String(education.highestDegree ?? "").trim() || undefined,
    school: String(education.school ?? "").trim() || undefined,
    degree: String(education.degree ?? "").trim() || undefined,
    field: String(education.field ?? "").trim() || undefined,
    graduationYear: String(education.graduationYear ?? "").trim() || undefined
  };

  const yearsValue = Number(experience.years);
  profile.experience = {
    years: Number.isFinite(yearsValue) && yearsValue >= 0 ? yearsValue : undefined,
    summary: String(experience.summary ?? "").trim() || undefined,
    currentCompany: String(experience.currentCompany ?? "").trim() || undefined,
    currentTitle: String(experience.currentTitle ?? "").trim() || undefined
  };

  profile.salary = String(source.salary ?? "").trim() || undefined;
  profile.country = String(source.country ?? "").trim() || undefined;
  profile.state = String(source.state ?? "").trim() || undefined;
  profile.skillsSummary = String(source.skillsSummary ?? "").trim() || undefined;
  profile.preferences = {
    desiredRoles: normalizeArray(preferences.desiredRoles),
    desiredLocations: normalizeArray(preferences.desiredLocations),
    employmentTypes: normalizeArray(preferences.employmentTypes).length > 0
      ? normalizeArray(preferences.employmentTypes)
      : ["full-time"],
    remoteOnly: preferences.remoteOnly === false ? false : true
  };

  return profile;
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in model response");
  }
  return text.slice(start, end + 1);
}

function inferMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".doc") return "application/msword";
  if (extension === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (extension === ".rtf") return "application/rtf";
  if (extension === ".txt") return "text/plain";
  return "application/octet-stream";
}

// Text extraction only. We deliberately avoid `pdf-parse`, which drags in
// `@napi-rs/canvas` — a native, architecture-specific binary. That would make an
// x64 build produced on an arm64 Mac throw on load. pdfjs-dist needs no canvas
// for `getTextContent`, so the app stays free of native modules.
async function extractPdfText(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true
  }).promise;

  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => (typeof item === "object" && item && "str" in item ? String(item.str) : ""))
        .join(" ");
      pages.push(text);
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }

  return pages.join("\n").replace(/[ \t]+/g, " ").trim();
}

async function extractTextWithTextUtil(filePath: string): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/textutil", ["-convert", "txt", "-stdout", filePath], {
    maxBuffer: 20 * 1024 * 1024
  });
  return stdout.trim();
}

function heuristicProfileFromText(text: string): UserProfileInput {
  const profile = createEmptyProfile();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const phone = text.match(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/)?.[0];
  const linkedin = text.match(/https?:\/\/(?:www\.)?linkedin\.com\/[^\s]+/i)?.[0];
  const github = text.match(/https?:\/\/(?:www\.)?github\.com\/[^\s]+/i)?.[0];
  const portfolio = text.match(/https?:\/\/[^\s]+/i)?.[0];

  const firstLine = lines[0] ?? "";
  const nameParts = firstLine.split(/\s+/).filter(Boolean);
  profile.basics.firstName = nameParts[0] ?? "";
  profile.basics.lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] ?? "" : "";
  profile.basics.fullName = firstLine;
  profile.basics.email = email ?? "";
  profile.basics.phone = phone ?? "";
  profile.basics.location = lines.find((line) => /,\s*[A-Z]{2}\b|remote|united states|california|new york/i.test(line)) ?? "";
  profile.links.linkedin = linkedin;
  profile.links.github = github;
  if (portfolio && portfolio !== linkedin && portfolio !== github) {
    profile.links.website = portfolio;
  }
  profile.experience.summary = lines.slice(0, 12).join(" ").slice(0, 1200);
  profile.experience.currentTitle = lines[1] ?? undefined;
  profile.preferences.desiredRoles = profile.experience.currentTitle ? [profile.experience.currentTitle] : [];
  if (profile.basics.location) {
    profile.preferences.desiredLocations = [profile.basics.location];
  }
  profile.skillsSummary = lines.slice(0, 20).join(" ").slice(0, 1500);
  return profile;
}

async function extractResumeText(resume: DesktopResumeRecord): Promise<string> {
  const extension = path.extname(resume.filePath).toLowerCase();
  if (extension === ".pdf") {
    return extractPdfText(resume.filePath);
  }
  if ([".doc", ".docx", ".rtf"].includes(extension)) {
    return extractTextWithTextUtil(resume.filePath);
  }
  if ([".txt", ".md"].includes(extension)) {
    return (await fs.readFile(resume.filePath, "utf8")).trim();
  }
  throw new Error(`Unsupported resume file type: ${extension || "unknown"}`);
}

async function parseWithOpenAI(text: string, config: DesktopAutomationConfig): Promise<UserProfileInput> {
  const apiKey = process.env[config.openaiApiKeyEnv] || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(`Missing OpenAI API key in ${config.openaiApiKeyEnv}`);
  }

  const client = new OpenAI({ apiKey });
  const response = await client.responses.create({
    model: config.openaiModel,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Extract a job-automation candidate profile from resume text and return only one JSON object. " +
              "Fill unknown fields with empty strings, empty arrays, or sensible defaults. " +
              'Use this exact shape: {"basics":{"firstName":"","lastName":"","fullName":"","email":"","phone":"","location":""},' +
              '"links":{"linkedin":"","github":"","portfolio":"","website":""},' +
              '"workAuthorization":{"authorizedToWork":true,"requiresSponsorship":false,"usCitizen":null,"permanentResident":null,"visaStatus":""},' +
              '"education":{"highestDegree":"","school":"","degree":"","field":"","graduationYear":""},' +
              '"experience":{"years":0,"summary":"","currentCompany":"","currentTitle":""},' +
              '"salary":"","country":"","state":"","skillsSummary":"","preferences":{"desiredRoles":[],"desiredLocations":[],"employmentTypes":["full-time"],"remoteOnly":true}}. ' +
              "Do not invent facts. Infer desired roles and locations conservatively from the resume when they are explicit."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: text.slice(0, 24000)
          }
        ]
      }
    ]
  });

  return sanitizeParsedProfile(JSON.parse(extractJsonObject(response.output_text)));
}

export function createResumeRecord(filePath: string): DesktopResumeRecord {
  return {
    fileName: path.basename(filePath),
    filePath,
    mimeType: inferMimeType(filePath),
    selectedAt: new Date().toISOString()
  };
}

export async function parseResumeRecord(
  resume: DesktopResumeRecord,
  config: DesktopAutomationConfig
): Promise<ResumeParseDraft> {
  const warnings: string[] = [];
  const extractedText = await extractResumeText(resume);
  if (!extractedText) {
    throw new Error("The selected resume could not be read.");
  }

  let profile = heuristicProfileFromText(extractedText);
  if (config.aiProvider === "openai") {
    try {
      profile = await parseWithOpenAI(extractedText, config);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "OpenAI parsing failed, using basic extraction.");
    }
  } else {
    warnings.push("AI parsing is disabled. Basic extraction was used instead.");
  }

  if (!profile.basics.fullName && profile.basics.firstName && profile.basics.lastName) {
    profile.basics.fullName = `${profile.basics.firstName} ${profile.basics.lastName}`.trim();
  }

  return {
    profile,
    extractedText,
    warnings
  };
}
