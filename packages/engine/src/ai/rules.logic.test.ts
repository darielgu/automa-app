import assert from "node:assert/strict";
import test from "node:test";
import type { ApplicationQuestion, CandidateProfile } from "../core/types.js";
import { boolToAnswer, evaluateDeterministicRule, evaluateProfileMapping } from "./rules.js";

const profile: CandidateProfile = {
  basics: {
    firstName: "Alex",
    lastName: "Rivera",
    email: "alex-riverarivera332@gmail.com"
  },
  country: "United States",
  workAuthorization: {
    authorizedToWork: true,
    requiresSponsorship: false
  },
  links: {
    linkedin: "https://linkedin.com/in/alex-rivera-rivera"
  },
  education: {
    school: "San Diego State University",
    university: "San Diego State University",
    startMonth: "August",
    startYear: "2023",
    endMonth: "May",
    endYear: "2027",
    graduationYear: "2027",
    graduationDateMmDdYyyy: "05/15/2027",
    graduationDateMmYyyy: "05/2027"
  },
  customAnswers: {
    "open to relocation": true,
    onsite: true
  }
};

test("deterministic source rule does not trigger for motivation question", () => {
  const question: ApplicationQuestion = {
    id: "question_interest",
    label: "Why are you interested in applying to this company?",
    type: "textarea",
    required: true
  };
  const result = evaluateDeterministicRule(question, profile);
  assert.equal(result.answer, undefined);
});

test("deterministic source rule still triggers for explicit source question", () => {
  const question: ApplicationQuestion = {
    id: "question_source",
    label: "How did you find out about this opportunity?",
    type: "textarea",
    required: true
  };
  const result = evaluateDeterministicRule(question, profile);
  assert.equal(result.answer, "Online Job Board");
  assert.equal(result.reason, "application_source");
});

test("profile mapping uses explicit education timeline fields", () => {
  const startMonth = evaluateProfileMapping(
    {
      id: "start-month--0",
      label: "Start date month",
      type: "single_select",
      required: true
    },
    profile
  );
  const startYear = evaluateProfileMapping(
    {
      id: "start-year--0",
      label: "Start date year",
      type: "text",
      required: true
    },
    profile
  );
  const endMonth = evaluateProfileMapping(
    {
      id: "end-month--0",
      label: "End date month",
      type: "single_select",
      required: true
    },
    profile
  );
  const endYear = evaluateProfileMapping(
    {
      id: "end-year--0",
      label: "End date year",
      type: "text",
      required: true
    },
    profile
  );

  assert.equal(startMonth.answer, "August");
  assert.equal(startYear.answer, "2023");
  assert.equal(endMonth.answer, "May");
  assert.equal(endYear.answer, "2027");
});

test("college graduate question is not mapped as school-name field", () => {
  const result = evaluateProfileMapping(
    {
      id: "question_66032287",
      label: "Are you a rising senior or recent college graduate?",
      type: "single_select",
      required: true
    },
    profile
  );
  assert.equal(result.answer, undefined);
});

test("profile mapping uses explicit graduation date formats when prompt specifies format", () => {
  const graduationFull = evaluateProfileMapping(
    {
      id: "grad-date-full",
      label: "Expected graduation date (MM/DD/YYYY)",
      type: "text",
      required: true
    },
    profile
  );
  const graduationMonthYear = evaluateProfileMapping(
    {
      id: "grad-date-month-year",
      label: "Expected graduation date (MM/YYYY)",
      type: "text",
      required: true
    },
    profile
  );

  assert.equal(graduationFull.answer, "05/15/2027");
  assert.equal(graduationMonthYear.answer, "05/2027");
});

test("export-control status prompt maps to US citizen option, not location", () => {
  const question: ApplicationQuestion = {
    id: "question_export_status",
    label:
      "ASM may work with technologies subject to U.S. export control regulations. Please, select which option applies to you.",
    type: "single_select",
    required: true,
    options: [
      "Citizen or National of the United States",
      "U.S. Lawful Permanent Resident (Greencard holder)",
      "None of the above"
    ]
  };
  const result = evaluateDeterministicRule(question, {
    ...profile,
    country: "United States",
    workAuthorization: {
      authorizedToWork: true,
      requiresSponsorship: false
    }
  });
  assert.equal(result.answer, "Citizen or National of the United States");
});

test("relinquished citizenship question maps to No", () => {
  const question: ApplicationQuestion = {
    id: "question_relinquished",
    label:
      "Have you ever relinquished, abandoned, or lost citizenship, nationality or permanent residence in the country identified in the previous question?",
    type: "single_select",
    required: true,
    options: ["Yes", "No"]
  };
  const result = evaluateDeterministicRule(question, profile);
  assert.equal(result.answer, "No");
});

