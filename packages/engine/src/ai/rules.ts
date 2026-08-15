import type { AnswerValue, ApplicationQuestion, CandidateProfile } from "../core/types.js";
import type { RuleEvaluation } from "./types.js";

const YES_NO_WORDS = ["yes", "no"];
const EU_EFTA_COUNTRIES = new Set([
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

const SANCTIONED_COUNTRIES = new Set(["cuba", "iran", "north korea", "syria", "russia", "belarus", "venezuela"]);

function normalize(text: string): string {
  // Lever appends its required-marker glyph (✱, U+2731) to every scraped
  // label, and many labels end with a colon. Both broke the exact-equality
  // branches below, so they are stripped here for every platform.
  return text
    .trim()
    .toLowerCase()
    .replace(/[✱*]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[:\s]+$/, "")
    .trim();
}

function includesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function findCustomAnswer(profile: CandidateProfile, patterns: RegExp[]): string | boolean | string[] | number | undefined {
  for (const [key, value] of Object.entries(profile.customAnswers ?? {})) {
    const normalizedKey = key.toLowerCase();
    if (patterns.some((pattern) => pattern.test(normalizedKey))) {
      return value;
    }
  }
  return undefined;
}

const MONTH_NUMBERS = new Map<string, string>([
  ["january", "01"], ["jan", "01"], ["february", "02"], ["feb", "02"], ["march", "03"], ["mar", "03"],
  ["april", "04"], ["apr", "04"], ["may", "05"], ["june", "06"], ["jun", "06"], ["july", "07"], ["jul", "07"],
  ["august", "08"], ["aug", "08"], ["september", "09"], ["sep", "09"], ["sept", "09"], ["october", "10"], ["oct", "10"],
  ["november", "11"], ["nov", "11"], ["december", "12"], ["dec", "12"]
]);

function monthNumberFrom(raw: string): string {
  const text = String(raw || "").trim().toLowerCase();
  if (!text) return "";
  if (/^\d{1,2}$/.test(text)) return text.padStart(2, "0");
  return MONTH_NUMBERS.get(text) || "";
}

function normalizeGraduationDateProfileValue(input: CandidateProfile["education"]): {
  mmDdYyyy?: string;
  mmYyyy?: string;
} {
  if (!input) return {};
  const full = String(input.graduationDateMmDdYyyy || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (full) {
    const month = full[1]!.padStart(2, "0");
    const day = full[2]!.padStart(2, "0");
    const year = full[3]!;
    return {
      mmDdYyyy: `${month}/${day}/${year}`,
      mmYyyy: `${month}/${year}`
    };
  }
  const monthYear = String(input.graduationDateMmYyyy || "").trim().match(/^(\d{1,2})\/(\d{4})$/);
  if (monthYear) {
    const month = monthYear[1]!.padStart(2, "0");
    const year = monthYear[2]!;
    return {
      mmDdYyyy: `${month}/01/${year}`,
      mmYyyy: `${month}/${year}`
    };
  }
  const month = monthNumberFrom(String(input.endMonth || ""));
  const year = String(input.endYear || input.graduationYear || "").trim();
  if (!month || !year) return {};
  return {
    mmDdYyyy: `${month}/01/${year}`,
    mmYyyy: `${month}/${year}`
  };
}

function coerceBoolean(value: string | boolean | string[] | number | undefined): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalizedValue = normalize(value);
    if (["yes", "y", "true"].includes(normalizedValue)) return true;
    if (["no", "n", "false"].includes(normalizedValue)) return false;
  }
  return undefined;
}

/**
 * The candidate's postal code, wherever it happens to be recorded.
 *
 * Greenhouse asks "Zip / Postal" on most of its forms and nothing mapped it, so
 * a profile that already held 94105 answered it as unknown and the adapter
 * retried the field until it gave up. The Workday block is the only structured
 * address in the schema, which is why it is read here rather than duplicated.
 */
function preferredPostalCode(profile: CandidateProfile): string | undefined {
  const workdayPostal = profile.workday?.contact?.address?.postalCode?.trim();
  if (workdayPostal) return workdayPostal;
  // Fall back to a postal code sitting inside a free-text location.
  const fromLocation = (profile.basics.location ?? "").match(/\b\d{5}(?:-\d{4})?\b/);
  return fromLocation?.[0];
}

/**
 * Street, city, and state resolvers with the same fallback idea as
 * preferredPostalCode: the Workday block is the only structured address in
 * the schema, so it is read first, then locationStructured, then whatever
 * can be parsed out of the free-text basics.location.
 */
function preferredStreetAddress(profile: CandidateProfile): string | undefined {
  const address = profile.workday?.contact?.address;
  const line1 = address?.line1?.trim();
  if (line1) {
    const line2 = address?.line2?.trim();
    return line2 ? `${line1}, ${line2}` : line1;
  }
  // A leading "500 Folsom St" segment inside a free-text location.
  const fromLocation = (profile.basics.location ?? "").trim().match(/^\d+\s+[^,]+/);
  return fromLocation?.[0];
}

function preferredCity(profile: CandidateProfile): string | undefined {
  const structured = profile.locationStructured?.city?.trim();
  if (structured) return structured;
  const workdayCity = profile.workday?.contact?.address?.city?.trim();
  if (workdayCity) return workdayCity;
  const parts = (profile.basics.location ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  // Skip a leading street segment; the city never starts with a digit.
  return parts.find((part) => !/^\d/.test(part)) || undefined;
}

function preferredState(profile: CandidateProfile): string | undefined {
  return (
    profile.state?.trim() ||
    profile.locationStructured?.region?.trim() ||
    profile.workday?.contact?.address?.state?.trim() ||
    undefined
  );
}

function preferredFullAddress(profile: CandidateProfile): string | undefined {
  const address = profile.workday?.contact?.address;
  const joined = [address?.line1, address?.line2, address?.city, address?.state, address?.postalCode]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(", ");
  if (joined) return joined;
  return profile.basics.location?.trim() || undefined;
}

function preferredBasedLocation(profile: CandidateProfile): string | undefined {
  const rawLocation = profile.basics.location?.trim() ?? "";
  const rawCity = rawLocation
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)[0];
  const city = rawCity ?? preferredCity(profile);
  const state = preferredState(profile);
  if (city && state) {
    return `${city}, ${state}`;
  }
  return rawLocation || city || undefined;
}

function preferredEarliestStart(profile: CandidateProfile, label: string): string | undefined {
  const raw = (profile.logistics?.earliestStartDate ?? profile.logistics?.earliest_start_date)?.trim();
  if (!raw) return undefined;
  if (/month\/year|month and year|mm\/yyyy/.test(label)) {
    const monthYear = raw.match(/^([a-z]+|\d{1,2})[ /-]+(\d{4})$/i);
    if (monthYear) {
      const month = monthNumberFrom(monthYear[1]!);
      if (month) return `${month}/${monthYear[2]}`;
    }
    const full = raw.match(/^(\d{1,2})\/\d{1,2}\/(\d{4})$/);
    if (full) return `${full[1]!.padStart(2, "0")}/${full[2]}`;
  }
  return raw;
}

function formatEducationStart(profile: CandidateProfile, label: string): string | undefined {
  const startMonth = profile.education?.startMonth?.trim();
  const startYear = profile.education?.startYear?.trim();
  if (!startYear) return undefined;
  if (/mm\/yyyy|month\/year/.test(label)) {
    const month = monthNumberFrom(startMonth || "");
    if (month) return `${month}/${startYear}`;
  }
  return startMonth ? `${startMonth} ${startYear}` : startYear;
}

/**
 * Degree selects rarely offer the profile's exact wording: the profile says
 * "Bachelor of Science" and the form offers "Bachelors". Match by degree
 * level, highest first, in both directions.
 */
function pickDegreeLevelOption(options: string[] | undefined, degreeText: string | undefined): string | undefined {
  if (!options?.length || !degreeText) return undefined;
  const normalizedDegree = normalize(degreeText);
  const levels: RegExp[] = [
    /doctor|phd|ph\.d/,
    /\bmba\b/,
    /master|m\.s\.|\bms\b|m\.a\./,
    /bachelor|b\.s\.|\bbs\b|b\.a\./,
    /associate/,
    /high school|ged/
  ];
  for (const level of levels) {
    if (!level.test(normalizedDegree)) continue;
    const option = options.find((item) => level.test(normalize(item)));
    if (option) return option;
  }
  return undefined;
}

function pickOptionByPatterns(options: string[] | undefined, patterns: RegExp[]): string | undefined {
  if (!options?.length) return undefined;
  return options.find((option) => patterns.some((pattern) => pattern.test(option.toLowerCase())));
}

function pickCountryOption(options: string[] | undefined, country: string): string | undefined {
  if (!options?.length) return undefined;
  const normalizedCountry = normalize(country);
  if (!normalizedCountry) return undefined;
  const normalizedOptions = options.map((option) => ({ raw: option, normalized: normalize(option) }));
  const exact = normalizedOptions.find((option) => option.normalized === normalizedCountry);
  if (exact) return exact.raw;
  const contains = normalizedOptions.find(
    (option) => option.normalized.includes(normalizedCountry) || normalizedCountry.includes(option.normalized)
  );
  return contains?.raw;
}

function optionLooksLikeNegativeAuthorization(option: string): boolean {
  const normalized = normalize(option);
  return (
    normalized === "no" ||
    normalized.startsWith("no,") ||
    normalized.includes("not authorized") ||
    normalized.includes("not eligible") ||
    normalized.includes("require sponsorship")
  );
}

function optionsContainCountries(options?: string[]): boolean {
  if (!options?.length) return false;
  const countryHints = [
    "united states",
    "usa",
    "us",
    "canada",
    "singapore",
    "india",
    "united kingdom",
    "uk",
    "australia",
    "germany"
  ];
  return options.some((option) => {
    const normalized = normalize(option);
    return countryHints.some((hint) => normalized === hint || normalized.includes(hint));
  });
}

function inferIsRisingSeniorOrRecentGrad(profile: CandidateProfile): boolean | undefined {
  const raw = profile.education?.graduationYear ?? profile.education?.endYear;
  if (!raw) return undefined;
  const year = Number.parseInt(raw, 10);
  if (!Number.isFinite(year)) return undefined;
  const nowYear = new Date().getFullYear();
  // Treat current students and very recent graduates as "yes".
  return year >= nowYear - 1;
}

export function evaluateDeterministicRule(question: ApplicationQuestion, profile: CandidateProfile): RuleEvaluation {
  const label = normalize(question.label);
  const sponsorshipIntent = includesAny(label, [
    /require sponsorship/,
    /need sponsorship/,
    /visa sponsorship/,
    /now or in the future.*sponsorship/,
    /future.*sponsorship/,
    /continue or extend.*work authorization/,
    /extend your current work authorization/
  ]);

  if (sponsorshipIntent) {
    const sponsorship = profile.workAuthorization?.requiresSponsorship;
    if (typeof sponsorship === "boolean") {
      const mapped = boolToAnswer(sponsorship, question.options);
      if (mapped !== null) {
        return {
          answer: mapped,
          source: "rule",
          reason: "sponsorship"
        };
      }
      const option = sponsorship
        ? pickOptionByPatterns(question.options, [/require.*sponsorship/, /need.*sponsorship/, /yes/])
        : pickOptionByPatterns(
            question.options,
            [/will not require|do not require|no sponsorship|without sponsorship|without restriction|no/]
          );
      if (option) {
        return {
          answer: option,
          source: "rule",
          reason: "sponsorship"
        };
      }
    }
  }

  if (!sponsorshipIntent && includesAny(label, [/authorized to work/, /work authorization/, /legally authorized/])) {
    const authorized = profile.workAuthorization?.authorizedToWork;
    if (optionsContainCountries(question.options)) {
      const preferredCountry = profile.country ?? "United States";
      const matchedCountry = pickCountryOption(question.options, preferredCountry);
      if (matchedCountry) {
        return {
          answer: matchedCountry,
          source: "rule",
          reason: "work_authorization_country"
        };
      }
    }
    if (typeof authorized === "boolean") {
      const mapped = boolToAnswer(authorized, question.options);
      if (mapped !== null) {
        return {
          answer: mapped,
          source: "rule",
          reason: "work_authorization"
        };
      }
      const option = authorized
        ? pickOptionByPatterns(question.options, [/authorized/, /without restriction/, /without sponsorship/, /yes/])
        : pickOptionByPatterns(question.options, [/not authorized/, /require sponsorship/, /no/]);
      if (option) {
        return {
          answer: option,
          source: "rule",
          reason: "work_authorization"
        };
      }
      if (authorized) {
        const nonNegative = (question.options ?? []).find((option) => !optionLooksLikeNegativeAuthorization(option));
        if (nonNegative) {
          return {
            answer: nonNegative,
            source: "rule",
            reason: "work_authorization_positive_fallback"
          };
        }
      }
    }
  }

  if (!sponsorshipIntent && includesAny(label, [/right to work/, /legal requirements to work/])) {
    const foreignGeo = includesAny(label, [
      /\buk\b/,
      /united kingdom/,
      /solihull/,
      /england/,
      /scotland/,
      /\bcanada\b/,
      /australia/,
      /germany/,
      /ireland/,
      /singapore/,
      /\bindia\b/
    ]);
    if (foreignGeo) {
      // The profile only records US work authorization. A non-US right to
      // work must come from the applicant, never from a guess.
      const custom = findCustomAnswer(profile, [/right to work/, /legal requirements to work/]);
      if (custom !== undefined) {
        const asBool = coerceBoolean(custom);
        return {
          answer: typeof asBool === "boolean" ? boolToAnswer(asBool, question.options) : normalizeCustomValue(custom),
          source: "rule",
          reason: "right_to_work_custom"
        };
      }
      if (/united states|^us$|^usa$/i.test(profile.country || "")) {
        return {
          answer: boolToAnswer(false, question.options),
          source: "rule",
          reason: "right_to_work_foreign_no"
        };
      }
      return {};
    }
    const authorized = profile.workAuthorization?.authorizedToWork;
    if (typeof authorized === "boolean") {
      const mapped = boolToAnswer(authorized, question.options);
      if (mapped !== null) {
        return {
          answer: mapped,
          source: "rule",
          reason: "work_authorization_right_to_work"
        };
      }
    }
  }

  if (includesAny(label, [/rising senior/, /recent college graduate/, /currently enrolled/, /student status/, /current student/])) {
    const inferred = inferIsRisingSeniorOrRecentGrad(profile);
    if (typeof inferred === "boolean") {
      const direct = boolToAnswer(inferred, question.options);
      if (direct !== null) {
        return {
          answer: direct,
          source: "rule",
          reason: "student_status_inferred"
        };
      }

      const option = inferred
        ? pickOptionByPatterns(question.options, [/rising senior/, /recent.*graduate/, /current.*student/, /yes/])
        : pickOptionByPatterns(question.options, [/no/, /not.*student/, /none of the above/]);
      if (option) {
        return {
          answer: option,
          source: "rule",
          reason: "student_status_inferred"
        };
      }
    }
  }

  if (
    includesAny(label, [
      /final year of a bachelor/,
      /enrolled in a master/,
      /enrolled in a phd/,
      /currently in your final year/
    ])
  ) {
    const inferred = inferIsRisingSeniorOrRecentGrad(profile);
    if (typeof inferred === "boolean") {
      return {
        answer: boolToAnswer(inferred, question.options),
        source: "rule",
        reason: "student_status_final_year"
      };
    }
    return {
      answer: boolToAnswer(true, question.options),
      source: "rule",
      reason: "student_status_final_year_default"
    };
  }

  if (includesAny(label, [/relinquished/, /abandoned/, /lost citizenship/, /lost nationality/, /lost.*permanent residence/])) {
    return {
      answer: boolToAnswer(false, question.options),
      source: "rule",
      reason: "citizenship_status_no"
    };
  }

  if (
    includesAny(label, [/(citizen|national|resident) of/, /sanctioned countr/]) &&
    includesAny(label, [/\bcuba\b/, /\biran\b/, /north korea/, /\bsyria\b/, /\brussia\b/, /\bbelarus\b/, /venezuela/])
  ) {
    // A wrong "No" here is a false export-control statement, so the answer
    // only comes from a known, non-sanctioned country of citizenship.
    const normalizedCountry = normalize(profile.country || "");
    if (normalizedCountry && !SANCTIONED_COUNTRIES.has(normalizedCountry)) {
      return {
        answer: boolToAnswer(false, question.options),
        source: "rule",
        reason: "sanctioned_country_citizenship"
      };
    }
    return {};
  }

  if (
    includesAny(label, [
      /export control/,
      /citizenship/,
      /nationality/,
      /permanent residence/,
      /which option applies to you/,
      /u\.?s\.? person/,
      /best describes your (citizenship|immigration|work authorization) status/,
      /are you one of the following.*(citizen|resident|refugee|asylum)/,
      /citizens or permanent residents/
    ]) &&
    question.options?.length
  ) {
    const options = question.options;
    const findOption = (patterns: RegExp[]): string | undefined =>
      options.find((option) => patterns.some((pattern) => pattern.test(option.toLowerCase())));
    // Explicit profile flags outrank the authorization heuristic below.
    if (profile.workAuthorization?.usCitizen === true) {
      const citizenOption = findOption([
        /citizen or national of the united states/,
        /u\.?s\.? citizen/,
        /united states citizen/,
        /\bcitizen\b/
      ]);
      if (citizenOption) {
        return {
          answer: citizenOption,
          source: "rule",
          reason: "export_control_status"
        };
      }
    }
    if (profile.workAuthorization?.permanentResident === true) {
      const residentOption = findOption([/lawful permanent resident/, /green ?card/, /permanent resident/]);
      if (residentOption) {
        return {
          answer: residentOption,
          source: "rule",
          reason: "export_control_status"
        };
      }
    }
    if (
      includesAny(label, [/are you one of the following/, /u\.?s\.? person/, /citizens or permanent residents/]) &&
      (profile.exportControl?.usPerson === true ||
        profile.workAuthorization?.usCitizen === true ||
        profile.workAuthorization?.permanentResident === true)
    ) {
      const mapped = boolToAnswer(true, question.options);
      if (mapped !== null) {
        return {
          answer: mapped,
          source: "rule",
          reason: "export_control_us_person"
        };
      }
    }
    const authorizedNoSponsor =
      profile.workAuthorization?.authorizedToWork === true ||
      profile.workAuthorization?.requiresSponsorship === false ||
      (/united states|^us$|^usa$/i.test(profile.country || "") && profile.workAuthorization?.requiresSponsorship !== true);
    if (authorizedNoSponsor) {
      const citizenOrResident = findOption([
        /citizen or national of the united states/,
        /u\.?s\.? citizen/,
        /lawful permanent resident|greencard|green ?card/,
        /\bcitizen\b/
      ]);
      if (citizenOrResident) {
        return {
          answer: citizenOrResident,
          source: "rule",
          reason: "export_control_status"
        };
      }
    }

    const none = findOption([/none of the above/]);
    if (none) {
      return {
        answer: none,
        source: "rule",
        reason: "export_control_none_of_above"
      };
    }
  }

  if (includesAny(label, [/place of citizenship/, /country of citizenship/, /citizenship country/])) {
    const country = profile.country ?? "United States";
    if (question.options?.length) {
      const option =
        pickOptionByPatterns(question.options, [new RegExp(country.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))]) ??
        pickOptionByPatterns(question.options, [/united states|usa|u\.s\./]);
      if (option) {
        return { answer: option, source: "rule", reason: "citizenship_country" };
      }
    }
    return { answer: country, source: "rule", reason: "citizenship_country" };
  }

  if (includesAny(label, [/linkedin/]) && profile.links?.linkedin) {
    return { answer: profile.links.linkedin, source: "rule", reason: "linkedin" };
  }

  if (includesAny(label, [/github/]) && profile.links?.github) {
    return { answer: profile.links.github, source: "rule", reason: "github" };
  }

  if (includesAny(label, [/twitter/, /^x (url|profile|handle)/])) {
    const customTwitter = findCustomAnswer(profile, [/twitter/, /^x ?(url|profile|handle)/]);
    if (typeof customTwitter === "string" && customTwitter.trim()) {
      return { answer: customTwitter.trim(), source: "rule", reason: "twitter_url_custom" };
    }
    // No profile field holds a Twitter/X URL; never substitute another link.
    return {};
  }

  if (includesAny(label, [/other (url|website|link)/])) {
    const customOther = findCustomAnswer(profile, [/other (url|website|link)/]);
    if (typeof customOther === "string" && customOther.trim()) {
      return { answer: customOther.trim(), source: "rule", reason: "other_url_custom" };
    }
    if (profile.links?.portfolio || profile.links?.website) {
      return {
        answer: profile.links.portfolio ?? profile.links.website ?? null,
        source: "rule",
        reason: "other_url"
      };
    }
    return {};
  }

  if (includesAny(label, [/portfolio/, /website/]) && (profile.links?.portfolio || profile.links?.website)) {
    return {
      answer: profile.links.portfolio ?? profile.links.website ?? null,
      source: "rule",
      reason: "portfolio"
    };
  }

  if (includesAny(label, [/years? of experience/]) && typeof profile.experience?.years === "number") {
    return {
      answer: String(profile.experience.years),
      source: "rule",
      reason: "years_experience"
    };
  }

  if (includesAny(label, [/salary/, /compensation/, /pay.*expect/, /desired.*pay/])) {
    if (profile.salary) {
      return {
        answer: profile.salary,
        source: "rule",
        reason: "salary"
      };
    }
    const customSalary = findCustomAnswer(profile, [/salary/, /compensation/, /desired pay/, /pay expectation/]);
    if (customSalary !== undefined) {
      return {
        answer: normalizeCustomValue(customSalary),
        source: "rule",
        reason: "salary_custom"
      };
    }
  }

  if (includesAny(label, [/\bgpa\b/]) && profile.education?.gpa) {
    return {
      answer: profile.education.gpa,
      source: "rule",
      reason: "gpa"
    };
  }

  if (includesAny(label, [/pronoun/])) {
    const customPronouns = findCustomAnswer(profile, [/pronoun/]);
    if (customPronouns !== undefined) {
      return {
        answer: normalizeCustomValue(customPronouns),
        source: "rule",
        reason: "pronouns_custom"
      };
    }
    const decline = pickOptionByPatterns(question.options, [/decline/, /prefer not/, /do not wish/, /not to answer/]);
    if (decline) {
      return { answer: decline, source: "rule", reason: "pronouns_decline" };
    }
    return {};
  }

  if (includesAny(label, [/age range/, /age group/])) {
    const customAge = findCustomAnswer(profile, [/age range/, /age group/]);
    if (customAge !== undefined) {
      return {
        answer: normalizeCustomValue(customAge),
        source: "rule",
        reason: "age_range_custom"
      };
    }
    const decline = pickOptionByPatterns(question.options, [/decline/, /prefer not/, /do not wish/, /not to answer/]);
    if (decline) {
      return { answer: decline, source: "rule", reason: "age_range_decline" };
    }
    return {};
  }

  if (includesAny(label, [/gender/, /sex/])) {
    const customGender = findCustomAnswer(profile, [/gender/, /\bsex\b/]);
    if (customGender !== undefined) {
      const customGenderBool = coerceBoolean(customGender);
      return {
        answer:
          typeof customGenderBool === "boolean" ? boolToAnswer(customGenderBool, question.options) : normalizeCustomValue(customGender),
        source: "rule",
        reason: "demographic_gender_custom"
      };
    }

    return {
      answer: question.options?.length ? "Decline to self-identify" : "Prefer not to say",
      source: "rule",
      reason: "demographic_gender"
    };
  }

  if (includesAny(label, [/race/, /ethnicity/, /ethnic/])) {
    const customEthnicity = findCustomAnswer(profile, [/race/, /ethnicity/, /ethnic/]);
    if (customEthnicity !== undefined) {
      const customEthnicityBool = coerceBoolean(customEthnicity);
      return {
        answer:
          typeof customEthnicityBool === "boolean"
            ? boolToAnswer(customEthnicityBool, question.options)
            : normalizeCustomValue(customEthnicity),
        source: "rule",
        reason: "demographic_ethnicity_custom"
      };
    }

    return {
      answer: question.options?.length ? "Decline to self-identify" : "Prefer not to say",
      source: "rule",
      reason: "demographic_ethnicity"
    };
  }

  if (includesAny(label, [/hispanic/, /latino/])) {
    const customHispanic = findCustomAnswer(profile, [/hispanic/, /latino/]);
    if (customHispanic !== undefined) {
      const customHispanicBool = coerceBoolean(customHispanic);
      return {
        answer:
          typeof customHispanicBool === "boolean"
            ? boolToAnswer(customHispanicBool, question.options)
            : normalizeCustomValue(customHispanic),
        source: "rule",
        reason: "demographic_hispanic_custom"
      };
    }

    return {
      answer: question.options?.length ? "Decline to self-identify" : "Prefer not to say",
      source: "rule",
      reason: "demographic_hispanic"
    };
  }

  if (includesAny(label, [/veteran/, /military/, /armed forces/])) {
    const customVeteran = coerceBoolean(findCustomAnswer(profile, [/veteran/, /military/]));
    if (typeof customVeteran === "boolean") {
      return {
        answer: boolToAnswer(customVeteran, question.options),
        source: "rule",
        reason: "veteran_status_custom"
      };
    }

    return {
      answer: "I am not a protected veteran",
      source: "rule",
      reason: "veteran_status"
    };
  }

  if (includesAny(label, [/disability/, /disabled/, /handicap/])) {
    const customDisability = coerceBoolean(findCustomAnswer(profile, [/disability/, /disabled/, /handicap/]));
    if (typeof customDisability === "boolean") {
      return {
        answer: boolToAnswer(customDisability, question.options),
        source: "rule",
        reason: "disability_status_custom"
      };
    }

    return {
      answer: "I do not wish to answer",
      source: "rule",
      reason: "disability_status"
    };
  }

  if (includesAny(label, [/18.*years/, /legal.*age/, /at least 18/, /over 18/])) {
    return {
      answer: boolToAnswer(true, question.options),
      source: "rule",
      reason: "age_18"
    };
  }

  if (includesAny(label, [/background.*check/, /criminal.*check/])) {
    return {
      answer: boolToAnswer(true, question.options),
      source: "rule",
      reason: "background_check"
    };
  }

  if (includesAny(label, [/how.*hear/, /how.*find/, /where.*hear/, /how did you hear/, /how did you find/, /referral source/])) {
    return {
      answer: "Online Job Board",
      source: "rule",
      reason: "application_source"
    };
  }

  if (includesAny(label, [/mm\/dd\/yyyy/, /date.*format/, /specify.*date/])) {
    return {
      answer: formatFutureDate(14),
      source: "rule",
      reason: "date_format_mmddyyyy"
    };
  }

  if (
    includesAny(label, [
      /start.*date/,
      /earliest.*start/,
      /when.*start/,
      /available.*start/,
      /available to begin/,
      /begin employment/,
      /anticipated start/,
      /earliest available/
    ]) &&
    // "(Month/Year)" format hints must not trip the month/year exclusions,
    // which exist for the separate "Start date month"/"Start date year" fields.
    !includesAny(label, [
      /start date month/,
      /start date year/,
      /school/,
      /university/,
      /college/,
      /education/,
      /semester/
    ])
  ) {
    const fromProfile = preferredEarliestStart(profile, label);
    if (fromProfile) {
      return {
        answer: fromProfile,
        source: "rule",
        reason: "start_date_profile"
      };
    }
    return {
      answer: "Immediately",
      source: "rule",
      reason: "start_date"
    };
  }

  if (includesAny(label, [/willing.*relocate/, /open.*relocation/])) {
    const customRelocation = coerceBoolean(findCustomAnswer(profile, [/relocat/, /location preference/, /location/]));
    if (typeof customRelocation === "boolean") {
      return {
        answer: boolToAnswer(customRelocation, question.options),
        source: "rule",
        reason: "relocation_custom"
      };
    }

    return {
      answer: boolToAnswer(false, question.options),
      source: "rule",
      reason: "relocation"
    };
  }

  if (includesAny(label, [/commutable distance/, /work onsite/, /on-site/, /in office/, /in-person/])) {
    const customCommute = coerceBoolean(findCustomAnswer(profile, [/commut/, /onsite/, /in office/, /in-person/, /relocat/]));
    if (typeof customCommute === "boolean") {
      return {
        answer: boolToAnswer(customCommute, question.options),
        source: "rule",
        reason: "onsite_commute_custom"
      };
    }
  }

  if (includesAny(label, [/previously.*applied/, /applied.*before/])) {
    return {
      answer: boolToAnswer(false, question.options),
      source: "rule",
      reason: "previous_application"
    };
  }

  if (includesAny(label, [/how many years.*work experience/, /how many years.*experience/, /years.*work experience.*do you have/])) {
    const fromCustom = findCustomAnswer(profile, [/years.*experience/, /relevant experience/]);
    if (fromCustom !== undefined) {
      return {
        answer: normalizeCustomValue(fromCustom),
        source: "profile",
        reason: "years_experience_custom"
      };
    }
    if (typeof profile.experience?.years === "number") {
      return {
        answer: String(profile.experience.years),
        source: "profile",
        reason: "years_experience"
      };
    }
  }

  if (includesAny(label, [/submitted.*cover letter.*resume.*code sample/, /cover letter.*resume.*code sample/])) {
    const fromCustom = coerceBoolean(findCustomAnswer(profile, [/cover letter.*resume.*code sample/, /submitted.*code sample/]));
    return {
      answer: boolToAnswer(fromCustom ?? false, question.options),
      source: fromCustom === undefined ? "rule" : "profile",
      reason: fromCustom === undefined ? "external_submission_not_confirmed" : "external_submission_custom"
    };
  }

  return {};
}

