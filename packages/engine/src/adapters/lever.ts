import path from "node:path";
import { BaseAdapter } from "./base.js";
import type { AdapterRunContext, ApplicationQuestion, AnswerValue, CandidateProfile, JobRunResult, ResolvedAnswer } from "../core/types.js";

export type LeverFieldType =
  | "text"
  | "email"
  | "phone"
  | "file"
  | "location_autocomplete"
  | "textarea"
  | "radio"
  | "checkbox_group"
  | "select"
  | "hidden"
  | "unknown";

export interface LeverFieldSchema {
  fieldId: string;
  label: string;
  sectionTitle: string;
  required: boolean;
  fieldType: LeverFieldType;
  possibleAnswers: string[];
  currentValue: string | string[] | null;
  selectorHints: {
    name?: string;
    dataQa?: string;
    inputId?: string;
    selector?: string;
    frameUrl?: string;
    cardKey?: string;
    groupName?: string;
    containerSelector?: string;
    customTriggerSelector?: string;
    customOptionSelector?: string;
    customSelectedValueSelector?: string;
  };
  fieldKind?: "native_select" | "custom_select";
  htmlSummary: Record<string, unknown>;
}

interface LeverTemplateField {
  cardKey: string;
  fieldIndex: number;
  label: string;
  required: boolean;
  templateType: string;
  fieldType: LeverFieldType;
  options: string[];
}

interface PlannedAnswer {
  fieldId: string;
  fieldType: LeverFieldType;
  answer: string | null;
  selectedOptions: string[];
  source: "deterministic_profile" | "llm_inference";
  reason: string;
  locked: boolean;
  unknownField?: boolean;
  rawLlmValue?: AnswerValue;
}

interface OptionRepair {
  answer: string | null;
  selectedOptions: string[];
}

interface InvalidFieldSignal {
  key: string;
  containerLabel: string;
}

interface PreSubmitGateStatus {
  blockerFieldIds: string[];
  hardBlockerFieldIds: string[];
  softConflictFieldIds: string[];
  domVerifiedFieldIds: string[];
  locationTokenMissingFieldIds: string[];
  invalidFieldIds: string[];
  unresolvedRequiredUnknownFieldIds: string[];
  unresolvedRequiredFieldIds: string[];
}

interface FieldExecutionState {
  fieldId: string;
  applied: boolean;
  verified: boolean;
  lastVerifiedAt: string | null;
}

interface RequiredFieldDomStatus {
  fieldId: string;
  satisfied: boolean;
  checkedCount: number;
  activeCount: number;
  hasValue: boolean;
  ariaInvalid: string;
  valueMissing: boolean;
  locationVisibleValue: string;
  locationHiddenValue: string;
  locationTokenValid: boolean;
}

const DEFAULT_MAX_SUBMIT_ATTEMPTS = 2;
const NARRATIVE_TELEMETRY_PREVIEW_LIMIT = 500;

const INACTIVE_POSTING_TEXT_PATTERNS = [
  "job not found",
  "posting not found",
  "position has been filled",
  "no longer accepting applications",
  "this job has expired",
  "404"
];

const CHALLENGE_SELECTORS = [
  "#h-captcha",
  "iframe[src*='hcaptcha']",
  "input[name='h-captcha-response']",
  "iframe[src*='recaptcha']",
  "textarea[name='g-recaptcha-response']"
];

const LEVER_CONTAINER_SELECTORS = [
  "li.application-question",
  "li.application-question.custom-question",
  "li.application-question.resume",
  "section[data-qa='additional-cards'] .application-question",
  ".eeo-section .application-question",
  "[data-qa='structured-contact-location-question']"
];

export function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isLikelyNarrativeLeverPrompt(label: string): boolean {
  return (
    /tell us|describe|what(?:'| i)?s most exciting|if you could|why do you|why are you|what motivates|one thing.*proud|proud of|what problem|what would you solve|interviewing.*stage/i.test(
      label
    ) || /resonates the most with your job search/i.test(label)
  );
}

function buildTelemetryPreview(value: string, maxLen = NARRATIVE_TELEMETRY_PREVIEW_LIMIT): { preview: string; charCount: number } {
  const normalized = normalizeText(value);
  return {
    preview: normalized.slice(0, maxLen),
    charCount: normalized.length
  };
}

export interface LeverSelectedLocationStatus {
  raw: string;
  name: string;
  id: string;
  valid: boolean;
}

export function parseLeverSelectedLocationStatus(value: unknown): LeverSelectedLocationStatus {
  const raw = normalizeText(value);
  if (!raw) {
    return { raw: "", name: "", id: "", valid: false };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const name = normalizeText(parsed?.name);
    const id = normalizeText(parsed?.id ?? parsed?.locationId ?? parsed?.value ?? "");
    const validName = Boolean(name) && !/no location found|select location|type to search/i.test(name);
    return {
      raw,
      name,
      id,
      valid: validName
    };
  } catch {
    return { raw, name: "", id: "", valid: false };
  }
}

export function isValidLeverSelectedLocation(value: unknown): boolean {
  return parseLeverSelectedLocationStatus(value).valid;
}

export function buildLeverLocationAnswer(profile: CandidateProfile): string {
  const { city, region, country, basicsLocation } = extractLeverLocationParts(profile);
  if (city && region) return `${city}, ${region}`;
  if (city && country) return `${city}, ${country}`;
  if (city) return city;
  if (region && country) return `${region}, ${country}`;
  return basicsLocation;
}

function extractLeverLocationParts(profile: CandidateProfile): { city: string; region: string; country: string; basicsLocation: string } {
  const structuredCity = normalizeText(profile.locationStructured?.city);
  const structuredRegion = normalizeText(profile.locationStructured?.region);
  const structuredCountry = normalizeText(profile.locationStructured?.country);
  const basicsLocation = normalizeText(profile.basics.location);

  if (structuredCity || structuredRegion || structuredCountry) {
    return {
      city: structuredCity,
      region: structuredRegion,
      country: structuredCountry,
      basicsLocation
    };
  }

  const rawParts = basicsLocation
    .split(",")
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .filter((item) => !/^\d{4,}$/.test(item));

  const parts = [...rawParts];
  if (parts.length > 0 && (/^\d+\s+/.test(parts[0]!) || /\b(ave|avenue|st|street|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place)\b/i.test(parts[0]!))) {
    parts.shift();
  }

  return {
    city: parts[0] ?? "",
    region: parts[1] ?? "",
    country: parts[2] ?? "",
    basicsLocation
  };
}

function buildLeverLocationOptionAnswer(profile: CandidateProfile, possibleAnswers: string[]): string | null {
  const { city, region, country, basicsLocation } = extractLeverLocationParts(profile);
  const inferredUsCountry =
    /united states|usa|u\.s\./i.test(country) ||
    /\b\d{5}\b/.test(basicsLocation) ||
    /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i.test(basicsLocation);

  const candidates = [
    buildLeverLocationAnswer(profile),
    [city, region].filter(Boolean).join(", "),
    [city, country].filter(Boolean).join(", "),
    [region, country].filter(Boolean).join(", "),
    inferredUsCountry && region ? `${region}, USA` : "",
    inferredUsCountry && city ? `${city}, USA` : "",
    region,
    city,
    country,
    inferredUsCountry ? "USA" : "",
    inferredUsCountry ? "United States" : ""
  ]
    .map((item) => normalizeText(item))
    .filter(Boolean);

  for (const candidate of candidates) {
    const repaired = validateAndRepairOption("select", possibleAnswers, candidate, [candidate]);
    if (repaired.answer) return repaired.answer;
  }

  return null;
}

export function mapLeverTemplateTypeToFieldType(templateType: string): LeverFieldType {
  const normalized = normalizeText(templateType).toLowerCase();
  if (normalized === "text") return "text";
  if (normalized === "textarea") return "textarea";
  if (normalized === "multiple-choice") return "radio";
  if (normalized === "multiple-select") return "checkbox_group";
  if (normalized === "dropdown") return "select";
  return "unknown";
}

export function parseLeverBaseTemplateJson(raw: string, cardKey = "unknown"): LeverTemplateField[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as { fields?: Array<{ type?: string; text?: string; required?: boolean; options?: Array<{ text?: string }> }> };
    const fields = Array.isArray(parsed.fields) ? parsed.fields : [];
    return fields.map((field, index) => ({
      cardKey,
      fieldIndex: index,
      label: normalizeText(field.text || `Card field ${index + 1}`),
      required: Boolean(field.required),
      templateType: normalizeText(field.type),
      fieldType: mapLeverTemplateTypeToFieldType(String(field.type ?? "")),
      options: Array.isArray(field.options)
        ? field.options.map((option) => normalizeText(option?.text)).filter(Boolean)
        : []
    }));
  } catch {
    return [];
  }
}

export function validateAndRepairOption(
  fieldType: LeverFieldType,
  possibleAnswers: string[],
  answer: string | null,
  selectedOptions: string[]
): OptionRepair {
  const cleaned = possibleAnswers.map((item) => normalizeText(item)).filter(Boolean);
  const index = new Map(cleaned.map((item) => [item.toLowerCase(), item]));
  if (cleaned.length === 0) {
    return {
      answer: normalizeText(answer) || null,
      selectedOptions: selectedOptions.map((item) => normalizeText(item)).filter(Boolean)
    };
  }

  if (fieldType === "checkbox_group") {
    const repaired = selectedOptions
      .map((item) => index.get(normalizeText(item).toLowerCase()))
      .filter((item): item is string => Boolean(item));
    return { answer: null, selectedOptions: [...new Set(repaired)] };
  }

  const primary = normalizeText(answer || selectedOptions[0] || "").toLowerCase();
  if (!primary) return { answer: null, selectedOptions: [] };
  const matched = index.get(primary) ?? cleaned.find((item) => item.toLowerCase().includes(primary) || primary.includes(item.toLowerCase()));
  return { answer: matched ?? null, selectedOptions: matched ? [matched] : [] };
}

function bestGuessOptionRepairForRequiredUnknown(field: LeverFieldSchema): OptionRepair {
  const options = field.possibleAnswers.map((item) => normalizeText(item)).filter(Boolean);
  if (options.length === 0) return { answer: null, selectedOptions: [] };
  if (field.fieldType === "checkbox_group") {
    const pick = pickEarliestNonPlaceholderOption(options);
    return pick ? { answer: null, selectedOptions: [pick] } : { answer: null, selectedOptions: [] };
  }
  if (field.fieldType === "select" || field.fieldType === "radio") {
    const pick = pickEarliestNonPlaceholderOption(options);
    return pick ? { answer: pick, selectedOptions: [pick] } : { answer: null, selectedOptions: [] };
  }
  return { answer: null, selectedOptions: [] };
}

export function formatDateMmDdYyyy(date: Date = new Date()): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  return `${mm}/${dd}/${yyyy}`;
}

function isLikelySelectPlaceholderOption(value: string): boolean {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return true;
  if (/^select(\.\.\.)?$/.test(normalized)) return true;
  if (/^choose\b/.test(normalized)) return true;
  if (/^please select\b/.test(normalized)) return true;
  if (/priority will be given/.test(normalized)) return true;
  return false;
}

function formatMonthApostropheYear(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[date.getMonth()] ?? "Jan";
  const yy = String(date.getFullYear()).slice(-2);
  return `${month}'${yy}`;
}

function buildFutureAvailabilityRange(now: Date = new Date(), monthsForward = 6): string {
  const start = new Date(now.getTime());
  const end = new Date(now.getTime());
  end.setMonth(end.getMonth() + monthsForward);
  return `${formatMonthApostropheYear(start)} - ${formatMonthApostropheYear(end)}`;
}

