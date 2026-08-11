import type { CandidateProfile, QuestionType, QuestionnaireResolutionRecord, ResolvedAnswer } from "../../core/types.js";
import type { WorkdayFieldSchema, WorkdayStep, WorkdayWidgetSchema } from "./schema.js";

export interface WorkdayJobContext {
  url: string;
  jobTitle?: string;
  company?: string;
}

export interface WorkdayQuestionnaireField {
  fieldId: string;
  labelText: string;
  inputKind: "dropdown" | "radio" | "checkbox" | "text" | "textarea" | "unknown";
  options: string[];
  selector: string;
  currentValue: string;
  required: boolean;
}

export interface WorkdayQuestionResolution {
  value: string | null;
  source: "deterministic" | "llm" | "manual_review";
  confidence: number;
  reason: string;
  manualReview: boolean;
}

export interface WorkdayWidgetAnswer {
  widgetId: string;
  value: string | string[] | null;
  source: "profile" | "llm" | "rule" | "preexisting";
  reason?: string;
}

export interface WorkdayWidgetAnswerValidationResult {
  accepted: boolean;
  value: string | string[] | null;
  reason?: string;
}

interface WorkdayNearbyQuestionContextItem {
  label: string;
  value: string;
}

export interface NormalizedWorkdayProfile {
  account: {
    email: string;
    password: string;
  };
  identity: {
    fullName: string;
    firstName: string;
    middleName?: string;
    lastName: string;
    suffix?: string;
    preferredName?: string;
  };
  contact: {
    email: string;
    phone: string;
    phoneType: "Mobile" | "Home" | "Work";
    address: {
      line1: string;
      line2?: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
    };
  };
  workAuthorization: {
    authorizedInUS: boolean;
    requiresSponsorship: boolean;
    visaStatus?: string;
    usCitizen?: boolean;
    permanentResident?: boolean;
  };
  exportControl: {
    usPerson?: boolean;
  };
  applicationSource?: string;
  customAnswers: Record<string, string | boolean | string[] | number>;
  experience: Array<{
    jobTitle: string;
    company: string;
    location: string;
    startDateMonth: string;
    startDateYear: string;
    endDateMonth?: string;
    endDateYear?: string;
    currentlyWorkHere?: boolean;
    description: string;
  }>;
  currentCompany?: string;
  previousEmployers: string[];
  education: Array<{
    school: string;
    degree: string;
    fieldOfStudy: string;
    gpa?: string;
    startYear?: string;
    endYear: string;
    startMonth?: string;
    endMonth?: string;
    graduationDateMmDdYyyy?: string;
    graduationDateMmYyyy?: string;
  }>;
  skills: string[];
  links: {
    linkedin?: string;
    github?: string;
    portfolio?: string;
    other?: string[];
  };
  files: {
    resumePath: string;
  };
  demographics: {
    gender?: string;
    hispanicOrLatino?: string;
    ethnicity?: string;
    raceEthnicity?: string;
    veteranStatus?: string;
    disabilityStatus?: "yes" | "no" | "decline";
  };
  logistics: {
    earliestStartDate?: string;
    allowDateFallbackToday: boolean;
  };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForMatch(value: string): string {
  return normalizeText(value).toLowerCase();
}

const US_STATE_ENTRIES: Array<{ code: string; name: string }> = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" },
  { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" },
  { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" },
  { code: "DC", name: "District of Columbia" }
];

function isResolverPlaceholderText(value: string): boolean {
  return /^(select one|choose one|please select|choose|search|add|upload|select files|calendar|all|partial list \(first 500 entries\)|no items\.?)$/i.test(normalizeText(value));
}

function isUncommittedSkillsValue(widget: WorkdayWidgetSchema, selections: string[]): boolean {
  const label = normalizeForMatch(widget.label);
  if (!/skills/.test(label)) return false;
  return selections.some((value) => /^(0 items selected|no items selected|no items|type to add skills)$/i.test(normalizeText(value)));
}

function currentDateParts(): { month: string; day: string; year: string; formatted: string; formattedDmy: string } {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const year = String(now.getFullYear());
  return {
    month,
    day,
    year,
    formatted: `${month}/${day}/${year}`,
    formattedDmy: `${day}/${month}/${year}`
  };
}

function parseAvailabilityDate(raw: string | undefined): { month: string; day: string; year: string; formatted: string; formattedDmy: string } | null {
  const value = normalizeText(raw || "");
  if (!value) return null;

  let month = "";
  let day = "";
  let year = "";

  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    year = iso[1]!;
    month = iso[2]!;
    day = iso[3]!;
  } else {
    const slash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!slash) return null;
    const first = slash[1]!.padStart(2, "0");
    const second = slash[2]!.padStart(2, "0");
    year = slash[3]!;
    if (Number.parseInt(first, 10) > 12) {
      day = first;
      month = second;
    } else {
      month = first;
      day = second;
    }
  }

  if (!month || !day || !year) return null;
  return {
    month,
    day,
    year,
    formatted: `${month}/${day}/${year}`,
    formattedDmy: `${day}/${month}/${year}`
  };
}

function resolveAvailabilityDate(profile: NormalizedWorkdayProfile): { month: string; day: string; year: string; formatted: string; formattedDmy: string } | null {
  const explicit = parseAvailabilityDate(profile.logistics.earliestStartDate);
  if (explicit) return explicit;
  if (profile.logistics.allowDateFallbackToday) return currentDateParts();
  return currentDateParts();
}

function isAvailabilityStartQuestion(value: string): boolean {
  return /when would you be available to start|when can you start|available start date|date of availability|availability date|date availability|\bavailable to start\b|\bstart date\b/.test(value);
}

function isNoticePeriodAvailabilityQuestion(value: string): boolean {
  return /notice period|available to start work|when would you be available to start work|when would you be available to start|current notice period/.test(value);
}

function availabilityDaysFromNow(profile: NormalizedWorkdayProfile): number {
  const availability = resolveAvailabilityDate(profile);
  if (!availability) return 0;
  const start = new Date(`${availability.year}-${availability.month}-${availability.day}T00:00:00`);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffMs = start.getTime() - today.getTime();
  return Math.max(0, Math.round(diffMs / 86_400_000));
}

function containsAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function parseAddressFallback(profile: CandidateProfile): {
  line1: string;
  city: string;
  state: string;
  postalCode: string;
} {
  const custom = profile.customAnswers || {};
  const customLine1 = normalizeText(String(custom["address line 1"] || custom["address"] || custom["current address"] || ""));
  const customCity = normalizeText(String(custom["city"] || custom["current city"] || ""));
  const customState = normalizeText(String(custom["state"] || custom["current state/province"] || ""));
  const customPostal = normalizeText(String(custom["postal code"] || custom["zip"] || ""));
  const raw = customLine1 || normalizeText(profile.basics.location || "");
  if (!raw && !customCity && !customState && !customPostal) return { line1: "", city: "", state: "", postalCode: "" };

  const parts = raw.split(",").map((part) => normalizeText(part)).filter(Boolean);
  const parsedLine1 = parts[0] || "";
  const parsedCity = parts[1] || "";
  const third = parts[2] || "";
  const fourth = parts[3] || "";
  const parsedPostal = third.match(/\b\d{5}(?:-\d{4})?\b/)?.[0] || fourth.match(/\b\d{5}(?:-\d{4})?\b/)?.[0] || "";
  const parsedState = third.replace(/\b\d{5}(?:-\d{4})?\b/g, "").trim() || fourth || "";

  return {
    line1: customLine1.includes(",") ? parsedLine1 : (customLine1 || parsedLine1),
    city: customCity || parsedCity,
    state: customState || parsedState,
    postalCode: customPostal || parsedPostal
  };
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeText(String(value || "")))
    .filter(Boolean);
}

function normalizeApplicationSource(value: unknown): string | undefined {
  const normalized = normalizeText(String(value || ""));
  return normalized || undefined;
}

function normalizeGraduationDateFormats(input: {
  graduationDateMmDdYyyy?: string;
  graduationDateMmYyyy?: string;
  endMonth?: string;
  endYear?: string;
  graduationYear?: string;
}): {
  graduationDateMmDdYyyy?: string;
  graduationDateMmYyyy?: string;
  month?: string;
  day?: string;
  year?: string;
} {
  const normalizeMonth = (raw: string): string => {
    const text = normalizeForMatch(raw);
    if (!text) return "";
    if (/^\d{1,2}$/.test(text)) return text.padStart(2, "0");
    const monthMap = new Map<string, string>([
      ["january", "01"],
      ["jan", "01"],
      ["february", "02"],
      ["feb", "02"],
      ["march", "03"],
      ["mar", "03"],
      ["april", "04"],
      ["apr", "04"],
      ["may", "05"],
      ["june", "06"],
      ["jun", "06"],
      ["july", "07"],
      ["jul", "07"],
      ["august", "08"],
      ["aug", "08"],
      ["september", "09"],
      ["sep", "09"],
      ["sept", "09"],
      ["october", "10"],
      ["oct", "10"],
      ["november", "11"],
      ["nov", "11"],
      ["december", "12"],
      ["dec", "12"]
    ]);
    return monthMap.get(text) || "";
  };

  const parseFull = (raw: string): { month: string; day: string; year: string } | null => {
    const value = normalizeText(raw);
    if (!value) return null;
    const slash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!slash) return null;
    return {
      month: slash[1]!.padStart(2, "0"),
      day: slash[2]!.padStart(2, "0"),
      year: slash[3]!
    };
  };

  const parseMonthYear = (raw: string): { month: string; year: string } | null => {
    const value = normalizeText(raw);
    if (!value) return null;
    const slash = value.match(/^(\d{1,2})\/(\d{4})$/);
    if (slash) {
      return {
        month: slash[1]!.padStart(2, "0"),
        year: slash[2]!
      };
    }
    const month = normalizeMonth(value);
    const yearMatch = value.match(/\b(20\d{2})\b/);
    if (!month || !yearMatch) return null;
    return { month, year: yearMatch[1]! };
  };

  const full = parseFull(input.graduationDateMmDdYyyy || "");
  const monthYear = parseMonthYear(input.graduationDateMmYyyy || "");
  const month = full?.month || monthYear?.month || normalizeMonth(input.endMonth || "");
  const day = full?.day || "01";
  const year = full?.year || monthYear?.year || normalizeText(input.endYear || input.graduationYear || "");

  if (!month || !year) {
    return {
      graduationDateMmDdYyyy: full ? `${full.month}/${full.day}/${full.year}` : undefined,
      graduationDateMmYyyy: monthYear ? `${monthYear.month}/${monthYear.year}` : undefined,
      month: full?.month || monthYear?.month,
      day: full?.day,
      year: full?.year || monthYear?.year
    };
  }

  return {
    graduationDateMmDdYyyy: `${month}/${day}/${year}`,
    graduationDateMmYyyy: `${month}/${year}`,
    month,
    day,
    year
  };
}

function parsePreviousEmployers(profile: CandidateProfile): string[] {
  const fromWorkday = normalizeStringArray(profile.workday?.previousEmployers);
  const fromProfile = normalizeStringArray(profile.previousEmployers);
  const custom = profile.customAnswers?.["previous employers"];
  const fromCustom = Array.isArray(custom)
    ? normalizeStringArray(custom)
    : typeof custom === "string"
      ? custom.split(/\s*,\s*/).map((value) => normalizeText(value)).filter(Boolean)
      : [];

  return [...new Set([...fromWorkday, ...fromProfile, ...fromCustom].map((value) => normalizeForMatch(value)))];
}

export function normalizeWorkdayProfile(profile: CandidateProfile, resumePathFallback?: string): NormalizedWorkdayProfile {
  const wd = profile.workday;
  const fallbackFullName = normalizeText(profile.basics.fullName || `${profile.basics.firstName} ${profile.basics.lastName}`);
  const fallbackSkills = profile.skillsSummary
    ? profile.skillsSummary.split(",").map((s) => normalizeText(s)).filter(Boolean)
    : [];
  const addressFallback = parseAddressFallback(profile);
  const rootEducation = profile.education;
  const normalizedRootGraduation = normalizeGraduationDateFormats({
    graduationDateMmDdYyyy: rootEducation?.graduationDateMmDdYyyy,
    graduationDateMmYyyy: rootEducation?.graduationDateMmYyyy,
    endMonth: rootEducation?.endMonth,
    endYear: rootEducation?.endYear,
    graduationYear: rootEducation?.graduationYear
  });
  const baseEducationEntries = wd?.education?.length
    ? wd.education
    : rootEducation
      ? [{
          school: normalizeText(rootEducation.school || rootEducation.university || ""),
          degree: normalizeText(rootEducation.degree || rootEducation.highestDegree || ""),
          fieldOfStudy: normalizeText(rootEducation.field || rootEducation.discipline || ""),
          gpa: rootEducation.gpa,
          startYear: rootEducation.startYear,
          endYear: normalizeText(rootEducation.endYear || rootEducation.graduationYear || ""),
          startMonth: rootEducation.startMonth,
          endMonth: rootEducation.endMonth,
          graduationDateMmDdYyyy: rootEducation.graduationDateMmDdYyyy,
          graduationDateMmYyyy: rootEducation.graduationDateMmYyyy
        }]
      : [];
  const normalizedEducation = baseEducationEntries.map((education, index) => {
    const fallback = index === 0 ? rootEducation : undefined;
    const normalizedGraduation = normalizeGraduationDateFormats({
      graduationDateMmDdYyyy: education.graduationDateMmDdYyyy || fallback?.graduationDateMmDdYyyy,
      graduationDateMmYyyy: education.graduationDateMmYyyy || fallback?.graduationDateMmYyyy,
      endMonth: education.endMonth || fallback?.endMonth || normalizedRootGraduation.month,
      endYear: education.endYear || fallback?.endYear || fallback?.graduationYear || normalizedRootGraduation.year,
      graduationYear: fallback?.graduationYear
    });
    return {
      school: education.school || (index === 0 ? normalizeText(rootEducation?.school || rootEducation?.university || "") : ""),
      degree: education.degree || (index === 0 ? normalizeText(rootEducation?.degree || rootEducation?.highestDegree || "") : ""),
      fieldOfStudy: education.fieldOfStudy || (index === 0 ? normalizeText(rootEducation?.field || rootEducation?.discipline || "") : ""),
      gpa: education.gpa || (index === 0 ? rootEducation?.gpa : undefined),
      startYear: education.startYear || (index === 0 ? rootEducation?.startYear : undefined),
      endYear: education.endYear || (index === 0 ? normalizeText(rootEducation?.endYear || rootEducation?.graduationYear || normalizedGraduation.year || "") : ""),
      startMonth: education.startMonth || (index === 0 ? rootEducation?.startMonth : undefined),
      endMonth: education.endMonth || (index === 0 ? rootEducation?.endMonth || normalizedGraduation.month : normalizedGraduation.month),
      graduationDateMmDdYyyy: normalizedGraduation.graduationDateMmDdYyyy,
      graduationDateMmYyyy: normalizedGraduation.graduationDateMmYyyy
    };
  });

  return {
    account: {
      email: wd?.account?.email || profile.basics.email,
      password: wd?.account?.password || ""
    },
    identity: {
      fullName: wd?.identity?.fullName || fallbackFullName,
      firstName: wd?.identity?.firstName || profile.basics.firstName,
      middleName: wd?.identity?.middleName,
      lastName: wd?.identity?.lastName || profile.basics.lastName,
      suffix: wd?.identity?.suffix,
      preferredName: wd?.identity?.preferredName
    },
    contact: {
      email: wd?.contact?.email || profile.basics.email,
      phone: wd?.contact?.phone || profile.basics.phone || "",
      phoneType: wd?.contact?.phoneType || "Mobile",
      address: {
        line1: wd?.contact?.address.line1 || addressFallback.line1 || "",
        line2: wd?.contact?.address.line2,
        city: wd?.contact?.address.city || profile.locationStructured?.city || addressFallback.city || "",
        state: wd?.contact?.address.state || profile.locationStructured?.region || profile.state || addressFallback.state || "",
        postalCode: wd?.contact?.address.postalCode || addressFallback.postalCode || "",
        country: wd?.contact?.address.country || profile.locationStructured?.country || profile.country || "United States"
      }
    },
    workAuthorization: {
      authorizedInUS: wd?.workAuthorization?.authorizedInUS ?? profile.workAuthorization?.authorizedToWork ?? true,
      requiresSponsorship: wd?.workAuthorization?.requiresSponsorship ?? profile.workAuthorization?.requiresSponsorship ?? false,
      visaStatus: wd?.workAuthorization?.visaStatus || profile.workAuthorization?.visaStatus,
      usCitizen: wd?.workAuthorization?.usCitizen ?? profile.workAuthorization?.usCitizen,
      permanentResident: wd?.workAuthorization?.permanentResident ?? profile.workAuthorization?.permanentResident
    },
    exportControl: {
      usPerson: wd?.exportControl?.usPerson ?? profile.exportControl?.usPerson
    },
    applicationSource: normalizeApplicationSource(
      wd?.applicationSource ||
      profile.applicationSource ||
      profile.customAnswers?.["application source"] ||
      profile.customAnswers?.["job source"] ||
      profile.customAnswers?.["source"] ||
      profile.customAnswers?.["how did you hear about us"] ||
      profile.customAnswers?.["how did you hear about this job"]
    ),
    customAnswers: profile.customAnswers || {},
    experience: wd?.experience || [],
    currentCompany: normalizeText(profile.experience?.currentCompany || wd?.experience?.find((entry) => entry.currentlyWorkHere)?.company || ""),
    previousEmployers: parsePreviousEmployers(profile),
    education: normalizedEducation,
    skills: wd?.skills || fallbackSkills,
    links: wd?.links || {
      linkedin: profile.links?.linkedin,
      github: profile.links?.github,
      portfolio: profile.links?.portfolio,
      other: profile.links?.website ? [profile.links.website] : []
    },
    files: {
      resumePath: wd?.files?.resumePath || resumePathFallback || ""
    },
    demographics: {
      ...wd?.demographics,
      raceEthnicity: wd?.demographics?.raceEthnicity || wd?.demographics?.ethnicity
    },
    logistics: {
      earliestStartDate: normalizeText(
        wd?.logistics?.earliestStartDate ||
        wd?.logistics?.earliest_start_date ||
        profile.logistics?.earliestStartDate ||
        profile.logistics?.earliest_start_date ||
        String(profile.customAnswers?.["earliest start date"] || "")
      ) || undefined,
      allowDateFallbackToday:
        wd?.logistics?.allowDateFallbackToday ??
        wd?.logistics?.allow_date_fallback_today ??
        profile.logistics?.allowDateFallbackToday ??
        profile.logistics?.allow_date_fallback_today ??
        false
    }
  };
}

function pushAnswer(
  out: ResolvedAnswer[],
  field: WorkdayFieldSchema,
  value: string | boolean | null,
  reason: string,
  source: ResolvedAnswer["source"] = "profile"
): void {
  out.push({ questionId: field.fieldId, value, source, reason });
}