test("student-status question maps to Yes for upcoming grad year", () => {
  const question: ApplicationQuestion = {
    id: "question_student_status",
    label: "Are you a rising senior or recent college graduate?",
    type: "single_select",
    required: true,
    options: ["Yes", "No"]
  };
  const result = evaluateDeterministicRule(question, profile);
  assert.equal(result.answer, "Yes");
});

test("future sponsorship variant maps to no-sponsorship option", () => {
  const question: ApplicationQuestion = {
    id: "question_sponsor_variant",
    label: "Do you now or in the future require sponsorship support to work in the United States?",
    type: "single_select",
    required: true,
    options: ["I will not require sponsorship", "I require sponsorship"]
  };
  const result = evaluateDeterministicRule(question, profile);
  assert.equal(result.answer, "I will not require sponsorship");
});

test("sponsorship phrasing with work-authorization wording still maps to no-sponsorship option", () => {
  const question: ApplicationQuestion = {
    id: "question_sponsor_extend_auth",
    label:
      "Will you require sponsorship to continue or extend your current work authorization status, either now or in the future?",
    type: "single_select",
    required: true,
    options: [
      "Yes, I will require Simular to sponsor my employment",
      "No, I do not require sponsorship to work in this country"
    ]
  };
  const result = evaluateDeterministicRule(question, profile);
  assert.equal(result.answer, "No, I do not require sponsorship to work in this country");
});

test("place of citizenship maps to United States option", () => {
  const question: ApplicationQuestion = {
    id: "question_place_citizenship",
    label: "Place of citizenship",
    type: "single_select",
    required: true,
    options: ["Canada", "United States", "Singapore"]
  };
  const result = evaluateDeterministicRule(question, profile);
  assert.equal(result.answer, "United States");
});

test("work authorization with country options maps to United States", () => {
  const question: ApplicationQuestion = {
    id: "question_work_auth_country",
    label: "Are you authorized to work in the country this role is listed in?",
    type: "single_select",
    required: true,
    options: ["United States", "Singapore", "No", "N.A. - this is a remote position"]
  };
  const result = evaluateDeterministicRule(question, profile);
  assert.equal(result.answer, "United States");
});

test("boolToAnswer does not flip to opposite choice when target token is missing", () => {
  assert.equal(boolToAnswer(true, ["No", "N.A. - this is a remote position"]), null);
});

test("commutable/onsite question uses custom boolean", () => {
  const question: ApplicationQuestion = {
    id: "question_commute",
    label: "Are you a day to day commutable distance to our office?",
    type: "single_select",
    required: true,
    options: ["Yes", "No"]
  };
  const result = evaluateDeterministicRule(question, profile);
  assert.equal(result.answer, "Yes");
});

test("preferred first name maps from basics firstName", () => {
  const result = evaluateProfileMapping(
    {
      id: "preferred_name",
      label: "Preferred First Name (if different than the name you entered above)",
      type: "text",
      required: true
    },
    profile
  );
  assert.equal(result.answer, "Alex");
  assert.equal(result.reason, "preferred_first_name");
});

test("phone field maps from profile basics.phone", () => {
  const withPhone: CandidateProfile = {
    ...profile,
    basics: {
      ...profile.basics,
      phone: "619-289-5672"
    }
  };
  const result = evaluateProfileMapping(
    {
      id: "phone",
      label: "Phone",
      type: "text",
      required: true
    },
    withPhone
  );
  assert.equal(result.answer, "619-289-5672");
  assert.equal(result.reason, "phone");
});

test("phone country code does not map to raw phone number", () => {
  const withPhone: CandidateProfile = {
    ...profile,
    country: "United States",
    basics: {
      ...profile.basics,
      phone: "619-289-5672"
    }
  };
  const result = evaluateProfileMapping(
    {
      id: "phone_country_code",
      label: "Phone country code",
      type: "single_select",
      required: true,
      options: ["United States (+1)", "Canada (+1)", "Mexico (+52)"]
    },
    withPhone
  );
  assert.equal(result.answer, "+1");
  assert.equal(result.reason, "country_code_us");
});

test("years of work experience prompt uses profile years", () => {
  const result = evaluateDeterministicRule(
    {
      id: "react_years",
      label: "How many years of work experience do you have with React.js?",
      type: "text",
      required: true
    },
    {
      ...profile,
      experience: {
        years: 2
      }
    }
  );
  assert.equal(result.answer, "2");
  assert.equal(result.reason, "years_experience");
});