export function evaluateProfileMapping(question: ApplicationQuestion, profile: CandidateProfile): RuleEvaluation {
  const normalized = normalize(question.label);

  // "Are you related to anyone who works here?" and its many phrasings. Real
  // Lever and Greenhouse forms mark this required, and it blocked every live
  // Lever application measured. Only the applicant knows the answer, so it is
  // read from what they have already told us and never guessed: a wrong "No"
  // here is a false statement on a job application.
  if (
    includesAny(normalized, [/related to (any|anyone|a )?(current )?employee/, /relative.*(employ|work)/, /family member.*(employ|work)/]) ||
    (includesAny(normalized, [/know anyone/, /referred by/]) && includesAny(normalized, [/employee/, /work(s|ing)? (here|at)/]))
  ) {
    const known = findCustomAnswer(profile, [
      /related to (any|anyone|a )?(current )?employee/,
      /relative/,
      /family member/,
      /know anyone/,
      /referred by/
    ]);
    if (known !== undefined) {
      const asBool = coerceBoolean(known);
      return {
        answer: typeof asBool === "boolean" ? boolToAnswer(asBool, question.options) : normalizeCustomValue(known),
        source: "profile",
        reason: "employee_relationship_custom"
      };
    }
  }

  // The address group. Order matters: the combined form mentions street,
  // city, state, and zip in one label, so it must win before any of them.
  if (includesAny(normalized, [/(enter your|full|complete|mailing|current) address/, /address \(street/, /^address$/])) {
    const fullAddress = preferredFullAddress(profile);
    if (fullAddress) {
      return { answer: fullAddress, source: "profile", reason: "full_address" };
    }
  }

  if (includesAny(normalized, [/\(city,? ?state\)/, /city and state/, /city\/state/])) {
    const based = preferredBasedLocation(profile);
    if (based) {
      return { answer: based, source: "profile", reason: "city_state_location" };
    }
  }

  if (includesAny(normalized, [/street address/])) {
    const street = preferredStreetAddress(profile);
    if (street) {
      return { answer: street, source: "profile", reason: "street_address" };
    }
  }

  if (
    includesAny(normalized, [/\bcity\b/]) &&
    !includesAny(normalized, [/state/, /zip/, /country/, /address/, /located/, /location/, /commut/])
  ) {
    // A bare "City" field takes the city alone, never "City, State".
    const city = preferredCity(profile);
    if (city) {
      return { answer: city, source: "profile", reason: "city" };
    }
  }

  if (includesAny(normalized, [/zip/, /postal/, /post code/, /postcode/])) {
    const postal = preferredPostalCode(profile);
    if (postal) {
      return { answer: postal, source: "profile", reason: "postal_code" };
    }
  }

  if (includesAny(normalized, [/eu/, /european union/, /member state/, /eu\/efta/]) && includesAny(normalized, [/citizen/, /citizenship/, /nationality/])) {
    const explicitEuCitizen = coerceBoolean(findCustomAnswer(profile, [/eu/, /european union/, /member state/, /eu\/efta/]));
    if (typeof explicitEuCitizen === "boolean") {
      return {
        answer: boolToAnswer(explicitEuCitizen, question.options),
        source: "profile",
        reason: "eu_citizenship_custom"
      };
    }
    const normalizedCountry = normalize(profile.country || "");
    if (normalizedCountry) {
      return {
        answer: boolToAnswer(EU_EFTA_COUNTRIES.has(normalizedCountry), question.options),
        source: "profile",
        reason: "eu_citizenship_country"
      };
    }
  }

  if (
    /where are you currently based|where are you based|currently based|based in/.test(normalized) &&
    question.type === "single_select" &&
    profile.country
  ) {
    return { answer: profile.country, source: "profile", reason: "country" };
  }

  if (includesAny(normalized, [/country code/, /dial code/, /phone code/])) {
    if (!profile.country || /united states|^us$|^usa$/i.test(profile.country)) {
      return { answer: "+1", source: "profile", reason: "country_code_us" };
    }
  }

  if (includesAny(normalized, [/\bphone\b/, /mobile/, /telephone/, /contact number/]) && profile.basics.phone) {
    return { answer: profile.basics.phone, source: "profile", reason: "phone" };
  }

  if (includesAny(normalized, [/\bemail\b/, /e-mail/]) && profile.basics.email) {
    return { answer: profile.basics.email, source: "profile", reason: "email" };
  }

  if (profile.customAnswers?.[normalized] !== undefined) {
    const customValue = normalizeCustomValue(profile.customAnswers[normalized]);
    return {
      answer: customValue,
      source: "profile",
      reason: "custom_answers_exact"
    };
  }

  if (
    includesAny(normalized, [
      /preferred first name/,
      /preferred name/,
      /first name if different/,
      /if different than the name you entered above/,
      /like us to call you/,
      /should we call you/
    ])
  ) {
    const customPreferredName = findCustomAnswer(profile, [/preferred ?name/, /preferred first name/, /first name/]);
    if (typeof customPreferredName === "string" && customPreferredName.trim()) {
      return {
        answer: customPreferredName.trim(),
        source: "profile",
        reason: "preferred_first_name_custom"
      };
    }
    if (profile.basics.firstName?.trim()) {
      return {
        answer: profile.basics.firstName.trim(),
        source: "profile",
        reason: "preferred_first_name"
      };
    }
  }

  for (const [key, value] of Object.entries(profile.customAnswers ?? {})) {
    if (normalized.includes(key.toLowerCase())) {
      const customValue = normalizeCustomValue(value);
      return {
        answer: customValue,
        source: "profile",
        reason: "custom_answers_partial"
      };
    }
  }

  // The profile only records college education, and a college date or the
  // school name is the wrong answer for anything about high school.
  if (includesAny(normalized, [/high school/]) && includesAny(normalized, [/graduat/])) {
    const customHighSchool = findCustomAnswer(profile, [/high school/]);
    if (customHighSchool !== undefined) {
      return {
        answer: normalizeCustomValue(customHighSchool),
        source: "profile",
        reason: "high_school_graduation_custom"
      };
    }
    return {};
  }

  const looksLikeSchoolField =
    includesAny(normalized, [/school/, /university/, /college/]) &&
    !includesAny(normalized, [
      /rising senior/,
      /recent college graduate/,
      /college graduate/,
      /graduat/,
      /year in school/,
      /\bmajor\b/,
      /\bminor\b/,
      /\bdegree\b/,
      /\bgpa\b/,
      /start date/,
      /started/,
      /high school/
    ]);
  if (looksLikeSchoolField && (profile.education?.school || profile.education?.university)) {
    return {
      answer: profile.education?.school ?? profile.education?.university ?? null,
      source: "profile",
      reason: "education_school"
    };
  }

  if (includesAny(normalized, [/\bminor\b/])) {
    const customMinor = findCustomAnswer(profile, [/\bminor\b/]);
    if (customMinor !== undefined) {
      return {
        answer: normalizeCustomValue(customMinor),
        source: "profile",
        reason: "education_minor_custom"
      };
    }
    return {};
  }

  if (includesAny(normalized, [/start date year/, /education start year/]) && profile.education?.startYear) {
    return {
      answer: profile.education.startYear,
      source: "profile",
      reason: "education_start_year"
    };
  }

  if (includesAny(normalized, [/start date month/, /education start month/]) && profile.education?.startMonth) {
    return {
      answer: profile.education.startMonth,
      source: "profile",
      reason: "education_start_month"
    };
  }

  if (
    includesAny(normalized, [
      /(start date|started).*(school|university|college|education)/,
      /(school|university|college|education).*start date/
    ]) &&
    profile.education?.startYear
  ) {
    const startDate = formatEducationStart(profile, normalized);
    if (startDate) {
      return { answer: startDate, source: "profile", reason: "education_start_date" };
    }
  }

  if (
    includesAny(normalized, [/\bdegree\b/]) &&
    !includesAny(normalized, [/graduat/]) &&
    (profile.education?.highestDegree || profile.education?.degree)
  ) {
    const degreeText = profile.education?.highestDegree ?? profile.education?.degree;
    const option = pickDegreeLevelOption(question.options, degreeText);
    if (option) {
      return { answer: option, source: "profile", reason: "education_degree" };
    }
    return {
      answer: degreeText ?? null,
      source: "profile",
      reason: "education_degree"
    };
  }

  if (includesAny(normalized, [/discipline/, /major/, /field of study/]) && (profile.education?.field || profile.education?.discipline)) {
    return {
      answer: profile.education?.field ?? profile.education?.discipline ?? null,
      source: "profile",
      reason: "education_field"
    };
  }

  if (
    includesAny(normalized, [/end date year/, /graduation year/, /grad year/]) &&
    !includesAny(normalized, [/high school/]) &&
    (profile.education?.endYear || profile.education?.graduationYear)
  ) {
    return {
      answer: profile.education.endYear ?? profile.education.graduationYear ?? null,
      source: "profile",
      reason: "education_end_year"
    };
  }

  if (includesAny(normalized, [/end date month/, /graduation month/, /grad month/]) && profile.education?.endMonth) {
    return {
      answer: profile.education.endMonth,
      source: "profile",
      reason: "education_end_month"
    };
  }

  if (includesAny(normalized, [/end date month/, /graduation month/, /grad month/])) {
    return {
      answer: "May",
      source: "profile",
      reason: "education_end_month_default"
    };
  }

  if (
    includesAny(normalized, [
      /graduation date/,
      /expected graduation date/,
      /when is your graduation date/,
      /when do you graduate/,
      /intended graduation/,
      /expected graduation/
    ])
  ) {
    const graduationDate = normalizeGraduationDateProfileValue(profile.education);
    if (/mm\/dd\/yyyy|month\/day\/year/.test(normalized) && graduationDate.mmDdYyyy) {
      return {
        answer: graduationDate.mmDdYyyy,
        source: "profile",
        reason: "education_graduation_date_mm_dd_yyyy"
      };
    }
    if (/mm\/yyyy|month\/year/.test(normalized) && graduationDate.mmYyyy) {
      return {
        answer: graduationDate.mmYyyy,
        source: "profile",
        reason: "education_graduation_date_mm_yyyy"
      };
    }
    // No format hint: answer "May 2027" style, never a term range.
    const month = profile.education?.endMonth?.trim();
    const year = profile.education?.endYear ?? profile.education?.graduationYear;
    if (year) {
      return {
        answer: month ? `${month} ${year}` : String(year),
        source: "profile",
        reason: "education_graduation_date"
      };
    }
  }

  if (includesAny(normalized, [/graduation term/, /which term/]) && profile.education?.graduationYear) {
    return {
      answer: `May - Aug ${profile.education.graduationYear}`,
      source: "profile",
      reason: "education_graduation_term"
    };
  }

  if (includesAny(normalized, [/semester/])) {
    const customSemesters = findCustomAnswer(profile, [/semester/]);
    if (customSemesters !== undefined) {
      return {
        answer: normalizeCustomValue(customSemesters),
        source: "profile",
        reason: "semesters_available_custom"
      };
    }
    return {};
  }

  if (includesAny(normalized, [/\bcountry\b/]) && !includesAny(normalized, [/country code/, /dial code/]) && profile.country) {
    return { answer: profile.country, source: "profile", reason: "country" };
  }

  if (
    includesAny(normalized, [/state/, /province/]) &&
    !includesAny(normalized, [/citizenship/, /citizen/, /nationality/, /permanent residence/, /member state/, /eu/, /european union/, /united states/])
  ) {
    const state = preferredState(profile);
    if (state) {
      return { answer: state, source: "profile", reason: "state" };
    }
  }

  if (
    includesAny(normalized, [/where are you/, /current location/, /currently based/, /\bbased in\b/, /location \(city\)/, /commuting from/, /\bcity\b/]) &&
    !includesAny(normalized, [/export control/, /citizenship/, /nationality/, /permanent residence/])
  ) {
    const based = preferredBasedLocation(profile);
    if (based) {
      return { answer: based, source: "profile", reason: "location" };
    }
  }

  if ((normalized === "location" || normalized === "current location") && profile.basics.location) {
    return { answer: profile.basics.location, source: "profile", reason: "location" };
  }

  if (includesAny(normalized, [/years of relevant experience/, /years of experience/, /relevant experience/])) {
    const fromCustom = findCustomAnswer(profile, [/years.*experience/, /relevant experience/]);
    if (fromCustom !== undefined) {
      return {
        answer: normalizeCustomValue(fromCustom),
        source: "profile",
        reason: "years_experience_custom"
      };
    }
    if (typeof profile.experience?.years === "number") {
      return {
        answer: String(profile.experience.years),
        source: "profile",
        reason: "years_experience"
      };
    }
  }

  if (normalized.includes("current company") && profile.experience?.currentCompany) {
    return { answer: profile.experience.currentCompany, source: "profile", reason: "current_company" };
  }

  if (normalized.includes("current title") && profile.experience?.currentTitle) {
    return { answer: profile.experience.currentTitle, source: "profile", reason: "current_title" };
  }

  if (normalized.includes("highest degree") && profile.education?.highestDegree) {
    return { answer: profile.education.highestDegree, source: "profile", reason: "highest_degree" };
  }

  return {};
}

function normalizeCustomValue(value: string | boolean | string[] | number): AnswerValue {
  if (typeof value === "number") return String(value);
  return value;
}

function formatFutureDate(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const year = String(date.getFullYear());
  return `${month}/${day}/${year}`;
}

export function isCredentialQuestion(question: ApplicationQuestion): boolean {
  const label = normalize(question.label);
  return includesAny(label, [
    /security clearance/,
    /clearance level/,
    /license number/,
    /certification id/,
    /gpa/,
    /citizenship status/,
    /passport/,
    /ssn/,
    /social security/
  ]);
}

export function boolToAnswer(value: boolean, options?: string[]): AnswerValue {
  if (!options?.length) {
    return value;
  }

  const target = value ? ["yes", "true"] : ["no", "false"];
  const found = options.find((option) => target.includes(option.trim().toLowerCase()));
  if (found) return found;

  const normalizedOptions = options.map((option) => ({ raw: option, normalized: option.trim().toLowerCase() }));
  const prefixMatch = normalizedOptions.find((option) =>
    target.some((token) => option.normalized.startsWith(token) || new RegExp(`\\b${token}\\b`).test(option.normalized))
  );
  if (prefixMatch) return prefixMatch.raw;

  return null;
}