function pushWidgetAnswer(
  out: WorkdayWidgetAnswer[],
  widget: WorkdayWidgetSchema,
  value: string | string[] | null,
  reason: string,
  source: WorkdayWidgetAnswer["source"] = "profile"
): void {
  out.push({ widgetId: widget.widgetId, value, source, reason });
}

function match(label: string, ...patterns: RegExp[]): boolean {
  const text = label.toLowerCase();
  return patterns.some((p) => p.test(text));
}

function isLanguageQuestion(label: string): boolean {
  return match(label, /\benglish\b/, /\blanguage\b/, /\bproficiency\b/, /\bspeak\b.*\bread\b.*\bwrite\b/);
}

function resolveEligibilityWithoutSponsorship(profile: NormalizedWorkdayProfile): "Yes" | "No" {
  return profile.workAuthorization.authorizedInUS && !profile.workAuthorization.requiresSponsorship ? "Yes" : "No";
}

const EMPLOYER_HISTORY_LABEL_PATTERNS: RegExp[] = [
  /currently or have you ever worked/,
  /have you ever worked for/,
  /have you ever worked with/,
  /previously worked for/,
  /previously worked at/,
  /former employee/,
  /current employee/,
  /employee or contractor/,
  /employee, intern, vendor, agency temporary,? or business guest/,
  /full-time\/part-time employee, intern, vendor/,
  /previous worker/
];

function isEmployerHistoryQuestion(label: string): boolean {
  return match(label, ...EMPLOYER_HISTORY_LABEL_PATTERNS);
}

function isLowRiskDefaultNoQuestion(label: string): boolean {
  return isEmployerHistoryQuestion(label) || match(
    label,
    /have you ever been employed by/,
    /worked .* employee or contractor/,
    /employee or contractor/,
    /current or former contractor/,
    /former contractor/,
    /contractor to\b/,
    /worked or attended school under a different name/,
    /under a different name/,
    /different name at any of the organizations/,
    /previously applied/,
    /have you previously applied/,
    /previous applicant/,
    /relatives employed/,
    /related to or know anyone/,
    /know anyone .* works? or has worked/,
    /family members? working here/,
    /related to anyone employed here/,
    /relative .* employed/,
    /family member .* employed/,
    /conflict of interest/,
    /financial interest/,
    /family relationship/,
    /personal relationship/,
    /non-compete/,
    /non-competition/,
    /non-disclosure/,
    /non-solicitation/,
    /employment agreement/
  );
}

function isPermittedWorkQuestion(label: string): boolean {
  return match(
    label,
    /lawfully permitted to work in the country where this job is located/,
    /lawfully permitted to work in the country/,
    /lawfully permitted to work where this job is located/,
    /lawfully permitted to work/,
    /legally permitted to work in the country where this job is located/,
    /legally permitted to work in the country/,
    /legally permitted to work where this job is located/,
    /legally permitted to work/
  );
}

function isWorkAuthorizationQuestionLabel(label: string): boolean {
  return isLegalRightToWorkVerificationQuestion(label) ||
    isPermittedWorkQuestion(label) ||
    match(label, /authorized.*work|work authorization/);
}

function isEmploymentEligibilityQuestion(label: string): boolean {
  return match(
    label,
    /employment eligibility/,
    /appropriate option describing your employment eligibility/,
    /describe your employment eligibility/,
    /which option describes your employment eligibility/
  );
}

function resolveEmploymentEligibilityValue(widget: WorkdayWidgetSchema, profile: NormalizedWorkdayProfile): string | string[] | null {
  const requiresSponsorship = profile.workAuthorization.requiresSponsorship;
  const authorized = profile.workAuthorization.authorizedInUS || profile.workAuthorization.usCitizen === true || profile.workAuthorization.permanentResident === true;
  const preferredTargets = requiresSponsorship
    ? [
        "require sponsorship",
        "will require sponsorship",
        "need sponsorship",
        "visa sponsorship",
        "authorized to work with sponsorship"
      ]
    : [
        "authorized to work without sponsorship",
        "do not require sponsorship",
        "no sponsorship required",
        "authorized to work",
        "citizen",
        "permanent resident"
      ];

  for (const target of preferredTargets) {
    const picked = resolveWidgetValueForOptions(widget, target);
    if (picked) return picked;
  }

  if (widget.options.length) {
    return authorized
      ? (pickAffirmativeOption(widget.options) || widget.options.find((option) => normalizeForMatch(option) !== "select one") || null)
      : (pickNegativeOption(widget.options) || widget.options.find((option) => normalizeForMatch(option) !== "select one") || null);
  }

  return requiresSponsorship ? "require sponsorship" : "authorized to work without sponsorship";
}

function isGovernmentConflictQuestion(label: string): boolean {
  return match(
    label,
    /employee of the united states government/,
    /united states government.*close friends or family/,
    /decision making capacity on any .* contract/,
    /friends or family .* contract/,
    /government.*friends or family/,
    /government.*decision making capacity/
  );
}

function isLegalRightToWorkVerificationQuestion(label: string): boolean {
  return match(
    label,
    /submit verification of your legal right to work/,
    /verification of your legal right to work/,
    /verify.*legal right to work/,
    /submit verification .* work in the united states/
  );
}

function isHighRiskTruthRequiredQuestion(label: string): boolean {
  return match(
    label,
    /authorized.*work/,
    /work authorization/,
    /eligible to work/,
    /sponsorship/,
    /visa/,
    /citizenship/,
    /nationality/,
    /export control/,
    /u\.?s\.? person/,
    /clearance/,
    /criminal/,
    /conviction/,
    /felony/,
    /misdemeanor/,
    /arrest/,
    /offense/,
    /crime/,
    /disability/,
    /veteran/,
    /race/,
    /ethnicity/,
    /gender/,
    /hispanic/,
    /latino/,
    /work opportunity tax credit/,
    /\bwotc\b/,
    /consent/,
    /i agree/,
    /agree to/,
    /agree with/,
    /acknowledgement/,
    /acknowledgment/,
    /privacy/,
    /background check/,
    /drug screen/
  );
}

function resolveExplicitCustomAnswerForLabel(
  profile: NormalizedWorkdayProfile,
  label: string
): string | boolean | string[] | number | null | undefined {
  const normalizedLabel = normalizeForMatch(label);
  if (!normalizedLabel) return undefined;

  for (const [rawKey, rawValue] of Object.entries(profile.customAnswers || {})) {
    if (rawValue === null || rawValue === undefined) continue;
    if (typeof rawValue === "string" && !normalizeText(rawValue)) continue;
    if (Array.isArray(rawValue) && !rawValue.some((entry) => normalizeText(String(entry)))) continue;

    const normalizedKey = normalizeForMatch(rawKey);
    if (!normalizedKey) continue;
    if (
      normalizedKey === normalizedLabel ||
      normalizedLabel.includes(normalizedKey) ||
      normalizedKey.includes(normalizedLabel)
    ) {
      return rawValue;
    }
  }

  return undefined;
}

function normalizeExplicitYesNoAnswer(rawValue: string | boolean | string[] | number | null): "Yes" | "No" | null {
  if (rawValue === null) return null;
  if (typeof rawValue === "boolean") return rawValue ? "Yes" : "No";
  const text = Array.isArray(rawValue)
    ? normalizeText(String(rawValue[0] || ""))
    : normalizeText(String(rawValue));
  if (!text) return null;
  if (/^(yes|y|true)$/i.test(text)) return "Yes";
  if (/^(no|n|false)$/i.test(text)) return "No";
  return null;
}

function isEmptyOrPlaceholderCurrentValue(value: string | string[] | null | undefined): boolean {
  if (Array.isArray(value)) {
    const parts = value.map((entry) => normalizeText(String(entry))).filter(Boolean);
    return !parts.length || parts.every((entry) => isResolverPlaceholderText(entry));
  }
  const text = normalizeText(String(value || ""));
  return !text || isResolverPlaceholderText(text);
}

function isLowRiskDefaultNoFieldType(field: WorkdayFieldSchema): boolean {
  return field.fieldType === "dropdown" || field.fieldType === "search_combobox" || field.fieldType === "radio";
}

function isLowRiskDefaultNoWidgetType(widget: WorkdayWidgetSchema): boolean {
  return widget.widgetType === "button_select" ||
    widget.widgetType === "prompt_input_select" ||
    widget.widgetType === "radio_group";
}

function deriveEmployerHistoryCompany(label: string): string | null {
  const normalized = normalizeText(label);
  const candidate = normalized.match(/worked for\s+(.+)/i)?.[1] ||
    normalized.match(/worked at\s+(.+)/i)?.[1] ||
    normalized.match(/current employee of\s+(.+)/i)?.[1] ||
    "";
  if (!candidate) return null;

  const simplified = candidate
    .replace(/\s+as\s+an?\s+employee.*$/i, "")
    .replace(/\s+as\s+an?\s+contractor.*$/i, "")
    .replace(/\s+as\s+.*$/i, "")
    .replace(/\s+or\s+any\s+of\s+their.*$/i, "")
    .replace(/\s+or\s+its.*$/i, "")
    .replace(/\s+or\s+any\s+affiliate.*$/i, "")
    .split(/,|\/|\(|\)/)[0]
    ?.trim();

  return simplified ? simplified : null;
}

function profileShowsEmployerHistory(profile: NormalizedWorkdayProfile, label: string): boolean {
  const target = normalizeForMatch(deriveEmployerHistoryCompany(label) || "");
  if (!target) return false;
  if (profile.previousEmployers.some((company) => company === target || company.includes(target) || target.includes(company))) {
    return true;
  }

  return profile.experience.some((entry) => {
    const company = normalizeForMatch(entry.company || "");
    return Boolean(company) && (company === target || company.includes(target) || target.includes(company));
  });
}