test("external document/code-sample submission defaults to no unless explicit", () => {
  const result = evaluateDeterministicRule(
    {
      id: "righton_email_submission",
      label: "Have you submitted a cover letter/resume to info@example.com? Alongside those documents, have you also submitted a code sample?",
      type: "boolean",
      required: true,
      options: ["Yes", "No"]
    },
    profile
  );
  assert.equal(result.answer, "No");
  assert.equal(result.reason, "external_submission_not_confirmed");
});

test("plain location field maps from profile location", () => {
  const withLocation: CandidateProfile = {
    ...profile,
    basics: {
      ...profile.basics,
      location: "San Diego, CA"
    }
  };
  const result = evaluateProfileMapping(
    {
      id: "location",
      label: "Location",
      type: "single_select",
      required: true
    },
    withLocation
  );
  assert.equal(result.answer, "San Diego, CA");
  assert.equal(result.reason, "location");
});

test("eu member-state citizenship question does not map to profile.state", () => {
  const withState: CandidateProfile = {
    ...profile,
    state: "California",
    country: "United States"
  };
  const result = evaluateProfileMapping(
    {
      id: "question_eu_citizen",
      label: "Are you an EU citizen (a citizen of European Union Member State)?",
      type: "single_select",
      required: true,
      options: ["Yes", "No"]
    },
    withState
  );
  assert.equal(result.answer, "No");
  assert.equal(result.reason, "eu_citizenship_country");
});

test("the employee-relationship question is answered only from what the user said", () => {
  // Observed blocking every live Lever application measured:
  // "Are you related to any current employee/s at Analytic Partners?"
  const question: ApplicationQuestion = {
    id: "cards[abc][field0]",
    label: "Are you related to any current employee/s at Analytic Partners? No or Yes and whom?",
    type: "text",
    required: true
  };

  // Nothing saved: it must stay unanswered. Guessing "No" would put a false
  // statement on a job application, and it is not ours to make.
  assert.equal(evaluateProfileMapping(question, profile).answer, undefined);

  const withAnswer: CandidateProfile = {
    ...profile,
    customAnswers: { ...(profile.customAnswers ?? {}), "related to any current employee": "No" }
  };
  const resolved = evaluateProfileMapping(question, withAnswer);
  assert.equal(resolved.answer, "No");
  assert.equal(resolved.source, "profile");
});

// ---------------------------------------------------------------------------
// Live Lever labels. Every label below appeared verbatim (including Lever's
// required glyph ✱, U+2731, and trailing colons) in the 2026-08-13 live runs
// and went unanswered even though the profile held the data. The engine runs
// evaluateDeterministicRule first and evaluateProfileMapping second, so
// resolveLikeEngine mirrors that order.
// ---------------------------------------------------------------------------

const leverProfile: CandidateProfile = {
  ...profile,
  basics: {
    ...profile.basics,
    location: "San Diego, CA"
  },
  state: "California",
  salary: "120000",
  locationStructured: {
    city: "San Diego",
    region: "California",
    country: "United States"
  },
  workday: {
    contact: {
      email: "alex-riverarivera332@gmail.com",
      phone: "619-289-5672",
      phoneType: "Mobile",
      address: {
        line1: "500 Folsom St",
        line2: "Apt 4",
        city: "San Diego",
        state: "CA",
        postalCode: "92101",
        country: "United States"
      }
    }
  },
  workAuthorization: {
    authorizedToWork: true,
    requiresSponsorship: false,
    usCitizen: true
  },
  education: {
    ...profile.education,
    highestDegree: "Bachelor of Science",
    degree: "Bachelor of Science",
    field: "Computer Science",
    discipline: "Computer Science"
  },
  links: {
    ...profile.links,
    portfolio: "https://alexrivera.dev"
  },
  logistics: {
    earliestStartDate: "June 2026"
  },
  customAnswers: {
    ...profile.customAnswers,
    "minor concentration": "Mathematics",
    "high school graduation": "2019",
    "semester availability": "Fall 2026",
    preferredName: "Al",
    twitter: "https://x.com/alexr",
    pronouns: "they/them",
    "age range": "25-34"
  }
};

function resolveLikeEngine(question: ApplicationQuestion, candidate: CandidateProfile) {
  const deterministic = evaluateDeterministicRule(question, candidate);
  if (deterministic.answer !== undefined) return deterministic;
  return evaluateProfileMapping(question, candidate);
}

