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