function deriveCurrentCompanyQuestionTarget(label: string): string | null {
  const normalized = normalizeForMatch(label);
  const candidate = normalized.match(/existing\s+([a-z0-9&.,'()\/ -]+?)\s+employee/)?.[1] ||
    normalized.match(/current\s+([a-z0-9&.,'()\/ -]+?)\s+employee/)?.[1] ||
    normalized.match(/currently employed by\s+([a-z0-9&.,'()\/ -]+?)(?:\?|$)/)?.[1] ||
    normalized.match(/employee of\s+([a-z0-9&.,'()\/ -]+?)(?:\?|$)/)?.[1] ||
    "";
  const simplified = candidate
    .replace(/\s+or\s+any\s+affiliate.*$/i, "")
    .replace(/\s+or\s+its.*$/i, "")
    .split(/,|\/|\(|\)/)[0]
    ?.trim();
  return simplified || null;
}

function profileShowsCurrentCompany(profile: NormalizedWorkdayProfile, label: string): boolean {
  const target = normalizeForMatch(deriveCurrentCompanyQuestionTarget(label) || "");
  if (!target) return false;
  const currentCompany = normalizeForMatch(profile.currentCompany || "");
  if (currentCompany && (currentCompany === target || currentCompany.includes(target) || target.includes(currentCompany))) {
    return true;
  }
  return profile.experience.some((entry) => {
    if (!entry.currentlyWorkHere) return false;
    const company = normalizeForMatch(entry.company || "");
    return Boolean(company) && (company === target || company.includes(target) || target.includes(company));
  });
}

function resolveEmployerHistoryFieldValue(
  options: string[],
  profile: NormalizedWorkdayProfile,
  label: string
): string {
  const workedThere = profileShowsEmployerHistory(profile, label);
  return pickOptionByTarget(options, workedThere ? "Yes" : "No") ||
    (workedThere
      ? pickOptionByTarget(options, "Yes, I have")
      : pickOptionByTarget(options, "No, I have not")) ||
    (workedThere ? "Yes" : "No");
}

function resolveEmployerHistoryWidgetValue(
  widget: WorkdayWidgetSchema,
  profile: NormalizedWorkdayProfile
): string | string[] | null {
  return widgetBooleanValue(widget, profileShowsEmployerHistory(profile, widget.label));
}

function profileCountryValue(profile: NormalizedWorkdayProfile): string {
  return normalizeText(profile.contact.address.country || "United States");
}

function profileLocatedInUnitedStates(profile: NormalizedWorkdayProfile): boolean {
  const country = normalizeForMatch(profileCountryValue(profile));
  return /\b(united states|united states of america|usa|us)\b/.test(country);
}

function isUsLocationQuestion(label: string): boolean {
  return match(
    label,
    /located in us/,
    /located in the us/,
    /located in united states/,
    /are you located in/,
    /currently located.*united states/,
    /currently located.*\bus\b/
  );
}

function isCountryLocationQuestion(label: string): boolean {
  return match(
    label,
    /current country/,
    /country of residence/,
    /current location/,
    /current country\/region/,
    /what country are you located in/,
    /where are you currently located/
  );
}

function isSourceQuestion(label: string): boolean {
  return match(
    label,
    /how did you hear about us/,
    /how did you hear about this job/,
    /how did you learn about this opportunity/,
    /\bapplication source\b/,
    /\breferral source\b/,
    /\bjob source\b/,
    /^source$/
  );
}

function isStateLocationIntentQuestion(label: string): boolean {
  return match(
    label,
    /what state do you intend to work/,
    /preferred work state/,
    /work location state/,
    /state where you will perform work/,
    /where do you intend to work/,
    /intend to work in/,
    /desired work state/,
    /state of employment/,
    /state where this job was posted/
  );
}

function normalizeUsStateCandidate(value: string): string {
  const normalized = normalizeForMatch(value);
  if (!normalized) return "";
  const direct = US_STATE_ENTRIES.find((entry) =>
    normalizeForMatch(entry.name) === normalized || entry.code.toLowerCase() === normalized
  );
  return direct ? direct.name : "";
}

function looksLikeUsStateAnswer(value: string): boolean {
  return Boolean(normalizeUsStateCandidate(value));
}

function pickStateOptionByTarget(options: string[], target: string): string | null {
  const normalizedState = normalizeUsStateCandidate(target);
  if (!normalizedState) return null;
  return pickOptionByTarget(options, normalizedState) || pickOptionByTarget(options, target);
}

function extractJobContextState(jobContext?: WorkdayJobContext): string | null {
  if (!jobContext) return null;
  const candidates = [jobContext.jobTitle || "", jobContext.url || ""]
    .map((value) => decodeURIComponent(String(value || "")).replace(/[-_/]+/g, " "));
  for (const candidate of candidates) {
    const normalized = normalizeForMatch(candidate);
    if (!normalized) continue;
    for (const entry of US_STATE_ENTRIES) {
      if (
        normalized.includes(normalizeForMatch(entry.name)) ||
        normalized.match(new RegExp(`\\b${entry.code.toLowerCase()}\\b`))
      ) {
        return entry.name;
      }
    }
  }
  return null;
}

function buildNearbyQuestionContext(widgets: WorkdayWidgetSchema[]): WorkdayNearbyQuestionContextItem[] {
  return widgets
    .map((widget) => {
      const current = Array.isArray(widget.currentValue)
        ? widget.currentValue.map((value) => normalizeText(String(value))).filter(Boolean).join(" / ")
        : normalizeText(String(widget.currentValue || ""));
      if (!current || isResolverPlaceholderText(current)) return null;
      return {
        label: normalizeText(widget.label),
        value: current
      };
    })
    .filter((item): item is WorkdayNearbyQuestionContextItem => Boolean(item));
}

function nearbyAnsweredQuestionValue(
  context: WorkdayNearbyQuestionContextItem[],
  matcher: RegExp
): string | null {
  for (let index = context.length - 1; index >= 0; index -= 1) {
    const item = context[index]!;
    if (matcher.test(normalizeForMatch(item.label))) return item.value;
  }
  return null;
}

function resolveStateLocationIntentOption(
  widget: WorkdayWidgetSchema,
  profile: NormalizedWorkdayProfile,
  nearbyContext: WorkdayNearbyQuestionContextItem[],
  jobContext?: WorkdayJobContext
): string | null {
  if (!widget.options.length || !isStateLocationIntentQuestion(widget.label)) return null;

  const customCandidates = [
    profile.customAnswers["preferred state"],
    profile.customAnswers["preferred work state"],
    profile.customAnswers["work location state"],
    profile.customAnswers["state where you intend to work"]
  ].map((value) => normalizeText(String(value || ""))).filter(Boolean);
  for (const candidate of customCandidates) {
    const picked = pickStateOptionByTarget(widget.options, candidate);
    if (picked) return picked;
  }

  const profileState = normalizeText(profile.contact.address.state || "");
  const profilePicked = pickStateOptionByTarget(widget.options, profileState);
  if (profilePicked) return profilePicked;

  const priorIntent = nearbyAnsweredQuestionValue(
    nearbyContext,
    /do you intend to work in the state where this job was posted|work in the state where this job was posted/
  );
  const normalizedPriorIntent = normalizeForMatch(priorIntent || "");
  if (/^(yes|y|true)$/.test(normalizedPriorIntent)) {
    const jobState = extractJobContextState(jobContext);
    const jobPicked = pickStateOptionByTarget(widget.options, jobState || "");
    if (jobPicked) return jobPicked;
  }

  return null;
}

function resolveNoticePeriodAvailabilityOption(
  widget: WorkdayWidgetSchema,
  profile: NormalizedWorkdayProfile
): string[] | null {
  if (widget.widgetType !== "checkbox_group") return null;
  if (!isNoticePeriodAvailabilityQuestion(widget.label)) return null;
  if (!widget.options.length) return null;

  const days = availabilityDaysFromNow(profile);
  const targets = days <= 3
    ? ["Available Immediately", "Immediately", "2 Weeks", "1 Month", "2 Months", "More than 3 Months"]
    : days <= 14
      ? ["2 Weeks", "1 Month", "Available Immediately", "2 Months", "More than 3 Months"]
      : days <= 31
        ? ["1 Month", "2 Weeks", "2 Months", "More than 3 Months", "Available Immediately"]
        : days <= 62
          ? ["2 Months", "1 Month", "More than 3 Months", "2 Weeks", "Available Immediately"]
          : ["More than 3 Months", "2 Months", "1 Month", "2 Weeks", "Available Immediately"];

  for (const target of targets) {
    const picked = pickOptionByTarget(widget.options, target);
    if (picked) return [picked];
  }
  return null;
}

function extractJobContextLocationCandidates(jobContext?: WorkdayJobContext): string[] {
  if (!jobContext) return [];
  const rawParts = [jobContext.jobTitle || "", jobContext.url || ""]
    .map((value) => decodeURIComponent(String(value || "")).replace(/[-_/]+/g, " "))
    .filter(Boolean);
  const candidates = new Set<string>();
  for (const raw of rawParts) {
    const compact = normalizeText(raw);
    if (!compact) continue;
    candidates.add(compact);
    for (const optionLike of compact.split(/\s{2,}|[,|]/g).map((part) => normalizeText(part)).filter(Boolean)) {
      candidates.add(optionLike);
    }
  }
  return [...candidates];
}

function isLocationPreferenceCheckboxQuestion(widget: WorkdayWidgetSchema): boolean {
  const label = normalizeForMatch(widget.label);
  if (!/location|office|city|site|where would you like to work|which location|which office|which site|role based in us/.test(label)) {
    return false;
  }
  return widget.options.some((option) => /,\s*[A-Z]{2}\b/.test(option) || /not applying to role based in us/i.test(option));
}

function resolveLocationPreferenceCheckboxOption(
  widget: WorkdayWidgetSchema,
  profile: NormalizedWorkdayProfile,
  jobContext?: WorkdayJobContext
): string[] | null {
  if (widget.widgetType !== "checkbox_group") return null;
  if (!widget.options.length || !isLocationPreferenceCheckboxQuestion(widget)) return null;

  const jobCandidates = extractJobContextLocationCandidates(jobContext);
  for (const candidate of jobCandidates) {
    const picked = pickOptionByTarget(widget.options, candidate);
    if (picked) return [picked];
  }

  const profileCandidates = [
    `${profile.contact.address.city}, ${profile.contact.address.state}`,
    profile.contact.address.city,
    profile.contact.address.state
  ].map((value) => normalizeText(value)).filter(Boolean);
  for (const candidate of profileCandidates) {
    const picked = pickOptionByTarget(widget.options, candidate);
    if (picked) return [picked];
  }

  const notUsOption = pickOptionByTarget(widget.options, "Not Applicable - Not applying to role based in US");
  if (notUsOption && !profileLocatedInUnitedStates(profile)) return [notUsOption];

  const nonDecline = widget.options.find((option) => {
    const normalized = normalizeForMatch(option);
    return normalized &&
      normalized !== "select one" &&
      !/not applicable|other/.test(normalized);
  });
  return nonDecline ? [nonDecline] : null;
}

function isPreferenceCheckboxQuestion(widget: WorkdayWidgetSchema): boolean {
  const label = normalizeForMatch(widget.label);
  return widget.widgetType === "checkbox_group" && /preference|preferred|which would you prefer|select all that apply/.test(label);
}

function resolvePreferenceCheckboxOption(
  widget: WorkdayWidgetSchema,
  jobContext?: WorkdayJobContext
): string[] | null {
  if (widget.widgetType !== "checkbox_group") return null;
  if (!widget.options.length || !isPreferenceCheckboxQuestion(widget)) return null;

  const jobTitle = normalizeForMatch(jobContext?.jobTitle || "");
  const notSoftwareRole = pickOptionByTarget(widget.options, "I am not applying for a Software Developer role");
  if (notSoftwareRole && jobTitle && !/software developer|software engineer|mobile engineer|frontend|front end|backend|back end|full stack|cloud engineer/.test(jobTitle)) {
    return [notSoftwareRole];
  }

  const noPreference = pickOptionByTarget(widget.options, "I do not have a preference") ||
    pickOptionByTarget(widget.options, "No Preference");
  if (noPreference) return [noPreference];

  return null;
}

function isRequiredSingleSelectWidget(widget: WorkdayWidgetSchema): boolean {
  return widget.required && (
    widget.widgetType === "button_select" ||
    widget.widgetType === "prompt_input_select" ||
    widget.widgetType === "radio_group"
  );
}

function firstNonPlaceholderOption(options: string[]): string | null {
  return options.find((option) => {
    const normalized = normalizeForMatch(option);
    return normalized && normalized !== "select one" && normalized !== "select..." && normalized !== "please select" && normalized !== "choose one" && normalized !== "choose";
  }) || null;
}

function isInternshipCommitmentQuestion(label: string): boolean {
  return match(
    label,
    /commit to the entire duration/,
    /entire duration of the program/,
    /able to commit/,
    /able to participate/,
    /entire duration.*job description/,
    /entire internship duration/
  );
}

function graduationDateOptionTargets(education: NormalizedWorkdayProfile["education"][number] | null): string[] {
  if (!education) return [];
  const month = normalizeText(education.endMonth || "");
  const year = normalizeText(education.endYear || "");
  if (!year) return [];
  const numericMonth = month.padStart(2, "0");
  const monthNames = new Map<string, string>([
    ["01", "January"], ["02", "February"], ["03", "March"], ["04", "April"], ["05", "May"], ["06", "June"],
    ["07", "July"], ["08", "August"], ["09", "September"], ["10", "October"], ["11", "November"], ["12", "December"]
  ]);
  const monthName = monthNames.get(numericMonth) || "";
  return [
    `${numericMonth}/${year}`,
    `${monthName} ${year}`,
    `${monthName}, ${year}`,
    year
  ].map((value) => normalizeText(value)).filter(Boolean);
}

function parseFutureLikeOptionScore(option: string): number | null {
  const normalized = normalizeForMatch(option);
  if (!normalized) return null;
  const yearMatch = normalized.match(/\b(20\d{2})\b/);
  if (!yearMatch) return null;
  const year = Number.parseInt(yearMatch[1] || "", 10);
  if (!Number.isFinite(year)) return null;
  const monthOrder = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"
  ];
  const monthIndex = monthOrder.findIndex((name) => normalized.includes(name));
  const numericMonth = normalized.match(/\b(0?[1-9]|1[0-2])\/20\d{2}\b/);
  const resolvedMonth = numericMonth ? Number.parseInt((numericMonth[1] || "1").padStart(2, "0"), 10) : (monthIndex >= 0 ? monthIndex + 1 : 12);
  return year * 100 + resolvedMonth;
}

function resolveGraduationDateOption(
  widget: WorkdayWidgetSchema,
  profile: NormalizedWorkdayProfile
): string | null {
  if (!widget.options.length) return null;
  const primaryEducation = resolveEducationFact(profile);
  for (const target of graduationDateOptionTargets(primaryEducation)) {
    const picked = pickOptionByTarget(widget.options, target);
    if (picked) return picked;
  }

  const now = new Date();
  const currentScore = now.getFullYear() * 100 + (now.getMonth() + 1);
  const datedOptions = widget.options
    .map((option) => ({ option, score: parseFutureLikeOptionScore(option) }))
    .filter((entry) => entry.score !== null) as Array<{ option: string; score: number }>;
  const future = datedOptions
    .filter((entry) => entry.score >= currentScore)
    .sort((lhs, rhs) => lhs.score - rhs.score);
  if (future.length) return future[0]!.option;
  return firstNonPlaceholderOption(widget.options);
}

function isGraduationDateQuestion(label: string): boolean {
  return match(
    label,
    /expected graduation date/,
    /graduation date/,
    /anticipate graduating/,
    /most recent academic degree/
  );
}

function isCohortPreferenceQuestion(label: string): boolean {
  return match(label, /internship cohort/, /\bcohort\b/, /prefer to join based on your school timeline/);
}

function resolveCohortPreferenceOption(
  widget: WorkdayWidgetSchema,
  profile: NormalizedWorkdayProfile,
  jobContext?: WorkdayJobContext
): string | null {
  if (!widget.options.length) return null;
  const education = resolveEducationFact(profile);
  const year = normalizeText(education?.endYear || "");
  const endMonth = normalizeText(education?.endMonth || "");
  const targets: string[] = [];
  const jobText = normalizeForMatch([jobContext?.jobTitle || "", jobContext?.url || ""].join(" "));
  if (/summer/.test(jobText)) targets.push("Summer");
  if (/fall|autumn/.test(jobText)) targets.push("Fall");
  if (/spring/.test(jobText)) targets.push("Spring");
  if (/winter/.test(jobText)) targets.push("Winter");
  if (year) targets.push(year);
  if (endMonth) targets.push(endMonth);
  for (const target of targets) {
    const picked = pickOptionByTarget(widget.options, target);
    if (picked) return picked;
  }
  return firstNonPlaceholderOption(widget.options);
}

function isProfessionalExperienceExcludingInternshipsQuestion(label: string): boolean {
  return match(
    label,
    /years of relevant/,
    /similar professional work experience/,
    /do not include internship/,
    /excluding internships/,
    /professional work experience/
  );
}

function resolveLowExperienceOption(widget: WorkdayWidgetSchema): string | null {
  if (!widget.options.length) return null;
  const preferredTargets = ["0", "none", "less than 1", "0-1", "0 to 1", "under 1", "entry level"];
  for (const target of preferredTargets) {
    const picked = pickOptionByTarget(widget.options, target);
    if (picked) return picked;
  }
  const picked = pickClosestExperienceOption(widget.options, 0);
  return picked || firstNonPlaceholderOption(widget.options);
}

function isUniversityCountryQuestion(label: string): boolean {
  return match(
    label,
    /country of residence .* university/,
    /country of the university/,
    /country of residence for the school/,
    /school country/,
    /university .* country/
  );
}

function resolveUniversityCountryOption(
  widget: WorkdayWidgetSchema,
  profile: NormalizedWorkdayProfile
): string | null {
  if (!widget.options.length) return null;
  const school = normalizeForMatch(resolveEducationFact(profile)?.school || "");
  const isUsSchool = /san diego state university|sdsu|united states|usa/.test(school) || profileLocatedInUnitedStates(profile);
  if (isUsSchool) {
    return resolveWidgetValueForOptions(widget, "United States") as string | null ||
      resolveWidgetValueForOptions(widget, "United States of America") as string | null;
  }
  return firstNonPlaceholderOption(widget.options);
}

function resolveGenericRequiredSingleSelectOption(
  widget: WorkdayWidgetSchema,
  profile: NormalizedWorkdayProfile,
  nearbyContext: WorkdayNearbyQuestionContextItem[],
  jobContext?: WorkdayJobContext
): string | null {
  if (!isRequiredSingleSelectWidget(widget) || !widget.options.length) return null;
  const label = widget.label;

  if (match(label, /18 years of age or older/, /over the age of 18/, /at least 18/, /18 years old at or before the start/)) {
    return pickAffirmativeOption(widget.options);
  }
  if (isInternshipCommitmentQuestion(label)) {
    return pickAffirmativeOption(widget.options);
  }
  if (isGraduationDateQuestion(label)) {
    return resolveGraduationDateOption(widget, profile);
  }
  if (isCohortPreferenceQuestion(label)) {
    return resolveCohortPreferenceOption(widget, profile, jobContext);
  }
  if (isProfessionalExperienceExcludingInternshipsQuestion(label)) {
    return resolveLowExperienceOption(widget);
  }
  if (isUniversityCountryQuestion(label) || isCountryLocationQuestion(label)) {
    return resolveUniversityCountryOption(widget, profile) || (resolveWidgetValueForOptions(widget, "United States") as string | null);
  }
  if (isStateLocationIntentQuestion(label)) {
    return resolveStateLocationIntentOption(widget, profile, nearbyContext, jobContext);
  }
  if (isSourceQuestion(label)) {
    return resolveSourceOption(widget.options, profile);
  }
  if (isEmploymentEligibilityQuestion(label)) {
    return resolveEmploymentEligibilityValue(widget, profile) as string | null;
  }
  if (isWorkAuthorizationQuestionLabel(label)) {
    return widgetBooleanValue(widget, profile.workAuthorization.authorizedInUS) as string | null;
  }
  if (match(label, /eligible to work/, /without visa sponsorship/, /future eligible to work/)) {
    return widgetBooleanValue(widget, resolveEligibilityWithoutSponsorship(profile) === "Yes") as string | null;
  }
  if (match(label, /sponsorship|visa/)) {
    return widgetBooleanValue(widget, profile.workAuthorization.requiresSponsorship) as string | null;
  }
  if (isWotcQuestion(label)) {
    return resolveWidgetValueForOptions(widget, "Answer I don’t wish to respond") as string | null ||
      resolveWidgetValueForOptions(widget, "Answer I don't wish to respond") as string | null;
  }
  return null;
}

function resolveGenericRequiredCheckboxGroupOption(
  widget: WorkdayWidgetSchema,
  profile: NormalizedWorkdayProfile,
  nearbyContext: WorkdayNearbyQuestionContextItem[],
  jobContext?: WorkdayJobContext
): string[] | null {
  if (widget.widgetType !== "checkbox_group" || !widget.options.length) return null;

  const noticePeriod = resolveNoticePeriodAvailabilityOption(widget, profile);
  if (noticePeriod) return noticePeriod;

  const locationPreference = resolveLocationPreferenceCheckboxOption(widget, profile, jobContext);
  if (locationPreference) return locationPreference;

  const preference = resolvePreferenceCheckboxOption(widget, jobContext);
  if (preference) return preference;

  const careerLevel = careerLevelClassificationOption(widget.options);
  if (careerLevel) return [careerLevel];

  const declineOption = pickDeclineOption(widget.options);
  if ((widget.step === "voluntary_disclosures" || widget.step === "self_identification") && declineOption) {
    return [declineOption];
  }

  const priorIntent = nearbyAnsweredQuestionValue(nearbyContext, /prefer|preference|location|office|site/);
  if (priorIntent) {
    const picked = pickOptionByTarget(widget.options, priorIntent);
    if (picked) return [picked];
  }

  const safeFallback = widget.options.find((option) => {
    const normalized = normalizeForMatch(option);
    return normalized &&
      normalized !== "select one" &&
      !/other|decline|prefer not|do not wish/.test(normalized);
  });
  return safeFallback ? [safeFallback] : null;
}

function widgetHasBinaryYesNoOptions(widget: WorkdayWidgetSchema): boolean {
  return Boolean(pickOptionByTarget(widget.options, "Yes") && pickOptionByTarget(widget.options, "No"));
}

function resolveForcedRequiredOptionChoice(
  widget: WorkdayWidgetSchema,
  profile: NormalizedWorkdayProfile,
  nearbyContext: WorkdayNearbyQuestionContextItem[],
  jobContext?: WorkdayJobContext
): string | string[] | null {
  const label = widget.label;
  const explicitCustomAnswer = resolveExplicitCustomAnswerForLabel(profile, label);
  const explicitYesNo = explicitCustomAnswer !== undefined ? normalizeExplicitYesNoAnswer(explicitCustomAnswer) : null;
  if (explicitYesNo) return widgetBooleanValue(widget, explicitYesNo === "Yes");

  if (widget.widgetType === "checkbox_group") {
    const checkboxFallback = resolveGenericRequiredCheckboxGroupOption(widget, profile, nearbyContext, jobContext);
    if (checkboxFallback) return checkboxFallback;
  }

  const genericSingleSelect = resolveGenericRequiredSingleSelectOption(widget, profile, nearbyContext, jobContext);
  if (genericSingleSelect) return genericSingleSelect;

  if (isStateLocationIntentQuestion(label)) {
    return resolveStateLocationIntentOption(widget, profile, nearbyContext, jobContext);
  }
  if (isCountryLocationQuestion(label)) {
    return resolveWidgetValueForOptions(widget, "United States of America") ||
      resolveWidgetValueForOptions(widget, "United States") ||
      profileCountryValue(profile);
  }
  if (isSourceQuestion(label)) {
    return resolveSourceOption(widget.options, profile);
  }
  if (isEmploymentEligibilityQuestion(label)) {
    return resolveEmploymentEligibilityValue(widget, profile);
  }
  if (isWorkAuthorizationQuestionLabel(label)) {
    return widgetBooleanValue(widget, profile.workAuthorization.authorizedInUS);
  }
  if (match(label, /eligible to work/, /without visa sponsorship/, /future eligible to work/)) {
    return widgetBooleanValue(widget, resolveEligibilityWithoutSponsorship(profile) === "Yes");
  }
  if (match(label, /sponsorship|visa/)) {
    return widgetBooleanValue(widget, profile.workAuthorization.requiresSponsorship);
  }
  if (isUsLocationQuestion(label)) {
    return widgetBooleanValue(widget, profileLocatedInUnitedStates(profile));
  }
  if (isWotcQuestion(label)) {
    return resolveWidgetValueForOptions(widget, "Answer I don’t wish to respond") ||
      resolveWidgetValueForOptions(widget, "Answer I don't wish to respond");
  }
  if (isGovernmentConflictQuestion(label) || match(label, /government employee/, /department of defense/, /public institution/)) {
    return widgetBooleanValue(widget, false);
  }
  if (isEmployerHistoryQuestion(label)) {
    return resolveEmployerHistoryWidgetValue(widget, profile);
  }
  if (isLowRiskDefaultNoQuestion(label) || match(label, /conflict of interest/, /non-compete/, /non-competition/, /family relationship/, /personal relationship/, /relative .* company/, /family member .* company/)) {
    return widgetBooleanValue(widget, false);
  }
  if (widgetHasBinaryYesNoOptions(widget) && widget.required && !isWorkAuthorizationQuestionLabel(label)) {
    return widgetBooleanValue(widget, false);
  }
  if (isRequiredSingleSelectWidget(widget)) {
    return firstNonPlaceholderOption(widget.options);
  }
  return null;
}

function isSourceOtherOption(option: string): boolean {
  return /(^|\b)other(\b|$)/.test(normalizeForMatch(option));
}

function isReferralLikeSourceOption(option: string): boolean {
  return /referral|employee referral|friend|family|relative|recruiter|agency|staffing|internal|campus|school|college|university/.test(normalizeForMatch(option));
}

function pickSourceCandidateOption(options: string[], preferredValue: string): string | null {
  const exact = options.find((option) => normalizeForMatch(option) === normalizeForMatch(preferredValue));
  if (exact) return exact;

  const preferredTokens = normalizeForMatch(preferredValue)
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
  if (!preferredTokens.length) return null;

  const scored = options
    .filter((option) => !isSourceOtherOption(option))
    .map((option) => ({
      raw: option,
      score: preferredTokens.reduce((count, token) => count + (normalizeForMatch(option).includes(token) ? 1 : 0), 0)
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.raw ?? null;
}

function pickBestGenericSourceOption(options: string[]): string | null {
  const scored = options
    .map((option) => {
      const normalized = normalizeForMatch(option);
      if (!normalized || normalized === "select one") return { raw: option, score: -1000 };
      if (isReferralLikeSourceOption(option)) return { raw: option, score: -100 };
      if (/linkedin/.test(normalized)) return { raw: option, score: 100 };
      if (/company website|careers website|career site|company site|corporate website/.test(normalized)) return { raw: option, score: 90 };
      if (/indeed/.test(normalized)) return { raw: option, score: 80 };
      if (/glassdoor|handshake|ziprecruiter|monster|simplify/.test(normalized)) return { raw: option, score: 70 };
      if (/job board|online job board|website|internet|search engine|social media/.test(normalized)) return { raw: option, score: 50 };
      if (isSourceOtherOption(option)) return { raw: option, score: 5 };
      return { raw: option, score: 20 };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.raw ?? null;
}

function resolveSourceOption(options: string[], profile: NormalizedWorkdayProfile): string | null {
  const visible = Array.from(new Set(options.map((option) => normalizeText(option)).filter(Boolean)));
  if (!visible.length) return profile.applicationSource || "LinkedIn";

  const explicit = profile.applicationSource ? pickSourceCandidateOption(visible, profile.applicationSource) : null;
  if (explicit) return explicit;
  return visible.find((option) => !isResolverPlaceholderText(option)) || pickBestGenericSourceOption(visible);
}

function pickBestOption(options: string[], predicate: (normalized: string) => boolean): string | null {
  const scored = options
    .map((raw) => ({ raw, normalized: normalizeForMatch(raw) }))
    .filter((entry) => entry.normalized && entry.normalized !== "select one");
  return scored.find((entry) => predicate(entry.normalized))?.raw ?? null;
}

function pickAffirmativeOption(options: string[]): string | null {
  return pickBestOption(options, (v) => /^(yes|y|i agree|agree|consent|accept|authorized|eligible|immediately|available now)/.test(v));
}

function pickNegativeOption(options: string[]): string | null {
  return pickBestOption(options, (v) => /^(no|n|not applicable|none|decline)/.test(v));
}

function pickNeitherOption(options: string[]): string | null {
  return pickBestOption(options, (v) => /^neither$/.test(v));
}

function pickDeclineOption(options: string[]): string | null {
  return pickBestOption(
    options,
    (v) => /decline to self-identify|decline to identify|do not wish to answer|don't wish to answer|prefer not to say|prefer not to answer|choose not to disclose|prefer not to disclose|decline|self-identify later/.test(v)
  );
}

function isEthnicityDisclosureOptionSet(options: string[]): boolean {
  const normalized = options.map((option) => normalizeForMatch(option)).filter(Boolean);
  if (!normalized.length) return false;
  const markers = [
    /asian/,
    /black or african american/,
    /hispanic or latino/,
    /white/,
    /two or more races/,
    /native american or alaska native/,
    /native hawaiian or pacific islander/
  ];
  const matches = markers.reduce((count, marker) => count + (normalized.some((option) => marker.test(option)) ? 1 : 0), 0);
  return matches >= 3;
}

function pickEarliestStartOption(options: string[]): string | null {
  const priority = [/immediately|available now|asap/, /\b1[- ]?2 weeks?\b|\btwo weeks?\b/, /\b2[- ]?4 weeks?\b|\bfour weeks?\b/];
  for (const matcher of priority) {
    const found = pickBestOption(options, (v) => matcher.test(v));
    if (found) return found;
  }
  return options.find((o) => normalizeForMatch(o) !== "select one") ?? null;
}

function pickOptionByTarget(options: string[], target: string): string | null {
  const normalizedTarget = normalizeForMatch(target);
  const exact = options.find((option) => normalizeForMatch(option) === normalizedTarget);
  if (exact) return exact;
  const fuzzy = options.find((option) => normalizeForMatch(option).includes(normalizedTarget) || normalizedTarget.includes(normalizeForMatch(option)));
  if (fuzzy) return fuzzy;
  const stopwords = new Set(["or", "and", "the", "of", "to", "a", "i", "do", "not", "wish", "self", "identify", "united", "states", "america"]);
  const targetTokens = normalizedTarget
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !stopwords.has(token));
  if (targetTokens.length) {
    let best: { raw: string; score: number } | null = null;
    for (const option of options) {
      const normalizedOption = normalizeForMatch(option);
      const score = targetTokens.reduce((count, token) => count + (normalizedOption.includes(token) ? 1 : 0), 0);
      if (score <= 0) continue;
      if (!best || score > best.score) best = { raw: option, score };
    }
    if (best) return best.raw;
  }
  if (normalizedTarget === "yes") return pickAffirmativeOption(options);
  if (normalizedTarget === "no") return pickNegativeOption(options);
  return null;
}

function isOptionBackedWidget(widget: WorkdayWidgetSchema): boolean {
  return widget.options.length > 0 ||
    widget.widgetType === "button_select" ||
    widget.widgetType === "prompt_input_select" ||
    widget.widgetType === "radio_group" ||
    widget.widgetType === "checkbox_group";
}

function widgetHasValidationError(widget: WorkdayWidgetSchema): boolean {
  return Boolean(widget.htmlSummary.ariaInvalid) || Boolean(widget.htmlSummary.hasInputAlert);
}

function isFileUploadCommitted(widget: WorkdayWidgetSchema): boolean {
  const current = currentWidgetDisplayValue(widget);
  if (!current || isResolverPlaceholderText(current)) return false;
  return /\.[a-z0-9]{2,6}\b/i.test(current) || /uploaded|successfully uploaded/i.test(current);
}

function normalizeCurrentSelectionParts(widget: WorkdayWidgetSchema): string[] {
  if (widget.widgetType === "date_mm_yyyy") {
    return normalizeDateAnswerParts(widget.currentValue, 2);
  }
  if (widget.widgetType === "date_mm_dd_yyyy") {
    return normalizeDateAnswerParts(widget.currentValue, 3);
  }
  const current = widget.currentValue;
  if (Array.isArray(current)) {
    return current.map((value) => normalizeText(String(value))).filter(Boolean);
  }
  const text = normalizeText(String(current || ""));
  if (!text) return [];
  if (widget.widgetType === "checkbox_group") {
    return text.split(/\s*\/\s*|\s*,\s*/).map((value) => normalizeText(value)).filter(Boolean);
  }
  return [text];
}

export function isAcceptablePreexistingWorkdayWidgetValue(widget: WorkdayWidgetSchema): boolean {
  if ((widget.widgetType === "date_mm_yyyy" || widget.widgetType === "date_mm_dd_yyyy") && widget.step === "my_experience") {
    const expectedParts = widget.widgetType === "date_mm_yyyy" ? 2 : 3;
    return normalizeDateAnswerParts(widget.currentValue, expectedParts).length === expectedParts;
  }

  if (widgetHasValidationError(widget)) return false;

  if (widget.widgetType === "file_upload") return isFileUploadCommitted(widget);

  const selections = normalizeCurrentSelectionParts(widget);
  if (!selections.length) return false;
  if (isUncommittedSkillsValue(widget, selections)) return false;

  if (widget.widgetType === "checkbox_group" || widget.widgetType === "radio_group") {
    return selections.some((value) => !isResolverPlaceholderText(value));
  }

  if (widget.widgetType === "button_select" || widget.widgetType === "prompt_input_select") {
    return selections.some((value) => !isResolverPlaceholderText(value));
  }

  return selections.some((value) => !isResolverPlaceholderText(value));
}

export function collectPreexistingWorkdayWidgetAnswers(
  widgets: WorkdayWidgetSchema[],
  options?: { requiredOnly?: boolean }
): Map<string, WorkdayWidgetAnswer> {
  const answers: WorkdayWidgetAnswer[] = [];
  const requiredOnly = options?.requiredOnly ?? true;
  for (const widget of widgets) {
    if (widget.widgetType === "panel_collection") continue;
    if (requiredOnly && !widget.required) continue;
    if (!isAcceptablePreexistingWorkdayWidgetValue(widget)) continue;
    const normalizedSelections = normalizeCurrentSelectionParts(widget);
    const value: string | string[] | null = widget.widgetType === "checkbox_group" ||
      widget.widgetType === "date_mm_yyyy" ||
      widget.widgetType === "date_mm_dd_yyyy"
      ? normalizedSelections
      : normalizedSelections[0] || null;
    if (value === null || (Array.isArray(value) && value.length === 0)) continue;
    answers.push({
      widgetId: widget.widgetId,
      value,
      source: "preexisting",
      reason: "workday_preexisting_value_accepted"
    });
  }
  return new Map(answers.map((answer) => [answer.widgetId, answer]));
}

function isYesNoStyleOptions(options: string[]): boolean {
  const normalized = options.map((option) => normalizeForMatch(option)).filter(Boolean);
  if (!normalized.length) return false;
  return normalized.every((option) => /^(yes|no|answer i don.?t wish to respond|prefer not to answer|decline|not applicable)/.test(option));
}

function looksNumericOnly(value: string): boolean {
  return /^\$?\d+(?:[.,]\d+)?(?:\s*(k|m))?$/.test(normalizeForMatch(value));
}

function isBooleanLikeAnswer(value: string): boolean {
  return /^(yes|no|true|false|y|n|i accept|i do not accept|accept|decline|agree|disagree|authorized|eligible)$/i.test(normalizeText(value));
}

function isSemanticYesNoQuestion(widget: WorkdayWidgetSchema): boolean {
  if (!isOptionBackedWidget(widget)) return false;
  const label = normalizeForMatch(widget.label);
  return (
    isLowRiskDefaultNoQuestion(label) ||
    isGovernmentConflictQuestion(label) ||
    isLegalRightToWorkVerificationQuestion(label) ||
    /authorized.*work|work authorization|eligible to work|sponsorship|visa|security clearance|clearance|consent|i accept|agree/.test(label)
  );
}

function looksLongTextareaAnswer(value: string): boolean {
  const normalized = normalizeText(value);
  return normalized.length > 100 || /[.?!].+[.?!]/.test(normalized);
}

function isExplicitCompensationPrompt(label: string): boolean {
  return /desired compensation|salary expectation|salary range|expected salary|pay expectation|compensation expectation|salary requirement/.test(normalizeForMatch(label));
}

export function validateResolvedWorkdayWidgetAnswer(
  widget: WorkdayWidgetSchema,
  answer: WorkdayWidgetAnswer
): WorkdayWidgetAnswerValidationResult {
  const raw = answer.value;
  if (raw === null || raw === undefined) {
    return { accepted: false, value: null, reason: "empty_answer" };
  }

  if (isOptionBackedWidget(widget)) {
    if (!widget.options.length) {
      if (widget.widgetType === "checkbox_group") {
        const requested = Array.isArray(raw)
          ? raw.map((value) => normalizeText(String(value))).filter(Boolean)
          : String(raw).split(/\s*,\s*/).map((value) => normalizeText(value)).filter(Boolean);
        const accepted = requested.filter((value) => !isResolverPlaceholderText(value));
        return accepted.length ? { accepted: true, value: accepted } : { accepted: false, value: null, reason: "answer_not_in_options" };
      }
      const single = Array.isArray(raw) ? normalizeText(String(raw[0] || "")) : normalizeText(String(raw));
      if (isSemanticYesNoQuestion(widget) && !isBooleanLikeAnswer(single)) {
        return { accepted: false, value: null, reason: "answer_not_in_options" };
      }
      if (isStateLocationIntentQuestion(widget.label) && !looksLikeUsStateAnswer(single)) {
        return { accepted: false, value: null, reason: "answer_not_in_options" };
      }
      return single && !isResolverPlaceholderText(single)
        ? { accepted: true, value: single }
        : { accepted: false, value: null, reason: "answer_not_in_options" };
    }

    if (widget.widgetType === "checkbox_group") {
      const requested = Array.isArray(raw)
        ? raw.map((value) => normalizeText(String(value))).filter(Boolean)
        : String(raw).split(/\s*,\s*/).map((value) => normalizeText(value)).filter(Boolean);
      if (!requested.length) return { accepted: false, value: null, reason: "answer_not_in_options" };
      const picked = requested
        .map((value) => pickOptionByTarget(widget.options, value))
        .filter(Boolean) as string[];
      if (!picked.length) return { accepted: false, value: null, reason: "answer_not_in_options" };
      return { accepted: true, value: [...new Set(picked)] };
    }

    const single = Array.isArray(raw) ? normalizeText(String(raw[0] || "")) : normalizeText(String(raw));
    if (!single) return { accepted: false, value: null, reason: "answer_not_in_options" };
    if (isYesNoStyleOptions(widget.options) && looksNumericOnly(single)) {
      return { accepted: false, value: null, reason: "answer_not_in_options" };
    }
    if (looksLongTextareaAnswer(single) && !widget.options.some((option) => normalizeForMatch(option) === normalizeForMatch(single))) {
      return { accepted: false, value: null, reason: "answer_not_in_options" };
    }
    const picked = pickOptionByTarget(widget.options, single);
    if (!picked) return { accepted: false, value: null, reason: "answer_not_in_options" };
    return { accepted: true, value: picked };
  }

  if (!isExplicitCompensationPrompt(widget.label) && /salary|compensation|pay/.test(normalizeForMatch(widget.label)) === false && Array.isArray(raw) === false && looksNumericOnly(String(raw)) && widget.widgetType !== "text_input" && widget.widgetType !== "textarea") {
    return { accepted: false, value: null, reason: "answer_not_in_options" };
  }

  return { accepted: true, value: raw };
}

function careerLevelClassificationOption(options: string[]): string | null {
  const normalized = options.map((option) => normalizeForMatch(option));
  const hasCareerLevelTerms = normalized.some((option) => /student \/ intern|entry level|manager|director|vice president/.test(option));
  if (!hasCareerLevelTerms) return null;
  return pickOptionByTarget(options, "Student / Intern");
}

function isWotcQuestion(label: string): boolean {
  return match(
    label,
    /work opportunity tax credit/,
    /\bwotc\b/,
    /participate in the work opportunity tax credit program/,
    /voluntary information to the statement below/
  );
}

function resolveVoluntaryDisclosurePreferredValue(
  label: string,
  options: string[],
  profile: NormalizedWorkdayProfile
): string | null {
  const normalizedLabel = normalizeForMatch(label);
  const explicitText = (value: string | undefined): string | null => {
    const normalized = normalizeText(value || "");
    if (!normalized) return null;
    return pickOptionByTarget(options, normalized) || normalized;
  };

  if (/gender/.test(normalizedLabel)) {
    return explicitText(profile.demographics.gender) || pickDeclineOption(options);
  }
  if (/hispanic|latino/.test(normalizedLabel)) {
    return explicitText(profile.demographics.hispanicOrLatino) || pickDeclineOption(options);
  }
  if (/ethnicity|race/.test(normalizedLabel)) {
    return explicitText(profile.demographics.raceEthnicity || profile.demographics.ethnicity) || pickDeclineOption(options);
  }
  if (/veteran/.test(normalizedLabel)) {
    return explicitText(profile.demographics.veteranStatus) || pickDeclineOption(options);
  }
  if (/disability/.test(normalizedLabel)) {
    if (profile.demographics.disabilityStatus === "yes") {
      return options.find((option) => /^yes, i have a disability/i.test(option)) || pickAffirmativeOption(options) || "Yes";
    }
    if (profile.demographics.disabilityStatus === "no") {
      return options.find((option) => /^no, i do not have a disability/i.test(option)) || pickNegativeOption(options) || "No";
    }
    return pickDeclineOption(options);
  }
  return null;
}

export function resolveWorkdayVoluntaryDisclosureOption(
  label: string,
  options: string[],
  profile: NormalizedWorkdayProfile
): string | null {
  return resolveVoluntaryDisclosurePreferredValue(label, options, profile);
}

function currentWidgetDisplayValue(widget: WorkdayWidgetSchema): string {
  if (Array.isArray(widget.currentValue)) return widget.currentValue.join(" / ");
  return String(widget.currentValue || "");
}

function normalizeDateAnswerParts(raw: string | string[] | null | undefined, partCount: 2 | 3): string[] {
  if (Array.isArray(raw)) {
    return raw.map((part) => normalizeText(String(part))).filter(Boolean).slice(0, partCount);
  }
  const value = normalizeText(String(raw || ""));
  if (!value) return [];
  const split = value.split(/[\/\-\s]+/).map((part) => normalizeText(part)).filter(Boolean);
  if (split.length >= partCount) return split.slice(0, partCount);
  return [];
}

function resolveWidgetValueForOptions(widget: WorkdayWidgetSchema, preferredValue: string): string | string[] | null {
  if (!widget.options.length) return preferredValue;
  if (widget.widgetType === "checkbox_group") {
    const selected = preferredValue
      .split(/\s*,\s*/)
      .map((value) => pickOptionByTarget(widget.options, value))
      .filter(Boolean) as string[];
    return selected.length ? selected : null;
  }
  return pickOptionByTarget(widget.options, preferredValue);
}

function resolveWidgetValueForOptionsOrRaw(widget: WorkdayWidgetSchema, preferredValue: string): string | string[] | null {
  const resolved = resolveWidgetValueForOptions(widget, preferredValue);
  if (resolved) return resolved;
  return normalizeText(preferredValue) ? preferredValue : null;
}

function widgetBooleanValue(widget: WorkdayWidgetSchema, wantYes: boolean): string | string[] | null {
  if (!widget.options.length) {
    if (widget.widgetType === "checkbox_group") return wantYes ? ["Yes"] : [];
    return wantYes ? "Yes" : "No";
  }

  if (widget.widgetType === "checkbox_group") {
    if (wantYes && widget.options.length === 1) return [widget.options[0]!];
    const picked = wantYes ? pickAffirmativeOption(widget.options) : pickNegativeOption(widget.options);
    return picked ? [picked] : null;
  }

  const affirmative = pickAffirmativeOption(widget.options);
  const negative = pickNegativeOption(widget.options);
  if (wantYes) return affirmative || (negative ? "Yes" : null) || "Yes";
  return negative || (affirmative ? "No" : null) || "No";
}

function degreeAliases(rawDegree: string): string[] {
  const normalized = normalizeForMatch(rawDegree);
  const aliases = new Set<string>();
  if (!normalized) return [];
  aliases.add(rawDegree);

  if (/\bph\.?d\b|doctor|doctorate/.test(normalized)) {
    aliases.add("PhD");
    aliases.add("Doctorate");
    aliases.add("Doctoral");
  }
  if (/\bm\.?s\b|\bmba\b|master/.test(normalized)) {
    aliases.add("Master");
    aliases.add("Master's");
    aliases.add("Masters");
  }
  if (/\bb\.?s\b|\bb\.?a\b|bachelor/.test(normalized)) {
    aliases.add("Bachelor");
    aliases.add("Bachelor's");
    aliases.add("Bachelors");
  }
  if (/associate/.test(normalized)) {
    aliases.add("Associate");
  }
  if (/high school|ged/.test(normalized)) {
    aliases.add("High School");
    aliases.add("GED");
  }

  return [...aliases];
}

function resolveDegreeWidgetValue(widget: WorkdayWidgetSchema, degree: string): string | string[] | null {
  if (!degree) return null;
  for (const alias of degreeAliases(degree)) {
    const picked = resolveWidgetValueForOptions(widget, alias);
    if (picked) return picked;
  }
  return resolveWidgetValueForOptions(widget, degree);
}

function resolveEducationFact(profile: NormalizedWorkdayProfile): NormalizedWorkdayProfile["education"][number] | null {
  return profile.education[0] || null;
}

function isEducationWidget(widget: WorkdayWidgetSchema): boolean {
  const key = normalizeForMatch([
    widget.label,
    widget.promptText,
    String(widget.selectorHints.dataAutomationId || ""),
    String(widget.selectorHints.controlSelector || ""),
    String(widget.selectorHints.containerSelector || ""),
    String(widget.htmlSummary.sectionKind || ""),
    String(widget.htmlSummary.panelKind || "")
  ].join(" "));
  if (/educationsection/.test(key)) return true;
  return /school|university|college|degree|major|field of study|fieldofstudy|discipline|grade average|gradeaverage|gpa|overall|graduation|language|first year attended|firstyearattended|last year attended|lastyearattended|actual or expected/.test(key);
}

function educationDateParts(
  widget: WorkdayWidgetSchema,
  year: string | undefined,
  month: string | undefined,
  kind: "start" | "end"
): string[] | null {
  if (!year) return null;
  const normalizedMonth = normalizeText(month || (kind === "end" ? "05" : "01"));
  if (widget.widgetType === "date_mm_yyyy") return [normalizedMonth, year];
  if (widget.widgetType === "date_mm_dd_yyyy") return [normalizedMonth, "01", year];
  return null;
}

function graduationDateParts(
  widget: WorkdayWidgetSchema,
  education: NormalizedWorkdayProfile["education"][number] | null
): string[] | null {
  if (!education) return null;
  const normalized = normalizeGraduationDateFormats({
    graduationDateMmDdYyyy: education.graduationDateMmDdYyyy,
    graduationDateMmYyyy: education.graduationDateMmYyyy,
    endMonth: education.endMonth,
    endYear: education.endYear
  });
  if (widget.widgetType === "date_mm_dd_yyyy" && normalized.graduationDateMmDdYyyy) {
    return normalized.graduationDateMmDdYyyy.split("/");
  }
  if (widget.widgetType === "date_mm_yyyy" && normalized.graduationDateMmYyyy) {
    return normalized.graduationDateMmYyyy.split("/");
  }
  if (normalized.month && normalized.year) {
    return widget.widgetType === "date_mm_dd_yyyy"
      ? [normalized.month, normalized.day || "01", normalized.year]
      : [normalized.month, normalized.year];
  }
  return null;
}

function resolveMyExperienceEducationWidgetValue(
  widget: WorkdayWidgetSchema,
  education: NormalizedWorkdayProfile["education"][number] | null
): string | string[] | null {
  if (!education || !isEducationWidget(widget)) return null;
  const label = normalizeForMatch([
    widget.label,
    widget.promptText,
    widget.widgetId,
    widget.visibleContainerId,
    String(widget.selectorHints.dataAutomationId || ""),
    String(widget.selectorHints.controlSelector || ""),
    String(widget.selectorHints.containerSelector || "")
  ].join(" "));
  const isLanguageSection = /\blanguage\b|language_\d+|native|i am fluent in this language/.test(label);

  if (/school|university|college/.test(label)) return resolveWidgetValueForOptions(widget, education.school);
  if (/degree program|degree/.test(label)) return resolveDegreeWidgetValue(widget, education.degree);
  if (/field of study|major|discipline/.test(label)) return resolveWidgetValueForOptions(widget, education.fieldOfStudy);
  if (isLanguageSection && /overall|proficiency|fluency|level/.test(label)) {
    return resolveWidgetValueForOptionsOrRaw(widget, "4 - Fluent") ||
      resolveWidgetValueForOptionsOrRaw(widget, "Fluent") ||
      resolveWidgetValueForOptionsOrRaw(widget, "4");
  }
  if (isLanguageSection && /i am fluent in this language|native/.test(label)) {
    return resolveWidgetValueForOptions(widget, "I am fluent in this language.") || resolveWidgetValueForOptions(widget, "Yes");
  }
  if (/overall|gpa|grade average/.test(label)) return resolveWidgetValueForOptions(widget, education.gpa || "");
  if (/\blanguage\b/.test(label)) return resolveWidgetValueForOptionsOrRaw(widget, "English");

  if (/to\b|actual or expected|end date|graduation date|last year attended|lastyearattended/.test(label)) {
    const dateValue = educationDateParts(widget, education.endYear, education.endMonth, "end");
    if (dateValue) return dateValue;
    return education.endYear;
  }

  if (/from\b|start date|first year attended|firstyearattended/.test(label)) {
    const dateValue = educationDateParts(widget, education.startYear, education.startMonth, "start");
    if (dateValue) return dateValue;
    return education.startYear || null;
  }

  return null;
}

function resolveSalaryExpectation(profile: CandidateProfile): string {
  const custom = profile.customAnswers || {};
  return String(
    custom["salary expectations"] ||
    custom["salary expectation"] ||
    custom["expected salary"] ||
    profile.salary ||
    "120000"
  ).trim();
}

function parseNumberFromOption(option: string): number | null {
  const t = normalizeForMatch(option);
  const range = t.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  const plus = t.match(/(\d+)\s*\+/);
  if (plus) return Number(plus[1]) + 0.5;
  const single = t.match(/\b(\d+)\b/);
  return single ? Number(single[1]) : null;
}

function pickClosestExperienceOption(options: string[], years: number): string | null {
  const candidates = options
    .map((raw) => ({ raw, score: parseNumberFromOption(raw) }))
    .filter((entry) => Number.isFinite(entry.score)) as Array<{ raw: string; score: number }>;
  if (!candidates.length) return null;
  candidates.sort((a, b) => Math.abs(a.score - years) - Math.abs(b.score - years));
  return candidates[0]?.raw ?? null;
}

function deterministicQuestionAnswer(
  field: WorkdayQuestionnaireField,
  profile: NormalizedWorkdayProfile
): WorkdayQuestionResolution | null {
  const question = normalizeForMatch(field.labelText);
  const options = field.options;
  const hasOptions = options.length > 0;
  const authYes = profile.workAuthorization.authorizedInUS || profile.workAuthorization.usCitizen === true || profile.workAuthorization.permanentResident === true;
  const exportYes = profile.exportControl.usPerson ?? profile.workAuthorization.usCitizen ?? profile.workAuthorization.permanentResident ?? authYes;
  const primaryEducation = resolveEducationFact(profile);

  if (/18 years of age or older|over the age of 18|at least 18/.test(question)) {
    const picked = hasOptions ? pickAffirmativeOption(options) : "Yes";
    if (picked) return { value: picked, source: "deterministic", confidence: 1, reason: "adult_age_default_yes", manualReview: false };
  }

  if (/ernst\s*&\s*young|current or former employee/.test(question)) {
    const picked = hasOptions ? pickNegativeOption(options) : "No";
    if (picked) return { value: picked, source: "deterministic", confidence: 1, reason: "previous_employer_default_no", manualReview: false };
  }

  if (/immediate family member.*partner at ernst/.test(question)) {
    const picked = hasOptions ? pickNegativeOption(options) : "No";
    if (picked) return { value: picked, source: "deterministic", confidence: 1, reason: "family_member_conflict_default_no", manualReview: false };
  }

  if (/non-competition|non-disclosure|non-solicitation|impact or interfere/.test(question)) {
    const picked = hasOptions ? pickNegativeOption(options) : "No";
    if (picked) return { value: picked, source: "deterministic", confidence: 0.95, reason: "employment_restriction_default_no", manualReview: false };
  }

  if (/non-compete/.test(question)) {
    const picked = hasOptions ? pickNegativeOption(options) : "No";
    if (picked) return { value: picked, source: "deterministic", confidence: 0.95, reason: "employment_restriction_default_no", manualReview: false };
  }

  if (/intellectual property rights|patents|trademarks|copyrights/.test(question)) {
    const picked = hasOptions ? pickNegativeOption(options) : "No";
    if (picked) return { value: picked, source: "deterministic", confidence: 0.95, reason: "ip_rights_default_no", manualReview: false };
  }

  if (/if hired, do you intend to/.test(question)) {
    const picked = hasOptions ? (pickNeitherOption(options) || pickNegativeOption(options)) : "Neither";
    if (picked) return { value: picked, source: "deterministic", confidence: 0.95, reason: "future_activity_default_neither", manualReview: false };
  }

  const workAuthPattern = [
    /lawfully permitted to work/,
    /legally authorised to work/,
    /legally authorized to work/,
    /legally permitted to work/,
    /authorized to work/,
    /work authorization/,
    /eligible to work/
  ];
  if (containsAny(question, workAuthPattern)) {
    const picked = hasOptions ? (authYes ? pickAffirmativeOption(options) : pickNegativeOption(options)) : (authYes ? "Yes" : "No");
    if (picked) return { value: picked, source: "deterministic", confidence: 1, reason: "work_auth_profile", manualReview: false };
  }

  if (/sponsorship|visa/.test(question)) {
    const noSponsorship = !profile.workAuthorization.requiresSponsorship;
    const picked = hasOptions ? (noSponsorship ? pickNegativeOption(options) : pickAffirmativeOption(options)) : (noSponsorship ? "No" : "Yes");
    if (picked) return { value: picked, source: "deterministic", confidence: 1, reason: "sponsorship_profile", manualReview: false };
  }

  if (/eligible.*(defense|defence|security clearance)|eligible to obtain.*clearance/.test(question)) {
    const picked = hasOptions ? (authYes ? pickAffirmativeOption(options) : pickNegativeOption(options)) : (authYes ? "Yes" : "No");
    if (picked) return { value: picked, source: "deterministic", confidence: 0.9, reason: "clearance_best_effort", manualReview: false };
  }

  if (/currently employed by the us government|department of defense|federal, state or local government employee|federal state or local government employee|active duty|reserves|national guard/.test(question)) {
    const picked = hasOptions ? (pickNegativeOption(options) || pickBestOption(options, (v) => /not applicable/.test(v))) : "No";
    if (picked) return { value: picked, source: "deterministic", confidence: 0.85, reason: "gov_military_default_no", manualReview: false };
  }

  if (/held an active security clearance.*past 2 years|active security clearance/.test(question)) {
    const picked = hasOptions ? pickNegativeOption(options) : "No";
    if (picked) return { value: picked, source: "deterministic", confidence: 0.85, reason: "active_clearance_default_no", manualReview: false };
  }

  if (/how many years.*relevant experience|years of experience/.test(question)) {
    const years = Number(profile.experience.length > 0 ? profile.experience.length : 0) || 0;
    const picked = hasOptions ? pickClosestExperienceOption(options, years) : String(profile.experience.length || 0);
    if (picked) return { value: picked, source: "deterministic", confidence: 0.85, reason: "experience_years_profile", manualReview: false };
  }

  if (isAvailabilityStartQuestion(question)) {
    if (hasOptions) {
      const picked = pickEarliestStartOption(options);
      if (picked) return { value: picked, source: "deterministic", confidence: 0.85, reason: "availability_date_earliest", manualReview: false };
    }
    const availability = resolveAvailabilityDate(profile);
    if (!availability) return null;
    const textLike = field.inputKind === "text" || field.inputKind === "textarea";
    return {
      value: textLike ? availability.formattedDmy : availability.formatted,
      source: "deterministic",
      confidence: 0.85,
      reason: "availability_date_profile",
      manualReview: false
    };
  }

  if (/ever been employed by cae|previously worked for|previous worker|previously employed/.test(question)) {
    const picked = hasOptions ? pickNegativeOption(options) : "No";
    if (picked) return { value: picked, source: "deterministic", confidence: 1, reason: "previous_employer_default_no", manualReview: false };
  }

  if (/background check|drug screen|condition of employment|agree to comply|terms and conditions|read and consent|privacy|tobacco|alcohol|workplace policies/.test(question)) {
    const picked = hasOptions ? (pickAffirmativeOption(options) || options[0] || null) : "Yes";
    if (picked) return { value: picked, source: "deterministic", confidence: 0.95, reason: "policy_acknowledgement_yes", manualReview: false };
  }

  if (primaryEducation && /degree currently pursuing|current degree|degree program|what degree/.test(question)) {
    const picked = hasOptions
      ? degreeAliases(primaryEducation.degree).map((alias) => pickOptionByTarget(options, alias)).find(Boolean) || null
      : primaryEducation.degree;
    if (picked) return { value: picked, source: "deterministic", confidence: 0.95, reason: "education_degree_profile", manualReview: false };
  }

  if (primaryEducation && /gpa|cumulative gpa|out of 4\.0/.test(question)) {
    const picked = hasOptions ? pickOptionByTarget(options, primaryEducation.gpa || "") : primaryEducation.gpa || null;
    if (picked) return { value: picked, source: "deterministic", confidence: 0.95, reason: "education_gpa_profile", manualReview: false };
  }

  if (primaryEducation && /school|university|college/.test(question)) {
    const picked = hasOptions ? pickOptionByTarget(options, primaryEducation.school) : primaryEducation.school;
    if (picked) return { value: picked, source: "deterministic", confidence: 0.9, reason: "education_school_profile", manualReview: false };
  }

  if (primaryEducation && /major|field of study|discipline/.test(question)) {
    const picked = hasOptions ? pickOptionByTarget(options, primaryEducation.fieldOfStudy) : primaryEducation.fieldOfStudy;
    if (picked) return { value: picked, source: "deterministic", confidence: 0.9, reason: "education_field_profile", manualReview: false };
  }

  if (/willing to relocate|open to relocation/.test(question)) {
    const customRelocation = profile.workAuthorization.authorizedInUS;
    const picked = hasOptions ? (customRelocation ? (pickAffirmativeOption(options) || pickNegativeOption(options)) : pickNegativeOption(options)) : (customRelocation ? "Yes" : "No");
    if (picked) return { value: picked, source: "deterministic", confidence: 0.8, reason: "relocation_profile", manualReview: false };
  }

  if (/percentage.*travel|able to travel|willing to travel|how much.*travel|%.*travel|travel.*%|can travel/.test(question)) {
    const picked = hasOptions
      ? (pickOptionByTarget(options, "25%") || pickOptionByTarget(options, "20%") || pickOptionByTarget(options, "0%") || options.find((option) => normalizeForMatch(option) !== "select one") || null)
      : "25%";
    if (picked) return { value: picked, source: "deterministic", confidence: 0.8, reason: "travel_default_moderate", manualReview: false };
  }

  if (/retain your application|share it internally|consent|acknowledgement|agree/.test(question)) {
    const picked = hasOptions ? pickAffirmativeOption(options) : "Yes";
    if (picked) return { value: picked, source: "deterministic", confidence: 0.95, reason: "consent_ack_yes", manualReview: false };
  }

  if (/export control|u\.?s\. citizen or national|lawful permanent resident|refugee or asylee/.test(question)) {
    const picked = hasOptions ? (exportYes ? pickAffirmativeOption(options) : pickNegativeOption(options)) : (exportYes ? "Yes" : "No");
    if (picked) return { value: picked, source: "deterministic", confidence: 1, reason: "export_control_profile", manualReview: false };
  }

  return null;
}

export async function resolveQuestionnaireField(input: {
  field: WorkdayQuestionnaireField;
  profile: NormalizedWorkdayProfile;
  profileRaw: CandidateProfile;
  jobContext: WorkdayJobContext;
  aiEngine: import("../../ai/engine.js").AnswerEngine;
  resumeText: string;
}): Promise<WorkdayQuestionResolution> {
  const salaryQuestion = normalizeForMatch(input.field.labelText);
  if (/salary expectation|salary range|compensation expectation|expected salary/.test(salaryQuestion)) {
    const custom = input.profileRaw.customAnswers || {};
    const customSalary = String(custom["salary expectations"] || custom["salary expectation"] || custom["expected salary"] || "").trim();
    const fallback = customSalary || "USD 120000";
    return { value: fallback, source: "deterministic", confidence: 0.8, reason: "salary_expectation_default", manualReview: false };
  }

  const deterministic = deterministicQuestionAnswer(input.field, input.profile);
  if (deterministic) return deterministic;

  const questionType: QuestionType =
    input.field.inputKind === "textarea"
      ? "textarea"
      : input.field.inputKind === "dropdown" || input.field.inputKind === "radio"
        ? "single_select"
        : input.field.inputKind === "checkbox"
          ? "boolean"
          : "text";

  const answers = await input.aiEngine.resolve([{
    id: input.field.fieldId,
    label: input.field.labelText,
    type: questionType,
    required: input.field.required,
    options: input.field.options,
    platformMeta: {
      platform: "workday",
      inputKind: input.field.inputKind,
      strictOptionConstraint: input.field.options.length > 0,
      fieldContext: [
        "Return a safe factual answer from profile context only.",
        "Do not invent clearance, military, legal, criminal, certification, or employment history facts.",
        "If options are provided, answer must match one option exactly."
      ].join(" ")
    }
  }], {
    profile: input.profileRaw,
    resumeText: input.resumeText,
    jobTitle: input.jobContext.jobTitle,
    company: input.jobContext.company,
    companyContext: "Workday required questionnaire resolution fallback.",
    platform: "workday"
  }).catch(() => []);

  const answer = answers[0]?.value;
  if (answer === null || answer === undefined) {
    return { value: null, source: "manual_review", confidence: 0, reason: "llm_no_answer", manualReview: true };
  }
  const asString = String(Array.isArray(answer) ? answer[0] : answer).trim();
  if (!asString) return { value: null, source: "manual_review", confidence: 0, reason: "llm_empty_answer", manualReview: true };

  if (input.field.options.length > 0) {
    const exact = input.field.options.find((option) => normalizeForMatch(option) === normalizeForMatch(asString));
    if (!exact) return { value: null, source: "manual_review", confidence: 0, reason: "llm_not_in_options", manualReview: true };
    return { value: exact, source: "llm", confidence: 0.65, reason: "llm_option_match", manualReview: false };
  }

  return { value: asString, source: "llm", confidence: 0.6, reason: "llm_text_fallback", manualReview: false };
}

export function toQuestionnaireResolutionRecord(
  field: WorkdayQuestionnaireField,
  resolution: WorkdayQuestionResolution,
  extras?: {
    attemptedStrategies?: string[];
    applied?: boolean;
    verified?: boolean;
    failureReason?: string;
  }
): QuestionnaireResolutionRecord {
  return {
    label: field.labelText,
    inputKind: field.inputKind,
    options: field.options,
    selected: resolution.value,
    source: resolution.source,
    confidence: resolution.confidence,
    reason: resolution.reason,
    requiresManualReview: resolution.manualReview,
    attemptedStrategies: extras?.attemptedStrategies ?? [],
    applied: extras?.applied ?? false,
    verified: extras?.verified ?? false,
    failureReason: extras?.failureReason
  };
}

export function resolveWorkdayDeterministic(
  schema: WorkdayFieldSchema[],
  profile: NormalizedWorkdayProfile,
  currentStep: WorkdayStep
): Map<string, ResolvedAnswer> {
  const resolved: ResolvedAnswer[] = [];
  const today = currentDateParts();

  for (const field of schema) {
    const label = field.label;
    const fieldId = field.fieldId.toLowerCase();
    const domId = String(field.htmlSummary.id || "").toLowerCase();
    const automationId = (field.selectorHints.dataAutomationId || "").toLowerCase();
    const fieldKey = `${label.toLowerCase()} ${automationId} ${domId} ${fieldId}`;

    if (/candidateispreviousworker/.test(fieldId) || /candidateispreviousworker/.test(automationId)) {
      const valueText = String(field.htmlSummary.valueText || field.currentValue || "").toLowerCase();
      if (match(label, /^\s*no\s*$/i) || valueText === "false" || valueText === "no") {
        pushAnswer(resolved, field, "No", "workday_contact_previous_worker_default_no");
      }
      continue;
    }

    if (match(label, /eligible to work/, /without visa sponsorship/)) {
      pushAnswer(resolved, field, resolveEligibilityWithoutSponsorship(profile), "workday_auth_eligible_without_sponsorship");
      continue;
    }
    if (match(label, /self-identify as a veteran/, /\bveteran\b/)) {
      pushAnswer(resolved, field, profile.demographics.veteranStatus || "I am not a veteran", "workday_demo_veteran_default");
      continue;
    }
    if (match(label, /tobacco/, /drug.*alcohol/, /agree to comply/)) {
      pushAnswer(resolved, field, "Yes", "workday_policy_acknowledge_yes");
      continue;
    }
    if (isLanguageQuestion(label)) {
      pushAnswer(resolved, field, "Fluent", "workday_language_proficiency_default_fluent");
      continue;
    }

    if (currentStep === "contact_information") {
      if (match(label, /first name/, /legal.*first/)) pushAnswer(resolved, field, profile.identity.firstName, "workday_contact_first_name");
      else if (field.fieldType === "radio" && match(label, /^\s*no\s*$/i) && String(field.htmlSummary.valueText || "").toLowerCase() === "false") {
        pushAnswer(resolved, field, "No", "workday_contact_radio_no_default");
      }
      else if (match(label, /father'?s family name/, /mother'?s family name/, /second last name/, /maternal surname/, /paternal surname/)) {
        pushAnswer(resolved, field, profile.identity.lastName, "workday_contact_family_name_fallback_last_name");
      }
      else if (match(label, /last name/, /legal.*last/)) pushAnswer(resolved, field, profile.identity.lastName, "workday_contact_last_name");
      else if (match(label, /full name/)) pushAnswer(resolved, field, profile.identity.fullName, "workday_contact_full_name");
      else if (match(label, /suffix/)) pushAnswer(resolved, field, profile.identity.suffix || null, "workday_contact_suffix");
      else if (match(label, /address line 1/, /^address$/)) pushAnswer(resolved, field, profile.contact.address.line1, "workday_contact_address1");
      else if (match(label, /address line 2/)) pushAnswer(resolved, field, profile.contact.address.line2 || null, "workday_contact_address2");
      else if (match(label, /city/)) pushAnswer(resolved, field, profile.contact.address.city, "workday_contact_city");
      else if (match(label, /country\/region phone code/, /country phone code/, /phone code/)) {
        pushAnswer(resolved, field, "United States of America (+1)", "workday_contact_phone_code_us");
      }
      else if (match(label, /state/, /region/)) pushAnswer(resolved, field, profile.contact.address.state, "workday_contact_state");
      else if (match(label, /postal/, /zip/)) pushAnswer(resolved, field, profile.contact.address.postalCode, "workday_contact_postal");
      else if (match(label, /country/)) pushAnswer(resolved, field, profile.contact.address.country, "workday_contact_country");
      else if (match(label, /phone type/, /phone device type/) || /phone-device-type/.test(fieldKey)) {
        pushAnswer(resolved, field, profile.contact.phoneType, "workday_contact_phone_type");
      } else if (match(label, /extension/)) {
        pushAnswer(resolved, field, null, "workday_contact_extension_skip");
      } else if (isSourceQuestion(label) || /\bsource\b/.test(automationId)) {
        pushAnswer(
          resolved,
          field,
          resolveSourceOption(field.possibleAnswers, profile),
          "workday_contact_source_preferred"
        );
      }
      else if (match(label, /phone/)) pushAnswer(resolved, field, profile.contact.phone, "workday_contact_phone");
      else if (match(label, /email/)) pushAnswer(resolved, field, profile.contact.email, "workday_contact_email");
      else if (field.fieldType === "file" || match(label, /upload a file/, /resume|cv/)) {
        pushAnswer(resolved, field, profile.files.resumePath || null, "workday_contact_resume_upload");
      }
      else if (isEmployerHistoryQuestion(label)) {
        pushAnswer(
          resolved,
          field,
          resolveEmployerHistoryFieldValue(field.possibleAnswers, profile, label),
          profileShowsEmployerHistory(profile, label) ? "workday_contact_previous_worker_profile_yes" : "workday_contact_previous_worker_default_no"
        );
      }
    }

    if (currentStep === "voluntary_disclosures" || currentStep === "self_identification") {
      if (match(label, /gender/)) pushAnswer(resolved, field, resolveVoluntaryDisclosurePreferredValue(field.label, field.possibleAnswers, profile) || profile.demographics.gender || "Decline to self-identify", "workday_demo_gender");
      else if (match(label, /hispanic|latino/)) pushAnswer(resolved, field, resolveVoluntaryDisclosurePreferredValue(field.label, field.possibleAnswers, profile) || profile.demographics.hispanicOrLatino || "I do not wish to answer", "workday_demo_hispanic");
      else if (match(label, /ethnicity|race/)) pushAnswer(resolved, field, resolveVoluntaryDisclosurePreferredValue(field.label, field.possibleAnswers, profile) || profile.demographics.raceEthnicity || profile.demographics.ethnicity || "Decline to identify", "workday_demo_ethnicity");
      else if (match(label, /veteran/)) pushAnswer(resolved, field, resolveVoluntaryDisclosurePreferredValue(field.label, field.possibleAnswers, profile) || profile.demographics.veteranStatus || "I am not a protected veteran", "workday_demo_veteran");
      else if (currentStep === "self_identification" && (/datesignedon/.test(fieldId) || /datesignedon/.test(automationId))) {
        if (/datesectionmonth/.test(fieldId)) pushAnswer(resolved, field, today.month, "workday_self_id_date_month");
        else if (/datesectionday/.test(fieldId)) pushAnswer(resolved, field, today.day, "workday_self_id_date_day");
        else if (/datesectionyear/.test(fieldId)) pushAnswer(resolved, field, today.year, "workday_self_id_date_year");
        else pushAnswer(resolved, field, today.formatted, "workday_self_id_date");
      } else if (/^yes, i have a disability/.test(label.toLowerCase())) {
        pushAnswer(resolved, field, profile.demographics.disabilityStatus === "yes", "workday_demo_disability_yes_option");
      } else if (/^no, i do not have a disability/.test(label.toLowerCase())) {
        pushAnswer(resolved, field, profile.demographics.disabilityStatus !== "yes" && profile.demographics.disabilityStatus !== "decline", "workday_demo_disability_no_option");
      } else if (/do not want to answer|don't wish to answer|decline/.test(label.toLowerCase())) {
        pushAnswer(resolved, field, profile.demographics.disabilityStatus === "decline", "workday_demo_disability_decline_option");
      } else if (match(label, /disability/)) {
        const v = profile.demographics.disabilityStatus;
        if (field.possibleAnswers.length > 0) {
          const target = v === "yes"
            ? field.possibleAnswers.find((option) => /^yes, i have a disability/i.test(option))
            : v === "no"
              ? field.possibleAnswers.find((option) => /^no, i do not have a disability/i.test(option))
              : field.possibleAnswers.find((option) => /do not want to answer|don't wish to answer|decline/i.test(option));
          pushAnswer(resolved, field, target || null, "workday_demo_disability_option");
        } else {
          pushAnswer(resolved, field, v === "yes" ? "Yes" : v === "no" ? "No" : "I don't wish to answer", "workday_demo_disability");
        }
      } else if (currentStep === "self_identification" && match(label, /name/)) {
        pushAnswer(resolved, field, profile.identity.fullName, "workday_self_id_name");
      }
    }

    if (currentStep === "application_questions" || currentStep === "unknown") {
      if (match(label, /18 years of age or older/, /over the age of 18/, /at least 18/)) {
        pushAnswer(resolved, field, "Yes", "workday_questionnaire_adult_age_yes");
      } else if (match(label, /ernst\s*&\s*young/, /current or former employee/)) {
        pushAnswer(resolved, field, "No", "workday_questionnaire_previous_employer_no");
      } else if (match(label, /immediate family member/, /partner at ernst/)) {
        pushAnswer(resolved, field, "No", "workday_questionnaire_family_member_no");
      } else if (match(label, /non-competition/, /non-disclosure/, /non-solicitation/, /impact or interfere/)) {
        pushAnswer(resolved, field, "No", "workday_questionnaire_employment_restriction_no");
      } else if (match(label, /non-compete/)) {
        pushAnswer(resolved, field, "No", "workday_questionnaire_employment_restriction_no");
      } else if (match(label, /intellectual property rights/, /patents/, /trademarks/, /copyrights/)) {
        pushAnswer(resolved, field, "No", "workday_questionnaire_ip_rights_no");
      } else if (match(label, /if hired, do you intend to/)) {
        pushAnswer(resolved, field, "Neither", "workday_questionnaire_future_activity_neither");
      } else if (match(label, /department of defense/, /federal, state or local government employee/, /government employee/)) {
        pushAnswer(resolved, field, "No", "workday_questionnaire_government_employee_no");
      } else if (match(label, /willing to relocate/, /open to relocation/, /open to relocate/, /relocate\/work in other cities/, /work in other cities/)) {
        pushAnswer(resolved, field, "Yes", "workday_questionnaire_relocation_yes");
      } else if (isAvailabilityStartQuestion(label)) {
        const availability = resolveAvailabilityDate(profile);
        if (availability) {
          const availabilityValue = field.fieldType === "text" || field.fieldType === "textarea"
            ? availability.formattedDmy
            : availability.formatted;
          pushAnswer(resolved, field, availabilityValue, "workday_questionnaire_availability_date");
        }
      } else if (match(label, /percentage.*travel/, /able to travel/, /willing to travel/, /how much.*travel/, /%.*travel/, /travel.*%/, /can travel/)) {
        pushAnswer(resolved, field, "25%", "workday_questionnaire_travel_moderate");
      } else if (isWorkAuthorizationQuestionLabel(label)) {
        pushAnswer(resolved, field, profile.workAuthorization.authorizedInUS ? "Yes" : "No", "workday_auth_authorized");
      } else if (match(label, /sponsorship|visa/)) {
        pushAnswer(resolved, field, profile.workAuthorization.requiresSponsorship ? "Yes" : "No", "workday_auth_sponsorship");
      } else if (isWotcQuestion(label)) {
        pushAnswer(
          resolved,
          field,
          pickOptionByTarget(field.possibleAnswers, "Answer I don’t wish to respond") || pickOptionByTarget(field.possibleAnswers, "Answer I don't wish to respond"),
          "workday_questionnaire_wotc_decline",
          "rule"
        );
      } else if (match(label, /u\.?s\.? person|export control/, /u\.?s\. citizen or national/, /lawful permanent resident/, /refugee or asylee/)) {
        const exportYes = profile.exportControl.usPerson ?? profile.workAuthorization.usCitizen ?? profile.workAuthorization.permanentResident ?? profile.workAuthorization.authorizedInUS;
        pushAnswer(resolved, field, exportYes === true ? "Yes" : exportYes === false ? "No" : null, "workday_export_control");
      } else if (isSourceQuestion(label)) {
        pushAnswer(resolved, field, resolveSourceOption(field.possibleAnswers, profile), "workday_questionnaire_source_preferred", "rule");
      } else if (match(label, /linkedin/)) {
        pushAnswer(resolved, field, profile.links.linkedin || null, "workday_links_linkedin");
      } else if (match(label, /github/)) {
        pushAnswer(resolved, field, profile.links.github || null, "workday_links_github");
      } else if (match(label, /portfolio|website/)) {
        pushAnswer(resolved, field, profile.links.portfolio || profile.links.other?.[0] || null, "workday_links_portfolio");
      }
    }
  }

  return new Map(resolved.map((a) => [a.questionId, a]));
}

export function resolveWorkdayWidgetDeterministic(
  widgets: WorkdayWidgetSchema[],
  profile: NormalizedWorkdayProfile,
  currentStep: WorkdayStep,
  options?: {
    contextWidgets?: WorkdayWidgetSchema[];
    jobContext?: WorkdayJobContext;
  }
): Map<string, WorkdayWidgetAnswer> {
  const resolved: WorkdayWidgetAnswer[] = [];
  const today = currentDateParts();
  const primaryEducation = resolveEducationFact(profile);
  const nearbyContext = buildNearbyQuestionContext(options?.contextWidgets || widgets);

  for (const widget of widgets) {
    const label = widget.label;
    const widgetKey = normalizeForMatch(`${label} ${widget.selectorHints.dataAutomationId || ""} ${widget.widgetId}`);

    if (widget.widgetType === "panel_collection") {
      if (currentStep === "my_experience") continue;
      if (/workexperience/.test(widgetKey) && profile.experience.length > 0) {
        pushWidgetAnswer(resolved, widget, "reconcile", "workday_experience_panel_reconcile", "rule");
        continue;
      }
      if (/education/.test(widgetKey) && profile.education.length > 0) {
        pushWidgetAnswer(resolved, widget, "reconcile", "workday_education_panel_reconcile", "rule");
        continue;
      }
      continue;
    }

    if (widget.widgetType === "file_upload" && profile.files.resumePath) {
      pushWidgetAnswer(resolved, widget, profile.files.resumePath, "workday_resume_upload");
      continue;
    }

    if (widget.widgetType === "date_mm_yyyy" || widget.widgetType === "date_mm_dd_yyyy") {
      if (currentStep === "self_identification" && /date signed|signed on|datesignedon/.test(widgetKey)) {
        const value = widget.widgetType === "date_mm_yyyy"
          ? [today.month, today.year]
          : [today.month, today.day, today.year];
        pushWidgetAnswer(resolved, widget, value, "workday_self_id_signed_date");
      }
      if (currentStep === "my_experience") {
        const value = resolveMyExperienceEducationWidgetValue(widget, primaryEducation);
        if (value) {
          pushWidgetAnswer(resolved, widget, value, "workday_my_experience_education_date", "rule");
          continue;
        }
      }
      if ((currentStep === "application_questions" || currentStep === "unknown") && isGraduationDateQuestion(label)) {
        const graduationValue = graduationDateParts(widget, primaryEducation);
        if (graduationValue) {
          pushWidgetAnswer(resolved, widget, graduationValue, "workday_questionnaire_graduation_date", "rule");
          continue;
        }
      }
      if ((currentStep === "application_questions" || currentStep === "unknown") && isAvailabilityStartQuestion(label)) {
        const availability = resolveAvailabilityDate(profile);
        if (availability) {
          const value = widget.widgetType === "date_mm_yyyy"
            ? [availability.month, availability.year]
            : [availability.month, availability.day, availability.year];
          pushWidgetAnswer(resolved, widget, value, "workday_questionnaire_availability_date");
        }
      }
      continue;
    }

    if (currentStep === "my_experience") {
      if (/type to add skills|\bskills?\b/.test(normalizeForMatch(widget.label)) && profile.skills.length > 0) {
        pushWidgetAnswer(resolved, widget, profile.skills[0]!, "workday_my_experience_skill_profile", "rule");
        continue;
      }
      const value = resolveMyExperienceEducationWidgetValue(widget, primaryEducation);
      if (value) {
        pushWidgetAnswer(resolved, widget, value, "workday_my_experience_education_profile", "rule");
        continue;
      }
    }

    if (
      (currentStep === "application_questions" || currentStep === "unknown") &&
      widget.widgetType !== "checkbox_group" &&
      isAvailabilityStartQuestion(label)
    ) {
      const availability = resolveAvailabilityDate(profile);
      if (availability) {
        const availabilityValue = widget.widgetType === "textarea" || widget.widgetType === "text_input"
          ? availability.formattedDmy
          : availability.formatted;
        pushWidgetAnswer(resolved, widget, availabilityValue, "workday_questionnaire_availability_date");
      }
      continue;
    }

    if (currentStep === "contact_information") {
      if (match(label, /first name/, /legal.*first/)) pushWidgetAnswer(resolved, widget, profile.identity.firstName, "workday_contact_first_name");
      else if (match(label, /father'?s family name/, /mother'?s family name/, /second last name/, /maternal surname/, /paternal surname/)) {
        pushWidgetAnswer(resolved, widget, profile.identity.lastName, "workday_contact_family_name_fallback_last_name");
      }
      else if (match(label, /last name/, /legal.*last/)) pushWidgetAnswer(resolved, widget, profile.identity.lastName, "workday_contact_last_name");
      else if (match(label, /full name/)) pushWidgetAnswer(resolved, widget, profile.identity.fullName, "workday_contact_full_name");
      else if (match(label, /suffix/)) pushWidgetAnswer(resolved, widget, profile.identity.suffix || null, "workday_contact_suffix");
      else if (match(label, /address line 1/, /^address$/)) pushWidgetAnswer(resolved, widget, profile.contact.address.line1, "workday_contact_address1");
      else if (match(label, /address line 2/)) pushWidgetAnswer(resolved, widget, profile.contact.address.line2 || null, "workday_contact_address2");
      else if (match(label, /city/)) pushWidgetAnswer(resolved, widget, profile.contact.address.city, "workday_contact_city");
      else if (match(label, /country\/region phone code/, /country phone code/, /phone code/)) {
        pushWidgetAnswer(resolved, widget, resolveWidgetValueForOptions(widget, "United States of America (+1)"), "workday_contact_phone_code_us");
      }
      else if (match(label, /state/, /region/)) pushWidgetAnswer(resolved, widget, profile.contact.address.state, "workday_contact_state");
      else if (match(label, /postal/, /zip/)) pushWidgetAnswer(resolved, widget, profile.contact.address.postalCode, "workday_contact_postal");
      else if (match(label, /country/)) pushWidgetAnswer(resolved, widget, profile.contact.address.country, "workday_contact_country");
      else if (match(label, /phone type/, /phone device type/)) pushWidgetAnswer(resolved, widget, resolveWidgetValueForOptions(widget, profile.contact.phoneType), "workday_contact_phone_type");
      else if (match(label, /extension/)) pushWidgetAnswer(resolved, widget, null, "workday_contact_extension_skip");
      else if (isSourceQuestion(label) || /\bsource\b/.test(widgetKey)) {
        pushWidgetAnswer(
          resolved,
          widget,
          resolveSourceOption(widget.options, profile),
          "workday_contact_source_preferred",
          "rule"
        );
      }
      else if (match(label, /phone/)) pushWidgetAnswer(resolved, widget, profile.contact.phone, "workday_contact_phone");
      else if (match(label, /email/)) pushWidgetAnswer(resolved, widget, profile.contact.email, "workday_contact_email");
      else if (isEmployerHistoryQuestion(label)) {
        pushWidgetAnswer(
          resolved,
          widget,
          resolveEmployerHistoryWidgetValue(widget, profile),
          profileShowsEmployerHistory(profile, label) ? "workday_contact_previous_worker_profile_yes" : "workday_contact_previous_worker_default_no"
        );
      }
    }

    if (currentStep === "voluntary_disclosures" || currentStep === "self_identification") {
      if (match(label, /gender/)) pushWidgetAnswer(resolved, widget, resolveWidgetValueForOptions(widget, resolveVoluntaryDisclosurePreferredValue(widget.label, widget.options, profile) || profile.demographics.gender || "Decline to self-identify"), "workday_demo_gender");
      else if (match(label, /ethnicity|race/) || (widget.widgetType === "checkbox_group" && isEthnicityDisclosureOptionSet(widget.options))) {
        const explicitPreferred = resolveVoluntaryDisclosurePreferredValue(widget.label, widget.options, profile) ||
          profile.demographics.raceEthnicity ||
          profile.demographics.ethnicity;
        const explicitResolved = explicitPreferred ? resolveWidgetValueForOptions(widget, explicitPreferred) : null;
        const declineOption = pickDeclineOption(widget.options);
        const ethnicityValue =
          explicitResolved ||
          (widget.widgetType === "checkbox_group" && declineOption ? [declineOption] : resolveWidgetValueForOptions(widget, declineOption || "Decline to identify"));
        pushWidgetAnswer(resolved, widget, ethnicityValue, "workday_demo_ethnicity");
      }
      else if (match(label, /hispanic|latino/)) pushWidgetAnswer(resolved, widget, resolveWidgetValueForOptions(widget, resolveVoluntaryDisclosurePreferredValue(widget.label, widget.options, profile) || profile.demographics.hispanicOrLatino || "I do not wish to answer"), "workday_demo_hispanic");
      else if (match(label, /veteran/)) pushWidgetAnswer(resolved, widget, resolveWidgetValueForOptions(widget, resolveVoluntaryDisclosurePreferredValue(widget.label, widget.options, profile) || profile.demographics.veteranStatus || "I am not a protected veteran"), "workday_demo_veteran");
      else if (match(label, /disability/)) {
        const desired = profile.demographics.disabilityStatus === "yes"
          ? widget.options.find((option) => /^yes, i have a disability/i.test(option)) || "Yes"
          : profile.demographics.disabilityStatus === "no"
            ? widget.options.find((option) => /^no, i do not have a disability/i.test(option)) || "No"
            : widget.options.find((option) => /do not want to answer|don't wish to answer|decline/i.test(option)) || "I don't wish to answer";
        pushWidgetAnswer(resolved, widget, widget.widgetType === "checkbox_group" ? [desired] : desired, "workday_demo_disability");
      } else if (currentStep === "self_identification" && match(label, /name/)) {
        pushWidgetAnswer(resolved, widget, profile.identity.fullName, "workday_self_id_name");
      }
    }

    if (currentStep === "application_questions" || currentStep === "unknown") {
      if (match(label, /18 years of age or older/, /over the age of 18/, /at least 18/)) {
        pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, true), "workday_questionnaire_adult_age_yes");
      } else if (isUsLocationQuestion(label)) {
        pushWidgetAnswer(
          resolved,
          widget,
          widgetBooleanValue(widget, profileLocatedInUnitedStates(profile)),
          profileLocatedInUnitedStates(profile) ? "workday_questionnaire_located_in_us_yes" : "workday_questionnaire_located_in_us_no"
        );
      } else if (isCountryLocationQuestion(label)) {
        pushWidgetAnswer(
          resolved,
          widget,
          resolveWidgetValueForOptions(widget, "United States of America") ||
            resolveWidgetValueForOptions(widget, "United States") ||
            profileCountryValue(profile),
          "workday_questionnaire_current_country_profile",
          "rule"
        );
      } else if (match(label, /ernst\s*&\s*young/, /current or former employee/, /previously worked for/, /previous employer/)) {
        pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, false), "workday_questionnaire_previous_employer_no");
      } else if (match(label, /existing .* employee/, /current .* employee/, /currently employed by/, /existing hp employee/, /current hp employee/)) {
        const isExistingEmployee = profileShowsCurrentCompany(profile, widget.label);
        pushWidgetAnswer(
          resolved,
          widget,
          widgetBooleanValue(widget, isExistingEmployee),
          isExistingEmployee ? "workday_questionnaire_existing_employee_yes" : "workday_questionnaire_existing_employee_no"
        );
      } else if (match(label, /immediate family member/, /partner at ernst/)) {
        pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, false), "workday_questionnaire_family_member_no");
      } else if (match(label, /conflict of interest/, /financial interest/, /family relationship/, /personal relationship/, /relative .* company/, /family member .* company/)) {
        pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, false), "workday_questionnaire_conflict_of_interest_no");
      } else if (match(label, /non-competition/, /non-disclosure/, /non-solicitation/, /impact or interfere/)) {
        pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, false), "workday_questionnaire_employment_restriction_no");
      } else if (match(label, /non-compete/)) {
        pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, false), "workday_questionnaire_employment_restriction_no");
      } else if (match(label, /intellectual property rights/, /patents/, /trademarks/, /copyrights/)) {
        pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, false), "workday_questionnaire_ip_rights_no");
      } else if (match(label, /if hired, do you intend to/)) {
        pushWidgetAnswer(resolved, widget, resolveWidgetValueForOptions(widget, "Neither") || resolveWidgetValueForOptions(widget, "No") || "Neither", "workday_questionnaire_future_activity_neither");
      } else if (isGovernmentConflictQuestion(label)) {
        pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, false), "workday_questionnaire_government_conflict_default_no", "rule");
      } else if (match(label, /department of defense/, /federal.*state.*local government/, /state.*local government/, /government employee/, /public institution/, /past 5 years.*government/)) {
        pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, false), "workday_questionnaire_government_employee_no");
      } else if (match(label, /background check/, /drug screen/, /condition of employment/, /agree to comply/, /terms and conditions/, /read and consent/, /privacy/, /tobacco/, /alcohol/, /workplace policies/)) {
        pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, true), "workday_questionnaire_policy_acknowledgement_yes", "rule");
      } else if (widget.widgetType === "checkbox_group") {
        const checkboxFallback = resolveGenericRequiredCheckboxGroupOption(widget, profile, nearbyContext, options?.jobContext);
        if (checkboxFallback) {
          const reason =
            isNoticePeriodAvailabilityQuestion(label) ? "workday_questionnaire_notice_period_availability" :
            isLocationPreferenceCheckboxQuestion(widget) ? "workday_questionnaire_location_preference_profile" :
            isPreferenceCheckboxQuestion(widget) ? "workday_questionnaire_preference_checkbox_fallback" :
            careerLevelClassificationOption(widget.options) ? "workday_questionnaire_career_level_student_intern" :
            "workday_questionnaire_checkbox_required_fallback";
          pushWidgetAnswer(resolved, widget, checkboxFallback, reason, "rule");
        }
      } else if (match(label, /willing to relocate/, /open to relocation/, /open to relocate/, /relocate\/work in other cities/, /work in other cities/)) {
        pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, true), "workday_questionnaire_relocation_yes");
      } else if (match(label, /willing to work on[- ]site/, /work on[- ]site/, /onsite/)) {
        pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, true), "workday_questionnaire_onsite_yes");
      } else if (match(label, /percentage.*travel/, /able to travel/, /willing to travel/, /how much.*travel/, /%.*travel/, /travel.*%/, /can travel/)) {
        pushWidgetAnswer(
          resolved,
          widget,
          resolveWidgetValueForOptions(widget, "25%") || resolveWidgetValueForOptions(widget, "20%") || resolveWidgetValueForOptions(widget, "0%") || widget.options.find((option) => normalizeForMatch(option) !== "select one") || "25%",
          "workday_questionnaire_travel_moderate"
        );
      } else if (isLegalRightToWorkVerificationQuestion(label) || isPermittedWorkQuestion(label)) {
        pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, profile.workAuthorization.authorizedInUS), "workday_auth_verification_of_work_right");
      } else if (isEmploymentEligibilityQuestion(label)) {
        pushWidgetAnswer(resolved, widget, resolveEmploymentEligibilityValue(widget, profile), "workday_auth_employment_eligibility", "rule");
      } else if (isStateLocationIntentQuestion(label)) {
        pushWidgetAnswer(
          resolved,
          widget,
          resolveStateLocationIntentOption(widget, profile, nearbyContext, options?.jobContext),
          "workday_questionnaire_state_location_profile",
          "rule"
        );
      } else if (isWorkAuthorizationQuestionLabel(label)) {
        pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, profile.workAuthorization.authorizedInUS), "workday_auth_authorized");
      } else if (match(label, /eligible to work/, /without visa sponsorship/, /future eligible to work/)) {
        pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, profile.workAuthorization.authorizedInUS && !profile.workAuthorization.requiresSponsorship), "workday_auth_eligible_without_sponsorship");
      } else if (match(label, /sponsorship|visa/)) {
        pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, profile.workAuthorization.requiresSponsorship), "workday_auth_sponsorship");
      } else if (isWotcQuestion(label)) {
        pushWidgetAnswer(
          resolved,
          widget,
          resolveWidgetValueForOptions(widget, "Answer I don’t wish to respond") || resolveWidgetValueForOptions(widget, "Answer I don't wish to respond"),
          "workday_questionnaire_wotc_decline",
          "rule"
        );
      } else if (match(label, /u\.?s\.? person|export control/, /u\.?s\. citizen or national/, /lawful permanent resident/, /refugee or asylee/)) {
        const exportYes = profile.exportControl.usPerson ?? profile.workAuthorization.usCitizen ?? profile.workAuthorization.permanentResident ?? profile.workAuthorization.authorizedInUS;
        pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, exportYes === true), "workday_export_control");
      } else if (isSourceQuestion(label)) {
        pushWidgetAnswer(resolved, widget, resolveSourceOption(widget.options, profile), "workday_questionnaire_source_preferred", "rule");
      } else if (primaryEducation && match(label, /degree currently pursuing/, /current degree/, /degree program/, /what degree/)) {
        pushWidgetAnswer(resolved, widget, resolveDegreeWidgetValue(widget, primaryEducation.degree), "workday_questionnaire_degree_profile", "rule");
      } else if (primaryEducation && match(label, /gpa/, /cumulative gpa/, /out of 4\.0/)) {
        pushWidgetAnswer(resolved, widget, resolveWidgetValueForOptions(widget, primaryEducation.gpa || ""), "workday_questionnaire_gpa_profile", "rule");
      } else if (primaryEducation && match(label, /school/, /university/)) {
        pushWidgetAnswer(resolved, widget, resolveWidgetValueForOptions(widget, primaryEducation.school), "workday_questionnaire_school_profile", "rule");
      } else if (primaryEducation && match(label, /major/, /field of study/, /discipline/)) {
        pushWidgetAnswer(resolved, widget, resolveWidgetValueForOptions(widget, primaryEducation.fieldOfStudy), "workday_questionnaire_major_profile", "rule");
      } else if (widget.required && isRequiredSingleSelectWidget(widget) && widget.options.length) {
        const singleSelectFallback = resolveGenericRequiredSingleSelectOption(widget, profile, nearbyContext, options?.jobContext);
        if (singleSelectFallback) {
          const reason =
            isInternshipCommitmentQuestion(label) ? "workday_questionnaire_commitment_yes" :
            isGraduationDateQuestion(label) ? "workday_questionnaire_graduation_date_profile" :
            isCohortPreferenceQuestion(label) ? "workday_questionnaire_cohort_preference" :
            isProfessionalExperienceExcludingInternshipsQuestion(label) ? "workday_questionnaire_experience_low" :
            isUniversityCountryQuestion(label) ? "workday_questionnaire_university_country_profile" :
            "workday_questionnaire_required_single_select_fallback";
          pushWidgetAnswer(resolved, widget, singleSelectFallback, reason, "rule");
        }
      } else if (match(label, /given name/, /first name/, /legal first name/)) {
        pushWidgetAnswer(resolved, widget, profile.identity.firstName, "workday_questionnaire_first_name", "rule");
      } else if (match(label, /father'?s family name/, /family name/, /surname/, /last name/, /legal last name/)) {
        pushWidgetAnswer(resolved, widget, profile.identity.lastName, "workday_questionnaire_last_name", "rule");
      } else if (match(label, /middle name/)) {
        pushWidgetAnswer(resolved, widget, profile.identity.middleName || null, "workday_questionnaire_middle_name", "rule");
      } else if (match(label, /preferred name/)) {
        pushWidgetAnswer(resolved, widget, profile.identity.preferredName || profile.identity.firstName, "workday_questionnaire_preferred_name", "rule");
      } else if (match(label, /email/)) {
        pushWidgetAnswer(resolved, widget, profile.contact.email || profile.account.email, "workday_questionnaire_email", "rule");
      } else if (match(label, /\bphone\b/)) {
        pushWidgetAnswer(resolved, widget, profile.contact.phone, "workday_questionnaire_phone", "rule");
      } else if (isExplicitCompensationPrompt(label)) {
        pushWidgetAnswer(resolved, widget, "120000", "workday_questionnaire_salary_default", "rule");
      } else if (match(label, /linkedin/)) {
        pushWidgetAnswer(resolved, widget, profile.links.linkedin || null, "workday_links_linkedin");
      } else if (match(label, /github/)) {
        pushWidgetAnswer(resolved, widget, profile.links.github || null, "workday_links_github");
      } else if (match(label, /portfolio|website/)) {
        pushWidgetAnswer(resolved, widget, profile.links.portfolio || profile.links.other?.[0] || null, "workday_links_portfolio");
      }
    }
  }

  return new Map(resolved.map((answer) => [answer.widgetId, answer]));
}