test("live Lever labels resolve from the profile without any LLM", () => {
  const cases: Array<{ label: string; options?: string[]; answer: string; reason?: string }> = [
    { label: "Street Address✱", answer: "500 Folsom St, Apt 4", reason: "street_address" },
    { label: "City✱", answer: "San Diego", reason: "city" },
    { label: "State✱", answer: "California", reason: "state" },
    { label: "Zip Code✱", answer: "92101", reason: "postal_code" },
    {
      label: "Please enter your address (Street Address, City, State, Zip Code)✱",
      answer: "500 Folsom St, Apt 4, San Diego, CA, 92101",
      reason: "full_address"
    },
    {
      label: "Where are you currently located? (City, State)✱",
      answer: "San Diego, California",
      reason: "city_state_location"
    },
    {
      label: "Where will you be commuting from? (city or zip code)✱",
      answer: "92101",
      reason: "postal_code"
    },
    { label: "School Major:", answer: "Computer Science", reason: "education_field" },
    { label: "School Minor:", answer: "Mathematics", reason: "education_minor_custom" },
    {
      label: "What degree are you currently pursuing?✱",
      options: ["High School", "Associates", "Bachelors", "Masters", "PhD"],
      answer: "Bachelors",
      reason: "education_degree"
    },
    {
      label: "Are you currently enrolled in a Bachelors or Masters Degree program?✱",
      options: ["Yes", "No"],
      answer: "Yes"
    },
    {
      label: "Graduation date or expected graduation date:✱",
      answer: "May 2027",
      reason: "education_graduation_date"
    },
    { label: "Start Date at Current School:✱", answer: "August 2023", reason: "education_start_date" },
    { label: "What year did you graduate high school?✱", answer: "2019" },
    { label: "Year of High School Graduation✱", answer: "2019" },
    {
      label:
        'Which university are you currently attending or did you last attend? Please select "Other (School Not Listed)" if your school is not listed.✱',
      answer: "San Diego State University",
      reason: "education_school"
    },
    {
      label:
        "Please include your intended graduation year for the degree or relevant learning program that you are currently pursuing or have completed.✱",
      answer: "2027",
      reason: "education_end_year"
    },
    {
      label: "What date are you available to begin employment (Month and Year)✱",
      answer: "06/2026",
      reason: "start_date_profile"
    },
    { label: "What is your earliest available start date?✱", answer: "June 2026", reason: "start_date_profile" },
    { label: "What is your anticipated start date? (Month/Year)", answer: "06/2026", reason: "start_date_profile" },
    {
      label: "What semester(s) are you available to work?*✱",
      answer: "Fall 2026",
      reason: "semesters_available_custom"
    },
    {
      label: "Preferred Name | What would you like us to call you?",
      answer: "Al",
      reason: "preferred_first_name_custom"
    },
    { label: "Twitter URL", answer: "https://x.com/alexr", reason: "twitter_url_custom" },
    { label: "X URL", answer: "https://x.com/alexr", reason: "twitter_url_custom" },
    { label: "Other URL", answer: "https://alexrivera.dev", reason: "other_url" },
    { label: "Desired Pay✱", answer: "120000", reason: "salary" },
    { label: "Pronouns", answer: "they/them", reason: "pronouns_custom" },
    { label: "What is your age range?", answer: "25-34", reason: "age_range_custom" },
    {
      label: "Do you have the unrestricted right to work in the US?✱",
      options: ["Yes", "No"],
      answer: "Yes",
      reason: "work_authorization_right_to_work"
    }
  ];

  for (const item of cases) {
    const result = resolveLikeEngine(
      {
        id: `live-${item.label.slice(0, 24)}`,
        label: item.label,
        type: item.options ? "single_select" : "text",
        required: true,
        options: item.options
      },
      leverProfile
    );
    assert.equal(result.answer, item.answer, `label: ${item.label}`);
    if (item.reason) {
      assert.equal(result.reason, item.reason, `reason for label: ${item.label}`);
    }
  }
});

test("School Major never answers with the school name", () => {
  const result = resolveLikeEngine(
    { id: "school-major", label: "School Major:", type: "text", required: true },
    leverProfile
  );
  assert.notEqual(result.answer, "San Diego State University");
  assert.equal(result.answer, "Computer Science");
});

test("Start Date at Current School never answers Immediately", () => {
  const result = resolveLikeEngine(
    { id: "school-start", label: "Start Date at Current School:✱", type: "text", required: true },
    leverProfile
  );
  assert.notEqual(result.answer, "Immediately");
  assert.equal(result.answer, "August 2023");
});

test("a bare City field gets the city alone, never City, State", () => {
  const result = resolveLikeEngine({ id: "city", label: "City✱", type: "text", required: true }, leverProfile);
  assert.equal(result.answer, "San Diego");
});