function isEuOrEftaCountry(country: string): boolean {
  const normalized = normalizeText(country).toLowerCase();
  if (!normalized) return false;
  const euOrEfta = new Set([
    "austria",
    "belgium",
    "bulgaria",
    "croatia",
    "cyprus",
    "czech republic",
    "czechia",
    "denmark",
    "estonia",
    "finland",
    "france",
    "germany",
    "greece",
    "hungary",
    "ireland",
    "italy",
    "latvia",
    "lithuania",
    "luxembourg",
    "malta",
    "netherlands",
    "poland",
    "portugal",
    "romania",
    "slovakia",
    "slovenia",
    "spain",
    "sweden",
    "iceland",
    "liechtenstein",
    "norway",
    "switzerland"
  ]);
  return euOrEfta.has(normalized);
}

export function pickEarliestNonPlaceholderOption(options: string[]): string | null {
  for (const option of options.map((item) => normalizeText(item)).filter(Boolean)) {
    if (isLikelySelectPlaceholderOption(option)) continue;
    return option;
  }
  return null;
}

export function resolveDeterministicProfileValue(
  field: LeverFieldSchema,
  profile: CandidateProfile,
  configResumePath?: string
): PlannedAnswer | null {
  const label = normalizeText(field.label).toLowerCase();
  const narrativeTextarea = field.fieldType === "textarea" && isLikelyNarrativeLeverPrompt(label);
  const basics = profile.basics;
  const fullName = normalizeText(basics.fullName || `${basics.firstName} ${basics.lastName}`);
  const currentCompany = normalizeText(profile.experience?.currentCompany || "");
  const preferredName = normalizeText(String(profile.customAnswers?.preferredName ?? "")) || basics.firstName;
  const nickname = normalizeText(String(profile.customAnswers?.nickname ?? ""));

  const pick = (value: string | null, reason: string): PlannedAnswer | null => {
    const normalized = normalizeText(value);
    if (!normalized) return null;
    return {
      fieldId: field.fieldId,
      fieldType: field.fieldType,
      answer: normalized,
      selectedOptions: [],
      source: "deterministic_profile",
      reason,
      locked: true
    };
  };

  if (field.fieldType === "file") {
    const resumePath = normalizeText(configResumePath || "");
    if (!resumePath) return null;
    return {
      fieldId: field.fieldId,
      fieldType: field.fieldType,
      answer: resumePath,
      selectedOptions: [resumePath],
      source: "deterministic_profile",
      reason: "profile_resume_path",
      locked: true
    };
  }

  if (
    field.fieldType === "checkbox_group" &&
    field.required &&
    field.possibleAnswers.length === 1 &&
    (/confirmation|confirm|acknowledge|attest|declaration/.test(label) ||
      /i hereby confirm|true and accurate/i.test(field.possibleAnswers[0] || ""))
  ) {
    const onlyOption = normalizeText(field.possibleAnswers[0]);
    return {
      fieldId: field.fieldId,
      fieldType: field.fieldType,
      answer: null,
      selectedOptions: [onlyOption],
      source: "deterministic_profile",
      reason: "deterministic_confirmation_checkbox",
      locked: true
    };
  }

  if (/full name|name\b/.test(label) && !/first|last|preferred|nick/.test(label)) return pick(fullName, "profile_full_name");
  if (/legal first name|first name/.test(label)) return pick(basics.firstName, "profile_first_name");
  if (/legal last name|last name|family name|surname/.test(label)) return pick(basics.lastName, "profile_last_name");
  if (/preferred first name/.test(label)) return pick(preferredName, "profile_preferred_name");
  if (/nick ?name/.test(label)) return pick(nickname || basics.firstName, "profile_nickname");
  if (!narrativeTextarea && /email/.test(label)) return pick(basics.email, "profile_email");
  if (!narrativeTextarea && /\b(phone|mobile|telephone|tel)\b/.test(label)) return pick(basics.phone || "", "profile_phone");
  if (
    field.fieldType === "checkbox_group" &&
    /check all that apply/.test(label) &&
    /relocation support|visa sponsorship|housing assistance/.test(label) &&
    field.possibleAnswers.length > 0
  ) {
    const preferredCity = ["London", "Berlin", "Munich", "Zurich", "Cologne", "Karlsruhe"]
      .map((city) => field.possibleAnswers.find((option) => normalizeText(option).toLowerCase() === city.toLowerCase()))
      .find(Boolean);
    const selected = normalizeText(preferredCity || pickEarliestNonPlaceholderOption(field.possibleAnswers) || "");
    if (selected) {
      return {
        fieldId: field.fieldId,
        fieldType: field.fieldType,
        answer: null,
        selectedOptions: [selected],
        source: "deterministic_profile",
        reason: "deterministic_eu_location_preference",
        locked: true
      };
    }
  }

  if (!narrativeTextarea && /current location|location|currently based/.test(label)) {
    if (field.possibleAnswers.length > 0) {
      const optionAnswer = buildLeverLocationOptionAnswer(profile, field.possibleAnswers);
      if (optionAnswer) {
        return {
          fieldId: field.fieldId,
          fieldType: field.fieldType,
          answer: optionAnswer,
          selectedOptions: [optionAnswer],
          source: "deterministic_profile",
          reason: "profile_location_option",
          locked: true
        };
      }
    }
    return pick(buildLeverLocationAnswer(profile), "profile_location");
  }
  if (!narrativeTextarea && /current company/.test(label)) return pick(currentCompany, "profile_current_company");
  if (/linkedin( url)?/.test(label)) return pick(profile.links?.linkedin || "", "profile_linkedin");
  if (/github( url)?|git hub/.test(label)) return pick(profile.links?.github || profile.links?.portfolio || profile.links?.website || "", "profile_github");
  if ((/personal website|portfolio|website|personal site|homepage/.test(label)) && !/linkedin|github|git hub/.test(label)) {
    return pick(profile.links?.portfolio || profile.links?.website || profile.links?.github || "", "profile_portfolio_site");
  }

  if (
    (/disability/.test(label) && /date|dated|signature date|today/.test(label)) ||
    (/eeo/.test(field.fieldId.toLowerCase()) && /signature.?date|date/.test(label))
  ) {
    return pick(formatDateMmDdYyyy(), "deterministic_disability_date");
  }

  if (/what semester|semester|interested term|interested in/.test(label) && field.possibleAnswers.length > 0) {
    const semester = pickEarliestNonPlaceholderOption(field.possibleAnswers);
    if (semester) {
      const repaired = validateAndRepairOption(field.fieldType, field.possibleAnswers, semester, [semester]);
      return {
        fieldId: field.fieldId,
        fieldType: field.fieldType,
        answer: repaired.answer,
        selectedOptions: repaired.selectedOptions,
        source: "deterministic_profile",
        reason: "deterministic_semester_pick",
        locked: true
      };
    }
  }

  if (/commitment period|full time internship|internship.*commitment/.test(label) && field.possibleAnswers.length > 0) {
    const validOptions = field.possibleAnswers.filter((item) => !isLikelySelectPlaceholderOption(item));
    const ranked = [
      validOptions.find((item) => /9\s*-\s*12\s*months|9\s*to\s*12\s*months|12\s*months/i.test(item)),
      validOptions.find((item) => /6\+|6\s*months|half[- ]?year/i.test(item)),
      validOptions.find((item) => /5\s*months/i.test(item)),
      validOptions.find((item) => /4\s*months/i.test(item)),
      validOptions.find((item) => /3\s*months/i.test(item)),
      pickEarliestNonPlaceholderOption(validOptions)
    ]
      .map((item) => normalizeText(item))
      .filter(Boolean);
    const preferred = ranked[0] ?? "";
    if (preferred) {
      const repaired = validateAndRepairOption(field.fieldType, field.possibleAnswers, preferred, [preferred]);
      return {
        fieldId: field.fieldId,
        fieldType: field.fieldType,
        answer: repaired.answer,
        selectedOptions: repaired.selectedOptions,
        source: "deterministic_profile",
        reason: "deterministic_internship_commitment",
        locked: true
      };
    }
  }

  if (/when is your availability|availability \(eg\.|availability period|available from|internship availability/.test(label)) {
    const customAvailability =
      normalizeText(String(profile.customAnswers?.["internship availability"] ?? "")) ||
      normalizeText(String(profile.customAnswers?.availability ?? "")) ||
      normalizeText(String(profile.customAnswers?.["available from"] ?? ""));
    const answer = customAvailability || buildFutureAvailabilityRange();
    return pick(answer, "deterministic_internship_availability");
  }

  if (/citizen.*eu\/efta|country in the eu\/efta|european employment eligibility/.test(label) && field.possibleAnswers.length > 0) {
    const profileCountry =
      normalizeText(profile.country) ||
      normalizeText(String(profile.customAnswers?.["current country of residence"] ?? "")) ||
      normalizeText(String(profile.customAnswers?.["country of residence"] ?? ""));
    const yesNo = isEuOrEftaCountry(profileCountry) ? "Yes" : "No";
    const repaired = validateAndRepairOption(field.fieldType, field.possibleAnswers, yesNo, [yesNo]);
    return {
      fieldId: field.fieldId,
      fieldType: field.fieldType,
      answer: repaired.answer,
      selectedOptions: repaired.selectedOptions,
      source: "deterministic_profile",
      reason: "deterministic_eu_efta_citizenship",
      locked: true
    };
  }

  if (/authorized to work/.test(label)) {
    const yesNo = profile.workAuthorization?.authorizedToWork === false ? "No" : "Yes";
    const repaired = validateAndRepairOption(field.fieldType, field.possibleAnswers, yesNo, [yesNo]);
    return {
      fieldId: field.fieldId,
      fieldType: field.fieldType,
      answer: repaired.answer,
      selectedOptions: repaired.selectedOptions,
      source: "deterministic_profile",
      reason: "profile_work_authorization",
      locked: true
    };
  }

  if (/sponsorship|require visa|need visa/.test(label)) {
    const yesNo = profile.workAuthorization?.requiresSponsorship ? "Yes" : "No";
    const repaired = validateAndRepairOption(field.fieldType, field.possibleAnswers, yesNo, [yesNo]);
    return {
      fieldId: field.fieldId,
      fieldType: field.fieldType,
      answer: repaired.answer,
      selectedOptions: repaired.selectedOptions,
      source: "deterministic_profile",
      reason: "profile_sponsorship",
      locked: true
    };
  }

  if (/u\.?s\.? person|export control/.test(label)) {
    const usPerson = profile.exportControl?.usPerson ?? profile.workAuthorization?.usCitizen ?? profile.workAuthorization?.permanentResident;
    const yesNo = usPerson ? "Yes" : "No";
    const repaired = validateAndRepairOption(field.fieldType, field.possibleAnswers, yesNo, [yesNo]);
    return {
      fieldId: field.fieldId,
      fieldType: field.fieldType,
      answer: repaired.answer,
      selectedOptions: repaired.selectedOptions,
      source: "deterministic_profile",
      reason: "profile_export_control",
      locked: true
    };
  }

  if (/equal employment opportunity|veteran|ethnicity|race|gender|disability|self-identify/.test(label)) {
    const decline = field.possibleAnswers.find((item) => /decline|prefer not|do not wish|not to answer/i.test(item));
    if (!decline) return null;
    return {
      fieldId: field.fieldId,
      fieldType: field.fieldType,
      answer: decline,
      selectedOptions: [decline],
      source: "deterministic_profile",
      reason: "eeo_decline_fallback",
      locked: true
    };
  }

  return null;
}

export class LeverAdapter extends BaseAdapter {
  readonly platform = "lever" as const;

  canHandle(url: string): boolean {
    const normalized = url.toLowerCase();
    return normalized.includes("lever.co") || normalized.includes("lever-practice.html");
  }

  async apply(context: AdapterRunContext): Promise<JobRunResult> {
    const { page, target, config } = context;
    const result = this.baseResult(context);
    result.startedAt = new Date().toISOString();
    const executionStateByFieldId = new Map<string, FieldExecutionState>();

    try {
      const response = await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });
      await page.waitForTimeout(700);
      const status = response?.status() ?? 0;
      if ([404, 410].includes(status) || (await this.isInactivePosting(page))) {
        return this.fail(result, "inactive_or_unreachable_job:inactive_or_unreachable");
      }

      await this.openApplyFlow(page);
      await this.waitForDomSettled(page);

      let schema = await this.extractLeverSchema(page);
      if (schema.length === 0) {
        return await this.failAndFinalize(page, config.screenshotsDir, result, "unsupported_widget:no_lever_fields_discovered");
      }
      let missingRequiredDiscoveryAttempted = false;

      result.notes.push(`lever_schema_fields:${schema.length}`);

      const locationFrozenFieldIds = new Set<string>();
      let planned = await this.planAnswers(context, schema, result, false);
      await this.executeAnswers(
        context.logger,
        page,
        schema,
        planned,
        result,
        config.resumePath,
        locationFrozenFieldIds,
        executionStateByFieldId
      );

      const maxReadinessAttempts = 3;
      for (let readinessAttempt = 1; readinessAttempt <= maxReadinessAttempts; readinessAttempt += 1) {
        const readiness = await this.evaluatePreSubmitGate(
          page,
          schema,
          planned,
          locationFrozenFieldIds,
          executionStateByFieldId
        );
        if (readiness.blockerFieldIds.length === 0) break;
        if (!missingRequiredDiscoveryAttempted) {
          missingRequiredDiscoveryAttempted = true;
          const discovered = await this.discoverMissingRequiredFields(page, schema);
          if (discovered.length > 0) {
            schema = [...schema, ...discovered];
            result.notes.push(`lever_missing_required_discovered:${discovered.map((item) => item.fieldId).join(" | ")}`);
            const targetedPlan = await this.planAnswers(context, discovered, result, true);
            planned = this.mergePlannedAnswers(planned, targetedPlan);
            await this.executeAnswers(
              context.logger,
              page,
              discovered,
              targetedPlan,
              result,
              config.resumePath,
              locationFrozenFieldIds,
              executionStateByFieldId
            );
            continue;
          }
        }
        context.logger.info("lever_unknown_field_trace", {
          stage: "readiness_gate_failed",
          attempt: readinessAttempt,
          invalidFieldIds: readiness.invalidFieldIds,
          hardBlockerFieldIds: readiness.hardBlockerFieldIds,
          softConflictFieldIds: readiness.softConflictFieldIds,
          domVerifiedFieldIds: readiness.domVerifiedFieldIds,
          locationTokenMissingFieldIds: readiness.locationTokenMissingFieldIds,
          unresolvedRequiredUnknownFieldIds: readiness.unresolvedRequiredUnknownFieldIds,
          unresolvedRequiredFieldIds: readiness.unresolvedRequiredFieldIds
        });
        result.notes.push(
          `readiness_gate_failed:${readinessAttempt}:blocked=${readiness.blockerFieldIds.join(" | ")}`
        );
        for (const fieldId of readiness.blockerFieldIds) {
          const domSatisfied = readiness.domVerifiedFieldIds.includes(fieldId);
          result.notes.push(`pre_submit_dom_state:${fieldId}:${domSatisfied ? "satisfied" : "unsatisfied"}`);
        }
        for (const fieldId of readiness.locationTokenMissingFieldIds) {
          result.notes.push(`location_token_missing:${fieldId}`);
        }
        if (readiness.softConflictFieldIds.length > 0) {
          for (const fieldId of readiness.softConflictFieldIds) {
            result.notes.push(`pre_submit_soft_conflict:${fieldId}`);
            result.notes.push(`pre_submit_recovery_attempted:${fieldId}`);
          }
          const softSet = new Set(readiness.softConflictFieldIds);
          const targetedSchema = schema.filter((field) => softSet.has(field.fieldId) && field.required);
          if (targetedSchema.length > 0) {
            const targetedPlan = await this.planAnswers(context, targetedSchema, result, true);
            planned = this.mergePlannedAnswers(planned, targetedPlan);
            await this.executeAnswers(
              context.logger,
              page,
              targetedSchema,
              targetedPlan,
              result,
              config.resumePath,
              locationFrozenFieldIds,
              executionStateByFieldId
            );
          }

          const postRecovery = await this.evaluatePreSubmitGate(
            page,
            schema,
            planned,
            locationFrozenFieldIds,
            executionStateByFieldId
          );
          for (const fieldId of readiness.softConflictFieldIds) {
            const recovered = !postRecovery.softConflictFieldIds.includes(fieldId);
            result.notes.push(`pre_submit_recovery_result:${recovered ? "ok" : "fail"}:${fieldId}`);
          }

          if (postRecovery.hardBlockerFieldIds.length === 0 && postRecovery.softConflictFieldIds.length > 0) {
            result.notes.push("pre_submit_guarded_submit_allowed");
            break;
          }

          if (postRecovery.blockerFieldIds.length === 0) break;
        }

        if (readinessAttempt >= maxReadinessAttempts) {
          if (readiness.locationTokenMissingFieldIds.length > 0) {
            return await this.failAndFinalize(
              page,
              config.screenshotsDir,
              result,
              `blocked_pre_submit_location_token_missing:${readiness.locationTokenMissingFieldIds.join(" | ")}`
            );
          }
          return await this.failAndFinalize(
            page,
            config.screenshotsDir,
            result,
            `blocked_pre_submit_unresolved_required:${readiness.blockerFieldIds.join(" | ")}`
          );
        }

        const blockedSet = new Set(readiness.blockerFieldIds);
        const targetedSchema = schema.filter((field) => blockedSet.has(field.fieldId));
        if (targetedSchema.length === 0) {
          return await this.failAndFinalize(
            page,
            config.screenshotsDir,
            result,
            `blocked_pre_submit_unresolved_required:${readiness.blockerFieldIds.join(" | ")}`
          );
        }
        const targetedPlan = await this.planAnswers(context, targetedSchema, result, true);
        planned = this.mergePlannedAnswers(planned, targetedPlan);
        await this.executeAnswers(
          context.logger,
          page,
          targetedSchema,
          targetedPlan,
          result,
          config.resumePath,
          locationFrozenFieldIds,
          executionStateByFieldId
        );
      }

      if (config.mode === "dry-run") {
        result.status = "filled";
        result.answers = planned.map((item) => ({
          questionId: item.fieldId,
          value: item.fieldType === "checkbox_group" ? item.selectedOptions : item.answer,
          source: item.source === "deterministic_profile" ? "profile" : "llm",
          reason: item.reason
        }));
        return await this.finalize(page, config.screenshotsDir, result);
      }

      const maxAttempts = DEFAULT_MAX_SUBMIT_ATTEMPTS;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (await this.detectChallenge(page)) {
          return await this.failAndFinalize(page, config.screenshotsDir, result, "captcha_or_bot_challenge:challenge_detected_pre_submit");
        }

        const submitClicked = await this.clickSubmit(page);
        if (!submitClicked) {
          return await this.failAndFinalize(page, config.screenshotsDir, result, "validation_errors_after_submit:submit_button_unavailable");
        }

        result.submitted = true;
        result.submitOutcome = "pending_confirmation";

        await this.waitForDomSettled(page);
        if (await this.detectChallenge(page)) {
          return await this.failAndFinalize(page, config.screenshotsDir, result, "captcha_or_bot_challenge:challenge_detected_post_submit");
        }

        if (await this.waitForConfirmation(page, 20)) {
          result.status = "applied";
          result.submissionConfirmed = true;
          result.submitOutcome = "confirmed";
          result.answers = planned.map((item) => ({
            questionId: item.fieldId,
            value: item.fieldType === "checkbox_group" ? item.selectedOptions : item.answer,
            source: item.source === "deterministic_profile" ? "profile" : "llm",
            reason: item.reason
          }));
          return await this.finalize(page, config.screenshotsDir, result);
        }

        const failedFields = await this.extractInvalidFieldIds(page, schema, locationFrozenFieldIds);
        const unknownFailedFields = failedFields.filter((fieldId) => planned.some((item) => item.fieldId === fieldId && item.unknownField));
        if (unknownFailedFields.length > 0) {
          result.notes.push(`lever_unknown_required_best_guess_submitted:${unknownFailedFields.join(" | ")}`);
          context.logger.info("lever_unknown_field_trace", {
            stage: "submit_validation_unknown_fields",
            failedFields: unknownFailedFields,
            attempt
          });
        }
        if (failedFields.length === 0 || attempt >= maxAttempts) {
          return await this.failAndFinalize(
            page,
            config.screenshotsDir,
            result,
            "validation_errors_after_submit:submit_clicked_without_confirmation_or_recoverable_validation"
          );
        }

        result.notes.push(`lever_validation_recovery:${attempt}:failed=${failedFields.length}`);
        result.notes.push(`recovery_failed_fields:${failedFields.join(" | ")}`);
        const failedSet = new Set(failedFields);
        const targetedSchema = schema.filter((field) => failedSet.has(field.fieldId));
        const targetedPlan = await this.planAnswers(context, targetedSchema, result, true);
        planned = this.mergePlannedAnswers(planned, targetedPlan);
        await this.executeAnswers(
          context.logger,
          page,
          targetedSchema,
          targetedPlan,
          result,
          config.resumePath,
          locationFrozenFieldIds,
          executionStateByFieldId
        );
      }

      return await this.failAndFinalize(page, config.screenshotsDir, result, "validation_errors_after_submit:submit_attempts_exhausted");
    } catch (error) {
      const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
      result.error = detail;
      result.status = "failed";
      result.submitOutcome = "submit_failed";
      return await this.finalize(page, config.screenshotsDir, result);
    }
  }

  private fail(result: JobRunResult, reason: string): JobRunResult {
    result.submissionConfirmed = false;
    result.submitted = false;
    result.notes.unshift(reason);

    // Refusing to submit an application with a required question still
    // unanswered is the adapter working, not breaking. Recording it as "failed"
    // put a correct, careful run in the same bucket as a crash, hid the fact
    // that it had filled eighteen fields, and told the user Automa could not
    // handle a form it had very nearly finished. What is left is the part a
    // person has to answer, which is what the run should say.
    const blockedButFilled =
      reason.startsWith("blocked_pre_submit_") && result.filledFields.length > 0;
    result.status = blockedButFilled ? "filled" : "failed";
    if (!blockedButFilled) result.error = reason;
    if (reason.startsWith("captcha_or_bot_challenge:")) result.submitOutcome = "blocked_bot_challenge";
    else if (reason.startsWith("blocked_pre_submit_unresolved_required:")) result.submitOutcome = "blocked_pre_submit_unresolved_required";
    else if (reason.startsWith("blocked_pre_submit_location_token_missing:")) result.submitOutcome = "blocked_pre_submit_unresolved_required";
    else if (reason.startsWith("validation_errors_after_submit:")) result.submitOutcome = "validation_error";
    else if (reason.startsWith("inactive_or_unreachable_job:")) result.submitOutcome = "inactive_posting";
    else result.submitOutcome = "not_submitted";
    return result;
  }

  private async failAndFinalize(
    page: AdapterRunContext["page"],
    screenshotsDir: string,
    result: JobRunResult,
    reason: string
  ): Promise<JobRunResult> {
    this.fail(result, reason);
    return await this.finalize(page, screenshotsDir, result);
  }

  private mergePlannedAnswers(existing: PlannedAnswer[], updates: PlannedAnswer[]): PlannedAnswer[] {
    const merged = new Map(existing.map((item) => [item.fieldId, item]));
    for (const update of updates) merged.set(update.fieldId, update);
    return [...merged.values()];
  }

  private hasResolvedPlannedValue(field: LeverFieldSchema, plan: PlannedAnswer | undefined, locationFrozenFieldIds: Set<string>): boolean {
    if (!plan) return false;
    if (field.fieldType === "location_autocomplete" && locationFrozenFieldIds.has(field.fieldId)) return true;
    if (field.fieldType === "checkbox_group") return plan.selectedOptions.length > 0;
    return Boolean(normalizeText(plan.answer));
  }

  private async evaluatePreSubmitGate(
    page: AdapterRunContext["page"],
    schema: LeverFieldSchema[],
    planned: PlannedAnswer[],
    locationFrozenFieldIds: Set<string>,
    executionStateByFieldId: Map<string, FieldExecutionState>
  ): Promise<PreSubmitGateStatus> {
    const plannedById = new Map(planned.map((item) => [item.fieldId, item]));
    const unresolvedRequiredUnknownFieldIds = schema
      .filter((field) => field.required)
      .filter((field) => {
        const plan = plannedById.get(field.fieldId);
        if (!plan?.unknownField) return false;
        return !this.hasResolvedPlannedValue(field, plan, locationFrozenFieldIds);
      })
      .map((field) => field.fieldId);

    const unresolvedRequiredFieldIds = schema
      .filter((field) => field.required)
      .filter((field) => !this.hasResolvedPlannedValue(field, plannedById.get(field.fieldId), locationFrozenFieldIds))
      .map((field) => field.fieldId);

    const invalidFieldIds = await this.extractInvalidFieldIds(page, schema, locationFrozenFieldIds);
    const domStatusByFieldId = await this.collectRequiredFieldDomStatus(page, schema);
    const domVerifiedFieldIds = [...domStatusByFieldId.values()].filter((status) => status.satisfied).map((status) => status.fieldId);
    const locationTokenMissingFieldIds = [...domStatusByFieldId.values()]
      .filter((status) => !status.locationTokenValid && normalizeText(status.locationVisibleValue).length > 0)
      .map((status) => status.fieldId);
    const hardInvalidFieldIds = invalidFieldIds.filter(
      (fieldId) => !executionStateByFieldId.get(fieldId)?.verified && !domStatusByFieldId.get(fieldId)?.satisfied
    );
    const softConflictFieldIds = invalidFieldIds.filter(
      (fieldId) => Boolean(executionStateByFieldId.get(fieldId)?.verified || domStatusByFieldId.get(fieldId)?.satisfied)
    );
    const hardBlockerFieldIds = [...new Set([...hardInvalidFieldIds, ...unresolvedRequiredFieldIds])];
    const blockerFieldIds = [...new Set([...hardBlockerFieldIds, ...softConflictFieldIds])];
    return {
      blockerFieldIds,
      hardBlockerFieldIds,
      softConflictFieldIds,
      domVerifiedFieldIds,
      locationTokenMissingFieldIds,
      invalidFieldIds,
      unresolvedRequiredUnknownFieldIds,
      unresolvedRequiredFieldIds
    };
  }

  private async collectRequiredFieldDomStatus(
    page: AdapterRunContext["page"],
    schema: LeverFieldSchema[]
  ): Promise<Map<string, RequiredFieldDomStatus>> {
    const status = await page
      .evaluate((requiredFields) => {
        const normalize = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
        const isVisible = (node: Element | null): boolean => {
          if (!node || !(node instanceof HTMLElement)) return false;
          if (node.offsetParent === null && node.getClientRects().length === 0) return false;
          const style = window.getComputedStyle(node);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        };
        const out: RequiredFieldDomStatus[] = [];
        for (const field of requiredFields) {
          const selector = normalize(field.selector || "");
          if (!selector) continue;
          const nodes = Array.from(document.querySelectorAll(selector)).filter((node) => {
            if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement)) return false;
            if ((node as HTMLInputElement).type === "hidden") return false;
            if (normalize(node.getAttribute("aria-hidden")).toLowerCase() === "true") return false;
            if ((node as HTMLInputElement).disabled) return false;
            return isVisible(node);
          }) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
          if (nodes.length === 0) continue;
          const first = nodes[0];
          if (!first) continue;
          const ariaInvalid = normalize(first.getAttribute("aria-invalid"));
          const valueMissing = first.validity?.valueMissing ?? false;
          let checkedCount = 0;
          let hasValue = false;
          let locationVisibleValue = "";
          let locationHiddenValue = "";
          let locationTokenValid = false;
          if (field.fieldType === "radio" || field.fieldType === "checkbox_group") {
            checkedCount = nodes.filter((node) => node instanceof HTMLInputElement && node.checked).length;
          } else if (field.fieldType === "location_autocomplete") {
            const input = first as HTMLInputElement;
            locationVisibleValue = normalize(input.value);
            const container = input.closest("[data-qa='structured-contact-location-question'], li.application-question, .application-question");
            const hidden =
              (container?.querySelector("#selected-location, input[name='selectedLocation']") as HTMLInputElement | null) ||
              (document.querySelector("#selected-location, input[name='selectedLocation']") as HTMLInputElement | null);
            locationHiddenValue = normalize(hidden?.value || "");
            hasValue = locationVisibleValue.length > 0;
            try {
              const parsed = JSON.parse(locationHiddenValue) as Record<string, unknown>;
              const name = normalize(parsed?.name ?? "").toLowerCase();
              locationTokenValid = Boolean(name && !/no location found|select location|type to search/.test(name));
            } catch {
              locationTokenValid = false;
            }
          } else {
            hasValue = nodes.some((node) => normalize(node.value).length > 0);
          }
          const satisfied =
            field.fieldType === "radio" || field.fieldType === "checkbox_group"
              ? checkedCount > 0
              : field.fieldType === "location_autocomplete"
                ? locationTokenValid
              : hasValue && !valueMissing;
          out.push({
            fieldId: field.fieldId,
            satisfied,
            checkedCount,
            activeCount: nodes.length,
            hasValue,
            ariaInvalid,
            valueMissing,
            locationVisibleValue,
            locationHiddenValue,
            locationTokenValid
          });
        }
        return out;
      }, schema.filter((field) => field.required).map((field) => ({ fieldId: field.fieldId, fieldType: field.fieldType, selector: field.selectorHints.selector })))
      .catch(() => [] as RequiredFieldDomStatus[]);
    return new Map(status.map((item) => [item.fieldId, item]));
  }

  private async finalize(page: AdapterRunContext["page"], screenshotsDir: string, result: JobRunResult): Promise<JobRunResult> {
    const screenshotPath = path.join(screenshotsDir, `lever-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    result.screenshotPaths.push(screenshotPath);
    result.finishedAt = new Date().toISOString();
    return result;
  }

  private async openApplyFlow(page: AdapterRunContext["page"]): Promise<void> {
    if (/\/apply(?:\?|$)/i.test(page.url())) return;
    const button = page
      .locator("button, a")
      .filter({ hasText: /apply|easy apply|start application|apply now/i })
      .first();
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }

  private async isInactivePosting(page: AdapterRunContext["page"]): Promise<boolean> {
    const text = await page
      .locator("body")
      .innerText()
      .then((value) => normalizeText(value).toLowerCase())
      .catch(() => "");
    return INACTIVE_POSTING_TEXT_PATTERNS.some((item) => text.includes(item));
  }

  private async waitForDomSettled(page: AdapterRunContext["page"]): Promise<void> {
    await page.waitForTimeout(500);
  }

  private async detectChallenge(page: AdapterRunContext["page"]): Promise<boolean> {
    for (const selector of CHALLENGE_SELECTORS) {
      const locator = page.locator(selector).first();
      const exists = (await locator.count().catch(() => 0)) > 0;
      if (!exists) continue;
      const visible = await locator.isVisible().catch(() => false);
      if (visible) return true;
      if (selector.includes("h-captcha-response") || selector.includes("g-recaptcha-response")) {
        const required = (await locator.getAttribute("required").catch(() => null)) !== null;
        const value = await locator.inputValue().catch(() => "");
        if (required && !normalizeText(value)) return true;
      }
    }
    return false;
  }

  private async clickSubmit(page: AdapterRunContext["page"]): Promise<boolean> {
    const candidates = [
      page.locator("#btn-submit").first(),
      page.locator("[data-qa='btn-submit']").first(),
      page.locator("button[type='submit']").first(),
      page.locator("button").filter({ hasText: /submit|send application|finish application/i }).first()
    ];
    for (const candidate of candidates) {
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;
      const disabled = await candidate.isDisabled().catch(() => false);
      if (disabled) continue;
      await candidate.click().catch(() => undefined);
      return true;
    }
    return false;
  }

  private async waitForConfirmation(page: AdapterRunContext["page"], seconds: number): Promise<boolean> {
    for (let i = 0; i < seconds; i += 1) {
      const url = page.url().toLowerCase();
      if (url.includes("thank") || url.includes("submitted")) return true;
      const text = await page
        .locator("body")
        .innerText()
        .then((value) => value.toLowerCase())
        .catch(() => "");
      if (
        text.includes("thank you") ||
        text.includes("application submitted") ||
        text.includes("we've received your application") ||
        text.includes("received your application")
      ) {
        return true;
      }
      await page.waitForTimeout(1000);
    }
    return false;
  }

  private async extractLeverSchema(page: AdapterRunContext["page"]): Promise<LeverFieldSchema[]> {
    type RawField = Omit<LeverFieldSchema, "possibleAnswers" | "currentValue"> & {
      possibleAnswers: string[];
      currentValue: string | string[] | null;
    };

    const raw = await page
      .evaluate((selectors) => {
        const normalize = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
        const isPlaceholder = (value: string): boolean => {
          const normalized = normalize(value).toLowerCase();
          if (!normalized) return true;
          if (/^select(\.\.\.)?$/.test(normalized)) return true;
          if (/^choose\b/.test(normalized)) return true;
          if (/^please select\b/.test(normalized)) return true;
          if (/priority will be given/.test(normalized)) return true;
          return false;
        };
        const asSelector = (el: Element): string => {
          const id = normalize(el.getAttribute("id"));
          // Lever names its fields cards[<card>][field0]. Those brackets make
          // "#cards[work_auth][field0]" an invalid CSS selector, so every
          // control with a bracketed id silently failed to resolve and the
          // pre-submit readiness gate then blocked the run. Use the attribute
          // form, which needs no escaping.
          if (id) return `${el.tagName.toLowerCase()}[id="${id.replace(/"/g, '\\"')}"]`;
          const name = normalize(el.getAttribute("name"));
          const tag = el.tagName.toLowerCase();
          if (name) return `${tag}[name=\"${name.replace(/"/g, '\\"')}\"]`;
          return tag;
        };
        const asContainerSelector = (el: Element): string => {
          const id = normalize(el.getAttribute("id"));
          if (id) return `#${id}`;
          const cardName = normalize((el.querySelector("input[name]") as HTMLInputElement | null)?.name);
          if (cardName) return `li.application-question input[name=\"${cardName.replace(/"/g, '\\"')}\"]`;
          return "li.application-question";
        };
        const containerList: Element[] = [];
        for (const selector of selectors) {
          for (const node of Array.from(document.querySelectorAll(selector))) {
            if (!containerList.includes(node)) containerList.push(node);
          }
        }

        const out: RawField[] = [];
        let idx = 0;
        for (const container of containerList) {
          const sectionTitle =
            normalize(container.closest("section")?.querySelector("h1,h2,h3,h4,legend")?.textContent) ||
            normalize(container.closest("fieldset")?.querySelector("legend")?.textContent) ||
            "Application";

          const questionTitle =
            normalize(container.querySelector(".application-label,.application-question-title,label,legend,h3,h4")?.textContent) || "";

          const controls = Array.from(
            container.querySelectorAll("input, textarea, select")
          ).filter((node) => node instanceof HTMLElement) as HTMLElement[];
          const titleRequired = /(^|\\s)\\*(\\s|$)/.test(questionTitle) || /required/i.test(questionTitle);
          const containerRequiredMarker = Boolean(container.querySelector(".required,[aria-required='true']"));
          const containerSelector = asContainerSelector(container);

          for (const control of controls) {
            const tag = control.tagName.toLowerCase();
            const type = normalize(control.getAttribute("type")).toLowerCase();
            const name = normalize(control.getAttribute("name"));
            const id = normalize(control.getAttribute("id"));
            const dataQa = normalize(control.getAttribute("data-qa"));
            const required = control.hasAttribute("required") || control.getAttribute("aria-required") === "true";
            const label =
              questionTitle ||
              normalize((id && document.querySelector(`label[for=\"${id}\"]`)?.textContent) || "") ||
              normalize(control.getAttribute("aria-label")) ||
              normalize(control.getAttribute("placeholder")) ||
              name ||
              id ||
              `field_${idx}`;

            const trulyRequired = required || titleRequired || containerRequiredMarker;

            let fieldType: LeverFieldType = "unknown";
            if (type === "hidden") fieldType = "hidden";
            else if (type === "file" || /resume/i.test(name) || dataQa === "input-resume") fieldType = "file";
            else if (dataQa === "email-input" || type === "email") fieldType = "email";
            else if (dataQa === "phone-input" || type === "tel") fieldType = "phone";
            else if (tag === "textarea") fieldType = "textarea";
            else if (tag === "select") fieldType = "select";
            else if (type === "radio") fieldType = "radio";
            else if (type === "checkbox") fieldType = "checkbox_group";
            else if (
              container.matches("[data-qa='structured-contact-location-question']") ||
              dataQa === "location-input" ||
              (control.classList?.contains("location-input") ?? false) ||
              id === "selected-location"
            ) {
              fieldType = "location_autocomplete";
            } else if (type === "text") fieldType = "text";

            const possibleAnswers: string[] = [];
            if (fieldType === "select") {
              for (const option of Array.from((control as HTMLSelectElement).options)) {
                const optValue = normalize(option.value);
                const optText = normalize(option.textContent || option.value);
                if (!optText) continue;
                if (!optValue) continue;
                if (isPlaceholder(optText) || isPlaceholder(optValue)) continue;
                possibleAnswers.push(optText);
              }
            }

            if (fieldType === "radio" || fieldType === "checkbox_group") {
              const groupName = name;
              const group = groupName
                ? Array.from(document.querySelectorAll(`input[name=\"${groupName.replace(/"/g, '\\"')}\"]`))
                : [control];
              for (const node of group) {
                const value = normalize(node.getAttribute("value"));
                const parentText = normalize(node.closest("label,.application-answer-alternative")?.textContent);
                const candidate = value || parentText;
                if (candidate) possibleAnswers.push(candidate);
              }
            }

            let currentValue: string | string[] | null = null;
            if (fieldType === "checkbox_group") {
              const groupName = name;
              const checked = groupName
                ? Array.from(document.querySelectorAll(`input[type=\"checkbox\"][name=\"${groupName.replace(/"/g, '\\"')}\"]:checked`))
                : [];
              currentValue = checked.map((item) => normalize(item.getAttribute("value") || item.closest("label")?.textContent));
            } else if (fieldType === "radio") {
              const groupName = name;
              const selected = groupName
                ? (document.querySelector(`input[type=\"radio\"][name=\"${groupName.replace(/"/g, '\\"')}\"]:checked`) as HTMLInputElement | null)
                : null;
              currentValue = normalize(selected?.value || selected?.closest("label")?.textContent || "") || null;
            } else if (tag === "input" || tag === "textarea" || tag === "select") {
              currentValue = normalize((control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value) || null;
            }

            const selector = asSelector(control);
            const card = container.closest("[data-qa='additional-cards']") ? "additional_cards" : "default";

            out.push({
              fieldId: `${name || id || `field_${idx}`}`,
              label,
              sectionTitle,
              required: trulyRequired,
              fieldType,
              possibleAnswers: [...new Set(possibleAnswers.map((item) => normalize(item)).filter(Boolean))],
              currentValue,
              fieldKind: fieldType === "select" ? "native_select" : undefined,
              selectorHints: {
                name: name || undefined,
                dataQa: dataQa || undefined,
                inputId: id || undefined,
                selector,
                cardKey: card,
                groupName: name || undefined,
                containerSelector
              },
              htmlSummary: {
                tag,
                type,
                containerClass: container.className,
                selector
              }
            });
            idx += 1;
          }

          const hasActiveNativeControl = controls.some((node) => {
            const input = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
            if (input.disabled) return false;
            if ((input as HTMLInputElement).type === "hidden") return false;
            const style = window.getComputedStyle(input);
            if (style.display === "none" || style.visibility === "hidden") return false;
            return true;
          });
          if (!hasActiveNativeControl && (titleRequired || containerRequiredMarker)) {
            const hiddenControls = Array.from(container.querySelectorAll("input[type='hidden'][name], input[type='hidden'][id]")) as HTMLInputElement[];
            const identity =
              hiddenControls.find((item) => /cards\[[^\]]+\]\[field\d+\]/i.test(normalize(item.name))) ||
              hiddenControls.find((item) => normalize(item.name)) ||
              hiddenControls.find((item) => normalize(item.id));
            const identityName = normalize(identity?.name);
            const identityId = normalize(identity?.id);
            if (identityName || identityId) {
              const trigger = (container.querySelector("[role='combobox'], [aria-haspopup='listbox'], .select__control, .dropdown-trigger, .dropdown-selection, button") ||
                container.querySelector("input[readonly], div[tabindex]")) as HTMLElement | null;
              const triggerSelector = trigger ? asSelector(trigger) : undefined;
              const optionSelector = "[role='option'], .dropdown-results li, .dropdown-results [role='menuitem'], .dropdown-results button, ul li";
              const possibleAnswers = Array.from(container.querySelectorAll(optionSelector))
                .map((node) => normalize(node.textContent))
                .filter((text) => text && !isPlaceholder(text));
              const selectedText = normalize(
                (container.querySelector("[aria-selected='true'], [data-selected='true'], .selected, .is-selected") as HTMLElement | null)?.textContent
              );
              const hiddenValue = normalize(identity?.value || "");
              out.push({
                fieldId: identityName || identityId || `field_${idx}`,
                label:
                  questionTitle ||
                  identityName ||
                  identityId ||
                  `field_${idx}`,
                sectionTitle,
                required: true,
                fieldType: "select",
                possibleAnswers: [...new Set(possibleAnswers)],
                currentValue: selectedText || hiddenValue || null,
                fieldKind: "custom_select",
                selectorHints: {
                  name: identityName || undefined,
                  inputId: identityId || undefined,
                  selector: identity ? asSelector(identity) : undefined,
                  cardKey: container.closest("[data-qa='additional-cards']") ? "additional_cards" : "default",
                  groupName: identityName || undefined,
                  containerSelector,
                  customTriggerSelector: triggerSelector,
                  customOptionSelector: optionSelector,
                  customSelectedValueSelector: "[aria-selected='true'], [data-selected='true'], .selected, .is-selected"
                },
                htmlSummary: {
                  extractionSource: "required_container_fallback",
                  containerClass: container.className,
                  optionCount: possibleAnswers.length
                }
              });
              idx += 1;
            }
          }
        }

        return out;
      }, LEVER_CONTAINER_SELECTORS)
      .catch(() => [] as RawField[]);

    const templateFields = await this.extractTemplateFields(page);
    const merged = raw.map((field) => {
      const template = templateFields.find((item) => {
        const sameCard = !item.cardKey || item.cardKey === field.selectorHints.cardKey;
        const labelMatch = normalizeText(item.label).toLowerCase() === normalizeText(field.label).toLowerCase();
        const nameMatch = normalizeText(field.selectorHints.name || "").toLowerCase().includes(`field${item.fieldIndex + 1}`);
        return sameCard && (labelMatch || nameMatch);
      });
      if (!template) return field;

      return {
        ...field,
        label: field.label || template.label,
        required: field.required || template.required,
        fieldType: field.fieldType === "unknown" ? template.fieldType : field.fieldType,
        possibleAnswers:
          field.possibleAnswers.length > 0
            ? field.possibleAnswers
            : template.options
      };
    });

    const deduped = new Map<string, LeverFieldSchema>();
    for (const item of merged) {
      if (item.fieldType === "hidden") continue;
      const key = `${item.fieldId}::${item.selectorHints.selector || ""}`;
      if (!deduped.has(key)) deduped.set(key, item);
    }
    return [...deduped.values()];
  }

  private async discoverMissingRequiredFields(
    page: AdapterRunContext["page"],
    schema: LeverFieldSchema[]
  ): Promise<LeverFieldSchema[]> {
    const existing = new Set(
      schema.flatMap((field) =>
        [
          normalizeText(field.fieldId).toLowerCase(),
          normalizeText(field.selectorHints.name || "").toLowerCase(),
          normalizeText(field.selectorHints.inputId || "").toLowerCase(),
          normalizeText(field.selectorHints.groupName || "").toLowerCase()
        ].filter(Boolean)
      )
    );
    const requiredKeys = await page
      .evaluate(() => {
        const normalize = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
        const keys = new Set<string>();
        const containers = Array.from(document.querySelectorAll("li.application-question, li.application-question.custom-question, .application-question"));
        for (const container of containers) {
          const label = normalize(container.querySelector(".application-label,.application-question-title,label,legend,h3,h4")?.textContent || "");
          const isRequired = /(^|\s)\*(\s|$)/.test(label) || /required/.test(label) || Boolean(container.querySelector(".required,[aria-required='true']"));
          if (!isRequired) continue;
          const hidden = Array.from(container.querySelectorAll("input[type='hidden'][name], input[type='hidden'][id]")) as HTMLInputElement[];
          for (const item of hidden) {
            const key = normalize(item.name || item.id || "");
            if (key) keys.add(key);
          }
        }
        return [...keys];
      })
      .catch(() => [] as string[]);
    const missingKeys = requiredKeys.filter((key) => !existing.has(key));
    if (missingKeys.length === 0) return [];

    const refreshed = await this.extractLeverSchema(page);
    return refreshed.filter((field) => {
      if (!field.required) return false;
      const keys = [
        normalizeText(field.fieldId).toLowerCase(),
        normalizeText(field.selectorHints.name || "").toLowerCase(),
        normalizeText(field.selectorHints.inputId || "").toLowerCase(),
        normalizeText(field.selectorHints.groupName || "").toLowerCase()
      ].filter(Boolean);
      return keys.some((key) => missingKeys.includes(key)) && !existing.has(normalizeText(field.fieldId).toLowerCase());
    });
  }

  private async extractTemplateFields(page: AdapterRunContext["page"]): Promise<LeverTemplateField[]> {
    const rows = await page
      .locator("input[name*='[baseTemplate]']")
      .evaluateAll((nodes) => {
        const normalize = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
        return nodes.map((node, idx) => ({
          name: normalize(node.getAttribute("name")),
          value: normalize((node as HTMLInputElement).value),
          cardKey: `card_${idx}`
        }));
      })
      .catch(() => [] as Array<{ name: string; value: string; cardKey: string }>);

    return rows.flatMap((item) => parseLeverBaseTemplateJson(item.value, item.cardKey));
  }

  private async planAnswers(
    context: AdapterRunContext,
    schema: LeverFieldSchema[],
    result: JobRunResult,
    recoveryMode: boolean
  ): Promise<PlannedAnswer[]> {
    const planned = new Map<string, PlannedAnswer>();
    for (const field of schema) {
      const deterministic = resolveDeterministicProfileValue(field, context.profile, context.config.resumePath);
      if (deterministic) {
        if (deterministic.reason === "deterministic_disability_date") {
          result.notes.push(`deterministic_disability_date:${field.fieldId}:${deterministic.answer ?? "none"}`);
        }
        if (deterministic.reason === "deterministic_semester_pick") {
          result.notes.push(`deterministic_semester_pick:${field.fieldId}:${deterministic.answer ?? deterministic.selectedOptions.join(",")}`);
        }
        planned.set(field.fieldId, deterministic);
      }
    }

    const unresolved = schema.filter((field) => !planned.has(field.fieldId));
    if (unresolved.length === 0) return [...planned.values()];

    for (const field of unresolved) {
      context.logger.info("lever_unknown_field_trace", {
        stage: "extracted",
        fieldId: field.fieldId,
        label: field.label,
        fieldType: field.fieldType,
        required: field.required,
        optionsCount: field.possibleAnswers.length,
        recoveryMode
      });
    }

    const questions: ApplicationQuestion[] = unresolved.map((field) => ({
      id: field.fieldId,
      label: field.label,
      type:
        field.fieldType === "textarea"
          ? "textarea"
          : field.fieldType === "radio" || field.fieldType === "select"
            ? "single_select"
            : field.fieldType === "checkbox_group"
              ? "multi_select"
              : field.fieldType === "file"
                ? "file"
                : "text",
      required: field.required,
      options: field.possibleAnswers.length ? field.possibleAnswers : undefined,
      platformMeta: {
        platform: "lever",
        sectionTitle: field.sectionTitle,
        fieldType: field.fieldType,
        possibleAnswers: field.possibleAnswers,
        strictOptionConstraint: field.possibleAnswers.length > 0,
        recoveryMode
      }
    }));

    let resolved: ResolvedAnswer[] = [];
    try {
      resolved = await context.aiEngine.resolve(questions, {
        profile: context.profile,
        resumeText: context.resumeText,
        jobTitle: context.target.jobTitle,
        company: context.target.company,
        companyContext: [
          "Return JSON-compatible values only.",
          "When possibleAnswers/options are provided, choose only from those options.",
          "Do not invent options.",
          "Radio/select: choose exactly one option.",
          "Checkbox groups: choose one or more options."
        ].join(" "),
        platform: "lever"
      });
    } catch {
      resolved = [];
    }

    const byId = new Map(resolved.map((item) => [item.questionId, item]));
    const needsRetry: LeverFieldSchema[] = [];
    const retryReasons = new Map<string, string>();

    for (const field of unresolved) {
      const candidate = byId.get(field.fieldId);
      const rawAnswer = candidate?.value;
      context.logger.info("lever_unknown_field_trace", {
        stage: "llm_raw",
        fieldId: field.fieldId,
        label: field.label,
        rawAnswer,
        llmReason: candidate?.reason ?? ""
      });

      let answer: string | null = null;
      let selectedOptions: string[] = [];
      if (Array.isArray(rawAnswer)) {
        selectedOptions = rawAnswer.map((item) => normalizeText(item)).filter(Boolean);
      } else if (typeof rawAnswer === "boolean") {
        answer = rawAnswer ? "Yes" : "No";
      } else if (rawAnswer !== null && rawAnswer !== undefined) {
        answer = normalizeText(rawAnswer);
      }

      const repaired = validateAndRepairOption(field.fieldType, field.possibleAnswers, answer, selectedOptions);
      const strictOptionField = field.possibleAnswers.length > 0 && (field.fieldType === "select" || field.fieldType === "radio" || field.fieldType === "checkbox_group");
      const requiredNarrativeOrTextField =
        field.required &&
        field.possibleAnswers.length === 0 &&
        (field.fieldType === "textarea" || field.fieldType === "text");
      const missingAfterRepair =
        field.fieldType === "checkbox_group"
          ? repaired.selectedOptions.length === 0
          : !normalizeText(repaired.answer || "");
      if ((strictOptionField || requiredNarrativeOrTextField) && missingAfterRepair) {
        needsRetry.push(field);
        retryReasons.set(
          field.fieldId,
          strictOptionField ? "option_not_in_visible_choices" : "required_text_or_narrative_missing"
        );
      }

      planned.set(field.fieldId, {
        fieldId: field.fieldId,
        fieldType: field.fieldType,
        answer: repaired.answer,
        selectedOptions: repaired.selectedOptions,
        source: "llm_inference",
        reason: candidate?.reason || (recoveryMode ? "llm_recovery" : "llm_unresolved"),
        locked: false,
        unknownField: true,
        rawLlmValue: rawAnswer ?? null
      });
      context.logger.info("lever_unknown_field_trace", {
        stage: "normalized",
        fieldId: field.fieldId,
        label: field.label,
        normalizedAnswer: repaired.answer,
        normalizedSelections: repaired.selectedOptions
      });
    }

    if (needsRetry.length > 0) {
      const retryQuestions: ApplicationQuestion[] = needsRetry.map((field) => ({
        id: field.fieldId,
        label: field.label,
        type:
          field.fieldType === "textarea"
            ? "textarea"
            : field.fieldType === "radio" || field.fieldType === "select"
              ? "single_select"
              : field.fieldType === "checkbox_group"
                ? "multi_select"
                : field.fieldType === "file"
                  ? "file"
                  : "text",
        required: field.required,
        options: field.possibleAnswers.length ? field.possibleAnswers : undefined,
        platformMeta: {
          platform: "lever",
          sectionTitle: field.sectionTitle,
          fieldType: field.fieldType,
          possibleAnswers: field.possibleAnswers,
          strictOptionConstraint: true,
          recoveryMode
        }
      }));
      let retryResolved: ResolvedAnswer[] = [];
      try {
        retryResolved = await context.aiEngine.resolve(retryQuestions, {
          profile: context.profile,
          resumeText: context.resumeText,
          jobTitle: context.target.jobTitle,
          company: context.target.company,
          companyContext: [
            "Previous answer was invalid for available options.",
            "Return ONLY options visible in possibleAnswers/options.",
            "Do not output placeholders.",
            "For checkbox groups, choose at least one relevant option."
          ].join(" "),
          platform: "lever"
        });
      } catch {
        retryResolved = [];
      }

      const retryById = new Map(retryResolved.map((item) => [item.questionId, item]));
      for (const field of needsRetry) {
        const retryCandidate = retryById.get(field.fieldId);
        const rawRetry = retryCandidate?.value;
        context.logger.info("lever_unknown_field_trace", {
          stage: "llm_retry_raw",
          fieldId: field.fieldId,
          label: field.label,
          rawAnswer: rawRetry,
          retryHint: retryReasons.get(field.fieldId) ?? ""
        });
        let answer: string | null = null;
        let selectedOptions: string[] = [];
        if (Array.isArray(rawRetry)) selectedOptions = rawRetry.map((item) => normalizeText(item)).filter(Boolean);
        else if (typeof rawRetry === "boolean") answer = rawRetry ? "Yes" : "No";
        else if (rawRetry !== null && rawRetry !== undefined) answer = normalizeText(rawRetry);
        const repairedRetry = validateAndRepairOption(field.fieldType, field.possibleAnswers, answer, selectedOptions);
        const current = planned.get(field.fieldId);
        const improved =
          field.fieldType === "checkbox_group"
            ? repairedRetry.selectedOptions.length > 0
            : Boolean(repairedRetry.answer);
        if (current && improved) {
          planned.set(field.fieldId, {
            ...current,
            answer: repairedRetry.answer,
            selectedOptions: repairedRetry.selectedOptions,
            reason: retryCandidate?.reason || "llm_retry_repaired",
            rawLlmValue: rawRetry ?? current.rawLlmValue
          });
        }
        context.logger.info("lever_unknown_field_trace", {
          stage: "llm_retry_normalized",
          fieldId: field.fieldId,
          label: field.label,
          normalizedAnswer: repairedRetry.answer,
          normalizedSelections: repairedRetry.selectedOptions
        });
      }
    }

    for (const field of unresolved) {
      const current = planned.get(field.fieldId);
      if (!current) continue;
      const missing =
        field.fieldType === "checkbox_group"
          ? current.selectedOptions.length === 0
          : !normalizeText(current.answer || "");
      if (field.required && field.possibleAnswers.length > 0 && missing) {
        const bestGuess = bestGuessOptionRepairForRequiredUnknown(field);
        const upgraded =
          field.fieldType === "checkbox_group"
            ? bestGuess.selectedOptions.length > 0
            : Boolean(bestGuess.answer);
        if (upgraded) {
          planned.set(field.fieldId, {
            ...current,
            answer: bestGuess.answer,
            selectedOptions: bestGuess.selectedOptions,
            reason: "unknown_required_best_guess_option",
            locked: false
          });
          context.logger.info("lever_unknown_field_trace", {
            stage: "best_guess_option_fallback",
            fieldId: field.fieldId,
            label: field.label,
            answer: bestGuess.answer,
            selections: bestGuess.selectedOptions
          });
        }
      }
    }

    result.notes.push(`lever_answer_plan:deterministic=${[...planned.values()].filter((item) => item.source === "deterministic_profile").length}:llm=${[...planned.values()].filter((item) => item.source === "llm_inference").length}`);
    return [...planned.values()];
  }

  private async executeAnswers(
    logger: AdapterRunContext["logger"],
    page: AdapterRunContext["page"],
    schema: LeverFieldSchema[],
    planned: PlannedAnswer[],
    result: JobRunResult,
    resumePath?: string,
    locationFrozenFieldIds: Set<string> = new Set<string>(),
    executionStateByFieldId: Map<string, FieldExecutionState> = new Map<string, FieldExecutionState>()
  ): Promise<void> {
    const byId = new Map(planned.map((item) => [item.fieldId, item]));
    for (const field of schema) {
      const plan = byId.get(field.fieldId);
      if (!plan) continue;
      const isLlmNarrativeTextarea = field.fieldType === "textarea" && plan.source === "llm_inference";
      if (isLlmNarrativeTextarea && plan.answer) {
        const telemetry = buildTelemetryPreview(plan.answer);
        logger.info("lever_unknown_field_trace", {
          stage: "narrative_planned",
          fieldId: field.fieldId,
          label: field.label,
          reason: plan.reason,
          charCount: telemetry.charCount,
          preview: telemetry.preview
        });
      }
      if (plan.unknownField) {
        logger.info("lever_unknown_field_trace", {
          stage: "execution_attempt",
          fieldId: field.fieldId,
          label: field.label,
          fieldType: field.fieldType,
          answer: plan.answer,
          selections: plan.selectedOptions
        });
      }
      const ok = await this.executeField(page, field, plan, resumePath, locationFrozenFieldIds);
      const verified = ok ? await this.verifyFieldValue(page, field, plan, locationFrozenFieldIds) : false;
      executionStateByFieldId.set(field.fieldId, {
        fieldId: field.fieldId,
        applied: ok,
        verified,
        lastVerifiedAt: verified ? new Date().toISOString() : null
      });
      if (isLlmNarrativeTextarea) {
        const selector = field.selectorHints.selector;
        const committedValue = selector
          ? await page.locator(selector).first().inputValue().catch(() => "")
          : "";
        const telemetry = buildTelemetryPreview(committedValue || plan.answer || "");
        logger.info("lever_unknown_field_trace", {
          stage: ok ? "narrative_committed" : "narrative_execution_failed",
          fieldId: field.fieldId,
          label: field.label,
          success: ok,
          charCount: telemetry.charCount,
          preview: telemetry.preview
        });
      }
      if (plan.unknownField) {
        logger.info("lever_unknown_field_trace", {
          stage: "execution_result",
          fieldId: field.fieldId,
          label: field.label,
          success: ok,
          verified
        });
      }
      if (!ok) continue;
      result.filledFields.push({
        id: field.fieldId,
        label: field.label,
        value: field.fieldType === "checkbox_group" ? plan.selectedOptions.join(", ") : plan.answer || "",
        source: plan.source === "deterministic_profile" ? "profile" : "llm",
        inputKind: field.fieldType
      });
    }
  }

  private async executeField(
    page: AdapterRunContext["page"],
    field: LeverFieldSchema,
    plan: PlannedAnswer,
    resumePath?: string,
    locationFrozenFieldIds: Set<string> = new Set<string>()
  ): Promise<boolean> {
    const selector = field.selectorHints.selector;
    if (!selector) return false;
    const locator = page.locator(selector).first();

    if (field.fieldType === "file") {
      const filePath = normalizeText(plan.answer || resumePath || "");
      if (!filePath) return false;
      await locator.setInputFiles(filePath).catch(() => undefined);
      const attached = await page
        .evaluate((sel) => {
          const input = document.querySelector(sel) as HTMLInputElement | null;
          if (!input) return false;
          if (input.files && input.files.length > 0) return true;
          const success = document.querySelector(".resume-upload-success,.filename");
          if (success) return true;
          const hiddenResume = document.querySelector("input[name*='resumeStorageId']") as HTMLInputElement | null;
          return Boolean(hiddenResume?.value);
        }, selector)
        .catch(() => false);
      return attached;
    }

    if (field.fieldType === "textarea") {
      if (!plan.answer) return false;
      // fill() can fail silently on a control the page has disabled or covered.
      // Returning true regardless recorded an answer that was never typed.
      await locator.fill(plan.answer).catch(() => undefined);
      return this.textValueLanded(locator, plan.answer);
    }

    if (field.fieldType === "location_autocomplete") {
      if (locationFrozenFieldIds.has(field.fieldId)) return true;
      const query = normalizeText(plan.answer || "");
      if (!query) return false;
      const applied = await this.setLeverLocation(page, selector, query);
      if (applied) locationFrozenFieldIds.add(field.fieldId);
      return applied;
    }

    if (field.fieldType === "radio") {
      const target = normalizeText(plan.answer || plan.selectedOptions[0] || "");
      if (!target) return false;
      const group = field.selectorHints.groupName
        ? page.locator(`input[type='radio'][name="${field.selectorHints.groupName.replace(/"/g, '\\"')}"]`)
        : page.locator(selector);
      const count = await group.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const option = group.nth(i);
        const value = normalizeText(await option.getAttribute("value").catch(() => ""));
        const label = normalizeText(await option.locator("xpath=ancestor::label[1]").innerText().catch(() => ""));
        if ([value, label].some((item) => item && (item.toLowerCase() === target.toLowerCase() || item.toLowerCase().includes(target.toLowerCase())))) {
          // Was: check() falling back to click(), both unbounded, and then
          // "return true" regardless of whether either landed -- so a radio
          // Lever had hidden behind a styled label reported as filled while
          // staying empty.
          const id = await option.getAttribute("id").catch(() => "");
          return this.toggleChoiceInput(page, option, id || "", false);
        }
      }
      return false;
    }

    if (field.fieldType === "checkbox_group") {
      const picks = plan.selectedOptions;
      if (picks.length === 0) return false;
      const group = field.selectorHints.groupName
        ? page.locator(`input[type='checkbox'][name="${field.selectorHints.groupName.replace(/"/g, '\\"')}"]`)
        : page.locator(selector);
      const count = await group.count().catch(() => 0);
      let selected = 0;
      for (let i = 0; i < count; i += 1) {
        const option = group.nth(i);
        const value = normalizeText(await option.getAttribute("value").catch(() => ""));
        const label = normalizeText(await option.locator("xpath=ancestor::label[1]").innerText().catch(() => ""));
        const shouldPick = picks.some((pick) => {
          const normalized = pick.toLowerCase();
          return [value, label].some((item) => item && (item.toLowerCase() === normalized || item.toLowerCase().includes(normalized)));
        });
        if (shouldPick) {
          const id = await option.getAttribute("id").catch(() => "");
          if (await this.toggleChoiceInput(page, option, id || "", true)) selected += 1;
        }
      }
      return selected > 0;
    }

    if (field.fieldType === "select") {
      if (field.fieldKind === "custom_select") {
        return await this.executeCustomSelect(page, field, plan);
      }
      const target = normalizeText(plan.answer || plan.selectedOptions[0] || "");
      if (!target) return false;
      const selected = await locator.selectOption({ label: target }).catch(() => null);
      if (selected && selected.length > 0) return true;
      const selectedByValue = await locator.selectOption({ value: target }).catch(() => null);
      return Boolean(selectedByValue && selectedByValue.length > 0);
    }

    if (["text", "email", "phone", "unknown"].includes(field.fieldType)) {
      if (!plan.answer) return false;
      await locator.fill(plan.answer).catch(() => undefined);
      return this.textValueLanded(locator, plan.answer);
    }

    return false;
  }

  /**
   * Whether the value is actually in the control now.
   *
   * The point of reading it back is that an application which reports a field
   * as filled, and submits without it, costs the user the job rather than a
   * retry. Some fields normalise what they were given -- a phone control may
   * reformat -- so a prefix or containment counts, but empty never does.
   */
  private async textValueLanded(
    locator: ReturnType<AdapterRunContext["page"]["locator"]>,
    expected: string
  ): Promise<boolean> {
    const actual = await locator.inputValue().catch(() => "");
    if (!actual) return false;
    const a = normalizeText(actual).toLowerCase();
    const b = normalizeText(expected).toLowerCase();
    return a === b || a.includes(b) || b.includes(a);
  }

  private async verifyFieldValue(
    page: AdapterRunContext["page"],
    field: LeverFieldSchema,
    plan: PlannedAnswer,
    locationFrozenFieldIds: Set<string>
  ): Promise<boolean> {
    const selector = field.selectorHints.selector;
    if (!selector) return false;
    const locator = page.locator(selector).first();

    if (field.fieldType === "location_autocomplete") {
      return locationFrozenFieldIds.has(field.fieldId);
    }
    if (field.fieldType === "file") {
      return true;
    }
    if (field.fieldType === "textarea" || field.fieldType === "text" || field.fieldType === "email" || field.fieldType === "phone" || field.fieldType === "unknown") {
      const actual = normalizeText(await locator.inputValue().catch(() => ""));
      const expected = normalizeText(plan.answer || "");
      return Boolean(actual && expected && actual.toLowerCase() === expected.toLowerCase());
    }
    if (field.fieldType === "select") {
      if (field.fieldKind === "custom_select") {
        const expected = normalizeText(plan.answer || plan.selectedOptions[0] || "").toLowerCase();
        if (!expected) return false;
        const hiddenValue = normalizeText(await locator.inputValue().catch(() => "")).toLowerCase();
        if (hiddenValue === expected) return true;
        const selectedText = field.selectorHints.containerSelector
          ? normalizeText(
              await page
                .locator(field.selectorHints.containerSelector)
                .first()
                .locator(field.selectorHints.customSelectedValueSelector || "[aria-selected='true'], [data-selected='true'], .selected, .is-selected")
                .first()
                .innerText()
                .catch(() => "")
            ).toLowerCase()
          : "";
        return selectedText === expected || selectedText.includes(expected);
      }
      const expected = normalizeText(plan.answer || plan.selectedOptions[0] || "").toLowerCase();
      if (!expected) return false;
      const selectedText = normalizeText(await locator.locator("option:checked").first().innerText().catch(() => "")).toLowerCase();
      const selectedValue = normalizeText(await locator.inputValue().catch(() => "")).toLowerCase();
      return selectedText === expected || selectedValue === expected;
    }
    if (field.fieldType === "radio") {
      const group = field.selectorHints.groupName
        ? page.locator(`input[type='radio'][name="${field.selectorHints.groupName.replace(/"/g, '\\"')}"]`)
        : page.locator(selector);
      const count = await group.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const option = group.nth(i);
        const checked = await option.isChecked().catch(() => false);
        if (checked) return true;
      }
      return false;
    }
    if (field.fieldType === "checkbox_group") {
      if (plan.selectedOptions.length === 0) return false;
      const group = field.selectorHints.groupName
        ? page.locator(`input[type='checkbox'][name="${field.selectorHints.groupName.replace(/"/g, '\\"')}"]`)
        : page.locator(selector);
      const count = await group.count().catch(() => 0);
      let selected = 0;
      for (let i = 0; i < count; i += 1) {
        const option = group.nth(i);
        const checked = await option.isChecked().catch(() => false);
        if (!checked) continue;
        selected += 1;
      }
      return selected > 0;
    }

    return false;
  }

  private async executeCustomSelect(
    page: AdapterRunContext["page"],
    field: LeverFieldSchema,
    plan: PlannedAnswer
  ): Promise<boolean> {
    const target = normalizeText(plan.answer || plan.selectedOptions[0] || "");
    if (!target) return false;
    const container = field.selectorHints.containerSelector
      ? page.locator(field.selectorHints.containerSelector).first()
      : null;
    const triggerSelector = field.selectorHints.customTriggerSelector || "[role='combobox'], [aria-haspopup='listbox'], .select__control, .dropdown-trigger, .dropdown-selection, button";
    const optionSelector = field.selectorHints.customOptionSelector || "[role='option'], .dropdown-results li, .dropdown-results button, ul li";
    const trigger = container ? container.locator(triggerSelector).first() : page.locator(triggerSelector).first();
    const triggerVisible = await trigger.isVisible().catch(() => false);
    if (!triggerVisible) return false;
    await trigger.click().catch(() => undefined);
    await page.waitForTimeout(120);
    const options = container ? container.locator(optionSelector) : page.locator(optionSelector);
    const count = await options.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 20); i += 1) {
      const option = options.nth(i);
      const text = normalizeText(await option.innerText().catch(() => ""));
      if (!text) continue;
      if (text.toLowerCase() === target.toLowerCase() || text.toLowerCase().includes(target.toLowerCase())) {
        await option.click().catch(() => undefined);
        return true;
      }
    }
    return false;
  }

  private async extractInvalidFieldIds(
    page: AdapterRunContext["page"],
    schema: LeverFieldSchema[],
    locationFrozenFieldIds: Set<string> = new Set<string>()
  ): Promise<string[]> {
    const invalid = await page
      .evaluate((selectors) => {
        const normalize = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
        const isElementVisible = (node: Element | null): boolean => {
          if (!node || !(node instanceof HTMLElement)) return false;
          if (node.offsetParent === null && node.getClientRects().length === 0) return false;
          const style = window.getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden") return false;
          if (style.opacity === "0") return false;
          return true;
        };
        const isActiveControl = (node: Element | null): boolean => {
          if (!node || !(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement)) return false;
          if (node.type === "hidden") return false;
          if (normalize(node.getAttribute("aria-hidden")) === "true") return false;
          if (node.disabled) return false;
          return isElementVisible(node);
        };
        const hasValidSelectedLocation = (node: Element | null): boolean => {
          const parse = (raw: string): boolean => {
            const trimmed = raw.trim();
            if (!trimmed) return false;
            try {
              const parsed = JSON.parse(trimmed) as Record<string, unknown>;
              const name = String(parsed?.name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
              if (!name) return false;
              if (/no location found|select location|type to search/.test(name)) return false;
              return true;
            } catch {
              return false;
            }
          };

          const container = node?.closest("[data-qa='structured-contact-location-question'], li.application-question, .application-question");
          const localHidden = container?.querySelector("#selected-location, input[name='selectedLocation']") as HTMLInputElement | null;
          if (localHidden && parse(localHidden.value || "")) return true;
          const globalHidden = document.querySelector("#selected-location, input[name='selectedLocation']") as HTMLInputElement | null;
          return Boolean(globalHidden && parse(globalHidden.value || ""));
        };
        const isLocationInput = (node: Element): boolean => {
          const id = normalize(node.getAttribute("id"));
          const name = normalize(node.getAttribute("name"));
          const dataQa = normalize(node.getAttribute("data-qa"));
          const aria = normalize(node.getAttribute("aria-label"));
          const placeholder = normalize(node.getAttribute("placeholder"));
          return (
            id === "location-input" ||
            id === "selected-location" ||
            dataQa === "location-input" ||
            name.includes("location") ||
            aria.includes("location") ||
            placeholder.includes("city")
          );
        };
        const ids = new Set<string>();
        const signals: InvalidFieldSignal[] = [];

        const emptyRequired = Array.from(document.querySelectorAll("input[required], textarea[required], select[required]"));
        for (const node of emptyRequired) {
          if (!isActiveControl(node)) continue;
          if (isLocationInput(node) && hasValidSelectedLocation(node)) continue;
          const value = (node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value || "";
          if (!normalize(value)) {
            const name = normalize(node.getAttribute("name"));
            const id = normalize(node.getAttribute("id"));
            if (name) ids.add(name);
            else if (id) ids.add(id);
            const container = node.closest("li.application-question, li.application-question.custom-question, .application-question");
            const label = normalize(container?.querySelector(".application-label,.application-question-title,label,legend,h3,h4")?.textContent || "");
            if (name || id || label) {
              signals.push({ key: name || id || "", containerLabel: label });
            }
          }
        }

        const invalidControls = Array.from(document.querySelectorAll(":invalid"));
        for (const node of invalidControls) {
          if (!isActiveControl(node)) continue;
          if (isLocationInput(node) && hasValidSelectedLocation(node)) continue;
          const name = normalize(node.getAttribute("name"));
          const id = normalize(node.getAttribute("id"));
          if (name) ids.add(name);
          else if (id) ids.add(id);
        }

        const errorNodes = Array.from(document.querySelectorAll(".error-message,[role='alert'],.application-error,.field-error"));
        for (const error of errorNodes) {
          if (!(error instanceof HTMLElement)) continue;
          if (!isElementVisible(error)) continue;
          const container = error.closest("li.application-question, li.application-question.custom-question, .application-question");
          if (!container) continue;
          if (hasValidSelectedLocation(container) && /location/.test(normalize(container.textContent || ""))) {
            continue;
          }
          const exactInvalidControl = Array.from(container.querySelectorAll("input, textarea, select")).find(
            (node) => isActiveControl(node) && (node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).matches(":invalid")
          );
          const control = exactInvalidControl || Array.from(container.querySelectorAll("input, textarea, select")).find((node) => isActiveControl(node));
          const name = normalize(control?.getAttribute("name"));
          const id = normalize(control?.getAttribute("id"));
          if (name) ids.add(name);
          else if (id) ids.add(id);
          const label = normalize(container.querySelector(".application-label,.application-question-title,label,legend,h3,h4")?.textContent || "");
          signals.push({ key: name || id || "", containerLabel: label });
        }

        const requiredGroups = Array.from(
          document.querySelectorAll("li.application-question, li.application-question.custom-question, .application-question")
        ).filter((container) => {
          const text = normalize(container.querySelector(".application-label,.application-question-title,label,legend,h3,h4")?.textContent || "");
          const hasRequiredMark = /(^|\\s)\\*(\\s|$)/.test(text) || /required/.test(text);
          return hasRequiredMark;
        });

        for (const container of requiredGroups) {
          const radio = Array.from(container.querySelectorAll("input[type='radio']")).filter((node) => isActiveControl(node));
          if (radio.length > 0 && radio.every((node) => !(node as HTMLInputElement).checked)) {
            const groupedByName = new Map<string, HTMLInputElement[]>();
            for (const node of radio) {
              const key = normalize(node.getAttribute("name")) || `__radio_${normalize(node.getAttribute("id"))}`;
              const current = groupedByName.get(key) ?? [];
              current.push(node as HTMLInputElement);
              groupedByName.set(key, current);
            }
            const firstGroup = [...groupedByName.values()][0] ?? [];
            if (firstGroup.length === 0) continue;
            if (firstGroup.some((node) => node.checked)) continue;
            const first = firstGroup[0];
            const name = normalize(first?.getAttribute("name"));
            const id = normalize(first?.getAttribute("id"));
            const label = normalize(container.querySelector(".application-label,.application-question-title,label,legend,h3,h4")?.textContent || "");
            if (name) ids.add(name);
            else if (id) ids.add(id);
            signals.push({ key: name || id || "", containerLabel: label });
          }

          const checkboxes = Array.from(container.querySelectorAll("input[type='checkbox']")).filter((node) => isActiveControl(node));
          if (checkboxes.length > 0) {
            const groupedByName = new Map<string, HTMLInputElement[]>();
            for (const node of checkboxes) {
              const key = normalize(node.getAttribute("name")) || `__checkbox_${normalize(node.getAttribute("id"))}`;
              const current = groupedByName.get(key) ?? [];
              current.push(node as HTMLInputElement);
              groupedByName.set(key, current);
            }
            for (const group of groupedByName.values()) {
              if (group.length === 0) continue;
              if (group.some((node) => node.checked)) continue;
              const first = group[0];
              const name = normalize(first?.getAttribute("name"));
              const id = normalize(first?.getAttribute("id"));
              const label = normalize(container.querySelector(".application-label,.application-question-title,label,legend,h3,h4")?.textContent || "");
              if (name) ids.add(name);
              else if (id) ids.add(id);
              signals.push({ key: name || id || "", containerLabel: label });
            }
          }
        }

        return {
          ids: [...ids],
          signals
        };
      }, LEVER_CONTAINER_SELECTORS)
      .catch(() => ({ ids: [] as string[], signals: [] as InvalidFieldSignal[] }));

    const lowered = new Set(invalid.ids.map((item) => normalizeText(item).toLowerCase()).filter(Boolean));
    const exactMapped = new Set<string>();
    for (const field of schema) {
      if (field.fieldType === "location_autocomplete" && locationFrozenFieldIds.has(field.fieldId)) continue;
      const exactKeys = [
        normalizeText(field.fieldId).toLowerCase(),
        normalizeText(field.selectorHints.name || "").toLowerCase(),
        normalizeText(field.selectorHints.inputId || "").toLowerCase(),
        normalizeText(field.selectorHints.groupName || "").toLowerCase()
      ].filter(Boolean);
      if (exactKeys.some((key) => lowered.has(key))) exactMapped.add(field.fieldId);
    }

    const fallbackMapped = new Set<string>();
    for (const signal of invalid.signals) {
      if (normalizeText(signal.key)) continue;
      const signalLabel = normalizeText(signal.containerLabel).toLowerCase();
      if (!signalLabel) continue;
      for (const field of schema) {
        if (field.fieldType === "location_autocomplete" && locationFrozenFieldIds.has(field.fieldId)) continue;
        if (exactMapped.has(field.fieldId)) continue;
        const fieldLabel = normalizeText(field.label).toLowerCase();
        if (fieldLabel && (fieldLabel.includes(signalLabel) || signalLabel.includes(fieldLabel))) {
          fallbackMapped.add(field.fieldId);
        }
      }
    }
    return [...new Set([...exactMapped, ...fallbackMapped])];
  }

  private async setLeverLocation(
    page: AdapterRunContext["page"],
    selector: string,
    value: string
  ): Promise<boolean> {
    const locator = page.locator(selector).first();
    const before = await this.readLeverLocationState(page, selector);
    if (before.valid) return true;

    const queries = this.buildLocationQueryVariants(value);
    for (const query of queries) {
      await locator.click().catch(() => undefined);
      await page.keyboard.press("ControlOrMeta+A").catch(() => undefined);
      await page.keyboard.press("Backspace").catch(() => undefined);
      await locator.fill("").catch(() => undefined);
      await locator.type(query, { delay: 35 }).catch(() => undefined);

      const container = locator.locator(
        "xpath=ancestor::*[@data-qa='structured-contact-location-question' or contains(@class,'application-question')][1]"
      ).first();
      const dropdownOptions = container.locator(
        ".dropdown-results [role='option'], .dropdown-results li, .dropdown-results button, .dropdown-results .dropdown-result-item, .dropdown-results > div"
      );

      // Kept at three seconds. Raising it to eight was tried against the same
      // seven live postings and changed nothing: the two that fail produce no
      // suggestions at all rather than slow ones, so the extra wait bought
      // 45 seconds per run and no successes.
      const started = Date.now();
      while (Date.now() - started < 3000) {
        const count = await dropdownOptions.count().catch(() => 0);
        if (count > 0) break;
        await page.waitForTimeout(120);
      }

      let clickedOption = false;
      const optionCount = await dropdownOptions.count().catch(() => 0);
      if (optionCount > 0) {
        const lowered = query.toLowerCase();
        for (let i = 0; i < Math.min(10, optionCount); i += 1) {
          const option = dropdownOptions.nth(i);
          const text = normalizeText(await option.innerText().catch(() => ""));
          if (!text) continue;
          if (/no location found|searching|loading/i.test(text)) continue;
          const optionLower = text.toLowerCase();
          if (optionLower.includes(lowered) || lowered.includes(optionLower)) {
            await option.click().catch(() => undefined);
            clickedOption = true;
            break;
          }
        }
        if (!clickedOption) {
          const first = dropdownOptions.first();
          const firstText = normalizeText(await first.innerText().catch(() => ""));
          if (firstText && !/no location found|searching|loading/i.test(firstText)) {
            await first.click().catch(() => undefined);
            clickedOption = true;
          }
        }
      }

      if (!clickedOption) {
        await locator.press("ArrowDown").catch(() => undefined);
        await locator.press("Enter").catch(() => undefined);
      }

      await page.waitForTimeout(220);
      const after = await this.readLeverLocationState(page, selector);
      if (after.valid) return true;
    }
    return false;
  }

  private buildLocationQueryVariants(value: string): string[] {
    const base = normalizeText(value);
    if (!base) return [];
    const variants = new Set<string>([base]);
    const parts = base.split(",").map((part) => normalizeText(part)).filter(Boolean);
    const first = parts[0];
    const second = parts[1];
    if (parts.length >= 2) {
      if (first && second) {
        variants.add(`${first}, ${second}`);
        variants.add(`${first} ${second}`);
      }
      if (first) variants.add(first);
    } else if (parts.length === 1 && first) {
      variants.add(first);
    }
    return [...variants];
  }

  private async readLeverLocationState(
    page: AdapterRunContext["page"],
    selector: string
  ): Promise<{ visibleValue: string; hiddenValue: string; valid: boolean }> {
    const snapshot = await page
      .evaluate((inputSelector) => {
        const normalize = (input: unknown) => String(input ?? "").replace(/\s+/g, " ").trim();
        const input =
          (document.querySelector(inputSelector) as HTMLInputElement | null) ||
          (document.querySelector("#location-input, input[name='location']") as HTMLInputElement | null);
        if (!input) return { visibleValue: "", hiddenValue: "" };
        const container = input.closest("[data-qa='structured-contact-location-question'], li.application-question, .application-question");
        const hidden =
          (container?.querySelector("#selected-location, input[name='selectedLocation']") as HTMLInputElement | null) ||
          (document.querySelector("#selected-location, input[name='selectedLocation']") as HTMLInputElement | null);
        return {
          visibleValue: normalize(input.value),
          hiddenValue: normalize(hidden?.value || "")
        };
      }, selector)
      .catch(() => ({ visibleValue: "", hiddenValue: "" }));

    return {
      visibleValue: snapshot.visibleValue,
      hiddenValue: snapshot.hiddenValue,
      valid: isValidLeverSelectedLocation(snapshot.hiddenValue)
    };
  }
}