export function resolveWorkdayWidgetAlias(
  widgets: WorkdayWidgetSchema[],
  profile: NormalizedWorkdayProfile,
  currentStep: WorkdayStep,
  profileRaw?: CandidateProfile,
  options?: {
    contextWidgets?: WorkdayWidgetSchema[];
    jobContext?: WorkdayJobContext;
  }
): Map<string, WorkdayWidgetAnswer> {
  const resolved: WorkdayWidgetAnswer[] = [];
  const primaryEducation = resolveEducationFact(profile);
  const salaryExpectation = resolveSalaryExpectation(profileRaw || { basics: { firstName: "", lastName: "", email: "" } } as CandidateProfile);
  const nearbyContext = buildNearbyQuestionContext(options?.contextWidgets || widgets);

  for (const widget of widgets) {
    const label = normalizeForMatch(`${widget.label} ${widget.promptText}`);
    if (currentStep !== "application_questions" && currentStep !== "unknown" && currentStep !== "contact_information" && currentStep !== "my_experience") continue;

    if (currentStep === "contact_information") {
      if (isSourceQuestion(label)) {
        pushWidgetAnswer(
          resolved,
          widget,
          resolveSourceOption(widget.options, profile),
          "workday_contact_source_alias_preferred",
          "rule"
        );
      } else if (/extension/.test(label)) {
        pushWidgetAnswer(resolved, widget, null, "workday_contact_extension_alias_skip", "rule");
      } else if (/currently or have you ever worked|have you ever worked for|previously worked for|previously worked at|former employee|current employee|employee or contractor|previous worker/.test(label)) {
        pushWidgetAnswer(
          resolved,
          widget,
          resolveEmployerHistoryWidgetValue(widget, profile),
          profileShowsEmployerHistory(profile, widget.label) ? "workday_contact_previous_worker_alias_yes" : "workday_contact_previous_worker_alias_no",
          "rule"
        );
      } else if (/phone device type|phone type/.test(label)) {
        pushWidgetAnswer(resolved, widget, resolveWidgetValueForOptions(widget, profile.contact.phoneType), "workday_contact_phone_type_alias", "rule");
      } else if (/email/.test(label)) {
        pushWidgetAnswer(resolved, widget, profile.contact.email || profile.account.email, "workday_contact_email_alias", "rule");
      } else if (/phone/.test(label)) {
        pushWidgetAnswer(resolved, widget, profile.contact.phone, "workday_contact_phone_alias", "rule");
      }
      continue;
    }

    if (currentStep === "my_experience") {
      if (/type to add skills|\bskills?\b/.test(label) && profile.skills.length > 0) {
        pushWidgetAnswer(resolved, widget, profile.skills[0]!, "workday_my_experience_skill_alias", "rule");
        continue;
      }
      const value = resolveMyExperienceEducationWidgetValue(widget, primaryEducation);
      if (value) {
        pushWidgetAnswer(resolved, widget, value, "workday_my_experience_education_alias", "rule");
      }
      continue;
    }

    if (/background|drug screen|condition of employment|agree|consent|policy|privacy/.test(label)) {
      pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, true), "workday_questionnaire_policy_alias_yes", "rule");
    } else if (widget.widgetType === "checkbox_group") {
      const checkboxFallback = resolveGenericRequiredCheckboxGroupOption(widget, profile, nearbyContext, options?.jobContext);
      if (checkboxFallback) {
        const reason =
          isNoticePeriodAvailabilityQuestion(widget.label) ? "workday_questionnaire_notice_period_availability_alias" :
          isLocationPreferenceCheckboxQuestion(widget) ? "workday_questionnaire_location_preference_alias" :
          isPreferenceCheckboxQuestion(widget) ? "workday_questionnaire_preference_checkbox_alias" :
          careerLevelClassificationOption(widget.options) ? "workday_questionnaire_career_level_student_intern_alias" :
          "workday_questionnaire_checkbox_required_alias";
        pushWidgetAnswer(resolved, widget, checkboxFallback, reason, "rule");
      }
    } else if (isUsLocationQuestion(label)) {
      pushWidgetAnswer(
        resolved,
        widget,
        widgetBooleanValue(widget, profileLocatedInUnitedStates(profile)),
        profileLocatedInUnitedStates(profile) ? "workday_questionnaire_located_in_us_alias_yes" : "workday_questionnaire_located_in_us_alias_no",
        "rule"
      );
    } else if (isCountryLocationQuestion(label)) {
      pushWidgetAnswer(
        resolved,
        widget,
        resolveWidgetValueForOptions(widget, "United States of America") ||
          resolveWidgetValueForOptions(widget, "United States") ||
          profileCountryValue(profile),
        "workday_questionnaire_current_country_alias",
        "rule"
      );
    } else if (/existing .* employee|current .* employee|currently employed by|existing hp employee|current hp employee/.test(label)) {
      const isExistingEmployee = profileShowsCurrentCompany(profile, widget.label);
      pushWidgetAnswer(
        resolved,
        widget,
        widgetBooleanValue(widget, isExistingEmployee),
        isExistingEmployee ? "workday_questionnaire_existing_employee_alias_yes" : "workday_questionnaire_existing_employee_alias_no",
        "rule"
      );
    } else if (/conflict of interest|financial interest|family relationship|personal relationship|relative .* company|family member .* company/.test(label)) {
      pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, false), "workday_questionnaire_conflict_alias_no", "rule");
    } else if (isGovernmentConflictQuestion(label)) {
      pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, false), "workday_questionnaire_government_conflict_alias_no", "rule");
    } else if (/federal.*state.*local government|state.*local government|government employee|public institution|past 5 years.*government/.test(label)) {
      pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, false), "workday_questionnaire_government_alias_no", "rule");
    } else if (isLegalRightToWorkVerificationQuestion(label) || isPermittedWorkQuestion(label)) {
      pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, profile.workAuthorization.authorizedInUS), "workday_auth_verification_of_work_right_alias", "rule");
    } else if (isEmploymentEligibilityQuestion(label)) {
      pushWidgetAnswer(resolved, widget, resolveEmploymentEligibilityValue(widget, profile), "workday_auth_employment_eligibility_alias", "rule");
    } else if (isStateLocationIntentQuestion(label)) {
      pushWidgetAnswer(
        resolved,
        widget,
        resolveStateLocationIntentOption(widget, profile, nearbyContext, options?.jobContext),
        "workday_questionnaire_state_location_alias",
        "rule"
      );
    } else if (/willing to relocate|open to relocation|open to relocate|relocate\/work in other cities|work in other cities/.test(label)) {
      pushWidgetAnswer(resolved, widget, widgetBooleanValue(widget, true), "workday_questionnaire_relocation_alias_yes", "rule");
    } else if (isSourceQuestion(label)) {
      pushWidgetAnswer(resolved, widget, resolveSourceOption(widget.options, profile), "workday_questionnaire_source_alias_preferred", "rule");
    } else if (primaryEducation && /degree|program/.test(label)) {
      pushWidgetAnswer(resolved, widget, resolveDegreeWidgetValue(widget, primaryEducation.degree), "workday_questionnaire_degree_alias", "rule");
    } else if (primaryEducation && /gpa|grade average|out of 4/.test(label)) {
      pushWidgetAnswer(resolved, widget, resolveWidgetValueForOptions(widget, primaryEducation.gpa || ""), "workday_questionnaire_gpa_alias", "rule");
    } else if (primaryEducation && /school|university|college/.test(label)) {
      pushWidgetAnswer(resolved, widget, resolveWidgetValueForOptions(widget, primaryEducation.school), "workday_questionnaire_school_alias", "rule");
    } else if (primaryEducation && /major|discipline|field/.test(label)) {
      pushWidgetAnswer(resolved, widget, resolveWidgetValueForOptions(widget, primaryEducation.fieldOfStudy), "workday_questionnaire_major_alias", "rule");
    } else if (isWotcQuestion(label)) {
      pushWidgetAnswer(
        resolved,
        widget,
        resolveWidgetValueForOptions(widget, "Answer I don’t wish to respond") || resolveWidgetValueForOptions(widget, "Answer I don't wish to respond"),
        "workday_questionnaire_wotc_decline_alias",
        "rule"
      );
    } else if (isExplicitCompensationPrompt(label)) {
      pushWidgetAnswer(resolved, widget, resolveWidgetValueForOptions(widget, salaryExpectation), "workday_questionnaire_salary_alias", "rule");
    } else if (/email/.test(label)) {
      pushWidgetAnswer(resolved, widget, profile.contact.email || profile.account.email, "workday_questionnaire_email_alias", "rule");
    } else if (/phone/.test(label)) {
      pushWidgetAnswer(resolved, widget, profile.contact.phone, "workday_questionnaire_phone_alias", "rule");
    } else if (/first name|given name/.test(label)) {
      pushWidgetAnswer(resolved, widget, profile.identity.firstName, "workday_questionnaire_first_name_alias", "rule");
    } else if (/last name|family name|surname/.test(label)) {
      pushWidgetAnswer(resolved, widget, profile.identity.lastName, "workday_questionnaire_last_name_alias", "rule");
    }
  }

  return new Map(resolved.map((answer) => [answer.widgetId, answer]));
}