test("US-citizenship-status multi-selects pick the explicit-flag option", () => {
  const anduril = resolveLikeEngine(
    {
      id: "citizen-status-bullets",
      label:
        "Are you one of the following: • U.S. Citizen or National. • U.S. Lawful Permanent Resident. • Person granted Refugee status in the United States. • Person granted Asylum in the United States.✱",
      type: "single_select",
      required: true,
      options: [
        "U.S. Citizen or National",
        "U.S. Lawful Permanent Resident",
        "Person granted Refugee status in the United States",
        "Person granted Asylum in the United States"
      ]
    },
    leverProfile
  );
  assert.equal(anduril.answer, "U.S. Citizen or National");
  assert.equal(anduril.reason, "export_control_status");

  const istari = resolveLikeEngine(
    {
      id: "citizen-status-contracts",
      label:
        "This position may provide the opportunity to work on US Federal Government contracts that require candidates to be US Citizens or Permanent Residents. NOTE - it is not required to be a US Citizen or Permanent Resident to apply for a position at Istari, but it will affect the range of projects available to you. Please select the following that apply to you:✱",
      type: "multi_select",
      required: true,
      options: ["I am a US Citizen", "I am a Permanent Resident", "None of these apply to me"]
    },
    leverProfile
  );
  assert.equal(istari.answer, "I am a US Citizen");
  assert.equal(istari.reason, "export_control_status");
});

test("sanctioned-country citizenship answers No only from a known country", () => {
  const question: ApplicationQuestion = {
    id: "sanctioned",
    label:
      "Are you a national, citizen, or permanent resident of Belarus, Cuba, Iran, North Korea, Syria, or Russia?✱",
    type: "single_select",
    required: true,
    options: ["Yes", "No"]
  };
  const known = resolveLikeEngine(question, leverProfile);
  assert.equal(known.answer, "No");
  assert.equal(known.reason, "sanctioned_country_citizenship");

  const unknownCountry = resolveLikeEngine(question, { ...leverProfile, country: undefined });
  assert.equal(unknownCountry.answer, undefined);
});

test("a non-US right to work comes from the applicant or from a US-country No", () => {
  const question: ApplicationQuestion = {
    id: "solihull",
    label: "Do you currently meet legal requirements to work in Solihull, England??✱",
    type: "single_select",
    required: true,
    options: ["Yes", "No"]
  };
  const fromCountry = resolveLikeEngine(question, leverProfile);
  assert.equal(fromCountry.answer, "No");
  assert.equal(fromCountry.reason, "right_to_work_foreign_no");

  const withCustom = resolveLikeEngine(question, {
    ...leverProfile,
    customAnswers: { ...(leverProfile.customAnswers ?? {}), "right to work in the uk": "Yes" }
  });
  assert.equal(withCustom.answer, "Yes");
  assert.equal(withCustom.reason, "right_to_work_custom");

  const unknown = resolveLikeEngine(question, { ...leverProfile, country: undefined });
  assert.equal(unknown.answer, undefined);
});

test("desired pay falls back to a custom answer when salary is empty", () => {
  const result = resolveLikeEngine(
    { id: "desired-pay", label: "Desired Pay✱", type: "text", required: true },
    {
      ...leverProfile,
      salary: undefined,
      customAnswers: { "desired salary": "130000" }
    }
  );
  assert.equal(result.answer, "130000");
  assert.equal(result.reason, "salary_custom");
});

test("personal facts with no saved answer stay unanswered, never guessed", () => {
  const labels = [
    "Pronouns",
    "What is your age range?",
    "What year did you graduate high school?✱",
    "School Minor:",
    "Twitter URL",
    "What semester(s) are you available to work?*✱"
  ];
  for (const label of labels) {
    const result = resolveLikeEngine(
      { id: `bare-${label.slice(0, 16)}`, label, type: "text", required: true },
      profile
    );
    assert.equal(result.answer, undefined, `label: ${label}`);
  }
});

test("pronouns and age range take a decline option when one exists", () => {
  const pronouns = resolveLikeEngine(
    {
      id: "pronouns-select",
      label: "Pronouns",
      type: "single_select",
      required: true,
      options: ["She/Her", "He/Him", "They/Them", "Prefer not to say"]
    },
    profile
  );
  assert.equal(pronouns.answer, "Prefer not to say");
  assert.equal(pronouns.reason, "pronouns_decline");

  const age = resolveLikeEngine(
    {
      id: "age-select",
      label: "What is your age range?",
      type: "single_select",
      required: true,
      options: ["18-24", "25-34", "I decline to answer"]
    },
    profile
  );
  assert.equal(age.answer, "I decline to answer");
  assert.equal(age.reason, "age_range_decline");
});