export function unresolvedFields(schema: WorkdayFieldSchema[], resolved: Map<string, ResolvedAnswer>): WorkdayFieldSchema[] {
  return schema.filter((field) => !resolved.has(field.fieldId));
}

export function unresolvedWidgets(widgets: WorkdayWidgetSchema[], resolved: Map<string, WorkdayWidgetAnswer>): WorkdayWidgetSchema[] {
  return widgets.filter((widget) => !resolved.has(widget.widgetId));
}

export function mergeLockedFirst(
  deterministic: Map<string, ResolvedAnswer>,
  llm: ResolvedAnswer[]
): ResolvedAnswer[] {
  const merged = new Map<string, ResolvedAnswer>();
  for (const [k, v] of deterministic) merged.set(k, v);
  for (const answer of llm) {
    if (!merged.has(answer.questionId)) merged.set(answer.questionId, answer);
  }
  return [...merged.values()];
}

export function mergeLockedWidgetAnswers(
  deterministic: Map<string, WorkdayWidgetAnswer>,
  llm: WorkdayWidgetAnswer[]
): WorkdayWidgetAnswer[] {
  const merged = new Map<string, WorkdayWidgetAnswer>();
  for (const [id, answer] of deterministic) merged.set(id, answer);
  for (const answer of llm) {
    if (!merged.has(answer.widgetId)) merged.set(answer.widgetId, answer);
  }
  return [...merged.values()];
}

export async function planWorkdayUnresolvedFields(input: {
  unresolved: WorkdayFieldSchema[];
  aiEngine: import("../../ai/engine.js").AnswerEngine;
  profile: CandidateProfile;
  resumeText: string;
  jobContext: WorkdayJobContext;
}): Promise<ResolvedAnswer[]> {
  if (!input.unresolved.length) return [];

  const questions = input.unresolved.map((field) => {
    const questionType: QuestionType =
      field.fieldType === "textarea"
        ? "textarea"
        : field.fieldType === "radio" || field.fieldType === "dropdown" || field.fieldType === "search_combobox"
          ? "single_select"
          : field.fieldType === "checkbox"
            ? "boolean"
            : field.fieldType === "file"
              ? "file"
              : "text";
    return {
    id: field.fieldId,
    label: field.label,
    type: questionType,
    required: field.required,
    options: field.possibleAnswers,
    platformMeta: {
      platform: "workday",
      workdayFieldType: field.fieldType,
      step: field.step,
      strictOptionConstraint: field.possibleAnswers.length > 0
    }
  };
  });

  const answers = await input.aiEngine.resolve(questions, {
    profile: input.profile,
    resumeText: input.resumeText,
    jobTitle: input.jobContext.jobTitle,
    company: input.jobContext.company,
    companyContext: [
      "Workday unresolved question resolution.",
      "If options are provided, choose only from those options.",
      "For radio/dropdown choose exactly one option.",
      "For checkbox return true/false.",
      "Use profile facts for legal/work-auth/export-control questions."
    ].join(" "),
    platform: "workday"
  }).catch(() => []);

  return answers.map((a) => ({ ...a, source: "llm" as const, reason: a.reason || "workday_llm_unresolved" }));
}

export async function planWorkdayUnresolvedWidgets(input: {
  unresolved: WorkdayWidgetSchema[];
  contextWidgets?: WorkdayWidgetSchema[];
  aiEngine: import("../../ai/engine.js").AnswerEngine;
  profile: CandidateProfile;
  resumeText: string;
  jobContext: WorkdayJobContext;
  notes?: string[];
}): Promise<WorkdayWidgetAnswer[]> {
  if (!input.unresolved.length) return [];
  const normalizedProfile = normalizeWorkdayProfile(input.profile);
  const nearbyContext = buildNearbyQuestionContext(input.contextWidgets || input.unresolved);
  const nearbyContextText = nearbyContext
    .slice(-6)
    .map((item) => `${item.label}=${item.value}`)
    .join(" || ");
  const isRequiredOptionBacked = (widget: WorkdayWidgetSchema): boolean =>
    widget.required && (
      widget.options.length > 0 ||
      widget.widgetType === "button_select" ||
      widget.widgetType === "prompt_input_select" ||
      widget.widgetType === "radio_group" ||
      widget.widgetType === "checkbox_group"
    );

  const buildQuestions = (strictOptionRetry = false, forceChoice = false) => input.unresolved.map((widget) => {
    const questionType: QuestionType =
      widget.widgetType === "textarea"
        ? "textarea"
        : widget.widgetType === "checkbox_group"
          ? "multi_select"
          : widget.widgetType === "button_select" || widget.widgetType === "prompt_input_select" || widget.widgetType === "radio_group"
            ? "single_select"
            : widget.widgetType === "file_upload"
              ? "file"
              : "text";

    let instruction = "Return a safe factual answer from profile context only.";
    if (widget.widgetType === "button_select" || widget.widgetType === "prompt_input_select" || widget.widgetType === "radio_group" || widget.widgetType === "checkbox_group") {
      instruction = "If options are provided, return exact option text only.";
    } else if (widget.widgetType === "date_mm_yyyy") {
      instruction = "Return month and year only, formatted as MM/YYYY.";
    } else if (widget.widgetType === "date_mm_dd_yyyy") {
      instruction = "Return month, day, and year only, formatted as MM/DD/YYYY.";
    }
    const forceInstruction = forceChoice && isRequiredOptionBacked(widget)
      ? " This question is required. You must choose from the visible options. Do not abstain, return null, return empty text, or explain."
      : "";

    return {
      id: widget.widgetId,
      label: widget.label,
      type: questionType,
      required: widget.required,
      options: widget.options,
      platformMeta: {
        platform: "workday",
        step: widget.step,
        widgetType: widget.widgetType,
        visiblePrompt: widget.promptText,
        currentValue: currentWidgetDisplayValue(widget),
        strictOptionConstraint: widget.options.length > 0,
        expectedDomAction:
          widget.widgetType === "textarea" || widget.widgetType === "text_input" ? "type" :
          widget.widgetType === "button_select" ? "select_dropdown_option" :
          widget.widgetType === "prompt_input_select" ? "select_combobox_option" :
          widget.widgetType === "radio_group" ? "click_radio" :
          widget.widgetType === "checkbox_group" ? "click_checkbox" :
          widget.widgetType === "file_upload" ? "upload_file" :
          widget.widgetType === "date_mm_yyyy" || widget.widgetType === "date_mm_dd_yyyy" ? "type" :
          "type",
        fieldContext: strictOptionRetry
          ? `${instruction}${forceInstruction} Return only exact visible DOM option text. Do not paraphrase or invent option values.${nearbyContextText ? ` Nearby answered questions: ${nearbyContextText}.` : ""}`
          : `${instruction}${forceInstruction}${nearbyContextText ? ` Nearby answered questions: ${nearbyContextText}.` : ""}`
      }
    };
  });

  for (const widget of input.unresolved) {
    input.notes?.push(`workday_question_llm_used:${normalizeText(widget.label)}`);
  }

  const resolveAnswers = async (strictOptionRetry = false, forceChoice = false) => input.aiEngine.resolve(buildQuestions(strictOptionRetry, forceChoice), {
    profile: input.profile,
    resumeText: input.resumeText,
    jobTitle: input.jobContext.jobTitle,
    company: input.jobContext.company,
    companyContext: [
      "Workday widget resolution fallback.",
      "Use profile facts only.",
      "Radio, checkbox, and select widgets must use exact option text.",
      "Date widgets must be returned as normalized date sections.",
      nearbyContextText ? `Nearby answered questions: ${nearbyContextText}.` : "",
      strictOptionRetry ? "Retry mode: if options exist, return only exact visible DOM option text from the provided list." : "",
      forceChoice ? "Required option-backed questions must never be left blank. You must choose a visible option; empty/null/abstain is invalid." : ""
    ].join(" "),
    platform: "workday"
  }).catch(() => []);

  const answers = await resolveAnswers(false, false);

  const widgetsById = new Map(input.unresolved.map((widget) => [widget.widgetId, widget]));
  const answerById = new Map(answers.map((answer) => [answer.questionId, answer]));
  const retryCandidates = input.unresolved.filter((widget) => {
    const answer = answerById.get(widget.widgetId);
    if (!answer) return widget.options.length > 0;
    const raw = Array.isArray(answer.value) ? answer.value.map((value) => String(value)) : String(answer.value ?? "").trim();
    if (!raw || (Array.isArray(raw) && !raw.length)) return true;
    if (!widget.options.length) return false;
    if (widget.widgetType === "checkbox_group") {
      const picks = (Array.isArray(raw) ? raw : String(raw).split(/\s*,\s*/))
        .map((value) => pickOptionByTarget(widget.options, value))
        .filter(Boolean);
      return picks.length === 0;
    }
    return !pickOptionByTarget(widget.options, Array.isArray(raw) ? raw[0] || "" : raw);
  });

  if (retryCandidates.length) {
    const retryAnswers = await input.aiEngine.resolve(retryCandidates.map((widget) => {
      const questionType: QuestionType =
        widget.widgetType === "checkbox_group" ? "multi_select" :
        widget.widgetType === "button_select" || widget.widgetType === "prompt_input_select" || widget.widgetType === "radio_group" ? "single_select" :
        widget.widgetType === "textarea" ? "textarea" :
        widget.widgetType === "file_upload" ? "file" :
        "text";
      return {
        id: widget.widgetId,
        label: widget.label,
        type: questionType,
        required: widget.required,
        options: widget.options,
        platformMeta: {
          platform: "workday",
          step: widget.step,
          widgetType: widget.widgetType,
          visiblePrompt: widget.promptText,
          currentValue: currentWidgetDisplayValue(widget),
          strictOptionConstraint: widget.options.length > 0,
          expectedDomAction:
            widget.widgetType === "button_select" ? "select_dropdown_option" :
            widget.widgetType === "prompt_input_select" ? "select_combobox_option" :
            widget.widgetType === "radio_group" ? "click_radio" :
            widget.widgetType === "checkbox_group" ? "click_checkbox" :
            widget.widgetType === "file_upload" ? "upload_file" :
            "type",
          fieldContext: `${isRequiredOptionBacked(widget) ? "This question is required. You must choose one visible option and may not abstain. " : ""}Retry mode. Return only exact visible DOM option text from options. Never paraphrase. Empty/null is invalid for required option-backed questions.`
        }
      };
    }), {
      profile: input.profile,
      resumeText: input.resumeText,
      jobTitle: input.jobContext.jobTitle,
      company: input.jobContext.company,
      companyContext: "Workday widget resolution fallback retry. If options exist, return only exact option text from the provided visible DOM options. Required option-backed questions must never be left blank; choose one visible option.",
      platform: "workday"
    }).catch(() => []);
    for (const answer of retryAnswers) {
      answerById.set(answer.questionId, answer);
    }
  }

  const planned: WorkdayWidgetAnswer[] = [];
  for (const [widgetId, answer] of answerById.entries()) {
    const widget = widgetsById.get(widgetId);
    if (!widget) continue;
    const raw = Array.isArray(answer.value) ? answer.value.map((value) => String(value)) : String(answer.value ?? "").trim();
    if (!raw || (Array.isArray(raw) && !raw.length)) {
      const forced = resolveForcedRequiredOptionChoice(widget, normalizedProfile, nearbyContext, input.jobContext);
      if (forced !== null && forced !== undefined && (!Array.isArray(forced) || forced.length > 0)) {
        input.notes?.push(`workday_question_llm_forced_choice:${normalizeText(widget.label)}:${Array.isArray(forced) ? forced.join(" | ") : String(forced)}`);
        input.notes?.push("workday_question_answer_validated:true");
        planned.push({
          widgetId: widget.widgetId,
          value: forced,
          source: "rule",
          reason: "workday_required_option_forced_choice"
        });
        continue;
      }
      input.notes?.push("workday_question_answer_validated:false");
      continue;
    }

    if (widget.widgetType === "date_mm_yyyy") {
      const parts = normalizeDateAnswerParts(raw, 2);
      input.notes?.push(`workday_question_llm_answer:${normalizeText(widget.label)}:${parts.join("/")}`);
      input.notes?.push(`workday_question_answer_validated:${parts.length === 2}`);
      if (parts.length === 2) planned.push({ widgetId: widget.widgetId, value: parts, source: "llm", reason: answer.reason || "workday_llm_unresolved" });
      continue;
    }
    if (widget.widgetType === "date_mm_dd_yyyy") {
      const parts = normalizeDateAnswerParts(raw, 3);
      input.notes?.push(`workday_question_llm_answer:${normalizeText(widget.label)}:${parts.join("/")}`);
      input.notes?.push(`workday_question_answer_validated:${parts.length === 3}`);
      if (parts.length === 3) planned.push({ widgetId: widget.widgetId, value: parts, source: "llm", reason: answer.reason || "workday_llm_unresolved" });
      continue;
    }
    if (widget.options.length) {
      if (widget.widgetType === "checkbox_group") {
        const picks = (Array.isArray(raw) ? raw : String(raw).split(/\s*,\s*/))
          .map((value) => pickOptionByTarget(widget.options, value))
          .filter(Boolean) as string[];
        input.notes?.push(`workday_question_llm_answer:${normalizeText(widget.label)}:${picks.join(" | ") || String(raw)}`);
        if (picks.length) {
          input.notes?.push("workday_question_answer_validated:true");
          planned.push({ widgetId: widget.widgetId, value: picks, source: "llm", reason: answer.reason || "workday_llm_unresolved" });
          continue;
        }
        const forced = resolveForcedRequiredOptionChoice(widget, normalizedProfile, nearbyContext, input.jobContext);
        input.notes?.push(`workday_question_answer_validated:${Boolean(forced)}`);
        if (forced && Array.isArray(forced) && forced.length) {
          input.notes?.push(`workday_question_llm_forced_choice:${normalizeText(widget.label)}:${forced.join(" | ")}`);
          planned.push({ widgetId: widget.widgetId, value: forced, source: "rule", reason: "workday_required_option_forced_choice" });
        }
        continue;
      }
      const picked = pickOptionByTarget(widget.options, Array.isArray(raw) ? raw[0] || "" : raw);
      input.notes?.push(`workday_question_llm_answer:${normalizeText(widget.label)}:${picked || String(raw)}`);
      if (picked) {
        input.notes?.push("workday_question_answer_validated:true");
        planned.push({ widgetId: widget.widgetId, value: picked, source: "llm", reason: answer.reason || "workday_llm_unresolved" });
        continue;
      }
      const forced = resolveForcedRequiredOptionChoice(widget, normalizedProfile, nearbyContext, input.jobContext);
      input.notes?.push(`workday_question_answer_validated:${Boolean(forced)}`);
      if (forced && !Array.isArray(forced)) {
        input.notes?.push(`workday_question_llm_forced_choice:${normalizeText(widget.label)}:${forced}`);
        planned.push({ widgetId: widget.widgetId, value: forced, source: "rule", reason: "workday_required_option_forced_choice" });
      }
      continue;
    }
    if (isStateLocationIntentQuestion(widget.label)) {
      const single = Array.isArray(raw) ? String(raw[0] || "") : String(raw);
      input.notes?.push(`workday_question_llm_answer:${normalizeText(widget.label)}:${single}`);
      input.notes?.push(`workday_question_answer_validated:${looksLikeUsStateAnswer(single)}`);
      if (looksLikeUsStateAnswer(single)) {
        planned.push({
          widgetId: widget.widgetId,
          value: normalizeUsStateCandidate(single),
          source: "llm",
          reason: answer.reason || "workday_llm_unresolved"
        });
      }
      continue;
    }
    input.notes?.push(`workday_question_llm_answer:${normalizeText(widget.label)}:${Array.isArray(raw) ? raw.join(" | ") : String(raw)}`);
    input.notes?.push("workday_question_answer_validated:true");
    planned.push({
      widgetId: widget.widgetId,
      value: Array.isArray(raw) ? raw : String(raw),
      source: "llm",
      reason: answer.reason || "workday_llm_unresolved"
    });
  }

  return planned;
}
